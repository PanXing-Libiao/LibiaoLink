import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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
import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionEvaluation,
  AutomationMessageSnapshot,
  AutomationTrigger,
} from "@libiaolink/contracts";
import { users } from "./identity.js";

/** automation_rules（M5-06-1A · 0060）：规则权威表；运行时只读启用且未软删的行。 */
export const automationRules = pgTable(
  "automation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    enabled: boolean("enabled").notNull().default(false),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    conditions: jsonb("conditions").$type<AutomationCondition[]>().notNull(),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("automation_rules_code_key").on(table.code),
    index("ix_automation_rules_enabled").on(table.enabled, table.deletedAt),
    check("ck_automation_rules_code", sql`char_length(btrim(${table.code})) between 2 and 32`),
    check("ck_automation_rules_name", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("ck_automation_rules_trigger", sql`jsonb_typeof(${table.trigger}) = 'object'`),
    check("ck_automation_rules_conditions", sql`jsonb_typeof(${table.conditions}) = 'array'`),
    check(
      "ck_automation_rules_actions",
      sql`jsonb_typeof(${table.actions}) = 'array' and jsonb_array_length(${table.actions}) between 1 and 10`,
    ),
    check("ck_automation_rules_version", sql`${table.version} >= 1`),
    check("ck_automation_rules_timestamps", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

/** automation_runs（M5-06-1A · 0060）：规则 × 实体 × 窗口求值留痕；dedupe_key 唯一。 */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ruleId: uuid("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
    ruleCode: text("rule_code").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    source: text("source").notNull(),
    topic: text("topic"),
    windowKey: text("window_key"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull(),
    skipReason: text("skip_reason"),
    conditions: jsonb("conditions").$type<AutomationConditionEvaluation[]>().notNull().default([]),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull().default([]),
    messages: jsonb("messages").$type<AutomationMessageSnapshot[]>().notNull().default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("automation_runs_dedupe_key_key").on(table.dedupeKey),
    index("ix_automation_runs_rule_created").on(table.ruleCode, table.createdAt.desc()),
    index("ix_automation_runs_entity_created").on(table.entityType, table.entityId, table.createdAt.desc()),
    index("ix_automation_runs_window")
      .on(table.ruleCode, table.windowKey)
      .where(sql`window_key is not null`),
    check("ck_automation_runs_rule_code", sql`char_length(btrim(${table.ruleCode})) between 2 and 32`),
    check("ck_automation_runs_rule_version", sql`${table.ruleVersion} >= 1`),
    check("ck_automation_runs_source", sql`${table.source} in ('event', 'schedule')`),
    check("ck_automation_runs_topic", sql`(${table.source} = 'event') = (${table.topic} is not null)`),
    check(
      "ck_automation_runs_window",
      sql`${table.windowKey} is null or char_length(btrim(${table.windowKey})) between 1 and 128`,
    ),
    check("ck_automation_runs_entity", sql`(${table.entityType} is null) = (${table.entityId} is null)`),
    check("ck_automation_runs_dedupe", sql`char_length(btrim(${table.dedupeKey})) between 1 and 256`),
    check("ck_automation_runs_status", sql`${table.status} in ('hit', 'skipped', 'failed')`),
    check(
      "ck_automation_runs_skip_reason",
      sql`${table.skipReason} is null or ${table.skipReason} in ('disabled', 'subject_mismatch', 'window_mismatch', 'not_matched', 'recipient_missing', 'template_missing', 'duplicate', 'event_too_old')`,
    ),
    check(
      "ck_automation_runs_outcome",
      sql`(${table.status} = 'hit' and ${table.skipReason} is null and ${table.error} is null) or (${table.status} = 'skipped' and ${table.skipReason} is not null and ${table.error} is null) or (${table.status} = 'failed' and ${table.skipReason} is null and ${table.error} is not null and char_length(btrim(${table.error})) > 0)`,
    ),
    check("ck_automation_runs_conditions", sql`jsonb_typeof(${table.conditions}) = 'array'`),
    check("ck_automation_runs_actions", sql`jsonb_typeof(${table.actions}) = 'array'`),
    check("ck_automation_runs_messages", sql`jsonb_typeof(${table.messages}) = 'array'`),
  ],
);
