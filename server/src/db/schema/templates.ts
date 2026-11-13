import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { TEMPLATE_SECTION_KEYS, sqlValueList } from "./literals.js";

/**
 * task_templates（0033 · M3-05 余第二段；0092 增 visibility）：任务模板 —— 名称 + 所属阶段 + 可见范围 + 乐观锁 version；删除为软删（deleted_at / deleted_by）。
 * 读面恒带 `deleted_at is null`；名称不设同阶段唯一（「未命名模板」允许重复，是否唯一待业务定稿）。
 */
export const taskTemplates = pgTable(
  "task_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    stageKey: text("stage_key").notNull(),
    visibility: text("visibility").notNull().default("public"),
    version: integer("version").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ix_task_templates_active_stage").on(table.stageKey, table.createdAt, table.id).where(sql`deleted_at is null`),
    index("ix_task_templates_created_by").on(table.createdBy).where(sql`deleted_at is null`),
    check("ck_task_templates_stage_key", sql`${table.stageKey} in ${sql.raw(sqlValueList(TEMPLATE_SECTION_KEYS))}`),
    check("ck_task_templates_visibility", sql`${table.visibility} in ('private', 'public')`),
    check("ck_task_templates_name", sql`char_length(btrim(${table.name})) between 1 and 100`),
    check("ck_task_templates_version", sql`${table.version} >= 0`),
  ],
);

/**
 * task_nodes（0032 · M3-05 余；0094 增 owner_template_id）：任务节点库与模板私有节点的共同落点。
 * owner_template_id = null → 公共节点库；非空 → 只属于该模板的私有节点（不出现在左侧节点库，也不能被其它模板引用）。
 * 与流程节点（project_nodes / 蓝图）区分：本表回答「任务从哪来」，不被 tasks 直接引用（tasks.task_node_id 才是来源引用）。
 * 公共节点删除 = 物理删行；模板保存时清理该模板已移除的私有节点。
 */
export const taskNodes = pgTable(
  "task_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerTemplateId: uuid("owner_template_id").references(() => taskTemplates.id, { onDelete: "cascade" }),
    stageKey: text("stage_key").notNull(),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    titleEn: text("title_en"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_task_nodes_shared_stage_title")
      .on(table.stageKey, table.title)
      .where(sql`${table.ownerTemplateId} is null`),
    uniqueIndex("uq_task_nodes_owner_title")
      .on(table.ownerTemplateId, table.title)
      .where(sql`${table.ownerTemplateId} is not null`),
    index("ix_task_nodes_stage_seq").on(table.stageKey, table.seq, table.id),
    index("ix_task_nodes_owner_seq").on(table.ownerTemplateId, table.seq, table.id),
    check("ck_task_nodes_stage_key", sql`${table.stageKey} in ${sql.raw(sqlValueList(TEMPLATE_SECTION_KEYS))}`),
    check("ck_task_nodes_seq", sql`${table.seq} > 0`),
    check("ck_task_nodes_title", sql`char_length(btrim(${table.title})) between 1 and 200`),
    check("ck_task_nodes_version", sql`${table.version} >= 0`),
  ],
);

/**
 * task_template_nodes（0033）：模板内节点引用 —— 主键 (template_id, node_id) = 同一模板内按 id 去重；seq = 模板内顺序。
 * 两个外键都是 on delete cascade：删模板连带清引用；删节点（公共节点物理删行 / 模板私有节点清理）连带从各模板移除该条。
 */
export const taskTemplateNodes = pgTable(
  "task_template_nodes",
  {
    templateId: uuid("template_id").notNull().references(() => taskTemplates.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => taskNodes.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
  },
  (table) => [
    primaryKey({ name: "pk_task_template_nodes", columns: [table.templateId, table.nodeId] }),
    index("ix_task_template_nodes_order").on(table.templateId, table.seq),
    check("ck_task_template_nodes_seq", sql`${table.seq} > 0`),
  ],
);
