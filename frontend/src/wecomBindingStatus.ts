import { useSyncExternalStore } from "react";

/**
 * 顶栏站内信提示用的企微单聊绑定态（模块级 store）。
 *
 * 登录后读一次；bindingApi 的读态 / 绑定 / 解绑响应都会覆盖这里，保证顶栏红点
 * 随服务端状态即时消失或恢复。null = 尚未读到（失败静默，不亮绑定红点）。
 */
let bound: boolean | null = null;
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

function getWecomBindingBound(): boolean | null {
  return bound;
}

/** 绑定态读面 / 写面落位（同值不触发重渲染）。 */
export function applyWecomBindingBound(next: boolean): void {
  if (bound === next) {
    return;
  }
  bound = next;
  emit();
}

/** 退出登录清空本会话状态，避免共用设备时把上一位用户的绑定态带给下一位。 */
export function resetWecomBindingStatus(): void {
  if (bound === null) {
    return;
  }
  bound = null;
  emit();
}

/** 订阅企微绑定态：false 时顶栏站内信显示无数字红点。 */
export function useWecomBindingBound(): boolean | null {
  return useSyncExternalStore(subscribe, getWecomBindingBound);
}
