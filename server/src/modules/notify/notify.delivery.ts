/**
 * 通知投递规则（S7-4 · j1 / M5-04 首刀）：纯函数 —— 不连库、不取系统时间（ClockService 注入），
 * 可单测 / 可回放（技术设计v0.3 §4.7）。
 *
 * 口径来源：系统功能书 C2-09（同期消息合并推送 / 免打扰时段静默次日补发 / 每人每日上限）、
 *   技术设计v0.2 §6.2「合并与免打扰」；ADR-028（业务日固定 Asia/Shanghai，UTC+8 无夏令时）。
 *
 * 三种落点（消费与 flush 共用同一决策）：
 *   ① 立即投递：不在免打扰、未到每日上限；
 *   ② 免打扰 → 静默到时段结束（跨零点即「次日补发」）；
 *   ③ 每日上限溢出 → 排到次日投递窗口起点（NOTIFY_DAILY_WINDOW_START_MINUTE，缺省 08:00；若该刻仍在免打扰再顺延到时段结束）。
 */
import { NotifyMessagePayloadSchema, type NotifyMessagePayload } from "@libiaolink/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Asia/Shanghai 固定偏移（ADR-028：无夏令时，偏移恒为 +8）。 */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 免打扰时段（当日分钟表示；跨零点时 toMinute < fromMinute，命中口径 `[from, to)`）。 */
export interface QuietHours {
  fromMinute: number;
  toMinute: number;
}

/** `HH:MM` → 当日分钟（0 ~ 1439）；非法返回 null。 */
export function parseClockMinute(raw: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(raw);
  if (match === null) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 当日分钟 → `HH:MM`（0 ~ 1439）。 */
export function formatClockMinute(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

/** `HH:MM-HH:MM` → QuietHours；空串 / 非法 / 起止相同 → null（null = 免打扰关闭）。 */
export function parseQuietHours(raw: string): QuietHours | null {
  if (raw === "") {
    return null;
  }
  const parts = raw.split("-");
  if (parts.length !== 2) {
    return null;
  }
  const fromRaw = parts[0];
  const toRaw = parts[1];
  if (fromRaw === undefined || toRaw === undefined) {
    return null;
  }
  const fromMinute = parseClockMinute(fromRaw);
  const toMinute = parseClockMinute(toRaw);
  if (fromMinute === null || toMinute === null || fromMinute === toMinute) {
    return null;
  }
  return { fromMinute, toMinute };
}

/** Asia/Shanghai 当日已过分钟数（0 ~ 1439）。 */
export function shanghaiMinuteOfDay(now: Date): number {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Asia/Shanghai 业务日起点（当日 00:00 的 UTC 时刻）—— 每人每日上限的统计窗口。 */
export function shanghaiDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS,
  );
}

/** 是否落在免打扰时段（`[from, to)`；跨零点 = `m >= from || m < to`）。 */
export function isWithinQuiet(minuteOfDay: number, quiet: QuietHours): boolean {
  return quiet.fromMinute < quiet.toMinute
    ? minuteOfDay >= quiet.fromMinute && minuteOfDay < quiet.toMinute
    : minuteOfDay >= quiet.fromMinute || minuteOfDay < quiet.toMinute;
}

/** 免打扰结束时刻：严格晚于 now 的下一个 `to` 时刻（跨零点即次日 = C2-09「次日补发」）。 */
export function quietEndAfter(now: Date, quiet: QuietHours): Date {
  const candidate = new Date(shanghaiDayStart(now).getTime() + quiet.toMinute * MINUTE_MS);
  return candidate.getTime() > now.getTime() ? candidate : new Date(candidate.getTime() + DAY_MS);
}

/** 次日投递窗口起点（严格晚于 now）：每日上限溢出的落点（Asia/Shanghai 次日 `minuteOfDay` 时刻）。 */
export function nextDayWindowStart(now: Date, minuteOfDay: number): Date {
  return new Date(shanghaiDayStart(now).getTime() + DAY_MS + minuteOfDay * MINUTE_MS);
}

/**
 * 合并键（同人 + 同键 + 合并窗口内 = 合并为一条）：显式 `mergeKey` → `templateCode` → `type:refType:refId` 逐级回退。
 * 生产端要「同期合并」的系列消息（A01 多项目提醒等）应显式给 mergeKey；都给不出时按类型 + 关联对象收敛，避免全类型乱合并。
 */
export function mergeKeyOf(message: NotifyMessagePayload): string {
  const explicit = message.mergeKey?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const template = message.templateCode?.trim();
  if (template !== undefined && template !== "") {
    return template;
  }
  return message.type + ":" + (message.refType ?? "-") + ":" + (message.refId ?? "-");
}

/**
 * 载荷解析：契约校验 + 空白归一（title / body trim，nullish 归一为 null）。
 * 非法载荷 → null —— 消费侧转 outbox `dead`（确定性失败一次即弃，先例 preview.job；重试不会变合法）。
 */
export function parseNotifyMessage(raw: Record<string, unknown>): NotifyMessagePayload | null {
  const parsed = NotifyMessagePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.data;
  const trimOrNull = (text: string | null | undefined): string | null => {
    if (text === null || text === undefined) {
      return null;
    }
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed;
  };
  return {
    recipientId: value.recipientId,
    type: value.type,
    title: value.title.trim(),
    body: value.body.trim(),
    refType: trimOrNull(value.refType),
    refId: value.refId ?? null,
    templateCode: trimOrNull(value.templateCode),
    mergeKey: trimOrNull(value.mergeKey),
    channel: value.channel ?? "inbox",
  };
}

/**
 * 已落地渠道（M5-03-3 起 + M5-03-5-4 接线段）：站内信 `inbox` + 企微应用消息 `wecom_app` + 企微单聊智能机器人
 * `wecom_aibot`（notify.message 主题三个分支；wecom_app → NotifyAppService、wecom_aibot → NotifyDmService ——
 * OutboxModule 按载荷 channel 路由）。未落地渠道（email 等）在接线层跳过（自动化的非落地渠道防护）+ 投递层兜底按
 * **确定性失败**收口（consume → dead + 告警），不得静默当站内信投递 —— wmj PR #197 提请的接线段护栏。
 * 群播报走独立主题 `notify.group`，不在此表。
 */
export const DELIVERABLE_CHANNELS: readonly string[] = ["inbox", "wecom_app", "wecom_aibot"];

/** 渠道是否可投递：非白名单 = 未落地通道，调用方按确定性失败收口（M5-03 起飞后扩表）。 */
export function isDeliverableChannel(channel: string): boolean {
  return DELIVERABLE_CHANNELS.includes(channel);
}

/** 载荷渠道读取（notify.message 路由用；缺省 inbox —— 与 parseNotifyMessage 同口径，不做其余字段校验）。 */
export function channelOfNotifyPayload(raw: Record<string, unknown>): string {
  const value = raw["channel"];
  return typeof value === "string" && value !== "" ? value : "inbox";
}

export interface DeliveryPlanInput {
  now: Date;
  /** 生效免打扰（null = 关闭）。 */
  quiet: QuietHours | null;
  /** 生效每人每日上限（0 = 不限）。 */
  dailyLimit: number;
  /** 当日（Asia/Shanghai）已投递主行数。 */
  deliveredToday: number;
  /** 次日投递窗口起点（分钟，Asia/Shanghai）。 */
  nextDayStartMinute: number;
}

/** 投递决策：立即投递，或静默到 `deliverAt`（原因：每日上限 / 免打扰）。 */
export type DeliveryDecision =
  | { deliver: true }
  | { deliver: false; deliverAt: Date; reason: "daily_limit" | "quiet_hours" };

/** 决策顺序：每日上限优先（溢出排到次日窗口），其次免打扰（静默到时段结束）；两者都不挡 = 立即投递。 */
export function planDelivery(input: DeliveryPlanInput): DeliveryDecision {
  if (input.dailyLimit > 0 && input.deliveredToday >= input.dailyLimit) {
    let deliverAt = nextDayWindowStart(input.now, input.nextDayStartMinute);
    if (input.quiet !== null && isWithinQuiet(shanghaiMinuteOfDay(deliverAt), input.quiet)) {
      deliverAt = quietEndAfter(deliverAt, input.quiet);
    }
    return { deliver: false, deliverAt, reason: "daily_limit" };
  }
  if (input.quiet !== null && isWithinQuiet(shanghaiMinuteOfDay(input.now), input.quiet)) {
    return { deliver: false, deliverAt: quietEndAfter(input.now, input.quiet), reason: "quiet_hours" };
  }
  return { deliver: true };
}
