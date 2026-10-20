import { z } from "../zod.ts";
import { DateTimeSchema } from "../common/conventions.ts";

/**
 * Outbox 事件消费与调度契约（M5-02 草案 · wmj）—— 主题白名单 / 事件行形态 / 领取与重试口径 /
 * 调度与补发 / 幂等执行键与「状态回退再生窗口」。
 *
 * 口径来源：技术设计v0.2-架构与数据模型.md §1.3（Outbox 至少一次投递 + dedupe_key 消费幂等）、
 *   §6.2（幂等执行键 / 调度 / 投递 / 留痕）、ADR-005（PG 原生：Outbox + SKIP LOCKED + advisory lock）、
 *   ADR-009（消息通道）、ADR-028（时区固定 Asia/Shanghai）；
 *   实现现状：`server/src/db/outbox.ts`（同事务投递 + 唤醒 dead）、`server/src/db/outbox.store.ts`
 *   （领取 / done / retry / dead）、迁移 `0028_outbox_claim`（`locked_at` + `processing` 部分索引）、
 *   `server/src/outbox/`（S7-1 运行时分派 / 重试退避 / 死信与积压告警 / done 保留期）、
 *   `server/src/entry/worker.ts`（常驻三轮：分派 / 告警探针 / 保留期清理）。
 *
 *   白名单口径（Push 169 定案）：`OUTBOX_TOPICS` = **已写入主题闭集 ∪ 已定案预留主题**（当前 **30 项 = 30 项写入闭集**（`notify.group` —— M5-03-2 接线段 Push 224 转写入端：automation-wiring 产出行，回放脚本 `RESERVED_TOPICS` 同批清空）；`notify.message` 随 S7-4 规则接线转写入端；Push 215 增 `report.deleted` / `issue.deleted`；Push 252 增 `task.finalized`（任务定档 · 抽屉开关入口）；Push 260 增 `task.unfinalized`（任务取消定档 · 同一开关再次点击））。
 *   新增主题须同时改写入端与本表；`scripts/outbox-contract-replay.mjs` 扫 `server/src` 的主题字面量与主题常量，
 *   断言「写入 ⊆ 本表」且「本表无死条目」（未被写入者必须在预留清单）。
 *
 * 边界（本切片不落端点）：本文件只固定**消费侧口径**；规则管理端点（M5-06）与消息中心查询端点（M5-07）
 *   入 `openapi.ts` 时以本文件枚举与 schema 为准 —— **paths / operations / schemas 计数不变**，生成物零漂移。
 *   切片边界沿 Push 160 定案：领取器只落「领取 + 消费 + 重试 + dead」，规则 / 通知编排不在本契约内。
 *
 * 与 automation.ts 的关系：`RULE_EVENT_TOPICS`（规则可订阅的事件）必须是本文件 `OUTBOX_TOPICS` 的
 *   **子集**（不变式由 `scripts/outbox-contract-replay.mjs` 断言）；新增主题须同时扩两处。
 */

/** Outbox 行状态（`outbox_events.status`，与库侧 CHECK `ck_outbox_status` 同值同序）。 */
export const OUTBOX_STATUSES = ["pending", "processing", "done", "dead"] as const;
export const OutboxStatusSchema = z.enum(OUTBOX_STATUSES).openapi("OutboxStatus", {
  description:
    "Outbox 行状态：pending 待领取（available_at 到期才可见）/ processing 已领取（locked_at 记领取时刻，超过领取阈值视为崩溃遗留可重领）/ done 消费成功 / dead 到顶或确定性放弃（同 dedupeKey 的新事件可唤醒回 pending）",
});
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/** 事件主题白名单（业务事务同事务写入；消费侧只认本表，未知主题不领取）。 */
export const OUTBOX_TOPICS = [
  "task.created",
  "task.updated",
  "task.progress_changed",
  "task.completed",
  "task.finalized",
  "task.unfinalized",
  "task.deleted",
  "task.locked_fields_adjusted",
  "task.draft_doc_reminded",
  "task.gate_rejected",
  "node.added",
  "node.completed",
  "node.deleted",
  "node.gate_rejected",
  "stage.advanced",
  "stage.gate_rejected",
  "stage.rolled_back",
  "project.completed",
  "project.created",
  "file.version.created",
  "file.finalized",
  "preview.job",
  "change.applied",
  "report.submitted",
  "report.deleted",
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "notify.message",
  "notify.group",
] as const;
export const OutboxTopicSchema = z.enum(OUTBOX_TOPICS).openapi("OutboxTopic", {
  description:
    "事件主题：task.created 任务创建 / task.updated 任务更新 / task.progress_changed 进度变化 / task.completed 任务完成 / task.finalized 任务定档（Push 252）/ task.unfinalized 任务取消定档（Push 260）/ task.deleted 任务软删 / task.locked_fields_adjusted 锁定字段例外调整 / task.draft_doc_reminded 缺件提醒 / task.gate_rejected 完成门禁拒绝 / node.added 节点新增 / node.completed 节点完成 / node.deleted 节点删除 / node.gate_rejected 节点完成门禁拒绝 / stage.advanced 阶段推进 / stage.gate_rejected 阶段门禁拒绝 / stage.rolled_back 阶段回退 / project.completed 项目完成（用户将项目状态改为已完成）/ project.created 项目创建 / file.version.created 文件新版本 / file.finalized 文件定档 / preview.job 预览转换任务 / change.applied 变更生效 / report.submitted 日报提交 / report.deleted 日报删除（成对删派生问题，Push 215）/ issue.created 问题生成 / issue.updated 问题更新 / issue.deleted 问题删除（成对删来源日报，Push 215）/ notify.message 通知投递（S7-4 起为写入端：站内信 / 企微 / 邮件；合并 / 免打扰 / 限速在投递层）/ notify.group 群播报投递（M5-03-2 接线段起为写入端：企微智能机器人长连接 + chatid —— 寻址键 projectId，投递时解析群绑定）；规则可订阅的主题见 automation 的 RuleEventTopic（本表的子集）",
});
export type OutboxTopic = z.infer<typeof OutboxTopicSchema>;

/** 窗口键类型：决定「同键不重复发」的粒度。 */
export const OUTBOX_WINDOW_KINDS = ["date", "iso_week", "state_version"] as const;
export const OutboxWindowKindSchema = z.enum(OUTBOX_WINDOW_KINDS).openapi("OutboxWindowKind", {
  description:
    "窗口键类型：date 业务日（YYYY-MM-DD，Asia/Shanghai · ADR-028）/ iso_week ISO 周（YYYY-Www）/ state_version 状态版本（v{n}，n = 实体乐观锁版本）；调度型规则用 date 或 iso_week，事件型用 state_version",
});
export type OutboxWindowKind = z.infer<typeof OutboxWindowKindSchema>;

/** 窗口键：date = `YYYY-MM-DD`；iso_week = `YYYY-Www`；state_version = `v{n}`。 */
export const OutboxWindowKeySchema = z.string().min(1).max(32).openapi("OutboxWindowKey", {
  description:
    "窗口键：YYYY-MM-DD（业务日）/ YYYY-Www（ISO 周）/ v{n}（状态版本，n = 实体 version）；存量 task.* 事件的状态版本段为裸 n（如 task.completed:{id}:3），语义相同 —— 新键统一写 v{n}，存量不回改",
});

/**
 * 幂等执行键形态：`scope:entityId:window`（冒号分隔，至少三段）——
 *   - scope：事件型填主题（小写点分，如 `task.completed` / `preview.job`）/ 调度型填规则码（大写字母 + 数字，如 `R03` / `A01` / `A14`）；
 *   - entityId：主体 ID（任务 / 节点 / 日报 / 问题 / 待办 / 上传会话）；合并类任务用其合并粒度（如按人合并时用 userId）；
 *   - window：窗口键（见 OutboxWindowKey）；按主题语义可继续追加段（预览任务 = 内容哈希 + 管线版本 + 目标三元组）。
 * 唯一约束 `outbox_events.dedupe_key` 兜底「同键不重复发」（同事务投递用 ON CONFLICT DO NOTHING）。
 *
 * **状态回退再生窗口**：窗口键含状态版本时（`state_version`），实体回退后**再次**进入触发态会推进版本 →
 *   生成新键 → 可再次投递（这正是「回退再生」）；若窗口键为日期 / 周（不含版本），回退当天不重发 ——
 *   两类键并存是刻意的：选哪类由规则 / 事件的语义决定（提醒类按日窗口「一天一次」，事件类按版本窗口「每次到达都算」）。
 */
export const OUTBOX_DEDUPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._]*(:[^:]+){2,}$/;
export const OutboxDedupeKeySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(OUTBOX_DEDUPE_KEY_PATTERN)
  .openapi("OutboxDedupeKey", {
    description:
      "幂等执行键（outbox_events.dedupe_key）：scope:entityId:window（scope = 主题或规则码；window = 业务日 / ISO 周 / 状态版本 v{n}）；同键只投递一次",
    example: "task.completed:6f1f4d3a-0000-4000-8000-000000000000:v7",
  });
export type OutboxDedupeKey = z.infer<typeof OutboxDedupeKeySchema>;

/** 幂等执行键构造（与 `server/src/modules/automation/automation.rules.ts` 的 `dedupeKey()` 同形态）。 */
export function outboxDedupeKey(scope: string, entityId: string, window: string): string {
  return scope + ":" + entityId + ":" + window;
}

/** 状态版本窗口键：`v{n}`（n = 实体乐观锁版本）。 */
export function stateVersionWindow(version: number): string {
  return "v" + version;
}

/**
 * 调度与补发口径（ADR-005：任务定义入 DB、每分钟 tick、单活调度器、错过窗口按 last_run_at 补发）。
 * `tickMs` / `catchupMaxDays` / `maxWindowsPerTick` 为**建议值**（实施时可按量级调，语义不变；落 env 便于按环境调档）；
 * `maxWindowsPerTick` 是**水位护栏**：单轮 tick 最多处理 N 个补发窗口，触顶时 last_run_at 只推进到本轮
 *   最后处理的窗口（不越过未处理窗口），剩余窗口下一轮顺延；
 * `lockName` 是排障锚点（`pg_locks` / 日志里能看到谁在调度）。
 */
export const OUTBOX_SCHEDULER = {
  /** 单活调度器：pg_advisory_lock 键名（同一时刻只允许一个 worker 求值窗口）。 */
  lockName: "libiaolink:outbox:scheduler",
  /** tick 周期（毫秒）：每分钟一次（ADR-005）；窗口求值按业务日 / ISO 周，不随 tick 频率变化。 */
  tickMs: 60_000,
  /** 补发跨度上限（天）：重启 / 停机期间错过的窗口按 last_run_at 与窗口比对补发，超出跨度只记 skipped 留痕。 */
  catchupMaxDays: 7,
  /** 单轮 tick 最多处理的补发窗口数：触顶时水位停在最后处理的窗口，剩余窗口下一轮顺延（不越过未处理窗口）。 */
  maxWindowsPerTick: 20,
} as const;

// 重试与死信口径（**语义**为契约，数值按主题落 env）：
//   1. 可重试失败：回 pending 并把 available_at 推后（指数退避、attempts 累计，不新建事件）；
//   2. 到顶 / 确定性失败：写 dead + last_error 留痕，并按 ADR-005 纳入死信告警（Outbox 积压量 + 最老消息年龄）；
//   3. 唤醒：同 dedupe_key 的新事件把 dead 行唤醒回 pending（读取侧补投场景；见 server/src/db/outbox.ts）；
//   4. 保留：done 行按保留期清理并观察表膨胀（ADR-005）。
//   数值现状：通用主题缺省 OUTBOX_DEFAULT_MAX_ATTEMPTS / OUTBOX_DEFAULT_BACKOFF_BASE_MS / OUTBOX_DEFAULT_BACKOFF_MAX_MS
//   （5 / 15s / 30min）；预览队列沿用 PREVIEW_CONVERT_MAX_ATTEMPTS / PREVIEW_CONVERT_BACKOFF_MS（3 / 15s）且封顶 30 分钟；
//   崩溃遗留重领阈值 OUTBOX_STALE_MS（须 ≥ 单条消费最长时长）。语义入契约、数值按主题落 env —— 契约不落数值常量。

/** done 行保留期（天）—— ADR-005「成功行按保留期（约 90 天）清理，观察表膨胀」。 */
export const OUTBOX_DONE_RETENTION_DAYS = 90;

/** 消费侧看到的事件行（与 `outbox_events` 列一一对应，裁到消费需要的最小面）。 */
export const OutboxEventSchema = z
  .object({
    id: z.number().int().positive(),
    topic: OutboxTopicSchema,
    dedupeKey: OutboxDedupeKeySchema,
    status: OutboxStatusSchema,
    attempts: z.number().int().min(0).openapi({ description: "已尝试次数（失败重试累计；成功 / dead 后不再增长）" }),
    availableAt: DateTimeSchema.openapi({ description: "下次可领取时刻（退避后推后；未到点不领取）" }),
    lockedAt: DateTimeSchema.nullable().openapi({ description: "领取时刻（processing 时有值；超过领取阈值视为崩溃遗留可重领）" }),
    lastError: z.string().nullable().openapi({ description: "最后一次失败原因（dead 时为放弃原因）" }),
  })
  .openapi("OutboxEvent", { description: "Outbox 事件行：消费侧领取与回写的最小字段面" });
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;
