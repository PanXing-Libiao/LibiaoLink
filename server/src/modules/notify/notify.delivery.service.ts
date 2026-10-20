/**
 * 发送记录读面与重发（M5-06-2B · S8-4 / C2-07 / C5-03）。
 * - 读：管理员按渠道 / 状态 / 规则 / 收件人 / 时间 / 关键字筛选；尝试目标与错误掩码；
 * - 重发：仅 failed / dead 的外部渠道；新 outbox + 新消息归档，原消息与原尝试不改写；
 * - 幂等：Idempotency-Key 经 actor + 来源消息哈希为 source_dedupe_key，并发同 key 返回同一结果；
 * - 审计：只有真正新建重发归档时写一条 update / notify_delivery。
 */
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  IdempotencyKeySchema,
  type NotifyDeliveryAttempt,
  type NotifyDeliveryDetail,
  type NotifyDeliveryListQuery,
  type NotifyDeliveryListResponse,
  type NotifyDeliveryMessage,
  type NotifyDeliveryResendResponse,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService } from "../audit/index.js";
import { PermissionService } from "../permission/index.js";
import {
  NotifyDeliveryReadRepository,
  type NotifyDeliveryAttemptRecord,
  type NotifyDeliveryMessageRecord,
} from "./notify.delivery-read.repository.js";

const RESEND_CHANNELS = new Set(["wecom_app", "wecom_aibot", "wecom_group"]);
const RESEND_STATES = new Set(["failed", "dead"]);
const SECRET_PATTERN = /(key|secret|access_token|authorization|password)=([^\s&,;]+)/gi;

@Injectable()
export class NotifyDeliveryService {
  constructor(
    private readonly repository: NotifyDeliveryReadRepository,
    private readonly database: DatabaseService,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /** 发送记录列表（管理员读面；目标 / 错误只回掩码）。 */
  async list(actorId: string, query: NotifyDeliveryListQuery): Promise<NotifyDeliveryListResponse> {
    await this.permission.assertCan(
      actorId,
      "notify.record.view",
      undefined,
      "查看发送记录需要 notify.record.view",
    );
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);
    if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
      throw new AppError("VALIDATION_FAILED", "归档时刻区间非法：from 必须早于（或等于）to");
    }
    const keyword = query.q?.trim();
    const result = await this.repository.list({
      channel: query.channel,
      lastState: query.lastState,
      ruleCode: query.ruleCode,
      recipientId: query.recipientId,
      from,
      to,
      q: keyword === undefined || keyword === "" ? undefined : keyword,
      page: query.page,
      limit: query.limit,
    });
    return {
      items: result.items.map(toNotifyDeliveryMessage),
      page: query.page,
      limit: query.limit,
      total: result.total,
    };
  }

  /** 发送记录详情：消息归档 + 全部尝试；不存在统一 404。 */
  async detail(actorId: string, id: number): Promise<NotifyDeliveryDetail> {
    await this.permission.assertCan(
      actorId,
      "notify.record.view",
      undefined,
      "查看发送记录需要 notify.record.view",
    );
    const message = await this.repository.findById(id);
    if (message === null) {
      throw new AppError("NOT_FOUND", "发送记录不存在（id=" + id + "）");
    }
    const attempts = await this.repository.listAttempts(id);
    return {
      ...toNotifyDeliveryMessage(message),
      attempts: attempts.map(toNotifyDeliveryAttempt),
    };
  }

  /**
   * 重发失败 / 死信外部消息：同事务写新归档 + 新 outbox + 审计。
   * 同一 Idempotency-Key 重复请求返回首次新建的归档；不创建第二个 outbox / 审计。
   */
  async resend(actorId: string, id: number, idempotencyKey: string | undefined): Promise<NotifyDeliveryResendResponse> {
    await this.permission.assertCan(actorId, "notify.resend", undefined, "重发发送记录需要 notify.resend");
    const parsedKey = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedKey.success) {
      throw new AppError("VALIDATION_FAILED", "Idempotency-Key 缺失或非法（8~128 字符）");
    }
    const keyHash = createHash("sha256").update(actorId + "\n" + parsedKey.data).digest("hex");
    const sourceDedupeKey = "resend:" + id + ":" + keyHash;

    return this.database.db.transaction(async (tx) => {
      // 幂等优先级高于状态门禁：首次成功后原消息可能已变化，同一 key 重试仍须返回首次结果。
      const existing = await this.repository.findBySourceKey(sourceDedupeKey, tx);
      if (existing !== null) {
        return { message: toNotifyDeliveryMessage(existing) };
      }

      const original = await this.repository.findById(id, tx);
      if (original === null) {
        throw new AppError("NOT_FOUND", "发送记录不存在（id=" + id + "）");
      }
      if (!RESEND_CHANNELS.has(original.channel) || !RESEND_STATES.has(original.lastState)) {
        throw new AppError(
          "VERSION_CONFLICT",
          "重发仅允许 wecom_app / wecom_aibot / wecom_group 且最新状态为 failed / dead" +
            "（当前 " + original.channel + " / " + original.lastState + "）",
        );
      }

      const inserted = await this.repository.insertResendMessage(
        {
          sourceDedupeKey,
          topic: original.topic,
          channel: original.channel,
          recipientId: original.recipientId,
          recipientLabel: original.recipientLabel,
          title: original.title,
          body: original.body,
          templateCode: original.templateCode,
          ruleCode: original.ruleCode,
          refType: original.refType,
          refId: original.refId,
          payload: original.payload,
          resendOfMessageId: original.id,
          metadata: { operation: "resend", sourceMessageId: original.id, idempotencyKeyHash: keyHash },
        },
        tx,
      );
      if (!inserted.created) {
        return { message: toNotifyDeliveryMessage(inserted.row) };
      }

      const outboxId = await this.repository.insertResendOutbox(tx, {
        topic: original.topic,
        payload: original.payload,
        dedupeKey: sourceDedupeKey,
      });
      await this.repository.setOutboxId(tx, inserted.row.id, outboxId);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "notify_delivery",
        objectId: String(inserted.row.id),
        summary: "重发发送记录 #" + original.id + "（" + original.channel + " / " + original.lastState + "）",
        metadata: {
          operation: "resend",
          sourceMessageId: original.id,
          outboxDedupeKey: sourceDedupeKey,
        },
      });
      const saved = await this.repository.findById(inserted.row.id, tx);
      return { message: toNotifyDeliveryMessage(saved ?? { ...inserted.row, outboxId }) };
    });
  }
}

function toNotifyDeliveryMessage(row: NotifyDeliveryMessageRecord): NotifyDeliveryMessage {
  return {
    id: row.id,
    sourceDedupeKey: row.sourceDedupeKey,
    topic: row.topic,
    channel: row.channel,
    recipientId: row.recipientId,
    recipientLabel: maskText(row.recipientLabel),
    title: row.title,
    body: row.body,
    templateCode: row.templateCode,
    ruleCode: row.ruleCode,
    refType: row.refType,
    refId: row.refId,
    resendOfMessageId: row.resendOfMessageId,
    lastState: row.lastState,
    attemptCount: row.attemptCount,
    lastError: maskText(row.lastError),
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toNotifyDeliveryAttempt(row: NotifyDeliveryAttemptRecord): NotifyDeliveryAttempt {
  return {
    id: row.id,
    messageId: row.messageId,
    channel: row.channel as NotifyDeliveryAttempt["channel"],
    targetMasked: maskTarget(row.target),
    state: row.state as NotifyDeliveryAttempt["state"],
    attempts: row.attempts,
    error: maskText(row.error),
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 目标只回末 4 位；短目标全掩码，避免短 userid / chatid 被完整反推。 */
function maskTarget(target: string): string {
  return "****" + (target.length > 4 ? target.slice(-4) : "");
}

/** 错误 / 标签中的常见 Secret 形态脱敏，并限制响应长度。 */
function maskText(value: string | null): string | null {
  if (value === null) return null;
  const masked = value.replace(SECRET_PATTERN, "$1=***");
  return masked.length > 500 ? masked.slice(0, 497) + "..." : masked;
}
