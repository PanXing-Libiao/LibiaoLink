import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { sqlValueList } from "./literals.js";
import { projects } from "./projects.js";

/**
 * project_import_previews（0053）：导入表导入预览票据 —— 解析结果（payload jsonb）+ 源工作簿对象键；
 * commit 单事务写入全部业务数据后置 committed；超时未提交 = expired（惰性标记 + 清理对象）。
 * 口径见 database/migrations/0053_project_imports.sql 与 shared/src/modules/imports.ts。
 */
export const projectImportPreviews = pgTable(
  "project_import_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileName: text("file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    committedProjectId: uuid("committed_project_id").references(() => projects.id, { onDelete: "set null" }),
  },
  (table) => [
    index("ix_project_import_previews_status_expires").on(table.status, table.expiresAt),
    index("ix_project_import_previews_creator").on(table.createdBy, table.createdAt, table.id),
    check(
      "ck_project_import_previews_status",
      sql`${table.status} in ${sql.raw(sqlValueList(["pending", "committed", "expired"]))}`,
    ),
    check("ck_project_import_previews_file_size", sql`${table.fileSizeBytes} >= 0`),
    check("ck_project_import_previews_expires", sql`${table.expiresAt} > ${table.createdAt}`),
    check("ck_project_import_previews_payload", sql`jsonb_typeof(${table.payload}) = ${sql.raw(sqlValueList(["object"]))}`),
    check(
      "ck_project_import_previews_committed_pair",
      sql`(${table.status} = ${sql.raw(sqlValueList(["committed"]))}) = (${table.committedAt} is not null)`,
    ),
  ],
);

export type ProjectImportPreviewRow = typeof projectImportPreviews.$inferSelect;
