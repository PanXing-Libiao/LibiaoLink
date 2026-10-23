import {
  GROUP_ACCESS_PAGE_KEYS,
  type GroupAccessPage,
  type GroupAccessProjectScope,
} from "@libiaolink/contracts";

/** 仓储读出的规则形状（项目 id 已按 selected 规则展开）。 */
export interface GroupAccessRuleData {
  groupKey: string;
  allowedPages: GroupAccessPage[];
  projectScope: GroupAccessProjectScope;
  projectIds: string[];
}

export interface GroupAccessProfile {
  enforced: boolean;
  admin: boolean;
  groupKeys: string[];
  pages: GroupAccessPage[];
  /** null = 不额外收窄项目；数组（含空数组）= 群组白名单。 */
  projectIds: string[] | null;
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
 * 多群组取并集：页面取并集；项目规则任意 all 即不额外收窄，否则 selected 项目并集，
 * none 不贡献项目。没有任何有效规则 = 空页面 / 空项目（默认拒绝，防止漏配越权）。
 */
export function resolveGroupAccess(input: {
  enforced: boolean;
  admin: boolean;
  groupKeys: readonly string[];
  rules: readonly GroupAccessRuleData[];
}): GroupAccessProfile {
  const pages = new Set<GroupAccessPage>();
  let projectIds: string[] | null = [];
  let hasRule = false;
  for (const rule of input.rules) {
    hasRule = true;
    for (const page of rule.allowedPages) pages.add(page);
    if (rule.projectScope === "all") {
      projectIds = null;
    } else if (rule.projectScope === "selected" && projectIds !== null) {
      for (const id of rule.projectIds) {
        if (!projectIds.includes(id)) projectIds.push(id);
      }
    }
  }
  if (!input.enforced) {
    return {
      enforced: false,
      admin: input.admin,
      groupKeys: [...input.groupKeys],
      pages: [...GROUP_ACCESS_PAGE_KEYS],
      projectIds: null,
    };
  }
  if (input.admin) {
    return {
      enforced: true,
      admin: true,
      groupKeys: [...input.groupKeys],
      pages: [...GROUP_ACCESS_PAGE_KEYS],
      projectIds: null,
    };
  }
  return {
    enforced: true,
    admin: false,
    groupKeys: [...input.groupKeys],
    pages: [...pages],
    projectIds: hasRule ? projectIds : [],
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
