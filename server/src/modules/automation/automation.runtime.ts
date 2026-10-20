/**
 * automation 运行时求值入口（M5-02 接线段前置 · 原方案 S7-4 的「规则接线」主体面）。
 *
 * 口径来源：lan PR #195 提请的「automation 运行时求值 API」（三件 + 五条回执，答复见 PR #195 评审帖）；
 *   字段与收件人唯一口径 = docs/rules/A01-A03-A14-扩展规则文案.md 的「回放主体字段口径」表。
 * 设计：
 *   - 纯函数：不连库、不取系统时间（at / 数据集全注入）；与回放器共用 evaluateBusinessDate / finalizeMessages
 *     —— 同一规则集 + 同一主体 + 同一业务日下，入口输出与 replayRules 逐字段一致（自检用例见 test/automation-runtime.test.ts）。
 *   - 事件形态 evaluateEventMessages：topic → 命中规则（event 型 + 主题相等，与 subjectKindOf 同源）→ 单主体求值；
 *     冷启动保护 = at - eventAt 超阈值 → 逐规则登记 skipped.reason = event_too_old（不评估主体）。
 *   - 调度形态 planWindowMessages：schedule 型规则 × 主体 × 窗口（触发时刻 ∈ (from, to]）→ 应发送清单。
 *   - 规则来源：M5-06-1A 起由 AutomationRuleRepository 读 automation_rules（空表不回退代码常量；非法行 fail closed）。
 *   - 主体映射器：report_slot / project_day / todo 三类（输入 = 领域快照；读库在接线层；issue 随处理时限删除下线 · Push 215）。
 * 边界：本文件只算「本事件 / 本窗口应发给谁、发什么、幂等键是什么」；投递 / 重试 / 死信由 M5-02 ~ M5-04（lan）承担。
 */
import type { AutomationRule, RuleEventTopic } from "@libiaolink/contracts";
import { addDays, calendarWindow, type CalendarShiftDirection, type CalendarWindow } from "../calendar/index.js";
import {
  evaluateBusinessDate,
  finalizeMessages,
  type ReplayDetail,
  type ReplayMergedEntry,
  type ReplayMessage,
  type ReplaySkipReason,
  type ReplaySubject,
} from "./automation.replay.js";

/** 运行时跳过留痕：reason 为回放跳过原因 ∪ event_too_old（冷启动保护）；disabled 为规则级（不带 entityId）。 */
export interface RuntimeSkip {
  reason: ReplaySkipReason | "event_too_old";
  ruleCode?: string;
  entityId?: string;
}

/** 运行时求值结果：messages 与回放器 ReplayMessage 同形（含 dedupeKey / channel / recipientName）。 */
export interface RuntimeEvaluation {
  messages: ReplayMessage[];
  skipped: RuntimeSkip[];
  /** 逐规则 × 实体的求值明细（M5-06-1A 运行留痕；条件 / 窗口 / 命中态）。 */
  details: RuntimeDetail[];
}

/** 运行留痕明细：回放明细 + 冷启动专用 event_too_old。 */
export interface RuntimeDetail extends Omit<ReplayDetail, "skipped"> {
  skipped: ReplaySkipReason | "event_too_old" | null;
}

/** Asia/Shanghai 业务日（ADR-028）：引擎不取系统时间，at 由接线层注入。 */
function businessDateOf(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 事件形态入参：topic + 规则集 + 单主体快照 + 求值时刻（冷启动保护可选）。 */
export interface EventEvaluationInput {
  /** outbox 主题（RULE_EVENT_TOPICS 子集；接线层从事件行透传）。 */
  topic: RuleEventTopic;
  /** 规则集（来源 = listEnabledRules()；自检 / 单测可直接传 BUILTIN_RULES）。 */
  rules: readonly AutomationRule[];
  /** 主体快照（接线层按字段口径组装，或经四类映射器产出）。 */
  subject: ReplaySubject;
  /** 求值时刻（ClockService 注入）：业务日基准与冷启动保护共用。 */
  at: Date;
  /** 日历窗口（event 型规则不参与窗口求值；缺省 = 求值日单日空窗口）。 */
  calendar?: CalendarWindow;
  /** 事件发生时刻（outbox 行创建时刻；缺省 = 不做冷启动保护）。 */
  eventAt?: Date;
  /** 冷启动保护阈值（env 由接线层读入传参；仅在提供 eventAt 时生效）。 */
  maxEventAgeMs?: number;
}

/** 事件形态留痕：与回放 details 的跳过项一一对应（disabled 为规则级，不带实体 id）。 */
function eventSkips(details: readonly RuntimeDetail[]): RuntimeSkip[] {
  const skipped: RuntimeSkip[] = [];
  for (const detail of details) {
    if (detail.skipped === null) continue;
    if (detail.entityId === "-") skipped.push({ reason: detail.skipped, ruleCode: detail.ruleCode });
    else skipped.push({ reason: detail.skipped, ruleCode: detail.ruleCode, entityId: detail.entityId });
  }
  return skipped;
}

/** 同一 rule × entity × window 只保留一条运行明细（调度逐日求值会产生重复 disabled）。 */
function dedupeDetails(details: readonly RuntimeDetail[]): RuntimeDetail[] {
  const result = new Map<string, RuntimeDetail>();
  for (const detail of details) {
    const key = [detail.ruleCode, detail.entityId, detail.windowKey ?? "-", detail.skipped ?? "hit"].join("|");
    if (!result.has(key)) result.set(key, detail);
  }
  return [...result.values()];
}

/**
 * 事件形态求值：topic → 命中规则（event 型 + 主题相等）→ 单主体求值 → 应发送清单与跳过留痕。
 * 冷启动保护：at - eventAt > maxEventAgeMs（严格大于）→ 整体放弃，逐规则登记 event_too_old（不评估主体）。
 * 说明：topic 不命中的规则不参与；event 型规则的窗口键 = 实体版本（vN），与回放器同口径。
 */
export function evaluateEventMessages(input: EventEvaluationInput): RuntimeEvaluation {
  const businessDate = businessDateOf(input.at);
  const topicRules = input.rules.filter((rule) => rule.trigger.kind === "event" && rule.trigger.topic === input.topic);
  if (input.maxEventAgeMs !== undefined) {
    if (input.eventAt === undefined) throw new Error("冷启动保护需要 eventAt（outbox 行事件时刻）");
    if (!Number.isFinite(input.maxEventAgeMs) || input.maxEventAgeMs < 0) throw new Error("maxEventAgeMs 需为非负有限数");
    if (input.at.getTime() - input.eventAt.getTime() > input.maxEventAgeMs) {
      return {
        messages: [],
        skipped: topicRules.map((rule) => ({ reason: "event_too_old", ruleCode: rule.code, entityId: input.subject.id })),
        details: topicRules.map((rule) => ({
          ruleCode: rule.code,
          ruleName: rule.name,
          entityId: input.subject.id,
          windowKey: "v" + String(input.subject.version ?? 0),
          matched: false,
          skipped: "event_too_old",
          conditions: [],
        })),
      };
    }
  }
  const evaluation = evaluateBusinessDate({
    businessDate,
    rules: topicRules,
    subjects: [input.subject],
    calendar: input.calendar ?? calendarWindow(businessDate, businessDate, []),
    shiftEnabled: false,
    shiftDirection: "forward",
  });
  const messages = finalizeMessages(evaluation.merged, evaluation.details, []);
  return { messages, skipped: eventSkips(evaluation.details), details: dedupeDetails(evaluation.details) };
}

/** 调度任务 kind（一期唯一 = automation-schedule.job；新增 kind = 显式扩表，与接线段同步）。 */
export const AUTOMATION_SCHEDULE_JOB_KIND = "automation-schedule.job";

/** 调度形态入参：任务 kind + 窗口 + 规则集 + 本窗口待评估主体（读库在接线层）。 */
export interface WindowPlanInput {
  /** 调度任务 kind（一期仅支持 AUTOMATION_SCHEDULE_JOB_KIND）。 */
  jobKind: string;
  /** 调度窗口 (from, to]（UTC 时刻；= JobRunContext.windowFrom / windowTo）。 */
  window: { from: Date; to: Date };
  /** 规则集（来源 = listEnabledRules()；本入口只取 schedule 型规则）。 */
  rules: readonly AutomationRule[];
  /** 本窗口待评估主体（同类主体一批；字段口径见 docs/rules 字段表）。 */
  subjects: readonly ReplaySubject[];
  /** 求值时刻（ClockService 注入；窗口终点不得晚于它）。 */
  at: Date;
  /** 日历窗口：需覆盖 [窗口首日 - 最大偏移, 窗口末日 + 最大偏移]（T±N 与顺延求值）。 */
  calendar: CalendarWindow;
  /** 节假日顺延（R03 / R05 可配置；缺省 false，与回放同口径）。 */
  shiftEnabled?: boolean;
  shiftDirection?: CalendarShiftDirection;
}

/**
 * 调度形态求值：schedule 型规则 × 主体 × 窗口 → 应发送清单（触发时刻 ∈ (from, to]，业务日逐日求值）。
 * 说明：
 *   - 窗口半开（与调度补发 planCatchup 同口径）：from 时刻本身的触发属上一窗口；触发时刻由 resolveScheduleFire 求（含顺延）。
 *   - 不在窗口内的触发不产出、不留痕（不属本窗口）；skip 登记 = disabled（规则级一次）+ 窗口内已触发但未产出的原因
 *     （not_matched / recipient_missing / template_missing / duplicate）；subject_mismatch 与 window_mismatch 不入 skipped
 *     （前者结构性：主体类型与规则不符；后者正常态：本窗口不触发）。
 *   - messages 已做同键去重与确定性排序；落库幂等最终由 outbox dedupe_key 唯一约束兜底（接线段 appendOutboxIfAbsent）。
 */
export function planWindowMessages(input: WindowPlanInput): RuntimeEvaluation {
  if (input.jobKind !== AUTOMATION_SCHEDULE_JOB_KIND) throw new Error("未支持的 jobKind：" + input.jobKind);
  if (input.window.from.getTime() > input.window.to.getTime()) throw new Error("planWindowMessages：窗口起点晚于终点");
  if (input.window.to.getTime() > input.at.getTime()) throw new Error("planWindowMessages：窗口终点晚于 at（不得规划未来窗口）");

  const fromMs = input.window.from.getTime();
  const toMs = input.window.to.getTime();
  const shiftEnabled = input.shiftEnabled ?? false;
  const shiftDirection = input.shiftDirection ?? "forward";
  const scheduleRules = input.rules.filter((rule) => rule.trigger.kind === "schedule");
  const firstDate = businessDateOf(input.window.from);
  const lastDate = businessDateOf(input.window.to);

  const details: ReplayDetail[] = [];
  const merged: ReplayMergedEntry[] = [];
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    const evaluation = evaluateBusinessDate({
      businessDate: date,
      rules: scheduleRules,
      subjects: input.subjects,
      calendar: input.calendar,
      shiftEnabled,
      shiftDirection,
      fireAtWithin: (fireAt) => {
        const fireMs = Date.parse(fireAt);
        return fireMs > fromMs && fireMs <= toMs;
      },
    });
    for (const entry of evaluation.merged) merged.push(entry);
    for (const detail of evaluation.details) details.push(detail);
  }

  const messages = finalizeMessages(merged, details, []);
  const skipped: RuntimeSkip[] = [];
  for (const rule of scheduleRules) {
    if (!rule.enabled) skipped.push({ reason: "disabled", ruleCode: rule.code });
  }
  for (const detail of details) {
    if (detail.windowKey === null || detail.skipped === null) continue;
    if (detail.skipped === "subject_mismatch" || detail.skipped === "window_mismatch") continue;
    skipped.push({ reason: detail.skipped, ruleCode: detail.ruleCode, entityId: detail.entityId });
  }
  const runtimeDetails = dedupeDetails(
    details.filter(
      (detail) =>
        detail.skipped !== "subject_mismatch" &&
        detail.skipped !== "window_mismatch" &&
        (detail.windowKey !== null || detail.skipped === "disabled"),
    ),
  );
  return { messages, skipped, details: runtimeDetails };
}

/** A01 日报名册槽位快照（数据面 = GET /api/v1/projects/{id}/reports/missing；字段表见 docs/rules）。 */
export interface ReportMemberSnapshot {
  /** 名册槽位 id（幂等实体标识；缺省 = projectId|userId）。 */
  slotId?: string;
  /** 业务日（report.date；trigger.baseField）。 */
  date: string;
  /** 是否工作日（report.is_workday；非工作日不催）。 */
  isWorkday: boolean;
  /** 当日是否已提交（report.submitted；已提交不催）。 */
  submitted: boolean;
  /** 成员 id（report.user_id = 收件人 id）。 */
  userId: string;
  /** 成员姓名（文案称呼；可空）。 */
  userName: string | null;
  projectId: string;
  /** 项目名（模板 {项目名}）。 */
  projectName: string;
}

/** 主体映射器（A01）：日报名册槽位快照 → 回放主体（收件人 = report.member = 成员本人）。 */
export function toReportMemberSubject(snapshot: ReportMemberSnapshot): ReplaySubject {
  return {
    kind: "report_slot",
    id: snapshot.slotId ?? snapshot.projectId + "|" + snapshot.userId,
    fields: {
      "report.date": snapshot.date,
      "report.is_workday": snapshot.isWorkday,
      "report.submitted": snapshot.submitted,
      "report.user_id": snapshot.userId,
      "project.name": snapshot.projectName,
    },
    recipients: {
      "report.member": snapshot.userId === "" ? null : { id: snapshot.userId, name: snapshot.userName },
    },
  };
}

/** A02 项目日报快照（数据面 = GET /api/v1/projects/{id}/reports/summary）。 */
export interface ProjectDaySnapshot {
  projectId: string;
  /** 项目名（模板 {项目名}）。 */
  projectName: string;
  /** 业务日（report.date；trigger.baseField）。 */
  date: string;
  /** 当日提交人数（{提交人数}）。 */
  entryCount: number;
  /** 当日应填人数（{应填人数}）。 */
  headcountTotal: number;
  /** 当日发现问题数（{问题数}）。 */
  issueCount: number;
  /** 汇总正文（数据面拼装；模板 {汇总正文}）。 */
  summaryText: string;
  /** 项目群 id（未绑定 → null = recipient_missing）。 */
  groupId: string | null;
}

/** 主体映射器（A02）：项目日报快照 → 回放主体（收件人 = project.group = 项目群机器人）。 */
export function toProjectDaySubject(snapshot: ProjectDaySnapshot): ReplaySubject {
  return {
    kind: "project_day",
    id: snapshot.projectId,
    fields: {
      "report.date": snapshot.date,
      "report.entry_count": snapshot.entryCount,
      "report.headcount_total": snapshot.headcountTotal,
      "report.issue_count": snapshot.issueCount,
      "report.summary_text": snapshot.summaryText,
      "project.name": snapshot.projectName,
    },
    recipients: {
      "project.group": snapshot.groupId === null ? null : { id: snapshot.groupId, name: null },
    },
  };
}
/** A08 项目阶段推进快照（事件载荷 + 读库补齐项目 / 姓名 / 群绑定）。 */
export interface StageSnapshot {
  stageId: string;
  stageKey: string;
  stageName: string;
  stageVersion: number;
  nextStageKey: string | null;
  nextStageName: string;
  advancedByName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  groupId: string | null;
}

/** 主体映射器（A08）：阶段推进快照 → 回放主体（收件人 = project.group = 项目群机器人）。 */
export function toStageSubject(snapshot: StageSnapshot): ReplaySubject {
  const projectLabel =
    snapshot.projectCode === "" ? snapshot.projectName : snapshot.projectName === "" ? snapshot.projectCode : snapshot.projectCode + "·" + snapshot.projectName;
  return {
    kind: "stage",
    id: snapshot.stageId,
    version: snapshot.stageVersion,
    fields: {
      "stage.id": snapshot.stageId,
      "stage.key": snapshot.stageKey,
      "stage.name": snapshot.stageName,
      "stage.next_key": snapshot.nextStageKey,
      "stage.next_name": snapshot.nextStageName,
      "stage.advanced_by_name": snapshot.advancedByName,
      "project.id": snapshot.projectId,
      "project.code": snapshot.projectCode,
      "project.name": snapshot.projectName,
      "project.label": projectLabel,
    },
    recipients: {
      "project.group": snapshot.groupId === null ? null : { id: snapshot.groupId, name: null },
    },
  };
}

/** A14 自定义待办快照（todos 表未落 —— 数据面随 M5-06 / M8；重复规则由待办模块展开为逐次提醒日）。 */
export interface TodoSnapshot {
  todoId: string;
  /** 主体实体 id 覆盖（缺省 = todoId；多提醒对象按成员展开时建议编入成员 id，保证幂等键不串人）。 */
  entityId?: string;
  /** 待办标题（模板 {待办标题}）。 */
  title: string;
  /** 待办内容（可空 —— 空内容正文止于句号，金标口径）。 */
  content: string | null;
  /** 待办状态（done = 完成；非 done 参与求值）。 */
  status: string;
  /** 本次提醒日（trigger.baseField = todo.remind_date）。 */
  remindDate: string;
  /** 提醒对象成员 id（rule.members = 收件人 id）。 */
  memberId: string;
  memberName: string | null;
}

/** 主体映射器（A14）：自定义待办快照 → 回放主体（收件人 = rule.members = 提醒对象）。 */
export function toTodoSubject(snapshot: TodoSnapshot): ReplaySubject {
  return {
    kind: "todo",
    id: snapshot.entityId ?? snapshot.todoId,
    fields: {
      "todo.title": snapshot.title,
      "todo.content": snapshot.content,
      "todo.status": snapshot.status,
      "todo.remind_date": snapshot.remindDate,
    },
    recipients: {
      "rule.members": snapshot.memberId === "" ? null : { id: snapshot.memberId, name: snapshot.memberName },
    },
  };
}
