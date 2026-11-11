/**
 * stakeholders / project_stakeholders（0019 · j6 · S8·stakeholder · A5-01 ~ A5-04 / A5-07）。
 * 表口径见 database/migrations/0019_stakeholders.sql：台账为全库实体（不挂项目），项目关联走多对多；
 * 字段集与 permission.rules.ts 的字段策略表（entity = stakeholder）一一对应；软删口径照 projects（0009）。
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { projects } from "./projects.js";
import { STAKEHOLDER_COMPANY_TYPE_KEYS, sqlValueList } from "./literals.js";

/** 干系人台账（A5-01）：name / company_type / company / title / phone / wechat / email / remark / role 九个业务字段（role = 「干系人角色」，Push 225 增列）。 */
export const stakeholders = pgTable(
  "stakeholders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    companyType: text("company_type").notNull(),
    company: text("company"),
    title: text("title"),
    phone: text("phone"),
    wechat: text("wechat"),
    email: text("email"),
    remark: text("remark"),
    /** 干系人角色（A5-01 · Push 225 增列）：自由文本 1..80，未填为 null；不登记字段级策略（有 stakeholder.view 即可见）。 */
    role: text("role"),
    /** 录入人（A5-04）：数据范围 own_stakeholders 据此判定「我录入的干系人」；系统导入可空。 */
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** 软删（照 0009）：列表 / 详情一律过滤 deleted_at is null。 */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id),
  },
  (table) => [
    index("ix_stakeholders_active_updated").on(table.updatedAt.desc()).where(sql`deleted_at is null`),
    index("ix_stakeholders_created_by").on(table.createdBy).where(sql`deleted_at is null`),
    index("ix_stakeholders_company_type").on(table.companyType, table.updatedAt.desc()).where(sql`deleted_at is null`),
    index("ix_stakeholders_name").on(table.name).where(sql`deleted_at is null`),
    check("ck_stakeholders_name", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("ck_stakeholders_company_type", sql`${table.companyType} in ${sql.raw(sqlValueList(STAKEHOLDER_COMPANY_TYPE_KEYS))}`),
    check("ck_stakeholders_company", sql`${table.company} is null or char_length(btrim(${table.company})) between 1 and 120`),
    check("ck_stakeholders_title", sql`${table.title} is null or char_length(btrim(${table.title})) between 1 and 80`),
    check("ck_stakeholders_phone", sql`${table.phone} is null or char_length(btrim(${table.phone})) between 1 and 40`),
    check("ck_stakeholders_wechat", sql`${table.wechat} is null or char_length(btrim(${table.wechat})) between 1 and 64`),
    check("ck_stakeholders_email", sql`${table.email} is null or char_length(btrim(${table.email})) between 3 and 120`),
    check("ck_stakeholders_remark", sql`${table.remark} is null or char_length(btrim(${table.remark})) between 1 and 500`),
    check("ck_stakeholders_role", sql`${table.role} is null or char_length(btrim(${table.role})) between 1 and 80`),
  ],
);

/** 干系人所属项目：每条记录只归属一个项目，同一个人可在不同项目有独立记录；联合唯一 + 记录唯一双约束。 */
export const projectStakeholders = pgTable(
  "project_stakeholders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    stakeholderId: uuid("stakeholder_id").notNull().references(() => stakeholders.id),
    linkedBy: uuid("linked_by").references(() => users.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_project_stakeholders").on(table.projectId, table.stakeholderId),
    index("ix_project_stakeholders_project").on(table.projectId),
    unique("uq_project_stakeholders_stakeholder").on(table.stakeholderId),
  ],
);
