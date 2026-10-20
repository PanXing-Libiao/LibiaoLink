import { Logger, Module, type DynamicModule } from "@nestjs/common";
import type { OutboxTopic } from "@libiaolink/contracts";
import { ClockService } from "../common/clock/clock.service.js";
import type { Env } from "../config/env.js";
import { DatabaseService } from "../db/database.service.js";
import { JobsStore } from "../db/jobs.store.js";
import { appendOutboxIfAbsent } from "../db/outbox.js";
import { OutboxStore } from "../db/outbox.store.js";
import {
  AUTOMATION_SCHEDULE_JOB_KIND,
  AutomationRuleRepository,
  AutomationRunRepository,
} from "../modules/automation/index.js";
import { CalendarModule, CalendarService } from "../modules/calendar/index.js";
import { FileModule, PREVIEW_JOB_TOPIC, PreviewService } from "../modules/file/index.js";
import {
  channelOfNotifyPayload,
  NOTIFY_GROUP_TOPIC,
  NOTIFY_MESSAGE_TOPIC,
  NotifyAppService,
  NotifyDmService,
  NotifyGroupService,
  NotifyModule,
  NotifyService,
  WecomAibotClient,
} from "../modules/notify/index.js";
import { LogOutboxAlertSink, OUTBOX_ALERT_SINK } from "./alert.js";
import { AutomationSubjectReader } from "./automation-subjects.js";
import { createAutomationScheduleHandler, createRuleEventConsumers, type AutomationWiringDeps } from "./automation-wiring.js";
import { OUTBOX_POLICIES, OUTBOX_REGISTRY, OutboxDispatcher } from "./dispatcher.js";
import type { OutboxTopicHandler } from "./handler.js";
import { resolveOutboxPolicies } from "./policy.js";
import { OutboxAlertProbe } from "./probe.js";
import { OutboxRetention } from "./retention.js";
import { JOBS_REGISTRY, JobScheduler, type OutboxJobHandler } from "./scheduler.js";
import { registerConsumerTopic, registerDrainOnlyTopics } from "./topic-catalog.js";
import { WecomAlertSink } from "./wecom-alert.sink.js";

/** 规则接线日志（Nest Logger：产出 / 跳过 / 渠道留痕与 worker 日志同管道）。 */
const wiringLogger = new Logger("AutomationWiring");

/** 消费注册表日志（群通道门控留痕：未配置 = 「只存不投」明确可见）。 */
const registryLogger = new Logger("OutboxRegistry");

/**
 * Outbox worker 运行时（S7-1）：dispatcher（领取 / 消费 / 重试 / dead）+ 告警探针 + done 行保留期清理；
 * S7-3 增补调度器（jobs 表：cron 领取 / last_run_at 补发 / 单活 advisory lock · JobScheduler）；
 * S7-4 增补规则接线（AUTOMATION_WIRING_ENABLED）：RULE_EVENT_TOPICS 事件消费 + automation-schedule.job 生产者
 * （automation 引擎 → notify.message 产出；未落地渠道不产行，见 automation-wiring.ts）。
 * 只装配在 worker 进程（api 不消费）。消费 / 生产注册表都在此组装（**加项即可**，dispatcher / scheduler 不感知业务）：
 * 事件消费当前有 preview.job（受 PREVIEW_JOB_ENABLED 开关）、notify.message（S7-4 站内信投递，受
 * NOTIFY_DELIVERY_ENABLED 开关）与规则事件主题（受 AUTOMATION_WIRING_ENABLED 开关）；
 * 其余无业务订阅的主题由 `topic-catalog.ts` 全量登记为 drain-only（领取后 done，不补发历史事件）；
 * 调度生产者当前有 automation-schedule.job（同上开关；关闭 = 「只存不跑」排障态）。
 */
@Module({})
export class OutboxModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: OutboxModule,
      imports: [FileModule, NotifyModule, CalendarModule],
      providers: [
        OutboxStore,
        JobsStore,
        AutomationRuleRepository,
        AutomationRunRepository,
        ClockService,
        AutomationSubjectReader,
        {
          provide: OUTBOX_ALERT_SINK,
          useFactory: (aibot: WecomAibotClient) => {
            const fallback = new LogOutboxAlertSink();
            // 告警群出口（M5-03-3 · B2 定案）：chatid + 智能机器人凭据齐备才启用；否则保持结构化日志。
            if (env.OUTBOX_ALERT_WECOM_CHATID === "" || env.WECOM_BOT_ID === "" || env.WECOM_BOT_SECRET === "") {
              return fallback;
            }
            return new WecomAlertSink(aibot, env.OUTBOX_ALERT_WECOM_CHATID, fallback);
          },
          inject: [WecomAibotClient],
        },
        { provide: OUTBOX_POLICIES, useFactory: () => resolveOutboxPolicies(env) },
        {
          provide: OUTBOX_REGISTRY,
          useFactory: (
            previews: PreviewService,
            notify: NotifyService,
            groupNotify: NotifyGroupService,
            appNotify: NotifyAppService,
            dmNotify: NotifyDmService,
            subjects: AutomationSubjectReader,
            clock: ClockService,
            calendar: CalendarService,
            database: DatabaseService,
            rules: AutomationRuleRepository,
            runs: AutomationRunRepository,
          ) => {
            const registry = buildRegistry(env, previews, notify, groupNotify, appNotify, dmNotify);
            if (env.AUTOMATION_WIRING_ENABLED === "true") {
              const deps = automationWiringDeps(env, subjects, clock, calendar, database, rules, runs);
              for (const [topic, handler] of createRuleEventConsumers(deps)) {
                registerConsumerTopic(registry, topic, handler);
              }
            }
            return registry;
          },
          inject: [
            PreviewService,
            NotifyService,
            NotifyGroupService,
            NotifyAppService,
            NotifyDmService,
            AutomationSubjectReader,
            ClockService,
            CalendarService,
            DatabaseService,
            AutomationRuleRepository,
            AutomationRunRepository,
          ],
        },
        {
          provide: JOBS_REGISTRY,
          useFactory: (
            subjects: AutomationSubjectReader,
            clock: ClockService,
            calendar: CalendarService,
            database: DatabaseService,
            rules: AutomationRuleRepository,
            runs: AutomationRunRepository,
          ) => buildJobsRegistry(env, subjects, clock, calendar, database, rules, runs),
          inject: [
            AutomationSubjectReader,
            ClockService,
            CalendarService,
            DatabaseService,
            AutomationRuleRepository,
            AutomationRunRepository,
          ],
        },
        OutboxAlertProbe,
        OutboxRetention,
        OutboxDispatcher,
        JobScheduler,
      ],
      exports: [OutboxDispatcher, OutboxAlertProbe, OutboxRetention, JobScheduler],
    };
  }
}

/**
 * 注册表组装（消费侧唯一清单）：PREVIEW_JOB_ENABLED=false 时预览不入表、NOTIFY_DELIVERY_ENABLED=false 时
 * 站内信不入表（只投递不消费的排障态）；其余契约主题无条件落 drain-only，保证不会因漏登记永久积压。
 * notify.message 的消费只做「落行 + 合并 / 投递 / 排期」分类；
 * 延迟投递（免打扰 / 每日上限）由 NotifyService.flushDue 的独立循环排空，不占 outbox 重试。
 * 导出（M5-03-5-4）：接线回放 / 门禁直接驱动「按载荷 channel 分流」这一生产装配点（先例 =
 * automation-wiring 的 createRuleEventConsumers / createAutomationScheduleHandler）。
 */
export function buildRegistry(
  env: Env,
  previews: PreviewService,
  notify: NotifyService,
  groupNotify: NotifyGroupService,
  appNotify: NotifyAppService,
  dmNotify: NotifyDmService,
): Map<OutboxTopic, OutboxTopicHandler> {
  const registry = new Map<OutboxTopic, OutboxTopicHandler>();
  if (env.PREVIEW_JOB_ENABLED === "true") {
    registerConsumerTopic(registry, PREVIEW_JOB_TOPIC, {
      handle: (row) => previews.consume(row),
      onDead: (row, error) => previews.onDead(row, error),
    });
  }
  if (env.NOTIFY_DELIVERY_ENABLED === "true") {
    registerConsumerTopic(registry, NOTIFY_MESSAGE_TOPIC, {
      // 渠道分流（M5-03-3 / M5-03-5-4）：wecom_app → 应用消息消费（NotifyAppService）；wecom_aibot → 单聊 aibot
      // 消费（NotifyDmService；长连接未就绪按 retry 收敛 —— 未配置 ≠ 不领取，bounded by outbox 重试上限 →
      // dead + 告警，与群通道「未配置 = 只存不投」的差异为单聊面定案，见 M5-03-5 执行计划 §3.4）；其余
      // （inbox / 未落地 email）→ 站内信消费器（后者对非 inbox 渠道按确定性失败收口 —— 投递层护栏）。
      handle: (row) => {
        const channel = channelOfNotifyPayload(row.payload);
        if (channel === "wecom_app") return appNotify.consume(row);
        if (channel === "wecom_aibot") return dmNotify.consume(row);
        return notify.consume(row);
      },
    });
    // 群通道（M5-03-2 接线段）：凭据齐备才注册消费 —— 未配置时「只存不投」（notify.group 行不领取，
    // 不因客户端未就绪空转重试）；配置后由 worker 启动流程 start() 长连接（entry/worker.ts）。
    if (env.WECOM_BOT_ID !== "" && env.WECOM_BOT_SECRET !== "") {
      registerConsumerTopic(registry, NOTIFY_GROUP_TOPIC, {
        handle: (row) => groupNotify.consume(row),
      });
    } else {
      registryLogger.warn("WECOM_BOT_ID / WECOM_BOT_SECRET 未配置：群通道未启用，notify.group 只存不投");
    }
  }
  registerDrainOnlyTopics(registry);
  return registry;
}

/**
 * 调度生产者注册表组装：kind → handler（与 OUTBOX_REGISTRY 同形，加项即可）。
 * AUTOMATION_WIRING_ENABLED=false → 空表 = 「只存不跑」排障态（jobs 行不领取、窗口不推进）。
 */
function buildJobsRegistry(
  env: Env,
  subjects: AutomationSubjectReader,
  clock: ClockService,
  calendar: CalendarService,
  database: DatabaseService,
  rules: AutomationRuleRepository,
  runs: AutomationRunRepository,
): Map<string, OutboxJobHandler> {
  const registry = new Map<string, OutboxJobHandler>();
  if (env.AUTOMATION_WIRING_ENABLED === "true") {
    registry.set(
      AUTOMATION_SCHEDULE_JOB_KIND,
      createAutomationScheduleHandler(automationWiringDeps(env, subjects, clock, calendar, database, rules, runs)),
    );
  }
  return registry;
}

/** 接线装配依赖：主体读取（读库）+ 引擎规则来源 + 产出落点（appendOutboxIfAbsent）+ 时钟 / 顺延设置。 */
function automationWiringDeps(
  env: Env,
  subjects: AutomationSubjectReader,
  clock: ClockService,
  calendar: CalendarService,
  database: DatabaseService,
  rules: AutomationRuleRepository,
  runs: AutomationRunRepository,
): AutomationWiringDeps {
  return {
    env,
    subjects,
    append: appendOutboxIfAbsent,
    db: database.db,
    rules: (client) =>
      rules.listEnabledRules(client, {
        forceEnableCodes: env.AUTOMATION_R06_ENABLED === "true" ? ["R06"] : [],
      }),
    runs,
    transaction: (work) => database.db.transaction(work),
    now: () => clock.now(),
    shift: () => calendar.getSettings(),
    logger: wiringLogger,
  };
}
