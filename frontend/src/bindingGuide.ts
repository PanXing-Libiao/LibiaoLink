/**
 * 「绑定企业微信」首登引导弹窗的本机记忆（口径 §10 D5「用户首次登录系统时引导弹窗（**可跳过**）」）。
 *
 * 跳过 = 不再自动弹出（设置页仍可补绑）；记录按**登录账号 id** 分记，退出登录时清除
 * （多人共用设备的隔离手段，与 homePrefs 同一口径 —— 上一位用户的「跳过」不该影响下一位）。
 * 为什么不上云：跳过位是「本机是否还弹」的界面状态，落库要扩 `user_preferences.prefs` 契约（wmj 线）；
 * 本刀零契约改动，先本机记忆 —— 如需跨设备统一，另开一刀走偏好通道（已登记《前端功能需求》§3.10）。
 */
const STORAGE_KEY = "libiaolink.wecom.binding.guide.v1";

type StoredGuide = { v: 1; skipped: string[] };

/** 会话内兜底（隐私模式 / 存储受限时 write 失败，本次会话内仍不再弹）。 */
const memory = new Set<string>();

function read(): StoredGuide {
  const empty: StoredGuide = { v: 1, skipped: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return empty;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return empty;
    }
    const skipped = (parsed as { skipped?: unknown }).skipped;
    if (!Array.isArray(skipped)) {
      return empty;
    }
    return { v: 1, skipped: skipped.filter((item): item is string => typeof item === "string" && item !== "") };
  } catch {
    return empty;
  }
}

function write(next: StoredGuide): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储受限静默降级：会话内记忆照旧生效
  }
}

/** 该账号是否已跳过引导（跳过 / 已绑定后不再自动弹出）。 */
export function isBindingGuideSkipped(userId: string): boolean {
  return memory.has(userId) || read().skipped.includes(userId);
}

/** 记下「这个账号不再自动弹」（稍后再说 / 前往设置 都走这里）。 */
export function skipBindingGuide(userId: string): void {
  memory.add(userId);
  const current = read();
  if (!current.skipped.includes(userId)) {
    write({ v: 1, skipped: [...current.skipped, userId] });
  }
}

/** 退出登录清除（与 clearHomePrefs 同桌调用 —— 换人登录照常引导）。 */
export function clearBindingGuidePrefs(): void {
  memory.clear();
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存储受限：无事可清
  }
}
