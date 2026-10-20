/**
 * automation 规则接线（S7-4 · M5-02 接线段）· 消费 / 调度两入口装配。
 *
 * ① 事件消费（OutboxTopicHandler；主题 = 契约 RULE_EVENT_TOPICS）：领取事件行 → 冷启动判据（行创建时刻）→
 *    读主体快照（AutomationSubjectReader）→ evaluateEventMessages（引擎，wmj 线）→ 逐条产出：inbox →
 *    `notify.message`（站内信）/ wecom_group → `notify.group`（群播报；appendOutboxIfAbsent，dedupeKey = 引擎幂等键，
 *    唯一约束兜底至少一次投递）；
 * ② 调度（OutboxJobHandler；kind = automation-schedule.job）：读窗口主体池 → planWindowMessages → 同上产出，
 *    与 last_run_at 推进同一事务（JobRunContext.tx）—— 崩溃回滚后窗口重放，幂等键兜底不重发。
 *
 * 渠道口径（M5-03-3 起；M5-03-5-4 接线段收口）：inbox → `notify.message`（S7-4 j1）；wecom_app → `notify.message`
 *   （channel=wecom_app，幂等键加 ":app" 后缀避免与同规则 inbox 行撞 outbox 唯一约束；投递层按 users.username
 *   解析 userid）；wecom_aibot → `notify.message`（channel=wecom_aibot · 单聊智能机器人，M5-03-5 接线段；幂等键加
 *   ":aibot" 后缀 —— 与同规则 inbox / app 行并存不撞 outbox 唯一约束；投递层同按 users.username 解析 userid）；
 *   wecom_group → `notify.group`（群播报：载荷只带 projectId（寻址键）+ 文案，投递层按绑定解析 chatid + 按会话
 *   限速）；未落地渠道（email 随 M5-04）—— 逐条 warn 留痕 + 计数入日志/note（与投递层护栏 wmj PR #197 配对）。
 * 冷启动保护（事件形态）：AUTOMATION_EVENT_MAX_AGE_MS 透传引擎 —— 接线前积压的历史事件按 `event_too_old`
 *   消费掉、不补发业务通知（投递层免打扰的「次日补发」不受影响）。
 * 边界：本层只做「主体读库 + 引擎求值 + 产出落库」；投递 / 合并 / 免打扰 / 重试 / 死信归 notify + outbox 运行时。
 */
import {
  RULE_EVENT_TOPICS,
  type AutomationMessageSnapshot,
  type AutomationRule,
  type NotifyGroupMessagePayload,
  type NotifyMessagePayload,
  type RuleEventTopic,
} from "@libiaolink/contracts";
import type { Logger } from "@nestjs/common";
import type { Env } from "../config/env.js";
import type { DbClient } from "../db/db-client.js";
import type { OutboxEventInput } from "../db/outbox.js";
import {
  AUTOMATION_SCHEDULE_JOB_KIND,
  evaluateEventMessages,
  planWindowMessages,
  subjectKindOf,
  type AutomationRunInsert,
  type ReplayMessage,
  type ReplaySubject,
  type RuntimeDetail,
} from "../modules/automation/index.js";
import type { CalendarShiftDirection, CalendarWindow } from "../modules/calendar/index.js";
import { isDeliverableChannel, NOTIFY_GROUP_TOPIC, NOTIFY_MESSAGE_TOPIC } from "../modules/notify/index.js";
import type { OutboxHandleOutcome, OutboxTopicHandler } from "./handler.js";
import type { JobRunResult, OutboxJobHandler } from "./scheduler.js";
import type { WindowSubjectBundle } from "./automation-subjects.js";

/** 通知类型（C5-02 分类）：规则码 → 类型。一期落在 notify.message 的四条规则均为业务提醒。 */
const NOTIFICATION_TYPE_BY_RULE: Readonly<Record<string, "reminder" | "approval" | "broadcast" | "system">> = {
  R02: "reminder",
  R07: "reminder",
  A01: "reminder",
  A14: "reminder",
  A08: "broadcast",
};

/** 接线层日志（Nest Logger 结构兼容；单测注入替身）。 */
export interface WiringLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 主体读取端口（生产 = AutomationSubjectReader；单测注入替身，不连库）。 */
export interface AutomationSubjectPort {
  eventSubject(
    topic: RuleEventTopic,
    payload: Record<string, unknown>,
    at: Date,
    client?: DbClient,
  ): Promise<ReplaySubject | null>;
  loadWindow(window: { from: Date; to: Date }, at: Date, client?: DbClient): Promise<WindowSubjectBundle>;
}

/** 运行记录写入端口（生产 = AutomationRunRepository）：返回本事务真正新建的 dedupe_key。 */
export interface AutomationRunPort {
  insertIfAbsent(client: DbClient, inputs: readonly AutomationRunInsert[]): Promise<ReadonlySet<string>>;
}

/** 接线装配依赖（组合根在 OutboxModule.forRoot 组装；测试逐项替身）。 */
export interface AutomationWiringDeps {
  env: Env;
  subjects: AutomationSubjectPort;
  /** outbox 写入端口（生产 = appendOutboxIfAbsent）：事件形态用 db（主连接）/ 调度形态用 JobRunContext.tx。 */
  append: (client: DbClient, event: OutboxEventInput) => Promise<void>;
  /** 事件形态使用的连接（生产 = DatabaseService.db）。 */
  db: DbClient;
  /** 规则来源（生产 = AutomationRuleRepository.listEnabledRules；读表，空表不回退代码常量）。 */
  rules: (client?: DbClient) => Promise<AutomationRule[]>;
  /** 运行留痕端口（automation_runs，dedupe_key 唯一）。 */
  runs: AutomationRunPort;
  /** 事件路径事务入口：主体读取、run 写入与 outbox 追加必须同一事务。 */
  transaction: <T>(work: (tx: DbClient) => Promise<T>) => Promise<T>;
  /** 求值时刻（ClockService 注入；引擎不取系统时间）。 */
  now: () => Date;
  /** 节假日顺延设置（D5-02：CalendarService.getSettings）。 */
  shift: () => Promise<{ reminderShiftEnabled: boolean; shiftDirection: CalendarShiftDirection }>;
  logger: WiringLogger;
}

/** 产出统计（日志与 JobRunResult.note 共用）。 */
export interface ProduceStats {
  /** notify.message（站内信）产出行数。 */
  produced: number;
  /** notify.message（channel=wecom_app · 应用消息）产出行数（M5-03-3 起）。 */
  appProduced: number;
  /** notify.message（channel=wecom_aibot · 单聊智能机器人）产出行数（M5-03-5-4 起）。 */
  aibotProduced: number;
  /** notify.group（群播报）产出行数（M5-03-2 接线段起）。 */
  groupProduced: number;
  /** 未落地渠道跳过（email 随 M5-04）条数。 */
  channelSkipped: number;
}
/** 单条产出上下文（事件形态 / 调度形态共用；append 由调用方绑定事务或主连接）。 */
interface ProduceContext {
  rules: readonly AutomationRule[];
  append: (event: OutboxEventInput) => Promise<void>;
  logger: WiringLogger;
  /** 留痕作用域（事件 = `outbox#id`；调度 = `kind#jobId`）。 */
  scope: string;
}

/** 规则码 → 关联对象（refType / refId 成对；任务主体映射 task、项目日报主体映射 project，其余暂无单一对象 → 空）。 */
function referenceOf(ruleCode: string, entityId: string): { refType: string | null; refId: string | null } {
  const kind = subjectKindOf(ruleCode);
  if (kind === "task") return { refType: "task", refId: entityId };
  if (kind === "project_day") return { refType: "project", refId: entityId };
  if (kind === "stage") return { refType: "stage", refId: entityId };
  return { refType: null, refId: null };
}

/** 模板码回溯（排障用）：规则码 + 规则名 + 渠道 → 动作模板。 */
function templateCodeOf(rules: readonly AutomationRule[], message: ReplayMessage): string | null {
  const rule = rules.find((item) => item.code === message.ruleCode && item.name === message.ruleName);
  if (rule === undefined) return null;
  for (const action of rule.actions) {
    const channel = action.channel ?? "inbox";
    if (channel === message.channel) return action.template;
  }
  return null;
}

/** 跳过留痕汇总（引擎 skipped → 一行日志：原因 × 条数）。 */
function logSkips(logger: WiringLogger, scope: string, skipped: readonly { reason: string }[]): void {
  if (skipped.length === 0) return;
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const parts = [...counts.entries()].map(([reason, value]) => reason + "×" + value);
  logger.log("规则接线：跳过 " + skipped.length + " 项（" + parts.join(" / ") + "）：" + scope);
}

/** 消息唯一标识（同一规则同键可因多渠道并存；运行快照 / 产出过滤共用）。 */
function messageIdentity(message: ReplayMessage): string {
  return message.dedupeKey + "|" + message.channel + "|" + (message.recipientId ?? "-");
}

/** 与 produceMessages 同口径的确定性载荷问题；null = 可产出。 */
function messageProblem(message: ReplayMessage): string | null {
  const title = message.title === null ? null : message.title.trim();
  const body = message.body.trim();
  if (message.channel === "wecom_group") {
    if (message.recipientId === null) return message.dedupeKey + "（无群收件人）";
    if (body === "") return message.dedupeKey + "（正文为空）";
    return null;
  }
  if (message.recipientId === null) return message.dedupeKey + "（无收件人）";
  if (title === null || title === "" || body === "") return message.dedupeKey + "（标题 / 正文为空）";
  return null;
}

/** 消息 → automation_runs.messages 快照。 */
function messageSnapshot(rules: readonly AutomationRule[], message: ReplayMessage): AutomationMessageSnapshot {
  return {
    recipient: message.recipientName ?? message.recipientId ?? message.recipient,
    channel: message.channel,
    template: templateCodeOf(rules, message) ?? "",
    dedupeKey: message.dedupeKey,
    title: message.title,
    body: message.body,
  };
}

interface PlannedRun {
  input: AutomationRunInsert;
  messages: ReplayMessage[];
}

interface PlannedRuns {
  plans: PlannedRun[];
  invalid: string[];
  invalidMessageIds: Set<string>;
}

/** 求值明细 × 消息 → 运行记录候选；无效载荷对应的 run 直接标 failed，且不产出该消息。 */
function planRuns(input: {
  source: "event" | "schedule";
  topic: RuleEventTopic | null;
  eventDedupeKey: string | null;
  rules: readonly AutomationRule[];
  details: readonly RuntimeDetail[];
  messages: readonly ReplayMessage[];
}): PlannedRuns {
  const plans: PlannedRun[] = [];
  const invalid: string[] = [];
  const invalidMessageIds = new Set<string>();
  const seen = new Set<string>();
  for (const detail of input.details) {
    const rule = input.rules.find((item) => item.code === detail.ruleCode);
    if (rule === undefined) continue;
    const entityId = detail.entityId === "-" ? null : detail.entityId;
    const dedupeKey =
      input.source === "event"
        ? "event:" + (input.eventDedupeKey ?? "-") + ":" + rule.code + ":" + (entityId ?? "-")
        : "schedule:" + rule.code + ":" + (entityId ?? "-") + ":" + (detail.windowKey ?? "-");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const attached = input.messages.filter(
      (message) =>
        message.ruleCode === rule.code &&
        message.windowKey === detail.windowKey &&
        (message.entityId === detail.entityId || message.mergedFrom?.includes(detail.entityId) === true),
    );
    const problems = attached
      .map((message) => ({ message, problem: messageProblem(message) }))
      .filter((item): item is { message: ReplayMessage; problem: string } => item.problem !== null);
    for (const item of problems) {
      invalid.push(item.problem);
      invalidMessageIds.add(messageIdentity(item.message));
    }
    const failed = problems.length > 0;
    const skipReason = detail.skipped ?? (attached.length === 0 ? "not_matched" : null);
    plans.push({
      input: {
        ruleCode: rule.code,
        ruleVersion: rule.version,
        source: input.source,
        topic: input.source === "event" ? input.topic : null,
        windowKey: detail.windowKey,
        entityType: entityId === null ? null : subjectKindOf(rule.code),
        entityId,
        dedupeKey,
        status: failed ? "failed" : skipReason === null ? "hit" : "skipped",
        skipReason: failed ? null : skipReason,
        conditions: detail.conditions,
        actions: rule.actions,
        messages: failed ? [] : attached.map((message) => messageSnapshot(input.rules, message)),
        error: failed ? problems.map((item) => item.problem).join("；") : null,
      },
      messages: attached,
    });
  }
  return { plans, invalid, invalidMessageIds };
}

/** 先写 run（唯一键防重放），只有新建成功的 run 对应消息才进入产出集合。 */
async function insertPlannedRunsAndCollectMessages(
  client: DbClient,
  runs: AutomationRunPort,
  planned: PlannedRuns,
): Promise<readonly ReplayMessage[]> {
  const inserted = await runs.insertIfAbsent(client, planned.plans.map((plan) => plan.input));
  const messages = new Map<string, ReplayMessage>();
  for (const plan of planned.plans) {
    if (!inserted.has(plan.input.dedupeKey) || plan.input.status === "failed") continue;
    for (const message of plan.messages) {
      if (planned.invalidMessageIds.has(messageIdentity(message))) continue;
      messages.set(messageIdentity(message), message);
    }
  }
  return [...messages.values()];
}

/**
 * 逐条产出（inbox / wecom_app / wecom_aibot → notify.message；wecom_group → notify.group）：
 *   - 未落地渠道（email）：不产行 + warn（与投递层「非白名单 → dead」护栏配对；计入 channelSkipped）；
 *   - 应用消息寻址：recipientId = 用户 id（投递层按 users.username 解析 userid）；幂等键 = 引擎键 + ":app"
 *     后缀（同规则同实体的 inbox 行占原始键 —— outbox_events.dedupe_key 全局唯一，不加后缀两行会互相吞）；
 *   - 单聊 aibot 寻址：同应用消息（recipientId = 用户 id · 投递层按 users.username 解析 userid）；幂等键 = 引擎键
 *     + ":aibot" 后缀（与 inbox / app 行并存不撞键）；
 *   - 载荷不合规（无收件人 / 正文为空；站内信另要求标题非空）：不产行，收 invalid 由调用方按确定性失败收口（模板配置问题）；
 *   - 群播报寻址：payload.projectId 取 message.recipientId —— 不变式「wecom_group 的 recipientId = 群寻址键（一期 = projectId）」，
 *     由主体读取层保证（project.group 收件人 id = 项目 id；未绑定 → 引擎已按 recipient_missing 不产出）；
 *   - 合并 / 幂等：dedupeKey = 引擎幂等键（规则 + 实体 + 窗口），站内信 mergeKey 显式取同键 —— 通知层合并
 *     （C2-09 同期合并）不参与机内产出（引擎已按收件人合并且幂等键防重），避免跨窗口误合并；群播报逐条不合并。
 */
async function produceMessages(
  messages: readonly ReplayMessage[],
  context: ProduceContext,
): Promise<{ stats: ProduceStats; invalid: string[] }> {
  const stats: ProduceStats = { produced: 0, appProduced: 0, aibotProduced: 0, groupProduced: 0, channelSkipped: 0 };
  const invalid: string[] = [];
  for (const message of messages) {
    if (message.channel === "wecom_group") {
      const body = message.body.trim();
      const title = message.title === null ? null : message.title.trim() === "" ? null : message.title.trim();
      if (message.recipientId === null) {
        invalid.push(message.dedupeKey + "（无群收件人）");
        continue;
      }
      if (body === "") {
        invalid.push(message.dedupeKey + "（正文为空）");
        continue;
      }
      const reference = referenceOf(message.ruleCode, message.entityId);
      const payload: NotifyGroupMessagePayload = {
        projectId: message.recipientId,
        title,
        body,
        refType: reference.refType,
        refId: reference.refId,
        templateCode: templateCodeOf(context.rules, message),
      };
      await context.append({ topic: NOTIFY_GROUP_TOPIC, dedupeKey: message.dedupeKey, payload });
      stats.groupProduced += 1;
      continue;
    }
    if (message.channel === "wecom_app") {
      const title = message.title === null ? null : message.title.trim();
      const body = message.body.trim();
      if (message.recipientId === null) {
        invalid.push(message.dedupeKey + "（无收件人）");
        continue;
      }
      if (title === null || title === "" || body === "") {
        invalid.push(message.dedupeKey + "（标题 / 正文为空）");
        continue;
      }
      const reference = referenceOf(message.ruleCode, message.entityId);
      const payload: NotifyMessagePayload = {
        recipientId: message.recipientId,
        type: NOTIFICATION_TYPE_BY_RULE[message.ruleCode] ?? "reminder",
        channel: "wecom_app",
        title,
        body,
        refType: reference.refType,
        refId: reference.refId,
        templateCode: templateCodeOf(context.rules, message),
        mergeKey: message.dedupeKey,
      };
      await context.append({ topic: NOTIFY_MESSAGE_TOPIC, dedupeKey: message.dedupeKey + ":app", payload });
      stats.appProduced += 1;
      continue;
    }
    if (message.channel === "wecom_aibot") {
      const title = message.title === null ? null : message.title.trim();
      const body = message.body.trim();
      if (message.recipientId === null) {
        invalid.push(message.dedupeKey + "（无收件人）");
        continue;
      }
      if (title === null || title === "" || body === "") {
        invalid.push(message.dedupeKey + "（标题 / 正文为空）");
        continue;
      }
      const reference = referenceOf(message.ruleCode, message.entityId);
      const payload: NotifyMessagePayload = {
        recipientId: message.recipientId,
        type: NOTIFICATION_TYPE_BY_RULE[message.ruleCode] ?? "reminder",
        channel: "wecom_aibot",
        title,
        body,
        refType: reference.refType,
        refId: reference.refId,
        templateCode: templateCodeOf(context.rules, message),
        mergeKey: message.dedupeKey,
      };
      await context.append({ topic: NOTIFY_MESSAGE_TOPIC, dedupeKey: message.dedupeKey + ":aibot", payload });
      stats.aibotProduced += 1;
      continue;
    }
    if (!isDeliverableChannel(message.channel)) {
      stats.channelSkipped += 1;
      context.logger.warn("规则接线：渠道未落地（email 随 M5-04）：" + message.channel + " · " + message.dedupeKey);
      continue;
    }
    const title = message.title === null ? null : message.title.trim();
    const body = message.body.trim();
    if (message.recipientId === null) {
      invalid.push(message.dedupeKey + "（无收件人）");
      continue;
    }
    if (title === null || title === "" || body === "") {
      invalid.push(message.dedupeKey + "（标题 / 正文为空）");
      continue;
    }
    const reference = referenceOf(message.ruleCode, message.entityId);
    const payload: NotifyMessagePayload = {
      recipientId: message.recipientId,
      type: NOTIFICATION_TYPE_BY_RULE[message.ruleCode] ?? "reminder",
      channel: "inbox",
      title,
      body,
      refType: reference.refType,
      refId: reference.refId,
      templateCode: templateCodeOf(context.rules, message),
      mergeKey: message.dedupeKey,
    };
    await context.append({ topic: NOTIFY_MESSAGE_TOPIC, dedupeKey: message.dedupeKey, payload });
    stats.produced += 1;
  }
  return { stats, invalid };
}
/**
 * 事件消费者注册表（主题 = RULE_EVENT_TOPICS 全量）：
 *   - 无事件型规则订阅的主题：直接消费完成（不产消息；新增规则后自动生效，规则集动态读）；
 *   - 冷启动保护：`at - 行创建时刻 > AUTOMATION_EVENT_MAX_AGE_MS` → 引擎逐规则登记 `event_too_old`（不评估主体）；
 *   - 主体不可解析（载荷缺实体 id / 行不存在）：确定性失败 → dead（一次即弃，不重试轰炸）。
 */
export function createRuleEventConsumers(deps: AutomationWiringDeps): Map<RuleEventTopic, OutboxTopicHandler> {
  const registry = new Map<RuleEventTopic, OutboxTopicHandler>();
  for (const topic of RULE_EVENT_TOPICS) {
    registry.set(topic, {
      handle: async (row): Promise<OutboxHandleOutcome> => {
        const at = deps.now();
        const scope = "outbox#" + row.id + " · " + topic;
        return deps.transaction(async (tx) => {
          const rules = await deps.rules(tx);
          const topicRules = rules.filter((rule) => rule.trigger.kind === "event" && rule.trigger.topic === topic);
          if (topicRules.length === 0) {
            deps.logger.log("规则接线：主题无事件型规则订阅，事件消费完成（不产消息）：" + scope);
            return { outcome: "done" };
          }
          const subject = await deps.subjects.eventSubject(topic, row.payload, at, tx);
          if (subject === null) {
            deps.logger.warn("规则接线：事件主体不可解析（确定性失败转 dead）：" + scope + " · " + row.dedupeKey);
            return {
              outcome: "dead",
              error: "事件主体不可解析（载荷缺实体 id 或行不存在）：" + topic + " · " + row.dedupeKey,
            };
          }
          const evaluation = evaluateEventMessages({
            topic,
            rules: topicRules,
            subject,
            at,
            eventAt: row.createdAt,
            maxEventAgeMs: deps.env.AUTOMATION_EVENT_MAX_AGE_MS,
          });
          logSkips(deps.logger, scope, evaluation.skipped);
          const planned = planRuns({
            source: "event",
            topic,
            eventDedupeKey: row.dedupeKey,
            rules,
            details: evaluation.details,
            messages: evaluation.messages,
          });
          const messages = await insertPlannedRunsAndCollectMessages(tx, deps.runs, planned);
          const produced = await produceMessages(messages, {
            rules,
            append: (event) => deps.append(tx, event),
            logger: deps.logger,
            scope,
          });
          const invalid = [...planned.invalid, ...produced.invalid];
          if (invalid.length > 0) {
            const detail = [...new Set(invalid)].join("；");
            deps.logger.warn("规则接线：消息载荷不合规（确定性失败转 dead）：" + scope + " · " + detail);
            return { outcome: "dead", error: "消息载荷不合规（模板缺标题 / 收件人）：" + detail };
          }
          if (
            produced.stats.produced + produced.stats.appProduced + produced.stats.aibotProduced +
              produced.stats.groupProduced + produced.stats.channelSkipped > 0
          ) {
            deps.logger.log(
              "规则接线：产出 " + (produced.stats.produced + produced.stats.appProduced + produced.stats.aibotProduced) +
                " 条 notify.message / " + produced.stats.groupProduced + " 条 notify.group / 未落地渠道跳过 " +
                produced.stats.channelSkipped + " 条：" + scope,
            );
          }
          return { outcome: "done" };
        });
      },
    });
  }
  return registry;
}
/**
 * 调度生产者（kind = automation-schedule.job）：
 *   - 窗口 (windowFrom, windowTo] 由调度器（JobScheduler）给出；fireTimes 不参与 —— 触发时刻由引擎按规则 cron
 *     + 窗口基准字段重算（planWindowMessages），同窗口确定性产出；
 *   - 产出与 last_run_at 推进同一事务（context.tx）：任一条写入失败 → 整体回滚、任务按失败累计重试；
 *   - 载荷不合规（模板配置问题）→ 抛错回滚（窗口不推进；修配置后重放，幂等键兜底不重发）。
 */
export function createAutomationScheduleHandler(deps: AutomationWiringDeps): OutboxJobHandler {
  return {
    run: async (context): Promise<JobRunResult> => {
      const at = deps.now();
      const scope = context.job.kind + "#" + context.job.id;
      const allRules = (await deps.rules(context.tx)).filter((rule) => rule.trigger.kind === "schedule");
      const payloadRuleCode = typeof context.job.payload.ruleCode === "string" ? context.job.payload.ruleCode : null;
      const rules = payloadRuleCode === null ? allRules : allRules.filter((rule) => rule.code === payloadRuleCode);
      if (payloadRuleCode !== null && rules.length === 0) {
        deps.logger.warn("规则接线：调度 job 指向的规则未启用或不存在（零产出）：" + scope + " · " + payloadRuleCode);
        return { produced: 0, note: "规则 " + payloadRuleCode + " 未启用或不存在" };
      }
      const payloadRuleVersion = context.job.payload.ruleVersion;
      if (rules.length === 1 && typeof payloadRuleVersion === "number" && payloadRuleVersion !== rules[0]?.version) {
        deps.logger.warn(
          "规则接线：调度 job 规则版本与库内不一致（按库内最新版本执行）：" + scope + " · payload=" +
            payloadRuleVersion + " · db=" + rules[0]?.version,
        );
      }
      if (rules.length === 0) {
        deps.logger.log("规则接线：无启用中的调度型规则（零产出）：" + scope);
        return { produced: 0, note: "无启用中的调度型规则" };
      }
      const bundle = await deps.subjects.loadWindow({ from: context.windowFrom, to: context.windowTo }, at, context.tx);
      const shift = await deps.shift();
      const evaluation = planWindowMessages({
        jobKind: AUTOMATION_SCHEDULE_JOB_KIND,
        window: { from: context.windowFrom, to: context.windowTo },
        rules,
        subjects: bundle.subjects,
        at,
        calendar: bundle.calendar,
        shiftEnabled: shift.reminderShiftEnabled,
        shiftDirection: shift.shiftDirection,
      });
      logSkips(deps.logger, scope, evaluation.skipped);
      const planned = planRuns({
        source: "schedule",
        topic: null,
        eventDedupeKey: null,
        rules,
        details: evaluation.details,
        messages: evaluation.messages,
      });
      if (planned.invalid.length > 0) {
        throw new Error("规则接线：调度产出载荷不合规（事务回滚）：" + [...new Set(planned.invalid)].join("；"));
      }
      const messages = await insertPlannedRunsAndCollectMessages(context.tx, deps.runs, planned);
      const { stats, invalid } = await produceMessages(messages, {
        rules,
        append: (event) => deps.append(context.tx, event),
        logger: deps.logger,
        scope,
      });
      if (invalid.length > 0) {
        throw new Error("规则接线：调度产出载荷不合规（事务回滚）：" + invalid.join("；"));
      }
      deps.logger.log(
        "规则接线：窗口产出 " + (stats.produced + stats.appProduced + stats.aibotProduced) + " 条 notify.message / " +
          stats.groupProduced + " 条 notify.group / 未落地渠道跳过 " + stats.channelSkipped + " 条 / 主体 " +
          bundle.subjects.length + " 个：" + scope,
      );
      return {
        produced: stats.produced + stats.appProduced + stats.aibotProduced + stats.groupProduced,
        note: "主体 " + bundle.subjects.length + " 个 / notify.message " +
          (stats.produced + stats.appProduced + stats.aibotProduced) + " 条 / notify.group " + stats.groupProduced +
          " 条 / 未落地渠道跳过 " + stats.channelSkipped + " 条",
      };
    },
  };
}
