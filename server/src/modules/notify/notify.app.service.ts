/**
 * 应用消息投递消费（M5-03-3 · outbox 主题 `notify.message` 的 channel=wecom_app 分支 ·
 * C2-07 / C2-08 / C5-03 / C5-04）。
 *
 * 一次消费 = 解析载荷 → 解析 userid（`users.username`，口径见 NotifyAppRepository 头注）→ 组装文本（B5 截断）
 * → `WecomClient.sendAppText` → 三分类收敛 + 投递留痕（notify_deliveries · channel=wecom_app）：
 *   ok                                → done（sent 行，attempts = 实际 HTTP 次数）；
 *   rate_limited（本地桶 / 45009）     → deferred（deferred 行；availableAt = retryAt ?? now+60s；不消耗重试次数）；
 *   retryable（超时 / 5xx / -1）       → retry（failed 行）；
 *   permanent（60011 一类）            → dead（dead 行）+ C5-04 降级（同收件人站内信）；
 *   收件人不可投递（不存在 / 停用 / 离职 / userid 缺失）→ 不发 HTTP，按 permanent 收口；用户存在即降级。
 *
 * C5-04 降级：经 `NotifyService.deliverInboxCopy` —— 站内信行走同一落行 / 合并 / 免打扰 / 实时流口径；
 * 幂等键 = 来源 dedupeKey + ":c504"（避免与来源事件唯一键相撞）。降级写库失败 → retry 收敛（有界重试，
 * 不静默丢消息 —— 「企微失败 → 站内信，保证不丢」）。管理员告警群留痕由 outbox 死信告警自动承担
 * （dispatcher → OUTBOX_ALERT_SINK，M5-03-3 起 = 企微告警群）。
 *
 * 超长口径（B5 定案）：文本按 UTF-8 字节截断（≤ 2000 字节，留 2048 官方上限余量），尾部省略 + warn 留痕。
 * 安全：userid 只进库（notify_deliveries.target）与限速桶；日志 / outbox error 一律掩码（末 4 位）。
 */
import { Injectable, Logger } from "@nestjs/common";
import type { NotifyDeliveryTopic, NotifyMessagePayload } from "@libiaolink/contracts";
import { ClockService } from "../../common/clock/clock.service.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import { parseNotifyMessage } from "./notify.delivery.js";
import {
  inferNotifyRuleCode,
  NotifyDeliveryArchiveRepository,
  type NotifyDeliveryMessageRow,
} from "./notify.delivery-archive.repository.js";
import { NotifyAppRepository } from "./notify.app.repository.js";
import { NotifyService } from "./notify.service.js";
import type { WecomSendResult } from "./wecom.client.js";
import { WecomClient } from "./wecom.client.js";
import { describeWecomFailure } from "./wecom.errors.js";
import { truncateUtf8Bytes } from "./wecom.text.js";

/** 应用文本字节上限（官方 2048；取 2000 留余量 —— B5 定案「投递层按字节截断留痕」）。 */
export const APP_TEXT_MAX_BYTES = 2_000;

/** 截断省略后缀（尾部省略口径）。 */
export const APP_TRUNCATION_SUFFIX = "\n\n…（内容过长，已截断）";

/** 降级站内信前缀（C5-04：企微失败 → 站内信；正文保留原文，前缀标注来源变化）。 */
export const APP_DEGRADE_PREFIX = "【企微未送达，已转站内信】\n\n";

/** userid 掩码（日志 / outbox error 口径：只回末 4 位，全文只落库）。 */
export function maskUserid(userid: string): string {
  return "****" + userid.slice(-4);
}

/** 文本组装：标题 + 空行 + 正文（text 消息无 markdown 语法）。 */
export function composeAppText(message: Pick<NotifyMessagePayload, "title" | "body">): string {
  return message.title + "\n\n" + message.body;
}

/** UTF-8 字节截断（B5）：未超长原样返回；超长截到上限 - 后缀，尾部拼省略标记。 */
export function truncateAppText(content: string, maxBytes: number = APP_TEXT_MAX_BYTES): {
  content: string;
  truncated: boolean;
} {
  return truncateUtf8Bytes(content, maxBytes, APP_TRUNCATION_SUFFIX);
}

/** 失败描述（核心语义：errcode + 白话标签 / errmsg 概要；不含 kind / HTTP 内部态与企微机器尾巴；不含 userid 明文）。 */
function describeAppFailure(result: Extract<WecomSendResult, { ok: false }>): string {
  return "应用消息未送达" + describeWecomFailure(result.errcode, result.errmsg);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 应用消息消费服务（worker 注册表 · 由 OutboxModule 按载荷 channel 路由）：handler 只做业务与分类，
 * outbox 回写统一由 dispatcher 收敛；任何异常都不外抛（dispatcher 按可重试兜底，与 NotifyService 同口径）。
 */
@Injectable()
export class NotifyAppService {
  private readonly logger = new Logger(NotifyAppService.name);

  constructor(
    private readonly repository: NotifyAppRepository,
    private readonly archive: NotifyDeliveryArchiveRepository,
    private readonly client: WecomClient,
    private readonly notify: NotifyService,
    private readonly clock: ClockService,
  ) {}

  async consume(row: OutboxClaimedRow): Promise<OutboxHandleOutcome> {
    const message = parseNotifyMessage(row.payload);
    if (message === null) {
      this.logger.warn("应用消息载荷非法，转 dead：outbox#" + row.id + "（" + row.dedupeKey + "）");
      return {
        outcome: "dead",
        error: "应用消息载荷非法（缺 recipientId / type / title / body 或超长）：" + row.dedupeKey,
      };
    }
    const channel = message.channel ?? "inbox";
    if (channel !== "wecom_app") {
      // 防御：路由（OutboxModule 按载荷 channel 分发）不应把其它渠道送到本消费器；出现即确定性失败留痕。
      this.logger.warn("应用消息消费收到非 wecom_app 渠道（渠道路由异常转 dead）：outbox#" + row.id + " · channel=" + channel);
      return {
        outcome: "dead",
        error: "应用消息消费渠道异常（期望 wecom_app，实得 " + channel + "）：" + row.dedupeKey,
      };
    }

    let archived: NotifyDeliveryMessageRow;
    try {
      archived = await this.archive.ensureMessage({
        outboxId: row.id,
        sourceDedupeKey: row.dedupeKey,
        topic: row.topic as NotifyDeliveryTopic,
        channel: "wecom_app",
        recipientId: message.recipientId,
        recipientLabel: null,
        title: message.title,
        body: message.body,
        templateCode: message.templateCode ?? null,
        ruleCode: inferNotifyRuleCode(row.dedupeKey),
        refType: message.refType ?? null,
        refId: message.refId ?? null,
        payload: { ...message, channel: "wecom_app" },
        metadata: {},
      });
    } catch (archiveError) {
      const detail = messageOf(archiveError);
      this.logger.error("应用消息归档失败（不发送，交 outbox 重试）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: "应用消息归档失败：" + detail };
    }
    if (archived.lastState === "sent") {
      this.logger.log("应用消息已发送归档，重复消费幂等跳过：" + row.dedupeKey);
      return { outcome: "done" };
    }
    const terminalDead = archived.lastState === "dead";

    const contact = await this.repository.findContact(message.recipientId);
    if (contact === null) {
      // 用户不存在：站内信 FK 同样不可落 —— 不降级（无收件人可降），dead 一次即弃。
      if (terminalDead) {
        return { outcome: "dead", error: archived.lastError ?? "应用消息已终态失败：" + row.dedupeKey };
      }
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_app",
        target: "user:" + message.recipientId,
        recipientLabel: "user:" + message.recipientId,
        state: "dead",
        attempts: 0,
        error: "收件人不存在（无法降级站内信）",
        sentAt: null,
        at: this.clock.now(),
      });
      this.logger.warn("应用消息收件人不存在（确定性失败转 dead，不降级）：outbox#" + row.id + " · " + row.dedupeKey);
      return { outcome: "dead", error: "应用消息收件人不存在（无法降级站内信）：" + row.dedupeKey };
    }

    const userid = contact.username.trim();
    const blockedReason =
      contact.removedAt !== null ? "已删除（目录源删除）" : contact.status !== "active" ? "已停用" : userid === "" ? "userid 缺失" : null;
    if (blockedReason !== null) {
      const error = "收件人不可投递（" + blockedReason + "）";
      const target = userid === "" ? "user:" + contact.id : userid;
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_app",
          target,
          recipientLabel: maskUserid(target),
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      this.logger.warn("应用消息收件人不可投递（确定性失败转 dead）：outbox#" + row.id + " · " + row.dedupeKey + " —— " + error);
      return await this.degradeWith(message, row, terminalDead ? (archived.lastError ?? error) : error);
    }
    if (terminalDead) {
      const error = archived.lastError ?? "应用消息已终态失败：" + row.dedupeKey;
      this.logger.warn("应用消息已归档为 dead，重复消费不再外发、仅重试降级：" + row.dedupeKey);
      return await this.degradeWith(message, row, error);
    }

    const composed = composeAppText(message);
    const { content, truncated } = truncateAppText(composed);
    if (truncated) {
      this.logger.warn(
        "应用消息超字节上限已截断（" +
          String(Buffer.byteLength(composed, "utf8")) +
          " → " +
          String(Buffer.byteLength(content, "utf8")) +
          " 字节）：outbox#" +
          row.id +
          " · userid " +
          maskUserid(userid),
      );
    }

    const result = await this.client.sendAppText({ toUser: [userid], content });
    if (result.ok) {
      const sentAt = this.clock.now();
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_app",
        target: userid,
        recipientLabel: maskUserid(userid),
        state: "sent",
        attempts: result.attempts,
        error: null,
        sentAt,
        at: sentAt,
      });
      this.logger.log("应用消息已受理：" + row.dedupeKey + " · userid " + maskUserid(userid) + (truncated ? "（截断发送）" : ""));
      return { outcome: "done" };
    }

    const error = describeAppFailure(result);
    if (result.kind === "rate_limited") {
      const availableAt = result.retryAt ?? new Date(this.clock.now().getTime() + 60_000);
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_app",
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
        channel: "wecom_app",
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
    // permanent（含 token 失效重取后仍失败 —— 配置类）：dead + C5-04 降级。
    await this.archive.recordAttempt({
      messageId: archived.id,
      outboxId: row.id,
      channel: "wecom_app",
      target: userid,
      recipientLabel: maskUserid(userid),
      state: "dead",
      attempts: result.attempts,
      error,
      sentAt: null,
      at: this.clock.now(),
    });
    this.logger.warn("应用消息确定性失败（转 dead）：" + row.dedupeKey + " · userid " + maskUserid(userid) + " —— " + error);
    return await this.degradeWith(message, row, error);
  }

  /**
   * C5-04 降级：企微失败 → 同收件人站内信（NotifyService.deliverInboxCopy 同口径；幂等键后缀 ":c504"）；
   * 降级写库失败 → retry 收敛（有界重试；不静默丢消息）。
   */
  private async degradeWith(
    message: NotifyMessagePayload,
    row: OutboxClaimedRow,
    error: string,
  ): Promise<OutboxHandleOutcome> {
    try {
      await this.notify.deliverInboxCopy(
        { ...message, body: APP_DEGRADE_PREFIX + message.body },
        row.topic,
        row.dedupeKey + ":c504",
      );
      this.logger.warn("应用消息失败已降级站内信：" + row.dedupeKey + " —— " + error);
      return { outcome: "dead", error };
    } catch (degradeError) {
      const detail = messageOf(degradeError);
      this.logger.error("应用消息降级站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
    }
  }
}
