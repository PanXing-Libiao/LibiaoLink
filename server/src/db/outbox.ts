import type { OutboxTopic } from "@libiaolink/contracts";
import { sql } from "drizzle-orm";
import { outboxEvents } from "./schema/platform.js";
import type { DbClient } from "./db-client.js";

export interface OutboxEventInput {
  /** 主题：契约白名单闭集（Push 169 定案 24 项 → Push 215 后 26 项 → Push 252 后 27 项（增 task.finalized）→ Push 260 后 28 项（增 task.unfinalized）→ Push 385 后 30 项（增 project.completed）；编译期收口 —— 写入端只允许已登记主题）。 */
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  /** 消费幂等键（unique）：状态变更事件用「实体 + 版本」，重试事件追加时间戳。 */
  dedupeKey: string;
}

/**
 * 同事务写 Outbox（v0.2 §1.3：外部副作用唯一出口，至少一次投递 + dedupe_key 幂等）。
 * 业务事务内调用；投递由 worker 承接（骨架阶段仅落行）。
 */
export async function appendOutbox(client: DbClient, event: OutboxEventInput): Promise<void> {
  await client.insert(outboxEvents).values({
    topic: event.topic,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    status: "pending",
  });
}

/** 同事务追加并返回新 outbox id（M5-06-2B 重发归档需要回填 outbox_id）。 */
export async function appendOutboxReturningId(client: DbClient, event: OutboxEventInput): Promise<number> {
  const rows = await client.insert(outboxEvents).values({
    topic: event.topic,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    status: "pending",
  }).returning({ id: outboxEvents.id });
  const row = rows[0];
  if (row === undefined) throw new Error("outbox 插入后未返回 id：" + event.dedupeKey);
  return Number(row.id);
}

/**
 * 幂等投递（M4-05c 预览任务：「同一三元组只转一次」的投递侧落点）。
 *
 * - 同 `dedupeKey` 已存在：**不重复插入**（不覆盖已有进度）；
 * - 该行处于 `dead`：**重新唤醒**为 `pending`（重试次数归零、`last_error` 清空）——
 *   预览任务的 dead 只代表「这一轮重试到顶」，读取侧再次请求时应当可以重投（不是永久丢弃）；
 * - `options.reviveDone = true`（Push 226 续 · 预览读取侧）：`done` 行也一并唤醒 —— 调用方已确认产物
 *   `not_ready`（首次登记 / 产物行被彻底删除后同内容重传），done 的记录背后没有可复用产物，
 *   必须重新投一次，否则读取侧永远停在 not_ready；重投后记录转 pending，后续读取不再重复投。
 *   唤醒（含 dead）时 payload 一并刷新为本次事件的载荷 —— 旧载荷可能指向已删除的源（预览任务 fileId）。
 */
export async function appendOutboxIfAbsent(
  client: DbClient,
  event: OutboxEventInput,
  options: { reviveDone?: boolean } = {},
): Promise<void> {
  await client
    .insert(outboxEvents)
    .values({
      topic: event.topic,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: outboxEvents.dedupeKey,
      // 唤醒时必须连 payload 一起刷新（Push 226 续）：行是历史投递记录，载荷可能指向已删除的
      // fileId / versionId（预览补投场景）—— 不刷新就会「复活了任务但转的是旧源」，worker 直接跳过。
      set: { payload: event.payload, status: "pending", availableAt: sql`now()`, attempts: 0, lastError: null },
      setWhere:
        options.reviveDone === true
          ? sql`${outboxEvents.status} in ('dead', 'done')`
          : sql`${outboxEvents.status} = 'dead'`,
    });
}
