/**
 * 仪表盘数据口径（蓝图页「蓝图 ⇄ 仪表盘」转场视图 · 2026-10-15 业务口径「鼠标滑动蓝图转场展示仪表盘」）。
 *
 * 形态 = 「阶段 × 进度五档」横向堆叠条 —— 效果图业务已确认（「效果不错」）；落地时按业务口径
 * 「多余的注释和文字不需要」去掉了效果图上的数据来源 / 口径注释，只留标题 + 图例 + 数据本身。
 *
 * 口径（改规则只改这里）：
 * - 行 = 九阶段（契约 STAGE_KEYS 序：售前规划 / 设计开发 / 加工采购 / 组装发货 / 硬件实施 / 软件部署 /
 *   试运行 / 生产阶段 / 验收）+「未分组」（stageKey 为空的临时任务；没有就不出行，落最后一行）。
 * - 档 = 任务进度本身：契约 TaskProgress 就是离散五档（0 / 0.25 / 0.5 / 0.75 / 1），直接落档、不做就近收敛
 *   （「进行中收 25/50/75」只发生在旧表导入折算里，见服务端 project-import/legacy.ts）；异常小数按
 *   最近档四舍五入兜底（与契约迁移口径一致：0.49 → 0.5）。
 * - 段上数字 = 该档任务数；行右侧合计 = 该阶段任务总数。
 * - 汇总范围 = 全部项目（项目列表读面 + 逐项目任务读面前端聚合，取数在 src/dashboardApi.ts；
 *   服务端 dashboard 读面未落地 —— server/src/modules/dashboard/README.md 仍是占位，上量后再收口）。
 *
 * Push 339（2026-10-15 业务口径「现在准备做这个任务状态的」+「已延期也要的 只是没有相关的任务状态才没显示在图中」）：
 * 同一份任务读面再聚一份「任务状态」分布（buildDashboardStatus）—— 供仪表盘第二个视图（任务状态饼图）用；
 * 状态取服务端展示态（displayStatusLabel，与任务表 / 数据详情同源），0 条的状态不进 slices（图上整条不出现）。
 */
import { displayStatusLabel, stageNameOf } from "../taskApi";
import { ISSUE_STATE_NAMES } from "../reportApi";
import { isCompleteStatus, type TaskStatus } from "./tasks";

/** 进度五档（契约 TaskProgressSchema）：堆叠顺序 = 从左到右 0 → 1。 */
export const DASHBOARD_BINS = [0, 0.25, 0.5, 0.75, 1] as const;

/** 九阶段行键（与契约 STAGE_KEYS 同序）：前端本地维护一份（与 taskApi 的 STAGE_NAMES_BY_KEY 同源口径）。 */
export const DASHBOARD_STAGE_KEYS = [
  "presale",
  "design",
  "purchase",
  "assembly",
  "install",
  "deploy",
  "trial",
  "production",
  "acceptance",
] as const;

/** 一行 = 一个阶段（或「未分组」）的五档分布。 */
export type DashboardRow = {
  /** 行键：九阶段 key 或 "ungrouped"。 */
  readonly key: string;
  /** 行标题（中文阶段名；「未分组」行为空串，展示层用 i18n 键）。 */
  readonly label: string;
  /** 是否「未分组」行（展示层据此换 i18n 文案）。 */
  readonly isUngrouped: boolean;
  /** 五档计数，与 DASHBOARD_BINS 同下标。 */
  readonly counts: readonly number[];
  /** 该行任务总数（= counts 合计）。 */
  readonly total: number;
};

export type DashboardProgress = {
  readonly rows: readonly DashboardRow[];
  /** 任务总数（跨全部项目）。 */
  readonly totalTasks: number;
};

/** 聚合输入的最小任务形状（ApiTaskListItem 满足）。 */
export type DashboardTaskLike = {
  readonly stageKey: string | null;
  readonly progress: number;
};

/** 进度值 → 档下标（0..4）：就近档四舍五入；非数值返回 -1（不计入）。 */
export function progressBinIndex(progress: number): number {
  if (!Number.isFinite(progress)) {
    return -1;
  }
  return Math.min(4, Math.max(0, Math.round(progress * 4)));
}

/** 九阶段 key 集合（判断 stageKey 是否落在既有行上：不在 = 归「未分组」行）。 */
const KNOWN_STAGE_KEYS: readonly string[] = DASHBOARD_STAGE_KEYS;

/**
 * 任务是否落在该（行 × 档）格子里 —— 点击柱段打开的「数据详情」列表按它筛（Push 335）。
 * 与 buildDashboardProgress 同一套口径：档 = progressBinIndex；行 = stageKey 命中该阶段，未命中（含未知 key
 * 与 stageKey 为空）都归「未分组」行。保证「段上数字 = 详情表行数」。
 */
export function isTaskInCell(task: DashboardTaskLike, rowKey: string, bin: number): boolean {
  if (progressBinIndex(task.progress) !== bin) {
    return false;
  }
  if (rowKey === "ungrouped") {
    return task.stageKey === null || !KNOWN_STAGE_KEYS.includes(task.stageKey);
  }
  return task.stageKey === rowKey;
}

/** 聚合中的可变行（key 放宽成 string，兼容 stageKey 的任何落库值）。 */
type MutableRow = { key: string; label: string; isUngrouped: boolean; counts: number[] };

/** 全量任务 → 阶段 × 进度五档（纯函数，取数见 dashboardApi.ts）。 */
export function buildDashboardProgress(tasks: readonly DashboardTaskLike[]): DashboardProgress {
  const stageRows: MutableRow[] = DASHBOARD_STAGE_KEYS.map((key) => ({
    key,
    label: stageNameOf(key),
    isUngrouped: false,
    counts: [0, 0, 0, 0, 0],
  }));
  const ungroupedRow: MutableRow = { key: "ungrouped", label: "", isUngrouped: true, counts: [0, 0, 0, 0, 0] };
  const byKey = new Map<string, MutableRow>(stageRows.map((row) => [row.key, row] as const));
  let totalTasks = 0;
  for (const task of tasks) {
    const bin = progressBinIndex(task.progress);
    if (bin < 0) {
      continue;
    }
    const target = (task.stageKey !== null ? byKey.get(task.stageKey) : undefined) ?? ungroupedRow;
    target.counts[bin] += 1;
    totalTasks += 1;
  }
  const rows = ungroupedRow.counts.some((count) => count > 0) ? [...stageRows, ungroupedRow] : stageRows;
  return {
    rows: rows.map((row) => ({ ...row, total: row.counts.reduce((sum, count) => sum + count, 0) })),
    totalTasks,
  };
}

/**
 * 任务状态展示序（Push 339 · 与业务参考图同序：图例顺序 = 扇区顺时针顺序；「已延期」垫底 ——
 * 没有该态任务时整条不出现，见业务口径「已延期也要的 只是没有相关的任务状态才没显示在图中」）。
 */
export const DASHBOARD_STATUS_ORDER: readonly TaskStatus[] = ["进行中", "已完成", "待开始", "提前完成", "已延期"];

/** 一枚状态切片（只含 count > 0 的状态；顺序 = DASHBOARD_STATUS_ORDER）。 */
export type DashboardStatusSlice = {
  readonly status: TaskStatus;
  readonly count: number;
};

/** 任务状态分布（「任务状态」饼图口径 · Push 339）。 */
export type DashboardStatus = {
  readonly slices: readonly DashboardStatusSlice[];
  readonly totalTasks: number;
};

/** 聚合输入的最小任务形状（ApiTaskListItem 满足）：只吃服务端展示态。 */
export type DashboardStatusTaskLike = {
  readonly displayStatus: string;
};

/** 全量任务 → 任务五态分布（纯函数；0 条的状态不出现在 slices 里 = 图上不出现）。 */
export function buildDashboardStatus(tasks: readonly DashboardStatusTaskLike[]): DashboardStatus {
  const counts = new Map<TaskStatus, number>();
  let totalTasks = 0;
  for (const task of tasks) {
    const status = displayStatusLabel(task.displayStatus);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    totalTasks += 1;
  }
  return {
    slices: DASHBOARD_STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
    })),
    totalTasks,
  };
}

/**
 * 问题分布口径（Push 344 · 业务口径 2026-10-16「现在做这个问题 效果和上面做的一样」）：
 * 仪表盘第三个视图 ——「问题」分组柱状图（x = 问题状态、图例 = 问题归类）用；取数与明细在 src/dashboardApi.ts
 * 的 fetchDashboardIssues（懒加载：首次切到「问题」视图才拉问题 / 日报读面，任务读面不受影响）。
 *
 * 口径（改规则只改这里）：
 * - x 轴 = 问题三态展示名（已完成 / 处理中 / 未解决，DASHBOARD_ISSUE_STATE_ORDER），**0 条的状态整组不出现**
 *   （与「任务状态」饼图同一口径：业务口径「没有相关的任务状态才没显示在图中」）。
 * - 图例 / 分组内柱序 = 问题归类十项契约原序（DASHBOARD_ISSUE_CATEGORY_ORDER），**0 条的归类整条不出现**。
 * - 一条问题多归类时**每个归类各计一条**（柱高 = 命中该（状态 × 归类）的问题数；各柱之和可大于问题总数）。
 * - 配色 DASHBOARD_ISSUE_COLORS 只服务柱状图 / 图例 / 悬停卡色点；明细表的归类色签仍走「问题追踪」那套浅底色表。
 */
/** 问题状态展示序（Push 344 · 与业务参考图同序：已完成在左，未解决垫底）。 */
export const DASHBOARD_ISSUE_STATE_ORDER: readonly string[] = ["已完成", "处理中", "未解决"];

/** 问题归类展示序（Push 344 · 契约 C9 十项原序：机械部 / 采购部 / 规划部 / 项目部 / 物流原因 / 供应商原因 / 客户原因 / 客观原因 / 生产原因 / 其它原因）。 */
export const DASHBOARD_ISSUE_CATEGORY_ORDER: readonly string[] = ["机械部", "采购部", "规划部", "项目部", "物流原因", "供应商原因", "客户原因", "客观原因", "生产原因", "其它原因"];

/** 分组柱状图配色（Push 344 · 前五项与业务参考图同族：机械部蓝 / 规划部绿 / 供应商原因黄 / 客户原因橙 / 其它原因紫，其余按同族补足）。 */
export const DASHBOARD_ISSUE_COLORS: Readonly<Record<string, string>> = {
  机械部: "#2f7ef2",
  采购部: "#0ea5e9",
  规划部: "#22c55e",
  项目部: "#06b6d4",
  物流原因: "#64748b",
  供应商原因: "#f5c518",
  客户原因: "#f97316",
  客观原因: "#7c3aed",
  生产原因: "#ec4899",
  其它原因: "#a855f7",
};

/** 聚合输入的最小问题形状（data/reports.ts 的 Issue 满足）。 */
export type DashboardIssueLike = {
  readonly state: string;
  readonly categories: readonly string[];
};

/** 问题分布（「问题」柱状图口径 · Push 344）。 */
export type DashboardIssues = {
  /** 有数据的状态（展示序：已完成 / 处理中 / 未解决；0 条的不出现）。 */
  readonly states: readonly string[];
  /** 有数据的归类（契约 C9 原序；0 条的不出现）。 */
  readonly categories: readonly string[];
  /** 计数键 dashboardIssueKey(state, category) → 条数。 */
  readonly counts: ReadonlyMap<string, number>;
  /** 问题总数（明细行数口径，与柱高口径分开：多归类问题在每个归类各计一条）。 */
  readonly totalIssues: number;
};

/** （状态 × 归类）计数键。 */
export function dashboardIssueKey(state: string, category: string): string {
  return state + "#" + category;
}

/** 契约三态 → 展示名（未收录的态返回 null = 不计入）。 */
function issueStateNameOf(state: string): string | null {
  if (state === "open") {
    return ISSUE_STATE_NAMES.open;
  }
  if (state === "in_progress") {
    return ISSUE_STATE_NAMES.in_progress;
  }
  if (state === "done") {
    return ISSUE_STATE_NAMES.done;
  }
  return null;
}

/** 全量问题 → 状态 × 归类分布（纯函数，取数见 dashboardApi.ts；0 条的状态 / 归类都不出现在结果里 = 图上不出现）。 */
export function buildDashboardIssues(issues: readonly DashboardIssueLike[]): DashboardIssues {
  const counts = new Map<string, number>();
  const states = new Set<string>();
  const categories = new Set<string>();
  let totalIssues = 0;
  for (const issue of issues) {
    const state = issueStateNameOf(issue.state);
    if (state === null) {
      continue;
    }
    totalIssues += 1;
    for (const category of issue.categories) {
      if (!DASHBOARD_ISSUE_CATEGORY_ORDER.includes(category)) {
        continue;
      }
      const key = dashboardIssueKey(state, category);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      states.add(state);
      categories.add(category);
    }
  }
  return {
    states: DASHBOARD_ISSUE_STATE_ORDER.filter((state) => states.has(state)),
    categories: DASHBOARD_ISSUE_CATEGORY_ORDER.filter((category) => categories.has(category)),
    counts,
    totalIssues,
  };
}

/** 问题是否落在该（状态 × 归类）格子里 —— 点柱打开的「数据详情」行按它筛（保证「柱上数字 = 表行数」）。 */
export function isIssueInCell(issue: DashboardIssueLike, state: string, category: string): boolean {
  return issueStateNameOf(issue.state) === state && issue.categories.includes(category);
}

/**
 * 「交付时间」视图口径（Push 345 · 业务口径 2026-10-16「这个交付时间也要做一个图表 但是它的这个逻辑我没搞懂
 * 感觉也不好 请你重新设计一个告诉我」+「选择B方案 叫交付时间 加一个「按时率」的小结」；
 * Push 346 追订「取消提前完成展示」：提前完成并入按时交付、不再单独占一档）：
 * 仪表盘第四个视图 —— 三结果竖直柱状图（按时交付 / 逾期已交付 / 逾期未交付）+ 右上「按时率」小结 +
 * 「未到交付节点」注记；取数与明细在 src/dashboardApi.ts（与进度 / 状态同一轮取数，零额外请求）。
 *
 * 口径（改规则只改这里；与任务表「是否按时交付」列 + 展示态同源，见 HubDashDetail.onTimeLabelOf / data/tasks.ts）：
 * - 分类 = 服务端展示态（displayStatus）+ onTime 三选一：已延期 → 逾期未交付；完成态（已完成 / 提前完成）且
 *   onTime=false → 逾期已交付；完成态且 onTime=true → 按时交付（提前完成并入，不单独展示）。
 * - 未到交付节点（进行中 / 待开始 / 完成但未判定 onTime=null）不计入（只进注记条数）。
 * - 按时率 = 按时交付 ÷ 已交付合计（三结果之和），百分比取整；分母 0 → 显示「—」。
 */

/** 仪表盘页内视图 id（Push 345 · 业务口径「选择后刷新不变 按账号记住」；Push 353 加「词频图」、Push 358 加「数据总览」；与契约 HUB_DASH_VIEW_IDS 同源）：
 *  overview = 数据总览（Push 358 · 切换栏最左；五图等比例缩小总览；不设默认，缺省仍 progress）/
 *  progress = 项目进度（默认）/ status = 任务状态 / issues = 问题 / delivery = 交付时间 / wordcloud = 词频图。 */
export const HUB_DASH_VIEW_IDS = ["overview", "progress", "status", "issues", "delivery", "wordcloud"] as const;

export type HubDashView = (typeof HUB_DASH_VIEW_IDS)[number];

/** 偏好里读回的页内视图收敛（白名单外 / 坏值 → progress，不抛错 —— 与读侧收敛同口径）。 */
export function asHubDashView(value: unknown): HubDashView {
  return typeof value === "string" && (HUB_DASH_VIEW_IDS as readonly string[]).includes(value) ? (value as HubDashView) : "progress";
}

/** 交付结果展示序（Push 345；Push 346 追订起三档 —— 从左到右：按时交付 → 逾期已交付 → 逾期未交付；0 条也固定占位）。 */
export const DASHBOARD_DELIVERY_ORDER = ["按时交付", "逾期已交付", "逾期未交付"] as const;

export type DashboardDeliveryBucket = (typeof DASHBOARD_DELIVERY_ORDER)[number];

/** 聚合输入的最小任务形状（ApiTaskListItem 满足）：吃服务端展示态 + onTime。 */
export type DashboardDeliveryTaskLike = {
  readonly displayStatus: string;
  readonly onTime: boolean | null;
};

/** 任务 → 交付结果（null = 未到交付节点 / 未判定，不计入）—— 与任务表「是否按时交付」列同一套判定（提前完成 = 按时交付）。 */
export function deliveryBucketOf(task: DashboardDeliveryTaskLike): DashboardDeliveryBucket | null {
  const status = displayStatusLabel(task.displayStatus);
  if (status === "已延期") {
    return "逾期未交付";
  }
  if (isCompleteStatus(status)) {
    if (task.onTime === false) {
      return "逾期已交付";
    }
    if (task.onTime === null) {
      return null;
    }
    return "按时交付";
  }
  return null;
}

/** 交付结果分布（「交付时间」视图口径 · Push 345）。 */
export type DashboardDelivery = {
  /** 三结果计数（下标与 DASHBOARD_DELIVERY_ORDER 同序；0 也保留 —— 图上三档固定）。 */
  readonly counts: readonly number[];
  /** 已交付合计（三结果之和 = 按时率分母）。 */
  readonly total: number;
  /** 按时率（百分比取整 0~100）；分母 0 → null（显示「—」）。 */
  readonly onTimeRate: number | null;
  /** 未到交付节点（进行中 / 待开始 / 完成但未判定）的任务数（不计入本图）。 */
  readonly pendingCount: number;
};

/** 全量任务 → 交付结果分布（纯函数，取数见 dashboardApi.ts）。 */
export function buildDashboardDelivery(tasks: readonly DashboardDeliveryTaskLike[]): DashboardDelivery {
  const counts = DASHBOARD_DELIVERY_ORDER.map(() => 0);
  let total = 0;
  let pendingCount = 0;
  for (const task of tasks) {
    const bucket = deliveryBucketOf(task);
    if (bucket === null) {
      pendingCount += 1;
      continue;
    }
    counts[DASHBOARD_DELIVERY_ORDER.indexOf(bucket)] += 1;
    total += 1;
  }
  return {
    counts,
    total,
    onTimeRate: total === 0 ? null : Math.round((counts[0] / total) * 100),
    pendingCount,
  };
}

/** 任务是否落在该交付结果柱里 —— 点柱打开的「数据详情」按它筛（保证柱上数字 = 表行数）。 */
export function isTaskInDeliveryBucket(task: DashboardDeliveryTaskLike, bucket: DashboardDeliveryBucket): boolean {
  return deliveryBucketOf(task) === bucket;
}

/** 任务是否未到交付节点（右上注记「未到交付节点 N 条」—— 点注记打开的「数据详情」按它筛）。 */
export function isTaskPendingDelivery(task: DashboardDeliveryTaskLike): boolean {
  return deliveryBucketOf(task) === null;
}
