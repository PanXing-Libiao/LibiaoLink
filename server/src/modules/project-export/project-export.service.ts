import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAGE_EXPORT_PREVIEW_PHOTO_LIMIT,
  PAGE_EXPORT_PREVIEW_ROW_LIMIT,
  type DailyReport,
  type Issue,
  type PageExportCatalogResponse,
  type PageExportPreviewPhotoCell,
  type PageExportPreviewRow,
  type PageExportSheetKey,
  type PageExportSheetSelection,
  type PermissionKey,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { ObjectStorage } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import { ChangeService, FileService, type ProjectExportFileRef } from "../file/index.js";
import { UserService } from "../identity/index.js";
import { ProjectService } from "../project/index.js";
import { IssueService, ReportService } from "../report-issue/index.js";
import { PermissionService, type ProjectAccessContext } from "../permission/index.js";
import { StakeholderService } from "../stakeholder/index.js";
import { TaskService } from "../task/index.js";
import {
  changeExportRow,
  orphanIssueReportRow,
  personLabel,
  registerTaskChangeLinks,
  reportExportRow,
  stakeholderExportRow,
  taskExportRow,
  type ProjectExportUserLabel,
} from "./project-export.mapping.js";
import {
  buildProjectExportWorkbook,
  normalizeHttpOrigin,
  projectExportArchiveFileName,
  projectExportArchiveStem,
  projectExportFileName,
  projectExportArchiveWorkbookName,
  projectExportSheetNames,
  ProjectExportWorkbookWriter,
  type ExportFileLink,
  type ExportImage,
  type ExportPhotoLoader,
  type ExportPhotoRef,
  type ProjectExportChangeRow,
  type ProjectExportPayload,
  type ProjectExportReportRow,
  type ProjectExportStakeholderRow,
  type ProjectExportTaskRow,
} from "./project-export.workbook.js";
import {
  buildProjectArchiveManifest,
  planProjectArchiveAttachments,
  projectArchiveLinks,
  projectArchiveManifestJson,
  PROJECT_ARCHIVE_MAX_FILE_BYTES,
  PROJECT_ARCHIVE_MAX_TOTAL_BYTES,
  ProjectZipWriter,
  shouldCompressProjectArchiveEntry,
  type ProjectArchiveAttachmentSource,
  type ProjectArchivePlan,
  type ProjectExportFormat,
} from "./project-export.archive.js";
import { PAGE_EXPORT_SHEETS, pageExportColumnDefinition, pageExportSheetDefinition, type PageExportColumnDefinition } from "./page-export.catalog.js";
import { pageExportPhotoIds, pageIssueRow, pageReportRow, pageStakeholderRow, type PageExportMappedRow } from "./page-export.mapping.js";
import {
  buildPageExportWorkbook,
  pageExportFileName,
  PageExportWorkbookWriter,
  type PageExportWorkbookRow,
  type PageExportWorkbookSheet,
} from "./page-export.workbook.js";
import { injectWorkbookImages } from "./project-export.xlsx-images.js";
import { ProjectExportTelemetry } from "./project-export.metrics.js";
import { ProjectArchiveImageCapture, sniffProjectExportImage } from "./project-export.image-capture.js";

export { splitChangeReason } from "./project-export.mapping.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MAX_EXPORT_ROWS = PAGE_SIZE * MAX_PAGES;
const AUTO_STREAM_ROW_THRESHOLD = 3_000;
const IMAGE_CONCURRENCY = 4;
const MAX_IMAGE_COUNT = 250;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
const PHOTO_PREFETCH_ROWS = 200;
const WORKBOOK_THUMBNAIL_SIZE = { maxWidth: 176, maxHeight: 128 };
const ARCHIVE_THUMBNAIL_SIZE = { maxWidth: 360, maxHeight: 270 };
const TEMP_EXPORT_PREFIX = "libiaolink-project-export-";
const STALE_TEMP_EXPORT_MS = 60 * 60 * 1000;
const PAGE_EXPORT_PREVIEW_TEXT_MAX = 240;

interface ImageThumbnailSize {
  maxWidth: number;
  maxHeight: number;
}

interface ImageLoadBudget {
  count: number;
  totalBytes: number;
}

interface ReusedExportImage {
  image: ExportImage;
  sourceBytes: number;
}

interface ImageLoadOptions {
  reused?: ReadonlyMap<string, ReusedExportImage>;
  blockedIds?: ReadonlySet<string>;
}

export type ProjectExportModeSetting = "auto" | "legacy" | "stream";
export type ProjectExportExecutionMode = "legacy" | "stream";
export type ProjectExportResultMode = ProjectExportExecutionMode | "archive";

export function resolveProjectExportMode(setting: ProjectExportModeSetting, rowCount: number): ProjectExportExecutionMode {
  if (setting === "legacy" || setting === "stream") return setting;
  return rowCount >= AUTO_STREAM_ROW_THRESHOLD ? "stream" : "legacy";
}

interface ProjectExportMetrics {
  fileName: string;
  sheetNames: string[];
  taskCount: number;
  reportCount: number;
  changeCount: number;
  stakeholderCount: number;
  imageCount: number;
  imageLinkCount: number;
  missingImageCount: number;
  mode: ProjectExportResultMode;
}

export interface ProjectExportBufferResult extends ProjectExportMetrics {
  kind: "buffer";
  buffer: Buffer;
}

export interface ProjectExportFileResult extends ProjectExportMetrics {
  kind: "file";
  filePath: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

export type ProjectExportResult = ProjectExportBufferResult | ProjectExportFileResult;

export interface PageExportRowCounts {
  reports: number;
  issues: number;
  stakeholders: number;
}

interface PageExportMetrics {
  fileName: string;
  sheetNames: string[];
  rowCounts: PageExportRowCounts;
  imageCount: number;
  imageLinkCount: number;
  missingImageCount: number;
  mode: ProjectExportExecutionMode;
}

export interface PageExportBufferResult extends PageExportMetrics {
  kind: "buffer";
  buffer: Buffer;
}

export interface PageExportFileResult extends PageExportMetrics {
  kind: "file";
  filePath: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
}

export type PageExportResult = PageExportBufferResult | PageExportFileResult;

interface ExportProject {
  id: string;
  code: string;
  name: string;
  managerIds: string[];
  managerNames: Array<string | null>;
}

interface PagedResult<T> {
  items: T[];
  total: number;
}

interface StreamingCounts {
  tasks: number;
  reports: number;
  changes: number;
  stakeholders: number;
  imageIds: Set<string>;
}

type ProjectTaskItem = Awaited<ReturnType<TaskService["list"]>>["items"][number];
type ProjectChangeItem = Awaited<ReturnType<ChangeService["listProjectChanges"]>>["items"][number];
type ProjectStakeholderItem = Awaited<ReturnType<StakeholderService["list"]>>["items"][number];

interface CollectedProjectExport {
  taskItems: ProjectTaskItem[];
  reportItems: DailyReport[];
  issueItems: Issue[];
  changeItems: ProjectChangeItem[];
  stakeholderItems: ProjectStakeholderItem[];
  taskFilesById: Map<string, ExportFileLink[]>;
  fileRefs: Map<string, ProjectExportFileRef>;
  taskRows: ProjectExportTaskRow[];
  reportRows: ProjectExportReportRow[];
  changeRows: ProjectExportChangeRow[];
  stakeholderRows: ProjectExportStakeholderRow[];
}

interface PageExportStreamingCounts extends PageExportRowCounts {
  imageIds: Set<string>;
}

interface PageExportAccess {
  sheets: Map<PageExportSheetKey, boolean>;
  columns: Map<string, boolean>;
}

interface PageExportRows {
  reports: PageExportMappedRow[];
  issues: PageExportMappedRow[];
  stakeholders: PageExportMappedRow[];
}

function zeroPageCounts(): PageExportRowCounts {
  return { reports: 0, issues: 0, stakeholders: 0 };
}

function columnsAllowed(
  column: PageExportColumnDefinition,
  allowed: ReadonlyMap<PermissionKey, boolean>,
): boolean {
  return column.permission === undefined || allowed.get(column.permission) === true;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AppError("INTERNAL", "项目导出已取消");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

async function* readPaged<T>(
  load: (page: number, limit: number) => Promise<PagedResult<T>>,
  section: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<PagedResult<T>> {
  let loaded = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    throwIfAborted(signal);
    const result = await load(page, PAGE_SIZE);
    if (result.total > MAX_EXPORT_ROWS) {
      throw new AppError("INTERNAL", section + "超过导出上限（" + String(MAX_EXPORT_ROWS) + " 条），请分批导出");
    }
    if (result.items.length === 0) return;
    loaded += result.items.length;
    yield result;
    if (loaded >= result.total) return;
  }
  throw new AppError("INTERNAL", section + "超过导出上限（" + String(MAX_EXPORT_ROWS) + " 条），请分批导出");
}

async function collectPaged<T>(
  load: (page: number, limit: number) => Promise<PagedResult<T>>,
  section: string,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  const rows: T[] = [];
  for await (const page of readPaged(load, section, signal)) rows.push(...page.items);
  return rows;
}

/**
 * 日报读面固定按日期 / 创建时间倒序；从末页向前取并在页内反转，可在不缓存全量日报的前提下恢复导出口径的升序。
 */
async function* readPagedAscendingFromTotal<T>(
  load: (page: number, limit: number) => Promise<PagedResult<T>>,
  total: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<T[]> {
  if (total > MAX_EXPORT_ROWS) throw new AppError("INTERNAL", "日报超过导出上限（" + String(MAX_EXPORT_ROWS) + " 条），请分批导出");
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let page = pages; page >= 1; page -= 1) {
    throwIfAborted(signal);
    const result = await load(page, PAGE_SIZE);
    yield [...result.items].reverse();
  }
}

function addPhotoIds(target: Set<string>, refs: readonly { fileId: string }[]): void {
  for (const ref of refs) target.add(ref.fileId);
}

function addReportPhotoIds(target: Set<string>, row: ProjectExportReportRow): void {
  addPhotoIds(target, row.onsitePhotos);
  addPhotoIds(target, row.issuePhotos);
}

function addChangePhotoIds(target: Set<string>, row: ProjectExportChangeRow): void {
  addPhotoIds(target, row.beforePhotos);
  addPhotoIds(target, row.afterPhotos);
}

/** 流式写入前一页一取图：保持行级顺序与有界内存，同时避免逐行查文件引用。 */
async function* prefetchPhotoRows<T>(
  rows: AsyncIterable<T>,
  photosOf: (row: T) => readonly ExportPhotoRef[],
  loadPhotos: ExportPhotoLoader,
): AsyncGenerator<T> {
  let buffered: T[] = [];
  let refs: ExportPhotoRef[] = [];
  const takeBatch = async (): Promise<T[]> => {
    if (buffered.length === 0) return [];
    const batch = buffered;
    const batchRefs = refs;
    buffered = [];
    refs = [];
    await loadPhotos(batchRefs);
    return batch;
  };
  for await (const row of rows) {
    buffered.push(row);
    refs.push(...photosOf(row));
    if (buffered.length >= PHOTO_PREFETCH_ROWS) {
      for (const bufferedRow of await takeBatch()) yield bufferedRow;
    }
  }
  for (const bufferedRow of await takeBatch()) yield bufferedRow;
}

@Injectable()
export class ProjectExportService implements OnModuleInit {
  private readonly logger = new Logger(ProjectExportService.name);
  private streamingInFlight = false;

  constructor(
    private readonly projects: ProjectService,
    private readonly tasks: TaskService,
    private readonly reports: ReportService,
    private readonly issues: IssueService,
    private readonly changes: ChangeService,
    private readonly stakeholders: StakeholderService,
    private readonly files: FileService,
    private readonly users: UserService,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupStaleExportDirectories();
  }

  async pageExportCatalog(
    projectId: string,
    actorId: string,
    projectAccess: ProjectAccessContext,
  ): Promise<PageExportCatalogResponse> {
    const access = await this.pageExportAccess(actorId, projectAccess);
    const sheets = await Promise.all(
      PAGE_EXPORT_SHEETS.map(async (definition) => {
        const allowed = access.sheets.get(definition.key) === true;
        const columns = definition.columns.map((column) => ({
          key: column.key,
          label: column.label,
          allowed: allowed && (column.permission === undefined || access.columns.get(this.pageExportColumnAccessKey(definition.key, column.key)) === true),
        }));
        const defaultColumns = definition.defaultColumns.filter((key) => columns.some((column) => column.key === key && column.allowed));
        const preview = allowed
          ? await this.pageExportPreviewOne(projectId, actorId, definition.key)
          : { rowCount: 0, rows: [] as PageExportMappedRow[] };
        const allowedColumnKeys = new Set(columns.filter((column) => column.allowed).map((column) => column.key));
        return {
          key: definition.key,
          label: definition.label,
          allowed,
          rowCount: preview.rowCount,
          defaultColumns: defaultColumns.length > 0 ? defaultColumns : columns.filter((column) => column.allowed).slice(0, 1).map((column) => column.key),
          columns,
          previewRows: preview.rows.map((row) => this.pageExportPreviewRow(row, allowedColumnKeys)),
        };
      }),
    );
    return { sheets };
  }

  async exportPages(
    projectId: string,
    actorId: string,
    requestOrigin: string,
    sheets: readonly PageExportSheetSelection[],
    projectAccess: ProjectAccessContext,
    signal?: AbortSignal,
  ): Promise<PageExportResult> {
    throwIfAborted(signal);
    await this.assertPageExportAccess(actorId, sheets, projectAccess);
    const project = await this.projects.getProject(projectId, actorId);
    const rowCounts = await this.pageExportCounts(projectId, actorId, sheets.map((sheet) => sheet.sheet), signal);
    const mode = resolveProjectExportMode(
      this.config.env.PROJECT_EXPORT_MODE,
      rowCounts.reports + rowCounts.issues + rowCounts.stakeholders,
    );
    if (mode === "legacy") return this.exportPagesLegacy(project, actorId, requestOrigin, sheets, rowCounts, signal);
    return this.withStreamingSlot(() => this.exportPagesStreaming(project, actorId, requestOrigin, sheets, rowCounts, signal));
  }

  private pageExportColumnAccessKey(sheet: PageExportSheetKey, column: string): string {
    return sheet + ":" + column;
  }

  private async pageExportAccess(actorId: string, projectAccess: ProjectAccessContext): Promise<PageExportAccess> {
    const permissions = new Set<PermissionKey>();
    for (const definition of PAGE_EXPORT_SHEETS) {
      permissions.add(definition.permission);
      for (const column of definition.columns) if (column.permission !== undefined) permissions.add(column.permission);
    }
    const allowed = new Map<PermissionKey, boolean>();
    await Promise.all([...permissions].map(async (permission) => {
      allowed.set(permission, await this.permission.can(actorId, permission, projectAccess));
    }));
    const sheets = new Map<PageExportSheetKey, boolean>();
    const columns = new Map<string, boolean>();
    for (const definition of PAGE_EXPORT_SHEETS) {
      sheets.set(definition.key, allowed.get(definition.permission) === true);
      for (const column of definition.columns) {
        columns.set(
          this.pageExportColumnAccessKey(definition.key, column.key),
          columnsAllowed(column, allowed) && allowed.get(definition.permission) === true,
        );
      }
    }
    return { sheets, columns };
  }

  private async assertPageExportAccess(
    actorId: string,
    sheets: readonly PageExportSheetSelection[],
    projectAccess: ProjectAccessContext,
  ): Promise<void> {
    const access = await this.pageExportAccess(actorId, projectAccess);
    for (const selection of sheets) {
      const definition = pageExportSheetDefinition(selection.sheet);
      if (access.sheets.get(selection.sheet) !== true) {
        throw new AppError("FORBIDDEN", "无权限导出页面：" + definition.label);
      }
      for (const columnKey of selection.columns) {
        const column = pageExportColumnDefinition(definition, columnKey);
        if (access.columns.get(this.pageExportColumnAccessKey(selection.sheet, columnKey)) !== true) {
          throw new AppError("FORBIDDEN", "无权限导出列：" + definition.label + " / " + column.label);
        }
      }
    }
  }

  private async pageExportPreviewOne(
    projectId: string,
    actorId: string,
    sheet: PageExportSheetKey,
  ): Promise<{ rowCount: number; rows: PageExportMappedRow[] }> {
    const users = new Map<string, ProjectExportUserLabel>();
    if (sheet === "reports") {
      const result = await this.reports.list(projectId, { page: 1, limit: PAGE_EXPORT_PREVIEW_ROW_LIMIT });
      return { rowCount: result.total, rows: result.items.slice(0, PAGE_EXPORT_PREVIEW_ROW_LIMIT).map((report) => pageReportRow(report, users)) };
    }
    if (sheet === "issues") {
      const result = await this.issues.list(projectId, { page: 1, limit: PAGE_EXPORT_PREVIEW_ROW_LIMIT });
      return { rowCount: result.total, rows: result.items.slice(0, PAGE_EXPORT_PREVIEW_ROW_LIMIT).map((issue) => pageIssueRow(issue, users)) };
    }
    const result = await this.stakeholders.list(
      { "filter[projectId]": projectId, page: 1, limit: PAGE_EXPORT_PREVIEW_ROW_LIMIT },
      actorId,
    );
    return { rowCount: result.total, rows: result.items.slice(0, PAGE_EXPORT_PREVIEW_ROW_LIMIT).map((item) => pageStakeholderRow(item, users)) };
  }

  private pageExportPreviewRow(
    row: PageExportMappedRow,
    allowedColumnKeys: ReadonlySet<string>,
  ): PageExportPreviewRow {
    const result: PageExportPreviewRow = {};
    for (const key of allowedColumnKeys) {
      const photos = row.photos[key];
      if (photos !== undefined) {
        if (photos.length === 0) {
          result[key] = "";
        } else {
          const photoCell: PageExportPreviewPhotoCell = {
            kind: "photos",
            total: photos.length,
            items: photos.slice(0, PAGE_EXPORT_PREVIEW_PHOTO_LIMIT).map((photo) => ({ fileId: photo.fileId, name: photo.name })),
          };
          result[key] = photoCell;
        }
        continue;
      }
      const value = row.values[key] ?? null;
      result[key] = typeof value === "string" && value.length > PAGE_EXPORT_PREVIEW_TEXT_MAX
        ? value.slice(0, PAGE_EXPORT_PREVIEW_TEXT_MAX - 1) + "…"
        : value;
    }
    return result;
  }

  private async pageExportCountOne(projectId: string, actorId: string, sheet: PageExportSheetKey): Promise<number> {
    if (sheet === "reports") return (await this.reports.list(projectId, { page: 1, limit: 1 })).total;
    if (sheet === "issues") return (await this.issues.list(projectId, { page: 1, limit: 1 })).total;
    return (await this.stakeholders.list({ "filter[projectId]": projectId, page: 1, limit: 1 }, actorId)).total;
  }

  private async pageExportCounts(
    projectId: string,
    actorId: string,
    sheets: readonly PageExportSheetKey[],
    signal: AbortSignal | undefined,
  ): Promise<PageExportRowCounts> {
    const selected = new Set(sheets);
    throwIfAborted(signal);
    const [reports, issues, stakeholders] = await Promise.all([
      selected.has("reports") ? this.pageExportCountOne(projectId, actorId, "reports") : 0,
      selected.has("issues") ? this.pageExportCountOne(projectId, actorId, "issues") : 0,
      selected.has("stakeholders") ? this.pageExportCountOne(projectId, actorId, "stakeholders") : 0,
    ]);
    throwIfAborted(signal);
    return { reports, issues, stakeholders };
  }

  /** 请求列只表达“导出哪些列”，Excel 列序始终取系统目录顺序。 */
  private pageExportCanonicalColumns(selection: PageExportSheetSelection): string[] {
    const definition = pageExportSheetDefinition(selection.sheet);
    const selected = new Set<string>(selection.columns);
    return definition.columns.filter((column) => selected.has(column.key)).map((column) => column.key);
  }

  private pageExportWorkbookSheet(selection: PageExportSheetSelection, rows: readonly PageExportWorkbookRow[]): PageExportWorkbookSheet {
    const definition = pageExportSheetDefinition(selection.sheet);
    return {
      key: definition.key,
      name: definition.label,
      columns: this.pageExportCanonicalColumns(selection).map((key) => {
        const column = pageExportColumnDefinition(definition, key);
        return { key: column.key, label: column.label, width: column.width, photo: column.photo };
      }),
      rows,
    };
  }

  private pageExportHasPhotoColumn(selection: PageExportSheetSelection): boolean {
    return (selection.columns as readonly string[]).includes("photos");
  }

  private async exportPagesLegacy(
    project: ExportProject,
    actorId: string,
    requestOrigin: string,
    selections: readonly PageExportSheetSelection[],
    rowCounts: PageExportRowCounts,
    signal: AbortSignal | undefined,
  ): Promise<PageExportBufferResult> {
    const selected = new Set(selections.map((selection) => selection.sheet));
    const userPromise = collectPaged((page, limit) => this.users.listUsers({ page, limit }), "用户目录", signal);
    const reportPromise: Promise<DailyReport[]> = selected.has("reports")
      ? collectPaged((page, limit) => this.reports.list(project.id, { page, limit }), "日报", signal)
      : Promise.resolve([]);
    const issuePromise: Promise<Issue[]> = selected.has("issues")
      ? collectPaged((page, limit) => this.issues.list(project.id, { page, limit }), "问题", signal)
      : Promise.resolve([]);
    const stakeholderPromise = selected.has("stakeholders")
      ? collectPaged(
          (page, limit) => this.stakeholders.list({ "filter[projectId]": project.id, page, limit }, actorId),
          "干系人",
          signal,
        )
      : Promise.resolve([]);
    const [userItems, reportItems, issueItems, stakeholderItems] = await Promise.all([
      userPromise,
      reportPromise,
      issuePromise,
      stakeholderPromise,
    ]);
    throwIfAborted(signal);

    const users = this.userLabels(userItems);
    const rows: PageExportRows = {
      reports: reportItems.map((report) => pageReportRow(report, users)),
      issues: issueItems.map((issue) => pageIssueRow(issue, users)),
      stakeholders: stakeholderItems.map((item) => pageStakeholderRow(item, users)),
    };
    const imageIds = new Set<string>();
    for (const selection of selections) {
      if (!this.pageExportHasPhotoColumn(selection)) continue;
      for (const id of pageExportPhotoIds(rows[selection.sheet])) imageIds.add(id);
    }
    const fileRefs = imageIds.size === 0
      ? new Map<string, ProjectExportFileRef>()
      : await this.files.listExportFileRefs(project.id, [...imageIds]);
    const images = await this.loadImages(imageIds, fileRefs);
    const missingImageCount = [...imageIds].filter((id) => !images.has(id)).length;
    throwIfAborted(signal);

    const workbookSheets = selections.map((selection) => this.pageExportWorkbookSheet(selection, rows[selection.sheet]));
    const workbook = await buildPageExportWorkbook({
      projectId: project.id,
      origin: normalizeHttpOrigin(requestOrigin),
      sheets: workbookSheets,
      images,
    });
    const fileName = pageExportFileName(project, workbookSheets);
    await this.auditPageExport(project, actorId, workbook.sheetNames, selections, rowCounts, {
      mode: "legacy",
      images: images.size,
      imageLinks: 0,
      missingImages: missingImageCount,
    });
    return {
      kind: "buffer",
      fileName,
      buffer: workbook.buffer,
      sheetNames: workbook.sheetNames,
      rowCounts,
      imageCount: images.size,
      imageLinkCount: 0,
      missingImageCount,
      mode: "legacy",
    };
  }

  private async exportPagesStreaming(
    project: ExportProject,
    actorId: string,
    requestOrigin: string,
    selections: readonly PageExportSheetSelection[],
    rowCounts: PageExportRowCounts,
    signal: AbortSignal | undefined,
  ): Promise<PageExportFileResult> {
    let directory: string | undefined;
    let writer: PageExportWorkbookWriter | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), TEMP_EXPORT_PREFIX));
      await chmod(directory, 0o700);
      const filePath = join(directory, "page-export.xlsx");
      throwIfAborted(signal);
      const userItems = await collectPaged((page, limit) => this.users.listUsers({ page, limit }), "用户目录", signal);
      const users = this.userLabels(userItems);
      const counts: PageExportStreamingCounts = { ...zeroPageCounts(), imageIds: new Set<string>() };
      const photoLoader = this.createStreamingPhotoLoader(project.id, signal);
      writer = new PageExportWorkbookWriter(filePath, photoLoader.load);
      for (const selection of selections) {
        const sheet = this.pageExportWorkbookSheet(selection, []);
        const wantsPhotos = this.pageExportHasPhotoColumn(selection);
        await writer.writeSheet(
          sheet,
          prefetchPhotoRows(
            this.streamPageExportRows(project.id, actorId, selection, users, counts, signal),
            (row) => wantsPhotos ? Object.values(row.photos).flat() : [],
            photoLoader.load,
          ),
        );
      }
      throwIfAborted(signal);
      const workbook = await writer.commit();
      await injectWorkbookImages(workbook.filePath, workbook.imagePlacements, workbook.images);
      await chmod(filePath, 0o600);
      const info = await stat(filePath);
      const fileName = pageExportFileName(project, selections.map((selection) => ({ name: pageExportSheetDefinition(selection.sheet).label })));
      const imageCount = workbook.images.size;
      const missingImageCount = [...counts.imageIds].filter((id) => !workbook.images.has(id)).length;
      await this.auditPageExport(project, actorId, workbook.sheetNames, selections, rowCounts, {
        mode: "stream",
        images: imageCount,
        imageLinks: 0,
        missingImages: missingImageCount,
      });
      return {
        kind: "file",
        fileName,
        filePath,
        sizeBytes: info.size,
        cleanup: this.tempDirectoryCleanup(directory),
        sheetNames: workbook.sheetNames,
        rowCounts,
        imageCount,
        imageLinkCount: 0,
        missingImageCount,
        mode: "stream",
      };
    } catch (error) {
      if (writer !== undefined) await writer.abort();
      if (directory !== undefined) await this.removeTempDirectory(directory);
      throw error;
    }
  }

  private async *streamPageExportRows(
    projectId: string,
    actorId: string,
    selection: PageExportSheetSelection,
    users: ReadonlyMap<string, ProjectExportUserLabel>,
    counts: PageExportStreamingCounts,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<PageExportWorkbookRow> {
    const wantsPhotos = this.pageExportHasPhotoColumn(selection);
    if (selection.sheet === "reports") {
      for await (const page of readPaged((page, limit) => this.reports.list(projectId, { page, limit }), "日报", signal)) {
        for (const report of page.items) {
          throwIfAborted(signal);
          const row = pageReportRow(report, users);
          if (wantsPhotos) for (const id of pageExportPhotoIds([row])) counts.imageIds.add(id);
          counts.reports += 1;
          yield row;
        }
      }
      return;
    }
    if (selection.sheet === "issues") {
      for await (const page of readPaged((page, limit) => this.issues.list(projectId, { page, limit }), "问题", signal)) {
        for (const issue of page.items) {
          throwIfAborted(signal);
          const row = pageIssueRow(issue, users);
          if (wantsPhotos) for (const id of pageExportPhotoIds([row])) counts.imageIds.add(id);
          counts.issues += 1;
          yield row;
        }
      }
      return;
    }
    for await (const page of readPaged(
      (page, limit) => this.stakeholders.list({ "filter[projectId]": projectId, page, limit }, actorId),
      "干系人",
      signal,
    )) {
      for (const item of page.items) {
        throwIfAborted(signal);
        counts.stakeholders += 1;
        yield pageStakeholderRow(item, users);
      }
    }
  }

  private async auditPageExport(
    project: ExportProject,
    actorId: string,
    sheetNames: readonly string[],
    selections: readonly PageExportSheetSelection[],
    rowCounts: PageExportRowCounts,
    metrics: { mode: ProjectExportExecutionMode; images: number; imageLinks: number; missingImages: number },
  ): Promise<void> {
    await this.audit.record(this.database.db, {
      actorId,
      action: "download",
      objectType: "project",
      objectId: project.id,
      projectId: project.id,
      summary: "导出页面数据：" + project.code + " " + project.name,
      metadata: {
        feature: "page_export",
        mode: metrics.mode,
        format: "xlsx",
        sheets: sheetNames,
        columns: Object.fromEntries(selections.map((selection) => [selection.sheet, this.pageExportCanonicalColumns(selection)])),
        reports: rowCounts.reports,
        issues: rowCounts.issues,
        stakeholders: rowCounts.stakeholders,
        images: metrics.images,
        imageLinks: metrics.imageLinks,
        missingImages: metrics.missingImages,
      },
    });
  }

  async exportProject(
    projectId: string,
    actorId: string,
    requestOrigin: string,
    signal?: AbortSignal,
    format: ProjectExportFormat = "xlsx",
  ): Promise<ProjectExportResult> {
    const telemetry = new ProjectExportTelemetry(projectId, format);
    try {
      throwIfAborted(signal);
      const project = await telemetry.measure("dataLoad", () => this.projects.getProject(projectId, actorId));
      let result: ProjectExportResult;
      if (format === "zip") {
        telemetry.setMode("archive");
        result = await this.withStreamingSlot(() => this.exportProjectArchive(project, actorId, signal, telemetry));
      } else {
        const mode = await telemetry.measure("dataLoad", () => this.resolveMode(projectId, actorId, signal));
        telemetry.setMode(mode);
        result = mode === "legacy"
          ? await this.exportProjectLegacy(project, actorId, requestOrigin, signal, telemetry)
          : await this.withStreamingSlot(() => this.exportProjectStreaming(project, actorId, requestOrigin, signal, telemetry));
      }
      telemetry.recordResult({
        mode: result.mode,
        rows: result.taskCount + result.reportCount + result.changeCount + result.stakeholderCount,
        images: result.imageCount,
        imageLinks: result.imageLinkCount,
        missingImages: result.missingImageCount,
        outputBytes: result.kind === "buffer" ? result.buffer.byteLength : result.sizeBytes,
      });
      this.logProjectExportTelemetry(telemetry, "success");
      return result;
    } catch (error) {
      this.logProjectExportTelemetry(telemetry, signal?.aborted === true ? "cancelled" : "failed", error);
      throw error;
    }
  }

  private logProjectExportTelemetry(
    telemetry: ProjectExportTelemetry,
    status: "success" | "failed" | "cancelled",
    error?: unknown,
  ): void {
    try {
      this.logger.log("project_export_metrics " + JSON.stringify(telemetry.snapshot(status, error)));
    } catch {
      return;
    }
  }

  private async resolveMode(projectId: string, actorId: string, signal: AbortSignal | undefined): Promise<ProjectExportExecutionMode> {
    const setting = this.config.env.PROJECT_EXPORT_MODE;
    if (setting !== "auto") return resolveProjectExportMode(setting, 0);
    throwIfAborted(signal);
    const [tasks, reports, issues, changes, stakeholders] = await Promise.all([
      this.tasks.list(projectId, { page: 1, limit: 1 }),
      this.reports.list(projectId, { page: 1, limit: 1 }),
      this.issues.list(projectId, { page: 1, limit: 1 }),
      this.changes.listProjectChanges(projectId, { page: 1, limit: 1, sort: "appliedAt:asc" }),
      this.stakeholders.list({ "filter[projectId]": projectId, page: 1, limit: 1, sort: "createdAt:asc" }, actorId),
    ]);
    throwIfAborted(signal);
    return resolveProjectExportMode(setting, tasks.total + reports.total + issues.total + changes.total + stakeholders.total);
  }

  private async exportProjectLegacy(
    project: ExportProject,
    actorId: string,
    requestOrigin: string,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): Promise<ProjectExportBufferResult> {
    const data = await telemetry.measure("dataLoad", () => this.collectProjectExport(project, actorId, signal));
    const imageIds = new Set<string>();
    for (const row of data.reportRows) addReportPhotoIds(imageIds, row);
    for (const row of data.changeRows) addChangePhotoIds(imageIds, row);
    telemetry.setRequestedImages(imageIds.size);
    const images = await this.loadImages(imageIds, data.fileRefs, false, undefined, telemetry);
    const missingIds = new Set<string>();
    for (const id of imageIds) if (!images.has(id)) missingIds.add(id);
    throwIfAborted(signal);

    const payload: ProjectExportPayload = {
      project: { id: project.id, code: project.code, name: project.name },
      origin: normalizeHttpOrigin(requestOrigin),
      tasks: data.taskRows,
      reports: data.reportRows,
      changes: data.changeRows,
      stakeholders: data.stakeholderRows,
      images,
    };
    const workbook = await telemetry.measure("workbook", () => buildProjectExportWorkbook(payload));
    const fileName = projectExportFileName(project);
    await telemetry.measure("audit", () => this.audit.record(this.database.db, {
      actorId,
      action: "download",
      objectType: "project",
      objectId: project.id,
      projectId: project.id,
      summary: "导出项目数据：" + project.code + " " + project.name,
      metadata: {
        mode: "legacy",
        format: "xlsx",
        sheets: workbook.sheetNames,
        tasks: data.taskRows.length,
        reports: data.reportRows.length,
        changes: data.changeRows.length,
        stakeholders: data.stakeholderRows.length,
        images: images.size,
        imageLinks: 0,
        missingImages: missingIds.size,
      },
    }));
    return {
      kind: "buffer",
      fileName,
      buffer: workbook.buffer,
      sheetNames: workbook.sheetNames,
      taskCount: data.taskRows.length,
      reportCount: data.reportRows.length,
      changeCount: data.changeRows.length,
      stakeholderCount: data.stakeholderRows.length,
      imageCount: images.size,
      imageLinkCount: 0,
      missingImageCount: missingIds.size,
      mode: "legacy",
    };
  }

  private async collectProjectExport(
    project: ExportProject,
    actorId: string,
    signal: AbortSignal | undefined,
  ): Promise<CollectedProjectExport> {
    const [userItems, fileItems, taskItems, reportItems, issueItems, changeItems, stakeholderItems] = await Promise.all([
      collectPaged((page, limit) => this.users.listUsers({ page, limit }), "用户目录", signal),
      collectPaged((page, limit) => this.files.listProjectFiles(project.id, { page, limit }), "文件", signal),
      collectPaged((page, limit) => this.tasks.list(project.id, { page, limit }), "任务", signal),
      collectPaged((page, limit) => this.reports.list(project.id, { page, limit }), "日报", signal),
      collectPaged((page, limit) => this.issues.list(project.id, { page, limit }), "问题", signal),
      collectPaged((page, limit) => this.changes.listProjectChanges(project.id, { page, limit, sort: "appliedAt:asc" }), "变更", signal),
      collectPaged(
        (page, limit) => this.stakeholders.list({ "filter[projectId]": project.id, page, limit, sort: "createdAt:asc" }, actorId),
        "干系人",
        signal,
      ),
    ]);
    throwIfAborted(signal);

    const users = this.userLabels(userItems);
    const managerLabels = project.managerIds.map((id, index) => personLabel(id, project.managerNames[index] ?? null, users));
    const taskFilesById = this.taskFiles(fileItems);
    const relatedByChange = new Map<string, string[]>();
    const taskRows = taskItems.map((task) => {
      registerTaskChangeLinks(task, relatedByChange);
      return taskExportRow(task, managerLabels, users, taskFilesById.get(task.id) ?? []);
    });

    const fileIds = new Set<string>();
    for (const files of taskFilesById.values()) for (const file of files) fileIds.add(file.id);
    for (const report of reportItems) {
      addPhotoIds(fileIds, report.photos);
      addPhotoIds(fileIds, report.issuePhotos);
    }
    for (const issue of issueItems) addPhotoIds(fileIds, issue.photos);
    for (const change of changeItems) {
      if (change.fileId !== null) fileIds.add(change.fileId);
      for (const id of change.beforeSummaryFileIds) fileIds.add(id);
      for (const id of change.afterSummaryFileIds) fileIds.add(id);
    }
    const fileRefs = await this.files.listExportFileRefs(project.id, [...fileIds]);

    reportItems.sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt));
    const issueByReport = new Map<string, Issue[]>();
    for (const issue of issueItems) {
      if (issue.sourceReportId === null) continue;
      const current = issueByReport.get(issue.sourceReportId) ?? [];
      current.push(issue);
      issueByReport.set(issue.sourceReportId, current);
    }
    const reportRows: ProjectExportReportRow[] = reportItems.map((report) => reportExportRow(report, issueByReport.get(report.id) ?? [], users));
    const reportIds = new Set(reportItems.map((report) => report.id));
    const orphanIssues = issueItems
      .filter((issue) => issue.sourceReportId === null || !reportIds.has(issue.sourceReportId))
      .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.createdAt.localeCompare(right.createdAt));
    for (const issue of orphanIssues) reportRows.push(orphanIssueReportRow(issue, users));

    const changeRows = changeItems.map((change) => changeExportRow(change, fileRefs, users, relatedByChange));
    const stakeholderRows = stakeholderItems.map((item) => stakeholderExportRow(item, users));
    throwIfAborted(signal);
    return {
      taskItems,
      reportItems,
      issueItems,
      changeItems,
      stakeholderItems,
      taskFilesById,
      fileRefs,
      taskRows,
      reportRows,
      changeRows,
      stakeholderRows,
    };
  }

  private async exportProjectArchive(
    project: ExportProject,
    actorId: string,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): Promise<ProjectExportFileResult> {
    let directory: string | undefined;
    let archive: ProjectZipWriter | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), TEMP_EXPORT_PREFIX));
      await chmod(directory, 0o700);
      const data = await telemetry.measure("dataLoad", () => this.collectProjectExport(project, actorId, signal));
      const sources = this.projectArchiveSources(project, data);
      const plan = planProjectArchiveAttachments(sources, data.fileRefs);
      telemetry.recordAttachmentPlan(plan.files.map((file) => file.fileId));
      const imageIds = this.projectArchiveImageIds(data.reportRows, data.changeRows);
      telemetry.setRequestedImages(imageIds.size);
      const captureIds = this.projectArchiveThumbnailIds(imageIds, plan, data.fileRefs);
      const workbookName = projectExportArchiveWorkbookName(project);
      const rootName = projectExportArchiveStem(project);
      const zipPath = join(directory, "project-export.zip");
      archive = new ProjectZipWriter(zipPath, new Date());
      await archive.open();
      const reusedImages = await this.writeProjectArchiveAttachments(archive, plan, rootName, signal, telemetry, captureIds);

      const links = projectArchiveLinks(plan);
      this.applyProjectArchiveLinks(data, links);
      const images = await this.loadImages(imageIds, data.fileRefs, ARCHIVE_THUMBNAIL_SIZE, undefined, telemetry, {
        reused: reusedImages,
        blockedIds: this.projectArchiveBlockedImageIds(plan, imageIds, reusedImages),
      });
      throwIfAborted(signal);

      const attachmentRows = plan.references.map((reference) => ({
        sourcePage: reference.sourcePage,
        sourceRow: reference.sourceRow,
        sourceRecord: reference.sourceRecord,
        attachmentType: reference.attachmentType,
        fileName: reference.file.fileName,
        relativePath: reference.file.relativePath,
        sizeBytes: reference.file.sizeBytes,
        status: reference.file.status === "included" ? "已包含" : reference.file.status === "missing" ? "缺失" : "已跳过",
      }));
      const payload: ProjectExportPayload = {
        project: { id: project.id, code: project.code, name: project.name },
        origin: null,
        tasks: data.taskRows,
        reports: data.reportRows,
        changes: data.changeRows,
        stakeholders: data.stakeholderRows,
        images,
        attachmentSheet: attachmentRows,
        imageLimitPerCell: 4,
      };
      const workbook = await telemetry.measure("workbook", () => buildProjectExportWorkbook(payload));
      const manifest = buildProjectArchiveManifest({
        project: { code: project.code, name: project.name },
        workbook: workbookName,
        plan,
        exportedAt: new Date(),
      });
      const openArchive = archive;
      if (openArchive === undefined) throw new AppError("INTERNAL", "项目导出 ZIP 尚未打开");
      const info = await telemetry.measure("archiveFinalize", async () => {
        await openArchive.addBuffer(rootName + "/" + workbookName, workbook.buffer, false);
        await openArchive.addBuffer(rootName + "/manifest.json", projectArchiveManifestJson(manifest));
        await openArchive.close();
        archive = undefined;
        await chmod(zipPath, 0o600);
        return stat(zipPath);
      });
      const missingImageCount = [...imageIds].filter((id) => !images.has(id)).length;
      let imageLinkCount = 0;
      for (const row of data.reportRows) {
        imageLinkCount += row.onsitePhotos.filter((ref) => ref.href !== undefined).length;
        imageLinkCount += row.issuePhotos.filter((ref) => ref.href !== undefined).length;
      }
      for (const row of data.changeRows) {
        imageLinkCount += row.beforePhotos.filter((ref) => ref.href !== undefined).length;
        imageLinkCount += row.afterPhotos.filter((ref) => ref.href !== undefined).length;
      }
      await telemetry.measure("audit", () => this.audit.record(this.database.db, {
        actorId,
        action: "download",
        objectType: "project",
        objectId: project.id,
        projectId: project.id,
        summary: "导出项目数据（Excel + 附件）：" + project.code + " " + project.name,
        metadata: {
          mode: "archive",
          format: "zip",
          sheets: workbook.sheetNames,
          tasks: data.taskRows.length,
          reports: data.reportRows.length,
          changes: data.changeRows.length,
          stakeholders: data.stakeholderRows.length,
          attachments: manifest.summary.attachmentCount,
          attachmentFiles: manifest.summary.includedFileCount,
          attachmentBytes: manifest.summary.attachmentBytes,
          missingAttachments: manifest.summary.missingCount,
          skippedAttachments: manifest.summary.skippedCount,
          images: images.size,
          imageLinks: imageLinkCount,
          missingImages: missingImageCount,
        },
      }));
      return {
        kind: "file",
        fileName: projectExportArchiveFileName(project),
        filePath: zipPath,
        sizeBytes: info.size,
        cleanup: this.tempDirectoryCleanup(directory),
        sheetNames: workbook.sheetNames,
        taskCount: data.taskRows.length,
        reportCount: data.reportRows.length,
        changeCount: data.changeRows.length,
        stakeholderCount: data.stakeholderRows.length,
        imageCount: images.size,
        imageLinkCount,
        missingImageCount,
        mode: "archive",
      };
    } catch (error) {
      if (archive !== undefined) await archive.abort();
      if (directory !== undefined) await this.removeTempDirectory(directory);
      throw error;
    }
  }

  private projectArchiveSources(project: ExportProject, data: CollectedProjectExport): ProjectArchiveAttachmentSource[] {
    const taskSheetName = projectExportSheetNames(project)[0] ?? "项目任务";
    const sources: ProjectArchiveAttachmentSource[] = [];
    const seen = new Set<string>();
    const push = (source: ProjectArchiveAttachmentSource): void => {
      if (seen.has(source.key)) return;
      seen.add(source.key);
      sources.push(source);
    };

    for (let index = 0; index < data.taskRows.length; index += 1) {
      const row = data.taskRows[index];
      if (row === undefined) continue;
      for (const file of row.files) {
        push({
          key: "task:" + String(index) + ":file:" + file.id,
          sourcePage: taskSheetName,
          sourceRow: index + 2,
          sourceRecord: row.description,
          attachmentType: "输出成果文件",
          directory: "任务文件",
          fileId: file.id,
          fileName: file.name,
        });
      }
    }

    for (let index = 0; index < data.reportRows.length; index += 1) {
      const row = data.reportRows[index];
      if (row === undefined) continue;
      const sourceRecord = row.author === "" ? row.date : row.date + " / " + row.author;
      for (const photo of row.onsitePhotos) {
        push({
          key: "report:" + String(index) + ":onsite:" + photo.fileId,
          sourcePage: "日报及问题汇总",
          sourceRow: index + 2,
          sourceRecord,
          attachmentType: "现场工作附图",
          directory: "日报及问题汇总/现场工作附图",
          fileId: photo.fileId,
          fileName: photo.name,
        });
      }
      for (const photo of row.issuePhotos) {
        push({
          key: "report:" + String(index) + ":issue:" + photo.fileId,
          sourcePage: "日报及问题汇总",
          sourceRow: index + 2,
          sourceRecord,
          attachmentType: "问题附图",
          directory: "日报及问题汇总/问题附图",
          fileId: photo.fileId,
          fileName: photo.name,
        });
      }
    }

    for (let index = 0; index < data.changeRows.length; index += 1) {
      const row = data.changeRows[index];
      if (row === undefined) continue;
      const change = data.changeItems[index];
      const sourceRecord = row.description === "" ? row.changedAt : row.changedAt + " " + row.description;
      const changeFileId = change?.fileId ?? row.files[0]?.id;
      if (changeFileId !== undefined && changeFileId !== null) {
        push({
          key: "change:" + String(index) + ":file:" + changeFileId,
          sourcePage: "变更管理",
          sourceRow: index + 2,
          sourceRecord,
          attachmentType: "变更后文件",
          directory: "变更管理/变更后文件",
          fileId: changeFileId,
          fileName: data.fileRefs.get(changeFileId)?.name ?? "缺失附件",
        });
      }
      for (const photo of row.beforePhotos) {
        push({
          key: "change:" + String(index) + ":before:" + photo.fileId,
          sourcePage: "变更管理",
          sourceRow: index + 2,
          sourceRecord,
          attachmentType: "变更前附图",
          directory: "变更管理/变更前",
          fileId: photo.fileId,
          fileName: photo.name,
        });
      }
      for (const photo of row.afterPhotos) {
        push({
          key: "change:" + String(index) + ":after:" + photo.fileId,
          sourcePage: "变更管理",
          sourceRow: index + 2,
          sourceRecord,
          attachmentType: "变更后附图",
          directory: "变更管理/变更后",
          fileId: photo.fileId,
          fileName: photo.name,
        });
      }
    }
    return sources;
  }

  private applyProjectArchiveLinks(data: CollectedProjectExport, links: ReadonlyMap<string, string>): void {
    const withHref = <T extends { href?: string }>(value: T, key: string): T => {
      const href = links.get(key);
      return href === undefined ? value : { ...value, href };
    };
    for (let index = 0; index < data.taskRows.length; index += 1) {
      const row = data.taskRows[index];
      if (row === undefined) continue;
      row.files = row.files.map((file) => withHref(file, "task:" + String(index) + ":file:" + file.id));
    }
    for (let index = 0; index < data.reportRows.length; index += 1) {
      const row = data.reportRows[index];
      if (row === undefined) continue;
      row.onsitePhotos = row.onsitePhotos.map((photo) => withHref(photo, "report:" + String(index) + ":onsite:" + photo.fileId));
      row.issuePhotos = row.issuePhotos.map((photo) => withHref(photo, "report:" + String(index) + ":issue:" + photo.fileId));
    }
    for (let index = 0; index < data.changeRows.length; index += 1) {
      const row = data.changeRows[index];
      if (row === undefined) continue;
      row.files = row.files.map((file) => withHref(file, "change:" + String(index) + ":file:" + file.id));
      row.afterFiles = row.afterFiles.map((file) => withHref(file, "change:" + String(index) + ":file:" + file.id));
      row.beforePhotos = row.beforePhotos.map((photo) => withHref(photo, "change:" + String(index) + ":before:" + photo.fileId));
      row.afterPhotos = row.afterPhotos.map((photo) => withHref(photo, "change:" + String(index) + ":after:" + photo.fileId));
    }
  }

  private projectArchiveImageIds(
    reports: readonly ProjectExportReportRow[],
    changes: readonly ProjectExportChangeRow[],
  ): Set<string> {
    const ids = new Set<string>();
    const add = (refs: readonly { fileId: string }[]): void => {
      const seen = new Set<string>();
      let count = 0;
      for (const ref of refs) {
        if (seen.has(ref.fileId)) continue;
        seen.add(ref.fileId);
        ids.add(ref.fileId);
        count += 1;
        if (count >= 4) break;
      }
    };
    for (const row of reports) {
      add(row.onsitePhotos);
      add(row.issuePhotos);
    }
    for (const row of changes) {
      add(row.beforePhotos);
      add(row.afterPhotos);
    }
    return ids;
  }

  private projectArchiveThumbnailIds(
    imageIds: ReadonlySet<string>,
    plan: ProjectArchivePlan,
    refs: ReadonlyMap<string, ProjectExportFileRef>,
  ): Set<string> {
    const includedFileIds = new Set(plan.files.filter((file) => file.status === "included").map((file) => file.fileId));
    const result = new Set<string>();
    let count = 0;
    let totalBytes = 0;
    for (const id of imageIds) {
      if (count >= MAX_IMAGE_COUNT || totalBytes >= MAX_TOTAL_IMAGE_BYTES) break;
      if (!includedFileIds.has(id)) continue;
      const ref = refs.get(id);
      if (ref === undefined || ref.objectKey === null || !supportedImage(ref)) continue;
      const sizeBytes = ref.sizeBytes;
      if (sizeBytes !== null && (sizeBytes > MAX_IMAGE_BYTES || totalBytes + sizeBytes > MAX_TOTAL_IMAGE_BYTES)) continue;
      result.add(id);
      count += 1;
      totalBytes += sizeBytes ?? 0;
    }
    return result;
  }

  private projectArchiveBlockedImageIds(
    plan: ProjectArchivePlan,
    imageIds: ReadonlySet<string>,
    reusedImages: ReadonlyMap<string, ReusedExportImage>,
  ): Set<string> {
    const includedFileIds = new Set(plan.files.filter((file) => file.status === "included").map((file) => file.fileId));
    const blockedIds = new Set(plan.files
      .filter((file) => file.status !== "included" && !includedFileIds.has(file.fileId))
      .map((file) => file.fileId));
    for (const id of imageIds) {
      if (includedFileIds.has(id) && !reusedImages.has(id)) blockedIds.add(id);
    }
    return blockedIds;
  }

  private async writeProjectArchiveAttachments(
    archive: ProjectZipWriter,
    plan: ProjectArchivePlan,
    rootName: string,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
    captureIds: ReadonlySet<string>,
  ): Promise<Map<string, ReusedExportImage>> {
    let includedBytes = 0;
    const processed = new Set<(typeof plan.files)[number]>();
    const reusedImages = new Map<string, ReusedExportImage>();
    const inFlightThumbnails = new Set<Promise<void>>();
    const captureStates = new Map<string, "pending" | "completed">();
    const scheduleThumbnail = async (fileId: string, fileName: string, bytes: Buffer, extension: ExportImage["extension"]): Promise<void> => {
      while (inFlightThumbnails.size >= IMAGE_CONCURRENCY) {
        await Promise.race(inFlightThumbnails);
      }
      let task: Promise<void>;
      task = (async () => {
        if (signal?.aborted === true) return;
        const image = await this.thumbnailImage(bytes, extension, ARCHIVE_THUMBNAIL_SIZE, telemetry);
        reusedImages.set(fileId, { image, sourceBytes: bytes.byteLength });
        captureStates.set(fileId, "completed");
      })().catch((error: unknown) => {
        captureStates.delete(fileId);
        if (signal?.aborted !== true) this.logger.warn("项目导出 ZIP 附件缩略图生成失败：" + fileName + " / " + String(error));
      }).finally(() => {
        inFlightThumbnails.delete(task);
      });
      inFlightThumbnails.add(task);
    };
    try {
      for (const file of plan.files) {
        if (file.status !== "included" || file.ref === null || file.ref.objectKey === null) continue;
        const objectKey = file.ref.objectKey;
        throwIfAborted(signal);
        processed.add(file);
        let object: Awaited<ReturnType<ObjectStorage["getObjectStream"]>>;
        try {
          telemetry.recordObjectStreamCall();
          object = await telemetry.measure("attachmentOpen", () => this.storage.getObjectStream(objectKey));
        } catch (error) {
          this.logger.warn("项目附件导出读取失败：" + file.fileName + " / " + String(error));
          file.status = "skipped";
          continue;
        }
        if (object === null) {
          file.status = "missing";
          continue;
        }
        const actualSize = object.sizeBytes;
        if (actualSize > PROJECT_ARCHIVE_MAX_FILE_BYTES || includedBytes + actualSize > PROJECT_ARCHIVE_MAX_TOTAL_BYTES) {
          object.stream.destroy();
          file.status = "skipped";
          continue;
        }
        let written: Awaited<ReturnType<ProjectZipWriter["addStream"]>>;
        const shouldCapture = captureIds.has(file.fileId)
          && supportedImage(file.ref)
          && (file.ref.sizeBytes === null || file.ref.sizeBytes <= MAX_IMAGE_BYTES)
          && !reusedImages.has(file.fileId)
          && captureStates.get(file.fileId) !== "pending";
        const capture = shouldCapture ? new ProjectArchiveImageCapture(MAX_IMAGE_BYTES) : undefined;
        if (capture !== undefined) captureStates.set(file.fileId, "pending");
        try {
          written = await telemetry.measure("attachmentZipWrite", () => archive.addStream(
            rootName + "/" + file.relativePath,
            object.stream,
            actualSize,
            {
              compress: shouldCompressProjectArchiveEntry(file.fileName),
              maxBytes: PROJECT_ARCHIVE_MAX_FILE_BYTES,
              ...(capture === undefined ? {} : { onChunk: capture.onChunk }),
            },
          ));
        } catch (error) {
          capture?.discard();
          object.stream.destroy();
          file.status = "skipped";
          this.logger.warn("项目附件写入 ZIP 失败：" + file.fileName + " / " + String(error));
          throw error;
        }
        file.status = "included";
        file.sizeBytes = written.sizeBytes;
        file.sha256 = written.sha256;
        telemetry.recordObjectStreamBytes(written.sizeBytes);
        includedBytes += written.sizeBytes;
        if (capture !== undefined) {
          const bytes = capture.take();
          const extension = bytes === null ? null : sniffProjectExportImage(bytes);
          if (bytes !== null && extension !== null) {
            await scheduleThumbnail(file.fileId, file.fileName, bytes, extension);
          } else {
            captureStates.delete(file.fileId);
          }
        }
      }
      await Promise.all(inFlightThumbnails);
      throwIfAborted(signal);
    } finally {
      await Promise.allSettled(inFlightThumbnails);
      telemetry.recordAttachmentStatuses(plan.files.map((file) => {
        if (file.status === "missing" || file.status === "skipped") return file.status;
        return processed.has(file) ? file.status : "skipped";
      }));
    }
    return reusedImages;
  }

  private async exportProjectStreaming(
    project: ExportProject,
    actorId: string,
    requestOrigin: string,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): Promise<ProjectExportFileResult> {
    let directory: string | undefined;
    let writer: ProjectExportWorkbookWriter | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), TEMP_EXPORT_PREFIX));
      await chmod(directory, 0o700);
      const filePath = join(directory, "project-export.xlsx");
      throwIfAborted(signal);

      const setup = await telemetry.measure("dataLoad", async () => {
        const [userItems, fileItems, reportTotal] = await Promise.all([
          collectPaged((page, limit) => this.users.listUsers({ page, limit }), "用户目录", signal),
          collectPaged((page, limit) => this.files.listProjectFiles(project.id, { page, limit }), "文件", signal),
          this.reports.countForExport(project.id),
        ]);
        const users = this.userLabels(userItems);
        return {
          users,
          reportTotal,
          fileItemsById: new Map(fileItems.map((file) => [file.id, { id: file.id, name: file.name }])),
          groupedIssues: await this.collectIssues(project.id, signal),
          managerLabels: project.managerIds.map((id, index) => personLabel(id, project.managerNames[index] ?? null, users)),
          taskFilesById: this.taskFiles(fileItems),
          relatedByChange: new Map<string, string[]>(),
        };
      });
      const { users, reportTotal, fileItemsById, groupedIssues, managerLabels, taskFilesById, relatedByChange } = setup;
      const counts: StreamingCounts = { tasks: 0, reports: 0, changes: 0, stakeholders: 0, imageIds: new Set() };

      const photoLoader = this.createStreamingPhotoLoader(project.id, signal, telemetry);
      writer = new ProjectExportWorkbookWriter(filePath, project, normalizeHttpOrigin(requestOrigin), photoLoader.load);
      const activeWriter = writer;
      const workbook = await telemetry.measure("workbook", async () => {
        await activeWriter.writeTasks(this.streamTaskRows(project.id, managerLabels, users, taskFilesById, relatedByChange, counts, signal, telemetry));
        await activeWriter.writeReports(prefetchPhotoRows(
          this.streamReportRows(project.id, reportTotal, users, groupedIssues, counts, signal, telemetry),
          (row) => [...row.onsitePhotos, ...row.issuePhotos],
          photoLoader.load,
        ));
        await activeWriter.writeChanges(prefetchPhotoRows(
          this.streamChangeRows(project.id, fileItemsById, users, relatedByChange, counts, signal, telemetry),
          (row) => [...row.beforePhotos, ...row.afterPhotos],
          photoLoader.load,
        ));
        await activeWriter.writeStakeholders(this.streamStakeholderRows(project.id, actorId, users, counts, signal, telemetry));
        throwIfAborted(signal);
        telemetry.setRequestedImages(counts.imageIds.size);
        return activeWriter.commit();
      });
      await telemetry.measure("imageInjection", () => injectWorkbookImages(workbook.filePath, workbook.imagePlacements, workbook.images));
      await chmod(filePath, 0o600);
      const info = await stat(filePath);
      const fileName = projectExportFileName(project);
      const imageCount = workbook.images.size;
      const missingImageCount = [...counts.imageIds].filter((id) => !workbook.images.has(id)).length;
      await telemetry.measure("audit", () => this.audit.record(this.database.db, {
        actorId,
        action: "download",
        objectType: "project",
        objectId: project.id,
        projectId: project.id,
        summary: "导出项目数据：" + project.code + " " + project.name,
        metadata: {
          mode: "stream",
          format: "xlsx",
          sheets: workbook.sheetNames,
          tasks: counts.tasks,
          reports: counts.reports,
          changes: counts.changes,
          stakeholders: counts.stakeholders,
          images: imageCount,
          imageLinks: 0,
          missingImages: missingImageCount,
        },
      }));
      return {
        kind: "file",
        fileName,
        filePath,
        sizeBytes: info.size,
        cleanup: this.tempDirectoryCleanup(directory),
        sheetNames: workbook.sheetNames,
        taskCount: counts.tasks,
        reportCount: counts.reports,
        changeCount: counts.changes,
        stakeholderCount: counts.stakeholders,
        imageCount,
        imageLinkCount: 0,
        missingImageCount,
        mode: "stream",
      };
    } catch (error) {
      if (writer !== undefined) await writer.abort();
      if (directory !== undefined) await this.removeTempDirectory(directory);
      throw error;
    }
  }

  private async collectIssues(
    projectId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ byReport: Map<string, Issue[]>; orphans: Issue[] }> {
    const byReport = new Map<string, Issue[]>();
    const orphans: Issue[] = [];
    for await (const page of readPaged((page, limit) => this.issues.list(projectId, { page, limit }), "问题", signal)) {
      for (const issue of page.items) {
        const sourceReportId = issue.sourceReportId;
        if (sourceReportId === null) {
          orphans.push(issue);
          continue;
        }
        const current = byReport.get(sourceReportId) ?? [];
        current.push(issue);
        byReport.set(sourceReportId, current);
      }
    }
    orphans.sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.createdAt.localeCompare(right.createdAt));
    return { byReport, orphans };
  }

  private async *streamTaskRows(
    projectId: string,
    managerLabels: readonly string[],
    users: ReadonlyMap<string, ProjectExportUserLabel>,
    taskFilesById: ReadonlyMap<string, ExportFileLink[]>,
    relatedByChange: Map<string, string[]>,
    counts: StreamingCounts,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): AsyncGenerator<ProjectExportTaskRow> {
    for await (const page of readPaged(
      (page, limit) => telemetry.measure("dataLoad", () => this.tasks.list(projectId, { page, limit })),
      "任务",
      signal,
    )) {
      for (const task of page.items) {
        throwIfAborted(signal);
        registerTaskChangeLinks(task, relatedByChange);
        counts.tasks += 1;
        yield taskExportRow(task, managerLabels, users, taskFilesById.get(task.id) ?? []);
      }
    }
  }

  private async *streamReportRows(
    projectId: string,
    reportTotal: number,
    users: ReadonlyMap<string, ProjectExportUserLabel>,
    groupedIssues: { byReport: Map<string, Issue[]>; orphans: Issue[] },
    counts: StreamingCounts,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): AsyncGenerator<ProjectExportReportRow> {
    for await (const page of readPagedAscendingFromTotal(
      (page, limit) => telemetry.measure("dataLoad", () => this.reports.list(projectId, { page, limit })),
      reportTotal,
      signal,
    )) {
      for (const report of page) {
        throwIfAborted(signal);
        const issues = groupedIssues.byReport.get(report.id) ?? [];
        groupedIssues.byReport.delete(report.id);
        const row = reportExportRow(report, issues, users);
        addReportPhotoIds(counts.imageIds, row);
        counts.reports += 1;
        yield row;
      }
    }
    const remaining = [...groupedIssues.byReport.values()].flat();
    const orphanIssues = [...groupedIssues.orphans, ...remaining]
      .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.createdAt.localeCompare(right.createdAt));
    for (const issue of orphanIssues) {
      throwIfAborted(signal);
      const row = orphanIssueReportRow(issue, users);
      addReportPhotoIds(counts.imageIds, row);
      counts.reports += 1;
      yield row;
    }
  }

  private async *streamChangeRows(
    projectId: string,
    fileRefs: ReadonlyMap<string, { id: string; name: string }>,
    users: ReadonlyMap<string, ProjectExportUserLabel>,
    relatedByChange: ReadonlyMap<string, string[]>,
    counts: StreamingCounts,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): AsyncGenerator<ProjectExportChangeRow> {
    for await (const page of readPaged(
      (page, limit) => telemetry.measure(
        "dataLoad",
        () => this.changes.listProjectChanges(projectId, { page, limit, sort: "appliedAt:asc" }),
      ),
      "变更",
      signal,
    )) {
      for (const change of page.items) {
        throwIfAborted(signal);
        const row = changeExportRow(change, fileRefs, users, relatedByChange);
        addChangePhotoIds(counts.imageIds, row);
        counts.changes += 1;
        yield row;
      }
    }
  }

  private async *streamStakeholderRows(
    projectId: string,
    actorId: string,
    users: ReadonlyMap<string, ProjectExportUserLabel>,
    counts: StreamingCounts,
    signal: AbortSignal | undefined,
    telemetry: ProjectExportTelemetry,
  ): AsyncGenerator<ProjectExportStakeholderRow> {
    for await (const page of readPaged(
      (page, limit) => telemetry.measure(
        "dataLoad",
        () => this.stakeholders.list({ "filter[projectId]": projectId, page, limit, sort: "createdAt:asc" }, actorId),
      ),
      "干系人",
      signal,
    )) {
      for (const item of page.items) {
        throwIfAborted(signal);
        counts.stakeholders += 1;
        yield stakeholderExportRow(item, users);
      }
    }
  }

  private userLabels(items: readonly { id: string; username: string; displayName: string }[]): Map<string, ProjectExportUserLabel> {
    return new Map(items.map((user) => [user.id, { username: user.username, displayName: user.displayName }]));
  }

  private taskFiles(items: readonly { id: string; name: string; taskId: string | null }[]): Map<string, ExportFileLink[]> {
    const result = new Map<string, ExportFileLink[]>();
    for (const file of items) {
      if (file.taskId === null) continue;
      const current = result.get(file.taskId) ?? [];
      current.push({ id: file.id, name: file.name });
      result.set(file.taskId, current);
    }
    return result;
  }

  private async withStreamingSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.streamingInFlight) throw new AppError("RATE_LIMITED", "大项目导出正在处理中，请稍后重试");
    this.streamingInFlight = true;
    try {
      return await work();
    } finally {
      this.streamingInFlight = false;
    }
  }

  private tempDirectoryCleanup(directory: string): () => Promise<void> {
    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      await this.removeTempDirectory(directory);
    };
  }

  private async removeTempDirectory(directory: string): Promise<void> {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      this.logger.warn("项目导出临时文件清理失败：" + directory + " / " + String(error));
    }
  }

  private async cleanupStaleExportDirectories(): Promise<void> {
    try {
      const entries = await readdir(tmpdir(), { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(TEMP_EXPORT_PREFIX)) continue;
        const path = join(tmpdir(), entry.name);
        const info = await stat(path);
        if (now - info.mtimeMs < STALE_TEMP_EXPORT_MS) continue;
        await this.removeTempDirectory(path);
      }
    } catch (error) {
      this.logger.warn("项目导出启动清理失败：" + String(error));
    }
  }

  private createStreamingPhotoLoader(
    projectId: string,
    signal: AbortSignal | undefined,
    telemetry?: ProjectExportTelemetry,
  ): { load: ExportPhotoLoader; images: Map<string, ExportImage> } {
    const images = new Map<string, ExportImage>();
    const requested = new Set<string>();
    const budget: ImageLoadBudget = { count: 0, totalBytes: 0 };
    const load: ExportPhotoLoader = async (refs) => {
      throwIfAborted(signal);
      const ids = [...new Set(refs.map((ref) => ref.fileId))].filter((id) => !requested.has(id));
      if (ids.length === 0) return images;
      for (const id of ids) requested.add(id);
      if (budget.count >= MAX_IMAGE_COUNT || budget.totalBytes >= MAX_TOTAL_IMAGE_BYTES) return images;
      const fileRefs = telemetry === undefined
        ? await this.files.listExportFileRefs(projectId, ids)
        : await telemetry.measure("dataLoad", () => this.files.listExportFileRefs(projectId, ids));
      throwIfAborted(signal);
      const loaded = await this.loadImages(new Set(ids), fileRefs, WORKBOOK_THUMBNAIL_SIZE, budget, telemetry);
      for (const [id, image] of loaded) images.set(id, image);
      throwIfAborted(signal);
      return images;
    };
    return { load, images };
  }

  private async loadImages(
    ids: Set<string>,
    files: ReadonlyMap<string, ProjectExportFileRef>,
    thumbnail: ImageThumbnailSize | false = false,
    budget?: ImageLoadBudget,
    telemetry?: ProjectExportTelemetry,
    options: ImageLoadOptions = {},
  ): Promise<Map<string, ExportImage>> {
    const candidates = [...ids]
      .map((id) => ({ id, ref: files.get(id) }))
      .filter((item): item is { id: string; ref: ProjectExportFileRef } => {
        const ref = item.ref;
        return ref !== undefined
          && ref.objectKey !== null
          && supportedImage(ref)
          && (ref.sizeBytes === null || ref.sizeBytes <= MAX_IMAGE_BYTES)
          && options.blockedIds?.has(item.id) !== true;
      });
    const result = new Map<string, ExportImage>();
    const activeBudget = budget ?? { count: 0, totalBytes: 0 };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        if (activeBudget.count >= MAX_IMAGE_COUNT || activeBudget.totalBytes >= MAX_TOTAL_IMAGE_BYTES) continue;
        const candidate = candidates[index];
        if (candidate === undefined || candidate.ref.objectKey === null) continue;
        const reused = options.reused?.get(candidate.id);
        if (reused !== undefined) {
          if (reused.sourceBytes > MAX_IMAGE_BYTES || activeBudget.totalBytes + reused.sourceBytes > MAX_TOTAL_IMAGE_BYTES) continue;
          activeBudget.count += 1;
          activeBudget.totalBytes += reused.sourceBytes;
          result.set(candidate.id, reused.image);
          continue;
        }
        const objectKey = candidate.ref.objectKey;
        try {
          telemetry?.recordObjectGetCall();
          const object = telemetry === undefined
            ? await this.storage.getObject(objectKey)
            : await telemetry.measure("thumbnailLoad", () => this.storage.getObject(objectKey));
          if (object === null) continue;
          const bytes = object.bytes;
          telemetry?.recordObjectGetBytes(bytes.length);
          if (activeBudget.count >= MAX_IMAGE_COUNT || bytes.length > MAX_IMAGE_BYTES || activeBudget.totalBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) continue;
          const extension = sniffProjectExportImage(bytes);
          if (extension === null) continue;
          activeBudget.count += 1;
          activeBudget.totalBytes += bytes.length;
          result.set(
            candidate.id,
            thumbnail ? await this.thumbnailImage(bytes, extension, thumbnail, telemetry) : { bytes, extension },
          );
        } catch (error) {
          this.logger.warn("项目导出读取图片失败：" + candidate.ref.name + " / " + String(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, candidates.length) }, () => worker()));
    return result;
  }

  private async thumbnailImage(
    bytes: Uint8Array,
    extension: ExportImage["extension"],
    size: ImageThumbnailSize,
    telemetry?: ProjectExportTelemetry,
  ): Promise<ExportImage> {
    if (bytes.byteLength < 48 * 1024) return { bytes, extension };
    try {
      const canvasApi = await import("@napi-rs/canvas");
      const load = (): Promise<Awaited<ReturnType<typeof canvasApi.loadImage>>> => canvasApi.loadImage(Buffer.from(bytes));
      const image = telemetry === undefined ? await load() : await telemetry.measure("thumbnailDecode", load);
      const render = (): Buffer => {
        const scale = Math.min(1, size.maxWidth / Math.max(1, image.width), size.maxHeight / Math.max(1, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = canvasApi.createCanvas(width, height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        return canvas.toBuffer("image/jpeg", 72);
      };
      const output = telemetry === undefined ? render() : telemetry.measureSync("thumbnailGenerate", render);
      if (output.byteLength >= bytes.byteLength) return { bytes, extension };
      return { bytes: output, extension: "jpeg" };
    } catch (error) {
      this.logger.warn("项目导出缩略图生成失败：" + String(error));
      return { bytes, extension };
    }
  }
}

function supportedImage(ref: { mime: string | null; name: string }): boolean {
  if (ref.mime !== null && (ref.mime.startsWith("image/png") || ref.mime.startsWith("image/jpeg") || ref.mime.startsWith("image/gif"))) return true;
  return /\.(png|jpe?g|gif)$/i.test(ref.name);
}
