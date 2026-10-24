import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteGroupAccessRule,
  fetchAccessOverview,
  saveGroupAccessRule,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessMemberScope,
  type GroupAccessOverview,
  type GroupAccessProjectScope,
} from "./accessApi";
import { AppHeader } from "./components/AppHeader";
import { Toast, type ToastKind } from "./components/Toast";
import { useT, type TextKey } from "./i18n";
import { loadMyPermissions } from "./permissions";
import type { MeResponse } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: GroupAccessOverview }
  | { kind: "error"; message: string };

type Notice = { kind: ToastKind; text: string };
type Translate = (key: TextKey, params?: Record<string, string | number>) => string;
type DepartmentTreeNode = { group: GroupAccessGroup; children: DepartmentTreeNode[] };

const SCOPE_OPTIONS: Array<{ value: GroupAccessProjectScope; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.scope.all" },
  { value: "own", labelKey: "access.scope.own" },
  { value: "selected", labelKey: "access.scope.selected" },
  { value: "none", labelKey: "access.scope.none" },
];

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

function memberInitial(member: GroupAccessMember): string {
  const chars = Array.from(member.displayName.trim());
  return chars.length === 0 ? "?" : chars[0] ?? "?";
}

function MemberRow({ member, depth, t }: { member: GroupAccessMember; depth: number; t: Translate }) {
  const detail = [member.username, member.email ?? ""].filter((item) => item !== "").join(" · ");
  return (
    <div style={{ paddingLeft: String(32 + depth * 14) + "px" }} className="pr-2">
      <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50" title={member.email ?? member.username}>
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
      </div>
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
  t,
  onToggle,
}: {
  member: GroupAccessMember;
  checked: boolean;
  t: Translate;
  onToggle: () => void;
}) {
  const detail = [member.username, member.email ?? ""].filter((item) => item !== "").join(" · ");
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-blue-50/60">
      <SelectionCheckbox checked={checked} indeterminate={false} onChange={onToggle} />
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
        {memberInitial(member)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-800">{member.displayName}</span>
          {member.status === "disabled" ? (
            <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{t("access.memberDisabled")}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-400">{detail}</span>
      </span>
    </label>
  );
}

function DepartmentTree({
  nodes,
  depth,
  selectedKey,
  expandedKeys,
  currentGroupKeys,
  query,
  t,
  onSelect,
  onToggle,
}: {
  nodes: readonly DepartmentTreeNode[];
  depth: number;
  selectedKey: string | null;
  expandedKeys: ReadonlySet<string>;
  currentGroupKeys: ReadonlySet<string>;
  query: string;
  t: Translate;
  onSelect: (group: GroupAccessGroup) => void;
  onToggle: (groupKey: string) => void;
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
                {currentGroupKeys.has(group.groupKey) ? (
                  <span title={t("access.currentDepartment")} className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                ) : null}
              </button>
            </div>
            {expanded ? (
              <div className="pb-1 pt-0.5">
                {members.map((member) => (
                  <MemberRow key={member.userId} member={member} depth={depth} t={t} />
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
                  currentGroupKeys={currentGroupKeys}
                  query={query}
                  t={t}
                  onSelect={onSelect}
                  onToggle={onToggle}
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
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [projectScope, setProjectScope] = useState<GroupAccessProjectScope>("none");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [memberScope, setMemberScope] = useState<GroupAccessMemberScope>("all");
  const [memberUserIds, setMemberUserIds] = useState<string[]>([]);
  const [projectQuery, setProjectQuery] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void fetchAccessOverview()
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

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
  const currentGroupKeys = new Set(data?.currentGroupKeys ?? []);
  const currentDepartmentNames = (data?.currentGroupKeys ?? []).map((key) => groupByKey.get(key)?.groupName ?? key);
  const totalMemberCount = new Set(allGroups.flatMap((group) => group.members.map((member) => member.userId))).size;
  const selectedGroup = selectedKey === null ? null : groupByKey.get(selectedKey) ?? null;
  const selectedRule = selectedGroup?.rule ?? null;
  const selectedGroupMembers = selectedGroup?.members ?? [];
  const selectedMemberIdSet = new Set(
    memberScope === "all" ? selectedGroupMembers.map((member) => member.userId) : memberUserIds,
  );
  const selectedMemberCount = selectedGroupMembers.filter((member) => selectedMemberIdSet.has(member.userId)).length;
  const allMembersSelected = selectedGroupMembers.length > 0 && selectedMemberCount === selectedGroupMembers.length;
  const someMembersSelected = selectedMemberCount > 0 && !allMembersSelected;
  const selectedPath = selectedKey === null ? [] : departmentPathOf(selectedKey, groupByKey);
  const query = projectQuery.trim().toLowerCase();
  const projects = data === null ? [] : query === "" ? data.projects : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(query));

  function applyGroup(group: GroupAccessGroup): void {
    setProjectScope(group.rule?.projectScope ?? "none");
    setProjectIds(group.rule?.projectIds ?? []);
    const currentMemberIds = new Set(group.members.map((member) => member.userId));
    setMemberScope(group.rule?.memberScope ?? "all");
    setMemberUserIds((group.rule?.memberUserIds ?? []).filter((userId) => currentMemberIds.has(userId)));
    setProjectQuery("");
  }

  function openGroup(group: GroupAccessGroup): void {
    setSelectedKey(group.groupKey);
    setExpandedKeys((current) => new Set(current).add(group.groupKey));
    applyGroup(group);
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

  function toggleProject(projectId: string): void {
    setProjectIds((current) => (current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId)));
  }

  function toggleAllMembers(): void {
    if (selectedGroupMembers.length === 0) return;
    if (allMembersSelected) {
      setMemberScope("selected");
      setMemberUserIds([]);
      return;
    }
    setMemberScope("all");
    setMemberUserIds([]);
  }

  function toggleMember(userId: string): void {
    const next = new Set(selectedMemberIdSet);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    if (selectedGroupMembers.length > 0 && selectedGroupMembers.every((member) => next.has(member.userId))) {
      setMemberScope("all");
      setMemberUserIds([]);
      return;
    }
    setMemberScope("selected");
    setMemberUserIds(selectedGroupMembers.filter((member) => next.has(member.userId)).map((member) => member.userId));
  }

  async function handleSave(): Promise<void> {
    if (selectedKey === null || saving) return;
    setSaving(true);
    try {
      await saveGroupAccessRule({
        groupKey: selectedKey,
        projectScope,
        projectIds: projectScope === "selected" ? projectIds : [],
        memberScope,
        memberUserIds: memberScope === "selected" ? memberUserIds : [],
      });
      setNotice({ kind: "ok", text: t("access.saved") });
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.saveFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (selectedKey === null || deleting) return;
    if (!window.confirm(t("access.confirmDelete"))) return;
    setDeleting(true);
    try {
      await deleteGroupAccessRule(selectedKey);
      setNotice({ kind: "ok", text: t("access.deleted") });
      setSelectedKey(null);
      setProjectScope("none");
      setProjectIds([]);
      setMemberScope("all");
      setMemberUserIds([]);
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.deleteFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <AppHeader me={me} />
      <main className="w-full px-4 pb-10 pt-3 sm:px-6">
        <div data-access-control="" className="mx-auto w-full max-w-6xl space-y-4">
          <header>
            <h1 className="text-lg font-semibold text-zinc-900">{t("access.title")}</h1>
            <p className="mt-0.5 text-xs text-zinc-500">{t("access.subtitle")}</p>
          </header>

          {state.kind === "loading" ? <p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-500">{t("access.loading")}</p> : null}
          {state.kind === "error" ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t("access.loadFailed", { message: state.message })}</p> : null}

          {data === null ? null : (
            <>
              <section className={"rounded-xl border px-4 py-3 text-xs " + (data.enforced ? "border-amber-200 bg-amber-50 text-amber-800" : "border-zinc-200 bg-white text-zinc-600")}>
                <p className="font-medium">{data.enforced ? t("access.enforcedOn") : t("access.enforcedOff")}</p>
                <p className="mt-1">{t("access.currentGroups")}: {currentDepartmentNames.length === 0 ? t("access.noGroups") : currentDepartmentNames.join(" · ")}</p>
              </section>

              <div className="grid gap-4 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
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
                        <button type="button" onClick={toggleAllExpanded} className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50">
                          {allExpanded ? t("access.collapseAll") : t("access.expandAll")}
                        </button>
                      ) : null}
                    </div>
                    <label className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-2.5 py-2 focus-within:border-blue-300 focus-within:bg-white">
                      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400">
                        <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.7" />
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

                  <div className="max-h-[620px] overflow-auto p-2">
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
                        currentGroupKeys={currentGroupKeys}
                        query={normalizedDirectoryQuery}
                        t={t}
                        onSelect={openGroup}
                        onToggle={toggleExpanded}
                      />
                    )}
                  </div>
                </aside>

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
                              <h2 className="truncate text-base font-semibold text-zinc-900">{selectedGroup?.groupName ?? selectedKey}</h2>
                              <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                                {selectedPath.length > 0 ? selectedPath.join(" / ") : selectedKey}
                              </p>
                              {selectedGroup === null ? null : (
                                <p className="mt-1 text-[11px] text-zinc-500">{t("access.members", { n: selectedGroup.memberCount })}</p>
                              )}
                            </div>
                          </div>
                          <span className={"rounded-full px-2.5 py-1 text-[11px] font-medium " + (selectedRule === null ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700")}>
                            {selectedRule === null ? t("access.unconfigured") : t("access.configured")}
                          </span>
                        </div>

                        <h3 className="mt-5 text-sm font-semibold text-zinc-800">{t("access.memberRuleTitle")}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500">{t("access.memberRuleHint")}</p>
                        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
                          <label className="flex cursor-pointer items-center gap-2.5 border-b border-zinc-200 bg-zinc-50 px-3 py-2.5">
                            <SelectionCheckbox
                              checked={allMembersSelected}
                              indeterminate={someMembersSelected}
                              disabled={selectedGroupMembers.length === 0}
                              onChange={toggleAllMembers}
                            />
                            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0 text-blue-500">
                              <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" />
                              <path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.55" strokeWidth="1.2" />
                            </svg>
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800">{selectedGroup?.groupName ?? selectedKey}</span>
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              {t("access.memberSelectionCount", { selected: selectedMemberCount, total: selectedGroupMembers.length })}
                            </span>
                          </label>
                          {selectedGroupMembers.length === 0 ? (
                            <p className="px-3 py-3 text-xs text-zinc-400">{t("access.noMembers")}</p>
                          ) : (
                            <div className="p-1.5">
                              {selectedGroupMembers.map((member) => (
                                <SelectableMemberRow
                                  key={member.userId}
                                  member={member}
                                  checked={selectedMemberIdSet.has(member.userId)}
                                  t={t}
                                  onToggle={() => { toggleMember(member.userId); }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        {memberScope === "selected" && selectedMemberCount === 0 && selectedGroupMembers.length > 0 ? (
                          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t("access.memberSelectionEmpty")}</p>
                        ) : null}
                        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
                          <p className="font-medium">{t("access.readOnlyTitle")}</p>
                          <p className="mt-0.5 leading-5">{t("access.readOnlyHint")}</p>
                        </div>

                        <h3 className="mt-6 text-sm font-semibold text-zinc-800">{t("access.projectsTitle")}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500">{t("access.projectsHint")}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                          {SCOPE_OPTIONS.map((option) => (
                            <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
                              <input type="radio" name="access-project-scope" checked={projectScope === option.value} onChange={() => { setProjectScope(option.value); }} className="h-4 w-4 accent-zinc-900" />
                              {t(option.labelKey)}
                            </label>
                          ))}
                        </div>

                        {projectScope === "selected" ? (
                          <div className="mt-4 rounded-xl border border-zinc-200">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
                              <input
                                value={projectQuery}
                                onChange={(event) => { setProjectQuery(event.target.value); }}
                                placeholder={t("access.projectSearch")}
                                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
                              />
                              <span className="text-xs text-zinc-500">{t("access.selectedCount", { n: projectIds.length })}</span>
                            </div>
                            <div className="max-h-64 overflow-auto p-2">
                              {projects.length === 0 ? <p className="px-2 py-3 text-xs text-zinc-500">{t("access.noProjects")}</p> : null}
                              {projects.map((project) => (
                                <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50">
                                  <input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => { toggleProject(project.id); }} className="h-4 w-4 accent-zinc-900" />
                                  <span className="font-mono text-xs text-zinc-400">{project.code}</span>
                                  <span className="min-w-0 truncate">{project.name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {selectedRule === null ? null : (
                          <button type="button" onClick={() => { void handleDelete(); }} disabled={deleting} className="mr-auto rounded-lg px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                            {deleting ? t("access.deleting") : t("access.deleteRule")}
                          </button>
                        )}
                        <button type="button" onClick={() => { void handleSave(); }} disabled={saving} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50">
                          {saving ? t("access.saving") : t("access.save")}
                        </button>
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
