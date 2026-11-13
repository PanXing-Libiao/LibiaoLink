import { Injectable } from "@nestjs/common";
import {
  GROUP_ACCESS_PAGE_KEYS,
  GROUP_ACCESS_UNGROUPED_KEY,
  GROUP_ACCESS_UNGROUPED_NAME,
  type GroupAccessAdmin,
  type GroupAccessAdminResponse,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessMemberRule,
  type GroupAccessMemberRuleDeleteInput,
  type GroupAccessMemberRuleInput,
  type GroupAccessMemberRuleResponse,
  type GroupAccessOverview,
  type GroupAccessRule,
  type GroupAccessRuleInput,
  type GroupAccessRuleResponse,
  type GroupAccessScopePermission,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { AuditService } from "../audit/index.js";
import { casdoorGroupKey, casdoorGroupName, DepartmentService } from "../identity/index.js";
import {
  mergeScopePermissions,
  normalizeScopePermissions,
  parseGroupAccessAdminKeys,
  summarizeScopePermissions,
  type GroupAccessMemberRuleData,
  type GroupAccessRuleData,
} from "./group-access.rules.js";
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
    const { directory, activeGroupKeys } = await this.activeDirectory();
    const [memberships, ungroupedUsers, rules, memberRules, projects, automaticRoles, groupAccess, admins] = await Promise.all([
      this.repository.listGroupMembers(),
      this.repository.listUngroupedUsers([...activeGroupKeys]),
      this.repository.listAccessRules(),
      this.repository.listAccessMemberRules(),
      this.repository.listAccessProjects(),
      this.repository.listAutomaticProjectRoles(),
      this.permission.groupAccessOf(actorId),
      this.listAdmins(),
    ]);
    const effectiveRules = rules.filter(
      (rule) => activeGroupKeys.has(rule.groupKey) || rule.groupKey === GROUP_ACCESS_UNGROUPED_KEY,
    );
    const metadata = new Map(
      await Promise.all(
        effectiveRules.map(async (rule) => {
          const meta = await this.repository.findRuleMetadata(rule.groupKey);
          return [rule.groupKey, meta] as const;
        }),
      ),
    );
    const membersByKey = new Map<string, GroupAccessMember[]>();
    const memberRulesByKey = new Map<string, GroupAccessMemberRule[]>();
    for (const memberRule of memberRules) {
      if (!activeGroupKeys.has(memberRule.groupKey)) continue;
      const list = memberRulesByKey.get(memberRule.groupKey) ?? [];
      list.push(toMemberRule(memberRule, memberRule.updatedAt ?? new Date(0)));
      memberRulesByKey.set(memberRule.groupKey, list);
    }
    for (const membership of memberships) {
      if (!activeGroupKeys.has(membership.groupKey)) continue;
      const members = membersByKey.get(membership.groupKey) ?? [];
      members.push({
        userId: membership.userId,
        username: membership.username,
        displayName: membership.displayName,
        email: membership.email,
        status: membership.status,
      });
      membersByKey.set(membership.groupKey, members);
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
        memberRules: memberRulesByKey.get(groupKey) ?? [],
        rule: null,
      });
    }
    if (ungroupedUsers.length > 0) {
      const members: GroupAccessMember[] = ungroupedUsers.map((user) => ({
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
      }));
      groups.set(GROUP_ACCESS_UNGROUPED_KEY, {
        groupKey: GROUP_ACCESS_UNGROUPED_KEY,
        groupName: GROUP_ACCESS_UNGROUPED_NAME,
        parentGroupKey: null,
        memberCount: members.length,
        members,
        memberRules: memberRulesByKey.get(GROUP_ACCESS_UNGROUPED_KEY) ?? [],
        rule: null,
      });
    }
    for (const rule of effectiveRules) {
      const meta = metadata.get(rule.groupKey) ?? null;
      const current = groups.get(rule.groupKey);
      groups.set(rule.groupKey, {
        groupKey: rule.groupKey,
        groupName: meta?.groupName ?? current?.groupName ?? casdoorGroupName(rule.groupKey),
        parentGroupKey: current?.parentGroupKey ?? null,
        memberCount: current?.memberCount ?? 0,
        members: current?.members ?? [],
        memberRules: current?.memberRules ?? memberRulesByKey.get(rule.groupKey) ?? [],
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
      automaticRoles,
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
      throw new AppError("VALIDATION_FAILED", "环境配置的管理员不能在此撤销");
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

  private async activeDirectory(): Promise<{
    directory: Awaited<ReturnType<DepartmentService["listDepartments"]>>;
    activeGroupKeys: Set<string>;
  }> {
    const directory = await this.departments.listDepartments();
    const activeGroupKeys = new Set<string>();
    for (const department of directory) {
      if (department.sourceId === null) continue;
      const groupKey = casdoorGroupKey(this.config.env.CASDOOR_ORG_NAME, department.sourceId);
      if (groupKey !== "") activeGroupKeys.add(groupKey);
    }
    return { directory, activeGroupKeys };
  }

  /** 系统管理员名单：候选 / 资格校验与权限管理页共用同一口径。 */
  async listAdmins(): Promise<GroupAccessAdmin[]> {
    const configuredGroupKeys = parseGroupAccessAdminKeys(this.config.env.GROUP_ACCESS_ADMIN_GROUP_KEYS ?? "");
    const configuredUserIds = parseGroupAccessAdminKeys(this.config.env.GROUP_ACCESS_ADMIN_USER_IDS ?? "");
    let effectiveGroupKeys: string[] = [];
    if (configuredGroupKeys.length > 0) {
      const { activeGroupKeys } = await this.activeDirectory();
      effectiveGroupKeys = configuredGroupKeys.filter((groupKey) => activeGroupKeys.has(groupKey));
    }
    const [configuredUsers, groupUsers, manualAdmins] = await Promise.all([
      this.repository.listActiveUsersByIds(configuredUserIds),
      this.repository.listGroupAdminUsersByGroupKeys(effectiveGroupKeys),
      this.repository.listManualGroupAccessAdmins(),
    ]);
    const admins = new Map<string, GroupAccessAdmin>();
    const put = (user: { userId: string; username: string; displayName: string; email: string | null; status: "active" | "disabled" }, source: "manual" | "configured"): void => {
      const rank = { manual: 0, configured: 2 } as const;
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
    for (const user of groupUsers) put(user, "configured");
    for (const user of configuredUsers) put(user, "configured");
    return [...admins.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-Hans-CN") || left.username.localeCompare(right.username),
    );
  }

  async save(actorId: string, input: GroupAccessRuleInput): Promise<GroupAccessRuleResponse> {
    await this.assertAdmin(actorId);
    const before = await this.repository.findRuleMetadata(input.groupKey);
    const scopePermissions = normalizeScopePermissions(input.scopePermissions, input.projectScope, input.accessLevel);
    const summary = summarizeScopePermissions(scopePermissions);
    const hasSelected = scopePermissions.some((permission) => permission.projectScope === "selected");
    const projectIds = hasSelected ? Array.from(new Set(input.projectIds)) : [];
    if (projectIds.length > 0) {
      const existing = await this.repository.listExistingProjectIds(projectIds);
      if (existing.length !== projectIds.length) {
        throw new AppError("VALIDATION_FAILED", "项目不存在或已进入回收站，请刷新后重新选择");
      }
    }
    const memberUserIds = input.memberScope === "selected" ? Array.from(new Set(input.memberUserIds)) : [];
    if (memberUserIds.length > 0) {
      const currentMemberIds = new Set(
        input.groupKey === GROUP_ACCESS_UNGROUPED_KEY
          ? (await this.repository.listUngroupedUsers()).map((user) => user.userId)
          : await this.repository.listGroupMemberIds(input.groupKey),
      );
      const unknownMemberIds = memberUserIds.filter((userId) => !currentMemberIds.has(userId));
      if (unknownMemberIds.length > 0) {
        throw new AppError("VALIDATION_FAILED", "所选人员已不在该部门，请刷新后重新选择");
      }
    }
    const groupName = await this.resolveGroupName(input.groupKey, input.groupName ?? before?.groupName ?? null);
    const permissionText = await this.describeScopePermissions(scopePermissions, projectIds);
    const grantText = scopePermissions.length === 0 ? "不显示项目数据" : "赋予" + permissionText;
    const allowedPages = [...GROUP_ACCESS_PAGE_KEYS];
    const at = new Date();
    await this.repository.upsertGroupAccessRule(
      input.groupKey,
      groupName,
      allowedPages,
      scopePermissions,
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
      summary: (before === null ? "新增" : "修改") + groupName + "默认权限（部门全体成员）；" + grantText,
      metadata: {
        groupKey: input.groupKey,
        groupName,
        allowedPages,
        scopePermissions,
        permissionText,
        projectScope: summary.projectScope,
        accessLevel: summary.accessLevel,
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
        scopePermissions,
        projectScope: summary.projectScope,
        accessLevel: summary.accessLevel,
        projectIds,
        memberScope: input.memberScope,
        memberUserIds,
        updatedAt: at.toISOString(),
      },
    };
  }

  async saveMemberRules(
    actorId: string,
    input: GroupAccessMemberRuleInput,
  ): Promise<GroupAccessMemberRuleResponse> {
    await this.assertAdmin(actorId);
    const userIds = Array.from(new Set(input.userIds));
    const scopePermissions = normalizeScopePermissions(input.scopePermissions, input.projectScope, input.accessLevel);
    const summary = summarizeScopePermissions(scopePermissions);
    const hasSelected = scopePermissions.some((permission) => permission.projectScope === "selected");
    const projectIds = hasSelected ? Array.from(new Set(input.projectIds)) : [];
    if (projectIds.length > 0) {
      const existing = await this.repository.listExistingProjectIds(projectIds);
      if (existing.length !== projectIds.length) {
        throw new AppError("VALIDATION_FAILED", "项目不存在或已进入回收站，请刷新后重新选择");
      }
    }
    const currentMemberIds = new Set(
      input.groupKey === GROUP_ACCESS_UNGROUPED_KEY
        ? (await this.repository.listUngroupedUsers()).map((user) => user.userId)
        : await this.repository.listGroupMemberIds(input.groupKey),
    );
    const unknownMemberIds = userIds.filter((userId) => !currentMemberIds.has(userId));
    if (unknownMemberIds.length > 0) {
      throw new AppError("VALIDATION_FAILED", "所选人员已不在该部门，请刷新后重新选择");
    }
    const fallbackGroupName = input.groupName ?? (await this.repository.findRuleMetadata(input.groupKey))?.groupName ?? null;
    const groupName = await this.resolveGroupName(input.groupKey, fallbackGroupName);
    const memberUsers = await this.repository.listUsersByIds(userIds);
    const memberText = describeUsers(memberUsers, userIds);
    const permissionText = await this.describeScopePermissions(scopePermissions, projectIds);
    const grantText = scopePermissions.length === 0 ? "不显示项目数据" : "赋予" + permissionText;
    const existingUserIds = await this.repository.listExistingMemberRuleUserIds(input.groupKey, userIds);
    const at = new Date();
    await this.repository.upsertGroupAccessMemberRules(
      input.groupKey,
      userIds,
      scopePermissions,
      projectIds,
      at,
    );
    await this.audit.recordStandalone({
      actorId,
      action: existingUserIds.length === 0 ? "create" : "update",
      objectType: "group_access_rule",
      objectId: input.groupKey,
      summary: (existingUserIds.length === 0 ? "新增" : "修改") + groupName + "个人权限：" + memberText + "；" + grantText,
      metadata: {
        groupKey: input.groupKey,
        groupName,
        userIds,
        memberNames: memberUsers.map((user) => ({ userId: user.userId, displayName: user.displayName, username: user.username })),
        scopePermissions,
        permissionText,
        projectScope: summary.projectScope,
        accessLevel: summary.accessLevel,
        projectIds,
        target: "member",
      },
    });
    this.permission.invalidate();
    return {
      rules: userIds.map((userId) => ({
        groupKey: input.groupKey,
        userId,
        scopePermissions,
        projectScope: summary.projectScope,
        accessLevel: summary.accessLevel,
        projectIds,
        updatedAt: at.toISOString(),
      })),
    };
  }

  async removeMemberRules(actorId: string, input: GroupAccessMemberRuleDeleteInput): Promise<void> {
    await this.assertAdmin(actorId);
    const userIds = Array.from(new Set(input.userIds));
    const fallbackGroupName = input.groupName ?? (await this.repository.findRuleMetadata(input.groupKey))?.groupName ?? null;
    const groupName = await this.resolveGroupName(input.groupKey, fallbackGroupName);
    const existingUserIds = await this.repository.listExistingMemberRuleUserIds(input.groupKey, userIds);
    const targetUserIds = existingUserIds.length > 0 ? existingUserIds : userIds;
    const memberUsers = await this.repository.listUsersByIds(targetUserIds);
    const memberText = describeUsers(memberUsers, targetUserIds);
    const deleted = await this.repository.deleteGroupAccessMemberRules(input.groupKey, userIds);
    if (deleted === 0) throw new AppError("NOT_FOUND", "所选人员没有个人权限规则");
    await this.audit.recordStandalone({
      actorId,
      action: "delete",
      objectType: "group_access_rule",
      objectId: input.groupKey,
      summary: "删除" + groupName + "个人权限：" + memberText + "；恢复继承部门默认权限",
      metadata: {
        groupKey: input.groupKey,
        groupName,
        userIds: targetUserIds,
        memberNames: memberUsers.map((user) => ({ userId: user.userId, displayName: user.displayName, username: user.username })),
        target: "member",
      },
    });
    this.permission.invalidate();
  }

  async remove(actorId: string, groupKey: string): Promise<void> {
    await this.assertAdmin(actorId);
    const [before, metadata] = await Promise.all([
      this.repository.findGroupAccessRule(groupKey),
      this.repository.findRuleMetadata(groupKey),
    ]);
    if (before === null) throw new AppError("NOT_FOUND", "部门访问规则不存在");
    const groupName = await this.resolveGroupName(groupKey, metadata?.groupName ?? null);
    const permissionText = await this.describeScopePermissions(before.scopePermissions, before.projectIds);
    let memberText = "部门全体成员";
    let memberUsers: Awaited<ReturnType<PermissionRepository["listUsersByIds"]>> = [];
    if (before.memberScope === "selected") {
      memberUsers = await this.repository.listUsersByIds(before.memberUserIds);
      memberText = before.memberUserIds.length === 0
        ? "指定成员（未选择人员）"
        : "指定成员：" + describeUsers(memberUsers, before.memberUserIds);
    }
    await this.repository.deleteGroupAccessRule(groupKey);
    await this.audit.recordStandalone({
      actorId,
      action: "delete",
      objectType: "group_access_rule",
      objectId: groupKey,
      summary: "删除" + groupName + "默认权限（" + memberText + "）；移除权限：" + (permissionText === "" ? "不显示项目数据" : permissionText),
      metadata: {
        groupKey,
        groupName,
        memberScope: before.memberScope,
        memberUserIds: before.memberUserIds,
        memberNames: memberUsers.map((user) => ({ userId: user.userId, displayName: user.displayName, username: user.username })),
        scopePermissions: before.scopePermissions,
        permissionText,
        projectIds: before.projectIds,
      },
    });
    this.permission.invalidate();
  }

  private async resolveGroupName(groupKey: string, fallback: string | null): Promise<string> {
    if (groupKey === GROUP_ACCESS_UNGROUPED_KEY) return GROUP_ACCESS_UNGROUPED_NAME;
    const departments = await this.departments.listDepartments({ includeDisabled: true });
    const owner = this.config.env.CASDOOR_ORG_NAME;
    const matched = departments.find((department) => {
      const sourceId = department.sourceId;
      return sourceId !== null && (sourceId === groupKey || casdoorGroupKey(owner, sourceId) === groupKey);
    });
    if (matched !== undefined) return matched.name;
    const fallbackText = fallback?.trim() ?? "";
    if (fallbackText !== "") return fallbackText;
    return casdoorGroupName(groupKey) || groupKey;
  }

  private async describeScopePermissions(
    scopePermissions: readonly GroupAccessScopePermission[],
    projectIds: readonly string[],
  ): Promise<string> {
    const normalized = mergeScopePermissions(scopePermissions);
    if (normalized.length === 0) return "";
    const selectedProjectIds = Array.from(new Set(projectIds));
    const projectTextById = new Map<string, string>();
    if (normalized.some((permission) => permission.projectScope === "selected") && selectedProjectIds.length > 0) {
      const projects = await this.repository.listAccessProjects();
      for (const project of projects) projectTextById.set(project.id, project.name + "（" + project.code + "）");
    }
    return normalized.map((permission) => {
      const level = permission.accessLevel === "edit" ? "编辑 / 浏览" : "仅浏览";
      if (permission.projectScope === "selected") {
        const projectText = selectedProjectIds.map((projectId) => projectTextById.get(projectId) ?? "未知项目").join("、");
        return "指定项目：" + level + (projectText === "" ? "（未选择项目）" : "（" + projectText + "）");
      }
      const scope = permission.projectScope === "all" ? "全部项目" : "仅限自己的项目";
      return scope + "：" + level;
    }).join("；");
  }

  private async assertAdmin(actorId: string): Promise<void> {
    if (await this.permission.canManageGroupAccess(actorId)) return;
    throw new AppError("FORBIDDEN", "仅部门权限管理员可以管理编辑 / 仅浏览权限");
  }
}

function describeUsers(
  users: ReadonlyArray<{ userId: string; username: string; displayName: string }>,
  userIds: readonly string[],
): string {
  const byId = new Map(users.map((user) => [user.userId, user]));
  return userIds.map((userId) => {
    const user = byId.get(userId);
    if (user === undefined) return "未知成员";
    const displayName = user.displayName.trim();
    const username = user.username.trim();
    const label = displayName !== "" ? displayName : username !== "" ? username : "未知成员";
    return username !== "" && username !== label ? label + "（" + username + "）" : label;
  }).join("、");
}

function toMemberRule(rule: GroupAccessMemberRuleData, updatedAt: Date): GroupAccessMemberRule {
  const scopePermissions = mergeScopePermissions(rule.scopePermissions);
  const summary = summarizeScopePermissions(scopePermissions);
  return {
    groupKey: rule.groupKey,
    userId: rule.userId,
    scopePermissions,
    projectScope: summary.projectScope,
    accessLevel: summary.accessLevel,
    projectIds: [...rule.projectIds],
    updatedAt: updatedAt.toISOString(),
  };
}

function toRule(rule: GroupAccessRuleData, groupName: string, updatedAt: Date): GroupAccessRule {
  const scopePermissions = mergeScopePermissions(rule.scopePermissions);
  const summary = summarizeScopePermissions(scopePermissions);
  return {
    groupKey: rule.groupKey,
    groupName,
    allowedPages: [...GROUP_ACCESS_PAGE_KEYS],
    scopePermissions,
    projectScope: summary.projectScope,
    accessLevel: summary.accessLevel,
    projectIds: rule.projectIds,
    memberScope: rule.memberScope,
    memberUserIds: rule.memberUserIds,
    updatedAt: updatedAt.toISOString(),
  };
}
