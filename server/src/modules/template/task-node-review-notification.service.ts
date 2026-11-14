import { Injectable } from "@nestjs/common";
import { STAGE_NAMES } from "@libiaolink/contracts";
import type {
  TaskNodeReviewNotificationSettings,
  TaskNodeReviewNotificationSettingsBody,
} from "@libiaolink/contracts";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutboxIfAbsent } from "../../db/outbox.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import { TaskNodeRepository } from "./task-node.repository.js";
import type { TaskNodeRow } from "./task-node.repository.js";
import { TaskNodeRequestRepository } from "./task-node-request.repository.js";
import {
  TaskNodeReviewNotificationSettingsRepository,
  type TaskNodeReviewNotificationSettingsRow,
} from "./task-node-review-notification.repository.js";
import { buildTaskNodeReviewMessage } from "./task-node-review-wecom.js";

const STAGE_NAME_BY_KEY = STAGE_NAMES as Record<string, string>;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAILY_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** 上海业务日与 HH:mm（无夏令时，固定 UTC+8，ADR-028）。 */
export function shanghaiWallClockOf(now: Date): { date: string; time: string } {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

export type TaskNodeReviewNotificationDispatchState =
  | "disabled"
  | "not_due"
  | "already_dispatched"
  | "no_reviewers"
  | "dispatched";

export interface TaskNodeReviewNotificationDispatchResult {
  state: TaskNodeReviewNotificationDispatchState;
  produced: number;
}

function toContract(row: TaskNodeReviewNotificationSettingsRow): TaskNodeReviewNotificationSettings {
  return { enabled: row.enabled, dailyTime: row.dailyTime };
}

function settingsSnapshot(row: TaskNodeReviewNotificationSettingsRow): Record<string, unknown> {
  return { enabled: row.enabled, dailyTime: row.dailyTime };
}

/**
 * 公共节点审核企微通知（0099 · 2026-11-15）：
 * - 全局单例设置：开关 + 每日通知时间（Asia/Shanghai），仅当前公共节点审核管理员可读 / 改；
 * - 关闭 = 不生成待审核申请通知 outbox；开启 = worker 每分钟看一次，到点后把当日尚未通知的 pending 申请
 *   逐条写给当前有效审核人；last_dispatched_on 保证同一上海业务日只跑一次；
 * - 审批结果通知不在这里，仍由审核动作即时发送，避免两位审核人并发时另一位收不到结论。
 */
@Injectable()
export class TaskNodeReviewNotificationService {
  constructor(
    private readonly settings: TaskNodeReviewNotificationSettingsRepository,
    private readonly requests: TaskNodeRequestRepository,
    private readonly nodes: TaskNodeRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {}

  /** GET /api/v1/task-node-requests/notification-settings。 */
  async getSettings(actorId: string): Promise<TaskNodeReviewNotificationSettings> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "查看公共节点审核通知设置需要已授权的管理员权限");
    return toContract(await this.settings.getSettings());
  }

  /** PUT /api/v1/task-node-requests/notification-settings（整份保存，避免半更新竞态）。 */
  async updateSettings(
    body: TaskNodeReviewNotificationSettingsBody,
    actorId: string,
  ): Promise<TaskNodeReviewNotificationSettings> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "修改公共节点审核通知设置需要已授权的管理员权限");
    if (!DAILY_TIME_PATTERN.test(body.dailyTime)) {
      throw new AppError("VALIDATION_FAILED", "每日通知时间格式必须为 HH:mm");
    }
    const at = this.clock.now();
    return await this.database.db.transaction(async (tx) => {
      const before = await this.settings.lockSettings(tx);
      const saved = await this.settings.updateSettings(body, actorId, at, tx);
      const changes = diffRecords(settingsSnapshot(before), settingsSnapshot(saved));
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node_review_notification_settings",
        objectId: "default",
        summary:
          "更新公共节点审核企微通知：" + (saved.enabled ? "开" : "关") + " · 每天 " + saved.dailyTime,
        changes: changes.length > 0 ? changes : null,
        metadata: {},
      });
      return toContract(saved);
    });
  }

  /**
   * worker 每分钟调用：只有开启且到达每日时刻才派发；审批结果通知不经过本方法。
   * 先做一次无锁预读避免非到点时的写事务；真正派发前在事务内再次锁行复核，保证多实例不重复。
   */
  async flushScheduledNotifications(now: Date = this.clock.now()): Promise<TaskNodeReviewNotificationDispatchResult> {
    const wall = shanghaiWallClockOf(now);
    const preview = await this.settings.getSettings();
    const previewState = evaluateDispatchState(preview, wall.date, wall.time);
    if (previewState !== null) {
      return { state: previewState, produced: 0 };
    }
    const reviewerIds = await this.permission.listEffectiveTaskNodeReviewers();
    if (reviewerIds.length === 0) {
      return { state: "no_reviewers", produced: 0 };
    }
    return await this.database.db.transaction(async (tx) => {
      const locked = await this.settings.lockSettings(tx);
      const state = evaluateDispatchState(locked, wall.date, wall.time);
      if (state !== null) {
        return { state, produced: 0 };
      }
      const pending = await this.requests.list(
        { stageKey: null, status: "pending", requestedBy: null },
        tx,
      );
      const nodesByStage = new Map<string, TaskNodeRow[]>();
      const baseUrl = this.config.env.PUBLIC_APP_BASE_URL;
      let produced = 0;
      for (const request of pending) {
        let existingNodes = nodesByStage.get(request.stageKey);
        if (existingNodes === undefined) {
          existingNodes = await this.nodes.list(request.stageKey, tx);
          nodesByStage.set(request.stageKey, existingNodes);
        }
        const stageName = STAGE_NAME_BY_KEY[request.stageKey] ?? request.stageKey;
        const title = "公共节点入库审核｜" + stageName;
        const body = buildTaskNodeReviewMessage({ stageName, request, existingNodes, publicBaseUrl: baseUrl });
        for (const reviewerId of reviewerIds) {
          await appendOutboxIfAbsent(tx, {
            topic: "notify.message",
            dedupeKey: "task-node-request-review:" + request.id + ":" + reviewerId,
            payload: {
              recipientId: reviewerId,
              type: "approval",
              channel: "wecom_aibot",
              title,
              body,
              refType: "task_node_request",
              refId: request.id,
              templateCode: "TASK_NODE_REQUEST_REVIEW",
              mergeKey: "task-node-request:" + request.id,
            },
          });
          produced += 1;
        }
      }
      await this.settings.markDispatched(wall.date, tx);
      return { state: "dispatched" as const, produced };
    });
  }
}

/** 返回 null = 可以派发；非 null = 本次跳过原因。 */
function evaluateDispatchState(
  settings: Pick<TaskNodeReviewNotificationSettingsRow, "enabled" | "dailyTime" | "lastDispatchedOn">,
  date: string,
  time: string,
): Exclude<TaskNodeReviewNotificationDispatchState, "dispatched" | "no_reviewers"> | null {
  if (!settings.enabled) return "disabled";
  if (settings.lastDispatchedOn === date) return "already_dispatched";
  if (time < settings.dailyTime) return "not_due";
  return null;
}
