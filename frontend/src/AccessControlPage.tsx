import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  assignGroupAccessAdmin,
  deleteGroupAccessMemberRules,
  deleteGroupAccessRule,
  fetchAccessOverview,
  revokeGroupAccessAdmin,
  saveGroupAccessMemberRules,
  saveGroupAccessRule,
  type GroupAccessAdmin,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessOverview,
} from "./accessApi";
import { AccessDashboard, AccessDashboardSkeleton } from "./AccessDashboard";
import { AccessPermissionMatrix } from "./AccessPermissionMatrix";
import { buildAccessDashboardModel } from "./accessDashboardModel";
import {
  automaticCountsForMembers,
  automaticRoleOf,
  automaticRolesById,
  effectiveMemberPermission,
  manualLevelOf,
  projectById,
  projectLabel,
  type EffectiveMemberPermission,
} from "./accessRoleModel";
import { memberRuleOf, scopePermissionsOf } from "./accessRules";
import { AccessScopePicker } from "./AccessScopePicker";
import { AppHeader } from "./components/AppHeader";
import { SelectMenu } from "./components/SelectMenu";
import { Toast, type ToastKind } from "./components/Toast";
import { useLocale, useT, type TextKey } from "./i18n";
import { useLiveRefresh } from "./useLiveRefresh";
import { loadMyPermissions, type GroupAccessScopePermission } from "./permissions";
import type { MeResponse } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: GroupAccessOverview }
  | { kind: "error"; message: string };

type Notice = { kind: ToastKind; text: string };
type AccessView = "departments" | "people" | "dashboard";
type Translate = (key: TextKey, params?: Record<string, string | number>) => string;
type DirectorySection = { key: string; label: string; items: Array<{ group: GroupAccessGroup; pathText: string }> };

type PreviewRow = {
  projectId: string;
  sources: string[];
  level: "edit" | "view" | "task";
  taskOwner: boolean;
};

function memberSearchText(member: GroupAccessMember): string {
  return (member.displayName + " " + member.username + " " + (member.email ?? "")).toLowerCase();
}

function memberInitial(member: Pick<GroupAccessMember, "displayName">): string {
  const chars = Array.from(member.displayName.trim());
  return chars.length === 0 ? "?" : chars[0] ?? "?";
}

function departmentPathOf(groupKey: string, groups: ReadonlyMap<string, GroupAccessGroup>): string[] {
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

function buildDirectorySections(
  groups: readonly GroupAccessGroup[],
  groupsByKey: ReadonlyMap<string, GroupAccessGroup>,
  query: string,
): DirectorySection[] {
  const byRoot = new Map<string, { label: string; sortKey: string; items: Array<{ group: GroupAccessGroup; pathText: string }> }>();
  for (const group of groups) {
    const path = departmentPathOf(group.groupKey, groupsByKey);
    let root = groupsByKey.get(group.groupKey) ?? group;
    const seen = new Set<string>();
    while (root.parentGroupKey !== null && !seen.has(root.groupKey)) {
      seen.add(root.groupKey);
      const parent = groupsByKey.get(root.parentGroupKey);
      if (parent === undefined) break;
      root = parent;
    }
    const matches = query === "" ||
      (group.groupName + " " + group.groupKey + " " + path.join(" ")).toLowerCase().includes(query) ||
      group.members.some((member) => memberSearchText(member).includes(query));
    if (!matches) continue;
    const bucketKey = path.length === 0 ? "__root__" : root.groupKey;
    const existing = byRoot.get(bucketKey) ?? {
      label: path.length === 0 ? group.groupName : root.groupName,
      sortKey: path.length === 0 ? group.groupName : root.groupName,
      items: [],
    };
    existing.items.push({
      group,
      pathText: path.length > 1 ? path.join(" / ") : group.groupName,
    });
    byRoot.set(bucketKey, existing);
  }
  return [...byRoot.entries()]
    .map(([key, section]) => ({
      key,
      label: section.label,
      items: section.items.sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN")),
      sortKey: section.sortKey,
    }))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey, "zh-Hans-CN"))
    .map(({ sortKey: _sortKey, ...section }) => section);
}

function adminSourceKey(source: GroupAccessAdmin["source"]): TextKey {
  return source === "configured" ? "access.adminSourceConfigured" : "access.adminSourceManual";
}

function levelText(t: Translate, level: "edit" | "view"): string {
  return t(level === "edit" ? "access.dashboard.operate" : "access.dashboard.viewOnly");
}

function scopeSummary(t: Translate, permissions: readonly GroupAccessScopePermission[]): string {
  if (permissions.length === 0) return t("access.noExtraScope");
  return permissions
    .map((permission) => t(("access.scope." + permission.projectScope) as TextKey) + " · " + levelText(t, permission.accessLevel))
    .join(t("access.permissionSeparator"));
}

function visibleText(t: Translate, effective: EffectiveMemberPermission): string {
  if (effective.visibleAll) return t("access.visibleAll");
  if (effective.visibleProjectIds.length === 0) return t("access.visibleNone");
  if (
    effective.manual.permissions.length === 0 &&
    effective.automatic.managerCount === 0 &&
    effective.automatic.memberCount === 0 &&
    effective.automatic.taskOwnerProjectCount > 0
  ) return t("access.visibleTaskOnly");
  return t("access.visibleCount", { n: effective.visibleProjectIds.length });
}

function editableText(t: Translate, effective: EffectiveMemberPermission): string {
  if (effective.editAll) return t("access.visibleAll");
  if (effective.editProjectIds.length > 0) return t("access.editCount", { n: effective.editProjectIds.length });
  if (effective.taskOnlyCount > 0) return t("access.taskLevelCount", { n: effective.taskOnlyCount });
  return t("access.editNone");
}

function MemberAvatar({ member, size }: { member: GroupAccessMember; size: "sm" | "md" | "lg" }) {
  const className = size === "lg" ? "h-14 w-14 text-xl" : size === "md" ? "h-9 w-9 text-sm" : "h-7 w-7 text-[11px]";
  return (
    <span className={"flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 font-semibold text-blue-700 ring-1 ring-blue-200/60 " + className}>
      {memberInitial(member)}
    </span>
  );
}

function RoleTag({ tone, children }: { tone: "blue" | "emerald" | "violet" | "amber" | "zinc"; children: ReactNode }) {
  const tones = {
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    zinc: "border-zinc-200 bg-zinc-50 text-zinc-500",
  };
  return <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium " + tones[tone]}>{children}</span>;
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/70 px-3 py-6 text-center text-xs text-zinc-400">{children}</p>;
}

function ProjectPicker({
  projects,
  selectedIds,
  query,
  t,
  onQueryChange,
  onToggle,
}: {
  projects: GroupAccessOverview["projects"];
  selectedIds: readonly string[];
  query: string;
  t: Translate;
  onQueryChange: (value: string) => void;
  onToggle: (projectId: string) => void;
}) {
  return (
    <div data-access-project-picker="true" className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/80 px-3 py-2">
        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-400"><circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <input value={query} onChange={(event) => { onQueryChange(event.target.value); }} placeholder={t("access.projectSearch")} aria-label={t("access.projectSearch")} className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400" />
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{t("access.selectedCount", { n: selectedIds.length })}</span>
      </div>
      <div className="scrollbar-hidden grid max-h-56 gap-1 overflow-y-auto p-1.5 sm:grid-cols-2">
        {projects.length === 0 ? <p className="col-span-full px-2 py-4 text-center text-[11px] text-zinc-400">{t("access.noProjects")}</p> : projects.map((project) => {
          const selected = selectedIds.includes(project.id);
          return (
            <button key={project.id} type="button" onClick={() => { onToggle(project.id); }} aria-pressed={selected} className={"flex min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition " + (selected ? "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200" : "text-zinc-600 hover:bg-zinc-50")}>
              <span className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border " + (selected ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-300 bg-white text-transparent")}><svg viewBox="0 0 16 16" className="h-2.5 w-2.5"><path d="m3.2 8.2 3 3 6.5-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
              <span className="min-w-0"><span className="block truncate text-[11px] font-medium">{project.code}</span><span className="mt-0.5 block truncate text-[10px] text-zinc-400">{project.name}</span></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RoleProjectBlock({
  title,
  count,
  tone,
  projectIds,
  projectsById,
  footer,
  t,
}: {
  title: string;
  count: number;
  tone: "blue" | "emerald" | "violet";
  projectIds: readonly string[];
  projectsById: ReadonlyMap<string, { id: string; code: string; name: string }>;
  footer?: string;
  t: Translate;
}) {
  const tones = {
    blue: "bg-blue-50/70 text-blue-700 ring-blue-100",
    emerald: "bg-emerald-50/70 text-emerald-700 ring-emerald-100",
    violet: "bg-violet-50/70 text-violet-700 ring-violet-100",
  };
  const visible = projectIds.slice(0, 4);
  return (
    <div className={"min-w-0 rounded-2xl p-4 ring-1 ring-inset " + tones[tone]}>
      <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-semibold">{title}</h4><span className="text-lg font-semibold tabular-nums">{count}</span></div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {visible.length === 0 ? <span className="text-[10px] opacity-70">{t("access.noAutoRole")}</span> : visible.map((projectId) => <span key={projectId} className="max-w-full truncate rounded-md bg-white/80 px-2 py-1 text-[10px] font-medium ring-1 ring-inset ring-current/10">{projectLabel(projectsById.get(projectId), projectId)}</span>)}
        {projectIds.length > visible.length ? <span className="rounded-md bg-white/80 px-2 py-1 text-[10px] font-medium ring-1 ring-inset ring-current/10">+{projectIds.length - visible.length}</span> : null}
      </div>
      {footer === undefined ? null : <p className="mt-2 text-[10px] leading-4 opacity-80">{footer}</p>}
    </div>
  );
}

function buildPreviewRows(
  effective: EffectiveMemberPermission,
  projectsById: ReadonlyMap<string, { id: string; code: string; name: string }>,
  t: Translate,
): PreviewRow[] {
  const manager = new Set(effective.automatic.role.projectManagerProjectIds);
  const member = new Set(effective.automatic.role.projectMemberProjectIds);
  const taskOwner = new Set(effective.automatic.role.taskOwnerProjectIds);
  const allLevel = manualLevelOf(effective.manual, "all");
  const ownLevel = manualLevelOf(effective.manual, "own");
  const selectedLevel = manualLevelOf(effective.manual, "selected");
  const selectedIds = new Set(effective.manual.projectIds);
  const ids = effective.visibleProjectIds.slice(0, 12);
  return ids.map((projectId) => {
    const sources: string[] = [];
    if (manager.has(projectId)) sources.push(t("access.sourceAutoManager"));
    if (member.has(projectId)) sources.push(t("access.sourceAutoMember"));
    if (taskOwner.has(projectId)) sources.push(t("access.sourceAutoTask"));
    let manualLevel: "edit" | "view" | null = null;
    if (allLevel !== null) manualLevel = allLevel;
    if (ownLevel !== null && (manager.has(projectId) || member.has(projectId))) manualLevel = manualLevel === "edit" ? manualLevel : ownLevel;
    if (selectedLevel !== null && selectedIds.has(projectId)) manualLevel = manualLevel === "edit" ? manualLevel : selectedLevel;
    if (manualLevel !== null) sources.push(t("access.sourceManual"));
    const level: PreviewRow["level"] = effective.isAdmin || manager.has(projectId) || manualLevel === "edit"
      ? "edit"
      : taskOwner.has(projectId)
        ? "task"
        : "view";
    return { projectId, sources: [...new Set(sources)], level, taskOwner: taskOwner.has(projectId) };
  }).sort((left, right) => {
    const leftProject = projectsById.get(left.projectId);
    const rightProject = projectsById.get(right.projectId);
    return (leftProject?.code ?? left.projectId).localeCompare(rightProject?.code ?? right.projectId);
  });
}

/**
 * 权限管理页（2026-11-11 动态授权改版）：
 * 自动项目角色由项目和任务关系实时计算；部门 / 个人规则只配置额外范围。
 * 页面每 30 秒后台刷新，关系变化后无需手工补规则。
 */
export function AccessControlPage({ me }: { me: MeResponse }) {
  const t = useT();
  const locale = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [accessView, setAccessView] = useState<AccessView>("departments");
  const [scopeGroupKey, setScopeGroupKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [reload, setReload] = useState(0);
  const hasDataRef = useRef(false);
  const dataSignatureRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusedMemberId, setFocusedMemberId] = useState<string | null>(null);
  const [personalUserId, setPersonalUserId] = useState<string | null>(null);
  const [departmentScopePermissions, setDepartmentScopePermissions] = useState<GroupAccessScopePermission[]>([]);
  const [departmentProjectIds, setDepartmentProjectIds] = useState<string[]>([]);
  const [personalScopePermissions, setPersonalScopePermissions] = useState<GroupAccessScopePermission[]>([]);
  const [personalProjectIds, setPersonalProjectIds] = useState<string[]>([]);
  const [departmentProjectQuery, setDepartmentProjectQuery] = useState("");
  const [personalProjectQuery, setPersonalProjectQuery] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [personalDirectoryQuery, setPersonalDirectoryQuery] = useState("");
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [deletingDepartment, setDeletingDepartment] = useState(false);
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [restoringPersonal, setRestoringPersonal] = useState(false);
  const [adminBusyUserId, setAdminBusyUserId] = useState<string | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadAccessData = useCallback(async (options?: { background?: boolean }): Promise<boolean> => {
    const background = options?.background === true;
    if (background && inFlightRef.current) return true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    inFlightRef.current = true;
    if (!background) {
      if (hasDataRef.current) setRefreshing(true);
      else setState({ kind: "loading" });
    }
    try {
      const next = await fetchAccessOverview();
      if (requestId !== requestIdRef.current) return false;
      hasDataRef.current = true;
      setLastSyncedAt(new Date());
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== dataSignatureRef.current) {
        dataSignatureRef.current = nextSignature;
        setState({ kind: "ready", data: next });
        setRefreshSeq((value) => value + 1);
      }
      return true;
    } catch (error: unknown) {
      if (requestId !== requestIdRef.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (background) return false;
      if (hasDataRef.current) {
        setNotice({ kind: "error", text: tRef.current("access.loadFailed", { message }) });
      } else {
        setState({ kind: "error", message });
      }
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        inFlightRef.current = false;
        if (!background) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadAccessData();
    return () => { requestIdRef.current += 1; };
  }, [loadAccessData, reload]);

  // 项目 / 任务关系变化通过实时事件立即触发后台刷新；全局 live sync 仍保留 30 秒兜底。
  useLiveRefresh(
    ["projects", "tasks", "permissions", "users"],
    async () => {
      await loadAccessData({ background: true });
      return () => {};
    },
    "access-overview",
    true,
    { readOnly: true },
  );

  const data = state.kind === "ready" ? state.data : null;
  const allGroups = data?.groups ?? [];
  const groupsByKey = useMemo(() => new Map(allGroups.map((group) => [group.groupKey, group] as const)), [allGroups]);
  const rolesById = useMemo(() => data === null ? new Map() : automaticRolesById(data), [data]);
  const projectsById = useMemo(() => data === null ? new Map() : projectById(data.projects), [data]);
  const adminByUserId = useMemo(() => new Map((data?.admins ?? []).map((admin) => [admin.userId, admin] as const)), [data]);

  useEffect(() => {
    if (selectedKey !== null || data === null || data.groups.length === 0) return;
    const initial = data.groups.find((group) => data.currentGroupKeys.includes(group.groupKey)) ?? data.groups.find((group) => group.groupKey !== "__ungrouped__") ?? data.groups[0];
    if (initial === undefined) return;
    setSelectedKey(initial.groupKey);
    applyGroup(initial);
  }, [data, selectedKey]);

  useEffect(() => {
    if (accessView !== "people" || selectedKey === null || data === null) return;
    const group = groupsByKey.get(selectedKey);
    if (group === undefined) return;
    if (personalUserId !== null && group.members.some((member) => member.userId === personalUserId)) return;
    const next = group.members.find((member) => member.userId === focusedMemberId) ?? group.members[0];
    if (next === undefined) {
      setPersonalUserId(null);
      return;
    }
    setPersonalUserId(next.userId);
    setFocusedMemberId(next.userId);
    setPersonalRuleFromMember(group, next.userId);
  }, [accessView, selectedKey, personalUserId, focusedMemberId, data, groupsByKey]);

  useEffect(() => {
    if (scopeGroupKey === null || data === null) return;
    if (!data.groups.some((group) => group.groupKey === scopeGroupKey)) setScopeGroupKey(null);
  }, [data, scopeGroupKey]);

  const selectedGroup = selectedKey === null ? null : groupsByKey.get(selectedKey) ?? null;
  const selectedRule = selectedGroup?.rule ?? null;
  const selectedRuleScopes = selectedRule === null ? [] : scopePermissionsOf(selectedRule.scopePermissions, selectedRule.projectScope, selectedRule.accessLevel);
  const selectedMembers = selectedGroup?.members ?? [];
  const selectedMemberCounts = automaticCountsForMembers(selectedMembers, rolesById);
  const selectedPath = selectedKey === null ? [] : departmentPathOf(selectedKey, groupsByKey);
  const totalMemberCount = new Set(allGroups.flatMap((group) => group.members.map((member) => member.userId))).size;
  const normalizedDirectoryQuery = directoryQuery.trim().toLowerCase();
  const directorySections = useMemo(
    () => buildDirectorySections(allGroups, groupsByKey, normalizedDirectoryQuery),
    [allGroups, groupsByKey, normalizedDirectoryQuery],
  );
  const activeGroupCount = allGroups.filter((group) => group.groupKey !== "__ungrouped__").length;
  const filteredDepartmentProjects = data === null
    ? []
    : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(departmentProjectQuery.trim().toLowerCase()));
  const filteredPersonalProjects = data === null
    ? []
    : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(personalProjectQuery.trim().toLowerCase()));
  const personalMember = personalUserId === null ? null : selectedMembers.find((member) => member.userId === personalUserId) ?? null;
  const personalRuleGroups = personalMember === null || data === null ? [] : data.groups.filter((group) => memberRuleOf(group, personalMember.userId) !== null);
  const personalRuleGroup = personalRuleGroups[0] ?? null;
  const personalRule = personalRuleGroup === null || personalMember === null ? null : memberRuleOf(personalRuleGroup, personalMember.userId);
  const personalAdmin = personalMember === null ? null : adminByUserId.get(personalMember.userId) ?? null;
  const personalAutomatic = personalMember === null ? null : automaticRoleOf(rolesById, personalMember.userId);
  const personalEffective = personalMember === null || personalAutomatic === null || data === null
    ? null
    : effectiveMemberPermission(data, personalMember.userId, personalAutomatic, personalAdmin !== null);
  const personalPreview = personalEffective === null ? [] : buildPreviewRows(personalEffective, projectsById, t);
  const personalManual = personalEffective?.manual ?? null;
  const personalGroups = personalMember === null || data === null ? [] : data.groups.filter((group) => group.members.some((member) => member.userId === personalMember.userId));
  const personalMemberQuery = personalDirectoryQuery.trim().toLowerCase();
  const personalVisibleMembers = selectedMembers.filter((member) => personalMemberQuery === "" || (memberSearchText(member) + " " + groupNameOfMember(data, member.userId)).toLowerCase().includes(personalMemberQuery));

  const dashboardModel = useMemo(() => data === null ? null : buildAccessDashboardModel(data, scopeGroupKey), [data, scopeGroupKey]);
  const scopeOptions = useMemo(() => {
    if (data === null) return [] as Array<{ groupKey: string; pathText: string }>;
    return data.groups
      .map((group) => ({ groupKey: group.groupKey, pathText: departmentPathOf(group.groupKey, groupsByKey).join(" / ") || group.groupName }))
      .sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN"));
  }, [data, groupsByKey]);

  const syncTime = lastSyncedAt === null
    ? "—"
    : new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(lastSyncedAt);

  function groupNameOfMember(source: GroupAccessOverview | null, userId: string): string {
    if (source === null) return "";
    return source.groups.find((group) => group.members.some((member) => member.userId === userId))?.groupName ?? "";
  }

  function setDepartmentRuleFrom(group: GroupAccessGroup): void {
    setDepartmentScopePermissions(scopePermissionsOf(group.rule?.scopePermissions, group.rule?.projectScope ?? "none", group.rule?.accessLevel ?? "view"));
    setDepartmentProjectIds(group.rule?.projectIds ?? []);
  }

  function setPersonalRuleFromMember(group: GroupAccessGroup, userId: string): void {
    const ruleGroup = allGroups.find((candidate) => memberRuleOf(candidate, userId) !== null) ?? group;
    const rule = memberRuleOf(ruleGroup, userId);
    setPersonalScopePermissions(rule === null ? [] : scopePermissionsOf(rule.scopePermissions, rule.projectScope, rule.accessLevel));
    setPersonalProjectIds(rule?.projectIds ?? []);
  }

  function applyGroup(group: GroupAccessGroup): void {
    setDepartmentRuleFrom(group);
    setDepartmentProjectQuery("");
    setPersonalProjectQuery("");
    setShowAllMembers(false);
    setFocusedMemberId(null);
    const firstMember = group.members[0];
    if (firstMember === undefined) {
      setPersonalUserId(null);
      setPersonalScopePermissions([]);
      setPersonalProjectIds([]);
    } else {
      setPersonalUserId(firstMember.userId);
      setPersonalRuleFromMember(group, firstMember.userId);
    }
  }

  function openGroup(group: GroupAccessGroup): void {
    setSelectedKey(group.groupKey);
    applyGroup(group);
  }

  function openPersonalFor(group: GroupAccessGroup, member: GroupAccessMember): void {
    setSelectedKey(group.groupKey);
    setFocusedMemberId(member.userId);
    setPersonalUserId(member.userId);
    setPersonalRuleFromMember(group, member.userId);
    setAccessView("people");
  }

  function selectPersonalMember(member: GroupAccessMember): void {
    if (selectedGroup === null) return;
    setPersonalUserId(member.userId);
    setFocusedMemberId(member.userId);
    setPersonalRuleFromMember(selectedGroup, member.userId);
  }

  function changePersonalGroup(groupKey: string): void {
    const group = groupsByKey.get(groupKey);
    if (group === undefined) return;
    openGroup(group);
    setAccessView("people");
  }

  function toggleDepartmentProject(projectId: string): void {
    setDepartmentProjectIds((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId));
  }

  function togglePersonalProject(projectId: string): void {
    setPersonalProjectIds((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId));
  }

  function resetDepartmentDraft(): void {
    if (selectedGroup === null) return;
    setDepartmentRuleFrom(selectedGroup);
    setDepartmentProjectQuery("");
  }

  function resetPersonalDraft(): void {
    if (selectedGroup === null || personalMember === null) return;
    setPersonalRuleFromMember(selectedGroup, personalMember.userId);
    setPersonalProjectQuery("");
  }

  async function handleSaveDepartment(): Promise<void> {
    if (selectedKey === null || savingDepartment || deletingDepartment) return;
    setSavingDepartment(true);
    try {
      await saveGroupAccessRule({
        groupKey: selectedKey,
        scopePermissions: departmentScopePermissions,
        projectIds: departmentScopePermissions.some((permission) => permission.projectScope === "selected") ? departmentProjectIds : [],
        memberScope: "all",
        memberUserIds: [],
      });
      setNotice({ kind: "ok", text: t("access.saved") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.saveFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setSavingDepartment(false);
    }
  }

  async function handleDeleteDepartment(): Promise<void> {
    if (selectedKey === null || deletingDepartment || savingDepartment) return;
    if (!window.confirm(t("access.confirmDelete"))) return;
    setDeletingDepartment(true);
    try {
      await deleteGroupAccessRule(selectedKey);
      setNotice({ kind: "ok", text: t("access.deleted") });
      setSelectedKey(null);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.deleteFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setDeletingDepartment(false);
    }
  }

  async function handleSavePersonal(): Promise<void> {
    if (selectedKey === null || personalMember === null || savingPersonal || restoringPersonal) return;
    setSavingPersonal(true);
    try {
      await saveGroupAccessMemberRules({
        groupKey: personalRuleGroup?.groupKey ?? selectedKey,
        userIds: [personalMember.userId],
        scopePermissions: personalScopePermissions,
        projectIds: personalScopePermissions.some((permission) => permission.projectScope === "selected") ? personalProjectIds : [],
      });
      setNotice({ kind: "ok", text: t("access.personalSaved") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.personalSaveFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setSavingPersonal(false);
    }
  }

  async function handleRestorePersonal(): Promise<void> {
    if (selectedKey === null || personalMember === null || personalRuleGroups.length === 0 || restoringPersonal || savingPersonal) return;
    if (!window.confirm(t("access.confirmRestoreDepartmentDefault"))) return;
    setRestoringPersonal(true);
    try {
      for (const group of personalRuleGroups) {
        await deleteGroupAccessMemberRules({ groupKey: group.groupKey, userIds: [personalMember.userId] });
      }
      setPersonalScopePermissions([]);
      setPersonalProjectIds([]);
      setNotice({ kind: "ok", text: t("access.personalRestored") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.personalRestoreFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setRestoringPersonal(false);
    }
  }

  async function handleToggleAdmin(member: GroupAccessMember): Promise<void> {
    if (adminBusyUserId !== null) return;
    const admin = adminByUserId.get(member.userId);
    if (admin !== undefined && !admin.removable) return;
    setAdminBusyUserId(member.userId);
    try {
      if (admin === undefined) {
        await assignGroupAccessAdmin(member.userId);
        setNotice({ kind: "ok", text: t("access.adminAssigned", { name: member.displayName }) });
      } else {
        await revokeGroupAccessAdmin(member.userId);
        setNotice({ kind: "ok", text: t("access.adminRemoved", { name: member.displayName }) });
      }
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.adminChangeFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setAdminBusyUserId(null);
    }
  }

  async function handleAccessChanged(): Promise<boolean> {
    const ok = await loadAccessData();
    if (ok) void loadMyPermissions(true);
    return ok;
  }

  const tabs: Array<{ value: AccessView; labelKey: TextKey }> = [
    { value: "departments", labelKey: "access.tabDepartment" },
    { value: "people", labelKey: "access.tabPeople" },
    { value: "dashboard", labelKey: "access.tabDashboard" },
  ];

  return (
    <>
      <AppHeader me={me} />
      <main className="w-full px-4 pb-10 pt-4 sm:px-6">
        <div data-access-control="" data-access-view={accessView} className="mx-auto w-full max-w-[1600px] space-y-4">
          <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t("access.managementTitle")}</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start">
              <span className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium " + (refreshing ? "border-blue-200 bg-blue-50 text-blue-700" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>
                <span className={"h-1.5 w-1.5 rounded-full " + (refreshing ? "animate-pulse bg-blue-500" : "bg-emerald-500")} />
                {refreshing ? t("access.dashboard.syncing") : t("access.dashboard.autoSync")}
                <span className="tabular-nums text-current/70">{syncTime}</span>
              </span>
              <button type="button" onClick={() => { setMatrixOpen(true); }} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-medium text-zinc-600 shadow-sm transition hover:border-blue-200 hover:text-blue-700">
                <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5"><path d="M3.5 4.5h5v11h-5zM11.5 4.5h5v7h-5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                {t("access.matrixOpen")}
              </button>
              <button type="button" disabled={refreshing || data === null} onClick={() => { setReload((value) => value + 1); }} aria-label={t("access.dashboard.refresh")} title={t("access.dashboard.refresh")} className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm transition hover:text-blue-700 disabled:opacity-40">
                <svg viewBox="0 0 24 24" aria-hidden="true" className={"h-4 w-4 " + (refreshing ? "access-refresh-spin" : "")}><path d="M18.5 8.5A7.5 7.5 0 1 0 19.2 13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><path d="M18.5 4.5v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </header>

          <section data-access-admin-roster="" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold text-zinc-900">{t("access.adminTitle")}</h2></div><span className="text-[10px] tabular-nums text-zinc-400">{data === null ? "—" : t("access.adminSummary", { n: data.admins.length })}</span></div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">{data === null ? <span className="h-6 w-40 animate-pulse rounded-full bg-zinc-100" aria-hidden="true" /> : data.admins.length === 0 ? <span className="text-xs text-zinc-400">{t("access.adminEmpty")}</span> : data.admins.map((admin) => <span key={admin.userId} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">{admin.displayName}<span className="text-emerald-500/80">{t(adminSourceKey(admin.source))}</span></span>)}</div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div data-access-view-toggle="" role="tablist" aria-label={t("access.viewAria")} className="inline-flex rounded-xl border border-zinc-200 bg-white p-1 shadow-sm">
              {tabs.map((tab) => (
                <button key={tab.value} type="button" role="tab" aria-selected={accessView === tab.value} data-access-view={tab.value} onClick={() => { setAccessView(tab.value); }} className={"rounded-lg px-3.5 py-1.5 text-xs font-medium transition " + (accessView === tab.value ? "bg-zinc-900 text-white shadow-sm" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800")}>
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              {data === null ? null : <span>{t("access.directorySummary", { departments: activeGroupCount, members: totalMemberCount })}</span>}
              {data === null ? null : <span className={"rounded-full px-2 py-0.5 font-medium " + (data.enforced ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{data.enforced ? t("access.dashboard.ruleLive") : t("access.dashboard.ruleDraft")}</span>}
            </div>
          </div>

          {state.kind === "loading" && accessView === "dashboard" ? <AccessDashboardSkeleton /> : null}
          {state.kind === "loading" && accessView !== "dashboard" ? (
            <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div className="h-[520px] animate-pulse rounded-2xl border border-zinc-200 bg-white" />
              <div className="space-y-4"><div className="h-36 animate-pulse rounded-2xl border border-zinc-200 bg-white" /><div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-white" /></div>
            </div>
          ) : null}
          {state.kind === "error" ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t("access.loadFailed", { message: state.message })}</p> : null}

          {data === null ? null : accessView === "dashboard" ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-3">
                <span className="text-xs font-medium text-zinc-600">{t("access.dashboard.departmentScope")}</span>
                <div className="w-[280px] max-w-full"><SelectMenu value={scopeGroupKey ?? ""} options={[{ value: "", label: t("access.dashboard.allDepartments") }, ...scopeOptions.map((option) => ({ value: option.groupKey, label: option.pathText }))]} onChange={(value) => { setScopeGroupKey(value === "" ? null : value); }} ariaLabel={t("access.dashboard.departmentScope")} disabled={data === null} /></div>
              </div>
              {dashboardModel === null ? null : <AccessDashboard data={data} model={dashboardModel} refreshSeq={refreshSeq} refreshing={refreshing} onChanged={handleAccessChanged} onNotify={(kind, text) => { setNotice({ kind, text }); }} />}
            </div>
          ) : accessView === "departments" ? (
            <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm lg:sticky lg:top-3">
                <div className="border-b border-zinc-200 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-zinc-900">{t("access.directoryTitle")}</h2><span className="text-[10px] text-zinc-400">{t("access.departmentCount", { n: activeGroupCount })}</span></div>
                  <label className="mt-2.5 flex items-center gap-2 rounded-lg bg-zinc-100 px-2.5 py-2 ring-1 ring-inset ring-zinc-200 focus-within:bg-white focus-within:ring-blue-300">
                    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-400"><circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                    <input value={directoryQuery} onChange={(event) => { setDirectoryQuery(event.target.value); }} placeholder={t("access.directorySearch")} aria-label={t("access.directorySearch")} className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400" />
                    {directoryQuery === "" ? null : <button type="button" onClick={() => { setDirectoryQuery(""); }} aria-label={t("access.clearSearch")} className="shrink-0 text-zinc-400 hover:text-zinc-700"><svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg></button>}
                  </label>
                </div>
                <div className="scrollbar-hidden max-h-[calc(100vh-235px)] min-h-[280px] overflow-y-auto p-2">
                  {directorySections.length === 0 ? <EmptyHint>{t("access.directoryNoMatch")}</EmptyHint> : directorySections.map((section) => (
                    <div key={section.key} className="mb-2 last:mb-0">
                      <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{section.label}</p>
                      {section.items.map(({ group, pathText }) => {
                        const selected = group.groupKey === selectedKey;
                        return (
                          <button key={group.groupKey} type="button" onClick={() => { openGroup(group); }} aria-pressed={selected} className={"group mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition " + (selected ? "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200" : "text-zinc-600 hover:bg-zinc-50")}>
                            <span className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " + (selected ? "bg-white text-blue-600 shadow-sm" : "bg-zinc-100 text-zinc-400 group-hover:text-blue-500")}><svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /></svg></span>
                            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{group.groupName}</span><span className={"mt-0.5 block truncate text-[10px] " + (selected ? "text-blue-600/70" : "text-zinc-400")}>{pathText}</span></span>
                            <span className={"shrink-0 text-[10px] tabular-nums " + (selected ? "text-blue-700" : "text-zinc-400")}>{group.memberCount}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </aside>

              <section className="min-w-0 space-y-4">
                {selectedGroup === null ? <EmptyHint>{t("access.noGroupSelected")}</EmptyHint> : (
                  <>
                    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-500 ring-1 ring-blue-100"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /><path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" /></svg></span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-semibold tracking-tight text-zinc-900">{selectedGroup.groupName}</h2>{selectedRule === null ? <RoleTag tone="zinc">{t("access.unconfigured")}</RoleTag> : <RoleTag tone="emerald">{t("access.configured")}</RoleTag>}</div>
                            <p className="mt-1 truncate text-[11px] text-zinc-400">{selectedPath.length > 0 ? selectedPath.join(" / ") : selectedGroup.groupKey}</p>
                            <p className="mt-1 text-[11px] text-zinc-500">{t("access.departmentHeroMeta", { members: selectedMembers.length, personal: selectedGroup.memberRules.length })}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <RoleTag tone="blue">{t("access.roleManagerCount", { n: selectedMemberCounts.projectManagers })}</RoleTag>
                          <RoleTag tone="emerald">{t("access.roleMemberCount", { n: selectedMemberCounts.projectMembers })}</RoleTag>
                          <RoleTag tone="violet">{t("access.roleTaskOwnerCount", { n: selectedMemberCounts.taskOwners })}</RoleTag>
                        </div>
                      </div>
                    </div>

                    <div data-access-department-default="true" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div><h3 className="text-sm font-semibold text-zinc-800">{t("access.extraScopeTitle")}</h3><p className="mt-0.5 text-xs leading-5 text-zinc-500">{t("access.extraScopeHint")}</p></div>
                        <button type="button" onClick={() => { setDepartmentScopePermissions([]); setDepartmentProjectIds([]); }} className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-zinc-500 transition hover:bg-amber-50 hover:text-amber-700">{t("access.clearExtraScope")}</button>
                      </div>
                      <div className="mt-3"><AccessScopePicker scopePermissions={departmentScopePermissions} onChange={setDepartmentScopePermissions} /></div>
                      {departmentScopePermissions.some((permission) => permission.projectScope === "selected") ? <ProjectPicker projects={filteredDepartmentProjects} selectedIds={departmentProjectIds} query={departmentProjectQuery} t={t} onQueryChange={setDepartmentProjectQuery} onToggle={toggleDepartmentProject} /> : null}
                      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-zinc-400"><svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 9v4M10 6.6v.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span title={t("access.scopeFootNoteTitle")}>{t("access.scopeFootNote")}</span></p>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-100 px-4 py-3.5 sm:px-5">
                        <div><h3 className="text-sm font-semibold text-zinc-800">{t("access.memberEffectTitle")}</h3><p className="mt-0.5 text-xs text-zinc-500">{t("access.memberEffectHint")}</p></div>
                        <RoleTag tone="amber">{t("access.personalCoverageCount", { n: selectedGroup.memberRules.length })}</RoleTag>
                      </div>
                      <div className="grid grid-cols-2 divide-x divide-y divide-zinc-100 border-b border-zinc-100 bg-zinc-50/50 sm:grid-cols-4 sm:divide-y-0">
                        <div className="px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.summaryMembers")}</p><p className="mt-0.5 text-sm font-semibold text-zinc-800">{selectedMembers.length}</p></div>
                        <div className="px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.summaryRelations")}</p><p className="mt-0.5 text-sm font-semibold text-zinc-800">{selectedMemberCounts.relations}</p></div>
                        <div className="px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.summaryOverrides")}</p><p className="mt-0.5 text-sm font-semibold text-zinc-800">{selectedGroup.memberRules.length}</p></div>
                        <div className="px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.summaryDefaultScope")}</p><p className="mt-0.5 truncate text-xs font-semibold text-zinc-800">{scopeSummary(t, selectedRuleScopes)}</p></div>
                      </div>
                      {selectedMembers.length === 0 ? <div className="p-4"><EmptyHint>{t("access.noMembers")}</EmptyHint></div> : (
                        <div>
                          <div className="hidden grid-cols-[minmax(150px,1.2fr)_minmax(190px,1.35fr)_minmax(140px,1fr)_96px_104px] gap-3 border-b border-zinc-100 bg-white px-4 py-2 text-[10px] font-medium text-zinc-400 xl:grid">
                            <span>{t("access.memberColumn")}</span><span>{t("access.autoRoleColumn")}</span><span>{t("access.overrideColumn")}</span><span>{t("access.visibleColumn")}</span><span>{t("access.editableColumn")}</span>
                          </div>
                          <div className="divide-y divide-zinc-100">
                            {(showAllMembers ? selectedMembers : selectedMembers.slice(0, 8)).map((member) => {
                              const automatic = automaticRoleOf(rolesById, member.userId);
                              const effective = effectiveMemberPermission(data, member.userId, automatic, adminByUserId.has(member.userId));
                              const personal = memberRuleOf(selectedGroup, member.userId);
                              return (
                                <div key={member.userId} className="px-4 py-3 transition hover:bg-zinc-50/70 xl:grid xl:grid-cols-[minmax(150px,1.2fr)_minmax(190px,1.35fr)_minmax(140px,1fr)_96px_104px] xl:items-center xl:gap-3">
                                  <div className="flex min-w-0 items-center gap-2.5">
                                    <MemberAvatar member={member} size="md" />
                                    <span className="min-w-0"><span className="flex items-center gap-1.5"><span className="truncate text-xs font-semibold text-zinc-800">{member.displayName}</span>{adminByUserId.has(member.userId) ? <RoleTag tone="blue">{t("access.adminBadge")}</RoleTag> : null}{member.status === "disabled" ? <RoleTag tone="zinc">{t("access.memberDisabled")}</RoleTag> : null}</span><span className="mt-0.5 block truncate text-[10px] text-zinc-400">{member.username}{member.email === null ? "" : " · " + member.email}</span></span>
                                    <button type="button" onClick={() => { openPersonalFor(selectedGroup, member); }} className="ml-auto shrink-0 rounded-md p-1 text-zinc-300 transition hover:bg-indigo-50 hover:text-indigo-600 xl:hidden" aria-label={t("access.openPersonalFor", { name: member.displayName })}><svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5"><path d="m7 4 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1 xl:mt-0">
                                    {automatic.managerCount === 0 && automatic.memberCount === 0 && automatic.taskOwnerProjectCount === 0 ? <span className="text-[10px] text-zinc-400">{t("access.noAutoRole")}</span> : null}
                                    {automatic.managerCount > 0 ? <RoleTag tone="blue">{t("access.managerTag", { n: automatic.managerCount })}</RoleTag> : null}
                                    {automatic.memberCount > 0 ? <RoleTag tone="emerald">{t("access.memberTag", { n: automatic.memberCount })}</RoleTag> : null}
                                    {automatic.taskOwnerProjectCount > 0 ? <RoleTag tone="violet">{t("access.taskOwnerTag", { n: automatic.taskOwnerProjectCount })}</RoleTag> : null}
                                  </div>
                                  <div className="mt-2 min-w-0 xl:mt-0"><p className="truncate text-[10px] text-zinc-500">{personal === null ? t("access.overrideInherit") : scopeSummary(t, scopePermissionsOf(personal.scopePermissions, personal.projectScope, personal.accessLevel))}</p>{personal === null ? null : <button type="button" onClick={() => { openPersonalFor(selectedGroup, member); }} className="mt-0.5 text-[10px] font-medium text-indigo-600 hover:text-indigo-800 xl:hidden">{t("access.editPersonal")}</button>}</div>
                                  <div className="mt-2 xl:mt-0"><p className="text-[10px] text-zinc-400 xl:hidden">{t("access.visibleColumn")}</p><p className="truncate text-[11px] font-medium text-zinc-700">{visibleText(t, effective)}</p></div>
                                  <div className="mt-1 xl:mt-0"><p className="text-[10px] text-zinc-400 xl:hidden">{t("access.editableColumn")}</p><p className="truncate text-[11px] font-medium text-zinc-700">{editableText(t, effective)}</p></div>
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 px-4 py-2.5 text-[10px] text-zinc-400">
                            <span>{t("access.memberTableFoot")}</span>
                            {selectedMembers.length > 8 ? <button type="button" onClick={() => { setShowAllMembers((value) => !value); }} className="font-medium text-blue-600 hover:text-blue-800">{showAllMembers ? t("access.showFewerMembers") : t("access.viewAllMembers", { n: selectedMembers.length })}</button> : null}
                          </div>
                        </div>
                      )}
                    </div>


                    <div className="sticky bottom-3 z-20 flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] backdrop-blur sm:flex-row sm:items-center">
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        {selectedRule === null ? null : <button type="button" onClick={() => { void handleDeleteDepartment(); }} disabled={deletingDepartment || savingDepartment} className="rounded-lg px-2.5 py-2 text-[11px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40">{deletingDepartment ? t("access.deleting") : t("access.deleteDepartmentDefault")}</button>}
                        <button type="button" onClick={resetDepartmentDraft} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50">{t("access.reset")}</button>
                        <button type="button" onClick={() => { void handleSaveDepartment(); }} disabled={savingDepartment || deletingDepartment} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50">{savingDepartment ? t("access.saving") : t("access.saveDepartmentDefault")}</button>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>
          ) : (

            <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm lg:sticky lg:top-3">
                <div className="border-b border-zinc-200 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold text-zinc-900">{t("access.personalDirectoryTitle")}</h2><span className="text-[10px] text-zinc-400">{t("access.departmentCount", { n: activeGroupCount })}</span></div>
                  <div className="mt-2.5"><SelectMenu value={selectedKey ?? ""} options={scopeOptions.map((option) => ({ value: option.groupKey, label: option.pathText }))} onChange={changePersonalGroup} ariaLabel={t("access.selectDepartment")} disabled={data === null} /></div>
                  <label className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-100 px-2.5 py-2 ring-1 ring-inset ring-zinc-200 focus-within:bg-white focus-within:ring-blue-300"><svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-400"><circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg><input value={personalDirectoryQuery} onChange={(event) => { setPersonalDirectoryQuery(event.target.value); }} placeholder={t("access.personSearch")} aria-label={t("access.personSearch")} className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400" /></label>
                </div>
                <div className="scrollbar-hidden max-h-[calc(100vh-285px)] min-h-[260px] overflow-y-auto p-2">
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{selectedGroup?.groupName ?? t("access.selectDepartment")}</p>
                  {personalVisibleMembers.length === 0 ? <EmptyHint>{t("access.directoryNoMatch")}</EmptyHint> : personalVisibleMembers.map((member) => {
                    const automatic = automaticRoleOf(rolesById, member.userId);
                    const selected = member.userId === personalUserId;
                    return (
                      <button key={member.userId} type="button" onClick={() => { selectPersonalMember(member); }} aria-pressed={selected} className={"mb-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition " + (selected ? "bg-indigo-50 ring-1 ring-inset ring-indigo-200" : "hover:bg-zinc-50")}>
                        <MemberAvatar member={member} size="md" />
                        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-zinc-800">{member.displayName}</span><span className="mt-0.5 block truncate text-[10px] text-zinc-400">{t("access.autoRelationsShort", { n: automatic.relationCount })}</span></span>
                        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-300"><path d="m7 4 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    );
                  })}
                </div>
                <div className="border-t border-zinc-100 bg-zinc-50/60 px-3 py-2.5 text-[10px] leading-4 text-zinc-400">{t("access.personalSideNote")}</div>
              </aside>

              <section className="min-w-0 space-y-4">
                {personalMember === null || personalEffective === null || personalManual === null ? <EmptyHint>{t("access.personNoMember")}</EmptyHint> : (
                  <>
                    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start gap-3">
                        <MemberAvatar member={personalMember} size="lg" />
                        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold tracking-tight text-zinc-900">{personalMember.displayName}</h2><RoleTag tone={personalMember.status === "active" ? "emerald" : "zinc"}>{personalMember.status === "active" ? t("access.active") : t("access.memberDisabled")}</RoleTag>{personalAdmin === null ? null : <RoleTag tone="blue">{t("access.adminBadge")}</RoleTag>}</div><p className="mt-1 text-[11px] text-zinc-500">{personalMember.username}{personalMember.email === null ? "" : " · " + personalMember.email}</p><p className="mt-1 truncate text-[11px] text-zinc-400">{personalGroups.map((group) => group.groupName).join(" / ")}</p></div>
                        <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => { void handleToggleAdmin(personalMember); }} disabled={adminBusyUserId !== null || (personalAdmin !== null && !personalAdmin.removable)} title={personalAdmin !== null && !personalAdmin.removable ? t("access.adminImmutable") : undefined} className="rounded-lg border border-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-40">{adminBusyUserId === personalMember.userId ? t("access.adminBusy") : personalAdmin === null ? t("access.makeAdmin") : t("access.removeAdmin")}</button><span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-medium text-zinc-500">{t("access.autoRelationsShort", { n: personalEffective.automatic.relationCount })}</span></div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-zinc-800">{t("access.autoRolesTitle")}</h3><p className="mt-0.5 text-xs text-zinc-500">{t("access.autoRolesHint")}</p></div><RoleTag tone="blue"><svg viewBox="0 0 20 20" aria-hidden="true" className="h-3 w-3"><rect x="4.5" y="8.5" width="11" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M7 8.5V6.7a3 3 0 0 1 6 0v1.8" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>{t("access.systemMaintained")}</RoleTag></div>
                      <div className="mt-3 grid gap-2.5 md:grid-cols-3">
                        <RoleProjectBlock title={t("access.autoRoleManagers")} count={personalEffective.automatic.managerCount} tone="blue" projectIds={personalEffective.automatic.role.projectManagerProjectIds} projectsById={projectsById} t={t} />
                        <RoleProjectBlock title={t("access.autoRoleMembers")} count={personalEffective.automatic.memberCount} tone="emerald" projectIds={personalEffective.automatic.role.projectMemberProjectIds} projectsById={projectsById} t={t} />
                        <RoleProjectBlock title={t("access.autoRoleTaskOwners")} count={personalEffective.automatic.taskOwnerProjectCount} tone="violet" projectIds={personalEffective.automatic.role.taskOwnerProjectIds} projectsById={projectsById} footer={t("access.taskCountNote", { n: personalEffective.automatic.taskOwnerTaskCount })} t={t} />
                      </div>
                      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-zinc-400"><svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 9v4M10 6.6v.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span>{t("access.taskOwnerNote")}</span></p>
                    </div>

                    <div data-access-personal-editor="true" className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-zinc-800">{t("access.extraPersonalTitle")}</h3><p className="mt-0.5 text-xs leading-5 text-zinc-500">{t("access.extraPersonalHint")}</p></div><RoleTag tone="amber">{t("access.manualConfigured")}</RoleTag></div>
                      {personalRuleGroups.length === 0 ? null : <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-700 ring-1 ring-inset ring-amber-100">{t("access.personalRuleSource", { groups: personalRuleGroups.map((group) => group.groupName).join(" / ") })}</p>}
                      <div className="mt-3"><AccessScopePicker scopePermissions={personalScopePermissions} onChange={setPersonalScopePermissions} /></div>
                      {personalScopePermissions.some((permission) => permission.projectScope === "selected") ? <ProjectPicker projects={filteredPersonalProjects} selectedIds={personalProjectIds} query={personalProjectQuery} t={t} onQueryChange={setPersonalProjectQuery} onToggle={togglePersonalProject} /> : null}
                      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-zinc-400"><svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 9v4M10 6.6v.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span>{t("access.personalFootNote")}</span></p>
                    </div>

                    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-zinc-800">{t("access.finalTitle")}</h3><p className="mt-0.5 text-xs text-zinc-500">{t("access.finalHint")}</p></div><RoleTag tone="zinc">{t("access.liveCalculated")}</RoleTag></div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.visibleColumn")}</p><p className="mt-0.5 text-sm font-semibold text-zinc-800">{visibleText(t, personalEffective)}</p></div>
                        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.editableColumn")}</p><p className="mt-0.5 text-sm font-semibold text-zinc-800">{editableText(t, personalEffective)}</p></div>
                        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2.5"><p className="text-[10px] text-zinc-400">{t("access.manualScopeLabel")}</p><p className="mt-0.5 truncate text-sm font-semibold text-zinc-800">{scopeSummary(t, personalManual.permissions)}</p></div>
                      </div>
                      <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
                        <div className="hidden grid-cols-[minmax(180px,1.3fr)_minmax(180px,1.2fr)_96px] gap-2 bg-zinc-50 px-3 py-2 text-[10px] font-medium text-zinc-400 sm:grid"><span>{t("access.projectTaskColumn")}</span><span>{t("access.sourceColumn")}</span><span>{t("access.finalRightsColumn")}</span></div>
                        {personalPreview.length === 0 ? <p className="px-3 py-5 text-center text-[11px] text-zinc-400">{t("access.noEffectiveRows")}</p> : personalPreview.map((row) => <div key={row.projectId} className="grid gap-1 border-t border-zinc-100 px-3 py-2 text-[11px] first:border-t-0 sm:grid-cols-[minmax(180px,1.3fr)_minmax(180px,1.2fr)_96px] sm:items-center sm:gap-2"><span className="min-w-0 truncate font-medium text-zinc-700">{projectLabel(projectsById.get(row.projectId), row.projectId)}</span><span className="flex min-w-0 flex-wrap gap-1">{row.sources.map((source) => <span key={source} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500">{source}</span>)}</span><span className={"font-medium " + (row.level === "edit" ? "text-blue-700" : row.level === "task" ? "text-violet-700" : "text-emerald-700")}>{row.level === "edit" ? t("access.rightEdit") : row.level === "task" ? t("access.rightTask") : t("access.rightView")}</span></div>)}
                        {personalEffective.visibleAll || personalEffective.visibleProjectIds.length > personalPreview.length ? <div className="border-t border-zinc-100 px-3 py-2 text-[10px] text-zinc-400">{t("access.previewTruncated", { shown: personalPreview.length, total: personalEffective.visibleAll ? data.projects.length : personalEffective.visibleProjectIds.length })}</div> : null}
                      </div>
                    </div>

                    <div className="sticky bottom-3 z-20 flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] backdrop-blur sm:flex-row sm:items-center">
                      <p className="flex min-w-0 items-start gap-1.5 text-[10px] leading-4 text-zinc-400"><svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500"><path d="m10 2 1.5 4.3L16 8l-4.5 1.7L10 14l-1.5-4.3L4 8l4.5-1.7L10 2Z" fill="currentColor" /></svg><span>{t("access.saveBarPersonal")}</span></p>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <button type="button" onClick={() => { void handleRestorePersonal(); }} disabled={personalRule === null || restoringPersonal || savingPersonal} className="rounded-lg px-2.5 py-2 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-40">{restoringPersonal ? t("access.restoring") : t("access.restoreDepartmentDefault")}</button>
                        <button type="button" onClick={resetPersonalDraft} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50">{t("access.reset")}</button>
                        <button type="button" onClick={() => { void handleSavePersonal(); }} disabled={savingPersonal || restoringPersonal} className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50">{savingPersonal ? t("access.saving") : t("access.savePersonalRules")}</button>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>
          )}
        </div>
      </main>
      <AccessPermissionMatrix open={matrixOpen} onClose={() => { setMatrixOpen(false); }} />
      {notice === null ? null : <Toast kind={notice.kind} text={notice.text} onClose={() => { setNotice(null); }} />}
    </>
  );
}
