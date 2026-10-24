import {
  GROUP_ACCESS_PAGE_KEYS,
  type GroupAccessMemberScope,
  type GroupAccessPage,
  type GroupAccessProjectScope,
} from "@libiaolink/contracts";

/** 仓储读出的规则形状（项目 id 已按 selected 规则展开）。 */
export interface GroupAccessRuleData {
  groupKey: string;
  allowedPages: GroupAccessPage[];
  projectScope: GroupAccessProjectScope;
  projectIds: string[];
  memberScope: GroupAccessMemberScope;
  memberUserIds: string[];
}

export interface GroupAccessProfile {
  enforced: boolean;
  admin: boolean;
  /** 群组限制开启且非管理员：所有页面可进，但业务写操作一律拒绝。 */
  readOnly: boolean;
  groupKeys: string[];
  pages: GroupAccessPage[];
  /** null = 不额外收窄项目；数组（含空数组）= 群组白名单。 */
  projectIds: string[] | null;
  /** 规则包含 own：需在服务层把本人负责 / 参与项目并入 projectIds。 */
  ownProjects: boolean;
}

/** 规则是否适用于该账号：all = 部门全体；selected = 仅勾选人员。 */
export function ruleAppliesToMember(rule: GroupAccessRuleData, userId: string): boolean {
  return rule.memberScope === "all" || rule.memberUserIds.includes(userId);
}

/** 管理员群组配置：逗号分隔，去空白、去重、保序。 */
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
 * 群组限制开启且非管理员 = 只读；管理员与开关关闭时保留原有写能力。
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
  for (const rule of input.rules) {
    hasRule = true;
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
    };
  }
  return {
    enforced: true,
    admin: false,
    readOnly: true,
    groupKeys: [...input.groupKeys],
    pages: [...GROUP_ACCESS_PAGE_KEYS],
    projectIds: hasRule ? projectIds : [],
    ownProjects,
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
