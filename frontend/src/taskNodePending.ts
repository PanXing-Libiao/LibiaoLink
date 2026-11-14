import { useSyncExternalStore } from "react";
import { listTaskNodeRequests, type TaskNodeRequest } from "./templateApi";

/**
 * 「任务模板」导航红点（PM 反馈 2026-11-13「任务模板 这里加红点提醒吧」）模块级 store。
 *
 * 显示条件 = 该账号有尚未查看的「入库审核」通知（非数字红点，不显示条数）：
 * - 有公共节点审核权（permissions.taskNodeReview）= 存在尚未查看的 pending 申请 —— GET /api/v1/task-node-requests（审核人视角，缺省不带 mine）；
 * - 其他账号 = 存在尚未查看的 pending 或 rejected 申请 —— GET /api/v1/task-node-requests?mine=true。
 * 点击进入「入库审核」后当前通知全部记为本机已读；只要没有新的申请 / 驳回，红点就不再因为待审仍然存在而重新亮。
 *
 * 形态照 ./inbox、./permissions：模块级快照 + 订阅（顶栏每页都渲染，切页不丢红点）。
 * 失效时机由调用方控制：App.tsx 在登录后 / 路由变化 / 60 秒兜底各刷新一次；
 * 任务模板页审核通过 / 驳回 / 撤销成功后再刷一次（fe-review 接线）。
 * 失败与无权限一律静默置 false —— 红点只是入口提示，不打断页面，也不把 403 摆到界面上。
 */
export type TaskNodePendingBadge = {
  /** 是否有未被点击看过的新入库审核通知（true = 亮红点）。 */
  pending: boolean;
};

/** 已查看的申请通知 key（本地读面）：服务端没有“已读”字段，点击入库审核后按 key 记住。 */
const NOTIFICATION_SEEN_STORAGE_KEY = "libiaolink.task-node-notifications-seen.v1";
const NOTIFICATION_SEEN_LIMIT = 200;
let notificationSeenCache: Set<string> | null = null;

function storage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSeenNotifications(): Set<string> {
  if (notificationSeenCache !== null) {
    return notificationSeenCache;
  }
  const seen = new Set<string>();
  try {
    const raw = storage()?.getItem(NOTIFICATION_SEEN_STORAGE_KEY) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((value) => {
        if (typeof value === "string" && value !== "") {
          seen.add(value);
        }
      });
    }
  } catch {
    // localStorage 不可用 / 内容损坏：本会话仍靠模块级缓存记住已读，不阻塞页面。
  }
  notificationSeenCache = seen;
  return seen;
}

function persistSeenNotifications(seen: Set<string>): void {
  try {
    storage()?.setItem(
      NOTIFICATION_SEEN_STORAGE_KEY,
      JSON.stringify(Array.from(seen).slice(-NOTIFICATION_SEEN_LIMIT)),
    );
  } catch {
    // 隐私模式 / 配额满：本会话内仍有效，下次刷新最多重复亮一次通知提醒。
  }
}

/** 当前申请对应的通知 key：审核人只关心 pending；申请人关心 pending 与 rejected。 */
export function taskNodeNotificationKeys(
  requests: readonly TaskNodeRequest[],
  hasReviewAccess: boolean,
): string[] {
  return requests.flatMap((request) => {
    if (request.status === "pending") {
      return [(hasReviewAccess ? "review:pending:" : "mine:pending:") + request.id];
    }
    if (!hasReviewAccess && request.status === "rejected") {
      return [
        "mine:rejected:" + request.id + ":" + (request.reviewedAt ?? request.updatedAt),
      ];
    }
    return [];
  });
}

/** 把当前页已看到的申请通知记为已读；返回是否有新增。 */
export function markTaskNodeNotificationsSeen(keys: readonly string[]): boolean {
  const seen = readSeenNotifications();
  let changed = false;
  keys.forEach((key) => {
    if (key !== "" && !seen.has(key)) {
      seen.add(key);
      changed = true;
    }
  });
  if (changed) {
    persistSeenNotifications(seen);
  }
  return changed;
}

let badge: TaskNodePendingBadge = { pending: false };
const listeners = new Set<() => void>();
/** 请求序号：并发刷新只认最后一次结果（登录瞬间「本人视角 → 审核人视角」两次刷新不会互相覆盖）。 */
let requestSeq = 0;

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

export function getTaskNodePendingBadge(): TaskNodePendingBadge {
  return badge;
}

/** 落位红点状态（同值不触发重渲染）。 */
function applyTaskNodePending(pending: boolean): void {
  if (pending === badge.pending) {
    return;
  }
  badge = { pending };
  emit();
}

/**
 * 刷新「任务模板」红点：hasReviewAccess = 当前账号有公共节点审核权
 * （true = 审核人视角看新 pending；false = 本人视角看未读 pending / rejected）。
 */
export async function refreshTaskNodePending(hasReviewAccess: boolean): Promise<void> {
  const seq = ++requestSeq;
  try {
    const list = hasReviewAccess ? await listTaskNodeRequests() : await listTaskNodeRequests({ mine: true });
    if (seq === requestSeq) {
      const seen = readSeenNotifications();
      const unseen = taskNodeNotificationKeys(list.items, hasReviewAccess).some(
        (key) => !seen.has(key),
      );
      applyTaskNodePending(unseen);
    }
  } catch {
    // 网络异常 / 无权限（403）：当作「没有待处理」，下一次刷新再对齐
    if (seq === requestSeq) {
      applyTaskNodePending(false);
    }
  }
}

/** 订阅「任务模板」红点（顶栏 TopNav 的「任务模板」项据此渲染 data-nav-templates-dot）。 */
export function useTaskNodePendingBadge(): boolean {
  return useSyncExternalStore(subscribe, getTaskNodePendingBadge).pending;
}
