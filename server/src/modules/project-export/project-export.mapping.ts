import {
  ISSUE_STATE_NAMES,
  STAGE_NAMES,
  ChangeRequestSchema,
  StakeholderSchema,
  TaskListItemSchema,
  type DailyReport,
  type Issue,
  z,
} from "@libiaolink/contracts";
import {
  formatCalendarDate,
  formatReportDate,
  formatReportTime,
  formatTaskDate,
  numbered,
  versionNameOf,
  type ExportFileLink,
  type ProjectExportChangeRow,
  type ProjectExportReportRow,
  type ProjectExportStakeholderRow,
  type ProjectExportTaskRow,
} from "./project-export.workbook.js";

export interface ProjectExportUserLabel {
  username: string;
  displayName: string;
}

type TaskExportItem = z.infer<typeof TaskListItemSchema>;
type ChangeExportItem = z.infer<typeof ChangeRequestSchema>;
type StakeholderExportItem = z.infer<typeof StakeholderSchema>;

const COMPANY_LABELS: Record<string, string> = {
  libiao: "立镖机器人",
  supplier: "供应商supplier",
  general_contractor: "总包单位",
  customer: "客户customer",
};

export function personLabel(
  id: string | null,
  fallback: string | null,
  users: ReadonlyMap<string, ProjectExportUserLabel>,
): string {
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

function photoRefs(values: readonly { fileId: string; name: string }[]): Array<{ fileId: string; name: string }> {
  return values.map((value) => ({ fileId: value.fileId, name: value.name }));
}

export function taskExportRow(
  task: TaskExportItem,
  managerLabels: readonly string[],
  users: ReadonlyMap<string, ProjectExportUserLabel>,
  taskFiles: readonly ExportFileLink[],
): ProjectExportTaskRow {
  const ownerLabels = task.ownerIds.map((id, index) => personLabel(id, task.ownerNames[index] ?? null, users));
  const latestChange = task.changeLinks[task.changeLinks.length - 1];
  return {
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
    files: [...taskFiles],
    changeDates: task.changeLinks.map((link) => formatCalendarDate(link.appliedAt)),
  };
}

/** 变更关联按任务列表顺序累积；同一变更关联到多个任务时按首次出现顺序展示。 */
export function registerTaskChangeLinks(task: TaskExportItem, relatedByChange: Map<string, string[]>): void {
  for (const link of task.changeLinks) {
    const current = relatedByChange.get(link.id) ?? [];
    if (!current.includes(task.title)) current.push(task.title);
    relatedByChange.set(link.id, current);
  }
}

export function reportExportRow(
  report: DailyReport,
  issues: readonly Issue[],
  users: ReadonlyMap<string, ProjectExportUserLabel>,
): ProjectExportReportRow {
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

export function orphanIssueReportRow(
  issue: Issue,
  users: ReadonlyMap<string, ProjectExportUserLabel>,
): ProjectExportReportRow {
  return {
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
  };
}

export function changeExportRow(
  change: ChangeExportItem,
  fileRefs: ReadonlyMap<string, { id: string; name: string }>,
  users: ReadonlyMap<string, ProjectExportUserLabel>,
  relatedByChange: ReadonlyMap<string, string[]>,
): ProjectExportChangeRow {
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
}

export function stakeholderExportRow(
  item: StakeholderExportItem,
  users: ReadonlyMap<string, ProjectExportUserLabel>,
): ProjectExportStakeholderRow {
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
}
