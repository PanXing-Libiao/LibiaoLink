import { useEffect, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { Toast } from "./components/Toast";
import { ApiError } from "./api";
import { useT } from "./i18n";
import {
  activateSystemModel, createModelProvider, deleteModelProvider, loadModelSettings,
  loadProviderModels, updateModelProvider, type ModelProvider, type ModelSettings,
} from "./modelSettingsApi";
import type { MeResponse } from "./types";

type Form = { name: string; baseUrl: string; apiKey: string; clearApiKey: boolean };
type Notice = { kind: "ok" | "error"; text: string };
const EMPTY_FORM: Form = { name: "", baseUrl: "", apiKey: "", clearApiKey: false };
const inputClass = "mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 disabled:bg-zinc-50";
const secondaryClass = "rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = "rounded-xl bg-[#feca04] px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50";

function formOf(provider: ModelProvider): Form {
  return { name: provider.name, baseUrl: provider.baseUrl, apiKey: "", clearApiKey: false };
}

export function ModelManagementPage({ me }: { me: MeResponse }) {
  const t = useT();
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [models, setModels] = useState<string[]>([]);
  const [modelId, setModelId] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const provider = settings?.providers.find((item) => item.id === selectedId) ?? null;
  const active = settings?.active ?? null;
  const activeProvider = settings?.providers.find((item) => item.id === active?.providerId) ?? null;
  const visibleModels = models.filter((item) => item.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  const errorText = (error: unknown, fallback: string): string => error instanceof ApiError ? error.message : fallback;

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void loadModelSettings().then((data) => {
      if (cancelled) return;
      setSettings(data);
      const first = data.providers.find((item) => item.id === data.active?.providerId) ?? data.providers[0];
      if (first === undefined) {
        setCreating(true);
      } else {
        setSelectedId(first.id);
        setForm(formOf(first));
      }
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(errorText(error, t("models.loadFailed")));
    });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (selectedId === null || creating) {
      setModels([]);
      setModelId("");
      setModelsError("");
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    setModelsError("");
    setModels([]);
    setModelId("");
    void loadProviderModels(selectedId).then((result) => {
      if (cancelled) return;
      setModels(result.models);
      if (active?.providerId === selectedId && result.models.includes(active.modelId)) setModelId(active.modelId);
    }).catch((error: unknown) => {
      if (!cancelled) setModelsError(errorText(error, t("models.detectFailed")));
    }).finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [selectedId, creating, refresh]);

  function selectProvider(item: ModelProvider): void {
    setCreating(false);
    setSelectedId(item.id);
    setForm(formOf(item));
    setModelSearch("");
    if (selectedId === item.id) setRefresh((value) => value + 1);
  }

  function addProvider(): void {
    setCreating(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setModelSearch("");
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const input = { name: form.name.trim(), baseUrl: form.baseUrl.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) };
      const saved = creating
        ? await createModelProvider(input)
        : await updateModelProvider(provider!.id, { ...input, version: provider!.version, clearApiKey: form.clearApiKey });
      const next = await loadModelSettings();
      setSettings(next);
      setCreating(false);
      setSelectedId(saved.id);
      setForm(formOf(saved));
      setRefresh((value) => value + 1);
      setNotice({ kind: "ok", text: t("models.saved") });
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error, t("models.saveFailed")) });
    } finally {
      setBusy(false);
    }
  }

  async function activate(): Promise<void> {
    if (provider === null || modelId === "") return;
    setBusy(true);
    try {
      await activateSystemModel(provider.id, modelId);
      setSettings(await loadModelSettings());
      setNotice({ kind: "ok", text: t("models.activated") });
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error, t("models.activateFailed")) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (provider === null || !window.confirm(active?.providerId === provider.id ? t("models.deleteActiveConfirm") : t("models.deleteConfirm"))) return;
    setBusy(true);
    try {
      await deleteModelProvider(provider.id);
      const next = await loadModelSettings();
      setSettings(next);
      const first = next.providers.find((item) => item.id === next.active?.providerId) ?? next.providers[0];
      if (first === undefined) addProvider(); else selectProvider(first);
      setNotice({ kind: "ok", text: t("models.deleted") });
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error, t("models.deleteFailed")) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader me={me} />
      <main className="w-full px-4 pb-12 pt-4 sm:px-6" data-model-management="">
        <div className="mx-auto max-w-6xl space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">AI</p>
              <h1 className="mt-1 text-xl font-semibold text-zinc-900">{t("models.title")}</h1>
              <p className="mt-1 text-sm text-zinc-500">{t("models.subtitle")}</p>
            </div>
            <button type="button" className={primaryClass} onClick={addProvider} disabled={busy} data-model-add="">{t("models.add")}</button>
          </header>

          <section className="rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4" data-model-active="">
            <div className="text-xs font-semibold text-amber-800">{t("models.current")}</div>
            <div className="mt-1 text-sm font-medium text-zinc-900">
              {activeProvider === null || active === null ? t("models.currentEmpty") : activeProvider.name + " · " + active.modelId}
            </div>
          </section>

          {settings === null ? <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">{loadError === "" ? t("models.loading") : <div role="alert" className="flex items-center justify-between gap-4"><span className="text-rose-600">{loadError}</span><button type="button" className={secondaryClass} onClick={() => setLoadAttempt((value) => value + 1)}>{t("models.retry")}</button></div>}</div> : (
            <div className="grid gap-4 md:grid-cols-[270px_minmax(0,1fr)]">
              <aside className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
                <div className="px-2 py-2 text-xs font-semibold text-zinc-500">{t("models.services")}</div>
                {settings.providers.length === 0 ? <p className="px-2 py-4 text-sm text-zinc-400">{t("models.noServices")}</p> : (
                  <div className="space-y-1">
                    {settings.providers.map((item) => (
                      <button key={item.id} type="button" onClick={() => selectProvider(item)} disabled={busy}
                        className={"w-full rounded-xl px-3 py-3 text-left transition " + (!creating && selectedId === item.id ? "bg-amber-50 ring-1 ring-amber-200" : "hover:bg-zinc-50")}
                        data-model-provider={item.id}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-zinc-900">{item.name}</span>
                          {active?.providerId === item.id ? <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">{t("models.inUse")}</span> : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-zinc-400">{item.baseUrl}</span>
                      </button>
                    ))}
                  </div>
                )}
              </aside>

              <div className="space-y-4">
                <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" data-model-form="">
                  <h2 className="text-base font-semibold text-zinc-900">{creating ? t("models.newService") : t("models.editService")}</h2>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{t("models.serviceHint")}</p>
                  <div className="mt-5 grid gap-4">
                    <label className="text-sm font-medium text-zinc-700">
                      {t("models.name")}
                      <input className={inputClass} value={form.name} maxLength={80} disabled={busy} data-model-name=""
                        onChange={(event) => setForm({ ...form, name: event.target.value })} />
                    </label>
                    <label className="text-sm font-medium text-zinc-700">
                      {t("models.endpoint")}
                      <input className={inputClass} value={form.baseUrl} maxLength={500} disabled={busy} placeholder="https://example.com/v1" data-model-url=""
                        onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
                    </label>
                    <label className="text-sm font-medium text-zinc-700">
                      {t("models.key")}
                      <input className={inputClass} type="password" autoComplete="new-password" value={form.apiKey} maxLength={1024}
                        disabled={busy || form.clearApiKey} data-model-key="" placeholder={provider?.hasApiKey && !creating ? t("models.keySaved") : t("models.keyOptional")}
                        onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
                    </label>
                    {!creating && provider?.hasApiKey ? (
                      <label className="flex items-center gap-2 text-xs text-zinc-600">
                        <input type="checkbox" checked={form.clearApiKey} disabled={busy}
                          onChange={(event) => setForm({ ...form, clearApiKey: event.target.checked, apiKey: "" })} />
                        {t("models.clearKey")}
                      </label>
                    ) : null}
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    {!creating && provider !== null ? <button type="button" className="text-sm text-rose-600 hover:text-rose-700 disabled:opacity-50" disabled={busy} onClick={() => { void remove(); }}>{t("models.delete")}</button> : <span />}
                    <button type="button" className={primaryClass} disabled={busy || form.name.trim() === "" || form.baseUrl.trim() === ""} onClick={() => { void save(); }} data-model-save="">{t("models.save")}</button>
                  </div>
                </section>

                {!creating && provider !== null ? (
                  <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" data-model-list="">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold text-zinc-900">{t("models.available")}</h2>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">{t("models.availableHint")}</p>
                      </div>
                      <button type="button" className={secondaryClass} disabled={busy || loadingModels} onClick={() => setRefresh((value) => value + 1)}>{t("models.refresh")}</button>
                    </div>
                    {loadingModels ? <p className="mt-4 text-sm text-zinc-500">{t("models.detecting")}</p> :
                      modelsError ? <p className="mt-4 text-sm text-rose-600" role="alert">{modelsError}</p> :
                        models.length === 0 ? <p className="mt-4 text-sm text-zinc-400">{t("models.noneFound")}</p> : (
                          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                            <label className="text-xs font-medium text-zinc-600">{t("models.search")}
                              <input className={inputClass} value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />
                            </label>
                            <label className="text-xs font-medium text-zinc-600">{t("models.choose")}
                              <select className={inputClass} value={modelId} onChange={(event) => setModelId(event.target.value)} data-model-select="">
                                <option value="">{t("models.choosePlaceholder")}</option>
                                {visibleModels.map((model) => <option key={model} value={model}>{model}</option>)}
                                {modelId !== "" && !visibleModels.includes(modelId) ? <option value={modelId}>{modelId}</option> : null}
                              </select>
                            </label>
                            <button type="button" className={primaryClass} disabled={busy || modelId === "" || (active?.providerId === provider.id && active.modelId === modelId)}
                              onClick={() => { void activate(); }} data-model-activate="">{t("models.use")}</button>
                          </div>
                        )}
                  </section>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </main>
      {notice === null ? null : <Toast kind={notice.kind} text={notice.text} onClose={() => setNotice(null)} />}
    </>
  );
}
