import { Injectable } from "@nestjs/common";
import {
  GROUP_ACCESS_PAGE_KEYS,
  type GroupAccessAdmin,
  type GroupAccessAdminResponse,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessOverview,
  type GroupAccessRule,
  type GroupAccessRuleInput,
  type GroupAccessRuleResponse,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { AuditService } from "../audit/index.js";
import { casdoorGroupKey, casdoorGroupName, DepartmentService } from "../identity/index.js";
import { parseGroupAccessAdminKeys, type GroupAccessRuleData } from "./group-access.rules.js";
import { PermissionRepository } from "./permission.repository.js";
import { PermissionService } from "./permission.service.js";

/** 群组权限管理用例：读取群组目录 + 规则，保存 / 删除规则并写审计。 */
@Injectable()
export class GroupAccessService {
  constructor(
    private readonly permission: PermissionService,
    private readonly repository: PermissionRepository,
    private readonly audit: AuditService,
    private readonly departments: DepartmentService,
    private readonly config: AppConfig,
  ) {}

  async overview(actorId: string): Promise<GroupAccessOverview> {
    await this.assertAdmin(actorId);
    const [memberships, directory, rules, projects, groupAccess, admins] = await Promise.all([
      this.repository.listGroupMembers(),
      this.departments.listDepartments(),
      this.repository.listAccessRules(),
      this.repository.listAccessProjects(),
      this.permission.groupAccessOf(actorId),
      this.listAdmins(),
    ]);
    const metadata = new Map(
      await Promise.all(
        rules.map(async (rule) => {
          const meta = await this.repository.findRuleMetadata(rule.groupKey);
          return [rule.groupKey, meta] as const;
        }),
      ),
    );
    const membersByKey = new Map<string, GroupAccessMember[]>();
    const membershipNameByKey = new Map<string, string>();
    for (const membership of memberships) {
      const members = membersByKey.get(membership.groupKey) ?? [];
      members.push({
        userId: membership.userId,
        username: membership.username,
        displayName: membership.displayName,
        email: membership.email,
        status: membership.status,
      });
      membersByKey.set(membership.groupKey, members);
      if (!membershipNameByKey.has(membership.groupKey)) {
        membershipNameByKey.set(membership.groupKey, membership.groupName);
      }
    }
    const sourceIdByDepartmentId = new Map<string, string>();
    for (const department of directory) {
      if (department.sourceId !== null) sourceIdByDepartmentId.set(department.id, department.sourceId);
    }
    const groups = new Map<string, GroupAccessGroup>();
    for (const department of directory) {
      if (department.sourceId === null) continue;
      const groupKey = casdoorGroupKey(this.config.env.CASDOOR_ORG_NAME, department.sourceId);
      if (groupKey === "") continue;
      const parentSourceId =
        department.parentId === null ? null : sourceIdByDepartmentId.get(department.parentId) ?? null;
      const parentGroupKey =
        parentSourceId === null ? null : casdoorGroupKey(this.config.env.CASDOOR_ORG_NAME, parentSourceId) || null;
      const members = membersByKey.get(groupKey) ?? [];
      groups.set(groupKey, {
        groupKey,
        groupName: department.name,
        parentGroupKey,
        memberCount: members.length,
        members,
        rule: null,
      });
    }
    for (const [groupKey, members] of membersByKey) {
      if (groups.has(groupKey)) continue;
      groups.set(groupKey, {
        groupKey,
        groupName: membershipNameByKey.get(groupKey) ?? casdoorGroupName(groupKey),
        parentGroupKey: null,
        memberCount: members.length,
        members,
        rule: null,
      });
    }
    for (const rule of rules) {
      const meta = metadata.get(rule.groupKey) ?? null;
      const current = groups.get(rule.groupKey);
      groups.set(rule.groupKey, {
        groupKey: rule.groupKey,
        groupName: meta?.groupName ?? current?.groupName ?? casdoorGroupName(rule.groupKey),
        parentGroupKey: current?.parentGroupKey ?? null,
        memberCount: current?.memberCount ?? 0,
        members: current?.members ?? [],
        rule: toRule(
          rule,
          meta?.groupName ?? current?.groupName ?? casdoorGroupName(rule.groupKey),
          meta?.updatedAt ?? new Date(0),
        ),
      });
    }
    return {
      enforced: groupAccess.enforced,
      admin: groupAccess.admin,
      currentGroupKeys: groupAccess.groupKeys,
      admins,
      groups: Array.from(groups.values()).sort((left, right) => left.groupKey.localeCompare(right.groupKey)),
      projects,
    };
  }

  async assignAdmin(actorId: string, userId: string): Promise<GroupAccessAdminResponse> {
    await this.assertAdmin(actorId);
    const user = await this.repository.findActiveGroupAccessUser(userId);
    if (user === null) throw new AppError("NOT_FOUND", "用户不存在、已停用或已离职");
    const existing = (await this.listAdmins()).find((admin) => admin.userId === userId);
    if (existing !== undefined && existing.source !== "manual") return { admin: existing };
    const at = new Date();
    const inserted = await this.repository.grantGroupAccessAdmin(userId, actorId, at);
    if (inserted) {
      await this.audit.recordStandalone({
        actorId,
        action: "create",
        objectType: "group_access_admin",
        objectId: userId,
        summary: "新增系统管理员：" + user.displayName + "（" + user.username + "）",
        metadata: { userId, source: "manual" },
      });
    }
    this.permission.invalidate();
    const admin = (await this.listAdmins()).find((item) => item.userId === userId);
    if (admin === undefined) throw new AppError("INTERNAL", "系统管理员授权后未能读取名单");
    return { admin };
  }

  async removeAdmin(actorId: string, userId: string): Promise<void> {
    await this.assertAdmin(actorId);
    const admins = await this.listAdmins();
    const target = admins.find((admin) => admin.userId === userId);
    if (target === undefined) throw new AppError("NOT_FOUND", "该账号不是系统管理员");
    if (!target.removable) {
      throw new AppError("VALIDATION_FAILED", "环境配置或角色授权的管理员不能在此撤销");
    }
    if (admins.length <= 1) {
      throw new AppError("VALIDATION_FAILED", "至少需要保留一名系统管理员");
    }
    const removed = await this.repository.revokeGroupAccessAdmin(userId);
    if (!removed) throw new AppError("NOT_FOUND", "该账号不是手工添加的系统管理员");
    await this.audit.recordStandalone({
      actorId,
      action: "delete",
      objectType: "group_access_admin",
      objectId: userId,
      summary: "移除系统管理员：" + target.displayName + "（" + target.username + "）",
      metadata: { userId, source: "manual" },
    });
    this.permission.invalidate();
  }

  private async listAdmins(): Promise<GroupAccessAdmin[]> {
    const configuredGroupKeys = parseGroupAccessAdminKeys(this.config.env.GROUP_ACCESS_ADMIN_GROUP_KEYS ?? "");
    const configuredUserIds = parseGroupAccessAdminKeys(this.config.env.GROUP_ACCESS_ADMIN_USER_IDS ?? "");
    const roleAdmins = this.config.env.PERMISSION_ENFORCED === "true"
      ? this.repository.listRoleGroupAccessAdmins()
      : Promise.resolve([]);
    const [configuredUsers, groupUsers, manualAdmins, roleUsers] = await Promise.all([
      this.repository.listActiveUsersByIds(configuredUserIds),
      this.repository.listGroupAdminUsersByGroupKeys(configuredGroupKeys),
      this.repository.listManualGroupAccessAdmins(),
      roleAdmins,
    ]);
    const admins = new Map<string, GroupAccessAdmin>();
    const put = (user: { userId: string; username: string; displayName: string; email: string | null; status: "active" | "disabled" }, source: GroupAccessAdmin["source"]): void => {
      const rank = { manual: 0, role: 1, configured: 2 } as const;
      const current = admins.get(user.userId);
      if (current !== undefined && rank[current.source] > rank[source]) return;
      admins.set(user.userId, {
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
        source,
        removable: source === "manual",
      });
    };
    for (const user of manualAdmins) put(user, "manual");
    for (const user of roleUsers) put(user, "role");
    for (const user of groupUsers) put(user, "configured");
    for (const user of configuredUsers) put(user, "configured");
    return [...admins.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-Hans-CN") || left.username.localeCompare(right.username),
    );
  }

  async save(actorId: string, input: GroupAccessRuleInput): Promise<GroupAccessRuleResponse> {
    await this.assertAdmin(actorId);
    const before = await this.repository.findRuleMetadata(input.groupKey);
    const accessLevel = input.projectScope === "none" ? "view" : input.accessLevel;
    const projectIds = input.projectScope === "selected" ? Array.from(new Set(input.projectIds)) : [];
    if (projectIds.length > 0) {
      const existing = await this.repository.listExistingProjectIds(projectIds);
      if (existing.length !== projectIds.length) {
        throw new AppError("VALIDATION_FAILED", "项目不存在或已进入回收站，请刷新后重新选择");
      }
    }
    const memberUserIds = input.memberScope === "selected" ? Array.from(new Set(input.memberUserIds)) : [];
    if (memberUserIds.length > 0) {
      const currentMemberIds = new Set(await this.repository.listGroupMemberIds(input.groupKey));
      const unknownMemberIds = memberUserIds.filter((userId) => !currentMemberIds.has(userId));
      if (unknownMemberIds.length > 0) {
        throw new AppError("VALIDATION_FAILED", "所选人员已不在该部门，请刷新后重新选择");
      }
    }
    const groupName = input.groupName ?? before?.groupName ?? casdoorGroupName(input.groupKey) ?? input.groupKey;
    const allowedPages = [...GROUP_ACCESS_PAGE_KEYS];
    const at = new Date();
    await this.repository.upsertGroupAccessRule(
      input.groupKey,
      groupName,
      allowedPages,
      input.projectScope,
      accessLevel,
      projectIds,
      input.memberScope,
      memberUserIds,
      at,
    );
    await this.audit.recordStandalone({
      actorId,
      action: before === null ? "create" : "update",
      objectType: "group_access_rule",
      objectId: input.groupKey,
      summary: (before === null ? "新增" : "修改") + "群组访问规则：" + groupName + "（" + input.groupKey + "）",
      metadata: {
        groupKey: input.groupKey,
        allowedPages,
        projectScope: input.projectScope,
        accessLevel,
        projectIds,
        memberScope: input.memberScope,
        memberUserIds,
      },
    });
    this.permission.invalidate();
    return {
      rule: {
        groupKey: input.groupKey,
        groupName,
        allowedPages,
        projectScope: input.projectScope,
        accessLevel,
        projectIds,
        memberScope: input.memberScope,
        memberUserIds,
        updatedAt: at.toISOString(),
      },
    };
  }

  async remove(actorId: string, groupKey: string): Promise<void> {
    await this.assertAdmin(actorId);
    const before = await this.repository.findRuleMetadata(groupKey);
    if (before === null) throw new AppError("NOT_FOUND", "部门访问规则不存在");
    await this.repository.deleteGroupAccessRule(groupKey);
    await this.audit.recordStandalone({
      actorId,
      action: "delete",
      objectType: "group_access_rule",
      objectId: groupKey,
      summary: "删除部门访问规则：" + before.groupName + "（" + groupKey + "）",
      metadata: { groupKey },
    });
    this.permission.invalidate();
  }

  private async assertAdmin(actorId: string): Promise<void> {
    if (await this.permission.canManageGroupAccess(actorId)) return;
    throw new AppError("FORBIDDEN", "仅部门权限管理员可以管理编辑 / 仅浏览权限");
  }
}

function toRule(rule: GroupAccessRuleData, groupName: string, updatedAt: Date): GroupAccessRule {
  return {
    groupKey: rule.groupKey,
    groupName,
    allowedPages: [...GROUP_ACCESS_PAGE_KEYS],
    projectScope: rule.projectScope,
    accessLevel: rule.accessLevel,
    projectIds: rule.projectIds,
    memberScope: rule.memberScope,
    memberUserIds: rule.memberUserIds,
    updatedAt: updatedAt.toISOString(),
  };
}
