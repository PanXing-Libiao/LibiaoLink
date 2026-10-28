import { Injectable, Logger } from "@nestjs/common";
import {
  NOTIFICATION_SNOOZE_MAX_AHEAD_MS,
  NOTIFICATION_SNOOZE_MIN_LEAD_MS,
  type Notification,
  type NotificationDeleteAllResponse,
  type NotificationDeleteResponse,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationMarkAllReadResponse,
  type NotificationSnoozeBody,
  type NotificationSnoozeListResponse,
  type NotifyMessagePayload,
  type NotifyPrefs,
  type NotifyPrefsUpdateBody,
  type NotifyDeliveryTopic,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { DbClient } from "../../db/db-client.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import {
  formatClockMinute,
  isWithinQuiet,
  mergeKeyOf,
  parseNotifyMessage,
  parseQuietHours,
  planDelivery,
  quietEndAfter,
  shanghaiDayStart,
  shanghaiMinuteOfDay,
  type QuietHours,
} from "./notify.delivery.js";
import {
  inferNotifyRuleCode,
  NotifyDeliveryArchiveRepository,
  type NotifyDeliveryMessageInsert,
  type NotifyDeliveryMessageRow,
} from "./notify.delivery-archive.repository.js";
import {
  NotifyRepository,
  type NotifyInboxFilter,
  type NotifyMessageInsert,
  type NotifyMessageRow,
  type NotifyPrefsPatch,
  type NotifyPrefsRow,
} from "./notify.repository.js";
import { NotifyStreamPublisher } from "./notify.stream.publisher.js";

/** flush 循环单轮统计（worker 日志与回放断言共用）。 */
export interface NotifyFlushStats {
  scanned: number;
  delivered: number;
  merged: number;
  postponed: number;
}

/** 稍后提醒触发循环单轮统计（worker 日志与回放断言共用）。 */
export interface NotifySnoozeFlushStats {
  scanned: number;
  triggered: number;
  deferred: number;
}

/** 生效偏好（个人配置 → env 缺省回退后）。 */
interface ResolvedNotifyPrefs {
  quiet: QuietHours | null;
  dailyLimit: number;
  mergeWindowMs: number;
}

/**
 * 通知投递服务（S7-4 · j1 / M5-04 首刀 · C5 / C2-08 / C2-09）。
 *
 * 三条入口：
 * ① `consume` —— outbox 主题 `notify.message` 消费者（worker 注册表）：一次投递事件 = 一行留档
 *    （`source_dedupe_key` 唯一兜底消费重放），随后三选一：并入同期主行（合并）/ 立即投递 / 排期（免打扰 / 每日上限）；
 * ② `flushDue` —— 延迟投递排空（worker 常驻循环）：把 `deliver_at` 到期的行重排一次（合并或投递），
 *    与 consume 共用同一决策函数 —— 不在 outbox 重试里做（重试语义是「消费失败退避」，不是「投递窗口静默」）。
 * ③ `flushSnoozes` —— 稍后提醒到点触发（worker 常驻循环 · C5-05 / M5-04-2）：与 ② 并列、语义独立 ——
 *    不合并、不消耗每日上限；到点落免打扰时段顺延到时段结束，否则置回 unread + 推 `notification` / `unread`。
 * ④ `deliverInboxCopy` —— C5-04 降级入口（M5-03-3）：企微投递失败 → 同收件人站内信副本（同 ① 投递口径）。
 *
 * 读面（消息中心）：收件箱列表 / 未读角标 / 标记已读·已处理 / 全部已读 / 通知偏好 —— 全为**个人资源**
 * （仅会话、无功能权限键、不写审计；先例 user_preferences / project_views）；稍后提醒（C5-05）同口径：
 * 设置 / 取消 / 记录读面，记录表即留痕（不写审计）。
 *
 * 实时流（S8-3 · M5-04-1）：投递 / 标记在**同一事务内**经 `NotifyStreamPublisher` 发 `pg_notify`
 * （`notification` = 新投递行、`unread` = 未读数快照；合并 / 排期 / 幂等重放不发 —— 未读数无变化），
 * 由 api 实例的 `NotifyStreamService` LISTEN 后桥到该用户 SSE 连接；重连不补发（客户端读面补拉）。
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly repository: NotifyRepository,
    private readonly archive: NotifyDeliveryArchiveRepository,
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
    private readonly clock: ClockService,
    private readonly streamPublisher: NotifyStreamPublisher,
  ) {}

  /** 单条消费（OutboxDispatcher 调用）：分类只有 done / dead / retry；任何异常都不外抛。 */
  async consume(row: OutboxClaimedRow): Promise<OutboxHandleOutcome> {
    const message = parseNotifyMessage(row.payload);
    if (message === null) {
      this.logger.warn("通知载荷非法，转 dead：outbox#" + row.id + "（" + row.dedupeKey + "）");
      return {
        outcome: "dead",
        error: "通知载荷非法（缺 recipientId / type / title / body 或超长）：" + row.dedupeKey,
      };
    }
    const channel = message.channel ?? "inbox";
    if (channel !== "inbox") {
      // M5-03-3 起 wecom_app 已落地：由 NotifyAppService 消费（OutboxModule 按载荷 channel 路由）；
      // 本消费器只承载 inbox。其余渠道（email 等）未落地：按确定性失败收口（dead + 告警），
      // 不得静默当站内信投递（wmj PR #197 护栏）—— 一次即弃，不进重试退避。
      this.logger.warn("通知渠道非 inbox（确定性失败转 dead）：outbox#" + row.id + " · channel=" + channel);
      return {
        outcome: "dead",
        error:
          "非 inbox 渠道（wecom_app 由应用消息服务消费；email 等未落地）：channel=" + channel + " · " + row.dedupeKey,
      };
    }
    try {
      const result = await this.deliverOnce(message, row.topic, row.dedupeKey, row.id);
      if (result.duplicate) {
        // 消费重放（worker 崩溃超领取窗重领 / 人工重放）：source_dedupe_key 唯一命中 —— 幂等收敛为 done。
        this.logger.log("通知重复投递（source_dedupe_key 已存在），幂等跳过：" + row.dedupeKey);
      }
      return { outcome: "done" };
    } catch (error) {
      const message0 = messageOf(error);
      this.logger.error("通知投递失败（按可重试收敛）：outbox#" + row.id + " —— " + message0);
      return { outcome: "retry", error: message0 };
    }
  }

  /** 单条投递（事务内）：落行 → 合并判定 → 投递 / 排期；重放命中唯一键 = duplicate（幂等）。 */
  private async deliverOnce(
    message: NotifyMessagePayload,
    topic: string,
    dedupeKey: string,
    outboxId: number | null = null,
  ): Promise<{ duplicate: boolean }> {
    const now = this.clock.now();
    const prefs = await this.resolvePrefs(message.recipientId);
    const insert: NotifyMessageInsert = {
      recipientId: message.recipientId,
      type: message.type,
      title: message.title,
      body: message.body,
      refType: message.refType ?? null,
      refId: message.refId ?? null,
      sourceTopic: topic,
      sourceDedupeKey: dedupeKey,
      templateCode: message.templateCode ?? null,
      mergeKey: mergeKeyOf(message),
    };
    return this.database.db.transaction(async (tx) => {
      const archived = await this.archive.ensureMessage(archiveInputOf(message, topic, dedupeKey, outboxId), tx);
      const row = await this.repository.insertMessage(insert, tx);
      if (row === null) {
        await this.reconcileArchivedDuplicate(archived, dedupeKey, now, tx);
        return { duplicate: true };
      }
      if (await this.tryMerge(row, prefs, now, tx, archived.id)) {
        return { duplicate: false };
      }
      const decision = planDelivery({
        now,
        quiet: prefs.quiet,
        dailyLimit: prefs.dailyLimit,
        deliveredToday: await this.repository.countDeliveredSince(row.recipientId, shanghaiDayStart(now), tx),
        nextDayStartMinute: this.config.env.NOTIFY_DAILY_WINDOW_START_MINUTE,
      });
      if (decision.deliver) {
        await this.repository.markDelivered(row.id, now, tx);
        await this.archive.markState(
          { messageId: archived.id, state: "sent", at: now, sentAt: now, error: null },
          tx,
        );
        await this.publishDelivered(row, now, tx);
      } else {
        this.logger.log(
          "通知静默排期（" + decision.reason + "）：#" + row.id + " → " + decision.deliverAt.toISOString(),
        );
        await this.repository.postpone(row.id, decision.deliverAt, now, tx);
        await this.archive.markState(
          {
            messageId: archived.id,
            state: "deferred",
            at: now,
            error: "站内信延迟投递（" + decision.reason + "）",
          },
          tx,
        );
      }
      return { duplicate: false };
    });
  }

  /**
   * 历史通知行先于 0061 归档存在时，重复消费只补状态、不重发：
   * 已投递 → sent；合并子行 → sent + mergedIntoId；未到期 / 待排期 → deferred。
   * 既有非 pending 归档视为真实尝试结果，不覆盖。
   */
  private async reconcileArchivedDuplicate(
    archived: NotifyDeliveryMessageRow,
    dedupeKey: string,
    now: Date,
    tx: DbClient,
  ): Promise<void> {
    if (archived.lastState !== "pending") {
      return;
    }
    const existing = await this.repository.findBySourceDedupeKey(dedupeKey, tx);
    if (existing === null) {
      return;
    }
    if (existing.mergedIntoId !== null) {
      await this.archive.markMerged(archived.id, existing.mergedIntoId, existing.deliveredAt ?? now, tx);
      return;
    }
    if (existing.deliveredAt !== null) {
      await this.archive.markState(
        { messageId: archived.id, state: "sent", at: now, sentAt: existing.deliveredAt, error: null },
        tx,
      );
      return;
    }
    await this.archive.markState(
      {
        messageId: archived.id,
        state: "deferred",
        at: now,
        error: "历史站内信待排期投递（重复消费补归档）",
      },
      tx,
    );
  }

  /**
   * C5-04 降级入口（M5-03-3）：企微投递失败 → 站内信副本 —— 与 inbox 消费同一落行 / 合并 / 排期 / 实时流口径。
   * 调用方负责幂等键后缀（先例：":c504" —— 避免与来源事件 source_dedupe_key 唯一约束相撞）。
   */
  async deliverInboxCopy(message: NotifyMessagePayload, topic: string, dedupeKey: string): Promise<{ duplicate: boolean }> {
    return this.deliverOnce(message, topic, dedupeKey, null);
  }

  /**
   * 延迟投递排空（worker 常驻循环）：领取 `deliver_at` 到期的未投递主行，逐条重排（合并 → 投递 / 再排期）。
   * 单行失败只记日志（下一轮重排，不阻塞其余行）；单轮条数由 NOTIFY_FLUSH_BATCH 收敛。
   */
  async flushDue(): Promise<NotifyFlushStats> {
    const now = this.clock.now();
    const due = await this.repository.listDue(now, this.config.env.NOTIFY_FLUSH_BATCH);
    const stats: NotifyFlushStats = { scanned: due.length, delivered: 0, merged: 0, postponed: 0 };
    for (const row of due) {
      try {
        const prefs = await this.resolvePrefs(row.recipientId);
        const outcome = await this.database.db.transaction(async (tx) => {
          const archived = await this.archive.ensureMessage(archiveInputOfRow(row), tx);
          if (await this.tryMerge(row, prefs, now, tx, archived.id)) {
            return "merged" as const;
          }
          const decision = planDelivery({
            now,
            quiet: prefs.quiet,
            dailyLimit: prefs.dailyLimit,
            deliveredToday: await this.repository.countDeliveredSince(row.recipientId, shanghaiDayStart(now), tx),
            nextDayStartMinute: this.config.env.NOTIFY_DAILY_WINDOW_START_MINUTE,
          });
          if (decision.deliver) {
            await this.repository.markDelivered(row.id, now, tx);
            await this.archive.markState(
              { messageId: archived.id, state: "sent", at: now, sentAt: now, error: null },
              tx,
            );
            await this.publishDelivered(row, now, tx);
            return "delivered" as const;
          }
          await this.repository.postpone(row.id, decision.deliverAt, now, tx);
          await this.archive.markState(
            {
              messageId: archived.id,
              state: "deferred",
              at: now,
              error: "站内信延迟投递（" + decision.reason + "）",
            },
            tx,
          );
          return "postponed" as const;
        });
        stats[outcome] += 1;
      } catch (error) {
        this.logger.error("通知延迟投递失败（下一轮重排）：#" + row.id + " —— " + messageOf(error));
      }
    }
    return stats;
  }

  /**
   * 稍后提醒到点触发（worker 常驻循环 · C5-05 / M5-04-2）：与 `flushDue` 并列、语义独立 ——
   * 不合并、不消耗每日上限；到点落免打扰时段 → 顺延到时段结束（复用投递决策先例），否则置回 `unread`
   * （`handled` 行照提醒）+ 清 `snoozeUntil` + 回填记录 `triggeredAt` + 推 `notification` / `unread`。
   * 单行失败只记日志（下一轮重扫，不阻塞其余行）；单轮条数由 NOTIFY_SNOOZE_BATCH 收敛。
   */
  async flushSnoozes(): Promise<NotifySnoozeFlushStats> {
    const now = this.clock.now();
    const due = await this.repository.listDueSnoozes(now, this.config.env.NOTIFY_SNOOZE_BATCH);
    const stats: NotifySnoozeFlushStats = { scanned: due.length, triggered: 0, deferred: 0 };
    for (const row of due) {
      try {
        const prefs = await this.resolvePrefs(row.recipientId);
        const outcome = await this.database.db.transaction(async (tx) => {
          if (prefs.quiet !== null && isWithinQuiet(shanghaiMinuteOfDay(now), prefs.quiet)) {
            const deferredUntil = quietEndAfter(now, prefs.quiet);
            await this.repository.deferSnooze(row.id, deferredUntil, now, tx);
            this.logger.log("稍后提醒免打扰顺延：#" + row.id + " → " + deferredUntil.toISOString());
            return "deferred" as const;
          }
          const updated = await this.repository.triggerSnooze(row.id, now, tx);
          await this.streamPublisher.publish(tx, {
            recipientId: row.recipientId,
            event: "notification",
            data: await this.contractOf(updated, tx),
          });
          const unreadCount = await this.repository.countUnread(row.recipientId, tx);
          await this.streamPublisher.publish(tx, {
            recipientId: row.recipientId,
            event: "unread",
            data: { unreadCount },
          });
          return "triggered" as const;
        });
        stats[outcome] += 1;
      } catch (error) {
        this.logger.error("稍后提醒触发失败（下一轮重扫）：#" + row.id + " —— " + messageOf(error));
      }
    }
    return stats;
  }

  /** 合并判定：命中同人同键、窗口内的未读主行 → 并入（子行留档 + 主行计数自增）。 */
  private async tryMerge(
    row: NotifyMessageRow,
    prefs: ResolvedNotifyPrefs,
    now: Date,
    tx: DbClient,
    messageId: number,
  ): Promise<boolean> {
    if (prefs.mergeWindowMs <= 0) {
      return false;
    }
    const target = await this.repository.findMergeTarget(
      {
        recipientId: row.recipientId,
        mergeKey: row.mergeKey,
        since: new Date(now.getTime() - prefs.mergeWindowMs),
        excludeId: row.id,
      },
      tx,
    );
    if (target === null) {
      return false;
    }
    // 查目标后主行可能刚被删除 / 标读：条件落合并失败时改走正常投递，不能把新消息静默留档。
    if (!(await this.repository.attachMerged({ childId: row.id, parentId: target.id, at: now }, tx))) {
      return false;
    }
    await this.archive.markMerged(messageId, target.id, now, tx);
    return true;
  }

  /** 收件箱清单（C5-01 / C5-02）：状态 / 类型 / 关联对象 + 投递时刻区间 + 分页；随行未读角标。 */
  async list(actorId: string, query: NotificationListQuery): Promise<NotificationListResponse> {
    const from = query.from === undefined ? null : new Date(query.from);
    const to = query.to === undefined ? null : new Date(query.to);
    if (from !== null && to !== null && from.getTime() > to.getTime()) {
      throw new AppError("VALIDATION_FAILED", "投递时刻区间非法：from 必须早于（或等于）to");
    }
    const filter: NotifyInboxFilter = {
      status: query.status ?? null,
      type: query.type ?? null,
      refType: query.refType ?? null,
      from,
      to,
      page: query.page,
      limit: query.limit,
    };
    const { rows, total } = await this.repository.listInbox(actorId, filter);
    const unreadCount = await this.repository.countUnread(actorId);
    return { items: await this.contractsOf(rows), page: query.page, limit: query.limit, total, unreadCount };
  }

  /** 标记状态（C5-01）：幂等；仅本人已投递主行（他人 / 合并子行 / 未投递行统一 404 防 IDOR）。 */
  async mark(actorId: string, id: number, status: string): Promise<Notification> {
    const at = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const existing = await this.repository.findByIdForRecipient(id, actorId, tx);
      if (existing === null || existing.mergedIntoId !== null || existing.deliveredAt === null) {
        throw new AppError("NOT_FOUND", "通知不存在：" + id);
      }
      const wasUnread = existing.status === "unread";
      const updated = await this.repository.markStatus(id, status, at, tx);
      // 未读数变更时刻才广播（幂等同值标记 / 已读互转不打扰其它端）。
      if (wasUnread !== (updated.status === "unread")) {
        await this.publishUnread(actorId, tx);
      }
      return this.contractOf(updated, tx);
    });
  }

  /** 全部标记已读（C5-01）：只动本人已投递未读主行；幂等（无未读时 updated=0）。 */
  async markAllRead(actorId: string): Promise<NotificationMarkAllReadResponse> {
    const at = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const updated = await this.repository.markAllRead(actorId, at, tx);
      const unreadCount = await this.repository.countUnread(actorId, tx);
      // 幂等（updated = 0）不发事件：未读数无变化。
      if (updated > 0) {
        await this.streamPublisher.publish(tx, { recipientId: actorId, event: "unread", data: { unreadCount } });
      }
      return { updated, unreadCount };
    });
  }

  /**
   * 删除指定站内信（C5-01 · 2026-10-23）：本人已投递主行软删隐藏；未读删除同步角标；
   * 他人 / 合并子行 / 未投递 / 已删除行统一 404（与 mark 先例一致）。C5-03 留档不删。
   */
  async deleteOne(actorId: string, id: number): Promise<NotificationDeleteResponse> {
    const at = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const existing = await this.repository.findByIdForRecipient(id, actorId, tx);
      if (existing === null || existing.mergedIntoId !== null || existing.deliveredAt === null) {
        throw new AppError("NOT_FOUND", "通知不存在：" + id);
      }
      const deleted = await this.repository.softDelete(id, actorId, at, tx);
      if (!deleted) {
        throw new AppError("NOT_FOUND", "通知不存在：" + id);
      }
      const unreadCount = await this.repository.countUnread(actorId, tx);
      if (existing.status === "unread") {
        await this.streamPublisher.publish(tx, { recipientId: actorId, event: "unread", data: { unreadCount } });
      }
      return { id, deleted: true, unreadCount };
    });
  }

  /**
   * 一键删除全部站内信（C5-01 · 2026-10-23）：只隐藏本人已投递主行；幂等（已删行不重复计数）。
   * 删除的未读行 > 0 时发 unread 快照；C5-03 留档与管理员发送记录不删。
   */
  async deleteAll(actorId: string): Promise<NotificationDeleteAllResponse> {
    const at = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const result = await this.repository.softDeleteAll(actorId, at, tx);
      const unreadCount = await this.repository.countUnread(actorId, tx);
      if (result.unreadDeleted > 0) {
        await this.streamPublisher.publish(tx, { recipientId: actorId, event: "unread", data: { unreadCount } });
      }
      return { deleted: result.deleted, unreadCount };
    });
  }

  /**
   * 稍后提醒设置（C5-05 · S8-3 / M5-04-2）：范围校验（> now + 5 分钟且 ≤ now + 30 天；毫秒截断到秒后校验）
   * → 覆盖语义（旧记录标 `cancelledAt` + 新记录）→ 行置读（原未读才发 `unread` 快照，对齐 mark 口径）。
   * 404 族 = 他人行 / 合并子行 / 未投递行（与 mark 先例一致）；对已读 / 已处理行均可设置（用户显式意图优先）。
   */
  async snooze(actorId: string, id: number, body: NotificationSnoozeBody): Promise<Notification> {
    const now = this.clock.now();
    // 毫秒位向下取整到秒后再做范围校验（定案 §三-8：秒级口径，不因毫秒位卡边界）。
    const target = new Date(Math.floor(new Date(body.snoozeUntil).getTime() / 1000) * 1000);
    if (target.getTime() <= now.getTime() + NOTIFICATION_SNOOZE_MIN_LEAD_MS) {
      throw new AppError("VALIDATION_FAILED", "稍后提醒时刻过早：须晚于当前时刻 + 5 分钟（毫秒截断到秒后校验）");
    }
    if (target.getTime() > now.getTime() + NOTIFICATION_SNOOZE_MAX_AHEAD_MS) {
      throw new AppError("VALIDATION_FAILED", "稍后提醒时刻过远：不得晚于当前时刻 + 30 天");
    }
    return this.database.db.transaction(async (tx) => {
      const existing = await this.repository.findByIdForRecipient(id, actorId, tx);
      if (existing === null || existing.mergedIntoId !== null || existing.deliveredAt === null) {
        throw new AppError("NOT_FOUND", "通知不存在：" + id);
      }
      const wasUnread = existing.status === "unread";
      const updated = await this.repository.setSnooze(id, target, now, tx);
      if (wasUnread) {
        await this.publishUnread(actorId, tx);
      }
      return this.contractOf(updated, tx);
    });
  }

  /**
   * 稍后提醒取消（C5-05）：幂等（无未触发稍后提醒也 200）—— 清行上 `snoozeUntil` + 活跃记录标 `cancelledAt`。
   * 状态不动（设置时已置读则不回滚）、未读数无变化不发事件；404 族与 mark 先例一致。
   */
  async unsnooze(actorId: string, id: number): Promise<Notification> {
    const at = this.clock.now();
    return this.database.db.transaction(async (tx) => {
      const existing = await this.repository.findByIdForRecipient(id, actorId, tx);
      if (existing === null || existing.mergedIntoId !== null || existing.deliveredAt === null) {
        throw new AppError("NOT_FOUND", "通知不存在：" + id);
      }
      const updated = await this.repository.cancelSnooze(id, at, tx);
      return this.contractOf(updated, tx);
    });
  }

  /** 稍后提醒记录读面（C5-05「设置与触发记录可查」）：按 id 降序、不翻页；404 族与 mark 先例一致。 */
  async listSnoozes(actorId: string, id: number): Promise<NotificationSnoozeListResponse> {
    const existing = await this.repository.findByIdForRecipient(id, actorId);
    if (existing === null || existing.mergedIntoId !== null || existing.deliveredAt === null) {
      throw new AppError("NOT_FOUND", "通知不存在：" + id);
    }
    const rows = await this.repository.listSnoozes(id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        setAt: row.setAt.toISOString(),
        snoozeUntil: row.snoozeUntil.toISOString(),
        triggeredAt: row.triggeredAt === null ? null : row.triggeredAt.toISOString(),
        cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
      })),
    };
  }

  /** 单条站内信 → 契约（按关联对象解析所属项目，供站内信点击直达）。 */
  private async contractOf(row: NotifyMessageRow, tx?: DbClient): Promise<Notification> {
    const [contract] = await this.contractsOf([row], tx);
    if (contract === undefined) throw new Error("notify contract：行缺失");
    return contract;
  }

  /** 批量站内信 → 契约（一次解析全部关联项目，避免逐条查库）。 */
  private async contractsOf(rows: readonly NotifyMessageRow[], tx?: DbClient): Promise<Notification[]> {
    const projects = await this.repository.resolveProjectIds(
      rows.map((row) => ({ refType: row.refType, refId: row.refId })),
      tx,
    );
    return rows.map((row) => {
      const key = row.refType === null || row.refId === null ? null : row.refType + ":" + row.refId;
      return toContract(row, key === null ? null : projects.get(key) ?? null);
    });
  }

  /** 投递广播（新投递 / 延迟补发同一口径）：`notification`（该行契约形态）+ `unread`（角标快照），同一事务内。 */
  private async publishDelivered(row: NotifyMessageRow, at: Date, tx: DbClient): Promise<void> {
    const unreadCount = await this.repository.countUnread(row.recipientId, tx);
    await this.streamPublisher.publish(tx, {
      recipientId: row.recipientId,
      event: "notification",
      data: await this.contractOf({ ...row, deliveredAt: at }, tx),
    });
    await this.streamPublisher.publish(tx, {
      recipientId: row.recipientId,
      event: "unread",
      data: { unreadCount },
    });
  }

  /** 未读数广播（标记 / 全部已读等状态变更时刻）。 */
  private async publishUnread(userId: string, tx: DbClient): Promise<void> {
    const unreadCount = await this.repository.countUnread(userId, tx);
    await this.streamPublisher.publish(tx, { recipientId: userId, event: "unread", data: { unreadCount } });
  }

  /** 通知偏好（生效值）：个人配置缺省时回退 env（NOTIFY_QUIET_HOURS / NOTIFY_DAILY_LIMIT / NOTIFY_MERGE_WINDOW_MS）。 */
  async getPrefs(actorId: string): Promise<NotifyPrefs> {
    return this.toPrefs(await this.repository.getPrefs(actorId));
  }

  /** 更新通知偏好（局部更新：只写传入键；空更新 400）；quietHours 三态 default / off / HH:MM-HH:MM。 */
  async updatePrefs(actorId: string, body: NotifyPrefsUpdateBody): Promise<NotifyPrefs> {
    if (Object.keys(body).length === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "更新内容为空：至少传入一个变更键（quietHours / dailyLimit / mergeWindowMs）",
      );
    }
    const patch: NotifyPrefsPatch = {};
    if (body.quietHours !== undefined) {
      patch.quietHours = body.quietHours === "default" ? null : body.quietHours === "off" ? "" : body.quietHours;
    }
    if (body.dailyLimit !== undefined) {
      patch.dailyLimit = body.dailyLimit;
    }
    if (body.mergeWindowMs !== undefined) {
      patch.mergeWindowMs = body.mergeWindowMs;
    }
    const row = await this.repository.upsertPrefs(actorId, patch, this.clock.now());
    return this.toPrefs(row);
  }

  /** 生效偏好解析：行内值 → env 缺省回退（quiet 三态：null 继承 / '' 关闭 / 自定义）。 */
  private async resolvePrefs(userId: string): Promise<ResolvedNotifyPrefs> {
    const row = await this.repository.getPrefs(userId);
    const effectiveQuiet = row?.quietHours ?? this.config.env.NOTIFY_QUIET_HOURS;
    return {
      quiet: parseQuietHours(effectiveQuiet),
      dailyLimit: row?.dailyLimit ?? this.config.env.NOTIFY_DAILY_LIMIT,
      mergeWindowMs: row?.mergeWindowMs ?? this.config.env.NOTIFY_MERGE_WINDOW_MS,
    };
  }

  /** 行 → 契约读面（quietFrom / quietTo 为生效值；配置态回显 quietHours 三态）。 */
  private toPrefs(row: NotifyPrefsRow | null): NotifyPrefs {
    const quietHours = row?.quietHours ?? "default";
    const effective = row?.quietHours ?? this.config.env.NOTIFY_QUIET_HOURS;
    const quiet = parseQuietHours(effective);
    return {
      quietHours: quietHours === "" ? "off" : quietHours,
      quietFrom: quiet === null ? null : formatClockMinute(quiet.fromMinute),
      quietTo: quiet === null ? null : formatClockMinute(quiet.toMinute),
      dailyLimit: row?.dailyLimit ?? this.config.env.NOTIFY_DAILY_LIMIT,
      mergeWindowMs: row?.mergeWindowMs ?? this.config.env.NOTIFY_MERGE_WINDOW_MS,
      updatedAt: row === null ? null : row.updatedAt.toISOString(),
    };
  }
}

/** inbox 消息归档输入（payload = 规范化载荷；C5-04 以 :c504 独立归档并保留来源键）。 */
function archiveInputOf(
  message: NotifyMessagePayload,
  topic: string,
  dedupeKey: string,
  outboxId: number | null,
): NotifyDeliveryMessageInsert {
  return {
    outboxId,
    sourceDedupeKey: dedupeKey,
    topic: topic as NotifyDeliveryTopic,
    channel: "inbox",
    recipientId: message.recipientId,
    recipientLabel: null,
    title: message.title,
    body: message.body,
    templateCode: message.templateCode ?? null,
    ruleCode: inferNotifyRuleCode(dedupeKey),
    refType: message.refType ?? null,
    refId: message.refId ?? null,
    payload: { ...message, channel: "inbox" },
    metadata: dedupeKey.endsWith(":c504")
      ? { c5_04: true, sourceDedupeKey: dedupeKey.slice(0, -5) }
      : {},
  };
}

/** flush 路径从 notifications 行恢复归档输入（归档已存在时仅是幂等读回）。 */
function archiveInputOfRow(row: NotifyMessageRow): NotifyDeliveryMessageInsert {
  return {
    outboxId: null,
    sourceDedupeKey: row.sourceDedupeKey,
    topic: "notify.message",
    channel: "inbox",
    recipientId: row.recipientId,
    recipientLabel: null,
    title: row.title,
    body: row.body,
    templateCode: row.templateCode,
    ruleCode: inferNotifyRuleCode(row.sourceDedupeKey),
    refType: row.refType,
    refId: row.refId,
    payload: {
      recipientId: row.recipientId,
      type: row.type,
      channel: "inbox",
      title: row.title,
      body: row.body,
      refType: row.refType,
      refId: row.refId,
      templateCode: row.templateCode,
      mergeKey: row.mergeKey,
    },
    metadata: { recoveredFromNotifications: true },
  };
}

/** 行 → 契约（收件箱条目；deliveredAt 在服务层已保证非空）。 */
function toContract(row: NotifyMessageRow, projectId: string | null): Notification {
  return {
    id: row.id,
    type: row.type as Notification["type"],
    title: row.title,
    body: row.body,
    status: row.status as Notification["status"],
    refType: row.refType,
    refId: row.refId,
    projectId,
    templateCode: row.templateCode,
    mergedCount: row.mergedCount,
    // 当前未触发的稍后提醒时刻（C5-05）：未设置 / 已触发 / 已取消 = null。
    snoozeUntil: row.snoozeUntil === null ? null : row.snoozeUntil.toISOString(),
    deliveredAt: (row.deliveredAt ?? row.deliverAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
