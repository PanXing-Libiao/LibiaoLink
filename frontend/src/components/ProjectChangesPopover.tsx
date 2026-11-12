import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api";
import { memberNameOf, type Member } from "../data/members";
import { dateOnlyText, ownersLabel, type ProjectTask } from "../data/tasks";
import {
  ensurePreviewOutcome,
  fetchChangeRequest,
  fetchDownloadUrl,
  fetchProjectChanges,
  previewKindOf,
  recordPreviewView,
  triggerDownload,
  type ApiChangeRequest,
  type ChangeRequestDetail,
  type FilePreviewKind,
  type PreviewViewerConfig,
} from "../fileApi";
import { fieldText, isLocalizedLocale, mdText, stageText, statusText, useLocale, useLocalizedTranslator, useT } from "../i18n";
import {
  materialReissueApplicationDepartmentText,
  materialReissueApprovalText,
  materialReissueDefaultEmailTitle,
  materialReissueDepartmentText,
  materialReissueFreightText,
  materialReissueReasonText,
} from "../materialReissue";
import { mobileFilePreviewMustDownload } from "../mobilePreviewPolicy";
import { applicantHandleText, slashDate, splitChangeReason, stageLabelOf, textOrDash } from "./ChangeDetailModal";
import { FilePreviewOverlay } from "./FilePreviewOverlay";
import { FileTypeIcon } from "./FileTypeIcon";
import { PhotoStrip } from "./ReportIssuePanel";

type ChangeEntry =
  | { state: "loading" }
  | { state: "ready"; detail: ChangeRequestDetail }
  | { state: "error"; note: string };

type PopoverPosition = {
  left: number;
  width: number;
  side: "bottom" | "top";
  top: number | null;
  bottom: number | null;
  maxHeight: number;
};

type PreviewState = {
  detail: ChangeRequestDetail;
  pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
  name: string;
  kind: FilePreviewKind;
  nonce: number;
};

type ChangeGroup = {
  task: ProjectTask;
  changes: ProjectTask["changes"];
};

type ChangeKind = "file_change" | "material_reissue";
type ChangeKindFilter = "all" | ChangeKind;

/**
 * 项目总览表头「变更关联」按钮（2026-11-10）：触发器是列名本身，不是任务行内的胶囊；
 * 任务行仍保留原有的「变更关联」胶囊与中央详情弹窗。表头按钮打开白底圆角气泡，气泡按视口水平居中，
 * 汇总整个项目所有任务的变更：先按任务展示大记录，展开任务后看到该任务的全部变更，再展开单条变更看小详情。
 * 点击外部 / Esc 关闭；portal 根节点拦截点击与按键冒泡，避免误开任务抽屉。
 */
export function ProjectChangesPopover({ tasks, members, projectId, onOpenTask }: {
  tasks: readonly ProjectTask[];
  members: readonly Member[];
  projectId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const localize = useLocalizedTranslator();

  const groups: ChangeGroup[] = tasks
    .filter((task) => task.changes.length > 0)
    .map((task) => ({
      task,
      changes: [...task.changes].sort((left, right) => Date.parse(right.appliedAt) - Date.parse(left.appliedAt)),
    }))
    .sort((left, right) => Date.parse(right.changes[0]?.appliedAt ?? "") - Date.parse(left.changes[0]?.appliedAt ?? ""));
  const totalChanges = groups.reduce((total, group) => total + group.changes.length, 0);
  const summaryText = t("board.change.projectSummary", { tasks: groups.length, changes: totalChanges });

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [openTaskIds, setOpenTaskIds] = useState<Record<string, boolean>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, ChangeEntry>>({});
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<{ id: string; text: string } | null>(null);
  const [thumbPreviewOpen, setThumbPreviewOpen] = useState(false);
  const [catalog, setCatalog] = useState<Record<string, ApiChangeRequest>>({});
  const [kindFilter, setKindFilter] = useState<ChangeKindFilter>("all");

  const tRef = useRef(t);
  tRef.current = t;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const entriesRef = useRef<Record<string, ChangeEntry>>({});
  const inflightRef = useRef<Set<string>>(new Set());
  const previewRef = useRef<PreviewState | null>(null);
  const thumbPreviewOpenRef = useRef(false);
  entriesRef.current = entries;
  previewRef.current = preview;
  thumbPreviewOpenRef.current = thumbPreviewOpen;

  useEffect(() => {
    setCatalog({});
  }, [projectId]);

  useEffect(() => {
    if (!open || projectId === undefined || projectId === "") {
      return;
    }
    let cancelled = false;
    void fetchProjectChanges(projectId)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        const next: Record<string, ApiChangeRequest> = {};
        rows.forEach((row) => {
          next[row.id] = row;
        });
        setCatalog(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const titleOf = (task: ProjectTask) => isLocalizedLocale(locale)
    ? (locale === "en" && task.titleEn !== "" ? task.titleEn : localize(task.title))
    : task.title;

  const loadDetail = useCallback((changeId: string, force = false) => {
    if (inflightRef.current.has(changeId)) {
      return;
    }
    if (!force && entriesRef.current[changeId] !== undefined) {
      return;
    }
    inflightRef.current.add(changeId);
    setEntries((previous) => ({ ...previous, [changeId]: { state: "loading" } }));
    void fetchChangeRequest(changeId)
      .then((detail) => {
        setEntries((previous) => ({ ...previous, [changeId]: { state: "ready", detail } }));
      })
      .catch((error: unknown) => {
        const note = error instanceof ApiError && (error.status === 403 || error.status === 404)
          ? tRef.current("cd.gone")
          : error instanceof Error && error.message !== ""
            ? error.message
            : tRef.current("drawer.record.missing");
        setEntries((previous) => ({ ...previous, [changeId]: { state: "error", note } }));
      })
      .finally(() => {
        inflightRef.current.delete(changeId);
      });
  }, []);

  const kindOfChange = (change: ChangeGroup["changes"][number]): ChangeKind => {
    const entry = entries[change.id];
    if (entry !== undefined && entry.state === "ready") {
      return entry.detail.changeType;
    }
    const catalogRow = catalog[change.id];
    if (catalogRow !== undefined) {
      return catalogRow.changeType;
    }
    return change.reason.trimStart().startsWith("物料变更补发") ? "material_reissue" : "file_change";
  };
  const applicantIdOfChange = (change: ChangeGroup["changes"][number]): string => {
    const entry = entries[change.id];
    if (entry !== undefined && entry.state === "ready") {
      return entry.detail.appliedBy;
    }
    return catalog[change.id]?.appliedBy ?? "";
  };
  const kindCounts: Record<ChangeKind, number> = { file_change: 0, material_reissue: 0 };
  groups.forEach(({ changes }) => {
    changes.forEach((change) => {
      kindCounts[kindOfChange(change)] += 1;
    });
  });
  const kindTabs: ReadonlyArray<{ key: ChangeKindFilter; label: string; count: number }> = [
    { key: "all", label: t("board.change.filterAll"), count: totalChanges },
    { key: "file_change", label: t("board.change.filterFile"), count: kindCounts.file_change },
    { key: "material_reissue", label: t("board.change.filterMaterial"), count: kindCounts.material_reissue },
  ];
  const visibleGroups = groups
    .map(({ task, changes }) => ({
      task,
      changes: kindFilter === "all" ? changes : changes.filter((change) => kindOfChange(change) === kindFilter),
    }))
    .filter(({ changes }) => changes.length > 0);

  const updatePosition = useCallback(() => {
    if (!open) {
      return;
    }
    const trigger = triggerRef.current;
    if (trigger === null) {
      return;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(320, Math.min(760, viewportWidth - 16));
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.round((viewportWidth - width) / 2));
    const gap = 11;
    const margin = 12;
    const belowSpace = Math.max(0, viewportHeight - rect.bottom - gap - margin);
    const aboveSpace = Math.max(0, rect.top - gap - margin);
    const measuredHeight = popoverRef.current === null ? 520 : popoverRef.current.getBoundingClientRect().height;
    const side: "bottom" | "top" = belowSpace >= Math.min(measuredHeight, 620) || belowSpace >= aboveSpace ? "bottom" : "top";
    const available = side === "bottom" ? belowSpace : aboveSpace;
    const maxHeight = Math.max(180, Math.min(700, available));
    setPosition({
      left,
      width,
      side,
      top: side === "bottom" ? rect.bottom + gap : null,
      bottom: side === "top" ? viewportHeight - rect.top + gap : null,
      maxHeight,
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (previewRef.current !== null || thumbPreviewOpenRef.current) {
        return;
      }
      const target = event.target as Node;
      const insideTrigger = triggerRef.current !== null && triggerRef.current.contains(target);
      const insidePopover = popoverRef.current !== null && popoverRef.current.contains(target);
      if (!insideTrigger && !insidePopover) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (previewRef.current !== null) {
        event.preventDefault();
        event.stopPropagation();
        setPreview(null);
        return;
      }
      if (thumbPreviewOpenRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const handleViewportChange = () => {
      updatePosition();
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || popoverRef.current === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      updatePosition();
    });
    observer.observe(popoverRef.current);
    return () => {
      observer.disconnect();
    };
  }, [open, position === null, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setActiveId(null);
    setPreview(null);
    setPreviewNote(null);
  }, [open]);

  const downloadChangeFile = async (detail: ChangeRequestDetail) => {
    if (detail.file === null || detail.versionId === null) {
      return;
    }
    try {
      const signed = await fetchDownloadUrl(detail.file.id, detail.versionId);
      await triggerDownload(signed.url, signed.fileName);
    } catch (error) {
      setPreviewNote({
        id: detail.id,
        text: error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed"),
      });
    }
  };

  const openFilePreview = async (detail: ChangeRequestDetail) => {
    if (detail.file === null || detail.versionId === null || previewBusy !== null) {
      return;
    }
    if (mobileFilePreviewMustDownload(detail.file.name)) {
      await downloadChangeFile(detail);
      return;
    }
    setPreviewBusy(detail.id);
    setPreviewNote(null);
    const outcome = await ensurePreviewOutcome(detail.file.id, detail.versionId);
    setPreviewBusy(null);
    if (outcome.kind === "unavailable") {
      setPreviewNote({ id: detail.id, text: outcome.reason ?? t("drawer.preview.unavailable") });
      return;
    }
    void recordPreviewView(detail.file.id, detail.versionId);
    const fileName = detail.file.name;
    setPreview((previous) => ({
      detail,
      pane: outcome.kind === "viewer" ? { mode: "viewer", viewer: outcome.viewer } : { mode: "url", url: outcome.url },
      name: fileName,
      kind: previewKindOf(fileName) ?? "image",
      nonce: previous === null ? 0 : previous.nonce + 1,
    }));
  };

  const toggleTask = (taskId: string) => {
    const nextOpen = openTaskIds[taskId] !== true;
    setOpenTaskIds((previous) => ({ ...previous, [taskId]: nextOpen }));
    const group = groups.find((item) => item.task.id === taskId);
    if (nextOpen) {
      group?.changes.forEach((change) => { loadDetail(change.id); });
      return;
    }
    if (group !== undefined && activeId !== null && group.changes.some((change) => change.id === activeId)) {
      setActiveId(null);
    }
  };

  const toggleRecord = (changeId: string) => {
    if (activeId === changeId) {
      setActiveId(null);
      return;
    }
    setActiveId(changeId);
    const entry = entries[changeId];
    loadDetail(changeId, entry !== undefined && entry.state === "error");
  };

  const closePopover = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openTaskAndClose = (taskId: string) => {
    setOpen(false);
    onOpenTask?.(taskId);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-project-changes-open="true"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("board.change.projectOpen")}
        title={t("board.change.projectOpen") + " · " + summaryText}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
        className="inline-flex h-6 max-w-full shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-zinc-200 bg-amber-50 px-2 text-[11px] font-medium leading-5 text-amber-700 outline-none transition hover:border-zinc-300 hover:bg-amber-100/70 hover:text-amber-800 focus-visible:ring-2 focus-visible:ring-amber-500/30"
      >
        {t("board.change.projectButton")}
      </button>
      {open && position !== null ? createPortal(
        <div
          ref={popoverRef}
          data-project-changes-dropdown="true"
          data-task-changes-dropdown="true"
          role="dialog"
          aria-label={t("board.change.projectTitle")}
          data-live-sync-readonly="true"
          style={{
            left: position.left,
            width: position.width,
            top: position.top ?? undefined,
            bottom: position.bottom ?? undefined,
            maxHeight: position.maxHeight,
          } as CSSProperties}
          onClick={(event) => { event.stopPropagation(); }}
          onKeyDown={(event) => { event.stopPropagation(); }}
          className="fixed z-[65]"
        >
          <div
            className="flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-zinc-200/85 bg-white shadow-[0_24px_64px_rgba(15,23,42,0.22),0_4px_14px_rgba(15,23,42,0.08)]"
            style={{ maxHeight: position.maxHeight }}
          >
            <header className="shrink-0 border-b border-zinc-100 px-4 pb-3 pt-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
                    <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M12 7.5V12l4 2" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[15px] font-semibold leading-5 text-zinc-900">{t("board.change.projectTitle")}</p>
                    <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700">{summaryText}</span>
                  </div>
                </div>
                <button
                  type="button"
                  data-project-changes-close="true"
                  title={t("cd.close")}
                  aria-label={t("cd.close")}
                  onClick={closePopover}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/15"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </header>

            <nav data-project-change-kind-tabs="true" className="shrink-0 border-b border-zinc-100 bg-white px-3 py-2">
              <div role="tablist" aria-label={t("board.change.filterLabel")} className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-100/80 p-1">
                {kindTabs.map((tab) => {
                  const selected = kindFilter === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-project-change-kind-tab={tab.key}
                      onClick={() => {
                        setKindFilter(tab.key);
                        setActiveId(null);
                      }}
                      className={"flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30 " + (selected ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200/80" : "text-zinc-500 hover:bg-white/70 hover:text-zinc-700")}
                    >
                      <span className="truncate">{tab.label}</span>
                      <span className={"shrink-0 rounded-full px-1.5 py-0.5 text-[9px] tabular-nums " + (selected ? "bg-amber-50 text-amber-700" : "bg-zinc-200/70 text-zinc-500")}>{tab.count}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white px-3 py-3">
              {groups.length === 0 ? (
                <div data-project-changes-empty="true" className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
                      <path d="M5 6h14M5 12h9M5 18h6" />
                    </svg>
                  </span>
                  <p className="text-[12px] text-zinc-500">{t("board.change.projectEmpty")}</p>
                </div>
              ) : visibleGroups.length === 0 ? (
                <div data-project-change-kind-empty="true" className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
                      <path d="M5 6h14M5 12h9M5 18h6" />
                    </svg>
                  </span>
                  <p className="text-[12px] text-zinc-500">{t("board.change.projectKindEmpty")}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {visibleGroups.map(({ task, changes }) => {
                    const taskTitle = titleOf(task);
                    const taskOpen = openTaskIds[task.id] === true;
                    const taskMeta = [
                      task.stage === "" ? "" : stageText(locale, task.stage),
                      task.owners.length === 0 ? fieldText(locale, "待分配") : ownersLabel(task.owners),
                      task.dueDate === "" ? "" : fieldText(locale, "预计完成日期") + " " + mdText(locale, task.dueDate),
                    ].filter((part) => part !== "");
                    return (
                      <section
                        key={task.id}
                        data-project-change-task={task.id}
                        className={"overflow-hidden rounded-xl border bg-white transition " + (taskOpen ? "border-amber-300 shadow-[0_4px_14px_rgba(245,158,11,0.08)]" : "border-zinc-200/80 hover:border-zinc-300")}
                      >
                        <button
                          type="button"
                          data-project-change-task-toggle={task.id}
                          aria-expanded={taskOpen}
                          onClick={() => { toggleTask(task.id); }}
                          className="flex w-full items-start gap-2.5 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/30"
                        >
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-3.5 w-3.5">
                              <path d="M8 5h8M6 9h12M5 13h14M7 17h10M9 21h6" />
                            </svg>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="min-w-0 flex-1 line-clamp-2 text-[13px] font-semibold leading-5 text-zinc-900">{taskTitle}</span>
                              <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-amber-700">{t("board.change.count", { n: changes.length })}</span>
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-zinc-500">
                              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-zinc-600">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                {statusText(locale, task.status)}
                              </span>
                              {taskMeta.map((part, index) => (
                                <span key={part + String(index)} className="inline-flex items-center gap-2">
                                  {index === 0 ? null : <span aria-hidden="true" className="text-zinc-300">·</span>}
                                  <span>{part}</span>
                                </span>
                              ))}
                            </span>
                          </span>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"mt-1 h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform " + (taskOpen ? "rotate-180" : "")}>
                            <path d="M6 9.5l6 6 6-6" />
                          </svg>
                        </button>
                        {taskOpen ? (
                          <div data-project-change-task-changes={task.id} className="flex flex-col gap-2 border-t border-zinc-100 bg-zinc-50/45 p-2.5">
                            {changes.map((change) => {
                              const entry = entries[change.id];
                              const active = activeId === change.id;
                              const detail = entry !== undefined && entry.state === "ready" ? entry.detail : null;
                              const summary = splitChangeReason(detail === null ? change.reason : detail.reason).content;
                              const kind = kindOfChange(change);
                              const isMaterial = kind === "material_reissue";
                              const applicantId = detail?.appliedBy ?? catalog[change.id]?.appliedBy ?? applicantIdOfChange(change);
                              return (
                                <div
                                  key={change.id}
                                  data-task-change-record={change.id}
                                  data-project-change-record={change.id}
                                  className={"overflow-hidden rounded-xl border bg-white transition " + (active ? "border-amber-300 shadow-[0_4px_14px_rgba(245,158,11,0.10)]" : "border-zinc-200/80 hover:border-zinc-300 hover:shadow-[0_3px_10px_rgba(15,23,42,0.06)]")}
                                >
                                  <button
                                    type="button"
                                    data-task-change-toggle={change.id}
                                    aria-expanded={active}
                                    onClick={() => { toggleRecord(change.id); }}
                                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/30"
                                  >
                                    <span className="w-[64px] shrink-0 pt-0.5">
                                      <span className="block text-[12px] font-semibold tabular-nums text-zinc-800">{slashDate(change.appliedAt)}</span>
                                      <span className="mt-0.5 block text-[9px] uppercase tracking-[0.12em] text-zinc-400">{dateOnlyText(change.appliedAt).slice(0, 4)}</span>
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="flex flex-wrap items-center gap-1.5">
                                        <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium " + (isMaterial ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
                                          {isMaterial ? fieldText(locale, "物料变更补发") : t("mr.menu.file")}
                                        </span>
                                        {applicantId !== "" ? (
                                          <span className="truncate text-[10px] text-zinc-400">{memberNameOf(members, applicantId) ?? applicantId}</span>
                                        ) : null}
                                      </span>
                                      <span className="mt-1.5 line-clamp-2 block text-[12px] leading-5 text-zinc-600">{summary === "" ? t("drawer.history.noReason") : summary}</span>
                                    </span>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"mt-1 h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform " + (active ? "rotate-180" : "")}>
                                      <path d="M6 9.5l6 6 6-6" />
                                    </svg>
                                  </button>
                                  {active ? (
                                    <div data-task-change-detail={change.id} className="border-t border-zinc-100 bg-zinc-50/65 px-3 py-3">
                                      {entry === undefined || entry.state === "loading" ? (
                                        <p className="py-2 text-center text-[11px] text-zinc-400">{t("board.change.loading")}</p>
                                      ) : entry.state === "error" ? (
                                        <div className="flex items-center gap-2 py-1.5">
                                          <p className="min-w-0 flex-1 text-[11px] leading-5 text-zinc-500">{entry.note}</p>
                                          <button
                                            type="button"
                                            data-task-change-retry="true"
                                            onClick={() => { loadDetail(change.id, true); }}
                                            className="shrink-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] text-zinc-600 transition hover:bg-zinc-50"
                                          >
                                            {t("drawer.history.retry")}
                                          </button>
                                        </div>
                                      ) : (
                                        <ExpandedChangeDetail
                                          detail={entry.detail}
                                          members={members}
                                          deliverableTypes={task.deliverableTypes}
                                          taskTitle={taskTitle}
                                          previewBusy={previewBusy === entry.detail.id}
                                          previewNote={previewNote !== null && previewNote.id === entry.detail.id ? previewNote.text : null}
                                          onPreview={() => { void openFilePreview(entry.detail); }}
                                          onDownload={() => { void downloadChangeFile(entry.detail); }}
                                          onThumbPreviewOpenChange={setThumbPreviewOpen}
                                          onOpenTask={onOpenTask === undefined ? undefined : () => { openTaskAndClose(task.id); }}
                                        />
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-100 bg-white px-3.5 py-2 text-[10px] text-zinc-400">
              <span>{t("board.change.projectHintShort")}</span>
              <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{t("board.change.esc")}</span>
            </footer>
          </div>
        </div>,
        document.body,
      ) : null}
      {preview === null ? null : (
        <FilePreviewOverlay
          pane={preview.pane}
          name={preview.name}
          kind={preview.kind}
          nonce={preview.nonce}
          zClass="z-[90]"
          onRetry={() => { void openFilePreview(preview.detail); }}
          onDownload={() => { void downloadChangeFile(preview.detail); }}
          onClose={() => { setPreview(null); }}
        />
      )}
    </>
  );
}

function ExpandedChangeDetail({ detail, members, deliverableTypes, taskTitle, previewBusy, previewNote, onPreview, onDownload, onThumbPreviewOpenChange, onOpenTask }: {
  detail: ChangeRequestDetail;
  members: readonly Member[];
  deliverableTypes: readonly string[];
  taskTitle: string;
  previewBusy: boolean;
  previewNote: string | null;
  onPreview: () => void;
  onDownload: () => void;
  onThumbPreviewOpenChange: (open: boolean) => void;
  onOpenTask?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const split = splitChangeReason(detail.reason);
  const material = detail.materialReissue;
  const applicantId = detail.appliedBy;
  const applicantName = memberNameOf(members, applicantId) ?? (applicantId === "" ? fieldText(locale, "成员") : applicantId);
  const applicant = members.find((member) => member.id === applicantId);
  const writerId = detail.writerBy ?? detail.appliedBy;
  const writerName = memberNameOf(members, writerId) ?? (writerId === "" ? fieldText(locale, "成员") : writerId);
  const writer = members.find((member) => member.id === writerId);
  const fileTypeText = detail.file === null ? deliverableTypes[0] ?? null : detail.file.docType === null ? deliverableTypes[0] ?? null : detail.file.docType;
  return (
    <dl className="flex flex-col gap-2.5">
      {material === null ? null : (
        <>
          <InfoRow field="material-type" label={fieldText(locale, "变更类型")}>
            <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">{fieldText(locale, "物料变更补发")}</span>
          </InfoRow>
          <InfoRow field="material-email-title" label={fieldText(locale, "邮件标题")}>{material.emailTitle ?? materialReissueDefaultEmailTitle(material.projectCode, material.projectName)}</InfoRow>
          <InfoRow field="material-customer" label={fieldText(locale, "客户名称")}>{material.customerName ?? "—"}</InfoRow>
          <InfoRow field="material-category" label={fieldText(locale, "补发类别")}>{materialReissueReasonText(locale, material)}</InfoRow>
          <InfoRow field="material-department" label={fieldText(locale, "申请部门")}>{materialReissueApplicationDepartmentText(locale, material.applicationDepartment, material.applicationDepartmentOther)}</InfoRow>
          <InfoRow field="material-out-date" label={fieldText(locale, "要求出库时间")}>{material.requiredOutDate.replace(/-/g, "/")}</InfoRow>
          <InfoRow field="material-responsible" label={fieldText(locale, "责任归属部门")}>{materialReissueDepartmentText(locale, material.responsibleDepartment, material.responsibleDepartmentOther)}</InfoRow>
          <InfoRow field="material-approved" label={fieldText(locale, "是否已审批")}>{materialReissueApprovalText(locale, material.approved)}</InfoRow>
          <InfoRow field="material-recipient" label={fieldText(locale, "收货人")}>
            <span className="block">{material.recipient} · {material.phone}</span>
            <span className="mt-0.5 block whitespace-pre-wrap text-zinc-500">{material.address}</span>
          </InfoRow>
          <InfoRow field="material-items" label={fieldText(locale, "补发物料清单")}>
            <span className="flex flex-col gap-1">
              {material.materials.map((line, index) => (
                <span key={String(index)} data-task-change-material-line={String(index + 1)} className="block rounded-md bg-white px-2 py-1">
                  <span className="font-medium text-zinc-700">{String(index + 1)}. {line.materialName}</span>
                  <span className="ml-1 text-zinc-500">{line.specification === "" ? "" : line.specification + " · "}{String(line.quantity)} {line.unit}</span>
                  {line.materialCode === "" ? null : <span className="mt-0.5 block text-[10px] text-zinc-400">{fieldText(locale, "物料编码")}：{line.materialCode}</span>}
                  {line.remark === "" ? null : <span className="mt-0.5 block text-[10px] text-zinc-400">{line.remark}</span>}
                </span>
              ))}
            </span>
          </InfoRow>
          <InfoRow field="material-description" label={fieldText(locale, "补发原因简述")}>{material.description}</InfoRow>
          <InfoRow field="material-freight" label={fieldText(locale, "运费承担")}>{materialReissueFreightText(locale, material.freightBearer)}</InfoRow>
        </>
      )}
      <InfoRow field="time" label={fieldText(locale, "变更时间")}>{slashDate(detail.appliedAt)}</InfoRow>
      <InfoRow field="stage" label={fieldText(locale, "变更阶段")}>
        <span className="inline-block rounded bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 ring-1 ring-zinc-200">{stageLabelOf(locale, detail.stageKey)}</span>
      </InfoRow>
      <InfoRow field="file" label={fieldText(locale, "变更文件")}>
        {fileTypeText === null ? <span className="text-zinc-400">—</span> : <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{fileTypeText}</span>}
      </InfoRow>
      {material === null ? <InfoRow field="content" label={fieldText(locale, "变更内容描述")}>{textOrDash(split.content)}</InfoRow> : null}
      {material === null ? (
        <InfoRow field="before" label={fieldText(locale, "变更前")}>
          <span className="block whitespace-pre-wrap">{textOrDash(detail.beforeSummary)}</span>
          {detail.beforeSummaryFileIds.length === 0 ? null : (
            <PhotoStrip
              strip="task-change-before"
              size="md"
              previewZClass="z-[90]"
              onPreviewOpenChange={onThumbPreviewOpenChange}
              items={detail.beforeSummaryFileIds.map((fileId, index) => ({ fileId, name: t("drawer.change.photo.name", { n: String(index + 1) }), url: null }))}
            />
          )}
        </InfoRow>
      ) : null}
      {material === null ? (
        <InfoRow field="after" label={fieldText(locale, "变更后")}>
          <span className="block whitespace-pre-wrap">{textOrDash(detail.afterSummary)}</span>
          {detail.afterSummaryFileIds.length === 0 ? null : (
            <PhotoStrip
              strip="task-change-after"
              size="md"
              previewZClass="z-[90]"
              onPreviewOpenChange={onThumbPreviewOpenChange}
              items={detail.afterSummaryFileIds.map((fileId, index) => ({ fileId, name: t("drawer.change.photo.name", { n: String(index + 1) }), url: null }))}
            />
          )}
        </InfoRow>
      ) : null}
      {material === null ? <InfoRow field="cause" label={fieldText(locale, "变更原因")}>{textOrDash(split.cause)}</InfoRow> : null}
      <InfoRow field="applicant" label={fieldText(locale, "变更申请人")}>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-1.5 py-0.5 text-[11px] text-zinc-700 ring-1 ring-zinc-200" title={applicantId}>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-400 text-[9px] font-medium text-white">{applicantName.slice(0, 1)}</span>
          {applicantHandleText(applicantName, applicant === undefined ? null : applicant.handle)}
        </span>
      </InfoRow>
      <InfoRow field="writer" label={fieldText(locale, "填写者")}>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-1.5 py-0.5 text-[11px] text-zinc-700 ring-1 ring-zinc-200" title={writerId}>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-400 text-[9px] font-medium text-white">{writerName.slice(0, 1)}</span>
          {applicantHandleText(writerName, writer === undefined ? null : writer.handle)}
        </span>
      </InfoRow>
      <InfoRow field="progress" label={fieldText(locale, "进度")}><span className="text-zinc-400">—</span></InfoRow>
      <InfoRow field="version" label={fieldText(locale, "变更后文件版本")}>
        {detail.file === null || detail.versionSeq === null ? (
          <span className="text-zinc-400">{t("drawer.history.filePending")}</span>
        ) : (
          detail.file.name + "（v" + String(detail.versionSeq) + "）"
        )}
      </InfoRow>
      <InfoRow field="after-file" label={fieldText(locale, "变更后文件")}>
        {detail.file === null || detail.versionId === null ? (
          <span className="text-[11px] leading-5 text-zinc-400">{t("drawer.history.filePending")}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex min-w-0 max-w-[260px] items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1.5">
              <FileTypeIcon name={detail.file.name} className="h-4 w-4 shrink-0" />
              <span className="truncate text-[11px] text-zinc-600" title={detail.file.name}>{detail.file.name}</span>
            </span>
            <button
              type="button"
              data-task-change-file-preview="true"
              title={mobileFilePreviewMustDownload(detail.file.name) ? t("drawer.file.downloadTitle") : t("drawer.file.previewTitle")}
              disabled={previewBusy}
              onClick={onPreview}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] text-zinc-600 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 disabled:cursor-progress disabled:text-zinc-400"
            >
              {previewBusy ? t("cd.openingPreview") : mobileFilePreviewMustDownload(detail.file.name) ? t("drawer.file.download") : t("drawer.file.preview")}
            </button>
            <button
              type="button"
              data-task-change-file-download="true"
              onClick={onDownload}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] text-zinc-600 transition hover:bg-zinc-50"
            >
              {t("drawer.file.download")}
            </button>
          </span>
        )}
        {previewNote === null ? null : <span className="mt-1 block text-[10px] leading-4 text-rose-500">{previewNote}</span>}
      </InfoRow>
      <InfoRow field="links" label={fieldText(locale, "关联")}>
        {onOpenTask === undefined ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 ring-1 ring-zinc-200">
            <LinkIcon />
            {taskTitle}
          </span>
        ) : (
          <button
            type="button"
            data-task-change-open-task="true"
            title={t("cd.openTaskDrawer")}
            onClick={onOpenTask}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700"
          >
            <LinkIcon />
            {taskTitle}
          </button>
        )}
      </InfoRow>
    </dl>
  );
}

function InfoRow({ field, label, children }: { field: string; label: string; children: ReactNode }) {
  return (
    <div data-task-change-field={field} className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2">
      <dt className="pt-px text-[11px] leading-5 text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-[11px] leading-5 text-zinc-700">{children}</dd>
    </div>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
      <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1-1" />
    </svg>
  );
}
