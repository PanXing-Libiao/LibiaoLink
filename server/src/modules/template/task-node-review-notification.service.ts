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
  | "immediate"
  | "not_due"
  | "already_dispatched"
  | "no_reviewers"
  | "dispatched";

export interface TaskNodeReviewNotificationDispatchResult {
  state: TaskNodeReviewNotificationDispatchState;
  produced: number;
}

type ReviewerScheduleState = Exclude<
  TaskNodeReviewNotificationDispatchState,
  "dispatched" | "no_reviewers"
>;

function toContract(row: TaskNodeReviewNotificationSettingsRow): TaskNodeReviewNotificationSettings {
  return {
    enabled: row.enabled,
    notificationMode: row.notificationMode,
    dailyTime: row.dailyTime,
  };
}

function settingsSnapshot(row: TaskNodeReviewNotificationSettingsRow): Record<string, unknown> {
  return {
    enabled: row.enabled,
    notificationMode: row.notificationMode,
    dailyTime: row.dailyTime,
  };
}

function settingsLabel(row: TaskNodeReviewNotificationSettingsRow): string {
  if (!row.enabled) return "关闭";
  if (row.notificationMode === "immediate") return "开启 · 及时通知";
  return "开启 · 固定时间 " + row.dailyTime + "（北京时间）";
}

/**
 * 公共节点审核企微通知（0100 · 2026-11-15）：
 * - 每位公共节点审核管理员各自保存开关、通知方式（及时 / 固定时间）与固定时间（Asia/Shanghai）；
 * - 及时 = 新申请随导入事务即时写通知；固定时间 = worker 每分钟逐人判断，到本人时刻才派发 pending；
 * - last_dispatched_on 按审核人独立，同一审核人同一上海业务日只跑一次；
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

  /** GET /api/v1/task-node-requests/notification-settings：只读当前审核人自己的设置。 */
  async getSettings(actorId: string): Promise<TaskNodeReviewNotificationSettings> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "查看公共节点审核通知设置需要已授权的管理员权限");
    return toContract(await this.settings.getSettings(actorId));
  }

  /** PUT /api/v1/task-node-requests/notification-settings（整份保存；只影响当前审核人）。 */
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
      const before = await this.settings.lockSettings(actorId, tx);
      const saved = await this.settings.updateSettings(
        actorId,
        {
          enabled: body.enabled,
          notificationMode: body.notificationMode,
          dailyTime: body.dailyTime,
        },
        actorId,
        at,
        tx,
      );
      const changes = diffRecords(settingsSnapshot(before), settingsSnapshot(saved));
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node_review_notification_settings",
        objectId: actorId,
        summary: "更新本人公共节点审核企微通知：" + settingsLabel(saved),
        changes: changes.length > 0 ? changes : null,
        metadata: {},
      });
      return toContract(saved);
    });
  }

  /**
   * worker 每分钟调用：只处理选择固定时间且到点的审核人。
   * 先无锁批量预读，非到点时不写事务；真正派发前按 reviewer_id 顺序锁行复核，保证多实例不重复。
   */
  async flushScheduledNotifications(now: Date = this.clock.now()): Promise<TaskNodeReviewNotificationDispatchResult> {
    const wall = shanghaiWallClockOf(now);
    const reviewerIds = await this.permission.listEffectiveTaskNodeReviewers();
    if (reviewerIds.length === 0) {
      return { state: "no_reviewers", produced: 0 };
    }
    const orderedIds = [...reviewerIds].sort();
    const previewRows = await this.settings.listSettings(orderedIds);
    const previewStates = previewRows.map((row) => evaluateReviewerSchedule(row, wall.date, wall.time));
    const dueIds = previewRows
      .filter((_row, index) => previewStates[index] === null)
      .map((row) => row.reviewerId);
    if (dueIds.length === 0) {
      return { state: summarizeStates(previewStates.filter((state): state is ReviewerScheduleState => state !== null)), produced: 0 };
    }
    return await this.database.db.transaction(async (tx) => {
      const dueRows: TaskNodeReviewNotificationSettingsRow[] = [];
      const racedStates: ReviewerScheduleState[] = [];
      for (const reviewerId of dueIds) {
        const locked = await this.settings.lockSettings(reviewerId, tx);
        const state = evaluateReviewerSchedule(locked, wall.date, wall.time);
        if (state === null) dueRows.push(locked);
        else racedStates.push(state);
      }
      if (dueRows.length === 0) {
        return { state: summarizeStates(racedStates), produced: 0 };
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
        for (const reviewer of dueRows) {
          await appendOutboxIfAbsent(tx, {
            topic: "notify.message",
            dedupeKey: "task-node-request-review:" + request.id + ":" + reviewer.reviewerId,
            payload: {
              recipientId: reviewer.reviewerId,
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
      for (const reviewer of dueRows) {
        await this.settings.markDispatched(reviewer.reviewerId, wall.date, tx);
      }
      return { state: "dispatched" as const, produced };
    });
  }
}

/** 返回 null = 固定时间到点且可派发；非 null = 该审核人本次跳过原因。 */
function evaluateReviewerSchedule(
  settings: Pick<TaskNodeReviewNotificationSettingsRow, "enabled" | "notificationMode" | "dailyTime" | "lastDispatchedOn">,
  date: string,
  time: string,
): ReviewerScheduleState | null {
  if (!settings.enabled) return "disabled";
  if (settings.notificationMode === "immediate") return "immediate";
  if (settings.lastDispatchedOn === date) return "already_dispatched";
  if (time < settings.dailyTime) return "not_due";
  return null;
}

function summarizeStates(states: readonly ReviewerScheduleState[]): TaskNodeReviewNotificationDispatchState {
  if (states.length === 0) return "no_reviewers";
  if (states.some((state) => state === "not_due")) return "not_due";
  if (states.some((state) => state === "already_dispatched")) return "already_dispatched";
  if (states.some((state) => state === "immediate")) return "immediate";
  return "disabled";
}
