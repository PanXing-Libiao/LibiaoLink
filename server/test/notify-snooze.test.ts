/**
 * 稍后提醒服务回归（S8-3 · M5-04-2 · C5-05）：设置（置读 / 毫秒截断到秒 / 覆盖）/ 取消（幂等）/ 记录读面 /
 * 范围校验 400 / 404 族（他人 · 合并子行 · 未投递）/ 到点触发（重投原行 + `notification` / `unread` 广播 +
 * 记录回填）/ 免打扰顺延 / handled 行照提醒 / 不消耗每日上限 / 单行失败不阻塞。
 * 仓储 / 时钟 / 配置全替身，不连库；真机口径见 server/scripts/m5-04-2-snooze-replay.mjs。
 */
import { NOTIFICATION_SNOOZE_MAX_AHEAD_MS, NOTIFICATION_SNOOZE_MIN_LEAD_MS } from "@libiaolink/contracts";
import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import { FakeNotifyDeliveryArchive } from "./fakes/notify-delivery-archive.fake.js";
import { loadEnv } from "../src/config/env.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type {
  NotificationSnoozeRow,
  NotifyMessageRow,
  NotifyPrefsRow,
} from "../src/modules/notify/notify.repository.js";
import { NotifyService } from "../src/modules/notify/notify.service.js";
import type { NotifyStreamWireMessage } from "../src/modules/notify/notify.stream.js";

const ME = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** 固定时钟：上海 2026-09-28 14:00（= UTC 06:00，非免打扰）。 */
const DAYTIME = new Date("2026-09-28T06:00:00.000Z");
/** 固定时钟：上海 2026-09-28 23:00（= UTC 15:00，在缺省免打扰 22:00-08:00 内）。 */
const NIGHT = new Date("2026-09-28T15:00:00.000Z");
/** 免打扰 22:00-08:00 自 NIGHT 起的时段结束（上海 09-29 08:00 = UTC 09-29 00:00）。 */
const NIGHT_QUIET_END = new Date("2026-09-29T00:00:00.000Z");

class FakeSnoozeRepository {
  rows: NotifyMessageRow[] = [];
  snoozes: NotificationSnoozeRow[] = [];
  prefs = new Map<string, NotifyPrefsRow>();
  /** 指定行触发失败（单行失败不阻塞回归用）。 */
  failTriggerIds = new Set<number>();
  private snoozeSeq = 0;

  seedRow(overrides: Partial<NotifyMessageRow> = {}): NotifyMessageRow {
    const row: NotifyMessageRow = {
      id: this.rows.length + 1,
      recipientId: ME,
      type: "reminder",
      title: "日报未填",
      body: "请补填日报",
      status: "unread",
      refType: null,
      refId: null,
      templateCode: null,
      sourceDedupeKey: "A01:-:-",
      mergeKey: "A01:-:-",
      mergedCount: 1,
      mergedIntoId: null,
      deliverAt: DAYTIME,
      deliveredAt: DAYTIME,
      snoozeUntil: null,
      createdAt: DAYTIME,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  async resolveProjectIds(_refs: readonly { refType: string | null; refId: string | null }[]): Promise<Map<string, string>> {
    return new Map();
  }

  async findByIdForRecipient(id: number, recipientId: string): Promise<NotifyMessageRow | null> {
    return this.rows.find((row) => row.id === id && row.recipientId === recipientId) ?? null;
  }

  async setSnooze(notificationId: number, until: Date, at: Date): Promise<NotifyMessageRow> {
    for (const item of this.snoozes) {
      if (item.notificationId === notificationId && item.triggeredAt === null && item.cancelledAt === null) {
        item.cancelledAt = at;
      }
    }
    this.snoozeSeq += 1;
    this.snoozes.push({
      id: this.snoozeSeq,
      notificationId,
      setAt: at,
      snoozeUntil: until,
      triggeredAt: null,
      cancelledAt: null,
    });
    const row = this.mustRow(notificationId);
    row.snoozeUntil = until;
    row.status = "read";
    return row;
  }

  async cancelSnooze(notificationId: number, at: Date): Promise<NotifyMessageRow> {
    for (const item of this.snoozes) {
      if (item.notificationId === notificationId && item.triggeredAt === null && item.cancelledAt === null) {
        item.cancelledAt = at;
      }
    }
    const row = this.mustRow(notificationId);
    row.snoozeUntil = null;
    return row;
  }

  async triggerSnooze(notificationId: number, at: Date): Promise<NotifyMessageRow> {
    if (this.failTriggerIds.has(notificationId)) {
      throw new Error("fake trigger 失败（id=" + notificationId + "）");
    }
    for (const item of this.snoozes) {
      if (item.notificationId === notificationId && item.triggeredAt === null && item.cancelledAt === null) {
        item.triggeredAt = at;
      }
    }
    const row = this.mustRow(notificationId);
    row.snoozeUntil = null;
    row.status = "unread";
    return row;
  }

  async deferSnooze(notificationId: number, until: Date, _at: Date): Promise<void> {
    this.mustRow(notificationId).snoozeUntil = until;
  }

  async listDueSnoozes(now: Date, limit: number): Promise<NotifyMessageRow[]> {
    return this.rows
      .filter(
        (row) =>
          row.snoozeUntil !== null &&
          row.snoozeUntil.getTime() <= now.getTime() &&
          row.mergedIntoId === null &&
          row.deliveredAt !== null,
      )
      .sort((a, b) => (a.snoozeUntil?.getTime() ?? 0) - (b.snoozeUntil?.getTime() ?? 0) || a.id - b.id)
      .slice(0, limit);
  }

  async listSnoozes(notificationId: number): Promise<NotificationSnoozeRow[]> {
    return this.snoozes.filter((item) => item.notificationId === notificationId).sort((a, b) => b.id - a.id);
  }

  async countUnread(recipientId: string): Promise<number> {
    return this.rows.filter(
      (row) =>
        row.recipientId === recipientId && row.mergedIntoId === null && row.status === "unread" && row.deliveredAt !== null,
    ).length;
  }

  async getPrefs(userId: string): Promise<NotifyPrefsRow | null> {
    return this.prefs.get(userId) ?? null;
  }

  private mustRow(id: number): NotifyMessageRow {
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) {
      throw new Error("fake 行不存在：" + id);
    }
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

function makeService(repo: FakeSnoozeRepository, initialNow: Date, overrides: Record<string, string> = {}) {
  const env = loadEnv({
    DATABASE_URL: "postgresql://unused",
    NOTIFY_QUIET_HOURS: "22:00-08:00",
    NOTIFY_DAILY_LIMIT: "200",
    NOTIFY_MERGE_WINDOW_MS: "1800000",
    NOTIFY_DAILY_WINDOW_START_MINUTE: "480",
    ...overrides,
  });
  const clock = new ClockService();
  let now = initialNow;
  clock.setSource(() => now);
  const publisher = new FakeStreamPublisher();
  const service = new NotifyService(
    repo as never,
    new FakeNotifyDeliveryArchive() as never,
    fakeDatabase,
    new AppConfig(env),
    clock,
    publisher as never,
  );
  return {
    service,
    publisher,
    setNow: (value: Date): void => {
      now = value;
    },
  };
}

/** 请求体用时刻：自基准 + 偏移（毫秒）。 */
function at(base: Date, offsetMs: number): { snoozeUntil: string } {
  return { snoozeUntil: new Date(base.getTime() + offsetMs).toISOString() };
}

describe("稍后提醒（S8-3 · M5-04-2 · C5-05）", () => {
  it("设置：unread 行 → 置读 + snoozeUntil 毫秒截断到秒 + 记录一条 + 只发 unread 快照（不发 notification）", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service, publisher } = makeService(repo, DAYTIME);
    const target = new Date(DAYTIME.getTime() + 60 * MINUTE_MS + 1234);
    const expected = new Date(Math.floor(target.getTime() / 1000) * 1000);

    const result = await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS + 1234));

    expect(result.status).toBe("read");
    expect(result.snoozeUntil).toBe(expected.toISOString());
    expect(repo.rows[0]?.snoozeUntil?.toISOString()).toBe(expected.toISOString());
    expect(repo.snoozes).toHaveLength(1);
    expect(repo.snoozes[0]?.setAt.toISOString()).toBe(DAYTIME.toISOString());
    expect(repo.snoozes[0]?.snoozeUntil.toISOString()).toBe(expected.toISOString());
    expect(publisher.published).toEqual([{ recipientId: ME, event: "unread", data: { unreadCount: 0 } }]);
  });

  it("覆盖：重复设置 → 旧记录标 cancelledAt + 新记录；行上 snoozeUntil 取新值；记录读面按 id 降序", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service } = makeService(repo, DAYTIME);

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    const second = await service.snooze(ME, 1, at(DAYTIME, 120 * MINUTE_MS));
    const expected = new Date(Math.floor((DAYTIME.getTime() + 120 * MINUTE_MS) / 1000) * 1000);

    expect(second.snoozeUntil).toBe(expected.toISOString());
    expect(repo.snoozes).toHaveLength(2);
    expect(repo.snoozes[0]?.cancelledAt?.toISOString()).toBe(DAYTIME.toISOString());
    expect(repo.snoozes[1]?.cancelledAt).toBeNull();
    const listed = await service.listSnoozes(ME, 1);
    expect(listed.items).toHaveLength(2);
    expect(listed.items[0]?.id).toBe(2);
    expect(listed.items[0]?.cancelledAt).toBeNull();
    expect(listed.items[1]?.id).toBe(1);
    expect(listed.items[1]?.cancelledAt).toBe(DAYTIME.toISOString());
  });

  it("设置：已读 / 已处理行均可设置 —— handled 行置读（定案 ②）；未读数无变化不发事件", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow({ status: "read" });
    repo.seedRow({ status: "handled" });
    const { service, publisher } = makeService(repo, DAYTIME);

    const read = await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    const handled = await service.snooze(ME, 2, at(DAYTIME, 60 * MINUTE_MS));

    expect(read.status).toBe("read");
    expect(handled.status).toBe("read");
    expect(publisher.published).toEqual([]);
  });

  it("范围校验：过近（毫秒截断后 ≤ now + 5 分钟）与过远（> now + 30 天）400；边界内接受", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service } = makeService(repo, DAYTIME);

    await expect(service.snooze(ME, 1, at(DAYTIME, NOTIFICATION_SNOOZE_MIN_LEAD_MS))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    // 毫秒先向下取整到秒再校验：+5min+500ms → 截断为 +5min → 过近。
    await expect(service.snooze(ME, 1, at(DAYTIME, NOTIFICATION_SNOOZE_MIN_LEAD_MS + 500))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    // +5min+1500ms → 截断为 +5min+1s → 合法。
    const ok = await service.snooze(ME, 1, at(DAYTIME, NOTIFICATION_SNOOZE_MIN_LEAD_MS + 1500));
    expect(ok.snoozeUntil).toBe(
      new Date(Math.floor((DAYTIME.getTime() + NOTIFICATION_SNOOZE_MIN_LEAD_MS + 1000) / 1000) * 1000).toISOString(),
    );
    // 上界为含：= now + 30 天可收；再多 1 秒拒绝。
    await service.snooze(ME, 1, at(DAYTIME, NOTIFICATION_SNOOZE_MAX_AHEAD_MS));
    await expect(service.snooze(ME, 1, at(DAYTIME, NOTIFICATION_SNOOZE_MAX_AHEAD_MS + 1000))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("404 族：他人行 / 合并子行 / 未投递行统一 NOT_FOUND（设置 / 取消 / 记录读面同口径）", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow({ recipientId: OTHER });
    repo.seedRow({ mergedIntoId: 99 });
    repo.seedRow({ deliveredAt: null });
    const { service } = makeService(repo, DAYTIME);

    await expect(service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.snooze(ME, 2, at(DAYTIME, 60 * MINUTE_MS))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.snooze(ME, 3, at(DAYTIME, 60 * MINUTE_MS))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.unsnooze(ME, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.listSnoozes(ME, 3)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.listSnoozes(ME, 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("取消：活跃记录标 cancelledAt + 清 snoozeUntil（状态不回滚）；无未触发也 200（幂等）；不发事件", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service, publisher } = makeService(repo, DAYTIME);

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    publisher.published.length = 0;
    const cancelled = await service.unsnooze(ME, 1);

    expect(cancelled.snoozeUntil).toBeNull();
    expect(cancelled.status).toBe("read");
    expect(repo.snoozes[0]?.cancelledAt?.toISOString()).toBe(DAYTIME.toISOString());
    expect(publisher.published).toEqual([]);

    const again = await service.unsnooze(ME, 1);
    expect(again.snoozeUntil).toBeNull();
    expect(repo.snoozes).toHaveLength(1);
  });

  it("触发：到期行置回 unread + 清 snoozeUntil + 记录回填 triggeredAt + 推 notification 后 unread（deliveredAt 留档）", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service, publisher } = makeService(repo, DAYTIME);

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    const row = repo.rows[0];
    if (row === undefined) {
      throw new Error("seed 行缺失");
    }
    row.snoozeUntil = new Date(DAYTIME.getTime() - 1000);
    publisher.published.length = 0;

    const stats = await service.flushSnoozes();

    expect(stats).toEqual({ scanned: 1, triggered: 1, deferred: 0 });
    expect(row.status).toBe("unread");
    expect(row.snoozeUntil).toBeNull();
    expect(row.deliveredAt?.toISOString()).toBe(DAYTIME.toISOString());
    expect(repo.snoozes[0]?.triggeredAt?.toISOString()).toBe(DAYTIME.toISOString());
    expect(publisher.published).toHaveLength(2);
    const [first, secondEvent] = publisher.published;
    expect(first?.event).toBe("notification");
    if (first?.event === "notification") {
      expect(first.data.status).toBe("unread");
      expect(first.data.snoozeUntil).toBeNull();
      expect(first.data.deliveredAt).toBe(DAYTIME.toISOString());
    }
    expect(secondEvent).toEqual({ recipientId: ME, event: "unread", data: { unreadCount: 1 } });
  });

  it("触发：handled 行照提醒（定案 ④）—— snooze 后重新置 handled，到点仍置回 unread", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow({ status: "handled" });
    const { service } = makeService(repo, DAYTIME);

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    const row = repo.rows[0];
    if (row === undefined) {
      throw new Error("seed 行缺失");
    }
    row.status = "handled";
    row.snoozeUntil = new Date(DAYTIME.getTime() - 1000);

    const stats = await service.flushSnoozes();

    expect(stats.triggered).toBe(1);
    expect(row.status).toBe("unread");
  });

  it("免打扰顺延：到点落在免打扰时段 → snoozeUntil 推到时段结束、不发事件；时段结束后下一轮触发", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service, publisher, setNow } = makeService(repo, NIGHT);

    await service.snooze(ME, 1, at(NIGHT, 60 * MINUTE_MS));
    const row = repo.rows[0];
    if (row === undefined) {
      throw new Error("seed 行缺失");
    }
    row.snoozeUntil = new Date(NIGHT.getTime() - 1000);
    publisher.published.length = 0;

    const deferred = await service.flushSnoozes();

    expect(deferred).toEqual({ scanned: 1, triggered: 0, deferred: 1 });
    expect(row.snoozeUntil?.toISOString()).toBe(NIGHT_QUIET_END.toISOString());
    expect(row.status).toBe("read");
    expect(repo.snoozes[0]?.triggeredAt).toBeNull();
    expect(publisher.published).toEqual([]);

    const notYet = await service.flushSnoozes();
    expect(notYet).toEqual({ scanned: 0, triggered: 0, deferred: 0 });

    setNow(NIGHT_QUIET_END);
    const triggered = await service.flushSnoozes();
    expect(triggered).toEqual({ scanned: 1, triggered: 1, deferred: 0 });
    expect(row.status).toBe("unread");
    expect(repo.snoozes[0]?.triggeredAt?.toISOString()).toBe(NIGHT_QUIET_END.toISOString());
  });

  it("不消耗每日上限：限额已满 / 当日已投递达上限仍照常触发（用户主动重提醒，非新投递）", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    const { service } = makeService(repo, DAYTIME, { NOTIFY_DAILY_LIMIT: "1" });

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    const row = repo.rows[0];
    if (row === undefined) {
      throw new Error("seed 行缺失");
    }
    row.snoozeUntil = new Date(DAYTIME.getTime() - 1000);

    const stats = await service.flushSnoozes();

    expect(stats.triggered).toBe(1);
    expect(row.status).toBe("unread");
  });

  it("单行失败不阻塞：失败行留在下一轮重扫，同批其余行照常触发", async () => {
    const repo = new FakeSnoozeRepository();
    repo.seedRow();
    repo.seedRow();
    const { service } = makeService(repo, DAYTIME);

    await service.snooze(ME, 1, at(DAYTIME, 60 * MINUTE_MS));
    await service.snooze(ME, 2, at(DAYTIME, 60 * MINUTE_MS));
    for (const row of repo.rows) {
      row.snoozeUntil = new Date(DAYTIME.getTime() - 1000);
    }
    repo.failTriggerIds.add(1);

    const first = await service.flushSnoozes();
    expect(first).toEqual({ scanned: 2, triggered: 1, deferred: 0 });
    expect(repo.rows[0]?.status).toBe("read");
    expect(repo.rows[0]?.snoozeUntil).not.toBeNull();
    expect(repo.rows[1]?.status).toBe("unread");

    repo.failTriggerIds.clear();
    const second = await service.flushSnoozes();
    expect(second).toEqual({ scanned: 1, triggered: 1, deferred: 0 });
    expect(repo.rows[0]?.status).toBe("unread");
  });
});
