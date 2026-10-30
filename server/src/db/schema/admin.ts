import { desc, sql } from "drizzle-orm";
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
import { AUDIT_ACTION_KEYS, AUDIT_ENTRY_KEYS, AUDIT_RESULT_KEYS, sqlValueList } from "./literals.js";

/** 审计字段级变更条目（changes 列元素形状：谁、何时、从什么改成什么 —— C7-02）。 */
export interface AuditChangeEntry {
  field: string;
  from: unknown;
  to: unknown;
}

/** 字典类型注册表（C9）：一期只登记下发类字典（region / projectType）；阶段 / 成果文件类型走契约枚举。 */
export const dictTypes = pgTable(
  "dict_types",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ck_dict_types_code", sql`${table.code} ~ '^[a-z][a-zA-Z0-9_]{1,39}$'`),
    check("ck_dict_types_name", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("ck_dict_types_sort", sql`${table.sort} >= 0`),
  ],
);

/** 字典条目（C9）：唯一键 (type_code, code)；停用（enabled=false）替代删除，存量数据展示不受影响。 */
export const dictItems = pgTable(
  "dict_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    typeCode: text("type_code")
      .notNull()
      .references(() => dictTypes.code, { onUpdate: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (table) => [
    unique("uq_dict_items_type_code").on(table.typeCode, table.code),
    check("ck_dict_items_code", sql`char_length(btrim(${table.code})) between 1 and 64`),
    check("ck_dict_items_name", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("ck_dict_items_sort", sql`${table.sort} >= 0`),
    check("ck_dict_items_metadata", sql`jsonb_typeof(${table.metadata}) = 'object'`),
    index("ix_dict_items_type_sort").on(table.typeCode, table.sort, table.code),
  ],
);

/** 操作审计（C7）：追加写；应用角色无 UPDATE / DELETE（迁移 0013 显式 revoke）；保留 ≥6 个月。 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    projectId: uuid("project_id"),
    /** 所属项目编号快照：项目彻底删除后仍保留操作记录上下文；查询时优先当前项目。 */
    projectCode: text("project_code"),
    /** 所属项目名称快照：项目彻底删除后仍保留操作记录上下文；查询时优先当前项目。 */
    projectName: text("project_name"),
    result: text("result").notNull().default("succeeded"),
    entry: text("entry").notNull().default("api"),
    summary: text("summary").notNull().default(""),
    changes: jsonb("changes").$type<AuditChangeEntry[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    check("ck_audit_logs_action", sql`${table.action} in ${sql.raw(sqlValueList(AUDIT_ACTION_KEYS))}`),
    check("ck_audit_logs_result", sql`${table.result} in ${sql.raw(sqlValueList(AUDIT_RESULT_KEYS))}`),
    check("ck_audit_logs_entry", sql`${table.entry} in ${sql.raw(sqlValueList(AUDIT_ENTRY_KEYS))}`),
    check(
      "ck_audit_logs_object",
      sql`char_length(btrim(${table.objectType})) between 1 and 40 and char_length(btrim(${table.objectId})) between 1 and 200`,
    ),
    check("ck_audit_logs_changes", sql`${table.changes} is null or jsonb_typeof(${table.changes}) = 'array'`),
    check("ck_audit_logs_metadata", sql`jsonb_typeof(${table.metadata}) = 'object'`),
    index("ix_audit_logs_object").on(table.objectType, table.objectId, desc(table.occurredAt)),
    index("ix_audit_logs_actor").on(table.actorId, desc(table.occurredAt)),
    index("ix_audit_logs_time").on(desc(table.occurredAt)),
    index("ix_audit_logs_project")
      .on(table.projectId, desc(table.occurredAt))
      .where(sql`project_id is not null`),
    index("ix_audit_logs_denied")
      .on(desc(table.occurredAt))
      .where(sql`result = 'denied'`),
  ],
);
