import { useEffect, useRef, useState } from "react";
import { startLiveSync } from "./liveSync";
import { applyInboxUnread, noteInboxNotification, refreshInboxUnread } from "./inbox";
import { useLiveRefresh } from "./useLiveRefresh";
import { AuditLogPage } from "./AuditLogPage";
import { FileLibraryPage } from "./FileLibraryPage";
import { SettingsPage } from "./SettingsPage";
import Hub from "./Hub";
import Home from "./Home";
import PlaceholderPage from "./PlaceholderPage";
import ProjectDetail from "./ProjectDetail";
import WorkspacePage from "./WorkspacePage";
import { ApiError, apiFetch, redirectToLogin } from "./api";
import { applyBackgroundTier, applyCardWatermark, asBackgroundTier, asCardWatermark } from "./backgroundTier";
import { applyLocale, asLocale, getLocale, textOf, useT, type TextKey } from "./i18n";
import { Loader } from "./components/Loader";
import { Toast } from "./components/Toast";
import { useFocusTrap } from "./components/useFocusTrap";
import { BindingGuideModal } from "./components/BindingGuideModal";
import { ProjectModal, type ProjectDraft, type ProjectSubmitResult } from "./components/ProjectModal";
import type { DictTools } from "./dictTools";
import { hasPermission, loadMyPermissions, useMyPermissions } from "./permissions";
import {
  createDictItem,
  deleteDictItem,
  EMPTY_DICTS,
  loadDicts,
  nextDictSort,
  type DictTypeCode,
  type DictTypeResult,
  type Dicts,
} from "./dicts";
import { directoryMemberOptions, loadDirectory, type DirectoryUser } from "./directory";
import { archiveProject, createProject, deleteProject, fetchProject, toUiProject, updateProject } from "./projectApi";
import { loadMyPreferences, loadMyPreferencesWithLegacyMigration, saveHomeSavedFilters, saveTaskTableHiddenColumns, saveHubDashProject, saveHubDashView, saveHubView, saveWorkspaceOpenProjects, type WorkspaceOpenProjects } from "./preferencesApi";
import type { SavedFilter } from "./savedFilters";
import { asHubDashView, type HubDashView } from "./data/dashboardProgress";
import { asHubView, replaceAuditQuery, replaceFilesQuery, replaceWorkspaceSub, replaceWorkspaceTab, useHashRoute, type HubView } from "./useHashRoute";
import { projectStatusOf, type MeResponse, type Project } from "./types";

type ViewState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; me: MeResponse }
  | { kind: "error"; message: string };

/** 写失败 → 面向业务的提示（错误码口径《前端功能需求》§3.7）。 */
function errorMessageOf(error: unknown, fallback: string): string {
  const t = (key: TextKey, params?: Record<string, string | number>): string => textOf(getLocale(), key, params);
  if (error instanceof ApiError) {
    if (error.code === "PROJECT_CODE_EXISTS") {
      return t("app.err.codeExists");
    }
    if (error.code === "VERSION_CONFLICT") {
      return t("app.err.versionConflict");
    }
    if (error.code === "PROJECT_ARCHIVED") {
      return t("app.err.archived");
    }
    if (error.code === "ARCHIVE_NOT_READY") {
      return t("app.err.archiveNotReady");
    }
    if (error.code === "ARCHIVE_GATE_NOT_PASSED") {
      return t("app.err.archiveGate");
    }
    if (error.code === "DICT_ITEM_EXISTS") {
      return t("app.err.dictExists");
    }
    if (error.code === "DICT_ITEM_IN_USE") {
      // A3 删除守卫（Push 174）：服务端文案自带「哪个条目 + 多少个项目在用」，原样透出比前端复述更准。
      return error.message;
    }
    if (error.code === "VALIDATION_FAILED") {
      const first = error.details[0];
      return first !== undefined && first.message !== "" ? t("app.err.validation", { message: first.message }) : t("app.err.validationPlain");
    }
    if (error.status === 403) {
      return t("app.err.forbidden");
    }
    if (error.status === 404) {
      return t("app.err.notFound");
    }
    return t("app.err.wrapped", { message: error.message, code: error.code });
  }
  return t("app.err.network", { fallback });
}

/**
 * 编辑弹窗字段与项目现值是否有差异（Push 262；Push 280 起含备注）：「已归档」保存要先落其余字段时，用来判断要不要先 PATCH。
 */
function projectFieldsChanged(
  project: Project,
  fields: { code: string; name: string; region: string; projectType: string; managerIds: string[]; remark: string },
): boolean {
  if (
    fields.code !== project.code ||
    fields.name !== project.description ||
    fields.remark !== project.remark ||
    fields.region !== project.region ||
    fields.projectType !== project.projectType
  ) {
    return true;
  }
  if (fields.managerIds.length !== project.managerIds.length) {
    return true;
  }
  return fields.managerIds.some((managerId, index) => managerId !== project.managerIds[index]);
}

export default function App() {
  const t = useT();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  // 参考数据：字典（地区 / 项目类型 + 主题色）、用户目录（项目经理）与本人偏好（常用筛选）；失败不阻塞登录，页面用兜底值
  const [dicts, setDicts] = useState<Dicts>(EMPTY_DICTS);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  // 常用筛选（A24 · Push 169 落库）：按账号存服务端，换设备同账号可见（契约 users.ts homeSavedFilters）
  const filterRevision = useRef(0);
  const archiveAttempt = useRef<{ id: string; version: number; fields: string } | null>(null);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  // 任务表列显隐（A4 · Push 170）：同样按账号存服务端；null = 偏好尚未取到（先用页面默认列）
  const [taskTableHiddenColumns, setTaskTableHiddenColumns] = useState<string[] | null>(null);
  /** 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）：按标签分记已展开的项目 id；null = 偏好尚未取到（按全收起渲染，不回写）。 */
  const [workspaceOpenProjects, setWorkspaceOpenProjects] = useState<WorkspaceOpenProjects | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  // 详情页数据（GET /projects/{id}）：列表分页外的项目也能直接打开
  const [detail, setDetail] = useState<Project | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 写操作后 +1：列表与详情按它重新取数（前端不做本地拼接，以服务端返回为准）
  const [dataVersion, setDataVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  /** 仪表盘页常驻视图（Push 332 · 业务口径「这个页面要记住 因为不同的人想常驻的页面可能不一样」）：按账号记住 —— 地址不带 `?view=` 时本页落在这一屏。 */
  const [hubView, setHubView] = useState<HubView>("map");
  /** 首落闸门（Push 354 · 业务口径 2026-10-16「仪表盘页面重新登录点击刷新后 会触发页面转场动画效果」）：账号记忆（prefs）落定前，
   *  仪表盘页 #/（无 ?view=）先不渲染卡面 —— 落哪一屏由记忆决定，记忆没到就落屏必出「先地图、后滑屏」的假转场。 */
  const [hubPrefsSettled, setHubPrefsSettled] = useState(false);
  /** 仪表盘常驻项目（Push 336 · 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」）：按账号记住选中的项目；null = 全部项目。 */
  const [hubDashProject, setHubDashProject] = useState<string | null>(null);
  /** 仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」）：按账号记住选中视图 —— 数据总览 / 项目进度 / 任务状态 / 问题 / 交付时间 / 词频图。 */
  const [hubDashView, setHubDashView] = useState<HubDashView>("progress");
  /** 权限画像（Push 172 重新接线）：管理入口的呈现层收敛 —— 字典治理（dict.manage）与删除项目（project.delete）。 */
  const permissions = useMyPermissions();
  /** 待确认删除的项目（卡片删除先出确认条，第二下才真删）：null = 没有待确认的删除。 */
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内（初始焦点不再留在背景卡片）、Tab 在条内循环、关闭还原。 */
  const deleteConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDelete !== null);
  const route = useHashRoute();

  const signedIn = state.kind === "signed-in";
  /** 站内信红点（Push 352）：登录后先按读面补拉一次角标（SSE 未连上也有数），随后由 unread 快照驱动；
   *  open（含自动重连；服务端重连不补发）再补拉一次对齐；notification 只推进弹窗补拉版本号。 */
  useEffect(() => {
    if (!signedIn) {
      return undefined;
    }
    void refreshInboxUnread();
    return startLiveSync({
      onUnread: applyInboxUnread,
      onNotification: noteInboxNotification,
      onOpen: () => { void refreshInboxUnread(); },
    });
  }, [signedIn]);
  useLiveRefresh(["dicts", "projects"], async () => {
    const next = await loadDicts();
    return () => setDicts(next);
  }, "dicts", signedIn);
  useLiveRefresh(["users"], async () => {
    const next = await loadDirectory();
    return () => setDirectory(next);
  }, "directory", signedIn);

  useLiveRefresh(["permissions", "users"], async () => {
    await loadMyPermissions(true);
    return () => {};
  }, "permissions", signedIn, { readOnly: true });

  useLiveRefresh(["preferences"], async () => {
    const prefs = await loadMyPreferences();
    return () => {
      filterRevision.current = prefs.revisions?.homeSavedFilters ?? 0;
      setSavedFilters(prefs.homeSavedFilters);
      setTaskTableHiddenColumns(prefs.taskTableHiddenColumns);
      setHubView(asHubView(prefs.hubView));
      setHubDashProject(prefs.hubDashProject ?? null);
      setHubDashView(asHubDashView(prefs.hubDashView));
      applyBackgroundTier(asBackgroundTier(prefs.backgroundTier));
      applyCardWatermark(asCardWatermark(prefs.cardWatermark));
      applyLocale(asLocale(prefs.locale));
      // Expansion is local while this workspace is open; use the remote value on the next visit.
      if (route.kind !== "workspace") setWorkspaceOpenProjects(prefs.workspaceOpenProjects);
    };
  }, "preferences", signedIn);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await apiFetch("/auth/me");
        if (cancelled) {
          return;
        }
        if (response.status === 401) {
          setState({ kind: "signed-out" });
          return;
        }
        if (!response.ok) {
          throw new Error("HTTP " + String(response.status));
        }
        const me = (await response.json()) as MeResponse;
        if (cancelled) {
          return;
        }
        setState({ kind: "signed-in", me });
        const [dictResult, directoryResult, prefsResult] = await Promise.allSettled([
          loadDicts(),
          loadDirectory(),
          loadMyPreferencesWithLegacyMigration(),
          loadMyPermissions(),
        ]);
        if (cancelled) {
          return;
        }
        if (dictResult.status === "fulfilled") {
          setDicts(dictResult.value);
        }
        if (directoryResult.status === "fulfilled") {
          setDirectory(directoryResult.value);
        }
        if (prefsResult.status === "fulfilled") {
          setSavedFilters(prefsResult.value.homeSavedFilters);
          filterRevision.current = prefsResult.value.revisions?.homeSavedFilters ?? 0;
          setTaskTableHiddenColumns(prefsResult.value.taskTableHiddenColumns);
          setWorkspaceOpenProjects(prefsResult.value.workspaceOpenProjects);
          setHubView(asHubView(prefsResult.value.hubView));
          // 仪表盘常驻项目（Push 336 · 「选择的项目也要记住 不随刷新变动而回到全部项目」）：登录后从账号偏好静默落位（缺键 / 已删项目在页面内回落全部项目）
          setHubDashProject(prefsResult.value.hubDashProject ?? null);
          // 仪表盘页内图表视图（Push 345 · 「选择后刷新不变 按账号记住」）：登录后从账号偏好静默落位（缺键 / 坏值回落项目进度）
          setHubDashView(asHubDashView(prefsResult.value.hubDashView));
          // 外观偏好（Push 291 背景档位 / Push 292 卡片水印）：登录后从账号偏好静默落位（坏值 / 缺键回落默认）
          applyBackgroundTier(asBackgroundTier(prefsResult.value.backgroundTier));
          applyCardWatermark(asCardWatermark(prefsResult.value.cardWatermark));
          // 界面语言（Push 296）：按账号静默落位（刷新 / 换设备同账号保持；坏值 / 缺键回落中文）
          applyLocale(asLocale(prefsResult.value.locale));
        }
        // Push 354 首落闸门放行：账号记忆到这一步已落定（成功落值 / 失败留缺省），#/ 无 ?view= 时可渲染卡面。
        setHubPrefsSettled(true);
      } catch (error: unknown) {
        if (!cancelled) {
          setState({ kind: "error", message: String(error) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.kind === "signed-out") {
      redirectToLogin();
    }
  }, [state]);

  const detailId = route.kind === "project" ? route.id : null;
  useLiveRefresh(["projects"], async () => {
    if (detailId === null) return () => {};
    try {
      const view = await fetchProject(detailId);
      return () => setDetail(toUiProject(view));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return () => setDetail(null);
      throw error;
    }
  }, String(detailId) + ":" + String(dataVersion), signedIn && detailId !== null && !detailLoading && detail !== null);
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const load = async (): Promise<void> => {
      try {
        const view = await fetchProject(detailId);
        if (!cancelled) {
          setDetail(toUiProject(view));
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setDetail(null);
          if (error instanceof ApiError && error.status !== 404) {
            setNotice(errorMessageOf(error, t("app.fail.loadProject")));
          }
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [detailId, dataVersion]);

  /** 新建项目（POST）：返回 null = 成功；返回文案 = 弹窗内提示（编号重复等）。 */
  const handleCreateProject = async (draft: ProjectDraft): Promise<string | null> => {
    try {
      await createProject({
        code: draft.code.trim(),
        name: draft.description.trim(),
        region: draft.region,
        projectType: draft.projectType,
        managerIds: draft.managerIds,
        remark: draft.note.trim(),
      });
      setDataVersion((value) => value + 1);
      return null;
    } catch (error: unknown) {
      return errorMessageOf(error, t("app.fail.createProject"));
    }
  };

  /** 字典写操作后的缓存替换（Push 173）：只换**当前类型**（写响应只带该类型；不本地拼接顺序，以服务端返回为准）。 */
  const applyDictType = (type: DictTypeCode, result: DictTypeResult): void => {
    setDicts((previous) => (type === "region" ? { ...previous, region: result.items } : { ...previous, projectType: result.items }));
  };

  /**
   * 字典「＋ 添加」（Push 167 地区起；Push 172 抽成两类共用一个实现）：写**数据字典**（C9-01 读 / C9-02 写）——
   * region 任何登录用户都能加（Push 168 业务口径「全站共享、非管理员也能加」）、projectType 需 dict.manage；
   * 保存后全站可见（所有项目的下拉都能选到）、可在首页按它筛选。码重复 409 / 无权限 403 由浮层内联提示。
   * Push 173：删除 = **物理删行**，删除无记忆 —— 同码可重新新增（按全新条目：本次颜色、排到末尾），界面无「恢复」字样。
   */
  const handleDictAdd: DictTools["onAdd"] = async (type, input) => {
    try {
      applyDictType(
        type,
        await createDictItem(type, {
          code: input.name,
          name: input.name,
          sort: nextDictSort(dicts[type]),
          enabled: true,
          metadata: input.metadata,
        }),
      );
      return null;
    } catch (error: unknown) {
      return errorMessageOf(error, type === "region" ? t("app.fail.addRegion") : t("app.fail.addProjectType"));
    }
  };

  /**
   * 字典「删除」（Push 173 起 = **物理删行**，C9-02 修订）：仅管理员（dict.manage，服务端裁决）。
   * 删除不影响存量数据展示（项目仍按原码 / 原名渲染；projects.region / project_type 是 text 冗余码，无外键），
   * 只是不再进下拉候选与首页筛选项；成功后条目立刻从候选里消失，同码可重新新增。
   * Push 174 引用守卫：被项目卡片引用的条目不给删 —— 前端删除位已置灰，万一缓存陈旧，服务端仍回 409 DICT_ITEM_IN_USE。
   */
  const handleDictDelete: DictTools["onDelete"] = async (type, code) => {
    try {
      applyDictType(type, await deleteDictItem(type, code));
      return null;
    } catch (error: unknown) {
      return errorMessageOf(error, type === "region" ? t("app.fail.deleteRegion") : t("app.fail.deleteProjectType"));
    }
  };

  /**
   * 删除项目（A5；Push 172 接上入口）：硬删（连同聚合子表物理删）+ If-Match 回传当前 version 防误删；卡片上的删除是隐式的，
   * 点一下先出确认条（项目是数据级操作），确认后才调 DELETE —— 成功后 dataVersion +1 刷新列表 / 详情。
   */
  const handleConfirmDeleteProject = async (): Promise<void> => {
    const project = pendingDelete;
    if (project === null) {
      return;
    }
    setPendingDelete(null);
    try {
      await deleteProject(project.id, project.version);
      setDataVersion((value) => value + 1);
    } catch (error: unknown) {
      setNotice(errorMessageOf(error, t("app.fail.deleteProject")));
    }
  };

  /**
   * 常用筛选（A24 · Push 169）：整体替换 PATCH —— 乐观更新（胶囊立即出现 / 消失），服务端返回后以它为准。
   * 失败回滚到上一次状态（服务端没落库，界面不能停在假状态）并把文案交给 Home 顶部的提示条。
   */
  const handleSaveSavedFilters = async (items: SavedFilter[]): Promise<string | null> => {
    const previous = savedFilters;
    setSavedFilters(items);
    try {
      const prefs = await saveHomeSavedFilters(items, filterRevision.current);
      setSavedFilters(prefs.homeSavedFilters);
      filterRevision.current = prefs.revisions?.homeSavedFilters ?? 0;
      return null;
    } catch (error: unknown) {
      setSavedFilters((current) => (current === items ? previous : current));
      return errorMessageOf(error, t("app.fail.saveFilters"));
    }
  };

  /**
   * 任务表列显隐（A4 · Push 170）：整体替换 PATCH —— 与常用筛选同一套乐观更新 + 失败回滚；
   * 返回文案交给 ProjectDetail 的提示条。
   */
  const handleSaveTaskHiddenColumns = async (keys: string[]): Promise<string | null> => {
    const previous = taskTableHiddenColumns;
    setTaskTableHiddenColumns(keys);
    try {
      const prefs = await saveTaskTableHiddenColumns(keys);
      setTaskTableHiddenColumns(prefs.taskTableHiddenColumns);
      return null;
    } catch (error: unknown) {
      setTaskTableHiddenColumns((current) => (current === keys ? previous : current));
      return errorMessageOf(error, t("app.fail.saveColumns"));
    }
  };

  /**
   * 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）：点一下即生效 + 单键 PATCH ——
   * 与醒目模式同一套乐观更新 + 失败回滚（对象整体替换，用引用比较判断有没有被更新的操作覆盖）；
   * 返回文案交给 WorkspacePage 的提示条（服务端没落库，界面不能停在假状态）。
   */
  const handleSaveWorkspaceOpenProjects = async (value: WorkspaceOpenProjects): Promise<string | null> => {
    const previous = workspaceOpenProjects;
    setWorkspaceOpenProjects(value);
    try {
      const prefs = await saveWorkspaceOpenProjects(value);
      setWorkspaceOpenProjects(prefs.workspaceOpenProjects);
      return null;
    } catch (error: unknown) {
      setWorkspaceOpenProjects((current) => (current === value ? previous : current));
      return errorMessageOf(error, t("app.fail.savePanels"));
    }
  };

  /**
   * 仪表盘页常驻视图（Push 332 · 业务口径 2026-10-15「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：
   * 与背景档位同一套乐观更新 + 失败回滚（单键 PATCH user_preferences.prefs.hubView；地址由页面自身写回）。
   */
  const handleHubViewChange = async (next: HubView): Promise<void> => {
    const previous = hubView;
    setHubView(next);
    try {
      const prefs = await saveHubView(next);
      setHubView(asHubView(prefs.hubView));
    } catch (error: unknown) {
      setHubView((current) => (current === next ? previous : current));
      setNotice(errorMessageOf(error, t("app.fail.saveHubView")));
    }
  };

  /**
   * 仪表盘常驻项目（Push 336 · 业务口径 2026-10-15「选择的项目也要记住 不随刷新变动而回到全部项目」）：
   * 与 hubView 同一套乐观更新 + 失败回滚（单键 PATCH user_preferences.prefs.hubDashProject；null = 回全部项目）。
   */
  const handleHubDashProjectChange = async (next: string | null): Promise<void> => {
    const previous = hubDashProject;
    setHubDashProject(next);
    try {
      const prefs = await saveHubDashProject(next);
      setHubDashProject(prefs.hubDashProject ?? null);
    } catch (error: unknown) {
      setHubDashProject((current) => (current === next ? previous : current));
      setNotice(errorMessageOf(error, t("app.fail.saveHubDashProject")));
    }
  };

  /**
   * 仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」）：
   * 与 hubDashProject 同一套乐观更新 + 失败回滚（单键 PATCH user_preferences.prefs.hubDashView）。
   */
  const handleHubDashViewChange = async (next: HubDashView): Promise<void> => {
    const previous = hubDashView;
    setHubDashView(next);
    try {
      const prefs = await saveHubDashView(next);
      setHubDashView(asHubDashView(prefs.hubDashView));
    } catch (error: unknown) {
      setHubDashView((current) => (current === next ? previous : current));
      setNotice(errorMessageOf(error, t("app.fail.saveHubDashView")));
    }
  };

  /**
   * 编辑项目（Push 262 起带状态口径）：active / paused / done 走 PATCH（乐观锁 version）；
   * archived 走归档端点（契约：PATCH 不收 archived —— ADR-027 门禁 + 清单 + 留痕）。
   * 返回结构化结果：ok = 成功；error = 文案；archive-confirm = 归档缺项，弹窗内二次确认。
   */
  const handleUpdateProject = async (
    project: Project,
    draft: ProjectDraft,
    options?: { archiveConfirm?: boolean; version?: number },
  ): Promise<ProjectSubmitResult> => {
    const fields = {
      code: draft.code.trim(),
      name: draft.description.trim(),
      region: draft.region,
      projectType: draft.projectType,
      managerIds: draft.managerIds,
      remark: draft.note.trim(),
    };
    try {
      if (draft.status !== "archived") {
        await updateProject(project.id, fields, options?.version ?? project.version, draft.status);
        setDataVersion((value) => value + 1);
        return { kind: "ok" };
      }
      const signature = JSON.stringify(fields);
      const attempt = archiveAttempt.current;
      let version = options?.archiveConfirm && attempt?.id === project.id && attempt.fields === signature ? attempt.version : options?.version ?? project.version;
      if (!options?.archiveConfirm && (options?.version !== undefined || projectFieldsChanged(project, fields))) {
        const saved = await updateProject(project.id, fields, version);
        version = saved.version;
      }
      archiveAttempt.current = { id: project.id, version, fields: signature };
      await archiveProject(project.id, version, options?.archiveConfirm === true);
      archiveAttempt.current = null;
      setDataVersion((value) => value + 1);
      return { kind: "ok" };
    } catch (error: unknown) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        try {
          const latest = toUiProject(await fetchProject(project.id));
          return { kind: "conflict", version: latest.version, latest: { code: latest.code, description: latest.description, note: latest.remark, managerIds: latest.managerIds, projectType: latest.projectType, region: latest.region, status: projectStatusOf(latest.status) ?? "active" } };
        } catch {
          return { kind: "error", message: t("app.err.projectGone") };
        }
      }
      if (error instanceof ApiError && error.code === "ARCHIVE_GATE_NOT_PASSED" && options?.archiveConfirm !== true) {
        return { kind: "archive-confirm", missing: error.details.map((detail) => detail.message) };
      }
      return { kind: "error", message: errorMessageOf(error, t("app.fail.saveProject")) };
    }
  };

  /** 任务抽屉 / 任务表里改「项目经理」：项目级字段，走 PATCH（乐观锁 version）。 */
  const handleChangeManagers = async (id: string, managerIds: string[]): Promise<boolean> => {
    if (detail === null || detail.id !== id) {
      return false;
    }
    const current = detail;
    try {
      const view = await updateProject(
        id,
        {
          code: current.code,
          name: current.description,
          region: current.region,
          projectType: current.projectType,
          managerIds,
        },
        current.version,
      );
      setDetail(toUiProject(view));
      setDataVersion((value) => value + 1);
      return true;
    } catch (error: unknown) {
      setNotice(errorMessageOf(error, t("app.fail.saveManagers")));
      return false;
    }
  };

  /**
   * 任务字段被编辑（M3-07 刀 1 后半接线）：任务写入会 touch 项目 updated_at（ADR-022 ④），
   * 这里只轻量刷新项目列表（详情里那一行已由 ProjectDetail 自己回读），下次回到首页能看到新时间。
   */
  const handleTaskEdited = (_id: string): void => {
    void _id;
    setDataVersion((value) => value + 1);
  };

  /** 字典下拉的「自定义 + 删除」能力（新建与编辑弹窗共用同一份）。 */
  const dictTools: DictTools = {
    onAdd: handleDictAdd,
    onDelete: handleDictDelete,
  };

  /** 权限分叉（Push 172）：字典治理 = dict.manage；删项目 = project.delete（服务端逐请求仍是最终裁决）。 */
  const canManageDicts = hasPermission(permissions, "dict.manage");
  const canDeleteProject = hasPermission(permissions, "project.delete");
  /**
   * 建 / 改项目（Push 173）：画像**未到时乐观放行**（网络抖动不该把有权限的账号挡在门外；服务端仍是最终裁决），
   * 已知缺位才收敛入口 —— 首页「新建项目」出禁用观感 + 提示条、卡片编辑入口不渲染。
   */
  const canCreateProject = permissions === null || hasPermission(permissions, "project.create");
  const canUpdateProject = permissions === null || hasPermission(permissions, "project.update");
  /** 归档权（Push 262 · M7-04 前端接线一部分）：决定编辑弹窗「已归档」选项是否可选（服务端逐请求仍是最终裁决）。 */
  const canArchiveProject = permissions === null || hasPermission(permissions, "project.archive");
  /**
   * 任务模板页的维护权（左列节点库的新增 / 编辑 / 删除 + 右侧模板的新建 / 保存 / 删除 / 拖拽改内容）= blueprint.manage
   * （Push 181 起节点库、Push 182 起模板；服务端逐请求仍是最终裁决 —— 无权 = 403 FORBIDDEN）。
   */
  const canManageBlueprint = hasPermission(permissions, "blueprint.manage");
  /**
   * 干系人写入口（Push 221 · A27）：新建 / 编辑 / 删除 = stakeholder.manage。与 project.create / project.update
   * 同一口径：画像未到时乐观放行（服务端逐请求仍是最终裁决），已知缺位才收起写入口 —— 读列表 = stakeholder.view
   * 全部角色都有，标签本身不收敛。
   */
  const canManageStakeholders = permissions === null || hasPermission(permissions, "stakeholder.manage");

  if (state.kind === "loading") {
    return (
      <main className="page">
        <Loader />
      </main>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <main className="page">
        <div className="card">
          <p className="muted">{t("app.login.redirecting")}</p>
        </div>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="page">
        <div className="card">
          <h1>{t("app.loadFailed")}</h1>
          <p className="muted">{state.message}</p>
          <p>
            <button
              type="button"
              onClick={() => {
                window.location.reload();
              }}
            >
              {t("common.retry")}
            </button>
          </p>
        </div>
      </main>
    );
  }

  /**
   * 全局提示区：
   * ① 删除项目确认条（Push 172：卡片隐式删除的第二下）—— 非阻断式确认，仍走底部固定条；
   * ② 错误提示（如加载 / 删除 / 项目经理修改失败）—— Push 261 追订改**屏幕上方居中浮空 Toast**
   *   （3s 自动消失口径见 Toast 组件；业务口径 2026-10-09「要直接在屏幕上方浮空的 然后保持3s消失 不要在页面顶部」）。
   */
  const bottomBars = (
    <>
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {pendingDelete === null ? null : (
        <div
          ref={deleteConfirmTrapRef}
          role="dialog"
          aria-label={t("app.delete.aria")}
          className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
        >
          <span>
            {t("app.delete.lead")} <span className="font-mono font-semibold">{pendingDelete.code}</span>{t("app.delete.tail", { name: pendingDelete.description })}
          </span>
          <button
            type="button"
            onClick={() => {
              setPendingDelete(null);
            }}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleConfirmDeleteProject();
            }}
            className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
          >
            {t("common.delete")}
          </button>
        </div>
      )}
      </div>
      {notice === null ? null : (
        <Toast
          kind="error"
          text={notice}
          onClose={() => {
            setNotice(null);
          }}
        />
      )}
      {/* 首登「绑定企业微信」引导（D5 · Push 250）：未绑定且本机未跳过才弹；已绑定 / 已跳过 = 静默不渲染。 */}
      <BindingGuideModal me={state.me} />
    </>
  );

  const editModal =
    editingProject === null ? null : (
      <ProjectModal
        key={editingProject.id + ":" + String(editingProject.version)}
        mode="edit"
        initial={{
          code: editingProject.code,
          description: editingProject.description,
          note: editingProject.remark,
          managerIds: editingProject.managerIds,
          projectType: editingProject.projectType,
          region: editingProject.region,
          status: projectStatusOf(editingProject.status) ?? "active",
        }}
        dicts={dicts}
        dictTools={dictTools}
        canManageDicts={canManageDicts}
        canArchive={canArchiveProject}
        managerOptions={directoryMemberOptions(directory)}
        onClose={() => {
          setEditingProject(null);
        }}
        onSubmit={async (draft, options) => {
          const result = await handleUpdateProject(editingProject, draft, options);
          if (result.kind === "ok") {
            setEditingProject(null);
          }
          return result;
        }}
      />
    );

  if (route.kind === "hub") {
    // 仪表盘页（顶层 · Push 285 前叫「入口页 / 首页」· Push 331 起叫「仪表盘」）：地图 / 仪表盘双视图（Push 332 起视图走地址 `?view=`；Push 358 起仪表盘侧含「数据总览」等六个图表视图）；登录后的默认落地已改项目空间 `#/projects`
    // Push 354 首落闸门（业务口径 2026-10-16「仪表盘页面重新登录点击刷新后 会触发页面转场动画效果」）：地址没写 ?view= 时，
    // 落哪一屏由账号记忆（prefs）决定 —— 记忆没落定前先不渲染卡面，防「先按缺省落地图、记忆晚到再换屏」的假转场；
    // 记忆落定后由 Hub 对齐 effect 瞬时对齐并把视图写回地址（见 Hub.tsx），之后刷新 / 收藏 / 分享都由地址直达。
    if (route.view === null && !hubPrefsSettled) {
      return (
        <main className="page">
          <Loader />
        </main>
      );
    }
    return (
      <>
        <Hub me={state.me} routeView={route.view} rememberedView={hubView} onViewChange={handleHubViewChange} rememberedDashProject={hubDashProject} onDashProjectChange={handleHubDashProjectChange} rememberedDashView={hubDashView} onDashViewChange={handleHubDashViewChange} />
        {bottomBars}
      </>
    );
  }

  if (route.kind === "workspace") {
    // 工作台「我的任务」页（Push 230 起正式落地）：三枚标签（我的任务 / 提出·负责的问题 / 我的计划）+ 按项目的折叠面板；
    // Push 260：第二枚标签改名「提出/负责的问题」并带下拉子菜单（我提出的问题 / 待我处理的问题，?sub=）；
    // 数据 = GET /api/v1/workspace（frontend/src/workspaceApi.ts）；标签走地址（?tab= / ?sub=，见 useHashRoute）。
    return (
      <>
        <WorkspacePage
          me={state.me}
          members={directoryMemberOptions(directory)}
          tab={route.tab}
          onChangeTab={replaceWorkspaceTab}
          sub={route.sub}
          onChangeSub={replaceWorkspaceSub}
          workspaceOpenProjects={workspaceOpenProjects}
          onWorkspaceOpenProjectsChange={handleSaveWorkspaceOpenProjects}
        />
        {bottomBars}
      </>
    );
  }

  if (route.kind === "placeholder") {
    return (
      <>
        <PlaceholderPage me={state.me} page={route.page} section={route.section} canManageBlueprint={canManageBlueprint} />
        {bottomBars}
      </>
    );
  }

  if (route.kind === "project") {
    if (detailLoading && detail === null) {
      return (
        <main className="page">
          <Loader />
        </main>
      );
    }
    return (
      <>
        <ProjectDetail
          me={state.me}
          project={detail}
          view={route.view}
          dailySub={route.sub}
          members={directoryMemberOptions(directory)}
          onChangeManagers={handleChangeManagers}
          onTaskEdited={handleTaskEdited}
          taskHiddenColumns={taskTableHiddenColumns}
          onTaskHiddenColumnsChange={handleSaveTaskHiddenColumns}
          canManageStakeholders={canManageStakeholders}
        />
        {editModal}
        {bottomBars}
      </>
    );
  }

  if (route.kind === "files") {
    // 文件库（Push 261 · 头像菜单「文件库」入口）：两栏（系统现有文件 / 回收站）+ 关键字 / 项目 / 状态 / 类型 / 上传人筛选，
    // 筛选态走地址（replaceFilesQuery，地址即状态）—— 与 #/audit 同一口径；数据 = 逐项目聚合（FileLibraryPage.tsx）。
    return (
      <>
        <FileLibraryPage me={state.me} query={route.query} onChangeQuery={replaceFilesQuery} directory={directory} />
        {bottomBars}
      </>
    );
  }

  if (route.kind === "audit") {
    // 操作记录（C7-04 管理员查询页 · u12）：入口 = 头像菜单「操作记录」（AppHeader · audit.view）；
    // 数据 = GET /api/v1/audit-logs（AuditLogPage + auditApi）；筛选态走地址（replaceAuditQuery，地址即状态）。
    return (
      <>
        <AuditLogPage me={state.me} query={route.query} onChangeQuery={replaceAuditQuery} directory={directory} />
        {bottomBars}
      </>
    );
  }

  if (route.kind === "settings") {
    // 设置页（Push 250 · 头像菜单首项「设置」）：账号级设置的家 —— 当前落点 = 企业微信绑定（D5 / D6 绑定码链路）。
    return (
      <>
        <SettingsPage me={state.me} />
        {bottomBars}
      </>
    );
  }

  return (
    <>
      <Home
        me={state.me}
        dicts={dicts}
        directory={directory}
        dictTools={dictTools}
        canManageDicts={canManageDicts}
        canDeleteProject={canDeleteProject}
        canCreateProject={canCreateProject}
        canUpdateProject={canUpdateProject}
        onDeleteProject={(project) => {
          setPendingDelete(project);
        }}
        savedFilters={savedFilters}
        onSavedFiltersChange={handleSaveSavedFilters}
        onCreate={handleCreateProject}
        onEdit={setEditingProject}
        refreshToken={dataVersion}
      />
      {editModal}
      {bottomBars}
    </>
  );
}
