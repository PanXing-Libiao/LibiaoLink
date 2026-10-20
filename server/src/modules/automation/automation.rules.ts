/**
 * 自动化规则求值内核（纯函数：不连库、不取系统时间）：条件求值 / 模板渲染 / 触发窗口与幂等执行键。
 * 口径来源：技术设计v0.2 §6.1（规则模型）/ §6.2（幂等执行键 = ruleId + entityId + 触发窗口；时钟注入）、
 *   docs/rules/R01-R07-内置规则文案.md（R 系列逐字文案与金标）、docs/rules/A01-A03-A14-扩展规则文案.md（A 系列；A03 随处理时限删除下线）、
 *   ADR-026（已作废 —— 处理时限 due_at 随 Push 215 删除）、ADR-028（Asia/Shanghai）、
 *   契约 shared/src/modules/automation.ts（枚举与规则文档 schema）。
 */
import type { AutomationCondition, AutomationRule, RuleConditionOperator, RuleScheduleWindow } from "@libiaolink/contracts";
import {
  addDays,
  atShanghaiTime,
  dayOfWeek,
  evaluateOffset,
  type CalendarShiftDirection,
  type CalendarWindow,
} from "../calendar/index.js";

/** 求值上下文字段值（点分字段名 → 值；缺省 undefined 视为空值）。 */
export type RuleFieldValue = string | number | boolean | readonly string[] | readonly number[] | null;
export type RuleContext = Readonly<Record<string, RuleFieldValue | undefined>>;

/** 回放主体类型（规则作用对象；M5-05 余项：A 系列不再限于任务）：task 任务（R02 ~ R05 / R07）/
 * project 项目完成（R06）/ report_slot 日报名册槽位 = 人员 × 项目 × 日期（A01）/ project_day 项目日报 = 项目 × 日期（A02）/ todo 自定义待办（A14）/ stage 项目阶段推进（A08）；
 * issue 问题主体随处理时限（due_at）删除下线（Push 215）。 */
export const REPLAY_SUBJECT_KINDS = ["task", "project", "report_slot", "project_day", "todo", "stage"] as const;
export type ReplaySubjectKind = (typeof REPLAY_SUBJECT_KINDS)[number];

/** 求值选项：业务日（Asia/Shanghai）—— eqOffsetDays 的基准日，禁止取系统时间（v0.2 §6.2 可测试）。 */
export interface RuleEvaluationOptions {
  businessDate: string;
}

/** 单条件求值明细（C2-12 规则可解释）。 */
export interface ConditionEvaluation {
  field: string;
  op: RuleConditionOperator;
  expected: RuleFieldValue | undefined;
  actual: RuleFieldValue | undefined;
  passed: boolean;
}

/** 规则求值结果：全部条件与运算；conditions 供留痕与回放报告。 */
export interface RuleEvaluation {
  matched: boolean;
  conditions: ConditionEvaluation[];
}

function isArrayValue(value: RuleFieldValue | undefined): value is readonly string[] | readonly number[] {
  return Array.isArray(value);
}

function scalarEquals(left: RuleFieldValue | undefined, right: RuleFieldValue | undefined): boolean {
  if (isArrayValue(left) || isArrayValue(right)) return false;
  return left === right;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00.000Z") - Date.parse(from + "T00:00:00.000Z")) / 86_400_000);
}

/** 大小比较：数字按数值、日期串（YYYY-MM-DD）按日、其余按字符串字典序；不可比返回 null。 */
function compareOrdered(left: RuleFieldValue | undefined, right: RuleFieldValue | undefined): number | null {
  if (typeof left === "number" && typeof right === "number") return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") {
    const leftDate = Date.parse(left + "T00:00:00.000Z");
    const rightDate = Date.parse(right + "T00:00:00.000Z");
    const leftIsDate = left.length === 10 && !Number.isNaN(leftDate);
    const rightIsDate = right.length === 10 && !Number.isNaN(rightDate);
    if (leftIsDate && rightIsDate) return leftDate === rightDate ? 0 : leftDate < rightDate ? -1 : 1;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

/** 条件操作符求值（白名单；语义见契约 RuleConditionOperator 描述）。 */
export function evaluateOperator(
  op: RuleConditionOperator,
  actual: RuleFieldValue | undefined,
  expected: RuleFieldValue | undefined,
  options: RuleEvaluationOptions,
): boolean {
  switch (op) {
    case "eq":
      return scalarEquals(actual, expected);
    case "ne":
      return !scalarEquals(actual, expected);
    case "in":
      return isArrayValue(expected) && expected.some((item) => scalarEquals(actual, item));
    case "notIn":
      return isArrayValue(expected) && !expected.some((item) => scalarEquals(actual, item));
    case "isNull":
      return actual === null || actual === undefined;
    case "notNull":
      return actual !== null && actual !== undefined;
    case "notEmpty":
      if (actual === null || actual === undefined) return false;
      if (typeof actual === "string") return actual.trim().length > 0;
      if (isArrayValue(actual)) return actual.length > 0;
      return true;
    case "containsAny":
      if (!isArrayValue(actual) || !isArrayValue(expected)) return false;
      return expected.some((item) => actual.includes(item as string & number));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const order = compareOrdered(actual, expected);
      if (order === null) return false;
      if (op === "gt") return order > 0;
      if (op === "gte") return order >= 0;
      if (op === "lt") return order < 0;
      return order <= 0;
    }
    case "eqOffsetDays":
      return (
        typeof actual === "string" &&
        actual.length === 10 &&
        typeof expected === "number" &&
        daysBetween(options.businessDate, actual) === expected
      );
  }
}

/** 单条件求值（明细含 expected / actual，供规则可解释与金标断言）。 */
export function evaluateCondition(
  condition: AutomationCondition,
  context: RuleContext,
  options: RuleEvaluationOptions,
): ConditionEvaluation {
  const actual = context[condition.field];
  const expected = condition.value as RuleFieldValue | undefined;
  return {
    field: condition.field,
    op: condition.op,
    expected,
    actual: actual === undefined ? null : actual,
    passed: evaluateOperator(condition.op, actual, expected, options),
  };
}

/** 规则求值（全部条件与运算；空条件 = 恒命中）。 */
export function evaluateRule(
  rule: Pick<AutomationRule, "conditions">,
  context: RuleContext,
  options: RuleEvaluationOptions,
): RuleEvaluation {
  const conditions = rule.conditions.map((condition) => evaluateCondition(condition, context, options));
  return { matched: conditions.every((item) => item.passed), conditions };
}

/** 模板渲染：{字段} 逐字替换；存在未提供变量时报错（金标逐字比对要求缺变量必须显性失败）。 */
export function renderTemplate(text: string, variables: Readonly<Record<string, string | number>>): string {
  let out = text;
  for (const name of Object.keys(variables)) {
    out = out.split("{" + name + "}").join(String(variables[name]));
  }
  if (out.indexOf("{") >= 0) throw new Error("模板存在未提供变量：" + text);
  return out;
}

/** 触发窗口求值入参：窗口 + 业务日 + 基准字段值 + 业务时刻 + 顺延开关 + 日历窗口（无数据库、无系统时间）。 */
export interface ScheduleFireInput {
  window: RuleScheduleWindow;
  /** 业务日 YYYY-MM-DD（Asia/Shanghai；回放注入 / 调度按 ClockService 传入）。 */
  businessDate: string;
  /** 窗口基准字段值（task.planned_end / task.planned_start 一类；WEEKLY 忽略）。 */
  baseDate: string | null;
  /** 业务时刻 HH:mm（R03 / R05 = 08:00，R04 = 10:00，R07 = 09:30，A02 = 19:00，A01 = 19:30，A14 = 09:00）。 */
  time: string;
  /** 节假日顺延（R03 / R05 可配置；R04 按关闭）。 */
  shiftEnabled: boolean;
  shiftDirection: CalendarShiftDirection;
  calendar: CalendarWindow;
}

/** 触发求值结果：fireDate = 应触发日（与 businessDate 相等才发）、fireAt = UTC 时刻、windowKey = 幂等窗口键。 */
export interface ScheduleFire {
  fireDate: string;
  fireAt: string;
  windowKey: string;
  shifted: boolean;
}

/** 所在周的周一（周一 = 一周之首；R07 周窗口基准）。 */
export function mondayOf(date: string): string {
  const weekday = dayOfWeek(date);
  return addDays(date, -((weekday + 6) % 7));
}

/** ISO 周键（YYYY-Www，周一为界；R07 跨周幂等键）。 */
export function isoWeekKey(date: string): string {
  const parsed = new Date(Date.parse(date + "T00:00:00.000Z"));
  const weekday = (parsed.getUTCDay() + 6) % 7;
  const thursday = new Date(parsed.getTime());
  thursday.setUTCDate(parsed.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return thursday.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

/**
 * 触发窗口求值：T_MINUS_1 / SAME_DAY / T_PLUS_1 / T_PLUS_3 走 calendar 的 T±N 求值（顺延按开关与方向），
 * WEEKLY 取业务日所在周的周一；基准字段缺失返回 null（该实体本窗口不触发）。
 */
export function resolveScheduleFire(input: ScheduleFireInput): ScheduleFire | null {
  if (input.window === "WEEKLY") {
    const monday = mondayOf(input.businessDate);
    return { fireDate: monday, fireAt: atShanghaiTime(monday, input.time), windowKey: isoWeekKey(input.businessDate), shifted: false };
  }
  if (input.baseDate === null) return null;
  const days =
    input.window === "T_MINUS_1" ? -1 : input.window === "T_PLUS_1" ? 1 : input.window === "T_PLUS_3" ? 3 : 0;
  const outcome = evaluateOffset({
    baseDate: input.baseDate,
    days,
    shiftEnabled: input.shiftEnabled,
    shiftDirection: input.shiftDirection,
    window: input.calendar,
  });
  if (outcome === null) return null;
  return { fireDate: outcome.date, fireAt: atShanghaiTime(outcome.date, input.time), windowKey: outcome.date, shifted: outcome.shifted };
}

/** 幂等执行键（v0.2 §6.2）：规则 + 实体 + 触发窗口；落 outbox / automation_runs 的 dedupe_key 唯一约束兜底。 */
export function dedupeKey(ruleCode: string, entityId: string, windowKey: string): string {
  return ruleCode + ":" + entityId + ":" + windowKey;
}
