/**
 * 规则回放器（纯函数，不连库）：给定规则集 + 主体数据集 + 业务日 + 日历 → 应发送清单（含幂等与合并）。
 * 口径来源：技术设计v0.2 §6.2（幂等执行键 / 可测试：时钟注入 + 规则回放 + 金标文案逐字比对）、
 *   docs/rules/R01-R07-内置规则文案.md（R 系列）、docs/rules/A01-A03-A14-扩展规则文案.md（A 系列）、
 *   技术设计v0.3 §3.6 M5 出口标准（金标回放全绿）。
 * 主体口径：任务（R02 ~ R05 / R07）、项目完成（R06）与 A 系列主体（A01 日报名册槽位 / A02 项目日报 / A14 待办 / A08 阶段；A03 问题随处理时限删除下线 · Push 215）——
 *   规则码 → 主体类型见 builtin-rules 的 subjectKindOf；字段与收件人由唤醒层按实体快照注入。
 * 边界：本文件只算「应发给谁、发什么、幂等键是什么」；真正投递（企微 / 站内信 / 重试 / 死信）由 M5-02 ~ M5-04 承担。
 */
import type { AutomationRule, NotifyChannel, RuleRecipient } from "@libiaolink/contracts";
import type { CalendarShiftDirection, CalendarWindow } from "../calendar/index.js";
import {
  dedupeKey,
  evaluateRule,
  renderTemplate,
  resolveScheduleFire,
  type ConditionEvaluation,
  type ReplaySubjectKind,
  type RuleFieldValue,
} from "./automation.rules.js";
import {
  BUILTIN_RULES,
  findMergedSpec,
  findTemplate,
  subjectKindOf,
  SUBJECT_TEMPLATE_VARIABLES,
} from "./builtin-rules.js";

/** 回放用任务快照（去 DB 化：字段口径 = 规则条件与文案变量所需的最小集）。 */
export interface ReplayTask {
  id: string;
  title: string;
  version: number;
  /** 展示五态（pending / active / done / overdue / early_done，派生口径见 task.rules）。 */
  displayStatus: string;
  urgency: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  ownerId: string | null;
  ownerName: string | null;
  managerId: string | null;
  managerName: string | null;
  projectId: string;
  projectCode: string;
  projectName: string;
  projectProgress: number;
  completedByName: string | null;
  projectGroupId: string | null;
  deliverableTypes: readonly string[];
  fileCount: number;
}

/** 收件人解析结果（id = 幂等 / 投递标识；name = 文案称呼；id 为 null 视为解析不到）。 */
export interface ReplaySubjectRecipient {
  id: string | null;
  name: string | null;
}

/**
 * 通用回放主体（A 系列）：fields = 条件求值与模板变量取数口径；recipients = 收件人解析表（键 = RuleRecipient）。
 * 触发窗口基准字段（trigger.baseField，如 report.date / todo.remind_date）从 fields 取日期串（issue.due_at 随处理时限下线 · Push 215）。
 */
export interface ReplaySubject {
  kind: ReplaySubjectKind;
  id: string;
  /** 事件型规则的窗口版本（task 用；缺省 0）。 */
  version?: number;
  fields: Readonly<Record<string, RuleFieldValue | undefined>>;
  recipients?: Readonly<Partial<Record<RuleRecipient, ReplaySubjectRecipient | null>>>;
}

/** 回放入参：业务日（Asia/Shanghai）+ 数据集 + 日历窗口（顺延开关与方向由调用方按日历设置折算）。 */
export interface ReplayInput {
  businessDate: string;
  /** 任务数据集（R02 ~ R07）；与 subjects 合并参与回放。 */
  tasks?: readonly ReplayTask[];
  /** 通用主体数据集（A01 / A02 / A14；A03 随处理时限删除下线）。 */
  subjects?: readonly ReplaySubject[];
  calendar: CalendarWindow;
  shiftEnabled?: boolean;
  shiftDirection?: CalendarShiftDirection;
  /** 已发送（或已入队）的幂等键：命中即跳过，跨天 / 重启补跑不重复发送。 */
  sentKeys?: readonly string[];
  /** 规则集（缺省 = 内置 R02 ~ R07 + A01 / A02 / A14；回放指定规则便于金标逐条比对）。 */
  rules?: readonly AutomationRule[];
}

export interface ReplayMessage {
  ruleCode: string;
  /** 规则名（消息与明细随行 —— 规则可解释；A03 同 code 两窗口随处理时限删除下线）。 */
  ruleName: string;
  entityId: string;
  windowKey: string;
  dedupeKey: string;
  channel: NotifyChannel;
  recipient: RuleRecipient;
  recipientId: string | null;
  recipientName: string | null;
  title: string | null;
  body: string;
  /** 分组来源（分组规则 = 本条清单覆盖的主体 id；非分组消息省略）。 */
  mergedFrom?: string[];
}

export type ReplaySkipReason =
  | "disabled"
  | "subject_mismatch"
  | "window_mismatch"
  | "not_matched"
  | "recipient_missing"
  | "template_missing"
  | "duplicate";

export interface ReplayDetail {
  ruleCode: string;
  ruleName: string;
  entityId: string;
  windowKey: string | null;
  matched: boolean;
  skipped: ReplaySkipReason | null;
  conditions: ConditionEvaluation[];
}

export interface ReplayReport {
  businessDate: string;
  /** 应发送清单（确定性排序：规则码 → 实体 id）。 */
  messages: ReplayMessage[];
  matched: number;
  skipped: number;
  details: ReplayDetail[];
}

/** 单业务日求值入参（回放器与运行时入口共用的内核口径；subjects 需已映射为通用主体）。 */
export interface BusinessDateEvaluationInput {
  businessDate: string;
  rules: readonly AutomationRule[];
  subjects: readonly ReplaySubject[];
  calendar: CalendarWindow;
  shiftEnabled: boolean;
  shiftDirection: CalendarShiftDirection;
  /** 触发时刻过滤（运行时窗口形态用：返回 false = 触发不在窗口内，不产出、不留痕；回放不传）。 */
  fireAtWithin?: (fireAt: string) => boolean;
}

/** 合并后的候选消息（fireAt = 触发时刻 UTC ISO 串；事件型 = null）。 */
export interface ReplayMergedEntry {
  message: ReplayMessage;
  fireAt: string | null;
}

/** 单业务日求值结果（未做「已发送」过滤；sent 幂等与排序由 finalizeMessages 收口）。 */
export interface BusinessDateEvaluation {
  details: ReplayDetail[];
  merged: ReplayMergedEntry[];
}

/** 事件型规则在回放中的候选口径：任务已处完成态 = 完成事件已发生（真实事件由 outbox 承载，M5-02）。 */
const COMPLETED_STATUSES = ["done", "early_done"];
/** 任务快照 → 通用主体（字段与 R02 ~ R07 的条件 / 文案变量一一对应）。 */
export function toTaskSubject(task: ReplayTask): ReplaySubject {
  const projectLabel =
    task.projectCode === "" ? task.projectName : task.projectName === "" ? task.projectCode : task.projectCode + "·" + task.projectName;
  const taskBrief = "项目：**" + projectLabel + "**" + String.fromCharCode(10) + "任务：「**" + task.title + "**」";
  return {
    kind: "task",
    id: task.id,
    version: task.version,
    fields: {
      "task.id": task.id,
      "task.title": task.title,
      "task.version": task.version,
      "task.display_status": task.displayStatus,
      "task.urgency": task.urgency,
      "task.planned_start": task.plannedStart,
      "task.planned_end": task.plannedEnd,
      "task.actual_start": task.actualStart,
      "task.actual_end": task.actualEnd,
      "task.owner_id": task.ownerId,
      "task.owner_name": task.ownerName,
      "task.manager_name": task.managerName,
      "task.completed_by_name": task.completedByName,
      "task.brief": taskBrief,
      "task.deliverable_types": task.deliverableTypes,
      "task.file_count": task.fileCount,
      "project.id": task.projectId,
      "project.code": task.projectCode,
      "project.name": task.projectName,
      "project.label": projectLabel,
      "project.progress": task.projectProgress,
    },
    recipients: {
      "task.owner": task.ownerId === null ? null : { id: task.ownerId, name: task.ownerName },
      "task.owner_or_project_manager":
        task.ownerId !== null
          ? { id: task.ownerId, name: task.ownerName }
          : task.managerId === null
            ? null
            : { id: task.managerId, name: task.managerName },
      "project.manager": task.managerId === null ? null : { id: task.managerId, name: task.managerName },
      "project.group": task.projectGroupId === null ? null : { id: task.projectGroupId, name: null },
    },
  };
}

/** 触发窗口基准字段（trigger.baseField）取值：主体字段里的日期串（YYYY-MM-DD）；缺失 / 非串 = null。 */
function baseDateOf(subject: ReplaySubject, field: string | null | undefined): string | null {
  if (field === null || field === undefined) return null;
  const value = subject.fields[field];
  return typeof value === "string" ? value : null;
}

/** 收件人解析：主体收件人表命中且 id 非空才算成功（否则由回放器登记 recipient_missing）。 */
function resolveRecipient(subject: ReplaySubject, recipient: RuleRecipient): ReplaySubjectRecipient | null {
  const entry = subject.recipients?.[recipient];
  if (entry === undefined || entry === null || entry.id === null) return null;
  return entry;
}

/** 同一次回放内的重复判定粒度 = 幂等键 + 投放面（实体 + 渠道 + 收件人）：同规则多渠道路由 / 多主体各自成条，互不吞并。 */
function messageIdentity(message: ReplayMessage): string {
  return [message.dedupeKey, message.entityId, message.channel, message.recipient, message.recipientId ?? "-"].join("|");
}

/** 模板变量取值：候选链依次取第一个非空；"@recipient" = 本次解析出的收件人名称；全空 = ""。 */
function variableValue(subject: ReplaySubject, candidates: readonly string[], recipientName: string | null): string {
  for (const token of candidates) {
    if (token === "@recipient") return recipientName ?? "";
    const raw = subject.fields[token];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) return raw.join("、");
    return String(raw);
  }
  return "";
}

/** 主体 → 模板变量（口径 = SUBJECT_TEMPLATE_VARIABLES；模板里出现的变量名必须登记在该表，见模板一致性用例）。 */
function subjectVariables(subject: ReplaySubject, recipientName: string | null): Record<string, string> {
  const mapping = SUBJECT_TEMPLATE_VARIABLES[subject.kind];
  const variables: Record<string, string> = {};
  for (const [name, candidates] of Object.entries(mapping)) {
    variables[name] = variableValue(subject, candidates, recipientName);
  }
  return variables;
}

/** 调度窗口的业务时刻（取 cron 前两段，分钟粒度；不支持星号步进写法，配置错误直接抛）。 */
export function cronTime(cron: string | null | undefined): string {
  if (cron === null || cron === undefined) throw new Error("调度型规则缺少 cron");
  const fields = cron.trim().split(" ");
  if (fields.length !== 5) throw new Error("cron 需五段：" + cron);
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    throw new Error("cron 前两段需为具体时刻（分钟 / 小时）：" + cron);
  }
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}
/**
 * 单业务日求值内核（确定性）：逐规则 × 逐主体 →（主体类型匹配 → 触发窗口 → 条件 → 动作 / 收件人）→ 合并。
 * 去重留痕：主体类型不匹配 / 窗口不匹配 / 未命中 / 收件人缺失 / 模板缺失逐条登记 details；
 * 分组规则（groupBy）按收件人 + 窗口合并为一条清单（R07 任务清单 / A01 未填项目清单）；
 * sent 幂等不在本函数内（由 finalizeMessages 收口，回放与运行时入口按各自场景调用）。
 */
export function evaluateBusinessDate(input: BusinessDateEvaluationInput): BusinessDateEvaluation {
  const rules = input.rules;
  const subjects = input.subjects;
  const details: ReplayDetail[] = [];
  const candidates: Array<{ message: ReplayMessage; groupBy: readonly string[] | null; listValue: string | null; fireAt: string | null }> = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: "-", windowKey: null, matched: false, skipped: "disabled", conditions: [] });
      continue;
    }
    const ruleKind = subjectKindOf(rule.code);
    for (const subject of subjects) {
      if (subject.kind !== ruleKind) {
        details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey: null, matched: false, skipped: "subject_mismatch", conditions: [] });
        continue;
      }
      let windowKey: string | null = null;
      let fireAt: string | null = null;

      if (rule.trigger.kind === "event") {
        // 回放任务主体时，完成事件以任务状态代表事件已发生；其他事件主体（如 A08 stage.advanced）只看 outbox 已给出的事件。
        if (subject.kind === "task") {
          const status = subject.fields["task.display_status"];
          if (typeof status !== "string" || !COMPLETED_STATUSES.includes(status)) {
            details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey: null, matched: false, skipped: "window_mismatch", conditions: [] });
            continue;
          }
        }
        windowKey = "v" + String(subject.version ?? 0);
      } else {
        const fire = resolveScheduleFire({
          window: rule.trigger.window ?? "SAME_DAY",
          businessDate: input.businessDate,
          baseDate: baseDateOf(subject, rule.trigger.baseField),
          time: cronTime(rule.trigger.cron),
          shiftEnabled: input.shiftEnabled,
          shiftDirection: input.shiftDirection,
          calendar: input.calendar,
        });
        if (fire === null || fire.fireDate !== input.businessDate) {
          details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey: fire === null ? null : fire.windowKey, matched: false, skipped: "window_mismatch", conditions: [] });
          continue;
        }
        if (input.fireAtWithin !== undefined && !input.fireAtWithin(fire.fireAt)) continue;
        windowKey = fire.windowKey;
        fireAt = fire.fireAt;
      }

      const evaluation = evaluateRule(rule, subject.fields, { businessDate: input.businessDate });
      if (!evaluation.matched) {
        details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey, matched: false, skipped: "not_matched", conditions: evaluation.conditions });
        continue;
      }

      const produced: ReplayMessage[] = [];
      const producedCandidates: Array<{ message: ReplayMessage; groupBy: readonly string[] | null; listValue: string | null; fireAt: string | null }> = [];
      let skip: ReplaySkipReason | null = null;

      for (const action of rule.actions) {
        const template = findTemplate(action.template);
        if (template === null) {
          skip = skip ?? "template_missing";
          continue;
        }
        const channel = action.channel ?? "inbox";
        const groupBy = action.groupBy !== undefined && action.groupBy.length > 0 ? action.groupBy : null;
        const spec = groupBy === null ? null : findMergedSpec(rule.code, channel);
        const recipientKinds = Array.isArray(action.recipient) ? action.recipient : [action.recipient];
        const resolvedRecipients: Array<{ kind: RuleRecipient; recipient: ReplaySubjectRecipient }> = [];
        const seenRecipientIds = new Set<string>();
        for (const recipientKind of recipientKinds) {
          const recipient = resolveRecipient(subject, recipientKind);
          if (recipient === null || recipient.id === null || seenRecipientIds.has(recipient.id)) continue;
          seenRecipientIds.add(recipient.id);
          resolvedRecipients.push({ kind: recipientKind, recipient });
        }
        const actionMessages: ReplayMessage[] = [];
        const baseDedupeKey = dedupeKey(rule.code, subject.id, windowKey);
        for (const { kind: recipientKind, recipient } of resolvedRecipients) {
          const variables = subjectVariables(subject, recipient.name);
          // 合并清单变量先按本主体的清单值注入（单条形态），合并步再按 bucket 重渲染全量清单。
          if (spec !== null) variables[spec.listVariable] = variableValue(subject, [spec.listField], recipient.name);
          actionMessages.push({
            ruleCode: rule.code,
            ruleName: rule.name,
            entityId: subject.id,
            windowKey,
            // 多收件人动作必须逐人成键；同一人兼任多个角色时已在上面按 recipient id 去重。
            dedupeKey: resolvedRecipients.length > 1 ? baseDedupeKey + ":" + recipient.id : baseDedupeKey,
            channel,
            recipient: recipientKind,
            recipientId: recipient.id,
            recipientName: recipient.name,
            title: template.title === null ? null : renderTemplate(template.title, variables),
            body: renderTemplate(template.body, variables),
          });
        }
        if (resolvedRecipients.length === 0) skip = skip ?? "recipient_missing";
        const recipientName = actionMessages[0]?.recipientName ?? null;
        const listValue = spec === null ? null : variableValue(subject, [spec.listField], recipientName);
        for (const message of actionMessages) {
          produced.push(message);
          producedCandidates.push({ message, groupBy, listValue, fireAt });
        }
      }

      if (produced.length === 0) {
        details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey, matched: false, skipped: skip ?? "recipient_missing", conditions: evaluation.conditions });
        continue;
      }
      details.push({ ruleCode: rule.code, ruleName: rule.name, entityId: subject.id, windowKey, matched: true, skipped: null, conditions: evaluation.conditions });
      for (const item of producedCandidates) candidates.push(item);
    }
  }

  const merged: ReplayMergedEntry[] = [];
  const groups = new Map<string, Array<{ message: ReplayMessage; listValue: string | null; fireAt: string | null }>>();
  for (const item of candidates) {
    if (item.groupBy === null) {
      merged.push({ message: item.message, fireAt: item.fireAt });
      continue;
    }
    const key = [item.message.ruleCode, item.message.channel, item.message.recipient, item.message.recipientId ?? "-", item.message.windowKey].join("|");
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [{ message: item.message, listValue: item.listValue, fireAt: item.fireAt }]);
    else bucket.push({ message: item.message, listValue: item.listValue, fireAt: item.fireAt });
  }
  // 分组规则恒落到收件人粒度（哪怕本次只命中一条）：幂等键 = 规则 + 收件人 + 窗口，跨天 / 补跑不因条目数变化而漏判。
  for (const bucket of groups.values()) {
    const firstItem = bucket[0];
    if (firstItem === undefined) continue;
    const first = firstItem.message;
    const sourceIds = bucket.map((item) => item.message.entityId);
    const recipientEntityId = first.recipientId ?? first.entityId;
    const recipientKey = dedupeKey(first.ruleCode, recipientEntityId, first.windowKey);
    const spec = findMergedSpec(first.ruleCode, first.channel);
    const template = spec === null ? null : findTemplate(spec.template);
    if (spec === null || template === null) {
      merged.push({ message: { ...first, entityId: recipientEntityId, dedupeKey: recipientKey, mergedFrom: sourceIds }, fireAt: firstItem.fireAt });
      continue;
    }
    const list = bucket.map((item) => item.listValue ?? "").join(spec.separator ?? "、");
    const listVariables = { [spec.listVariable]: list, "任务负责人": first.recipientName ?? "" };
    merged.push({
      message: {
        ...first,
        entityId: recipientEntityId,
        dedupeKey: recipientKey,
        title: template.title === null ? null : renderTemplate(template.title, listVariables),
        body: renderTemplate(template.body, listVariables),
        mergedFrom: sourceIds,
      },
      fireAt: firstItem.fireAt,
    });
  }

  return { details, merged };
}

/**
 * 应发送清单收口：sent 幂等（已发送 / 已入队）与投放面重复判定 → duplicate（同条 details 同步标记）；
 * 确定性排序 = 规则码 → 实体 id（回放报告与运行时输出同序）。
 */
export function finalizeMessages(entries: readonly ReplayMergedEntry[], details: ReplayDetail[], sentKeys: readonly string[]): ReplayMessage[] {
  const sent = new Set(sentKeys);
  const detailIndex = new Map<string, ReplayDetail>();
  for (const detail of details) detailIndex.set([detail.ruleCode, detail.entityId, detail.windowKey ?? "-"].join("|"), detail);
  const markDuplicate = (message: ReplayMessage): void => {
    for (const id of message.mergedFrom ?? [message.entityId]) {
      const detail = detailIndex.get([message.ruleCode, id, message.windowKey].join("|"));
      if (detail !== undefined && detail.skipped === null) detail.skipped = "duplicate";
    }
  };
  const messages: ReplayMessage[] = [];
  const producedIdentities = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (sent.has(message.dedupeKey) || producedIdentities.has(messageIdentity(message))) {
      markDuplicate(message);
      continue;
    }
    producedIdentities.add(messageIdentity(message));
    messages.push(message);
  }
  messages.sort((left, right) => (left.ruleCode + "|" + left.entityId).localeCompare(right.ruleCode + "|" + right.entityId));
  return messages;
}

/**
 * 回放主流程：业务日 + 数据集（任务 + 通用主体）+ 日历 → 应发送清单（确定性排序、幂等去重、分组合并）。
 * M5-02 接线段（lan）的运行时求值入口见 automation.runtime.ts —— 与回放共用 evaluateBusinessDate / finalizeMessages，
 * 同一规则集 + 同一主体 + 同一业务日下两处输出逐字段一致（自检用例见 test/automation-runtime.test.ts）。
 */
export function replayRules(input: ReplayInput): ReplayReport {
  const evaluation = evaluateBusinessDate({
    businessDate: input.businessDate,
    rules: input.rules ?? BUILTIN_RULES,
    subjects: [...(input.tasks ?? []).map(toTaskSubject), ...(input.subjects ?? [])],
    calendar: input.calendar,
    shiftEnabled: input.shiftEnabled ?? false,
    shiftDirection: input.shiftDirection ?? "forward",
  });
  return {
    businessDate: input.businessDate,
    messages: finalizeMessages(evaluation.merged, evaluation.details, input.sentKeys ?? []),
    matched: evaluation.details.filter((item) => item.matched).length,
    skipped: evaluation.details.filter((item) => item.skipped !== null).length,
    details: evaluation.details,
  };
}
