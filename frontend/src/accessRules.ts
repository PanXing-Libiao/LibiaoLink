import type {
  GroupAccessAccessLevel,
  GroupAccessGroup,
  GroupAccessMemberRule,
  GroupAccessProjectScope,
} from "./accessApi";
import type { GroupAccessDataProjectScope, GroupAccessScopePermission } from "./permissions";

export type EffectiveAccessSource = "personal" | "department" | "none";

export type EffectiveAccessRule = {
  source: EffectiveAccessSource;
  scopePermissions: GroupAccessScopePermission[];
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  projectIds: string[];
  updatedAt: string | null;
};

const DATA_SCOPES: readonly GroupAccessDataProjectScope[] = ["all", "own", "selected"];

/** 同一范围去重取最高权限；固定按 all / own / selected 输出。 */
export function mergeScopePermissions(
  permissions: readonly GroupAccessScopePermission[],
): GroupAccessScopePermission[] {
  const byScope = new Map<GroupAccessDataProjectScope, GroupAccessAccessLevel>();
  for (const permission of permissions) {
    const current = byScope.get(permission.projectScope);
    if (current === undefined || permission.accessLevel === "edit") {
      byScope.set(permission.projectScope, permission.accessLevel);
    }
  }
  return DATA_SCOPES.flatMap((scope) => {
    const accessLevel = byScope.get(scope);
    return accessLevel === undefined ? [] : [{ projectScope: scope, accessLevel }];
  });
}

/** 旧服务端兼容：未下发 scopePermissions 时回退到单选 projectScope / accessLevel。 */
export function scopePermissionsOf(
  permissions: readonly GroupAccessScopePermission[] | undefined,
  projectScope: GroupAccessProjectScope,
  accessLevel: GroupAccessAccessLevel,
): GroupAccessScopePermission[] {
  if (permissions !== undefined) return mergeScopePermissions(permissions);
  return projectScope === "none" ? [] : [{ projectScope, accessLevel }];
}

export function summarizeScopePermissions(
  permissions: readonly GroupAccessScopePermission[],
): { projectScope: GroupAccessProjectScope; accessLevel: GroupAccessAccessLevel } {
  for (const scope of DATA_SCOPES) {
    const permission = permissions.find((item) => item.projectScope === scope);
    if (permission !== undefined) return { projectScope: scope, accessLevel: permission.accessLevel };
  }
  return { projectScope: "none", accessLevel: "view" };
}

export function memberRuleOf(group: GroupAccessGroup, userId: string): GroupAccessMemberRule | null {
  return group.memberRules.find((rule) => rule.userId === userId) ?? null;
}

export function groupRuleAppliesToMember(group: GroupAccessGroup, userId: string): boolean {
  const rule = group.rule;
  if (rule === null) return false;
  return rule.memberScope === "all" || rule.memberUserIds.includes(userId);
}

export function effectiveMemberAccess(group: GroupAccessGroup, userId: string): EffectiveAccessRule {
  return effectiveAccessRule(memberRuleOf(group, userId), group.rule, userId);
}

export function effectiveAccessRule(
  personal: GroupAccessMemberRule | null,
  groupRule: GroupAccessGroup["rule"],
  userId: string,
): EffectiveAccessRule {
  if (personal !== null) {
    const scopePermissions = scopePermissionsOf(
      personal.scopePermissions,
      personal.projectScope,
      personal.accessLevel,
    );
    return {
      source: "personal",
      scopePermissions,
      ...summarizeScopePermissions(scopePermissions),
      projectIds: personal.projectIds,
      updatedAt: personal.updatedAt,
    };
  }
  if (groupRule !== null && (groupRule.memberScope === "all" || groupRule.memberUserIds.includes(userId))) {
    const scopePermissions = scopePermissionsOf(
      groupRule.scopePermissions,
      groupRule.projectScope,
      groupRule.accessLevel,
    );
    return {
      source: "department",
      scopePermissions,
      ...summarizeScopePermissions(scopePermissions),
      projectIds: groupRule.projectIds,
      updatedAt: groupRule.updatedAt,
    };
  }
  return {
    source: "none",
    scopePermissions: [],
    projectScope: "none",
    accessLevel: "view",
    projectIds: [],
    updatedAt: null,
  };
}
