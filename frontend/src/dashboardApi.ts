/**
 * 仪表盘取数（B4 / M7-02 · 2026-10-21 服务端收口）：
 * - 首屏 GET /api/v1/dashboard/progress 一次拿全部与逐项目任务聚合，不再逐项目拉任务；
 * - 「问题」/「词频图」分别懒加载 GET /api/v1/dashboard/issues 与 /change-words，只拿统计；
 * - 点柱 / 扇区 / 词打开的「数据详情」才按选中项目取一次明细（任务 / 问题 + 日报 / 变更 + 任务 + 目录），
 *   组件层缓存到下一次聚合刷新，避免重复请求。
 */
import { apiRequest } from "./api";
import type { DashboardChangeWords } from "./data/changeWords";
import {
  dashboardIssueKey,
  type DashboardDelivery,
  type DashboardIssues,
  type DashboardProgress,
  type DashboardStatus,
} from "./data/dashboardProgress";
import type { Member } from "./data/members";
import type { DailyReport, Issue } from "./data/reports";
import { directoryMemberOptions, loadDirectory } from "./directory";
import { fetchProjectChanges, type ApiChangeRequest } from "./fileApi";
import { fetchProjectIssues, fetchProjectReports, ISSUE_STATE_NAMES } from "./reportApi";
import { displayStatusLabel, fetchProjectTasks, type ApiTaskListItem } from "./taskApi";

/** 选择器里的一行（固定第一行「全部项目」由展示层补，这里只放真实项目）。 */
export type DashboardProjectOption = {
  readonly id: string;
  readonly name: string;
};

/** 仪表盘首屏数据：全部 + 逐项目聚合；项目顺序 = 项目列表默认排序。 */
export type DashboardDataset = {
  readonly options: readonly DashboardProjectOption[];
  readonly all: DashboardProgress;
  readonly byProject: ReadonlyMap<string, DashboardProgress>;
  readonly statusAll: DashboardStatus;
  readonly statusByProject: ReadonlyMap<string, DashboardStatus>;
  readonly deliveryAll: DashboardDelivery;
  readonly deliveryByProject: ReadonlyMap<string, DashboardDelivery>;
  /** 项目 id → 项目经理显示名（契约 managerNames 用「、」连接）。 */
  readonly managerByProject: ReadonlyMap<string, string>;
};

/** 问题统计（只含全部 / 逐项目聚合；明细在 fetchDashboardIssueDetail 按需取）。 */
export type DashboardIssueDataset = {
  readonly all: DashboardIssues;
  readonly byProject: ReadonlyMap<string, DashboardIssues>;
};

/** 词频统计（只含全部 / 逐项目聚合；明细在 fetchDashboardWordDetail 按需取）。 */
export type DashboardWordDataset = {
  readonly all: DashboardChangeWords;
  readonly byProject: ReadonlyMap<string, DashboardChangeWords>;
};

type ApiDashboardStatus = {
  slices: Array<{ status: string; count: number }>;
  totalTasks: number;
};

type ApiDashboardTaskSummary = {
  progress: DashboardProgress;
  status: ApiDashboardStatus;
  delivery: DashboardDelivery;
};

type ApiDashboardProgressResponse = {
  all: ApiDashboardTaskSummary;
  byProject: Array<{
    projectId: string;
    projectName: string;
    managerNames: Array<string | null>;
    summary: ApiDashboardTaskSummary;
  }>;
};

type ApiDashboardIssues = {
  states: string[];
  categories: string[];
  counts: Array<{ state: string; category: string; count: number }>;
  totalIssues: number;
};

type ApiDashboardIssuesResponse = {
  all: ApiDashboardIssues;
  byProject: Array<{ projectId: string; issues: ApiDashboardIssues }>;
};

type ApiDashboardChangeWordsResponse = {
  all: DashboardChangeWords;
  byProject: Array<{ projectId: string; words: DashboardChangeWords }>;
};

/** 项目任务明细（数据详情）。 */
export type DashboardTaskDetail = {
  readonly tasks: readonly ApiTaskListItem[];
};

/** 项目问题明细（问题 + 来源日报字段）。 */
export type DashboardIssueDetail = {
  readonly issues: readonly Issue[];
  readonly reports: readonly DailyReport[];
};

/** 项目变更明细（变更 + 任务成果类型 + 申请人目录）。 */
export type DashboardWordDetail = {
  readonly changes: readonly ApiChangeRequest[];
  readonly tasks: readonly ApiTaskListItem[];
  readonly members: readonly Member[];
};

/** 仪表盘首屏：服务端一次聚合全部可见项目与逐项目任务统计。 */
export async function fetchDashboardProgress(): Promise<DashboardDataset> {
  const response = await apiRequest<ApiDashboardProgressResponse>("/api/v1/dashboard/progress");
  const byProject = new Map<string, DashboardProgress>();
  const statusByProject = new Map<string, DashboardStatus>();
  const deliveryByProject = new Map<string, DashboardDelivery>();
  const managerByProject = new Map<string, string>();
  const options: DashboardProjectOption[] = [];
  for (const project of response.byProject) {
    options.push({ id: project.projectId, name: project.projectName });
    byProject.set(project.projectId, project.summary.progress);
    statusByProject.set(project.projectId, toDashboardStatus(project.summary.status));
    deliveryByProject.set(project.projectId, project.summary.delivery);
    managerByProject.set(project.projectId, project.managerNames.filter((name): name is string => name !== null && name !== "").join("、"));
  }
  return {
    options,
    all: response.all.progress,
    byProject,
    statusAll: toDashboardStatus(response.all.status),
    statusByProject,
    deliveryAll: response.all.delivery,
    deliveryByProject,
    managerByProject,
  };
}

/** 仪表盘问题分布（首次切到「问题」/「数据总览」时懒加载）。 */
export async function fetchDashboardIssues(): Promise<DashboardIssueDataset> {
  const response = await apiRequest<ApiDashboardIssuesResponse>("/api/v1/dashboard/issues");
  const byProject = new Map<string, DashboardIssues>();
  for (const project of response.byProject) {
    byProject.set(project.projectId, toDashboardIssues(project.issues));
  }
  return { all: toDashboardIssues(response.all), byProject };
}

/** 仪表盘变更原因词频（首次切到「词频图」/「数据总览」时懒加载）。 */
export async function fetchDashboardChangeWords(): Promise<DashboardWordDataset> {
  const response = await apiRequest<ApiDashboardChangeWordsResponse>("/api/v1/dashboard/change-words");
  const byProject = new Map<string, DashboardChangeWords>();
  for (const project of response.byProject) {
    byProject.set(project.projectId, project.words);
  }
  return { all: response.all, byProject };
}

/** 项目任务明细：点任务类图表时才按单个项目取。 */
export async function fetchDashboardTaskDetail(projectId: string): Promise<DashboardTaskDetail> {
  const result = await fetchProjectTasks(projectId);
  return { tasks: result.items };
}

/** 项目问题明细：只取选中项目的问题 / 日报，不再为全部项目预取。 */
export async function fetchDashboardIssueDetail(projectId: string): Promise<DashboardIssueDetail> {
  const [issues, reports] = await Promise.all([fetchProjectIssues(projectId), fetchProjectReports(projectId)]);
  return { issues, reports };
}

/** 项目变更明细：选中项目一次取变更 + 任务 + 用户目录，用于点词后的只读表。 */
export async function fetchDashboardWordDetail(projectId: string): Promise<DashboardWordDetail> {
  const [changes, taskResult, directory] = await Promise.all([
    fetchProjectChanges(projectId),
    fetchProjectTasks(projectId),
    loadDirectory(),
  ]);
  return { changes, tasks: taskResult.items, members: directoryMemberOptions(directory) };
}

function toDashboardStatus(status: ApiDashboardStatus): DashboardStatus {
  return {
    slices: status.slices.map((slice) => ({ status: displayStatusLabel(slice.status), count: slice.count })),
    totalTasks: status.totalTasks,
  };
}

function issueStateLabel(state: string): string | null {
  if (state === "open") return ISSUE_STATE_NAMES.open;
  if (state === "in_progress") return ISSUE_STATE_NAMES.in_progress;
  if (state === "done") return ISSUE_STATE_NAMES.done;
  return null;
}

function toDashboardIssues(issues: ApiDashboardIssues): DashboardIssues {
  const counts = new Map<string, number>();
  const states: string[] = [];
  const seenStates = new Set<string>();
  for (const state of issues.states) {
    const label = issueStateLabel(state);
    if (label !== null && !seenStates.has(label)) {
      seenStates.add(label);
      states.push(label);
    }
  }
  for (const count of issues.counts) {
    const label = issueStateLabel(count.state);
    if (label === null) continue;
    counts.set(dashboardIssueKey(label, count.category), count.count);
  }
  return { states, categories: [...issues.categories], counts, totalIssues: issues.totalIssues };
}
