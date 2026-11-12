/**
 * 任务规则（纯函数，不连库）：展示五态 / 按时交付派生、进度与状态写入联动、Asia/Shanghai 日界。
 * 口径来源：系统功能书 A1-06、技术设计v0.2 §2.4、A12 / A13 / A14（PR #42 / Push 70 定案）、ADR-028（时区）；
 * **2026-09-24 定案**：五态下拉可写 —— 「已延期 / 提前完成」落 tasks.status_override 显式覆盖（迁移 0031），
 * 读时有覆盖取覆盖（按生效边界）、无覆盖走派生；写进度 / 写基础三态 / 门禁完成即清覆盖。
 * 派生结果本身仍只在读时计算、不写回存储（v0.2 §2.4：基础态仅 pending / active / done）。
 */

export type TaskBaseStatus = "pending" | "active" | "done";
export type TaskDisplayStatus = "pending" | "active" | "done" | "overdue" | "early_done";
/** 状态写入值（2026-09-24 定案）：基础三态 + 两个显式覆盖值（对应页面五态下拉）。 */
export type TaskStatusWrite = TaskBaseStatus | "overdue" | "early_done";
/** 允许落库的显式覆盖值（tasks.status_override 两值）。 */
export type TaskStatusOverride = "overdue" | "early_done";

export interface TaskDerivationInput {
  /** 存储基础态（tasks.status）。 */
  status: string;
  /** 显式覆盖（tasks.status_override）：overdue / early_done / null（无覆盖 = 纯派生）。 */
  statusOverride: string | null;
  /** 预计完成日期 YYYY-MM-DD（tasks.planned_end）。 */
  plannedEnd: string | null;
  /** 实际完成日期 YYYY-MM-DD（tasks.actual_end）。 */
  actualEnd: string | null;
  /** 迁移导入的存储值（tasks.on_time），派生不出时回落。 */
  storedOnTime: boolean | null;
  /** 业务日（Asia/Shanghai）YYYY-MM-DD。 */
  today: string;
}

/** Asia/Shanghai 当天（ADR-028：UTC+8 固定偏移、无夏令时；日界在应用层算出后以参数进入 SQL）。 */
export function shanghaiToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 取消定档时间闸（2026-11-12 业务口径）：预计完成日期当天及之前可取消；业务今天（Asia/Shanghai）
 * 已晚于 plannedEnd 时，任务负责人只能定档、不能取消；项目经理等项目编辑者不受此闸限制。
 * 调用方必须先用共享能力投影判定 source=task_owner。plannedEnd 为空 = 无期限，始终可取消。
 */
export function isUnfinalizeLockedByPlannedEnd(plannedEnd: string | null, today: string): boolean {
  return plannedEnd !== null && plannedEnd < today;
}

/**
 * 展示五态派生（A1-06 / A12 / A14；2026-09-24 起含显式覆盖）：
 * 先看覆盖 —— early_done 仅在已完成时生效、overdue 仅在未完成时生效（生效边界与原型 statusOverride 一致）；
 * 无覆盖（或边界不满足）时走派生：完成按实际完成日期与预计完成日期比较分「已完成 / 提前完成」；
 * 未完成且已过预计完成日期 = 「已延期」；其余按基础态。
 */
export function deriveDisplayStatus(input: TaskDerivationInput): TaskDisplayStatus {
  if (input.statusOverride === "early_done" && input.status === "done") {
    return "early_done";
  }
  if (input.statusOverride === "overdue" && input.status !== "done") {
    return "overdue";
  }
  if (input.status === "done") {
    if (input.actualEnd !== null && input.plannedEnd !== null && input.actualEnd < input.plannedEnd) {
      return "early_done";
    }
    return "done";
  }
  if (input.plannedEnd !== null && input.plannedEnd < input.today) return "overdue";
  return input.status === "active" ? "active" : "pending";
}

/**
 * 是否按时交付派生（A14）：
 * 完成且实际完成不晚于预计完成 → true；完成但晚于预计完成，或已完成未填完成日期且预计完成已过 → false；
 * 未完成且已过预计完成日期 → false（配 displayStatus=overdue 渲染「逾期未交付」）；其余派生不出 → 回落存储值（仍无则 null）。
 */
export function deriveOnTime(input: TaskDerivationInput): boolean | null {
  if (input.status === "done") {
    if (input.actualEnd !== null && input.plannedEnd !== null) return input.actualEnd <= input.plannedEnd;
    if (input.actualEnd === null && input.plannedEnd !== null && input.plannedEnd < input.today) return false;
    return input.storedOnTime;
  }
  if (input.plannedEnd !== null && input.plannedEnd < input.today) return false;
  return input.storedOnTime;
}

/** 任务写入结果（状态 / 进度 / 完成日期 / 显式覆盖）——联动后一起落库。 */
export interface TaskWriteState {
  status: string;
  progress: number;
  actualEnd: string | null;
  statusOverride: string | null;
}

/**
 * 状态写入联动（A12，服务端同事务裁决；2026-09-24 起五态可写）：
 * done → 满格 + 缺省按当天补完成日期（已完成保留原日期）+ 清覆盖；active → 至少 1 格（0 → 0.25、满格 → 0.75）并清完成日期 + 清覆盖；
 * pending → 清进度、清完成日期 + 清覆盖；
 * overdue（已延期）→ **保持当前格数与完成日期**、只落覆盖值（原型「已延期 = 保持当前格数」）；
 * early_done（提前完成）→ 四格全亮 + 完成日期缺省按当天（同已完成）+ 落覆盖值。
 * 覆盖的生效边界在读时判定（deriveDisplayStatus）：overdue 仅未完成生效、early_done 仅已完成生效。
 */
export function applyStatusWrite(current: TaskWriteState, status: TaskStatusWrite, today: string): TaskWriteState {
  if (status === "overdue") {
    return { status: current.status, progress: current.progress, actualEnd: current.actualEnd, statusOverride: "overdue" };
  }
  if (status === "early_done") {
    return { status: "done", progress: 1, actualEnd: current.actualEnd ?? today, statusOverride: "early_done" };
  }
  if (status === "done") {
    return { status, progress: 1, actualEnd: current.actualEnd ?? today, statusOverride: null };
  }
  if (status === "active") {
    const progress = current.progress === 0 ? 0.25 : current.progress === 1 ? 0.75 : current.progress;
    return { status, progress, actualEnd: null, statusOverride: null };
  }
  return { status, progress: 0, actualEnd: null, statusOverride: null };
}

/**
 * 进度写入联动（A12 / A13）：0 → 待开始；0.25 / 0.5 / 0.75 → 进行中并清完成日期（清除完成日期的唯一方式）；
 * 1 → 已完成 + 完成日期（缺省按当天，显式传入则用传入值）。
 * 2026-09-24：点进度条一律**清空显式覆盖**（回到派生）—— 与原型「点进度条后状态重新联动」同结果。
 */
export function applyProgressWrite(
  progress: number,
  actualEndInput: string | null,
  today: string,
): TaskWriteState {
  if (progress === 1) {
    return { status: "done", progress: 1, actualEnd: actualEndInput ?? today, statusOverride: null };
  }
  return { status: progress === 0 ? "pending" : "active", progress, actualEnd: null, statusOverride: null };
}
