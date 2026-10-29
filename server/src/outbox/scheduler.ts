import { Inject, Injectable, Logger } from "@nestjs/common";
import { hostname } from "node:os";
import { OUTBOX_SCHEDULER } from "@libiaolink/contracts";
import { ClockService } from "../common/clock/clock.service.js";
import { AppConfig } from "../config/config.module.js";
import type { Env } from "../config/env.js";
import { DatabaseService } from "../db/database.service.js";
import type { DbTransaction } from "../db/db-client.js";
import { JobsStore, type JobRow } from "../db/jobs.store.js";
import { nextFireAfter, planCatchup } from "./schedule.js";

/** 注入令牌：调度生产者注册表（kind → handler）由组合根装配（SchedulerModule.forRoot）。 */
export const JOBS_REGISTRY = Symbol("JOBS_REGISTRY");

/** 单次执行的入参：窗口 (windowFrom, windowTo] 与窗口内命中触发时刻；tx = 产出与推移的同事务句柄。 */
export interface JobRunContext {
  job: JobRow;
  windowFrom: Date;
  windowTo: Date;
  fireTimes: readonly Date[];
  /** 生产者在此事务内写 outbox（appendOutboxIfAbsent）：与 last_run_at 推进原子提交。 */
  tx: DbTransaction;
}

/** 生产者结果：produced = 本轮产出（写入 outbox）条数；note = 留痕备注（可空）。 */
export interface JobRunResult {
  produced?: number;
  note?: string;
}

/**
 * 调度生产者（S7-3 · i11 / M5-02）：一个 kind 一个 handler。
 * 契约：**同一窗口必须确定性**（相同 fireTimes → 相同产出与幂等执行键）—— 崩溃重领 / 窗口重放时
 * 靠 outbox 的幂等执行键（dedupe_key 唯一约束）兜底「不重发」。
 */
export interface OutboxJobHandler {
  /**
   * 默认 true：run 与 jobs 水位推进同事务。需要外部副作用（例如发企微日报）的处理器可置 false，
   * 调度器会在 run 返回后用独立短事务推进水位；此时至少一次语义，提交失败可能重复执行。
   */
  transactional?: boolean;
  run(context: JobRunContext): Promise<JobRunResult | void>;
}

/** 单轮 tick 结果（日志与回放断言共用）。 */
export interface SchedulerTickStats {
  /** 是否取得单活锁（false = 其它实例正在调度，本 tick 跳过）。 */
  lockAcquired: boolean;
  claimed: number;
  executed: number;
  failed: number;
  unbound: number;
  produced: number;
}

/**
 * 调度器（S7-3 · i11 / M5-02 · ADR-005）：cron 领取 + 补发（last_run_at 与窗口比对）+ 单活（advisory lock）。
 *
 * 不变式：
 * - 单活：每轮 tick 先 `pg_try_advisory_lock(OUTBOX_SCHEDULER.lockName)`；拿不到直接跳过（多实例部署只跑一个）。
 * - 补发：窗口 = (last_run_at, now]；超过 OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS 的区间只记 skipped 留痕（不补发轰炸）。
 * - 水位不越过：单轮最多处理 OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK 个窗口（默认 20），触顶时 last_run_at 停在
 *   本轮最后处理的窗口（resumeFrom）且 run_at = now —— 剩余窗口下一轮顺延，不整段跳过。
 * - 原子：产出（outbox 行）与 last_run_at 推进在同一事务；崩溃回滚后重领重放，由幂等执行键兜底不重发。
 * - 无生产者注册的 kind：只存不跑（排障态），窗口不推进、不占重领窗口（清 locked_at）。
 */
@Injectable()
export class JobScheduler {
  private readonly logger = new Logger(JobScheduler.name);
  private readonly workerId: string;
  private readonly unboundWarned = new Set<number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly store: JobsStore,
    @Inject(JOBS_REGISTRY) private readonly registry: ReadonlyMap<string, OutboxJobHandler>,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {
    this.workerId = resolveWorkerId(config.env);
  }

  async tickOnce(): Promise<SchedulerTickStats> {
    const stats: SchedulerTickStats = {
      lockAcquired: false,
      claimed: 0,
      executed: 0,
      failed: 0,
      unbound: 0,
      produced: 0,
    };
    // 注册表为空 = 「只存不跑」排障态：不触库、不占锁（与 OutboxDispatcher 同口径）。
    if (this.registry.size === 0) {
      return stats;
    }
    const lock = await this.store.tryAdvisoryLock(OUTBOX_SCHEDULER.lockName);
    if (lock === null) {
      this.logger.warn("调度 tick 跳过：未取得单活锁（" + OUTBOX_SCHEDULER.lockName + "）");
      return stats;
    }
    stats.lockAcquired = true;
    try {
      const env = this.config.env;
      const due = await this.store.claimDue({
        limit: env.OUTBOX_SCHEDULER_BATCH_LIMIT,
        staleAfterMs: env.OUTBOX_STALE_MS,
        workerId: this.workerId,
      });
      stats.claimed = due.length;
      for (const job of due) {
        await this.runJob(job, stats);
      }
    } finally {
      await lock.release();
    }
    return stats;
  }

  private async runJob(job: JobRow, stats: SchedulerTickStats): Promise<void> {
    const handler = this.registry.get(job.kind);
    if (handler === undefined) {
      stats.unbound += 1;
      if (!this.unboundWarned.has(job.id)) {
        this.unboundWarned.add(job.id);
        this.logger.warn("调度任务无生产者注册（只存不跑，窗口不推进）：kind=" + job.kind + "#" + job.id);
      }
      await this.store.releaseClaim(job.id);
      return;
    }

    const now = this.clock.now();
    const plan =
      job.cron === null
        ? {
            windowFrom: job.lastRunAt ?? new Date(job.runAt.getTime() - 1),
            windowTo: now,
            fireTimes: job.runAt.getTime() <= now.getTime() ? [job.runAt] : [],
            pendingMore: false,
            resumeFrom: null as Date | null,
            skippedFrom: null as Date | null,
            skippedTo: null as Date | null,
          }
        : planCatchup({
            cron: job.cron,
            after: job.lastRunAt ?? new Date(job.runAt.getTime() - 1),
            now,
            catchupMaxDays: this.config.env.OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS,
            maxWindows: this.config.env.OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK,
          });

    const nextRunAt = job.cron === null ? null : nextFireAfter(job.cron, now);
    if (job.cron !== null && nextRunAt === null) {
      await this.failJob(job, plan, stats, new Error("cron 无下一触发时刻（扫描上限内无命中）：" + job.cron));
      return;
    }

    try {
      // 外部副作用处理器不占长事务：先执行，再用短事务推进 jobs 水位；其余处理器保持原子提交。
      let outcome: JobRunResult;
      if (handler.transactional === false) {
        outcome =
          (await handler.run({
            job,
            windowFrom: plan.windowFrom,
            windowTo: plan.windowTo,
            fireTimes: plan.fireTimes,
            tx: this.database.db as unknown as DbTransaction,
          })) ?? {};
        await this.database.db.transaction((tx) => this.finishJobRun(tx, job, plan, nextRunAt, outcome));
      } else {
        outcome = await this.database.db.transaction(async (tx) => {
          const result =
            (await handler.run({
              job,
              windowFrom: plan.windowFrom,
              windowTo: plan.windowTo,
              fireTimes: plan.fireTimes,
              tx,
            })) ?? {};
          await this.finishJobRun(tx, job, plan, nextRunAt, result);
          return result;
        });
      }
      stats.executed += 1;
      stats.produced += outcome.produced ?? 0;
      if (plan.pendingMore) {
        this.logger.warn(
          "调度任务窗口触顶（每轮上限 OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK=" +
            this.config.env.OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK +
            "，剩余窗口下一轮顺延）：kind=" + job.kind + "#" + job.id +
            "，本轮窗口至 " + (plan.resumeFrom === null ? "（无）" : plan.resumeFrom.toISOString()),
        );
      }
      if (plan.skippedFrom !== null) {
        this.logger.warn("调度任务跳过超跨度窗口：kind=" + job.kind + "#" + job.id);
      }
    } catch (error) {
      await this.failJob(job, plan, stats, error);
    }
  }

  private async finishJobRun(
    tx: DbTransaction,
    job: JobRow,
    plan: {
      windowFrom: Date;
      windowTo: Date;
      fireTimes: readonly Date[];
      pendingMore: boolean;
      resumeFrom: Date | null;
      skippedFrom: Date | null;
      skippedTo: Date | null;
    },
    nextRunAt: Date | null,
    result: JobRunResult,
  ): Promise<void> {
    const now = this.clock.now();
    const resumeFrom = plan.pendingMore ? plan.resumeFrom : null;
    await this.store.finishRun(tx, {
      jobId: job.id,
      kind: job.kind,
      lastRunAt: resumeFrom ?? now,
      nextRunAt: resumeFrom === null ? nextRunAt : now,
      windowFrom: plan.windowFrom,
      windowTo: resumeFrom ?? plan.windowTo,
      fireCount: plan.fireTimes.length,
      produced: result.produced ?? 0,
      note:
        resumeFrom === null
          ? result.note ?? null
          : "窗口触顶（OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK=" +
            this.config.env.OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK +
            "），剩余窗口下一轮顺延" +
            (result.note === undefined || result.note === null || result.note === "" ? "" : "；" + result.note),
    });
    if (plan.skippedFrom !== null && plan.skippedTo !== null) {
      await this.store.recordSkipped(tx, {
        jobId: job.id,
        kind: job.kind,
        windowFrom: plan.skippedFrom,
        windowTo: plan.skippedTo,
        note:
          "超出补发跨度上限（OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS=" +
          this.config.env.OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS +
          " 天），只记留痕不补发",
      });
    }
  }

  private async failJob(
    job: JobRow,
    plan: { windowFrom: Date; windowTo: Date },
    stats: SchedulerTickStats,
    error: unknown,
  ): Promise<void> {
    const message = messageOf(error);
    stats.failed += 1;
    this.logger.error(
      "调度任务失败（kind=" + job.kind + "#" + job.id + "，attempts=" + (job.attempts + 1) + "）：" + message,
    );
    await this.store.markFailure({
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts + 1,
      maxAttempts: this.config.env.OUTBOX_SCHEDULER_MAX_ATTEMPTS,
      error: message,
      windowFrom: plan.windowFrom,
      windowTo: plan.windowTo,
    });
  }
}

function resolveWorkerId(env: Env): string {
  return env.WORKER_ID !== "" ? env.WORKER_ID : hostname() + ":" + process.pid;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
