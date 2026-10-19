/**
 * 企微智能机器人长连接客户端回归（M5-03-2 · P5 定案；M5-03-5-3 扩单聊面）：假 socket 驱动 —— 订阅成败 /
 * 状态机与统计 / 推送帧形状（群 chat_type=2 / 单聊 chatid 填 userid + chat_type=1 · P4 锁帧）/
 * 846607 双语义（群 groupActivated / 单聊 dmActivated）/ 846609 与回执超时 / 双窗口限速拒绝（group / single）/
 * 会话内回执（M5-03-5-6 · aibot_respond_msg + 回调 req_id 透传）/ 心跳失联重连 / 回调分发 / stop 清理。
 * 不触外网（socketFactory 全替身；生产 `ws` 实现见 wecom.aibot.ts createWsSocketFactory）。
 */
import { describe, expect, it } from "vitest";
import { WecomAibotClient, type AibotIncomingMessage, type AibotSocket } from "../src/modules/notify/wecom.aibot.js";
import {
  InMemoryRateWindowStore,
  WECOM_BOT_WINDOW_PER_HOUR_MS,
  WECOM_BOT_WINDOW_PER_MINUTE_MS,
  WecomRateLimiter,
  type WecomRateWindowSpec,
} from "../src/modules/notify/wecom.rate.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSocket implements AibotSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onclose?.(code ?? 1000, reason ?? "closed by test");
  }

  // ---- 驱动面（替身专用） ----
  open(): void {
    this.onopen?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.(JSON.stringify(frame));
  }

  lastFrame(): Record<string, unknown> {
    const raw = this.sent[this.sent.length - 1];
    if (raw === undefined) {
      throw new Error("无已发送帧");
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /** 以回执应答最近一帧（订阅 / 推送同形：errcode 在帧顶层）。 */
  ackLast(errcode = 0, errmsg = "ok"): void {
    const headers = this.lastFrame()["headers"] as Record<string, unknown> | undefined;
    this.deliver({ headers: { req_id: headers?.["req_id"] }, errcode, errmsg });
  }
}

interface MakeClientOptions {
  ackTimeoutMs?: number;
  pingIntervalMs?: number;
  reconnectMinMs?: number;
  now?: () => number;
  windows?: WecomRateWindowSpec[];
}

function makeClient(options: MakeClientOptions = {}) {
  const sockets: FakeSocket[] = [];
  const limiter = new WecomRateLimiter({
    store: new InMemoryRateWindowStore(),
    windows: options.windows ?? [
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 0 },
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 0 },
    ],
    now: options.now,
  });
  const client = new WecomAibotClient({
    wsUrl: "wss://stub.test/aibot",
    botId: "bot-1",
    secret: "secret-1",
    pingIntervalMs: options.pingIntervalMs ?? 1_000_000, // 默认静默（测试内不触心跳）
    ackTimeoutMs: options.ackTimeoutMs ?? 1_000,
    reconnectMinMs: options.reconnectMinMs ?? 60_000,
    reconnectMaxMs: 60_000,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    limiter,
    now: options.now,
  });
  return { client, sockets, limiter };
}

/** 建立连接并完成订阅（返回已订阅的假 socket）。 */
async function connect(client: WecomAibotClient, sockets: FakeSocket[]): Promise<FakeSocket> {
  client.start();
  const socket = sockets[sockets.length - 1]!;
  socket.open();
  socket.ackLast(0);
  await sleep(0);
  return socket;
}

describe("企微智能机器人长连接客户端（M5-03-2 · P5）", () => {
  it("订阅：start → 订阅帧形状正确 → 订阅回执置状态 subscribed（统计回填）", async () => {
    const { client, sockets } = makeClient();
    client.start();
    expect(client.getStats().state).toBe("connecting");
    const socket = sockets[0]!;
    socket.open();

    expect(socket.lastFrame()).toMatchObject({
      cmd: "aibot_subscribe",
      body: { bot_id: "bot-1", secret: "secret-1" },
    });
    socket.ackLast(0);
    await sleep(0);

    const stats = client.getStats();
    expect(stats.state).toBe("subscribed");
    expect(stats.connects).toBe(1);
    expect(stats.subscribes).toBe(1);
    expect(stats.framesOut).toBe(1);
    expect(stats.lastSubscribedAt).not.toBeNull();
    await client.stop();
  });

  it("waitForSubscribed：等待中订阅成功 → resolve(true)（首轮告警探针门）", async () => {
    const { client, sockets } = makeClient();
    client.start();
    const pending = client.waitForSubscribed(1_000);
    const socket = sockets[0]!;
    socket.open();
    socket.ackLast(0);

    await expect(pending).resolves.toBe(true);
    expect(client.getStats().state).toBe("subscribed");
    await client.stop();
  });

  it("waitForSubscribed：超时 → false（有界等待，不阻塞首轮探针）", async () => {
    const { client } = makeClient();
    client.start();
    await expect(client.waitForSubscribed(5)).resolves.toBe(false);
    await client.stop();
  });

  it("waitForSubscribed：已订阅立即 true；stop() 让等待中调用返回 false", async () => {
    const subscribed = makeClient();
    await connect(subscribed.client, subscribed.sockets);
    await expect(subscribed.client.waitForSubscribed(100)).resolves.toBe(true);
    await subscribed.client.stop();

    const { client } = makeClient();
    client.start();
    const waiting = client.waitForSubscribed(1_000);
    await client.stop();
    await expect(waiting).resolves.toBe(false);
  });

  it("订阅失败（853000 凭据无效）：断开并排程重连（backoff）", async () => {
    const { client, sockets } = makeClient();
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.ackLast(853000, "invalid bot");
    await sleep(0);

    const stats = client.getStats();
    expect(stats.state).toBe("backoff");
    expect(stats.lastError).toContain("订阅失败");
    expect(stats.reconnects).toBe(1);
    expect(socket.closed).toBe(true);
    await client.stop();
  });

  it("推送 markdown：帧形状（chatid / chat_type=2 / markdown.content）与回执 ok", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);

    const pending = client.sendGroupMarkdown({ chatid: "chat-1", content: "**播报**" });
    await sleep(0);
    expect(socket.lastFrame()).toMatchObject({
      cmd: "aibot_send_msg",
      body: { chatid: "chat-1", chat_type: 2, msgtype: "markdown", markdown: { content: "**播报**" } },
    });
    socket.ackLast(0);
    const result = await pending;
    expect(result).toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("846607 双语义：groupActivated=false → permanent；true / 未传 → rate_limited", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);

    for (const [activated, kind] of [
      [false, "permanent"],
      [true, "rate_limited"],
      [undefined, "rate_limited"],
    ] as const) {
      const pending = client.sendGroupMarkdown({ chatid: "chat-1", content: "x", groupActivated: activated });
      await sleep(0);
      socket.ackLast(846607, "aibot send msg frequency limit exceeded");
      const result = await pending;
      expect(result).toMatchObject({ ok: false, kind, errcode: 846607, attempts: 1 });
    }
    await client.stop();
  });

  it("846609（未订阅）→ retryable；回执超时 → retryable；回执缺 errcode → retryable", async () => {
    const { client, sockets } = makeClient({ ackTimeoutMs: 40 });
    const socket = await connect(client, sockets);

    const unsubscribed = client.sendGroupMarkdown({ chatid: "chat-1", content: "x" });
    await sleep(0);
    socket.ackLast(846609, "not subscribed");
    expect(await unsubscribed).toMatchObject({ ok: false, kind: "retryable", errcode: 846609 });

    const noCode = client.sendGroupMarkdown({ chatid: "chat-1", content: "x" });
    await sleep(0);
    const headers = socket.lastFrame()["headers"] as Record<string, unknown> | undefined;
    socket.deliver({ headers: { req_id: headers?.["req_id"] }, errmsg: "no code" });
    expect(await noCode).toMatchObject({ ok: false, kind: "retryable", errcode: null, attempts: 1 });

    const timedOut = await client.sendGroupMarkdown({ chatid: "chat-1", content: "x" }); // 不回执 → ackTimeoutMs 到点
    expect(timedOut).toMatchObject({ ok: false, kind: "retryable", errcode: null, attempts: 1 });
    if (!timedOut.ok) {
      expect(timedOut.errmsg).toContain("回执超时");
    }
    await client.stop();
  });

  it("本地双窗口限速：第二次拒绝（不发帧、attempts=0、retryAt = 被拒窗口最大值）", async () => {
    const fixedNow = 1_000;
    const { client, sockets } = makeClient({
      now: () => fixedNow,
      windows: [
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 1 },
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 1 },
      ],
    });
    const socket = await connect(client, sockets);

    const first = client.sendGroupMarkdown({ chatid: "chat-1", content: "1" });
    await sleep(0);
    socket.ackLast(0);
    expect(await first).toEqual({ ok: true, attempts: 1 });
    const framesAfterFirst = socket.sent.length;

    const blocked = await client.sendGroupMarkdown({ chatid: "chat-1", content: "2" });
    expect(blocked).toMatchObject({ ok: false, kind: "rate_limited", attempts: 0 });
    if (!blocked.ok) {
      expect(blocked.retryAt?.getTime()).toBe(WECOM_BOT_WINDOW_PER_HOUR_MS); // max(分钟下一窗口, 小时下一窗口)
    }
    expect(socket.sent.length).toBe(framesAfterFirst); // 拒绝不发帧
    await client.stop();
  });

  it("单聊 markdown 推送（M5-03-5-3 · P4 锁帧）：帧形状 chatid=userid / chat_type=1 / markdown.content，回执 ok", async () => {
    const { client, sockets } = makeClient({
      windows: [
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 0 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 0 },
      ],
    });
    const socket = await connect(client, sockets);

    const pending = client.sendUserMarkdown({ userid: "zhangsan", content: "**标题**\n\n正文" });
    await sleep(0);
    expect(socket.lastFrame()).toMatchObject({ cmd: "aibot_send_msg" });
    // 锁帧：body 逐字段全等（chatid 填 userid + chat_type 1 —— 官方 SDK 语义核对 + 探针 T5-1b 真机锁定）
    expect(socket.lastFrame()["body"]).toEqual({
      chatid: "zhangsan",
      chat_type: 1,
      msgtype: "markdown",
      markdown: { content: "**标题**\n\n正文" },
    });
    socket.ackLast(0);
    expect(await pending).toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("会话内回执（M5-03-5-6）：cmd=aibot_respond_msg + headers.req_id = 回调 req_id + stream 单帧收敛，回执 ok", async () => {
    const { client, sockets } = makeClient({
      windows: [
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 0 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 0 },
      ],
    });
    const socket = await connect(client, sockets);

    const pending = client.replyToCallback({ reqId: "ReqIdCallback0001", userid: "wosu-open-userid", content: "绑定成功" });
    await sleep(0);
    expect(socket.lastFrame()).toMatchObject({ cmd: "aibot_respond_msg", headers: { req_id: "ReqIdCallback0001" } });
    const body = socket.lastFrame()["body"] as Record<string, unknown>;
    expect(body["msgtype"]).toBe("stream");
    expect(body["stream"]).toMatchObject({ finish: true, content: "绑定成功" });
    expect(String((body["stream"] as Record<string, unknown>)["id"]).startsWith("stream_")).toBe(true);
    socket.ackLast(0);
    expect(await pending).toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("会话内回执：未就绪 → retryable / attempts=0（不发帧）", async () => {
    const { client, sockets } = makeClient();

    const result = await client.replyToCallback({ reqId: "req-1", userid: "u-1", content: "绑定成功" });

    expect(result).toMatchObject({ ok: false, kind: "retryable", attempts: 0 });
    expect(sockets.length).toBe(0);
    await client.stop();
  });

  it("欢迎语回执（enter_chat）：aibot_respond_welcome_msg + req_id 透传 + text 纯文本，回执 ok", async () => {
    const { client, sockets } = makeClient({
      windows: [
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 0 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 0 },
      ],
    });
    const socket = await connect(client, sockets);

    const pending = client.replyWelcome({ reqId: "ReqIdWelcome0001", content: "你好，欢迎 👋" });
    await sleep(0);
    expect(socket.lastFrame()).toMatchObject({
      cmd: "aibot_respond_welcome_msg",
      headers: { req_id: "ReqIdWelcome0001" },
    });
    expect(socket.lastFrame()["body"]).toEqual({ msgtype: "text", text: { content: "你好，欢迎 👋" } });
    socket.ackLast(0);
    expect(await pending).toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("欢迎语回执：未就绪 → retryable / attempts=0（不发帧）；853000 → permanent", async () => {
    const notReady = makeClient();
    const refused = await notReady.client.replyWelcome({ reqId: "req-welcome-0", content: "欢迎" });
    expect(refused).toMatchObject({ ok: false, kind: "retryable", attempts: 0 });
    expect(notReady.sockets.length).toBe(0);
    await notReady.client.stop();

    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const pending = client.replyWelcome({ reqId: "req-welcome-1", content: "欢迎" });
    await sleep(0);
    socket.ackLast(853000, "invalid bot");
    expect(await pending).toMatchObject({ ok: false, kind: "permanent", errcode: 853000, attempts: 1 });
    await client.stop();
  });

  it("会话内回执：单聊桶限速拒绝 → rate_limited / attempts=0（不发帧）；846607 回执 → rate_limited", async () => {
    const { client, sockets } = makeClient({
      windows: [
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 1 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 0 },
      ],
      now: () => 1_700_000_000_000,
    });
    const socket = await connect(client, sockets);

    const first = client.replyToCallback({ reqId: "req-1", userid: "u-1", content: "绑定成功" });
    await sleep(0);
    socket.ackLast(0);
    expect((await first).ok).toBe(true);
    const frames = socket.sent.length;

    const refused = await client.replyToCallback({ reqId: "req-2", userid: "u-1", content: "已绑定" });
    expect(refused).toMatchObject({ ok: false, kind: "rate_limited", attempts: 0 });
    expect(socket.sent.length).toBe(frames);

    const throttled = client.replyToCallback({ reqId: "req-3", userid: "u-2", content: "绑定成功" });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    expect(await throttled).toMatchObject({ ok: false, kind: "rate_limited", errcode: 846607, attempts: 1 });
    await client.stop();
  });

  it("单聊 846607 分流：dmActivated=false（未命中激活表）→ permanent；true / 缺省 → rate_limited（超频）", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);

    const unactivated = client.sendUserMarkdown({ userid: "u-1", content: "x", dmActivated: false });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    expect(await unactivated).toMatchObject({ ok: false, kind: "permanent", errcode: 846607 });

    const throttled = client.sendUserMarkdown({ userid: "u-1", content: "x", dmActivated: true });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    expect(await throttled).toMatchObject({ ok: false, kind: "rate_limited", errcode: 846607 });

    const unknown = client.sendUserMarkdown({ userid: "u-1", content: "x" });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    expect(await unknown).toMatchObject({ ok: false, kind: "rate_limited", errcode: 846607 });
    await client.stop();
  });

  it("单聊未就绪发送：state ≠ subscribed → retryable、attempts=0（不发帧）", async () => {
    const { client, sockets } = makeClient();
    const result = await client.sendUserMarkdown({ userid: "u-1", content: "x", dmActivated: true });
    expect(result).toMatchObject({ ok: false, kind: "retryable", attempts: 0, errcode: null });
    if (!result.ok) {
      expect(result.errmsg).toContain("长连接未就绪");
    }
    expect(sockets.length).toBe(0);
    await client.stop();
  });

  it("单聊本地双窗口限速：第二次拒绝（不发帧、attempts=0、retryAt = 被拒窗口最大值）；群 / 单聊桶隔离", async () => {
    const fixedNow = 1_000;
    const { client, sockets } = makeClient({
      now: () => fixedNow,
      windows: [
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 1 },
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 1 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 1 },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 1 },
      ],
    });
    const socket = await connect(client, sockets);

    const first = client.sendUserMarkdown({ userid: "u-1", content: "1", dmActivated: true });
    await sleep(0);
    socket.ackLast(0);
    expect(await first).toEqual({ ok: true, attempts: 1 });
    const framesAfterFirst = socket.sent.length;

    const blocked = await client.sendUserMarkdown({ userid: "u-1", content: "2", dmActivated: true });
    expect(blocked).toMatchObject({ ok: false, kind: "rate_limited", attempts: 0 });
    if (!blocked.ok) {
      expect(blocked.retryAt?.getTime()).toBe(WECOM_BOT_WINDOW_PER_HOUR_MS); // max(分钟下一窗口, 小时下一窗口)
    }
    expect(socket.sent.length).toBe(framesAfterFirst); // 拒绝不发帧

    // kind 隔离：单聊桶耗尽不影响群桶（同摘要不互污）
    const groupOk = client.sendGroupMarkdown({ chatid: "u-1", content: "g" });
    await sleep(0);
    socket.ackLast(0);
    expect(await groupOk).toEqual({ ok: true, attempts: 1 });
    await client.stop();
  });

  it("心跳失联：连续 2 周期无回执 → 断开并重连（新连接建立）", async () => {
    const { client, sockets } = makeClient({ pingIntervalMs: 25, reconnectMinMs: 10 });
    await connect(client, sockets);

    await sleep(300);
    const stats = client.getStats();
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(stats.reconnects).toBeGreaterThanOrEqual(1);
    expect(stats.lastError).toContain("心跳失联");
    await client.stop();
  });

  it("回调分发：aibot_msg_callback 归一载荷经 onMessage（含 msgtype / 文本正文；退订后不再分发）", async () => {
    const { client, sockets } = makeClient();
    const socket = await connect(client, sockets);
    const received: AibotIncomingMessage[] = [];
    const off = client.onMessage((message) => received.push(message));

    socket.deliver({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-cb-1" },
      body: {
        chatid: "chat-9",
        chattype: "group",
        chatname: "  项目群  ",
        from: { userid: "u-9" },
        msgid: "m-1",
        msgtype: "text",
        text: { content: "@Bot 绑定 123456" },
      },
    });
    expect(received).toEqual([
      {
        cmd: "aibot_msg_callback",
        reqId: "req-cb-1",
        chatid: "chat-9",
        chattype: "group",
        chatName: "项目群",
        fromUserId: "u-9",
        msgid: "m-1",
        msgtype: "text",
        text: "@Bot 绑定 123456",
        eventType: null,
      },
    ]);

    // 事件回调（单聊 enter_chat）：带 req_id + from.userid，无正文（msgtype=event → text 为 null）
    socket.deliver({
      cmd: "aibot_event_callback",
      headers: { req_id: "req-cb-ev" },
      body: { chattype: "single", from: { userid: "u-9" }, msgid: "m-2", msgtype: "event", event: { eventtype: "enter_chat" } },
    });
    expect(received[1]).toEqual({
      cmd: "aibot_event_callback",
      reqId: "req-cb-ev",
      chatid: null,
      chattype: "single",
      fromUserId: "u-9",
      msgid: "m-2",
      msgtype: "event",
      text: null,
      eventType: "enter_chat",
    });

    off();
    socket.deliver({ cmd: "aibot_event_callback", headers: { req_id: "req-cb-2" }, body: { chatid: "chat-9" } });
    expect(received).toHaveLength(2);
    await client.stop();
  });

  it("未就绪发送：state ≠ subscribed → retryable、attempts=0（不发帧）", async () => {
    const { client, sockets } = makeClient();
    const result = await client.sendGroupMarkdown({ chatid: "chat-1", content: "x" });
    expect(result).toMatchObject({ ok: false, kind: "retryable", attempts: 0, errcode: null });
    if (!result.ok) {
      expect(result.errmsg).toContain("长连接未就绪");
    }
    expect(sockets.length).toBe(0);
    await client.stop();
  });

  it("stop 清理：停止后不放帧、不重连、待回执推送按「连接已断开」返回", async () => {
    const { client, sockets } = makeClient({ pingIntervalMs: 20, reconnectMinMs: 10 });
    const socket = await connect(client, sockets);

    const pending = client.sendGroupMarkdown({ chatid: "chat-1", content: "x" });
    await sleep(0);
    await client.stop();

    const result = await pending;
    expect(result).toMatchObject({ ok: false, kind: "retryable", attempts: 1 });
    if (!result.ok) {
      expect(result.errmsg).toContain("连接已断开");
    }
    expect(client.getStats().state).toBe("stopped");
    expect(socket.closed).toBe(true);
    const socketCount = sockets.length;
    await sleep(150); // 远超心跳 / 重连窗口：停止后不得再建连
    expect(sockets.length).toBe(socketCount);
    const afterStop = await client.sendGroupMarkdown({ chatid: "chat-1", content: "y" });
    expect(afterStop).toMatchObject({ ok: false, kind: "retryable", attempts: 0 });
  });
});
