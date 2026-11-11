import type {
  GroupAccessAutomaticRole,
  GroupAccessGroup,
  GroupAccessMember,
  GroupAccessOverview,
  GroupAccessProject,
} from "./accessApi";
import { effectiveMemberAccess, mergeScopePermissions, type EffectiveAccessRule } from "./accessRules";
import type { GroupAccessDataProjectScope, GroupAccessScopePermission } from "./permissions";

export type AutomaticRoleSummary = {
  role: GroupAccessAutomaticRole;
  managerCount: number;
  memberCount: number;
  taskOwnerProjectCount: number;
  taskOwnerTaskCount: number;
  relationCount: number;
};

export type ManualScopeState = {
  permissions: GroupAccessScopePermission[];
  projectIds: string[];
  sources: string[];
  hasPersonalOverride: boolean;
};

export type EffectiveMemberPermission = {
  automatic: AutomaticRoleSummary;
  manual: ManualScopeState;
  isAdmin: boolean;
  visibleAll: boolean;
  visibleProjectIds: string[];
  editAll: boolean;
  editProjectIds: string[];
  taskOnlyCount: number;
};

export function emptyAutomaticRole(userId: string): GroupAccessAutomaticRole {
  return {
    userId,
    projectManagerProjectIds: [],
    projectMemberProjectIds: [],
    taskOwnerProjectIds: [],
    taskOwnerTaskCount: 0,
  };
}

export function summarizeAutomaticRole(role: GroupAccessAutomaticRole): AutomaticRoleSummary {
  return {
    role,
    managerCount: role.projectManagerProjectIds.length,
    memberCount: role.projectMemberProjectIds.length,
    taskOwnerProjectCount: role.taskOwnerProjectIds.length,
    taskOwnerTaskCount: role.taskOwnerTaskCount,
    relationCount: new Set([
      ...role.projectManagerProjectIds,
      ...role.projectMemberProjectIds,
      ...role.taskOwnerProjectIds,
    ]).size,
  };
}

export function automaticRoleOf(
  roles: ReadonlyMap<string, GroupAccessAutomaticRole>,
  userId: string,
): AutomaticRoleSummary {
  return summarizeAutomaticRole(roles.get(userId) ?? emptyAutomaticRole(userId));
}

export function automaticRolesById(data: GroupAccessOverview): Map<string, GroupAccessAutomaticRole> {
  return new Map((data.automaticRoles ?? []).map((role) => [role.userId, role] as const));
}

export function automaticCountsForMembers(
  members: readonly GroupAccessMember[],
  roles: ReadonlyMap<string, GroupAccessAutomaticRole>,
): { projectManagers: number; projectMembers: number; taskOwners: number; relations: number } {
  let projectManagers = 0;
  let projectMembers = 0;
  let taskOwners = 0;
  let relations = 0;
  for (const member of members) {
    const summary = automaticRoleOf(roles, member.userId);
    if (summary.managerCount > 0) projectManagers += 1;
    if (summary.memberCount > 0) projectMembers += 1;
    if (summary.taskOwnerTaskCount > 0) taskOwners += 1;
    relations += summary.relationCount;
  }
  return { projectManagers, projectMembers, taskOwners, relations };
}

export function groupsOfMember(data: GroupAccessOverview, userId: string): GroupAccessGroup[] {
  return data.groups.filter((group) => group.members.some((member) => member.userId === userId));
}

export function manualScopeOfMember(data: GroupAccessOverview, userId: string): ManualScopeState {
  const permissions: GroupAccessScopePermission[] = [];
  const projectIds = new Set<string>();
  const sources: string[] = [];
  let hasPersonalOverride = false;
  for (const group of groupsOfMember(data, userId)) {
    const effective: EffectiveAccessRule = effectiveMemberAccess(group, userId);
    if (effective.source === "none") continue;
    permissions.push(...effective.scopePermissions);
    if (effective.scopePermissions.some((permission) => permission.projectScope === "selected")) {
      for (const projectId of effective.projectIds) projectIds.add(projectId);
    }
    if (effective.source === "personal") hasPersonalOverride = true;
    sources.push((effective.source === "personal" ? "personal:" : "department:") + group.groupName);
  }
  return {
    permissions: mergeScopePermissions(permissions),
    projectIds: [...projectIds].sort(),
    sources,
    hasPersonalOverride,
  };
}

export function effectiveMemberPermission(
  data: GroupAccessOverview,
  userId: string,
  automatic: AutomaticRoleSummary,
  isAdmin: boolean,
): EffectiveMemberPermission {
  const manual = manualScopeOfMember(data, userId);
  const managerIds = new Set(automatic.role.projectManagerProjectIds);
  const memberIds = new Set(automatic.role.projectMemberProjectIds);
  const taskOwnerIds = new Set(automatic.role.taskOwnerProjectIds);
  const relationshipIds = new Set([...managerIds, ...memberIds, ...taskOwnerIds]);
  const allProjectIds = data.projects.map((project) => project.id);
  const levelOf = (scope: GroupAccessDataProjectScope): "edit" | "view" | null =>
    manual.permissions.find((permission) => permission.projectScope === scope)?.accessLevel ?? null;
  const allVisible = isAdmin || levelOf("all") !== null;
  const ownLevel = levelOf("own");
  const selectedLevel = levelOf("selected");
  const visible = new Set<string>(allVisible ? allProjectIds : []);
  if (!allVisible) {
    for (const projectId of relationshipIds) visible.add(projectId);
    if (ownLevel !== null) {
      for (const projectId of managerIds) visible.add(projectId);
      for (const projectId of memberIds) visible.add(projectId);
    }
    if (selectedLevel !== null) {
      for (const projectId of manual.projectIds) visible.add(projectId);
    }
  }
  const editAll = isAdmin || levelOf("all") === "edit";
  const edit = new Set<string>();
  if (editAll) {
    for (const projectId of allProjectIds) edit.add(projectId);
  } else {
    for (const projectId of managerIds) edit.add(projectId);
    if (ownLevel === "edit") {
      for (const projectId of managerIds) edit.add(projectId);
      for (const projectId of memberIds) edit.add(projectId);
    }
    if (selectedLevel === "edit") {
      for (const projectId of manual.projectIds) edit.add(projectId);
    }
  }
  return {
    automatic,
    manual,
    isAdmin,
    visibleAll: allVisible,
    visibleProjectIds: [...visible].sort(),
    editAll,
    editProjectIds: [...edit].sort(),
    taskOnlyCount: automatic.taskOwnerTaskCount,
  };
}

export function projectById(projects: readonly GroupAccessProject[]): Map<string, GroupAccessProject> {
  return new Map(projects.map((project) => [project.id, project] as const));
}

export function projectLabel(project: GroupAccessProject | undefined, projectId: string): string {
  return project === undefined ? projectId.slice(0, 8) : project.code + " · " + project.name;
}

export function manualLevelOf(
  manual: ManualScopeState,
  scope: GroupAccessDataProjectScope,
): "edit" | "view" | null {
  return manual.permissions.find((permission) => permission.projectScope === scope)?.accessLevel ?? null;
}
