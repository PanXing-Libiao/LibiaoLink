/**
 * M5-06-1B · 规则管理 / 只读试运行 / 运行记录读面。
 *
 * 口径：
 * - 管理面固定返回 10 条内置规则（R02 ~ R07 + A01 / A02 / A08 / A14），R01 不入列表；
 * - 保存只允许 enabled 与 actions.channel / actions.recipient 变化，version 为乐观锁；
 * - 保存在同一事务内完成规则更新、version + 1、审计与一规则一 job reconcile；
 * - 试运行只读：不写 automation_runs / outbox / 审计；事件型必须给 entityId，调度型最多评估 100 个主体。
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  AUTOMATION_RULE_EDITABLE_FIELDS,
  AutomationRuleTestResponseSchema,
  AutomationRuleViewSchema,
  type AutomationAction,
  type AutomationRuleListResponse,
  type AutomationRulePatchBody,
  type AutomationRuleTestBody,
  type AutomationRuleTestMessage,
  type AutomationRuleTestResponse,
  type AutomationRuleTestSkipped,
  type AutomationRuleView,
  type AutomationRun,
  type AutomationRunListQuery,
  type AutomationRunListResponse,
  type AutomationScheduleJobStatus,
  type RuleEventTopic,
  type RuleRecipient,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { ClockService } from "../../common/clock/clock.service.js";
import type { DbClient } from "../../db/db-client.js";
import { DatabaseService } from "../../db/database.service.js";
import { JobsStore } from "../../db/jobs.store.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { CalendarService } from "../calendar/index.js";
import { atShanghaiTime, type CalendarWindow } from "../calendar/index.js";
import { PermissionService } from "../permission/index.js";
import {
  AUTOMATION_SCHEDULE_JOB_KIND,
  evaluateEventMessages,
  planWindowMessages,
  subjectKindOf,
  type ReplaySubject,
  type RuntimeDetail,
  type RuntimeEvaluation,
} from "./index.js";
import {
  AutomationRuleRepository,
  AutomationRunRepository,
  automationRuleFromRow,
  automationRunFromRow,
  type AutomationRuleRow,
  type AutomationRunFilter,
} from "./automation.repository.js";
import type { ReplaySubjectKind } from "./automation.rules.js";

/** 试运行主体端口：生产 = outbox 的 AutomationSubjectReader；单测可注入替身。 */
export interface AutomationTrialSubjectPort {
  subjectById(
    topic: RuleEventTopic,
    entityId: string,
    at: Date,
    client?: DbClient,
  ): Promise<ReplaySubject | null>;
  loadWindow(
    window: { from: Date; to: Date },
    at: Date,
    client?: DbClient,
  ): Promise<{ subjects: ReplaySubject[]; calendar: CalendarWindow }>;
}

export const AUTOMATION_TRIAL_SUBJECTS = Symbol("AUTOMATION_TRIAL_SUBJECTS");

/** 调度型试运行的主体上限（契约口径：最多 100 个，超出置 truncated = true）。 */
const TEST_SUBJECT_LIMIT = 100;

/** 主体类型 → 允许配置的收件人口径（与运行时主体映射器提供的 recipients 表同源）。 */
const ALLOWED_RECIPIENTS: Readonly<Record<ReplaySubjectKind, readonly RuleRecipient[]>> = {
  task: ["task.owner", "task.owner_or_project_manager", "project.manager", "project.group"],
  project: ["project.group"],
  report_slot: ["report.member"],
  project_day: ["project.group"],
  todo: ["rule.members"],
  stage: ["project.group"],
};

function validationError(message: string, path?: string): AppError {
  return new AppError("VALIDATION_FAILED", message, [{ code: "custom", message, path }]);
}

/**
 * 只读字段 / 动作数量 / 顺序变更（S8-4 契约：规则保存冲突或不可修改返回 409）。
 * 错误码沿用 VERSION_CONFLICT —— 统一错误码表暂无通用 CONFLICT；契约只冻结状态码与语义，
 * 不把「改模板 / 改条件」伪装成 400 参数校验。
 */
function immutableConflict(message: string, path?: string): AppError {
  return new AppError("VERSION_CONFLICT", message, [{ code: "custom", message, path }]);
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function recipientsOf(action: AutomationAction): readonly RuleRecipient[] {
  return Array.isArray(action.recipient) ? action.recipient : [action.recipient];
}

/** actions 白名单：数组顺序 / 数量 / kind / template / groupBy 只读；仅 channel / recipient 可变。 */
function validateActionChanges(row: AutomationRuleRow, next: readonly AutomationAction[]): AutomationAction[] {
  if (next.length !== row.actions.length) {
    throw immutableConflict("动作数量不可修改：" + row.code + " 现有 " + row.actions.length + " 项，提交 " + next.length + " 项", "actions");
  }
  const subjectKind = subjectKindOf(row.code);
  const allowedRecipients = new Set<RuleRecipient>(ALLOWED_RECIPIENTS[subjectKind]);
  next.forEach((action, index) => {
    const before = row.actions[index];
    if (before === undefined) throw immutableConflict("动作顺序与数量必须保持原值", "actions." + index);
    if (action.kind !== before.kind) {
      throw immutableConflict("动作类型只读，不可修改（actions." + index + ".kind）", "actions." + index + ".kind");
    }
    if (action.template !== before.template) {
      throw immutableConflict("消息模板只读，不可修改（actions." + index + ".template）", "actions." + index + ".template");
    }
    if (!sameStringArray(action.groupBy, before.groupBy)) {
      throw immutableConflict("合并维度只读，不可修改（actions." + index + ".groupBy）", "actions." + index + ".groupBy");
    }
    const channel = action.channel ?? "inbox";
    if (action.kind === "notification" && channel !== "inbox") {
      throw validationError("站内信动作的渠道只能为 inbox", "actions." + index + ".channel");
    }
    if (action.kind === "notify" && channel === "inbox") {
      throw validationError("渠道消息动作不能使用 inbox（站内信请使用 notification）", "actions." + index + ".channel");
    }
    for (const recipient of recipientsOf(action)) {
      if (!allowedRecipients.has(recipient)) {
        throw validationError(
          "收件人口径 " + recipient + " 不适用于规则 " + row.code + "（主体类型 " + subjectKind + "）",
          "actions." + index + ".recipient",
        );
      }
    }
  });
  return [...next];
}

function jobStatusOf(status: string | undefined): AutomationScheduleJobStatus | null {
  return status === "pending" || status === "done" || status === "failed" ? status : null;
}

function toRuleView(
  row: AutomationRuleRow,
  lastRunAt: Date | undefined,
  job: { status: string; runAt: Date } | undefined,
): AutomationRuleView {
  const rule = automationRuleFromRow(row);
  const view = {
    ...rule,
    id: row.id,
    builtIn: row.builtIn,
    editableFields: [...AUTOMATION_RULE_EDITABLE_FIELDS],
    lastRunAt: lastRunAt === undefined ? null : lastRunAt.toISOString(),
    nextRunAt: job?.status === "pending" ? job.runAt.toISOString() : null,
    scheduleJobStatus: jobStatusOf(job?.status),
  };
  return AutomationRuleViewSchema.parse(view);
}

/** 试运行时间基准：业务日 23:59:59.999（Asia/Shanghai），保证 eqOffsetDays 与窗口同日求值。 */
function trialAtOf(businessDate: string): Date {
  return new Date(Date.parse(atShanghaiTime(businessDate, "23:59")) + 59_999);
}

function dedupeSubjects(subjects: readonly ReplaySubject[]): ReplaySubject[] {
  const byId = new Map<string, ReplaySubject>();
  for (const subject of subjects) byId.set(subject.kind + "|" + subject.id, subject);
  return [...byId.values()].sort((left, right) => (left.kind + "|" + left.id).localeCompare(right.kind + "|" + right.id));
}

function testMessageOf(
  message: RuntimeEvaluation["messages"][number],
  actions: readonly AutomationAction[],
): AutomationRuleTestMessage {
  return {
    ruleCode: message.ruleCode as AutomationRuleTestMessage["ruleCode"],
    entityId: message.entityId,
    windowKey: message.windowKey,
    recipient: message.recipientName ?? message.recipient,
    channel: message.channel,
    template: templateCodeFor(message, actions),
    dedupeKey: message.dedupeKey,
    title: message.title,
    body: message.body,
  };
}

/** 试运行消息的模板码：ReplayMessage 只带规则 / 渠道，按规则动作反查（同渠道首个动作）。 */
function templateCodeFor(
  message: RuntimeEvaluation["messages"][number],
  actions: readonly AutomationAction[],
): string {
  const action = actions.find((item) => (item.channel ?? "inbox") === message.channel);
  if (action === undefined) throw new Error("试运行消息缺少对应动作模板：" + message.ruleCode + " · " + message.channel);
  return action.template;
}

function testSkippedOf(detail: RuntimeDetail): AutomationRuleTestSkipped | null {
  if (detail.skipped === null) return null;
  return {
    reason: detail.skipped,
    ruleCode: detail.ruleCode as AutomationRuleTestSkipped["ruleCode"],
    entityId: detail.entityId === "-" ? null : detail.entityId,
    windowKey: detail.windowKey,
    conditions: detail.conditions,
  };
}

@Injectable()
export class AutomationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rules: AutomationRuleRepository,
    private readonly runs: AutomationRunRepository,
    private readonly jobs: JobsStore,
    private readonly audit: AuditService,
    private readonly permission: PermissionService,
    private readonly clock: ClockService,
    private readonly calendar: CalendarService,
    @Inject(AUTOMATION_TRIAL_SUBJECTS) private readonly subjects: AutomationTrialSubjectPort,
  ) {}

  async listRules(actorId: string): Promise<AutomationRuleListResponse> {
    await this.permission.assertCan(actorId, "automation.view", undefined, "查看自动化规则需要 automation.view");
    const rows = await this.rules.listManageableRules();
    return { items: await this.toViews(rows) };
  }

  async getRule(actorId: string, code: string): Promise<AutomationRuleView> {
    await this.permission.assertCan(actorId, "automation.view", undefined, "查看自动化规则需要 automation.view");
    const row = await this.requireRule(code);
    return (await this.toViews([row]))[0] as AutomationRuleView;
  }

  async patchRule(actorId: string, code: string, body: AutomationRulePatchBody): Promise<AutomationRuleView> {
    await this.permission.assertCan(actorId, "automation.manage", undefined, "修改自动化规则需要 automation.manage");
    const before = await this.requireRule(code);
    if (body.version !== before.version) {
      throw new AppError("VERSION_CONFLICT", "规则已被他人更新，请刷新后重试");
    }
    const actions = body.actions === undefined ? before.actions : validateActionChanges(before, body.actions);
    const enabled = body.enabled ?? before.enabled;
    const at = this.clock.now();
    const updated = await this.database.db.transaction(async (tx) => {
      const row = await this.rules.updateWithVersion(
        before.id,
        body.version,
        { enabled, actions },
        actorId,
        at,
        tx,
      );
      if (row === null) throw new AppError("VERSION_CONFLICT", "规则已被他人更新，请刷新后重试");
      if (row.trigger.kind === "schedule") {
        const cron = row.trigger.cron;
        if (cron === null || cron === undefined || cron.trim() === "") {
          throw new Error("调度型规则缺少 cron：" + row.code);
        }
        await this.jobs.reconcileAutomationScheduleJob(tx, {
          ruleCode: row.code,
          ruleVersion: row.version,
          cron,
          enabled: row.enabled,
        });
      }
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "automation_rule",
        objectId: row.id,
        summary: "更新自动化规则：" + row.code + " · " + row.name,
        changes: diffRecords(
          { enabled: before.enabled, actions: before.actions },
          { enabled: row.enabled, actions: row.actions },
        ),
        metadata: {
          code: row.code,
          beforeVersion: before.version,
          afterVersion: row.version,
        },
      });
      return row;
    });
    return (await this.toViews([updated]))[0] as AutomationRuleView;
  }

  async testRule(actorId: string, code: string, body: AutomationRuleTestBody): Promise<AutomationRuleTestResponse> {
    await this.permission.assertCan(actorId, "automation.manage", undefined, "试运行自动化规则需要 automation.manage");
    const row = await this.requireRule(code);
    const rule = automationRuleFromRow(row);
    const businessDate = body.businessDate ?? this.clock.today();
    const at = trialAtOf(businessDate);
    let evaluation: RuntimeEvaluation;
    let evaluatedCount: number;
    let truncated = false;

    if (rule.trigger.kind === "event") {
      if (body.entityId === undefined) {
        throw validationError("事件型规则试运行必须提供 entityId", "entityId");
      }
      const topic = rule.trigger.topic;
      if (topic === null || topic === undefined) throw new Error("事件型规则缺少 topic：" + rule.code);
      const subject = await this.subjects.subjectById(topic, body.entityId, at);
      if (subject === null) throw new AppError("NOT_FOUND", "试运行主体不存在：" + body.entityId);
      evaluation = evaluateEventMessages({ topic, rules: [rule], subject, at });
      evaluatedCount = 1;
    } else {
      const shift = await this.calendar.getSettings();
      const window = { from: new Date(atShanghaiTime(businessDate, "00:00")), to: at };
      const bundle = await this.subjects.loadWindow(window, at);
      const kind = subjectKindOf(rule.code);
      let relevant = dedupeSubjects(bundle.subjects.filter((subject) => subject.kind === kind));
      if (body.entityId !== undefined) {
        relevant = relevant.filter((subject) => subject.id === body.entityId);
        if (relevant.length === 0) throw new AppError("NOT_FOUND", "试运行主体不存在：" + body.entityId);
      }
      truncated = relevant.length > TEST_SUBJECT_LIMIT;
      relevant = relevant.slice(0, TEST_SUBJECT_LIMIT);
      evaluatedCount = relevant.length;
      evaluation = planWindowMessages({
        jobKind: AUTOMATION_SCHEDULE_JOB_KIND,
        window,
        rules: [rule],
        subjects: relevant,
        at,
        calendar: bundle.calendar,
        shiftEnabled: shift.reminderShiftEnabled,
        shiftDirection: shift.shiftDirection,
      });
    }

    const skipped = evaluation.details
      .map(testSkippedOf)
      .filter((item): item is AutomationRuleTestSkipped => item !== null);
    return AutomationRuleTestResponseSchema.parse({
      businessDate,
      evaluatedCount,
      // 命中计数按「规则 × 实体 × 窗口」求值明细统计（与 replayRules.matched 同口径）；
      // 一条命中可因多收件人 / 分组合并产出多条消息，故不能直接用 messages.length。
      matchedCount: evaluation.details.filter((detail) => detail.matched).length,
      skippedCount: skipped.length,
      truncated,
      messages: evaluation.messages.map((message) => ({
        ...testMessageOf(message, rule.actions),
      })),
      skipped,
    });
  }

  async listRuns(actorId: string, query: AutomationRunListQuery): Promise<AutomationRunListResponse> {
    await this.permission.assertCan(actorId, "automation.view", undefined, "查看运行记录需要 automation.view");
    if (query.from !== undefined && query.to !== undefined && Date.parse(query.from) > Date.parse(query.to)) {
      throw validationError("from 不能晚于 to", "from");
    }
    const filter: AutomationRunFilter = {
      ...(query.ruleCode === undefined ? {} : { ruleCode: query.ruleCode }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.topic === undefined ? {} : { topic: query.topic }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      page: query.page,
      limit: query.limit,
    };
    const [rows, total] = await Promise.all([this.runs.list(filter), this.runs.count(filter)]);
    return {
      items: rows.map(automationRunFromRow),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async getRun(actorId: string, id: number): Promise<AutomationRun> {
    await this.permission.assertCan(actorId, "automation.view", undefined, "查看运行记录需要 automation.view");
    const row = await this.runs.findById(id);
    if (row === null) throw new AppError("NOT_FOUND", "运行记录不存在：" + String(id));
    return automationRunFromRow(row);
  }

  private async requireRule(code: string): Promise<AutomationRuleRow> {
    const row = await this.rules.findManageableByCode(code);
    if (row === null) throw new AppError("NOT_FOUND", "自动化规则不存在或不可管理：" + code);
    return row;
  }

  private async toViews(rows: readonly AutomationRuleRow[]): Promise<AutomationRuleView[]> {
    const codes = rows.map((row) => row.code);
    const [lastRunAt, jobs] = await Promise.all([
      this.rules.lastRunAtByRuleCodes(codes),
      this.rules.scheduleJobsByRuleCodes(codes),
    ]);
    return rows.map((row) => toRuleView(row, lastRunAt.get(row.code), jobs.get(row.code)));
  }
}
