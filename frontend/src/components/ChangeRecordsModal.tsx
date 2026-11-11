import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchProjectChanges, type ApiChangeRequest } from "../fileApi";
import { fullDateText, stageText, useLocale, useLocalizedTranslator, useT } from "../i18n";
import { dateOnlyText, type ProjectTask } from "../data/tasks";
import type { Member } from "../data/members";
import { lockBodyScroll } from "../scrollLock";
import { ChangeDetailModal, splitChangeReason } from "./ChangeDetailModal";
import { useFocusTrap } from "./useFocusTrap";

type ChangeGroup = {
  key: string;
  task: ProjectTask | null;
  rows: ApiChangeRequest[];
};

const UNLINKED_GROUP = "__unlinked__";

function newestFirst(left: ApiChangeRequest, right: ApiChangeRequest): number {
  return Date.parse(right.appliedAt) - Date.parse(left.appliedAt);
}

/**
 * 项目级「变更记录」弹窗（2026-11-10）：
 * - 项目总览工具区打开，取 GET /projects/{id}/change-requests 一次展示项目全部变更；
 * - 以任务为单位分组，任务条固定在每组顶部并显示任务名称、阶段与条数；
 * - 搜索同时匹配任务名 / 英文名 / 阶段 / 变更内容；无匹配任务时保留未关联变更；
 * - 点单条仍在最上层复用 ChangeDetailModal，保留现有字段、预览与下载口径。
 */
export function ChangeRecordsModal({ projectId, tasks, members, initialTaskId, onClose }: {
  projectId: string;
  tasks: readonly ProjectTask[];
  members: readonly Member[];
  initialTaskId: string | null;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = useT();
  const translate = useLocalizedTranslator();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<readonly ApiChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [query, setQuery] = useState("");
  const [detailChangeId, setDetailChangeId] = useState<string | null>(null);

  useEffect(() => lockBodyScroll(), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    fetchProjectChanges(projectId)
      .then((next) => {
        if (alive) {
          setRows(next);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setRows([]);
          setLoading(false);
          setLoadError(error instanceof Error && error.message !== "" ? error.message : t("project.changeRecords.loadFailed"));
        }
      });
    return () => { alive = false; };
  }, [projectId, retryTick]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  const groups = useMemo<ChangeGroup[]>(() => {
    const taskByNodeId = new Map<string, ProjectTask>();
    const linkedTasks = new Map<string, ProjectTask[]>();
    for (const task of tasks) {
      if (task.nodeId !== null) {
        taskByNodeId.set(task.nodeId, task);
      }
      for (const change of task.changes) {
        const current = linkedTasks.get(change.id);
        if (current === undefined) {
          linkedTasks.set(change.id, [task]);
        } else if (!current.some((item) => item.id === task.id)) {
          current.push(task);
        }
      }
    }
    const buckets = new Map<string, ApiChangeRequest[]>();
    const unlinked: ApiChangeRequest[] = [];
    for (const row of rows) {
      const linked = linkedTasks.get(row.id);
      const exact = linked?.find((task) => task.nodeId !== null && row.nodeId !== null && task.nodeId === row.nodeId);
      const task = exact ?? linked?.[0] ?? (row.nodeId === null ? undefined : taskByNodeId.get(row.nodeId));
      if (task === undefined) {
        unlinked.push(row);
        continue;
      }
      const bucket = buckets.get(task.id);
      if (bucket === undefined) {
        buckets.set(task.id, [row]);
      } else {
        bucket.push(row);
      }
    }
    const next: ChangeGroup[] = tasks
      .map((task) => ({ key: task.id, task, rows: [...(buckets.get(task.id) ?? [])].sort(newestFirst) }))
      .filter((group) => group.rows.length > 0);
    if (unlinked.length > 0) {
      next.push({ key: UNLINKED_GROUP, task: null, rows: unlinked.sort(newestFirst) });
    }
    return next;
  }, [rows, tasks]);

  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const visibleGroups = useMemo(() => {
    if (normalizedQuery === "") {
      return groups;
    }
    return groups.map((group) => {
      const taskHit = group.task !== null && [
        group.task.title,
        group.task.titleEn,
        group.task.stage,
        translate(group.task.title),
      ].some((text) => text.toLocaleLowerCase(locale).includes(normalizedQuery));
      if (taskHit) {
        return group;
      }
      return {
        ...group,
        rows: group.rows.filter((row) => {
          const split = splitChangeReason(row.reason);
          return [
            row.reason,
            split.content,
            split.cause,
            row.beforeSummary ?? "",
            row.afterSummary ?? "",
          ].some((text) => text.toLocaleLowerCase(locale).includes(normalizedQuery));
        }),
      };
    }).filter((group) => group.rows.length > 0);
  }, [groups, locale, normalizedQuery, translate]);

  const visibleCount = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0);

  useEffect(() => {
    if (loading || loadError !== null || initialTaskId === null) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLElement>('[data-change-records-task="' + initialTaskId + '"]');
      target?.scrollIntoView({ block: "start" });
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [loading, loadError, initialTaskId]);

  const detailGroup = detailChangeId === null ? undefined : groups.find((group) => group.rows.some((row) => row.id === detailChangeId));

  return createPortal(
    <div
      ref={trapRef}
      data-change-records-modal="true"
      role="dialog"
      aria-modal="true"
      aria-label={t("project.changeRecords.title")}
      className="fixed inset-0 z-[65] flex items-center justify-center bg-zinc-900/45 p-0 sm:p-5"
      onClick={onClose}
    >
      <div
        onClick={(event) => { event.stopPropagation(); }}
        className="flex h-full max-h-[100dvh] w-full max-w-[1120px] flex-col overflow-hidden bg-white shadow-[0_30px_90px_-24px_rgba(15,23,42,0.4)] sm:h-auto sm:max-h-[88vh] sm:rounded-2xl sm:border sm:border-zinc-200"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-zinc-100 px-4 py-4 sm:px-6">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
              <path d="M4 6h10M4 12h7M4 18h10" />
              <path d="M16 8.5h4v10h-4z" />
              <path d="M17.5 11h1M17.5 14h1" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-zinc-900">{t("project.changeRecords.title")}</h2>
              <span data-change-records-total="true" className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500">
                {t("project.changeRecords.count", { n: rows.length })}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-5 text-zinc-400">{t("project.changeRecords.subtitle")}</p>
          </div>
          <button
            type="button"
            aria-label={t("toast.close")}
            title={t("toast.close")}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="h-4 w-4"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>

        <div className="shrink-0 border-b border-zinc-100 px-4 py-3 sm:px-6">
          <label className="flex h-9 items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-zinc-400 focus-within:border-zinc-300 focus-within:bg-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="h-4 w-4 shrink-0"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            <input
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value); }}
              placeholder={t("project.changeRecords.search")}
              aria-label={t("project.changeRecords.search")}
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
            />
            {query === "" ? null : (
              <button
                type="button"
                aria-label={t("project.changeRecords.clearSearch")}
                onClick={() => { setQuery(""); }}
                className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700"
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5"><path d="m5 5 10 10M15 5 5 15" /></svg>
              </button>
            )}
          </label>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-zinc-50/45 p-3 sm:p-5">
          {loading ? (
            <p data-change-records-loading="true" className="flex h-36 items-center justify-center text-sm text-zinc-400">{t("project.changeRecords.loading")}</p>
          ) : loadError !== null ? (
            <div data-change-records-error="true" className="flex h-36 flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-zinc-500">{loadError}</p>
              <button
                type="button"
                onClick={() => { setRetryTick((value) => value + 1); }}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
              >
                {t("common.retry")}
              </button>
            </div>
          ) : visibleGroups.length === 0 ? (
            <p data-change-records-empty="true" className="flex h-36 items-center justify-center text-sm text-zinc-400">
              {rows.length === 0 ? t("project.changeRecords.empty") : t("project.changeRecords.emptySearch")}
            </p>
          ) : (
            <div className="space-y-4">
              <p className="px-1 text-[11px] text-zinc-400">{t("project.changeRecords.visibleCount", { n: visibleCount })}</p>
              {visibleGroups.map((group) => {
                const taskTitle = group.task === null
                  ? t("project.changeRecords.unlinked")
                  : locale === "en" && group.task.titleEn !== ""
                    ? group.task.titleEn
                    : translate(group.task.title);
                const current = group.task !== null && group.task.id === initialTaskId;
                return (
                  <section
                    key={group.key}
                    data-change-records-task={group.task?.id ?? group.key}
                    className={"overflow-hidden rounded-xl border bg-white " + (current ? "border-amber-300 shadow-[0_0_0_3px_rgba(254,202,4,0.12)]" : "border-zinc-200")}
                  >
                    <div className={"sticky top-0 z-[2] flex items-center gap-2 border-b px-3 py-2.5 backdrop-blur sm:px-4 " + (current ? "border-amber-200 bg-amber-50/95" : "border-zinc-100 bg-white/95")}>
                      <span className={"h-6 w-1 shrink-0 rounded-full " + (group.task === null ? "bg-zinc-300" : "bg-amber-400")} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-800" title={taskTitle}>{taskTitle}</p>
                        <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                          {group.task === null ? t("project.changeRecords.originUnknown") : stageText(locale, group.task.stage)}
                        </p>
                      </div>
                      {current ? <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">{t("project.changeRecords.currentTask")}</span> : null}
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500">
                        {t("project.changeRecords.taskCount", { n: group.rows.length })}
                      </span>
                    </div>
                    <div className="divide-y divide-zinc-100">
                      {group.rows.map((row) => {
                        const split = splitChangeReason(row.reason);
                        const summary = split.content !== "" ? split.content : split.cause !== "" ? split.cause : t("project.changeRecords.noReason");
                        return (
                          <button
                            key={row.id}
                            type="button"
                            data-change-records-item={row.id}
                            onClick={() => { setDetailChangeId(row.id); }}
                            className="group flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-50 sm:px-4"
                          >
                            <span className="mt-0.5 shrink-0 rounded bg-zinc-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500 ring-1 ring-zinc-200">
                              {fullDateText(locale, dateOnlyText(row.appliedAt))}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-700">{summary}</span>
                            </span>
                            <span aria-hidden="true" className="mt-1 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500">
                              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="m7 4 6 6-6 6" /></svg>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {detailChangeId === null ? null : (
        <ChangeDetailModal
          changeId={detailChangeId}
          linkedTaskTitle={detailGroup?.task?.title ?? null}
          members={members}
          deliverableTypes={detailGroup?.task?.deliverableTypes ?? []}
          onClose={() => { setDetailChangeId(null); }}
        />
      )}
    </div>,
    document.body,
  );
}
