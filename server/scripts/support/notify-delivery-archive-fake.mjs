/**
 * 无数据库回放的归档端口替身（M5-06-2A 接线后，M5-03 消费段回放共用）：
 * 保留原 `repo.deliveries` 断言面，并把消息级状态 / 计数独立记录，供旧回放平滑迁移。
 */
export function createReplayNotifyDeliveryArchive(repo) {
  const messages = new Map();
  let sequence = 0;

  return {
    messages,

    async ensureMessage(input) {
      let row = messages.get(input.sourceDedupeKey);
      if (row === undefined) {
        row = {
          ...input,
          id: ++sequence,
          lastState: "pending",
          attemptCount: 0,
          lastError: null,
          sentAt: null,
          metadata: input.metadata ?? {},
        };
        messages.set(input.sourceDedupeKey, row);
      }
      return toRow(row);
    },

    async recordAttempt(input) {
      const row = mustMessage(messages, input.messageId);
      row.attemptCount += 1;
      row.lastState = input.state;
      row.lastError = input.state === "sent" ? null : input.error;
      if (input.sentAt !== null) {
        row.sentAt = input.sentAt;
      }
      repo.deliveries.push(input);
    },

    async markState(input) {
      const row = mustMessage(messages, input.messageId);
      row.lastState = input.state;
      row.lastError = input.state === "sent" || input.state === "pending" ? null : (input.error ?? "未提供失败原因");
      if (input.sentAt !== undefined) {
        row.sentAt = input.sentAt;
      }
      if (input.recipientLabel !== undefined) {
        row.recipientLabel = input.recipientLabel;
      }
      if (input.metadata !== undefined) {
        row.metadata = { ...row.metadata, ...input.metadata };
      }
    },

    async markMerged(messageId, parentId, at) {
      await this.markState({
        messageId,
        state: "sent",
        at,
        sentAt: at,
        metadata: { mergedIntoId: parentId },
      });
    },
  };
}

function mustMessage(messages, id) {
  for (const row of messages.values()) {
    if (row.id === id) {
      return row;
    }
  }
  throw new Error("回放归档不存在：id=" + id);
}

function toRow(row) {
  return {
    id: row.id,
    sourceDedupeKey: row.sourceDedupeKey,
    lastState: row.lastState,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    sentAt: row.sentAt,
  };
}
