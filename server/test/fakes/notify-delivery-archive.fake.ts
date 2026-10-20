import type {
  NotifyDeliveryAttemptInsert,
  NotifyDeliveryMessageInsert,
  NotifyDeliveryMessageRow,
  NotifyDeliveryStateUpdate,
} from "../../src/modules/notify/notify.delivery-archive.repository.js";

export interface FakeArchivedMessage extends NotifyDeliveryMessageInsert {
  id: number;
  lastState: NotifyDeliveryMessageRow["lastState"];
  attemptCount: number;
  lastError: string | null;
  sentAt: Date | null;
  metadata: Record<string, unknown>;
}

/** 消息归档端口替身：测试断言归档先于发送、尝试关联与状态推进。 */
export class FakeNotifyDeliveryArchive {
  messages: FakeArchivedMessage[] = [];
  attempts: NotifyDeliveryAttemptInsert[] = [];
  failEnsure = false;
  private seq = 0;

  async ensureMessage(input: NotifyDeliveryMessageInsert): Promise<NotifyDeliveryMessageRow> {
    if (this.failEnsure) {
      throw new Error("fake 消息归档写库失败");
    }
    const existing = this.messages.find((item) => item.sourceDedupeKey === input.sourceDedupeKey);
    if (existing !== undefined) {
      return toRow(existing);
    }
    this.seq += 1;
    const row: FakeArchivedMessage = {
      ...input,
      id: this.seq,
      lastState: "pending",
      attemptCount: 0,
      lastError: null,
      sentAt: null,
      metadata: input.metadata ?? {},
    };
    this.messages.push(row);
    return toRow(row);
  }

  async recordAttempt(input: NotifyDeliveryAttemptInsert): Promise<void> {
    const row = this.mustMessage(input.messageId);
    this.attempts.push(input);
    row.attemptCount += 1;
    row.lastState = input.state;
    row.lastError = input.state === "sent" ? null : input.error;
    row.sentAt = input.sentAt ?? row.sentAt;
    if (input.recipientLabel !== undefined) {
      row.recipientLabel = input.recipientLabel;
    }
  }

  async markState(input: NotifyDeliveryStateUpdate): Promise<void> {
    const row = this.mustMessage(input.messageId);
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
  }

  async markMerged(messageId: number, parentId: number, at: Date): Promise<void> {
    await this.markState({
      messageId,
      state: "sent",
      at,
      sentAt: at,
      metadata: { mergedIntoId: parentId },
    });
  }

  private mustMessage(id: number): FakeArchivedMessage {
    const row = this.messages.find((item) => item.id === id);
    if (row === undefined) {
      throw new Error("fake 归档不存在：id=" + id);
    }
    return row;
  }
}

function toRow(row: FakeArchivedMessage): NotifyDeliveryMessageRow {
  return {
    id: row.id,
    sourceDedupeKey: row.sourceDedupeKey,
    lastState: row.lastState,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    sentAt: row.sentAt,
  };
}
