import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import {
  GROUP_ACCESS_PAGE_KEYS,
  GROUP_ACCESS_PROJECT_SCOPE_KEYS,
  sqlArrayLiteral,
  sqlValueList,
} from "./literals.js";
import { projects } from "./projects.js";

/**
 * user_group_memberships（0068 · 2026-10-23）：登录令牌 / 目录同步落地的 Casdoor 群组成员关系。
 * group_key 统一 owner/name，中文显示名只作展示；规则判定不依赖显示名。
 */
export const userGroupMemberships = pgTable(
  "user_group_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    groupName: text("group_name").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "user_group_memberships_pkey", columns: [table.userId, table.groupKey] }),
    index("ix_user_group_memberships_group").on(table.groupKey),
    check(
      "ck_user_group_memberships_key",
      sql.raw("char_length(btrim(" + table.groupKey.name + ")) between 1 and 200"),
    ),
    check(
      "ck_user_group_memberships_name",
      sql.raw("char_length(btrim(" + table.groupName.name + ")) between 1 and 200"),
    ),
  ],
);

/** group_access_rules（0068）：一个 Casdoor 群组一行；allowed_pages 与项目范围共同裁定。 */
export const groupAccessRules = pgTable(
  "group_access_rules",
  {
    groupKey: text("group_key").primaryKey(),
    groupName: text("group_name").notNull(),
    allowedPages: text("allowed_pages").array().notNull().default(sql.raw("array[]::text[]")),
    projectScope: text("project_scope").notNull().default("none"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ck_group_access_rules_key",
      sql.raw("char_length(btrim(" + table.groupKey.name + ")) between 1 and 200"),
    ),
    check(
      "ck_group_access_rules_name",
      sql.raw("char_length(btrim(" + table.groupName.name + ")) between 1 and 200"),
    ),
    check(
      "ck_group_access_rules_pages",
      sql.raw(
        table.allowedPages.name +
          " <@ " +
          sqlArrayLiteral(GROUP_ACCESS_PAGE_KEYS) +
          " and array_position(" +
          table.allowedPages.name +
          ", null::text) is null",
      ),
    ),
    check(
      "ck_group_access_rules_scope",
      sql.raw(table.projectScope.name + " in " + sqlValueList(GROUP_ACCESS_PROJECT_SCOPE_KEYS)),
    ),
  ],
);

/** project_group_access（0068）：selected 规则下的项目白名单；多群组取并集。 */
export const projectGroupAccess = pgTable(
  "project_group_access",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupKey: text("group_key")
      .notNull()
      .references(() => groupAccessRules.groupKey, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "project_group_access_pkey", columns: [table.projectId, table.groupKey] }),
    index("ix_project_group_access_group").on(table.groupKey),
  ],
);
