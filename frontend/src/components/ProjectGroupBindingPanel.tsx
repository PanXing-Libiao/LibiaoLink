/**
 * 项目群绑定（设置页 · 业务口径 2026-10-19「先选择项目再绑定」）。
 *
 * 交互顺序固定：先选项目 -> 读群状态与自动发现候选。未绑定 / 换绑时优先从候选群中点选；
 * 候选不存在时才使用折叠的手工 chatid 兜底入口。读面只显示群标识末 4 位。
 * 写权限由服务端 project.update 裁决；前端不按猜测隐藏入口，403 走明确 Toast。
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import { useT, type TextKey } from "../i18n";
import { fetchProjectList, formatDateTime, type ApiProject } from "../projectApi";
import {
  deleteProjectGroup,
  fetchProjectGroup,
  fetchProjectGroupCandidates,
  putProjectGroup,
  type ProjectGroupBinding,
  type ProjectGroupCandidate,
} from "../projectGroupApi";
import { EMPTY_LIST_QUERY } from "../useHashRoute";
import { SearchSelect } from "./SearchSelect";
import type { BindingNotice } from "./WecomBindingPanel";

const fieldClass =
  "block w-full appearance-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400";

const primaryButtonClass =
  "rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300";

const secondaryButtonClass =
  "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-60";

const dangerButtonClass =
  "rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-95 disabled:opacity-60";

type Busy = "bind" | "unbind" | "refresh" | null;

const CHATID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function ProjectGroupBindingPanel({ onNotice }: { onNotice: (notice: BindingNotice) => void }) {
  const t = useT();
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [projectsReloadKey, setProjectsReloadKey] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [group, setGroup] = useState<ProjectGroupBinding | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupLoadFailed, setGroupLoadFailed] = useState(false);
  const [groupReloadKey, setGroupReloadKey] = useState(0);
  const [candidates, setCandidates] = useState<ProjectGroupCandidate[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesLoadFailed, setCandidatesLoadFailed] = useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);
  const [chatid, setChatid] = useState("");
  const [editingBinding, setEditingBinding] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setProjectsFailed(false);
    void fetchProjectList(EMPTY_LIST_QUERY)
      .then((result) => {
        if (!cancelled) {
          setProjects(result.items.filter((project) => project.status !== "archived"));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectsReloadKey]);

  useEffect(() => {
    if (selectedProjectId === "") {
      setGroup(null);
      setGroupLoading(false);
      setGroupLoadFailed(false);
      setCandidates(null);
      setCandidatesLoading(false);
      setCandidatesLoadFailed(false);
      return;
    }
    const controller = new AbortController();
    setGroup(null);
    setGroupLoading(true);
    setGroupLoadFailed(false);
    setCandidates(null);
    setCandidatesLoading(true);
    setCandidatesLoadFailed(false);
    setSelectedCandidateId(null);
    setConfirmUnbind(false);
    setEditingBinding(false);
    setChatid("");
    void fetchProjectGroup(selectedProjectId, controller.signal)
      .then((next) => {
        setGroup(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setGroupLoadFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setGroupLoading(false);
        }
      });
    void fetchProjectGroupCandidates(selectedProjectId, controller.signal)
      .then((result) => {
        setCandidates(result.items);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCandidatesLoadFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCandidatesLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [selectedProjectId, groupReloadKey]);

  const projectOptions = useMemo(
    () => (projects ?? []).map((project) => ({ value: project.id, label: project.code + " · " + project.name })),
    [projects],
  );
  const selectedProject =
    projects === null ? null : projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedCandidate =
    candidates === null
      ? null
      : candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;

  const errorText = (error: unknown, fallback: TextKey): string => {
    if (error instanceof ApiError) {
      if (error.status === 403) {
        return t("settings.group.forbidden");
      }
      if (error.code === "PROJECT_ARCHIVED") {
        return t("settings.group.archived");
      }
      if (error.status === 404) {
        return t("settings.group.notFound");
      }
      if (error.status === 400 || error.code === "VALIDATION_FAILED") {
        return t("settings.group.validationFailed");
      }
    }
    return t(fallback);
  };

  const resetCandidateSelection = (): void => {
    setSelectedCandidateId(null);
  };

  const handleProjectChange = (projectId: string): void => {
    setSelectedProjectId(projectId);
    setChatid("");
    resetCandidateSelection();
    setEditingBinding(false);
    setConfirmUnbind(false);
  };

  const handleStartRebind = (): void => {
    setEditingBinding(true);
    setChatid("");
    resetCandidateSelection();
    setConfirmUnbind(false);
  };

  const handleCancelRebind = (): void => {
    setEditingBinding(false);
    setChatid("");
    resetCandidateSelection();
  };

  const handleSelectCandidate = (candidate: ProjectGroupCandidate): void => {
    setSelectedCandidateId(candidate.id);
  };

  const handleBindCandidate = async (): Promise<void> => {
    if (selectedProjectId === "" || selectedCandidate === null || busy !== null) {
      if (selectedCandidate === null) {
        onNotice({ kind: "error", text: t("settings.group.noCandidateSelected") });
      }
      return;
    }
    setBusy("bind");
    try {
      const next = await putProjectGroup(selectedProjectId, { candidateId: selectedCandidate.id });
      setGroup(next);
      setCandidates((current) => current?.filter((candidate) => candidate.id !== selectedCandidate.id) ?? current);
      resetCandidateSelection();
      setEditingBinding(false);
      setConfirmUnbind(false);
      onNotice({ kind: "ok", text: next.activated ? t("settings.group.bindOk") : t("settings.group.bindOkPending") });
    } catch (error) {
      onNotice({ kind: "error", text: errorText(error, "settings.group.bindFailed") });
    } finally {
      setBusy(null);
    }
  };

  const handleBindManual = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selectedProjectId === "" || busy !== null) {
      return;
    }
    const nextChatid = chatid.trim();
    if (!CHATID_RE.test(nextChatid)) {
      onNotice({ kind: "error", text: t("settings.group.invalidChatid") });
      return;
    }
    setBusy("bind");
    try {
      const next = await putProjectGroup(selectedProjectId, { chatid: nextChatid });
      setGroup(next);
      setEditingBinding(false);
      setChatid("");
      resetCandidateSelection();
      setConfirmUnbind(false);
      onNotice({ kind: "ok", text: next.activated ? t("settings.group.bindOk") : t("settings.group.bindOkPending") });
    } catch (error) {
      onNotice({ kind: "error", text: errorText(error, "settings.group.bindFailed") });
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async (): Promise<void> => {
    if (selectedProjectId === "" || busy !== null) {
      return;
    }
    setBusy("refresh");
    const [groupResult, candidatesResult] = await Promise.allSettled([
      fetchProjectGroup(selectedProjectId),
      fetchProjectGroupCandidates(selectedProjectId),
    ]);
    let groupOk = false;
    if (groupResult.status === "fulfilled") {
      setGroup(groupResult.value);
      setGroupLoadFailed(false);
      groupOk = true;
    } else {
      onNotice({ kind: "error", text: errorText(groupResult.reason, "settings.group.loadFailed") });
    }
    if (candidatesResult.status === "fulfilled") {
      setCandidates(candidatesResult.value.items);
      setCandidatesLoadFailed(false);
      if (!candidatesResult.value.items.some((candidate) => candidate.id === selectedCandidateId)) {
        resetCandidateSelection();
      }
    } else {
      setCandidatesLoadFailed(true);
    }
    if (groupOk) {
      onNotice({ kind: "ok", text: t("settings.group.refreshed") });
    }
    setBusy(null);
  };

  const handleUnbind = async (): Promise<void> => {
    if (selectedProjectId === "" || busy !== null) {
      return;
    }
    setBusy("unbind");
    try {
      const next = await deleteProjectGroup(selectedProjectId);
      setGroup(next);
      setEditingBinding(false);
      setChatid("");
      resetCandidateSelection();
      setConfirmUnbind(false);
      onNotice({ kind: "ok", text: t("settings.group.unbindOk") });
    } catch (error) {
      onNotice({ kind: "error", text: errorText(error, "settings.group.unbindFailed") });
    } finally {
      setBusy(null);
    }
  };

  const loadingProjects = projects === null && !projectsFailed;
  const noProjects = projects !== null && projects.length === 0;
  const bound = group !== null && group.bound;
  const showBindingControls = selectedProject !== null && group !== null && !groupLoadFailed && (!bound || editingBinding);

  return (
    <section data-project-group-binding="" data-project-group-busy={busy ?? "idle"} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-900">{t("settings.group.title")}</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{t("settings.group.desc")}</p>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-zinc-700">{t("settings.group.projectLabel")}</span>
        <div data-project-group-select="">
          <SearchSelect
            ariaLabel={t("settings.group.projectLabel")}
            options={projectOptions}
            value={selectedProjectId}
            onChange={handleProjectChange}
            placeholder={
              loadingProjects
                ? t("settings.group.loadingProjects")
                : projectsFailed
                  ? t("settings.group.projectsFailed")
                  : t("settings.group.projectPlaceholder")
            }
            searchPlaceholder={t("settings.group.projectSearchPlaceholder")}
            disabled={loadingProjects || projectsFailed || busy !== null}
          />
        </div>
      </label>

      {projectsFailed ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          <span>{t("settings.group.projectsFailed")}</span>
          <button
            type="button"
            data-project-group-projects-retry=""
            onClick={() => {
              setProjectsReloadKey((value) => value + 1);
            }}
            className={secondaryButtonClass}
          >
            {t("settings.group.retry")}
          </button>
        </div>
      ) : null}

      {noProjects ? <p className="text-xs text-zinc-500">{t("settings.group.noProjects")}</p> : null}

      {selectedProjectId === "" ? (
        <p data-project-group-order-hint="" className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-3 text-xs text-zinc-500">
          {t("settings.group.selectFirst")}
        </p>
      ) : null}

      {selectedProject === null ? null : (
        <div
          data-project-group-state={groupLoading ? "loading" : groupLoadFailed ? "error" : bound ? "bound" : "unbound"}
          className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4"
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-xs font-semibold text-zinc-600">{selectedProject.code}</span>
            <span className="truncate text-sm font-medium text-zinc-900">{selectedProject.name}</span>
          </div>

          {groupLoading ? <p className="mt-3 text-xs text-zinc-400">{t("settings.group.loading")}</p> : null}

          {groupLoadFailed ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-xs text-rose-600">{t("settings.group.loadFailed")}</span>
              <button
                type="button"
                data-project-group-state-retry=""
                disabled={busy !== null}
                onClick={() => {
                  setGroupReloadKey((value) => value + 1);
                }}
                className={secondaryButtonClass}
              >
                {t("settings.group.retry")}
              </button>
            </div>
          ) : null}

          {bound && !editingBinding ? (
            <div data-project-group-bound="true" className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  {t("settings.group.bound")}
                </span>
                <span
                  data-project-group-activation={group.activated ? "active" : "pending"}
                  className={
                    "rounded-full border px-2 py-0.5 text-xs font-medium " +
                    (group.activated
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700")
                  }
                >
                  {group.activated ? t("settings.group.activated") : t("settings.group.pending")}
                </span>
                {group.chatidMasked === null ? null : (
                  <span data-project-group-chatid-masked="" className="font-mono text-xs text-zinc-500">
                    {t("settings.group.chatidMasked", { mask: group.chatidMasked })}
                  </span>
                )}
              </div>
              {group.name === null ? null : <p className="text-sm text-zinc-800">{group.name}</p>}
              {group.updatedAt === null ? null : (
                <p data-project-group-updated-at="" className="text-xs text-zinc-500">
                  {t("settings.group.updatedAt", { time: formatDateTime(group.updatedAt) })}
                </p>
              )}
              {group.activated ? null : (
                <p data-project-group-activation-hint="" className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800">
                  {t("settings.group.activationHint")}
                </p>
              )}
              {confirmUnbind ? (
                <div data-project-group-unbind-confirm="" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2">
                  <span className="text-xs text-red-700">{t("settings.group.unbindAsk")}</span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleUnbind()}
                    className={dangerButtonClass}
                  >
                    {busy === "unbind" ? t("settings.group.unbinding") : t("settings.group.unbindConfirm")}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmUnbind(false);
                    }}
                    className={secondaryButtonClass}
                  >
                    {t("settings.group.cancel")}
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    data-project-group-refresh=""
                    disabled={busy !== null}
                    onClick={() => void handleRefresh()}
                    className={secondaryButtonClass}
                  >
                    {busy === "refresh" ? t("settings.group.refreshing") : t("settings.group.refresh")}
                  </button>
                  <button
                    type="button"
                    data-project-group-rebind=""
                    disabled={busy !== null}
                    onClick={handleStartRebind}
                    className={secondaryButtonClass}
                  >
                    {t("settings.group.rebind")}
                  </button>
                  <button
                    type="button"
                    data-project-group-unbind=""
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmUnbind(true);
                    }}
                    className={secondaryButtonClass}
                  >
                    {t("settings.group.unbind")}
                  </button>
                </div>
              )}
              {group.activated ? null : (
                <p className="text-[11px] leading-5 text-zinc-500">{t("settings.group.activationRefreshHint")}</p>
              )}
            </div>
          ) : null}

          {showBindingControls ? (
            <div className={bound ? "mt-4 border-t border-zinc-200 pt-4" : "mt-3"}>
              {bound ? (
                <p className="mb-3 text-xs text-zinc-500">
                  {t("settings.group.currentBinding", { mask: group.chatidMasked ?? "" })}
                </p>
              ) : null}

              <div data-project-group-candidates="" className="rounded-xl border border-zinc-200 bg-white p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-zinc-900">{t("settings.group.candidatesTitle")}</p>
                    <p className="mt-0.5 text-[11px] leading-5 text-zinc-500">{t("settings.group.candidatesHint")}</p>
                  </div>
                  <button
                    type="button"
                    data-project-group-candidates-refresh=""
                    disabled={busy !== null || candidatesLoading}
                    onClick={() => void handleRefresh()}
                    className={secondaryButtonClass}
                  >
                    {busy === "refresh" ? t("settings.group.refreshing") : t("settings.group.refreshCandidates")}
                  </button>
                </div>

                {candidatesLoading ? (
                  <p className="mt-3 text-xs text-zinc-400">{t("settings.group.candidatesLoading")}</p>
                ) : null}
                {candidatesLoadFailed ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-2">
                    <span className="text-xs text-rose-700">{t("settings.group.candidatesFailed")}</span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setGroupReloadKey((value) => value + 1);
                      }}
                      className={secondaryButtonClass}
                    >
                      {t("settings.group.retry")}
                    </button>
                  </div>
                ) : null}
                {!candidatesLoading && !candidatesLoadFailed && candidates !== null && candidates.length === 0 ? (
                  <p data-project-group-candidates-empty="" className="mt-3 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-500">
                    {t("settings.group.noCandidates")}
                  </p>
                ) : null}

                {!candidatesLoading && !candidatesLoadFailed && candidates !== null && candidates.length > 0 ? (
                  <div role="radiogroup" aria-label={t("settings.group.candidatesTitle")} className="mt-3 space-y-2">
                    {candidates.map((candidate) => {
                      const selected = candidate.id === selectedCandidateId;
                      return (
                        <label
                          key={candidate.id}
                          data-project-group-candidate={String(candidate.id)}
                          className={
                            "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition " +
                            (selected
                              ? "border-blue-300 bg-blue-50/70 ring-1 ring-blue-200"
                              : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50")
                          }
                        >
                          <input
                            type="radio"
                            name="project-group-candidate"
                            className="mt-1 h-4 w-4 border-zinc-300 text-blue-600 focus:ring-blue-500"
                            checked={selected}
                            disabled={busy !== null}
                            onChange={() => {
                              handleSelectCandidate(candidate);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-zinc-900">
                              {candidate.name ?? t("settings.group.candidateUnknownName")}
                            </span>
                            <span className="mt-0.5 block font-mono text-[11px] text-zinc-500">
                              {t("settings.group.candidateMeta", {
                                mask: candidate.chatidMasked,
                                time: formatDateTime(candidate.lastSeenAt),
                              })}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                {selectedCandidate === null ? null : (
                  <div className="mt-3 border-t border-zinc-100 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-project-group-candidate-bind=""
                        disabled={busy !== null}
                        onClick={() => void handleBindCandidate()}
                        className={primaryButtonClass}
                      >
                        {busy === "bind" ? t("settings.group.binding") : t("settings.group.bindSelected")}
                      </button>
                      {bound ? (
                        <button type="button" disabled={busy !== null} onClick={handleCancelRebind} className={secondaryButtonClass}>
                          {t("settings.group.cancel")}
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[11px] leading-5 text-zinc-500">{t("settings.group.candidateSelectedHint")}</p>
                  </div>
                )}
              </div>

              <details data-project-group-manual="" className="mt-3 rounded-xl border border-zinc-200 bg-white px-3.5 py-3">
                <summary className="cursor-pointer select-none text-xs font-medium text-zinc-600">
                  {t("settings.group.manualToggle")}
                </summary>
                <form className="mt-3" onSubmit={(event) => void handleBindManual(event)}>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-zinc-700">{t("settings.group.chatidLabel")}</span>
                    <input
                      data-project-group-chatid=""
                      className={fieldClass + " font-mono"}
                      value={chatid}
                      maxLength={128}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={t("settings.group.chatidPlaceholder")}
                      onChange={(event) => {
                        setChatid(event.target.value);
                      }}
                    />
                  </label>
                  <p className="mt-2 text-[11px] leading-5 text-zinc-500">{t("settings.group.chatidHint")}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="submit" data-project-group-bind="" disabled={busy !== null} className={primaryButtonClass}>
                      {busy === "bind"
                        ? t("settings.group.binding")
                        : bound
                          ? t("settings.group.rebindSubmit")
                          : t("settings.group.bind")}
                    </button>
                    {bound ? (
                      <button type="button" disabled={busy !== null} onClick={handleCancelRebind} className={secondaryButtonClass}>
                        {t("settings.group.cancel")}
                      </button>
                    ) : null}
                  </div>
                </form>
              </details>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
