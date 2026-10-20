/**
 * M5-06-2B 发送记录读面 / 重发门禁（不连库）：
 * 筛选 + 稳定分页、目标 / 错误掩码、404 / 409 状态门禁、Idempotency-Key 幂等、
 * 新 outbox / 新归档 / 审计同事务语义，以及原消息与原尝试不改写。
 */
import { describe, expect, it } from "vitest";
import type { AuditService } from "../src/modules/audit/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type {
  NotifyDeliveryFilter,
  NotifyDeliveryMessageRecord,
  NotifyDeliveryResendInsert,
} from "../src/modules/notify/notify.delivery-read.repository.js";
import { NotifyDeliveryService } from "../src/modules/notify/notify.delivery.service.js";

const TX = { marker: "tx" } as unknown as DbClient;
const T0 = new Date("2026-10-20T04:00:00Z");

class FakeDeliveryRepository {
  messages: NotifyDeliveryMessageRecord[] = [];
  attempts: Array<Record<string, unknown>> = [];
  outbox: Array<{ id: number; topic: string; payload: Record<string, unknown>; dedupeKey: string; status: string }> = [];
  private seq = 100;

  async list(filter: NotifyDeliveryFilter): Promise<{ items: NotifyDeliveryMessageRecord[]; total: number }> {
    const keyword = filter.q?.toLowerCase();
    const items = this.messages
      .filter((row) => filter.channel === undefined || row.channel === filter.channel)
      .filter((row) => filter.lastState === undefined || row.lastState === filter.lastState)
      .filter((row) => filter.ruleCode === undefined || row.ruleCode === filter.ruleCode)
      .filter((row) => filter.recipientId === undefined || row.recipientId === filter.recipientId)
      .filter((row) => filter.from === undefined || row.createdAt.getTime() >= filter.from.getTime())
      .filter((row) => filter.to === undefined || row.createdAt.getTime() <= filter.to.getTime())
      .filter((row) => keyword === undefined || row.title?.toLowerCase().includes(keyword) === true || row.body.toLowerCase().includes(keyword))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    return { items: items.slice((filter.page - 1) * filter.limit, filter.page * filter.limit), total: items.length };
  }

  async findById(id: number): Promise<NotifyDeliveryMessageRecord | null> {
    return this.messages.find((row) => row.id === id) ?? null;
  }

  async findBySourceKey(key: string): Promise<NotifyDeliveryMessageRecord | null> {
    return this.messages.find((row) => row.sourceDedupeKey === key) ?? null;
  }

  async listAttempts(messageId: number): Promise<Array<Record<string, unknown>>> {
    return this.attempts.filter((row) => row.messageId === messageId);
  }

  async insertResendMessage(input: NotifyDeliveryResendInsert): Promise<{ row: NotifyDeliveryMessageRecord; created: boolean }> {
    const existing = this.messages.find((row) => row.sourceDedupeKey === input.sourceDedupeKey) ?? null;
    if (existing !== null) return { row: existing, created: false };
    this.seq += 1;
    const row: NotifyDeliveryMessageRecord = {
      id: this.seq,
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
      lastState: "pending",
      attemptCount: 0,
      lastError: null,
      sentAt: null,
      createdAt: T0,
      updatedAt: T0,
    };
    this.messages.push(row);
    return { row, created: true };
  }

  async insertResendOutbox(_client: DbClient, event: { topic: string; payload: Record<string, unknown>; dedupeKey: string }): Promise<number> {
    this.seq += 1;
    const id = this.seq;
    this.outbox.push({ id, ...event, status: "pending" });
    return id;
  }

  async setOutboxId(_client: DbClient, messageId: number, outboxId: number): Promise<void> {
    const row = this.messages.find((item) => item.id === messageId);
    if (row === undefined) throw new Error("fake：重发归档不存在");
    row.outboxId = outboxId;
  }
}

class FakeAudit {
  calls: Array<{ client: DbClient; input: Record<string, unknown> }> = [];
  async record(client: DbClient, input: Record<string, unknown>): Promise<void> {
    this.calls.push({ client, input });
  }
}

function message(overrides: Partial<NotifyDeliveryMessageRecord> = {}): NotifyDeliveryMessageRecord {
  return {
    id: 1,
    outboxId: 10,
    sourceDedupeKey: "R02:t-1:v5:app",
    topic: "notify.message",
    channel: "wecom_app",
    recipientId: "11111111-1111-4111-8111-111111111111",
    recipientLabel: "****1234",
    title: "提醒",
    body: "请处理任务",
    templateCode: "R02_WECOM",
    ruleCode: "R02",
    refType: "task",
    refId: "t-1",
    payload: { recipientId: "11111111-1111-4111-8111-111111111111", channel: "wecom_app", title: "提醒", body: "请处理任务" },
    resendOfMessageId: null,
    metadata: {},
    lastState: "failed",
    attemptCount: 1,
    lastError: "access_token=secret-token 调用失败",
    sentAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function harness() {
  const repository = new FakeDeliveryRepository();
  const audit = new FakeAudit();
  const permissionCalls: string[] = [];
  const permission = {
    async assertCan(actorId: string, key: string): Promise<void> {
      permissionCalls.push(actorId + ":" + key);
      if (actorId === "denied") {
        const { AppError } = await import("../src/common/errors/app-error.js");
        throw new AppError("FORBIDDEN", "无权限：" + key);
      }
    },
  } as unknown as PermissionService;
  const database = {
    db: { async transaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> { return work(TX); } },
  } as unknown as DatabaseService;
  const service = new NotifyDeliveryService(repository as never, database, permission, audit as unknown as AuditService);
  return { repository, audit, permissionCalls, service };
}

describe("NotifyDeliveryService", () => {
  it("列表：筛选 / total / createdAt desc, id desc；lastError 掩码", async () => {
    const h = harness();
    h.repository.messages.push(
      message({ id: 1, createdAt: new Date("2026-10-20T04:00:00Z") }),
      message({ id: 2, createdAt: new Date("2026-10-20T04:01:00Z") }),
      message({ id: 3, channel: "wecom_group", topic: "notify.group", createdAt: new Date("2026-10-20T04:02:00Z") }),
    );
    const result = await h.service.list("admin", { channel: "wecom_app", lastState: "failed", page: 1, limit: 1 });
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(2);
    expect(result.items[0]?.lastError).toBe("access_token=*** 调用失败");
    expect(h.permissionCalls).toEqual(["admin:notify.record.view"]);
  });

  it("详情：尝试目标只回末 4 位、错误脱敏；不存在 404", async () => {
    const h = harness();
    h.repository.messages.push(message({ id: 1 }));
    h.repository.attempts.push({
      id: 11,
      messageId: 1,
      channel: "wecom_app",
      target: "full-userid-1234",
      state: "failed",
      attempts: 1,
      error: "secret=top-secret",
      sentAt: null,
      createdAt: T0,
    });
    const detail = await h.service.detail("admin", 1);
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ targetMasked: "****1234", error: "secret=***" });
    await expect(h.service.detail("admin", 999)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("重发：failed 外部消息 → 新归档 pending + 新 outbox + 审计；原记录不变", async () => {
    const h = harness();
    const original = message({ id: 1, lastState: "failed" });
    h.repository.messages.push(original);
    const result = await h.service.resend("admin", 1, "idem-key-12345678");

    expect(result.message).toMatchObject({ lastState: "pending", resendOfMessageId: 1, attemptCount: 0 });
    expect(h.repository.outbox).toHaveLength(1);
    expect(h.repository.outbox[0]?.topic).toBe("notify.message");
    expect(h.repository.outbox[0]?.dedupeKey).toMatch(/^resend:1:[0-9a-f]{64}$/);
    expect(h.repository.messages.find((row) => row.id === 1)).toMatchObject({ lastState: "failed", attemptCount: 1 });
    expect(h.audit.calls).toHaveLength(1);
    expect(h.audit.calls[0]?.input).toMatchObject({
      action: "update",
      objectType: "notify_delivery",
      objectId: String(result.message.id),
      metadata: { operation: "resend", sourceMessageId: 1 },
    });
  });

  it("重发：同一 Idempotency-Key 重复 / 并发 → 同一归档、一个 outbox、一条审计", async () => {
    const h = harness();
    h.repository.messages.push(message({ id: 1, lastState: "dead" }));
    const [left, right] = await Promise.all([
      h.service.resend("admin", 1, "same-idem-key"),
      h.service.resend("admin", 1, "same-idem-key"),
    ]);
    const again = await h.service.resend("admin", 1, "same-idem-key");
    expect(left.message.id).toBe(right.message.id);
    expect(again.message.id).toBe(left.message.id);
    expect(h.repository.outbox).toHaveLength(1);
    expect(h.audit.calls).toHaveLength(1);
  });

  it("重发幂等：首次成功后原消息状态变化，同 key 仍返回首次归档而不被门禁拦截", async () => {
    const h = harness();
    const original = message({ id: 1, lastState: "failed" });
    h.repository.messages.push(original);
    const first = await h.service.resend("admin", 1, "state-change-key");
    original.lastState = "sent";

    const again = await h.service.resend("admin", 1, "state-change-key");
    expect(again.message.id).toBe(first.message.id);
    expect(h.repository.outbox).toHaveLength(1);
    expect(h.audit.calls).toHaveLength(1);
  });

  it("重发：不同 key 各自新建，原记录仍不变", async () => {
    const h = harness();
    h.repository.messages.push(message({ id: 1, lastState: "failed" }));
    const first = await h.service.resend("admin", 1, "key-one-12345678");
    const second = await h.service.resend("admin", 1, "key-two-12345678");
    expect(second.message.id).not.toBe(first.message.id);
    expect(h.repository.outbox).toHaveLength(2);
    expect(h.audit.calls).toHaveLength(2);
  });

  it("重发门禁：inbox / email / pending / deferred / sent 一律 409", async () => {
    for (const [id, overrides] of [
      [1, { channel: "inbox" as const, lastState: "failed" as const }],
      [2, { channel: "email" as const, lastState: "dead" as const }],
      [3, { channel: "wecom_app" as const, lastState: "pending" as const }],
      [4, { channel: "wecom_app" as const, lastState: "deferred" as const }],
      [5, { channel: "wecom_app" as const, lastState: "sent" as const, sentAt: T0, lastError: null }],
    ] as const) {
      const h = harness();
      h.repository.messages.push(message({ id, ...overrides }));
      await expect(h.service.resend("admin", id, "state-key-12345678")).rejects.toMatchObject({
        code: "VERSION_CONFLICT",
        httpStatus: 409,
      });
    }
  });

  it("重发：非法 / 缺失 Idempotency-Key → 400；无权限 → 403", async () => {
    const h = harness();
    h.repository.messages.push(message({ id: 1 }));
    await expect(h.service.resend("admin", 1, "short")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    await expect(h.service.resend("denied", 1, "idem-key-12345678")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
