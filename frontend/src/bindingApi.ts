/**
 * 企业微信单聊绑定客户端（M5-03-5-6 契约刀三端点 · Push 250 前端接线）。
 *
 * 契约 = shared/src/modules/notifications.ts 末段「企业微信单聊绑定」（Push 249 · lan 线 · wmj 复核）：
 *   GET    /api/v1/wecom-dm-binding        绑定态（恒 200；未绑定 = bound:false + 两个 null；v1.8 另回
 *                                          bindingCode / retryAt —— 刷新页面不丢码面与罚时）
 *   POST   /api/v1/wecom-dm-binding/codes  取绑定码（6 位 / TTL 5 分钟 / 一次性 / 5 次每 3 分钟 —— D3 修订 v1.8）
 *   DELETE /api/v1/wecom-dm-binding        解绑（幂等 —— 本就未绑定也 200 bound:false；返回同 GET 读面）
 *
 * 权限 = 个人资源：读 = 会话，写 = 会话 + CSRF（apiFetch 自动补 X-CSRF-Token），**不依赖功能权限键**
 * （同收件箱 / 通知偏好先例）；安全（口径 §9）：界面只展示掩码（末 4 位），前端不缓存 / 不落日志企微标识。
 */
import { ApiError, apiRequest, apiSend } from "./api";

/** 绑定态（`WecomDmBindingState` 契约同形）：掩码与绑定时刻只在已绑定时有值；v1.8 另带读面回填。 */
export type WecomDmBindingState = {
  bound: boolean;
  /** 密文 open_userid 掩码（形如 `****bmUw`）；未绑定 = null。 */
  wecomUseridMasked: string | null;
  /** 绑定时刻（ISO 8601 UTC）；未绑定 = null。 */
  boundAt: string | null;
  /** 当前仍未失效的绑定码（v1.8 读面回填）：刷新 / 重进页面后据此恢复码面与倒计时；无未用码 = null。 */
  bindingCode: WecomDmBindingCode | null;
  /** 取码限流可重试时刻（v1.8 读面回填，ISO 8601 UTC）：刷新后据此恢复罚时倒计时；未到顶 = null。 */
  retryAt: string | null;
};

/** 绑定码（`WecomDmBindingCode` 契约同形）：`expiresInSeconds` 直接用于倒计时（不必前端算时差）。 */
export type WecomDmBindingCode = {
  code: string;
  /** 失效时刻（ISO 8601 UTC）。 */
  expiresAt: string;
  /** 剩余有效秒数（服务端算好，前端据此倒计时）。 */
  expiresInSeconds: number;
};

/** 读绑定态（设置页 / 首登引导弹窗 / 站内信未绑定提示共用同一读面）。 */
export function loadWecomDmBinding(): Promise<WecomDmBindingState> {
  return apiRequest<WecomDmBindingState>("/api/v1/wecom-dm-binding");
}

/** 取绑定码：重复取码会作废上一条未用码 —— 前端一律以最新响应为准；频率到顶 = 429 `RATE_LIMITED`。 */
export function requestWecomDmBindingCode(): Promise<WecomDmBindingCode> {
  return apiSend<WecomDmBindingCode>("/api/v1/wecom-dm-binding/codes", "POST");
}

/** 解绑（幂等）：成功回未绑定态；服务端同事务写审计（对象类型「用户」/ 动作「删除」，只带掩码）。 */
export function unbindWecomDm(): Promise<WecomDmBindingState> {
  return apiSend<WecomDmBindingState>("/api/v1/wecom-dm-binding", "DELETE");
}

/** 429 限流的可重试时刻（`details[].meta.retryAt`，ISO）；非限流 / 解析不出 = null。 */
export function rateLimitedRetryAt(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "RATE_LIMITED") {
    return null;
  }
  const meta = error.details[0]?.meta;
  const value = meta === undefined ? undefined : meta.retryAt;
  return typeof value === "string" ? value : null;
}
