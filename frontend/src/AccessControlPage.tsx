import { useEffect, useState } from "react";
import {
  deleteGroupAccessRule,
  fetchAccessOverview,
  saveGroupAccessRule,
  type GroupAccessGroup,
  type GroupAccessOverview,
  type GroupAccessProjectScope,
} from "./accessApi";
import { AppHeader } from "./components/AppHeader";
import { Toast, type ToastKind } from "./components/Toast";
import { useT, type TextKey } from "./i18n";
import { GROUP_ACCESS_PAGE_KEYS, loadMyPermissions, type GroupAccessPage } from "./permissions";
import type { MeResponse } from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: GroupAccessOverview }
  | { kind: "error"; message: string };

type Notice = { kind: ToastKind; text: string };

const PAGE_LABEL_KEYS: Record<GroupAccessPage, TextKey> = {
  dashboard: "access.page.dashboard",
  projects: "access.page.projects",
  templates: "access.page.templates",
  workspace: "access.page.workspace",
  files: "access.page.files",
  audit: "access.page.audit",
};

const SCOPE_OPTIONS: Array<{ value: GroupAccessProjectScope; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.scope.all" },
  { value: "selected", labelKey: "access.scope.selected" },
  { value: "none", labelKey: "access.scope.none" },
];

/**
 * 权限管理页（2026-10-23 · 头像菜单入口）：按 Casdoor 群组配置页面与项目范围。
 * 本页只做配置；真实裁决在服务端 PermissionService，关闭 GROUP_ACCESS_ENFORCED 时规则仅保存不生效。
 */
export function AccessControlPage({ me }: { me: MeResponse }) {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [allowedPages, setAllowedPages] = useState<GroupAccessPage[]>([]);
  const [projectScope, setProjectScope] = useState<GroupAccessProjectScope>("none");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [projectQuery, setProjectQuery] = useState("");
  const [manualKey, setManualKey] = useState("");
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
        setSelectedKey((current) => {
          if (current !== null) return current;
          const first = data.groups[0];
          if (first === undefined) return null;
          applyGroup(first);
          return first.groupKey;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  function applyGroup(group: GroupAccessGroup): void {
    setAllowedPages(group.rule?.allowedPages ?? []);
    setProjectScope(group.rule?.projectScope ?? "none");
    setProjectIds(group.rule?.projectIds ?? []);
    setProjectQuery("");
  }

  function openGroup(group: GroupAccessGroup): void {
    setSelectedKey(group.groupKey);
    applyGroup(group);
  }

  function openManualGroup(): void {
    const key = manualKey.trim();
    if (key === "") return;
    setSelectedKey(key);
    setAllowedPages([]);
    setProjectScope("none");
    setProjectIds([]);
    setProjectQuery("");
    setManualKey("");
  }

  function togglePage(page: GroupAccessPage): void {
    setAllowedPages((current) => (current.includes(page) ? current.filter((item) => item !== page) : current.concat(page)));
  }

  function toggleProject(projectId: string): void {
    setProjectIds((current) => (current.includes(projectId) ? current.filter((id) => id !== projectId) : current.concat(projectId)));
  }

  async function handleSave(): Promise<void> {
    if (selectedKey === null || saving) return;
    setSaving(true);
    try {
      await saveGroupAccessRule({
        groupKey: selectedKey,
        allowedPages,
        projectScope,
        projectIds: projectScope === "selected" ? projectIds : [],
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
      setAllowedPages([]);
      setProjectScope("none");
      setProjectIds([]);
      void loadMyPermissions(true);
      setReload((value) => value + 1);
    } catch (error: unknown) {
      setNotice({ kind: "error", text: t("access.deleteFailed", { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setDeleting(false);
    }
  }

  const data = state.kind === "ready" ? state.data : null;
  const selectedGroup = data?.groups.find((group) => group.groupKey === selectedKey) ?? null;
  const selectedRule = selectedGroup?.rule ?? null;
  const query = projectQuery.trim().toLowerCase();
  const projects = data === null ? [] : query === "" ? data.projects : data.projects.filter((project) => (project.code + " " + project.name).toLowerCase().includes(query));

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
                <p className="mt-1">{t("access.currentGroups")}: {data.currentGroupKeys.length === 0 ? t("access.noGroups") : data.currentGroupKeys.join(" · ")}</p>
              </section>

              <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <aside className="rounded-2xl border border-zinc-200 bg-white p-3">
                  <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{t("access.groups")}</h2>
                  <div className="max-h-[420px] space-y-1 overflow-auto">
                    {data.groups.map((group) => (
                      <button
                        key={group.groupKey}
                        type="button"
                        onClick={() => openGroup(group)}
                        className={"w-full rounded-lg px-2.5 py-2 text-left transition " + (group.groupKey === selectedKey ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100")}
                      >
                        <span className="block truncate text-sm font-medium">{group.groupName}</span>
                        <span className={"mt-0.5 block truncate text-[11px] " + (group.groupKey === selectedKey ? "text-zinc-300" : "text-zinc-400")}>{group.groupKey}</span>
                        <span className={"mt-1 block text-[11px] " + (group.groupKey === selectedKey ? "text-zinc-300" : "text-zinc-500")}>
                          {t("access.members", { n: group.memberCount })} · {group.rule === null ? t("access.unconfigured") : group.rule.allowedPages.length + " " + t("access.pages")}
                        </span>
                      </button>
                    ))}
                    {data.groups.length === 0 ? <p className="px-2 py-3 text-xs text-zinc-500">{t("access.noObservedGroups")}</p> : null}
                  </div>
                  <div className="mt-3 border-t border-zinc-200 pt-3">
                    <label className="mb-1 block text-xs text-zinc-500" htmlFor="access-manual-group">{t("access.addGroup")}</label>
                    <input
                      id="access-manual-group"
                      value={manualKey}
                      onChange={(event) => { setManualKey(event.target.value); }}
                      placeholder={t("access.addGroupPlaceholder")}
                      className="w-full rounded-lg border border-zinc-200 px-2.5 py-2 text-xs outline-none focus:border-zinc-400"
                    />
                    <button type="button" onClick={openManualGroup} className="mt-2 w-full rounded-lg bg-zinc-100 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200">
                      {t("access.add")}
                    </button>
                  </div>
                </aside>

                <section className="space-y-4">
                  {selectedKey === null ? (
                    <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">{t("access.noGroupSelected")}</p>
                  ) : (
                    <>
                      <div className="rounded-2xl border border-zinc-200 bg-white p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate text-base font-semibold text-zinc-900">{selectedGroup?.groupName ?? selectedKey}</h2>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{selectedKey}</p>
                          </div>
                          <span className={"rounded-full px-2.5 py-1 text-[11px] font-medium " + (selectedRule === null ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700")}>
                            {selectedRule === null ? t("access.unconfigured") : t("access.configured")}
                          </span>
                        </div>

                        <h3 className="mt-5 text-sm font-semibold text-zinc-800">{t("access.pagesTitle")}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500">{t("access.pagesHint")}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {GROUP_ACCESS_PAGE_KEYS.map((page) => (
                            <label key={page} className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
                              <input type="checkbox" checked={allowedPages.includes(page)} onChange={() => { togglePage(page); }} className="h-4 w-4 accent-zinc-900" />
                              {t(PAGE_LABEL_KEYS[page])}
                            </label>
                          ))}
                        </div>

                        <h3 className="mt-6 text-sm font-semibold text-zinc-800">{t("access.projectsTitle")}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500">{t("access.projectsHint")}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
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
                        <button type="button" onClick={() => { setReload((value) => value + 1); }} className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50">
                          {t("access.refresh")}
                        </button>
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
