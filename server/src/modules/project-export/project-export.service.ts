import { Injectable, Logger } from "@nestjs/common";
import {
  ISSUE_STATE_NAMES,
  STAGE_NAMES,
  type DailyReport,
  type Issue,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { ObjectStorage } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import { ChangeService, FileService } from "../file/index.js";
import { UserService } from "../identity/index.js";
import { ProjectService } from "../project/index.js";
import { IssueService, ReportService } from "../report-issue/index.js";
import { StakeholderService } from "../stakeholder/index.js";
import { TaskService } from "../task/index.js";
import {
  buildProjectExportWorkbook,
  formatCalendarDate,
  formatReportDate,
  formatReportTime,
  formatTaskDate,
  normalizeHttpOrigin,
  numbered,
  projectExportFileName,
  versionNameOf,
  type ExportFileLink,
  type ExportImage,
  type ProjectExportChangeRow,
  type ProjectExportPayload,
  type ProjectExportReportRow,
  type ProjectExportStakeholderRow,
  type ProjectExportTaskRow,
} from "./project-export.workbook.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const IMAGE_CONCURRENCY = 4;
const MAX_IMAGE_COUNT = 250;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024;

const COMPANY_LABELS: Record<string, string> = {
  libiao: "立镖机器人",
  supplier: "供应商supplier",
  general_contractor: "总包单位",
  customer: "客户customer",
};

export interface ProjectExportResult {
  fileName: string;
  buffer: Buffer;
  sheetNames: string[];
  taskCount: number;
  reportCount: number;
  changeCount: number;
  stakeholderCount: number;
  imageCount: number;
  missingImageCount: number;
}

interface UserLabel {
  username: string;
  displayName: string;
}

async function collectPages<T>(
  load: (page: number, limit: number) => Promise<{ items: T[]; total: number }>,
  section: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await load(page, PAGE_SIZE);
    rows.push(...result.items);
    if (result.items.length === 0 || rows.length >= result.total) return rows;
  }
  throw new AppError("INTERNAL", section + "超过导出上限（" + String(MAX_PAGES * PAGE_SIZE) + " 条），请分批导出");
}

function personLabel(id: string | null, fallback: string | null, users: Map<string, UserLabel>): string {
  if (id === null && (fallback === null || fallback === "")) return "";
  const user = id === null ? undefined : users.get(id);
  const display = user?.displayName ?? fallback ?? "";
  const username = user?.username ?? "";
  if (display === "") return username;
  if (username === "" || username === display) return display;
  return display + "(" + username + ")";
}

function joinLabels(labels: readonly string[]): string {
  return labels.filter((label) => label !== "").join("、");
}

function statusName(status: string): string {
  const names: Record<string, string> = {
    pending: "待开始",
    active: "进行中",
    done: "已完成",
    overdue: "已延期",
    early_done: "提前完成",
  };
  return names[status] ?? status;
}

function stageName(stageKey: string | null): string {
  if (stageKey === null) return "";
  return (STAGE_NAMES as Record<string, string>)[stageKey] ?? stageKey;
}

/** 任务的空阶段 = 临时任务（与任务表「未分组 / 临时任务」口径一致）；变更空阶段保持空。 */
function taskStageName(stageKey: string | null): string {
  return stageKey === null ? "临时任务" : stageName(stageKey);
}

function onTimeName(value: boolean | null): string {
  if (value === true) return "按时交付";
  if (value === false) return "延期交付";
  return "";
}

function issueStateName(value: string): string {
  return (ISSUE_STATE_NAMES as Record<string, string>)[value] ?? value;
}

function issueCategoryText(values: readonly string[]): string {
  return values.filter((value) => value !== "").join("、");
}

/**
 * 库内 change_requests.reason 是「变更内容描述」与可选「变更原因」合并后的单列文本：
 * 应用内用「；变更原因：」/「; Change reason: 」，导入表用「；原因：」拼接。
 * 导出恢复为样例两列；识别不到分隔符时整段作为内容描述（导入遗留数据无法再拆）。
 */
export function splitChangeReason(value: string): { content: string; reason: string } {
  for (const marker of ["；变更原因：", "；原因：", "; Change reason: ", "; Change reason:"]) {
    const index = value.indexOf(marker);
    if (index >= 0) {
      return {
        content: value.slice(0, index).trim(),
        reason: value.slice(index + marker.length).trim(),
      };
    }
  }
  return { content: value.trim(), reason: "" };
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

function photoRefs(values: readonly { fileId: string; name: string }[]): Array<{ fileId: string; name: string }> {
  return values.map((value) => ({ fileId: value.fileId, name: value.name }));
}

@Injectable()
export class ProjectExportService {
  private readonly logger = new Logger(ProjectExportService.name);

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
  ) {}

  async exportProject(projectId: string, actorId: string, requestOrigin: string): Promise<ProjectExportResult> {
    const [project, userPage, fileItems, taskItems, reportItems, issueItems, changeItems, stakeholderItems] = await Promise.all([
      this.projects.getProject(projectId, actorId),
      collectPages((page, limit) => this.users.listUsers({ page, limit }), "用户目录"),
      collectPages((page, limit) => this.files.listProjectFiles(projectId, { page, limit }), "文件"),
      collectPages((page, limit) => this.tasks.list(projectId, { page, limit }), "任务"),
      collectPages((page, limit) => this.reports.list(projectId, { page, limit }), "日报"),
      collectPages((page, limit) => this.issues.list(projectId, { page, limit }), "问题"),
      collectPages((page, limit) => this.changes.listProjectChanges(projectId, { page, limit, sort: "appliedAt:asc" }), "变更"),
      collectPages(
        (page, limit) => this.stakeholders.list({ "filter[projectId]": projectId, page, limit, sort: "createdAt:asc" }, actorId),
        "干系人",
      ),
    ]);

    const users = new Map<string, UserLabel>();
    for (const user of userPage) users.set(user.id, { username: user.username, displayName: user.displayName });
    const managerLabels = project.managerIds.map((id, index) => personLabel(id, project.managerNames[index] ?? null, users));

    const taskRows: ProjectExportTaskRow[] = [];
    /** 一次取满项目文件后按任务分组，避免逐任务再查详情（文件默认序 = createdAt desc，与任务详情一致）。 */
    const taskFilesById = new Map<string, ExportFileLink[]>();
    for (const file of fileItems) {
      if (file.taskId === null) continue;
      const current = taskFilesById.get(file.taskId) ?? [];
      current.push({ id: file.id, name: file.name });
      taskFilesById.set(file.taskId, current);
    }
    const relatedByChange = new Map<string, string[]>();
    for (const task of taskItems) {
      const taskFiles = taskFilesById.get(task.id) ?? [];
      for (const link of task.changeLinks) {
        const current = relatedByChange.get(link.id) ?? [];
        if (!current.includes(task.title)) current.push(task.title);
        relatedByChange.set(link.id, current);
      }
      const ownerLabels = task.ownerIds.map((id, index) => personLabel(id, task.ownerNames[index] ?? null, users));
      const changeDates = task.changeLinks.map((link) => formatCalendarDate(link.appliedAt));
      const latestChange = task.changeLinks[task.changeLinks.length - 1];
      taskRows.push({
        description: task.title + (task.titleEn ?? ""),
        managers: joinLabels(managerLabels),
        owners: joinLabels(ownerLabels),
        status: statusName(task.displayStatus),
        progress: task.progress,
        onTime: onTimeName(task.onTime),
        deliverables: task.deliverableTypes.join("、"),
        note: task.note ?? "",
        plannedStart: formatTaskDate(task.plannedStart),
        plannedEnd: formatTaskDate(task.plannedEnd),
        headcount: task.headcount,
        estimatedDays: task.estimatedDays,
        actualEnd: formatTaskDate(task.actualEnd),
        stage: taskStageName(task.stageKey),
        priority: task.priority ?? "",
        endedAt: latestChange === undefined ? "" : formatCalendarDate(latestChange.appliedAt),
        files: taskFiles,
        changeDates,
      });
    }

    const fileIds = new Set<string>();
    for (const files of taskFilesById.values()) for (const file of files) fileIds.add(file.id);
    for (const report of reportItems) {
      for (const photo of report.photos) fileIds.add(photo.fileId);
      for (const photo of report.issuePhotos) fileIds.add(photo.fileId);
    }
    for (const issue of issueItems) for (const photo of issue.photos) fileIds.add(photo.fileId);
    for (const change of changeItems) {
      if (change.fileId !== null) fileIds.add(change.fileId);
      for (const id of change.beforeSummaryFileIds) fileIds.add(id);
      for (const id of change.afterSummaryFileIds) fileIds.add(id);
    }
    const fileRefs = await this.files.listExportFileRefs(projectId, [...fileIds]);

    reportItems.sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt));
    const issueByReport = new Map<string, Issue[]>();
    for (const issue of issueItems) {
      if (issue.sourceReportId === null) continue;
      const current = issueByReport.get(issue.sourceReportId) ?? [];
      current.push(issue);
      issueByReport.set(issue.sourceReportId, current);
    }
    const reportRows: ProjectExportReportRow[] = [];
    for (const report of reportItems) {
      reportRows.push(this.reportRow(report, issueByReport.get(report.id) ?? [], users));
    }
    const reportIds = new Set(reportItems.map((report) => report.id));
    const orphanIssues = issueItems
      .filter((issue) => issue.sourceReportId === null || !reportIds.has(issue.sourceReportId))
      .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.createdAt.localeCompare(right.createdAt));
    for (const issue of orphanIssues) {
      reportRows.push({
        date: formatReportDate(issue.raisedAt, "submitted"),
        author: personLabel(issue.reporterId, issue.reporterName, users),
        doneWork: "",
        plan: "",
        onsitePhotos: [],
        issueDescription: numbered([issue.title]),
        issueCategory: issueCategoryText(issue.categories),
        issueSolution: numbered([issue.solution ?? ""]),
        issueState: issueStateName(issue.state),
        issuePhotos: photoRefs(issue.photos),
        headcount: null,
      });
    }

    const changeRows: ProjectExportChangeRow[] = changeItems.map((change) => {
      const file = change.fileId === null ? undefined : fileRefs.get(change.fileId);
      const reasonParts = splitChangeReason(change.reason);
      const beforePhotos = change.beforeSummaryFileIds.map((id) => ({ fileId: id, name: fileRefs.get(id)?.name ?? id }));
      const afterPhotos = change.afterSummaryFileIds.map((id) => ({ fileId: id, name: fileRefs.get(id)?.name ?? id }));
      const applicant = personLabel(change.appliedBy, null, users);
      return {
        changedAt: formatCalendarDate(change.appliedAt),
        stage: stageName(change.stageKey),
        files: file === undefined ? [] : [{ id: file.id, name: file.name }],
        description: reasonParts.content || change.afterSummary?.trim() || change.beforeSummary?.trim() || "",
        beforeText: change.beforeSummary ?? "",
        afterText: change.afterSummary ?? "",
        reason: reasonParts.reason,
        applicant,
        writer: personLabel(change.writerBy, applicant, users),
        afterVersion: file === undefined ? "" : versionNameOf(file.name),
        afterFiles: file === undefined ? [] : [{ id: file.id, name: file.name }],
        progress: change.status === "applied" ? "已生效" : change.status,
        related: (relatedByChange.get(change.id) ?? []).join("、"),
        beforePhotos,
        afterPhotos,
      };
    });

    const stakeholderRows: ProjectExportStakeholderRow[] = stakeholderItems.map((item) => {
      const companyType = COMPANY_LABELS[item.companyType] ?? item.companyType;
      const positions = [item.title ?? "", item.role ?? ""].filter((value, index, values) => value !== "" && values.indexOf(value) === index);
      return {
        name: item.name,
        contact: [item.phone ?? "", item.wechat ?? ""].filter((value) => value !== "").join(" / "),
        email: item.email ?? "",
        position: positions.join(" / "),
        company: item.company === null || item.company === undefined || item.company === "" ? companyType : companyType + " / " + item.company,
        writer: personLabel(item.createdBy, item.createdByName, users),
        submittedAt: formatReportTime(item.createdAt),
      };
    });

    const imageIds = new Set<string>();
    for (const row of reportRows) {
      for (const photo of row.onsitePhotos) imageIds.add(photo.fileId);
      for (const photo of row.issuePhotos) imageIds.add(photo.fileId);
    }
    for (const row of changeRows) {
      for (const photo of row.beforePhotos) imageIds.add(photo.fileId);
      for (const photo of row.afterPhotos) imageIds.add(photo.fileId);
    }
    const images = await this.loadImages(imageIds, fileRefs);
    const missingIds = new Set<string>();
    for (const id of imageIds) if (!images.has(id)) missingIds.add(id);

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
        format: "xlsx",
        sheets: workbook.sheetNames,
        tasks: taskRows.length,
        reports: reportRows.length,
        changes: changeRows.length,
        stakeholders: stakeholderRows.length,
        images: images.size,
        missingImages: missingIds.size,
      },
    });
    return {
      fileName,
      buffer: workbook.buffer,
      sheetNames: workbook.sheetNames,
      taskCount: taskRows.length,
      reportCount: reportRows.length,
      changeCount: changeRows.length,
      stakeholderCount: stakeholderRows.length,
      imageCount: images.size,
      missingImageCount: missingIds.size,
    };
  }

  private reportRow(report: DailyReport, issues: readonly Issue[], users: Map<string, UserLabel>): ProjectExportReportRow {
    const descriptions = issues.length > 0 ? issues.map((issue) => issue.title) : [report.foundIssue ?? ""];
    const categories = issues.length > 0 ? issues.map((issue) => issueCategoryText(issue.categories)) : [issueCategoryText(report.issueCategories)];
    const solutions = issues.length > 0 ? issues.map((issue) => issue.solution ?? "") : [report.suggestion ?? ""];
    const states = issues.map((issue) => issueStateName(issue.state));
    const issuePhotos = issues.length > 0 ? issues.flatMap((issue) => photoRefs(issue.photos)) : photoRefs(report.issuePhotos);
    return {
      date: formatReportDate(report.date, report.state),
      author: personLabel(report.authorId, report.authorName, users),
      doneWork: report.doneWork,
      plan: report.plan ?? "",
      onsitePhotos: photoRefs(report.photos),
      issueDescription: numbered(descriptions),
      issueCategory: categories.filter((value) => value !== "").join("\n"),
      issueSolution: numbered(solutions),
      issueState: states.length <= 1 ? (states[0] ?? "") : numbered(states),
      issuePhotos,
      headcount: report.headcount,
    };
  }

  private async loadImages(ids: Set<string>, files: Map<string, { name: string; mime: string | null; sizeBytes: number | null; objectKey: string | null }>): Promise<Map<string, ExportImage>> {
    const candidates = [...ids]
      .map((id) => ({ id, ref: files.get(id) }))
      .filter((item): item is { id: string; ref: { name: string; mime: string | null; sizeBytes: number | null; objectKey: string | null } } => {
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
