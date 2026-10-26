import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignGroupAccessAdmin,
  deleteGroupAccessMemberRules,
  deleteGroupAccessRule,
  fetchAccessOverview,
  revokeGroupAccessAdmin,
  saveGroupAccessMemberRules,
  saveGroupAccessRule,
  type GroupAccessAccessLevel,
  type GroupAccessAdmin,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessMemberRule,
  type GroupAccessOverview,
  type GroupAccessProject,
  type GroupAccessProjectScope,
} from "./accessApi";
import { AccessDashboard, AccessDashboardSkeleton } from "./AccessDashboard";
import { buildAccessDashboardModel } from "./accessDashboardModel";
import { effectiveMemberAccess, memberRuleOf } from "./accessRules";
import { AccessScopePicker } from "./AccessScopePicker";
import { AppHeader } from "./components/AppHeader";
import { SelectMenu } from "./components/SelectMenu";
import { Toast, type ToastKind } from "./components/Toast";
import { useLocale, useT, type TextKey } from "./i18n";
import { loadMyPermissions } from "./permissions";
import type { MeResponse } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: GroupAccessOverview }
  | { kind: "error"; message: string };

type Notice = { kind: ToastKind; text: string };
type AccessView = "dashboard" | "rules";
type Translate = (key: TextKey, params?: Record<string, string | number>) => string;
type DepartmentTreeNode = { group: GroupAccessGroup; children: DepartmentTreeNode[] };

function memberSearchText(member: GroupAccessMember): string {
  return (member.displayName + " " + member.username + " " + (member.email ?? "")).toLowerCase();
}

function departmentMatches(group: GroupAccessGroup, query: string): boolean {
  return query === "" || (group.groupName + " " + group.groupKey).toLowerCase().includes(query);
}

function filterDepartmentTree(nodes: readonly DepartmentTreeNode[], query: string): DepartmentTreeNode[] {
  if (query === "") return [...nodes];
  const result: DepartmentTreeNode[] = [];
  for (const node of nodes) {
    if (departmentMatches(node.group, query)) {
      result.push(node);
      continue;
    }
    const children = filterDepartmentTree(node.children, query);
    const hasMember = node.group.members.some((member) => memberSearchText(member).includes(query));
    if (children.length > 0 || hasMember) {
      result.push({ group: node.group, children });
    }
  }
  return result;
}

function buildDepartmentTree(groups: readonly GroupAccessGroup[]): DepartmentTreeNode[] {
  const nodes = new Map<string, DepartmentTreeNode>();
  for (const group of groups) nodes.set(group.groupKey, { group, children: [] });
  const roots: DepartmentTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentKey = node.group.parentGroupKey ?? null;
    const parent = parentKey === null || parentKey === node.group.groupKey ? undefined : nodes.get(parentKey);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  const sort = (items: DepartmentTreeNode[]): void => {
    items.sort((left, right) => left.group.groupName.localeCompare(right.group.groupName, "zh-Hans-CN"));
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}

function collectDepartmentKeys(nodes: readonly DepartmentTreeNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    keys.push(node.group.groupKey);
    keys.push(...collectDepartmentKeys(node.children));
  }
  return keys;
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

function memberInitial(member: Pick<GroupAccessMember, "displayName">): string {
  const chars = Array.from(member.displayName.trim());
  return chars.length === 0 ? "?" : chars[0] ?? "?";
}

function adminSourceKey(source: GroupAccessAdmin["source"]): TextKey {
  if (source === "manual") return "access.adminSourceManual";
  return "access.adminSourceConfigured";
}

function MemberRow({
  member,
  depth,
  active,
  t,
  onSelect,
}: {
  member: GroupAccessMember;
  depth: number;
  active: boolean;
  t: Translate;
  onSelect: () => void;
}) {
  const detail = [member.username, member.email ?? ""].filter((item) => item !== "").join(" · ");
  return (
    <div style={{ paddingLeft: String(32 + depth * 14) + "px" }} className="pr-2">
      <button
        type="button"
        data-access-directory-member={member.userId}
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={"flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 " + (active ? "bg-blue-50/80 ring-1 ring-inset ring-blue-200" : "hover:bg-zinc-50")}
        title={member.email ?? member.username}
      >
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
          {memberInitial(member)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-700">{member.displayName}</span>
            {member.status === "disabled" ? (
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{t("access.memberDisabled")}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-400">{detail}</span>
        </span>
      </button>
    </div>
  );
}

function SelectionCheckbox({
  checked,
  indeterminate,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 shrink-0 cursor-pointer rounded border-zinc-300 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function SelectableMemberRow({
  member,
  checked,
  admin,
  adminBusy,
  personalRule,
  focused,
  t,
  onToggle,
  onToggleAdmin,
}: {
  member: GroupAccessMember;
  checked: boolean;
  admin: GroupAccessAdmin | undefined;
  adminBusy: boolean;
  personalRule: GroupAccessMemberRule | null;
  focused: boolean;
  t: Translate;
  onToggle: () => void;
  onToggleAdmin: () => void;
}) {
  const detail = [member.username, member.email ?? ""].filter((item) => item !== "").join(" · ");
  return (
    <div
      data-access-rule-member={member.userId}
      className={"flex items-center gap-2 rounded-lg px-3 py-2 transition " + (focused ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : "hover:bg-blue-50/60")}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
        <SelectionCheckbox checked={checked} indeterminate={false} onChange={onToggle} />
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
          {memberInitial(member)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-zinc-800">{member.displayName}</span>
            {member.status === "disabled" ? (
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{t("access.memberDisabled")}</span>
            ) : null}
            {personalRule === null ? null : (
              <span data-access-personal-badge={member.userId} className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                {t("access.personalBadge")}
              </span>
            )}
            {admin === undefined ? null : (
              <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">{t("access.adminBadge")}</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-400">{detail}</span>
        </span>
      </label>
      {admin === undefined ? (
        <button
          type="button"
          onClick={onToggleAdmin}
          disabled={adminBusy}
          className="shrink-0 whitespace-nowrap rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
        >
          {adminBusy ? t("access.adminBusy") : t("access.makeAdmin")}
        </button>
      ) : admin.removable ? (
        <button
          type="button"
          onClick={onToggleAdmin}
          disabled={adminBusy}
          className="shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          {adminBusy ? t("access.adminBusy") : t("access.removeAdmin")}
        </button>
      ) : (
        <span title={t("access.adminImmutable")} className="shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-2 py-1 text-[10px] text-zinc-500">
          {t(adminSourceKey(admin.source))}
        </span>
      )}
    </div>
  );
}

function ProjectSelectionList({
  projects,
  query,
  selectedIds,
  t,
  onQueryChange,
  onToggle,
}: {
  projects: readonly GroupAccessProject[];
  query: string;
  selectedIds: readonly string[];
  t: Translate;
  onQueryChange: (value: string) => void;
  onToggle: (projectId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-zinc-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
        <input
          value={query}
          onChange={(event) => { onQueryChange(event.target.value); }}
          placeholder={t("access.projectSearch")}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
        />
        <span className="text-xs text-zinc-500">{t("access.selectedCount", { n: selectedIds.length })}</span>
      </div>
      <div className="scrollbar-hidden max-h-56 overflow-auto p-2">
        {projects.length === 0 ? <p className="px-2 py-3 text-xs text-zinc-500">{t("access.noProjects")}</p> : null}
        {projects.map((project) => (
          <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
            <input type="checkbox" checked={selectedIds.includes(project.id)} onChange={() => { onToggle(project.id); }} className="h-4 w-4 accent-zinc-900" />
            <span className="font-mono text-xs text-zinc-400">{project.code}</span>
            <span className="min-w-0 truncate">{project.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function DepartmentTree({
  nodes,
  depth,
  selectedKey,
  expandedKeys,
  activeMemberId,
  query,
  t,
  onSelect,
  onToggle,
  onMemberSelect,
}: {
  nodes: readonly DepartmentTreeNode[];
  depth: number;
  selectedKey: string | null;
  expandedKeys: ReadonlySet<string>;
  activeMemberId: string | null;
  query: string;
  t: Translate;
  onSelect: (group: GroupAccessGroup) => void;
  onToggle: (groupKey: string) => void;
  onMemberSelect: (group: GroupAccessGroup, member: GroupAccessMember) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const group = node.group;
        const selfMatch = query !== "" && departmentMatches(group, query);
        const members = query === "" || selfMatch
          ? group.members
          : group.members.filter((member) => memberSearchText(member).includes(query));
        const expanded = query !== "" || expandedKeys.has(group.groupKey);
        const hasContent = group.members.length > 0 || node.children.length > 0;
        const selected = group.groupKey === selectedKey;
        return (
          <div key={group.groupKey} style={{ paddingLeft: String(depth * 14) + "px" }}>
            <div className={"group flex items-stretch rounded-lg " + (selected ? "bg-blue-50 text-blue-950 ring-1 ring-inset ring-blue-200" : "text-zinc-700 hover:bg-zinc-50")}>
              <button
                type="button"
                onClick={() => { onToggle(group.groupKey); }}
                disabled={!hasContent}
                aria-expanded={hasContent ? expanded : undefined}
                aria-label={expanded ? t("access.collapseDepartment") : t("access.expandDepartment")}
                className={"flex w-7 shrink-0 items-center justify-center rounded-l-lg " + (hasContent ? "cursor-pointer" : "cursor-default opacity-0")}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true" className={"h-3.5 w-3.5 transition-transform " + (expanded ? "rotate-90" : "")}>
                  <path d="M7 4.5 12.5 10 7 15.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => { onSelect(group); }} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left">
                <svg viewBox="0 0 24 24" aria-hidden="true" className={"h-5 w-5 shrink-0 " + (selected ? "text-blue-500" : "text-blue-400")}>
                  <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" opacity="0.95" />
                  <path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" />
                </svg>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{group.groupName}</span>
                  <span className={"mt-0.5 block truncate text-[11px] " + (selected ? "text-blue-600" : "text-zinc-400")}>
                    {t("access.members", { n: group.memberCount })}
                    {" · "}
                    {group.rule === null ? t("access.unconfigured") : t("access.configured")}
                  </span>
                </span>
              </button>
            </div>
            {expanded ? (
              <div className="pb-1 pt-0.5">
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    depth={depth}
                    active={member.userId === activeMemberId}
                    t={t}
                    onSelect={() => { onMemberSelect(group, member); }}
                  />
                ))}
                {group.members.length === 0 && node.children.length === 0 ? (
                  <p style={{ paddingLeft: String(34 + depth * 14) + "px" }} className="py-1 pr-2 text-[11px] text-zinc-400">
                    {t("access.noMembers")}
                  </p>
                ) : null}
                <DepartmentTree
                  nodes={node.children}
                  depth={depth + 1}
                  selectedKey={selectedKey}
                  expandedKeys={expandedKeys}
                  activeMemberId={activeMemberId}
                  query={query}
                  t={t}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onMemberSelect={onMemberSelect}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * 部门权限页（2026-10-23 上线；2026-10-24 改通讯录式部门树）：
 * 部门层级与直属人员来自 Casdoor 自动同步；右侧只做页面 / 项目范围配置。
 * 本页不改裁决开关：GROUP_ACCESS_ENFORCED=false 时规则仍只保存、不限制账号。
 */
export function AccessControlPage({ me }: { me: MeResponse }) {
  const t = useT();
  const locale = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [accessView, setAccessView] = useState<AccessView>("dashboard");
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
  const [departmentProjectScope, setDepartmentProjectScope] = useState<GroupAccessProjectScope>("none");
  const [departmentAccessLevel, setDepartmentAccessLevel] = useState<GroupAccessAccessLevel>("view");
  const [departmentProjectIds, setDepartmentProjectIds] = useState<string[]>([]);
  const [personalProjectScope, setPersonalProjectScope] = useState<GroupAccessProjectScope>("none");
  const [personalAccessLevel, setPersonalAccessLevel] = useState<GroupAccessAccessLevel>("view");
  const [personalProjectIds, setPersonalProjectIds] = useState<string[]>([]);
  const [selectedMemberUserIds, setSelectedMemberUserIds] = useState<string[]>([]);
  const [departmentProjectQuery, setDepartmentProjectQuery] = useState("");
  const [personalProjectQuery, setPersonalProjectQuery] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [deletingDepartment, setDeletingDepartment] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [restoringMembers, setRestoringMembers] = useState(false);
  const [adminBusyUserId, setAdminBusyUserId] = useState<string | null>(null);
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
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== dataSignatureRef.current) {
        dataSignatureRef.current = nextSignature;
        setState({ kind: "ready", data: next });
        setLastSyncedAt(new Date());
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
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadAccessData, reload]);

  useEffect(() => {
    const refreshIfVisible = (): void => {
      if (document.visibilityState === "visible") void loadAccessData({ background: true });
    };
    const timer = window.setInterval(refreshIfVisible, 30_000);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") refreshIfVisible();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadAccessData]);

  const data = state.kind === "ready" ? state.data : null;
  useEffect(() => {
    if (selectedKey !== null || data === null || data.groups.length === 0) return;
    const byKey = new Map(data.groups.map((group) => [group.groupKey, group] as const));
    const initial = data.groups.find((group) => data.currentGroupKeys.includes(group.groupKey)) ?? data.groups[0];
    if (initial === undefined) return;
    const branch = new Set<string>();
    let current: GroupAccessGroup | undefined = initial;
    while (current !== undefined && !branch.has(current.groupKey)) {
      branch.add(current.groupKey);
      current = current.parentGroupKey === null ? undefined : byKey.get(current.parentGroupKey);
    }
    setSelectedKey(initial.groupKey);
    setExpandedKeys((keys) => new Set([...keys, ...branch]));
    applyGroup(initial);
  }, [data, selectedKey]);

  const allGroups = data?.groups ?? [];
  const normalizedDirectoryQuery = directoryQuery.trim().toLowerCase();
  const departmentTree = useMemo(() => buildDepartmentTree(allGroups), [allGroups]);
  const filteredTree = useMemo(
    () => filterDepartmentTree(departmentTree, normalizedDirectoryQuery),
    [departmentTree, normalizedDirectoryQuery],
  );
  const allDepartmentKeys = useMemo(() => collectDepartmentKeys(departmentTree), [departmentTree]);
  const allExpanded = allDepartmentKeys.length > 0 && allDepartmentKeys.every((key) => expandedKeys.has(key));
  const groupByKey = new Map(allGroups.map((group) => [group.groupKey, group] as const));
  const admins = data?.admins ?? [];
  const adminByUserId = new Map(admins.map((admin) => [admin.userId, admin] as const));
  const totalMemberCount = new Set(allGroups.flatMap((group) => group.members.map((member) => member.userId))).size;
  const selectedGroup = selectedKey === null ? null : groupByKey.get(selectedKey) ?? null;
  const selectedRule = selectedGroup?.rule ?? null;
  const selectedGroupMembers = selectedGroup?.members ?? [];
  const selectedMemberIdSet = new Set(
    selectedMemberUserIds.filter((userId) => selectedGroupMembers.some((member) => member.userId === userId)),
  );
  const selectedMemberCount = selectedGroupMembers.filter((member) => selectedMemberIdSet.has(member.userId)).length;
  const allMembersSelected = selectedGroupMembers.length > 0 && selectedMemberCount === selectedGroupMembers.length;
  const someMembersSelected = selectedMemberCount > 0 && !allMembersSelected;
  const selectedHasPersonalRule = selectedGroupMembers.some(
    (member) => selectedMemberIdSet.has(member.userId) && memberRuleOf(selectedGroup as GroupAccessGroup, member.userId) !== null,
  );
  const personalRuleCount = selectedGroup?.memberRules.length ?? 0;
  const selectedPath = selectedKey === null ? [] : departmentPathOf(selectedKey, groupByKey);
  const departmentQuery = departmentProjectQuery.trim().toLowerCase();
  const personalQuery = personalProjectQuery.trim().toLowerCase();
  const departmentProjects = data === null
    ? []
    : departmentQuery === ""
      ? data.projects
      : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(departmentQuery));
  const personalProjects = data === null
    ? []
    : personalQuery === ""
      ? data.projects
      : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(personalQuery));
  const dashboardModel = useMemo(() => data === null ? null : buildAccessDashboardModel(data, scopeGroupKey), [data, scopeGroupKey]);
  const scopeOptions = useMemo(() => {
    if (data === null) return [] as Array<{ groupKey: string; pathText: string }>;
    const byKey = new Map(data.groups.map((group) => [group.groupKey, group] as const));
    return data.groups
      .map((group) => ({ groupKey: group.groupKey, pathText: departmentPathOf(group.groupKey, byKey).join(" / ") || group.groupName }))
      .sort((left, right) => left.pathText.localeCompare(right.pathText, "zh-Hans-CN"));
  }, [data]);
  useEffect(() => {
    if (focusedMemberId === null) return;
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('[data-access-rule-member="' + focusedMemberId + '"]');
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [focusedMemberId, selectedKey]);

  const syncTime = lastSyncedAt === null
    ? "—"
    : new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(lastSyncedAt);

  useEffect(() => {
    if (scopeGroupKey === null || data === null) return;
    if (!data.groups.some((group) => group.groupKey === scopeGroupKey)) setScopeGroupKey(null);
  }, [data, scopeGroupKey]);

  function setDepartmentRuleFrom(group: GroupAccessGroup): void {
    setDepartmentProjectScope(group.rule?.projectScope ?? "none");
    setDepartmentAccessLevel(group.rule?.accessLevel ?? "view");
    setDepartmentProjectIds(group.rule?.projectIds ?? []);
  }

  function setPersonalRuleFromDepartment(group: GroupAccessGroup): void {
    setPersonalProjectScope(group.rule?.projectScope ?? "none");
    setPersonalAccessLevel(group.rule?.accessLevel ?? "view");
    setPersonalProjectIds(group.rule?.projectIds ?? []);
  }

  function setPersonalRuleFromEffective(group: GroupAccessGroup, userId: string): void {
    const effective = effectiveMemberAccess(group, userId);
    setPersonalProjectScope(effective.projectScope);
    setPersonalAccessLevel(effective.accessLevel);
    setPersonalProjectIds(effective.projectIds);
  }

  function applyGroup(group: GroupAccessGroup): void {
    setDepartmentRuleFrom(group);
    setPersonalRuleFromDepartment(group);
    setSelectedMemberUserIds([]);
    setDepartmentProjectQuery("");
    setPersonalProjectQuery("");
  }

  function openGroup(group: GroupAccessGroup): void {
    setSelectedKey(group.groupKey);
    setFocusedMemberId(null);
    setExpandedKeys((current) => new Set(current).add(group.groupKey));
    applyGroup(group);
  }

  function openMember(group: GroupAccessGroup, member: GroupAccessMember): void {
    if (group.groupKey !== selectedKey) {
      setSelectedKey(group.groupKey);
      setExpandedKeys((current) => new Set(current).add(group.groupKey));
      applyGroup(group);
    }
    setSelectedMemberUserIds([member.userId]);
    setPersonalRuleFromEffective(group, member.userId);
    setFocusedMemberId(member.userId);
  }

  function toggleExpanded(groupKey: string): void {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function toggleAllExpanded(): void {
    setExpandedKeys(allExpanded ? new Set() : new Set(allDepartmentKeys));
  }

  function changeDepartmentScope(next: { projectScope: GroupAccessProjectScope; accessLevel: GroupAccessAccessLevel }): void {
    setDepartmentProjectScope(next.projectScope);
    setDepartmentAccessLevel(next.projectScope === "none" ? "view" : next.accessLevel);
  }

  function changePersonalScope(next: { projectScope: GroupAccessProjectScope; accessLevel: GroupAccessAccessLevel }): void {
    setPersonalProjectScope(next.projectScope);
    setPersonalAccessLevel(next.projectScope === "none" ? "view" : next.accessLevel);
  }

  function toggleDepartmentProject(projectId: string): void {
    setDepartmentProjectIds((current) => (current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId)));
  }

  function togglePersonalProject(projectId: string): void {
    setPersonalProjectIds((current) => (current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId)));
  }

  function toggleAllMembers(): void {
    if (selectedGroup === null || selectedGroupMembers.length === 0) return;
    if (allMembersSelected) {
      setSelectedMemberUserIds([]);
      setPersonalRuleFromDepartment(selectedGroup);
      return;
    }
    setSelectedMemberUserIds(selectedGroupMembers.map((member) => member.userId));
    setPersonalRuleFromEffective(selectedGroup, selectedGroupMembers[0]?.userId ?? "");
  }

  function toggleMember(userId: string): void {
    if (selectedGroup === null) return;
    const next = new Set(selectedMemberIdSet);
    const wasEmpty = next.size === 0;
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setSelectedMemberUserIds(selectedGroupMembers.filter((member) => next.has(member.userId)).map((member) => member.userId));
    if (next.size === 0) {
      setPersonalRuleFromDepartment(selectedGroup);
    } else if (wasEmpty) {
      setPersonalRuleFromEffective(selectedGroup, userId);
    }
  }

  async function handleSaveDepartment(): Promise<void> {
    if (selectedKey === null || savingDepartment || deletingDepartment) return;
    setSavingDepartment(true);
    try {
      await saveGroupAccessRule({
        groupKey: selectedKey,
        projectScope: departmentProjectScope,
        accessLevel: departmentProjectScope === "none" ? "view" : departmentAccessLevel,
        projectIds: departmentProjectScope === "selected" ? departmentProjectIds : [],
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
      setSelectedMemberUserIds([]);
      setDepartmentProjectScope("none");
      setDepartmentAccessLevel("view");
      setDepartmentProjectIds([]);
      setPersonalProjectScope("none");
      setPersonalAccessLevel("view");
      setPersonalProjectIds([]);
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.deleteFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setDeletingDepartment(false);
    }
  }

  async function handleSaveMembers(): Promise<void> {
    if (selectedKey === null || selectedMemberUserIds.length === 0 || savingMembers || restoringMembers) return;
    setSavingMembers(true);
    try {
      await saveGroupAccessMemberRules({
        groupKey: selectedKey,
        userIds: selectedMemberUserIds,
        projectScope: personalProjectScope,
        accessLevel: personalProjectScope === "none" ? "view" : personalAccessLevel,
        projectIds: personalProjectScope === "selected" ? personalProjectIds : [],
      });
      setNotice({ kind: "ok", text: t("access.personalSaved") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.personalSaveFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setSavingMembers(false);
    }
  }

  async function handleRestoreMembers(): Promise<void> {
    if (selectedKey === null || selectedMemberUserIds.length === 0 || restoringMembers || savingMembers) return;
    if (!window.confirm(t("access.confirmRestoreDepartmentDefault"))) return;
    setRestoringMembers(true);
    try {
      await deleteGroupAccessMemberRules({ groupKey: selectedKey, userIds: selectedMemberUserIds });
      if (selectedGroup !== null) setPersonalRuleFromDepartment(selectedGroup);
      setNotice({ kind: "ok", text: t("access.personalRestored") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.personalRestoreFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setRestoringMembers(false);
    }
  }

  async function handleAccessChanged(): Promise<boolean> {
    const ok = await loadAccessData();
    if (ok) void loadMyPermissions(true);
    return ok;
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

  return (
    <>
      <AppHeader me={me} />
      <main className="w-full px-4 pb-10 pt-3 sm:px-6">
        <div data-access-control="" data-access-view={accessView} className="mx-auto w-full max-w-screen-2xl space-y-4">
          <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-zinc-400">
                <span>{t("header.access")}</span>
                <span aria-hidden="true">/</span>
                <span className="text-zinc-500">{accessView === "dashboard" ? t("access.dashboard.breadcrumb") : t("access.viewRules")}</span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{accessView === "dashboard" ? t("access.dashboard.title") : t("access.title")}</h1>
                {accessView === "dashboard" ? (
                  <div data-access-scope="" className="w-[260px] min-w-[220px] max-w-[320px]">
                    <SelectMenu
                      value={scopeGroupKey ?? ""}
                      options={[
                        { value: "", label: t("access.dashboard.allDepartments") },
                        ...scopeOptions.map((option) => ({ value: option.groupKey, label: option.pathText })),
                      ]}
                      onChange={(value) => { setScopeGroupKey(value === "" ? null : value); }}
                      ariaLabel={t("access.dashboard.departmentScope")}
                      disabled={data === null}
                    />
                  </div>
                ) : null}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-400">
                <span className={"inline-flex items-center gap-1.5 " + (refreshing ? "text-blue-600" : "text-emerald-600")}>
                  <span className={"h-1.5 w-1.5 rounded-full " + (refreshing ? "animate-pulse bg-blue-500" : "bg-emerald-500")} />
                  {refreshing ? t("access.dashboard.syncing") : t("access.dashboard.autoSync")}
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{syncTime}</span>
                {data === null || dashboardModel === null ? null : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t("access.dashboard.summary", { departments: dashboardModel.topDepartmentCount, members: dashboardModel.globalMemberCount })}</span>
                  </>
                )}
                <button
                  type="button"
                  data-access-refresh="true"
                  disabled={refreshing || data === null}
                  onClick={() => { setReload((value) => value + 1); }}
                  aria-label={t("access.dashboard.refresh")}
                  title={t("access.dashboard.refresh")}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 transition hover:bg-blue-50 hover:text-blue-600 disabled:cursor-default disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className={"h-3.5 w-3.5 " + (refreshing ? "access-refresh-spin" : "")}>
                    <path d="M18.5 8.5A7.5 7.5 0 1 0 19.2 13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    <path d="M18.5 4.5v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start">
              {data === null ? null : (
                <span data-access-rule-state={data.enforced ? "enforced" : "draft"} className={"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium " + (data.enforced ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>
                  <span className={"h-1.5 w-1.5 rounded-full " + (data.enforced ? "bg-emerald-500" : "bg-amber-500")} />
                  {data.enforced ? t("access.dashboard.ruleLive") : t("access.dashboard.ruleDraft")}
                </span>
              )}
              <div data-access-view-toggle="" role="tablist" aria-label={t("access.viewAria")} className="inline-flex rounded-xl bg-zinc-100 p-0.5 ring-1 ring-inset ring-zinc-200">
                <button
                  type="button"
                  role="tab"
                  aria-selected={accessView === "dashboard"}
                  data-access-view="dashboard"
                  onClick={() => { setAccessView("dashboard"); }}
                  className={"rounded-[10px] px-3 py-1.5 text-[11px] font-medium transition " + (accessView === "dashboard" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800")}
                >
                  {t("access.viewDashboard")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={accessView === "rules"}
                  data-access-view="rules"
                  onClick={() => { setAccessView("rules"); }}
                  className={"rounded-[10px] px-3 py-1.5 text-[11px] font-medium transition " + (accessView === "rules" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800")}
                >
                  {t("access.viewRules")}
                </button>
              </div>
            </div>
          </header>

          {state.kind === "loading" && accessView === "dashboard" ? <AccessDashboardSkeleton /> : null}
          {state.kind === "loading" && accessView === "rules" ? <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-500">{t("access.loading")}</p> : null}
          {state.kind === "error" ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t("access.loadFailed", { message: state.message })}</p> : null}

          {data === null ? null : accessView === "dashboard" ? (
            dashboardModel === null ? null : (
              <AccessDashboard
                data={data}
                model={dashboardModel}
                refreshSeq={refreshSeq}
                refreshing={refreshing}
                onChanged={handleAccessChanged}
                onNotify={(kind, text) => { setNotice({ kind, text }); }}
              />
            )
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-[minmax(220px,260px)_minmax(300px,360px)_minmax(0,1fr)]">
                <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:contents">
                  <aside data-access-admin-column="" className="self-start overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                    <div data-access-admins="" className="border-b border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                            <path d="M12 3.5 19 6v5.1c0 4.3-2.8 7.8-7 9.4-4.2-1.6-7-5.1-7-9.4V6l7-2.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                            <path d="m8.7 12 2.1 2.1 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <div className="min-w-0 flex-1">
                          <h2 className="text-sm font-semibold text-zinc-900">{t("access.adminTitle")}</h2>
                          <p className="mt-0.5 text-[11px] text-zinc-400">{t("access.adminHint")}</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[10px] font-medium text-zinc-500 ring-1 ring-inset ring-zinc-200">
                          {t("access.adminSummary", { n: admins.length })}
                        </span>
                      </div>
                      <div className="scrollbar-hidden mt-2 max-h-[620px] space-y-1 overflow-auto">
                        {admins.length === 0 ? (
                          <p className="rounded-lg bg-white px-2.5 py-2 text-center text-[11px] text-zinc-400">{t("access.adminEmpty")}</p>
                        ) : admins.map((admin) => (
                          <div key={admin.userId} data-access-admin={admin.userId} className="flex items-start gap-2 rounded-lg bg-white px-2.5 py-2 ring-1 ring-inset ring-zinc-100">
                            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-[11px] font-semibold text-emerald-700">
                              {memberInitial(admin)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-xs font-semibold text-zinc-800">{admin.displayName}</span>
                                {admin.status === "disabled" ? (
                                  <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{t("access.memberDisabled")}</span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-zinc-400">
                                {[admin.username, admin.email ?? ""].filter((item) => item !== "").join(" · ")}
                              </span>
                            </span>
                            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                              {t(adminSourceKey(admin.source))}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </aside>

                  <aside className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                    <div className="border-b border-zinc-200 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="text-sm font-semibold text-zinc-900">{t("access.directoryTitle")}</h2>
                          <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                            {t("access.directorySummary", { departments: allGroups.length, members: totalMemberCount })}
                          </p>
                        </div>
                        {normalizedDirectoryQuery === "" && allDepartmentKeys.length > 0 ? (
                          <button
                            type="button"
                            onClick={toggleAllExpanded}
                            className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800"
                          >
                            {allExpanded ? t("access.collapseAll") : t("access.expandAll")}
                          </button>
                        ) : null}
                      </div>
                      <label className="mt-2 flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1.5 ring-1 ring-inset ring-zinc-200 focus-within:bg-white focus-within:ring-blue-300">
                        <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-zinc-400">
                          <circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
                          <path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                        </svg>
                        <input
                          value={directoryQuery}
                          onChange={(event) => { setDirectoryQuery(event.target.value); }}
                          placeholder={t("access.directorySearch")}
                          aria-label={t("access.directorySearch")}
                          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400"
                        />
                        {directoryQuery === "" ? null : (
                          <button type="button" onClick={() => { setDirectoryQuery(""); }} aria-label={t("access.clearSearch")} className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600">
                            <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5">
                              <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                            </svg>
                          </button>
                        )}
                      </label>
                    </div>

                    <div className="scrollbar-hidden max-h-[620px] overflow-auto p-2">
                      {filteredTree.length === 0 ? (
                        <p className="px-2 py-6 text-center text-xs text-zinc-400">
                          {normalizedDirectoryQuery === "" ? t("access.noObservedGroups") : t("access.directoryNoMatch")}
                        </p>
                      ) : (
                        <DepartmentTree
                          nodes={filteredTree}
                          depth={0}
                          selectedKey={selectedKey}
                          expandedKeys={expandedKeys}
                          activeMemberId={focusedMemberId}
                          query={normalizedDirectoryQuery}
                          t={t}
                          onSelect={openGroup}
                          onToggle={toggleExpanded}
                          onMemberSelect={openMember}
                        />
                      )}
                    </div>
                  </aside>
                </div>

                <section className="space-y-4">
                  {selectedKey === null ? (
                    <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">{t("access.noGroupSelected")}</p>
                  ) : (
                    <>
                      <div className="rounded-2xl border border-zinc-200 bg-white p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-500">
                              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">
                                <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" />
                                <path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" />
                              </svg>
                            </span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="truncate text-base font-semibold text-zinc-900">{selectedGroup?.groupName ?? selectedKey}</h2>
                                {selectedRule === null || selectedRule.projectScope === "none" ? null : (
                                  <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium " + (selectedRule.accessLevel === "edit" ? "bg-indigo-50 text-indigo-700" : "bg-emerald-50 text-emerald-700")}>
                                    {t(selectedRule.accessLevel === "edit" ? "access.dashboard.operate" : "access.dashboard.viewOnly")}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                                {selectedPath.length > 0 ? selectedPath.join(" / ") : selectedKey}
                              </p>
                              <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                                <span>{t("access.members", { n: selectedGroup?.memberCount ?? 0 })}</span>
                                {personalRuleCount === 0 ? null : <span>{t("access.personalRuleCount", { n: personalRuleCount })}</span>}
                              </p>
                            </div>
                          </div>
                          <span className={"rounded-full px-2.5 py-1 text-[11px] font-medium " + (selectedRule === null && personalRuleCount === 0 ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700")}>
                            {selectedRule === null && personalRuleCount === 0 ? t("access.unconfigured") : t("access.configured")}
                          </span>
                        </div>
                      </div>

                      <div data-access-department-default="true" className="rounded-2xl border border-zinc-200 bg-white p-5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold text-zinc-800">{t("access.departmentDefaultTitle")}</h3>
                            <p className="mt-0.5 text-xs leading-5 text-zinc-500">{t("access.departmentDefaultHint")}</p>
                          </div>
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">{t("access.departmentDefaultBadge")}</span>
                        </div>
                        <div className="mt-3">
                          <AccessScopePicker
                            projectScope={departmentProjectScope}
                            accessLevel={departmentAccessLevel}
                            onChange={changeDepartmentScope}
                          />
                        </div>
                        {departmentProjectScope === "selected" ? (
                          <ProjectSelectionList
                            projects={departmentProjects}
                            query={departmentProjectQuery}
                            selectedIds={departmentProjectIds}
                            t={t}
                            onQueryChange={setDepartmentProjectQuery}
                            onToggle={toggleDepartmentProject}
                          />
                        ) : null}
                        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                          {selectedRule === null ? null : (
                            <button type="button" onClick={() => { void handleDeleteDepartment(); }} disabled={deletingDepartment || savingDepartment} className="mr-auto rounded-lg px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                              {deletingDepartment ? t("access.deleting") : t("access.deleteDepartmentDefault")}
                            </button>
                          )}
                          <button type="button" onClick={() => { void handleSaveDepartment(); }} disabled={savingDepartment || deletingDepartment} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50">
                            {savingDepartment ? t("access.saving") : t("access.saveDepartmentDefault")}
                          </button>
                        </div>
                      </div>

                      <div data-access-personal-editor="true" className="rounded-2xl border border-indigo-100 bg-white p-5 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold text-zinc-800">{t("access.personalTitle")}</h3>
                            <p className="mt-0.5 text-xs leading-5 text-zinc-500">{t("access.personalHint")}</p>
                          </div>
                          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                            {t("access.memberSelectionCount", { selected: selectedMemberCount, total: selectedGroupMembers.length })}
                          </span>
                        </div>

                        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
                          <label className="flex cursor-pointer items-center gap-2.5 border-b border-zinc-200 bg-zinc-50 px-3 py-2.5">
                            <SelectionCheckbox
                              checked={allMembersSelected}
                              indeterminate={someMembersSelected}
                              disabled={selectedGroupMembers.length === 0}
                              onChange={toggleAllMembers}
                            />
                            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0 text-indigo-500">
                              <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" />
                              <path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" />
                            </svg>
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800">{t("access.selectAllMembers")}</span>
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              {t("access.memberSelectionCount", { selected: selectedMemberCount, total: selectedGroupMembers.length })}
                            </span>
                          </label>
                          {selectedGroupMembers.length === 0 ? (
                            <p className="px-3 py-3 text-xs text-zinc-400">{t("access.noMembers")}</p>
                          ) : (
                            <div className="scrollbar-hidden max-h-[min(46vh,520px)] overflow-y-auto overscroll-contain p-1.5">
                              {selectedGroupMembers.map((member) => (
                                <SelectableMemberRow
                                  key={member.userId}
                                  member={member}
                                  checked={selectedMemberIdSet.has(member.userId)}
                                  admin={adminByUserId.get(member.userId)}
                                  adminBusy={adminBusyUserId === member.userId}
                                  personalRule={selectedGroup === null ? null : memberRuleOf(selectedGroup, member.userId)}
                                  focused={focusedMemberId === member.userId}
                                  t={t}
                                  onToggle={() => { toggleMember(member.userId); }}
                                  onToggleAdmin={() => { void handleToggleAdmin(member); }}
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        {selectedMemberCount === 0 ? (
                          <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500">{t("access.personalEmpty")}</p>
                        ) : (
                          <div className="mt-4 border-t border-zinc-100 pt-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-medium text-zinc-700">{t("access.personalSelectedSettings", { n: selectedMemberCount })}</p>
                              {selectedHasPersonalRule ? (
                                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{t("access.personalBadge")}</span>
                              ) : (
                                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">{t("access.inheritDepartmentDefault")}</span>
                              )}
                            </div>
                            <div className="mt-3">
                              <AccessScopePicker
                                projectScope={personalProjectScope}
                                accessLevel={personalAccessLevel}
                                onChange={changePersonalScope}
                              />
                            </div>
                            {personalProjectScope === "selected" ? (
                              <ProjectSelectionList
                                projects={personalProjects}
                                query={personalProjectQuery}
                                selectedIds={personalProjectIds}
                                t={t}
                                onQueryChange={setPersonalProjectQuery}
                                onToggle={togglePersonalProject}
                              />
                            ) : null}
                            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => { void handleRestoreMembers(); }}
                                disabled={!selectedHasPersonalRule || restoringMembers || savingMembers}
                                className="mr-auto rounded-lg px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
                              >
                                {restoringMembers ? t("access.restoring") : t("access.restoreDepartmentDefault")}
                              </button>
                              <button
                                type="button"
                                onClick={() => { void handleSaveMembers(); }}
                                disabled={savingMembers || restoringMembers}
                                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                              >
                                {savingMembers ? t("access.saving") : t("access.savePersonalRules")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </main>
      {notice === null ? null : <Toast kind={notice.kind} text={notice.text} onClose={() => { setNotice(null); }} />}
    </>
  );
}
