/**
 * 企微智能机器人长连接客户端（M5-03-2 · P5 定案 2026-10-12：群通道唯一发送面 —— **webhook 面退役**）。
 *
 * 协议（Spike 真机实测 2026-10-10 ~ 10-12；口径来源 = docs/M5-03-实施方案(企微通道).md §五 5.3A + 官方 90313 码表）：
 *   - 连接 `wss://openws.work.weixin.qq.com`；帧 = `{ cmd, headers.req_id, body? }` JSON 文本帧；
 *   - 订阅 `aibot_subscribe`（body = bot_id + secret）→ 回执 errcode 0 = 订阅成功（853000 = 凭据无效；
 *     846601 = 后台未开启长连接模式）；
 *   - 心跳 `ping`：默认 30s（WECOM_BOT_PING_INTERVAL_MS）；连续 2 个周期无回执 → 判失联、断开重连
 *     （订阅请求有频率保护 —— 本客户端只在连接建立后订阅一次；重连走指数退避，天然控频）；
 *   - 主动推送 `aibot_send_msg`（群 = chatid + chat_type 2；单聊 = chatid 填 userid + chat_type 1；msgtype
 *     markdown）→ 回执按 req_id 关联；单聊帧形 = 官方 SDK 语义核对（sendMessage：单聊填 userid）+ 探针
 *     T5-1b 真机 errcode=0 实测锁定（P4 复核 · 2026-10-14），stub 锁帧见测试 / 回放；
 *   - 回调 `aibot_msg_callback` / `aibot_event_callback`（body.chatid 仅群聊；chattype / from.userid /
 *     msgid）经 `onMessage` 交给调用方（群绑定 ingest 用；本刀不落库）；
 *   - 会话内回复 `aibot_respond_msg`（M5-03-5-6 · 绑定码回执）：透传回调帧 `headers.req_id`，body =
 *     单帧收敛流式回复（官方 SDK 1.0.3 实证 —— 回复不依赖 chatid / 寻址；`response_url` 未被 SDK 使用，
 *     本仓同样不落该字段）；
 *   - 回执帧形状 = `{ headers: { req_id }, errcode, errmsg }` —— **errcode 在帧顶层**（非 body）。
 *
 * 语义：
 *   - 会话激活硬前提：群内有人在会话中给机器人发过消息后，才能主动推送该会话；未激活推送命中
 *     846607 未激活分支 → permanent（不重试 + 降级 B4 + 留痕）—— 激活态由调用方按绑定行
 *     `wecom_groups.activated_at` 经 `groupActivated` 传入（846607 双语义切分；P5 定案）；单聊同硬前提
 *     （M5-03-5-3：激活表 `wecom_aibot_dm_activations` 命中与否经 `dmActivated` 传入）；
 *   - 限速：按会话 30 条/分钟 + 1000 条/小时（回复 + 主动推送合计；Spike 实测）—— 本地双窗口桶，
 *     拒绝不发帧、`retryAt` = 被拒窗口的下一窗口起点（延期重排、不消耗重试次数）；
 *   - 断连 / 未订阅窗口：发送本地失败 retryable（不消耗服务端配额；重连就绪后由消费侧重排）；
 *   - 安全：不日志、不回显 secret / chatid 明文（限速桶键 = chatid 摘要；错误描述过掩码）。
 *
 * 生命周期：`start()` 建连（幂等；启动后自动重连直至 `stop()`）→ `stop()` 停止（断连 + 清空待回执）。
 * 接线边界：本刀只交付客户端内核（无 outbox / 投递接线 —— 消费侧接线随 M5-03-2 接线段）；
 * 单测 / stub 回放经 `socketFactory` 注入替身，不触外网；生产工厂 `createWsSocketFactory` 为全仓唯一 import "ws" 处。
 */
import WebSocketImpl from "ws";
import type { Env } from "../../config/env.js";
import { classifyWecomErrcode, describeNetworkError, type WecomFailureKind } from "./wecom.errors.js";
import {
  chatBucketId,
  InMemoryRateWindowStore,
  userBucketId,
  WECOM_BOT_WINDOW_PER_HOUR_MS,
  WECOM_BOT_WINDOW_PER_MINUTE_MS,
  WecomRateLimiter,
  type RateWindowStore,
} from "./wecom.rate.js";

/** 传输层最小面（生产 = ws；单测 / stub 回放 = 替身 —— 除 ws 语义外不依赖任何实现细节）。 */
export interface AibotSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export type AibotSocketFactory = (url: string) => AibotSocket;

export type AibotConnectionState = "stopped" | "connecting" | "subscribed" | "backoff";

/** 回执帧（订阅 / 推送 / 心跳共形）：errcode 在帧顶层；字段逐项 typeof 松读。 */
interface AibotAckFrame {
  errcode?: unknown;
  errmsg?: unknown;
}

/**
 * 回调帧归一载荷（群 / 单聊 ingest 用；仅透传，正文不落库 —— 单聊绑定码在服务层匹配，M5-03-5-6）。
 * `reqId` = 回调帧 `headers.req_id`：会话内回复（`replyToCallback`）透传它 —— 单聊回调无 `chatid`，
 * 回复不依赖寻址（官方 SDK 1.0.3 实证：回复 = `{ cmd: "aibot_respond_msg", headers: { req_id }, body }`）。
 */
export interface AibotIncomingMessage {
  cmd: "aibot_msg_callback" | "aibot_event_callback";
  reqId: string | null;
  chatid: string | null;
  chattype: string | null;
  fromUserId: string | null;
  msgid: string | null;
  /** 消息类型（text / image / …；事件回调为 event）。 */
  msgtype: string | null;
  /** 文本正文（msgtype = text 时非空；其余为 null）。 */
  text: string | null;
}

export type AibotSendResult =
  | { ok: true; attempts: number }
  | {
      ok: false;
      kind: WecomFailureKind;
      errcode: number | null;
      errmsg: string | null;
      /** 本地限速桶拒绝时为「被拒窗口的下一窗口起点」；服务端 846607 频控 / 未就绪为 null（退避由消费侧定）。 */
      retryAt: Date | null;
      /** 实际发出的帧数（本地限速拒绝 / 未就绪 = 0；单帧发送 = 1）。 */
      attempts: number;
      /** 返回时刻连接状态（诊断用）。 */
      state: AibotConnectionState;
    };

export interface WecomAibotStats {
  state: AibotConnectionState;
  /** 建连尝试次数（含重连）。 */
  connects: number;
  /** 订阅帧发出次数。 */
  subscribes: number;
  /** 重连排程次数（含订阅失败 / 心跳失联 / 断连）。 */
  reconnects: number;
  framesIn: number;
  framesOut: number;
  lastError: string | null;
  lastSubscribedAt: Date | null;
}

export interface WecomAibotOptions {
  wsUrl: string;
  botId: string;
  secret: string;
  pingIntervalMs: number;
  /** 单帧回执超时（毫秒）：订阅 / 推送共用。 */
  ackTimeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  socketFactory: AibotSocketFactory;
  limiter: WecomRateLimiter;
  now?: () => number;
}

type AckOutcome = { ok: true; frame: AibotAckFrame } | { ok: false; reason: "timeout" | "closed" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export class WecomAibotClient {
  private socket: AibotSocket | null = null;
  private state: AibotConnectionState = "stopped";
  private stopped = true;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, (outcome: AckOutcome) => void>();
  private readonly handlers = new Set<(message: AibotIncomingMessage) => void>();
  private readonly subscribedWaiters = new Set<(ready: boolean) => void>();
  private backoffMs = 0;
  private missedPongs = 0;
  private readonly counters = {
    connects: 0,
    subscribes: 0,
    reconnects: 0,
    framesIn: 0,
    framesOut: 0,
    lastError: null as string | null,
    lastSubscribedAt: null as Date | null,
  };

  constructor(private readonly options: WecomAibotOptions) {}

  /** 建立连接（幂等：已启动时忽略）。启动后自动重连直至 `stop()`。 */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.backoffMs = 0;
    this.connect();
  }

  /** 停止：断开连接、清空待回执、不再重连（可再次 `start()`）。 */
  async stop(): Promise<void> {
    if (this.stopped) {
      this.resolveSubscribedWaiters(false);
      return;
    }
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    this.setState("stopped");
    this.failPending("closed");
    if (socket !== null) {
      try {
        socket.close(1000, "client stop");
      } catch {
        // 忽略关闭异常（连接已死时 close 可能抛错）
      }
    }
  }

  getStats(): WecomAibotStats {
    return { state: this.state, ...this.counters };
  }

  /**
   * 等待长连接进入 subscribed（启动时序用）：已订阅立即 true；超时 / stop() 返回 false。
   * 订阅失败进入 backoff 时继续等待（自动重连成功仍可 true），由调用方超时收口。
   */
  waitForSubscribed(timeoutMs: number): Promise<boolean> {
    if (this.state === "subscribed") {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const waiter = (ready: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        this.subscribedWaiters.delete(waiter);
        resolve(ready);
      };
      this.subscribedWaiters.add(waiter);
      timer = setTimeout(() => waiter(false), Math.max(0, timeoutMs));
    });
  }

  /** 订阅回调（群绑定 ingest 用）：返回退订函数。 */
  onMessage(handler: (message: AibotIncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 群 markdown 推送：限速（group 双窗口）→ aibot_send_msg（chat_type 2）→ 等回执 → 分类。 */
  async sendGroupMarkdown(params: {
    chatid: string;
    content: string;
    /** 会话激活态（读绑定行 `wecom_groups.activated_at`；846607 双语义切分用 —— false = 未激活）。 */
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    return this.sendMarkdown({
      target: params.chatid,
      content: params.content,
      chatType: 2,
      rateKind: "group",
      channel: "wecom_group",
      bucketId: chatBucketId(params.chatid),
      activated: params.groupActivated ?? null,
    });
  }

  /**
   * 单聊 markdown 推送（M5-03-5-3）：限速（single 双窗口，按 userid 桶）→ aibot_send_msg
   * （chatid 填 userid + chat_type 1）→ 等回执 → 分类（846607 按 `dmActivated` 分流）。
   */
  async sendUserMarkdown(params: {
    userid: string;
    content: string;
    /** 会话激活态（读激活表 `wecom_aibot_dm_activations` 命中与否；846607 双语义切分用 —— false = 未激活）。 */
    dmActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    return this.sendMarkdown({
      target: params.userid,
      content: params.content,
      chatType: 1,
      rateKind: "single",
      channel: "wecom_aibot",
      bucketId: userBucketId(params.userid),
      activated: params.dmActivated ?? null,
    });
  }

  /**
   * 会话内回复（M5-03-5-6 · 绑定码回执）：被动回复走长连接 `aibot_respond_msg`，`headers.req_id` 透传
   * 回调帧的 req_id（官方 SDK 1.0.3 实证：`reply(frame, body)` → `{ cmd: "aibot_respond_msg", headers: { req_id }, body }`；
   * 单聊回调无 `chatid`，回复不依赖寻址）；body = 单帧收敛流式回复 `{ msgtype: "stream", stream: { id, finish: true, content } }`。
   * 限速：仍按目标会话桶计入（官方口径「回复 + 主动推送合计」同一配额）—— 被拒 = 不回复（回执属尽力而为，不影响绑定落库）。
   */
  async replyToCallback(params: { reqId: string; userid: string; content: string }): Promise<AibotSendResult> {
    if (this.state !== "subscribed" || this.socket === null) {
      return {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg: "长连接未就绪（state=" + this.state + "）",
        retryAt: null,
        attempts: 0,
        state: this.state,
      };
    }
    const rate = await this.options.limiter.tryConsume("single", userBucketId(params.userid), this.now());
    if (!rate.ok) {
      const refused = rate.windows.find((state) => state.count > state.limit);
      return {
        ok: false,
        kind: "rate_limited",
        errcode: null,
        errmsg:
          refused === undefined
            ? "本地限速桶已满（会话内回复）"
            : "本地限速桶已满（会话内回复 · " + String(refused.count) + "/" + String(refused.limit) + "）",
        retryAt: rate.retryAt,
        attempts: 0,
        state: this.state,
      };
    }
    const ack = this.waitAck(params.reqId);
    const sent = this.sendFrame({
      cmd: "aibot_respond_msg",
      headers: { req_id: params.reqId },
      body: { msgtype: "stream", stream: { id: this.nextReqId("stream"), finish: true, content: params.content } },
    });
    if (!sent) {
      this.cancelAck(params.reqId, "closed");
    }
    const outcome = await ack;
    if (!outcome.ok) {
      return {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg: outcome.reason === "timeout" ? "会话内回复回执超时" : "连接已断开（回复未确认）",
        retryAt: null,
        attempts: sent ? 1 : 0,
        state: this.state,
      };
    }
    const errcode = typeof outcome.frame.errcode === "number" ? outcome.frame.errcode : null;
    if (errcode === 0) {
      return { ok: true, attempts: 1 };
    }
    const errmsg = typeof outcome.frame.errmsg === "string" ? outcome.frame.errmsg : null;
    if (errcode === null) {
      return { ok: false, kind: "retryable", errcode: null, errmsg: "回执缺 errcode", retryAt: null, attempts: 1, state: this.state };
    }
    return {
      ok: false,
      kind: classifyWecomErrcode("wecom_aibot", errcode, { dmActivated: true }),
      errcode,
      errmsg,
      retryAt: null,
      attempts: 1,
      state: this.state,
    };
  }

  /** 发送主体（群 / 单聊共用）：限速（双窗口按目标桶）→ aibot_send_msg → 等回执 → 分类。 */
  private async sendMarkdown(input: {
    /** 发送目标（帧 `chatid` 字段值）：群 = chatid；单聊 = userid。 */
    target: string;
    content: string;
    /** 帧 chat_type：群 = 2 / 单聊 = 1。 */
    chatType: 1 | 2;
    rateKind: "group" | "single";
    channel: "wecom_group" | "wecom_aibot";
    /** 限速桶 id（chatid / userid 摘要 —— 计数键不回显目标明文）。 */
    bucketId: string;
    /** 会话激活态（false = 未激活 → 846607 按 permanent 收口）。 */
    activated: boolean | null;
  }): Promise<AibotSendResult> {
    if (this.state !== "subscribed" || this.socket === null) {
      return {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg: "长连接未就绪（state=" + this.state + "）",
        retryAt: null,
        attempts: 0,
        state: this.state,
      };
    }
    const rate = await this.options.limiter.tryConsume(input.rateKind, input.bucketId, this.now());
    if (!rate.ok) {
      const refused = rate.windows.find((state) => state.count > state.limit);
      return {
        ok: false,
        kind: "rate_limited",
        errcode: null,
        errmsg:
          refused === undefined
            ? "本地限速桶已满"
            : "本地限速桶已满（" + String(refused.count) + "/" + String(refused.limit) + "）",
        retryAt: rate.retryAt,
        attempts: 0,
        state: this.state,
      };
    }
    const reqId = this.nextReqId("aibot_send_msg");
    const ack = this.waitAck(reqId);
    const sent = this.sendFrame({
      cmd: "aibot_send_msg",
      headers: { req_id: reqId },
      body: { chatid: input.target, chat_type: input.chatType, msgtype: "markdown", markdown: { content: input.content } },
    });
    if (!sent) {
      this.cancelAck(reqId, "closed");
    }
    const outcome = await ack;
    if (!outcome.ok) {
      return {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg: outcome.reason === "timeout" ? "推送回执超时" : "连接已断开（推送未确认）",
        retryAt: null,
        attempts: sent ? 1 : 0,
        state: this.state,
      };
    }
    const errcode = typeof outcome.frame.errcode === "number" ? outcome.frame.errcode : null;
    const errmsg = typeof outcome.frame.errmsg === "string" ? outcome.frame.errmsg : null;
    if (errcode === 0) {
      return { ok: true, attempts: 1 };
    }
    if (errcode === null) {
      return { ok: false, kind: "retryable", errcode: null, errmsg: "回执缺 errcode", retryAt: null, attempts: 1, state: this.state };
    }
    const kind =
      input.channel === "wecom_group"
        ? classifyWecomErrcode("wecom_group", errcode, { groupActivated: input.activated })
        : classifyWecomErrcode("wecom_aibot", errcode, { dmActivated: input.activated });
    return { ok: false, kind, errcode, errmsg, retryAt: null, attempts: 1, state: this.state };
  }

  // ---- 连接与帧处理 ----

  private connect(): void {
    if (this.stopped || this.socket !== null) {
      return;
    }
    this.setState("connecting");
    this.counters.connects += 1;
    let socket: AibotSocket;
    try {
      socket = this.options.socketFactory(this.options.wsUrl);
    } catch (error) {
      this.scheduleReconnect("建立连接失败：" + describeNetworkError(error));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) {
        return;
      }
      this.subscribe(socket);
    };
    socket.onmessage = (data) => {
      if (this.socket !== socket) {
        return;
      }
      this.onFrame(data);
    };
    socket.onclose = (code, reason) => {
      this.onSocketClosed(socket, code, reason);
    };
    socket.onerror = (error) => {
      this.counters.lastError = describeNetworkError(error);
    };
  }

  private subscribe(socket: AibotSocket): void {
    const reqId = this.nextReqId("aibot_subscribe");
    this.counters.subscribes += 1;
    void this.waitAck(reqId).then((outcome) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleSubscribeAck(outcome);
    });
    const sent = this.sendFrame({
      cmd: "aibot_subscribe",
      headers: { req_id: reqId },
      body: { bot_id: this.options.botId, secret: this.options.secret },
    });
    if (!sent) {
      this.dropSocket("订阅帧发送失败");
    }
  }

  private handleSubscribeAck(outcome: AckOutcome): void {
    if (outcome.ok && typeof outcome.frame.errcode === "number" && outcome.frame.errcode === 0) {
      this.setState("subscribed");
      this.backoffMs = 0;
      this.missedPongs = 0;
      this.counters.lastSubscribedAt = new Date(this.now());
      this.startPing();
      return;
    }
    let detail: string;
    if (outcome.ok) {
      const code = typeof outcome.frame.errcode === "number" ? String(outcome.frame.errcode) : "?";
      const text = typeof outcome.frame.errmsg === "string" ? " " + outcome.frame.errmsg : "";
      detail = "errcode=" + code + text;
    } else {
      detail = outcome.reason === "timeout" ? "订阅回执超时" : "连接已断开";
    }
    this.dropSocket("订阅失败：" + detail);
  }

  private onFrame(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const frame = asRecord(parsed);
    if (frame === null) {
      return;
    }
    this.counters.framesIn += 1;
    const headers = asRecord(frame["headers"]);
    const reqId = readString(headers, "req_id");
    if (reqId !== null) {
      const waiter = this.pending.get(reqId);
      if (waiter !== undefined) {
        this.pending.delete(reqId);
        waiter({ ok: true, frame: frame as AibotAckFrame });
        return;
      }
      if (reqId.startsWith("ping")) {
        this.missedPongs = 0;
        return;
      }
    }
    const cmd = frame["cmd"];
    if (cmd === "aibot_msg_callback" || cmd === "aibot_event_callback") {
      this.dispatchCallback(cmd, reqId, frame);
    }
  }

  private dispatchCallback(cmd: "aibot_msg_callback" | "aibot_event_callback", reqId: string | null, frame: Record<string, unknown>): void {
    const body = asRecord(frame["body"]);
    const from = body === null ? null : asRecord(body["from"]);
    const text = body === null ? null : asRecord(body["text"]);
    const message: AibotIncomingMessage = {
      cmd,
      reqId,
      chatid: readString(body, "chatid"),
      chattype: readString(body, "chattype"),
      fromUserId: readString(from, "userid"),
      msgid: readString(body, "msgid"),
      msgtype: readString(body, "msgtype"),
      text: readString(text, "content"),
    };
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        // 回调处理器异常不影响连接（记录 / 重试由消费侧自理）
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => {
      if (this.stopped || this.state !== "subscribed" || this.socket === null) {
        return;
      }
      if (this.missedPongs >= 2) {
        this.dropSocket("心跳失联（连续 2 个周期无回执）");
        return;
      }
      this.missedPongs += 1;
      this.sendFrame({ cmd: "ping", headers: { req_id: this.nextReqId("ping") } });
    }, this.options.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** 主动断开当前连接（此处不排重连 —— 由调用方语境决定：订阅失败 / 心跳失联均在本方法内排程）。 */
  private dropSocket(reason: string): void {
    this.counters.lastError = reason;
    const socket = this.socket;
    this.socket = null;
    this.stopPing();
    this.failPending("closed");
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // 忽略关闭异常
      }
    }
    if (!this.stopped) {
      this.scheduleReconnect(reason);
    }
  }

  private onSocketClosed(socket: AibotSocket, code: number, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.stopPing();
    this.failPending("closed");
    if (this.stopped) {
      this.setState("stopped");
      return;
    }
    this.scheduleReconnect("连接断开（code=" + String(code) + (reason === "" ? "" : " " + reason) + "）");
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return;
    }
    this.counters.reconnects += 1;
    this.counters.lastError = reason;
    this.setState("backoff");
    const delay = this.backoffMs === 0 ? this.options.reconnectMinMs : Math.min(this.backoffMs * 2, this.options.reconnectMaxMs);
    this.backoffMs = delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** 状态迁移统一入口：进入 subscribed 唤醒等待者 true，进入 stopped 唤醒 false。 */
  private setState(next: AibotConnectionState): void {
    this.state = next;
    if (next === "subscribed") {
      this.resolveSubscribedWaiters(true);
    } else if (next === "stopped") {
      this.resolveSubscribedWaiters(false);
    }
  }

  private resolveSubscribedWaiters(ready: boolean): void {
    const waiters = [...this.subscribedWaiters];
    this.subscribedWaiters.clear();
    for (const waiter of waiters) {
      waiter(ready);
    }
  }

  private waitAck(reqId: string): Promise<AckOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ ok: false, reason: "timeout" });
      }, this.options.ackTimeoutMs);
      this.pending.set(reqId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  private cancelAck(reqId: string, reason: "timeout" | "closed"): void {
    const waiter = this.pending.get(reqId);
    if (waiter !== undefined) {
      this.pending.delete(reqId);
      waiter({ ok: false, reason });
    }
  }

  private failPending(reason: "timeout" | "closed"): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      waiter({ ok: false, reason });
    }
  }

  private sendFrame(frame: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (socket === null) {
      return false;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.counters.lastError = describeNetworkError(error);
      return false;
    }
    this.counters.framesOut += 1;
    return true;
  }

  private nextReqId(prefix: string): string {
    return prefix + "_" + String(this.now()) + "_" + Math.random().toString(36).slice(2, 8);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

export interface WecomAibotOverrides {
  limiter?: WecomRateLimiter;
  store?: RateWindowStore;
  socketFactory?: AibotSocketFactory;
  now?: () => number;
}

/** 环境装配（读 WECOM_BOT_* env；单测 / stub 回放注入 socketFactory / 内存计数 / 时钟）。 */
export function createWecomAibotClientFromEnv(
  env: Env,
  overrides: WecomAibotOverrides = {},
): { aibot: WecomAibotClient; limiter: WecomRateLimiter } {
  const limiter =
    overrides.limiter ??
    new WecomRateLimiter({
      store: overrides.store ?? new InMemoryRateWindowStore(),
      windows: [
        // 群通道（M5-03-2）与单聊通道（M5-03-5-3）各双窗口；单聊先复用同组 env 数值（P5 真机后再定是否拆 WECOM_BOT_DM_*）。
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: env.WECOM_BOT_RATE_LIMIT_PER_MINUTE },
        { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: env.WECOM_BOT_RATE_LIMIT_PER_HOUR },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: env.WECOM_BOT_RATE_LIMIT_PER_MINUTE },
        { kind: "single", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: env.WECOM_BOT_RATE_LIMIT_PER_HOUR },
      ],
      now: overrides.now,
    });
  const aibot = new WecomAibotClient({
    wsUrl: env.WECOM_BOT_WS_URL,
    botId: env.WECOM_BOT_ID,
    secret: env.WECOM_BOT_SECRET,
    pingIntervalMs: env.WECOM_BOT_PING_INTERVAL_MS,
    ackTimeoutMs: env.WECOM_BOT_ACK_TIMEOUT_MS,
    reconnectMinMs: env.WECOM_BOT_RECONNECT_MIN_MS,
    reconnectMaxMs: env.WECOM_BOT_RECONNECT_MAX_MS,
    socketFactory: overrides.socketFactory ?? createWsSocketFactory(),
    limiter,
    now: overrides.now,
  });
  return { aibot, limiter };
}

/** ws 传输层实现（生产路径；全仓唯一 import "ws" 处 —— 其余测试 / 回放一律走 socketFactory 替身）。 */
export function createWsSocketFactory(): AibotSocketFactory {
  return (url) => {
    const ws = new WebSocketImpl(url);
    const socket: AibotSocket = {
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.on("open", () => {
      socket.onopen?.();
    });
    ws.on("message", (data) => {
      socket.onmessage?.(typeof data === "string" ? data : data.toString());
    });
    ws.on("close", (code, reason) => {
      socket.onclose?.(code, reason.toString());
    });
    ws.on("error", (error) => {
      socket.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
    return socket;
  };
}
