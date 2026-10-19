import { Injectable } from "@nestjs/common";
import type { OutboxTopic } from "@libiaolink/contracts";
import { eq, sql } from "drizzle-orm";
import { DatabaseService } from "./database.service.js";
import type { DbClient } from "./db-client.js";
import { outboxEvents } from "./schema/platform.js";

/** 领取到的 Outbox 行（worker 消费用：只带消费需要的字段）。 */
export interface OutboxClaimedRow {
  id: number;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  dedupeKey: string;
  attempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  /** 事件行创建时刻（`created_at`）：规则接线的冷启动保护（AUTOMATION_EVENT_MAX_AGE_MS）按「at - eventAt」判定。 */
  createdAt: Date;
}

export interface ClaimOutboxInput {
  /** 允许领取的主题（一期只有预览队列用；空数组 = 不领任何行）。 */
  topics: readonly OutboxTopic[];
  limit: number;
  /** 超过该时长仍处 `processing` 的行视为崩溃遗留（migration 0028），可重新领取 —— 毫秒。 */
  staleAfterMs: number;
  /** 领取者标识（migration 0038 的 `locked_by`）：WORKER_ID 或 host:pid —— 排障 / PoC-5 并发报告用。 */
  workerId: string;
}

export interface OutboxRetryInput {
  /** 本次失败后的累计尝试次数（含本次）。 */
  attempts: number;
  /** 下次可领取时间（退避）。 */
  availableAt: Date;
  error: string | null;
}

/** 单主题积压明细（告警探针日志用）。 */
export interface OutboxTopicBacklog {
  topic: string;
  due: number;
  /** 该主题最老待领取消息的已等待时长（毫秒）。 */
  oldestMs: number;
}

/** Outbox 健康快照（S7-1 告警探针）：积压 / 最老年龄 / 死信。 */
export interface OutboxStatsSnapshot {
  /** `pending` 且 `available_at <= now()`（真正可领取，不含退避未到点的行）。 */
  duePending: number;
  /** 最老待领取消息的已等待时长（毫秒）；无积压 = null。 */
  oldestDueMs: number | null;
  /** 进度窗口内完成的 done 行数：用于区分「正常排空」与「消费者停滞」。 */
  doneRecent: number;
  /** 窗口内新增的 dead 行数（按 updated_at）。 */
  deadRecent: number;
  deadTotal: number;
  byTopic: OutboxTopicBacklog[];
}

export interface OutboxStatsInput {
  /** 死信「近期」窗口（毫秒）。 */
  deadWindowMs: number;
  /** 完成进度窗口（毫秒）：统计该窗口内 done 行，判断队列是否仍有消费进展。 */
  progressWindowMs: number;
}

export interface PurgeDoneInput {
  /** done 行保留期（天）。 */
  retentionDays: number;
  /** 单批删除条数上限。 */
  batch: number;
}

/**
 * Outbox 领取 / 回写（M4-05c · Push 160 定案：领取器切片只落「领取 + 消费 + 重试 + dead」）。
 *
 * 领取是**单条语句**（`update ... from (select ... for update skip locked)`）：原子、不占长事务 ——
 * 预览转换最长 90s，绝不能把行锁握满整个转换时长。崩溃遗留由 `locked_at` 超阈值重领兜底（migration 0028）。
 *
 * 状态口径：`pending`（待领）→ `processing`（已领，有 locked_at）→ `done`（消费成功）/ `dead`（到顶或确定性放弃）；
 * 重试 = 回 `pending` 并把 `available_at` 推后（`attempts` 留痕，不新建事件）。
 */
@Injectable()
export class OutboxStore {
  constructor(private readonly database: DatabaseService) {}

  async claim(input: ClaimOutboxInput): Promise<OutboxClaimedRow[]> {
    if (input.topics.length === 0 || input.limit <= 0) {
      return [];
    }
    // 注意：drizzle 的 sql`` 模板会把 JS 数组**摊平成多个参数**（`any($1::text[])` 会拿到单个元素 → 真机报
    // `malformed array literal`），所以主题清单要显式拼成 `in ($1, $2)`（sql.join 的每一项仍是绑定参数，不拼字符串）。
    const topics = sql.join(
      input.topics.map((topic) => sql`${topic}`),
      sql`, `,
    );
    const result = await this.database.db.execute(sql`
      with claimed as (
        select id
          from outbox_events
         where topic in (${topics})
           and (
             (status = 'pending' and available_at <= now())
             or (status = 'processing' and locked_at is not null
                 and locked_at < now() - ${input.staleAfterMs}::int * interval '1 millisecond')
           )
         order by id
         limit ${input.limit}
         for update skip locked
      )
      update outbox_events as e
         set status = 'processing', locked_at = now(), locked_by = ${input.workerId}, updated_at = now()
        from claimed
       where e.id = claimed.id
      returning e.id, e.topic, e.payload, e.dedupe_key, e.attempts, e.available_at, e.locked_at, e.created_at
    `);
    return (result.rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      // 领取恒按注册表主题（OutboxTopic）过滤，库内行必在白名单内；此处窄化以衔接消费侧类型收口。
      topic: String(row.topic) as OutboxTopic,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      dedupeKey: String(row.dedupe_key),
      attempts: Number(row.attempts),
      availableAt: new Date(row.available_at as string | number | Date),
      lockedAt: row.locked_at ? new Date(row.locked_at as string | number | Date) : null,
      createdAt: new Date(row.created_at as string | number | Date),
    }));
  }

  /** 消费成功：不再重投（同 dedupeKey 的后续投递只在 dead 时才唤醒，见 appendOutboxIfAbsent）。 */
  async markDone(id: number, client: DbClient = this.database.db): Promise<void> {
    await client
      .update(outboxEvents)
      .set({ status: "done", lockedAt: null, lastError: null, updatedAt: sql`now()` })
      .where(eq(outboxEvents.id, id));
  }

  /** 可重试失败：回 `pending` 并推后 `available_at`（退避），`attempts` 累计。 */
  async markRetry(id: number, input: OutboxRetryInput, client: DbClient = this.database.db): Promise<void> {
    await client
      .update(outboxEvents)
      .set({
        status: "pending",
        attempts: input.attempts,
        availableAt: input.availableAt,
        lockedAt: null,
        lastError: input.error,
        updatedAt: sql`now()`,
      })
      .where(eq(outboxEvents.id, id));
  }

  /** 到顶 / 确定性放弃：`dead` 留痕（`last_error` 记最后一次原因）。 */
  async markDead(
    id: number,
    input: { attempts: number; error: string },
    client: DbClient = this.database.db,
  ): Promise<void> {
    await client
      .update(outboxEvents)
      .set({ status: "dead", attempts: input.attempts, lockedAt: null, lastError: input.error, updatedAt: sql`now()` })
      .where(eq(outboxEvents.id, id));
  }

  /**
   * 健康快照（S7-1 告警探针）：积压 / 最老待领取年龄 / 死信。
   * 只读、两条语句；`due` 只算 `available_at <= now()`（退避未到点的行不算「该干没干」）。
   */
  async stats(input: OutboxStatsInput): Promise<OutboxStatsSnapshot> {
    const totals = await this.database.db.execute(sql`
      select
        count(*) filter (where status = 'pending' and available_at <= now())::int as due_pending,
        extract(epoch from (now() - min(available_at) filter (where status = 'pending' and available_at <= now()))) * 1000 as oldest_due_ms,
        count(*) filter (
          where status = 'done' and updated_at >= now() - ${input.progressWindowMs}::int * interval '1 millisecond'
        )::int as done_recent,
        count(*) filter (
          where status = 'dead' and updated_at >= now() - ${input.deadWindowMs}::int * interval '1 millisecond'
        )::int as dead_recent,
        count(*) filter (where status = 'dead')::int as dead_total
      from outbox_events
    `);
    const row = (totals.rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const byTopic = await this.database.db.execute(sql`
      select
        topic,
        count(*)::int as due,
        extract(epoch from (now() - min(available_at))) * 1000 as oldest_ms
      from outbox_events
      where status = 'pending' and available_at <= now()
      group by topic
      order by due desc, topic
    `);
    return {
      duePending: Number(row.due_pending ?? 0),
      oldestDueMs:
        row.oldest_due_ms === null || row.oldest_due_ms === undefined ? null : Math.max(0, Number(row.oldest_due_ms)),
      doneRecent: Number(row.done_recent ?? 0),
      deadRecent: Number(row.dead_recent ?? 0),
      deadTotal: Number(row.dead_total ?? 0),
      byTopic: (byTopic.rows as unknown as Array<Record<string, unknown>>).map((item) => ({
        topic: String(item.topic),
        due: Number(item.due),
        oldestMs: Math.max(0, Number(item.oldest_ms ?? 0)),
      })),
    };
  }

  /**
   * done 行保留期清理（ADR-005：成功行约 90 天，观察表膨胀）。
   * 单批删除（batch 上限），调用方循环到「不足一批」为止 —— 避免一次删太多把锁与 WAL 拉满。
   */
  async purgeDone(input: PurgeDoneInput): Promise<number> {
    const result = await this.database.db.execute(sql`
      with victims as (
        select id
          from outbox_events
         where status = 'done'
           and created_at < now() - ${input.retentionDays}::int * interval '1 day'
         order by id
         limit ${input.batch}
      )
      delete from outbox_events as e
        using victims
       where e.id = victims.id
      returning e.id
    `);
    return (result.rows as unknown as unknown[]).length;
  }
}
