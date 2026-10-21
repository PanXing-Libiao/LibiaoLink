import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlValueList } from "./literals.js";

/** outbox_events（外部副作用唯一出口：至少一次投递 + dedupe_key 消费幂等）。 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** 领取时刻（migration 0028）：worker 崩溃 / 重启后按超阈值重领，避免行永久卡在 processing。 */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** 领取者标识（migration 0038）：WORKER_ID 或 host:pid —— 多 worker 排障 / PoC-5 并发领取报告用。 */
    lockedBy: text("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** 状态迁移时刻（migration 0038）：markDone / markRetry / markDead 回写；死信告警按它判「最近新增」。 */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("outbox_events_dedupe_key_key").on(table.dedupeKey),
    index("ix_outbox_ready").on(table.status, table.availableAt),
    index("ix_outbox_processing").on(table.lockedAt).where(sql`status = 'processing'`),
    check(
      "ck_outbox_status",
      sql`${table.status} in ${sql.raw(sqlValueList(["pending", "processing", "done", "dead"]))}`,
    ),
    check("ck_outbox_attempts", sql`${table.attempts} >= 0`),
  ],
);

/** jobs（S7-3 · i11 / M5-02：定时 / 单例任务定义与状态；kind ↔ worker 生产者注册表）。 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** cron 五段（分钟 小时 日 月 周；Asia/Shanghai · ADR-028）；null = 一次性任务。 */
    cron: text("cron"),
    /** 下次应执行时刻：cron 任务每轮推进到下一触发时刻；一次性任务执行后置 done。 */
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    /** 上次成功执行时刻：补发窗口 = (last_run_at, now]，超补发跨度上限只记 skipped 留痕。 */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** 领取者标识（migration 0039）：保留最后一次，便于多实例排障；完成后清 locked_at、保留 locked_by。 */
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** 一规则一 job 的幂等键（M5-06-1A · 0060）：内置调度规则 = automation-schedule:<ruleCode>；历史行 NULL。 */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ck_jobs_status", sql`${table.status} in ('pending', 'done', 'failed')`),
    check("ck_jobs_cron", sql`${table.cron} is null or ${table.cron} ~ '^\\S+( \\S+){4}$'`),
    check("ck_jobs_attempts", sql`${table.attempts} >= 0`),
    unique("jobs_dedupe_key_key").on(table.dedupeKey),
    check(
      "ck_jobs_dedupe_key",
      sql`${table.dedupeKey} is null or char_length(btrim(${table.dedupeKey})) between 1 and 128`,
    ),
    index("ix_jobs_due").on(table.runAt).where(sql`status = 'pending'`),
    index("ix_jobs_locked").on(table.lockedAt).where(sql`status = 'pending' and locked_at is not null`),
  ],
);

/** job_runs（S7-3：调度运行留痕 —— executed / skipped / failed）。 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    fireCount: integer("fire_count").notNull().default(0),
    produced: integer("produced").notNull().default(0),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ck_job_runs_status", sql`${table.status} in ('executed', 'skipped', 'failed')`),
    check("ck_job_runs_fire_count", sql`${table.fireCount} >= 0`),
    check("ck_job_runs_produced", sql`${table.produced} >= 0`),
    index("ix_job_runs_job").on(table.jobId, table.createdAt),
  ],
);

/** idempotency_keys（写接口幂等：只存 key 哈希；作用域 = 调用方 + 接口指纹）。 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").notNull(),
    route: text("route").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("idempotency_keys_actor_id_route_key_hash_key").on(table.actorId, table.route, table.keyHash),
    index("ix_idempotency_keys_expiry").on(table.expiresAt),
    check(
      "ck_idempotency_keys_status",
      sql`${table.status} in ${sql.raw(sqlValueList(["in_progress", "completed"]))}`,
    ),
    check("ck_idempotency_keys_expires", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "ck_idempotency_keys_response",
      sql`(${table.status} = 'completed') = (${table.responseStatus} is not null)`,
    ),
    check(
      "ck_idempotency_keys_hashes",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$' and ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
