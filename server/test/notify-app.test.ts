/**
 * 应用消息消费回归（M5-03-3 · outbox 主题 notify.message 的 channel=wecom_app 分支）：
 * 文本组装与字节截断、消费三分类（ok / rate_limited / retryable / permanent → done / deferred /
 * retry / dead + 投递留痕）、收件人不可投递收敛（不存在不降级；停用 / 离职 / userid 缺失 → dead + 降级）、
 * C5-04 降级（同收件人站内信 · :c504）与降级失败 retry、渠道路由防御。仓储 / HTTP 客户端 / 站内信 / 时钟全替身。
 */
import { describe, expect, it } from "vitest";
import type { NotifyMessagePayload } from "@libiaolink/contracts";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import type { WecomAppContact } from "../src/modules/notify/notify.app.repository.js";
import {
  APP_DEGRADE_PREFIX,
  APP_TEXT_MAX_BYTES,
  APP_TRUNCATION_SUFFIX,
  composeAppText,
  maskUserid,
  NotifyAppService,
  truncateAppText,
} from "../src/modules/notify/notify.app.service.js";
import type { WecomClient, WecomSendResult } from "../src/modules/notify/wecom.client.js";
import { FakeNotifyDeliveryArchive } from "./fakes/notify-delivery-archive.fake.js";

const AT = new Date("2026-10-12T06:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USERID = "zhangsan";

class FakeAppRepository {
  readonly archive = new FakeNotifyDeliveryArchive();
  contacts = new Map<string, WecomAppContact>();

  get deliveries() {
    return this.archive.attempts;
  }

  async findContact(userId: string): Promise<WecomAppContact | null> {
    return this.contacts.get(userId) ?? null;
  }

}

class FakeWecomClient {
  sends: { toUser: readonly string[]; content: string }[] = [];
  result: WecomSendResult = { ok: true, retriedToken: false, attempts: 1 };

  async sendAppText(params: { toUser: readonly string[]; content: string }): Promise<WecomSendResult> {
    this.sends.push(params);
    return this.result;
  }
}

/** C5-04 降级站内信替身（NotifyService.deliverInboxCopy 端口）。 */
class FakeNotifyInbox {
  copies: { message: NotifyMessagePayload; topic: string; dedupeKey: string }[] = [];
  fail = false;

  async deliverInboxCopy(
    message: NotifyMessagePayload,
    topic: string,
    dedupeKey: string,
  ): Promise<{ duplicate: boolean }> {
    if (this.fail) {
      throw new Error("fake 站内信写库失败");
    }
    this.copies.push({ message, topic, dedupeKey });
    return { duplicate: false };
  }
}

function makeService(): {
  service: NotifyAppService;
  repo: FakeAppRepository;
  client: FakeWecomClient;
  inbox: FakeNotifyInbox;
  archive: FakeNotifyDeliveryArchive;
} {
  const repo = new FakeAppRepository();
  const client = new FakeWecomClient();
  const inbox = new FakeNotifyInbox();
  const clock = new ClockService();
  clock.setSource(() => AT);
  const service = new NotifyAppService(
    repo as never,
    repo.archive as never,
    client as unknown as WecomClient,
    inbox as never,
    clock,
  );
  return { service, repo, client, inbox, archive: repo.archive };
}

function contact(overrides: Partial<WecomAppContact> = {}): WecomAppContact {
  return { id: USER_ID, username: USERID, status: "active", removedAt: null, ...overrides };
}

function claimedRow(payload: Record<string, unknown>, overrides: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow {
  return {
    id: 9,
    topic: "notify.message",
    payload,
    dedupeKey: "R02:t-1:v5:app",
    attempts: 0,
    availableAt: AT,
    lockedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { recipientId: USER_ID, type: "reminder", channel: "wecom_app", title: "任务节点完成", body: "节点：到货验收 负责人：张工", ...overrides };
}

function permanent(errcode: number, errmsg: string): WecomSendResult {
  return { ok: false, kind: "permanent", errcode, errmsg, httpStatus: null, retryAt: null, retriedToken: false, attempts: 1 };
}

// ---------- 文本组装 / 截断 / 掩码（纯函数） ----------

describe("composeAppText / truncateAppText / maskUserid（纯函数）", () => {
  it("组装：标题 + 空行 + 正文（text 无 markdown）", () => {
    expect(composeAppText({ title: "T", body: "B" })).toBe("T\n\nB");
  });

  it("截断：超长按 UTF-8 字节截断（≤ 2000 字节 + 省略标记 + 不劈多字节）", () => {
    const truncated = truncateAppText("汉".repeat(3_000));

    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.content, "utf8")).toBeLessThanOrEqual(APP_TEXT_MAX_BYTES);
    expect(truncated.content.endsWith(APP_TRUNCATION_SUFFIX)).toBe(true);
    expect(truncated.content.includes("\uFFFD")).toBe(false);
  });

  it("截断：未超长原样返回", () => {
    expect(truncateAppText("短消息")).toEqual({ content: "短消息", truncated: false });
  });

  it("掩码：只回末 4 位", () => {
    expect(maskUserid(USERID)).toBe("****gsan");
  });
});

// ---------- 消费三分类 ----------

describe("NotifyAppService.consume（应用消息投递）", () => {
  it("ok：done + sent 行（target=userid / attempts / sentAt=时钟），发送文本逐字", async () => {
    const { service, repo, client, inbox, archive } = makeService();
    repo.contacts.set(USER_ID, contact());

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toEqual({ outcome: "done" });
    expect(repo.deliveries[0]).toMatchObject({ state: "sent", target: USERID, attempts: 1, error: null, sentAt: AT });
    expect(client.sends[0]!.toUser).toEqual([USERID]);
    expect(client.sends[0]!.content).toBe("任务节点完成\n\n节点：到货验收 负责人：张工");
    expect(inbox.copies).toEqual([]);
    expect(archive.messages[0]).toMatchObject({
      sourceDedupeKey: "R02:t-1:v5:app",
      topic: "notify.message",
      channel: "wecom_app",
      recipientId: USER_ID,
      ruleCode: "R02",
      lastState: "sent",
      attemptCount: 1,
      recipientLabel: maskUserid(USERID),
      sentAt: AT,
    });
    expect(archive.attempts[0]).toMatchObject({ messageId: archive.messages[0]!.id, channel: "wecom_app" });
  });

  it("重复消费：归档已 sent → done，不再发起第二次企微请求", async () => {
    const { service, repo, client, archive } = makeService();
    repo.contacts.set(USER_ID, contact());

    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });
    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });

    expect(client.sends).toHaveLength(1);
    expect(archive.messages).toHaveLength(1);
    expect(archive.attempts).toHaveLength(1);
  });

  it("重复消费：归档 failed → 允许再次尝试，成功后推进 sent", async () => {
    const { service, repo, client, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = { ok: false, kind: "retryable", errcode: -1, errmsg: "系统繁忙", httpStatus: null, retryAt: null, retriedToken: false, attempts: 1 };
    expect((await service.consume(claimedRow(payload()))).outcome).toBe("retry");

    client.result = { ok: true, retriedToken: false, attempts: 1 };
    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });

    expect(client.sends).toHaveLength(2);
    expect(archive.messages[0]).toMatchObject({ lastState: "sent", attemptCount: 2 });
  });

  it("归档失败：不调用企微，交 outbox retry", async () => {
    const { service, repo, client, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    archive.failEnsure = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry", error: expect.stringContaining("归档失败") });
    expect(client.sends).toEqual([]);
    expect(repo.deliveries).toEqual([]);
  });

  it("rate_limited：deferred + availableAt = retryAt（attempts 不消耗）", async () => {
    const { service, repo, client, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    const retryAt = new Date(AT.getTime() + 30_000);
    client.result = { ok: false, kind: "rate_limited", errcode: 45009, errmsg: "api freq out of limit", httpStatus: null, retryAt, retriedToken: false, attempts: 0 };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("deferred");
    if (outcome.outcome === "deferred") {
      expect(outcome.availableAt.getTime()).toBe(retryAt.getTime());
    }
    expect(repo.deliveries[0]).toMatchObject({ state: "deferred", attempts: 0, sentAt: null });
    expect(archive.messages[0]).toMatchObject({ lastState: "deferred", attemptCount: 1, lastError: expect.any(String) });
  });

  it("retryable：retry + failed 行", async () => {
    const { service, repo, client, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = { ok: false, kind: "retryable", errcode: -1, errmsg: "系统繁忙", httpStatus: null, retryAt: null, retriedToken: false, attempts: 1 };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("retry");
    expect(repo.deliveries[0]).toMatchObject({ state: "failed", attempts: 1 });
    expect(archive.messages[0]).toMatchObject({ lastState: "failed", attemptCount: 1, lastError: expect.any(String) });
  });

  it("permanent（60011）：dead + dead 行 + C5-04 降级（:c504 / 前缀 / 标题保留）", async () => {
    const { service, repo, client, inbox, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = permanent(60011, "invalid userid（不存在 / 离职 / 未激活 / 不在可见范围）");

    const outcome = await service.consume(
      claimedRow(payload({ refType: "task", refId: "33333333-3333-4333-8333-333333333333", templateCode: "R02_WECOM" })),
    );

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: USERID, error: expect.stringContaining("60011") });
    expect(archive.messages[0]).toMatchObject({ lastState: "dead", attemptCount: 1, lastError: expect.stringContaining("60011") });
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.topic).toBe("notify.message");
    expect(inbox.copies[0]!.dedupeKey).toBe("R02:t-1:v5:app:c504");
    expect(inbox.copies[0]!.message).toMatchObject({
      recipientId: USER_ID,
      type: "reminder",
      title: "任务节点完成",
      refType: "task",
      refId: "33333333-3333-4333-8333-333333333333",
    });
    expect(inbox.copies[0]!.message.body.startsWith(APP_DEGRADE_PREFIX)).toBe(true);
    expect(inbox.copies[0]!.message.body).toContain("节点：到货验收 负责人：张工");
  });

  it("重复消费：归档 dead → 不再发起第二次企微请求，仍按 dead 收敛", async () => {
    const { service, repo, client, inbox, archive } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = permanent(60011, "invalid userid");

    expect((await service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect((await service.consume(claimedRow(payload()))).outcome).toBe("dead");

    expect(client.sends).toHaveLength(1);
    expect(archive.attempts).toHaveLength(1);
    expect(archive.messages[0]).toMatchObject({ lastState: "dead", attemptCount: 1 });
    expect(inbox.copies.length).toBeGreaterThanOrEqual(1);
  });

  it("token_invalid（重取后仍失败）：按配置类收口 dead + 降级", async () => {
    const { service, repo, client, inbox } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = { ok: false, kind: "token_invalid", errcode: 40014, errmsg: "invalid access_token", httpStatus: null, retryAt: null, retriedToken: true, attempts: 2 };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(inbox.copies).toHaveLength(1);
  });

  it("收件人不存在：dead + dead 行（target=user:<id>）、不发送、不降级", async () => {
    const { service, repo, client, inbox } = makeService();

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: "user:" + USER_ID, attempts: 0 });
    expect(client.sends).toEqual([]);
    expect(inbox.copies).toEqual([]);
  });

  it("收件人停用 / 已删除 / userid 缺失：dead + dead 行 + 降级", async () => {
    const disabled = makeService();
    disabled.repo.contacts.set(USER_ID, contact({ status: "disabled" }));
    expect((await disabled.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(disabled.repo.deliveries[0]).toMatchObject({ state: "dead", target: USERID, error: "收件人不可投递（已停用）" });
    expect(disabled.inbox.copies).toHaveLength(1);

    const removed = makeService();
    removed.repo.contacts.set(USER_ID, contact({ removedAt: AT }));
    expect((await removed.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(removed.repo.deliveries[0]!.error).toContain("已删除");
    expect(removed.inbox.copies).toHaveLength(1);

    const nameless = makeService();
    nameless.repo.contacts.set(USER_ID, contact({ username: "  " }));
    expect((await nameless.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(nameless.repo.deliveries[0]).toMatchObject({ target: "user:" + USER_ID, error: "收件人不可投递（userid 缺失）" });
    expect(nameless.client.sends).toEqual([]);
    expect(nameless.inbox.copies).toHaveLength(1);
  });

  it("降级站内信写库失败：retry 收敛（不静默丢消息）", async () => {
    const { service, repo, client, inbox } = makeService();
    repo.contacts.set(USER_ID, contact());
    client.result = permanent(853000, "invalid bot");
    inbox.fail = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("retry");
    if (outcome.outcome === "retry") {
      expect(outcome.error).toContain("降级站内信失败");
    }
  });

  it("截断发送：超长正文 → 实际发出 ≤ 2000 字节 + 省略标记，sent 行", async () => {
    const { service, repo, client } = makeService();
    repo.contacts.set(USER_ID, contact());

    const outcome = await service.consume(claimedRow(payload({ body: "长".repeat(3_000) })));

    expect(outcome).toEqual({ outcome: "done" });
    expect(Buffer.byteLength(client.sends[0]!.content, "utf8")).toBeLessThanOrEqual(APP_TEXT_MAX_BYTES);
    expect(client.sends[0]!.content.endsWith(APP_TRUNCATION_SUFFIX)).toBe(true);
    expect(repo.deliveries[0]!.state).toBe("sent");
  });

  it("渠道路由防御：非 wecom_app（inbox）→ dead、不读联系人、不发送", async () => {
    const { service, repo, client } = makeService();

    const outcome = await service.consume(claimedRow(payload({ channel: "inbox" })));

    expect(outcome.outcome).toBe("dead");
    if (outcome.outcome === "dead") {
      expect(outcome.error).toContain("渠道异常");
    }
    expect(repo.deliveries).toEqual([]);
    expect(client.sends).toEqual([]);
  });

  it("非法载荷：dead、不读联系人、不发送", async () => {
    const { service, repo, client } = makeService();

    const outcome = await service.consume(claimedRow({ recipientId: USER_ID, type: "unknown", title: "t", body: "b", channel: "wecom_app" }));

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries).toEqual([]);
    expect(client.sends).toEqual([]);
  });
});
