import { Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lt, or, type SQL } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { notifyDeliveries, notifyDeliveryMessages } from "../db/schema/notify.js";
import { outboxEvents } from "../db/schema/platform.js";
import type { DailyDigestSourceData } from "./daily-digest.js";

export interface DailyDigestSourceWindow {
  historyFrom: Date;
  windowTo: Date;
  reportAt: Date;
}

/**
 * 管理员日报只读仓储：一次读取近 7 个自然日的消息归档、失败尝试与预览死信。
 * 去重 / 排除 / 状态归并全部在领域层完成，保证口径可单测，不把业务规则散进 SQL。
 */
@Injectable()
export class OutboxDailyDigestRepository {
  constructor(private readonly database: DatabaseService) {}

  async load(input: DailyDigestSourceWindow): Promise<DailyDigestSourceData> {
    const attempts = await this.database.db
      .select({
        messageId: notifyDeliveries.messageId,
        state: notifyDeliveries.state,
        error: notifyDeliveries.error,
        createdAt: notifyDeliveries.createdAt,
      })
      .from(notifyDeliveries)
      .where(
        and(
          gte(notifyDeliveries.createdAt, input.historyFrom),
          lt(notifyDeliveries.createdAt, input.windowTo),
          inArray(notifyDeliveries.state, ["failed", "deferred", "dead"]),
        ),
      )
      .orderBy(notifyDeliveries.createdAt, notifyDeliveries.id);

    const messageIds = [...new Set(attempts.map((row) => row.messageId).filter((id): id is number => id !== null))];
    const messageConditions: SQL[] = [lt(notifyDeliveryMessages.createdAt, input.reportAt)];
    if (messageIds.length === 0) {
      messageConditions.push(gte(notifyDeliveryMessages.createdAt, input.historyFrom));
    } else {
      const scope = or(
        gte(notifyDeliveryMessages.createdAt, input.historyFrom),
        inArray(notifyDeliveryMessages.id, messageIds),
      );
      if (scope !== undefined) {
        messageConditions.push(scope);
      }
    }

    const messages = await this.database.db
      .select({
        id: notifyDeliveryMessages.id,
        sourceDedupeKey: notifyDeliveryMessages.sourceDedupeKey,
        channel: notifyDeliveryMessages.channel,
        title: notifyDeliveryMessages.title,
        templateCode: notifyDeliveryMessages.templateCode,
        lastState: notifyDeliveryMessages.lastState,
        lastError: notifyDeliveryMessages.lastError,
        sentAt: notifyDeliveryMessages.sentAt,
        createdAt: notifyDeliveryMessages.createdAt,
        metadata: notifyDeliveryMessages.metadata,
      })
      .from(notifyDeliveryMessages)
      .where(and(...messageConditions))
      .orderBy(notifyDeliveryMessages.createdAt, notifyDeliveryMessages.id);

    const previewDeaths = await this.database.db
      .select({
        id: outboxEvents.id,
        lastError: outboxEvents.lastError,
        updatedAt: outboxEvents.updatedAt,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.topic, "preview.job"),
          eq(outboxEvents.status, "dead"),
          gte(outboxEvents.updatedAt, input.historyFrom),
          lt(outboxEvents.updatedAt, input.windowTo),
        ),
      )
      .orderBy(outboxEvents.updatedAt, outboxEvents.id);

    return {
      messages: messages.map((row) => ({ ...row, metadata: row.metadata ?? {} })),
      attempts,
      previewDeaths,
    };
  }
}
