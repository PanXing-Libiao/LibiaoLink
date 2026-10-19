/**
 * 单聊 aibot 投递消费 + 绑定码 ingest（M5-03-5-3 实现段 · M5-03-5-6 绑定码链路；
 * outbox 主题 `notify.message` 的 channel=wecom_aibot 分支；生产路由 / 产出接线 / worker 回调分流随 M5-03-5-4）。
 *
 * 寻址口径（M5-03-5-6 · 口径 §7 核心变更）：发送地址 = 绑定行 `wecom_aibot_dm_activations.wecom_userid`
 * （回调 from.userid 原文 = 密文 open_userid，按 `bot_id` = 当前机器人取）；**无绑定行 → 不发帧**，按
 * permanent 收口（dead + C5-04 降级 · D4 未绑定话术）。`users.username`（明文）不再参与单聊寻址。
 *
 * 一次消费 = 解析载荷 → 读收件人 → 读绑定行（寻址 + 是否可投递）→ 组装 markdown（截断）
 * → 读激活表（846607 分流依据 + 旁证回填判重）→ `WecomAibotClient.sendUserMarkdown` → 三分类收敛 +
 * 投递留痕（notify_deliveries · channel=wecom_aibot、target=userid）：
 *   ok                                 → done（sent 行；发送成功旁证回填激活表 —— D4，失败只 warn 不影响 done）；
 *   rate_limited（本地桶 / 846607 命中激活表）→ deferred（deferred 行；availableAt = retryAt ?? now+60s；不消耗重试次数）；
 *   retryable（断连 / 未订阅 / 回执超时） → retry（failed 行）；
 *   permanent（853000 / 846601 / 846607 未命中激活表）→ dead（dead 行）+ C5-04 降级（同收件人站内信）；
 *   收件人不可投递（不存在 / 停用 / 离职 / 未绑定企微）→ 不发帧，按 permanent 收口（同 app 口径：用户存在即降级）。
 *
 * C5-04 降级：经 `NotifyService.deliverInboxCopy` —— 站内信行走同一落行 / 合并 / 免打扰 / 实时流口径；
 * 幂等键 = 来源 dedupeKey + ":c504"。未绑定企微（无绑定行）/ 846607 未命中激活表 = 无可用地址的确定性失败
 * → 降级前缀附绑定指引话术（**D4 定稿 2026-10-16**：「当前用户未绑定企业微信，请前往设置补绑」）；其余失败用通用前缀。降级写库失败 →
 * retry 收敛（有界重试，不静默丢消息）。管理员告警群留痕由 outbox 死信告警自动承担（dispatcher → OUTBOX_ALERT_SINK）。
 *
 * 绑定码链路（M5-03-5-6 · 口径 §3 / §5；HTTP 面随契约刀 Push 249 落 `/api/v1/wecom-dm-binding`；
 * Push 254 起口径 v1.8：TTL 5 分钟 · 取码 5 次 / 3 分钟 · 换绑以码持有者为准 · 读面回填）：
 * `requestBindingCode`（取码）/ `ingestCallback`（单聊发码 → 同事务写绑定 + 标记码已用 → 会话内回执
 * `aibot_respond_msg`）/ `getBindingState`（读绑定态：v1.8 另回当前未用码与取码限流可重试时刻）/ `unbind`
 * （解绑：同事务清绑定行 + 写 `audit_logs` —— D6；跨用户换绑同写 `audit_logs`）。
 *
 * 超长口径（B5 定案 · 同群口径）：markdown 按 UTF-8 字节截断（≤ 20000 字节，留 20480 官方上限余量），
 * 尾部省略 + warn 留痕。免打扰口径同 M5-03-3（不做投递前 DND 过滤）。安全：userid 只进库与限速桶摘要；
 * 日志 / outbox error 一律掩码（末 4 位）。
 */
import { randomInt } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { NotifyMessagePayload, WecomDmBindingState } from "@libiaolink/contracts";
import { AppConfig } from "../../config/config.module.js";
import { ClockService } from "../../common/clock/clock.service.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import { AuditService } from "../audit/index.js";
import { maskUserid } from "./notify.app.service.js";
import { parseNotifyMessage } from "./notify.delivery.js";
import { NotifyDmRepository } from "./notify.dm.repository.js";
import { NotifyService } from "./notify.service.js";
import type { AibotIncomingMessage, AibotSendResult } from "./wecom.aibot.js";
import { WecomAibotClient } from "./wecom.aibot.js";
import { describeWecomFailure, WECOM_BOT_FREQ_ERRCODE } from "./wecom.errors.js";
import { truncateUtf8Bytes } from "./wecom.text.js";

/** 单聊 markdown 字节上限（官方口径 20480；取 20000 留余量 —— 同群口径）。 */
export const DM_MARKDOWN_MAX_BYTES = 20_000;

/** 截断省略后缀（尾部省略口径）。 */
export const DM_TRUNCATION_SUFFIX = "\n\n…（内容过长，已截断）";

/** 降级站内信前缀（C5-04：企微失败 → 站内信；正文保留原文，前缀标注来源变化）。 */
export const DM_DEGRADE_PREFIX = "【企微未送达，已转站内信】\n\n";

/**
 * 未绑定企微降级前缀（**D4 定稿 2026-10-16** · 口径 §6 / §10 —— 替换原 B6「请私发任意消息激活」：
 * 绑定码口径下「随便发条消息」不再产生可投递地址）。触发 = 收件人无绑定行（不发帧即判 permanent），
 * 以及兜底的「846607 且未命中激活表」分支；其余 permanent 失败用通用前缀，不误导用户去绑定。
 */
export const DM_BINDING_DEGRADE_PREFIX =
  "【企微未送达，已转站内信】\n" +
  "当前用户未绑定企业微信，请前往设置补绑\n\n";

/** 单聊 userid 字符集（同激活表 CHECK `^[A-Za-z0-9_.@-]{1,64}$`）—— 回调脏数据防御，不替代 DB 约束。 */
const DM_USERID_PATTERN = /^[A-Za-z0-9_.@-]{1,64}$/;

/** 绑定码形态（D3 定案：6 位数字）—— 与迁移 0055 CHECK `^[0-9]{6}$` 同口径。 */
export const DM_BINDING_CODE_PATTERN = /^[0-9]{6}$/;

/** 绑定码有效期（D3 修订 v1.8 · 2026-10-16：TTL 5 分钟 —— 原 10 分钟，用户口径「码 5 分钟内有效」）。 */
export const DM_BINDING_CODE_TTL_MS = 5 * 60_000;

/** 绑定码生成频率窗口（D3 修订 v1.8 · 2026-10-16：3 分钟滚动窗口；最长等待 = 窗口长度）。 */
export const DM_BINDING_CODE_WINDOW_MS = 3 * 60_000;

/** 绑定码生成频率上限（D3 修订 v1.8 · 2026-10-16：5 次 / 3 分钟 / 用户 —— 罚时上限 3 分钟）。 */
export const DM_BINDING_CODE_MAX_PER_WINDOW = 5;

/** 绑定码生成冲突重试次数（6 位数字空间 1e6，撞码概率极低；到顶抛错由调用方按 5xx 收口）。 */
const DM_BINDING_CODE_ATTEMPTS = 8;

/** 会话内回执话术（口径 §5 反馈面；未命中任何码 → 不回复，防探测）。 */
export const DM_BINDING_REPLY_BOUND = "绑定成功";
export const DM_BINDING_REPLY_INVALID = "码已失效，请重新获取";

/** markdown 组装（同群口径）：加粗标题 + 空行 + 正文；标题空白防御（解析后已 trim，非空为常态）。 */
export function composeDmMarkdown(message: Pick<NotifyMessagePayload, "title" | "body">): string {
  const title = message.title.trim();
  return title === "" ? message.body : "**" + title + "**\n\n" + message.body;
}

/** UTF-8 字节截断（不劈开多字节字符）：未超长原样返回；超长截到 maxBytes - 后缀，尾部拼省略标记。 */
export function truncateDmMarkdown(content: string, maxBytes: number = DM_MARKDOWN_MAX_BYTES): {
  content: string;
  truncated: boolean;
} {
  return truncateUtf8Bytes(content, maxBytes, DM_TRUNCATION_SUFFIX);
}

/**
 * 正文归一取码（口径 §5）：trim → 去群聊 `@<机器人名>` 前缀（单聊无此形态，容错用）→ 提取 6 位数字
 * （前后不接数字，避免从长数字串里截半）。正文只在本函数内短暂持有：不入库、不落日志（CONTRIBUTING §12）；
 * 未命中 = null（调用方按「登记激活 + 不回复」收口）。
 */
export function extractBindingCode(text: string): string | null {
  const normalized = text.trim().replace(/^@\S+\s+/, "");
  const matched = /(?<!\d)([0-9]{6})(?!\d)/.exec(normalized);
  return matched === null ? null : (matched[1] ?? null);
}

/** 6 位数字绑定码（随机；唯一性由 DB 唯一索引保证，撞码由调用方换码重试）。 */
function randomBindingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** 失败描述（核心语义：errcode + 白话标签 / errmsg 概要；不含 kind / state 内部态与企微机器尾巴；不含 userid 明文）。 */
function describeDmFailure(result: Extract<AibotSendResult, { ok: false }>): string {
  return "单聊消息未送达" + describeWecomFailure(result.errcode, result.errmsg);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 单聊 aibot 消费服务（worker 注册表 · 由 OutboxModule 按载荷 channel 路由 —— 接线随 M5-03-5-4）：
 * handler 只做业务与分类，outbox 回写统一由 dispatcher 收敛；任何异常都不外抛（同 NotifyAppService 口径）。
 */
@Injectable()
export class NotifyDmService {
  private readonly logger = new Logger(NotifyDmService.name);

  constructor(
    private readonly repository: NotifyDmRepository,
    private readonly aibot: WecomAibotClient,
    private readonly notify: NotifyService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /** 当前机器人维度（WECOM_BOT_ID 原文）：激活表 / 绑定码一律按 (bot_id, …) 成对读写（D2 定案）。 */
  private botId(): string {
    return this.config.env.WECOM_BOT_ID;
  }

  /**
   * 单聊回调 ingest（M5-03-5-6 · 口径 §5；长连接 `onMessage` 接线在 entry/worker.ts）：
   * ① 过滤：仅 cmd=aibot_msg_callback 且 chattype=single 且 from.userid 合法；事件回调（enter_chat 等）与
   *    群聊一律不处理（群聊不绑定 —— 防「发到群里以为绑定成功」）；
   * ② 登记（D1）：任何单聊消息都写激活登记（刷新 last_message_at，不动 user_id / bound_at）—— 保留 846607
   *    分流与观测，但该行不可作发送地址；
   * ③ 取码：非文本消息 / 正文不含 6 位数字 → 到此为止（不回复 —— 防探测）；
   * ④ 码不存在 → 不回复（防探测）；码已用 / 已过期 → 回「码已失效，请重新获取」；例外：码已被**本人**用掉
   *    且该企微号仍绑定在该码持有者名下（回调重复投递）→ 回「绑定成功」（幂等，不再动库）；
   * ⑤ 命中 pending 码 → **以码持有者为准**换绑（v1.8：发送方企微号已挂在别的库内用户上时不再短路「已绑定」，
   *    改由 `bindWithCode` 把该 (bot_id, wecom_userid) 行改挂到码的持有者，旧持有者回落未绑定）
   *    → 同一事务写绑定行 + 标记码已用（跨用户时另写 `audit_logs`）→ 回「绑定成功」。
   * 正文只做码匹配：不入库、不落日志；userid 非法（CHECK 字符集）→ 掩码 warn 忽略（防脏数据打断 ingest）。
   */
  async ingestCallback(incoming: AibotIncomingMessage): Promise<void> {
    if (incoming.cmd !== "aibot_msg_callback" || incoming.chattype !== "single" || incoming.fromUserId === null) {
      return;
    }
    const userid = incoming.fromUserId;
    if (!DM_USERID_PATTERN.test(userid)) {
      this.logger.warn("单聊回调 userid 非法（忽略，不入库）：" + maskUserid(userid));
      return;
    }
    const botId = this.botId();
    const at = this.clock.now();
    await this.repository.upsertActivationFromCallback({ botId, wecomUserid: userid, at });

    const code = incoming.msgtype === "text" && incoming.text !== null ? extractBindingCode(incoming.text) : null;
    if (code === null) {
      this.logger.log("单聊回调已登记激活（非绑定码消息 · 不可作发送地址）：userid " + maskUserid(userid));
      return;
    }
    const codeRow = await this.repository.findBindingCode(code);
    if (codeRow === null) {
      this.logger.log("单聊正文未命中绑定码（不回复 —— 防探测）：userid " + maskUserid(userid));
      return;
    }
    // 该企微号当前的绑定行（换绑前的旧持有者 —— 亦用于回调重复投递的幂等判定）。
    const previous = await this.repository.findBindingByWecomUserid(userid, botId);
    if (codeRow.status !== "pending" || codeRow.expiresAt.getTime() <= at.getTime()) {
      // 码已被本人用掉且绑定成立 → 回调重复投递幂等：仍回「绑定成功」，不再动库。
      if (codeRow.status === "used" && previous !== null && previous.userId === codeRow.userId) {
        this.logger.log("单聊绑定码已用且绑定成立（回调重复投递幂等）：userid " + maskUserid(userid) + " · code#" + String(codeRow.id));
        await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_BOUND);
        return;
      }
      this.logger.warn("单聊绑定码不可用（已用 / 已过期）：userid " + maskUserid(userid) + " · code#" + String(codeRow.id));
      await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_INVALID);
      return;
    }
    const rebound = previous !== null && previous.userId !== codeRow.userId;
    const boundOk = await this.database.db.transaction(async (tx) => {
      const claimed = await this.repository.bindWithCode(
        { codeId: codeRow.id, userId: codeRow.userId, botId, wecomUserid: userid, at },
        tx,
      );
      if (!claimed) {
        return false;
      }
      if (rebound && previous !== null) {
        await this.recordRebind(tx, { fromUserId: previous.userId, toUserId: codeRow.userId, wecomUserid: userid, botId });
      }
      return true;
    });
    if (!boundOk) {
      this.logger.warn("单聊绑定码占用失败（并发消费 / 恰过期）：userid " + maskUserid(userid) + " · code#" + String(codeRow.id));
      await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_INVALID);
      return;
    }
    this.logger.log(
      "单聊绑定成功（绑定行 = bot_id + userid 掩码）：userid " +
        maskUserid(userid) +
        " · user_id " +
        codeRow.userId +
        (rebound ? "（跨用户换绑）" : ""),
    );
    await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_BOUND);
  }

  /**
   * 会话内回执（尽力而为）：回复失败只 warn，不影响绑定结果（绑定已落库，用户可在设置页看到绑定态）；
   * 缺 req_id（回调异常）→ 不回复（单聊回调无 chatid，回复只能靠 req_id 透传）。
   */
  private async replyToCallback(incoming: AibotIncomingMessage, userid: string, content: string): Promise<void> {
    if (incoming.reqId === null) {
      this.logger.warn("回调缺 req_id，跳过会话内回执：userid " + maskUserid(userid));
      return;
    }
    try {
      const result = await this.aibot.replyToCallback({ reqId: incoming.reqId, userid, content });
      if (!result.ok) {
        this.logger.warn("会话内回执未送达（不影响绑定结果）：userid " + maskUserid(userid) + " —— " + describeDmFailure(result));
      }
    } catch (error) {
      this.logger.warn("会话内回执异常（不影响绑定结果）：userid " + maskUserid(userid) + " —— " + messageOf(error));
    }
  }

  /**
   * 生成绑定码（D3 签发：6 位数字 / TTL 5 分钟 / 一次性；频率口径 D3 修订 v1.8：5 次 / 3 分钟 / 用户）：
   * 频率到顶 → 返回 rate_limited + retryAt（窗口内最早码 + 窗口长度 = 最早的可用时刻，最长 ≤ 3 分钟）；
   * 否则同一事务作废旧 pending 码 + 插入新码（撞码换码重试 DM_BINDING_CODE_ATTEMPTS 次）。
   * HTTP 面（POST /api/v1/wecom-dm-binding/codes · 契约刀）：频率到顶统一映射 429 `RATE_LIMITED` + retryAt。
   */
  async requestBindingCode(userId: string): Promise<
    | { ok: true; code: string; expiresAt: Date; expiresInSeconds: number }
    | { ok: false; reason: "rate_limited"; retryAt: Date }
  > {
    const at = this.clock.now();
    const retryAt = await this.rateLimitedRetryAt(userId, at);
    if (retryAt !== null) {
      this.logger.warn(
        "绑定码生成频率到顶（" +
          String(DM_BINDING_CODE_MAX_PER_WINDOW) +
          " 次 / " +
          String(DM_BINDING_CODE_WINDOW_MS / 60_000) +
          " 分钟）：user_id " +
          userId,
      );
      return { ok: false, reason: "rate_limited", retryAt };
    }
    const expiresAt = new Date(at.getTime() + DM_BINDING_CODE_TTL_MS);
    for (let attempt = 0; attempt < DM_BINDING_CODE_ATTEMPTS; attempt += 1) {
      const code = randomBindingCode();
      if (await this.repository.createBindingCode({ userId, code, expiresAt, at })) {
        this.logger.log("绑定码已生成（TTL 5 分钟 · 旧 pending 码作废）：user_id " + userId);
        return { ok: true, code, expiresAt, expiresInSeconds: Math.round(DM_BINDING_CODE_TTL_MS / 1000) };
      }
    }
    throw new Error("绑定码生成失败（连续 " + String(DM_BINDING_CODE_ATTEMPTS) + " 次撞码）：user_id " + userId);
  }

  /**
   * 绑定态读面（设置页 / 契约读端点 · D5；口径 §6「设置页显示绑定态」）：恒 200 —— 未绑定 = bound:false。
   * 密文 open_userid 只回掩码末 4 位（§9 最小暴露 · 沿用群绑定 `chatidMasked` 先例）。
   * v1.8 回填：另回「当前仍未失效的 pending 绑定码」与「取码限流可重试时刻」—— 页面刷新 / 重进后前端据此
   * 恢复码面、倒计时与罚时（服务端为准，前端不缓存）。
   */
  async getBindingState(userId: string): Promise<WecomDmBindingState> {
    const at = this.clock.now();
    const binding = await this.repository.findBindingByUserId(userId, this.botId());
    const pending = await this.repository.findPendingBindingCode(userId, at);
    const retryAt = await this.rateLimitedRetryAt(userId, at);
    return {
      bound: binding !== null,
      wecomUseridMasked: binding === null ? null : maskUserid(binding.wecomUserid),
      boundAt: binding === null ? null : binding.boundAt.toISOString(),
      bindingCode:
        pending === null
          ? null
          : {
              code: pending.code,
              expiresAt: pending.expiresAt.toISOString(),
              expiresInSeconds: Math.max(1, Math.ceil((pending.expiresAt.getTime() - at.getTime()) / 1000)),
            },
      retryAt: retryAt === null ? null : retryAt.toISOString(),
    };
  }

  /**
   * 取码限流可重试时刻（v1.8 读面回填 · 与 `requestBindingCode` 同一判定，避免两处口径漂移）：
   * 窗口内已签发码不足上限 → null（未到顶）；到顶 → 窗口内最早一码 + 窗口长度（= 最早可再取时刻）。
   */
  private async rateLimitedRetryAt(userId: string, at: Date): Promise<Date | null> {
    const since = new Date(at.getTime() - DM_BINDING_CODE_WINDOW_MS);
    const issuedAt = await this.repository.bindingCodesSince(userId, since);
    if (issuedAt.length < DM_BINDING_CODE_MAX_PER_WINDOW) {
      return null;
    }
    const oldest = issuedAt[0];
    return new Date((oldest === undefined ? at.getTime() : oldest.getTime()) + DM_BINDING_CODE_WINDOW_MS);
  }

  /**
   * 跨用户换绑留痕（v1.8 口径）：同一企微号从旧持有者改挂到码持有者 —— 写 `audit_logs`（objectType=user /
   * action=update，与 D6 解绑的 delete 同一家族：只改「投递资格」，不动用户资产）；摘要与 metadata 只带掩码
   * （§9 最小暴露；changes 记库内 user_id 迁移，便于追责）。与绑定行改挂同一事务（tx）。
   */
  private async recordRebind(
    tx: DbClient,
    input: { fromUserId: string; toUserId: string; wecomUserid: string; botId: string },
  ): Promise<void> {
    const masked = maskUserid(input.wecomUserid);
    await this.audit.record(tx, {
      actorId: input.toUserId,
      action: "update",
      objectType: "user",
      objectId: input.fromUserId,
      summary: "企业微信单聊换绑：open_userid " + masked + " 由用户 " + input.fromUserId + " 改挂到 " + input.toUserId,
      changes: [{ field: "wecomDmBinding.owner", from: input.fromUserId, to: input.toUserId }],
      metadata: { botId: input.botId, wecomUseridMasked: masked },
    });
  }

  /**
   * 解绑（D6 · 口径 §4）：清当前机器人下该用户的绑定行（`bound_at` / `user_id` 置空 —— 保留激活登记行，
   * 与「换绑清旧」同形：注销投递资格、激活痕迹仍在），与清除**同一事务**写 `audit_logs`
   * （objectType=user / action=delete；summary 与 changes 只带掩码 —— §9 最小暴露）。
   * 幂等：本就无绑定（清除 0 行）→ 直接回落 bound:false，不写审计。
   * 返回同 GET 读面（v1.8）：解绑不回收未用绑定码 —— 响应里仍可能带 pending 码与罚时回填（前端据同一读面收敛）。
   */
  async unbind(userId: string, actorId: string): Promise<WecomDmBindingState> {
    const botId = this.botId();
    const binding = await this.repository.findBindingByUserId(userId, botId);
    if (binding === null) {
      return await this.getBindingState(userId);
    }
    const masked = maskUserid(binding.wecomUserid);
    const at = this.clock.now();
    await this.database.db.transaction(async (tx) => {
      const cleared = await this.repository.clearBindingByUserId({ botId, userId, at }, tx);
      if (cleared === 0) {
        return;
      }
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "user",
        objectId: userId,
        summary: "解绑企业微信单聊（open_userid " + masked + "）",
        changes: [{ field: "wecomDmBinding", from: masked, to: null }],
        metadata: { bound: false, botId },
      });
    });
    this.logger.log("企业微信单聊已解绑（绑定行去址 · 审计同事务已写）：user_id " + userId);
    return await this.getBindingState(userId);
  }

  async consume(row: OutboxClaimedRow): Promise<OutboxHandleOutcome> {
    const message = parseNotifyMessage(row.payload);
    if (message === null) {
      this.logger.warn("单聊消息载荷非法，转 dead：outbox#" + row.id + "（" + row.dedupeKey + "）");
      return {
        outcome: "dead",
        error: "单聊消息载荷非法（缺 recipientId / title / body 或超长）：" + row.dedupeKey,
      };
    }
    if (message.channel !== "wecom_aibot") {
      const channel = message.channel;
      this.logger.warn("单聊消息消费渠道异常（渠道路由异常转 dead）：outbox#" + row.id + " · channel=" + channel);
      return {
        outcome: "dead",
        error: "单聊消息消费渠道异常（期望 wecom_aibot，实得 " + channel + "）：" + row.dedupeKey,
      };
    }

    const contact = await this.repository.findContact(message.recipientId);
    if (contact === null) {
      // 用户不存在：站内信 FK 同样不可落 —— 不降级（无收件人可降），dead 一次即弃（同 app 口径）。
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: "user:" + message.recipientId,
        state: "dead",
        attempts: 0,
        error: "收件人不存在（无法降级站内信）",
        sentAt: null,
      });
      this.logger.warn("单聊消息收件人不存在（确定性失败转 dead，不降级）：outbox#" + row.id + " · " + row.dedupeKey);
      return { outcome: "dead", error: "单聊消息收件人不存在（无法降级站内信）：" + row.dedupeKey };
    }

    const botId = this.botId();
    const binding = await this.repository.findBindingByUserId(contact.id, botId);
    const blockedReason =
      contact.removedAt !== null ? "已删除（目录源删除）" : contact.status !== "active" ? "已停用" : null;
    if (blockedReason !== null) {
      const error = "收件人不可投递（" + blockedReason + "）";
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: binding === null ? "user:" + contact.id : binding.wecomUserid,
        state: "dead",
        attempts: 0,
        error,
        sentAt: null,
      });
      this.logger.warn("单聊消息收件人不可投递（确定性失败转 dead）：outbox#" + row.id + " · " + row.dedupeKey + " —— " + error);
      return await this.degradeWith(message, row, error, DM_DEGRADE_PREFIX);
    }

    // 未绑定企微（无绑定行 / 绑定行未带 user_id）：不发帧，按 permanent 收口 + D4 绑定指引降级（口径 §6）。
    if (binding === null) {
      const error = "收件人未绑定企业微信（无可投递地址）";
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: "user:" + contact.id,
        state: "dead",
        attempts: 0,
        error,
        sentAt: null,
      });
      this.logger.warn("单聊消息收件人未绑定企微（确定性失败转 dead · 不发帧）：outbox#" + row.id + " · " + row.dedupeKey + " —— " + error);
      return await this.degradeWith(message, row, error, DM_BINDING_DEGRADE_PREFIX);
    }

    const userid = binding.wecomUserid;
    const composed = composeDmMarkdown(message);
    const { content, truncated } = truncateDmMarkdown(composed);
    if (truncated) {
      this.logger.warn(
        "单聊消息超字节上限已截断（" +
          String(Buffer.byteLength(composed, "utf8")) +
          " → " +
          String(Buffer.byteLength(content, "utf8")) +
          " 字节）：outbox#" +
          row.id +
          " · userid " +
          maskUserid(userid),
      );
    }

    // 激活态读（846607 双语义分流依据；D4 —— 不做投递前拦截，未命中仍尝试发送）。
    const activation = await this.repository.findActivation(userid, botId);
    const result = await this.aibot.sendUserMarkdown({ userid, content, dmActivated: activation !== null });

    if (result.ok) {
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: userid,
        state: "sent",
        attempts: result.attempts,
        error: null,
        sentAt: this.clock.now(),
      });
      this.logger.log("单聊消息已受理：" + row.dedupeKey + " · userid " + maskUserid(userid) + (truncated ? "（截断发送）" : ""));
      if (activation === null || activation.userId === null) {
        await this.backfillActivation(contact.id, userid);
      }
      return { outcome: "done" };
    }

    const error = describeDmFailure(result);
    if (result.kind === "rate_limited") {
      const availableAt = result.retryAt ?? new Date(this.clock.now().getTime() + 60_000);
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: userid,
        state: "deferred",
        attempts: result.attempts,
        error,
        sentAt: null,
      });
      return { outcome: "deferred", availableAt, error };
    }
    if (result.kind === "retryable") {
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: userid,
        state: "failed",
        attempts: result.attempts,
        error,
        sentAt: null,
      });
      return { outcome: "retry", error };
    }
    // permanent（853000 / 846601 / 846607 未命中激活表）：dead + C5-04 降级（未激活附激活指引前缀 —— P3）。
    await this.repository.insertDelivery({
      outboxId: row.id,
      target: userid,
      state: "dead",
      attempts: result.attempts,
      error,
      sentAt: null,
    });
    this.logger.warn("单聊消息确定性失败（转 dead）：" + row.dedupeKey + " · userid " + maskUserid(userid) + " —— " + error);
    const prefix = result.errcode === WECOM_BOT_FREQ_ERRCODE ? DM_BINDING_DEGRADE_PREFIX : DM_DEGRADE_PREFIX;
    return await this.degradeWith(message, row, error, prefix);
  }

  /** D4 旁证回填：发送成功 = 该 userid 已激活；写库失败只 warn（旁证非关键路径，不影响 done）。 */
  private async backfillActivation(userId: string, userid: string): Promise<void> {
    try {
      await this.repository.backfillActivationOnSend({ botId: this.botId(), wecomUserid: userid, userId, at: this.clock.now() });
    } catch (error) {
      this.logger.warn("单聊发送成功旁证回填激活表失败（忽略；userid " + maskUserid(userid) + "）：" + messageOf(error));
    }
  }

  /**
   * C5-04 降级：企微失败 → 同收件人站内信（NotifyService.deliverInboxCopy 同口径；幂等键后缀 ":c504"）；
   * 降级写库失败 → retry 收敛（有界重试；不静默丢消息）。
   */
  private async degradeWith(
    message: NotifyMessagePayload,
    row: OutboxClaimedRow,
    error: string,
    prefix: string,
  ): Promise<OutboxHandleOutcome> {
    try {
      await this.notify.deliverInboxCopy(
        { ...message, body: prefix + message.body },
        row.topic,
        row.dedupeKey + ":c504",
      );
      this.logger.warn("单聊消息失败已降级站内信：" + row.dedupeKey + " —— " + error);
      return { outcome: "dead", error };
    } catch (degradeError) {
      const detail = messageOf(degradeError);
      this.logger.error("单聊消息降级站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
    }
  }
}
