import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { taskNodeReviewerNotificationSettings } from "../../db/schema/templates.js";

export type TaskNodeReviewNotificationMode = "immediate" | "scheduled";

/** 审核通知个人设置行；last_dispatched_on 仅供固定时间派发去重。缺行时读面返回默认值。 */
export interface TaskNodeReviewNotificationSettingsRow {
  reviewerId: string;
  enabled: boolean;
  notificationMode: TaskNodeReviewNotificationMode;
  dailyTime: string;
  lastDispatchedOn: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface TaskNodeReviewNotificationSettingsUpdate {
  enabled: boolean;
  notificationMode: TaskNodeReviewNotificationMode;
  dailyTime: string;
}

const SETTINGS_COLUMNS = {
  reviewerId: taskNodeReviewerNotificationSettings.reviewerId,
  enabled: taskNodeReviewerNotificationSettings.enabled,
  notificationMode: taskNodeReviewerNotificationSettings.notificationMode,
  dailyTime: taskNodeReviewerNotificationSettings.dailyTime,
  lastDispatchedOn: taskNodeReviewerNotificationSettings.lastDispatchedOn,
  updatedAt: taskNodeReviewerNotificationSettings.updatedAt,
  updatedBy: taskNodeReviewerNotificationSettings.updatedBy,
} as const;

type RawSettingsRow = {
  reviewerId: string;
  enabled: boolean;
  notificationMode: string;
  dailyTime: string;
  lastDispatchedOn: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

/** 审核人尚未保存过设置时的默认值：开启、固定时间 09:00（与 0099 全局默认一致）。 */
function defaultRow(reviewerId: string): TaskNodeReviewNotificationSettingsRow {
  return {
    reviewerId,
    enabled: true,
    notificationMode: "scheduled",
    dailyTime: "09:00",
    lastDispatchedOn: null,
    updatedAt: new Date(0),
    updatedBy: null,
  };
}

function toRow(row: RawSettingsRow): TaskNodeReviewNotificationSettingsRow {
  return {
    ...row,
    notificationMode: row.notificationMode as TaskNodeReviewNotificationMode,
  };
}

/**
 * 公共节点审核企微通知个人设置仓库（0100）：
 * - 以 reviewer_id = users.id 为主键；GET / PUT 只读写当前审核人的一行；
 * - 缺行读面按默认（开启 / 固定时间 / 09:00）返回，首次保存或首次到点派发时落行；
 * - worker 只锁本次到点的审核人行，按 reviewer_id 顺序加锁，避免多实例重复派发；
 * - markDispatched 只推进该审核人的 last_dispatched_on，不修改 updated_at。
 */
@Injectable()
export class TaskNodeReviewNotificationSettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  async getSettings(reviewerId: string, tx?: DbClient): Promise<TaskNodeReviewNotificationSettingsRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select(SETTINGS_COLUMNS)
      .from(taskNodeReviewerNotificationSettings)
      .where(eq(taskNodeReviewerNotificationSettings.reviewerId, reviewerId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? defaultRow(reviewerId) : toRow(row);
  }

  /** 批量读面：返回与入参同序、等长的行；没有设置行的审核人补默认值。 */
  async listSettings(
    reviewerIds: readonly string[],
    tx?: DbClient,
  ): Promise<TaskNodeReviewNotificationSettingsRow[]> {
    if (reviewerIds.length === 0) return [];
    const db = tx ?? this.database.db;
    const rows = await db
      .select(SETTINGS_COLUMNS)
      .from(taskNodeReviewerNotificationSettings)
      .where(inArray(taskNodeReviewerNotificationSettings.reviewerId, [...reviewerIds]));
    const byReviewer = new Map(rows.map((row) => [row.reviewerId, toRow(row)]));
    return reviewerIds.map((reviewerId) => byReviewer.get(reviewerId) ?? defaultRow(reviewerId));
  }

  /** 只返回当前开启且选择及时通知的审核人；没有设置行的审核人默认 scheduled，不在这里命中。 */
  async listImmediateEnabledReviewerIds(
    reviewerIds: readonly string[],
    tx?: DbClient,
  ): Promise<string[]> {
    if (reviewerIds.length === 0) return [];
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ reviewerId: taskNodeReviewerNotificationSettings.reviewerId })
      .from(taskNodeReviewerNotificationSettings)
      .where(
        and(
          inArray(taskNodeReviewerNotificationSettings.reviewerId, [...reviewerIds]),
          eq(taskNodeReviewerNotificationSettings.enabled, true),
          eq(taskNodeReviewerNotificationSettings.notificationMode, "immediate"),
        ),
      )
      .orderBy(asc(taskNodeReviewerNotificationSettings.reviewerId));
    return rows.map((row) => row.reviewerId);
  }

  /** 到点派发前锁住该审核人的设置；缺行时先落默认行，保证多实例串行。 */
  async lockSettings(reviewerId: string, tx: DbClient): Promise<TaskNodeReviewNotificationSettingsRow> {
    await tx
      .insert(taskNodeReviewerNotificationSettings)
      .values({ reviewerId })
      .onConflictDoNothing();
    const rows = await tx
      .select(SETTINGS_COLUMNS)
      .from(taskNodeReviewerNotificationSettings)
      .where(eq(taskNodeReviewerNotificationSettings.reviewerId, reviewerId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) throw new Error("task_node_reviewer_notification_settings 加锁后未找到行");
    return toRow(row);
  }

  async updateSettings(
    reviewerId: string,
    input: TaskNodeReviewNotificationSettingsUpdate,
    actorId: string,
    at: Date,
    tx?: DbClient,
  ): Promise<TaskNodeReviewNotificationSettingsRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(taskNodeReviewerNotificationSettings)
      .values({
        reviewerId,
        enabled: input.enabled,
        notificationMode: input.notificationMode,
        dailyTime: input.dailyTime,
        updatedAt: at,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: taskNodeReviewerNotificationSettings.reviewerId,
        set: {
          enabled: input.enabled,
          notificationMode: input.notificationMode,
          dailyTime: input.dailyTime,
          updatedAt: at,
          updatedBy: actorId,
        },
      })
      .returning(SETTINGS_COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error("task_node_reviewer_notification_settings 更新未返回行");
    return toRow(row);
  }

  async markDispatched(reviewerId: string, on: string, tx: DbClient): Promise<void> {
    await tx
      .update(taskNodeReviewerNotificationSettings)
      .set({ lastDispatchedOn: on })
      .where(eq(taskNodeReviewerNotificationSettings.reviewerId, reviewerId));
  }
}
