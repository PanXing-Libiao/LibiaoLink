import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import type { ProjectSummaryFacts, ProjectSummaryNarrative } from "@libiaolink/contracts";
import { projects } from "./projects.js";

/**
 * 项目总结（0076）：事实包与叙述同库存档，保留历史版本。
 * 一项目同时最多一条 confirmed（部分唯一索引）；确认新版本时旧 confirmed 与其余草稿转 superseded。
 * generated_by / confirmed_by 不做外键：人员停用或删除后仍保留操作历史。
 */
export const projectSummaries = pgTable(
  "project_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    dataCutoff: timestamp("data_cutoff", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("draft"),
    facts: jsonb("facts").$type<ProjectSummaryFacts>().notNull(),
    narrative: jsonb("narrative").$type<ProjectSummaryNarrative>().notNull(),
    generatorEngine: text("generator_engine").notNull(),
    generatorModel: text("generator_model"),
    promptVersion: text("prompt_version").notNull(),
    fallbackReason: text("fallback_reason"),
    generatedBy: uuid("generated_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ix_project_summaries_project_created").on(table.projectId, table.createdAt.desc()),
    uniqueIndex("uq_project_summaries_confirmed").on(table.projectId).where(sql`${table.status} = 'confirmed'`),
    check("ck_project_summaries_status", sql`${table.status} in ('draft', 'confirmed', 'superseded')`),
    check("ck_project_summaries_version", sql`${table.version} >= 1`),
    check("ck_project_summaries_facts_object", sql`jsonb_typeof(${table.facts}) = 'object'`),
    check("ck_project_summaries_narrative_object", sql`jsonb_typeof(${table.narrative}) = 'object'`),
    check(
      "ck_project_summaries_confirmed_pair",
      sql`(${table.confirmedBy} is null) = (${table.confirmedAt} is null)`,
    ),
    check(
      "ck_project_summaries_confirmed_status",
      sql`(${table.status} <> 'draft' or ${table.confirmedAt} is null) and (${table.status} <> 'confirmed' or ${table.confirmedAt} is not null)`,
    ),
  ],
);
