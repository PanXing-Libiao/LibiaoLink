import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api";
import { copyTextToClipboard } from "../clipboard";
import { projectStatusTextOf, textOf, useLocale, useT, type TextKey } from "../i18n";
import { formatDateTime } from "../projectApi";
import {
  confirmProjectSummary,
  fetchLatestProjectSummary,
  generateProjectSummary,
  updateProjectSummaryNarrative,
  type ProjectSummaryGapKind,
  type ProjectSummaryIssue,
  type ProjectSummaryLatestResponse,
  type ProjectSummaryNarrative,
  type ProjectSummaryResolution,
  type ProjectSummarySeverity,
  type ProjectSummaryView,
} from "../projectSummaryApi";
import { lockBodyScroll } from "../scrollLock";
import { useFocusTrap } from "./useFocusTrap";

const SUMMARY_ICON_PATH =
  "M0 458.9568c83.0464-32.3584 164.352-64.3072 248.32-84.3776 57.6512-13.9264 84.7872-43.8272 98.304-103.8336 20.0704-89.3952 49.7664-176.5376 77.1072-270.7456 5.632 15.5648 9.3184 25.2928 12.1856 34.9184 27.7504 96.0512 55.5008 191.6928 82.6368 287.744 13.6192 48.7424 92.9792 53.3504 132.096 66.2528 65.8432 21.1968 131.4816 43.008 205.1072 66.9696-16.6912 6.2464-25.3952 9.728-34.2016 12.8-65.536 21.2992-280.7808 43.3152-303.8208 123.904-26.3168 96.4608-54.6816 192-82.6368 287.744-2.4576 9.3184-6.4512 18.1248-11.6736 31.744-32.3584-111.2064-63.6928-216.8832-93.2864-322.9696-22.2208-76.8-240.128-100.2496-303.5136-120.832L0 458.9568z m738.7136 300.544c22.3232-6.2464 32.1536-18.2272 37.6832-41.0624 9.8304-40.6528 22.6304-80.5888 34.304-120.4224 1.4336-5.12 4.4032-9.216 8.3968-18.1248 11.776 39.0144 25.2928 71.9872 30.5152 106.3936 7.4752 49.9712 32.0512 75.1616 78.848 83.6608 32.5632 6.144 63.5904 20.1728 95.5392 30.6176-22.016 13.1072-43.6224 19.7632-64.8192 27.0336-30.0032 10.1376-67.584 12.3904-87.3472 33.28-19.7632 20.992-21.9136 60.928-31.4368 92.7744L819.6096 1024a1336.5248 1336.5248 0 0 1-45.056-141.0048c-5.12-19.6608-14.6432-29.3888-33.5872-34.9184-43.9296-12.288-87.1424-27.7504-130.2528-42.0864v-5.8368c42.8032-13.5168 84.8896-29.0816 128-40.6528z m22.016-562.8928c16.5888 4.608 23.8592 13.6192 27.9552 30.5152 7.2704 30.3104 16.896 59.904 25.4976 89.6 1.1264 3.6864 3.2768 6.8608 6.2464 13.4144 8.704-29.0816 18.8416-53.4528 22.6304-79.0528 5.632-37.0688 23.9616-55.9104 58.6752-62.1568 24.2688-4.608 47.4112-15.0528 70.9632-22.8352-16.2816-9.728-32.256-14.6432-48.128-20.0704-22.2208-7.4752-50.176-9.216-65.024-24.6784-14.5408-15.6672-16.1792-45.3632-23.2448-68.9152L820.9408 0a967.68 967.68 0 0 0-33.6896 104.7552c-3.7888 14.7456-10.8544 21.9136-24.9856 25.9072-32.5632 9.216-64.6144 20.7872-96.6656 31.3344v4.4032c31.8464 10.1376 63.0784 21.6064 95.1296 30.208z m0 0";

const NARRATIVE_FIELDS: Array<{ key: keyof ProjectSummaryNarrative; label: TextKey }> = [
  { key: "overview", label: "summary.section.overview" },
  { key: "process", label: "summary.section.process" },
  { key: "issues", label: "summary.section.issues" },
  { key: "result", label: "summary.section.result" },
  { key: "handover", label: "summary.section.handover" },
  { key: "risks", label: "summary.section.risks" },
];

const GAP_KIND_KEYS: Record<ProjectSummaryGapKind, TextKey> = {
  unresolved_issue: "summary.gap.unresolved_issue",
  issue_evidence: "summary.gap.issue_evidence",
  overdue_task: "summary.gap.overdue_task",
  unassigned_task: "summary.gap.unassigned_task",
  missing_deliverable: "summary.gap.missing_deliverable",
  status_mismatch: "summary.gap.status_mismatch",
  stale_reports: "summary.gap.stale_reports",
  missing_baseline: "summary.gap.missing_baseline",
};

const SEVERITY_KEYS: Record<ProjectSummarySeverity, TextKey> = {
  high: "summary.severity.high",
  medium: "summary.severity.medium",
  low: "summary.severity.low",
};

const RESOLUTION_KEYS: Record<ProjectSummaryResolution, TextKey> = {
  resolved: "summary.issues.resolved",
  unresolved: "summary.issues.unresolved",
  needs_evidence: "summary.issues.needsEvidence",
};

const ISSUE_STATE_KEYS = {
  open: "summary.issueState.open",
  in_progress: "summary.issueState.in_progress",
  done: "summary.issueState.done",
} as const satisfies Record<ProjectSummaryIssue["state"], TextKey>;

const STAGE_STATUS_KEYS = {
  pending: "summary.stage.pending",
  active: "summary.stage.active",
  done: "summary.stage.done",
} as const;

function percentOf(done: number, total: number): number {
  return total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function errorTextOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message !== "") return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return fallback;
}

function resolutionClass(resolution: ProjectSummaryResolution): string {
  if (resolution === "resolved") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (resolution === "needs_evidence") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-rose-200 bg-rose-50 text-rose-700";
}

function severityClass(severity: ProjectSummarySeverity): string {
  if (severity === "high") return "border-rose-200 bg-rose-50 text-rose-700";
  if (severity === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-sky-200 bg-sky-50 text-sky-700";
}

function Metric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }): ReactNode {
  return (
    <div className={"rounded-xl border px-3 py-3 " + (danger ? "border-rose-100 bg-rose-50/60" : "border-zinc-200 bg-white")}>
      <p className="text-[11px] leading-4 text-zinc-500">{label}</p>
      <p className={"mt-1 font-mono text-xl font-semibold tracking-tight " + (danger ? "text-rose-700" : "text-zinc-800")}>{value}</p>
    </div>
  );
}

function SummaryStarIcon({ className }: { className: string }): ReactNode {
  return (
    <svg viewBox="0 0 1024 1024" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      <path d={SUMMARY_ICON_PATH} />
    </svg>
  );
}

function copyTextOf(item: ProjectSummaryView, t: (key: TextKey, params?: Record<string, string | number>) => string): string {
  const { facts, narrative } = item;
  const lines: string[] = [
    "【" + t("summary.title") + "】" + facts.project.code + " " + facts.project.name,
    t("summary.dataCutoff", { time: formatDateTime(item.dataCutoff) }),
    t("summary.generatedAt", { time: formatDateTime(item.generatedAt) }),
    t("summary.generatedBy", { name: item.generatedByName ?? "—" }),
    "",
    "一、" + t("summary.section.overview"),
    narrative.overview,
    "",
    "二、" + t("summary.section.process"),
    narrative.process,
    "",
    "三、" + t("summary.section.issues"),
    narrative.issues,
    "",
    "四、" + t("summary.section.result"),
    narrative.result,
    "",
    "五、" + t("summary.section.handover"),
    narrative.handover,
    "",
    "六、" + t("summary.section.risks"),
    narrative.risks,
    "",
    "【" + t("summary.statsTitle") + "】",
    t("summary.metric.tasks") + "：" + String(facts.counts.tasksDone) + " / " + String(facts.counts.tasksTotal),
    t("summary.metric.overdue") + "：" + String(facts.counts.tasksOverdue),
    t("summary.metric.unassigned") + "：" + String(facts.counts.tasksUnassigned),
    t("summary.metric.issues") + "：" + String(facts.counts.issuesResolved) + " / " + String(facts.counts.issuesTotal),
    t("summary.metric.unresolved") + "：" + String(facts.counts.issuesUnresolved),
    t("summary.metric.evidence") + "：" + String(facts.counts.issuesClosedWithoutEvidence),
    t("summary.metric.deliverables") + "：" + String(facts.counts.deliverablesMissing),
  ];
  if (facts.gaps.length > 0) {
    lines.push("", "【" + t("summary.gapsTitle") + "】");
    for (const gap of facts.gaps) {
      lines.push(
        "[" + t(SEVERITY_KEYS[gap.severity]) + "] " + t(GAP_KIND_KEYS[gap.kind]) + "：" + gap.title,
        t("summary.gap.owner", { owner: gap.owner }),
        t("summary.gap.action", { action: gap.action }),
      );
    }
  }
  if (facts.handover.length > 0) {
    lines.push("", "【" + t("summary.handoverTitle") + "】");
    for (const group of facts.handover) {
      lines.push(group.owner + "：" + group.items.join("；"));
    }
  }
  return lines.join("\n");
}

export function ProjectSummaryModal({ project, onClose }: { project: { id: string }; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [latest, setLatest] = useState<ProjectSummaryLatestResponse | null>(null);
  const [narrative, setNarrative] = useState<ProjectSummaryNarrative | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [busy, setBusy] = useState<"generate" | "save" | "confirm" | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const item = latest?.item ?? null;
  const canEdit = latest?.canEdit === true;
  const editable = item !== null && item.status === "draft" && canEdit;
  const dirty = item !== null && narrative !== null && NARRATIVE_FIELDS.some((field) => narrative[field.key] !== item.narrative[field.key]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setLatest(null);
    setNarrative(null);
    fetchLatestProjectSummary(project.id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setLatest(data);
        setNarrative(data.item?.narrative ?? null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorTextOf(error, textOf(locale, "summary.actionFailed", { message: "" })));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [project.id, retryTick, locale]);

  useEffect(() => lockBodyScroll(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (closeArmed) {
        setCloseArmed(false);
      } else if (confirmArmed) {
        setConfirmArmed(false);
      } else if (dirty) {
        setCloseArmed(true);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closeArmed, confirmArmed, dirty, onClose]);

  function requestClose(): void {
    if (dirty) {
      setCloseArmed(true);
      setConfirmArmed(false);
      return;
    }
    onClose();
  }

  function applyItem(view: ProjectSummaryView): void {
    setLatest({ item: view, canEdit: view.canEdit });
    setNarrative(view.narrative);
    setConfirmArmed(false);
    setCloseArmed(false);
  }

  async function handleGenerate(): Promise<void> {
    if (busy !== null) return;
    setBusy("generate");
    setActionError(null);
    setNotice(null);
    try {
      const generated = await generateProjectSummary(project.id);
      applyItem(generated);
      setNotice(t("summary.generatedDone"));
    } catch (error: unknown) {
      setActionError(t("summary.actionFailed", { message: errorTextOf(error, t("summary.generate")) }));
    } finally {
      setBusy(null);
    }
  }

  function narrativeIsComplete(): boolean {
    return narrative !== null && NARRATIVE_FIELDS.every((field) => narrative[field.key].trim() !== "");
  }

  async function handleSave(): Promise<ProjectSummaryView | null> {
    if (item === null || narrative === null || !editable || busy !== null) return null;
    if (!narrativeIsComplete()) {
      setActionError(t("summary.required"));
      return null;
    }
    setBusy("save");
    setActionError(null);
    setNotice(null);
    try {
      const saved = await updateProjectSummaryNarrative(project.id, item.id, item.version, narrative);
      applyItem(saved);
      setNotice(t("summary.saved"));
      return saved;
    } catch (error: unknown) {
      setActionError(t("summary.actionFailed", { message: errorTextOf(error, t("summary.save")) }));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (item === null || narrative === null || !editable || busy !== null) return;
    if (!narrativeIsComplete()) {
      setActionError(t("summary.required"));
      return;
    }
    setBusy("confirm");
    setActionError(null);
    setNotice(null);
    try {
      let target = item;
      if (dirty) {
        target = await updateProjectSummaryNarrative(project.id, item.id, item.version, narrative);
        applyItem(target);
      }
      const confirmed = await confirmProjectSummary(project.id, target.id, target.version);
      applyItem(confirmed);
      setNotice(t("summary.confirmedDone"));
    } catch (error: unknown) {
      setActionError(t("summary.actionFailed", { message: errorTextOf(error, t("summary.confirm")) }));
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(): Promise<void> {
    if (item === null) return;
    const copied = await copyTextToClipboard(copyTextOf(item, t));
    setActionError(copied ? null : t("summary.copyFailed"));
    setNotice(copied ? t("summary.copied") : null);
  }

  const metrics = item === null ? [] : [
    { label: t("summary.metric.tasks"), value: String(item.facts.counts.tasksDone) + " / " + String(item.facts.counts.tasksTotal), danger: false },
    { label: t("summary.metric.overdue"), value: String(item.facts.counts.tasksOverdue), danger: item.facts.counts.tasksOverdue > 0 },
    { label: t("summary.metric.unassigned"), value: String(item.facts.counts.tasksUnassigned), danger: item.facts.counts.tasksUnassigned > 0 },
    { label: t("summary.metric.issues"), value: String(item.facts.counts.issuesResolved) + " / " + String(item.facts.counts.issuesTotal), danger: false },
    { label: t("summary.metric.unresolved"), value: String(item.facts.counts.issuesUnresolved), danger: item.facts.counts.issuesUnresolved > 0 },
    { label: t("summary.metric.evidence"), value: String(item.facts.counts.issuesClosedWithoutEvidence), danger: item.facts.counts.issuesClosedWithoutEvidence > 0 },
    { label: t("summary.metric.deliverables"), value: String(item.facts.counts.deliverablesMissing), danger: item.facts.counts.deliverablesMissing > 0 },
    { label: t("summary.metric.reports"), value: String(item.facts.counts.reportsTotal), danger: false },
    { label: t("summary.metric.files"), value: String(item.facts.counts.filesTotal), danger: false },
    { label: t("summary.metric.changes"), value: String(item.facts.counts.changesTotal), danger: false },
    { label: t("summary.metric.stages"), value: String(item.facts.counts.stagesDone) + " / " + String(item.facts.counts.stagesTotal), danger: false },
  ];

  return createPortal(
    <div
      data-project-summary-overlay="true"
      className="fixed inset-0 z-[85] flex items-center justify-center bg-zinc-950/45 p-3 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("summary.title")}
        data-focus-container="true"
        data-project-summary-dialog="true"
        tabIndex={-1}
        className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/70 bg-[#f6f6f3] shadow-2xl outline-none"
      >
        <div data-project-summary-toolbar="true" className="flex shrink-0 items-start gap-3 border-b border-zinc-200 bg-white px-5 py-4 sm:px-6">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
            <SummaryStarIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-900">{t("summary.title")}</h2>
            <p className="mt-1 text-sm text-zinc-500">{t("summary.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t("summary.close")}
            title={t("summary.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div data-project-summary-scroll="true" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {loading ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-zinc-500">
              <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 animate-spin text-amber-500" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-sm">{t("summary.loading")}</p>
            </div>
          ) : loadError !== null ? (
            <div className="mx-auto flex min-h-[360px] max-w-xl flex-col items-center justify-center text-center">
              <p className="text-sm text-rose-700">{t("summary.loadFailed", { message: loadError })}</p>
              <button
                type="button"
                onClick={() => {
                  setRetryTick((value) => value + 1);
                }}
                className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700"
              >
                {t("summary.retry")}
              </button>
            </div>
          ) : latest === null ? null : item === null ? (
            <div className="mx-auto flex min-h-[420px] max-w-2xl flex-col items-center justify-center rounded-2xl border border-zinc-200 bg-white px-6 py-10 text-center shadow-xs">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
                <SummaryStarIcon className="h-8 w-8" />
              </span>
              <h3 className="mt-5 text-xl font-semibold text-zinc-900">{t("summary.emptyTitle")}</h3>
              <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-500">{t("summary.emptyBody")}</p>
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    void handleGenerate();
                  }}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60"
                >
                  {busy === "generate" ? (
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  ) : null}
                  {busy === "generate" ? t("summary.generating") : t("summary.generate")}
                </button>
              ) : (
                <p className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-500">{t("summary.emptyReadOnly")}</p>
              )}
            </div>
          ) : (
            <div data-project-summary-print="true" className="space-y-5">
              <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xs">
                <div className="h-1.5 bg-amber-400" />
                <div className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs tracking-wide text-zinc-400">{item.facts.project.code}</p>
                      <h3 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">{item.facts.project.name}</h3>
                      <p className="mt-2 text-sm text-zinc-500">
                        {item.facts.project.customer ?? "—"} · {item.facts.project.region} · {item.facts.project.projectType}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                      <span className={"rounded-full border px-2.5 py-1 font-medium " + (item.status === "confirmed" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>
                        {item.status === "confirmed" ? t("summary.confirmed") : t("summary.draft")}
                      </span>
                      <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-zinc-600">
                        {projectStatusTextOf(locale, item.facts.project.status)}
                      </span>
                      <span className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-zinc-500">
                        {t("summary.engine", { engine: item.engine === "rule-template" ? t("summary.engineTemplate") : item.engine })}
                      </span>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-2 text-xs text-zinc-500 sm:grid-cols-2 lg:grid-cols-3">
                    <p>{t("summary.dataCutoff", { time: formatDateTime(item.dataCutoff) })}</p>
                    <p>{t("summary.generatedAt", { time: formatDateTime(item.generatedAt) })}</p>
                    <p>{t("summary.generatedBy", { name: item.generatedByName ?? "—" })}</p>
                    {item.confirmedAt === null ? null : <p>{t("summary.confirmedAt", { time: formatDateTime(item.confirmedAt) })}</p>}
                    {item.confirmedAt === null ? null : <p>{t("summary.confirmedBy", { name: item.confirmedByName ?? "—" })}</p>}
                    <p>{t("summary.evidence", item.facts.evidence)}</p>
                  </div>
                  <p className="mt-3 text-sm text-zinc-500">
                    {t("card.manager")}{item.facts.project.managerNames.join("、")}
                  </p>
                  {item.fallbackReason === null ? null : (
                    <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
                      {t("summary.fallback", { reason: item.fallbackReason })}
                    </p>
                  )}
                </div>
              </section>

              <section>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <h3 className="text-base font-semibold text-zinc-900">{t("summary.statsTitle")}</h3>
                  {dirty ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-800">{t("summary.unsaved")}</span> : null}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {metrics.map((metric) => <Metric key={metric.label} label={metric.label} value={metric.value} danger={metric.danger} />)}
                </div>
              </section>

              <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-zinc-900">{t("summary.narrativeTitle")}</h3>
                    <p className="mt-1 text-xs text-zinc-500">{editable ? t("summary.narrative.editable") : t("summary.narrative.readOnly")}</p>
                  </div>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {NARRATIVE_FIELDS.map((field) => (
                    <div key={field.key} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3.5">
                      <p className="text-xs font-semibold text-zinc-700">{t(field.label)}</p>
                      {editable && narrative !== null ? (
                        <>
                          <textarea
                            value={narrative[field.key]}
                            aria-label={t(field.label)}
                            maxLength={4000}
                            rows={6}
                            onChange={(event) => {
                              const value = event.target.value;
                              setNarrative((current) => current === null ? null : { ...current, [field.key]: value });
                              setConfirmArmed(false);
                              setNotice(null);
                            }}
                            className="mt-2 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-6 text-zinc-700 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-200 print:hidden"
                          />
                          <p className="mt-2 hidden whitespace-pre-wrap text-sm leading-6 text-zinc-600 print:block">{narrative[field.key]}</p>
                        </>
                      ) : (
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-600">{item.narrative[field.key]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <div className="grid gap-5 lg:grid-cols-2">
                <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                  <h3 className="text-base font-semibold text-zinc-900">{t("summary.stagesTitle")}</h3>
                  <div className="mt-4 space-y-3">
                    {item.facts.stages.map((stage) => (
                      <div key={stage.stageKey + String(stage.seq)} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-zinc-800">{stage.name}</p>
                          <span className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] text-zinc-500">{t(STAGE_STATUS_KEYS[stage.status])}</span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">
                          {t("summary.stage.progress", { nodes: String(stage.nodeDone) + " / " + String(stage.nodeTotal), tasks: String(stage.taskDone) + " / " + String(stage.taskTotal) })}
                        </p>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-200">
                          <div className="h-full rounded-full bg-amber-400" style={{ width: String(percentOf(stage.nodeDone, stage.nodeTotal)) + "%" }} />
                        </div>
                        <p className="mt-2 text-[11px] text-zinc-400">
                          {t("summary.stage.dates", {
                            plan: (stage.plannedStart ?? "—") + " ~ " + (stage.plannedEnd ?? "—"),
                            actual: (stage.actualStart ?? "—") + " ~ " + (stage.actualEnd ?? t("summary.noPlan")),
                          })}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                  <h3 className="text-base font-semibold text-zinc-900">{t("summary.timelineTitle")}</h3>
                  {item.facts.timeline.length === 0 ? (
                    <p className="mt-4 text-sm text-zinc-400">{t("summary.timeline.empty")}</p>
                  ) : (
                    <ol className="mt-4 max-h-[430px] space-y-3 overflow-y-auto pr-1">
                      {item.facts.timeline.map((event, index) => (
                        <li key={event.date + "-" + String(index)} className="relative border-l-2 border-amber-200 pl-3">
                          <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
                          <p className="font-mono text-[10px] text-zinc-400">{formatDateTime(event.date)}</p>
                          <p className="mt-0.5 text-xs font-medium text-zinc-700">{event.title}</p>
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{event.detail}</p>
                          {event.actorNames.length === 0 ? null : <p className="mt-1 text-[11px] text-zinc-400">{event.actorNames.join("、")}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>

              <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                <h3 className="text-base font-semibold text-zinc-900">{t("summary.issuesTitle")}</h3>
                {item.facts.issues.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-400">{t("summary.issues.empty")}</p>
                ) : (
                  <div className="mt-4 max-h-[460px] overflow-auto rounded-xl border border-zinc-200">
                    <table className="min-w-full divide-y divide-zinc-200 text-left text-xs">
                      <thead className="sticky top-0 bg-zinc-50 text-[11px] text-zinc-500">
                        <tr>
                          <th className="px-3 py-2 font-medium">{t("summary.issues.title")}</th>
                          <th className="px-3 py-2 font-medium">{t("summary.issues.state")}</th>
                          <th className="px-3 py-2 font-medium">{t("summary.issues.resolution")}</th>
                          <th className="px-3 py-2 font-medium">{t("summary.issues.owner")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 bg-white">
                        {item.facts.issues.map((issue) => (
                          <tr key={issue.id} className="align-top">
                            <td className="max-w-[420px] px-3 py-3">
                              <p className="font-medium leading-5 text-zinc-700">{issue.title}</p>
                              <p className="mt-1 text-[11px] text-zinc-400">{issue.categories.join("、")} · {issue.raisedAt}</p>
                              {issue.solution === null ? null : <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-zinc-500">{issue.solution}</p>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-zinc-500">{t(ISSUE_STATE_KEYS[issue.state])}</td>
                            <td className="px-3 py-3">
                              <span className={"inline-flex rounded-full border px-2 py-0.5 font-medium " + resolutionClass(issue.resolution)}>{t(RESOLUTION_KEYS[issue.resolution])}</span>
                            </td>
                            <td className="px-3 py-3 text-zinc-600">{issue.followUpOwner}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                <h3 className="text-base font-semibold text-zinc-900">{t("summary.gapsTitle")}</h3>
                {item.facts.gaps.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-400">{t("summary.gaps.empty")}</p>
                ) : (
                  <div className="mt-4 max-h-[520px] space-y-4 overflow-y-auto pr-1">
                    {(["high", "medium", "low"] as const).map((severity) => {
                      const rows = item.facts.gaps.filter((gap) => gap.severity === severity);
                      if (rows.length === 0) return null;
                      return (
                        <div key={severity}>
                          <div className="mb-2 flex items-center gap-2">
                            <span className={"rounded-full border px-2 py-0.5 text-[11px] font-medium " + severityClass(severity)}>{t(SEVERITY_KEYS[severity])}</span>
                            <span className="text-xs text-zinc-400">{String(rows.length)}</span>
                          </div>
                          <div className="space-y-2">
                            {rows.map((gap) => (
                              <article key={gap.id} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[11px] font-medium text-zinc-500">{t(GAP_KIND_KEYS[gap.kind])}</span>
                                  <h4 className="text-sm font-semibold text-zinc-800">{gap.title}</h4>
                                </div>
                                <p className="mt-1.5 text-xs leading-5 text-zinc-500">{gap.detail}</p>
                                <p className="mt-2 text-xs text-zinc-600">{t("summary.gap.owner", { owner: gap.owner })}</p>
                                <p className="mt-1 text-xs leading-5 text-zinc-500">{t("summary.gap.action", { action: gap.action })}</p>
                              </article>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                <h3 className="text-base font-semibold text-zinc-900">{t("summary.handoverTitle")}</h3>
                {item.facts.handover.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-400">{t("summary.handover.empty")}</p>
                ) : (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {item.facts.handover.map((group) => (
                      <article key={group.owner} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-sm font-semibold text-zinc-800">{group.owner}</h4>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-zinc-500">{t("summary.handover.items", { n: group.items.length })}</span>
                        </div>
                        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-zinc-500">
                          {group.items.map((entry, index) => <li key={group.owner + "-" + String(index)}>{entry}</li>)}
                        </ul>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
                <h3 className="text-base font-semibold text-zinc-900">{t("summary.dataQualityTitle")}</h3>
                {item.facts.dataQuality.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-400">{t("summary.dataQuality.empty")}</p>
                ) : (
                  <ul className="mt-4 space-y-2">
                    {item.facts.dataQuality.map((entry, index) => (
                      <li key={String(index)} className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3 py-2.5 text-xs leading-5 text-zinc-600">
                        <span className={"mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium " + severityClass(entry.severity)}>{t(SEVERITY_KEYS[entry.severity])}</span>
                        <span>{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">{t("summary.aiNotice")}</p>
            </div>
          )}
        </div>

        {actionError === null ? null : (
          <div data-project-summary-toolbar="true" className="shrink-0 border-t border-rose-200 bg-rose-50 px-5 py-2.5 text-xs text-rose-700">{actionError}</div>
        )}
        {notice === null ? null : (
          <div data-project-summary-toolbar="true" className="shrink-0 border-t border-emerald-200 bg-emerald-50 px-5 py-2.5 text-xs text-emerald-700">{notice}</div>
        )}

        {closeArmed ? (
          <div data-project-summary-toolbar="true" className="shrink-0 border-t border-amber-200 bg-amber-50 px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-amber-900">{t("summary.closeDirtyTitle")}</p>
                <p className="mt-0.5 text-xs text-amber-700">{t("summary.closeDirtyBody")}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCloseArmed(false)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100">{t("summary.cancel")}</button>
                <button type="button" onClick={onClose} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500">{t("summary.discardClose")}</button>
              </div>
            </div>
          </div>
        ) : confirmArmed && editable ? (
          <div data-project-summary-toolbar="true" className="shrink-0 border-t border-amber-200 bg-amber-50 px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-amber-900">{t("summary.confirm")}</p>
                <p className="mt-0.5 text-xs text-amber-700">{t("summary.confirmBody")}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirmArmed(false)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100">{t("summary.confirmCancel")}</button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => { void handleConfirm(); }}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {busy === "confirm" ? t("summary.confirming") : t("summary.confirm")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {item === null ? (
          <div data-project-summary-toolbar="true" className="flex shrink-0 items-center justify-end border-t border-zinc-200 bg-white px-5 py-3">
            <button type="button" onClick={requestClose} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">{t("summary.close")}</button>
          </div>
        ) : (
          <div data-project-summary-toolbar="true" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-zinc-200 bg-white px-5 py-3">
            <p className="text-xs text-zinc-400">{dirty ? t("summary.unsaved") : item.status === "confirmed" ? t("summary.narrative.readOnly") : t("summary.narrative.editable")}</p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" onClick={() => { void handleCopy(); }} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50">{t("summary.copy")}</button>
              <button type="button" onClick={() => window.print()} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50">{t("summary.print")}</button>
              {canEdit ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => { void handleGenerate(); }}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-60"
                >
                  {busy === "generate" ? t("summary.regenerating") : t("summary.regenerate")}
                </button>
              ) : null}
              {editable ? (
                <>
                  <button
                    type="button"
                    disabled={busy !== null || !dirty}
                    onClick={() => { void handleSave(); }}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === "save" ? t("summary.saving") : t("summary.save")}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => { setCloseArmed(false); setConfirmArmed(true); }}
                    className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60"
                  >
                    {t("summary.confirm")}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
