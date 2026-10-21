/**
 * 企微失败分类（M5-03-1 · S8-1；M5-03-2 群通道码表切换）：错误码 → 三分类
 * （permanent / retryable / rate_limited）+ token 特例（token_invalid）。
 *
 * 口径来源：docs/M5-03-实施方案(企微通道).md §五 失败模型（§五 5.3A 智能机器人实测码表 + 处置三分类）、
 *   shared/src/modules/notifications.ts NOTIFY_CHANNELS 描述。
 *
 * 处置对照（实现侧消费 · M5-03-2 / M5-03-3 接线）：
 *   permanent → dead + 降级（C5-04）+ 留痕 + 告警
 *   retryable → 退避重试（有界；到顶转 dead + 降级）
 *   rate_limited → 延期重排（排队下一窗口，**不消耗重试次数**）
 *   token_invalid → token 失效特例：客户端内失效重取一次；重取后仍失效 → 调用方按配置类处置
 *
 * 群通道（`wecom_group`）自 M5-03-2 起 = 智能机器人长连接（P5 定案 2026-10-12）—— webhook 面退役，
 * 93000 一类 webhook 码表同批移除（先例：ONLYOFFICE 承接后 LibreOffice 退役）。码表 = Spike 实测
 * 2026-10-10 ~ 10-13（含 T3-6 补测 · 见 §五 5.3A）+ 官方文档：
 *   853000（bot_id / secret 无效 · 订阅回执实测复现）/ 846601（未开长连接模式）→ permanent；
 *   93001（机器人被移出群 · T3-6 实测 2026-10-13 —— 群内不可见；重拉后恢复推送）→ permanent；
 *   846609（未订阅 —— 连接恢复后重试）→ retryable；
 *   846607 双语义（未激活 / 超频，errmsg 不可区分）—— 按调用方传入的 `groupActivated` 分流：
 *     false（会话未激活）→ permanent（不重试 + 降级 B4 + 留痕）；否则 → rate_limited（超频，延期重排）。
 * 单聊通道（`wecom_aibot`）自 M5-03-5-3 起 = 智能机器人长连接单发（chatid 填 userid + chat_type 1 · 帧形
 * 复核 + stub 锁帧见 wecom.aibot.ts）—— 与群共用长连接码表主体；846607 同一双语义，按调用方传入的
 * `dmActivated` 分流（false = 未命中激活表 → permanent —— 本地限速已前置挡量，未命中 + 846607 以未激活
 * 解释为主 · 计划 §3.5；命中 → rate_limited）。群专属码（93001 移出群）单聊不适用，按未收录兜底。
 * 未收录 errcode 一律 retryable 兜底（有界重试，不误杀）。
 */

export const WECOM_CHANNELS = ["wecom_app", "wecom_group", "wecom_aibot"] as const;
export type WecomChannel = (typeof WECOM_CHANNELS)[number];

export type WecomFailureKind = "permanent" | "retryable" | "rate_limited" | "token_invalid";

/** 自建应用：access_token 失效 / 缺失（41001 缺失、40014 非法、42001 过期）—— 客户端会失效重取一次。 */
export const WECOM_APP_TOKEN_ERRCODES: readonly number[] = [40014, 41001, 42001];

/** 自建应用错误码分类（初始集 · M5-03-4 实测锁定）。 */
const APP_ERRCODE_KINDS: ReadonlyMap<number, WecomFailureKind> = new Map<number, WecomFailureKind>([
  [40001, "permanent"], // invalid appsecret（配置 / 部署问题）
  [40013, "permanent"], // invalid corpid
  [40056, "permanent"], // invalid agentid
  [41002, "permanent"], // missing corpid
  [41004, "permanent"], // missing appsecret
  [60011, "permanent"], // userid 不存在 / 离职 / 未激活 / 不在可见范围（一类）
  [45002, "permanent"], // 消息内容超字节上限 / 大小非法（B5 产出侧裁剪为主，投递层兜底拒绝）
  [45009, "rate_limited"], // 接口频率超限（接口调用超过限制）
  [-1, "retryable"], // 系统繁忙
]);

/** 846607：未激活 / 超频双语义（errmsg 不可区分）—— 分流依赖调用方传入的会话激活态（群 / 单聊同码）。 */
export const WECOM_BOT_FREQ_ERRCODE = 846607;

/** 智能机器人（长连接）错误码分类主体：群 / 单聊共用（Spike 实测 2026-10-10 ~ 10-13；846607 在函数内按激活态分流）。 */
const AIBOT_ERRCODE_KINDS: ReadonlyMap<number, WecomFailureKind> = new Map<number, WecomFailureKind>([
  [853000, "permanent"], // bot_id / secret 无效（订阅回执实测复现；连接级，群 / 单聊同源）
  [846601, "permanent"], // 未开启长连接模式（配置 / 部署类）
  [846609, "retryable"], // 未订阅（连接恢复后重试）
]);

/** 群通道专属码：单聊不适用（未实测），出现时按未收录兜底 retryable（有界重试不误杀 —— P6 真机补测口径）。 */
const GROUP_ONLY_ERRCODE_KINDS: ReadonlyMap<number, WecomFailureKind> = new Map<number, WecomFailureKind>([
  [93001, "permanent"], // 机器人被移出群（T3-6 实测 2026-10-13 —— 重拉后恢复）
]);

const TOKEN_ERRCODE_SET = new Set<number>(WECOM_APP_TOKEN_ERRCODES);

/**
 * errcode → 分类；未收录一律 retryable 兜底（有界重试；到顶转 dead + 告警）。
 * 846607 双语义分流（群 = groupActivated / 单聊 = dmActivated）：false = 会话未激活（permanent）；
 * true / null（未知）→ 按超频（rate_limited）处置。
 */
export function classifyWecomErrcode(
  channel: WecomChannel,
  errcode: number,
  options: { groupActivated?: boolean | null; dmActivated?: boolean | null } = {},
): WecomFailureKind {
  if (channel === "wecom_app") {
    if (TOKEN_ERRCODE_SET.has(errcode)) {
      return "token_invalid";
    }
    return APP_ERRCODE_KINDS.get(errcode) ?? "retryable";
  }
  if (errcode === WECOM_BOT_FREQ_ERRCODE) {
    const activated = channel === "wecom_aibot" ? options.dmActivated : options.groupActivated;
    return activated === false ? "permanent" : "rate_limited";
  }
  if (channel === "wecom_group") {
    return GROUP_ONLY_ERRCODE_KINDS.get(errcode) ?? AIBOT_ERRCODE_KINDS.get(errcode) ?? "retryable";
  }
  return AIBOT_ERRCODE_KINDS.get(errcode) ?? "retryable";
}

/** HTTP 状态 → 分类（无合法 JSON 包体时的兜底；HTTP 面仅剩自建应用 —— 智能机器人走长连接帧）：429 / 5xx / 408 可恢复；其余 4xx 视为网关 / 配置类确定性失败。 */
export function classifyWecomHttpStatus(status: number): WecomFailureKind {
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 408 || status >= 500) {
    return "retryable";
  }
  if (status >= 400) {
    return "permanent";
  }
  return "retryable";
}

/**
 * errcode → 白话标签（告警 / 留痕文案）：只收录码表中语义唯一的高频码；未收录返回 null
 * （调用方回退 errmsg 概要 —— 见 describeWecomFailure）。
 */
const ERRCODE_LABELS: ReadonlyMap<number, string> = new Map<number, string>([
  // 自建应用
  [40001, "appsecret 无效"],
  [40013, "corpid 无效"],
  [40056, "agentid 无效"],
  [41002, "缺少 corpid"],
  [41004, "缺少 appsecret"],
  [45002, "消息内容超长"],
  [45009, "接口频率超限"],
  [60011, "userid 不存在或不可见"],
  [-1, "系统繁忙"],
  // 智能机器人（群通道）
  [853000, "机器人凭据无效（bot_id / secret）"],
  [846601, "未开启长连接模式"],
  [846607, "会话未激活或发送超频"],
  [846609, "长连接未订阅"],
  [93001, "机器人已被移出群"],
]);

export function wecomErrcodeLabel(errcode: number): string | null {
  return ERRCODE_LABELS.get(errcode) ?? null;
}

/**
 * errmsg 概要（告警 / 留痕文案）：收敛企微机器尾巴 —— `xx, hint: [..], from ip: .., more info at <url>` 只留 `xx`；
 * 并去内部连接态标记（`（state=…）`）。
 */
export function summarizeWecomErrmsg(errmsg: string): string {
  const tail = errmsg.search(/,\s*(?:hint:|from ip:|more info at\b)/i);
  return (tail === -1 ? errmsg : errmsg.slice(0, tail))
    .replace(/（state=(?:stopped|connecting|subscribed|backoff)）/g, "")
    .trim();
}

/** 失败描述尾串（errcode + 白话标签 / errmsg 概要）：群 / 应用通道共用 —— 告警群文案核心语义口径（2026-10-13）。 */
export function describeWecomFailure(errcode: number | null, errmsg: string | null): string {
  const reason = errmsg === null || errmsg.trim() === "" ? null : summarizeWecomErrmsg(errmsg);
  if (errcode === null) {
    return reason === null || reason === "" ? "" : "：" + reason;
  }
  const label = wecomErrcodeLabel(errcode) ?? reason;
  return "（errcode=" + String(errcode) + (label === null || label === "" ? "" : "：" + label) + "）";
}

/** 网络异常（超时 / 连接失败 / DNS / 中断）→ 统一 retryable；描述文本过掩码（key / secret / access_token 不回显）。 */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const masked = error.message.replace(/(key|secret|access_token)=[^&\s]+/gi, "$1=***");
    return masked === "" ? error.name : error.name + ": " + masked;
  }
  return "unknown error";
}
