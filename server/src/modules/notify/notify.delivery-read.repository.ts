/**
 * 发送记录读面 / 重发写面（M5-06-2B · S8-4）：消息级归档筛选、尝试明细、幂等重发插入。
 * 读面只返回掩码目标；完整 target / payload 仅供服务层重发时复用，不下发契约。
 */
import { Injectable } from "@nestjs/common";
import type { NotifyChannel, NotifyDeliveryMessageState, NotifyDeliveryTopic, OutboxTopic } from "@libiaolink/contracts";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { appendOutboxReturningId } from "../../db/outbox.js";
import { notifyDeliveryMessages, notifyDeliveries } from "../../db/schema/notify.js";
import type { NotifyDeliveryMessageInsert } from "./notify.delivery-archive.repository.js";

/** 消息归档完整行（读面 / 重发共用；payload 与 metadata 不直接下发）。 */
export interface NotifyDeliveryMessageRecord {
  id: number;
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
  resendOfMessageId: number | null;
  metadata: Record<string, unknown>;
  lastState: NotifyDeliveryMessageState;
  attemptCount: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 尝试行（target 只在库内；读面由服务层掩码）。 */
export interface NotifyDeliveryAttemptRecord {
  id: number;
  messageId: number;
  channel: string;
  target: string;
  state: string;
  attempts: number;
  error: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface NotifyDeliveryFilter {
  channel?: NotifyChannel;
  lastState?: NotifyDeliveryMessageState;
  ruleCode?: string;
  recipientId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  limit: number;
}

/** 重发插入：outbox id 由同一事务内的 outbox 插入后回填。 */
export type NotifyDeliveryResendInsert = Omit<NotifyDeliveryMessageInsert, "outboxId">;

const DELIVERY_MESSAGE_SELECT = {
  id: notifyDeliveryMessages.id,
  outboxId: notifyDeliveryMessages.outboxId,
  sourceDedupeKey: notifyDeliveryMessages.sourceDedupeKey,
  topic: notifyDeliveryMessages.topic,
  channel: notifyDeliveryMessages.channel,
  recipientId: notifyDeliveryMessages.recipientId,
  recipientLabel: notifyDeliveryMessages.recipientLabel,
  title: notifyDeliveryMessages.title,
  body: notifyDeliveryMessages.body,
  templateCode: notifyDeliveryMessages.templateCode,
  ruleCode: notifyDeliveryMessages.ruleCode,
  refType: notifyDeliveryMessages.refType,
  refId: notifyDeliveryMessages.refId,
  payload: notifyDeliveryMessages.payload,
  resendOfMessageId: notifyDeliveryMessages.resendOfMessageId,
  metadata: notifyDeliveryMessages.metadata,
  lastState: notifyDeliveryMessages.lastState,
  attemptCount: notifyDeliveryMessages.attemptCount,
  lastError: notifyDeliveryMessages.lastError,
  sentAt: notifyDeliveryMessages.sentAt,
  createdAt: notifyDeliveryMessages.createdAt,
  updatedAt: notifyDeliveryMessages.updatedAt,
} as const;

const DELIVERY_ATTEMPT_SELECT = {
  id: notifyDeliveries.id,
  messageId: notifyDeliveries.messageId,
  channel: notifyDeliveries.channel,
  target: notifyDeliveries.target,
  state: notifyDeliveries.state,
  attempts: notifyDeliveries.attempts,
  error: notifyDeliveries.error,
  sentAt: notifyDeliveries.sentAt,
  createdAt: notifyDeliveries.createdAt,
} as const;

@Injectable()
export class NotifyDeliveryReadRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(filter: NotifyDeliveryFilter): Promise<{ items: NotifyDeliveryMessageRecord[]; total: number }> {
    const conditions = deliveryConditions(filter);
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const limit = Math.min(200, Math.max(1, filter.limit));
    const page = Math.max(1, filter.page);
    const rows = await this.database.db
      .select(DELIVERY_MESSAGE_SELECT)
      .from(notifyDeliveryMessages)
      .where(where)
      .orderBy(desc(notifyDeliveryMessages.createdAt), desc(notifyDeliveryMessages.id))
      .limit(limit)
      .offset((page - 1) * limit);
    const totals = await this.database.db
      .select({ value: sql<number>`count(*)::int` })
      .from(notifyDeliveryMessages)
      .where(where);
    return {
      items: rows as unknown as NotifyDeliveryMessageRecord[],
      total: Number(totals[0]?.value ?? 0),
    };
  }

  async findById(id: number, client: DbClient = this.database.db): Promise<NotifyDeliveryMessageRecord | null> {
    const rows = await client
      .select(DELIVERY_MESSAGE_SELECT)
      .from(notifyDeliveryMessages)
      .where(eq(notifyDeliveryMessages.id, id))
      .limit(1);
    return (rows[0] as unknown as NotifyDeliveryMessageRecord | undefined) ?? null;
  }

  async findBySourceKey(
    sourceDedupeKey: string,
    client: DbClient = this.database.db,
  ): Promise<NotifyDeliveryMessageRecord | null> {
    const rows = await client
      .select(DELIVERY_MESSAGE_SELECT)
      .from(notifyDeliveryMessages)
      .where(eq(notifyDeliveryMessages.sourceDedupeKey, sourceDedupeKey))
      .limit(1);
    return (rows[0] as unknown as NotifyDeliveryMessageRecord | undefined) ?? null;
  }

  async listAttempts(messageId: number, client: DbClient = this.database.db): Promise<NotifyDeliveryAttemptRecord[]> {
    const rows = await client
      .select(DELIVERY_ATTEMPT_SELECT)
      .from(notifyDeliveries)
      .where(eq(notifyDeliveries.messageId, messageId))
      .orderBy(asc(notifyDeliveries.id));
    return rows as unknown as NotifyDeliveryAttemptRecord[];
  }

  /** 以 source_dedupe_key 唯一约束做重发幂等：并发同 key 只有一条 created=true。 */
  async insertResendMessage(
    input: NotifyDeliveryResendInsert,
    client: DbClient,
  ): Promise<{ row: NotifyDeliveryMessageRecord; created: boolean }> {
    const rows = await client
      .insert(notifyDeliveryMessages)
      .values({
        outboxId: null,
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
      .returning(DELIVERY_MESSAGE_SELECT);
    const inserted = rows[0] as unknown as NotifyDeliveryMessageRecord | undefined;
    if (inserted !== undefined) {
      return { row: inserted, created: true };
    }
    const existing = await this.findBySourceKey(input.sourceDedupeKey, client);
    if (existing === null) {
      throw new Error("重发归档冲突后未读回既有行：" + input.sourceDedupeKey);
    }
    return { row: existing, created: false };
  }

  async insertResendOutbox(
    client: DbClient,
    event: { topic: OutboxTopic; payload: Record<string, unknown>; dedupeKey: string },
  ): Promise<number> {
    return appendOutboxReturningId(client, event);
  }

  async setOutboxId(client: DbClient, messageId: number, outboxId: number): Promise<void> {
    const rows = await client
      .update(notifyDeliveryMessages)
      .set({ outboxId })
      .where(eq(notifyDeliveryMessages.id, messageId))
      .returning({ id: notifyDeliveryMessages.id });
    if (rows[0] === undefined) {
      throw new Error("重发归档回填 outbox_id 失败：消息不存在（id=" + messageId + "）");
    }
  }

}

function deliveryConditions(filter: NotifyDeliveryFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.channel !== undefined) conditions.push(eq(notifyDeliveryMessages.channel, filter.channel));
  if (filter.lastState !== undefined) conditions.push(eq(notifyDeliveryMessages.lastState, filter.lastState));
  if (filter.ruleCode !== undefined) conditions.push(eq(notifyDeliveryMessages.ruleCode, filter.ruleCode));
  if (filter.recipientId !== undefined) conditions.push(eq(notifyDeliveryMessages.recipientId, filter.recipientId));
  if (filter.from !== undefined) conditions.push(gte(notifyDeliveryMessages.createdAt, filter.from));
  if (filter.to !== undefined) conditions.push(lte(notifyDeliveryMessages.createdAt, filter.to));
  if (filter.q !== undefined && filter.q !== "") {
    const pattern = "%" + filter.q + "%";
    conditions.push(sql`(${notifyDeliveryMessages.title} ILIKE ${pattern} OR ${notifyDeliveryMessages.body} ILIKE ${pattern})`);
  }
  return conditions;
}
