import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api";
import { fieldText, textOf, useLocale, useT } from "../i18n";
import {
  downloadPageExport,
  fetchPageExportCatalog,
  type PageExportCatalogSheet,
  type PageExportCatalogResponse,
  type PageExportPreset,
  type PageExportSheetKey,
  type PageExportSheetSelection,
} from "../pageExportApi";
import { hasPermission, useMyPermissions } from "../permissions";
import { loadMyPreferences, savePageExportPresets } from "../preferencesApi";
import { lockBodyScroll } from "../scrollLock";
import { useFocusTrapFor } from "./useFocusTrap";

type PageExportButtonProps = {
  projectId: string;
  /** 当前页面所在的 Sheet：打开时默认勾选，其余页面仍可加入同一个工作簿。 */
  initialSheet: PageExportSheetKey;
};

type Feedback = { kind: "ok" | "error" | "info"; text: string };
type Selections = Partial<Record<PageExportSheetKey, string[]>>;
type PresetState = { presets: PageExportPreset[]; revision: number };

function sheetLabel(locale: ReturnType<typeof useLocale>, sheet: PageExportCatalogSheet): string {
  if (sheet.key === "reports") return textOf(locale, "report.records.title");
  if (sheet.key === "issues") return textOf(locale, "report.issues.title");
  return fieldText(locale, sheet.label);
}

function allowedColumnKeys(sheet: PageExportCatalogSheet): Set<string> {
  return new Set(sheet.columns.filter((column) => column.allowed).map((column) => column.key));
}

function defaultColumnsOf(sheet: PageExportCatalogSheet): string[] {
  const allowed = allowedColumnKeys(sheet);
  const defaults = sheet.defaultColumns.filter((key) => allowed.has(key));
  if (defaults.length > 0) return defaults;
  return sheet.columns.filter((column) => column.allowed).slice(0, 1).map((column) => column.key);
}

function payloadOf(catalog: PageExportCatalogResponse, selections: Selections): PageExportSheetSelection[] {
  const payload: PageExportSheetSelection[] = [];
  for (const sheet of catalog.sheets) {
    const selected = selections[sheet.key];
    if (!sheet.allowed || selected === undefined) continue;
    const allowed = allowedColumnKeys(sheet);
    const columns = selected.filter((key) => allowed.has(key));
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

/**
 * 页面级 Excel 导出入口（日报记录 / 问题追踪 / 干系人共用一个弹窗）。
 * 弹窗打开时读取服务端列目录：Sheet / 列可用性由当前账号权限决定；每个 Sheet 独立勾选、排序；
 * 生成一个多 Sheet xlsx。导出方案走 user_preferences.prefs.pageExportPresets（跨项目 / 跨设备）。
 */
export function PageExportButton({ projectId, initialSheet }: PageExportButtonProps) {
  const t = useT();
  const locale = useLocale();
  const permissions = useMyPermissions();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<PageExportCatalogResponse | null>(null);
  const [selections, setSelections] = useState<Selections>({});
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

  if (!hasPermission(permissions, "project.export")) return null;

  const selectedSheets = (catalog?.sheets ?? []).filter((sheet) => sheet.allowed && (selections[sheet.key]?.length ?? 0) > 0);
  const selectedColumnCount = selectedSheets.reduce((sum, sheet) => sum + (selections[sheet.key]?.length ?? 0), 0);
  const estimatedRows = selectedSheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
  const selectionPayload = catalog === null ? [] : payloadOf(catalog, selections);
  const canSubmit = catalog !== null && selectionPayload.length > 0 && !loading && !exporting;
  const selectedPreset = presetState?.presets.find((preset) => preset.id === selectedPresetId) ?? null;

  const toggleSheet = (sheet: PageExportCatalogSheet, checked: boolean): void => {
    setSelections((previous) => {
      const next = { ...previous };
      if (checked) next[sheet.key] = defaultColumnsOf(sheet);
      else delete next[sheet.key];
      return next;
    });
    setFeedback(null);
  };

  const toggleColumn = (sheet: PageExportCatalogSheet, columnKey: string, checked: boolean): void => {
    setSelections((previous) => {
      const current = previous[sheet.key];
      if (current === undefined) return previous;
      if (!checked && current.length <= 1) return previous;
      const next = checked ? [...current, columnKey] : current.filter((key) => key !== columnKey);
      return { ...previous, [sheet.key]: next };
    });
    setFeedback(null);
  };

  const moveColumn = (sheetKey: PageExportSheetKey, columnKey: string, offset: -1 | 1): void => {
    setSelections((previous) => {
      const current = previous[sheetKey];
      if (current === undefined) return previous;
      const from = current.indexOf(columnKey);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= current.length) return previous;
      const next = [...current];
      const moving = next[from];
      const target = next[to];
      if (moving === undefined || target === undefined) return previous;
      next[from] = target;
      next[to] = moving;
      return { ...previous, [sheetKey]: next };
    });
  };

  const validateSelection = (): string | null => {
    if (selectedSheets.length === 0) return t("pageExport.noSheets");
    for (const sheet of selectedSheets) {
      if ((selections[sheet.key]?.length ?? 0) === 0) return t("pageExport.noColumns", { sheet: sheetLabel(locale, sheet) });
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
      const columns = [...new Set(selection.columns.filter((key) => allowed.has(key)))];
      if (columns.length === 0) {
        filtered = true;
        continue;
      }
      if (columns.length !== selection.columns.length) filtered = true;
      next[sheet.key] = columns;
    }
    if (Object.keys(next).length === 0) {
      setFeedback({ kind: "error", text: t("pageExport.preset.applyEmpty") });
      return;
    }
    setSelections(next);
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
          className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-zinc-900/45 p-3 sm:p-6"
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
            className="my-auto w-full max-w-6xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none"
          >
            <header className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id="page-export-title" className="text-base font-semibold text-zinc-900">{t("pageExport.title")}</h2>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{t("pageExport.hint")}</p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={exporting}
                aria-label={t("pageExport.close")}
                className="ml-auto rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </header>

            <div className="max-h-[calc(100vh-13rem)] overflow-y-auto overscroll-contain px-5 py-4">
              {loading ? (
                <div className="py-16 text-center text-sm text-zinc-500">{t("pageExport.loading")}</div>
              ) : loadError !== null ? (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  <span>{loadError}</span>
                  <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs font-medium hover:bg-rose-100">
                    {t("common.retry")}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {presetState === null ? null : (
                    <section className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3.5">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3 className="text-xs font-semibold text-zinc-700">{t("pageExport.preset.title")}</h3>
                        <span className="text-[11px] text-zinc-400">{presetState.presets.length} / 20</span>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            data-page-export-preset=""
                            value={selectedPresetId}
                            onChange={(event) => {
                              setSelectedPresetId(event.target.value);
                              setDeleteArmId(null);
                              setRenameId(null);
                              setFeedback(null);
                            }}
                            className="min-w-48 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                          >
                            <option value="">{t("pageExport.preset.select")}</option>
                            {presetState.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                          </select>
                          <button type="button" onClick={applyPreset} disabled={selectedPreset === null || presetBusy} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50">
                            {t("pageExport.preset.apply")}
                          </button>
                          <button
                            type="button"
                            disabled={selectedPreset === null || presetBusy}
                            onClick={() => {
                              if (selectedPreset === null) return;
                              setRenameId(selectedPreset.id);
                              setRenameName(selectedPreset.name);
                              setDeleteArmId(null);
                            }}
                            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t("pageExport.preset.rename")}
                          </button>
                          <button
                            type="button"
                            disabled={selectedPreset === null || presetBusy}
                            onClick={() => { void deletePreset(); }}
                            className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {deleteArmId !== null && deleteArmId === selectedPresetId ? t("pageExport.preset.confirmDelete") : t("pageExport.preset.delete")}
                          </button>
                          {deleteArmId === null ? null : (
                            <button type="button" onClick={() => setDeleteArmId(null)} className="rounded-lg px-2 py-2 text-xs text-zinc-500 hover:bg-zinc-100">
                              {t("pageExport.preset.cancelDelete")}
                            </button>
                          )}
                        </div>

                        {renameId === null ? null : (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={renameName}
                              maxLength={20}
                              onChange={(event) => setRenameName(event.target.value)}
                              className="min-w-48 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                            />
                            <button type="button" disabled={presetBusy} onClick={() => { void commitRename(); }} className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
                              {t("pageExport.preset.saveName")}
                            </button>
                            <button type="button" disabled={presetBusy} onClick={() => setRenameId(null)} className="rounded-lg px-2 py-2 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50">
                              {t("pageExport.preset.cancelRename")}
                            </button>
                          </div>
                        )}

                        {renameId !== null ? null : (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={newPresetName}
                              maxLength={20}
                              placeholder={t("pageExport.preset.namePlaceholder")}
                              onChange={(event) => setNewPresetName(event.target.value)}
                              className="min-w-48 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                            />
                            <button type="button" disabled={presetBusy || selectionPayload.length === 0} onClick={() => { void saveAsPreset(); }} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50">
                              {t("pageExport.preset.save")}
                            </button>
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {feedback === null ? null : (
                    <p role="alert" className={"rounded-lg border px-3 py-2 text-xs " + (feedback.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : feedback.kind === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-sky-200 bg-sky-50 text-sky-700")}>
                      {feedback.text}
                    </p>
                  )}

                  <div className="grid gap-3 lg:grid-cols-3">
                    {(catalog?.sheets ?? []).map((sheet) => {
                      const selected = selections[sheet.key];
                      const active = selected !== undefined;
                      const label = sheetLabel(locale, sheet);
                      return (
                        <section key={sheet.key} data-page-export-sheet={sheet.key} className={"min-w-0 rounded-xl border bg-white " + (active ? "border-zinc-300 shadow-sm" : "border-zinc-200")}>
                          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={active}
                              disabled={!sheet.allowed || defaultColumnsOf(sheet).length === 0}
                              onChange={(event) => toggleSheet(sheet, event.target.checked)}
                              aria-label={label}
                              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 disabled:cursor-not-allowed"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800" title={label}>{label}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{t("pageExport.rowCount", { n: sheet.rowCount })}</span>
                          </div>
                          {!sheet.allowed ? (
                            <p className="px-3 py-8 text-center text-xs text-zinc-400">{t("pageExport.sheetDenied")}</p>
                          ) : (
                            <div className="max-h-72 space-y-0.5 overflow-y-auto p-1.5">
                              {sheet.columns.map((column) => {
                                const checked = selected?.includes(column.key) ?? false;
                                const order = checked ? (selected?.indexOf(column.key) ?? -1) : -1;
                                const columnLabel = fieldText(locale, column.label);
                                return (
                                  <div key={column.key} className={"flex items-center gap-1.5 rounded-lg px-2 py-1.5 " + (column.allowed ? "hover:bg-zinc-50" : "opacity-55")}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={!active || !column.allowed || (checked && (selected?.length ?? 0) <= 1)}
                                      onChange={(event) => toggleColumn(sheet, column.key, event.target.checked)}
                                      aria-label={columnLabel}
                                      className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 disabled:cursor-not-allowed"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-700" title={columnLabel}>{columnLabel}</span>
                                    {!column.allowed ? <span className="shrink-0 text-[10px] text-amber-600">{t("pageExport.columnDenied")}</span> : null}
                                    {checked ? <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{order + 1}</span> : null}
                                    {checked ? (
                                      <span className="flex shrink-0 items-center">
                                        <button type="button" disabled={order === 0} onClick={() => moveColumn(sheet.key, column.key, -1)} aria-label={t("pageExport.moveUp", { name: columnLabel })} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25">
                                          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="m5.5 12 4.5-4 4.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                        </button>
                                        <button type="button" disabled={order === (selected?.length ?? 0) - 1} onClick={() => moveColumn(sheet.key, column.key, 1)} aria-label={t("pageExport.moveDown", { name: columnLabel })} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25">
                                          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="m5.5 8 4.5 4 4.5-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                        </button>
                                      </span>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>

                  <p className="text-[11px] leading-5 text-zinc-400">{t("pageExport.note")}</p>
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-200 px-5 py-3.5">
              <p className="text-xs tabular-nums text-zinc-500">{t("pageExport.summary", { sheets: selectedSheets.length, columns: selectedColumnCount, rows: estimatedRows })}</p>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={close} disabled={exporting} className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50">
                  {t("common.cancel")}
                </button>
                <button type="button" data-page-export-submit="" onClick={() => { void exportPages(); }} disabled={!canSubmit} className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {exporting ? t("pageExport.submitting") : t("pageExport.submit")}
                </button>
              </div>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
