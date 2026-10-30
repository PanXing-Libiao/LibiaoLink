import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { cardBorderOf, cardTintOf, useBackgroundTier, useCardWatermark } from "./backgroundTier";
import { AppHeader } from "./components/AppHeader";
import { Card } from "./components/Card";
import { FilePreviewOverlay } from "./components/FilePreviewOverlay";
import { mobileFilePreviewMustDownload } from "./mobilePreviewPolicy";
import { FileTypeIcon } from "./components/FileTypeIcon";
import { Loader } from "./components/Loader";
import { SearchInput } from "./components/SearchInput";
import { SearchSelect } from "./components/SearchSelect";
import { Toast, ToastConfirm } from "./components/Toast";
import { regionNameEn } from "./data/regionPicker";
import { dictLabel, typeAccent, type Dicts } from "./dicts";
import type { DirectoryUser } from "./directory";
import { keepLiveOrder } from "./liveSync";
import { useLiveRefresh } from "./useLiveRefresh";
import {
  isLocalizedLocale,
  prefetchLocalizedText,
  projectStatusTextOf,
  projectTypeText,
  statusText,
  textOf,
  useLocale,
  useLocalizedTranslator,
  useT,
  type Locale,
  type TextKey,
} from "./i18n";
import {
  ensurePreviewOutcome,
  fetchDownloadUrl,
  fetchProjectFileLibrary,
  previewKindOf,
  purgeFile,
  recordPreviewView,
  restoreFile,
  triggerDownload,
  type FileLibraryItem,
  type FilePreviewKind,
  type PreviewViewerConfig,
} from "./fileApi";
import { hasPermission, useMyPermissions } from "./permissions";
import {
  fetchProjectList,
  fetchRecycledProjects,
  formatDateTime,
  purgeProject,
  restoreProject,
  type ApiProject,
} from "./projectApi";
import type { MeResponse } from "./types";
import { EMPTY_FILES_QUERY, EMPTY_LIST_QUERY, type FilesQueryState, type FilesTab } from "./useHashRoute";

/**
 * 回收站页（2026-10-29 · 由原「文件库」收敛而来）。
 *
 * 入口 = 右上角头像菜单「回收站」（AppHeader；全账号可见 —— 读面按项目可见性放开，无单独权限位）。
 * 两栏（地址缺省 = 文件回收站；`?tab=project-recycled` = 项目回收站）：
 *   ① 文件回收站 = filter[status]=recycled，行内可就地「恢复」（回退到进入回收站前的状态）与「彻底删除」
 *      （仅系统管理员渲染入口 —— 服务端按 groupAccessAdmin 硬闸，A4-12；非管理员吃 403 兜底）；
 *   ② 项目回收站 = 独立项目读口，按项目空间卡片展示、恢复 / 彻底删除。
 * 原「系统现有文件」栏已移到项目详情「项目文件」标签：那里只列各阶段任务文件与变更记录对应文件，
 * 日报 / 问题附图不进入项目文件列表。
 *
 * 数据面（前端聚合）：文件列表接口只有项目维度（GET /projects/{id}/files），本页按项目列表逐项目分页取满再合并
 * （fileApi.fetchProjectFileLibrary）；关键字 / 项目 / 上传人筛选保留，状态恒为 recycled。单项目失败（非成员 404 等）
 * 跳过不阻断整页。分页为前端切页（页大小 50）。
 * 预览走 S4 两通道裁决；写口反馈走顶部 Toast；失败口径不变（VERSION_CONFLICT = 数据已被他人更新）。
 */

/** 文件状态中文签（与站内文件行 / 抽屉「变更申请」页同一套文案；未知取值回落原文）。 */
const FILE_STATUS_LABELS: Record<string, string> = {
  draft: "未定档",
  final: "已定档",
  changed: "已变更",
  archived: "已归档",
  recycled: "回收站",
};

/** 状态签颜色（统一口径）：草稿 / 已归档 / 回收站 = 中性灰（同任务抽屉文件行），已定档 = 定档开关的琥珀，
 *  已变更 = 「进行中」蓝系。 */
const FILE_STATUS_CLASS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  final: "bg-amber-100 text-amber-800",
  changed: "bg-blue-50 text-blue-700",
  archived: "bg-zinc-100 text-zinc-500",
  recycled: "bg-zinc-100 text-zinc-400",
};

/** 页大小（前端切页；与操作记录页同为 50 行/页）。 */
const PAGE_LIMIT = 50;

type LibraryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: FileLibraryItem[] };

type ProjectRecycleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: ApiProject[] };

type PreviewState = {
  pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
  name: string;
  kind: FilePreviewKind;
  fileId: string;
  nonce: number;
};

type Notice = { kind: "ok" | "error"; text: string };

/** 两栏（顺序 = 标签栏顺序；label 存词典键，随语言切换）。 */
const TABS: ReadonlyArray<{ key: FilesTab; label: TextKey }> = [
  { key: "recycled", label: "lib.tab.recycled" },
  { key: "project-recycled", label: "lib.tab.projectRecycled" },
];

/** 写失败 → 面向业务的提示（错误码口径《前端功能需求》§3.7；Push 301：提示随语言切换）。 */
function friendlyError(locale: Locale, action: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "VERSION_CONFLICT") {
      return textOf(locale, "lib.err.versionConflict");
    }
    if (error.status === 403) {
      return textOf(locale, "lib.err.forbidden");
    }
    if (error.code === "FILE_STATE_INVALID") {
      return error.message;
    }
    return textOf(locale, "lib.err.code", { message: error.message, code: error.code });
  }
  return textOf(locale, "lib.err.network", { action });
}

export function FileLibraryPage({ me, query, onChangeQuery, directory, dicts }: {
  me: MeResponse;
  query: FilesQueryState;
  onChangeQuery: (next: FilesQueryState) => void;
  directory: readonly DirectoryUser[];
  /** 项目类型主题色、地区水印与卡片背景档位同首页项目空间。 */
  dicts: Dicts;
}) {
  const t = useT();
  const locale = useLocale();
  /** 手打内容（项目名）机翻显示：英文界面取译文，未就绪回退原文；文件名不翻译（业务口径 2026-10-13）。 */
  const localize = useLocalizedTranslator();
  const [state, setState] = useState<LibraryState>({ kind: "loading" });
  /** 已见上传人姓名缓存：筛选切换后已选停用账号即使零命中，也保留可读姓名供取消选择。 */
  const uploaderNameCacheRef = useRef<Map<string, string>>(new Map());
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const liveProjectsRef = useRef<ApiProject[] | null>(null);
  const [projectRecycleState, setProjectRecycleState] = useState<ProjectRecycleState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const permissions = useMyPermissions();
  const backgroundTier = useBackgroundTier();
  const cardWatermark = useCardWatermark();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [projectPurgeConfirmId, setProjectPurgeConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    const directoryNames = new Map(directory.map((user) => [user.id, user.displayName] as const));
    const next = new Map(uploaderNameCacheRef.current);
    for (const item of state.items) {
      next.set(
        item.createdBy,
        item.createdByName ?? directoryNames.get(item.createdBy) ?? item.createdBy,
      );
    }
    uploaderNameCacheRef.current = next;
  }, [state, directory]);

  // 关键字防抖（与首页列表 / 操作记录页同口径）：输入时不每敲一个字打一次接口，250ms 内的最后一次生效
  const [debouncedKeyword, setDebouncedKeyword] = useState(query.keyword ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(query.keyword ?? "");
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query.keyword]);

  // 项目列表（筛选下拉与项目编号列的一次性来源；limit=200 一次拉满）。失败 = 整页错误态，重试按钮重来。
  useEffect(() => {
    let alive = true;
    setProjects(null);
    fetchProjectList(EMPTY_LIST_QUERY)
      .then((payload) => {
        // Push 301：项目名（手打文本）提前后台翻好，切英文直接命中；文件名不翻译。
        prefetchLocalizedText(payload.items.map((project) => project.name));
        if (alive) {
          setProjects(payload.items);
        }
      })
      .catch(() => {
        if (alive) {
          setState({ kind: "error", message: t("lib.projectLoadFailed") });
        }
      });
    return () => {
      alive = false;
    };
  }, [reloadTick, locale]);

  // 项目回收站：独立读口 GET /projects?filter[recycled]=true；卡片沿用项目空间视觉，不复用文件聚合。
  useEffect(() => {
    if (query.tab !== "project-recycled") {
      return;
    }
    let alive = true;
    setProjectRecycleState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    fetchRecycledProjects()
      .then((payload) => {
        prefetchLocalizedText(payload.items.map((project) => project.name));
        if (alive) {
          setProjectRecycleState({ kind: "ready", items: payload.items });
        }
      })
      .catch(() => {
        if (alive) {
          setProjectRecycleState({ kind: "error", message: t("lib.projectRecycleLoadFailed") });
        }
      });
    return () => {
      alive = false;
    };
  }, [query.tab, reloadTick, locale]);

  // 多选筛选键（2026-10-09 追订）：数组引用每次解析都会变，用逗号串当依赖键，防误触发整页重取；
  // 上传人是内存过滤（见文件头）：不进 fetch 依赖 —— 勾选 / 取消只重算派生列表、不重发请求。
  const projectIdKey = query.projectIds.join(",");

  useLiveRefresh(["files", "projects", "permissions", "users"], async () => {
    if (query.tab === "project-recycled") {
      const recycled = await fetchRecycledProjects();
      return () => {
        setProjectRecycleState({ kind: "ready", items: recycled.items });
      };
    }
    const list = await fetchProjectList(EMPTY_LIST_QUERY);
    const targetIds = projectIdKey === "" ? [] : projectIdKey.split(",");
    const targets = list.items.filter((project) => targetIds.length === 0 || targetIds.includes(project.id));
    const results = await Promise.all(targets.map(async (project) => { try { return await fetchProjectFileLibrary(project.id, { statuses: ["recycled"], keyword: debouncedKeyword.trim() || undefined }); } catch (error) { if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return []; throw error; } }));
    const nextProjects = keepLiveOrder(projects ?? [], list.items);
    return () => {
      // The file results and project labels belong to one completed snapshot.
      liveProjectsRef.current = nextProjects;
      setProjects(nextProjects);
      setState((previous) => previous.kind === "ready" ? { kind: "ready", items: keepLiveOrder(previous.items, results.flat()) } : previous);
    };
  }, query.tab + ":" + projectIdKey + ":" + debouncedKeyword + ":" + String(reloadTick), query.tab === "project-recycled" ? projectRecycleState.kind === "ready" : projects !== null && state.kind === "ready");

  // 文件列表：按项目列表逐项目取满再合并（见文件头「数据面」；单项目失败跳过；多选 = 选中项目并集）。
  useEffect(() => {
    if (projects === null || query.tab === "project-recycled") {
      return;
    }
    if (liveProjectsRef.current === projects) { liveProjectsRef.current = null; return; }
    let alive = true;
    setState((previous) => previous.kind === "ready" ? previous : { kind: "loading" });
    const keyword = debouncedKeyword.trim();
    const targetIds = projectIdKey === "" ? [] : projectIdKey.split(",");
    const targets = projects.filter((project) => targetIds.length === 0 || targetIds.includes(project.id));
    void Promise.all(
      targets.map((project) =>
        fetchProjectFileLibrary(project.id, {
          statuses: ["recycled"],
          keyword: keyword === "" ? undefined : keyword,
        }).catch(() => [] as FileLibraryItem[]),
      ),
    ).then((results) => {
      if (!alive) {
        return;
      }
      const items = results.flat();
      items.sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt < right.createdAt ? 1 : -1;
        }
        return left.id < right.id ? -1 : 1;
      });
      setState({ kind: "ready", items });
    });
    return () => {
      alive = false;
    };
  }, [projects, debouncedKeyword, query.tab, projectIdKey, reloadTick]);

  // 权限画像（与 AppHeader 共用同一份进程内单飞缓存）：功能位 + 项目级 groupAccessLevel 共同收敛恢复 / 删除入口。
  // 服务端逐请求仍是最终裁决；系统管理员绕过部门项目范围限制。
  const isAdmin = permissions?.groupAccessAdmin === true;
  const canDeleteProject = hasPermission(permissions, "project.delete");
  const isProjectRecycle = query.tab === "project-recycled";
  const recycledProjects = projectRecycleState.kind === "ready" ? projectRecycleState.items : [];

  const projectById = new Map((projects ?? []).map((project) => [project.id, project] as const));
  // 上传人 = 内存过滤（服务端 filter[uploadedBy] 单值口径，见文件头）：空选不筛、多选取并集。
  const visibleItems =
    state.kind !== "ready"
      ? []
      : state.items.filter((item) => query.uploaderIds.length === 0 || query.uploaderIds.includes(item.createdBy));
  const total = visibleItems.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const page = Math.min(query.page, totalPages);
  const pageItems = visibleItems.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);
  const canEditProject = (projectId: string): boolean =>
    isAdmin || projectById.get(projectId)?.groupAccessLevel === "edit";
  const canRestoreProject = (project: ApiProject): boolean =>
    canDeleteProject && (isAdmin || project.groupAccessLevel === "edit");
  const userNameById = new Map(directory.map((user) => [user.id, user.displayName] as const));
  const userNameOf = (id: string | null): string => (id === null ? "—" : userNameById.get(id) ?? id);
  const projectCodeOf = (id: string): string => projectById.get(id)?.code ?? "—";
  const projectNameOf = (id: string): string => projectById.get(id)?.name ?? "—";
  const projectWatermarkOf = (regionCode: string): string => {
    const label = dictLabel(dicts, "region", regionCode);
    return isLocalizedLocale(locale) ? regionNameEn(label) || label : label;
  };

  const patchFilter = (patch: Partial<FilesQueryState>): void => {
    onChangeQuery({ ...query, ...patch, page: 1 });
  };
  const gotoPage = (next: number): void => {
    onChangeQuery({ ...query, page: next });
  };
  const switchTab = (tab: FilesTab): void => {
    if (tab === query.tab) {
      return;
    }
    // 换栏保留项目 / 关键字 / 上传人；两处彻底删除确认一并收起。
    setPurgeConfirmId(null);
    setProjectPurgeConfirmId(null);
    onChangeQuery({ ...query, tab, page: 1 });
  };
  const hasFilter =
    query.keyword !== null || query.projectIds.length > 0 || query.uploaderIds.length > 0;
  const clearFilters = (): void => {
    onChangeQuery({ ...EMPTY_FILES_QUERY, tab: query.tab });
  };

  // 项目筛选 = 多选（2026-10-09 追订）：不再有「全部项目」选项行，空选占位由 placeholder="全部项目" 承担。
  const projectOptions = (projects ?? []).map((project) => ({ value: project.id, label: project.code + " · " + localize(project.name) }));
  // 上传人候选 = 当前筛选结果（尚未应用上传人自身过滤的 state.items）中去重后的 createdBy；
  // 必须用 state.items 而不是 visibleItems，否则选中一人后其他候选会消失。已选但当前零命中的 id 也并入，保证可取消。
  const uploaderNameById = new Map<string, string>(uploaderNameCacheRef.current);
  if (state.kind === "ready") {
    for (const item of state.items) {
      uploaderNameById.set(
        item.createdBy,
        item.createdByName ?? userNameById.get(item.createdBy) ?? item.createdBy,
      );
    }
  }
  for (const id of query.uploaderIds) {
    if (!uploaderNameById.has(id)) {
      uploaderNameById.set(id, userNameById.get(id) ?? id);
    }
  }
  const uploaderOptions = [...uploaderNameById]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, locale));

  /** 预览（与任务抽屉同一套 S4 两通道裁决）：点开才懒取；unavailable = 一行提示（reason 或「请下载查看」口径）。 */
  const openPreview = async (file: FileLibraryItem): Promise<void> => {
    if (previewBusy !== null) {
      return;
    }
    if (mobileFilePreviewMustDownload(file.name)) {
      await downloadFile(file);
      return;
    }
    setPreviewBusy(file.id);
    setNotice(null);
    const outcome = await ensurePreviewOutcome(file.id);
    setPreviewBusy(null);
    if (outcome.kind === "unavailable") {
      setNotice({ kind: "error", text: outcome.reason ?? t("drawer.preview.unavailable") });
      return;
    }
    void recordPreviewView(file.id);
    const kind = previewKindOf(file.name) ?? "image";
    if (outcome.kind === "viewer") {
      setPreview({ pane: { mode: "viewer", viewer: outcome.viewer }, name: file.name, kind, fileId: file.id, nonce: 0 });
      return;
    }
    setPreview({ pane: { mode: "url", url: outcome.url }, name: file.name, kind, fileId: file.id, nonce: 0 });
  };

  /** 查看器外壳「重试」：重取查看器配置（token 随签发刷新）+ nonce 自增强制重建；仍取不到 → 关浮层 + 一行提示。 */
  const retryPreview = async (fileId: string, previous: PreviewState): Promise<void> => {
    if (previewBusy !== null) {
      return;
    }
    setPreviewBusy(fileId);
    const outcome = await ensurePreviewOutcome(fileId);
    setPreviewBusy(null);
    if (outcome.kind === "unavailable") {
      setPreview(null);
      setNotice({ kind: "error", text: outcome.reason ?? t("drawer.preview.unavailable") });
      return;
    }
    const pane = outcome.kind === "viewer"
      ? { mode: "viewer" as const, viewer: outcome.viewer }
      : { mode: "url" as const, url: outcome.url };
    setPreview({ pane, name: previous.name, kind: previous.kind, fileId: previous.fileId, nonce: previous.nonce + 1 });
  };

  /** 下载原文件（与任务抽屉同口径）：版本 attachment 短时签名 + Blob 落盘（服务端写 download 审计）。 */
  const downloadFile = async (file: FileLibraryItem): Promise<void> => {
    if (downloadBusy !== null) {
      return;
    }
    setDownloadBusy(file.id);
    setNotice(null);
    try {
      const signed = await fetchDownloadUrl(file.id);
      await triggerDownload(signed.url, signed.fileName);
      setNotice({ kind: "ok", text: t("lib.download.started", { name: signed.fileName }) });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed") });
    } finally {
      setDownloadBusy(null);
    }
  };

  /** 回收站恢复（A4-12）：回退到进入回收站前的状态；成功后重取当前栏。 */
  const restoreItem = async (file: FileLibraryItem): Promise<void> => {
    if (actionBusy !== null || !canEditProject(file.projectId)) {
      return;
    }
    setActionBusy(file.id);
    setNotice(null);
    try {
      await restoreFile(file.id);
      const back = statusText(locale, FILE_STATUS_LABELS[file.recycledFromStatus ?? "draft"] ?? "未定档");
      setNotice({ kind: "ok", text: t("lib.restored", { name: file.name, status: back }) });
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(locale, t("lib.act.restore"), error) });
    } finally {
      setActionBusy(null);
      setPurgeConfirmId(null);
    }
  };

  /** 彻底删除（仅系统管理员渲染入口；服务端按 groupAccessAdmin 硬闸）：行内二次确认后 POST /files/{id}/purge。 */
  const purgeItem = async (file: FileLibraryItem): Promise<void> => {
    if (actionBusy !== null || !isAdmin) {
      return;
    }
    setActionBusy(file.id);
    setNotice(null);
    try {
      await purgeFile(file.id);
      setPurgeConfirmId(null);
      setNotice({ kind: "ok", text: t("lib.purged", { name: file.name }) });
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(locale, t("lib.act.purge"), error) });
    } finally {
      setActionBusy(null);
    }
  };

  /** 项目回收站恢复：项目数据与图片原样保留，成功后从项目回收站列表移除。 */
  const restoreRecycledProject = async (project: ApiProject): Promise<void> => {
    if (actionBusy !== null || !canRestoreProject(project)) {
      return;
    }
    setActionBusy(project.id);
    setNotice(null);
    setProjectPurgeConfirmId(null);
    try {
      await restoreProject(project.id, project.version);
      setNotice({ kind: "ok", text: t("lib.projectRestored", { name: project.name }) });
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(locale, t("lib.act.restore"), error) });
    } finally {
      setActionBusy(null);
    }
  };

  /** 彻底删除第一下：只挂顶部确认 Toast，不直接调用接口。 */
  const requestPurgeProject = (project: ApiProject): void => {
    if (actionBusy !== null) {
      return;
    }
    setNotice(null);
    setProjectPurgeConfirmId(project.id);
  };

  /** 彻底删除第二下：服务端同事务清理项目聚合数据；projects/{id}/ 下文件、图片与暂存对象全部按版本删除。 */
  const confirmPurgeRecycledProject = async (): Promise<void> => {
    const project =
      projectPurgeConfirmId === null
        ? undefined
        : recycledProjects.find((item) => item.id === projectPurgeConfirmId);
    if (project === undefined || actionBusy !== null || !isAdmin) {
      return;
    }
    setActionBusy(project.id);
    setNotice(null);
    try {
      await purgeProject(project.id, project.version);
      setProjectPurgeConfirmId(null);
      setNotice({ kind: "ok", text: t("lib.projectPurged", { name: project.name }) });
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(locale, t("lib.act.purge"), error) });
    } finally {
      setActionBusy(null);
    }
  };

  const projectPurgeTarget =
    projectPurgeConfirmId === null
      ? null
      : recycledProjects.find((project) => project.id === projectPurgeConfirmId) ?? null;

  const emptyText = ((): string => {
    if (query.keyword !== null) {
      return t("lib.empty.keyword", { kw: query.keyword });
    }
    if (hasFilter) {
      return t("lib.empty.filter.recycled");
    }
    return t("lib.empty.recycled");
  })();

  return (
    <div className="min-h-screen">
      <AppHeader me={me} />
      <main className="@container w-full px-6 pb-10 pt-3">
        <div data-file-library="" className="w-full space-y-4">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-zinc-900">{t("lib.title")}</h1>
              <p className="mt-0.5 text-xs text-zinc-500">
                {t("lib.subtitle")}
              </p>
            </div>
            {isProjectRecycle ? (
              projectRecycleState.kind === "ready" ? (
                <p data-file-count="" className="text-xs text-zinc-500">
                  {t("lib.projectCount", { n: recycledProjects.length })}
                </p>
              ) : null
            ) : state.kind === "ready" ? (
              <p data-file-count="" className="text-xs text-zinc-500">
                {t("lib.count", { n: total })}
              </p>
            ) : null}
          </header>

          <nav data-file-tabs="" aria-label={t("lib.tabs.aria")} className="flex gap-1 border-b border-zinc-200">
            {TABS.map((item) => {
              const active = item.key === query.tab;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-file-tab={item.key}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    switchTab(item.key);
                  }}
                  className={
                    "border-b-2 px-4 py-2.5 text-sm font-medium transition " +
                    (active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800")
                  }
                >
                  {t(item.label)}
                </button>
              );
            })}
          </nav>

          {isProjectRecycle ? null : (
          <section className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
            <span data-file-filter="keyword" className="w-72 shrink-0">
              <SearchInput
                value={query.keyword ?? ""}
                onChange={(value) => {
                  patchFilter({ keyword: value === "" ? null : value });
                }}
                placeholder={t("lib.search")}
                className="w-full"
              />
            </span>
            <span data-file-filter="project" className="w-44 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel={t("lib.filter.project.aria")}
                values={query.projectIds}
                options={projectOptions}
                placeholder={t("lib.filter.project.placeholder")}
                searchPlaceholder={t("lib.filter.project.search")}
                label={t("lib.filter.project.label")}
                onToggle={(value) => {
                  patchFilter({
                    projectIds: query.projectIds.includes(value)
                      ? query.projectIds.filter((id) => id !== value)
                      : query.projectIds.concat(value),
                  });
                }}
              />
            </span>
            <span data-file-filter="uploader" className="w-36 shrink-0">
              <SearchSelect
                mode="multi"
                ariaLabel={t("lib.filter.uploader.aria")}
                values={query.uploaderIds}
                options={uploaderOptions}
                placeholder={t("lib.filter.uploader.placeholder")}
                searchPlaceholder={t("lib.filter.uploader.search")}
                label={t("lib.filter.uploader.label")}
                onToggle={(value) => {
                  patchFilter({
                    uploaderIds: query.uploaderIds.includes(value)
                      ? query.uploaderIds.filter((id) => id !== value)
                      : query.uploaderIds.concat(value),
                  });
                }}
              />
            </span>
            {hasFilter ? (
              <button
                type="button"
                data-file-clear="true"
                onClick={clearFilters}
                className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
              >
                {t("lib.clear")}
              </button>
            ) : null}
          </section>
          )}

          {notice === null ? null : (
            <Toast
              kind={notice.kind}
              text={notice.text}
              onClose={() => {
                setNotice(null);
              }}
              anchor={{ name: "data-file-notice", value: notice.kind }}
            />
          )}

          {!isProjectRecycle ? (
            <>
          {state.kind === "loading" ? (
            <div className="flex justify-center py-16">
              <Loader />
            </div>
          ) : null}

          {state.kind === "error" ? (
            <div role="alert" data-file-error="" className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <span>{state.message}</span>
              <button
                type="button"
                onClick={() => {
                  setReloadTick((tick) => tick + 1);
                }}
                className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium transition hover:bg-rose-100"
              >
                {t("common.retry")}
              </button>
            </div>
          ) : null}

          {state.kind === "ready" && total === 0 ? (
            <div data-file-empty="true" className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
              {emptyText}
            </div>
          ) : null}

          {state.kind === "ready" && total > 0 ? (
            <>
              <div data-file-table="" className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
                <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                  <thead className="bg-zinc-50 text-zinc-500">
                    <tr>
                      <th className="border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.file")}</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.status")}</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.project")}</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.uploader")}</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.recycledAt")}</th>
                      <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-3 font-medium">{t("lib.col.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((file) => (
                      <tr
                        key={file.id}
                        data-file-row={file.id}
                        tabIndex={0}
                        aria-label={(mobileFilePreviewMustDownload(file.name) ? t("lib.download") : t("lib.preview")) + " " + file.name}
                        aria-busy={previewBusy === file.id}
                        onClick={(event) => {
                          const target = event.target;
                          if (target instanceof Element && target.closest("button, a, input, select, textarea, [role=button]") !== null) return;
                          void openPreview(file);
                        }}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          void openPreview(file);
                        }}
                        className="cursor-pointer transition hover:bg-zinc-50/70 focus-visible:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
                      >
                        <td data-mobile-label={t("lib.col.file")} className="align-middle border-b border-zinc-100 px-4 py-3">
                          <span className="flex items-center gap-2.5">
                            <FileTypeIcon name={file.name} className="h-5 w-5" />
                            <span className="truncate text-base text-zinc-800" title={file.name}>
                              {file.name}
                            </span>
                          </span>
                        </td>
                        <td data-mobile-label={t("lib.col.status")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                          <span
                            data-file-status={file.status}
                            title={
                              file.recycledFromStatus !== null
                                ? t("lib.status.original", { status: statusText(locale, FILE_STATUS_LABELS[file.recycledFromStatus] ?? file.recycledFromStatus) })
                                : undefined
                            }
                            className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + (FILE_STATUS_CLASS[file.status] ?? "bg-zinc-100 text-zinc-600")}
                          >
                            {statusText(locale, FILE_STATUS_LABELS[file.status] ?? file.status)}
                          </span>
                        </td>
                        <td data-mobile-label={t("lib.col.project")} className="align-middle border-b border-zinc-100 px-4 py-3">
                          <div
                            data-file-project={file.projectId}
                            data-file-project-code={projectCodeOf(file.projectId)}
                            data-file-project-name={projectNameOf(file.projectId)}
                            className="flex max-w-[240px] flex-col gap-0.5"
                          >
                            <span className="truncate font-medium text-zinc-700" title={localize(projectNameOf(file.projectId))}>
                              {localize(projectNameOf(file.projectId))}
                            </span>
                            <span className="whitespace-nowrap text-xs text-zinc-500">{projectCodeOf(file.projectId)}</span>
                          </div>
                        </td>
                        <td data-mobile-label={t("lib.col.uploader")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-700">{file.createdByName ?? userNameOf(file.createdBy)}</td>
                        <td data-mobile-label={t("lib.col.recycledAt")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3 text-zinc-600">
                          {file.recycledAt === null
                            ? "—"
                            : formatDateTime(file.recycledAt) + " · " + userNameOf(file.recycledBy)}
                        </td>
                        <td data-mobile-label={t("lib.col.actions")} className="align-middle whitespace-nowrap border-b border-zinc-100 px-4 py-3">
                          <span className="flex items-center gap-2">
                                {canEditProject(file.projectId) && <button
                                  type="button"
                                  data-file-restore={file.id}
                                  disabled={actionBusy !== null}
                                  onClick={() => {
                                    void restoreItem(file);
                                  }}
                                  className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                                >
                                  {t("lib.restore")}
                                </button>}
                                {isAdmin ? (
                                  purgeConfirmId === file.id ? (
                                    <>
                                      <span className="text-[11px] text-rose-600">{t("lib.purge.note")}</span>
                                      <button
                                        type="button"
                                        data-file-purge-confirm={file.id}
                                        disabled={actionBusy !== null}
                                        onClick={() => {
                                          void purgeItem(file);
                                        }}
                                        className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:text-rose-300"
                                      >
                                        {actionBusy === file.id ? t("lib.purge.busy") : t("lib.purge.confirm")}
                                      </button>
                                      <button
                                        type="button"
                                        data-file-purge-cancel={file.id}
                                        onClick={() => {
                                          setPurgeConfirmId(null);
                                        }}
                                        className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                                      >
                                        {t("common.cancel")}
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      data-file-purge={file.id}
                                      disabled={actionBusy !== null}
                                      onClick={() => {
                                        setPurgeConfirmId(file.id);
                                      }}
                                      className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:text-rose-300"
                                    >
                                      {t("lib.purge")}
                                    </button>
                                  )
                                ) : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3">
                <p data-file-page-info="" className="text-xs text-zinc-500">
                  {t("lib.page", { total, page, pages: totalPages })}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-file-prev="true"
                    disabled={page <= 1}
                    onClick={() => {
                      gotoPage(page - 1);
                    }}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                  >
                    {t("lib.prev")}
                  </button>
                  <button
                    type="button"
                    data-file-next="true"
                    disabled={page >= totalPages}
                    onClick={() => {
                      gotoPage(page + 1);
                    }}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300"
                  >
                    {t("lib.next")}
                  </button>
                </div>
              </footer>
            </>
          ) : null}
            </>
          ) : (
            <>
              {projectRecycleState.kind === "loading" ? (
                <div className="flex justify-center py-16">
                  <Loader />
                </div>
              ) : null}

              {projectRecycleState.kind === "error" ? (
                <div role="alert" data-project-recycle-error="" className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  <span>{projectRecycleState.message}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setReloadTick((tick) => tick + 1);
                    }}
                    className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium transition hover:bg-rose-100"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : null}

              {projectRecycleState.kind === "ready" && recycledProjects.length === 0 ? (
                <div data-project-recycle-empty="true" className="rounded-xl border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
                  {t("lib.empty.projectRecycled")}
                </div>
              ) : null}

              {projectRecycleState.kind === "ready" && recycledProjects.length > 0 ? (
                <div data-project-recycle="" className="grid grid-cols-1 gap-6 @md:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4">
                  {recycledProjects.map((project) => {
                    const accent = typeAccent(dicts, project.projectType);
                    return (
                      <div key={project.id} data-project-recycle-card={project.id} className="w-full">
                        <Card
                          seqNo={project.seqNo}
                          code={project.code}
                          description={project.name}
                          watermark={cardWatermark ? projectWatermarkOf(project.region) : undefined}
                          watermarkBleed={locale === "zh"}
                          tint={cardTintOf(backgroundTier, accent.color)}
                          tintBorder={cardBorderOf(backgroundTier, accent.color)}
                          vividInk={backgroundTier === "vivid"}
                          typeLabel={projectTypeText(locale, dictLabel(dicts, "projectType", project.projectType))}
                          status={project.status}
                          statusText={projectStatusTextOf(locale, project.status)}
                          accentColor={accent.color}
                          accentText={accent.text}
                          managerNames={project.managerNames.map((name) => (name === null || name === "" ? "—" : name)).join("、")}
                          time={formatDateTime(project.deletedAt ?? project.updatedAt)}
                          onRestore={
                            canRestoreProject(project)
                              ? () => {
                                  void restoreRecycledProject(project);
                                }
                              : undefined
                          }
                          onPurge={
                            isAdmin
                              ? () => {
                                  requestPurgeProject(project);
                                }
                              : undefined
                          }
                          restoreLabel={t("lib.restore")}
                          purgeLabel={actionBusy === project.id ? t("lib.projectPurge.busy") : t("lib.purge")}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>
      {projectPurgeTarget === null ? null : (
        <ToastConfirm
          text={<>
            {t("lib.projectPurge.lead")}
            {t("lib.projectPurge.tail", { code: projectPurgeTarget.code, name: projectPurgeTarget.name })}
          </>}
          ariaLabel={t("lib.projectPurge.aria")}
          cancelLabel={t("common.cancel")}
          confirmLabel={actionBusy === projectPurgeTarget.id ? t("lib.projectPurge.busy") : t("lib.projectPurge.confirm")}
          onCancel={() => { setProjectPurgeConfirmId(null); }}
          onConfirm={() => { void confirmPurgeRecycledProject(); }}
          confirmDisabled={actionBusy !== null}
          anchor={{ name: "data-project-purge-dialog", value: projectPurgeTarget.id }}
          cancelAnchor={{ name: "data-project-purge-cancel", value: projectPurgeTarget.id }}
          confirmAnchor={{ name: "data-project-purge-confirm", value: projectPurgeTarget.id }}
        />
      )}
      {preview === null ? null : (
        <FilePreviewOverlay
          pane={preview.pane}
          name={preview.name}
          kind={preview.kind}
          nonce={preview.nonce}
          onRetry={() => {
            void retryPreview(preview.fileId, preview);
          }}
          onDownload={() => {
            void (async () => {
              try {
                const signed = await fetchDownloadUrl(preview.fileId);
                await triggerDownload(signed.url, signed.fileName);
              } catch (error) {
                setNotice({ kind: "error", text: error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed") });
              }
            })();
          }}
          onClose={() => {
            setPreview(null);
          }}
        />
      )}
    </div>
  );
}
