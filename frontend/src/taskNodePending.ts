import { useSyncExternalStore } from "react";
import { listTaskNodeRequests } from "./templateApi";

/**
 * 「任务模板」导航红点（PM 反馈 2026-11-13「任务模板 这里加红点提醒吧」）模块级 store。
 *
 * 显示条件 = 该账号有「入库审核」待处理事项（非数字红点，不显示条数）：
 * - 有节点库维护权（permissions.taskNodeManage）= 全局待审 > 0 —— GET /api/v1/task-node-requests（审核人视角，缺省不带 mine）；
 * - 其他账号 = 本人 pending 申请 > 0 —— GET /api/v1/task-node-requests?mine=true。
 * 两种视角都读响应里的 pendingCount（stage / status 不传 = 全部阶段、全部状态；服务端 pendingCount 恒为待审条数）。
 *
 * 形态照 ./inbox、./permissions：模块级快照 + 订阅（顶栏每页都渲染，切页不丢红点）。
 * 失效时机由调用方控制：App.tsx 在登录后 / 路由变化 / 60 秒兜底各刷新一次；
 * 任务模板页审核通过 / 驳回 / 撤销成功后再刷一次（fe-review 接线）。
 * 失败与无权限一律静默置 false —— 红点只是入口提示，不打断页面，也不把 403 摆到界面上。
 */
export type TaskNodePendingBadge = {
  /** 是否有「入库审核」待处理事项（true = 亮红点）。 */
  pending: boolean;
};

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
 * 刷新「任务模板」红点：hasManageNodes = 当前账号有节点库维护权
 * （true = 审核人视角拿全局待审；false = 只拿本人待审）。
 */
export async function refreshTaskNodePending(hasManageNodes: boolean): Promise<void> {
  const seq = ++requestSeq;
  try {
    const list = hasManageNodes ? await listTaskNodeRequests() : await listTaskNodeRequests({ mine: true });
    if (seq === requestSeq) {
      applyTaskNodePending(list.pendingCount > 0);
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
