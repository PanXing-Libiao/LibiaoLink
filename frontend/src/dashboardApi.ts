/**
 * 仪表盘取数（蓝图页「蓝图 ⇄ 仪表盘」转场视图）：项目列表 + 逐项目任务，前端聚合（口径见 data/dashboardProgress.ts）。
 *
 * 说明（2026-10-15）：
 * - 读面全部复用现有接口：GET /api/v1/projects（readAllPages）+ GET /api/v1/projects/{id}/tasks（readAllPages）；
 *   没有新增契约。服务端 dashboard 模块目前是占位（server/src/modules/dashboard/README.md），上量后把聚合
 *   收口到服务端读面 —— 本文件是唯一改动点。
 * - 并发上限 4；失败让调用方决定怎么呈现（蓝图页转场视图给「统计加载失败」）。
 * - Push 334：返回体带上「全部项目」与「逐项目」两份统计 —— 仪表盘标题旁的项目选择器（「项目进度·全部项目」/
 *   「项目进度·{项目名}」）直接切这份 byProject，**不额外发请求**（同一轮取数里顺带按项目分桶）。
 * - Push 335：返回体再带上逐项目任务明细（tasksByProject）与项目经理名（managerByProject）—— 点柱段打开的
 *   「数据详情」只读表用，仍是同一轮取数里存下、**零额外请求**（明细筛选口径见 data/dashboardProgress.ts）。
 * - Push 339：「任务状态」视图（饼图）也用同一轮取数 —— 顺带分桶出 statusAll / statusByProject
 *   （buildDashboardStatus，口径见 data/dashboardProgress.ts），同样零额外请求。
 * - Push 344：「问题」视图（问题状态 × 问题归类分组柱状图 + 点柱只读「数据详情」）的读面在 fetchDashboardIssues ——
 *   问题 / 日报逐项目读面**懒加载**（首次切到「问题」视图才拉，任务读面 / 首屏不受影响），拉完存明细、
 *   切项目 / 开弹窗零请求（口径见 data/dashboardProgress.ts 的 buildDashboardIssues）。
 * - Push 353：「词频图」视图（变更原因核心词词云 + 点词只读「数据详情」）的读面在 fetchDashboardChangeWords ——
 *   变更记录逐项目 + 用户目录（变更申请人 / 填写者列）**懒加载**（首次切到「词频图」才拉）；分词 / 计数口径见
 *   data/changeWords.ts。
 */
import { buildDashboardDelivery, buildDashboardIssues, buildDashboardProgress, buildDashboardStatus, type DashboardDelivery, type DashboardIssues, type DashboardProgress, type DashboardStatus } from "./data/dashboardProgress";
import { fetchProjectList } from "./projectApi";
import { fetchProjectTasks, type ApiTaskListItem } from "./taskApi";
import { fetchProjectIssues, fetchProjectReports } from "./reportApi";
import { fetchProjectChanges, type ApiChangeRequest } from "./fileApi";
import { directoryMemberOptions, loadDirectory } from "./directory";
import { buildDashboardChangeWords, type DashboardChangeWords } from "./data/changeWords";
import type { Member } from "./data/members";
import type { DailyReport, Issue } from "./data/reports";
import { EMPTY_LIST_QUERY } from "./useHashRoute";

/** 并发闸：同时最多 4 个 /tasks 请求在飞。 */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

/** 选择器里的一行（固定第一行「全部项目」由展示层补，这里只放真实项目）。 */
export type DashboardProjectOption = {
  readonly id: string;
  readonly name: string;
};

/** 仪表盘一份完整取数：全部项目聚合 + 逐项目聚合（选择器用）。 */
export type DashboardDataset = {
  readonly options: readonly DashboardProjectOption[];
  /** 全部项目合计（项目进度）。 */
  readonly all: DashboardProgress;
  /** 项目 id → 该项目统计（选择器切换用；同一轮取数里分桶，不再发请求）。 */
  readonly byProject: ReadonlyMap<string, DashboardProgress>;
  /** 全部项目的任务状态分布（Push 339 · 「任务状态」饼图取它）。 */
  readonly statusAll: DashboardStatus;
  /** 项目 id → 该项目任务状态分布（Push 339；同一轮取数里分桶，不再发请求）。 */
  readonly statusByProject: ReadonlyMap<string, DashboardStatus>;
  /** 全部项目的交付结果分布（Push 345 · 「交付时间」视图取它；同一轮取数里分桶，不再发请求）。 */
  readonly deliveryAll: DashboardDelivery;
  /** 项目 id → 该项目交付结果分布（Push 345；同一轮取数里分桶，不再发请求）。 */
  readonly deliveryByProject: ReadonlyMap<string, DashboardDelivery>;
  /** 项目 id → 该项目任务明细（Push 335：点柱段打开的「数据详情」只读表用；同一轮取数里存下，零额外请求）。 */
  readonly tasksByProject: ReadonlyMap<string, readonly ApiTaskListItem[]>;
  /** 项目 id → 项目经理名（契约 managerNames 按「、」连接；「数据详情」表「项目经理」列用）。 */
  readonly managerByProject: ReadonlyMap<string, string>;
};

/** 全量任务聚合 → 阶段 × 进度五档 + 任务五态分布；projects 可传已取好的项目列表（蓝图页地图那份）复用，缺省自己取。 */
export async function fetchDashboardProgress(projects?: readonly { id: string; name: string; managerNames?: readonly (string | null)[] }[]): Promise<DashboardDataset> {
  const list = projects === undefined ? (await fetchProjectList(EMPTY_LIST_QUERY)).items : projects;
  const pages = await mapWithLimit(list, 4, (project) => fetchProjectTasks(project.id));
  const byProject = new Map<string, DashboardProgress>();
  const statusByProject = new Map<string, DashboardStatus>();
  const deliveryByProject = new Map<string, DashboardDelivery>();
  const tasksByProject = new Map<string, readonly ApiTaskListItem[]>();
  const managerByProject = new Map<string, string>();
  const allTasks: Array<{ readonly stageKey: string | null; readonly progress: number; readonly displayStatus: string; readonly onTime: boolean | null }> = [];
  list.forEach((project, index) => {
    const items = pages[index].items;
    byProject.set(project.id, buildDashboardProgress(items));
    statusByProject.set(project.id, buildDashboardStatus(items));
    deliveryByProject.set(project.id, buildDashboardDelivery(items));
    tasksByProject.set(project.id, items);
    managerByProject.set(project.id, (project.managerNames ?? []).filter((name): name is string => name !== null && name !== "").join("、"));
    allTasks.push(...items);
  });
  return {
    options: list.map((project) => ({ id: project.id, name: project.name })),
    all: buildDashboardProgress(allTasks),
    byProject,
    statusAll: buildDashboardStatus(allTasks),
    statusByProject,
    deliveryAll: buildDashboardDelivery(allTasks),
    deliveryByProject,
    tasksByProject,
    managerByProject,
  };
}

/** 仪表盘问题分布取数（Push 344 · 「问题」视图 / 点柱「数据详情」）。 */
export type DashboardIssueDataset = {
  /** 全部项目合计（「问题」视图 · 全部项目口径）。 */
  readonly all: DashboardIssues;
  /** 项目 id → 该项目问题分布（切项目零请求）。 */
  readonly byProject: ReadonlyMap<string, DashboardIssues>;
  /** 项目 id → 该项目问题明细（点柱「数据详情」按 isIssueInCell 筛；同一轮取数里存下）。 */
  readonly issuesByProject: ReadonlyMap<string, readonly Issue[]>;
  /** 项目 id → 该项目日报明细（明细表的报告侧字段 —— 日期 / 当日完成工作 / 施工人数 / 填写者 / 明日计划 / 现场工作附图 —— 按 issue.reportId 取）。 */
  readonly reportsByProject: ReadonlyMap<string, readonly DailyReport[]>;
};

/**
 * 问题 / 日报逐项目读面 → 问题分布 + 明细（懒加载：调用方 = Hub.tsx 首次切到「问题」视图时触发；口径见 data/dashboardProgress.ts）。
 * 两条读面各自并发 4；任一项目失败即整轮失败（调用方落「统计加载失败」，切走再切回会重试）。
 */
export async function fetchDashboardIssues(projects?: readonly { id: string; name: string }[]): Promise<DashboardIssueDataset> {
  const list = projects === undefined ? (await fetchProjectList(EMPTY_LIST_QUERY)).items : projects;
  const [issuePages, reportPages] = await Promise.all([
    mapWithLimit(list, 4, (project) => fetchProjectIssues(project.id)),
    mapWithLimit(list, 4, (project) => fetchProjectReports(project.id)),
  ]);
  const byProject = new Map<string, DashboardIssues>();
  const issuesByProject = new Map<string, readonly Issue[]>();
  const reportsByProject = new Map<string, readonly DailyReport[]>();
  const allIssues: Issue[] = [];
  list.forEach((project, index) => {
    const issues = issuePages[index];
    byProject.set(project.id, buildDashboardIssues(issues));
    issuesByProject.set(project.id, issues);
    reportsByProject.set(project.id, reportPages[index]);
    allIssues.push(...issues);
  });
  return { all: buildDashboardIssues(allIssues), byProject, issuesByProject, reportsByProject };
}

/** 仪表盘词频图取数（Push 353 · 「词频图」视图 / 点词「数据详情」）。 */
export type DashboardWordDataset = {
  /** 全部项目合计（「词频图」· 全部项目口径）。 */
  readonly all: DashboardChangeWords;
  /** 项目 id → 该项目词频（切项目零请求）。 */
  readonly byProject: ReadonlyMap<string, DashboardChangeWords>;
  /** 项目 id → 该项目变更明细（点词「数据详情」按 isChangeWordHit 筛；同一轮取数里存下）。 */
  readonly changesByProject: ReadonlyMap<string, readonly ApiChangeRequest[]>;
  /** 用户目录（「变更申请人 / 填写者」两列的名字 + 工号；与全站目录同口径）。 */
  readonly members: readonly Member[];
};

/**
 * 变更记录逐项目读面 + 用户目录 → 核心词词频 + 明细（懒加载：调用方 = Hub.tsx 首次切到「词频图」时触发；
 * 分词 / 计数口径见 data/changeWords.ts）。变更读面并发 4；任一项目失败即整轮失败（调用方落「统计加载失败」，
 * 切走再切回会重试）。
 */
export async function fetchDashboardChangeWords(projects?: readonly { id: string; name: string }[]): Promise<DashboardWordDataset> {
  const list = projects === undefined ? (await fetchProjectList(EMPTY_LIST_QUERY)).items : projects;
  const [changePages, directory] = await Promise.all([
    mapWithLimit(list, 4, (project) => fetchProjectChanges(project.id)),
    loadDirectory(),
  ]);
  const byProject = new Map<string, DashboardChangeWords>();
  const changesByProject = new Map<string, readonly ApiChangeRequest[]>();
  const allRows: ApiChangeRequest[] = [];
  list.forEach((project, index) => {
    const rows = changePages[index];
    byProject.set(project.id, buildDashboardChangeWords(rows));
    changesByProject.set(project.id, rows);
    for (const row of rows) {
      allRows.push(row);
    }
  });
  return { all: buildDashboardChangeWords(allRows), byProject, changesByProject, members: directoryMemberOptions(directory) };
}
