import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { fileVersions, files } from "./files.js";
import { PREVIEW_STATUS_KEYS, PREVIEW_TARGET_KEYS, sqlValueList } from "./literals.js";

/** preview_artifacts：版本 ID + 管线版本 + 通道唯一（迁移 0067）。
 * content_hash 绑定源版本；file_id / version_id 始终属于本产物，不再向相同申报哈希的版本转移归属。
 */
export const previewArtifacts = pgTable(
  "preview_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    target: text("target").notNull(),
    pipelineVersion: text("pipeline_version").notNull(),
    status: text("status").notNull().default("not_ready"),
    objectKey: text("object_key"),
    error: text("error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_preview_artifacts_cache_key").on(table.versionId, table.pipelineVersion, table.target),
    index("ix_preview_artifacts_version").on(table.versionId, table.target),
    index("ix_preview_artifacts_file").on(table.fileId),
    check("ck_preview_artifacts_target", sql`${table.target} in ${sql.raw(sqlValueList(PREVIEW_TARGET_KEYS))}`),
    check("ck_preview_artifacts_status", sql`${table.status} in ${sql.raw(sqlValueList(PREVIEW_STATUS_KEYS))}`),
    check(
      "ck_preview_artifacts_ready_pair",
      sql`(${table.status} = 'ready') = (${table.objectKey} is not null and ${table.generatedAt} is not null)`,
    ),
    check("ck_preview_artifacts_failed_pair", sql`(${table.status} = 'failed') = (${table.error} is not null)`),
    check(
      "ck_preview_artifacts_error_length",
      sql`${table.error} is null or char_length(${table.error}) <= 500`,
    ),
  ],
);
