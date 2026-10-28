import { Inject, Injectable, Logger } from "@nestjs/common";
import { hostname } from "node:os";
import type { OutboxTopic } from "@libiaolink/contracts";
import { ClockService } from "../common/clock/clock.service.js";
import { AppConfig } from "../config/config.module.js";
import type { Env } from "../config/env.js";
import { OutboxStore, type OutboxClaimedRow } from "../db/outbox.store.js";
import { OUTBOX_ALERT_SINK, type OutboxAlertSink } from "./alert.js";
import type { OutboxDeadAlertOverride, OutboxHandleOutcome, OutboxTopicHandler } from "./handler.js";
import { backoffDelayMs, defaultTopicPolicy, type OutboxTopicPolicy } from "./policy.js";

/** 注入令牌：消费者注册表（topic → handler）由组合根装配（OutboxModule.forRoot）。 */
export const OUTBOX_REGISTRY = Symbol("OUTBOX_REGISTRY");
/** 注入令牌：主题 → 重试策略。 */
export const OUTBOX_POLICIES = Symbol("OUTBOX_POLICIES");

/** 单轮领取结果（worker 循环日志与测试断言共用）。 */
export interface OutboxDrainStats {
  claimed: number;
  done: number;
  retried: number;
  /** 延期重排（deferred）：回 pending 至指定时刻，不消耗重试次数（attempts 不累计）。 */
  deferred: number;
  dead: number;
}

/**
 * Outbox 分派器（S7-1 · i5 收口）：按注册主题**独立成批**领取，逐条交给 handler，
 * 统一收敛状态（done / retry 退避 / dead + 告警）。
 *
 * 不变式：
 * - 未注册主题不领取；注册表为空则不触库（「只投递不消费」的排障态 = 注册表为空）。
 * - handler 不直接回写 outbox；异常 / 非法返回一律按「可重试」收敛，绝不打断轮询（其余行、其余主题照常）。
 * - 串行处理（同实例并发恒为 1）：预览单条最长 90s，给转换沙箱留人工排障余量；
 *   要提速先按 ADR-013 复核 OUTBOX_BATCH_LIMIT 与沙箱并发，再把这里改成小并发。
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly workerId: string;

  constructor(
    private readonly store: OutboxStore,
    @Inject(OUTBOX_REGISTRY) private readonly registry: ReadonlyMap<OutboxTopic, OutboxTopicHandler>,
    @Inject(OUTBOX_POLICIES) private readonly policies: ReadonlyMap<OutboxTopic, OutboxTopicPolicy>,
    @Inject(OUTBOX_ALERT_SINK) private readonly alerts: OutboxAlertSink,
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {
    this.workerId = resolveWorkerId(config.env);
  }

  async drainOnce(): Promise<OutboxDrainStats> {
    const stats: OutboxDrainStats = { claimed: 0, done: 0, retried: 0, deferred: 0, dead: 0 };
    const topics = [...this.registry.keys()].sort();
    if (topics.length === 0) {
      return stats;
    }
    for (const topic of topics) {
      const handler = this.registry.get(topic);
      if (handler === undefined) {
        continue;
      }
      const policy = this.policies.get(topic) ?? defaultTopicPolicy(this.config.env);
      let rows: OutboxClaimedRow[];
      try {
        rows = await this.store.claim({
          topics: [topic],
          limit: policy.batchLimit,
          staleAfterMs: this.config.env.OUTBOX_STALE_MS,
          workerId: this.workerId,
        });
      } catch (error) {
        this.logger.error("outbox 领取失败（" + topic + "）：" + messageOf(error));
        continue;
      }
      stats.claimed += rows.length;
      for (const row of rows) {
        await this.handleRow(topic, handler, policy, row, stats);
      }
    }
    return stats;
  }

  /** 单条收敛：handler 只管业务与分类；回写与告警都在这里（失败路径永不外抛）。 */
  private async handleRow(
    topic: OutboxTopic,
    handler: OutboxTopicHandler,
    policy: OutboxTopicPolicy,
    row: OutboxClaimedRow,
    stats: OutboxDrainStats,
  ): Promise<void> {
    let outcome: OutboxHandleOutcome;
    try {
      outcome = await handler.handle(row);
    } catch (error) {
      const message = messageOf(error);
      this.logger.error("outbox 消费异常（按可重试收敛）：" + topic + "#" + row.id + " —— " + message);
      outcome = { outcome: "retry", error: message };
    }
    if (outcome === null || typeof outcome !== "object" || typeof (outcome as { outcome?: unknown }).outcome !== "string") {
      this.logger.error("outbox 处理器返回非法结果（按可重试收敛）：" + topic + "#" + row.id);
      outcome = { outcome: "retry", error: "处理器返回非法结果" };
    }

    if (outcome.outcome === "done") {
      await this.store.markDone(row.id);
      stats.done += 1;
      return;
    }

    const error = typeof outcome.error === "string" && outcome.error !== "" ? outcome.error : "(未附原因)";
    if (outcome.outcome === "deferred") {
      // 延期重排（rate_limited 一类）：attempts 原值回写 = 不消耗重试预算；availableAt 非法时兜底 now+60s。
      const availableAt =
        outcome.availableAt instanceof Date && Number.isFinite(outcome.availableAt.getTime())
          ? outcome.availableAt
          : new Date(this.clock.now().getTime() + 60_000);
      await this.store.markRetry(row.id, { attempts: row.attempts, availableAt, error });
      stats.deferred += 1;
      this.logger.warn(
        "outbox 延期重排（不消耗重试次数，至 " + availableAt.toISOString() + "）：" + topic + "#" + row.id + " —— " + error,
      );
      return;
    }
    const attempts = row.attempts + 1;
    if (outcome.outcome === "dead") {
      const deadAlert = outcome.deadAlert === "digest" ? "digest" : "immediate";
      await this.declareDead(topic, handler, policy, row, attempts, error, deadAlert, stats, outcome.alert);
      return;
    }
    if (attempts < policy.maxAttempts) {
      const delayMs = backoffDelayMs(policy, attempts);
      await this.store.markRetry(row.id, {
        attempts,
        availableAt: new Date(this.clock.now().getTime() + delayMs),
        error,
      });
      stats.retried += 1;
      this.logger.warn(
        "outbox 重试（第 " +
          attempts +
          "/" +
          policy.maxAttempts +
          " 次，" +
          Math.round(delayMs / 1000) +
          "s 后）：" +
          topic +
          "#" +
          row.id +
          "（" +
          row.dedupeKey +
          "）—— " +
          error,
      );
      return;
    }
    await this.declareDead(topic, handler, policy, row, attempts, error, "immediate", stats);
  }

  /**
   * 终态：onDead 留痕（可选，失败只记日志）→ 落 dead → 按 handler 的处置口径发即时告警或只记日志。
   * 确定性拒绝（deadAlert=digest）仍落 dead / 触发 onDead，但只进结构化日志与日报，不推企微即时告警。
   */
  private async declareDead(
    topic: OutboxTopic,
    handler: OutboxTopicHandler,
    policy: OutboxTopicPolicy,
    row: OutboxClaimedRow,
    attempts: number,
    error: string,
    deadAlert: "immediate" | "digest",
    stats: OutboxDrainStats,
    alertOverride?: OutboxDeadAlertOverride,
  ): Promise<void> {
    if (handler.onDead !== undefined) {
      try {
        await handler.onDead(row, error);
      } catch (hookError) {
        this.logger.error("outbox onDead 留痕失败（继续转 dead）：" + topic + "#" + row.id + " —— " + messageOf(hookError));
      }
    }
    await this.store.markDead(row.id, { attempts, error });
    stats.dead += 1;
    if (deadAlert === "digest") {
      this.logger.warn(
        JSON.stringify({
          event: "outbox.dead.digest_only",
          topic,
          outboxEventId: row.id,
          dedupeKey: row.dedupeKey,
          attempts,
          maxAttempts: policy.maxAttempts,
          lastError: error,
        }),
      );
      return;
    }
    const detail = alertOverride?.detail ?? {
      topic,
      id: row.id,
      dedupeKey: row.dedupeKey,
      attempts,
      maxAttempts: policy.maxAttempts,
    };
    this.alerts.emit({
      code: "outbox.dead",
      level: "error",
      message: alertOverride?.message ?? "outbox 死信：" + topic + "#" + row.id + "（" + row.dedupeKey + "）—— " + error,
      impact:
        alertOverride === undefined
          ? "该消息不会继续重试；关联通知、预览或规则动作可能未完成。"
          : (alertOverride.impact ?? undefined),
      action:
        alertOverride?.action ??
        "查看 worker 日志与 outbox_events#" +
          row.id +
          " 的 last_error；修复根因后重置为 pending 重放，永久错误则确认忽略并留档。",
      detail,
    });
  }
}

/** 领取者标识：WORKER_ID 优先；缺省 host:pid（进 outbox_events.locked_by）。 */
function resolveWorkerId(env: Env): string {
  return env.WORKER_ID !== "" ? env.WORKER_ID : hostname() + ":" + process.pid;
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 500 ? raw.slice(0, 500) : raw;
}
