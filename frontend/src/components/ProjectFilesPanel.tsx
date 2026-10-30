import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { PROJECT_STAGES } from "../data/projects";
import { TEMP_TASK_STAGE, type ProjectTask } from "../data/tasks";
import {
  ensurePreviewOutcome,
  fetchChangeRequest,
  fetchDownloadUrl,
  fetchFileVersions,
  fetchProjectChanges,
  fetchProjectFileLibrary,
  previewKindOf,
  recordPreviewView,
  triggerDownload,
  type ApiChangeRequest,
  type FileLibraryItem,
  type FilePreviewKind,
  type PreviewViewerConfig,
} from "../fileApi";
import { formatDateTime } from "../projectApi";
import { stageText, statusText, textOf, useLocale, useT } from "../i18n";
import { mobileFilePreviewMustDownload } from "../mobilePreviewPolicy";
import { useLiveRefresh } from "../useLiveRefresh";
import { FilePreviewOverlay } from "./FilePreviewOverlay";
import { FileTypeIcon } from "./FileTypeIcon";
import { Loader } from "./Loader";
import { SearchInput } from "./SearchInput";
import { SearchSelect } from "./SearchSelect";
import { Toast } from "./Toast";

/**
 * 项目详情「项目文件」标签（2026-10-29）。
 *
 * 业务口径：项目文件从原全站「文件库 / 系统现有文件」移入项目详情，替代全站文件浏览入口；
 * 本标签只展示「各阶段任务文件」与「变更记录对应的文件」，日报现场附图 / 问题附图不进入。
 *
 * 数据面：
 * - 阶段文件 = files.taskId 非空（任务文件；含定档 / 已归档任务文件）；
 * - 变更文件 = GET /projects/{id}/change-requests 中 fileId 命中的文件（不以文件状态猜关联，
 *   避免把恰好处于 changed 状态的日报 / 问题附图带进来）；
 * - 两端按文件 id 去重求并集；每个变更文件取最新一次变更，拆成「变更前 / 变更后」两行，
 *   更早的变更仍在任务抽屉「变更记录」中查看。项目回收站文件不在列表内。
 *
 * 交互：关键字 + 阶段 + 文件状态筛选（本地内存过滤，单项目一次取满）、50 行分页（变更前后同页）、
 * 整行点击预览、操作列下载原文件。预览 / 审计 / 下载均使用该行对应 versionId；阶段来自任务；
 * 无任务的历史任务文件显示「未关联阶段」，仅变更文件显示「变更文件」。
 */
const PAGE_LIMIT = 50;
const CURRENT_FILE_STATUSES = ["draft", "final", "changed", "archived"] as const;
const FILE_STATUS_FILTERS = ["draft", "final", "before", "after", "archived"] as const;
const CHANGED_STAGE = "__changed";
const UNKNOWN_STAGE = "__unknown";

const STATUS_LABELS: Record<string, string> = {
  draft: "未定档",
  final: "已定档",
  changed: "变更后",
  archived: "已归档",
};

const STATUS_CLASS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  final: "bg-amber-100 text-amber-800",
  changed: "bg-blue-50 text-blue-700",
  archived: "bg-zinc-100 text-zinc-500",
};

const CHANGE_SIDE_CLASS: Record<"before" | "after", string> = {
  before: "bg-zinc-100 text-zinc-600",
  after: "bg-blue-50 text-blue-700",
};

type ProjectFileRow = {
  /** 同一文件可拆成 before / after 两行，键必须唯一。 */
  key: string;
  file: FileLibraryItem;
  /** 该文件被至少一条变更记录引用（与 taskId 可同时成立）。 */
  changed: boolean;
  /** 本行展示的文件名（变更前可能使用更名前名称）。 */
  name: string;
  /** 本项目文件行对应的版本；空 = 历史版本链不可用，禁止误回落到当前版本。 */
  versionId: string | null;
  versionSeq: number | null;
  uploadedAt: string;
  changeSide: "before" | "after" | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: ProjectFileRow[] };

type PreviewState = {
  pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
  name: string;
  kind: FilePreviewKind;
  fileId: string;
  versionId: string | null;
  rowKey: string;
  nonce: number;
};

function versionIdOfRow(row: ProjectFileRow): string | undefined {
  return row.changeSide === null ? undefined : row.versionId ?? undefined;
}

function rowHasVersion(row: ProjectFileRow): boolean {
  return row.changeSide === null || row.versionId !== null;
}

type Notice = { kind: "ok" | "error"; text: string };

function changeTimestampOf(change: ApiChangeRequest): number {
  const applied = Date.parse(change.appliedAt);
  if (!Number.isNaN(applied)) {
    return applied;
  }
  const created = Date.parse(change.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

function isNewerChange(candidate: ApiChangeRequest, current: ApiChangeRequest): boolean {
  const candidateSeq = candidate.versionSeq ?? -1;
  const currentSeq = current.versionSeq ?? -1;
  if (candidateSeq !== currentSeq) {
    return candidateSeq > currentSeq;
  }
  return changeTimestampOf(candidate) > changeTimestampOf(current);
}

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function loadProjectFileRows(projectId: string): Promise<ProjectFileRow[]> {
  const [files, changes] = await Promise.all([
    fetchProjectFileLibrary(projectId, { statuses: [...CURRENT_FILE_STATUSES] }),
    fetchProjectChanges(projectId),
  ]);
  const latestChangeByFileId = new Map<string, ApiChangeRequest>();
  for (const change of changes) {
    if (change.fileId === null) {
      continue;
    }
    const current = latestChangeByFileId.get(change.fileId);
    if (current === undefined || isNewerChange(change, current)) {
      latestChangeByFileId.set(change.fileId, change);
    }
  }

  const visibleFiles = files.filter((file) => file.taskId !== null || latestChangeByFileId.has(file.id));
  const rowsByFileId = new Map<string, ProjectFileRow[]>();
  await runWithConcurrency(visibleFiles, 6, async (file) => {
    const latestChange = latestChangeByFileId.get(file.id);
    if (latestChange === undefined) {
      rowsByFileId.set(file.id, [
        {
          key: file.id + ":plain",
          file,
          changed: false,
          name: file.name,
          versionId: null,
          versionSeq: null,
          uploadedAt: file.createdAt,
          changeSide: null,
        },
      ]);
      return;
    }

    const [detail, versions] = await Promise.all([
      fetchChangeRequest(latestChange.id).catch(() => null),
      fetchFileVersions(file.id).catch(() => null),
    ]);
    const afterSeq = detail?.versionSeq ?? latestChange.versionSeq ?? (file.version > 0 ? file.version : null);
    const afterVersion =
      versions === null || afterSeq === null
        ? null
        : versions.find((item) => item.seq === afterSeq) ?? null;
    const beforeVersion =
      versions === null || afterSeq === null
        ? null
        : versions.find((item) => item.seq === afterSeq - 1) ?? null;
    const afterVersionId = detail?.versionId ?? latestChange.versionId ?? afterVersion?.id ?? null;
    const afterName = detail?.file?.name ?? file.name;
    const beforeName = detail?.filePreviousName ?? afterName;
    const afterUploadedAt = detail?.version?.uploadedAt ?? afterVersion?.uploadedAt ?? file.updatedAt;
    rowsByFileId.set(file.id, [
      {
        key: file.id + ":before",
        file,
        changed: true,
        name: beforeName,
        versionId: beforeVersion?.id ?? null,
        versionSeq: beforeVersion?.seq ?? null,
        uploadedAt: beforeVersion?.uploadedAt ?? "",
        changeSide: "before",
      },
      {
        key: file.id + ":after",
        file,
        changed: true,
        name: afterName,
        versionId: afterVersionId,
        versionSeq: afterSeq,
        uploadedAt: afterUploadedAt,
        changeSide: "after",
      },
    ]);
  });
  return visibleFiles.flatMap((file) => rowsByFileId.get(file.id) ?? []);
}

export function ProjectFilesPanel({ projectId, tasks }: { projectId: string; tasks: readonly ProjectTask[] }) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    loadProjectFileRows(projectId)
      .then((rows) => {
        if (alive) {
          setState({ kind: "ready", rows });
        }
      })
      .catch((error: unknown) => {
        if (!alive) {
          return;
        }
        const message =
          error instanceof ApiError && error.status === 403
            ? textOf(locale, "pd.files.loadForbidden")
            : error instanceof Error && error.message !== ""
              ? error.message
              : textOf(locale, "pd.files.loadFailed");
        setState({ kind: "error", message });
      });
    return () => {
      alive = false;
    };
  }, [projectId, reloadTick, locale]);

  useLiveRefresh(
    ["files", "tasks"],
    async () => {
      const rows = await loadProjectFileRows(projectId);
      return () => {
        setState((previous) =>
          previous.kind === "ready"
            ? { kind: "ready", rows }
            : previous,
        );
      };
    },
    projectId + ":" + String(reloadTick),
    state.kind === "ready",
    { readOnly: true },
  );

  useEffect(() => {
    setPage(1);
  }, [keyword, stageFilter, statusFilter, projectId]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task] as const)), [tasks]);
  const rows = state.kind === "ready" ? state.rows : [];

  const stageKeyOf = (row: ProjectFileRow): string => {
    if (row.file.taskId === null) {
      return row.changed ? CHANGED_STAGE : UNKNOWN_STAGE;
    }
    const task = taskById.get(row.file.taskId);
    if (task === undefined) {
      return UNKNOWN_STAGE;
    }
    return task.stage === "" ? TEMP_TASK_STAGE : task.stage;
  };

  const stageLabelOf = (key: string): string => {
    if (key === CHANGED_STAGE) {
      return t("pd.files.stage.changed");
    }
    if (key === UNKNOWN_STAGE) {
      return t("pd.files.stage.unknown");
    }
    return stageText(locale, key);
  };

  const stageOrder = useMemo(() => {
    const order: string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");
    order.push(TEMP_TASK_STAGE, CHANGED_STAGE, UNKNOWN_STAGE);
    return order;
  }, []);

  const statusValueOf = (row: ProjectFileRow): string =>
    row.changeSide ?? (row.file.status === "changed" ? "after" : row.file.status);
  const statusLabelOf = (status: string): string => {
    if (status === "before") return t("pd.files.status.before");
    if (status === "after") return t("pd.files.status.after");
    return statusText(locale, STATUS_LABELS[status] ?? status);
  };
  const statusOptions = [
    { value: "", label: t("lib.filter.status.placeholder") },
    ...FILE_STATUS_FILTERS.map((status) => ({ value: status, label: statusLabelOf(status) })),
  ];

  const presentStages = new Set(rows.map(stageKeyOf));
  const stageOptions = [
    { value: "", label: t("pd.files.filter.stage.all") },
    ...stageOrder.filter((stage) => presentStages.has(stage)).map((stage) => ({ value: stage, label: stageLabelOf(stage) })),
  ];

  const rowGroups = new Map<string, ProjectFileRow[]>();
  for (const row of rows) {
    const group = rowGroups.get(row.file.id);
    if (group === undefined) {
      rowGroups.set(row.file.id, [row]);
    } else {
      group.push(row);
    }
  }

  const normalizedKeyword = keyword.trim().toLocaleLowerCase(locale);
  const keywordMatchedFileIds = new Set<string>();
  if (normalizedKeyword !== "") {
    for (const [fileId, group] of rowGroups) {
      const taskTitle = taskById.get(group[0]?.file.taskId ?? "")?.title ?? "";
      if (
        group.some((row) => row.name.toLocaleLowerCase(locale).includes(normalizedKeyword)) ||
        taskTitle.toLocaleLowerCase(locale).includes(normalizedKeyword)
      ) {
        keywordMatchedFileIds.add(fileId);
      }
    }
  }

  const filteredRows = rows.filter((row) => {
    if (stageFilter !== "" && stageKeyOf(row) !== stageFilter) {
      return false;
    }
    if (statusFilter !== "" && statusValueOf(row) !== statusFilter) {
      return false;
    }
    return normalizedKeyword === "" || keywordMatchedFileIds.has(row.file.id);
  });

  const filteredGroups: ProjectFileRow[][] = [];
  for (const row of filteredRows) {
    const group = filteredGroups[filteredGroups.length - 1];
    if (group !== undefined && group[0]?.file.id === row.file.id) {
      group.push(row);
    } else {
      filteredGroups.push([row]);
    }
  }

  const pages: ProjectFileRow[][] = [];
  for (const group of filteredGroups) {
    const current = pages[pages.length - 1];
    if (current === undefined || current.length + group.length > PAGE_LIMIT) {
      pages.push([...group]);
    } else {
      current.push(...group);
    }
  }

  const total = filteredRows.length;
  const totalPages = Math.max(1, pages.length);
  const currentPage = Math.min(page, totalPages);
  const pageRows = pages[currentPage - 1] ?? [];
  const stageFileCount = new Set(rows.filter((row) => row.file.taskId !== null).map((row) => row.file.id)).size;
  const changedFileCount = new Set(rows.filter((row) => row.changed).map((row) => row.file.id)).size;
  const hasFilter = normalizedKeyword !== "" || stageFilter !== "" || statusFilter !== "";

  const openPreview = async (row: ProjectFileRow): Promise<void> => {
    if (previewBusy !== null || !rowHasVersion(row)) {
      return;
    }
    if (mobileFilePreviewMustDownload(row.name)) {
      await downloadFile(row);
      return;
    }
    const versionId = versionIdOfRow(row);
    setPreviewBusy(row.key);
    setNotice(null);
    const outcome = await ensurePreviewOutcome(row.file.id, versionId);
    setPreviewBusy(null);
    if (outcome.kind === "unavailable") {
      setNotice({ kind: "error", text: outcome.reason ?? t("drawer.preview.unavailable") });
      return;
    }
    void recordPreviewView(row.file.id, versionId);
    const kind = previewKindOf(row.name) ?? "image";
    if (outcome.kind === "viewer") {
      setPreview({
        pane: { mode: "viewer", viewer: outcome.viewer },
        name: row.name,
        kind,
        fileId: row.file.id,
        versionId: versionId ?? null,
        rowKey: row.key,
        nonce: 0,
      });
      return;
    }
    setPreview({
      pane: { mode: "url", url: outcome.url },
      name: row.name,
      kind,
      fileId: row.file.id,
      versionId: versionId ?? null,
      rowKey: row.key,
      nonce: 0,
    });
  };

  const retryPreview = async (previous: PreviewState): Promise<void> => {
    if (previewBusy !== null) {
      return;
    }
    setPreviewBusy(previous.rowKey);
    const outcome = await ensurePreviewOutcome(previous.fileId, previous.versionId ?? undefined);
    setPreviewBusy(null);
    if (outcome.kind === "unavailable") {
      setPreview(null);
      setNotice({ kind: "error", text: outcome.reason ?? t("drawer.preview.unavailable") });
      return;
    }
    const pane =
      outcome.kind === "viewer"
        ? { mode: "viewer" as const, viewer: outcome.viewer }
        : { mode: "url" as const, url: outcome.url };
    setPreview({ ...previous, pane, nonce: previous.nonce + 1 });
  };

  async function downloadFile(row: ProjectFileRow): Promise<void> {
    if (downloadBusy !== null || !rowHasVersion(row)) {
      return;
    }
    setDownloadBusy(row.key);
    setNotice(null);
    try {
      const signed = await fetchDownloadUrl(row.file.id, versionIdOfRow(row));
      await triggerDownload(signed.url, signed.fileName);
      setNotice({ kind: "ok", text: t("lib.download.started", { name: signed.fileName }) });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed"),
      });
    } finally {
      setDownloadBusy(null);
    }
  }

  return (
    <section data-project-files="" className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-zinc-900">{t("pd.files.title")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span data-project-files-summary="">{t("pd.files.summary", { stage: stageFileCount, changed: changedFileCount })}</span>
          <span data-project-files-count="">{t("pd.files.count", { n: total })}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
        <span data-project-files-filter="keyword" className="w-72 shrink-0">
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder={t("pd.files.search")}
            className="w-full"
          />
        </span>
        <span data-project-files-filter="stage" className="w-40 shrink-0">
          <SearchSelect
            mode="single"
            ariaLabel={t("pd.files.filter.stage.aria")}
            value={stageFilter}
            options={stageOptions}
            onChange={setStageFilter}
            placeholder={t("pd.files.filter.stage.all")}
            searchPlaceholder={t("pd.files.filter.stage.search")}
          />
        </span>
        <span data-project-files-filter="status" className="w-40 shrink-0">
          <SearchSelect
            mode="single"
            ariaLabel={t("lib.filter.status.aria")}
            value={statusFilter}
            options={statusOptions}
            onChange={setStatusFilter}
            placeholder={t("lib.filter.status.placeholder")}
            searchPlaceholder={t("lib.filter.status.search")}
          />
        </span>
        {hasFilter ? (
          <button
            type="button"
            onClick={() => {
              setKeyword("");
              setStageFilter("");
              setStatusFilter("");
            }}
            className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            {t("lib.clear")}
          </button>
        ) : null}
      </div>

      {notice === null ? null : (
        <Toast
          kind={notice.kind}
          text={notice.text}
          onClose={() => {
            setNotice(null);
          }}
          anchor={{ name: "data-project-files-notice", value: notice.kind }}
        />
      )}

      {state.kind === "loading" ? (
        <div className="flex justify-center rounded-xl border border-zinc-200 bg-white py-16">
          <Loader />
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{state.message}</span>
          <button
            type="button"
            onClick={() => {
              setReloadTick((tick) => tick + 1);
            }}
            className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs font-medium transition hover:bg-rose-100"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {state.kind === "ready" && total === 0 ? (
        <div data-project-files-empty="" className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
          {hasFilter ? t("pd.files.empty.filter") : t("pd.files.empty")}
        </div>
      ) : null}

      {state.kind === "ready" && total > 0 ? (
        <>
          <div data-project-files-table="" className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
              <thead className="bg-zinc-50 text-zinc-500">
                <tr>
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.file")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("pd.files.col.stage")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("pd.files.col.task")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.status")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.uploader")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.createdAt")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const file = row.file;
                  const task = taskById.get(file.taskId ?? "");
                  const stageKey = stageKeyOf(row);
                  const available = rowHasVersion(row);
                  const statusLabel =
                    row.changeSide === "before"
                      ? t("pd.files.status.before")
                      : row.changeSide === "after"
                        ? t("pd.files.status.after")
                        : statusText(locale, STATUS_LABELS[file.status] ?? file.status);
                  const statusClass =
                    row.changeSide === null
                      ? STATUS_CLASS[file.status] ?? "bg-zinc-100 text-zinc-600"
                      : CHANGE_SIDE_CLASS[row.changeSide];
                  return (
                    <tr
                      key={row.key}
                      data-project-file-row={row.key}
                      data-project-file-id={file.id}
                      data-project-file-changed={row.changed ? "true" : undefined}
                      data-project-file-change-side={row.changeSide ?? undefined}
                      data-project-file-version-id={row.versionId ?? undefined}
                      tabIndex={available ? 0 : undefined}
                      aria-label={(mobileFilePreviewMustDownload(row.name) ? t("lib.download") : t("lib.preview")) + " " + row.name}
                      aria-busy={previewBusy === row.key}
                      onClick={(event) => {
                        if (!available) {
                          return;
                        }
                        const target = event.target;
                        if (target instanceof Element && target.closest("button, a, input, select, textarea, [role=button]") !== null) {
                          return;
                        }
                        void openPreview(row);
                      }}
                      onKeyDown={(event) => {
                        if (!available || event.target !== event.currentTarget) {
                          return;
                        }
                        if (event.key !== "Enter" && event.key !== " ") {
                          return;
                        }
                        event.preventDefault();
                        void openPreview(row);
                      }}
                      className={
                        (available
                          ? "cursor-pointer transition hover:bg-zinc-50/70 focus-visible:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                          : "cursor-default") +
                        (row.changeSide === "before" ? " bg-zinc-50/40" : "")
                      }
                    >
                      <td data-mobile-label={t("lib.col.file")} className="align-middle border-b border-zinc-100 px-4 py-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileTypeIcon name={row.name} className="h-5 w-5 shrink-0" />
                          <span className="min-w-0">
                            <span className="block truncate text-base text-zinc-800" title={row.name}>
                              {row.name}
                            </span>
                            {row.changeSide !== null && row.versionSeq !== null ? (
                              <span className="mt-0.5 block text-[11px] text-zinc-400">v{String(row.versionSeq)}</span>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td data-project-file-stage={stageKey} data-mobile-label={t("pd.files.col.stage")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                        <span
                          className={
                            "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " +
                            (stageKey === CHANGED_STAGE
                              ? "bg-blue-50 text-blue-700"
                              : stageKey === UNKNOWN_STAGE
                                ? "bg-zinc-100 text-zinc-500"
                                : "bg-zinc-100 text-zinc-700")
                          }
                        >
                          {stageLabelOf(stageKey)}
                        </span>
                      </td>
                      <td data-mobile-label={t("pd.files.col.task")} className="align-middle border-b border-zinc-100 px-4 py-3 text-zinc-700">
                        <span className="block max-w-[260px] truncate" title={task?.title ?? undefined}>
                          {task?.title ?? "—"}
                        </span>
                      </td>
                      <td data-project-file-status={row.changeSide ?? file.status} data-mobile-label={t("lib.col.status")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                        <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + statusClass}>
                          {statusLabel}
                        </span>
                      </td>
                      <td data-mobile-label={t("lib.col.uploader")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-700">
                        {file.createdByName ?? file.createdBy}
                      </td>
                      <td data-mobile-label={t("lib.col.createdAt")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-600">
                        {row.uploadedAt === "" ? "—" : formatDateTime(row.uploadedAt)}
                      </td>
                      <td data-mobile-label={t("lib.col.actions")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                        <button
                          type="button"
                          data-project-file-download={row.key}
                          disabled={downloadBusy !== null || !available}
                          onClick={() => {
                            void downloadFile(row);
                          }}
                          className="inline-flex w-16 items-center justify-center rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                        >
                          {downloadBusy === row.key ? t("lib.download.busy") : t("lib.download")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">{t("lib.page", { total, page: currentPage, pages: totalPages })}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1);
                }}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                {t("lib.prev")}
              </button>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => {
                  setPage(currentPage + 1);
                }}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                {t("lib.next")}
              </button>
            </div>
          </footer>
        </>
      ) : null}

      {preview === null ? null : (
        <FilePreviewOverlay
          pane={preview.pane}
          name={preview.name}
          kind={preview.kind}
          nonce={preview.nonce}
          onRetry={() => {
            void retryPreview(preview);
          }}
          onDownload={() => {
            void (async () => {
              try {
                const signed = await fetchDownloadUrl(preview.fileId, preview.versionId ?? undefined);
                await triggerDownload(signed.url, signed.fileName);
              } catch (error) {
                setNotice({
                  kind: "error",
                  text: error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed"),
                });
              }
            })();
          }}
          onClose={() => {
            setPreview(null);
          }}
        />
      )}
    </section>
  );
}
