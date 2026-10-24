import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
  GroupAccessMemberScope,
  GroupAccessPage,
  GroupAccessProjectScope,
} from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import { groupAccessRules, projectGroupAccess, userGroupMemberships } from "../../db/schema/access.js";
import { users } from "../../db/schema/identity.js";
import { projectNodes } from "../../db/schema/flow.js";
import { projectMembers, projects } from "../../db/schema/projects.js";
import type { GroupAccessRuleData } from "./group-access.rules.js";
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

/** 权限页部门人员：直属成员 + 用户展示字段。 */
export interface GroupAccessMemberRecord {
  groupKey: string;
  groupName: string;
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
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
      projectIds: projectIdsByGroup.get(row.groupKey) ?? [],
      memberScope: row.memberScope as GroupAccessMemberScope,
      memberUserIds: row.memberUserIds,
    }));
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
