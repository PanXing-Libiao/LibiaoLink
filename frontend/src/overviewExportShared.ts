/**
 * 项目总览导出报告的数据准备层 —— 业务口径 2026-10-09（详见 `前端功能需求.md` §6.16）。
 *
 * `exportOverviewPdf.ts`（打印 PDF 报告）用这里的分组 / 统计 / 文本口径：阶段分组顺序、计数口径（summary 优先）、
 * 进度四格档位、负责人 / 日期 / 成果文件文案都在本文件单点定义（原为 PDF / Excel 两口共用，2026-10-09
 * 「excel先取消吧 删除按钮」撤除 Excel 版后由 PDF 单用）。
 */
import { PROJECT_STAGES } from "./data/projects";
import { PROGRESS_LABELS, PROGRESS_STEPS, TEMP_TASK_STAGE, progressStep, type ProjectTask } from "./data/tasks";
import type { ApiProjectSummary } from "./taskApi";
import type { Project } from "./types";

/** 导出入参（全部来自项目详情页已取到的数据，导出零新增请求）。 */
/** 导出报告的主体语言：zh = 中文大字 + 英文小字（当前版式）；en = 英文大字 + 中文小字。 */
export type OverviewExportLanguage = "zh" | "en";

export type OverviewExportInput = {
  project: Project;
  /** 展示顺序的任务（与「项目总览」同一份：阶段为主键、组内按 sortIndex）。 */
  tasks: readonly ProjectTask[];
  /** 汇总卡（GET /projects/{id}/summary）；null = 尚未取到 → 计数按任务列表现算、最慢 / 最新阶段出「—」。 */
  summary: ApiProjectSummary | null;
};

/** 九阶段（不含「项目总览」汇总视图）。 */
export const STAGE_NAMES: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");

/** 一个阶段分组（阶段进度区与任务明细表共用）。 */
export type StageGroup = { name: string; total: number; done: number; tasks: ProjectTask[] };

/** 完成态（已完成 / 提前完成）：与服务端 summary 的 done 同一口径（基础态 status = done）。 */
export function isDoneStatus(status: ProjectTask["status"]): boolean {
  return status === "已完成" || status === "提前完成";
}

/**
 * 任务 → 阶段分组：顺序 = 项目总览（售前规划 → … → 验收，垫底「临时任务」），空分组也保留（阶段进度区出 0 / 0）；
 * 契约九阶段之外的分组名（历史脏值）照原文单列一组挂在末尾，不丢任务行。
 */
export function groupedByStage(tasks: readonly ProjectTask[]): StageGroup[] {
  const groups: StageGroup[] = [...STAGE_NAMES, TEMP_TASK_STAGE].map((name) => ({ name, total: 0, done: 0, tasks: [] }));
  const indexOf = new Map(groups.map((group, index) => [group.name, index]));
  for (const task of tasks) {
    const name = task.stage === "" ? TEMP_TASK_STAGE : task.stage;
    let at = indexOf.get(name);
    if (at === undefined) {
      at = groups.length;
      groups.push({ name, total: 0, done: 0, tasks: [] });
      indexOf.set(name, at);
    }
    const group = groups[at];
    group.tasks.push(task);
    group.total += 1;
    if (isDoneStatus(task.status)) {
      group.done += 1;
    }
  }
  return groups;
}

/** 报告头部 / 汇总区的统计数字。 */
export type OverviewCounts = { total: number; done: number; active: number; pending: number; overdue: number; pct: number };

/** 总数 / 已完成 / 已延期优先吃服务端 summary（与页面汇总卡同值），进行中 / 待开始按任务列表现算。 */
export function countsOf(tasks: readonly ProjectTask[], summary: ApiProjectSummary | null): OverviewCounts {
  let active = 0;
  let pending = 0;
  let doneLocal = 0;
  let overdueLocal = 0;
  for (const task of tasks) {
    if (task.status === "进行中") {
      active += 1;
    } else if (task.status === "待开始") {
      pending += 1;
    } else if (task.status === "已延期") {
      overdueLocal += 1;
    }
    if (isDoneStatus(task.status)) {
      doneLocal += 1;
    }
  }
  const total = summary?.total ?? tasks.length;
  const done = summary?.done ?? doneLocal;
  const overdue = summary?.overdue ?? overdueLocal;
  return { total, done, active, pending, overdue, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** 日期列：空串（服务端未填）在报告里出「—」。 */
export function dateText(value: string): string {
  return value === "" ? "—" : value;
}

/** 负责人展示：空数组 = 「待分配」（契约 ownerIds 空数组同义）。 */
export function ownersText(task: ProjectTask): string {
  return task.owners.length === 0 ? "待分配" : task.owners.join("、");
}

/** 进度（0~1 小数）→ 四格档位百分比（0 / 25 / 50 / 75 / 100；换算口径同 data/tasks.ts 的 progressStep）。 */
export function progressPct(progress: number): number {
  return Math.round((progressStep(progress) / PROGRESS_STEPS) * 100);
}

/** 进度（0~1 小数）→ 中文档位（未开始 / 刚开工 / 完成一半 / 快完成了 / 已完成，同 Tracker 口径）。 */
export function progressLabel(progress: number): string {
  return PROGRESS_LABELS[progressStep(progress)] ?? "";
}
