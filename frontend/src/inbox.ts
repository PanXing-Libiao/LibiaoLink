import { useSyncExternalStore } from "react";
import { loadInboxPage } from "./inboxApi";

/**
 * 站内信未读角标（顶栏「站内信」红点）模块级 store（Push 352 · 业务口径 2026-10-16「在这个左侧增加站内信
 * 按钮 点击后出现局部弹窗用来消息通知」）。
 *
 * 数值来源 = 服务端未读总数：登录后 / SSE 重连 open / 弹窗打开时按读面补拉（GET /notifications.unreadCount），
 * SSE unread 事件到达即覆盖（新投递 / 标记已读 / 全部已读 / 稍后提醒置读的快照 —— 跨端同一口径，
 * 服务端「重连不补发」由读面补拉对齐）。revision 只在 notification 事件（新投递 / 稍后提醒触发）推进：
 * 打开着的弹窗据此静默补拉列表，不直接消费事件载荷拼装业务数据（与全局静默同步口径一致）。
 * 顶栏每页都渲染 —— 挂模块级 store，切页不丢角标。
 */
export type InboxBadge = { unreadCount: number; revision: number };

let badge: InboxBadge = { unreadCount: 0, revision: 0 };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

export function getInboxBadge(): InboxBadge {
  return badge;
}

/** SSE unread 快照 / 读面回读落位（同值不触发重渲染；非法值收敛为 0）。 */
export function applyInboxUnread(unreadCount: number): void {
  const next = Number.isInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0;
  if (next === badge.unreadCount) {
    return;
  }
  badge = { ...badge, unreadCount: next };
  emit();
}

/** SSE notification 事件：只推进版本号（角标数值由 unread 事件给；打开着的弹窗据此补拉列表）。 */
export function noteInboxNotification(): void {
  badge = { ...badge, revision: badge.revision + 1 };
  emit();
}

/** 读面补拉角标（登录后 / SSE 重连 open / 弹窗打开）：失败静默保持现值（401 已由 apiRequest 统一跳登录）。 */
export async function refreshInboxUnread(): Promise<void> {
  try {
    const page = await loadInboxPage(1);
    applyInboxUnread(page.unreadCount);
  } catch {
    // 后端不可达 / 混布窗口：红点保持现值，下一次 SSE 事件或打开弹窗再对齐
  }
}

/** 订阅未读角标（顶栏红点与弹窗标题共用同一快照）。 */
export function useInboxBadge(): InboxBadge {
  return useSyncExternalStore(subscribe, getInboxBadge);
}
