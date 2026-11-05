import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DailyReport, Issue } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { ObjectStorage } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import { ChangeService, FileService, type ProjectExportFileRef } from "../file/index.js";
import { UserService } from "../identity/index.js";
import { ProjectService } from "../project/index.js";
import { IssueService, ReportService } from "../report-issue/index.js";
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
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupStaleExportDirectories();
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
