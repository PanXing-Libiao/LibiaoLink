/**
 * 站内信投递服务回归（S7-4 · j1 / M5-04 首刀）：消费（投递 / 合并 / 静默排期 / 幂等重放 / 非法载荷 → dead）、
 * 延迟投递排空（免打扰次日补发 / 每日上限再排期）、收件箱读面（过滤 / 未读角标 / 标记与归属 404）、
 * 通知偏好（缺省回退 / 三态 / 局部更新 / 空更新 400）。仓储 / 时钟 / 配置全替身，不连库。
 * 真机口径见 server/src/modules/notify/README.md 与 server/scripts/s7-4-notify-replay.mjs。
 */
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import type {
  NotifyInboxFilter,
  NotifyMessageInsert,
  NotifyMessageRow,
  NotifyPrefsPatch,
  NotifyPrefsRow,
} from "../src/modules/notify/notify.repository.js";
import { NotifyService } from "../src/modules/notify/notify.service.js";
import type { NotifyStreamWireMessage } from "../src/modules/notify/notify.stream.js";
import { AppConfig } from "../src/config/config.module.js";
import { FakeNotifyDeliveryArchive } from "./fakes/notify-delivery-archive.fake.js";

const ME = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const REF_A = "11111111-1111-4111-8111-111111111111";
const DAY_MS = 86_400_000;

/** 固定时钟：上海 2026-09-28 14:00（= UTC 06:00，非免打扰）。 */
const DAYTIME = new Date("2026-09-28T06:00:00.000Z");
/** 固定时钟：上海 2026-09-28 23:00（= UTC 15:00，在缺省免打扰 22:00-08:00 内）。 */
const NIGHT = new Date("2026-09-28T15:00:00.000Z");

class FakeNotifyRepository {
  rows: NotifyMessageRow[] = [];
  /** 幂等键集合（行类型不带 source_dedupe_key —— 只读面字段；幂等用独立集合替身）。 */
  dedupeKeys = new Set<string>();
  prefs = new Map<string, NotifyPrefsRow>();
  insertCalls: NotifyMessageInsert[] = [];
  delivered: number[] = [];
  postponed: { id: number; deliverAt: Date }[] = [];
  failInsert = false;
  private seq = 0;

  async insertMessage(input: NotifyMessageInsert, _tx?: unknown): Promise<NotifyMessageRow | null> {
    if (this.failInsert) throw new Error("fake insert 失败");
    this.insertCalls.push(input);
    if (this.dedupeKeys.has(input.sourceDedupeKey)) {
      return null;
    }
    this.dedupeKeys.add(input.sourceDedupeKey);
    this.seq += 1;
    const row: NotifyMessageRow = {
      id: this.seq,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      status: "unread",
      refType: input.refType,
      refId: input.refId,
      templateCode: input.templateCode,
      sourceDedupeKey: input.sourceDedupeKey,
      mergeKey: input.mergeKey,
      mergedCount: 1,
      mergedIntoId: null,
      deliverAt: new Date("2026-09-28T06:00:00.000Z"),
      deliveredAt: null,
      snoozeUntil: null,
      createdAt: new Date("2026-09-28T06:00:00.000Z"),
    };
    this.rows.push(row);
    return row;
  }

  async findBySourceDedupeKey(sourceDedupeKey: string, _tx?: unknown): Promise<NotifyMessageRow | null> {
    return this.rows.find((row) => row.sourceDedupeKey === sourceDedupeKey) ?? null;
  }

  async listDue(now: Date, limit: number): Promise<NotifyMessageRow[]> {
    return this.rows
      .filter((row) => row.mergedIntoId === null && row.deliveredAt === null && row.deliverAt.getTime() <= now.getTime())
      .sort((a, b) => a.deliverAt.getTime() - b.deliverAt.getTime() || a.id - b.id)
      .slice(0, limit);
  }

  async findMergeTarget(
    input: { recipientId: string; mergeKey: string; since: Date; excludeId: number },
    _tx?: unknown,
  ): Promise<NotifyMessageRow | null> {
    const matches = this.rows.filter(
      (row) =>
        row.recipientId === input.recipientId &&
        row.mergeKey === input.mergeKey &&
        row.mergedIntoId === null &&
        row.status === "unread" &&
        row.createdAt.getTime() >= input.since.getTime() &&
        row.id < input.excludeId,
    );
    const latest = matches[matches.length - 1] ?? null;
    return latest;
  }

  async attachMerged(input: { childId: number; parentId: number; at: Date }, _tx?: unknown): Promise<void> {
    const child = this.rows.find((row) => row.id === input.childId);
    const parent = this.rows.find((row) => row.id === input.parentId);
    if (child === undefined || parent === undefined) throw new Error("fake attachMerged：行不存在");
    child.mergedIntoId = parent.id;
    parent.mergedCount += 1;
  }

  async markDelivered(id: number, at: Date, _tx?: unknown): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) throw new Error("fake markDelivered：行不存在");
    row.deliveredAt = at;
    this.delivered.push(id);
  }

  async postpone(id: number, deliverAt: Date, _at: Date, _tx?: unknown): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) throw new Error("fake postpone：行不存在");
    row.deliverAt = deliverAt;
    this.postponed.push({ id, deliverAt });
  }

  async countDeliveredSince(recipientId: string, since: Date, _tx?: unknown): Promise<number> {
    return this.rows.filter(
      (row) =>
        row.recipientId === recipientId &&
        row.mergedIntoId === null &&
        row.deliveredAt !== null &&
        row.deliveredAt.getTime() >= since.getTime(),
    ).length;
  }

  async listInbox(recipientId: string, filter: NotifyInboxFilter): Promise<{ rows: NotifyMessageRow[]; total: number }> {
    const matches = this.rows
      .filter((row) => row.recipientId === recipientId && row.mergedIntoId === null && row.deliveredAt !== null)
      .filter((row) => filter.status === null || row.status === filter.status)
      .filter((row) => filter.type === null || row.type === filter.type)
      .filter((row) => filter.refType === null || row.refType === filter.refType)
      .filter((row) => filter.from === null || (row.deliveredAt?.getTime() ?? 0) >= filter.from.getTime())
      .filter((row) => filter.to === null || (row.deliveredAt?.getTime() ?? 0) <= filter.to.getTime())
      .sort((a, b) => b.id - a.id);
    return { rows: matches.slice((filter.page - 1) * filter.limit, filter.page * filter.limit), total: matches.length };
  }

  async countUnread(recipientId: string, _tx?: unknown): Promise<number> {
    return this.rows.filter(
      (row) =>
        row.recipientId === recipientId && row.mergedIntoId === null && row.status === "unread" && row.deliveredAt !== null,
    ).length;
  }

  async findByIdForRecipient(id: number, recipientId: string): Promise<NotifyMessageRow | null> {
    return this.rows.find((row) => row.id === id && row.recipientId === recipientId) ?? null;
  }

  async markStatus(id: number, status: string, at: Date): Promise<NotifyMessageRow> {
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) throw new Error("fake markStatus：行不存在");
    row.status = status;
    return row;
  }

  async markAllRead(recipientId: string, _at: Date): Promise<number> {
    let updated = 0;
    for (const row of this.rows) {
      if (row.recipientId === recipientId && row.mergedIntoId === null && row.status === "unread" && row.deliveredAt !== null) {
        row.status = "read";
        updated += 1;
      }
    }
    return updated;
  }

  async getPrefs(userId: string): Promise<NotifyPrefsRow | null> {
    return this.prefs.get(userId) ?? null;
  }

  async upsertPrefs(userId: string, patch: NotifyPrefsPatch, at: Date): Promise<NotifyPrefsRow> {
    const existing = this.prefs.get(userId);
    const row: NotifyPrefsRow = {
      userId,
      quietHours: patch.quietHours !== undefined ? patch.quietHours : (existing?.quietHours ?? null),
      dailyLimit: patch.dailyLimit !== undefined ? patch.dailyLimit : (existing?.dailyLimit ?? null),
      mergeWindowMs: patch.mergeWindowMs !== undefined ? patch.mergeWindowMs : (existing?.mergeWindowMs ?? null),
      updatedAt: at,
    };
    this.prefs.set(userId, row);
    return row;
  }
}

/** 事务替身：直接执行回调并把 tx 置空（仓储替身忽略 tx）。 */
const fakeDatabase = {
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(undefined) },
} as unknown as DatabaseService;

/** 广播发布器替身（真发布器 = 事务内 pg_notify，见 notify-stream.test.ts）。 */
class FakeStreamPublisher {
  published: NotifyStreamWireMessage[] = [];

  async publish(_client: unknown, message: NotifyStreamWireMessage): Promise<void> {
    this.published.push(message);
  }
}

function makeService(
  repo: FakeNotifyRepository,
  now: Date,
  overrides: Record<string, string> = {},
  publisher = new FakeStreamPublisher(),
  archive = new FakeNotifyDeliveryArchive(),
) {
  const env = loadEnv({
    DATABASE_URL: "postgresql://unused",
    NOTIFY_QUIET_HOURS: "22:00-08:00",
    NOTIFY_DAILY_LIMIT: "200",
    NOTIFY_MERGE_WINDOW_MS: "1800000",
    NOTIFY_DAILY_WINDOW_START_MINUTE: "480",
    ...overrides,
  });
  const clock = new ClockService();
  clock.setSource(() => now);
  return new NotifyService(repo as never, archive as never, fakeDatabase, new AppConfig(env), clock, publisher as never);
}

function claimedRow(payload: Record<string, unknown>, overrides: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow {
  return {
    id: 1,
    topic: "notify.message",
    payload,
    dedupeKey: "A01:" + REF_A + ":2026-09-28",
    attempts: 0,
    availableAt: DAYTIME,
    lockedAt: DAYTIME,
    createdAt: DAYTIME,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { recipientId: ME, type: "reminder", title: "日报未填", body: "请补填日报", ...overrides };
}

describe("站内信投递（S7-4 · j1 / M5-04 首刀）", () => {
  it("消费：合法载荷 → 落行并立即投递（deliveredAt 非空），返回 done", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);
    const outcome = await service.consume(claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "A01_INBOX_MERGED" })));
    expect(outcome).toEqual({ outcome: "done" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.delivered).toEqual([1]);
    expect(repo.rows[0]?.deliveredAt?.toISOString()).toBe(DAYTIME.toISOString());
    expect(repo.rows[0]?.mergeKey).toBe("A01_INBOX_MERGED");
    expect(repo.insertCalls[0]?.sourceTopic).toBe("notify.message");
    expect(archive.messages).toHaveLength(1);
    expect(archive.messages[0]).toMatchObject({
      outboxId: 1,
      sourceDedupeKey: claimedRow(payload()).dedupeKey,
      topic: "notify.message",
      channel: "inbox",
      recipientId: ME,
      title: "日报未填",
      body: "请补填日报",
      ruleCode: "A01",
      lastState: "sent",
      attemptCount: 0,
      sentAt: DAYTIME,
    });
  });

  it("消费：非法载荷 → dead（不落行、不重试）；仓储异常 → retry", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    const dead = await service.consume(claimedRow({ recipientId: ME, type: "unknown", title: "t", body: "b" }));
    expect(dead.outcome).toBe("dead");
    expect(repo.rows).toHaveLength(0);

    repo.failInsert = true;
    const retry = await service.consume(claimedRow(payload()));
    expect(retry.outcome).toBe("retry");
  });
  it("消费：非 inbox 渠道（wecom_app 由 OutboxModule 路由到 NotifyAppService）→ 本消费器只承载 inbox，确定性失败 dead，不落行", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    const outcome = await service.consume(claimedRow(payload({ channel: "wecom_app" })));
    expect(outcome.outcome).toBe("dead");
    expect(repo.rows).toHaveLength(0);
  });

  it("合并：窗口内同人同键未读主行 → 新行挂主行留档、主行 mergedCount=2、不单独投递", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);
    await service.consume(claimedRow(payload({ templateCode: "A01_INBOX_MERGED" })));
    await service.consume(
      claimedRow(payload({ title: "第二个项目未填", templateCode: "A01_INBOX_MERGED" }), { id: 2, dedupeKey: "A01:" + REF_A + ":p2" }),
    );
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[1]?.mergedIntoId).toBe(1);
    expect(repo.rows[1]?.deliveredAt).toBeNull();
    expect(repo.rows[0]?.mergedCount).toBe(2);
    expect(repo.delivered).toEqual([1]);
    expect(archive.messages).toHaveLength(2);
    expect(archive.messages[1]).toMatchObject({
      lastState: "sent",
      attemptCount: 0,
      metadata: { mergedIntoId: 1 },
    });
  });

  it("合并：超出窗口 / 键不同 / 主行已读 → 不合并，各自成行", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME, { NOTIFY_MERGE_WINDOW_MS: "60000" });
    await service.consume(claimedRow(payload({ templateCode: "A01" })));
    repo.rows[0]!.createdAt = new Date(DAYTIME.getTime() - 120000);
    await service.consume(claimedRow(payload({ templateCode: "A01" }), { id: 2, dedupeKey: "k2" }));
    await service.consume(claimedRow(payload({ templateCode: "R02" }), { id: 3, dedupeKey: "k3" }));
    expect(repo.rows.every((row) => row.mergedIntoId === null)).toBe(true);
    expect(repo.delivered).toEqual([1, 2, 3]);
  });

  it("合并：mergeWindowMs=0（偏好关闭合并）→ 不合并", async () => {
    const repo = new FakeNotifyRepository();
    repo.prefs.set(ME, { userId: ME, quietHours: null, dailyLimit: null, mergeWindowMs: 0, updatedAt: DAYTIME });
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "A01" })));
    await service.consume(claimedRow(payload({ templateCode: "A01" }), { id: 2, dedupeKey: "k2" }));
    expect(repo.rows[1]?.mergedIntoId).toBeNull();
    expect(repo.rows[0]?.mergedCount).toBe(1);
  });

  it("幂等重放：同 source_dedupe_key 再消费 → done 且不重复落行", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);
    await service.consume(claimedRow(payload()));
    const again = await service.consume(claimedRow(payload()));
    expect(again).toEqual({ outcome: "done" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.delivered).toEqual([1]);
    expect(archive.messages).toHaveLength(1);
  });

  it("归档失败：不继续写 notifications，交 outbox retry", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    archive.failEnsure = true;
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry", error: expect.stringContaining("fake 消息归档写库失败") });
    expect(repo.insertCalls).toEqual([]);
    expect(repo.rows).toEqual([]);
  });

  it("C5-04 降级副本：:c504 单独归档并保留来源键", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);

    await service.deliverInboxCopy(
      { recipientId: ME, type: "reminder", title: "降级", body: "企微未送达", mergeKey: null },
      "notify.message",
      "R02:" + REF_A + ":v5:app:c504",
    );

    expect(archive.messages).toHaveLength(1);
    expect(archive.messages[0]).toMatchObject({
      outboxId: null,
      channel: "inbox",
      sourceDedupeKey: "R02:" + REF_A + ":v5:app:c504",
      metadata: { c5_04: true, sourceDedupeKey: "R02:" + REF_A + ":v5:app" },
      lastState: "sent",
    });
  });

  it("免打扰：静默排期到时段结束（次日补发），flush 到期后真正投递", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const night = makeService(repo, NIGHT, {}, new FakeStreamPublisher(), archive);
    await night.consume(claimedRow(payload()));
    expect(repo.rows[0]?.deliveredAt).toBeNull();
    expect(repo.postponed[0]?.deliverAt.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(repo.delivered).toEqual([]);
    expect(archive.messages[0]).toMatchObject({ lastState: "deferred", lastError: expect.stringContaining("quiet_hours") });

    const nextMorning = makeService(
      repo,
      new Date("2026-09-29T00:30:00.000Z"),
      {},
      new FakeStreamPublisher(),
      archive,
    );
    const stats = await nextMorning.flushDue();
    expect(stats).toEqual({ scanned: 1, delivered: 1, merged: 0, postponed: 0 });
    expect(repo.rows[0]?.deliveredAt?.toISOString()).toBe("2026-09-29T00:30:00.000Z");
    expect(archive.messages[0]).toMatchObject({
      lastState: "sent",
      lastError: null,
      sentAt: new Date("2026-09-29T00:30:00.000Z"),
    });
  });

  it("每日上限：当日已满 → 排到次日窗口起点；次日未到（上限未重置）再排期", async () => {
    const repo = new FakeNotifyRepository();
    repo.prefs.set(ME, { userId: ME, quietHours: "", dailyLimit: 1, mergeWindowMs: 0, updatedAt: DAYTIME });
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "R02" })));
    await service.consume(claimedRow(payload({ title: "第二条", templateCode: "R03" }), { id: 2, dedupeKey: "k2" }));
    expect(repo.rows[0]?.deliveredAt).not.toBeNull();
    expect(repo.rows[1]?.deliveredAt).toBeNull();
    expect(repo.postponed[0]?.deliverAt.toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });

  it("每日上限：次日窗口起点仍在上限日之外也不破例 —— flush 时上限未到点则继续再排期", async () => {
    const repo = new FakeNotifyRepository();
    repo.prefs.set(ME, { userId: ME, quietHours: "", dailyLimit: 1, mergeWindowMs: 0, updatedAt: DAYTIME });
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "R02" })));
    await service.consume(claimedRow(payload({ templateCode: "R03" }), { id: 2, dedupeKey: "k2" }));
    // 手动把 flush 时钟拨到次日窗口后：当日已投递 0 条 → 直接投递。
    const nextDay = makeService(repo, new Date("2026-09-29T00:00:00.000Z"));
    const stats = await nextDay.flushDue();
    expect(stats).toEqual({ scanned: 1, delivered: 1, merged: 0, postponed: 0 });
  });

  it("延迟投递排空：到期行命中合并目标 → 并入主行（不新增可见行）", async () => {
    const repo = new FakeNotifyRepository();
    repo.prefs.set(ME, { userId: ME, quietHours: null, dailyLimit: null, mergeWindowMs: DAY_MS, updatedAt: NIGHT });
    const night = makeService(repo, NIGHT);
    await night.consume(claimedRow(payload({ templateCode: "A01" })));
    await night.consume(claimedRow(payload({ templateCode: "A01" }), { id: 2, dedupeKey: "k2" }));
    // 两行都在静默排期，消费时第二行已并入第一行；手工拆开以验证 flush 的合并路径
    // （只并入更早的行 → 主行恒为 id=1：早行先投递、晚行再并入）。
    repo.rows[1]!.mergedIntoId = null;
    repo.rows[0]!.mergedCount = 1;
    const nextMorning = makeService(repo, new Date("2026-09-29T00:30:00.000Z"));
    const stats = await nextMorning.flushDue();
    expect(stats).toEqual({ scanned: 2, delivered: 1, merged: 1, postponed: 0 });
    expect(repo.rows[0]?.deliveredAt).not.toBeNull();
    expect(repo.rows[1]?.mergedIntoId).toBe(1);
    expect(repo.rows[0]?.mergedCount).toBe(2);
  });

  it("收件箱：过滤（状态 / 类型 / 关联对象 / 区间）+ 未读角标 + 分页；未投递与合并子行不返回", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "R02", refType: "task", refId: REF_A })));
    await service.consume(
      claimedRow(payload({ type: "broadcast", templateCode: "A02_GROUP" }), { id: 2, dedupeKey: "k2" }),
    );
    await service.consume(claimedRow(payload({ templateCode: "R03" }), { id: 3, dedupeKey: "k3" }));
    const all = await service.list(ME, { page: 1, limit: 50 });
    expect(all.total).toBe(3);
    expect(all.unreadCount).toBe(3);
    expect(all.items.map((item) => item.id)).toEqual([3, 2, 1]);

    const reminders = await service.list(ME, { type: "reminder", page: 1, limit: 50 });
    expect(reminders.total).toBe(2);
    expect(reminders.unreadCount).toBe(3);
    const byRef = await service.list(ME, { refType: "task", page: 1, limit: 50 });
    expect(byRef.items.map((item) => item.refType)).toEqual(["task"]);
    const paged = await service.list(ME, { page: 2, limit: 2 });
    expect(paged.items.map((item) => item.id)).toEqual([1]);

    const other = await service.list(OTHER, { page: 1, limit: 50 });
    expect(other.total).toBe(0);
  });

  it("标记：本人已投递行 → 已读 / 已处理；他人 / 合并子行 / 未投递行统一 404", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "R02" })));
    const read = await service.mark(ME, 1, "read");
    expect(read.status).toBe("read");
    const handled = await service.mark(ME, 1, "handled");
    expect(handled.status).toBe("handled");
    await expect(service.mark(OTHER, 1, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.mark(ME, 99, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });

    repo.rows[0]!.mergedIntoId = 1;
    await expect(service.mark(ME, 1, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    repo.rows[0]!.mergedIntoId = null;
    repo.rows[0]!.deliveredAt = null;
    await expect(service.mark(ME, 1, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("全部已读：只动本人已投递未读行；幂等（再次 updated=0）", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    await service.consume(claimedRow(payload({ templateCode: "R02" })));
    await service.consume(claimedRow(payload({ templateCode: "R03" }), { id: 2, dedupeKey: "k2" }));
    const result = await service.markAllRead(ME);
    expect(result).toEqual({ updated: 2, unreadCount: 0 });
    expect(await service.markAllRead(ME)).toEqual({ updated: 0, unreadCount: 0 });
  });

  it("通知偏好：无行 → env 缺省生效值；三态切换与局部更新；空更新 400", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    const defaults = await service.getPrefs(ME);
    expect(defaults).toEqual({
      quietHours: "default",
      quietFrom: "22:00",
      quietTo: "08:00",
      dailyLimit: 200,
      mergeWindowMs: 1800000,
      updatedAt: null,
    });

    const off = await service.updatePrefs(ME, { quietHours: "off" });
    expect(off.quietHours).toBe("off");
    expect(off.quietFrom).toBeNull();
    expect(off.quietTo).toBeNull();
    expect(off.dailyLimit).toBe(200);

    const custom = await service.updatePrefs(ME, { quietHours: "12:00-13:00", dailyLimit: 5 });
    expect(custom.quietFrom).toBe("12:00");
    expect(custom.quietTo).toBe("13:00");
    expect(custom.dailyLimit).toBe(5);
    expect(custom.updatedAt).toBe(DAYTIME.toISOString());

    const partial = await service.updatePrefs(ME, { mergeWindowMs: 0 });
    expect(partial.quietHours).toBe("12:00-13:00");
    expect(partial.dailyLimit).toBe(5);
    expect(partial.mergeWindowMs).toBe(0);

    const back = await service.updatePrefs(ME, { quietHours: "default" });
    expect(back.quietFrom).toBe("22:00");
    await expect(service.updatePrefs(ME, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("列表：投递时刻区间倒挂 → 400 VALIDATION_FAILED", async () => {
    const repo = new FakeNotifyRepository();
    const service = makeService(repo, DAYTIME);
    await expect(
      service.list(ME, { from: "2026-09-29T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z", page: 1, limit: 50 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("实时流发布：投递发 notification（契约行）+ unread（角标）；合并 / 幂等重放不发", async () => {
    const repo = new FakeNotifyRepository();
    const publisher = new FakeStreamPublisher();
    const service = makeService(repo, DAYTIME, {}, publisher);
    await service.consume(claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R02" })));
    expect(publisher.published).toEqual([
      {
        recipientId: ME,
        event: "notification",
        data: expect.objectContaining({
          id: 1,
          type: "reminder",
          title: "日报未填",
          status: "unread",
          mergedCount: 1,
          snoozeUntil: null,
          deliveredAt: DAYTIME.toISOString(),
        }),
      },
      { recipientId: ME, event: "unread", data: { unreadCount: 1 } },
    ]);

    // 同期合并（同 mergeKey 第二条）：未读数无变化 → 不发。
    await service.consume(
      claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R02" }), { id: 2, dedupeKey: "k2" }),
    );
    expect(repo.rows[1]?.mergedIntoId).toBe(1);
    expect(publisher.published).toHaveLength(2);

    // 幂等重放（同 dedupeKey）：duplicate → 不发。
    await service.consume(claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R02" })));
    expect(publisher.published).toHaveLength(2);
  });

  it("重复消费补归档：历史通知已投递但归档缺失 → sent，不重发", async () => {
    const repo = new FakeNotifyRepository();
    const publisher = new FakeStreamPublisher();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, publisher, archive);
    const row = claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R01_INBOX" }));

    await service.consume(row);
    archive.messages = [];
    await service.consume(row);

    expect(repo.rows).toHaveLength(1);
    expect(publisher.published).toHaveLength(2);
    expect(archive.messages[0]).toMatchObject({ lastState: "sent", sentAt: DAYTIME, lastError: null });
  });

  it("重复消费补归档：历史合并子行 → sent + mergedIntoId", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, DAYTIME, {}, new FakeStreamPublisher(), archive);
    const parent = claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R02" }));
    const child = claimedRow(payload({ refType: "report", refId: REF_A, templateCode: "R02" }), {
      id: 2,
      dedupeKey: "merge-child",
    });

    await service.consume(parent);
    await service.consume(child);
    archive.messages = archive.messages.filter((item) => item.sourceDedupeKey !== "merge-child");
    await service.consume(child);

    expect(repo.rows[1]?.mergedIntoId).toBe(1);
    expect(archive.messages[1]).toMatchObject({ lastState: "sent", metadata: { mergedIntoId: 1 } });
  });

  it("重复消费补归档：历史通知尚未到期 → deferred，不重发", async () => {
    const repo = new FakeNotifyRepository();
    const archive = new FakeNotifyDeliveryArchive();
    const service = makeService(repo, NIGHT, {}, new FakeStreamPublisher(), archive);
    const row = claimedRow(payload());

    await service.consume(row);
    archive.messages = [];
    await service.consume(row);

    expect(archive.messages[0]).toMatchObject({
      lastState: "deferred",
      lastError: expect.stringContaining("待排期"),
    });
  });

  it("实时流发布：免打扰排期不发；flush 补投按同口径发", async () => {
    const repo = new FakeNotifyRepository();
    const publisher = new FakeStreamPublisher();
    const night = makeService(repo, NIGHT, {}, publisher);
    await night.consume(claimedRow(payload()));
    expect(repo.postponed).toHaveLength(1);
    expect(publisher.published).toHaveLength(0);

    const nextMorning = makeService(repo, new Date("2026-09-29T00:30:00.000Z"), {}, publisher);
    expect(await nextMorning.flushDue()).toEqual({ scanned: 1, delivered: 1, merged: 0, postponed: 0 });
    expect(publisher.published).toEqual([
      {
        recipientId: ME,
        event: "notification",
        data: expect.objectContaining({ id: 1, deliveredAt: "2026-09-29T00:30:00.000Z" }),
      },
      { recipientId: ME, event: "unread", data: { unreadCount: 1 } },
    ]);
  });

  it("实时流发布：标记改未读数发 unread；同值幂等与全部已读空操作不发", async () => {
    const repo = new FakeNotifyRepository();
    const publisher = new FakeStreamPublisher();
    const service = makeService(repo, DAYTIME, {}, publisher);
    await service.consume(claimedRow(payload()));
    expect(publisher.published).toHaveLength(2);

    await service.mark(ME, 1, "read");
    expect(publisher.published[2]).toEqual({ recipientId: ME, event: "unread", data: { unreadCount: 0 } });

    await service.mark(ME, 1, "read");
    expect(publisher.published).toHaveLength(3);

    await service.mark(ME, 1, "unread");
    expect(publisher.published[3]).toEqual({ recipientId: ME, event: "unread", data: { unreadCount: 1 } });

    await service.markAllRead(ME);
    expect(publisher.published[4]).toEqual({ recipientId: ME, event: "unread", data: { unreadCount: 0 } });

    await service.markAllRead(ME);
    expect(publisher.published).toHaveLength(5);
  });

  it("实时流发布：非法载荷 dead 与越权 404 均不发事件", async () => {
    const repo = new FakeNotifyRepository();
    const publisher = new FakeStreamPublisher();
    const service = makeService(repo, DAYTIME, {}, publisher);
    expect(await service.consume(claimedRow({ title: "", body: "" }))).toMatchObject({ outcome: "dead" });
    expect(publisher.published).toHaveLength(0);

    await service.consume(claimedRow(payload()));
    expect(publisher.published).toHaveLength(2);
    await expect(service.mark(OTHER, 1, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(publisher.published).toHaveLength(2);
  });
});
