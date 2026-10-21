/**
 * Outbox 消费注册表门禁（M5-03-5-4 接线段 · 不连库）：buildRegistry 的注册面与 notify.message
 * 渠道分流（inbox / wecom_app / wecom_aibot）+ 群主题凭据门控 + 预览 / 投递开关门控。
 * 真机链路（规则产出 → 领取 → 路由 → 消费 → 留痕）见 server/scripts/s7-4-automation-wiring-replay.mjs。
 */
import { describe, expect, it } from "vitest";
import { loadEnv, type Env } from "../src/config/env.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import { PREVIEW_JOB_TOPIC } from "../src/modules/file/index.js";
import { NOTIFY_GROUP_TOPIC, NOTIFY_MESSAGE_TOPIC } from "../src/modules/notify/index.js";
import { buildRegistry } from "../src/outbox/outbox.module.js";
import { OUTBOX_DRAIN_ONLY_TOPICS } from "../src/outbox/topic-catalog.js";

function makeEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    DATABASE_URL: "postgresql://unused",
    NOTIFY_DELIVERY_ENABLED: "true",
    PREVIEW_JOB_ENABLED: "false",
    WECOM_BOT_ID: "",
    WECOM_BOT_SECRET: "",
    ...overrides,
  });
}

/** 消费替身：记录调用行（生产 = Nest 服务；本门禁只验「按载荷 channel 分流」这一装配点）。 */
function makeConsumer() {
  const calls: OutboxClaimedRow[] = [];
  return {
    calls,
    consume: async (row: OutboxClaimedRow) => {
      calls.push(row);
      return { outcome: "done" as const };
    },
  };
}

function makeRegistry(env: Env) {
  const previews = makeConsumer();
  const notify = makeConsumer();
  const groupNotify = makeConsumer();
  const appNotify = makeConsumer();
  const dmNotify = makeConsumer();
  const registry = buildRegistry(
    env,
    previews as never,
    notify as never,
    groupNotify as never,
    appNotify as never,
    dmNotify as never,
  );
  return { registry, previews, notify, groupNotify, appNotify, dmNotify };
}

function claimedRow(channel: string | null, id = 1): OutboxClaimedRow {
  const payload: Record<string, unknown> = {
    recipientId: "u-1",
    type: "reminder",
    title: "标题",
    body: "正文",
  };
  if (channel !== null) {
    payload["channel"] = channel;
  }
  return {
    id,
    topic: NOTIFY_MESSAGE_TOPIC,
    payload,
    dedupeKey: "R02:t-1:v5",
    attempts: 0,
    availableAt: new Date("2026-10-14T00:00:00.000Z"),
    lockedAt: new Date("2026-10-14T00:00:00.000Z"),
    createdAt: new Date("2026-10-14T00:00:00.000Z"),
  };
}

describe("Outbox 消费注册表（M5-03-5-4 接线段）", () => {
  it("notify.message 分流：wecom_app → 应用消息消费（其余分支零触达）", async () => {
    const h = makeRegistry(makeEnv());
    const handler = h.registry.get(NOTIFY_MESSAGE_TOPIC);
    expect(handler).toBeDefined();
    const row = claimedRow("wecom_app");
    const outcome = await handler?.handle(row);
    expect(outcome).toEqual({ outcome: "done" });
    expect(h.appNotify.calls).toEqual([row]);
    expect(h.dmNotify.calls).toHaveLength(0);
    expect(h.notify.calls).toHaveLength(0);
  });

  it("notify.message 分流：wecom_aibot → 单聊消费（未配置凭据也领取路由 —— 未就绪按 retry 收敛，非只存不投）", async () => {
    const h = makeRegistry(makeEnv());
    const row = claimedRow("wecom_aibot");
    await h.registry.get(NOTIFY_MESSAGE_TOPIC)?.handle(row);
    expect(h.dmNotify.calls).toEqual([row]);
    expect(h.appNotify.calls).toHaveLength(0);
    expect(h.notify.calls).toHaveLength(0);
  });

  it("notify.message 分流：inbox 与缺省 channel → 站内信消费（非 inbox 渠道由其按确定性失败收口）", async () => {
    const h = makeRegistry(makeEnv());
    const handler = h.registry.get(NOTIFY_MESSAGE_TOPIC);
    const inbox = claimedRow("inbox", 1);
    const missing = claimedRow(null, 2);
    await handler?.handle(inbox);
    await handler?.handle(missing);
    expect(h.notify.calls).toEqual([inbox, missing]);
    expect(h.appNotify.calls).toHaveLength(0);
    expect(h.dmNotify.calls).toHaveLength(0);
  });

  it("投递开关：NOTIFY_DELIVERY_ENABLED=false 时 notify.message 不注册（只投递不消费排障态）", () => {
    const h = makeRegistry(makeEnv({ NOTIFY_DELIVERY_ENABLED: "false" }));
    expect(h.registry.has(NOTIFY_MESSAGE_TOPIC)).toBe(false);
  });

  it("群主题门控：凭据缺失不注册（只存不投）；凭据齐备注册并消费 notify.group 行", async () => {
    const off = makeRegistry(makeEnv());
    expect(off.registry.has(NOTIFY_GROUP_TOPIC)).toBe(false);

    const on = makeRegistry(makeEnv({ WECOM_BOT_ID: "bot-stub", WECOM_BOT_SECRET: "secret-stub" }));
    const handler = on.registry.get(NOTIFY_GROUP_TOPIC);
    expect(handler).toBeDefined();
    const row = { ...claimedRow(null, 3), topic: NOTIFY_GROUP_TOPIC };
    await handler?.handle(row);
    expect(on.groupNotify.calls).toEqual([row]);
  });

  it("预览开关：PREVIEW_JOB_ENABLED=true 注册 preview.job；false（缺省）不注册", () => {
    expect(makeRegistry(makeEnv()).registry.has(PREVIEW_JOB_TOPIC)).toBe(false);
    expect(makeRegistry(makeEnv({ PREVIEW_JOB_ENABLED: "true" })).registry.has(PREVIEW_JOB_TOPIC)).toBe(true);
  });

  it("drain-only 全量注册：无业务订阅的主题也领取并 done，不再永久积压", async () => {
    const h = makeRegistry(makeEnv());
    const registeredDrainOnly = [...h.registry.keys()]
      .filter((topic) => OUTBOX_DRAIN_ONLY_TOPICS.includes(topic))
      .sort();

    expect(registeredDrainOnly).toEqual([...OUTBOX_DRAIN_ONLY_TOPICS].sort());
    expect(h.registry.size).toBe(OUTBOX_DRAIN_ONLY_TOPICS.length + 1);
    const row = { ...claimedRow(null, 9), topic: "task.created" as const };
    await expect(h.registry.get("task.created")?.handle(row)).resolves.toEqual({ outcome: "done" });
    expect(h.notify.calls).toHaveLength(0);
    expect(h.groupNotify.calls).toHaveLength(0);
    expect(h.appNotify.calls).toHaveLength(0);
    expect(h.dmNotify.calls).toHaveLength(0);
  });
});
