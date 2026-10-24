import { useMemo, useState } from "react";
import type {
  GroupAccessAdmin,
  GroupAccessGroup,
  GroupAccessMember,
  GroupAccessOverview,
  GroupAccessProjectScope,
} from "./accessApi";
import { useT, type TextKey } from "./i18n";
import { formatDateTime } from "./projectApi";

type DashboardRow = {
  group: GroupAccessGroup;
  path: string[];
  coveredMembers: GroupAccessMember[];
  projectNames: string[];
  searchText: string;
};

type MetricTone = "blue" | "violet" | "emerald" | "amber";

const SCOPE_ORDER: readonly GroupAccessProjectScope[] = ["all", "own", "selected", "none"];

const SCOPE_PRESENTATION: Record<
  GroupAccessProjectScope,
  { labelKey: TextKey; badge: string; bar: string; dot: string }
> = {
  all: {
    labelKey: "access.scope.all",
    badge: "bg-sky-50 text-sky-700 ring-sky-100",
    bar: "bg-sky-500",
    dot: "bg-sky-500",
  },
  own: {
    labelKey: "access.scope.own",
    badge: "bg-violet-50 text-violet-700 ring-violet-100",
    bar: "bg-violet-500",
    dot: "bg-violet-500",
  },
  selected: {
    labelKey: "access.scope.selected",
    badge: "bg-amber-50 text-amber-700 ring-amber-100",
    bar: "bg-amber-500",
    dot: "bg-amber-500",
  },
  none: {
    labelKey: "access.scope.none",
    badge: "bg-zinc-100 text-zinc-600 ring-zinc-200",
    bar: "bg-zinc-400",
    dot: "bg-zinc-400",
  },
};

const METRIC_TONE: Record<MetricTone, { dot: string; wash: string }> = {
  blue: { dot: "bg-blue-500", wash: "bg-blue-50/80" },
  violet: { dot: "bg-violet-500", wash: "bg-violet-50/80" },
  emerald: { dot: "bg-emerald-500", wash: "bg-emerald-50/80" },
  amber: { dot: "bg-amber-500", wash: "bg-amber-50/80" },
};

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
  if (source === "role") return "access.adminSourceRole";
  return "access.adminSourceConfigured";
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone: MetricTone;
}) {
  const style = METRIC_TONE[tone];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <span aria-hidden="true" className={"absolute -right-8 -top-8 h-20 w-20 rounded-full " + style.wash} />
      <div className="relative flex items-center gap-2">
        <span className={"h-2 w-2 shrink-0 rounded-full " + style.dot} />
        <p className="truncate text-xs font-medium text-zinc-500">{label}</p>
      </div>
      <p className="relative mt-2 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">{value}</p>
      <p className="relative mt-1 text-[11px] text-zinc-400">{hint}</p>
    </div>
  );
}

export function AccessDashboard({
  data,
  onOpenGroup,
}: {
  data: GroupAccessOverview;
  onOpenGroup: (group: GroupAccessGroup) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");

  const rows = useMemo<DashboardRow[]>(() => {
    const byKey = new Map(data.groups.map((group) => [group.groupKey, group] as const));
    const projectNameById = new Map(data.projects.map((project) => [project.id, project.name] as const));
    return data.groups
      .map((group) => {
        const path = departmentPathOf(group.groupKey, byKey);
        const rule = group.rule;
        const selectedUserIds = new Set(rule?.memberUserIds ?? []);
        const coveredMembers = rule === null
          ? []
          : rule.memberScope === "all"
            ? group.members
            : group.members.filter((member) => selectedUserIds.has(member.userId));
        const projectNames = rule?.projectScope === "selected"
          ? rule.projectIds.map((projectId) => projectNameById.get(projectId) ?? projectId)
          : [];
        const searchText = [
          group.groupName,
          group.groupKey,
          path.join(" "),
          ...group.members.flatMap((member) => [member.displayName, member.username, member.email ?? ""]),
        ].join(" ").toLowerCase();
        return { group, path, coveredMembers, projectNames, searchText };
      })
      .sort((left, right) => {
        const byPath = left.path.join(" / ").localeCompare(right.path.join(" / "), "zh-Hans-CN");
        return byPath !== 0 ? byPath : left.group.groupName.localeCompare(right.group.groupName, "zh-Hans-CN");
      });
  }, [data.groups, data.projects]);

  const configuredRows = rows.filter((row) => row.group.rule !== null);
  const configuredCount = configuredRows.length;
  const unconfiguredCount = rows.length - configuredCount;
  const coveredMemberIds = new Set<string>();
  for (const row of configuredRows) {
    for (const member of row.coveredMembers) coveredMemberIds.add(member.userId);
  }
  const directoryMemberCount = new Set(
    rows.flatMap((row) => row.group.members.map((member) => member.userId)),
  ).size;
  const scopeCounts: Record<GroupAccessProjectScope, number> = { all: 0, own: 0, selected: 0, none: 0 };
  for (const row of configuredRows) {
    const scope = row.group.rule?.projectScope;
    if (scope !== undefined) scopeCounts[scope] += 1;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = normalizedQuery === ""
    ? rows
    : rows.filter((row) => row.searchText.includes(normalizedQuery));

  return (
    <div data-access-dashboard="" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("access.dashboard.metricDepartments")}
          value={rows.length}
          hint={t("access.dashboard.metricDepartmentsHint", { members: directoryMemberCount })}
          tone="blue"
        />
        <MetricCard
          label={t("access.dashboard.metricRules")}
          value={configuredCount}
          hint={t("access.dashboard.metricRulesHint", { total: rows.length })}
          tone="violet"
        />
        <MetricCard
          label={t("access.dashboard.metricMembers")}
          value={coveredMemberIds.size}
          hint={t("access.dashboard.metricMembersHint", { total: directoryMemberCount })}
          tone="emerald"
        />
        <MetricCard
          label={t("access.dashboard.metricAdmins")}
          value={data.admins.length}
          hint={t("access.dashboard.metricAdminsHint")}
          tone="amber"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)]">
        <section className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900">{t("access.dashboard.distributionTitle")}</h2>
              <p className="mt-0.5 text-[11px] text-zinc-400">{t("access.dashboard.distributionHint")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-medium text-zinc-600">
              {t("access.dashboard.configuredSummary", { configured: configuredCount, total: rows.length })}
            </span>
          </div>

          <div aria-hidden="true" className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-zinc-100">
            {SCOPE_ORDER.map((scope) => {
              const count = scopeCounts[scope];
              if (count === 0 || rows.length === 0) return null;
              return (
                <span
                  key={scope}
                  className={"h-full " + SCOPE_PRESENTATION[scope].bar}
                  style={{ width: String((count / rows.length) * 100) + "%" }}
                />
              );
            })}
            {unconfiguredCount > 0 && rows.length > 0 ? (
              <span
                className="h-full bg-zinc-200"
                style={{ width: String((unconfiguredCount / rows.length) * 100) + "%" }}
              />
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {SCOPE_ORDER.map((scope) => (
              <div key={scope} className="flex min-w-0 items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-2">
                <span className={"h-2.5 w-2.5 shrink-0 rounded-full " + SCOPE_PRESENTATION[scope].dot} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600" title={t(SCOPE_PRESENTATION[scope].labelKey)}>
                  {t(SCOPE_PRESENTATION[scope].labelKey)}
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-800">{scopeCounts[scope]}</span>
              </div>
            ))}
            <div className="flex min-w-0 items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-300" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-600">{t("access.unconfigured")}</span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-800">{unconfiguredCount}</span>
            </div>
          </div>

          {unconfiguredCount > 0 ? (
            <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-700">
              {t("access.dashboard.unconfiguredNote", { n: unconfiguredCount })}
            </p>
          ) : null}
        </section>

        <section className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900">{t("access.dashboard.adminsTitle")}</h2>
              <p className="mt-0.5 text-[11px] leading-5 text-zinc-400">{t("access.dashboard.adminsHint")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">
              {t("access.adminSummary", { n: data.admins.length })}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.admins.length === 0 ? (
              <p className="w-full rounded-lg bg-zinc-50 px-3 py-3 text-center text-[11px] text-zinc-400">{t("access.adminEmpty")}</p>
            ) : data.admins.map((admin) => (
              <span
                key={admin.userId}
                data-access-dashboard-admin={admin.userId}
                title={[admin.username, admin.email ?? ""].filter((item) => item !== "").join(" · ")}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2 py-1.5"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-semibold text-emerald-700">
                  {memberInitial(admin)}
                </span>
                <span className="min-w-0 truncate text-[11px] font-medium text-zinc-700">{admin.displayName}</span>
                {admin.status === "disabled" ? (
                  <span className="shrink-0 rounded bg-zinc-200 px-1 py-0.5 text-[9px] text-zinc-500">{t("access.memberDisabled")}</span>
                ) : null}
                <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[9px] text-zinc-400 ring-1 ring-inset ring-zinc-200">
                  {t(adminSourceKey(admin.source))}
                </span>
              </span>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900">{t("access.dashboard.detailsTitle")}</h2>
              <p className="mt-0.5 text-[11px] text-zinc-400">{t("access.dashboard.detailsHint")}</p>
            </div>
            <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-medium text-zinc-500">
              {t("access.dashboard.showing", { shown: filteredRows.length, total: rows.length })}
            </span>
          </div>
          <label className="mt-3 flex max-w-xl items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-2.5 py-2 focus-within:border-blue-300 focus-within:bg-white">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400">
              <circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              data-access-dashboard-search=""
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder={t("access.dashboard.search")}
              aria-label={t("access.dashboard.search")}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-zinc-400"
            />
            {query === "" ? null : (
              <button
                type="button"
                onClick={() => { setQuery(""); }}
                aria-label={t("access.clearSearch")}
                className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600"
              >
                <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5">
                  <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </label>
        </div>

        <div className="hidden grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.25fr)_minmax(100px,0.55fr)_auto] gap-4 border-b border-zinc-200 bg-zinc-50/70 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 lg:grid">
          <span>{t("access.dashboard.departmentColumn")}</span>
          <span>{t("access.dashboard.membersColumn")}</span>
          <span>{t("access.dashboard.projectsColumn")}</span>
          <span>{t("access.dashboard.updatedColumn")}</span>
          <span className="text-right">{t("access.dashboard.actionsColumn")}</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-zinc-400">{t("access.noObservedGroups")}</p>
        ) : filteredRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-zinc-400">{t("access.dashboard.noMatch")}</p>
        ) : filteredRows.map((row) => {
          const rule = row.group.rule;
          const selectedMemberNames = rule?.memberScope === "selected"
            ? row.coveredMembers.map((member) => member.displayName)
            : [];
          const moreMemberCount = Math.max(0, selectedMemberNames.length - 3);
          const memberText = rule === null
            ? "—"
            : row.group.members.length === 0
              ? t("access.noMembers")
              : rule.memberScope === "all"
                ? t("access.dashboard.allMembers", { n: row.group.members.length })
                : t("access.dashboard.selectedMembers", {
                    selected: row.coveredMembers.length,
                    total: row.group.members.length,
                  });
          const projectHint = rule === null
            ? t("access.dashboard.ruleUnconfiguredHint")
            : rule.projectScope === "all"
              ? t("access.dashboard.ruleAllHint", { n: data.projects.length })
              : rule.projectScope === "own"
                ? t("access.dashboard.ruleOwnHint")
                : rule.projectScope === "none"
                  ? t("access.dashboard.ruleNoneHint")
                  : row.projectNames.length === 0
                    ? t("access.dashboard.noProjectSelected")
                    : t("access.dashboard.ruleSelectedHint", { n: row.projectNames.length });
          const projectPreview = row.projectNames.length === 0
            ? ""
            : row.projectNames.slice(0, 2).join(" · ") + (row.projectNames.length > 2
                ? " · " + t("access.dashboard.moreProjects", { n: row.projectNames.length - 2 })
                : "");
          const pathText = row.path.length > 0 ? row.path.join(" / ") : row.group.groupKey;

          return (
            <div
              key={row.group.groupKey}
              data-access-dashboard-row={row.group.groupKey}
              className="grid gap-3 border-b border-zinc-100 px-4 py-3 last:border-b-0 hover:bg-blue-50/20 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.25fr)_minmax(100px,0.55fr)_auto] lg:items-center lg:gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-500">
                    <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4.1l2 2.2H18A2.5 2.5 0 0 1 20.5 8.7v8.8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-11Z" fill="currentColor" />
                  </svg>
                  <span className="min-w-0 truncate text-sm font-semibold text-zinc-800">{row.group.groupName}</span>
                  <span
                    data-access-dashboard-rule-status={rule === null ? "unconfigured" : "configured"}
                    className={"shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium " + (rule === null ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700")}
                  >
                    {rule === null ? t("access.unconfigured") : t("access.configured")}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-zinc-400" title={pathText}>{pathText}</p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{t("access.members", { n: row.group.memberCount })}</p>
              </div>

              <div className="min-w-0">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 lg:hidden">{t("access.dashboard.membersColumn")}</p>
                <p className={"text-xs font-medium " + (rule?.memberScope === "selected" && row.coveredMembers.length === 0 ? "text-amber-600" : "text-zinc-700")}>
                  {memberText}
                </p>
                {rule?.memberScope === "selected" && row.coveredMembers.length === 0 ? (
                  <p className="mt-0.5 text-[11px] text-amber-600">{t("access.memberSelectionEmpty")}</p>
                ) : selectedMemberNames.length > 0 ? (
                  <p
                    className="mt-0.5 truncate text-[11px] text-zinc-400"
                    title={selectedMemberNames.join(" · ")}
                  >
                    {selectedMemberNames.slice(0, 3).join(" · ")}
                    {moreMemberCount > 0 ? " · " + t("access.dashboard.morePeople", { n: moreMemberCount }) : ""}
                  </p>
                ) : null}
              </div>

              <div className="min-w-0">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 lg:hidden">{t("access.dashboard.projectsColumn")}</p>
                <span className={"inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset " + (rule === null ? "bg-zinc-100 text-zinc-500 ring-zinc-200" : SCOPE_PRESENTATION[rule.projectScope].badge)}>
                  <span className="truncate">{rule === null ? t("access.unconfigured") : t(SCOPE_PRESENTATION[rule.projectScope].labelKey)}</span>
                </span>
                <p className={"mt-1 truncate text-[11px] " + (rule?.projectScope === "selected" && row.projectNames.length === 0 ? "text-amber-600" : "text-zinc-400")}>
                  {projectHint}
                </p>
                {projectPreview === "" ? null : (
                  <p className="mt-0.5 truncate text-[11px] text-zinc-400" title={row.projectNames.join(" · ")}>{projectPreview}</p>
                )}
              </div>

              <div className="min-w-0">
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400 lg:hidden">{t("access.dashboard.updatedColumn")}</p>
                <p className="whitespace-nowrap text-[11px] text-zinc-500">{rule === null ? "—" : formatDateTime(rule.updatedAt)}</p>
              </div>

              <div className="justify-self-start lg:justify-self-end">
                <button
                  type="button"
                  data-access-dashboard-open-rule={row.group.groupKey}
                  onClick={() => { onOpenGroup(row.group); }}
                  className="whitespace-nowrap rounded-lg border border-zinc-200 px-3 py-1.5 text-[11px] font-medium text-zinc-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                >
                  {rule === null ? t("access.dashboard.configureRule") : t("access.dashboard.viewRule")}
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
