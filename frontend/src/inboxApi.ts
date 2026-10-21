/**
 * 站内信读面客户端（C5 · 消息中心）：GET /api/v1/notifications、PATCH /api/v1/notifications/{id}、
 * POST /api/v1/notifications/mark-all-read。
 *
 * 契约 = shared/src/modules/notifications.ts（S7-4 / M5-04 · lan 线；服务端已落：收件箱三态 / 未读角标 /
 * 全量留档 / 合并条数）。本轮只接顶栏弹窗需要的最小面 —— 列表（id 降序 = 新在前）+ 标记已读 + 全部已读；
 * 稍后提醒（snooze）、通知偏好（prefs）与筛选分类留给消息中心整页（M5-07），此处不建。
 */
import { apiRequest, apiSend } from "./api";

/** 通知类型（C5-02 分类）：reminder 提醒 / approval 审批 / broadcast 播报 / system 系统。 */
export type InboxNotificationType = "reminder" | "approval" | "broadcast" | "system";

/** 收件箱状态（C5-01）：unread 未读 / read 已读 / handled 已处理。 */
export type InboxNotificationStatus = "unread" | "read" | "handled";

/** 收件箱条目（Notification 契约同形；mergedCount = 本行合并的消息条数，≥ 1）。 */
export type InboxNotification = {
  id: number;
  type: InboxNotificationType;
  title: string;
  body: string;
  status: InboxNotificationStatus;
  refType: string | null;
  refId: string | null;
  templateCode: string | null;
  mergedCount: number;
  snoozeUntil: string | null;
  deliveredAt: string;
  createdAt: string;
};

/** 收件箱清单（NotificationListResponse 契约同形）：unreadCount = 未读总数（不受 status 过滤影响；角标口径）。 */
export type InboxPage = {
  items: InboxNotification[];
  page: number;
  limit: number;
  total: number;
  unreadCount: number;
};

/** 收件箱清单（id 降序 = 新消息在前）。limit = 弹窗需要的条数（未读角标计数随行回读）。 */
export function loadInboxPage(limit: number): Promise<InboxPage> {
  return apiRequest<InboxPage>("/api/v1/notifications?limit=" + String(limit));
}

/** 标记单条为已读（幂等；他人 / 合并子行 / 未投递行服务端统一 404）。 */
export function markInboxRead(id: number): Promise<InboxNotification> {
  return apiSend<InboxNotification>("/api/v1/notifications/" + String(id), "PATCH", { status: "read" });
}

/** 全部标记已读（幂等）：返回本次置位条数与置位后的未读数（恒 0；回读口径）。 */
export function markAllInboxRead(): Promise<{ updated: number; unreadCount: number }> {
  return apiSend<{ updated: number; unreadCount: number }>("/api/v1/notifications/mark-all-read", "POST");
}
