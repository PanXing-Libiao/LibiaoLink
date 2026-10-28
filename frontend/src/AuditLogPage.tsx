import { useMyPermissions } from "./permissions";
import { useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "./useLiveRefresh";
import { keepLiveOrder } from "./liveSync";
import { ApiError } from "./api";
import { AppHeader } from "./components/AppHeader";
import { DateRangePicker, type DateRange } from "./components/DateRangePicker";
import { Loader } from "./components/Loader";
import { SearchInput } from "./components/SearchInput";
import { SearchSelect } from "./components/SearchSelect";
import type { DirectoryUser } from "./directory";
import { fetchProjectList, formatDateTime, type ApiProject } from "./projectApi";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_LABELS,
  AUDIT_RESULTS,
  AUDIT_RESULT_LABELS,
  auditLabelOf,
  fetchAuditLogs,
  type AuditLogListResult,
} from "./auditApi";
import {
  AUDIT_CHANGE_LINE_LIMIT,
  auditChangeLines,
  auditObjectText,
  auditSummaryText,
  type AuditFormatContext,
} from "./auditFormat";
import { EMPTY_AUDIT_QUERY, EMPTY_LIST_QUERY, type AuditQueryState } from "./useHashRoute";
import type { MeResponse } from "./types";

/**
 * 操作记录页（C7-04 · u12 · 2026-10-08；2026-10-25 起对登录账号开放）。
 * 入口 = 右上角头像菜单「操作记录」（所有登录账号可见；服务端逐请求按 auditScope 决定范围）。
 * 口径：全站关键操作留痕（谁 / 何时 / 动作 / 对象 / 摘要 / 结果），occurredAt 倒序、分页 50；
 * 筛选 = 关键字（Push 260 搜索：操作内容 / 操作人姓名，250ms 防抖）/ 操作人 / 动作 / 对象类型 / 结果 / 项目 / 时间区间 ——
 * 与首页列表同一套「地址即状态」（useHashRoute 的 AuditQueryState，可分享 / 可收藏 / 刷新不丢）。
 * 越权尝试（result=denied）在结果列一眼可见（C7-03）。
 * 失败口径：403 = 当前会话无权读取（页面给兜底提示）；其余错误给「重试」。
 */

type AuditPageState =
  | { kind: "loading" }
  | { kind: "error"; message: string; forbidden: boolean }
  | { kind: "ready"; result: AuditLogListResult };


export function AuditLogPage({ me, query, onChangeQuery, directory }: {
  me: MeResponse;
  query: AuditQueryState;
  onChangeQuery: (next: AuditQueryState) => void;
  directory: readonly DirectoryUser[];
}) {
  const permissions = useMyPermissions();
  const auditScope = permissions?.auditScope ?? "self";
  const isAdminAudit = auditScope === "all";
  const [state, setState] = useState<AuditPageState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const windowId = useRef<number | undefined>(undefined);
  const [projects, setProjects] = useState<ApiProject[]>([]);

  // 关键字防抖（Push 260 · 与首页列表同口径）：输入时不每个字符打一次接口（250ms 内的最后一次生效）
  const [debouncedKeyword, setDebouncedKeyword] = useState(query.keyword ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(query.keyword ?? "");
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query.keyword]);

  // 项目筛选 / 项目列的选项（一次拉满；失败只影响选项丰富度，不阻塞主列表）
  useEffect(() => {
    let alive = true;
    fetchProjectList(EMPTY_LIST_QUERY)
      .then((payload) => {
        if (alive) {
          setProjects(payload.items);
        }
      })
      .catch(() => {
        if (alive) {
          setProjects([]);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // 多选筛选键（2026-10-09 追订「别的筛选也是同理 要支持多选」+「操作记录里面也是」）：数组引用每次解析都会变，
  // 用逗号串当依赖键，防误触发重复取数。
  const queryActorIds = permissions === null || isAdminAudit ? query.actorIds : [];
  const actorKey = queryActorIds.join(",");
  const actionKey = query.actions.join(",");
  const objectTypeKey = query.objectTypes.join(",");
  const resultKey = query.results.join(",");
  const projectKey = query.projectIds.join(",");

  useEffect(() => {
    if (permissions !== null && !isAdminAudit && query.actorIds.length > 0) {
      onChangeQuery({ ...query, actorIds: [], page: 1 });
      return;
    }
    let alive = true;
    windowId.current = undefined;
    setState({ kind: "loading" });
    const keyword = debouncedKeyword.trim();
    fetchAuditLogs({
      keyword: keyword === "" ? null : keyword,
      actorIds: queryActorIds,
      actions: query.actions,
      objectTypes: query.objectTypes,
      results: query.results,
      projectIds: query.projectIds,
      from: query.from,
      to: query.to,
      page: query.page,
    })
      .then((result) => {
        if (alive) {
          windowId.current = result.windowId ?? (query.page === 1 ? result.items.reduce((id, item) => Math.max(id, item.id), 0) || undefined : undefined);
          setState({ kind: "ready", result });
        }
      })
      .catch((error: unknown) => {
        if (!alive) {
          return;
        }
        if (error instanceof ApiError && error.status === 403) {
          setState({ kind: "error", message: "当前账号无权查看操作记录。", forbidden: true });
          return;
        }
        setState({
          kind: "error",
          message: error instanceof ApiError ? error.message : "网络异常，请稍后重试。",
          forbidden: false,
        });
      });
    return () => {
      alive = false;
    };
  }, [debouncedKeyword, isAdminAudit, actorKey, actionKey, objectTypeKey, resultKey, projectKey, query.from, query.to, query.page, onChangeQuery, reloadTick]);

  useLiveRefresh(["audit", "projects", "permissions"], async () => {
    const readingHistory = query.page > 1 || window.scrollY > 160;
    try {
      const keyword = debouncedKeyword.trim();
      const [result, projectList] = await Promise.all([
        fetchAuditLogs({ keyword: keyword === "" ? null : keyword, actorIds: queryActorIds, actions: query.actions, objectTypes: query.objectTypes, results: query.results, projectIds: query.projectIds, from: query.from, to: query.to, page: query.page, beforeId: readingHistory ? windowId.current : undefined }),
        fetchProjectList(EMPTY_LIST_QUERY),
      ]);
      return () => {
        if (!readingHistory) windowId.current = result.windowId ?? (query.page === 1 ? result.items.reduce((id, item) => Math.max(id, item.id), 0) || undefined : undefined);
        setState({ kind: "ready", result });
        setProjects((previous) => keepLiveOrder(previous, projectList.items));
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return () => setState({ kind: "error", message: "当前账号无权查看操作记录。", forbidden: true });
      throw error;
    }
  }, [auditScope, debouncedKeyword, actorKey, actionKey, objectTypeKey, resultKey, projectKey, query.from, query.to, query.page].join(":"), state.kind === "ready", { readOnly: true });

  const patchFilter = (patch: Partial<AuditQueryState>): void => {
    onChangeQuery({ ...query, ...patch, page: 1 });
  };
  const gotoPage = (page: number): void => {
    onChangeQuery({ ...query, page });
  };

  const hasFilter =
    query.keyword !== null ||
    query.actorIds.length > 0 ||
    query.actions.length > 0 ||
    query.objectTypes.length > 0 ||
    query.results.length > 0 ||
    query.projectIds.length > 0 ||
    query.from !== null ||
    query.to !== null;

  // 五枚筛选均为多选（2026-10-09 追订）：不再有「全部…」选项行，空选占位交给 placeholder、触发器显示筛选名称 + 浅灰数量。
  const actorOptions = directory.map((user) => ({ value: user.id, label: user.displayName }));
  // 2026-10-23：「访问」加入、「预览」恢复；按业务口径撤「推进」「回退」筛选项（历史行 / 直链仍可读）。
  const actionOptions = AUDIT_ACTIONS.filter((action) => action !== "advance" && action !== "rollback").map((action) => ({
    value: action,
    label: auditLabelOf(AUDIT_ACTION_LABELS, action),
  }));
  const objectTypeOptions = AUDIT_OBJECT_TYPES.map((type) => ({ value: type, label: auditLabelOf(AUDIT_OBJECT_TYPE_LABELS, type) }));
  const resultOptions = AUDIT_RESULTS.map((result) => ({ value: result, label: auditLabelOf(AUDIT_RESULT_LABELS, result) }));
  const projectOptions = projects.map((project) => ({ value: project.id, label: project.code + " · " + project.name }));
  const projectCodeById = new Map(projects.map((project) => [project.id, project.code] as const));
  const projectNameById = new Map(projects.map((project) => [project.id, project.name] as const));
  const userNameById = new Map(directory.map((user) => [user.id, user.displayName] as const));
  const formatContext: AuditFormatContext = { userNameById, projectCodeById };

  const range: DateRange | null = query.from === null || query.to === null ? null : { from: query.from, to: query.to };
  const totalPages = state.kind === "ready" ? Math.max(1, Math.ceil(state.result.total / state.result.limit)) : 1;
  // 页码钳制（2026-10-10 修复「page=999 直接空态」；对照文件库口径）：直链 / 收藏的 page 超出总页数时按最后
  // 一页重新取数并 replace 写回地址 —— 而不是「空态 + 分页器消失」。越界结果只在「取数中」渲染（空态与地址都不
  // 落）；query 走 ref 读，effect 依赖只留 overPage / totalPages —— 否则 replace 触发的重渲染会重复调用 onChangeQuery。
  const overPage = state.kind === "ready" && state.result.page > totalPages;
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (overPage) {
      onChangeQuery({ ...queryRef.current, page: totalPages });
    }
  }, [overPage, totalPages, onChangeQuery]);

  return (
    <div className="min-h-screen">
      <AppHeader me={me} />
      <main className="w-full px-6 pb-10 pt-3">
        <div data-audit-page="" className="w-full space-y-4">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-zinc-900">操作记录</h1>
              <p className="mt-0.5 text-xs text-zinc-500">
                {auditScope === "all"
                  ? "全站关键操作的留痕（新增 / 修改 / 删除 / 访问 / 预览 / 下载 / 越权尝试……），按时间倒序。"
                  : auditScope === "project_manager"
                    ? "显示您本人的全部操作，以及由您担任项目经理且当前有权查看的项目的全部操作。"
                    : "仅显示您本人的操作记录，按时间倒序。"}
              </p>
            </div>
            {state.kind === "ready" ? (
              <p data-audit-count="" className="text-xs text-zinc-500">
                共 {state.result.total} 条
              </p>
            ) : null}
          </header>

          <section className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
            <span data-audit-filter="keyword" className="w-72 shrink-0">
              <SearchInput
                value={query.keyword ?? ""}
                onChange={(value) => {
                  patchFilter({ keyword: value === "" ? null : value });
                }}
                placeholder="搜索操作内容或操作人"
                className="w-full"
              />
            </span>
            {isAdminAudit ? (
              <span data-audit-filter="actor" className="w-36 shrink-0">
                <SearchSelect
                  mode="multi"
                  ariaLabel="按操作人筛选"
                  values={query.actorIds}
                  options={actorOptions}
                  placeholder="全部操作人"
                  searchPlaceholder="搜索姓名"
                  label="操作人"
                  onToggle={(value) => {
                    patchFilter({
                      actorIds: query.actorIds.includes(value)
                        ? query.actorIds.filter((id) => id !== value)
                        : query.actorIds.concat(value),
                    });
                  }}
                />
              </span>
            ) : null}
            <span data-audit-filter="action" className="w-28 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel="按动作筛选"
                values={query.actions}
                options={actionOptions}
                placeholder="全部动作"
                searchPlaceholder="搜索动作"
                label="动作"
                onToggle={(value) => {
                  patchFilter({
                    actions: query.actions.includes(value)
                      ? query.actions.filter((action) => action !== value)
                      : query.actions.concat(value),
                  });
                }}
              />
            </span>
            <span data-audit-filter="objectType" className="w-32 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel="按对象类型筛选"
                values={query.objectTypes}
                options={objectTypeOptions}
                placeholder="全部对象"
                searchPlaceholder="搜索对象类型"
                label="对象类型"
                onToggle={(value) => {
                  patchFilter({
                    objectTypes: query.objectTypes.includes(value)
                      ? query.objectTypes.filter((type) => type !== value)
                      : query.objectTypes.concat(value),
                  });
                }}
              />
            </span>
            <span data-audit-filter="result" className="w-28 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel="按结果筛选"
                values={query.results}
                options={resultOptions}
                placeholder="全部结果"
                searchPlaceholder="搜索结果"
                label="结果"
                onToggle={(value) => {
                  patchFilter({
                    results: query.results.includes(value)
                      ? query.results.filter((result) => result !== value)
                      : query.results.concat(value),
                  });
                }}
              />
            </span>
            <span data-audit-filter="project" className="w-44 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel="按项目筛选"
                values={query.projectIds}
                options={projectOptions}
                placeholder="全部项目"
                searchPlaceholder="搜索项目编号 / 名称"
                label="项目"
                onToggle={(value) => {
                  patchFilter({
                    projectIds: query.projectIds.includes(value)
                      ? query.projectIds.filter((id) => id !== value)
                      : query.projectIds.concat(value),
                  });
                }}
              />
            </span>
            <span data-audit-filter="time" className="shrink-0">
              <DateRangePicker
                ariaLabel="按时间筛选"
                value={range}
                onChange={(next) => {
                  patchFilter({ from: next === null ? null : next.from, to: next === null ? null : next.to });
                }}
              />
            </span>
            {hasFilter ? (
              <button
                type="button"
                data-audit-clear="true"
                onClick={() => {
                  onChangeQuery(EMPTY_AUDIT_QUERY);
                }}
                className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
              >
                清除筛选
              </button>
            ) : null}
          </section>

          {state.kind === "loading" || overPage ? (
            <div className="flex justify-center py-16">
              <Loader />
            </div>
          ) : null}

          {state.kind === "error" ? (
            <div role="alert" data-audit-error="" className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <span>{state.message}</span>
              {state.forbidden ? null : (
                <button
                  type="button"
                  onClick={() => {
                    setReloadTick((tick) => tick + 1);
                  }}
                  className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium transition hover:bg-rose-100"
                >
                  重试
                </button>
              )}
            </div>
          ) : null}

          {state.kind === "ready" && state.result.items.length === 0 && !overPage ? (
            <div data-audit-empty="true" className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
              {query.keyword !== null
                ? "没有匹配「" + query.keyword + "」的操作记录，可调整关键词或清除筛选。"
                : hasFilter
                  ? "当前筛选下没有操作记录，可清除筛选后重试。"
                  : "暂无操作记录。"}
            </div>
          ) : null}

          {state.kind === "ready" && state.result.items.length > 0 ? (
            <>
              <div data-audit-table="" className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
                <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                  <thead className="bg-zinc-50 text-zinc-500">
                    <tr>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">时间</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">操作人</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">动作</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">对象</th>
                      <th className="border-b border-zinc-200 px-4 py-3 font-medium">操作内容</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">结果</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">项目</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.result.items.map((item) => {
                      const changeLines = auditChangeLines(item, formatContext);
                      return (
                      <tr key={item.id} data-live-row={String(item.id)} data-audit-row={String(item.id)} className="align-top transition hover:bg-zinc-50/70">
                        <td data-mobile-label="时间" className="whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-700">{formatDateTime(item.occurredAt)}</td>
                        <td data-mobile-label="操作人" className="whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-700">{item.actorName ?? "系统"}</td>
                        <td data-mobile-label="动作" className="whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                          <span
                            data-audit-action={item.action}
                            className={
                              "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " +
                              (item.action === "delete" || item.action === "deny" ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-600")
                            }
                          >
                            {auditLabelOf(AUDIT_ACTION_LABELS, item.action)}
                          </span>
                        </td>
                        <td data-mobile-label="对象" className="whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-600">
                          {auditObjectText(item, formatContext)}
                        </td>
                        <td data-mobile-label="操作内容" className="border-b border-zinc-100 px-4 py-3">
                          <p className="text-zinc-700">{auditSummaryText(item)}</p>
                          {changeLines.length === 0 ? null : (
                            <ul className="mt-1.5 space-y-0.5">
                              {changeLines.slice(0, AUDIT_CHANGE_LINE_LIMIT).map((line, index) => (
                                <li key={line.label + "·" + String(index)} data-audit-change={line.label} data-audit-change-kind={line.kind} className="text-xs leading-5">
                                  <span className="text-zinc-500">{line.label}</span>
                                  <span className="mx-1 text-zinc-300">·</span>
                                  {line.kind === "create" ? (
                                    <span className="font-medium text-zinc-700">{line.to}</span>
                                  ) : line.kind === "clear" ? (
                                    item.action === "delete" ? (
                                      <span className="text-zinc-700">{line.from}</span>
                                    ) : (
                                      <>
                                        <span className="text-zinc-400">{line.from}</span>
                                        <span className="ml-1 text-zinc-400">（已清空）</span>
                                      </>
                                    )
                                  ) : (
                                    <>
                                      <span className="text-[11px] text-zinc-400">修改前</span>
                                      <span className="ml-1 text-zinc-400">{line.from}</span>
                                      <span className="mx-1 text-zinc-300">→</span>
                                      <span className="text-[11px] text-zinc-400">修改后</span>
                                      <span className="ml-1 font-medium text-zinc-800">{line.to}</span>
                                    </>
                                  )}
                                </li>
                              ))}
                              {changeLines.length > AUDIT_CHANGE_LINE_LIMIT ? (
                                <li className="text-xs text-zinc-400">等 {changeLines.length} 项变化</li>
                              ) : null}
                            </ul>
                          )}
                        </td>
                        <td data-mobile-label="结果" className="whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                          <span
                            data-audit-result={item.result}
                            className={
                              "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " +
                              (item.result === "succeeded"
                                ? "bg-emerald-50 text-emerald-700"
                                : item.result === "denied"
                                  ? "bg-amber-100 text-amber-800"
                                  : item.result === "failed"
                                    ? "bg-rose-50 text-rose-700"
                                    : "bg-zinc-100 text-zinc-600")
                            }
                          >
                            {auditLabelOf(AUDIT_RESULT_LABELS, item.result)}
                          </span>
                        </td>
                        <td data-mobile-label="项目" className="border-b border-zinc-100 px-4 py-3">
                          {item.projectId === null ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <div
                              data-audit-project={item.projectId}
                              data-audit-project-name={projectNameById.get(item.projectId) ?? ""}
                              data-audit-project-code={projectCodeById.get(item.projectId) ?? ""}
                              className="flex max-w-[240px] flex-col gap-0.5"
                            >
                              <span className="truncate font-medium text-zinc-700" title={projectNameById.get(item.projectId) ?? ""}>
                                {projectNameById.get(item.projectId) ?? "—"}
                              </span>
                              <span className="whitespace-nowrap text-xs text-zinc-500">{projectCodeById.get(item.projectId) ?? "—"}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3">
                <p data-audit-page-info="" className="text-xs text-zinc-500">
                  共 {state.result.total} 条 · 第 {state.result.page} / {totalPages} 页
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-audit-prev="true"
                    disabled={state.result.page <= 1}
                    onClick={() => {
                      gotoPage(state.result.page - 1);
                    }}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    data-audit-next="true"
                    disabled={state.result.page >= totalPages}
                    onClick={() => {
                      gotoPage(state.result.page + 1);
                    }}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                  >
                    下一页
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
