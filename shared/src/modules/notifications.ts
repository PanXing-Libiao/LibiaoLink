import { z } from "../zod.ts";
import { NotifyChannelSchema, NotifyExternalChannelSchema } from "./automation.ts";
import { DateTimeSchema, PageQuerySchema, UuidSchema, paginated } from "../common/conventions.ts";

/**
 * 通知（站内信 · 消息中心）契约（S7-4 · j1 / M5-04 首刀 · lan）。
 *
 * 口径来源：系统功能书 C5-01 收件箱三态（未读 / 已读 / 已处理）、C5-02 分类与筛选（提醒 / 审批 / 播报 / 系统 +
 *   时间区间 + 已读状态）、C5-03 全量留档、C5-05 稍后提醒（「设置新提醒时间；设置与触发记录可查」）；
 *   C2-08 投递保障（幂等去重 / 失败重试 / 错过补发 / 死信告警）、
 *   C2-09 合并与免打扰（同期消息合并推送 / 免打扰时段静默次日补发 / 每人每日上限）；
 *   技术设计v0.2 §6.2「合并与免打扰」，§11.1 新增表 notifications / notify_prefs（技术设计v0.3 §3.6 同）、
 *   §11.3 `/notifications/stream`（SSE）；ADR-005（Outbox + PG 原生队列）、ADR-028（业务日固定 Asia/Shanghai）。
 *
 * 本切片边界（S7-4）：站内信投递（outbox 主题 `notify.message` 消费）+ 合并（同人同时段）+ 免打扰（次日补发）+
 *   每人每日上限 + 收件箱读面（列表 / 未读计数 / 标记已读·已处理 / 全部已读）+ 全量留档 + 个人通知偏好。
 * S8-3 扩项（M5-04 余项 · 代 wmj 落地 · Push 210）：SSE 实时推送事件契约 + 稍后提醒契约（见本文件末两段；
 *   端点注册见 `openapi.ts`；实现随 `M5-04-1` / `M5-04-2` · lan）。
 * 余下随后续卡片：企微通道（M5-03）/ 规则生产端（i12 / i13：写 `notify.message` 的主题生产者）——
 *   投递层就绪后加项即可。
 */

/** 通知类型（C5-02 分类筛选）：提醒 / 审批 / 播报 / 系统。 */
export const NOTIFICATION_TYPES = ["reminder", "approval", "broadcast", "system"] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES).openapi("NotificationType", {
  description:
    "通知类型（C5-02 分类）：reminder 提醒（任务 / 日报 / 问题等业务提醒）/ approval 审批（待办审批与门禁）/ broadcast 播报（喜报 / 阶段达成 / 摘要群发同步留档）/ system 系统（账号 / 权限 / 运维通知）",
});
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** 收件箱状态（C5-01）：未读 / 已读 / 已处理（三态单向回退允许：已处理可退回已读，标记幂等）。 */
export const NOTIFICATION_STATUSES = ["unread", "read", "handled"] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES).openapi("NotificationStatus", {
  description: "收件箱状态：unread 未读 / read 已读 / handled 已处理（标记接口幂等；允许回退到更早状态）",
});
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

/** 标题 / 正文 / 关联类型 / 合并键 / 模板码上限（与库侧 CHECK 同口径）。 */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
export const NOTIFICATION_BODY_MAX_LENGTH = 4000;
export const NOTIFICATION_REF_TYPE_MAX_LENGTH = 40;
export const NOTIFICATION_MERGE_KEY_MAX_LENGTH = 120;
export const NOTIFICATION_TEMPLATE_CODE_MAX_LENGTH = 60;
/** 每人每日上限的库侧 / 契约上限（0 = 不限）。 */
export const NOTIFICATION_DAILY_LIMIT_MAX = 1000;
/** 合并窗口上限（毫秒；0 = 不合并）—— 防止把「同期」拉成无限期合并。 */
export const NOTIFICATION_MERGE_WINDOW_MAX_MS = 24 * 60 * 60_000;

/** 非空文本（前后空白剔除后 1 ~ max 字）：载荷与请求体的标题 / 正文共用口径。 */
function nonBlankText(max: number, label: string) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: label + "剔除前后空白后不能为空" });
}

/**
 * `notify.message` 主题载荷（outbox 消费侧唯一输入；i12 / i13 规则生产端按本 schema 写入）。
 *
 * 生产端责任：按收件人口径逐位展开（一个收件人一条事件，recipientId 必填）、同事务 appendOutbox、
 *   dedupeKey 用「规则码:实体 id:窗口」（含状态版本再生窗口，见 outbox 契约）；
 * 消费端责任：载荷非法 → outbox dead（确定性失败，一次即弃，先例 preview.job）、标题 / 正文 trim 后落库。
 * 渠道（channel）：缺省 inbox = 站内信；M5-03 落地前投递层只支持 inbox —— 非 inbox 值按确定性失败收口（dead + 告警），
 *   不得静默当站内信投递（接线层护栏；M5-03 落地后由投递层分流）。
 * 合并键（mergeKey）：缺省按 `templateCode` → `type:refType:refId` 逐级回退（见投递层口径）；
 *   需要「同人同时段合并成一条」的系列消息（A01 多项目提醒等）应显式给 mergeKey。
 */
export const NotifyMessagePayloadSchema = z
  .object({
    recipientId: UuidSchema.openapi({ description: "收件人（用户 id；生产端已按收件人口径展开到人）" }),
    type: NotificationTypeSchema,
    channel: NotifyChannelSchema.optional().openapi({
      description: "投递渠道（复用 automation 的 NOTIFY_CHANNELS，与引擎 ReplayMessage.channel 同源；缺省 inbox = 站内信）。M5-03 落地前非 inbox 值由投递层按确定性失败收口（dead + 告警）",
    }),
    title: nonBlankText(NOTIFICATION_TITLE_MAX_LENGTH, "标题").openapi({ description: "标题（前后空白剔除后 1 ~ 200 字）" }),
    body: nonBlankText(NOTIFICATION_BODY_MAX_LENGTH, "正文").openapi({ description: "正文（前后空白剔除后 1 ~ 4000 字）" }),
    refType: z
      .string()
      .max(NOTIFICATION_REF_TYPE_MAX_LENGTH)
      .nullish()
      .openapi({ description: "关联对象类型（project / task / report / issue / file / node 等，与审计对象类型同词汇表；可空）" }),
    refId: UuidSchema.nullish().openapi({ description: "关联对象 id（与 refType 成对；可空）" }),
    templateCode: z
      .string()
      .max(NOTIFICATION_TEMPLATE_CODE_MAX_LENGTH)
      .nullish()
      .openapi({ description: "模板码（如 A01_INBOX_MERGED / R02_INBOX；排障与文案回溯用；可空）" }),
    mergeKey: z
      .string()
      .max(NOTIFICATION_MERGE_KEY_MAX_LENGTH)
      .nullish()
      .openapi({ description: "合并键（缺省按 templateCode → type:refType:refId 回退；显式给键 = 同人同时段只推一条）" }),
  })
  .superRefine((value, context) => {
    const hasRefType = value.refType !== null && value.refType !== undefined && value.refType !== "";
    const hasRefId = value.refId !== null && value.refId !== undefined;
    if (hasRefType !== hasRefId) {
      context.addIssue({
        code: "custom",
        message: "refType 与 refId 必须成对出现（库侧 CHECK ck_notifications_ref 同口径）",
        path: ["refId"],
      });
    }
  })
  .openapi("NotifyMessagePayload", {
    description: "站内信投递事件载荷（outbox 主题 notify.message）：收件人 + 渠道 + 类型 + 标题 / 正文 + 关联对象 + 合并键",
  });
export type NotifyMessagePayload = z.infer<typeof NotifyMessagePayloadSchema>;

/**
 * `notify.group` 主题载荷（群播报 · M5-03-2 · P5 定案）：outbox 独立主题 —— 收件人是**项目群**。
 *
 * 边界（S8-1 §三-1 A 案定案）：与 `NotifyMessagePayload` 不混用 —— 群播报无个人收件人（不进收件箱、
 *   无合并 / 免打扰 / 每日上限语义），逐条播报 + 按会话限速（30 条/分钟、1000 条/小时 · P5 定案）；
 *   投递层按 `projectId` 读当前群绑定解析 `chatid`（换绑后未投递消息仍可送出；未绑定 / 群未激活 =
 *   确定性失败留痕）。
 * 不进载荷：`chatid`（绑定态数据，投递时读库）、`mergeKey`（幂等由 outbox dedupeKey 承担）。
 */
export const NotifyGroupMessagePayloadSchema = z
  .object({
    projectId: UuidSchema.openapi({ description: "目标项目 id（投递时解析该项目当前群绑定；未绑定 = 确定性失败留痕）" }),
    title: nonBlankText(NOTIFICATION_TITLE_MAX_LENGTH, "标题")
      .nullable()
      .openapi({
        description:
          "标题（前后空白剔除后 1 ~ 200 字；null = 无标题，投递仅正文；个人消息不受影响）",
      }),
    body: nonBlankText(NOTIFICATION_BODY_MAX_LENGTH, "正文").openapi({
      description: "正文（前后空白剔除后 1 ~ 4000 字）；投递层按企微 markdown 字节上限截断 —— 尾部省略 + 截断留痕（B5 定案）",
    }),
    refType: z
      .string()
      .max(NOTIFICATION_REF_TYPE_MAX_LENGTH)
      .nullish()
      .openapi({ description: "关联对象类型（project / report / task 等，与审计对象类型同词汇表；可空）" }),
    refId: UuidSchema.nullish().openapi({ description: "关联对象 id（与 refType 成对；可空）" }),
    templateCode: z
      .string()
      .max(NOTIFICATION_TEMPLATE_CODE_MAX_LENGTH)
      .nullish()
      .openapi({ description: "模板码（R04_GROUP / R06_GROUP / A02_GROUP / A08_GROUP；排障与文案回溯用）" }),
  })
  .superRefine((value, context) => {
    const hasRefType = value.refType !== null && value.refType !== undefined && value.refType !== "";
    const hasRefId = value.refId !== null && value.refId !== undefined;
    if (hasRefType !== hasRefId) {
      context.addIssue({
        code: "custom",
        message: "refType 与 refId 必须成对出现",
        path: ["refId"],
      });
    }
  })
  .openapi("NotifyGroupMessagePayload", {
    description: "群播报投递事件载荷（outbox 主题 notify.group）：目标项目 + 标题 / 正文 + 关联对象 + 模板码；chatid 不进载荷（投递时读绑定）",
  });
export type NotifyGroupMessagePayload = z.infer<typeof NotifyGroupMessagePayloadSchema>;

/**
 * 消息级发送归档（M5-06-2A / C5-03 全量留档）：一条 outbox 消息一行；尝试明细单独存
 * `notify_deliveries`。`lastState = pending` 表示已归档但外部渠道尚未发起第一次尝试。
 */
export const NOTIFY_DELIVERY_TOPICS = ["notify.message", "notify.group"] as const;
export const NotifyDeliveryTopicSchema = z.enum(NOTIFY_DELIVERY_TOPICS).openapi("NotifyDeliveryTopic", {
  description: "发送归档来源主题：notify.message 个人消息 / notify.group 群播报",
});
export type NotifyDeliveryTopic = z.infer<typeof NotifyDeliveryTopicSchema>;

export const NOTIFY_DELIVERY_MESSAGE_STATES = ["pending", "sent", "failed", "deferred", "dead"] as const;
export const NotifyDeliveryMessageStateSchema = z.enum(NOTIFY_DELIVERY_MESSAGE_STATES).openapi("NotifyDeliveryMessageState", {
  description: "消息最新状态：pending 尚未尝试 / sent 已受理 / failed 可重试失败 / deferred 限速延期 / dead 死信",
});
export type NotifyDeliveryMessageState = z.infer<typeof NotifyDeliveryMessageStateSchema>;

export const NOTIFY_DELIVERY_ATTEMPT_STATES = ["sent", "failed", "deferred", "dead"] as const;
export const NotifyDeliveryAttemptStateSchema = z.enum(NOTIFY_DELIVERY_ATTEMPT_STATES).openapi("NotifyDeliveryAttemptState", {
  description: "单次投递尝试状态（pending 仅属于消息级，不落尝试表）",
});
export type NotifyDeliveryAttemptState = z.infer<typeof NotifyDeliveryAttemptStateSchema>;

/** 消息级发送记录读面（目标地址只回掩码；完整 target / payload 不入本 schema）。 */
export const NotifyDeliveryMessageSchema = z
  .object({
    id: z.number().int().positive().openapi({ description: "消息归档 id" }),
    sourceDedupeKey: z.string().min(1).max(256).openapi({ description: "来源 outbox 幂等键（归档幂等）" }),
    topic: NotifyDeliveryTopicSchema,
    channel: NotifyChannelSchema,
    recipientId: z.union([UuidSchema, z.null()]).openapi({ description: "站内信 / 个人企微收件人 id；群播报 = null" }),
    recipientLabel: z.string().nullable().openapi({ description: "收件人展示值或掩码目标；不得返回 Secret" }),
    title: z.string().nullable(),
    body: z.string().min(1),
    templateCode: z.string().nullable(),
    ruleCode: z.string().max(32).nullable().openapi({ description: "来源规则码；非规则消息 = null" }),
    refType: z.string().max(40).nullable(),
    refId: z.string().max(64).nullable(),
    resendOfMessageId: z.number().int().positive().nullable().openapi({ description: "重发消息指向的原消息 id；普通消息 = null" }),
    lastState: NotifyDeliveryMessageStateSchema,
    attemptCount: z.number().int().min(0),
    lastError: z.string().nullable().openapi({ description: "最近失败 / 延期原因（已掩码）" }),
    sentAt: z.union([DateTimeSchema, z.null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("NotifyDeliveryMessage", {
    description: "消息级发送归档（C2-07 / C5-03）：正文、渠道、掩码收件人、最新状态与尝试次数；独立于 outbox 清理",
  });
export type NotifyDeliveryMessage = z.infer<typeof NotifyDeliveryMessageSchema>;

/** 单次投递尝试（notify_deliveries）：target 只回掩码。 */
export const NotifyDeliveryAttemptSchema = z
  .object({
    id: z.number().int().positive(),
    messageId: z.number().int().positive(),
    channel: NotifyExternalChannelSchema,
    targetMasked: z.string().min(1).openapi({ description: "投递目标掩码（如 userid / chatid 末 4 位）" }),
    state: NotifyDeliveryAttemptStateSchema,
    attempts: z.number().int().min(0).openapi({ description: "该尝试序号；deferred = 计划尝试序号、未发起 HTTP" }),
    error: z.string().nullable().openapi({ description: "失败 / 延期原因（已掩码）" }),
    sentAt: z.union([DateTimeSchema, z.null()]).openapi({ description: "API 受理成功时刻；sent 以外 = null" }),
    createdAt: DateTimeSchema,
  })
  .openapi("NotifyDeliveryAttempt", { description: "发送尝试明细（每次外部投递尝试一行；目标只回掩码）" });
export type NotifyDeliveryAttempt = z.infer<typeof NotifyDeliveryAttemptSchema>;

export const NotifyDeliveryListQuerySchema = z
  .object({
    channel: NotifyChannelSchema.optional(),
    lastState: NotifyDeliveryMessageStateSchema.optional(),
    ruleCode: z.string().max(32).optional(),
    recipientId: UuidSchema.optional(),
    from: DateTimeSchema.optional().openapi({ description: "归档时刻下界（含）" }),
    to: DateTimeSchema.optional().openapi({ description: "归档时刻上界（含）" }),
    q: z.string().min(1).max(200).optional().openapi({ description: "标题或正文关键字" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
  })
  .openapi("NotifyDeliveryListQuery", {
    description: "发送记录查询（渠道 / 最新状态 / 规则 / 收件人 / 时间区间 / 关键字 + 分页）",
  });
export type NotifyDeliveryListQuery = z.infer<typeof NotifyDeliveryListQuerySchema>;

export const NotifyDeliveryListResponseSchema = paginated(NotifyDeliveryMessageSchema).openapi("NotifyDeliveryListResponse", {
  description: "消息级发送记录列表（createdAt desc, id desc）",
});
export type NotifyDeliveryListResponse = z.infer<typeof NotifyDeliveryListResponseSchema>;

export const NotifyDeliveryDetailSchema = NotifyDeliveryMessageSchema.extend({
  attempts: z.array(NotifyDeliveryAttemptSchema).openapi({ description: "全部投递尝试（含 deferred / failed / dead / sent）" }),
})
  .openapi("NotifyDeliveryDetail", { description: "发送记录详情：消息归档 + 全部尝试明细" });
export type NotifyDeliveryDetail = z.infer<typeof NotifyDeliveryDetailSchema>;

/** 重发请求为空对象；幂等键走 Idempotency-Key 请求头（D7）。 */
export const NotifyDeliveryResendBodySchema = z
  .object({})
  .strict()
  .openapi("NotifyDeliveryResendBody", { description: "重发请求（空对象；Idempotency-Key 必填，正文 / 收件人 / 渠道不可改写）" });
export type NotifyDeliveryResendBody = z.infer<typeof NotifyDeliveryResendBodySchema>;

export const NotifyDeliveryResendResponseSchema = z
  .object({
    message: NotifyDeliveryMessageSchema,
  })
  .openapi("NotifyDeliveryResendResponse", { description: "重发已受理：返回新建的消息归档（lastState = pending）" });
export type NotifyDeliveryResendResponse = z.infer<typeof NotifyDeliveryResendResponseSchema>;

/**
 * 收件箱条目（C5-01 / C5-03 全量留档）。
 * 只返回**已投递**的主行（合并子行仅在库内留档，不进收件箱）；`mergedCount` = 本行合并的消息条数（≥ 1）。
 */
export const NotificationSchema = z
  .object({
    id: z.number().int().positive().openapi({ description: "通知 id（库内自增；收件箱以 id 降序）" }),
    type: NotificationTypeSchema,
    title: z.string().openapi({ description: "标题（已剔除前后空白）" }),
    body: z.string().openapi({ description: "正文（已剔除前后空白；首条消息的正文，被合并行正文留档在库内）" }),
    status: NotificationStatusSchema,
    refType: z.string().nullable().openapi({ description: "关联对象类型（可空）" }),
    refId: UuidSchema.nullable().openapi({ description: "关联对象 id（可空；与 refType 成对）" }),
    templateCode: z.string().nullable().openapi({ description: "模板码（可空）" }),
    mergedCount: z.number().int().min(1).openapi({ description: "合并条数：同期同合并键的消息条数（未合并 = 1）" }),
    snoozeUntil: DateTimeSchema.nullable().openapi({
      description:
        "未触发的稍后提醒时刻（C5-05）；null = 未设置 / 已触发 / 已取消（触发不改写 deliveredAt —— 首投时刻留档，重提醒时刻见记录）",
    }),
    deliveredAt: DateTimeSchema.openapi({ description: "投递时刻（进入收件箱的时刻）" }),
    createdAt: DateTimeSchema.openapi({ description: "消息创建时刻（收到投递事件的时刻）" }),
  })
  .openapi("Notification", { description: "收件箱条目（已投递；合并子行不进收件箱、只在库内留档）" });
export type Notification = z.infer<typeof NotificationSchema>;

/** 收件箱查询：状态 / 类型 / 关联对象 + 时间区间 + 分页（id 降序 = 新消息在前）。 */
export const NotificationListQuerySchema = z
  .object({
    status: NotificationStatusSchema.optional().openapi({ description: "状态过滤（缺省 = 全部三态）" }),
    type: NotificationTypeSchema.optional().openapi({ description: "类型过滤（C5-02 分类；缺省 = 全部）" }),
    refType: z
      .string()
      .max(NOTIFICATION_REF_TYPE_MAX_LENGTH)
      .optional()
      .openapi({ description: "关联对象类型过滤（如 task / issue；缺省 = 全部）" }),
    from: DateTimeSchema.optional().openapi({ description: "投递时刻下界（含；缺省 = 不限）" }),
    to: DateTimeSchema.optional().openapi({ description: "投递时刻上界（含；缺省 = 不限）" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
  })
  .openapi("NotificationListQuery", {
    description: "收件箱查询：状态 / 类型 / 关联对象 + 投递时刻区间 + 分页（缺省 id 降序 = 新消息在前）",
  });
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationListResponseSchema = z
  .object({
    items: z.array(NotificationSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0).openapi({ description: "当前筛选下的总条数" }),
    unreadCount: z.number().int().min(0).openapi({ description: "未读总数（不受 status 过滤影响；角标口径）" }),
  })
  .openapi("NotificationListResponse", { description: "收件箱清单（含未读角标计数）" });
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

/** 标记状态（PATCH /notifications/{id}）：幂等；允许回退到更早状态。 */
export const NotificationMarkBodySchema = z
  .object({ status: NotificationStatusSchema })
  .openapi("NotificationMarkBody", { description: "标记收件箱状态（幂等；已处理可退回已读）" });
export type NotificationMarkBody = z.infer<typeof NotificationMarkBodySchema>;

export const NotificationMarkAllReadResponseSchema = z
  .object({
    updated: z.number().int().min(0).openapi({ description: "本次实际置为已读的条数" }),
    unreadCount: z.number().int().min(0).openapi({ description: "置位后的未读数（恒为 0；回读口径）" }),
  })
  .openapi("NotificationMarkAllReadResponse", { description: "全部标记已读结果" });
export type NotificationMarkAllReadResponse = z.infer<typeof NotificationMarkAllReadResponseSchema>;

/** 免打扰配置三态：`default` 继承缺省（env NOTIFY_QUIET_HOURS）/ `off` 关闭 / `HH:MM-HH:MM` 自定义（跨零点允许，from ≠ to）。 */
export const NotifyQuietHoursSchema = z
  .string()
  .regex(/^(default|off|([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9])$/)
  .superRefine((value, context) => {
    const match = /^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/.exec(value);
    if (match !== null && match[1] === match[2]) {
      context.addIssue({ code: "custom", message: "免打扰开始与结束不能相同（要关闭免打扰请用 off）" });
    }
  })
  .openapi("NotifyQuietHours", {
    description:
      "免打扰配置（三态）：default 继承缺省（env NOTIFY_QUIET_HOURS，缺省 22:00-08:00）/ off 关闭 / HH:MM-HH:MM 自定义（Asia/Shanghai，跨零点允许）",
  });
export type NotifyQuietHours = z.infer<typeof NotifyQuietHoursSchema>;

/**
 * 通知偏好（notify_prefs；C2-09 的按人配置面）—— `quietHours` 为配置态三态，`quietFrom` / `quietTo` 为
 * **生效值**（default 时解析为缺省时段、off 时双 null），供前端直接展示；免打扰与合并窗口按 Asia/Shanghai（ADR-028）。
 */
export const NotifyPrefsSchema = z
  .object({
    quietHours: NotifyQuietHoursSchema,
    quietFrom: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .nullable()
      .openapi({ description: "免打扰开始（生效值，HH:MM，Asia/Shanghai）；null = 免打扰关闭" }),
    quietTo: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .nullable()
      .openapi({ description: "免打扰结束（生效值，HH:MM，Asia/Shanghai）；跨零点允许（from > to）；null = 免打扰关闭" }),
    dailyLimit: z
      .number()
      .int()
      .min(0)
      .max(NOTIFICATION_DAILY_LIMIT_MAX)
      .openapi({ description: "每人每日投递上限（0 = 不限）；超限消息排到次日窗口起点" }),
    mergeWindowMs: z
      .number()
      .int()
      .min(0)
      .max(NOTIFICATION_MERGE_WINDOW_MAX_MS)
      .openapi({ description: "合并窗口（毫秒；0 = 不合并）：同人同合并键、窗口内未读主行合并为一条" }),
    updatedAt: DateTimeSchema.nullable().openapi({ description: "偏好最近保存时刻；null = 从未保存（全走缺省）" }),
  })
  .openapi("NotifyPrefs", { description: "通知偏好（免打扰时段 / 每日上限 / 合并窗口；读面为生效值）" });
export type NotifyPrefs = z.infer<typeof NotifyPrefsSchema>;

/** 偏好更新（局部更新：只传变更键；空更新 400）。 */
export const NotifyPrefsUpdateBodySchema = z
  .object({
    quietHours: NotifyQuietHoursSchema.optional(),
    dailyLimit: z.number().int().min(0).max(NOTIFICATION_DAILY_LIMIT_MAX).optional(),
    mergeWindowMs: z.number().int().min(0).max(NOTIFICATION_MERGE_WINDOW_MAX_MS).optional(),
  })
  .openapi("NotifyPrefsUpdateBody", {
    description: "通知偏好更新（局部更新：只传变更键；quietHours 三态 default / off / HH:MM-HH:MM；空更新 400）",
  });
export type NotifyPrefsUpdateBody = z.infer<typeof NotifyPrefsUpdateBodySchema>;

/**
 * ---- SSE 实时推送（S8-3 · M5-04 余项 · 实时性口径 · 技术设计v0.2 §11.3 `/notifications/stream`）----
 *
 * 事件集：`notification`（单条通知：新投递 / 稍后提醒触发重提醒）+ `unread`（未读角标变更）+
 *   `invalidate`（成功业务写入后的资源失效提示，无记录标识或业务字段）。
 * 心跳 = SSE 注释行（`: ping`，周期落 env）—— 无载荷、无事件名，**不入契约**。
 * 重连补偿 = 不补发（服务端零状态）：客户端重连后等下一次事件 + 立即用读面补拉
 *   （`GET /notifications` + `NotificationListResponse.unreadCount`）对齐；`Last-Event-ID` 补发留二期。
 * 多实例广播：个人通知在写方事务内 `pg_notify`；业务失效提示在成功响应后合并发布（尽力而为），
 *   共用通道 `notify_stream`，api 各实例 `LISTEN` 后桥到本地连接。失效提示重连及周期补取兜底。
 * `ResourceInvalidationPayload` 单独注册入生成物；端点已在 `openapi.ts` 注册。
 */
export const NOTIFICATION_STREAM_EVENTS = ["notification", "unread", "invalidate"] as const;
export type NotificationStreamEventType = (typeof NOTIFICATION_STREAM_EVENTS)[number];

export const NotificationStreamUnreadPayloadSchema = z
  .object({
    unreadCount: z.number().int().min(0).openapi({ description: "当前未读总数（角标口径；= 未读状态主行数）" }),
  })
  .openapi("NotificationStreamUnreadPayload", {
    description: "unread 事件载荷：未读角标同步（新投递 / 标记已读 / 全部已读 / 稍后提醒置读等未读数变更时刻；跨端一致性口径）",
  });
export type NotificationStreamUnreadPayload = z.infer<typeof NotificationStreamUnreadPayloadSchema>;

export const ResourceInvalidationPayloadSchema = z.object({
  resources: z.array(z.enum(["projects", "tasks", "reports", "issues", "files", "stakeholders", "templates", "dicts", "users", "audit", "permissions", "preferences"])).min(1).max(12),
}).openapi("ResourceInvalidationPayload", {
  description: "业务读面失效提示：仅资源类别，无记录标识或业务数据；客户端按原有鉴权接口静默重取，事件允许合并与丢失，重连及周期补取兜底",
});
export type ResourceInvalidationPayload = z.infer<typeof ResourceInvalidationPayloadSchema>;

export const NotificationStreamEventSchema = z
  .discriminatedUnion("event", [
    z.object({ event: z.literal("notification"), data: NotificationSchema }),
    z.object({ event: z.literal("unread"), data: NotificationStreamUnreadPayloadSchema }),
    z.object({ event: z.literal("invalidate"), data: ResourceInvalidationPayloadSchema }),
  ])
  .openapi("NotificationStreamEvent", {
    description:
      "SSE 事件：notification = 单条通知；unread = 未读角标；invalidate = 无业务数据的资源失效提示；心跳为注释行不进本契约",
  });
export type NotificationStreamEvent = z.infer<typeof NotificationStreamEventSchema>;

/**
 * ---- 稍后提醒（S8-3 · M5-04 余项 · C5-05）----
 *
 * 语义（定案）：设置 = 该行自动置 `read`（「收下、稍后再看」；角标同步走 `unread` 事件）+ 记一条设置记录；
 *   触发 = 到点将原行置回 `unread`（角标 +1）+ 推 `notification` 事件 + 回填 `triggeredAt` + 清 `snoozeUntil`；
 *   到点落在免打扰时段 → 顺延到时段结束（复用投递决策先例）、**不消耗每日上限**（用户主动重提醒，非新投递）；
 *   重复设置 = 覆盖（旧记录标 `cancelledAt`）+ 写新记录；对已读 / 已处理行均可设置（用户显式意图优先）。
 * 范围校验：`> now + 最短提前量` 且 `≤ now + 最长提前量`；毫秒位截断（向下取整到秒）后再校验。
 * 数据面（随实现刀 · 迁移 `0045`）：`notifications.snooze_until` + `notification_snoozes`（一次设置一条）。
 */
export const NOTIFICATION_SNOOZE_MIN_LEAD_MS = 5 * 60_000;
export const NOTIFICATION_SNOOZE_MAX_AHEAD_MS = 30 * 24 * 60 * 60_000;

export const NotificationSnoozeBodySchema = z
  .object({
    snoozeUntil: DateTimeSchema.openapi({
      description: "稍后提醒时刻（绝对时刻；校验范围 = now + 5 分钟 ~ now + 30 天；预设枚举由前端换算）",
    }),
  })
  .openapi("NotificationSnoozeBody", { description: "设置稍后提醒（重复设置 = 覆盖旧记录 + 新记录）" });
export type NotificationSnoozeBody = z.infer<typeof NotificationSnoozeBodySchema>;

export const NotificationSnoozeRecordSchema = z
  .object({
    id: z.number().int().positive().openapi({ description: "记录 id（自增；读面按 id 降序）" }),
    setAt: DateTimeSchema.openapi({ description: "设置时刻" }),
    snoozeUntil: DateTimeSchema.openapi({ description: "设定时的稍后提醒时刻" }),
    triggeredAt: DateTimeSchema.nullable().openapi({ description: "触发时刻；null = 未触发（或已取消）" }),
    cancelledAt: DateTimeSchema.nullable().openapi({ description: "取消时刻（覆盖 / 手动取消）；null = 未取消" }),
  })
  .openapi("NotificationSnoozeRecord", {
    description: "稍后提醒记录（C5-05「设置与触发记录可查」；一次设置一条，触发 / 取消回填对应时刻）",
  });
export type NotificationSnoozeRecord = z.infer<typeof NotificationSnoozeRecordSchema>;

export const NotificationSnoozeListResponseSchema = z
  .object({ items: z.array(NotificationSnoozeRecordSchema) })
  .openapi("NotificationSnoozeListResponse", { description: "稍后提醒记录清单（按 id 降序，不翻页）" });
export type NotificationSnoozeListResponse = z.infer<typeof NotificationSnoozeListResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * 企业微信单聊绑定（M5-03-5-6 绑定码链路 · 契约刀 · 2026-10-16 · lan 代记 / wmj 复核）
 *
 * 口径来源：`docs/M5-03-5-绑定码方案设计口径(企微单聊).md` v1.4（§3 目标形态 / §4 数据模型 / §6 投递前判定 /
 *   §7 846607 分流 / §10 待定项 D2 · D3 · D5 · D6）；`docs/M5-03-单聊改智能机器人执行计划(企微单聊).md` §3.2 / §4。
 *
 * 语义：单聊可投递地址 = 绑定行（`wecom_aibot_dm_activations.bound_at` 非空）的 `wecom_userid`
 *   （回调 `from.userid` 原文 = 密文 open_userid；企微后台无管理员权限所致的既有事实）。绑定只能由用户交互
 *   产生 —— 本组端点 = 「取码（POST codes）→ 用户把码发进企微单聊（worker ingest 落绑定 + 会话内回执）→
 *   查绑定态（GET）→ 解绑（DELETE）」。
 * 安全口径（§9）：密文 open_userid 只回掩码末 4 位（最小暴露 · 沿用群绑定 `chatidMasked` 先例）；绑定码正文
 *   不入库、不落日志；取码频率 **5 次 / 3 分钟 / 用户**（D3 修订 v1.8 —— v1.7 的 10 分钟窗口罚时仍偏长，窗口改
 *   3 分钟 = 罚时上限 3 分钟；超出 = 429 `RATE_LIMITED` + `details[].meta.retryAt`）；
 *   解绑写 `audit_logs`（D6）；跨用户换绑同写 `audit_logs`。
 * 换绑口径（v1.8 明确）：码命中即以**码持有者为准** —— 发送方企微号已绑在别的库内用户上时不再短路「已绑定」，
 *   改为把该 `(bot_id, wecom_userid)` 行改挂到码的持有者（旧持有者回落未绑定），并回「绑定成功」。
 * 读面回填（v1.8）：绑定态读面另回「当前 pending 绑定码」与「取码限流可重试时刻」—— 刷新 / 重进页面后前端据此
 *   恢复码面、倒计时与罚时（服务端为准，前端不缓存）。
 * 权限口径：个人资源（同收件箱 / 通知偏好先例）—— 无功能权限位；读 = 会话，写 = 会话 + CSRF。
 * ---------------------------------------------------------------------------------------------- */

/** 绑定码位数（D3：6 位数字）。 */
export const WECOM_DM_BINDING_CODE_LENGTH = 6;
/** 绑定码有效期（2026-10-20 安全修订：3 分钟）。 */
export const WECOM_DM_BINDING_CODE_TTL_MS = 3 * 60_000;
/**
 * 绑定码生成频率窗口（D3 修订 v1.8：3 分钟）。
 * 罚时锚点 = 窗口内**最近一次**取码（v1.9 修订）：倒计时恒为「最近取码 + 3 分钟」，不随被拦重试延长；
 * 按「最早一码 + 窗口」会让分散取码后的罚时只剩 1 分钟（用户实测），故锚点改为最新一码。
 */
export const WECOM_DM_BINDING_CODE_WINDOW_MS = 3 * 60_000;
/** 绑定码生成频率上限（D3 修订 v1.8：5 次 / 3 分钟 / 用户；超出 → 429 `RATE_LIMITED`，最长等待 ≤ 3 分钟）。 */
export const WECOM_DM_BINDING_CODE_MAX_PER_WINDOW = 5;

/** 绑定码（POST codes 响应 / 绑定态读面回填）：只回码 + 失效时刻，不含任何企微标识。 */
export const WecomDmBindingCodeSchema = z
  .object({
    code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .openapi({ description: "6 位数字绑定码（用户在企微里把这条码发给机器人完成绑定）", example: "482913" }),
    expiresAt: DateTimeSchema.openapi({ description: "失效时刻（= 生成时刻 + 3 分钟）" }),
    expiresInSeconds: z.number().int().positive().openapi({ description: "剩余有效期（秒；供前端倒计时）" }),
  })
  .openapi("WecomDmBindingCode", {
    description: "绑定码（一次性：用户首次发码即绑定并置 used；重复取码会作废上一条未用码；TTL 3 分钟）",
  });
export type WecomDmBindingCode = z.infer<typeof WecomDmBindingCodeSchema>;

/** 绑定态（读面恒 200；未绑定 = `bound:false`）—— GET / DELETE 同形 + 取码链路回填（v1.8）。 */
export const WecomDmBindingStateSchema = z
  .object({
    bound: z.boolean().openapi({ description: "当前机器人（`WECOM_BOT_ID`）下是否已有可投递地址" }),
    wecomUseridMasked: z
      .string()
      .nullable()
      .openapi({ description: "企微 open_userid 掩码（只回末 4 位）；未绑定 / 解绑后 = null" }),
    boundAt: DateTimeSchema.nullable().openapi({ description: "绑定确立时刻；未绑定 / 解绑后 = null" }),
    messagesEnabled: z
      .boolean()
      .openapi({ description: "是否允许向该企业微信单聊发送任务提醒；绑定成功后默认 true，关闭后停止企微单聊外发（站内信仍按降级规则保留）" }),
    bindingCode: WecomDmBindingCodeSchema.nullable().openapi({
      description: "当前仍有效的（pending）绑定码 —— 刷新 / 重进页面后据此恢复码面与倒计时；无未用码 = null",
    }),
    retryAt: DateTimeSchema.nullable().openapi({
      description: "取码频率到顶时的可重试时刻 —— 刷新后据此恢复罚时倒计时；未到顶 = null",
    }),
  })
  .openapi("WecomDmBindingState", {
    description:
      "企业微信单聊绑定态：绑定按机器人维度成立（换机器人后旧绑定不生效 → 读面回到 bound:false）；解绑 = 注销投递资格（保留激活登记）；另回当前未用绑定码与取码限流可重试时刻（页面刷新不丢状态）",
  });
export type WecomDmBindingState = z.infer<typeof WecomDmBindingStateSchema>;

/** 绑定设置更新（当前仅消息开关；未绑定时调用幂等返回未绑定态）。 */
export const WecomDmBindingUpdateBodySchema = z
  .object({
    messagesEnabled: z.boolean().openapi({ description: "是否允许向该企业微信单聊发送任务提醒" }),
  })
  .openapi("WecomDmBindingUpdateBody", {
    description: "企业微信单聊绑定设置更新（messagesEnabled = false 时停止企微单聊外发；绑定成功后默认开启）",
  });
export type WecomDmBindingUpdateBody = z.infer<typeof WecomDmBindingUpdateBodySchema>;

/** 库内出现过的机器人维度（诊断用：排查 worker 是否在用另一个 bot_id 收消息）。 */
export const WecomDmBotInboundStatSchema = z
  .object({
    botId: z.string(),
    inboundCount: z.number().int().nonnegative().openapi({ description: "该 bot_id 下累计有过单聊消息的企微号数（激活表按 (bot_id, wecom_userid) 一行；不是消息条数）" }),
    lastInboundAt: DateTimeSchema.nullable().openapi({ description: "该 bot_id 最近一次收到单聊消息的时刻；无记录 = null" }),
  })
  .openapi("WecomDmBotInboundStat");

/**
 * 机器人诊断（本地联调 · 非生产）：回显当前 api 进程实际读取的 `WECOM_BOT_*`，以及该机器人维度最近是否收到单聊回调。
 * 用途：用户在企微侧发绑定码后机器人不回时，先核对 ID / Secret 是否与企微后台一致、回调是否到达（`inboundCount`）。
 * 安全（CONTRIBUTING §12）：仅 `NODE_ENV !== "production"`（或显式 `WECOM_BOT_DIAGNOSTICS=true`）时回敏感字段；
 * 生产恒 `enabled:false` + 敏感字段 null；本端点不写日志、响应 `Cache-Control: no-store`。
 */
export const WecomDmBotDiagnosticsSchema = z
  .object({
    enabled: z.boolean().openapi({ description: "诊断是否开启（生产默认关闭；关闭时其余敏感字段为 null）" }),
    botId: z.string().nullable().openapi({ description: "WECOM_BOT_ID 原文（未配置 = null）" }),
    botSecret: z.string().nullable().openapi({ description: "WECOM_BOT_SECRET 原文（仅诊断开启时回全量；关闭 = null）" }),
    botSecretMasked: z.string().nullable().openapi({ description: "Secret 掩码（首 4 + **** + 末 4；关闭 / 未配置 = null）" }),
    wsUrl: z.string().nullable().openapi({ description: "WECOM_BOT_WS_URL（机器人长连接地址）" }),
    deliveryEnabled: z.boolean().openapi({ description: "NOTIFY_DELIVERY_ENABLED（worker 是否允许启动机器人长连接）" }),
    lastInboundAt: DateTimeSchema.nullable().openapi({ description: "当前 bot_id 最近一次收到单聊消息的时刻；null = 从未收到" }),
    inboundCount: z.number().int().nonnegative().openapi({ description: "当前 bot_id 下有过单聊消息的企微号数（激活表行数）；0 = 回调从未到达（worker 未启动 / 凭据不对 / bot_id 不一致）" }),
    lastInboundUseridMasked: z.string().nullable().openapi({ description: "最近一次回调的 open_userid 掩码（末 4 位）；无记录 = null" }),
    observedBotIds: z.array(WecomDmBotInboundStatSchema).openapi({ description: "激活表内出现过的 bot_id（最多 5 个，最近在前）—— 可发现 worker 用的是另一个机器人" }),
    serverTime: DateTimeSchema.openapi({ description: "服务端当前时刻（对照最近回调时间判断是否仍在收消息）" }),
  })
  .openapi("WecomDmBotDiagnostics", {
    description: "机器人诊断（仅非生产环境）：bot_id / secret / ws 地址 / 最近回调统计；用于核对本地凭据与 worker 收消息链路",
  });
export type WecomDmBotDiagnostics = z.infer<typeof WecomDmBotDiagnosticsSchema>;
