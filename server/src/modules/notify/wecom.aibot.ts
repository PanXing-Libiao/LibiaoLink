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
 *   - 欢迎语回复 `aibot_respond_welcome_msg`（单聊 `enter_chat` 事件）：透传事件回调 `headers.req_id`，
 *     body = `{ msgtype: "text", text: { content } }`；官方要求在收到事件后 5 秒内发送；
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
import { createHash } from "node:crypto";
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

/** 智能机器人图片素材上限（官方长连接文档：图片不超过 10MB，支持 png / jpg / jpeg / gif）。 */
export const WECOM_AIBOT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 素材分片大小：10MB 上限下最多 20 片，远低于官方 100 片限制。 */
export const WECOM_AIBOT_MEDIA_CHUNK_BYTES = 512 * 1024;
export const WECOM_AIBOT_MEDIA_MAX_CHUNKS = 100;
/** 只缓存 2 天：官方 media_id 有效期约 3 天，留 1 天安全余量。 */
export const WECOM_AIBOT_MEDIA_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
export const WECOM_AIBOT_MEDIA_CACHE_MAX_ENTRIES = 32;

export type AibotImageMimeType = "image/png" | "image/jpeg" | "image/gif";

export type AibotConnectionState = "stopped" | "connecting" | "subscribed" | "backoff";

/** 回执帧（订阅 / 推送 / 心跳共形）：errcode 在帧顶层；字段逐项 typeof 松读。 */
interface AibotAckFrame {
  errcode?: unknown;
  errmsg?: unknown;
  body?: unknown;
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
  /** 群名（企微回调可选携带；未携带 = undefined，不参与单聊 / 事件语义）。 */
  chatName?: string | null;
  fromUserId: string | null;
  msgid: string | null;
  /** 消息类型（text / image / …；事件回调为 event）。 */
  msgtype: string | null;
  /** 文本正文（msgtype = text 时非空；其余为 null）。 */
  text: string | null;
  /** 事件类型（cmd = aibot_event_callback 时取 body.event.eventtype；消息回调为 null）。 */
  eventType: string | null;
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

type AibotUploadResult =
  | { ok: true; mediaId: string }
  | { ok: false; kind: WecomFailureKind; errcode: number | null; errmsg: string | null };

type AibotImageValidation =
  | { ok: true; mime: AibotImageMimeType; totalChunks: number }
  | { ok: false; reason: string };

export function aibotImageMimeFromFileName(fileName: string): AibotImageMimeType | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  return null;
}

function normalizeAibotImageMime(mime: string | null | undefined): AibotImageMimeType | null {
  if (mime === null || mime === undefined) {
    return null;
  }
  const normalized = mime.trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/gif") return "image/gif";
  return null;
}

function validateAibotImage(input: {
  content: Buffer;
  fileName: string;
  mime: string | null | undefined;
}): AibotImageValidation {
  const mime = normalizeAibotImageMime(input.mime) ?? aibotImageMimeFromFileName(input.fileName);
  if (mime === null) {
    return { ok: false, reason: "图片格式不受支持（仅支持 PNG / JPG / GIF）" };
  }
  if (input.fileName.trim() === "") {
    return { ok: false, reason: "图片文件名为空" };
  }
  if (Buffer.byteLength(input.fileName, "utf8") > 256) {
    return { ok: false, reason: "图片文件名超过 256 字节" };
  }
  if (!Buffer.isBuffer(input.content)) {
    return { ok: false, reason: "图片内容必须是 Buffer" };
  }
  if (input.content.length < 5) {
    return { ok: false, reason: "图片内容过短（至少 5 字节）" };
  }
  if (input.content.length > WECOM_AIBOT_IMAGE_MAX_BYTES) {
    return { ok: false, reason: "图片超过 10MB 上限" };
  }
  const totalChunks = Math.ceil(input.content.length / WECOM_AIBOT_MEDIA_CHUNK_BYTES);
  if (totalChunks > WECOM_AIBOT_MEDIA_MAX_CHUNKS) {
    return { ok: false, reason: "图片分片数超过 100 片" };
  }
  return { ok: true, mime, totalChunks };
}

export class WecomAibotClient {
  private socket: AibotSocket | null = null;
  private state: AibotConnectionState = "stopped";
  private stopped = true;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, (outcome: AckOutcome) => void>();
  private readonly handlers = new Set<(message: AibotIncomingMessage) => void>();
  private readonly stateWaiters = new Set<(state: AibotConnectionState) => void>();
  private readonly mediaCache = new Map<string, { mediaId: string; expiresAt: number }>();
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
   * 等待长连接进入 subscribed（worker 首轮告警探针前置 · 2026-10-19）：已订阅立即 true；
   * 超时 / stop() 返回 false —— 调用方按原口径继续探测（发送失败回退结构化日志，不阻塞启动）。
   * 只等「这一次」进入 subscribed：不缓存历史订阅态（重连后由调用方按需再等）。
   */
  waitForSubscribed(timeoutMs: number): Promise<boolean> {
    if (this.state === "subscribed") {
      return Promise.resolve(true);
    }
    if (this.stopped) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      let waiter: ((state: AibotConnectionState) => void) | null = null;
      const finish = (value: boolean): void => {
        if (done) {
          return;
        }
        done = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        if (waiter !== null) {
          this.stateWaiters.delete(waiter);
        }
        resolve(value);
      };
      waiter = (state: AibotConnectionState): void => {
        if (state === "subscribed" || state === "stopped") {
          finish(state === "subscribed");
        }
      };
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.stateWaiters.add(waiter);
    });
  }

  /** 状态迁移唯一入口：赋值后通知 waitForSubscribed 的等待者（订阅 / 停止两类事件）。 */
  private setState(next: AibotConnectionState): void {
    this.state = next;
    for (const waiter of [...this.stateWaiters]) {
      waiter(next);
    }
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
   * 群图片推送：先上传图片素材取得 media_id，再走 aibot_send_msg 的 image 消息。
   *
   * 上传帧序列（官方长连接文档）：
   *   aibot_upload_media_init（type / filename / total_size / total_chunks / md5）
   *   → aibot_upload_media_chunk × N（upload_id + chunk_index + base64_data）
   *   → aibot_upload_media_finish（upload_id）→ media_id
   *
   * 同一图片内容在 2 天内复用 media_id；图片发送与 markdown 共用群会话双窗口限速。
   * 上传失败不产生消息帧；发送失败沿用群通道错误分类与降级语义。
   */
  async sendGroupImage(params: {
    chatid: string;
    content: Buffer;
    fileName: string;
    mime?: string | null;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    const validation = validateAibotImage({
      content: params.content,
      fileName: params.fileName,
      mime: params.mime,
    });
    if (!validation.ok) {
      return {
        ok: false,
        kind: "permanent",
        errcode: null,
        errmsg: validation.reason,
        retryAt: null,
        attempts: 0,
        state: this.state,
      };
    }
    if (this.state !== "subscribed" || this.socket === null) {
      return this.notReadyResult();
    }
    const upload = await this.uploadImage({
      content: params.content,
      fileName: params.fileName,
      mime: validation.mime,
      totalChunks: validation.totalChunks,
      activated: params.groupActivated ?? null,
    });
    if (!upload.ok) {
      return {
        ok: false,
        kind: upload.kind,
        errcode: upload.errcode,
        errmsg: upload.errmsg,
        retryAt: null,
        attempts: 0,
        state: this.state,
      };
    }
    return this.sendMessage({
      target: params.chatid,
      chatType: 2,
      rateKind: "group",
      channel: "wecom_group",
      bucketId: chatBucketId(params.chatid),
      activated: params.groupActivated ?? null,
      message: { msgtype: "image", image: { media_id: upload.mediaId } },
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
  async replyToCallback(params: {
    reqId: string;
    userid: string;
    content: string;
    /** 群聊回调传 chatid：限速计入该群桶；单聊不传，沿用 userid 单聊桶。 */
    chatid?: string | null;
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
    const rate =
      params.chatid === undefined || params.chatid === null || params.chatid === ""
        ? await this.options.limiter.tryConsume("single", userBucketId(params.userid), this.now())
        : await this.options.limiter.tryConsume("group", chatBucketId(params.chatid), this.now());
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

  /**
   * 进入单聊会话欢迎语（企微智能机器人 `enter_chat` 事件）：被动回复走 `aibot_respond_welcome_msg`，
   * 透传事件回调的 `req_id`（官方要求 5 秒内发送）；body = 纯文本消息。欢迎语不占用绑定回执的流式
   * 消息形态，也不计入本地单聊限速桶（事件回调有独立时效，优先送达）。
   */
  async replyWelcome(params: { reqId: string; content: string }): Promise<AibotSendResult> {
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
    const ack = this.waitAck(params.reqId);
    const sent = this.sendFrame({
      cmd: "aibot_respond_welcome_msg",
      headers: { req_id: params.reqId },
      body: { msgtype: "text", text: { content: params.content } },
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
        errmsg: outcome.reason === "timeout" ? "欢迎语回执超时" : "连接已断开（欢迎语未确认）",
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

  /** markdown 消息主体：复用统一发送与错误分类。 */
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
    return this.sendMessage({
      target: input.target,
      chatType: input.chatType,
      rateKind: input.rateKind,
      channel: input.channel,
      bucketId: input.bucketId,
      activated: input.activated,
      message: { msgtype: "markdown", markdown: { content: input.content } },
    });
  }

  private notReadyResult(): AibotSendResult {
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

  /** 主动推送主体（群 / 单聊共用）：限速（双窗口按目标桶）→ aibot_send_msg → 等回执 → 分类。 */
  private async sendMessage(input: {
    target: string;
    chatType: 1 | 2;
    rateKind: "group" | "single";
    channel: "wecom_group" | "wecom_aibot";
    bucketId: string;
    activated: boolean | null;
    message: Record<string, unknown>;
  }): Promise<AibotSendResult> {
    if (this.state !== "subscribed" || this.socket === null) {
      return this.notReadyResult();
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
      body: { chatid: input.target, chat_type: input.chatType, ...input.message },
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

  /**
   * 上传图片素材。init / chunk / finish 每帧都等待回执；成功结果按内容 MD5 缓存 2 天。
   * 上传本身不计入消息限速，真正发送 image 消息时由 sendMessage 计一次群消息配额。
   */
  private async uploadImage(input: {
    content: Buffer;
    fileName: string;
    mime: AibotImageMimeType;
    totalChunks: number;
    activated: boolean | null;
  }): Promise<AibotUploadResult> {
    const digest = createHash("md5").update(input.content).digest("hex");
    const now = this.now();
    const cached = this.mediaCache.get(digest);
    if (cached !== undefined) {
      if (cached.expiresAt > now) {
        return { ok: true, mediaId: cached.mediaId };
      }
      this.mediaCache.delete(digest);
    }
    if (this.state !== "subscribed" || this.socket === null) {
      return { ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪（state=" + this.state + "）" };
    }

    const init = await this.sendControlFrame("aibot_upload_media_init", {
      type: "image",
      filename: input.fileName,
      total_size: input.content.length,
      total_chunks: input.totalChunks,
      md5: digest,
    });
    if (!init.ok) {
      return this.uploadFailure(init, "素材上传初始化", input.activated);
    }
    const initCode = typeof init.frame.errcode === "number" ? init.frame.errcode : null;
    if (initCode !== 0) {
      return this.uploadFailure(init, "素材上传初始化", input.activated);
    }
    const uploadId = readString(asRecord(init.frame.body), "upload_id");
    if (uploadId === null || uploadId.trim() === "") {
      return { ok: false, kind: "retryable", errcode: initCode, errmsg: "素材上传初始化回执缺少 upload_id" };
    }

    for (let index = 0; index < input.totalChunks; index += 1) {
      const from = index * WECOM_AIBOT_MEDIA_CHUNK_BYTES;
      const to = Math.min(from + WECOM_AIBOT_MEDIA_CHUNK_BYTES, input.content.length);
      const chunk = await this.sendControlFrame("aibot_upload_media_chunk", {
        upload_id: uploadId,
        chunk_index: String(index),
        base64_data: input.content.subarray(from, to).toString("base64"),
      });
      if (!chunk.ok) {
        return this.uploadFailure(chunk, "素材分片上传", input.activated);
      }
      const chunkCode = typeof chunk.frame.errcode === "number" ? chunk.frame.errcode : null;
      if (chunkCode !== 0) {
        return this.uploadFailure(chunk, "素材分片上传", input.activated);
      }
    }

    const finish = await this.sendControlFrame("aibot_upload_media_finish", { upload_id: uploadId });
    if (!finish.ok) {
      return this.uploadFailure(finish, "素材上传合并", input.activated);
    }
    const finishCode = typeof finish.frame.errcode === "number" ? finish.frame.errcode : null;
    if (finishCode !== 0) {
      return this.uploadFailure(finish, "素材上传合并", input.activated);
    }
    const mediaId = readString(asRecord(finish.frame.body), "media_id");
    if (mediaId === null || mediaId.trim() === "") {
      return { ok: false, kind: "retryable", errcode: finishCode, errmsg: "素材上传合并回执缺少 media_id" };
    }
    this.rememberMedia(digest, mediaId);
    return { ok: true, mediaId };
  }

  private async sendControlFrame(cmd: string, body: Record<string, unknown>): Promise<AckOutcome> {
    if (this.state !== "subscribed" || this.socket === null) {
      return { ok: false, reason: "closed" };
    }
    const reqId = this.nextReqId(cmd);
    const ack = this.waitAck(reqId);
    const sent = this.sendFrame({ cmd, headers: { req_id: reqId }, body });
    if (!sent) {
      this.cancelAck(reqId, "closed");
    }
    return ack;
  }

  private uploadFailure(outcome: AckOutcome, stage: string, activated: boolean | null): AibotUploadResult {
    if (!outcome.ok) {
      return {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg:
          outcome.reason === "timeout"
            ? stage + "回执超时"
            : "连接已断开（" + stage + "未确认）",
      };
    }
    const errcode = typeof outcome.frame.errcode === "number" ? outcome.frame.errcode : null;
    const errmsg = typeof outcome.frame.errmsg === "string" ? outcome.frame.errmsg : null;
    if (errcode === null) {
      return { ok: false, kind: "retryable", errcode: null, errmsg: stage + "回执缺 errcode" };
    }
    return {
      ok: false,
      kind: classifyWecomErrcode("wecom_group", errcode, { groupActivated: activated }),
      errcode,
      errmsg,
    };
  }

  private rememberMedia(digest: string, mediaId: string): void {
    const expiresAt = this.now() + WECOM_AIBOT_MEDIA_CACHE_TTL_MS;
    this.mediaCache.set(digest, { mediaId, expiresAt });
    while (this.mediaCache.size > WECOM_AIBOT_MEDIA_CACHE_MAX_ENTRIES) {
      const oldest = this.mediaCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.mediaCache.delete(oldest);
    }
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
    const event = body === null ? null : asRecord(body["event"]);
    const chatName = readString(body, "chatname") ?? readString(body, "chat_name");
    const message: AibotIncomingMessage = {
      cmd,
      reqId,
      chatid: readString(body, "chatid"),
      chattype: readString(body, "chattype"),
      fromUserId: readString(from, "userid"),
      msgid: readString(body, "msgid"),
      msgtype: readString(body, "msgtype"),
      text: readString(text, "content"),
      eventType: readString(event, "eventtype"),
    };
    if (chatName !== null && chatName.trim() !== "") {
      message.chatName = chatName.trim();
    }
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
