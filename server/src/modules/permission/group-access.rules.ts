import {
  GROUP_ACCESS_PAGE_KEYS,
  type GroupAccessAccessLevel,
  type GroupAccessMemberScope,
  type GroupAccessPage,
  type GroupAccessProjectScope,
} from "@libiaolink/contracts";

/** 仓储读出的规则形状（项目 id 已按 selected 规则展开）。 */
export interface GroupAccessRuleData {
  groupKey: string;
  allowedPages: GroupAccessPage[];
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  projectIds: string[];
  memberScope: GroupAccessMemberScope;
  memberUserIds: string[];
}

export interface GroupAccessProfile {
  enforced: boolean;
  admin: boolean;
  /** 群组限制开启且非管理员、无任何适用 edit 规则时为 true：页面可进，但业务写操作一律拒绝。 */
  readOnly: boolean;
  groupKeys: string[];
  pages: GroupAccessPage[];
  /** null = 不额外收窄项目；数组（含空数组）= 群组白名单。 */
  projectIds: string[] | null;
  /** 规则包含 own：需在服务层把本人负责 / 参与项目并入 projectIds。 */
  ownProjects: boolean;
  /** 当前账号是否命中至少一条已启用的部门规则；用于区分「仅登录」与「有规则但无项目」。 */
  hasRule: boolean;
  /** 当前账号命中的项目范围并集（保留规则原意，供权限画像展示）。 */
  projectScopes: GroupAccessProjectScope[];
}

/** 规则是否适用于该账号：all = 部门全体；selected = 仅勾选人员。 */
export function ruleAppliesToMember(rule: GroupAccessRuleData, userId: string): boolean {
  return rule.memberScope === "all" || rule.memberUserIds.includes(userId);
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
 * 多群组取并集：所有页面恒放行；项目规则任意 all 即不额外收窄，否则 selected 项目并集，
 * own 由服务层展开后并入，none 不贡献项目。没有任何有效规则 = 空项目（默认拒绝，防止漏配越权）。
 * 写能力同样取并集：只有任一适用规则为 edit 才解除只读；view / 无规则均只读。
 */
export function resolveGroupAccess(input: {
  enforced: boolean;
  admin: boolean;
  groupKeys: readonly string[];
  rules: readonly GroupAccessRuleData[];
}): GroupAccessProfile {
  let projectIds: string[] | null = [];
  let ownProjects = false;
  let hasRule = false;
  let hasEditAccess = false;
  const projectScopes: GroupAccessProjectScope[] = [];
  for (const rule of input.rules) {
    hasRule = true;
    if (!projectScopes.includes(rule.projectScope)) projectScopes.push(rule.projectScope);
    if (rule.accessLevel === "edit") hasEditAccess = true;
    if (rule.projectScope === "all") {
      projectIds = null;
      ownProjects = false;
    } else if (rule.projectScope === "own") {
      if (projectIds !== null) ownProjects = true;
    } else if (rule.projectScope === "selected" && projectIds !== null) {
      for (const id of rule.projectIds) {
        if (!projectIds.includes(id)) projectIds.push(id);
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
      hasRule: false,
      projectScopes: ["all"],
    };
  }
  return {
    enforced: true,
    admin: false,
    readOnly: !hasEditAccess,
    groupKeys: [...input.groupKeys],
    pages: [...GROUP_ACCESS_PAGE_KEYS],
    projectIds: hasRule ? projectIds : [],
    ownProjects,
    hasRule,
    projectScopes,
  };
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
