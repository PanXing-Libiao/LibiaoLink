/**
 * 任务 UI 模型与纯展示辅助（M3-07 刀 1 后半接线版）。
 * 数据来源 = 服务端任务接口（frontend/src/taskApi.ts 负责契约 → 本模型的映射）；本文件不再含演示数据，
 * 也不做任何状态 / 逾期的本地派生 —— 展示态（displayStatus）、是否按时交付（onTime）、阶段汇总均由服务端裁决。
 */
export type TaskStatus = "已完成" | "提前完成" | "进行中" | "待开始" | "已延期";

/** 紧急重要度三档（契约 Priority：高 / 中 / 低；2026-09-24 定案四象限口径作废）。 */
export type TaskPriority = "高" | "中" | "低";

/** 变更关联项（契约 Task.changeLinks）：reason 服务端下发短文本（可空），appliedAt 为变更生效时间。 */
export type TaskChange = {
  id: string;
  reason: string;
  /** 生效时间（ISO8601；展示时取日期部分）。 */
  appliedAt: string;
};

/** 任务随行文件摘要（契约 TaskListItem.fileSummary）：列表只渲染计数，文件名只在详情抽屉。 */
export type TaskFileSummary = {
  total: number;
  draft: number;
  final: number;
};

/**
 * 任务（列表行 / 看板卡片 / 甘特条 / 抽屉共用一份模型）。
 * 日期字段一律 **ISO（YYYY-MM-DD）或空串**（服务端 DateOnly 口径）。
 */
export type ProjectTask = {
  id: string;
  /** 来源流程节点（契约 nodeId）：蓝图实例上的节点；节点库来源的任务为 null。 */
  nodeId: string | null;
  /** 来源任务节点库节点（契约 sourceNodeId · M3-07 刀 3）：「已添加」判重的精确依据；手工创建 / 流程节点任务为 null。 */
  sourceNodeId: string | null;
  /** 所属阶段 key；null = 看板临时任务（展示层垫底归「临时任务」分组）。 */
  stageKey: string | null;
  /** 所属阶段中文名（展示与分组用；无阶段任务 = 空串，展示层归「临时任务」分组）。 */
  stage: string;
  /** 组内位次（契约 sortIndex）：一组 = 同一项目 + 同一阶段，0 起、密集。 */
  sortIndex: number;
  title: string;
  titleEn: string;
  /** 任务负责人 id（契约 ownerIds，可多位、数组顺序 = 展示顺序；空数组 = 「待分配」）。 */
  ownerIds: string[];
  /** 负责人姓名（契约 ownerNames；与 ownerIds 同下标，服务端取不到姓名的那位回落「—」）。 */
  owners: string[];
  /** 服务端展示态（契约 displayStatus）—— 前端直接渲染，不再本地派生。 */
  status: TaskStatus;
  progress: number;
  /** 开始日期（契约 plannedStart）。 */
  startDate: string;
  /** 预计完成日期（契约 plannedEnd）。 */
  dueDate: string;
  /** 实际完成日期（契约 actualEnd）；清除只能走「写回 <1 档进度」。 */
  doneDate: string;
  /** 预计所需天数（契约 estimatedDays；服务端未填时由开始 / 预计完成日期含首尾推算）。 */
  days: number;
  /** 要求输出成果文件（契约 deliverableTypes，十类字典多选、空数组 = 不要求）。 */
  deliverableTypes: string[];
  /** 随行文件摘要（列表列渲染计数）。 */
  files: TaskFileSummary;
  /** 变更关联（多条）。 */
  changes: TaskChange[];
  /** 是否按时交付（契约 onTime）：true = 按时、false = 逾期、null = 服务端派生不出（界面显示「—」）。 */
  onTime: boolean | null;
  note: string;
  headcount: number;
  /** 紧急重要度（契约可空：未填 = null）。 */
  priority: TaskPriority | null;
  /** 乐观锁版本（写入必须回传当前值）。 */
  version: number;
  /** 任务定档（Push 249 · 契约 Task.finalizedAt）：非空 = 已定档 —— 任务不支持任何修改
   *  （行内编辑 / 删除 / 文件新增 / 直替 / 改名全部关闭，服务端 409 TASK_FINALIZED；文件修改走变更）。 */
  finalizedAt: string | null;
};

/**
 * 没有阶段的任务（看板「添加 → 临时任务」手工创建）的展示名（Push 196）：
 * 项目总览 / 甘特图固定垫底的分组头、看板卡片「所属阶段」与抽屉阶段签共用同一文案。
 */
export const TEMP_TASK_STAGE = "临时任务";

/** 四格进度条的格数。 */
export const PROGRESS_STEPS = 4;

/** 四格进度的档位名（0 格「未开始」… 4 格「已完成」；任务表 / 抽屉 / 看板 / 导出报告共用同一套口径）。 */
export const PROGRESS_LABELS: readonly string[] = ["未开始", "刚开工", "完成一半", "快完成了", "已完成"];

/** 进度（0~1 小数）→ 点亮的格数（0~4，四舍五入）。 */
export function progressStep(progress: number, steps: number = PROGRESS_STEPS): number {
  return Math.max(0, Math.min(steps, Math.round(progress * steps)));
}

/** 完成态（手动改成非完成态时，实际完成日期要一并清空 —— Push 67 业务定案）。 */
export function isCompleteStatus(status: TaskStatus): boolean {
  return status === "已完成" || status === "提前完成";
}

/** 任务是否已完成（以服务端展示态为准）。 */
export function isTaskDone(task: ProjectTask): boolean {
  return isCompleteStatus(task.status);
}

/**
 * 「是否按时交付」列的逾期标注（Push 67 业务定案；M3-07 刀 1 后半起口径来自服务端）：
 * 展示态 = 已延期（未完成且过了预计完成日期）→ 「逾期未交付」；已完成但 onTime = false → 「逾期已交付」；
 * 其余返回 null（照常显示「按时交付」或「—」）。
 */
export function lateDeliveryLabel(task: ProjectTask): "逾期未交付" | "逾期已交付" | null {
  if (task.status === "已延期") {
    return "逾期未交付";
  }
  if (isCompleteStatus(task.status) && task.onTime === false) {
    return "逾期已交付";
  }
  return null;
}

/**
 * 多位负责人的展示文本（Push 136）：姓名按存储顺序「、」连接；空数组 = 空串（界面显示「待分配」）。
 * 2026-09-24 定案「只按名字 不用拼音」—— 原「姓名(拼音)」口径下线。
 */
export function ownersLabel(owners: readonly string[]): string {
  return owners.join("、");
}

/**
 * **兜底**判重键（阶段名 + 描述）：M3-07 刀 3 起主口径是 `addedNodeIdsOf`（任务侧落 `sourceNodeId`，精确）；
 * 本键只兜两类行 —— 本刀之前建的任务（来源列为空）与手工创建的同名任务（节点库同阶段内名称唯一，`uq_task_nodes_stage_title`）。
 */
export function addedNodeKey(stage: string, title: string): string {
  return stage + "\n" + title;
}

/**
 * 项目里「已添加的节点」判重键集合（添加卡片的「已添加」标记与整套添加的判重依据）：
 * Push 181 起节点池来自节点库接口（`GET /api/v1/task-nodes`），判重不能再按预设 id（预设 id 不是节点库 UUID）——
 * 键只由「阶段 + 描述」构成，节点侧用 `addedNodeKey(stage, node.title)` 比对。
 */
/**
 * 项目里「已添加的节点」来源 id 集合（M3-07 刀 3）：读任务行的 `sourceNodeId`（模板实例化 / 节点库添加都写它）——
 * 与 `addedNodeKeysOf` 一起用：命中 id = 精确「已添加」，命中键 = 旧行 / 手工同名任务的兜底。
 */
export function addedNodeIdsOf(tasks: readonly ProjectTask[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.sourceNodeId !== null) {
      ids.add(task.sourceNodeId);
    }
  }
  return ids;
}

export function addedNodeKeysOf(tasks: readonly ProjectTask[]): Set<string> {
  const keys = new Set<string>();
  for (const task of tasks) {
    keys.add(addedNodeKey(task.stage, task.title));
  }
  return keys;
}

/** ISO 时间戳 → 展示用日期（YYYY-MM-DD，Asia/Shanghai 口径取日期部分）。 */
export function dateOnlyText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return parts;
}

/** 预计所需天数 = 两个日期的含首尾天数（与源表口径一致：9月5日→9月22日 = 18 天）。 */
export function daysBetweenInclusive(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso + "T00:00:00Z");
  const to = Date.parse(toIso + "T00:00:00Z");
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
    return 0;
  }
  return Math.round((to - from) / 86400000) + 1;
}
