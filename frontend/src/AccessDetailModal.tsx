import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  assignGroupAccessAdmin,
  deleteGroupAccessRule,
  revokeGroupAccessAdmin,
  saveGroupAccessRule,
  type GroupAccessAdmin,
  type GroupAccessGroup,
  type GroupAccessMember,
  type GroupAccessMemberScope,
  type GroupAccessOverview,
  type GroupAccessProjectScope,
} from "./accessApi";
import {
  projectNamesOf,
  type AccessDashboardModel,
  type AccessLevel,
  type AccessPersonSummary,
} from "./accessDashboardModel";
import { useT, type TextKey } from "./i18n";
import { lockBodyScroll } from "./scrollLock";
import { useFocusTrap } from "./components/useFocusTrap";
import type { ToastKind } from "./components/Toast";

export type AccessDetailView =
  | { kind: "members" }
  | { kind: "projects" }
  | { kind: "admins" }
  | { kind: "departments" }
  | { kind: "department"; groupKey: string };

type Notify = (kind: ToastKind, text: string) => void;

const SCOPE_OPTIONS: Array<{ value: GroupAccessProjectScope; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.scope.all" },
  { value: "own", labelKey: "access.scope.own" },
  { value: "selected", labelKey: "access.scope.selected" },
  { value: "none", labelKey: "access.scope.none" },
];

const LEVEL_OPTIONS: Array<{ value: "all" | AccessLevel; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.detail.all" },
  { value: "operate", labelKey: "access.dashboard.operate" },
  { value: "view", labelKey: "access.dashboard.viewOnly" },
  { value: "login", labelKey: "access.dashboard.loginOnly" },
];

function memberInitial(member: { displayName: string }): string {
  const chars = Array.from(member.displayName.trim());
  return chars.length === 0 ? "?" : chars[0] ?? "?";
}

function adminSourceKey(source: GroupAccessAdmin["source"]): TextKey {
  if (source === "manual") return "access.adminSourceManual";
  if (source === "role") return "access.adminSourceRole";
  return "access.adminSourceConfigured";
}

function levelKey(level: AccessLevel): TextKey {
  if (level === "operate") return "access.dashboard.operate";
  if (level === "view") return "access.dashboard.viewOnly";
  return "access.dashboard.loginOnly";
}

function levelClass(level: AccessLevel): string {
  if (level === "operate") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (level === "view") return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  return "bg-zinc-100 text-zinc-600 ring-zinc-200";
}

function scopeKey(group: GroupAccessGroup): TextKey {
  if (group.rule === null) return "access.unconfigured";
  if (group.rule.projectScope === "all") return "access.scope.all";
  if (group.rule.projectScope === "own") return "access.scope.own";
  if (group.rule.projectScope === "selected") return "access.scope.selected";
  return "access.scope.none";
}

function scopeClass(group: GroupAccessGroup): string {
  if (group.rule === null) return "bg-zinc-100 text-zinc-500 ring-zinc-200";
  if (group.rule.projectScope === "all") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (group.rule.projectScope === "own") return "bg-sky-50 text-sky-700 ring-sky-100";
  if (group.rule.projectScope === "selected") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-zinc-100 text-zinc-600 ring-zinc-200";
}

function titleOf(view: AccessDetailView): TextKey {
  if (view.kind === "members") return "access.detail.members";
  if (view.kind === "projects") return "access.detail.projects";
  if (view.kind === "admins") return "access.detail.admins";
  if (view.kind === "departments") return "access.detail.departments";
  return "access.detail.department";
}

function personProjectKey(person: AccessPersonSummary): TextKey {
  if (person.projectLevel === "all") return "access.scope.all";
  if (person.projectLevel === "own") return "access.scope.own";
  if (person.projectLevel === "selected") return "access.scope.selected";
  return "access.dashboard.loginOnly";
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const t = useT();
  return (
    <label className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3 py-2 transition focus-within:border-blue-300 focus-within:bg-white">
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400">
        <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(event) => { onChange(event.target.value); }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400"
      />
      {value === "" ? null : (
        <button type="button" onClick={() => { onChange(""); }} aria-label={t("access.clearSearch")} title={t("access.clearSearch")} className="shrink-0 rounded p-0.5 text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700">
          <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </button>
      )}
    </label>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-10 text-center text-xs text-zinc-400">{children}</p>;
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={"rounded-full px-2.5 py-1 text-[11px] font-medium transition " + (active ? "bg-blue-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-800")}
    >
      {children}
    </button>
  );
}

function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <h3 className="text-sm font-semibold text-zinc-800">{title}</h3>
      {detail === undefined ? null : <span className="text-[11px] text-zinc-400">{detail}</span>}
    </div>
  );
}

function MembersView({ model, onOpenDepartment }: { model: AccessDashboardModel; onOpenDepartment: (groupKey: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | AccessLevel>("all");
  const normalized = query.trim().toLowerCase();
  const rows = model.people.filter((person) => {
    if (level !== "all" && person.level !== level) return false;
    return normalized === "" || person.searchText.includes(normalized);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchBox value={query} onChange={setQuery} placeholder={t("access.detail.searchMembers")} />
        <div className="flex flex-wrap gap-1.5">
          {LEVEL_OPTIONS.map((option) => (
            <FilterChip key={option.value} active={level === option.value} onClick={() => { setLevel(option.value); }}>{t(option.labelKey)}</FilterChip>
          ))}
        </div>
      </div>
      <div className="scrollbar-hidden min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.length === 0 ? <EmptyState>{t("access.detail.noMatch")}</EmptyState> : rows.map((person) => (
          <PersonDetailRow key={person.member.userId} person={person} onOpenDepartment={onOpenDepartment} />
        ))}
      </div>
    </div>
  );
}

function PersonDetailRow({ person, onOpenDepartment }: { person: AccessPersonSummary; onOpenDepartment: (groupKey: string) => void }) {
  const t = useT();
  return (
    <div data-access-member-row={person.member.userId} className="group flex items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 transition duration-200 hover:border-blue-100 hover:bg-blue-50/50">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 transition-transform duration-200 group-hover:scale-105">
        {memberInitial(person.member)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-zinc-800">{person.member.displayName}</span>
          {person.member.status === "disabled" ? <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500">{t("access.memberDisabled")}</span> : null}
          <span className={"rounded-full px-2 py-0.5 text-[9px] font-medium ring-1 ring-inset " + levelClass(person.level)}>{t(levelKey(person.level))}</span>
          {person.isAdmin ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-medium text-blue-700 ring-1 ring-inset ring-blue-100">{t("access.adminBadge")}</span> : null}
        </span>
        <span className="mt-1 block truncate text-[10px] text-zinc-400">{[person.member.username, person.member.email ?? ""].filter((item) => item !== "").join(" · ")}</span>
        <span className="mt-1.5 flex flex-wrap gap-1">
          {person.groups.length === 0 ? <span className="text-[10px] text-zinc-400">{t("access.adminTitle")}</span> : person.groups.map((group) => (
            <button
              key={group.groupKey}
              type="button"
              onClick={() => { onOpenDepartment(group.groupKey); }}
              title={group.pathText}
              className="max-w-full truncate rounded-md bg-white px-1.5 py-0.5 text-[9px] text-zinc-500 ring-1 ring-inset ring-zinc-200 transition hover:bg-blue-50 hover:text-blue-700 hover:ring-blue-200"
            >
              {group.pathText}
            </button>
          ))}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[10px] text-zinc-400">{t(personProjectKey(person))}</span>
      </span>
    </div>
  );
}

function ProjectsView({ model, onOpenDepartment }: { model: AccessDashboardModel; onOpenDepartment: (groupKey: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | GroupAccessProjectScope>("all");
  const normalized = query.trim().toLowerCase();
  const rows = model.groups.filter((row) => {
    if (scope === "all" ? false : row.group.rule === null || row.group.rule.projectScope !== scope) return false;
    return normalized === "" || row.searchText.includes(normalized);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchBox value={query} onChange={setQuery} placeholder={t("access.detail.searchDepartments")} />
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={scope === "all"} onClick={() => { setScope("all"); }}>{t("access.detail.all")}</FilterChip>
          {SCOPE_OPTIONS.map((option) => (
            <FilterChip key={option.value} active={scope === option.value} onClick={() => { setScope(option.value); }}>{t(option.labelKey)}</FilterChip>
          ))}
        </div>
      </div>
      <div className="scrollbar-hidden min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.length === 0 ? <EmptyState>{t("access.detail.noMatch")}</EmptyState> : rows.map((row) => {
          const names = projectNamesOf(row.group, model.projectsById);
          return (
            <div key={row.group.groupKey} data-access-project-row={row.group.groupKey} className="group flex items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-blue-100 hover:bg-blue-50/50">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /></svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-zinc-800">{row.group.groupName}</span>
                  <span className={"rounded-full px-2 py-0.5 text-[9px] font-medium ring-1 ring-inset " + scopeClass(row.group)}>{t(scopeKey(row.group))}</span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-zinc-400">{row.pathText}</span>
                <span className="mt-1 block truncate text-[10px] text-zinc-500">{names.length === 0 ? t("access.detail.noProjectNames") : names.slice(0, 3).join(" · ") + (names.length > 3 ? " · +" + String(names.length - 3) : "")}</span>
              </span>
              <button type="button" onClick={() => { onOpenDepartment(row.group.groupKey); }} className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[10px] font-medium text-zinc-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">
                {t("access.detail.editRule")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminRow({ admin, busy, onToggle }: { admin: GroupAccessAdmin; busy: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <div data-access-admin-row={admin.userId} className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-blue-100 hover:bg-blue-50/50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700 ring-1 ring-blue-100">{memberInitial(admin)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-zinc-800">{admin.displayName}</span>
          {admin.status === "disabled" ? <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500">{t("access.memberDisabled")}</span> : null}
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">{t(adminSourceKey(admin.source))}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-zinc-400">{[admin.username, admin.email ?? ""].filter((item) => item !== "").join(" · ")}</span>
      </span>
      {admin.removable ? (
        <button type="button" disabled={busy} onClick={onToggle} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[10px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50">
          {busy ? t("access.adminBusy") : t("access.removeAdmin")}
        </button>
      ) : (
        <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 text-[9px] text-zinc-500">{t("access.adminImmutable")}</span>
      )}
    </div>
  );
}

function AdminsView({ model, onChanged, onNotify }: { model: AccessDashboardModel; onChanged: () => Promise<boolean>; onNotify: Notify }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const adminIds = new Set(model.admins.map((admin) => admin.userId));
  const candidates = model.people.filter((person) => !adminIds.has(person.member.userId) && person.member.status === "active");
  const normalized = query.trim().toLowerCase();
  const filteredAdmins = model.admins.filter((admin) => normalized === "" || (admin.displayName + " " + admin.username + " " + (admin.email ?? "")).toLowerCase().includes(normalized));
  const filteredCandidates = candidates.filter((person) => normalized === "" || person.searchText.includes(normalized));

  async function changeAdmin(admin: GroupAccessAdmin | null, person: GroupAccessMember): Promise<void> {
    if (busyId !== null) return;
    if (admin !== null && !admin.removable) return;
    setBusyId(person.userId);
    try {
      if (admin === null) {
        await assignGroupAccessAdmin(person.userId);
        onNotify("ok", t("access.adminAssigned", { name: person.displayName }));
      } else {
        await revokeGroupAccessAdmin(person.userId);
        onNotify("ok", t("access.adminRemoved", { name: person.displayName }));
      }
      await onChanged();
    } catch (error: unknown) {
      onNotify("error", t("access.adminChangeFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <SearchBox value={query} onChange={setQuery} placeholder={t("access.detail.searchMembers")} />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden pr-1">
        <SectionHeading title={t("access.adminTitle")} detail={t("access.adminSummary", { n: model.admins.length })} />
        <div className="mt-2 space-y-1">
          {filteredAdmins.length === 0 ? <EmptyState>{t("access.adminEmpty")}</EmptyState> : filteredAdmins.map((admin) => (
            <AdminRow
              key={admin.userId}
              admin={admin}
              busy={busyId === admin.userId}
              onToggle={() => { void changeAdmin(admin, admin); }}
            />
          ))}
        </div>
        <div className="mt-6">
          <SectionHeading title={t("access.detail.adminCandidates")} detail={t("access.members", { n: filteredCandidates.length })} />
          <div className="mt-2 space-y-1">
            {filteredCandidates.length === 0 ? <EmptyState>{t("access.detail.adminNoCandidates")}</EmptyState> : filteredCandidates.map((person) => (
              <div key={person.member.userId} className="group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2 transition hover:border-blue-100 hover:bg-blue-50/50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-600">{memberInitial(person.member)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-zinc-800">{person.member.displayName}</span>
                  <span className="block truncate text-[10px] text-zinc-400">{[person.member.username, person.member.email ?? ""].filter((item) => item !== "").join(" · ")}</span>
                </span>
                <button type="button" disabled={busyId !== null} onClick={() => { void changeAdmin(null, person.member); }} className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[10px] font-medium text-zinc-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50">
                  {busyId === person.member.userId ? t("access.adminBusy") : t("access.makeAdmin")}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DepartmentsView({ model, onOpenDepartment }: { model: AccessDashboardModel; onOpenDepartment: (groupKey: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const rows = model.groups.filter((row) => normalized === "" || row.searchText.includes(normalized));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SearchBox value={query} onChange={setQuery} placeholder={t("access.detail.searchDepartments")} />
      <div className="scrollbar-hidden min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.length === 0 ? <EmptyState>{t("access.detail.noMatch")}</EmptyState> : rows.map((row) => (
          <button
            key={row.group.groupKey}
            type="button"
            data-access-department-list-row={row.group.groupKey}
            onClick={() => { onOpenDepartment(row.group.groupKey); }}
            className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition hover:border-blue-100 hover:bg-blue-50/50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 ring-1 ring-blue-100">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /></svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-zinc-800">{row.group.groupName}</span>
                <span className={"rounded-full px-2 py-0.5 text-[9px] font-medium ring-1 ring-inset " + scopeClass(row.group)}>{t(scopeKey(row.group))}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] text-zinc-500">{t("access.members", { n: row.subtreeMemberCount })}</span>
                {row.adminCount > 0 ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[9px] text-blue-700">{t("access.detail.adminCount", { n: row.adminCount })}</span> : null}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-zinc-400">{row.pathText}</span>
            </span>
            <span className="shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-500">
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4"><path d="m7 4.5 5.5 5.5L7 15.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectionCheckbox({ checked, indeterminate, disabled = false, onChange }: { checked: boolean; indeterminate: boolean; disabled?: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="h-4 w-4 shrink-0 cursor-pointer rounded border-zinc-300 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-40" />;
}

function DepartmentEditor({ group, data, onChanged, onNotify, onClose }: {
  group: GroupAccessGroup;
  data: GroupAccessOverview;
  onChanged: () => Promise<boolean>;
  onNotify: Notify;
  onClose: () => void;
}) {
  const t = useT();
  const [projectScope, setProjectScope] = useState<GroupAccessProjectScope>(group.rule?.projectScope ?? "none");
  const [projectIds, setProjectIds] = useState<string[]>(group.rule?.projectIds ?? []);
  const [memberScope, setMemberScope] = useState<GroupAccessMemberScope>(group.rule?.memberScope ?? "all");
  const [memberUserIds, setMemberUserIds] = useState<string[]>(group.rule?.memberUserIds ?? []);
  const [memberQuery, setMemberQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adminBusyId, setAdminBusyId] = useState<string | null>(null);
  const adminByUserId = new Map(data.admins.map((admin) => [admin.userId, admin] as const));

  useEffect(() => {
    setProjectScope(group.rule?.projectScope ?? "none");
    setProjectIds(group.rule?.projectIds ?? []);
    setMemberScope(group.rule?.memberScope ?? "all");
    setMemberUserIds(group.rule?.memberUserIds ?? []);
    setMemberQuery("");
    setProjectQuery("");
  }, [group.groupKey, group.rule?.updatedAt]);

  const members = group.members;
  const selectedMemberIds = new Set(memberScope === "all" ? members.map((member) => member.userId) : memberUserIds);
  const selectedMemberCount = members.filter((member) => selectedMemberIds.has(member.userId)).length;
  const allMembersSelected = members.length > 0 && selectedMemberCount === members.length;
  const someMembersSelected = selectedMemberCount > 0 && !allMembersSelected;
  const normalizedMemberQuery = memberQuery.trim().toLowerCase();
  const visibleMembers = members.filter((member) => normalizedMemberQuery === "" || (member.displayName + " " + member.username + " " + (member.email ?? "")).toLowerCase().includes(normalizedMemberQuery));
  const selectedMemberNamePreview = members.filter((member) => selectedMemberIds.has(member.userId)).slice(0, 3).map((member) => member.displayName).join(" · ");
  const normalizedProjectQuery = projectQuery.trim().toLowerCase();
  const visibleProjects = data.projects.filter((project) => normalizedProjectQuery === "" || (project.code + " " + project.name).toLowerCase().includes(normalizedProjectQuery));

  function toggleAllMembers(): void {
    if (members.length === 0) return;
    if (allMembersSelected) {
      setMemberScope("selected");
      setMemberUserIds([]);
      return;
    }
    setMemberScope("all");
    setMemberUserIds([]);
  }

  function toggleMember(userId: string): void {
    const next = new Set(selectedMemberIds);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    if (members.length > 0 && members.every((member) => next.has(member.userId))) {
      setMemberScope("all");
      setMemberUserIds([]);
      return;
    }
    setMemberScope("selected");
    setMemberUserIds(members.filter((member) => next.has(member.userId)).map((member) => member.userId));
  }

  function toggleProject(projectId: string): void {
    setProjectIds((current) => current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId));
  }

  async function handleSave(): Promise<void> {
    if (saving || deleting) return;
    setSaving(true);
    try {
      await saveGroupAccessRule({
        groupKey: group.groupKey,
        projectScope,
        projectIds: projectScope === "selected" ? projectIds : [],
        memberScope,
        memberUserIds: memberScope === "selected" ? memberUserIds : [],
      });
      onNotify("ok", t("access.saved"));
      await onChanged();
    } catch (error: unknown) {
      onNotify("error", t("access.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (saving || deleting || group.rule === null) return;
    if (!window.confirm(t("access.confirmDelete"))) return;
    setDeleting(true);
    try {
      await deleteGroupAccessRule(group.groupKey);
      onNotify("ok", t("access.deleted"));
      await onChanged();
      onClose();
    } catch (error: unknown) {
      onNotify("error", t("access.deleteFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggleAdmin(member: GroupAccessMember): Promise<void> {
    if (adminBusyId !== null) return;
    const admin = adminByUserId.get(member.userId);
    if (admin !== undefined && !admin.removable) return;
    setAdminBusyId(member.userId);
    try {
      if (admin === undefined) {
        await assignGroupAccessAdmin(member.userId);
        onNotify("ok", t("access.adminAssigned", { name: member.displayName }));
      } else {
        await revokeGroupAccessAdmin(member.userId);
        onNotify("ok", t("access.adminRemoved", { name: member.displayName }));
      }
      await onChanged();
    } catch (error: unknown) {
      onNotify("error", t("access.adminChangeFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setAdminBusyId(null);
    }
  }

  return (
    <div data-access-rule-editor={group.groupKey} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50/70 to-white px-4 py-3.5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-blue-600 shadow-sm ring-1 ring-blue-100">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /><path d="M3.8 9h16.4" stroke="white" strokeOpacity="0.65" strokeWidth="1.2" /></svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-zinc-900">{group.groupName}</h3>
              <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset " + scopeClass(group)}>{t(scopeKey(group))}</span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-blue-900/50">{group.groupKey}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{t("access.detail.directMembers", { n: group.memberCount })}</p>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-2">
        <section className="flex min-h-[300px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-3.5 py-3">
            <SectionHeading title={t("access.memberRuleTitle")} detail={t("access.memberSelectionCount", { selected: selectedMemberCount, total: members.length })} />
            <p className="mt-1 text-[10px] leading-4 text-zinc-400">{t("access.memberRuleHint")}</p>
            <div className="mt-2">
              <SearchBox value={memberQuery} onChange={setMemberQuery} placeholder={t("access.detail.searchGroupMembers")} />
            </div>
          </div>
          <div className="border-b border-zinc-100 bg-zinc-50/70 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2.5">
              <SelectionCheckbox checked={allMembersSelected} indeterminate={someMembersSelected} disabled={members.length === 0} onChange={toggleAllMembers} />
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5"><path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" /></svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-700">{group.groupName}</span>
              {selectedMemberNamePreview === "" ? null : <span className="max-w-[46%] truncate text-[9px] text-zinc-400">{selectedMemberNamePreview}</span>}
            </label>
          </div>
          <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-1.5">
            {visibleMembers.length === 0 ? <EmptyState>{t("access.detail.noGroupMembers")}</EmptyState> : visibleMembers.map((member) => {
              const admin = adminByUserId.get(member.userId);
              return (
                <div key={member.userId} data-access-editor-member={member.userId} className="group flex items-center gap-2 rounded-lg px-2 py-2 transition hover:bg-blue-50/55">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <SelectionCheckbox checked={selectedMemberIds.has(member.userId)} indeterminate={false} onChange={() => { toggleMember(member.userId); }} />
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[10px] font-semibold text-blue-700">{memberInitial(member)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-zinc-800">{member.displayName}</span>
                        {member.status === "disabled" ? <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[8px] text-zinc-500">{t("access.memberDisabled")}</span> : null}
                        {admin === undefined ? null : <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[8px] font-medium text-emerald-700">{t("access.adminBadge")}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] text-zinc-400">{[member.username, member.email ?? ""].filter((item) => item !== "").join(" · ")}</span>
                    </span>
                  </label>
                  {admin === undefined ? (
                    <button type="button" disabled={adminBusyId !== null || member.status === "disabled"} onClick={() => { void handleToggleAdmin(member); }} className="shrink-0 rounded-md px-1.5 py-1 text-[9px] font-medium text-zinc-500 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40">
                      {adminBusyId === member.userId ? t("access.adminBusy") : t("access.makeAdmin")}
                    </button>
                  ) : admin.removable ? (
                    <button type="button" disabled={adminBusyId !== null} onClick={() => { void handleToggleAdmin(member); }} className="shrink-0 rounded-md px-1.5 py-1 text-[9px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40">
                      {adminBusyId === member.userId ? t("access.adminBusy") : t("access.removeAdmin")}
                    </button>
                  ) : (
                    <span title={t("access.adminImmutable")} className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-1 text-[8px] text-zinc-500">{t(adminSourceKey(admin.source))}</span>
                  )}
                </div>
              );
            })}
          </div>
          {memberScope === "selected" && selectedMemberCount === 0 && members.length > 0 ? (
            <p className="mx-3 my-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] text-amber-700">{t("access.memberSelectionEmpty")}</p>
          ) : null}
        </section>

        <section className="flex min-h-[300px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-3.5 py-3">
            <SectionHeading title={t("access.projectsTitle")} detail={t("access.detail.projectCount", { n: projectScope === "selected" ? projectIds.length : 0 })} />
            <p className="mt-1 text-[10px] leading-4 text-zinc-400">{t("access.projectsHint")}</p>
          </div>
          <div className="grid gap-1.5 border-b border-zinc-100 p-3 sm:grid-cols-2">
            {SCOPE_OPTIONS.map((option) => (
              <label key={option.value} className={"flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[11px] transition " + (projectScope === option.value ? "border-blue-300 bg-blue-50 text-blue-800 shadow-sm" : "border-zinc-200 text-zinc-600 hover:border-blue-200 hover:bg-blue-50/40")}>
                <input type="radio" name={"access-project-scope-" + group.groupKey} checked={projectScope === option.value} onChange={() => { setProjectScope(option.value); }} className="h-3.5 w-3.5 accent-blue-600" />
                {t(option.labelKey)}
              </label>
            ))}
          </div>
          {projectScope === "selected" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="px-3 pt-2.5">
                <SearchBox value={projectQuery} onChange={setProjectQuery} placeholder={t("access.projectSearch")} />
              </div>
              <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-2">
                {visibleProjects.length === 0 ? <EmptyState>{t("access.noProjects")}</EmptyState> : visibleProjects.map((project) => (
                  <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-zinc-700 transition hover:bg-zinc-50">
                    <input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => { toggleProject(project.id); }} className="h-3.5 w-3.5 accent-blue-600" />
                    <span className="shrink-0 font-mono text-[9px] text-zinc-400">{project.code}</span>
                    <span className="min-w-0 truncate">{project.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-5">
              <p className="max-w-xs text-center text-[11px] leading-5 text-zinc-400">{t(projectScope === "all" ? "access.scope.all" : projectScope === "own" ? "access.scope.own" : "access.scope.none")}</p>
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 pt-3">
        {group.rule === null ? null : (
          <button type="button" disabled={deleting || saving} onClick={() => { void handleDelete(); }} className="mr-auto rounded-xl px-3 py-2 text-[11px] font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50">
            {deleting ? t("access.deleting") : t("access.deleteRule")}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-xl border border-zinc-200 px-4 py-2 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50">
          {t("access.detail.close")}
        </button>
        <button type="button" disabled={saving || deleting} onClick={() => { void handleSave(); }} className="rounded-xl bg-zinc-900 px-5 py-2 text-xs font-medium text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-zinc-800 hover:shadow-md disabled:translate-y-0 disabled:opacity-50">
          {saving ? t("access.saving") : t("access.save")}
        </button>
      </div>
    </div>
  );
}

export function AccessDetailModal({ data, model, initialView, onClose, onChanged, onNotify }: {
  data: GroupAccessOverview;
  model: AccessDashboardModel;
  initialView: AccessDetailView;
  onClose: () => void;
  onChanged: () => Promise<boolean>;
  onNotify: Notify;
}) {
  const t = useT();
  const [stack, setStack] = useState<AccessDetailView[]>([initialView]);
  const current = stack[stack.length - 1] ?? initialView;
  const trapRef = useFocusTrap<HTMLDivElement>();
  const group = current.kind === "department" ? model.groupsByKey.get(current.groupKey) ?? null : null;

  useEffect(() => lockBodyScroll(), []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKey, true);
    return () => { document.removeEventListener("keydown", handleKey, true); };
  }, [onClose]);

  function openDepartment(groupKey: string): void {
    setStack((previous) => previous.concat({ kind: "department", groupKey }));
  }

  return createPortal(
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={t(titleOf(current))}
      data-access-detail-modal="true"
      data-focus-container="true"
      tabIndex={-1}
      onClick={onClose}
      className="access-modal-backdrop fixed inset-0 z-[75] flex items-center justify-center bg-zinc-950/35 p-2 backdrop-blur-[2px] sm:p-5"
    >
      <div onClick={(event) => { event.stopPropagation(); }} className="access-modal-panel flex h-[min(88vh,820px)] w-[min(1040px,100%)] flex-col overflow-hidden rounded-2xl border border-white/60 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.28)]">
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-3 sm:px-5">
          {stack.length <= 1 ? null : (
            <button type="button" onClick={() => { setStack((previous) => previous.slice(0, -1)); }} aria-label={t("access.detail.back")} title={t("access.detail.back")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900">
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4"><path d="m12.5 4.5-5.5 5.5 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-medium uppercase tracking-wide text-zinc-400">{t("header.access")}</p>
            <h2 className="mt-0.5 truncate text-base font-semibold text-zinc-900">{group === null ? t(titleOf(current)) : group.groupName}</h2>
          </div>
          <span className="hidden rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] text-zinc-500 sm:inline">
            {current.kind === "members" ? t("access.members", { n: model.totalMembers }) : current.kind === "departments" || current.kind === "projects" ? t("access.members", { n: model.groups.length }) : current.kind === "admins" ? t("access.adminSummary", { n: model.admins.length }) : t("access.groups")}
          </span>
          <button type="button" data-access-detail-close="true" onClick={onClose} aria-label={t("access.detail.close")} title={t("access.detail.close")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:rotate-90 hover:bg-zinc-100 hover:text-zinc-900">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
          {current.kind === "members" ? <MembersView model={model} onOpenDepartment={openDepartment} /> : null}
          {current.kind === "projects" ? <ProjectsView model={model} onOpenDepartment={openDepartment} /> : null}
          {current.kind === "admins" ? <AdminsView model={model} onChanged={onChanged} onNotify={onNotify} /> : null}
          {current.kind === "departments" ? <DepartmentsView model={model} onOpenDepartment={openDepartment} /> : null}
          {current.kind === "department" ? (
            group === null ? <EmptyState>{t("access.detail.departmentMissing")}</EmptyState> : (
              <DepartmentEditor
                group={group}
                data={data}
                onChanged={onChanged}
                onNotify={onNotify}
                onClose={onClose}
              />
            )
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
