import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { PROJECT_STAGES } from "../data/projects";
import { TEMP_TASK_STAGE, type ProjectTask } from "../data/tasks";
import {
  createFileArchive,
  ensurePreviewOutcome,
  fetchChangeRequest,
  fetchDownloadUrl,
  fetchFileVersions,
  fetchProjectChanges,
  fetchProjectFileLibrary,
  previewKindOf,
  recordPreviewView,
  recycleFile,
  triggerDownload,
  type ApiChangeRequest,
  type FileArchiveItem,
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
import { ExportProgressOverlay } from "./ExportProgressOverlay";
import { Loader } from "./Loader";
import { RowDeleteButton } from "./RowDeleteButton";
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
 * 状态口径：任务已定档时，其 draft 文件按业务可见口径显示 / 筛选为「已定档」（与变更资格、任务抽屉一致）；
 * 变更文件仍按最新一次变更拆成「变更前 / 变更后」。
 *
 * 交互：关键字 + 阶段 + 文件状态筛选（本地内存过滤，单项目一次取满）、50 行分页（变更前后同页）、
 * 整行点击预览、操作列下载原文件；仅「补发申请」DOCX 行额外复用行内删除胶囊，确认后移入文件回收站（30 天可恢复）。
 * 预览 / 审计 / 下载均使用该行对应 versionId；阶段来自任务；
 * 无任务的历史任务文件显示「未关联阶段」，仅变更文件显示「变更文件」。
 */
const PAGE_LIMIT = 50;
const BULK_LIMIT = 50;
const BULK_DOWNLOAD_INTERVAL_MS = 150;
const BULK_CONTROL_CLASS =
  "inline-flex h-8 items-center justify-center rounded-lg border border-zinc-300 bg-white px-2.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300";
const BULK_PRIMARY_CLASS =
  "inline-flex h-8 items-center justify-center rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400";
const CURRENT_FILE_STATUSES = ["draft", "final", "changed", "archived"] as const;
const FILE_STATUS_FILTERS = ["draft", "final", "before", "after", "material", "archived"] as const;
const CHANGED_STAGE = "__changed";
const UNKNOWN_STAGE = "__unknown";

const STATUS_LABELS: Record<string, string> = {
  draft: "未定档",
  final: "已定档",
  changed: "变更后",
  material: "补发申请",
  archived: "已归档",
};

const STATUS_CLASS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  final: "bg-amber-100 text-amber-800",
  changed: "bg-blue-50 text-blue-700",
  material: "bg-emerald-100 text-emerald-700",
  archived: "bg-zinc-100 text-zinc-500",
};

const CHANGE_SIDE_CLASS: Record<"before" | "after" | "material", string> = {
  before: "bg-zinc-100 text-zinc-600",
  after: "bg-blue-50 text-blue-700",
  material: "bg-emerald-100 text-emerald-700",
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
  changeSide: "before" | "after" | "material" | null;
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

function resolvedVersionIdOfRow(row: ProjectFileRow): string | undefined {
  return row.changeSide === null ? row.file.currentVersionId ?? undefined : row.versionId ?? undefined;
}

function rowHasVersion(row: ProjectFileRow): boolean {
  return resolvedVersionIdOfRow(row) !== undefined;
}

function archiveItemOfRow(row: ProjectFileRow): FileArchiveItem | null {
  const versionId = resolvedVersionIdOfRow(row);
  return versionId === undefined ? null : { fileId: row.file.id, versionId, entryName: row.name };
}

/** 批量请求按 (fileId, versionId) 去重，同时保留用户首次选择顺序。 */
function uniqueDownloadRows(rows: readonly ProjectFileRow[]): ProjectFileRow[] {
  const seen = new Set<string>();
  const result: ProjectFileRow[] = [];
  for (const row of rows) {
    const item = archiveItemOfRow(row);
    if (item === null) {
      continue;
    }
    const key = item.fileId + ":" + item.versionId;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isMaterialReissueDocument(row: ProjectFileRow): boolean {
  return row.changeSide === "material" && row.name.toLowerCase().endsWith(".docx");
}

type Notice = { kind: "ok" | "error"; text: string };

type BulkBusy =
  | { kind: "separate"; done: number; total: number; current: string }
  | { kind: "archive"; total: number };

type BulkMessage = { kind: "ok" | "error" | "info"; text: string };

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
    if (latestChange.changeType === "material_reissue") {
      rowsByFileId.set(file.id, [
        {
          key: file.id + ":material",
          file,
          changed: true,
          name: afterName,
          versionId: afterVersionId,
          versionSeq: afterSeq,
          uploadedAt: afterUploadedAt,
          changeSide: "material",
        },
      ]);
      return;
    }
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

export function ProjectFilesPanel({ projectId, tasks, canEdit = false }: { projectId: string; tasks: readonly ProjectTask[]; canEdit?: boolean }) {
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
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkBusy | null>(null);
  const [bulkMessage, setBulkMessage] = useState<BulkMessage | null>(null);

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

  /** 筛选或项目变化后，旧选择不再对应可见集合，必须清空，避免批量操作命中已隐藏行。 */
  useEffect(() => {
    setSelectedRowKeys(new Set());
    setBulkMessage(null);
  }, [keyword, stageFilter, statusFilter, projectId]);

  /** 实时刷新 / 回收后剔除已不存在或已无版本的选中行；加载中暂不清空。 */
  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    const availableKeys = new Set(state.rows.filter(rowHasVersion).map((row) => row.key));
    setSelectedRowKeys((previous) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of previous) {
        if (availableKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [state]);

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

  /** 任务定档后，其 draft 文件在业务上视为已定档（与变更申请资格、任务抽屉口径一致）。 */
  const statusValueOf = (row: ProjectFileRow): string => {
    if (row.changeSide !== null) {
      return row.changeSide;
    }
    const status = row.file.status;
    const task = taskById.get(row.file.taskId ?? "");
    if (status === "draft" && task !== undefined && task.finalizedAt !== null) {
      return "final";
    }
    return status === "changed" ? "after" : status;
  };
  const statusLabelOf = (status: string): string => {
    if (status === "before") return t("pd.files.status.before");
    if (status === "after") return t("pd.files.status.after");
    if (status === "material") return t("pd.files.status.material");
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
  const rowByKey = new Map(rows.map((row) => [row.key, row] as const));
  const selectableRows = rows.filter(rowHasVersion);
  const selectedRows = [...selectedRowKeys].flatMap((key) => {
    const row = rowByKey.get(key);
    return row === undefined ? [] : [row];
  });
  const selectedDownloadRows = uniqueDownloadRows(selectedRows);
  const selectablePageRows = pageRows.filter(rowHasVersion);
  const selectedPageCount = selectablePageRows.filter((row) => selectedRowKeys.has(row.key)).length;
  const allPageSelected = selectablePageRows.length > 0 && selectedPageCount === selectablePageRows.length;
  const somePageSelected = selectedPageCount > 0 && !allPageSelected;
  const bulkBusyActive = bulkBusy !== null;

  const enterBulkMode = (): void => {
    if (selectableRows.length === 0) {
      return;
    }
    setBulkMode(true);
    setSelectedRowKeys(new Set());
    setBulkMessage(null);
  };

  const exitBulkMode = (): void => {
    if (bulkBusyActive) {
      return;
    }
    setBulkMode(false);
    setSelectedRowKeys(new Set());
    setBulkMessage(null);
  };

  const toggleRowSelection = (row: ProjectFileRow): void => {
    if (!bulkMode || bulkBusyActive || !rowHasVersion(row)) {
      return;
    }
    if (selectedRowKeys.has(row.key)) {
      setSelectedRowKeys((previous) => {
        const next = new Set(previous);
        next.delete(row.key);
        return next;
      });
      setBulkMessage(null);
      return;
    }
    if (selectedRowKeys.size >= BULK_LIMIT) {
      setBulkMessage({ kind: "error", text: t("pd.files.bulk.limit") });
      return;
    }
    setSelectedRowKeys((previous) => new Set(previous).add(row.key));
    setBulkMessage(null);
  };

  const toggleCurrentPageSelection = (): void => {
    if (bulkBusyActive || selectablePageRows.length === 0) {
      return;
    }
    if (allPageSelected) {
      const pageKeys = new Set(selectablePageRows.map((row) => row.key));
      setSelectedRowKeys((previous) => {
        const next = new Set(previous);
        for (const key of pageKeys) {
          next.delete(key);
        }
        return next;
      });
      setBulkMessage(null);
      return;
    }
    const additions = selectablePageRows.filter((row) => !selectedRowKeys.has(row.key));
    const availableSlots = Math.max(0, BULK_LIMIT - selectedRowKeys.size);
    if (availableSlots === 0) {
      setBulkMessage({ kind: "error", text: t("pd.files.bulk.limit") });
      return;
    }
    const accepted = additions.slice(0, availableSlots);
    setSelectedRowKeys((previous) => {
      const next = new Set(previous);
      for (const row of accepted) {
        next.add(row.key);
      }
      return next;
    });
    setBulkMessage(accepted.length < additions.length ? { kind: "info", text: t("pd.files.bulk.limit") } : null);
  };

  const clearBulkSelection = (): void => {
    if (bulkBusyActive) {
      return;
    }
    setSelectedRowKeys(new Set());
    setBulkMessage(null);
  };

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
    if (downloadBusy !== null || bulkBusyActive || !rowHasVersion(row)) {
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

  async function downloadSelectedSeparately(): Promise<void> {
    if (bulkBusyActive) {
      return;
    }
    if (selectedDownloadRows.length === 0) {
      setBulkMessage({ kind: "info", text: t("pd.files.bulk.needSelection") });
      return;
    }
    setNotice(null);
    setBulkMessage(null);
    let success = 0;
    let failed = 0;
    for (let index = 0; index < selectedDownloadRows.length; index += 1) {
      const row = selectedDownloadRows[index];
      if (row === undefined) {
        continue;
      }
      setBulkBusy({
        kind: "separate",
        done: index + 1,
        total: selectedDownloadRows.length,
        current: row.name,
      });
      try {
        const versionId = resolvedVersionIdOfRow(row);
        if (versionId === undefined) {
          throw new Error(t("pd.files.bulk.unavailable"));
        }
        const signed = await fetchDownloadUrl(row.file.id, versionId);
        await triggerDownload(signed.url, signed.fileName);
        success += 1;
      } catch {
        failed += 1;
      }
      setBulkBusy({
        kind: "separate",
        done: index + 1,
        total: selectedDownloadRows.length,
        current: row.name,
      });
      if (index < selectedDownloadRows.length - 1) {
        await waitMs(BULK_DOWNLOAD_INTERVAL_MS);
      }
    }
    setBulkBusy(null);
    setBulkMessage({
      kind: failed === 0 ? "ok" : "error",
      text:
        failed === 0
          ? t("pd.files.bulk.separateDone", { success })
          : t("pd.files.bulk.separateFailed", { success, failed }),
    });
  }

  async function downloadSelectedArchive(): Promise<void> {
    if (bulkBusyActive) {
      return;
    }
    const items = selectedDownloadRows.flatMap((row) => {
      const item = archiveItemOfRow(row);
      return item === null ? [] : [item];
    });
    if (items.length === 0) {
      setBulkMessage({ kind: "info", text: t("pd.files.bulk.needSelection") });
      return;
    }
    setNotice(null);
    setBulkMessage(null);
    setBulkBusy({ kind: "archive", total: items.length });
    try {
      const archive = await createFileArchive(projectId, items);
      await triggerDownload(archive.url, archive.fileName);
      setBulkMessage({ kind: "ok", text: t("pd.files.bulk.archiveStarted", { name: archive.fileName }) });
    } catch (error) {
      setBulkMessage({
        kind: "error",
        text:
          error instanceof Error && error.message !== ""
            ? error.message
            : t("pd.files.bulk.archiveFailed"),
      });
    } finally {
      setBulkBusy(null);
    }
  }

  async function deleteMaterialReissue(row: ProjectFileRow): Promise<void> {
    if (!canEdit || deleteBusy !== null || bulkBusyActive || !isMaterialReissueDocument(row)) {
      return;
    }
    setPendingDelete(null);
    setDeleteBusy(row.key);
    setNotice(null);
    try {
      await recycleFile(row.file.id);
      setNotice({ kind: "ok", text: t("pd.files.material.deleteSuccess", { name: row.name }) });
      setPage(1);
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error && error.message !== "" ? error.message : t("pd.files.material.deleteFailed"),
      });
    } finally {
      setDeleteBusy(null);
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
            disabled={bulkBusyActive}
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
            disabled={bulkBusyActive}
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
            disabled={bulkBusyActive}
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
            disabled={bulkBusyActive}
            className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-300"
          >
            {t("lib.clear")}
          </button>
        ) : null}
        <div
          data-project-files-bulk=""
          className="ml-auto mr-1 flex flex-wrap items-center justify-end gap-1.5"
        >
          {bulkMode ? (
            <>
              <span
                data-project-files-bulk-selected={selectedRowKeys.size}
                aria-live="polite"
                className="whitespace-nowrap px-1 text-xs font-medium text-zinc-600"
              >
                {t("pd.files.bulk.selected", { n: selectedRowKeys.size })}
              </span>
              <button
                type="button"
                data-project-files-bulk-action="page"
                disabled={bulkBusyActive || selectablePageRows.length === 0}
                aria-label={allPageSelected ? t("pd.files.bulk.unselectPageAria") : t("pd.files.bulk.selectPageAria")}
                onClick={toggleCurrentPageSelection}
                className={BULK_CONTROL_CLASS}
              >
                {allPageSelected ? t("pd.files.bulk.unselectPage") : t("pd.files.bulk.selectPage")}
              </button>
              <button
                type="button"
                data-project-files-bulk-action="clear"
                disabled={bulkBusyActive || selectedRowKeys.size === 0}
                onClick={clearBulkSelection}
                className={BULK_CONTROL_CLASS}
              >
                {t("pd.files.bulk.clear")}
              </button>
              <button
                type="button"
                data-project-files-bulk-action="separate"
                disabled={bulkBusyActive || selectedDownloadRows.length === 0}
                aria-busy={bulkBusy?.kind === "separate"}
                onClick={() => { void downloadSelectedSeparately(); }}
                className={BULK_CONTROL_CLASS}
              >
                {t("pd.files.bulk.separate")}
              </button>
              <button
                type="button"
                data-project-files-bulk-action="archive"
                disabled={bulkBusyActive || selectedDownloadRows.length === 0}
                aria-busy={bulkBusy?.kind === "archive"}
                onClick={() => { void downloadSelectedArchive(); }}
                className={BULK_PRIMARY_CLASS}
              >
                {bulkBusy?.kind === "archive" ? t("pd.files.bulk.archiving") : t("pd.files.bulk.archive")}
              </button>
              <button
                type="button"
                data-project-files-bulk-toggle="exit"
                disabled={bulkBusyActive}
                onClick={exitBulkMode}
                className={BULK_CONTROL_CLASS}
              >
                {t("pd.files.bulk.exit")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-project-files-bulk-toggle="enter"
              disabled={state.kind !== "ready" || selectableRows.length === 0}
              title={state.kind === "ready" && selectableRows.length === 0 ? t("pd.files.bulk.noneAvailable") : undefined}
              onClick={enterBulkMode}
              className={BULK_PRIMARY_CLASS}
            >
              {t("pd.files.bulk.entry")}
            </button>
          )}
        </div>
      </div>

      {bulkBusy?.kind === "separate" ? (
        <div
          data-project-files-bulk-progress="separate"
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
          <span className="min-w-0">
            {t("pd.files.bulk.separateProgress", {
              done: bulkBusy.done,
              total: bulkBusy.total,
              name: bulkBusy.current,
            })}
          </span>
        </div>
      ) : null}

      {bulkMessage === null ? null : (
        <div
          data-project-files-bulk-message={bulkMessage.kind}
          role={bulkMessage.kind === "error" ? "alert" : "status"}
          aria-live={bulkMessage.kind === "error" ? "assertive" : "polite"}
          className={
            "rounded-xl border px-3 py-2 text-xs " +
            (bulkMessage.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : bulkMessage.kind === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-sky-200 bg-sky-50 text-sky-800")
          }
        >
          {bulkMessage.text}
        </div>
      )}

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
            <table className={"w-full border-collapse text-left text-sm " + (bulkMode ? "min-w-[1168px]" : "min-w-[1120px]")}>
              <thead className="bg-zinc-50 text-zinc-500">
                <tr>
                  {bulkMode ? (
                    <th className="w-12 border-b border-zinc-200 px-3 py-3 font-medium">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        ref={(input) => {
                          if (input !== null) {
                            input.indeterminate = somePageSelected;
                          }
                        }}
                        disabled={bulkBusyActive || selectablePageRows.length === 0}
                        aria-label={allPageSelected ? t("pd.files.bulk.unselectPageAria") : t("pd.files.bulk.selectAllAria")}
                        aria-checked={somePageSelected ? "mixed" : allPageSelected}
                        onChange={toggleCurrentPageSelection}
                        className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </th>
                  ) : null}
                  <th className="border-b border-zinc-200 px-4 py-3 font-medium">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      {t("lib.col.file")}
                      <span data-project-files-preview-hint="" className="text-[11px] font-normal text-zinc-400">
                        {t("pd.files.previewHint")}
                      </span>
                    </span>
                  </th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("pd.files.col.stage")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("pd.files.col.task")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.status")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.uploader")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.createdAt")}</th>
                  <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 text-right font-medium">
                    <span className="inline-flex w-16 items-center justify-center">{t("lib.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const file = row.file;
                  const task = taskById.get(file.taskId ?? "");
                  const stageKey = stageKeyOf(row);
                  const available = rowHasVersion(row);
                  const statusKey = statusValueOf(row);
                  const statusLabel = statusLabelOf(statusKey);
                  const statusClass =
                    statusKey === "before" || statusKey === "after" || statusKey === "material"
                      ? CHANGE_SIDE_CLASS[statusKey]
                      : STATUS_CLASS[statusKey] ?? "bg-zinc-100 text-zinc-600";
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
                        "group " +
                        (available
                          ? "cursor-pointer transition hover:bg-zinc-50/70 focus-visible:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                          : "cursor-default") +
                        (row.changeSide === "before" ? " bg-zinc-50/40" : "")
                      }
                    >
                      {bulkMode ? (
                        <td
                          data-project-file-select={row.key}
                          data-mobile-label={t("pd.files.bulk.selectColumn")}
                          className="align-middle border-b border-zinc-100 px-3 py-3"
                        >
                          <input
                            type="checkbox"
                            checked={selectedRowKeys.has(row.key)}
                            disabled={
                              !available ||
                              bulkBusyActive ||
                              (!selectedRowKeys.has(row.key) && selectedRowKeys.size >= BULK_LIMIT)
                            }
                            aria-label={
                              available
                                ? t("pd.files.bulk.selectRow", { name: row.name })
                                : t("pd.files.bulk.unavailable")
                            }
                            title={available ? undefined : t("pd.files.bulk.unavailable")}
                            onChange={() => { toggleRowSelection(row); }}
                            className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </td>
                      ) : null}
                      <td data-mobile-label={t("lib.col.file")} className="align-middle border-b border-zinc-100 px-4 py-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileTypeIcon name={row.name} className="h-5 w-5 shrink-0" />
                          <span className="min-w-0">
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="block min-w-0 truncate text-base text-zinc-800" title={row.name}>
                                {row.name}
                              </span>
                              {canEdit && isMaterialReissueDocument(row) ? (
                                deleteBusy === row.key ? (
                                  <span data-project-file-deleting={row.key} className="inline-flex h-6 min-w-12 shrink-0 items-center justify-center rounded-full bg-red-50 px-2 text-[11px] font-medium text-red-600">
                                    {t("pd.files.material.deleting")}
                                  </span>
                                ) : pendingDelete === row.key ? (
                                  <span data-project-file-delete-confirm={row.key} className="flex shrink-0 items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => { void deleteMaterialReissue(row); }}
                                      className="flex h-6 shrink-0 items-center justify-center rounded-full bg-red-500 px-2.5 text-[11px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(220,38,38,0.25)] transition-colors hover:bg-red-600"
                                    >
                                      {t("drawer.file.deleteOk")}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => { setPendingDelete(null); }}
                                      className="flex h-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-medium leading-none text-zinc-600 transition-colors hover:bg-zinc-200"
                                    >
                                      {t("drawer.file.deleteCancel")}
                                    </button>
                                  </span>
                                ) : (
                                  <span data-project-file-delete={row.key} className="flex h-6 w-12 shrink-0 items-center">
                                    <RowDeleteButton
                                      onDelete={() => { setPendingDelete(row.key); }}
                                      label={t("drawer.file.deleteAria", { name: row.name })}
                                    />
                                  </span>
                                )
                              ) : null}
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
                      <td data-project-file-status={statusKey} data-mobile-label={t("lib.col.status")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
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
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            data-project-file-download={row.key}
                            disabled={downloadBusy !== null || deleteBusy !== null || bulkBusyActive || !available}
                            onClick={() => {
                              void downloadFile(row);
                            }}
                            className="inline-flex w-16 items-center justify-center rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                          >
                            {downloadBusy === row.key ? t("lib.download.busy") : t("lib.download")}
                          </button>
                        </div>
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

      {bulkBusy?.kind === "archive" ? (
        <ExportProgressOverlay
          progress={null}
          variant="project-data"
          title={t("pd.files.bulk.archiveProgress", { n: bulkBusy.total })}
          hint={t("pd.files.bulk.archiveWait")}
        />
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
