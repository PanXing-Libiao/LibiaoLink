/**
 * notifications / notify_prefs 数据访问（0040 · S7-4 · j1 / M5-04 首刀）+ 稍后提醒
 * （0045 · S8-3 / M5-04-2 · C5-05：notifications.snooze_until + notification_snoozes）。
 * 读面只认「主行」（merged_into_id is null）：合并子行仅库内留档（C5-03），不进收件箱。
 * 投递延迟列（deliver_at / delivered_at）承载免打扰与每日上限 —— flush 循环按 deliver_at 到期重排；
 * snooze_until 承载稍后提醒 —— worker 触发循环按 snooze_until 到期重提醒（与投递排空语义独立）。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { files } from "../../db/schema/files.js";
import { projectNodes } from "../../db/schema/flow.js";
import { notificationSnoozes, notifications, notifyPrefs } from "../../db/schema/notify.js";
import { projectStages } from "../../db/schema/projects.js";
import { dailyReports, issues } from "../../db/schema/reports.js";
import { tasks } from "../../db/schema/tasks.js";

/** 通知行（写路径读回与读面共用；契约转换在服务层）。 */
export interface NotifyMessageRow {
  id: number;
  recipientId: string;
  type: string;
  title: string;
  body: string;
  status: string;
  refType: string | null;
  refId: string | null;
  templateCode: string | null;
  /** 来源幂等键（内部字段：flush / 合并时推进消息级归档；不进收件箱契约）。 */
  sourceDedupeKey: string;
  mergeKey: string;
  mergedCount: number;
  mergedIntoId: number | null;
  deliverAt: Date;
  deliveredAt: Date | null;
  /** 当前未触发的稍后提醒时刻（C5-05）：null = 未设置 / 已触发 / 已取消。 */
  snoozeUntil: Date | null;
  createdAt: Date;
}

/** 稍后提醒记录行（读面 / 触发 / 取消回填共用）。 */
export interface NotificationSnoozeRow {
  id: number;
  notificationId: number;
  setAt: Date;
  snoozeUntil: Date;
  triggeredAt: Date | null;
  cancelledAt: Date | null;
}

/** 投递事件落库输入（服务层已完成载荷校验与空白归一）。 */
export interface NotifyMessageInsert {
  recipientId: string;
  type: string;
  title: string;
  body: string;
  refType: string | null;
  refId: string | null;
  sourceTopic: string;
  sourceDedupeKey: string;
  templateCode: string | null;
  mergeKey: string;
}

/** 收件箱读面过滤（服务层已做入参归一）。 */
export interface NotifyInboxFilter {
  status: string | null;
  type: string | null;
  refType: string | null;
  from: Date | null;
  to: Date | null;
  page: number;
  limit: number;
}

/** 站内信关联对象（点击目标解析输入）。 */
export interface NotifyReference {
  refType: string | null;
  refId: string | null;
}

/** 通知偏好行（可空列 = 继承 env 缺省）。 */
export interface NotifyPrefsRow {
  userId: string;
  /** null = 继承缺省 / '' = 关闭 / 'HH:MM-HH:MM' 自定义。 */
  quietHours: string | null;
  dailyLimit: number | null;
  mergeWindowMs: number | null;
  updatedAt: Date;
}

/** 偏好局部更新（只含传入键；quietHours 见三态口径）。 */
export interface NotifyPrefsPatch {
  quietHours?: string | null;
  dailyLimit?: number | null;
  mergeWindowMs?: number | null;
}

const NOTIFY_SELECT = {
  id: notifications.id,
  recipientId: notifications.recipientId,
  type: notifications.type,
  title: notifications.title,
  body: notifications.body,
  status: notifications.status,
  refType: notifications.refType,
  refId: notifications.refId,
  templateCode: notifications.templateCode,
  sourceDedupeKey: notifications.sourceDedupeKey,
  mergeKey: notifications.mergeKey,
  mergedCount: notifications.mergedCount,
  mergedIntoId: notifications.mergedIntoId,
  deliverAt: notifications.deliverAt,
  deliveredAt: notifications.deliveredAt,
  snoozeUntil: notifications.snoozeUntil,
  createdAt: notifications.createdAt,
} as const;

@Injectable()
export class NotifyRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 投递事件落库：`source_dedupe_key` 唯一 —— 消费重放命中冲突返回 null（幂等，不抛错）。 */
  async insertMessage(input: NotifyMessageInsert, tx?: DbClient): Promise<NotifyMessageRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        type: input.type,
        title: input.title,
        body: input.body,
        refType: input.refType,
        refId: input.refId,
        sourceTopic: input.sourceTopic,
        sourceDedupeKey: input.sourceDedupeKey,
        templateCode: input.templateCode,
        mergeKey: input.mergeKey,
      })
      .onConflictDoNothing({ target: notifications.sourceDedupeKey })
      .returning(NOTIFY_SELECT);
    return rows[0] ?? null;
  }

  /** 重复消费读回既有通知行（消息归档状态收敛用）；无行返回 null。 */
  async findBySourceDedupeKey(sourceDedupeKey: string, tx?: DbClient): Promise<NotifyMessageRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(eq(notifications.sourceDedupeKey, sourceDedupeKey))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 到期未投递行（flush 循环领取：主行、未投递、deliver_at 已到）。 */
  async listDue(now: Date, limit: number, tx?: DbClient): Promise<NotifyMessageRow[]> {
    const db = tx ?? this.database.db;
    return db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(
        and(
          isNull(notifications.mergedIntoId),
          isNull(notifications.deliveredAt),
          lte(notifications.deliverAt, now),
        ),
      )
      .orderBy(asc(notifications.deliverAt), asc(notifications.id))
      .limit(limit);
  }

  /**
   * 合并目标：同收件人 + 同合并键、窗口内创建、未读且未合并的**更早**主行（`id < excludeId`，取最新的那条）。
   * 只并入更早的行 = 「首条为主、后续并入」：消费路径 B 并入 A；flush 路径按 id 升序处理时，
   * 早行先投递、晚行再并入早行，主行恒为最早那条（结果与处理顺序无关）。
   */
  async findMergeTarget(
    input: { recipientId: string; mergeKey: string; since: Date; excludeId: number },
    tx?: DbClient,
  ): Promise<NotifyMessageRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, input.recipientId),
          eq(notifications.mergeKey, input.mergeKey),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          eq(notifications.status, "unread"),
          gte(notifications.createdAt, input.since),
          lt(notifications.id, input.excludeId),
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 合并落库：主行仍可见且未读时自增 merged_count，再把子行挂主行（同一事务两笔）。
   * 主行在「查合并目标」与「落合并」之间被删除 / 标读时返回 false，由调用方改走正常投递，
   * 避免新消息被并入已从收件箱隐藏的主行而静默丢失。
   */
  async attachMerged(
    input: { childId: number; parentId: number; at: Date },
    tx?: DbClient,
  ): Promise<boolean> {
    const db = tx ?? this.database.db;
    const parents = await db
      .update(notifications)
      .set({ mergedCount: sql`${notifications.mergedCount} + 1`, updatedAt: input.at })
      .where(
        and(
          eq(notifications.id, input.parentId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          eq(notifications.status, "unread"),
        ),
      )
      .returning({ id: notifications.id });
    if (parents.length === 0) {
      return false;
    }
    await db
      .update(notifications)
      .set({ mergedIntoId: input.parentId, updatedAt: input.at })
      .where(eq(notifications.id, input.childId));
    return true;
  }

  /** 投递：置 delivered_at（收件箱可见）。 */
  async markDelivered(id: number, at: Date, tx?: DbClient): Promise<void> {
    const db = tx ?? this.database.db;
    await db.update(notifications).set({ deliveredAt: at, updatedAt: at }).where(eq(notifications.id, id));
  }

  /** 延迟投递：推后 deliver_at（免打扰 / 每日上限），delivered_at 保持空。 */
  async postpone(id: number, deliverAt: Date, at: Date, tx?: DbClient): Promise<void> {
    const db = tx ?? this.database.db;
    await db.update(notifications).set({ deliverAt, updatedAt: at }).where(eq(notifications.id, id));
  }

  /** 当日已投递主行数（每人每日上限的统计口径：按 delivered_at、Asia/Shanghai 业务日起点）。 */
  async countDeliveredSince(recipientId: string, since: Date, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          gte(notifications.deliveredAt, since),
        ),
      );
    return Number(rows[0]?.value ?? 0);
  }

  /**
   * 站内信点击目标的项目 id：project 直接回填；task / stage / node / report / issue / file 按对象读回所属项目。
   * 只读解析，不复制到 notifications；查不到 / 已删对象 = null（前端仍可置读，不跳空页）。
   */
  async resolveProjectIds(refs: readonly NotifyReference[], tx?: DbClient): Promise<Map<string, string>> {
    const db = tx ?? this.database.db;
    const result = new Map<string, string>();
    const idsByType = new Map<string, Set<string>>();
    for (const ref of refs) {
      if (ref.refType === null || ref.refId === null) continue;
      const key = ref.refType + ":" + ref.refId;
      if (result.has(key)) continue;
      if (ref.refType === "project") {
        result.set(key, ref.refId);
        continue;
      }
      const bucket = idsByType.get(ref.refType) ?? new Set<string>();
      bucket.add(ref.refId);
      idsByType.set(ref.refType, bucket);
    }
    const addRows = (refType: string, rows: readonly { id: string; projectId: string }[]): void => {
      for (const row of rows) result.set(refType + ":" + row.id, row.projectId);
    };
    const taskIds = [...(idsByType.get("task") ?? [])];
    if (taskIds.length > 0) {
      addRows(
        "task",
        await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(inArray(tasks.id, taskIds)),
      );
    }
    const stageIds = [...(idsByType.get("stage") ?? [])];
    if (stageIds.length > 0) {
      addRows(
        "stage",
        await db.select({ id: projectStages.id, projectId: projectStages.projectId }).from(projectStages).where(inArray(projectStages.id, stageIds)),
      );
    }
    const nodeIds = [...(idsByType.get("node") ?? [])];
    if (nodeIds.length > 0) {
      addRows(
        "node",
        await db.select({ id: projectNodes.id, projectId: projectNodes.projectId }).from(projectNodes).where(inArray(projectNodes.id, nodeIds)),
      );
    }
    const reportIds = new Set<string>([...(idsByType.get("report") ?? []), ...(idsByType.get("daily_report") ?? [])]);
    if (reportIds.size > 0) {
      const rows = await db
        .select({ id: dailyReports.id, projectId: dailyReports.projectId })
        .from(dailyReports)
        .where(inArray(dailyReports.id, [...reportIds]));
      addRows("report", rows);
      addRows("daily_report", rows);
    }
    const issueIds = [...(idsByType.get("issue") ?? [])];
    if (issueIds.length > 0) {
      addRows(
        "issue",
        await db.select({ id: issues.id, projectId: issues.projectId }).from(issues).where(inArray(issues.id, issueIds)),
      );
    }
    const fileIds = [...(idsByType.get("file") ?? [])];
    if (fileIds.length > 0) {
      addRows(
        "file",
        await db.select({ id: files.id, projectId: files.projectId }).from(files).where(inArray(files.id, fileIds)),
      );
    }
    return result;
  }

  /** 收件箱：过滤 + 分页（id 降序 = 新消息在前）+ 总数。 */
  async listInbox(
    recipientId: string,
    filter: NotifyInboxFilter,
    tx?: DbClient,
  ): Promise<{ rows: NotifyMessageRow[]; total: number }> {
    const db = tx ?? this.database.db;
    const conditions: SQL[] = [
      eq(notifications.recipientId, recipientId),
      isNull(notifications.mergedIntoId),
      isNull(notifications.deletedAt),
      // 收件箱只返回**已投递**行：delay 中的行（免打扰 / 每日上限排队）不属于收件箱可见面。
      isNotNull(notifications.deliveredAt),
    ];
    if (filter.status !== null) {
      conditions.push(eq(notifications.status, filter.status));
    }
    if (filter.type !== null) {
      conditions.push(eq(notifications.type, filter.type));
    }
    if (filter.refType !== null) {
      conditions.push(eq(notifications.refType, filter.refType));
    }
    if (filter.from !== null) {
      conditions.push(gte(notifications.deliveredAt, filter.from));
    }
    if (filter.to !== null) {
      conditions.push(lte(notifications.deliveredAt, filter.to));
    }
    const where = and(...conditions);
    const rows = await db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit);
    const totals = await db.select({ value: count() }).from(notifications).where(where);
    return { rows, total: Number(totals[0]?.value ?? 0) };
  }

  /** 未读角标（C5-01；只算已投递主行）。 */
  async countUnread(recipientId: string, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          eq(notifications.status, "unread"),
          isNotNull(notifications.deliveredAt),
        ),
      );
    return Number(rows[0]?.value ?? 0);
  }

  /** 本人行回读（标记入口的归属校验；合并子行 / 未投递行同样返回，由服务层裁 404）。 */
  async findByIdForRecipient(id: number, recipientId: string, tx?: DbClient): Promise<NotifyMessageRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.recipientId, recipientId), isNull(notifications.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 标记状态（幂等：同值再标 = 0 行变更，读回原行）。 */
  async markStatus(id: number, status: string, at: Date, tx?: DbClient): Promise<NotifyMessageRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(notifications)
      .set({ status, updatedAt: at })
      .where(eq(notifications.id, id))
      .returning(NOTIFY_SELECT);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("notify markStatus：行不存在（id=" + id + "）");
    }
    return row;
  }

  /** 全部标记已读（只动已投递主行）：返回实际置位条数。 */
  async markAllRead(recipientId: string, at: Date, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(notifications)
      .set({ status: "read", updatedAt: at })
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          eq(notifications.status, "unread"),
          isNotNull(notifications.deliveredAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  }

  /** 删除指定站内信（软删）：先命中本人已投递主行，再取消该行未触发的稍后提醒；返回是否命中。 */
  async softDelete(id: number, recipientId: string, at: Date, tx?: DbClient): Promise<boolean> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(notifications)
      .set({ deletedAt: at, snoozeUntil: null, updatedAt: at })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          isNotNull(notifications.deliveredAt),
        ),
      )
      .returning({ id: notifications.id });
    if (rows.length === 0) {
      return false;
    }
    await db
      .update(notificationSnoozes)
      .set({ cancelledAt: at })
      .where(
        and(
          eq(notificationSnoozes.notificationId, id),
          isNull(notificationSnoozes.triggeredAt),
          isNull(notificationSnoozes.cancelledAt),
        ),
      );
    return true;
  }

  /** 一键删除全部（软删）：只隐藏本人已投递主行；返回本次删除数与其中未读数。 */
  async softDeleteAll(
    recipientId: string,
    at: Date,
    tx?: DbClient,
  ): Promise<{ deleted: number; unreadDeleted: number }> {
    const db = tx ?? this.database.db;
    const visibleIds = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          isNotNull(notifications.deliveredAt),
        ),
      );
    await db
      .update(notificationSnoozes)
      .set({ cancelledAt: at })
      .where(
        and(
          isNull(notificationSnoozes.triggeredAt),
          isNull(notificationSnoozes.cancelledAt),
          inArray(notificationSnoozes.notificationId, visibleIds),
        ),
      );
    const rows = await db
      .update(notifications)
      .set({ deletedAt: at, snoozeUntil: null, updatedAt: at })
      .where(
        and(
          eq(notifications.recipientId, recipientId),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          isNotNull(notifications.deliveredAt),
        ),
      )
      .returning({ status: notifications.status });
    return {
      deleted: rows.length,
      unreadDeleted: rows.filter((row) => row.status === "unread").length,
    };
  }

  /**
   * 设置 / 覆盖稍后提醒（C5-05）：旧活跃记录标 cancelled_at（无也照走）+ 写新记录 +
   * 行上置 snooze_until 并置读（「收下、稍后再看」；定案 §三-6②③）。
   */
  async setSnooze(notificationId: number, until: Date, at: Date, tx?: DbClient): Promise<NotifyMessageRow> {
    const db = tx ?? this.database.db;
    await db
      .update(notificationSnoozes)
      .set({ cancelledAt: at })
      .where(
        and(
          eq(notificationSnoozes.notificationId, notificationId),
          isNull(notificationSnoozes.triggeredAt),
          isNull(notificationSnoozes.cancelledAt),
        ),
      );
    await db.insert(notificationSnoozes).values({ notificationId, setAt: at, snoozeUntil: until });
    return this.applySnoozeState(db, notificationId, { snoozeUntil: until, status: "read" }, at);
  }

  /** 取消稍后提醒（幂等）：活跃记录标 cancelled_at（无也 200）+ 行上清 snooze_until（状态不动）。 */
  async cancelSnooze(notificationId: number, at: Date, tx?: DbClient): Promise<NotifyMessageRow> {
    const db = tx ?? this.database.db;
    await db
      .update(notificationSnoozes)
      .set({ cancelledAt: at })
      .where(
        and(
          eq(notificationSnoozes.notificationId, notificationId),
          isNull(notificationSnoozes.triggeredAt),
          isNull(notificationSnoozes.cancelledAt),
        ),
      );
    return this.applySnoozeState(db, notificationId, { snoozeUntil: null }, at);
  }

  /** 到点触发（C5-05）：活跃记录回填 triggered_at + 行上清 snooze_until 并置回 unread（handled 行照提醒）。 */
  async triggerSnooze(notificationId: number, at: Date, tx?: DbClient): Promise<NotifyMessageRow> {
    const db = tx ?? this.database.db;
    await db
      .update(notificationSnoozes)
      .set({ triggeredAt: at })
      .where(
        and(
          eq(notificationSnoozes.notificationId, notificationId),
          isNull(notificationSnoozes.triggeredAt),
          isNull(notificationSnoozes.cancelledAt),
        ),
      );
    return this.applySnoozeState(db, notificationId, { snoozeUntil: null, status: "unread" }, at);
  }

  /** 免打扰顺延：把行上 snooze_until 推到时段结束（记录不动 —— 记录存设定时刻，触发时刻见 triggered_at）。 */
  async deferSnooze(notificationId: number, until: Date, at: Date, tx?: DbClient): Promise<void> {
    const db = tx ?? this.database.db;
    await db.update(notifications).set({ snoozeUntil: until, updatedAt: at }).where(eq(notifications.id, notificationId));
  }

  /** 稍后提醒到期候选（触发循环领取：主行、已投递、snooze_until 已到；按到期序）。 */
  async listDueSnoozes(now: Date, limit: number, tx?: DbClient): Promise<NotifyMessageRow[]> {
    const db = tx ?? this.database.db;
    return db
      .select(NOTIFY_SELECT)
      .from(notifications)
      .where(
        and(
          isNotNull(notifications.snoozeUntil),
          lte(notifications.snoozeUntil, now),
          isNull(notifications.mergedIntoId),
          isNull(notifications.deletedAt),
          isNotNull(notifications.deliveredAt),
        ),
      )
      .orderBy(asc(notifications.snoozeUntil), asc(notifications.id))
      .limit(limit);
  }

  /** 稍后提醒记录读面（C5-05）：按 id 降序、不翻页。 */
  async listSnoozes(notificationId: number, tx?: DbClient): Promise<NotificationSnoozeRow[]> {
    const db = tx ?? this.database.db;
    return db
      .select({
        id: notificationSnoozes.id,
        notificationId: notificationSnoozes.notificationId,
        setAt: notificationSnoozes.setAt,
        snoozeUntil: notificationSnoozes.snoozeUntil,
        triggeredAt: notificationSnoozes.triggeredAt,
        cancelledAt: notificationSnoozes.cancelledAt,
      })
      .from(notificationSnoozes)
      .where(eq(notificationSnoozes.notificationId, notificationId))
      .orderBy(desc(notificationSnoozes.id));
  }

  /** 稍后提醒三态落行（置 / 清 snooze_until，触发 / 设置附带状态切换；读回契约形态）。 */
  private async applySnoozeState(
    db: DbClient,
    id: number,
    values: { snoozeUntil: Date | null; status?: "read" | "unread" },
    at: Date,
  ): Promise<NotifyMessageRow> {
    const rows = await db
      .update(notifications)
      .set({ ...values, updatedAt: at })
      .where(eq(notifications.id, id))
      .returning(NOTIFY_SELECT);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("notify applySnoozeState：行不存在（id=" + id + "）");
    }
    return row;
  }

  /** 偏好读取（无行 = 全走 env 缺省）。 */
  async getPrefs(userId: string, tx?: DbClient): Promise<NotifyPrefsRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({
        userId: notifyPrefs.userId,
        quietHours: notifyPrefs.quietHours,
        dailyLimit: notifyPrefs.dailyLimit,
        mergeWindowMs: notifyPrefs.mergeWindowMs,
        updatedAt: notifyPrefs.updatedAt,
      })
      .from(notifyPrefs)
      .where(eq(notifyPrefs.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 偏好落库（局部更新：只写传入键；无行则插入）。 */
  async upsertPrefs(userId: string, patch: NotifyPrefsPatch, at: Date, tx?: DbClient): Promise<NotifyPrefsRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(notifyPrefs)
      .values({ userId, ...patch, updatedAt: at })
      .onConflictDoUpdate({ target: notifyPrefs.userId, set: { ...patch, updatedAt: at } })
      .returning({
        userId: notifyPrefs.userId,
        quietHours: notifyPrefs.quietHours,
        dailyLimit: notifyPrefs.dailyLimit,
        mergeWindowMs: notifyPrefs.mergeWindowMs,
        updatedAt: notifyPrefs.updatedAt,
      });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("notify upsertPrefs：写入未返回行（userId=" + userId + "）");
    }
    return row;
  }
}

