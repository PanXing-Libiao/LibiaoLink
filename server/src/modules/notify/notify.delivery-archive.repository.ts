/**
 * 消息级发送归档写入端口（M5-06-2A · C2-07 / C5-03）：一次 outbox 消息一行，
 * 外部尝试另行写 notify_deliveries 并带 message_id；inbox 不写尝试表，只更新消息归档状态。
 *
 * 关键事务口径：
 * - 外部渠道先 `ensureMessage`，失败直接抛错交 outbox 重试，调用方不得继续发送；
 * - `recordAttempt` 在同一事务内写尝试行 + 推进消息最新状态 / 次数；
 * - inbox 的 `ensureMessage` 与 notifications 落行共用调用方事务；合并 / 延迟 / 投递结果同事务更新；
 * - source_dedupe_key 唯一，重复消费 / 回填返回既有行，不覆盖正文快照。
 */
import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { NotifyChannel, NotifyDeliveryMessageState, NotifyDeliveryTopic } from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { notifyDeliveryMessages, notifyDeliveries } from "../../db/schema/notify.js";

/** 外部尝试状态（消息级另有 pending）—— 与 shared NOTIFY_DELIVERY_ATTEMPT_STATES 同源。 */
export type NotifyDeliveryAttemptState = Exclude<NotifyDeliveryMessageState, "pending">;

/** 消息归档写入输入（正文已在调用方完成契约校验 / 空白归一）。 */
export interface NotifyDeliveryMessageInsert {
  outboxId: number | null;
  sourceDedupeKey: string;
  topic: NotifyDeliveryTopic;
  channel: NotifyChannel;
  recipientId: string | null;
  recipientLabel: string | null;
  title: string | null;
  body: string;
  templateCode: string | null;
  ruleCode: string | null;
  refType: string | null;
  refId: string | null;
  payload: Record<string, unknown>;
  resendOfMessageId?: number | null;
  metadata?: Record<string, unknown>;
}

/** 消息归档行（服务层只用 id / 状态做幂等判断与回读）。 */
export interface NotifyDeliveryMessageRow {
  id: number;
  sourceDedupeKey: string;
  lastState: NotifyDeliveryMessageState;
  attemptCount: number;
  lastError: string | null;
  sentAt: Date | null;
}

/** 单次外部尝试写入输入（attempts = 渠道客户端实际 HTTP / 帧次；消息级 attemptCount 每行 +1）。 */
export interface NotifyDeliveryAttemptInsert {
  messageId: number;
  outboxId: number | null;
  channel: NotifyDeliveryAttemptState extends never ? never : Exclude<NotifyChannel, "inbox">;
  target: string;
  recipientLabel?: string;
  state: NotifyDeliveryAttemptState;
  attempts: number;
  error: string | null;
  sentAt: Date | null;
  at: Date;
}

/** 消息状态推进输入（inbox 结果 / 无 target 的确定性失败）。 */
export interface NotifyDeliveryStateUpdate {
  messageId: number;
  state: NotifyDeliveryMessageState;
  at: Date;
  error?: string | null;
  sentAt?: Date | null;
  recipientLabel?: string;
  metadata?: Record<string, unknown>;
}

/** 规则幂等键前缀推断：生产键形如 `R02:entity:window[:suffix]`；无法可信推断时回 null。 */
export function inferNotifyRuleCode(dedupeKey: string): string | null {
  const base = dedupeKey.endsWith(":c504") ? dedupeKey.slice(0, -5) : dedupeKey;
  const candidate = base.split(":", 1)[0]?.trim() ?? "";
  return /^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(candidate) ? candidate : null;
}

const MESSAGE_SELECT = {
  id: notifyDeliveryMessages.id,
  sourceDedupeKey: notifyDeliveryMessages.sourceDedupeKey,
  lastState: notifyDeliveryMessages.lastState,
  attemptCount: notifyDeliveryMessages.attemptCount,
  lastError: notifyDeliveryMessages.lastError,
  sentAt: notifyDeliveryMessages.sentAt,
} as const;

@Injectable()
export class NotifyDeliveryArchiveRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 幂等落消息归档：同一来源键返回既有行；归档写失败直接抛出（调用方不得继续发送）。 */
  async ensureMessage(
    input: NotifyDeliveryMessageInsert,
    client: DbClient = this.database.db,
  ): Promise<NotifyDeliveryMessageRow> {
    const inserted = await client
      .insert(notifyDeliveryMessages)
      .values({
        outboxId: input.outboxId,
        sourceDedupeKey: input.sourceDedupeKey,
        topic: input.topic,
        channel: input.channel,
        recipientId: input.recipientId,
        recipientLabel: input.recipientLabel,
        title: input.title,
        body: input.body,
        templateCode: input.templateCode,
        ruleCode: input.ruleCode,
        refType: input.refType,
        refId: input.refId,
        payload: input.payload,
        resendOfMessageId: input.resendOfMessageId ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({ target: notifyDeliveryMessages.sourceDedupeKey })
      .returning(MESSAGE_SELECT);
    if (inserted[0] !== undefined) {
      return toMessageRow(inserted[0]);
    }
    const existing = await client
      .select(MESSAGE_SELECT)
      .from(notifyDeliveryMessages)
      .where(eq(notifyDeliveryMessages.sourceDedupeKey, input.sourceDedupeKey))
      .limit(1);
    const row = existing[0];
    if (row === undefined) {
      throw new Error("notify delivery archive ensure：冲突后未读回既有行（" + input.sourceDedupeKey + "）");
    }
    return toMessageRow(row);
  }

  /** 外部尝试 + 消息状态同一事务：任一写失败整体回滚，交 outbox 重试。 */
  async recordAttempt(input: NotifyDeliveryAttemptInsert, client?: DbClient): Promise<void> {
    await this.withTransaction(client, async (tx) => {
      const set: Record<string, unknown> = {
        lastState: input.state,
        lastError: input.state === "sent" ? null : input.error,
        attemptCount: sql`${notifyDeliveryMessages.attemptCount} + 1`,
        updatedAt: sql`greatest(${input.at}, ${notifyDeliveryMessages.createdAt}, ${notifyDeliveryMessages.updatedAt})`,
      };
      set.sentAt = input.sentAt === null
        ? sql`${notifyDeliveryMessages.sentAt}`
        : sql`coalesce(${notifyDeliveryMessages.sentAt}, ${input.sentAt})`;
      if (input.recipientLabel !== undefined) {
        set.recipientLabel = input.recipientLabel;
      }
      const updated = await tx
        .update(notifyDeliveryMessages)
        .set(set)
        .where(eq(notifyDeliveryMessages.id, input.messageId))
        .returning({ id: notifyDeliveryMessages.id });
      if (updated[0] === undefined) {
        throw new Error("notify delivery archive record：消息归档不存在（id=" + input.messageId + "）");
      }
      await tx.insert(notifyDeliveries).values({
        outboxId: input.outboxId,
        messageId: input.messageId,
        channel: input.channel,
        target: input.target,
        state: input.state,
        attempts: input.attempts,
        error: input.error,
        sentAt: input.sentAt,
      });
    });
  }

  /** 消息状态推进（inbox 投递 / 合并 / 延迟；外部无 target 的 dead）。 */
  async markState(input: NotifyDeliveryStateUpdate, client?: DbClient): Promise<void> {
    await this.withTransaction(client, async (tx) => {
      const set: Record<string, unknown> = {
        lastState: input.state,
        lastError: input.state === "sent" || input.state === "pending" ? null : (input.error ?? "未提供失败原因"),
        updatedAt: sql`greatest(${input.at}, ${notifyDeliveryMessages.createdAt}, ${notifyDeliveryMessages.updatedAt})`,
      };
      if (input.sentAt !== undefined) {
        set.sentAt = input.sentAt;
      }
      if (input.recipientLabel !== undefined) {
        set.recipientLabel = input.recipientLabel;
      }
      if (input.metadata !== undefined) {
        set.metadata = sql`${notifyDeliveryMessages.metadata} || ${JSON.stringify(input.metadata)}::jsonb`;
      }
      const updated = await tx
        .update(notifyDeliveryMessages)
        .set(set)
        .where(eq(notifyDeliveryMessages.id, input.messageId))
        .returning({ id: notifyDeliveryMessages.id });
      if (updated[0] === undefined) {
        throw new Error("notify delivery archive markState：消息归档不存在（id=" + input.messageId + "）");
      }
    });
  }

  /** inbox 合并子行：消息级仍视为已处理并保留归档；attemptCount 不增加（无外部尝试）。 */
  async markMerged(messageId: number, parentId: number, at: Date, client?: DbClient): Promise<void> {
    await this.markState(
      {
        messageId,
        state: "sent",
        at,
        sentAt: at,
        metadata: { mergedIntoId: parentId },
      },
      client,
    );
  }

  private async withTransaction(
    client: DbClient | undefined,
    work: (tx: DbClient) => Promise<void>,
  ): Promise<void> {
    if (client !== undefined) {
      await work(client);
      return;
    }
    await this.database.db.transaction(work);
  }
}

function toMessageRow(row: Omit<NotifyDeliveryMessageRow, "lastState"> & { lastState: string }): NotifyDeliveryMessageRow {
  return { ...row, lastState: row.lastState as NotifyDeliveryMessageState };
}
