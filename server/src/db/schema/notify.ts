/**
 * notifications / notify_prefs（0040 · S7-4 · j1 / M5-04 首刀 · lan 线）+ notification_snoozes /
 * notifications.snooze_until（0045 · S8-3 / M5-04-2 · C5-05 稍后提醒）。
 * 表口径见 database/migrations/0040_notify_delivery.sql 与 0045_notification_snooze.sql：一行 = 一条投递事件
 * （source_dedupe_key 唯一 = 消费幂等）；合并子行（merged_into_id 非空）仅库内留档、不进收件箱；
 * deliver_at / delivered_at 承载免打扰次日补发与每日上限排队的延迟投递；snooze_until = 当前未触发的稍后
 * 提醒时刻（null = 未设置 / 已触发 / 已取消）；notification_snoozes 一次设置一条（触发 / 取消回填时刻）；
 * notify_prefs 一人一行、可空列 = 继承 env 缺省。
 *
 * 0046 · M5-03-2 追加：wecom_groups（项目群绑定 · P5 智能机器人 + chatid）/ notify_deliveries
 * （外部渠道投递留痕 · C2-07 + C5-03）/ notify_rate_counters（固定窗口限速计数 · C2-10）；
 * 表口径见 database/migrations/0046_wecom_group_notify_delivery.sql。
 *
 * 0048 · M5-03-5-2 追加：wecom_aibot_dm_activations（单聊激活表 —— 单聊 aibot 主动推送前置）/ notify_deliveries.channel CHECK 扩值（增 wecom_aibot · 保留旧值）；
 * 表口径见 database/migrations/0048_wecom_aibot_dm_activation.sql。
 *
 * 0055 · M5-03-5-6 追加：wecom_id_binding_codes（企微 ID 绑定码 —— 绑定码链路：取码 / 单聊发码 / ingest 绑定）
 * + wecom_aibot_dm_activations 加机器人维度 bot_id 与绑定标记 bound_at（唯一键改 (bot_id, wecom_userid)）；
 * 表口径见 database/migrations/0055_wecom_id_binding_codes.sql。
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { NOTIFICATION_STATUS_KEYS, NOTIFICATION_TYPE_KEYS, sqlValueList } from "./literals.js";
import { outboxEvents } from "./platform.js";
import { projects } from "./projects.js";

/** 站内信（C5-01 / C5-03）：收件箱主行 + 合并子行（全量留档）。 */
export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("unread"),
    /** 关联对象（ref_type / ref_id 成对）：project / task / report / issue / file / node 等，与审计对象类型同词汇表。 */
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    /** 来源 outbox 主题（当前恒为 notify.message；留列便于多生产者主题回溯）。 */
    sourceTopic: text("source_topic").notNull(),
    /** 来源 outbox 去重键（唯一）：消费重放不重复落行。 */
    sourceDedupeKey: text("source_dedupe_key").notNull(),
    templateCode: text("template_code"),
    /** 合并键（缺省按契约回退：templateCode → type:refType:refId）。 */
    mergeKey: text("merge_key").notNull(),
    /** 合并条数（未合并 = 1；命中合并时主行自增）。 */
    mergedCount: integer("merged_count").notNull().default(1),
    /** 合并归属：非空 = 本行是子行（仅留档、不进收件箱）。 */
    mergedIntoId: bigint("merged_into_id", { mode: "number" }).references((): AnyPgColumn => notifications.id, {
      onDelete: "cascade",
    }),
    /** 计划投递时刻（免打扰 / 每日上限 → 排到下一投递窗口）。 */
    deliverAt: timestamp("deliver_at", { withTimezone: true }).notNull().defaultNow(),
    /** 实际投递时刻；null = 尚未投递（子行恒为 null）。 */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** 当前未触发的稍后提醒时刻（C5-05）：null = 未设置 / 已触发 / 已取消；触发不改写 delivered_at。 */
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notifications_source_dedupe_key").on(table.sourceDedupeKey),
    index("ix_notifications_inbox").on(table.recipientId, table.id.desc()).where(sql`merged_into_id is null`),
    index("ix_notifications_unread")
      .on(table.recipientId)
      .where(sql`merged_into_id is null and status = 'unread'`),
    index("ix_notifications_due")
      .on(table.deliverAt)
      .where(sql`merged_into_id is null and delivered_at is null`),
    index("ix_notifications_merge").on(table.recipientId, table.mergeKey, table.createdAt.desc()).where(sql`merged_into_id is null`),
    index("ix_notifications_daily")
      .on(table.recipientId, table.deliveredAt)
      .where(sql`merged_into_id is null and delivered_at is not null`),
    index("ix_notifications_snooze")
      .on(table.snoozeUntil)
      .where(sql`merged_into_id is null and snooze_until is not null`),
    check("ck_notifications_type", sql`${table.type} in ${sql.raw(sqlValueList(NOTIFICATION_TYPE_KEYS))}`),
    check("ck_notifications_status", sql`${table.status} in ${sql.raw(sqlValueList(NOTIFICATION_STATUS_KEYS))}`),
    check("ck_notifications_title", sql`char_length(btrim(${table.title})) between 1 and 200`),
    check("ck_notifications_body", sql`char_length(btrim(${table.body})) between 1 and 4000`),
    check("ck_notifications_ref", sql`(${table.refType} is null) = (${table.refId} is null)`),
    check("ck_notifications_merged_count", sql`${table.mergedCount} >= 1`),
    check("ck_notifications_merged_into", sql`${table.mergedIntoId} is null or ${table.mergedIntoId} <> ${table.id}`),
    check("ck_notifications_delivery", sql`${table.mergedIntoId} is null or ${table.deliveredAt} is null`),
  ],
);

/** 稍后提醒记录（C5-05「设置与触发记录可查」）：一次设置一条；触发 / 取消（含覆盖）回填对应时刻、二者互斥。 */
export const notificationSnoozes = pgTable(
  "notification_snoozes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    notificationId: bigint("notification_id", { mode: "number" })
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    /** 设置时刻（进读面 setAt）。 */
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    /** 设定时的稍后提醒时刻（读面原样回显；触发可能晚于本时刻 —— 免打扰顺延）。 */
    snoozeUntil: timestamp("snooze_until", { withTimezone: true }).notNull(),
    /** 触发时刻；null = 未触发（或已取消）。 */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),
    /** 取消时刻（重复设置 = 覆盖旧记录 / 手动取消）；null = 未取消。 */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    index("ix_notification_snoozes_notification").on(table.notificationId, table.id.desc()),
    check("ck_notification_snoozes_exclusive", sql`${table.triggeredAt} is null or ${table.cancelledAt} is null`),
  ],
);

/** 通知偏好（C2-09）：一人一行；可空列 = 继承 env 缺省（免打扰两列同生共死）。 */
export const notifyPrefs = pgTable(
  "notify_prefs",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 免打扰三态（HH:MM-HH:MM，Asia/Shanghai）：null = 继承 env 缺省 / '' = 关闭 / 自定义时段（跨零点允许）。 */
    quietHours: text("quiet_hours"),
    /** 每人每日投递上限（0 = 不限；null = 继承 env 缺省）。 */
    dailyLimit: integer("daily_limit"),
    /** 合并窗口毫秒（0 = 不合并；null = 继承 env 缺省）。 */
    mergeWindowMs: integer("merge_window_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ck_notify_prefs_quiet",
      sql`${table.quietHours} is null or ${table.quietHours} = '' or (${table.quietHours} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$' and split_part(${table.quietHours}, '-', 1) <> split_part(${table.quietHours}, '-', 2))`,
    ),
    check(
      "ck_notify_prefs_daily_limit",
      sql`${table.dailyLimit} is null or (${table.dailyLimit} >= 0 and ${table.dailyLimit} <= 1000)`,
    ),
    check(
      "ck_notify_prefs_merge_window",
      sql`${table.mergeWindowMs} is null or (${table.mergeWindowMs} >= 0 and ${table.mergeWindowMs} <= 86400000)`,
    ),
  ],
);

/**
 * 项目群绑定（M5-03-2 · P5 定案：智能机器人 + chatid · 0046）：一个项目最多一个群（project_id 唯一）、
 * 一个群最多绑一个项目（chatid 唯一，防重复播报 —— 换绑 = 先解绑再绑）；enabled = 绑定启用态
 * （群失效 / 人工暂停置 false，投递层跳过并留痕）；activated_at = 会话激活态（群内有人给机器人发过消息 ——
 * 主动推送前置；换绑（chatid 变更）视为新会话、重置 null）。
 */
export const wecomGroups = pgTable(
  "wecom_groups",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** 企微会话 id（群消息回调 body.chatid 自动落库；契约同形正则）。 */
    chatid: text("chatid").notNull(),
    /** 群名 / 备注（维护用；可空）。 */
    name: text("name"),
    /** 绑定启用态（false = 暂停播报 / 群失效标记；投递层跳过）。 */
    enabled: boolean("enabled").notNull().default(true),
    /** 会话激活时刻（null = 未激活；主动推送前置）。 */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_wecom_groups_project").on(table.projectId),
    uniqueIndex("uq_wecom_groups_chatid").on(table.chatid),
    check("ck_wecom_groups_chatid", sql`${table.chatid} ~ '^[A-Za-z0-9_-]{8,128}$'`),
    check("ck_wecom_groups_name", sql`${table.name} is null or char_length(btrim(${table.name})) between 1 and 64`),
  ],
);

/**
 * 单聊激活表（0048 · M5-03-5-2 · 单聊 aibot 主动推送前置；0055 · M5-03-5-6 加绑定维度）：
 * 用户向机器人发过消息 = 激活（enter_chat 等事件不激活）；wecom_userid = 回调 from.userid 原文
 * （企微后台无管理员权限 → 实为密文 open_userid）；bot_id = 机器人维度（WECOM_BOT_ID 原文，(bot_id, wecom_userid)
 * 唯一 —— 激活态按机器人成立）；bound_at 非空 = 绑定行 = 可投递地址（绑定码命中的产物），NULL = 仅激活登记
 * （D1：不可作发送地址）；first_activated_at 首次激活后不再覆盖，last_message_at 随 upsert 刷新；
 * updated_at 由应用写入（无触发器）。表口径见 database/migrations/0055_wecom_id_binding_codes.sql。
 */
export const wecomAibotDmActivations = pgTable(
  "wecom_aibot_dm_activations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 机器人维度（= WECOM_BOT_ID 原文；NULL = 历史遗留行（旧机器人），不参与发送寻址）。 */
    botId: text("bot_id"),
    /** 企微 userid（回调 from.userid 原文 —— 密文 open_userid；不再与 users.username 同源）。 */
    wecomUserid: text("wecom_userid").notNull(),
    /** 库内用户（可空 —— 仅激活登记行无主；绑定行必带，由绑定码链路写入；用户不物理删，故无级联口径）。 */
    userId: uuid("user_id").references(() => users.id),
    /** 首次激活时刻（upsert 不覆盖）。 */
    firstActivatedAt: timestamp("first_activated_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近一条消息时刻（upsert 刷新）。 */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** 绑定确立时刻（非空 = 绑定行 = 可投递地址；NULL = 仅激活登记）。 */
    boundAt: timestamp("bound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_wecom_aibot_dm_activations_bot_userid").on(table.botId, table.wecomUserid),
    check("ck_wecom_aibot_dm_activations_userid", sql`${table.wecomUserid} ~ '^[A-Za-z0-9_.@-]{1,64}$'`),
    check("ck_wecom_aibot_dm_activations_bot_id", sql`${table.botId} is null or ${table.botId} ~ '^[A-Za-z0-9_.@-]{1,64}$'`),
  ],
);

/**
 * 企微 ID 绑定码（0055 · M5-03-5-6 · D3 签发：6 位数字 / TTL 5 分钟 / 一次性；频率 D3 修订 v1.8：5 次 / 3 分钟 / 用户）：
 * 服务端取码 → 用户在单聊发码 → 回调 ingest 命中 → 同一事务写绑定行（wecom_aibot_dm_activations.bound_at）
 * + 标记本行 used（used_at / used_wecom_userid 留痕）。status = pending（待用）/ used（已用）/ expired（重发废止）；
 * 同一 user_id 仅一个 pending（部分唯一索引 uq_wecom_id_binding_codes_pending —— 重发由写入侧先作废旧码）。
 * 表口径见 database/migrations/0055_wecom_id_binding_codes.sql。
 */
export const wecomIdBindingCodes = pgTable(
  "wecom_id_binding_codes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 绑定码（6 位数字串；全库唯一 —— 用户把它发进单聊）。 */
    code: text("code").notNull(),
    /** 发起人（库内用户；用户不物理删，故无级联口径）。 */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** 处置态（pending / used / expired）。 */
    status: text("status").notNull().default("pending"),
    /** 失效时刻（created_at + TTL；写入侧定）。 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 实际使用该码的时刻（status = used 时非空 —— 见 ck_wecom_id_binding_codes_used）。 */
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** 实际使用该码的 open_userid（误绑可审计；掩码只用于日志 / 读面）。 */
    usedWecomUserid: text("used_wecom_userid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_wecom_id_binding_codes_code").on(table.code),
    uniqueIndex("uq_wecom_id_binding_codes_pending")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    index("ix_wecom_id_binding_codes_user_created").on(table.userId, table.createdAt.desc()),
    check("ck_wecom_id_binding_codes_code", sql`${table.code} ~ '^[0-9]{6}$'`),
    check("ck_wecom_id_binding_codes_status", sql`${table.status} in ('pending', 'used', 'expired')`),
    check("ck_wecom_id_binding_codes_used", sql`(${table.status} = 'used') = (${table.usedAt} is not null)`),
    check(
      "ck_wecom_id_binding_codes_used_userid",
      sql`${table.usedWecomUserid} is null or ${table.usedWecomUserid} ~ '^[A-Za-z0-9_.@-]{1,64}$'`,
    ),
  ],
);

/**
 * 外部渠道投递留痕（C2-07 / C5-03 共用底座 · 0046）：每次尝试一行；state = 处置三分类映射 ——
 * sent（API 受理成功）/ failed（retryable，将退避重试）/ deferred（rate_limited，延期重排、不消耗重试次数）/
 * dead（permanent 或重试到顶）；outbox_id 指向来源事件（outbox 行清理后置 null，留档不回删）。
 * 0048 扩 channel 值：增 wecom_aibot（单聊 aibot 投递留痕；保留旧值，见迁移 0048）。
 */
export const notifyDeliveries = pgTable(
  "notify_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outboxId: bigint("outbox_id", { mode: "number" }).references(() => outboxEvents.id, { onDelete: "set null" }),
    /** 投递渠道（NOTIFY_CHANNELS 的企微 / 邮件交集；inbox 不落本表 —— 收件箱行即留档）。 */
    channel: text("channel").notNull(),
    /** 投递目标全文（wecom_app = userid / wecom_aibot = userid / wecom_group = chatid；读面掩码，库内全文供排障）。 */
    target: text("target").notNull(),
    /** 本次尝试状态（sent / failed / deferred / dead —— 见 0046 迁移头注）。 */
    state: text("state").notNull(),
    /** 本次为第几次发送尝试（deferred = 被延期的计划尝试序号、未发起 HTTP）。 */
    attempts: integer("attempts").notNull().default(0),
    /** 失败 / 延期描述（掩码后，不含凭据；sent 恒 null）。 */
    error: text("error"),
    /** API 受理成功时刻（sent 恒非空，其余恒 null）。 */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ix_notify_deliveries_outbox").on(table.outboxId, table.id.desc()),
    index("ix_notify_deliveries_recent").on(table.channel, table.createdAt.desc()),
    check("ck_notify_deliveries_channel", sql`${table.channel} in ('wecom_app', 'wecom_aibot', 'wecom_group', 'email')`),
    check("ck_notify_deliveries_state", sql`${table.state} in ('sent', 'failed', 'deferred', 'dead')`),
    check("ck_notify_deliveries_attempts", sql`${table.attempts} >= 0`),
    check("ck_notify_deliveries_sent", sql`(${table.state} = 'sent') = (${table.sentAt} is not null)`),
    check("ck_notify_deliveries_error", sql`(${table.state} = 'sent') = (${table.error} is null)`),
  ],
);

/**
 * 固定窗口限速计数（C2-10 按队列限速发送 · 0046）：bucket 由调用方构造（含渠道桶 id + 窗口长度，
 * 避免 1 分钟 / 1 小时窗口在同起点互污）；消费 = 单语句 upsert（`on conflict (bucket, window_start)
 * do update set count = count + 1 returning count`，先增量后判定、跨进程并发安全）；
 * 过期窗口行由运维 / 后续清理作业按 updated_at 裁剪。
 */
export const notifyRateCounters = pgTable(
  "notify_rate_counters",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "notify_rate_counters_pkey", columns: [table.bucket, table.windowStart] }),
    index("ix_notify_rate_counters_updated").on(table.updatedAt),
    check("ck_notify_rate_counters_count", sql`${table.count} >= 0`),
  ],
);
