import { useMemo, useState, type ReactNode } from "react";
import type { GroupAccessAdmin, GroupAccessOverview } from "./accessApi";
import { AccessDetailModal, type AccessDetailView } from "./AccessDetailModal";
import {
  projectNamesOf,
  type AccessDashboardModel,
  type AccessDepartmentSummary,
  type AccessProjectLevel,
} from "./accessDashboardModel";
import { useT, type TextKey } from "./i18n";
import type { ToastKind } from "./components/Toast";

type DashboardView = "overview" | "departments" | "projects" | "admins";

const MEMBER_COLORS: Record<"operate" | "view" | "login", string> = {
  operate: "#2764e7",
  view: "#18a474",
  login: "#cbd2dc",
};

const PROJECT_BAR_STYLES: Record<AccessProjectLevel, string> = {
  all: "bg-[#2764e7]",
  own: "bg-[#77a0ee]",
  selected: "bg-[#efb51b]",
  login: "bg-[#cbd2dc]",
};

const VIEW_OPTIONS: Array<{ value: DashboardView; labelKey: TextKey }> = [
  { value: "overview", labelKey: "access.dashboard.viewOverview" },
  { value: "departments", labelKey: "access.dashboard.viewDepartments" },
  { value: "projects", labelKey: "access.dashboard.viewProjects" },
  { value: "admins", labelKey: "access.dashboard.viewAdmins" },
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

function scopeTextKey(scope: "all" | "own" | "selected" | "none"): TextKey {
  if (scope === "all") return "access.scope.all";
  if (scope === "own") return "access.scope.own";
  if (scope === "selected") return "access.scope.selected";
  return "access.scope.none";
}

function percentOf(value: number, total: number): number {
  return total <= 0 ? 0 : value / total * 100;
}

function DashboardCard({
  kind,
  title,
  count,
  onClick,
  children,
  delay,
}: {
  kind: "members" | "projects" | "admins";
  title: string;
  count: string;
  onClick: () => void;
  children: ReactNode;
  delay: number;
}) {
  return (
    <button
      type="button"
      data-access-dashboard-card={kind}
      onClick={onClick}
      style={{ animationDelay: delay + "ms" }}
      className="access-dash-card group flex min-h-[270px] w-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-[0_12px_28px_rgba(39,100,231,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 active:translate-y-0"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-semibold text-zinc-800">{title}</span>
        <span className="shrink-0 rounded-full bg-zinc-50 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors group-hover:bg-blue-50 group-hover:text-blue-700">{count}</span>
      </span>
      <span className="mt-4 flex min-h-0 flex-1 flex-col">{children}</span>
    </button>
  );
}

function MemberStatusChart({ model }: { model: AccessDashboardModel }) {
  const t = useT();
  const total = model.totalMembers;
  const operate = model.levelCounts.operate;
  const view = model.levelCounts.view;
  const login = model.levelCounts.login;
  const operateEnd = percentOf(operate, total);
  const viewEnd = operateEnd + percentOf(view, total);
  return (
    <span className="flex flex-1 items-center justify-center gap-5">
      <span
        role="img"
        aria-label={t("access.dashboard.operate") + " " + String(operate) + ", " + t("access.dashboard.viewOnly") + " " + String(view) + ", " + t("access.dashboard.loginOnly") + " " + String(login)}
        className="relative flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-full transition-transform duration-300 group-hover:scale-[1.03]"
        style={{ background: "conic-gradient(" + MEMBER_COLORS.operate + " 0% " + String(operateEnd) + "%, " + MEMBER_COLORS.view + " " + String(operateEnd) + "% " + String(viewEnd) + "%, " + MEMBER_COLORS.login + " " + String(viewEnd) + "% 100%)" }}
      >
        <span className="access-dash-donut absolute inset-0 rounded-full" />
        <span className="relative flex h-[92px] w-[92px] flex-col items-center justify-center rounded-full bg-white shadow-[inset_0_0_0_1px_rgba(228,228,231,0.65)]">
          <span className="access-dash-number text-[30px] font-semibold leading-none tracking-tight text-zinc-900">{total}</span>
          <span className="mt-1 text-[11px] text-zinc-400">{t("access.dashboard.membersCenter")}</span>
        </span>
      </span>
      <span className="grid min-w-0 flex-1 gap-3">
        <LegendRow color={MEMBER_COLORS.operate} label={t("access.dashboard.operate")} value={operate} total={total} />
        <LegendRow color={MEMBER_COLORS.view} label={t("access.dashboard.viewOnly")} value={view} total={total} />
        <LegendRow color={MEMBER_COLORS.login} label={t("access.dashboard.loginOnly")} value={login} total={total} />
      </span>
    </span>
  );
}

function LegendRow({ color, label, value, total }: { color: string; label: string; value: number; total: number }) {
  const percent = percentOf(value, total);
  return (
    <span className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 text-[12px]">
      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: color }} />
      <span className="truncate text-zinc-600">{label}</span>
      <span className="tabular-nums font-medium text-zinc-800">{value}</span>
      <span className="w-10 text-right tabular-nums text-[10px] text-zinc-400">{percent.toFixed(1)}%</span>
    </span>
  );
}

function ProjectScopeChart({ model }: { model: AccessDashboardModel }) {
  const t = useT();
  const values: Array<{ key: AccessProjectLevel; labelKey: TextKey; count: number }> = [
    { key: "all", labelKey: "access.scope.all", count: model.projectCounts.all },
    { key: "own", labelKey: "access.scope.own", count: model.projectCounts.own },
    { key: "selected", labelKey: "access.scope.selected", count: model.projectCounts.selected },
    { key: "login", labelKey: "access.dashboard.loginOnly", count: model.projectCounts.login },
  ];
  const max = Math.max(...values.map((item) => item.count), 1);
  return (
    <span className="flex min-h-0 flex-1 flex-col justify-end">
      <span className="relative grid flex-1 grid-cols-4 items-end gap-2 border-b border-zinc-200 pb-2 sm:gap-3">
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2 border-t border-dashed border-zinc-100" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-100" />
        {values.map((item) => (
          <span key={item.key} className="relative flex h-full min-h-[124px] flex-col items-center justify-end gap-1">
            <span className="access-dash-bar-number text-[11px] font-semibold tabular-nums text-zinc-600">{item.count}</span>
            <span
              aria-hidden="true"
              className={"access-dash-bar w-[62%] max-w-12 rounded-t-md transition-[filter,transform] duration-200 group-hover:brightness-95 " + PROJECT_BAR_STYLES[item.key]}
              style={{ height: item.count === 0 ? "4px" : Math.max(8, item.count / max * 82) + "%" }}
            />
          </span>
        ))}
      </span>
      <span className="mt-2 grid grid-cols-4 gap-1 sm:gap-2">
        {values.map((item) => (
          <span key={item.key} className="min-w-0 text-center text-[9px] leading-4 text-zinc-500 sm:text-[10px]">
            <span className="block truncate" title={t(item.labelKey)}>{t(item.labelKey)}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

function AdminPreview({ model }: { model: AccessDashboardModel }) {
  const t = useT();
  const visible = model.admins.slice(0, 4);
  return (
    <span className="flex flex-1 flex-col justify-between gap-3">
      <span className="grid gap-1.5">
        {visible.length === 0 ? (
          <span className="rounded-lg bg-zinc-50 px-3 py-4 text-center text-[11px] text-zinc-400">{t("access.adminEmpty")}</span>
        ) : visible.map((admin, index) => (
          <span
            key={admin.userId}
            style={{ animationDelay: 120 + index * 55 + "ms" }}
            className="access-dash-admin flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors group-hover:bg-zinc-50"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700">
              {memberInitial(admin)}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12px] font-semibold text-zinc-800">{admin.displayName}</span>
                {admin.status === "disabled" ? <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[9px] text-zinc-500">{t("access.memberDisabled")}</span> : null}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-zinc-400">@{admin.username}</span>
            </span>
            <span className="shrink-0 rounded bg-zinc-50 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{t(adminSourceKey(admin.source))}</span>
          </span>
        ))}
      </span>
      {model.admins.length > visible.length ? (
        <span className="text-right text-[10px] text-zinc-400">{t("access.dashboard.moreAdmins", { n: model.admins.length - visible.length })}</span>
      ) : null}
    </span>
  );
}

function DistributionRow({ row, total, projectNames, delay, onOpen }: {
  row: AccessDepartmentSummary;
  total: number;
  projectNames: string[];
  delay: number;
  onOpen: () => void;
}) {
  const t = useT();
  const segments: Array<{ key: "operate" | "view" | "login"; count: number }> = [
    { key: "operate", count: row.levelCounts.operate },
    { key: "view", count: row.levelCounts.view },
    { key: "login", count: row.levelCounts.login },
  ];
  const showPath = row.path.length > 1;
  const scopeText = row.group.rule === null ? t("access.unconfigured") : t(scopeTextKey(row.group.rule.projectScope));
  return (
    <button
      type="button"
      data-access-department-row={row.group.groupKey}
      onClick={onOpen}
      className="group grid w-full grid-cols-[minmax(88px,120px)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left transition duration-200 hover:bg-blue-50/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
      title={scopeText + (projectNames.length > 0 ? " · " + projectNames.join(" / ") : "")}
    >
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium text-zinc-700 transition-colors group-hover:text-blue-800">{row.group.groupName}</span>
        {showPath ? <span className="mt-0.5 block truncate text-[9px] text-zinc-400">{row.path.slice(0, -1).join(" / ")}</span> : null}
      </span>
      <span
        className="flex h-3 min-w-0 overflow-hidden rounded-sm bg-zinc-100 ring-1 ring-inset ring-zinc-100 transition-transform duration-200 group-hover:scale-y-110"
        aria-label={t("access.dashboard.operate") + " " + String(row.levelCounts.operate) + ", " + t("access.dashboard.viewOnly") + " " + String(row.levelCounts.view) + ", " + t("access.dashboard.loginOnly") + " " + String(row.levelCounts.login)}
      >
        {total === 0 ? null : segments.map((segment) => segment.count === 0 ? null : (
          <span
            key={segment.key}
            className="access-dash-segment h-full transition-[filter] duration-200 group-hover:brightness-95"
            style={{ width: percentOf(segment.count, total) + "%", backgroundColor: MEMBER_COLORS[segment.key], animationDelay: delay + "ms" }}
          />
        ))}
      </span>
      <span className="w-7 text-right text-[11px] font-medium tabular-nums text-zinc-700">{row.subtreeMemberCount}</span>
    </button>
  );
}

export function AccessDashboard({
  data,
  model,
  refreshSeq,
  refreshing,
  onChanged,
  onNotify,
}: {
  data: GroupAccessOverview;
  model: AccessDashboardModel;
  refreshSeq: number;
  refreshing: boolean;
  onChanged: () => Promise<boolean>;
  onNotify: (kind: ToastKind, text: string) => void;
}) {
  const t = useT();
  const [view, setView] = useState<DashboardView>("overview");
  const [detail, setDetail] = useState<AccessDetailView | null>(null);
  const visibleRows = useMemo(() => {
    if (view === "departments") return model.groups;
    if (view === "projects") return model.groups.filter((row) => row.hasProjectData);
    if (view === "admins") return model.groups.filter((row) => row.adminCount > 0);
    return model.rootRows;
  }, [model, view]);
  const distributionLabel = view === "overview" ? t("access.dashboard.byTopDepartment") : t(VIEW_OPTIONS.find((item) => item.value === view)?.labelKey ?? "access.dashboard.byTopDepartment");
  const projectNames = (row: AccessDepartmentSummary): string[] => projectNamesOf(row.group, model.projectsById);

  return (
    <>
      <div key={refreshSeq + ":" + String(model.scopeGroupKey ?? "all")} data-access-dashboard="" className={"space-y-4 transition-opacity duration-200 " + (refreshing ? "opacity-80" : "opacity-100")}>
        <div className="grid gap-4 lg:grid-cols-3">
          <DashboardCard
            kind="members"
            title={t("access.dashboard.membersTitle")}
            count={t("access.members", { n: model.totalMembers })}
            onClick={() => { setDetail({ kind: "members" }); }}
            delay={0}
          >
            <MemberStatusChart model={model} />
          </DashboardCard>
          <DashboardCard
            kind="projects"
            title={t("access.dashboard.projectsTitle")}
            count={t("access.members", { n: model.totalMembers })}
            onClick={() => { setDetail({ kind: "projects" }); }}
            delay={70}
          >
            <ProjectScopeChart model={model} />
          </DashboardCard>
          <DashboardCard
            kind="admins"
            title={t("access.adminTitle")}
            count={t("access.adminSummary", { n: model.admins.length })}
            onClick={() => { setDetail({ kind: "admins" }); }}
            delay={140}
          >
            <AdminPreview model={model} />
          </DashboardCard>
        </div>

        <section className="access-dash-distribution overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-800">{t("access.dashboard.distributionTitle")}</h2>
              <p className="mt-0.5 text-[10px] text-zinc-400">{distributionLabel}</p>
            </div>
            <div className="hidden items-center gap-3 text-[10px] text-zinc-500 sm:flex">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#2764e7]" />{t("access.dashboard.operate")}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#18a474]" />{t("access.dashboard.viewOnly")}</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px] bg-[#cbd2dc]" />{t("access.dashboard.loginOnly")}</span>
            </div>
          </header>
          <div className="scrollbar-hidden max-h-[300px] overflow-y-auto px-2 py-1.5 sm:max-h-[320px]">
            {visibleRows.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-zinc-400">{t("access.dashboard.emptyDepartments")}</p>
            ) : visibleRows.map((row, index) => (
              <DistributionRow
                key={row.group.groupKey}
                row={row}
                total={row.subtreeMemberCount}
                projectNames={projectNames(row)}
                delay={index * 55}
                onOpen={() => { setDetail({ kind: "department", groupKey: row.group.groupKey }); }}
              />
            ))}
          </div>
          <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-zinc-100 px-3 py-2">
            <span className="text-[10px] text-zinc-400">{t("access.dashboard.viewLabel")}</span>
            {VIEW_OPTIONS.map((option) => {
              const active = view === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { setView(option.value); }}
                  className={"inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors " + (active ? "text-blue-700" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800")}
                >
                  <span className={"flex h-4 w-4 items-center justify-center rounded-[4px] border transition-all " + (active ? "border-blue-600 bg-blue-600 text-white shadow-sm" : "border-zinc-300 bg-white text-transparent")}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3"><path d="m3.2 8.2 3 3 6.6-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  {t(option.labelKey)}
                </button>
              );
            })}
          </footer>
        </section>
      </div>

      {detail === null ? null : (
        <AccessDetailModal
          data={data}
          model={model}
          initialView={detail}
          onClose={() => { setDetail(null); }}
          onChanged={onChanged}
          onNotify={onNotify}
        />
      )}
    </>
  );
}

export function AccessDashboardSkeleton() {
  return (
    <div data-access-dashboard-skeleton="" className="space-y-4 motion-safe:animate-pulse motion-reduce:animate-none">
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="min-h-[270px] rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="h-4 w-28 rounded bg-zinc-100" />
            <div className="mt-8 flex items-center gap-5">
              <div className="h-[132px] w-[132px] rounded-full bg-zinc-100" />
              <div className="grid flex-1 gap-4">
                <div className="h-3 rounded bg-zinc-100" />
                <div className="h-3 rounded bg-zinc-100" />
                <div className="h-3 rounded bg-zinc-100" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="h-4 w-32 rounded bg-zinc-100" />
        <div className="mt-6 grid gap-4">
          <div className="h-4 rounded bg-zinc-100" />
          <div className="h-4 rounded bg-zinc-100" />
          <div className="h-4 rounded bg-zinc-100" />
          <div className="h-4 rounded bg-zinc-100" />
        </div>
      </div>
    </div>
  );
}
