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
 *   收件人不可投递（不存在 / 停用 / 离职 / 未绑定企微）→ 不发帧，按 permanent 收口（同 app 口径：用户存在即降级）；
 *   用户主动关闭提醒（messages_enabled=false）→ 不发帧；站内信副本成功即 done（不产生死信告警），写库失败才 retry。
 *
 * C5-04 降级：经 `NotifyService.deliverInboxCopy` —— 站内信行走同一落行 / 合并 / 免打扰 / 实时流口径；用户关闭提醒属偏好而非故障，
 * 站内信成功即 done（不落 outbox 死信），只有站内信写库失败才 retry；
 * 幂等键 = 来源 dedupeKey + ":c504"。未绑定企微（无绑定行）/ 846607 未命中激活表 = 无可用地址的确定性失败
 * → 降级前缀附绑定指引话术（**D4 定稿 2026-10-16**：「当前用户未绑定企业微信，请前往设置补绑」）；其余失败用通用前缀。降级写库失败 →
 * retry 收敛（有界重试，不静默丢消息）。管理员告警群留痕由 outbox 死信告警自动承担（dispatcher → OUTBOX_ALERT_SINK）。
 *
 * 绑定码链路（M5-03-5-6 · 口径 §3 / §5；HTTP 面随契约刀 Push 249 落 `/api/v1/wecom-dm-binding`；
 * Push 254 起口径 v1.8：取码 5 次 / 3 分钟 · 换绑以码持有者为准 · 读面回填；
 * Push 255 起 v1.9：罚时锚点 = 窗口内最近一码 + 窗口长度（不再按最早一码 → 分散取码后只剩 1 分钟）；
 * 2026-10-20 安全修订：TTL 3 分钟 · 验证失败 5 次 / 10 分钟 / (bot_id, wecom_userid) · 指数锁定：
 * `requestBindingCode`（取码）/ `ingestCallback`（单聊发码 → 同事务写绑定 + 标记码已用 → 会话内回执
 * `aibot_respond_msg`）/ `getBindingState`（读绑定态：v1.8 另回当前未用码与取码限流可重试时刻）/
 * `setMessagesEnabled`（绑定后消息开关；关闭只停止企微外发，C5-04 站内信仍保留）/ `unbind`
 * （解绑：同事务清绑定行 + 写 `audit_logs` —— D6；跨用户换绑同写 `audit_logs`）。
 *
 * 欢迎语（Push 261）：单聊 `enter_chat` 事件在收到后 5 秒内经 `aibot_respond_welcome_msg` 回纯文本；
 * 欢迎语只负责引导，**不计入会话激活、不触发绑定登记**，失败只 warn，不影响后续发码 / 绑定。
 *
 * 超长口径（B5 定案 · 同群口径）：markdown 按 UTF-8 字节截断（≤ 20000 字节，留 20480 官方上限余量），
 * 尾部省略 + warn 留痕。免打扰口径同 M5-03-3（不做投递前 DND 过滤）。安全：userid 只进库与限速桶摘要；
 * 日志 / outbox error 一律掩码（末 4 位）。
 */
import { randomInt } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type {
  NotifyDeliveryTopic,
  NotifyMessagePayload,
  WecomDmBindingState,
  WecomDmBotDiagnostics,
} from "@libiaolink/contracts";
import { AppConfig } from "../../config/config.module.js";
import { ClockService } from "../../common/clock/clock.service.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxDeadAlertOverride, OutboxHandleOutcome } from "../../outbox/handler.js";
import { AuditService } from "../audit/index.js";
import { maskUserid } from "./notify.app.service.js";
import { parseNotifyMessage } from "./notify.delivery.js";
import {
  inferNotifyRuleCode,
  NotifyDeliveryArchiveRepository,
  type NotifyDeliveryMessageRow,
} from "./notify.delivery-archive.repository.js";
import { NotifyDmRepository, type DmBindingCodeRow, type DmBindingGuardRow } from "./notify.dm.repository.js";
import { NotifyService } from "./notify.service.js";
import type { AibotIncomingMessage, AibotSendResult } from "./wecom.aibot.js";
import { WecomAibotClient } from "./wecom.aibot.js";
import { describeWecomFailure, WECOM_BOT_FREQ_ERRCODE } from "./wecom.errors.js";
import { applyMarkdownHardBreaks, truncateUtf8Bytes } from "./wecom.text.js";

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

/** 用户主动关闭企微单聊提醒时的降级前缀（不是故障，仍保留站内信留档）。 */
export const DM_DISABLED_DEGRADE_PREFIX = "【企微单聊提醒已关闭，已转站内信】\n\n";

/** 单聊 userid 字符集（同激活表 CHECK `^[A-Za-z0-9_.@-]{1,64}$`）—— 回调脏数据防御，不替代 DB 约束。 */
const DM_USERID_PATTERN = /^[A-Za-z0-9_.@-]{1,64}$/;

function alertLineText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, maxChars).join("");
}

/** 绑定码形态（D3 定案：6 位数字）—— 与迁移 0055 CHECK `^[0-9]{6}$` 同口径。 */
export const DM_BINDING_CODE_PATTERN = /^[0-9]{6}$/;

/** 绑定码有效期（D3 修订 2026-10-20：TTL 3 分钟 —— 降低被猜中窗口）。 */
export const DM_BINDING_CODE_TTL_MS = 3 * 60_000;

/** 绑定码生成频率窗口（D3 修订 v1.8 · 2026-10-16：3 分钟滚动窗口；最长等待 = 窗口长度）。 */
export const DM_BINDING_CODE_WINDOW_MS = 3 * 60_000;

/** 绑定码生成频率上限（D3 修订 v1.8 · 2026-10-16：5 次 / 3 分钟 / 用户 —— 罚时上限 3 分钟）。 */
export const DM_BINDING_CODE_MAX_PER_WINDOW = 5;

/** 验证失败窗口（同一 (bot_id, wecom_userid) 10 分钟内最多 5 次失败）。 */
export const DM_BINDING_FAILURE_WINDOW_MS = 10 * 60_000;

/** 验证失败阈值（达到后进入指数锁定；成功绑定立即清零）。 */
export const DM_BINDING_FAILURE_LIMIT = 5;

/** 指数锁定档位（分钟）：第 1~6 次触发锁定分别等待这些时长。 */
export const DM_BINDING_LOCK_STEPS_MS = [1, 2, 4, 8, 16, 30].map((minutes) => minutes * 60_000);

/** 24 小时无验证尝试 → 锁定级别归零（避免历史级别长期抬高正常用户的下一档等待）。 */
export const DM_BINDING_LOCK_RESET_MS = 24 * 60 * 60_000;

/** Secret 诊断掩码（首 4 + **** + 末 4；长度 ≤ 8 时全掩码 —— 与 userid 掩码同属最小暴露）。 */
function maskSecret(secret: string): string {
  return secret.length <= 8 ? "****" : secret.slice(0, 4) + "****" + secret.slice(-4);
}

/** 绑定码生成冲突重试次数（6 位数字空间 1e6，撞码概率极低；到顶抛错由调用方按 5xx 收口）。 */
const DM_BINDING_CODE_ATTEMPTS = 8;

/** 会话内回执话术（口径 §5 反馈面；所有失败统一话术，锁定单独提示 —— 不泄露码存在性）。 */
export const DM_BINDING_REPLY_BOUND = "绑定成功";
export const DM_BINDING_REPLY_INVALID = "绑定码无效或已失效，请重新获取";
export const DM_BINDING_REPLY_LOCKED = "尝试次数过多，请稍后再试";

/** 单聊首次进入欢迎语（企微后台口径 4–120 字符；含可直接显示的 emoji，换行按字符计数）。 */
export const DM_WELCOME_MESSAGE =
  "你好，我是 LibiaoLink 项目助手 👋\n" +
  "📣 我会把与你相关的项目动态推送到企业微信；项目群还可接收日报汇总和任务喜报。\n" +
  "📌 本机器人主要承担消息提醒与绑定；查看项目详情、填写日报或处理文件，请登录 LibiaoLink。";

/** markdown 组装（同群口径）：加粗标题 + 空行 + 正文；标题空白防御（解析后已 trim，非空为常态）。 */
export function composeDmMarkdown(message: Pick<NotifyMessagePayload, "title" | "body">): string {
  const title = message.title.trim();
  const content = title === "" ? message.body : "**" + title + "**\n\n" + message.body;
  return applyMarkdownHardBreaks(content);
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

/** 绑定验证失败原因（只进审计 / 日志，不回显给发送方）。 */
type BindingFailureReason = "missing" | "expired" | "used" | "claim_failed";

/** 绑定回调处理结果（事务内计算，事务提交后才发送回执 / 管理员告警）。 */
type BindingIngestResult =
  | { kind: "bound"; codeRow: DmBindingCodeRow; rebound: boolean; duplicate: boolean }
  | { kind: "invalid"; reason: BindingFailureReason | "duplicate"; duplicate: boolean }
  | { kind: "locked"; lockedUntil: Date; lockTriggered: boolean; lockLevel: number };

interface BindingFailureGuard {
  bindingFailCount: number;
  bindingFailWindowStartedAt: Date | null;
  bindingLockLevel: number;
  bindingLockedUntil: Date | null;
  locked: boolean;
}

/** msgid 只做相邻重投幂等；超长脏值不写库（DB CHECK 1..128）。 */
function bindingMsgid(value: string | null): string | null {
  return value === null || value.trim() === "" || value.length > 128 ? null : value;
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
    private readonly archive: NotifyDeliveryArchiveRepository,
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
   * ③ 取码：非文本消息 / 正文不含 6 位数字 → 只登记激活、不计失败、不回执；
   * ④ 防猜码（0059）：同一 (bot_id, wecom_userid) 10 分钟内失败 5 次 → 1/2/4/8/16/30 分钟指数锁定；
   *    锁定期间不查询绑定码表、正确码也不能绑定；未知 / 过期 / 已用 / 并发占用统一回失败话术并计次；
   * ⑤ 命中 pending 码 → **以码持有者为准**换绑（v1.8）→ 同一事务写绑定行 + 标记码已用 + 清零守卫
   *    （跨用户时另写 `audit_logs`）→ 回「绑定成功」。同一 msgid 重投只回执，不重复计数 / 绑定。
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
    const code = incoming.msgtype === "text" && incoming.text !== null ? extractBindingCode(incoming.text) : null;
    if (code === null) {
      await this.repository.upsertActivationFromCallback({ botId, wecomUserid: userid, at });
      this.logger.log("单聊回调已登记激活（非绑定码消息 · 不可作发送地址）：userid " + maskUserid(userid));
      return;
    }
    const msgid = bindingMsgid(incoming.msgid);
    const result = await this.database.db.transaction(async (tx) => {
      await this.repository.upsertActivationFromCallback({ botId, wecomUserid: userid, at }, tx);
      const guard = await this.repository.lockBindingGuard(botId, userid, tx);
      const duplicate = msgid !== null && guard.lastBindingMsgid === msgid;

      if (guard.bindingLockedUntil !== null && guard.bindingLockedUntil.getTime() > at.getTime()) {
        if (!duplicate) {
          await this.repository.touchBindingAttempt({ botId, wecomUserid: userid, at, lastBindingMsgid: msgid }, tx);
        }
        return {
          kind: "locked",
          lockedUntil: guard.bindingLockedUntil,
          lockTriggered: false,
          lockLevel: guard.bindingLockLevel,
        } satisfies BindingIngestResult;
      }

      const codeRow = await this.repository.findBindingCode(code, botId, tx);
      const previous = await this.repository.findBindingByWecomUserid(userid, botId, tx);
      if (duplicate || (codeRow !== null && codeRow.status === "used" && previous !== null && previous.userId === codeRow.userId)) {
        if (codeRow !== null && previous !== null && previous.userId === codeRow.userId) {
          this.logger.log("单聊绑定码已用且绑定成立（回调重复投递幂等）：userid " + maskUserid(userid));
          return { kind: "bound", codeRow, rebound: false, duplicate: true } satisfies BindingIngestResult;
        }
        if (duplicate) {
          return { kind: "invalid", reason: "duplicate", duplicate: true } satisfies BindingIngestResult;
        }
      }

      const failureReason: BindingFailureReason | null =
        codeRow === null
          ? "missing"
          : codeRow.status !== "pending"
            ? codeRow.status === "used"
              ? "used"
              : "expired"
            : codeRow.expiresAt.getTime() <= at.getTime()
              ? "expired"
              : null;
      if (failureReason !== null || codeRow === null) {
        return await this.recordBindingFailure(tx, {
          botId,
          wecomUserid: userid,
          at,
          msgid,
          guard,
          reason: failureReason ?? "missing",
        });
      }

      const rebound = previous !== null && previous.userId !== codeRow.userId;
      const claimed = await this.repository.bindWithCode(
        { codeId: codeRow.id, userId: codeRow.userId, botId, wecomUserid: userid, at },
        tx,
      );
      if (!claimed) {
        return await this.recordBindingFailure(tx, {
          botId,
          wecomUserid: userid,
          at,
          msgid,
          guard,
          reason: "claim_failed",
        });
      }
      await this.clearBindingGuard(tx, botId, userid, at, msgid);
      if (rebound && previous !== null) {
        await this.recordRebind(tx, { fromUserId: previous.userId, toUserId: codeRow.userId, wecomUserid: userid, botId });
      }
      return { kind: "bound", codeRow, rebound, duplicate: false } satisfies BindingIngestResult;
    });

    if (result.kind === "bound") {
      this.logger.log(
        "单聊绑定成功（绑定行 = bot_id + userid 掩码）：userid " +
          maskUserid(userid) +
          " · user_id " +
          result.codeRow.userId +
          (result.rebound ? "（跨用户换绑）" : ""),
      );
      await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_BOUND);
      return;
    }
    if (result.kind === "locked") {
      this.logger.warn(
        "单聊绑定验证已锁定（不查询码表）：userid " + maskUserid(userid) + " · 解锁至 " + result.lockedUntil.toISOString(),
      );
      await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_LOCKED);
      if (result.lockTriggered) {
        await this.sendBindingLockAlert({
          botId,
          wecomUserid: userid,
          lockedUntil: result.lockedUntil,
          lockLevel: result.lockLevel,
        });
      }
      return;
    }
    this.logger.warn(
      "单聊绑定验证失败（" + result.reason + "）：userid " + maskUserid(userid) + (result.duplicate ? "（重复 msgid）" : ""),
    );
    await this.replyToCallback(incoming, userid, DM_BINDING_REPLY_INVALID);
  }

  /**
   * 单聊进入事件欢迎语（企微 `enter_chat`）：只处理 single + enter_chat，且必须带事件 req_id；
   * 不写激活表、不做绑定，回复失败只 warn（5 秒时效内尽力送达，异常不打断 worker 回调链）。
   */
  async replyWelcomeToEnterChat(incoming: AibotIncomingMessage): Promise<void> {
    if (
      incoming.cmd !== "aibot_event_callback" ||
      incoming.chattype !== "single" ||
      incoming.eventType !== "enter_chat" ||
      incoming.fromUserId === null ||
      incoming.fromUserId === ""
    ) {
      return;
    }
    const masked = maskUserid(incoming.fromUserId);
    if (incoming.reqId === null) {
      this.logger.warn("欢迎语事件缺 req_id，跳过回复：userid " + masked);
      return;
    }
    try {
      const result = await this.aibot.replyWelcome({ reqId: incoming.reqId, content: DM_WELCOME_MESSAGE });
      if (!result.ok) {
        this.logger.warn("欢迎语未送达（不影响绑定）：userid " + masked + " —— " + describeDmFailure(result));
        return;
      }
      this.logger.log("单聊欢迎语已发送：userid " + masked);
    } catch (error) {
      this.logger.warn("欢迎语发送异常（不影响绑定）：userid " + masked + " —— " + messageOf(error));
    }
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

  /** 计算下一次验证失败后的守卫状态（5 次 / 10 分钟；达到阈值进入下一档指数锁定并清零窗口）。 */
  private nextBindingFailureGuard(guard: DmBindingGuardRow, at: Date): BindingFailureGuard {
    const idle =
      guard.lastBindingAttemptAt === null ||
      at.getTime() - guard.lastBindingAttemptAt.getTime() >= DM_BINDING_LOCK_RESET_MS;
    const baseLockLevel = idle ? 0 : guard.bindingLockLevel;
    const windowStartedAt = guard.bindingFailWindowStartedAt;
    const sameWindow =
      windowStartedAt !== null &&
      at.getTime() >= windowStartedAt.getTime() &&
      at.getTime() - windowStartedAt.getTime() < DM_BINDING_FAILURE_WINDOW_MS;
    const bindingFailCount = (sameWindow ? guard.bindingFailCount : 0) + 1;
    const bindingFailWindowStartedAt = sameWindow ? windowStartedAt : at;

    if (bindingFailCount < DM_BINDING_FAILURE_LIMIT) {
      return {
        bindingFailCount,
        bindingFailWindowStartedAt,
        bindingLockLevel: baseLockLevel,
        bindingLockedUntil: null,
        locked: false,
      };
    }
    const bindingLockLevel = Math.min(baseLockLevel + 1, DM_BINDING_LOCK_STEPS_MS.length);
    const lockMs = DM_BINDING_LOCK_STEPS_MS[bindingLockLevel - 1];
    if (lockMs === undefined) {
      throw new Error("绑定锁定档位配置为空");
    }
    return {
      bindingFailCount: 0,
      bindingFailWindowStartedAt: null,
      bindingLockLevel,
      bindingLockedUntil: new Date(at.getTime() + lockMs),
      locked: true,
    };
  }

  /** 记录失败：更新守卫状态 + 同事务写拒绝审计；达到阈值返回锁定并触发管理员告警。 */
  private async recordBindingFailure(
    tx: DbClient,
    input: {
      botId: string;
      wecomUserid: string;
      at: Date;
      msgid: string | null;
      guard: DmBindingGuardRow;
      reason: BindingFailureReason;
    },
  ): Promise<BindingIngestResult> {
    const next = this.nextBindingFailureGuard(input.guard, input.at);
    await this.repository.updateBindingGuard(
      {
        botId: input.botId,
        wecomUserid: input.wecomUserid,
        at: input.at,
        bindingFailCount: next.bindingFailCount,
        bindingFailWindowStartedAt: next.bindingFailWindowStartedAt,
        bindingLockLevel: next.bindingLockLevel,
        bindingLockedUntil: next.bindingLockedUntil,
        lastBindingMsgid: input.msgid,
      },
      tx,
    );
    const masked = maskUserid(input.wecomUserid);
    await this.audit.record(tx, {
      actorId: null,
      action: "deny",
      objectType: "wecom_dm_binding",
      objectId: input.botId + ":" + masked,
      result: "denied",
      entry: "system",
      summary: "企业微信绑定码验证失败（open_userid " + masked + "）",
      changes: null,
      metadata: {
        botId: input.botId,
        wecomUseridMasked: masked,
        reason: input.reason,
        failCount: next.locked ? DM_BINDING_FAILURE_LIMIT : next.bindingFailCount,
        lockLevel: next.bindingLockLevel,
        lockedUntil: next.bindingLockedUntil === null ? null : next.bindingLockedUntil.toISOString(),
      },
    });
    if (next.locked) {
      this.logger.warn(
        "单聊绑定验证达到失败阈值 → 临时锁定：userid " +
          masked +
          " · 第 " +
          String(next.bindingLockLevel) +
          " 档 · 至 " +
          (next.bindingLockedUntil === null ? "?" : next.bindingLockedUntil.toISOString()),
      );
      return {
        kind: "locked",
        lockedUntil: next.bindingLockedUntil ?? input.at,
        lockTriggered: true,
        lockLevel: next.bindingLockLevel,
      };
    }
    return { kind: "invalid", reason: input.reason, duplicate: false };
  }

  /** 成功绑定：清空失败窗口、锁定级别与锁定时刻（保留最近 msgid 供相邻重投幂等）。 */
  private async clearBindingGuard(
    tx: DbClient,
    botId: string,
    wecomUserid: string,
    at: Date,
    msgid: string | null,
  ): Promise<void> {
    await this.repository.updateBindingGuard(
      {
        botId,
        wecomUserid,
        at,
        bindingFailCount: 0,
        bindingFailWindowStartedAt: null,
        bindingLockLevel: 0,
        bindingLockedUntil: null,
        lastBindingMsgid: msgid,
      },
      tx,
    );
  }

  /** 锁定升级时推一次管理员告警群；未配置 chatid / 机器人凭据时只留 warn 日志（不阻断绑定链路）。 */
  private async sendBindingLockAlert(input: {
    botId: string;
    wecomUserid: string;
    lockedUntil: Date;
    lockLevel: number;
  }): Promise<void> {
    const chatid = this.config.env.OUTBOX_ALERT_WECOM_CHATID;
    if (chatid === "" || this.config.env.WECOM_BOT_ID === "" || this.config.env.WECOM_BOT_SECRET === "") {
      this.logger.warn(
        "绑定码锁定告警未推群（缺 OUTBOX_ALERT_WECOM_CHATID 或机器人凭据）：userid " + maskUserid(input.wecomUserid),
      );
      return;
    }
    const content =
      "【LibiaoLink 安全告警】企微绑定码连续验证失败\n" +
      "机器人：" +
      input.botId +
      "\n企微账号：" +
      maskUserid(input.wecomUserid) +
      "\n判定：" +
      String(DM_BINDING_FAILURE_LIMIT) +
      " 次 / " +
      String(DM_BINDING_FAILURE_WINDOW_MS / 60_000) +
      " 分钟；第 " +
      String(input.lockLevel) +
      "/" +
      String(DM_BINDING_LOCK_STEPS_MS.length) +
      " 档\n锁定至：" +
      input.lockedUntil.toISOString() +
      "\n处置：请核查来源账号；如非本人操作，建议暂停绑定并检查机器人凭据。";
    try {
      const result = await this.aibot.sendGroupMarkdown({ chatid, content, groupActivated: true });
      if (!result.ok) {
        this.logger.warn(
          "绑定码锁定告警推群失败（不影响绑定）：userid " + maskUserid(input.wecomUserid) + " —— " + describeDmFailure(result),
        );
      }
    } catch (error) {
      this.logger.warn("绑定码锁定告警推群异常（不影响绑定）：" + messageOf(error));
    }
  }

  /**
   * 生成绑定码（D3 签发：6 位数字 / TTL 3 分钟 / 一次性；频率口径 D3 修订 v1.8：5 次 / 3 分钟 / 用户）：
   * 频率到顶 → 返回 rate_limited + retryAt（窗口内**最近一码** + 窗口长度 —— v1.9 修订；恒 ≤ 3 分钟且重试不延长）；
   * 否则同一事务作废旧 pending 码 + 插入新码（撞码换码重试 DM_BINDING_CODE_ATTEMPTS 次）。
   * HTTP 面（POST /api/v1/wecom-dm-binding/codes · 契约刀）：频率到顶统一映射 429 `RATE_LIMITED` + retryAt。
   */
  async requestBindingCode(userId: string): Promise<
    | { ok: true; code: string; expiresAt: Date; expiresInSeconds: number }
    | { ok: false; reason: "rate_limited"; retryAt: Date }
  > {
    const at = this.clock.now();
    const botId = this.botId();
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
      if (await this.repository.createBindingCode({ botId, userId, code, expiresAt, at })) {
        this.logger.log("绑定码已生成（TTL 3 分钟 · 旧 pending 码作废）：user_id " + userId);
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
    const botId = this.botId();
    const binding = await this.repository.findBindingByUserId(userId, botId);
    const pending = await this.repository.findPendingBindingCode(userId, botId, at);
    const retryAt = await this.rateLimitedRetryAt(userId, at);
    return {
      bound: binding !== null,
      wecomUseridMasked: binding === null ? null : maskUserid(binding.wecomUserid),
      boundAt: binding === null ? null : binding.boundAt.toISOString(),
      messagesEnabled: binding === null ? true : binding.messagesEnabled,
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
   * 更新绑定行的企微单聊消息开关（个人设置；未绑定 = 幂等返回未绑定态）。
   * 关闭后 send 消费链不再外发，按“用户主动关闭”转站内信留档；站内信成功后按 done 收口。
   */
  async setMessagesEnabled(userId: string, messagesEnabled: boolean): Promise<WecomDmBindingState> {
    const at = this.clock.now();
    const changed = await this.repository.updateBindingMessagesEnabledByUserId({
      botId: this.botId(),
      userId,
      messagesEnabled,
      at,
    });
    if (changed > 0) {
      this.logger.log(
        "企业微信单聊提醒开关已更新：user_id " + userId + " · messagesEnabled=" + String(messagesEnabled),
      );
    }
    return await this.getBindingState(userId);
  }

  /**
   * 取码限流可重试时刻（v1.9 读面回填 · 与 `requestBindingCode` 同一判定，避免两处口径漂移）：
   * 窗口内已签发码不足上限 → null（未到顶）；到顶 → **窗口内最近一码** + 窗口长度。
   * 为什么不是最早一码：5 次取码若分散在 2 分钟内，最早一码 + 3 分钟只剩 1 分钟，与「5 次 / 3 分钟」的
   * 文案不一致（用户实测 1 分钟）；锚定最近一码后倒计时恒为「最近取码 + 3 分钟」，
   * 且被拦期间重试不会产生新码 → 锚点不动、倒计时不会被反复延长。
   */
  private async rateLimitedRetryAt(userId: string, at: Date): Promise<Date | null> {
    const since = new Date(at.getTime() - DM_BINDING_CODE_WINDOW_MS);
    const issuedAt = await this.repository.bindingCodesSince(userId, this.botId(), since);
    if (issuedAt.length < DM_BINDING_CODE_MAX_PER_WINDOW) {
      return null;
    }
    const newest = issuedAt[issuedAt.length - 1];
    return new Date((newest === undefined ? at.getTime() : newest.getTime()) + DM_BINDING_CODE_WINDOW_MS);
  }

  /**
   * 机器人诊断（本地联调 · 非生产）：回显本进程实际读取的 WECOM_BOT_* + 该机器人维度最近回调统计。
   * 开关 = WECOM_BOT_DIAGNOSTICS（auto 时 NODE_ENV !== production 才开）；关闭时敏感字段一律 null、统计归零。
   * 安全：仅会话可读；不写日志；secret 不落 outbox / 留痕（CONTRIBUTING §12）。
   */
  async getBotDiagnostics(): Promise<WecomDmBotDiagnostics> {
    const env = this.config.env;
    const enabled =
      env.WECOM_BOT_DIAGNOSTICS === "true" ||
      (env.WECOM_BOT_DIAGNOSTICS === "auto" && env.NODE_ENV !== "production");
    if (!enabled) {
      return {
        enabled: false,
        botId: null,
        botSecret: null,
        botSecretMasked: null,
        wsUrl: null,
        deliveryEnabled: env.NOTIFY_DELIVERY_ENABLED === "true",
        lastInboundAt: null,
        inboundCount: 0,
        lastInboundUseridMasked: null,
        observedBotIds: [],
        serverTime: this.clock.now().toISOString(),
      };
    }
    const botId = this.botId();
    const secret = env.WECOM_BOT_SECRET === "" ? null : env.WECOM_BOT_SECRET;
    const stats = await this.repository.botInboundStats(botId);
    const observed = await this.repository.observedBotIds(5);
    return {
      enabled: true,
      botId: botId === "" ? null : botId,
      botSecret: secret,
      botSecretMasked: secret === null ? null : maskSecret(secret),
      wsUrl: env.WECOM_BOT_WS_URL,
      deliveryEnabled: env.NOTIFY_DELIVERY_ENABLED === "true",
      lastInboundAt: stats.lastInboundAt === null ? null : stats.lastInboundAt.toISOString(),
      inboundCount: stats.inboundCount,
      lastInboundUseridMasked:
        stats.lastInboundUserid === null ? null : maskUserid(stats.lastInboundUserid),
      // 激活表 `bot_id` 可空（0048 的历史登记行）；诊断只列有 bot_id 的行。
      observedBotIds: observed
        .filter((row): row is { botId: string; inboundCount: number; lastInboundAt: Date | null } => row.botId !== null)
        .map((row) => ({
          botId: row.botId,
          inboundCount: row.inboundCount,
          lastInboundAt: row.lastInboundAt === null ? null : row.lastInboundAt.toISOString(),
        })),
      serverTime: this.clock.now().toISOString(),
    };
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

    let archived: NotifyDeliveryMessageRow;
    try {
      archived = await this.archive.ensureMessage({
        outboxId: row.id,
        sourceDedupeKey: row.dedupeKey,
        topic: row.topic as NotifyDeliveryTopic,
        channel: "wecom_aibot",
        recipientId: message.recipientId,
        recipientLabel: null,
        title: message.title,
        body: message.body,
        templateCode: message.templateCode ?? null,
        ruleCode: inferNotifyRuleCode(row.dedupeKey),
        refType: message.refType ?? null,
        refId: message.refId ?? null,
        payload: { ...message, channel: "wecom_aibot" },
        metadata: {},
      });
    } catch (archiveError) {
      const detail = messageOf(archiveError);
      this.logger.error("单聊消息归档失败（不发送，交 outbox 重试）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: "单聊消息归档失败：" + detail };
    }
    if (archived.lastState === "sent") {
      this.logger.log("单聊消息已发送归档，重复消费幂等跳过：" + row.dedupeKey);
      return { outcome: "done" };
    }
    const terminalDead = archived.lastState === "dead";

    const contact = await this.repository.findContact(message.recipientId);
    if (contact === null) {
      // 用户不存在：站内信 FK 同样不可落 —— 不降级（无收件人可降），dead 一次即弃（同 app 口径）。
      if (terminalDead) {
        return { outcome: "dead", error: archived.lastError ?? "单聊消息已终态失败：" + row.dedupeKey };
      }
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_aibot",
        target: "user:" + message.recipientId,
        recipientLabel: "user:" + message.recipientId,
        state: "dead",
        attempts: 0,
        error: "收件人不存在（无法降级站内信）",
        sentAt: null,
        at: this.clock.now(),
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
      const target = binding === null ? "user:" + contact.id : binding.wecomUserid;
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_aibot",
          target,
          recipientLabel: maskUserid(target),
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      this.logger.warn("单聊消息收件人不可投递（确定性失败转 dead）：outbox#" + row.id + " · " + row.dedupeKey + " —— " + error);
      return await this.degradeWith(message, row, terminalDead ? (archived.lastError ?? error) : error, DM_DEGRADE_PREFIX);
    }

    // 未绑定企微（无绑定行 / 绑定行未带 user_id）：不发帧，按 permanent 收口 + D4 绑定指引降级（口径 §6）。
    if (binding === null) {
      const recipientName = alertLineText(contact.displayName, 64) || "姓名未登记";
      const error = "收件人未绑定企业微信（" + recipientName + "，无可投递地址）";
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_aibot",
          target: "user:" + contact.id,
          recipientLabel: "user:" + contact.id,
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      this.logger.warn("单聊消息收件人未绑定企微（确定性失败转 dead · 不发帧）：outbox#" + row.id + " · " + row.dedupeKey + " —— " + error);
      return await this.degradeWith(
        message,
        row,
        terminalDead ? (archived.lastError ?? error) : error,
        DM_BINDING_DEGRADE_PREFIX,
        {
          message:
            "消息类型：" +
            alertLineText(message.title, 80) +
            "\n未绑定企业微信的收件人：" +
            recipientName,
          impact: null,
          action: "请提醒相关收件人及时绑定企业微信",
        },
      );
    }
    if (!binding.messagesEnabled) {
      const error = "收件人已关闭企业微信单聊提醒";
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_aibot",
          target: binding.wecomUserid,
          recipientLabel: maskUserid(binding.wecomUserid),
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      return await this.suppressWith(
        message,
        row,
        terminalDead ? (archived.lastError ?? error) : error,
        DM_DISABLED_DEGRADE_PREFIX,
        contact.id,
      );
    }
    if (terminalDead) {
      const error = archived.lastError ?? "单聊消息已终态失败：" + row.dedupeKey;
      this.logger.warn("单聊消息已归档为 dead，重复消费不再外发、仅重试降级：" + row.dedupeKey);
      return await this.degradeWith(message, row, error, DM_DEGRADE_PREFIX);
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
      const sentAt = this.clock.now();
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_aibot",
        target: userid,
        recipientLabel: maskUserid(userid),
        state: "sent",
        attempts: result.attempts,
        error: null,
        sentAt,
        at: sentAt,
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
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_aibot",
        target: userid,
        recipientLabel: maskUserid(userid),
        state: "deferred",
        attempts: result.attempts,
        error,
        sentAt: null,
        at: this.clock.now(),
      });
      return { outcome: "deferred", availableAt, error };
    }
    if (result.kind === "retryable") {
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_aibot",
        target: userid,
        recipientLabel: maskUserid(userid),
        state: "failed",
        attempts: result.attempts,
        error,
        sentAt: null,
        at: this.clock.now(),
      });
      return { outcome: "retry", error };
    }
    // permanent（853000 / 846601 / 846607 未命中激活表）：dead + C5-04 降级（未激活附激活指引前缀 —— P3）。
    await this.archive.recordAttempt({
      messageId: archived.id,
      outboxId: row.id,
      channel: "wecom_aibot",
      target: userid,
      recipientLabel: maskUserid(userid),
      state: "dead",
      attempts: result.attempts,
      error,
      sentAt: null,
      at: this.clock.now(),
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
   * 用户主动关闭提醒：不发企微帧，但站内信副本成功即视为消费完成（done）—— 这是偏好不是故障，
   * 不落 outbox 死信、不触发管理员告警；站内信写库失败仍按 retry 收敛。
   */
  private async suppressWith(
    message: NotifyMessagePayload,
    row: OutboxClaimedRow,
    error: string,
    prefix: string,
    userId: string,
  ): Promise<OutboxHandleOutcome> {
    try {
      await this.notify.deliverInboxCopy(
        { ...message, body: prefix + message.body },
        row.topic,
        row.dedupeKey + ":c504",
      );
      this.logger.log("单聊消息因用户关闭提醒已转站内信：" + row.dedupeKey + " · user_id " + userId);
      return { outcome: "done" };
    } catch (degradeError) {
      const detail = messageOf(degradeError);
      this.logger.error("单聊消息因用户关闭提醒转站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
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
    alert?: OutboxDeadAlertOverride,
  ): Promise<OutboxHandleOutcome> {
    try {
      await this.notify.deliverInboxCopy(
        { ...message, body: prefix + message.body },
        row.topic,
        row.dedupeKey + ":c504",
      );
      this.logger.warn("单聊消息失败已降级站内信：" + row.dedupeKey + " —— " + error);
      return alert === undefined ? { outcome: "dead", error } : { outcome: "dead", error, alert };
    } catch (degradeError) {
      const detail = messageOf(degradeError);
      this.logger.error("单聊消息降级站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
    }
  }
}
