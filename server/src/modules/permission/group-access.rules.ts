import {
  GROUP_ACCESS_DATA_PROJECT_SCOPES,
  GROUP_ACCESS_PAGE_KEYS,
  type GroupAccessAccessLevel,
  type GroupAccessMemberScope,
  type GroupAccessPage,
  type GroupAccessProjectScope,
  type GroupAccessScopePermission,
} from "@libiaolink/contracts";

/** 仓储读出的规则形状（项目 id 已按 selected 规则展开）。 */
export interface GroupAccessRuleData {
  groupKey: string;
  allowedPages: GroupAccessPage[];
  /** 新裁决口径：all / own / selected 可同时存在，每个范围独立编辑 / 仅浏览；空数组 = 不显示项目数据。 */
  scopePermissions: GroupAccessScopePermission[];
  /** 旧列保留为兼容摘要；新裁决只读 scopePermissions。 */
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  projectIds: string[];
  memberScope: GroupAccessMemberScope;
  memberUserIds: string[];
}

/** 个人权限覆盖（按 group_key + user_id 唯一）：存在时替代同部门默认规则。 */
export interface GroupAccessMemberRuleData {
  groupKey: string;
  userId: string;
  scopePermissions: GroupAccessScopePermission[];
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  projectIds: string[];
  updatedAt?: Date;
}

export interface GroupAccessProfile {
  enforced: boolean;
  admin: boolean;
  /** 旧客户端兼容摘要：任一范围可编辑 = false；项目级写权限以 projectGroupAccessLevelOf 为准。 */
  readOnly: boolean;
  groupKeys: string[];
  pages: GroupAccessPage[];
  /** null = 不额外收窄项目；数组（含空数组）= 群组可见项目白名单。 */
  projectIds: string[] | null;
  /** 规则包含 own：需在服务层把本人负责 / 参与项目并入 projectIds。 */
  ownProjects: boolean;
  /** selected 范围项目白名单并集。 */
  selectedProjectIds: string[];
  /** 当前账号是否命中至少一条已启用的部门规则；仅用于画像 / 排障，不单独代表业务数据读取权限。 */
  hasRule: boolean;
  /** 当前账号命中的项目范围并集（保留规则原意，供权限画像展示；none 仅表示该规则无数据范围）。 */
  projectScopes: GroupAccessProjectScope[];
  /** 多范围合并后的裁决口径；同一范围取最高权限。 */
  scopePermissions: GroupAccessScopePermission[];
  anyEdit: boolean;
  allEdit: boolean;
  ownEdit: boolean;
  selectedEdit: boolean;
}

/** 归一化旧单选字段到多范围；显式数组（含空数组）优先，旧字段仅用于未升级客户端。 */
export function normalizeScopePermissions(
  permissions: readonly GroupAccessScopePermission[] | undefined,
  legacyScope: GroupAccessProjectScope | undefined,
  legacyLevel: GroupAccessAccessLevel | undefined,
): GroupAccessScopePermission[] {
  if (permissions !== undefined) {
    return mergeScopePermissions(permissions);
  }
  if (legacyScope === undefined || legacyScope === "none") return [];
  return [{ projectScope: legacyScope, accessLevel: legacyLevel ?? "view" }];
}

/** 同一范围重复出现时取最高权限；返回顺序固定为 all / own / selected，便于稳定展示与审计。 */
export function mergeScopePermissions(
  permissions: readonly GroupAccessScopePermission[],
): GroupAccessScopePermission[] {
  const byScope = new Map<string, GroupAccessAccessLevel>();
  for (const permission of permissions) {
    const current = byScope.get(permission.projectScope);
    if (current === undefined || permission.accessLevel === "edit") {
      byScope.set(permission.projectScope, permission.accessLevel);
    }
  }
  return GROUP_ACCESS_DATA_PROJECT_SCOPES.flatMap((scope) => {
    const accessLevel = byScope.get(scope);
    return accessLevel === undefined ? [] : [{ projectScope: scope, accessLevel }];
  });
}

/** 旧字段摘要：优先 all，其次 own，再次 selected；无范围 = none + view。 */
export function summarizeScopePermissions(
  permissions: readonly GroupAccessScopePermission[],
): { projectScope: GroupAccessProjectScope; accessLevel: GroupAccessAccessLevel } {
  for (const scope of GROUP_ACCESS_DATA_PROJECT_SCOPES) {
    const permission = permissions.find((item) => item.projectScope === scope);
    if (permission !== undefined) return { projectScope: scope, accessLevel: permission.accessLevel };
  }
  return { projectScope: "none", accessLevel: "view" };
}

/** 规则是否适用于该账号：all = 部门全体；selected = 仅勾选人员。 */
export function ruleAppliesToMember(rule: GroupAccessRuleData, userId: string): boolean {
  return rule.memberScope === "all" || rule.memberUserIds.includes(userId);
}

/** 每个部门先取个人覆盖，否则取适用于该成员的部门默认规则；多部门结果再交给 resolveGroupAccess 取并集。 */
export function effectiveGroupAccessRules(
  groupKeys: readonly string[],
  groupRules: readonly GroupAccessRuleData[],
  memberRules: readonly GroupAccessMemberRuleData[],
  userId: string,
): GroupAccessRuleData[] {
  const groupRuleByKey = new Map(groupRules.map((item) => [item.groupKey, item] as const));
  const memberRuleByKey = new Map(
    memberRules.filter((item) => item.userId === userId).map((item) => [item.groupKey, item] as const),
  );
  const result: GroupAccessRuleData[] = [];
  for (const groupKey of groupKeys) {
    const personal = memberRuleByKey.get(groupKey);
    if (personal !== undefined) {
      result.push({
        groupKey: personal.groupKey,
        allowedPages: [...GROUP_ACCESS_PAGE_KEYS],
        scopePermissions: mergeScopePermissions(personal.scopePermissions),
        projectScope: personal.projectScope,
        accessLevel: personal.accessLevel,
        projectIds: [...personal.projectIds],
        memberScope: "selected",
        memberUserIds: [userId],
      });
      continue;
    }
    const groupRule = groupRuleByKey.get(groupKey);
    if (groupRule !== undefined && ruleAppliesToMember(groupRule, userId)) result.push(groupRule);
  }
  return result;
}

/** 权限管理员配置（部门键或用户 ID）：逗号分隔，去空白、去重、保序。 */
export function parseGroupAccessAdminKeys(value: string): string[] {
  const keys: string[] = [];
  for (const piece of value.split(",")) {
    const key = piece.trim();
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function isGroupAccessAdmin(groupKeys: readonly string[], adminGroupKeys: readonly string[]): boolean {
  return groupKeys.some((key) => adminGroupKeys.includes(key));
}

/**
 * 多群组取并集：所有页面恒放行；可见范围是 all / own / selected 的并集，
 * 同一范围在多个规则出现时取最高权限（edit > view）。任意 all = 全项目可见；否则 selected 项目并集 + own 标记。
 * 没有任何有效规则 = 空项目（默认拒绝，防止漏配越权）。
 */
export function resolveGroupAccess(input: {
  enforced: boolean;
  admin: boolean;
  groupKeys: readonly string[];
  rules: readonly GroupAccessRuleData[];
}): GroupAccessProfile {
  let hasRule = false;
  let hasNoneScope = false;
  let hasAllScope = false;
  let hasOwnScope = false;
  const selectedProjectIds: string[] = [];
  const projectScopes: GroupAccessProjectScope[] = [];
  const mergedScopePermissions: GroupAccessScopePermission[] = [];

  for (const rule of input.rules) {
    hasRule = true;
    const normalized = mergeScopePermissions(rule.scopePermissions);
    if (normalized.length === 0) {
      hasNoneScope = true;
      if (!projectScopes.includes("none")) projectScopes.push("none");
    }
    for (const permission of normalized) {
      if (!projectScopes.includes(permission.projectScope)) projectScopes.push(permission.projectScope);
      if (permission.projectScope === "all") hasAllScope = true;
      if (permission.projectScope === "own") hasOwnScope = true;
    }
    mergedScopePermissions.push(...normalized);
    if (normalized.some((permission) => permission.projectScope === "selected")) {
      for (const projectId of rule.projectIds) {
        if (!selectedProjectIds.includes(projectId)) selectedProjectIds.push(projectId);
      }
    }
  }
  if (!input.enforced || input.admin) {
    return {
      enforced: input.enforced,
      admin: input.admin,
      readOnly: false,
      groupKeys: [...input.groupKeys],
      pages: [...GROUP_ACCESS_PAGE_KEYS],
      projectIds: null,
      ownProjects: false,
      selectedProjectIds: [],
      hasRule: false,
      projectScopes: ["all"],
      scopePermissions: [{ projectScope: "all", accessLevel: "edit" }],
      anyEdit: true,
      allEdit: true,
      ownEdit: true,
      selectedEdit: true,
    };
  }

  const scopePermissions = mergeScopePermissions(mergedScopePermissions);
  const allEdit = scopePermissions.some((permission) => permission.projectScope === "all" && permission.accessLevel === "edit");
  const ownEdit = scopePermissions.some((permission) => permission.projectScope === "own" && permission.accessLevel === "edit");
  const selectedEdit = scopePermissions.some(
    (permission) => permission.projectScope === "selected" && permission.accessLevel === "edit",
  ) && selectedProjectIds.length > 0;
  const anyEdit = allEdit || ownEdit || selectedEdit;

  return {
    enforced: true,
    admin: false,
    readOnly: !anyEdit,
    groupKeys: [...input.groupKeys],
    pages: [...GROUP_ACCESS_PAGE_KEYS],
    projectIds: hasAllScope ? null : selectedProjectIds,
    ownProjects: hasOwnScope,
    selectedProjectIds,
    hasRule,
    projectScopes,
    scopePermissions,
    anyEdit,
    allEdit,
    ownEdit,
    selectedEdit,
  };
}

/** 单个项目的部门权限：所有命中范围取最高权限；null = 该项目不在任何可见范围。 */
export function projectGroupAccessLevelOf(
  profile: GroupAccessProfile,
  projectId: string,
  ownProject: boolean,
): GroupAccessAccessLevel | null {
  if (!profile.enforced || profile.admin) return "edit";
  let level: GroupAccessAccessLevel | null = null;
  for (const permission of profile.scopePermissions) {
    const applies =
      permission.projectScope === "all" ||
      (permission.projectScope === "own" && ownProject) ||
      (permission.projectScope === "selected" && profile.selectedProjectIds.includes(projectId));
    if (!applies) continue;
    if (permission.accessLevel === "edit") return "edit";
    level = "view";
  }
  return level;
}

/** 角色可见集与群组白名单取交集；groupIds = null 表示群组不收窄。 */
export function intersectProjectIds(
  roleIds: readonly string[] | null,
  groupIds: readonly string[] | null,
): string[] | null {
  if (groupIds === null) return roleIds === null ? null : [...roleIds];
  if (roleIds === null) return [...groupIds];
  const roleSet = new Set(roleIds);
  return groupIds.filter((id) => roleSet.has(id));
}
