import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import {
  GROUP_ACCESS_ACCESS_LEVEL_KEYS,
  GROUP_ACCESS_DATA_PROJECT_SCOPE_KEYS,
  GROUP_ACCESS_MEMBER_SCOPE_KEYS,
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

/** group_access_rules（0068 · 0070 · 0073）：一个 Casdoor 群组一行，表示部门默认权限；个人覆盖见 group_access_member_rules。allowed_pages 为旧客户端兼容字段（裁决恒全放行）。 */
export const groupAccessRules = pgTable(
  "group_access_rules",
  {
    groupKey: text("group_key").primaryKey(),
    groupName: text("group_name").notNull(),
    allowedPages: text("allowed_pages").array().notNull().default(sql.raw("array[]::text[]")),
    projectScope: text("project_scope").notNull().default("none"),
    accessLevel: text("access_level").notNull().default("view"),
    memberScope: text("member_scope").notNull().default("all"),
    memberUserIds: uuid("member_user_ids").array().notNull().default(sql.raw("array[]::uuid[]")),
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
    check(
      "ck_group_access_rules_access_level",
      sql.raw(table.accessLevel.name + " in " + sqlValueList(GROUP_ACCESS_ACCESS_LEVEL_KEYS)),
    ),
    check(
      "ck_group_access_rules_none_access",
      sql.raw(table.projectScope.name + " <> 'none' or " + table.accessLevel.name + " = 'view'"),
    ),
    check(
      "ck_group_access_rules_member_scope",
      sql.raw(table.memberScope.name + " in " + sqlValueList(GROUP_ACCESS_MEMBER_SCOPE_KEYS)),
    ),
    check(
      "ck_group_access_rules_members",
      sql.raw(
        "cardinality(" + table.memberUserIds.name + ") <= 2000 and array_position(" + table.memberUserIds.name + ", null::uuid) is null and (" + table.memberScope.name + " <> 'all' or cardinality(" + table.memberUserIds.name + ") = 0)",
      ),
    ),
  ],
);

/** group_access_member_rules（0074 · 2026-10-26）：部门内个人权限覆盖；存在个人规则时优先于同部门默认规则。 */
export const groupAccessMemberRules = pgTable(
  "group_access_member_rules",
  {
    groupKey: text("group_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectScope: text("project_scope").notNull().default("none"),
    accessLevel: text("access_level").notNull().default("view"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "group_access_member_rules_pkey", columns: [table.groupKey, table.userId] }),
    index("ix_group_access_member_rules_user").on(table.userId),
    check(
      "ck_group_access_member_rules_key",
      sql.raw("char_length(btrim(" + table.groupKey.name + ")) between 1 and 200"),
    ),
    check(
      "ck_group_access_member_rules_scope",
      sql.raw(table.projectScope.name + " in " + sqlValueList(GROUP_ACCESS_PROJECT_SCOPE_KEYS)),
    ),
    check(
      "ck_group_access_member_rules_access_level",
      sql.raw(table.accessLevel.name + " in " + sqlValueList(GROUP_ACCESS_ACCESS_LEVEL_KEYS)),
    ),
    check(
      "ck_group_access_member_rules_none_access",
      sql.raw(table.projectScope.name + " <> 'none' or " + table.accessLevel.name + " = 'view'"),
    ),
  ],
);

/** group_access_scope_permissions（0075 · 2026-10-27）：部门默认规则的多范围权限；每个项目范围一行。 */
export const groupAccessScopePermissions = pgTable(
  "group_access_scope_permissions",
  {
    groupKey: text("group_key")
      .notNull()
      .references(() => groupAccessRules.groupKey, { onDelete: "cascade" }),
    projectScope: text("project_scope").notNull(),
    accessLevel: text("access_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "group_access_scope_permissions_pkey", columns: [table.groupKey, table.projectScope] }),
    check(
      "ck_group_access_scope_permissions_scope",
      sql.raw(table.projectScope.name + " in " + sqlValueList(GROUP_ACCESS_DATA_PROJECT_SCOPE_KEYS)),
    ),
    check(
      "ck_group_access_scope_permissions_access_level",
      sql.raw(table.accessLevel.name + " in " + sqlValueList(GROUP_ACCESS_ACCESS_LEVEL_KEYS)),
    ),
  ],
);

/** group_access_member_scope_permissions（0075）：个人覆盖的多范围权限；存在个人规则时整体覆盖同部门默认规则。 */
export const groupAccessMemberScopePermissions = pgTable(
  "group_access_member_scope_permissions",
  {
    groupKey: text("group_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectScope: text("project_scope").notNull(),
    accessLevel: text("access_level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "group_access_member_scope_permissions_pkey", columns: [table.groupKey, table.userId, table.projectScope] }),
    foreignKey({
      name: "fk_group_access_member_scope_permissions_member",
      columns: [table.groupKey, table.userId],
      foreignColumns: [groupAccessMemberRules.groupKey, groupAccessMemberRules.userId],
    }).onDelete("cascade"),
    index("ix_group_access_member_scope_permissions_user").on(table.userId),
    check(
      "ck_group_access_member_scope_permissions_scope",
      sql.raw(table.projectScope.name + " in " + sqlValueList(GROUP_ACCESS_DATA_PROJECT_SCOPE_KEYS)),
    ),
    check(
      "ck_group_access_member_scope_permissions_access_level",
      sql.raw(table.accessLevel.name + " in " + sqlValueList(GROUP_ACCESS_ACCESS_LEVEL_KEYS)),
    ),
  ],
);

/** group_access_admins（0072 · 2026-10-24）：权限页手工授予的系统管理员；环境变量与角色来源不落本表。 */
export const groupAccessAdmins = pgTable(
  "group_access_admins",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [],
);

/** project_group_member_access（0074）：个人覆盖为 selected 时的项目白名单。 */
export const projectGroupMemberAccess = pgTable(
  "project_group_member_access",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "project_group_member_access_pkey", columns: [table.projectId, table.groupKey, table.userId] }),
    foreignKey({
      name: "fk_project_group_member_access_member",
      columns: [table.groupKey, table.userId],
      foreignColumns: [groupAccessMemberRules.groupKey, groupAccessMemberRules.userId],
    }).onDelete("cascade"),
    index("ix_project_group_member_access_member").on(table.groupKey, table.userId),
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
