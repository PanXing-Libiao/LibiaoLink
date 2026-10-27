/** 项目总结接口：某业务项目的脚本事实包 + 可编辑叙述（不是开发复盘）。 */
import { apiRequest, apiSend } from "./api";

export type ProjectSummaryStatus = "draft" | "confirmed" | "superseded";
export type ProjectSummaryResolution = "resolved" | "unresolved" | "needs_evidence";
export type ProjectSummarySeverity = "high" | "medium" | "low";
export type ProjectSummaryGapKind =
  | "unresolved_issue"
  | "issue_evidence"
  | "overdue_task"
  | "unassigned_task"
  | "missing_deliverable"
  | "status_mismatch"
  | "stale_reports"
  | "missing_baseline";
export type ProjectSummaryTimelineKind = "project" | "stage" | "task" | "report" | "issue" | "change" | "file";

export type ProjectSummaryNarrative = {
  overview: string;
  process: string;
  issues: string;
  result: string;
  handover: string;
  risks: string;
};

export type ProjectSummaryCounts = {
  tasksTotal: number;
  tasksDone: number;
  tasksActive: number;
  tasksPending: number;
  tasksOverdue: number;
  tasksUnassigned: number;
  reportsTotal: number;
  reportsDraft: number;
  reportsSubmitted: number;
  reportsSupplement: number;
  lastReportDate: string | null;
  issuesTotal: number;
  issuesResolved: number;
  issuesUnresolved: number;
  issuesInProgress: number;
  issuesClosedWithoutEvidence: number;
  filesTotal: number;
  filesDraft: number;
  filesFinal: number;
  filesChanged: number;
  filesArchived: number;
  changesTotal: number;
  deliverablesRequired: number;
  deliverablesFinalized: number;
  deliverablesMissing: number;
  stagesTotal: number;
  stagesDone: number;
  stagesActive: number;
};

export type ProjectSummaryStage = {
  stageKey: string;
  name: string;
  seq: number;
  status: "pending" | "active" | "done";
  nodeTotal: number;
  nodeDone: number;
  taskTotal: number;
  taskDone: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
};

export type ProjectSummaryTimelineEvent = {
  date: string;
  kind: ProjectSummaryTimelineKind;
  title: string;
  detail: string;
  actorNames: string[];
};

export type ProjectSummaryIssue = {
  id: string;
  title: string;
  state: "open" | "in_progress" | "done";
  stateName: string;
  categories: string[];
  raisedAt: string;
  reporterName: string | null;
  ownerName: string | null;
  ownerDepartment: string | null;
  solution: string | null;
  closedAt: string | null;
  updatedAt: string;
  resolution: ProjectSummaryResolution;
  followUpOwner: string;
};

export type ProjectSummaryGap = {
  id: string;
  kind: ProjectSummaryGapKind;
  severity: ProjectSummarySeverity;
  title: string;
  detail: string;
  owner: string;
  action: string;
};

export type ProjectSummaryHandover = {
  owner: string;
  items: string[];
};

export type ProjectSummaryDataQuality = {
  severity: ProjectSummarySeverity;
  message: string;
};

export type ProjectSummaryFacts = {
  generatedAt: string;
  dataCutoff: string;
  project: {
    id: string;
    code: string;
    name: string;
    customer: string | null;
    region: string;
    projectType: string;
    stageKey: string;
    stageName: string;
    status: string;
    statusName: string;
    managerNames: string[];
    description: string | null;
    createdAt: string;
    archivedAt: string | null;
  };
  counts: ProjectSummaryCounts;
  stages: ProjectSummaryStage[];
  timeline: ProjectSummaryTimelineEvent[];
  issues: ProjectSummaryIssue[];
  gaps: ProjectSummaryGap[];
  handover: ProjectSummaryHandover[];
  dataQuality: ProjectSummaryDataQuality[];
  evidence: {
    tasks: number;
    reports: number;
    issues: number;
    files: number;
    changes: number;
    stages: number;
  };
};

export type ProjectSummaryView = {
  id: string;
  projectId: string;
  dataCutoff: string;
  status: ProjectSummaryStatus;
  facts: ProjectSummaryFacts;
  narrative: ProjectSummaryNarrative;
  engine: string;
  model: string | null;
  promptVersion: string;
  fallbackReason: string | null;
  generatedBy: string;
  generatedByName: string | null;
  generatedAt: string;
  confirmedBy: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
};

export type ProjectSummaryLatestResponse = {
  item: ProjectSummaryView | null;
  canEdit: boolean;
};

const basePath = (projectId: string): string => "/api/v1/projects/" + encodeURIComponent(projectId) + "/project-summaries";

export function fetchLatestProjectSummary(projectId: string, signal?: AbortSignal): Promise<ProjectSummaryLatestResponse> {
  return apiRequest<ProjectSummaryLatestResponse>(basePath(projectId) + "/latest", signal === undefined ? {} : { signal });
}

/** 生成草稿：事实包由服务端脚本读取并定稿；AI 仅写叙述，失败自动回落规则模板。 */
export function generateProjectSummary(projectId: string): Promise<ProjectSummaryView> {
  return apiSend<ProjectSummaryView>(basePath(projectId), "POST");
}

export function updateProjectSummaryNarrative(
  projectId: string,
  summaryId: string,
  version: number,
  narrative: ProjectSummaryNarrative,
): Promise<ProjectSummaryView> {
  return apiSend<ProjectSummaryView>(basePath(projectId) + "/" + encodeURIComponent(summaryId), "PATCH", { version, narrative });
}

export function confirmProjectSummary(projectId: string, summaryId: string, version: number): Promise<ProjectSummaryView> {
  return apiSend<ProjectSummaryView>(basePath(projectId) + "/" + encodeURIComponent(summaryId) + "/confirm", "POST", { version });
}
