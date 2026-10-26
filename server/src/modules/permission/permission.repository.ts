import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type {
  GroupAccessAccessLevel,
  GroupAccessMemberScope,
  GroupAccessPage,
  GroupAccessProjectScope,
} from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import { groupAccessAdmins, groupAccessMemberRules, groupAccessRules, projectGroupAccess, projectGroupMemberAccess, userGroupMemberships } from "../../db/schema/access.js";
import { users } from "../../db/schema/identity.js";
import { projectNodes } from "../../db/schema/flow.js";
import { projectMembers, projects } from "../../db/schema/projects.js";
import type { GroupAccessMemberRuleData, GroupAccessRuleData } from "./group-access.rules.js";
import { visibleProjectIds, type ProjectScopeSpec } from "./permission.rules.js";

/** 项目数据面引用：可见性解析需要的项目主数据字段（不做软删过滤，由调用方判定）。 */
export interface ProjectRef {
  /** 项目经理（A22 · Push 136：多位，任一位即视为项目责任人）。 */
  managerIds: string[];
  deletedAt: Date | null;
}

/** 记录级解析结果：可见项目上下文 + 项目内角色（can 的项目级来源）。 */
export interface ProjectAccessContext {
  projectId: string;
  member: boolean;
  projectManager: boolean;
}

/** 权限页用户展示字段。 */
export interface GroupAccessUserRecord {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
}

/** 权限页部门人员：直属成员 + 用户展示字段。 */
export interface GroupAccessMemberRecord extends GroupAccessUserRecord {
  groupKey: string;
  groupName: string;
}

/** 系统管理员候选用户：环境配置 / 手工授予的共同展示字段。 */
export interface GroupAccessAdminUserRecord extends GroupAccessUserRecord {}

/** 手工管理员记录：额外保留授予时间，供后续审计扩展。 */
export interface GroupAccessManualAdminRecord extends GroupAccessAdminUserRecord {
  grantedAt: Date;
}

/**
 * permission 数据访问（h6）：只读名册 / 项目主数据 / 节点 → 项目解析。
 * 边界：记录级判定需要「我参与的项目」与「节点属于哪个项目」，前者读 project_members、
 * 后者读 project_nodes —— 只读、只取判定所需列；名册与节点的写路径仍归 project 模块。
 */
@Injectable()
export class PermissionRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 我参与的项目 id（名册任意角色）。 */
  async listMemberProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actorId));
    return rows.map((row) => row.projectId);
  }

  /** 我作为主数据责任人的项目 id（projects.manager_ids 含我；含回收站项目，列表查询再按 filter[recycled] 过滤）。 */
  async listOwnedProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ projectId: projects.id })
      .from(projects)
      .where(sql`${projects.managerIds} @> array[${actorId}]::uuid[]`);
    return rows.map((row) => row.projectId);
  }

  /** 当前是否存在任一未软删项目（项目范围为 all 时的页面三态判定）。 */
  async hasActiveProject(): Promise<boolean> {
    const rows = await this.database.db
      .select({ projectId: projects.id })
      .from(projects)
      .where(isNull(projects.deletedAt))
      .limit(1);
    return rows.length > 0;
  }

  /** 过滤仍有效的项目 id（排除软删项目；操作记录 / 页面三态只用有效项目）。 */
  async listActiveProjectIds(projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.database.db
      .select({ projectId: projects.id })
      .from(projects)
      .where(and(inArray(projects.id, [...projectIds]), isNull(projects.deletedAt)));
    return rows.map((row) => row.projectId);
  }

  /** 我在名册里是 project_manager 的项目 id（managed_projects 数据范围）。 */
  async listManagedRosterProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, actorId), eq(projectMembers.roleInProject, "project_manager")));
    return rows.map((row) => row.projectId);
  }

  /**
   * 可见项目 id 并集（记录级过滤；spec.all 由服务层短路，不查库）：
   * 名册成员（member） ∪ 我作为主数据责任人的项目（恒可见，见 resolveProjectAccess 同谓词） ∪ managed_projects 下的名册项目经理。
   */
  async listVisibleProjectIds(actorId: string, spec: ProjectScopeSpec): Promise<string[]> {
    return visibleProjectIds(spec, {
      memberIds: await this.listMemberProjectIds(actorId),
      ownedIds: await this.listOwnedProjectIds(actorId),
      managedRosterIds: await this.listManagedRosterProjectIds(actorId),
    });
  }

  /** 项目主数据引用（不存在返回 null；软删由调用方判定）。 */
  async findProjectRef(projectId: string): Promise<ProjectRef | null> {
    const rows = await this.database.db
      .select({ managerIds: projects.managerIds, deletedAt: projects.deletedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 名册行（项目内角色）。 */
  async findMembership(actorId: string, projectId: string): Promise<string | null> {
    const rows = await this.database.db
      .select({ roleInProject: projectMembers.roleInProject })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actorId)))
      .limit(1);
    return rows[0]?.roleInProject ?? null;
  }

  /** 节点 → 项目（/api/v1/nodes/* 路由没有项目路径参数，可见性判定需要这一步解析）。 */
  async findNodeProjectId(nodeId: string): Promise<string | null> {
    const rows = await this.database.db
      .select({ projectId: projectNodes.projectId })
      .from(projectNodes)
      .where(eq(projectNodes.id, nodeId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  // ---------- 系统管理员（0072） ----------

  /** 环境变量用户白名单：只取启用且未离职的账号，避免失效账号出现在管理员名单。 */
  async listActiveUsersByIds(userIds: readonly string[]): Promise<GroupAccessAdminUserRecord[]> {
    if (userIds.length === 0) return [];
    const rows = await this.database.db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), eq(users.status, "active"), isNull(users.removedAt)))
      .orderBy(asc(users.displayName), asc(users.username));
    return rows.map(normalizeAdminUser);
  }

  /** 环境变量管理员部门的直属成员。 */
  async listGroupAdminUsersByGroupKeys(groupKeys: readonly string[]): Promise<GroupAccessAdminUserRecord[]> {
    if (groupKeys.length === 0) return [];
    const rows = await this.database.db
      .selectDistinct({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(userGroupMemberships)
      .innerJoin(users, eq(users.id, userGroupMemberships.userId))
      .where(and(inArray(userGroupMemberships.groupKey, [...groupKeys]), eq(users.status, "active"), isNull(users.removedAt)))
      .orderBy(asc(users.displayName), asc(users.username));
    return rows.map(normalizeAdminUser);
  }

  /** 权限页手工添加的管理员（停用账号仍保留在名单，便于撤销）。 */
  async listManualGroupAccessAdmins(): Promise<GroupAccessManualAdminRecord[]> {
    const rows = await this.database.db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
        grantedAt: groupAccessAdmins.createdAt,
      })
      .from(groupAccessAdmins)
      .innerJoin(users, eq(users.id, groupAccessAdmins.userId))
      .orderBy(asc(users.displayName), asc(users.username));
    return rows.map((row) => ({ ...normalizeAdminUser(row), grantedAt: row.grantedAt }));
  }

  /** 权限画像快速判定：手工管理员必须仍是启用且未离职账号。 */
  async isManualGroupAccessAdmin(userId: string): Promise<boolean> {
    const rows = await this.database.db
      .select({ userId: groupAccessAdmins.userId })
      .from(groupAccessAdmins)
      .innerJoin(users, eq(users.id, groupAccessAdmins.userId))
      .where(and(eq(groupAccessAdmins.userId, userId), eq(users.status, "active"), isNull(users.removedAt)))
      .limit(1);
    return rows.length > 0;
  }

  /** 手工授权目标必须存在、启用且未离职。 */
  async findActiveGroupAccessUser(userId: string): Promise<GroupAccessAdminUserRecord | null> {
    const rows = await this.database.db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "active"), isNull(users.removedAt)))
      .limit(1);
    return rows[0] === undefined ? null : normalizeAdminUser(rows[0]);
  }

  /** 幂等授予；返回是否实际插入。 */
  async grantGroupAccessAdmin(userId: string, grantedBy: string, at: Date): Promise<boolean> {
    const rows = await this.database.db
      .insert(groupAccessAdmins)
      .values({ userId, grantedBy, createdAt: at })
      .onConflictDoNothing()
      .returning({ userId: groupAccessAdmins.userId });
    return rows.length > 0;
  }

  /** 撤销手工授予；返回是否存在并删除。 */
  async revokeGroupAccessAdmin(userId: string): Promise<boolean> {
    const rows = await this.database.db
      .delete(groupAccessAdmins)
      .where(eq(groupAccessAdmins.userId, userId))
      .returning({ userId: groupAccessAdmins.userId });
    return rows.length > 0;
  }

  // ---------- 群组访问（0068） ----------

  async listUserGroupKeys(userId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ groupKey: userGroupMemberships.groupKey })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.userId, userId));
    return rows.map((row) => row.groupKey);
  }

  /** 给定群组的规则 + selected 项目白名单（多群组由策略层取并集）。 */
  async listGroupAccessRules(groupKeys: readonly string[]): Promise<GroupAccessRuleData[]> {
    if (groupKeys.length === 0) return [];
    const rows = await this.database.db
      .select({
        groupKey: groupAccessRules.groupKey,
        allowedPages: groupAccessRules.allowedPages,
        projectScope: groupAccessRules.projectScope,
        accessLevel: groupAccessRules.accessLevel,
        memberScope: groupAccessRules.memberScope,
        memberUserIds: groupAccessRules.memberUserIds,
      })
      .from(groupAccessRules)
      .where(inArray(groupAccessRules.groupKey, groupKeys));
    const selectedKeys = rows.filter((row) => row.projectScope === "selected").map((row) => row.groupKey);
    const projectIdsByGroup = new Map<string, string[]>();
    if (selectedKeys.length > 0) {
      const mappings = await this.database.db
        .select({ groupKey: projectGroupAccess.groupKey, projectId: projectGroupAccess.projectId })
        .from(projectGroupAccess)
        .where(inArray(projectGroupAccess.groupKey, selectedKeys));
      for (const mapping of mappings) {
        const ids = projectIdsByGroup.get(mapping.groupKey) ?? [];
        ids.push(mapping.projectId);
        projectIdsByGroup.set(mapping.groupKey, ids);
      }
    }
    return rows.map((row) => ({
      groupKey: row.groupKey,
      allowedPages: row.allowedPages as GroupAccessPage[],
      projectScope: row.projectScope as GroupAccessProjectScope,
      accessLevel: row.accessLevel as GroupAccessAccessLevel,
      projectIds: projectIdsByGroup.get(row.groupKey) ?? [],
      memberScope: row.memberScope as GroupAccessMemberScope,
      memberUserIds: row.memberUserIds,
    }));
  }

  /** 权限页通讯录：每个部门的直属人员（含停用账号，供管理员核对目录）。 */
  async listGroupMembers(): Promise<GroupAccessMemberRecord[]> {
    const rows = await this.database.db
      .select({
        groupKey: userGroupMemberships.groupKey,
        groupName: userGroupMemberships.groupName,
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(userGroupMemberships)
      .innerJoin(users, eq(users.id, userGroupMemberships.userId))
      .orderBy(asc(userGroupMemberships.groupKey), asc(users.displayName), asc(users.username));
    return rows.map((row) => ({
      ...row,
      status: row.status === "disabled" ? "disabled" : "active",
    }));
  }

  /** 权限页虚拟「未分组」：当前没有任何部门成员关系的账号（含停用，排除已删除）。 */
  async listUngroupedUsers(): Promise<GroupAccessUserRecord[]> {
    const memberships = this.database.db
      .select({ userId: userGroupMemberships.userId })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.userId, users.id));
    const rows = await this.database.db
      .select({
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(and(isNull(users.removedAt), notExists(memberships)))
      .orderBy(asc(users.displayName), asc(users.username));
    return rows.map((row) => ({
      ...row,
      status: row.status === "disabled" ? "disabled" : "active",
    }));
  }

  /** 规则保存校验：该部门当前直属成员的 user id。 */
  async listGroupMemberIds(groupKey: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ userId: userGroupMemberships.userId })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.groupKey, groupKey));
    return rows.map((row) => row.userId);
  }

  async listAccessRules(): Promise<GroupAccessRuleData[]> {
    const rows = await this.database.db
      .select({
        groupKey: groupAccessRules.groupKey,
        allowedPages: groupAccessRules.allowedPages,
        projectScope: groupAccessRules.projectScope,
        accessLevel: groupAccessRules.accessLevel,
        memberScope: groupAccessRules.memberScope,
        memberUserIds: groupAccessRules.memberUserIds,
      })
      .from(groupAccessRules)
      .orderBy(asc(groupAccessRules.groupKey));
    const mappings = await this.database.db
      .select({ groupKey: projectGroupAccess.groupKey, projectId: projectGroupAccess.projectId })
      .from(projectGroupAccess);
    const projectIdsByGroup = new Map<string, string[]>();
    for (const mapping of mappings) {
      const ids = projectIdsByGroup.get(mapping.groupKey) ?? [];
      ids.push(mapping.projectId);
      projectIdsByGroup.set(mapping.groupKey, ids);
    }
    return rows.map((row) => ({
      groupKey: row.groupKey,
      allowedPages: row.allowedPages as GroupAccessPage[],
      projectScope: row.projectScope as GroupAccessProjectScope,
      accessLevel: row.accessLevel as GroupAccessAccessLevel,
      projectIds: projectIdsByGroup.get(row.groupKey) ?? [],
      memberScope: row.memberScope as GroupAccessMemberScope,
      memberUserIds: row.memberUserIds,
    }));
  }

  async listAccessMemberRules(): Promise<GroupAccessMemberRuleData[]> {
    return this.listAccessMemberRulesBy();
  }

  async listMemberAccessRulesForUser(
    groupKeys: readonly string[],
    userId: string,
  ): Promise<GroupAccessMemberRuleData[]> {
    if (groupKeys.length === 0) return [];
    return this.listAccessMemberRulesBy(groupKeys, userId);
  }

  private async listAccessMemberRulesBy(
    groupKeys?: readonly string[],
    userId?: string,
  ): Promise<GroupAccessMemberRuleData[]> {
    const filters = [];
    const mappingFilters = [];
    if (groupKeys !== undefined) {
      if (groupKeys.length === 0) return [];
      filters.push(inArray(groupAccessMemberRules.groupKey, [...groupKeys]));
      mappingFilters.push(inArray(projectGroupMemberAccess.groupKey, [...groupKeys]));
    }
    if (userId !== undefined) {
      filters.push(eq(groupAccessMemberRules.userId, userId));
      mappingFilters.push(eq(projectGroupMemberAccess.userId, userId));
    }
    const condition = and(...filters);
    const mappingCondition = and(...mappingFilters);
    const ruleQuery = this.database.db
      .select({
        groupKey: groupAccessMemberRules.groupKey,
        userId: groupAccessMemberRules.userId,
        projectScope: groupAccessMemberRules.projectScope,
        accessLevel: groupAccessMemberRules.accessLevel,
        updatedAt: groupAccessMemberRules.updatedAt,
      })
      .from(groupAccessMemberRules)
      .orderBy(asc(groupAccessMemberRules.groupKey), asc(groupAccessMemberRules.userId));
    const mappingQuery = this.database.db
      .select({
        groupKey: projectGroupMemberAccess.groupKey,
        userId: projectGroupMemberAccess.userId,
        projectId: projectGroupMemberAccess.projectId,
      })
      .from(projectGroupMemberAccess);
    const [rows, mappings] = await Promise.all([
      condition === undefined ? ruleQuery : ruleQuery.where(condition),
      mappingCondition === undefined ? mappingQuery : mappingQuery.where(mappingCondition),
    ]);
    const projectIdsByMember = new Map<string, string[]>();
    for (const mapping of mappings) {
      const key = mapping.groupKey + "\u0000" + mapping.userId;
      const ids = projectIdsByMember.get(key) ?? [];
      ids.push(mapping.projectId);
      projectIdsByMember.set(key, ids);
    }
    return rows.map((row) => ({
      groupKey: row.groupKey,
      userId: row.userId,
      projectScope: row.projectScope as GroupAccessProjectScope,
      accessLevel: row.accessLevel as GroupAccessAccessLevel,
      projectIds: projectIdsByMember.get(row.groupKey + "\u0000" + row.userId) ?? [],
      updatedAt: row.updatedAt,
    }));
  }

  async listExistingMemberRuleUserIds(
    groupKey: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.database.db
      .select({ userId: groupAccessMemberRules.userId })
      .from(groupAccessMemberRules)
      .where(and(
        eq(groupAccessMemberRules.groupKey, groupKey),
        inArray(groupAccessMemberRules.userId, [...userIds]),
      ));
    return rows.map((row) => row.userId);
  }

  async upsertGroupAccessMemberRules(
    groupKey: string,
    userIds: readonly string[],
    projectScope: GroupAccessProjectScope,
    accessLevel: GroupAccessAccessLevel,
    projectIds: readonly string[],
    at: Date,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(groupAccessMemberRules)
        .values(userIds.map((userId) => ({
          groupKey,
          userId,
          projectScope,
          accessLevel,
          updatedAt: at,
        })))
        .onConflictDoUpdate({
          target: [groupAccessMemberRules.groupKey, groupAccessMemberRules.userId],
          set: { projectScope, accessLevel, updatedAt: at },
        });
      await tx.delete(projectGroupMemberAccess).where(and(
        eq(projectGroupMemberAccess.groupKey, groupKey),
        inArray(projectGroupMemberAccess.userId, [...userIds]),
      ));
      if (projectScope === "selected" && projectIds.length > 0) {
        await tx.insert(projectGroupMemberAccess).values(
          userIds.flatMap((userId) => projectIds.map((projectId) => ({ projectId, groupKey, userId }))),
        );
      }
    });
  }

  async deleteGroupAccessMemberRules(groupKey: string, userIds: readonly string[]): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      await tx.delete(projectGroupMemberAccess).where(and(
        eq(projectGroupMemberAccess.groupKey, groupKey),
        inArray(projectGroupMemberAccess.userId, [...userIds]),
      ));
      const deleted = await tx
        .delete(groupAccessMemberRules)
        .where(and(
          eq(groupAccessMemberRules.groupKey, groupKey),
          inArray(groupAccessMemberRules.userId, [...userIds]),
        ))
        .returning({ userId: groupAccessMemberRules.userId });
      return deleted.length;
    });
  }

  async listAccessProjects(): Promise<Array<{ id: string; code: string; name: string }>> {
    return this.database.db
      .select({ id: projects.id, code: projects.code, name: projects.name })
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(asc(projects.code));
  }

  async listExistingProjectIds(projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.database.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)));
    return rows.map((row) => row.id);
  }

  async upsertGroupAccessRule(
    groupKey: string,
    groupName: string,
    allowedPages: readonly GroupAccessPage[],
    projectScope: GroupAccessProjectScope,
    accessLevel: GroupAccessAccessLevel,
    projectIds: readonly string[],
    memberScope: GroupAccessMemberScope,
    memberUserIds: readonly string[],
    at: Date,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(groupAccessRules)
        .values({
          groupKey,
          groupName,
          allowedPages: [...allowedPages],
          projectScope,
          accessLevel,
          memberScope,
          memberUserIds: [...memberUserIds],
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: groupAccessRules.groupKey,
          set: {
            groupName,
            allowedPages: [...allowedPages],
            projectScope,
            accessLevel,
            memberScope,
            memberUserIds: [...memberUserIds],
            updatedAt: at,
          },
        });
      await tx.delete(projectGroupAccess).where(eq(projectGroupAccess.groupKey, groupKey));
      if (projectScope === "selected" && projectIds.length > 0) {
        await tx.insert(projectGroupAccess).values(projectIds.map((projectId) => ({ projectId, groupKey })));
      }
    });
  }

  async deleteGroupAccessRule(groupKey: string): Promise<boolean> {
    const deleted = await this.database.db
      .delete(groupAccessRules)
      .where(eq(groupAccessRules.groupKey, groupKey))
      .returning({ groupKey: groupAccessRules.groupKey });
    return deleted.length > 0;
  }

  async findGroupAccessRule(groupKey: string): Promise<GroupAccessRuleData | null> {
    const rows = await this.listGroupAccessRules([groupKey]);
    return rows[0] ?? null;
  }

  async findRuleMetadata(groupKey: string): Promise<{ groupName: string; updatedAt: Date } | null> {
    const rows = await this.database.db
      .select({ groupName: groupAccessRules.groupName, updatedAt: groupAccessRules.updatedAt })
      .from(groupAccessRules)
      .where(eq(groupAccessRules.groupKey, groupKey))
      .limit(1);
    return rows[0] ?? null;
  }
}

function normalizeAdminUser(row: Omit<GroupAccessAdminUserRecord, "status"> & { status: string }): GroupAccessAdminUserRecord {
  return {
    ...row,
    status: row.status === "disabled" ? "disabled" : "active",
  };
}
