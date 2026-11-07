import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api";
import { usePhotoUrl } from "../fileApi";
import { textOf, useLocale, useT } from "../i18n";
import {
  PAGE_EXPORT_PREVIEW_PHOTO_LIMIT,
  downloadPageExport,
  fetchPageExportCatalog,
  type PageExportCatalogColumn,
  type PageExportCatalogSheet,
  type PageExportCatalogResponse,
  type PageExportPreset,
  type PageExportPreviewCell,
  type PageExportPreviewPhoto,
  type PageExportPreviewPhotoCell,
  type PageExportPreviewRow,
  type PageExportSheetKey,
  type PageExportSheetSelection,
} from "../pageExportApi";
import { hasPermission, useMyPermissions } from "../permissions";
import { loadMyPreferences, savePageExportPresets } from "../preferencesApi";
import { lockBodyScroll } from "../scrollLock";
import { useFocusTrapFor } from "./useFocusTrap";
import { SelectMenu } from "./SelectMenu";
import { ExportProgressOverlay } from "./ExportProgressOverlay";

type PageExportButtonProps = {
  projectId: string;
  /** 当前页面所在的 Sheet：打开时默认勾选，其余页面仍可加入同一个工作簿。 */
  initialSheet: PageExportSheetKey;
};

type Feedback = { kind: "ok" | "error" | "info"; text: string };
type Selections = Partial<Record<PageExportSheetKey, string[]>>;
type PresetState = { presets: PageExportPreset[]; revision: number };

function allowedColumnKeys(sheet: PageExportCatalogSheet): Set<string> {
  return new Set(sheet.columns.filter((column) => column.allowed).map((column) => column.key));
}

/** 导出列始终按服务端目录顺序规范，不接受前端或旧方案保存的自定义顺序。 */
function canonicalColumnsOf(sheet: PageExportCatalogSheet, keys: readonly string[]): string[] {
  const selected = new Set(keys);
  return sheet.columns.filter((column) => column.allowed && selected.has(column.key)).map((column) => column.key);
}

function defaultColumnsOf(sheet: PageExportCatalogSheet): string[] {
  const defaults = canonicalColumnsOf(sheet, sheet.defaultColumns);
  if (defaults.length > 0) return defaults;
  return sheet.columns.filter((column) => column.allowed).slice(0, 1).map((column) => column.key);
}

function payloadOf(catalog: PageExportCatalogResponse, selections: Selections): PageExportSheetSelection[] {
  const payload: PageExportSheetSelection[] = [];
  for (const sheet of catalog.sheets) {
    const selected = selections[sheet.key];
    if (!sheet.allowed || selected === undefined) continue;
    const columns = canonicalColumnsOf(sheet, selected);
    if (columns.length > 0) payload.push({ sheet: sheet.key, columns });
  }
  return payload;
}

function presetId(): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : "";
  return "pe-" + (uuid || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function previewWidth(sheet: PageExportSheetKey, column: string): number {
  const widths: Record<string, number> = {
    date: 110,
    raisedAt: 110,
    author: 110,
    stageNames: 150,
    doneWork: 250,
    plan: 210,
    photos: 112,
    categories: 150,
    owner: 116,
    solution: 220,
    state: 106,
    name: 136,
    phone: 140,
    wechat: 116,
    email: 190,
    company: 170,
    createdBy: 110,
    role: 124,
  };
  if (sheet === "issues" && column === "title") return 230;
  if (sheet === "stakeholders" && column === "title") return 150;
  return widths[column] ?? 140;
}

function previewCellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return value.toLocaleString("zh-CN");
  return value.trim() === "" ? "—" : value;
}

function isPhotoCell(value: PageExportPreviewCell | undefined): value is PageExportPreviewPhotoCell {
  return typeof value === "object" && value !== null && value.kind === "photos";
}

function PreviewPhotoImage({ photo }: { photo: PageExportPreviewPhoto }) {
  const url = usePhotoUrl(photo.fileId, null);
  if (url === null) {
    return <span aria-hidden="true" className="block h-full w-full animate-pulse bg-zinc-100" />;
  }
  return (
    <img
      src={url}
      alt={photo.name}
      title={photo.name}
      loading="lazy"
      className="block h-full w-full object-cover"
    />
  );
}

/** 视口接近时才挂载签名请求，避免一次预览为全部行批量取缩略图。 */
function PreviewPhotoThumb({ photo }: { photo: PageExportPreviewPhoto }) {
  const [visible, setVisible] = useState(false);
  const holderRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (visible) return undefined;
    const holder = holderRef.current;
    if (holder === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(holder);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <span
      ref={holderRef}
      data-page-export-preview-photo={photo.name}
      className="block h-10 w-10 overflow-hidden rounded-md border border-zinc-200 bg-zinc-100"
    >
      {visible ? <PreviewPhotoImage photo={photo} /> : <span aria-hidden="true" className="block h-full w-full animate-pulse bg-zinc-100" />}
    </span>
  );
}

function PreviewPhotos({ cell }: { cell: PageExportPreviewPhotoCell }) {
  const t = useT();
  if (cell.total === 0) return <span className="text-zinc-400">—</span>;
  const items = cell.items.slice(0, PAGE_EXPORT_PREVIEW_PHOTO_LIMIT);
  const remaining = Math.max(0, cell.total - items.length);
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="grid grid-cols-2 gap-1">
        {items.map((photo, index) => (
          <PreviewPhotoThumb key={photo.fileId + "#" + String(index)} photo={photo} />
        ))}
      </span>
      {remaining > 0 ? (
        <span
          title={t("pageExport.preview.morePhotos", { n: remaining })}
          className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-600"
        >
          +{remaining}
        </span>
      ) : null}
    </span>
  );
}

function PreviewCell({ value }: { value: PageExportPreviewCell | undefined }) {
  if (isPhotoCell(value)) return <PreviewPhotos cell={value} />;
  const text = previewCellText(value);
  return <span className="line-clamp-3 whitespace-pre-wrap break-words" title={text}>{text}</span>;
}

function ExportPreview({
  sheet,
  columns,
  rows,
  limited,
  t,
}: {
  sheet: PageExportCatalogSheet;
  columns: readonly PageExportCatalogColumn[];
  rows: readonly PageExportPreviewRow[];
  limited: boolean;
  t: ReturnType<typeof useT>;
}) {
  const totalWidth = Math.max(600, columns.reduce((sum, column) => sum + previewWidth(sheet.key, column.key), 0));
  return (
    <div data-page-export-preview="" className="flex min-h-0 flex-1 items-stretch justify-center overflow-hidden rounded-2xl bg-zinc-200/80 p-3 shadow-inner sm:p-4">
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl bg-white shadow-[0_12px_40px_rgba(15,23,42,0.14)] ring-1 ring-black/5">
        <div className="h-1 shrink-0 bg-[#217346]" />
        <div className="flex shrink-0 items-start gap-3 border-b border-zinc-200 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
            <svg viewBox="0 0 24 24" fill="none" className="h-4.5 w-4.5" aria-hidden="true">
              <path d="M7 3.75h7.5L19 8.25v12H7a1.5 1.5 0 0 1-1.5-1.5V5.25A1.5 1.5 0 0 1 7 3.75Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M14.5 3.75v4.5H19M8.5 12h6m-6 3h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">LIBIAOLINK · EXCEL</p>
            <h4 className="mt-0.5 truncate text-sm font-semibold text-zinc-900">{sheet.label}</h4>
          </div>
          <div className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11px] tabular-nums text-zinc-500">
            {t("pageExport.rowCount", { n: sheet.rowCount })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-white">
          <table className="border-collapse text-left" style={{ width: "100%", minWidth: totalWidth, tableLayout: "fixed" }}>
            <colgroup>
              {columns.map((column) => <col key={column.key} style={{ width: previewWidth(sheet.key, column.key) }} />)}
            </colgroup>
            <thead className="sticky top-0 z-[1]">
              <tr className="bg-[#217346] text-white">
                {columns.map((column) => (
                  <th key={column.key} scope="col" className="border-r border-white/15 px-3 py-2.5 text-left text-[11px] font-semibold last:border-r-0">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-16 text-center text-sm text-zinc-400">{t("pageExport.preview.noRows")}</td>
                </tr>
              ) : rows.map((row, index) => (
                <tr key={index} className={index % 2 === 0 ? "bg-white" : "bg-zinc-50/60"}>
                  {columns.map((column) => (
                    <td key={column.key} className="border-b border-r border-zinc-200 px-3 py-2.5 align-top text-xs leading-5 text-zinc-700 last:border-r-0">
                      <PreviewCell value={row[column.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-[11px] text-zinc-500">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>{t("pageExport.preview.live")}</span>
          {limited ? <span className="ml-auto tabular-nums">{t("pageExport.preview.limited", { n: rows.length, rows: sheet.rowCount })}</span> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 页面级 Excel 导出入口（日报记录 / 问题追踪 / 干系人共用一个弹窗）。
 * 左侧按服务端目录中的中文预览行实时展示，右侧选择 Sheet 与列。
 * 列顺序固定为目录顺序；方案只保存页面和列集合，旧方案中的自定义顺序在应用时归一化。
 */
export function PageExportButton({ projectId, initialSheet }: PageExportButtonProps) {
  const t = useT();
  const locale = useLocale();
  const permissions = useMyPermissions();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<PageExportCatalogResponse | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [previewSheet, setPreviewSheet] = useState<PageExportSheetKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presetState, setPresetState] = useState<PresetState | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [newPresetName, setNewPresetName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteArmId, setDeleteArmId] = useState<string | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrapFor(dialogRef, open);

  const close = (): void => {
    if (!exporting) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setFeedback(null);
    setCatalog(null);
    setPreviewSheet(null);
    setPresetState(null);
    setSelectedPresetId("");
    setRenameId(null);
    setDeleteArmId(null);
    setNewPresetName("");
    void Promise.allSettled([fetchPageExportCatalog(projectId), loadMyPreferences()]).then(([catalogResult, preferencesResult]) => {
      if (!alive) return;
      if (catalogResult.status === "rejected") {
        setLoadError(textOf(locale, "pageExport.loadFailed"));
        setLoading(false);
        return;
      }
      const nextCatalog = catalogResult.value;
      setCatalog(nextCatalog);
      const requested = nextCatalog.sheets.find((sheet) => sheet.key === initialSheet && sheet.allowed);
      const primary = requested ?? nextCatalog.sheets.find((sheet) => sheet.allowed && defaultColumnsOf(sheet).length > 0) ?? null;
      setSelections(primary === null ? {} : { [primary.key]: defaultColumnsOf(primary) });
      setPreviewSheet(primary?.key ?? null);
      if (preferencesResult.status === "fulfilled") {
        setPresetState({
          presets: preferencesResult.value.pageExportPresets ?? [],
          revision: preferencesResult.value.revisions?.pageExportPresets ?? 0,
        });
      } else {
        setPresetState({ presets: [], revision: 0 });
        setFeedback({ kind: "error", text: textOf(locale, "pageExport.preset.loadFailed") });
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open, projectId, initialSheet, reloadKey, locale]);

  useEffect(() => {
    if (!open) return undefined;
    return lockBodyScroll();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !exporting) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, exporting]);

  useEffect(() => {
    if (!open) return;
    if (previewSheet !== null && (selections[previewSheet]?.length ?? 0) > 0) return;
    const first = (catalog?.sheets ?? []).find((sheet) => (selections[sheet.key]?.length ?? 0) > 0);
    setPreviewSheet(first?.key ?? null);
  }, [open, catalog, selections, previewSheet]);

  if (!hasPermission(permissions, "project.export")) return null;

  const selectedSheets = (catalog?.sheets ?? []).filter((sheet) => sheet.allowed && (selections[sheet.key]?.length ?? 0) > 0);
  const selectedColumnCount = selectedSheets.reduce((sum, sheet) => sum + (selections[sheet.key]?.length ?? 0), 0);
  const estimatedRows = selectedSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
  const selectionPayload = catalog === null ? [] : payloadOf(catalog, selections);
  const canSubmit = catalog !== null && selectionPayload.length > 0 && !loading && !exporting;
  const selectedPreset = presetState?.presets.find((preset) => preset.id === selectedPresetId) ?? null;
  const previewDefinition = selectedSheets.find((sheet) => sheet.key === previewSheet) ?? selectedSheets[0] ?? null;
  const previewSelectedColumns = previewDefinition === null ? [] : selections[previewDefinition.key] ?? [];
  const previewColumns = previewDefinition === null
    ? []
    : previewDefinition.columns.filter((column) => column.allowed && previewSelectedColumns.includes(column.key));
  const previewRows = previewDefinition?.previewRows ?? [];

  const toggleSheet = (sheet: PageExportCatalogSheet, checked: boolean): void => {
    setSelections((previous) => {
      const next = { ...previous };
      if (checked) next[sheet.key] = defaultColumnsOf(sheet);
      else delete next[sheet.key];
      return next;
    });
    if (checked) setPreviewSheet(sheet.key);
    setFeedback(null);
  };

  const toggleColumn = (sheet: PageExportCatalogSheet, columnKey: string, checked: boolean): void => {
    setSelections((previous) => {
      const current = previous[sheet.key];
      if (current === undefined) return previous;
      if (!checked && current.length <= 1) return previous;
      const keys = checked ? [...current, columnKey] : current.filter((key) => key !== columnKey);
      return { ...previous, [sheet.key]: canonicalColumnsOf(sheet, keys) };
    });
    setPreviewSheet(sheet.key);
    setFeedback(null);
  };

  const validateSelection = (): string | null => {
    if (selectedSheets.length === 0) return t("pageExport.noSheets");
    for (const sheet of selectedSheets) {
      if ((selections[sheet.key]?.length ?? 0) === 0) return t("pageExport.noColumns", { sheet: sheet.label });
    }
    return null;
  };

  const reloadPreferences = async (): Promise<void> => {
    try {
      const preferences = await loadMyPreferences();
      setPresetState({
        presets: preferences.pageExportPresets ?? [],
        revision: preferences.revisions?.pageExportPresets ?? 0,
      });
    } catch {
      setPresetState({ presets: [], revision: 0 });
    }
  };

  const persistPresets = async (next: PageExportPreset[], successText: string): Promise<boolean> => {
    if (presetState === null) return false;
    setPresetBusy(true);
    setFeedback(null);
    try {
      const updated = await savePageExportPresets(next, presetState.revision);
      setPresetState({
        presets: updated.pageExportPresets ?? next,
        revision: updated.revisions?.pageExportPresets ?? presetState.revision + 1,
      });
      setFeedback({ kind: "ok", text: successText });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reloadPreferences();
        setFeedback({ kind: "error", text: t("pageExport.preset.conflict") });
      } else {
        setFeedback({ kind: "error", text: t("pageExport.preset.saveFailed", { message: messageOf(error, t("pageExport.loadFailed")) }) });
      }
      return false;
    } finally {
      setPresetBusy(false);
    }
  };

  const saveAsPreset = async (): Promise<void> => {
    const selectionError = validateSelection();
    if (selectionError !== null) {
      setFeedback({ kind: "error", text: selectionError });
      return;
    }
    if (presetState === null || catalog === null) return;
    const name = newPresetName.trim();
    if (name === "") {
      setFeedback({ kind: "error", text: t("pageExport.preset.nameRequired") });
      return;
    }
    if (name.length > 20) {
      setFeedback({ kind: "error", text: t("pageExport.preset.nameTooLong") });
      return;
    }
    if (presetState.presets.some((preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setFeedback({ kind: "error", text: t("pageExport.preset.duplicate") });
      return;
    }
    if (presetState.presets.length >= 20) {
      setFeedback({ kind: "error", text: t("pageExport.preset.limit") });
      return;
    }
    const preset: PageExportPreset = { id: presetId(), name, sheets: selectionPayload };
    if (await persistPresets([...presetState.presets, preset], t("pageExport.preset.saved"))) {
      setSelectedPresetId(preset.id);
      setNewPresetName("");
    }
  };

  const commitRename = async (): Promise<void> => {
    if (presetState === null || renameId === null) return;
    const name = renameName.trim();
    if (name === "") {
      setFeedback({ kind: "error", text: t("pageExport.preset.nameRequired") });
      return;
    }
    if (name.length > 20) {
      setFeedback({ kind: "error", text: t("pageExport.preset.nameTooLong") });
      return;
    }
    if (presetState.presets.some((preset) => preset.id !== renameId && preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setFeedback({ kind: "error", text: t("pageExport.preset.duplicate") });
      return;
    }
    const next = presetState.presets.map((preset) => preset.id === renameId ? { ...preset, name } : preset);
    if (await persistPresets(next, t("pageExport.preset.renamed"))) {
      setRenameId(null);
      setRenameName("");
    }
  };

  const deletePreset = async (): Promise<void> => {
    if (presetState === null || selectedPreset === null) return;
    if (deleteArmId !== selectedPreset.id) {
      setDeleteArmId(selectedPreset.id);
      return;
    }
    const next = presetState.presets.filter((preset) => preset.id !== selectedPreset.id);
    if (await persistPresets(next, t("pageExport.preset.deleted"))) {
      setSelectedPresetId("");
      setDeleteArmId(null);
      setRenameId(null);
    }
  };

  const applyPreset = (): void => {
    if (catalog === null || selectedPreset === null) return;
    const next: Selections = {};
    let filtered = false;
    for (const selection of selectedPreset.sheets) {
      const sheet = catalog.sheets.find((candidate) => candidate.key === selection.sheet);
      if (sheet === undefined || !sheet.allowed) {
        filtered = true;
        continue;
      }
      const allowed = allowedColumnKeys(sheet);
      const unique = [...new Set(selection.columns.filter((key) => allowed.has(key)))];
      const columns = canonicalColumnsOf(sheet, unique);
      if (columns.length === 0) {
        filtered = true;
        continue;
      }
      if (columns.length !== selection.columns.length || columns.some((key, index) => key !== selection.columns[index])) filtered = true;
      next[sheet.key] = columns;
    }
    if (Object.keys(next).length === 0) {
      setFeedback({ kind: "error", text: t("pageExport.preset.applyEmpty") });
      return;
    }
    setSelections(next);
    setPreviewSheet((catalog.sheets.find((sheet) => (next[sheet.key]?.length ?? 0) > 0) ?? null)?.key ?? null);
    setFeedback({ kind: filtered ? "info" : "ok", text: t(filtered ? "pageExport.preset.filtered" : "pageExport.preset.applied") });
  };

  const exportPages = async (): Promise<void> => {
    const selectionError = validateSelection();
    if (selectionError !== null) {
      setFeedback({ kind: "error", text: selectionError });
      return;
    }
    setExporting(true);
    setFeedback(null);
    try {
      await downloadPageExport(projectId, selectionPayload);
      setOpen(false);
    } catch (error) {
      setFeedback({ kind: "error", text: t("pageExport.exportFailed", { message: messageOf(error, t("pageExport.loadFailed")) }) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-page-export-button={initialSheet}
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
          <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("pageExport.button")}
      </button>

      {!open ? null : createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-stretch justify-center bg-zinc-950/55 sm:items-center sm:p-3 lg:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-export-title"
            data-page-export-dialog=""
            data-focus-container=""
            tabIndex={-1}
            className="flex h-full min-h-0 w-full max-w-[1540px] flex-col overflow-hidden border border-zinc-200 bg-white shadow-2xl outline-none sm:h-[calc(100vh-1.5rem)] sm:rounded-2xl lg:h-[92vh] lg:max-h-[1020px]"
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                  <path d="M5 4.5h14v15H5zM5 9h14M10 4.5v15" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="page-export-title" className="text-base font-semibold text-zinc-900 sm:text-lg">{t("pageExport.title")}</h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-zinc-500">{t("pageExport.hint")}</p>
              </div>
              <span className="mt-1 hidden shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t("pageExport.fixedChinese")}
              </span>
              <button
                type="button"
                onClick={close}
                disabled={exporting}
                aria-label={t("pageExport.close")}
                className="rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </header>

            {loading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-50">
                <div className="flex items-center gap-2.5 rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-500 shadow-sm">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-emerald-600" />
                  {t("pageExport.loading")}
                </div>
              </div>
            ) : loadError !== null ? (
              <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-50 p-6">
                <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-5 text-center shadow-sm">
                  <p className="text-sm text-rose-700">{loadError}</p>
                  <button
                    type="button"
                    onClick={() => setReloadKey((value) => value + 1)}
                    className="mt-3 rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_390px] lg:overflow-hidden">
                <section className="flex min-h-[520px] min-w-0 flex-col bg-zinc-50 p-4 sm:p-5 lg:min-h-0 lg:p-6">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-zinc-900">{t("pageExport.preview.title")}</h3>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {t("pageExport.preview.live")}
                    </span>
                  </div>

                  {selectedSheets.length === 0 ? null : (
                    <div className="mt-4 flex min-w-0 items-end gap-1 overflow-x-auto border-b border-zinc-200" role="tablist" aria-label={t("pageExport.preview.title")}>
                      {selectedSheets.map((sheet) => {
                        const active = previewDefinition?.key === sheet.key;
                        return (
                          <button
                            key={sheet.key}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            data-page-export-preview-tab={sheet.key}
                            onClick={() => setPreviewSheet(sheet.key)}
                            className={"inline-flex shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-2 text-xs font-medium transition " + (active ? "border-zinc-200 bg-white text-zinc-900 shadow-[0_-2px_8px_rgba(15,23,42,0.04)]" : "border-transparent text-zinc-500 hover:bg-white/60 hover:text-zinc-800")}
                          >
                            <span>{sheet.label}</span>
                            <span className={"rounded-full px-1.5 py-0.5 text-[10px] tabular-nums " + (active ? "bg-emerald-50 text-emerald-700" : "bg-zinc-200 text-zinc-500")}>
                              {selections[sheet.key]?.length ?? 0}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="mt-3 flex min-h-[360px] flex-1 flex-col lg:min-h-0">
                    {previewDefinition === null || previewColumns.length === 0 ? (
                      <div className="flex min-h-[360px] flex-1 items-center justify-center rounded-2xl bg-zinc-200/80 p-4 shadow-inner">
                        <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-black/5">
                          <div className="h-1 bg-[#217346]" />
                          <div className="grid grid-cols-4 gap-px bg-zinc-100 p-3">
                            {Array.from({ length: 12 }).map((_, index) => <div key={index} className="h-5 rounded-sm bg-zinc-50" />)}
                          </div>
                          <div className="border-t border-zinc-200 px-5 py-8 text-center">
                            <svg viewBox="0 0 24 24" fill="none" className="mx-auto h-8 w-8 text-zinc-300" aria-hidden="true">
                              <path d="M5 4.5h14v15H5zM5 9h14M10 4.5v15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                            </svg>
                            <p className="mt-3 text-sm text-zinc-500">{t("pageExport.preview.empty")}</p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <ExportPreview
                        sheet={previewDefinition}
                        columns={previewColumns}
                        rows={previewRows}
                        limited={previewRows.length < previewDefinition.rowCount}
                        t={t}
                      />
                    )}
                  </div>
                </section>

                <aside className="flex min-h-0 min-w-0 flex-col border-t border-zinc-200 bg-white lg:border-l lg:border-t-0">
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    <div className="space-y-4 p-4 sm:p-5">
                      {presetState === null ? null : (
                        <section className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3.5">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200">
                              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="M7 4.5h10v15l-5-3-5 3v-15Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
                            </div>
                            <h3 className="min-w-0 flex-1 text-xs font-semibold text-zinc-800">{t("pageExport.preset.title")}</h3>
                            <span className="text-[11px] tabular-nums text-zinc-400">{presetState.presets.length} / 20</span>
                          </div>
                          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <div data-page-export-preset="" className="min-w-0">
                              <SelectMenu
                                value={selectedPresetId}
                                options={[
                                  { value: "", label: t("pageExport.preset.select") },
                                  ...presetState.presets.map((preset) => ({ value: preset.id, label: preset.name })),
                                ]}
                                onChange={(value) => {
                                  setSelectedPresetId(value);
                                  setDeleteArmId(null);
                                  setRenameId(null);
                                  setFeedback(null);
                                }}
                                ariaLabel={t("pageExport.preset.select")}
                                popoverClassName="z-[80]"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={applyPreset}
                              disabled={selectedPreset === null || presetBusy}
                              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {t("pageExport.preset.apply")}
                            </button>
                          </div>

                          {selectedPreset === null ? null : (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                disabled={presetBusy}
                                onClick={() => {
                                  setRenameId(selectedPreset.id);
                                  setRenameName(selectedPreset.name);
                                  setDeleteArmId(null);
                                }}
                                className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 transition hover:bg-white hover:text-zinc-800 disabled:opacity-50"
                              >
                                {t("pageExport.preset.rename")}
                              </button>
                              <button
                                type="button"
                                disabled={presetBusy}
                                onClick={() => { void deletePreset(); }}
                                className="rounded-md px-2 py-1 text-[11px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                              >
                                {deleteArmId !== null && deleteArmId === selectedPresetId ? t("pageExport.preset.confirmDelete") : t("pageExport.preset.delete")}
                              </button>
                              {deleteArmId === null ? null : (
                                <button type="button" onClick={() => setDeleteArmId(null)} className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-white">
                                  {t("pageExport.preset.cancelDelete")}
                                </button>
                              )}
                            </div>
                          )}

                          {renameId === null ? (
                            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                              <input
                                value={newPresetName}
                                maxLength={20}
                                placeholder={t("pageExport.preset.namePlaceholder")}
                                onChange={(event) => setNewPresetName(event.target.value)}
                                className="min-w-0 rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                              />
                              <button
                                type="button"
                                disabled={presetBusy || selectionPayload.length === 0}
                                onClick={() => { void saveAsPreset(); }}
                                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {t("pageExport.preset.save")}
                              </button>
                            </div>
                          ) : (
                            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                              <input
                                value={renameName}
                                maxLength={20}
                                onChange={(event) => setRenameName(event.target.value)}
                                aria-label={t("pageExport.preset.rename")}
                                className="min-w-0 rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                              />
                              <button type="button" disabled={presetBusy} onClick={() => { void commitRename(); }} className="rounded-lg bg-zinc-900 px-2.5 py-2 text-[11px] font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
                                {t("pageExport.preset.saveName")}
                              </button>
                              <button type="button" disabled={presetBusy} onClick={() => setRenameId(null)} className="rounded-lg px-2 py-2 text-[11px] text-zinc-500 hover:bg-white disabled:opacity-50">
                                {t("pageExport.preset.cancelRename")}
                              </button>
                            </div>
                          )}
                        </section>
                      )}

                      {feedback === null ? null : (
                        <p role="alert" className={"rounded-xl border px-3 py-2 text-xs leading-5 " + (feedback.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : feedback.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-sky-200 bg-sky-50 text-sky-700")}>
                          {feedback.text}
                        </p>
                      )}

                      <section data-page-export-filter="" className="rounded-2xl border border-zinc-200 bg-white">
                        <div className="border-b border-zinc-100 px-3.5 py-3">
                          <div className="flex items-center gap-2">
                            <h3 className="min-w-0 flex-1 text-xs font-semibold text-zinc-800">{t("pageExport.filter.title")}</h3>
                            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">{t("pageExport.fixedChinese")}</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-5 text-zinc-400">{t("pageExport.filter.sheets")}</p>
                        </div>

                        <div className="space-y-2.5 p-2.5">
                          {(catalog?.sheets ?? []).map((sheet) => {
                            const chosen = selections[sheet.key];
                            const active = chosen !== undefined;
                            const count = chosen?.length ?? 0;
                            return (
                              <section key={sheet.key} data-page-export-sheet={sheet.key} className={"overflow-hidden rounded-xl border transition " + (active ? "border-emerald-200 bg-emerald-50/30 shadow-sm" : "border-zinc-200 bg-white")}>
                                <div className="flex items-center gap-2 px-2.5 py-2.5">
                                  <input
                                    type="checkbox"
                                    checked={active}
                                    disabled={!sheet.allowed || defaultColumnsOf(sheet).length === 0}
                                    onChange={(event) => toggleSheet(sheet, event.target.checked)}
                                    aria-label={sheet.label}
                                    className="h-4 w-4 shrink-0 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 disabled:cursor-not-allowed"
                                  />
                                  <button
                                    type="button"
                                    disabled={!sheet.allowed || defaultColumnsOf(sheet).length === 0}
                                    onClick={() => {
                                      if (active) setPreviewSheet(sheet.key);
                                      else toggleSheet(sheet, true);
                                    }}
                                    className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                                  >
                                    <span className="flex items-center gap-1.5">
                                      <span className="truncate text-xs font-semibold text-zinc-800">{sheet.label}</span>
                                      {active ? <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] tabular-nums text-emerald-700 ring-1 ring-emerald-100">{t("pageExport.filter.selected", { n: count })}</span> : null}
                                    </span>
                                    <span className="mt-0.5 block text-[10px] tabular-nums text-zinc-400">{t("pageExport.rowCount", { n: sheet.rowCount })}</span>
                                  </button>
                                  <svg viewBox="0 0 20 20" fill="none" className={"h-3.5 w-3.5 shrink-0 transition " + (active ? "rotate-180 text-emerald-600" : "text-zinc-300")} aria-hidden="true"><path d="m5.5 7.5 4.5 4 4.5-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                </div>

                                {!sheet.allowed ? (
                                  <p className="border-t border-zinc-100 px-3 py-5 text-center text-[11px] text-zinc-400">{t("pageExport.sheetDenied")}</p>
                                ) : active ? (
                                  <div className="border-t border-emerald-100/80 bg-white/80 p-1.5">
                                    {sheet.columns.map((column) => {
                                      const checked = chosen?.includes(column.key) ?? false;
                                      const order = checked ? (chosen?.indexOf(column.key) ?? -1) + 1 : 0;
                                      return (
                                        <label
                                          key={column.key}
                                          data-page-export-column={column.key}
                                          className={"flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs " + (column.allowed ? "cursor-pointer hover:bg-zinc-50" : "cursor-not-allowed opacity-55")}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!column.allowed || (checked && count <= 1)}
                                            onChange={(event) => toggleColumn(sheet, column.key, event.target.checked)}
                                            className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 disabled:cursor-not-allowed"
                                          />
                                          <span className="min-w-0 flex-1 truncate text-zinc-700" title={column.label}>{column.label}</span>
                                          {!column.allowed ? <span className="shrink-0 text-[10px] text-amber-600">{t("pageExport.columnDenied")}</span> : null}
                                          {checked ? <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[9px] tabular-nums text-zinc-500">{order}</span> : null}
                                        </label>
                                      );
                                    })}
                                  </div>
                                ) : null}
                              </section>
                            );
                          })}
                        </div>
                      </section>

                    </div>
                  </div>
                </aside>
              </div>
            )}

            <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-200 bg-white px-4 py-3.5 sm:px-6">
              <p data-page-export-summary="" className="text-xs tabular-nums text-zinc-500">
                {t("pageExport.summary", { sheets: selectedSheets.length, columns: selectedColumnCount, rows: estimatedRows })}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={exporting}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  data-page-export-submit=""
                  onClick={() => { void exportPages(); }}
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {exporting ? (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {exporting ? t("pageExport.submitting") : t("pageExport.submit")}
                </button>
              </div>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {!open || !exporting ? null : createPortal(
        <ExportProgressOverlay progress={null} variant="page-export" />,
        document.body,
      )}
    </>
  );
}
