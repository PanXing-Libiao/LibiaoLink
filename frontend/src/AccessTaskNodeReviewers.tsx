import { useMemo, useState } from "react";
import type { GroupAccessAdmin } from "./accessApi";
import { useT } from "./i18n";

type Props = {
  admins: GroupAccessAdmin[];
  selectedIds: string[];
  savedIds: string[];
  dirty: boolean;
  busy: boolean;
  onToggle: (userId: string) => void;
  onReset: () => void;
  onSave: () => void;
};

function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  return chars[0] ?? "?";
}

function selectedCountParams(selected: number, total: number): Record<string, string> {
  return { selected: String(selected), total: String(total) };
}

/**
 * 权限管理 · 公共节点审核：
 * 只在当前系统管理员中选择任务模板「入库审核」的审核人；页面本身仅权限管理员可进入。
 * 初始名单为空表示尚未配置：不预选任何管理员，保存至少一名后审核权才生效。
 */
export function AccessTaskNodeReviewers({
  admins,
  selectedIds,
  savedIds,
  dirty,
  busy,
  onToggle,
  onReset,
  onSave,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const saved = useMemo(() => new Set(savedIds), [savedIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleAdmins = useMemo(
    () => admins.filter((admin) =>
      normalizedQuery === "" ||
      (admin.displayName + " " + admin.username + " " + (admin.email ?? "")).toLowerCase().includes(normalizedQuery),
    ),
    [admins, normalizedQuery],
  );
  const activeCount = admins.filter((admin) => admin.status === "active").length;

  return (
    <div data-access-task-node-reviewers="" className="mx-auto w-full max-w-6xl space-y-4">
      <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="relative overflow-hidden border-b border-zinc-100 bg-[linear-gradient(135deg,rgba(37,99,235,0.10),rgba(255,255,255,0)_62%)] px-5 py-5 sm:px-6">
          <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-blue-100/60 blur-2xl" aria-hidden="true" />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3.5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.28)]">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6">
                  <path d="M12 3.2 19 6v5.2c0 4.6-2.8 8-7 9.6-4.2-1.6-7-5-7-9.6V6l7-2.8Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  <path d="m8.8 12 2.1 2.1 4.4-4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight text-zinc-950">{t("access.reviewers.title")}</h2>
                  <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-700">
                    {t("access.reviewers.adminOnly")}
                  </span>
                </div>
                <p className="mt-1.5 max-w-3xl text-xs leading-5 text-zinc-600">{t("access.reviewers.hint")}</p>
              </div>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2">
              <div className="min-w-24 rounded-xl border border-white/90 bg-white/80 px-3 py-2 shadow-sm backdrop-blur">
                <p className="text-[10px] text-zinc-400">{t("access.reviewers.selectedLabel")}</p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900">
                  {selected.size}<span className="text-[11px] font-normal text-zinc-400"> / {admins.length}</span>
                </p>
              </div>
              <div className="min-w-24 rounded-xl border border-white/90 bg-white/80 px-3 py-2 shadow-sm backdrop-blur">
                <p className="text-[10px] text-zinc-400">{t("access.reviewers.adminPool")}</p>
                <p className="mt-0.5 text-base font-semibold tabular-nums text-zinc-900">{activeCount}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3 sm:px-5">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 ring-1 ring-inset ring-zinc-200 transition focus-within:bg-white focus-within:ring-blue-300 sm:max-w-md">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400">
              <circle cx="8.5" cy="8.5" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="m12.2 12.2 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); }}
              placeholder={t("access.reviewers.search")}
              aria-label={t("access.reviewers.search")}
              className="min-w-0 flex-1 bg-transparent text-xs text-zinc-700 outline-none placeholder:text-zinc-400"
            />
            {query === "" ? null : (
              <button type="button" onClick={() => { setQuery(""); }} aria-label={t("access.clearSearch")} className="text-zinc-400 transition hover:text-zinc-700">
                <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5">
                  <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </label>
          <span className="ml-auto text-[11px] tabular-nums text-zinc-400">
            {t("access.reviewers.selectionSummary", selectedCountParams(selected.size, admins.length))}
          </span>
        </div>

        {visibleAdmins.length === 0 ? (
          <p className="px-5 py-12 text-center text-xs text-zinc-400">{t("access.reviewers.empty")}</p>
        ) : (
          <ul className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
            {visibleAdmins.map((admin) => {
              const checked = selected.has(admin.userId);
              const wasSaved = saved.has(admin.userId);
              const disabled = admin.status !== "active";
              return (
                <li key={admin.userId}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={admin.displayName}
                    data-reviewer-user-id={admin.userId}
                    disabled={disabled || busy}
                    onClick={() => { if (!disabled) onToggle(admin.userId); }}
                    className={
                      "group flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition " +
                      (checked
                        ? "border-blue-200 bg-blue-50/75 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.08)]"
                        : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/80") +
                      (disabled ? " cursor-not-allowed opacity-55" : " cursor-pointer")
                    }
                  >
                    <span className={
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold " +
                      (checked ? "bg-blue-600 text-white shadow-sm" : "bg-zinc-100 text-zinc-500 group-hover:bg-white")
                    }>
                      {initialOf(admin.displayName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-zinc-900">{admin.displayName}</span>
                        {disabled ? (
                          <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{t("access.memberDisabled")}</span>
                        ) : wasSaved ? (
                          <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">{t("access.reviewers.savedBadge")}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-zinc-400">
                        {admin.username}{admin.email === null ? "" : " · " + admin.email}
                      </span>
                      <span className="mt-1 block text-[9px] font-medium text-zinc-400">
                        {admin.source === "configured" ? t("access.adminSourceConfigured") : t("access.adminSourceManual")}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition " +
                        (checked ? "border-blue-600 bg-blue-600 text-white" : "border-zinc-300 bg-white text-transparent")
                      }
                    >
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5">
                        <path d="m4.8 10.2 3.2 3.2 7-7" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="sticky bottom-3 z-20 mx-3 mb-3 flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className={"text-xs font-medium " + (selected.size === 0 ? "text-rose-600" : dirty ? "text-amber-700" : "text-zinc-600")}>
              {selected.size === 0 ? t("access.reviewers.atLeastOne") : dirty ? t("access.reviewers.unsaved") : t("access.reviewers.savedState")}
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-zinc-400">{t("access.reviewers.saveHint")}</p>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={!dirty || busy}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-40"
            >
              {t("access.reviewers.reset")}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || busy || selected.size === 0}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? t("access.saving") : t("access.reviewers.save")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
