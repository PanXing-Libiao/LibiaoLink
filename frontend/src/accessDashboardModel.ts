import type {
  GroupAccessAdmin,
  GroupAccessGroup,
  GroupAccessMember,
  GroupAccessOverview,
  GroupAccessProject,
  GroupAccessProjectScope,
} from "./accessApi";
import { effectiveMemberAccess } from "./accessRules";

export type AccessLevel = "operate" | "view" | "login";
export type AccessProjectLevel = "all" | "own" | "selected" | "login";

export type AccessLevelCounts = Record<AccessLevel, number>;
export type AccessProjectCounts = Record<AccessProjectLevel, number>;

export type AccessPersonGroup = {
  groupKey: string;
  groupName: string;
  path: string[];
  pathText: string;
};

export type AccessPersonSummary = {
  member: GroupAccessMember;
  groups: AccessPersonGroup[];
  admin: GroupAccessAdmin | null;
  isAdmin: boolean;
  level: AccessLevel;
  projectLevel: AccessProjectLevel;
  searchText: string;
};

export type AccessDepartmentSummary = {
  group: GroupAccessGroup;
  path: string[];
  pathText: string;
  directMembers: GroupAccessMember[];
  activeMemberCount: number;
  subtreeMemberCount: number;
  levelCounts: AccessLevelCounts;
  projectCounts: AccessProjectCounts;
  adminCount: number;
  configured: boolean;
  hasProjectData: boolean;
  searchText: string;
};

export type AccessDashboardModel = {
  people: AccessPersonSummary[];
  admins: GroupAccessAdmin[];
  groups: AccessDepartmentSummary[];
  rootRows: AccessDepartmentSummary[];
  groupsByKey: ReadonlyMap<string, GroupAccessGroup>;
  projectsById: ReadonlyMap<string, GroupAccessProject>;
  levelCounts: AccessLevelCounts;
  projectCounts: AccessProjectCounts;
  totalMembers: number;
  globalMemberCount: number;
  topDepartmentCount: number;
  scopeGroupKey: string | null;
  scopePathText: string;
};

const LEVEL_KEYS: readonly AccessLevel[] = ["operate", "view", "login"];
const PROJECT_KEYS: readonly AccessProjectLevel[] = ["all", "own", "selected", "login"];

export function emptyLevelCounts(): AccessLevelCounts {
  return { operate: 0, view: 0, login: 0 };
}

export function emptyProjectCounts(): AccessProjectCounts {
  return { all: 0, own: 0, selected: 0, login: 0 };
}

export function addLevelCount(counts: AccessLevelCounts, level: AccessLevel): void {
  counts[level] += 1;
}

export function addProjectCount(counts: AccessProjectCounts, level: AccessProjectLevel): void {
  counts[level] += 1;
}

export function countLevels(people: readonly AccessPersonSummary[]): AccessLevelCounts {
  const counts = emptyLevelCounts();
  for (const person of people) addLevelCount(counts, person.level);
  return counts;
}

export function countProjects(people: readonly AccessPersonSummary[]): AccessProjectCounts {
  const counts = emptyProjectCounts();
  for (const person of people) addProjectCount(counts, person.projectLevel);
  return counts;
}

export function departmentPathOf(groupKey: string, groups: ReadonlyMap<string, GroupAccessGroup>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = groups.get(groupKey);
  while (current !== undefined && !seen.has(current.groupKey)) {
    path.unshift(current.groupName);
    seen.add(current.groupKey);
    const parentKey = current.parentGroupKey ?? null;
    current = parentKey === null ? undefined : groups.get(parentKey);
  }
  return path;
}

export function projectScopeKey(scope: GroupAccessProjectScope): string {
  return "access.scope." + scope;
}

function projectLevelOf(person: {
  member: GroupAccessMember;
  groups: readonly AccessPersonGroup[];
  isAdmin: boolean;
}, groupsByKey: ReadonlyMap<string, GroupAccessGroup>): AccessProjectLevel {
  if (person.isAdmin) return "all";
  let hasRule = false;
  let hasOwn = false;
  let hasSelected = false;
  for (const membership of person.groups) {
    const group = groupsByKey.get(membership.groupKey);
    if (group === undefined) continue;
    const effective = effectiveMemberAccess(group, person.member.userId);
    if (effective.source === "none") continue;
    hasRule = true;
    if (effective.projectScope === "all") return "all";
    if (effective.projectScope === "own") hasOwn = true;
    if (effective.projectScope === "selected" && effective.projectIds.length > 0) hasSelected = true;
  }
  if (!hasRule) return "login";
  if (hasOwn) return "own";
  if (hasSelected) return "selected";
  return "login";
}

function hasEditAccessOf(person: {
  member: GroupAccessMember;
  groups: readonly AccessPersonGroup[];
  isAdmin: boolean;
}, groupsByKey: ReadonlyMap<string, GroupAccessGroup>): boolean {
  if (person.isAdmin) return true;
  for (const membership of person.groups) {
    const group = groupsByKey.get(membership.groupKey);
    if (group === undefined) continue;
    const effective = effectiveMemberAccess(group, person.member.userId);
    if (effective.source !== "none" && effective.projectScope !== "none" && effective.accessLevel === "edit") return true;
  }
  return false;
}

function levelOf(projectLevel: AccessProjectLevel, isAdmin: boolean, hasEditAccess: boolean): AccessLevel {
  if (isAdmin) return "operate";
  if (projectLevel === "login") return "login";
  return hasEditAccess ? "operate" : "view";
}

function subtreeKeysOf(groupKey: string, groups: ReadonlyMap<string, GroupAccessGroup>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    result.push(key);
    for (const group of groups.values()) {
      if (group.parentGroupKey === key) visit(group.groupKey);
    }
  };
  visit(groupKey);
  return result;
}

function childGroupsOf(groupKey: string | null, groups: readonly GroupAccessGroup[]): GroupAccessGroup[] {
  return groups.filter((group) => {
    if (groupKey === null) {
      return group.parentGroupKey === null || !groups.some((candidate) => candidate.groupKey === group.parentGroupKey);
    }
    return group.parentGroupKey === groupKey;
  });
}

function pathTextOf(path: readonly string[], groupKey: string): string {
  return path.length > 0 ? path.join(" / ") : groupKey;
}

/**
 * 权限看板统计口径：
 * - 人与部门均来自 GET /api/v1/access；跨部门按 userId 去重。
 * - 系统管理员始终归入编辑，项目范围按全部项目计。
 * - 普通账号取所属部门全部适用规则的并集：任一 all 即全部；否则 own 优先，其次有项目的 selected；
 *   任一适用规则为 edit 且项目范围不是 none 才归编辑，否则为仅浏览；没有适用数据规则 = 仅登录。
 * - 看板只统计启用账号；停用账号仍在详情名单中展示，但不计入权限分布。
 */
export function buildAccessDashboardModel(data: GroupAccessOverview, scopeGroupKey: string | null): AccessDashboardModel {
  const groupsByKey = new Map(data.groups.map((group) => [group.groupKey, group] as const));
  const projectsById = new Map(data.projects.map((project) => [project.id, project] as const));
  const adminById = new Map(data.admins.map((admin) => [admin.userId, admin] as const));
  const scopedKey = scopeGroupKey !== null && groupsByKey.has(scopeGroupKey) ? scopeGroupKey : null;
  const scopeKeys = scopedKey === null ? null : new Set(subtreeKeysOf(scopedKey, groupsByKey));

  type MutablePerson = {
    member: GroupAccessMember;
    groups: AccessPersonGroup[];
    groupKeySet: Set<string>;
  };
  const peopleById = new Map<string, MutablePerson>();
  const ensurePerson = (member: GroupAccessMember): MutablePerson => {
    const existing = peopleById.get(member.userId);
    if (existing !== undefined) return existing;
    const created: MutablePerson = { member, groups: [], groupKeySet: new Set() };
    peopleById.set(member.userId, created);
    return created;
  };

  for (const group of data.groups) {
    const path = departmentPathOf(group.groupKey, groupsByKey);
    for (const member of group.members) {
      const person = ensurePerson(member);
      if (person.groupKeySet.has(group.groupKey)) continue;
      person.groupKeySet.add(group.groupKey);
      person.groups.push({
        groupKey: group.groupKey,
        groupName: group.groupName,
        path,
        pathText: pathTextOf(path, group.groupKey),
      });
    }
  }
  for (const admin of data.admins) {
    const person = ensurePerson({
      userId: admin.userId,
      username: admin.username,
      displayName: admin.displayName,
      email: admin.email,
      status: admin.status,
    });
    if (person.member.displayName === person.member.username && admin.displayName !== "") {
      person.member = { ...person.member, displayName: admin.displayName };
    }
  }

  const allPeople: AccessPersonSummary[] = [];
  for (const person of peopleById.values()) {
    const admin = adminById.get(person.member.userId) ?? null;
    const isAdmin = admin !== null;
    const projectLevel = projectLevelOf({ member: person.member, groups: person.groups, isAdmin }, groupsByKey);
    const level = levelOf(projectLevel, isAdmin, hasEditAccessOf({ member: person.member, groups: person.groups, isAdmin }, groupsByKey));
    const searchParts = [person.member.displayName, person.member.username, person.member.email ?? "", ...person.groups.map((group) => group.pathText)];
    allPeople.push({
      member: person.member,
      groups: [...person.groups].sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN")),
      admin,
      isAdmin,
      level,
      projectLevel,
      searchText: searchParts.join(" ").toLowerCase(),
    });
  }
  allPeople.sort((left, right) => left.member.displayName.localeCompare(right.member.displayName, "zh-Hans-CN") || left.member.username.localeCompare(right.member.username));

  const visiblePeople = allPeople.filter((person) => {
    if (person.member.status !== "active") return false;
    if (scopeKeys === null) return true;
    return person.groups.some((group) => scopeKeys.has(group.groupKey));
  });

  const groupSummaries: AccessDepartmentSummary[] = [];
  for (const group of data.groups) {
    const path = departmentPathOf(group.groupKey, groupsByKey);
    const subtreeKeys = new Set(subtreeKeysOf(group.groupKey, groupsByKey));
    const subtreePeople = visiblePeople.filter((person) => person.groups.some((membership) => subtreeKeys.has(membership.groupKey)));
    const subtreeMemberCount = subtreePeople.length;
    const activeMembers = group.members.filter((member) => {
      if (member.status !== "active") return false;
      if (scopeKeys === null) return true;
      return [...personGroupsOf(member.userId, allPeople)].some((membership) => scopeKeys.has(membership.groupKey));
    });
    const levelCounts = emptyLevelCounts();
    const projectCounts = emptyProjectCounts();
    for (const person of subtreePeople) {
      addLevelCount(levelCounts, person.level);
      addProjectCount(projectCounts, person.projectLevel);
    }
    const subtreeRuleGroups = [...subtreeKeys].map((key) => groupsByKey.get(key)).filter((item): item is GroupAccessGroup => item !== undefined);
    const hasProjectData = subtreeRuleGroups.some((item) => (item.rule !== null && item.rule.projectScope !== "none") || item.memberRules.some((memberRule) => memberRule.projectScope !== "none"));
    const configured = subtreeRuleGroups.some((item) => item.rule !== null || item.memberRules.length > 0);
    const adminCount = subtreePeople.filter((person) => person.isAdmin).length;
    groupSummaries.push({
      group,
      path,
      pathText: pathTextOf(path, group.groupKey),
      directMembers: group.members,
      activeMemberCount: activeMembers.length,
      subtreeMemberCount,
      levelCounts,
      projectCounts,
      adminCount,
      configured,
      hasProjectData,
      searchText: [group.groupName, group.groupKey, path.join(" "), ...group.members.map((member) => member.displayName + " " + member.username + " " + (member.email ?? ""))].join(" ").toLowerCase(),
    });
  }

  const topLevelCandidates = childGroupsOf(null, data.groups);
  const rootRows = scopeKeys === null
    ? topLevelCandidates
      .map((group) => groupSummaries.find((row) => row.group.groupKey === group.groupKey))
      .filter((row): row is AccessDepartmentSummary => row !== undefined)
      .sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN"))
    : (() => {
      const children = childGroupsOf(scopedKey, data.groups);
      const source = children.length > 0 ? children : data.groups.filter((group) => group.groupKey === scopedKey);
      return source
        .map((group) => groupSummaries.find((row) => row.group.groupKey === group.groupKey))
        .filter((row): row is AccessDepartmentSummary => row !== undefined)
        .sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN"));
    })();

  const levelCounts = countLevels(visiblePeople);
  const projectCounts = countProjects(visiblePeople);
  const scopePath = scopedKey === null ? [] : departmentPathOf(scopedKey, groupsByKey);

  return {
    people: visiblePeople,
    admins: [...data.admins].sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-Hans-CN") || left.username.localeCompare(right.username)),
    groups: groupSummaries.sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN")),
    rootRows,
    groupsByKey,
    projectsById,
    levelCounts,
    projectCounts,
    totalMembers: visiblePeople.length,
    globalMemberCount: allPeople.filter((person) => person.member.status === "active").length,
    topDepartmentCount: topLevelCandidates.length,
    scopeGroupKey: scopedKey,
    scopePathText: scopePath.length > 0 ? scopePath.join(" / ") : "",
  };
}

function personGroupsOf(userId: string, people: readonly AccessPersonSummary[]): readonly AccessPersonGroup[] {
  const found = people.find((person) => person.member.userId === userId);
  return found?.groups ?? [];
}

export function projectNamesOf(group: GroupAccessGroup, projectsById: ReadonlyMap<string, GroupAccessProject>): string[] {
  if (group.rule === null || group.rule.projectScope !== "selected") return [];
  return group.rule.projectIds.map((projectId) => {
    const project = projectsById.get(projectId);
    return project === undefined ? projectId : project.code + " · " + project.name;
  });
}

export function levelCountsAreEmpty(counts: AccessLevelCounts): boolean {
  return LEVEL_KEYS.every((key) => counts[key] === 0);
}

export function projectCountsAreEmpty(counts: AccessProjectCounts): boolean {
  return PROJECT_KEYS.every((key) => counts[key] === 0);
}
