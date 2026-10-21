import { ISSUE_CATEGORIES, ISSUE_STATES, STAGE_KEYS, STAGE_NAMES } from "@libiaolink/contracts";
import type { DashboardChangeWords, DashboardDelivery, DashboardIssues, DashboardProgress, DashboardStatus, DashboardTaskSummary } from "@libiaolink/contracts";

/**
 * 仪表盘聚合纯规则（不连库）：
 * - 任务桶来自 SQL 的 project_id / stage_key / progress_bin / display_status / delivery_bucket / count；
 * - 状态与交付口径必须与 task.rules 的 deriveDisplayStatus / deriveOnTime 严格同形（dashboard 属平台模块，
 *   不得 import task 领域模块；SQL 与这里的顺序见 dashboard.repository.ts，改口径必须三处同步）；
 * - 问题归类与词频口径沿用前端已确认规则（B4 原实现），只搬动计算位置，不改变业务口径。
 */

export const DASHBOARD_ISSUE_STATE_ORDER = ["done", "in_progress", "open"] as const;

/** Asia/Shanghai 业务日（ADR-028；平台模块不反依赖 task 领域模块，故本地保留同形纯函数）。 */
export function shanghaiToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface DashboardTaskBucketRow {
  projectId: string;
  stageKey: string | null;
  progressBin: number;
  displayStatus: string;
  deliveryBucket: number | null;
  count: number;
}

type DashboardIssueState = DashboardIssues["states"][number];
type DashboardTaskStatus = DashboardStatus["slices"][number]["status"];

export interface DashboardTaskAggregate {
  readonly projectId: string;
  progressCounts: Map<string, number[]>;
  statusCounts: Map<DashboardTaskStatus, number>;
  deliveryCounts: number[];
  pendingDelivery: number;
  totalTasks: number;
}

function emptyCounts(): number[] {
  return [0, 0, 0, 0, 0];
}

function knownStageKey(stageKey: string | null): string {
  return stageKey !== null && (STAGE_KEYS as readonly string[]).includes(stageKey) ? stageKey : "ungrouped";
}

function normalizeDisplayStatus(status: string): DashboardTaskStatus {
  if (status === "done" || status === "active" || status === "pending" || status === "early_done" || status === "overdue") {
    return status;
  }
  return "pending";
}

export function emptyTaskAggregate(projectId = ""): DashboardTaskAggregate {
  return {
    projectId,
    progressCounts: new Map<string, number[]>(STAGE_KEYS.map((key) => [key, emptyCounts()] as const)),
    statusCounts: new Map<DashboardTaskStatus, number>(),
    deliveryCounts: [0, 0, 0],
    pendingDelivery: 0,
    totalTasks: 0,
  };
}

export function addTaskBucket(aggregate: DashboardTaskAggregate, row: DashboardTaskBucketRow): void {
  const count = Number(row.count);
  if (!Number.isFinite(count) || count <= 0) return;
  const key = knownStageKey(row.stageKey);
  if (key === "ungrouped") {
    const counts = aggregate.progressCounts.get("ungrouped") ?? emptyCounts();
    aggregate.progressCounts.set("ungrouped", counts);
  }
  if (Number.isInteger(row.progressBin) && row.progressBin >= 0 && row.progressBin <= 4) {
    const counts = aggregate.progressCounts.get(key);
    if (counts !== undefined) counts[row.progressBin] = (counts[row.progressBin] ?? 0) + count;
    aggregate.totalTasks += count;
  }
  const status = normalizeDisplayStatus(row.displayStatus);
  aggregate.statusCounts.set(status, (aggregate.statusCounts.get(status) ?? 0) + count);
  if (row.deliveryBucket === null) {
    aggregate.pendingDelivery += count;
  } else if (Number.isInteger(row.deliveryBucket) && row.deliveryBucket >= 0 && row.deliveryBucket <= 2) {
    aggregate.deliveryCounts[row.deliveryBucket] = (aggregate.deliveryCounts[row.deliveryBucket] ?? 0) + count;
  }
}

export function progressOf(aggregate: DashboardTaskAggregate): DashboardProgress {
  const rows: DashboardProgress["rows"] = STAGE_KEYS.map((key) => {
    const counts = aggregate.progressCounts.get(key) ?? emptyCounts();
    return { key, label: STAGE_NAMES[key], isUngrouped: false, counts: [...counts], total: counts.reduce((sum, count) => sum + count, 0) };
  });
  const ungrouped = aggregate.progressCounts.get("ungrouped");
  if (ungrouped !== undefined && ungrouped.some((count) => count > 0)) {
    rows.push({ key: "ungrouped", label: "", isUngrouped: true, counts: [...ungrouped], total: ungrouped.reduce((sum, count) => sum + count, 0) });
  }
  return { rows, totalTasks: aggregate.totalTasks };
}

export function statusOf(aggregate: DashboardTaskAggregate): DashboardStatus {
  const slices: DashboardStatus["slices"] = [];
  for (const status of ["active", "done", "pending", "early_done", "overdue"] as const) {
    const count = aggregate.statusCounts.get(status) ?? 0;
    if (count > 0) slices.push({ status, count });
  }
  return { slices, totalTasks: aggregate.totalTasks };
}

export function deliveryOf(aggregate: DashboardTaskAggregate): DashboardDelivery {
  const counts = [...aggregate.deliveryCounts];
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    counts,
    total,
    onTimeRate: total === 0 ? null : Math.round(((counts[0] ?? 0) / total) * 100),
    pendingCount: aggregate.pendingDelivery,
  };
}

export function taskSummaryOf(aggregate: DashboardTaskAggregate): DashboardTaskSummary {
  return { progress: progressOf(aggregate), status: statusOf(aggregate), delivery: deliveryOf(aggregate) };
}

/** 展示态 + 派生 onTime → 交付桶（0 按时 / 1 逾期已交付 / 2 逾期未交付；null = 未到交付节点）。 */
export function deliveryBucketOf(displayStatus: string, onTime: boolean | null): number | null {
  if (displayStatus === "overdue") return 2;
  if (displayStatus !== "done" && displayStatus !== "early_done") return null;
  if (onTime === false) return 1;
  if (onTime === true) return 0;
  return null;
}

export function emptyIssues(): DashboardIssues {
  return { states: [], categories: [], counts: [], totalIssues: 0 };
}

function issueStateName(state: string): string | null {
  return (ISSUE_STATES as readonly string[]).includes(state) ? state : null;
}

export function buildIssues(issues: readonly { state: string; categories: readonly string[] }[]): DashboardIssues {
  const stateSet = new Set<DashboardIssueState>();
  const categorySet = new Set<string>();
  const counts = new Map<string, number>();
  let totalIssues = 0;
  for (const issue of issues) {
    const state = issueStateName(issue.state) as DashboardIssueState | null;
    if (state === null) continue;
    totalIssues += 1;
    for (const category of issue.categories) {
      if (!(ISSUE_CATEGORIES as readonly string[]).includes(category)) continue;
      const key = state + "#" + category;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      stateSet.add(state);
      categorySet.add(category);
    }
  }
  return {
    states: DASHBOARD_ISSUE_STATE_ORDER.filter((state) => stateSet.has(state)),
    categories: ISSUE_CATEGORIES.filter((category) => categorySet.has(category)),
    counts: DASHBOARD_ISSUE_STATE_ORDER.flatMap((state) =>
      ISSUE_CATEGORIES.filter((category) => (counts.get(state + "#" + category) ?? 0) > 0).map((category) => ({
        state,
        category,
        count: counts.get(state + "#" + category) ?? 0,
      })),
    ),
    totalIssues,
  };
}

export const CHANGE_CORE_WORDS: readonly string[] = (
  "客户 甲方 业主 需求 要求 反馈 投诉 供应商 厂家 供货 采购 质检 来料 " +
  "物料 材料 钢材 铝材 钣金 立柱 横梁 货架 托盘 输送线 传送带 机械 电气 电机 传感器 相机 镜头 料箱 飞箱 机器人 软件 硬件 网络 环境 " +
  "结构 支架 护栏 场地 地面 尺寸 规格 型号 数量 颜色 材质 表面 工艺 加工 喷涂 焊接 打磨 装配 安装 拼装 螺栓 螺丝 " +
  "孔位 开孔 打孔 槽位 卡扣 定位 间隙 公差 高度 宽度 长度 厚度 直径 重量 承重 负载 速度 节拍 精度 角度 位置 " +
  "布局 排列 顺序 方向 编号 标签 铭牌 二维码 设计 图纸 规划图 规划 方案 建模 模型 仿真 设计图 施工图 装配图 零件图 " +
  "参数 说明 文档 文件 清单 表单 表格 报告 日报 记录 内容 描述 摘要 备注 项目 任务 阶段 节点 进度 计划 排期 工期 " +
  "交期 时间 日期 现场 实施 调试 验收 发货 到货 物流 运输 装箱 包装 清关 报关 海运 空运 快递 订单 合同 协议 报价 " +
  "价格 成本 预算 费用 付款 发票 质量 品质 缺陷 故障 异常 问题 风险 标准 规范 流程 规则 权限 版本 变更 修改 调整 " +
  "优化 完善 补充 增补 增加 新增 减少 删除 取消 替换 更换 更新 升级 修复 更正 变化 延迟 排产 录入 签收 格式 纠正 返工 返修 重做 补做 遗漏 缺失 " +
  "缺少 错误 失误 偏差 误差 不符 一致 不一致 冲突 矛盾 重复 冗余 待定 原因 结果 影响 建议 意见 确认 审批 审核 沟通 " +
  "协调 配合 支持 售前 组装 部署 试运行 生产"
).split(" ");

const CHANGE_UNIT_WORDS: readonly string[] = ["mm", "cm"];
const CORE_WORD_SET: ReadonlySet<string> = new Set(CHANGE_CORE_WORDS);
const MAX_CORE_WORD_LENGTH: number = CHANGE_CORE_WORDS.reduce((max, word) => Math.max(max, word.length), 0);
const PLACEHOLDER_TEXTS: readonly string[] = ["（内容待补）", "(内容待补)", "（原因待补）", "(原因待补)"];

function isDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

export function tokenizeChangeReason(reason: string): string[] {
  let text = reason.toLowerCase();
  for (const placeholder of PLACEHOLDER_TEXTS) {
    text = text.split(placeholder).join(" ");
  }
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (isDigitAt(text, index)) {
      let end = index;
      while (end < text.length && isDigitAt(text, end)) end += 1;
      const digits = text.slice(index, end);
      if (digits.length >= 2) tokens.push(digits);
      index = end;
      continue;
    }
    const unit = CHANGE_UNIT_WORDS.find((word) => text.startsWith(word, index));
    if (unit !== undefined) {
      tokens.push(unit);
      index += unit.length;
      continue;
    }
    let matched: string | null = null;
    const maxLength = Math.min(MAX_CORE_WORD_LENGTH, text.length - index);
    for (let length = maxLength; length >= 2; length -= 1) {
      const candidate = text.slice(index, index + length);
      if (CORE_WORD_SET.has(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (matched !== null) {
      tokens.push(matched);
      index += matched.length;
      continue;
    }
    index += 1;
  }
  return tokens;
}

export function emptyChangeWords(): DashboardChangeWords {
  return { words: [], totalChanges: 0 };
}

export function buildChangeWords(rows: readonly { reason: string }[]): DashboardChangeWords {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const token of tokenizeChangeReason(row.reason)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const words = Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0));
  return { words, totalChanges: rows.length };
}
