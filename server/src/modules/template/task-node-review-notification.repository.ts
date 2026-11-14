import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { taskNodeReviewNotificationSettings } from "../../db/schema/templates.js";

/** 审核通知设置行（读面只暴露业务字段，last_dispatched_on 仅供派发去重）。 */
export interface TaskNodeReviewNotificationSettingsRow {
  enabled: boolean;
  dailyTime: string;
  lastDispatchedOn: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface TaskNodeReviewNotificationSettingsUpdate {
  enabled: boolean;
  dailyTime: string;
}

/**
 * 公共节点审核企微通知设置仓库（0099 单例）：
 * - 读 / 更新业务设置；worker 每日派发前用 FOR UPDATE 锁住单例，多实例同一时刻只会有一个进入扫描；
 * - markDispatched 只推进 last_dispatched_on，不修改 updated_at（后者仅表示人工设置变更）。
 */
@Injectable()
export class TaskNodeReviewNotificationSettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  async getSettings(tx?: DbClient): Promise<TaskNodeReviewNotificationSettingsRow> {
    return await this.read(tx ?? this.database.db);
  }

  /** 每日派发入口：锁住单例，读到 last_dispatched_on 后决定是否派发。 */
  async lockSettings(tx: DbClient): Promise<TaskNodeReviewNotificationSettingsRow> {
    const db = tx;
    const rows = await db
      .select({
        enabled: taskNodeReviewNotificationSettings.enabled,
        dailyTime: taskNodeReviewNotificationSettings.dailyTime,
        lastDispatchedOn: taskNodeReviewNotificationSettings.lastDispatchedOn,
        updatedAt: taskNodeReviewNotificationSettings.updatedAt,
        updatedBy: taskNodeReviewNotificationSettings.updatedBy,
      })
      .from(taskNodeReviewNotificationSettings)
      .where(eq(taskNodeReviewNotificationSettings.id, true))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) throw new Error("task_node_review_notification_settings 单行缺失");
    return row;
  }

  async updateSettings(
    input: TaskNodeReviewNotificationSettingsUpdate,
    actorId: string,
    at: Date,
    tx?: DbClient,
  ): Promise<TaskNodeReviewNotificationSettingsRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskNodeReviewNotificationSettings)
      .set({
        enabled: input.enabled,
        dailyTime: input.dailyTime,
        updatedAt: at,
        updatedBy: actorId,
      })
      .where(eq(taskNodeReviewNotificationSettings.id, true))
      .returning({
        enabled: taskNodeReviewNotificationSettings.enabled,
        dailyTime: taskNodeReviewNotificationSettings.dailyTime,
        lastDispatchedOn: taskNodeReviewNotificationSettings.lastDispatchedOn,
        updatedAt: taskNodeReviewNotificationSettings.updatedAt,
        updatedBy: taskNodeReviewNotificationSettings.updatedBy,
      });
    const row = rows[0];
    if (row === undefined) throw new Error("task_node_review_notification_settings 更新未返回行");
    return row;
  }

  async markDispatched(on: string, tx: DbClient): Promise<void> {
    await tx
      .update(taskNodeReviewNotificationSettings)
      .set({ lastDispatchedOn: on })
      .where(eq(taskNodeReviewNotificationSettings.id, true));
  }

  private async read(db: DbClient): Promise<TaskNodeReviewNotificationSettingsRow> {
    const rows = await db
      .select({
        enabled: taskNodeReviewNotificationSettings.enabled,
        dailyTime: taskNodeReviewNotificationSettings.dailyTime,
        lastDispatchedOn: taskNodeReviewNotificationSettings.lastDispatchedOn,
        updatedAt: taskNodeReviewNotificationSettings.updatedAt,
        updatedBy: taskNodeReviewNotificationSettings.updatedBy,
      })
      .from(taskNodeReviewNotificationSettings)
      .where(eq(taskNodeReviewNotificationSettings.id, true))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error("task_node_review_notification_settings 单行缺失");
    return row;
  }
}
