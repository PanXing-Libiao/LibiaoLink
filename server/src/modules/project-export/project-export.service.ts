import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DailyReport,
  Issue,
  PageExportCatalogResponse,
  PageExportSheetKey,
  PageExportSheetSelection,
  PermissionKey,
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
  projectExportFileName,
  ProjectExportWorkbookWriter,
  type ExportFileLink,
  type ExportImage,
  type ProjectExportChangeRow,
  type ProjectExportPayload,
  type ProjectExportReportRow,
  type ProjectExportStakeholderRow,
  type ProjectExportTaskRow,
} from "./project-export.workbook.js";
import { PAGE_EXPORT_SHEETS, pageExportColumnDefinition, pageExportSheetDefinition, type PageExportColumnDefinition } from "./page-export.catalog.js";
import { pageExportPhotoIds, pageIssueRow, pageReportRow, pageStakeholderRow, type PageExportMappedRow } from "./page-export.mapping.js";
import {
  buildPageExportWorkbook,
  pageExportFileName,
  PageExportWorkbookWriter,
  type PageExportWorkbookRow,
  type PageExportWorkbookSheet,
} from "./page-export.workbook.js";

export { splitChangeReason } from "./project-export.mapping.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MAX_EXPORT_ROWS = PAGE_SIZE * MAX_PAGES;
const AUTO_STREAM_ROW_THRESHOLD = 3_000;
const IMAGE_CONCURRENCY = 4;
const MAX_IMAGE_COUNT = 250;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;
const TEMP_EXPORT_PREFIX = "libiaolink-project-export-";
const STALE_TEMP_EXPORT_MS = 60 * 60 * 1000;

export type ProjectExportModeSetting = "auto" | "legacy" | "stream";
export type ProjectExportExecutionMode = "legacy" | "stream";

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
  mode: ProjectExportExecutionMode;
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
        return {
          key: definition.key,
          label: definition.label,
          allowed,
          rowCount: allowed ? await this.pageExportCountOne(projectId, actorId, definition.key) : 0,
          defaultColumns: defaultColumns.length > 0 ? defaultColumns : columns.filter((column) => column.allowed).slice(0, 1).map((column) => column.key),
          columns,
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

  private pageExportWorkbookSheet(selection: PageExportSheetSelection, rows: readonly PageExportWorkbookRow[]): PageExportWorkbookSheet {
    const definition = pageExportSheetDefinition(selection.sheet);
    return {
      key: definition.key,
      name: definition.label,
      columns: selection.columns.map((key) => {
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
      writer = new PageExportWorkbookWriter(filePath, project.id, normalizeHttpOrigin(requestOrigin));
      for (const selection of selections) {
        const sheet = this.pageExportWorkbookSheet(selection, []);
        await writer.writeSheet(sheet, this.streamPageExportRows(project.id, actorId, selection, users, counts, signal));
      }
      throwIfAborted(signal);
      const workbook = await writer.commit();
      await chmod(filePath, 0o600);
      const info = await stat(filePath);
      const fileName = pageExportFileName(project, selections.map((selection) => ({ name: pageExportSheetDefinition(selection.sheet).label })));
      const fileRefs = counts.imageIds.size === 0
        ? new Map<string, ProjectExportFileRef>()
        : await this.files.listExportFileRefs(project.id, [...counts.imageIds]);
      const missingImageCount = [...counts.imageIds].filter((id) => !fileRefs.has(id)).length;
      await this.auditPageExport(project, actorId, workbook.sheetNames, selections, rowCounts, {
        mode: "stream",
        images: 0,
        imageLinks: counts.imageIds.size,
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
        imageCount: 0,
        imageLinkCount: counts.imageIds.size,
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
        columns: Object.fromEntries(selections.map((selection) => [selection.sheet, selection.columns])),
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
  ): Promise<ProjectExportResult> {
    throwIfAborted(signal);
    const project = await this.projects.getProject(projectId, actorId);
    const mode = await this.resolveMode(projectId, actorId, signal);
    if (mode === "legacy") return this.exportProjectLegacy(project, actorId, requestOrigin, signal);
    return this.withStreamingSlot(() => this.exportProjectStreaming(project, actorId, requestOrigin, signal));
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
  ): Promise<ProjectExportBufferResult> {
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

    const imageIds = new Set<string>();
    for (const row of reportRows) addReportPhotoIds(imageIds, row);
    for (const row of changeRows) addChangePhotoIds(imageIds, row);
    const images = await this.loadImages(imageIds, fileRefs);
    const missingIds = new Set<string>();
    for (const id of imageIds) if (!images.has(id)) missingIds.add(id);
    throwIfAborted(signal);

    const payload: ProjectExportPayload = {
      project: { id: project.id, code: project.code, name: project.name },
      origin: normalizeHttpOrigin(requestOrigin),
      tasks: taskRows,
      reports: reportRows,
      changes: changeRows,
      stakeholders: stakeholderRows,
      images,
    };
    const workbook = await buildProjectExportWorkbook(payload);
    const fileName = projectExportFileName(project);
    await this.audit.record(this.database.db, {
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
        tasks: taskRows.length,
        reports: reportRows.length,
        changes: changeRows.length,
        stakeholders: stakeholderRows.length,
        images: images.size,
        imageLinks: 0,
        missingImages: missingIds.size,
      },
    });
    return {
      kind: "buffer",
      fileName,
      buffer: workbook.buffer,
      sheetNames: workbook.sheetNames,
      taskCount: taskRows.length,
      reportCount: reportRows.length,
      changeCount: changeRows.length,
      stakeholderCount: stakeholderRows.length,
      imageCount: images.size,
      imageLinkCount: 0,
      missingImageCount: missingIds.size,
      mode: "legacy",
    };
  }

  private async exportProjectStreaming(
    project: ExportProject,
    actorId: string,
    requestOrigin: string,
    signal: AbortSignal | undefined,
  ): Promise<ProjectExportFileResult> {
    let directory: string | undefined;
    let writer: ProjectExportWorkbookWriter | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), TEMP_EXPORT_PREFIX));
      await chmod(directory, 0o700);
      const filePath = join(directory, "project-export.xlsx");
      throwIfAborted(signal);

      const [userItems, fileItems, reportIdentity] = await Promise.all([
        collectPaged((page, limit) => this.users.listUsers({ page, limit }), "用户目录", signal),
        collectPaged((page, limit) => this.files.listProjectFiles(project.id, { page, limit }), "文件", signal),
        this.collectReportIdentity(project.id, signal),
      ]);
      const users = this.userLabels(userItems);
      const fileItemsById = new Map(fileItems.map((file) => [file.id, { id: file.id, name: file.name }]));
      const groupedIssues = await this.collectIssues(project.id, reportIdentity.ids, signal);
      const managerLabels = project.managerIds.map((id, index) => personLabel(id, project.managerNames[index] ?? null, users));
      const taskFilesById = this.taskFiles(fileItems);
      const relatedByChange = new Map<string, string[]>();
      const counts: StreamingCounts = { tasks: 0, reports: 0, changes: 0, stakeholders: 0, imageIds: new Set() };

      writer = new ProjectExportWorkbookWriter(filePath, project, normalizeHttpOrigin(requestOrigin));
      await writer.writeTasks(this.streamTaskRows(project.id, managerLabels, users, taskFilesById, relatedByChange, counts, signal));
      await writer.writeReports(this.streamReportRows(project.id, reportIdentity.total, users, groupedIssues, counts, signal));
      await writer.writeChanges(this.streamChangeRows(project.id, fileItemsById, users, relatedByChange, counts, signal));
      await writer.writeStakeholders(this.streamStakeholderRows(project.id, actorId, users, counts, signal));
      throwIfAborted(signal);
      const workbook = await writer.commit();
      await chmod(filePath, 0o600);
      const info = await stat(filePath);
      const fileName = projectExportFileName(project);
      const missingImageCount = [...counts.imageIds].filter((id) => !fileItemsById.has(id)).length;
      await this.audit.record(this.database.db, {
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
          images: 0,
          imageLinks: counts.imageIds.size,
          missingImages: missingImageCount,
        },
      });
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
        imageCount: 0,
        imageLinkCount: counts.imageIds.size,
        missingImageCount,
        mode: "stream",
      };
    } catch (error) {
      if (writer !== undefined) await writer.abort();
      if (directory !== undefined) await this.removeTempDirectory(directory);
      throw error;
    }
  }

  private async collectReportIdentity(
    projectId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ ids: Set<string>; total: number }> {
    const ids = new Set<string>();
    let total = 0;
    for await (const page of readPaged((page, limit) => this.reports.list(projectId, { page, limit }), "日报", signal)) {
      total = page.total;
      for (const report of page.items) ids.add(report.id);
    }
    return { ids, total };
  }

  private async collectIssues(
    projectId: string,
    reportIds: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<{ byReport: Map<string, Issue[]>; orphans: Issue[] }> {
    const byReport = new Map<string, Issue[]>();
    const orphans: Issue[] = [];
    for await (const page of readPaged((page, limit) => this.issues.list(projectId, { page, limit }), "问题", signal)) {
      for (const issue of page.items) {
        const sourceReportId = issue.sourceReportId;
        if (sourceReportId === null || !reportIds.has(sourceReportId)) {
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
  ): AsyncGenerator<ProjectExportTaskRow> {
    for await (const page of readPaged((page, limit) => this.tasks.list(projectId, { page, limit }), "任务", signal)) {
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
  ): AsyncGenerator<ProjectExportReportRow> {
    for await (const page of readPagedAscendingFromTotal(
      (page, limit) => this.reports.list(projectId, { page, limit }),
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
  ): AsyncGenerator<ProjectExportChangeRow> {
    for await (const page of readPaged(
      (page, limit) => this.changes.listProjectChanges(projectId, { page, limit, sort: "appliedAt:asc" }),
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
  ): AsyncGenerator<ProjectExportStakeholderRow> {
    for await (const page of readPaged(
      (page, limit) => this.stakeholders.list({ "filter[projectId]": projectId, page, limit, sort: "createdAt:asc" }, actorId),
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

  private async loadImages(
    ids: Set<string>,
    files: Map<string, ProjectExportFileRef>,
  ): Promise<Map<string, ExportImage>> {
    const candidates = [...ids]
      .map((id) => ({ id, ref: files.get(id) }))
      .filter((item): item is { id: string; ref: ProjectExportFileRef } => {
        const ref = item.ref;
        return ref !== undefined && ref.objectKey !== null && supportedImage(ref) && (ref.sizeBytes === null || ref.sizeBytes <= MAX_IMAGE_BYTES);
      });
    const result = new Map<string, ExportImage>();
    let cursor = 0;
    let totalBytes = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        if (result.size >= MAX_IMAGE_COUNT || totalBytes >= MAX_TOTAL_IMAGE_BYTES) continue;
        const candidate = candidates[index];
        if (candidate === undefined || candidate.ref.objectKey === null) continue;
        try {
          const object = await this.storage.getObject(candidate.ref.objectKey);
          if (object === null) continue;
          const bytes = object.bytes;
          if (result.size >= MAX_IMAGE_COUNT || bytes.length > MAX_IMAGE_BYTES || totalBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) continue;
          const extension = sniffImage(bytes);
          if (extension === null) continue;
          totalBytes += bytes.length;
          result.set(candidate.id, { bytes, extension });
        } catch (error) {
          this.logger.warn("项目导出读取图片失败：" + candidate.ref.name + " / " + String(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, candidates.length) }, () => worker()));
    return result;
  }
}

function supportedImage(ref: { mime: string | null; name: string }): boolean {
  if (ref.mime !== null && (ref.mime.startsWith("image/png") || ref.mime.startsWith("image/jpeg") || ref.mime.startsWith("image/gif"))) return true;
  return /\.(png|jpe?g|gif)$/i.test(ref.name);
}

function sniffImage(bytes: Uint8Array): ExportImage["extension"] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  return null;
}
