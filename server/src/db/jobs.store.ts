import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import type { DbClient } from "./db-client.js";
import { jobRuns, jobs } from "./schema/platform.js";

/** 领取到的任务行（调度器消费用：只带执行需要的字段）。 */
export interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  /** cron 五段（null = 一次性任务）。 */
  cron: string | null;
  runAt: Date;
  lastRunAt: Date | null;
  status: string;
  attempts: number;
  lastError: string | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  /** 一规则一 job 的幂等键；历史 / 非规则 job = null。 */
  dedupeKey: string | null;
}

export interface ClaimDueJobsInput {
  limit: number;
  /** 超过该时长仍持锁视为崩溃遗留、可重领（毫秒）—— 与 outbox 同口径（OUTBOX_STALE_MS）。 */
  staleAfterMs: number;
  workerId: string;
}

/** 单活锁句柄（S7-3）：release 解锁并归还连接；进程崩溃时随会话自动释放。 */
export interface AdvisoryLock {
  release(): Promise<void>;
}

export interface FinishJobRunInput {
  jobId: number;
  kind: string;
  /** 本轮执行时刻（写 last_run_at；窗口终点 = 它）。 */
  lastRunAt: Date;
  /** 下一触发时刻；一次性任务传 null（置 done）。 */
  nextRunAt: Date | null;
  windowFrom: Date;
  windowTo: Date;
  fireCount: number;
  produced: number;
  note: string | null;
}

export interface RecordSkippedInput {
  jobId: number;
  kind: string;
  windowFrom: Date;
  windowTo: Date;
  note: string | null;
}

export interface MarkJobFailureInput {
  jobId: number;
  kind: string;
  /** 本次失败后的累计尝试次数（含本次）。 */
  attempts: number;
  maxAttempts: number;
  error: string;
  windowFrom: Date;
  windowTo: Date;
}

export interface AutomationScheduleJobInput {
  ruleCode: string;
  ruleVersion: number;
  cron: string;
  enabled: boolean;
  /** 注入时刻（测试确定性）；缺省 = 当前时刻。 */
  now?: Date;
}

export type AutomationScheduleJobOutcome = "inserted" | "reactivated" | "updated" | "disabled" | "unchanged";

export interface FixedCronJobInput {
  kind: string;
  dedupeKey: string;
  cron: string;
  /** 首次注册 / 失败或 done 行复活后的到期时刻。正常 pending 行不重置水位。 */
  runAt: Date;
  payload?: Record<string, unknown>;
}

export type FixedCronJobOutcome = "inserted" | "reactivated" | "updated" | "unchanged";

/**
 * 调度任务存取（S7-3 · i11 / M5-02）：到期领取（`for update skip locked` + 崩溃遗留按 locked_at 重领）、
 * 成功推进（last_run_at / run_at，与生产者产出同事务）、失败累计、运行留痕（job_runs）。
 *
 * 状态口径：`pending`（待执行；cron 任务恒留 pending，一次性任务执行后 `done`）→ 失败累计到顶 `failed`（人工复位后继续）。
 * `locked_at` 是「本次执行中」标记：成功 / 失败 / 无生产者都会清掉（保留 `locked_by` 作最后一次领取者排障），
 * 只有进程崩溃才会留下 locked_at —— 超过 staleAfterMs 由后续实例重领（窗口重放由幂等执行键兜底不重发）。
 */
@Injectable()
export class JobsStore {
  constructor(private readonly database: DatabaseService) {}

  /** 尝试取得单活锁（非阻塞）：拿不到 = 其它实例正在调度，本 tick 跳过。 */
  async tryAdvisoryLock(lockName: string): Promise<AdvisoryLock | null> {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked",
        [lockName],
      );
      if (result.rows[0]?.locked !== true) {
        client.release();
        return null;
      }
      return {
        release: async (): Promise<void> => {
          try {
            await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /** 领取到期任务：单条语句原子领取（与 outbox_events 同口径），崩溃遗留按 locked_at 超阈值重领。 */
  async claimDue(input: ClaimDueJobsInput): Promise<JobRow[]> {
    if (input.limit <= 0) return [];
    const result = await this.database.db.execute(sql`
      with claimed as (
        select id
          from jobs
         where status = 'pending'
           and run_at <= now()
           and (locked_at is null
                or locked_at < now() - ${input.staleAfterMs}::int * interval '1 millisecond')
         order by run_at, id
         limit ${input.limit}
         for update skip locked
      )
      update jobs as j
         set locked_by = ${input.workerId}, locked_at = now(), updated_at = now()
        from claimed
       where j.id = claimed.id
      returning j.id, j.kind, j.payload, j.cron, j.run_at, j.last_run_at, j.status, j.attempts, j.last_error, j.locked_by, j.locked_at, j.dedupe_key
    `);
    return (result.rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      cron: row.cron === null || row.cron === undefined ? null : String(row.cron),
      runAt: new Date(row.run_at as string | number | Date),
      lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : new Date(row.last_run_at as string | number | Date),
      status: String(row.status),
      attempts: Number(row.attempts),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      lockedBy: row.locked_by === null || row.locked_by === undefined ? null : String(row.locked_by),
      lockedAt: row.locked_at === null || row.locked_at === undefined ? null : new Date(row.locked_at as string | number | Date),
      dedupeKey: row.dedupe_key === null || row.dedupe_key === undefined ? null : String(row.dedupe_key),
    }));
  }

  /** 无生产者注册（排障态「只存不跑」）：清 locked_at 让注册表补齐后立刻可跑；窗口不推进。 */
  async releaseClaim(jobId: number): Promise<void> {
    await this.database.db
      .update(jobs)
      .set({ lockedAt: null, updatedAt: sql`now()` })
      .where(eq(jobs.id, jobId));
  }

  /** 成功推进：写 last_run_at / 下一触发时刻（或 done）+ 运行留痕 —— 与生产者产出同事务（调用方传入 tx）。 */
  async finishRun(client: DbClient, input: FinishJobRunInput): Promise<void> {
    await client
      .update(jobs)
      .set({
        lastRunAt: input.lastRunAt,
        ...(input.nextRunAt === null ? { status: "done" } : { runAt: input.nextRunAt }),
        attempts: 0,
        lastError: null,
        lockedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(jobs.id, input.jobId));
    await client.insert(jobRuns).values({
      jobId: input.jobId,
      kind: input.kind,
      status: "executed",
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      fireCount: input.fireCount,
      produced: input.produced,
      note: input.note,
    });
  }

  /** 超补发跨度的区间留痕（skipped）：只记不补（避免停机数周后补发轰炸）。 */
  async recordSkipped(client: DbClient, input: RecordSkippedInput): Promise<void> {
    await client.insert(jobRuns).values({
      jobId: input.jobId,
      kind: input.kind,
      status: "skipped",
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      fireCount: 0,
      produced: 0,
      note: input.note,
    });
  }

  /** 失败收敛：attempts 累计；到顶置 failed（人工复位后继续），否则下个 tick 重试。 */
  async markFailure(input: MarkJobFailureInput): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({
          attempts: input.attempts,
          lastError: input.error,
          status: input.attempts >= input.maxAttempts ? "failed" : "pending",
          lockedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, input.jobId));
      await tx.insert(jobRuns).values({
        jobId: input.jobId,
        kind: input.kind,
        status: "failed",
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        fireCount: 0,
        produced: 0,
        note: input.error,
      });
    });
  }

  /**
   * 系统固定 cron 任务的幂等注册（管理员日报等）：不依赖手工 seed，worker 每次启动可安全重跑。
   * - 新行 = pending；已有 pending 行只校正 kind / cron / payload，不重置 run_at / last_run_at；
   * - failed / done 行复活为 pending（日报必须保留下一天执行资格），并清失败计数与锁；
   * - done 行复活时把水位放在本次 run_at 前 1ms，确保当天窗口可被枚举。
   */
  async ensureFixedCronJob(input: FixedCronJobInput): Promise<FixedCronJobOutcome> {
    return this.database.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(jobs)
        .values({
          kind: input.kind,
          payload: input.payload ?? {},
          cron: input.cron,
          runAt: input.runAt,
          status: "pending",
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoNothing({ target: jobs.dedupeKey })
        .returning({ id: jobs.id });
      if (inserted[0] !== undefined) {
        return "inserted";
      }

      const existing = (
        await tx
          .select({
            id: jobs.id,
            kind: jobs.kind,
            payload: jobs.payload,
            cron: jobs.cron,
            status: jobs.status,
            lastRunAt: jobs.lastRunAt,
          })
          .from(jobs)
          .where(eq(jobs.dedupeKey, input.dedupeKey))
          .limit(1)
      )[0];
      if (existing === undefined) {
        throw new Error("固定 cron 任务冲突后未读回既有行：" + input.dedupeKey);
      }

      const restore = existing.status !== "pending";
      const payloadUnchanged = JSON.stringify(existing.payload) === JSON.stringify(input.payload ?? {});
      const metadataUnchanged = existing.kind === input.kind && existing.cron === input.cron && payloadUnchanged;
      if (!restore && metadataUnchanged) {
        return "unchanged";
      }

      await tx
        .update(jobs)
        .set({
          kind: input.kind,
          payload: input.payload ?? {},
          cron: input.cron,
          updatedAt: sql`now()`,
          ...(restore
            ? {
                status: "pending",
                runAt: input.runAt,
                lastRunAt:
                  existing.status === "done" ? new Date(input.runAt.getTime() - 1) : existing.lastRunAt,
                attempts: 0,
                lastError: null,
                lockedAt: null,
              }
            : {}),
        })
        .where(eq(jobs.id, existing.id));
      return restore ? "reactivated" : "updated";
    });
  }

  /**
   * 一规则一 job 的 reconcile（M5-06-1A）：
   * - 新行：启用 = pending，停用 = done；run_at / last_run_at 均取 now，避免补发启用前窗口；
   * - done + enabled = 重新启用：pending、run_at / last_run_at = now、失败计数清零；
   * - pending / failed + enabled = 仅刷新 payload / cron，不重置窗口，也不自动复活 failed；
   * - disabled = done，保留行与历史窗口供排障。
   */
  async reconcileAutomationScheduleJob(
    client: DbClient,
    input: AutomationScheduleJobInput,
  ): Promise<AutomationScheduleJobOutcome> {
    const now = input.now ?? new Date();
    const dedupeKey = "automation-schedule:" + input.ruleCode;
    const payload = { ruleCode: input.ruleCode, ruleVersion: input.ruleVersion };
    const rows = await client
      .select({
        id: jobs.id,
        payload: jobs.payload,
        cron: jobs.cron,
        status: jobs.status,
      })
      .from(jobs)
      .where(eq(jobs.dedupeKey, dedupeKey))
      .limit(1);
    const existing = rows[0];
    if (existing === undefined) {
      await client.insert(jobs).values({
        kind: "automation-schedule.job",
        payload,
        cron: input.cron,
        runAt: now,
        lastRunAt: now,
        status: input.enabled ? "pending" : "done",
        dedupeKey,
      });
      return "inserted";
    }
    const payloadUnchanged = JSON.stringify(existing.payload) === JSON.stringify(payload);
    const cronUnchanged = existing.cron === input.cron;
    if (!input.enabled) {
      if (existing.status === "done" && payloadUnchanged && cronUnchanged) return "unchanged";
      await client
        .update(jobs)
        .set({ payload, cron: input.cron, status: "done", lockedAt: null, updatedAt: sql`now()` })
        .where(eq(jobs.id, existing.id));
      return "disabled";
    }
    if (existing.status === "done") {
      await client
        .update(jobs)
        .set({
          payload,
          cron: input.cron,
          status: "pending",
          runAt: now,
          lastRunAt: now,
          attempts: 0,
          lastError: null,
          lockedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, existing.id));
      return "reactivated";
    }
    if (payloadUnchanged && cronUnchanged) return "unchanged";
    await client
      .update(jobs)
      .set({ payload, cron: input.cron, updatedAt: sql`now()` })
      .where(eq(jobs.id, existing.id));
    return "updated";
  }
}
