import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { keepLiveOrder } from "./liveSync";
import { useLiveRefresh } from "./useLiveRefresh";
import { ApiError } from "./api";
import { cardBorderOf, cardTintOf, useBackgroundTier, useCardWatermark } from "./backgroundTier";
import type { DictTools } from "./dictTools";
import { AppHeader } from "./components/AppHeader";
import { Card } from "./components/Card";
import { CategoryFilterSidebar } from "./components/CategoryFilterSidebar";
import type { FacetOption } from "./components/CategoryFilterSidebar";
import { CategorySwitch } from "./components/CategorySwitch";
import type { DateRange } from "./components/DateRangePicker";
import { FilePreviewOverlay } from "./components/FilePreviewOverlay";
import { ImportProjectPanel } from "./components/ImportProjectPanel";
import { ProjectModal, type ProjectDraft } from "./components/ProjectModal";
import { SearchInput } from "./components/SearchInput";
import { Toast } from "./components/Toast";
import { useFocusTrap } from "./components/useFocusTrap";
import { dictLabel, typeAccent, type Dicts } from "./dicts";
import { directoryMemberOptions, directoryName, type DirectoryUser } from "./directory";
import { readStoredSidebarOpen, saveFiltersPref, saveSidebarPref } from "./homePrefs";
import { EMPTY_FACETS, buildListQuery, fetchProjectFacets, fetchProjectList, toUiProject, type ProjectFacets } from "./projectApi";
import { newSavedFilterId, sameCriteria } from "./savedFilters";
import type { FilterCriteria, SavedFilter } from "./savedFilters";
import { buildListHash, EMPTY_LIST_QUERY, hasListFilters, initialRouteRestored, openProject, replaceListQuery, useHashRoute } from "./useHashRoute";
import type { ListQueryState } from "./useHashRoute";
import { PROJECT_STATUS_VALUES, projectManagerText } from "./types";
import { isLocalizedLocale, projectStatusTextOf, projectTypeText, prefetchLocalizedText, useLocale, useT } from "./i18n";
import type { Locale } from "./i18n";
import { regionNameEn } from "./data/regionPicker";
import type { MeResponse, Project } from "./types";

type HomeProps = {
  me: MeResponse;
  /** 字典（地区 / 项目类型：下拉项与主题色）。 */
  dicts: Dicts;
  /** 用户目录（项目经理姓名与候选）。 */
  directory: DirectoryUser[];
  /** 字典（地区 / 项目类型）的「＋ 添加」与行内删除能力，与新建 / 编辑弹窗共用同一份。 */
  dictTools: DictTools;
  /** 是否持有 dict.manage（Push 172）：决定「＋ 添加项目类型」与两类条目删除入口的呈现。 */
  canManageDicts: boolean;
  /** 是否持有 project.delete（Push 172）：决定卡片上删除项目入口的呈现（服务端仍是最终裁决）。 */
  canDeleteProject: boolean;
  /** 是否持有 project.create（Push 173）：无权限时「新建项目」出禁用观感、点击给提示条（服务端仍是最终裁决）。 */
  canCreateProject: boolean;
  /** 是否持有 project.update（Push 173）：无权限时卡片编辑入口不渲染（与删除同款收敛口径）。 */
  canUpdateProject: boolean;
  /** 是否持有 project.export：无权限时卡片导出入口不渲染（服务端仍是最终裁决）。 */
  canExportProject: boolean;
  /** 导出项目全部数据（App 层调下载接口、持忙碌态并在失败时出全局提示）。 */
  onExportProject: (project: Project) => void;
  /** 正在导出的项目 id：null = 没有进行中的导出。 */
  exportingProjectId: string | null;
  /** 卡片删除项目（硬删；二次确认由 App 层的提示条承担）：确认后由父层调接口并刷新列表。 */
  onDeleteProject: (project: Project) => void;
  /** 新建项目：返回 null = 成功（父层刷新列表）；返回文案 = 失败提示（弹窗保持打开）。 */
  onCreate: (draft: ProjectDraft) => Promise<string | null>;
  onEdit: (project: Project) => void;
  /** 服务端写操作后的刷新信号（父层 +1 → 列表与计数重新取数）。 */
  refreshToken: number;
  /** 常用筛选（A24 · 服务端 user_preferences.homeSavedFilters）：父层持有，本组件只展示与触发保存。 */
  savedFilters: SavedFilter[];
  /** 保存 / 删除常用筛选（整体替换 PATCH）；返回 null = 成功，返回文案 = 失败提示（文案口径由父层给）。 */
  onSavedFiltersChange: (items: SavedFilter[]) => Promise<string | null>;
};

/** 排序维度固定「创建时间」（Push 177 口径）：显示名 / 口径说明 / 无权限提示均随语言切换，见 i18n 词典 home.sort.* 与 home.noCreatePermission。 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 地区显示名（Push 301）：英文界面按标准英文国名（regionNameEn），认不出的值原样返回 —— 侧栏地区胶囊用（卡片水印的回退值同源）。 */
function regionText(locale: Locale, dicts: Dicts, code: string): string {
  const label = dictLabel(dicts, "region", code);
  return isLocalizedLocale(locale) ? regionNameEn(label) || label : label;
}

/** 卡片水印文本（Push 301 追订 · 业务口径「中文模式和英文模式水印不一样」「之前的中文不要改」+「缩写不好看 试试全称吧」）：中文界面 = 地区中文名（Push 289 原样，不改）；英文界面 = 英文全称（认不出回退中文名）。 */
function regionWatermarkText(locale: Locale, dicts: Dicts, code: string): string {
  const label = dictLabel(dicts, "region", code);
  return locale === "zh" ? label : regionNameEn(label) || label;
}

/** 计数 → 侧栏选项：字典顺序优先、未知码排后；已选但零命中的值保留（否则没办法取消勾选）。 */
function buildOptions(
  counts: Record<string, number>,
  selected: string[],
  labelOf: (value: string) => string,
  order: string[],
): FacetOption[] {
  const values = new Set<string>(Object.keys(counts));
  for (const value of selected) {
    values.add(value);
  }
  const rank = new Map(order.map((value, index) => [value, index]));
  return Array.from(values)
    .map((value) => ({ value, count: counts[value] ?? 0, label: labelOf(value) }))
    .sort((left, right) => {
      const leftRank = rank.get(left.value) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.value) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return right.count - left.count;
    });
}

/** 加载失败提示的种类（Push 301）：文案取词典，语言切换后提示跟着变。 */
type LoadError =
  | { kind: "reset" }
  | { kind: "network" }
  | { kind: "api"; message: string; code: string };

export default function Home({ me, dicts, directory, dictTools, canManageDicts, canDeleteProject, canCreateProject, canUpdateProject, canExportProject, onExportProject, exportingProjectId, onDeleteProject, onCreate, onEdit, refreshToken, savedFilters, onSavedFiltersChange }: HomeProps) {
  const t = useT();
  const locale = useLocale();
  /** 无建项目权限提示（Push 173 口径；文案随语言切换）。 */
  const noCreatePermission = t("home.noCreatePermission");

  const route = useHashRoute();
  /** 背景档位（Push 289 · 同日「先来适中版」→「不同项目类型的颜色不同应该」→「用 c 试试」）：适中 = 项目卡片按项目类型铺「便签同款实色」。 */
  const backgroundTier = useBackgroundTier();
  /** 卡片水印开关（Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」）：关 = 卡片不渲染国家名水印。 */
  const cardWatermark = useCardWatermark();
  const filters = route.kind === "list" ? route.filters : EMPTY_LIST_QUERY;
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // 常用筛选（Push 138；Push 169 起按账号存服务端）：组合由父层持有（同账号换设备可见），点一下套用到当前筛选
  // 「哪组正在生效」由条件比较派生，不另存状态；保存 / 删除失败的提示条见 savedFilterError
  const [savedFilterError, setSavedFilterError] = useState<string | null>(null);
  // 待确认删除的常用筛选（Push 264 追订）：第一下只开底部确认条（与删除项目 / 模板同款非阻断），第二下才真删
  const [pendingDeleteFilter, setPendingDeleteFilter] = useState<SavedFilter | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内、Tab 在条内循环、关闭还原到胶囊行的删除按钮。 */
  const deleteFilterConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDeleteFilter !== null);
  // 无建项目权限时点「新建项目」的提示（Push 173；与 savedFilterError 同款琥珀提示条）
  const [createHint, setCreateHint] = useState<string | null>(null);
  // 「导入项目」（Push 316 待推 · 直连 API 导入）：文件选择 + 面板开合由本页持有 —— 面板是页内大屏（不动路由不刷新页面），
  // 选中文件即打开；关闭 / 导入完成清空。同一文件重复选也要能重开（onChange 里把 value 复位）。
  const [importFile, setImportFile] = useState<File | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // 导入说明浮层（Push 329 · 2026-10-15）：点击「导入说明」= 系统内浮层预览（复用文件预览浮层 · iframe 浏览器内置 PDF 渲染 · Esc / 点遮罩关闭），不开新标签页。
  const [guideOpen, setGuideOpen] = useState(false);
  const onImportFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (picked === null) {
      return;
    }
    setImportFile(picked);
  };
  // 侧边栏开合：URL 带参数的入口保持「有筛选自动展开」（既定行为）；无参数的书签入口完全按本地记忆恢复
  const [filterOpen, setFilterOpen] = useState(() => {
    if (initialRouteRestored()) {
      const storedOpen = readStoredSidebarOpen();
      return storedOpen === null ? hasListFilters(filters) : storedOpen;
    }
    return hasListFilters(filters) || readStoredSidebarOpen() === true;
  });
  // 手改地址 / 分享过期可能带非 UUID 的经理值：先在本地丢弃，再由 effect 归一化地址栏（服务端 400 的兜底见下面 error 分支）
  const activeFilters = useMemo<ListQueryState>(() => {
    const managerIds = filters.managerIds.filter((managerId) => UUID.test(managerId));
    return managerIds.length === filters.managerIds.length ? filters : { ...filters, managerIds };
  }, [filters]);
  useEffect(() => {
    if (buildListHash(activeFilters) !== buildListHash(filters)) {
      replaceListQuery(activeFilters);
    }
  }, [activeFilters, filters]);

  const updateFilters = (patch: Partial<ListQueryState>) => {
    const next = { ...activeFilters, ...patch };
    replaceListQuery(next);
    // 用户主动操作（勾选 / 时间区间 / 排序 / 搜索）：更新本地记忆，作为不带参数入口的恢复依据（关键字不写入）
    saveFiltersPref(next);
  };
  const query = activeFilters.q;
  const keyword = query.trim();
  const hasFilters = hasListFilters(activeFilters);
  const sortDesc = activeFilters.sortDesc;
  const dateRange: DateRange | null =
    activeFilters.timeFrom !== null && activeFilters.timeTo !== null
      ? { from: activeFilters.timeFrom, to: activeFilters.timeTo }
      : null;

  // 关键字防抖：输入时不每个字符打一次接口（250ms 内的最后一次生效）
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(activeFilters.q);
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeFilters.q]);
  const requestFilters = useMemo<ListQueryState>(
    () => ({ ...activeFilters, q: debouncedQuery }),
    [activeFilters, debouncedQuery],
  );
  const requestKey = useMemo(() => buildListQuery(requestFilters), [requestFilters]);
  const requestRef = useRef(requestFilters);
  requestRef.current = requestFilters;

  // 服务端数据：列表 + 三组计数（各自排除自己那一维）
  const [items, setItems] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  /** 加载失败提示（Push 301）：存种类不存死文案 —— 语言切换后提示跟着变。 */
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const loadErrorText =
    loadError === null
      ? null
      : loadError.kind === "reset"
        ? t("home.err.reset")
        : loadError.kind === "network"
          ? t("home.err.network")
          : t("home.err.api", { message: loadError.message, code: loadError.code });
  const [facets, setFacets] = useState<ProjectFacets>(EMPTY_FACETS);
  const [savedCounts, setSavedCounts] = useState<Record<string, number>>({});
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * 「手打内容」提前预热（业务口径 2026-10-13「因为页面有些内容是手打的 我建议是提前后台机翻」）：
   * 项目数据一到就把项目名（手打文本）丢进译文缓存后台翻好 —— 中文界面浏览时也翻，切英文 / 导出直接命中。
   */
  useEffect(() => {
    prefetchLocalizedText(items.map((project) => project.description));
  }, [items, locale]);

  useLiveRefresh(["projects", "dicts", "permissions", "users"], async () => {
    const current = requestRef.current;
    const [page, regions, types, managers, statuses, counts] = await Promise.all([
      fetchProjectList(current), fetchProjectFacets(current, "regions"), fetchProjectFacets(current, "projectTypes"),
      fetchProjectFacets(current, "managerIds"), fetchProjectFacets(current, "statuses"),
      Promise.all(savedFilters.map(async (filter): Promise<[string, number]> => {
        const result = await fetchProjectFacets({ regions: filter.regions, projectTypes: filter.projectTypes, managerIds: filter.managerIds, statuses: [], timeFrom: filter.timeFrom, timeTo: filter.timeTo, q: "", sortDesc: true });
        return [filter.id, result.total];
      })),
    ]);
    return () => {
      setItems((previous) => keepLiveOrder(previous, page.items.map(toUiProject)));
      setTotal(page.total);
      setFacets({ total: managers.total, region: regions.region, projectType: types.projectType, managerId: managers.managerId, stageKey: regions.stageKey, status: statuses.status });
      setSavedCounts(Object.fromEntries(counts));
      setLoadError(null);
    };
  }, requestKey + ":" + String(reloadToken) + ":" + String(refreshToken) + ":" + JSON.stringify(savedFilters), !loading && loadError === null);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const current = requestRef.current;
      setLoading(true);
      try {
        const [page, regionFacets, typeFacets, managerFacets, statusFacets] = await Promise.all([
          fetchProjectList(current),
          fetchProjectFacets(current, "regions"),
          fetchProjectFacets(current, "projectTypes"),
          fetchProjectFacets(current, "managerIds"),
          fetchProjectFacets(current, "statuses"),
        ]);
        if (cancelled) {
          return;
        }
        setItems(page.items.map(toUiProject));
        setTotal(page.total);
        setFacets({
          total: managerFacets.total,
          region: regionFacets.region,
          projectType: typeFacets.projectType,
          managerId: managerFacets.managerId,
          stageKey: regionFacets.stageKey,
          status: statusFacets.status,
        });
        setLoadError(null);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 400) {
          // 非法筛选值（UUID / 日期 / limit）：丢弃整组条件并归一化地址栏，让页面回到可用状态
          replaceListQuery(EMPTY_LIST_QUERY);
          setLoadError({ kind: "reset" });
        } else if (error instanceof ApiError) {
          setLoadError({ kind: "api", message: error.message, code: error.code });
        } else {
          setLoadError({ kind: "network" });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloadToken, refreshToken]);

  // 常用筛选胶囊计数：按该组合单独取一次 total（服务端同口径判定），与当前筛选无关
  useEffect(() => {
    if (savedFilters.length === 0) {
      setSavedCounts({});
      return;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const entries = await Promise.all(
          savedFilters.map(async (filter): Promise<[string, number]> => {
            const result = await fetchProjectFacets({
              regions: filter.regions,
              projectTypes: filter.projectTypes,
              managerIds: filter.managerIds,
              statuses: [],
              timeFrom: filter.timeFrom,
              timeTo: filter.timeTo,
              q: "",
              sortDesc: true,
            });
            return [filter.id, result.total];
          }),
        );
        if (!cancelled) {
          setSavedCounts(Object.fromEntries(entries));
        }
      } catch {
        if (!cancelled) {
          setSavedCounts({});
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [savedFilters, reloadToken, refreshToken]);

  const regionOptions = useMemo(
    () =>
      buildOptions(
        facets.region,
        activeFilters.regions,
        (code) => regionText(locale, dicts, code),
        dicts.region.map((item) => item.code),
      ),
    [activeFilters.regions, dicts, facets.region, locale],
  );
  const typeOptions = useMemo(
    () =>
      buildOptions(
        facets.projectType,
        activeFilters.projectTypes,
        (code) => projectTypeText(locale, dictLabel(dicts, "projectType", code)),
        dicts.projectType.map((item) => item.code),
      ),
    [activeFilters.projectTypes, dicts, facets.projectType, locale],
  );
  const managerOptions = useMemo(
    () =>
      buildOptions(
        facets.managerId,
        activeFilters.managerIds,
        (managerId) => directoryName(directory, managerId),
        [],
      ),
    [activeFilters.managerIds, directory, facets.managerId],
  );
  const statusOptions = useMemo(
    () =>
      buildOptions(
        facets.status,
        activeFilters.statuses,
        (status) => projectStatusTextOf(locale, status),
        PROJECT_STATUS_VALUES.slice(),
      ),
    [activeFilters.statuses, facets.status, locale],
  );
  const newestDay = useMemo(
    () => items.reduce((latest, project) => (project.updatedAt > latest ? project.updatedAt : latest), "").slice(0, 10),
    [items],
  );
  const managerChoices = useMemo(() => directoryMemberOptions(directory), [directory]);

  const resetFilters = () => {
    updateFilters({ regions: [], projectTypes: [], managerIds: [], statuses: [], timeFrom: null, timeTo: null });
  };
  // 正在生效的常用筛选：条件与某一组等价即高亮（排序 / 关键字不影响判定）
  const appliedSavedFilterId = useMemo(() => {
    if (!hasFilters) {
      return null;
    }
    const matched = savedFilters.find((filter) => sameCriteria(filter, activeFilters));
    return matched === undefined ? null : matched.id;
  }, [activeFilters, hasFilters, savedFilters]);
  const applySavedFilter = (filter: SavedFilter) => {
    updateFilters({
      regions: filter.regions.slice(),
      projectTypes: filter.projectTypes.slice(),
      managerIds: filter.managerIds.slice(),
      // 常用筛选不含项目状态：应用组合时把状态筛选归零，避免「高亮的组合 ≠ 当前视图」
      statuses: [],
      timeFrom: filter.timeFrom,
      timeTo: filter.timeTo,
    });
  };
  // 保存 / 删除 = 整体替换 PATCH（父层乐观更新 + 失败回滚）；返回文案时在页面顶部出提示条，不静默吞失败
  const persistSavedFilters = async (next: SavedFilter[]): Promise<void> => {
    setSavedFilterError(await onSavedFiltersChange(next));
  };
  const deleteSavedFilter = (id: string) => {
    void persistSavedFilters(savedFilters.filter((item) => item.id !== id));
  };
  /** 常用筛选删除第一下：只挂起（不落库），等底部确认条的第二下（业务口径 2026-10-10「删除常用筛选无二次确认」）。 */
  const requestDeleteSavedFilter = (filter: SavedFilter) => {
    setPendingDeleteFilter(filter);
  };
  /** 底部确认条的第二下：真删（整体替换 PATCH —— 失败仍走 savedFilterError 提示条，不静默吞）。 */
  const confirmDeleteSavedFilter = () => {
    const filter = pendingDeleteFilter;
    if (filter === null) {
      return;
    }
    setPendingDeleteFilter(null);
    deleteSavedFilter(filter.id);
  };
  const saveSavedFilter = ({ id, name, criteria }: { id: string | null; name: string; criteria: FilterCriteria }) => {
    // 保存前按当前字典 / 计数兜底：丢弃已不存在的地区 / 类型 / 经理（与 URL 参数归一化同一收敛口径）
    const knownRegions = new Set(Object.keys(facets.region));
    const knownTypes = new Set(Object.keys(facets.projectType));
    const knownManagers = new Set(Object.keys(facets.managerId));
    const normalized: FilterCriteria = {
      regions: criteria.regions.filter((region) => knownRegions.has(region)),
      projectTypes: criteria.projectTypes.filter((projectType) => knownTypes.has(projectType)),
      managerIds: criteria.managerIds.filter((managerId) => knownManagers.has(managerId)),
      timeFrom: criteria.timeFrom,
      timeTo: criteria.timeTo,
    };
    const next =
      id === null
        ? [...savedFilters, { id: newSavedFilterId(), name, ...normalized }]
        : savedFilters.map((item) => (item.id === id ? { ...item, name, ...normalized } : item));
    void persistSavedFilters(next);
    // 保存即应用（刚定义的一组就是要看的那组）；当前筛选保留的部分以这组为准整体替换
    updateFilters({
      regions: normalized.regions,
      projectTypes: normalized.projectTypes,
      managerIds: normalized.managerIds,
      statuses: [],
      timeFrom: normalized.timeFrom,
      timeTo: normalized.timeTo,
    });
  };
  const toggleValue = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  return (
    <div className="min-h-screen">
      <AppHeader me={me} />

      <CategoryFilterSidebar
        open={filterOpen}
        regions={regionOptions}
        types={typeOptions}
        managers={managerOptions}
        statuses={statusOptions}
        savedFilterCounts={savedCounts}
        newestDay={newestDay}
        selectedRegions={activeFilters.regions}
        selectedManagerIds={activeFilters.managerIds}
        selectedTypes={activeFilters.projectTypes}
        selectedStatuses={activeFilters.statuses}
        dateRange={dateRange}
        savedFilters={savedFilters}
        appliedSavedFilterId={appliedSavedFilterId}
        onApplySavedFilter={applySavedFilter}
        onRequestDeleteSavedFilter={requestDeleteSavedFilter}
        onSaveSavedFilter={saveSavedFilter}
        onToggleRegion={(region) => {
          updateFilters({ regions: toggleValue(activeFilters.regions, region) });
        }}
        onToggleRegions={(values, checked) => {
          const current = new Set(activeFilters.regions);
          for (const value of values) {
            if (checked) {
              current.add(value);
            } else {
              current.delete(value);
            }
          }
          updateFilters({ regions: Array.from(current) });
        }}
        onToggleManager={(managerId) => {
          updateFilters({ managerIds: toggleValue(activeFilters.managerIds, managerId) });
        }}
        onToggleType={(projectType) => {
          updateFilters({ projectTypes: toggleValue(activeFilters.projectTypes, projectType) });
        }}
        onToggleStatus={(status) => {
          updateFilters({ statuses: toggleValue(activeFilters.statuses, status) });
        }}
        onDateRangeChange={(range) => {
          updateFilters({
            timeFrom: range === null ? null : range.from,
            timeTo: range === null ? null : range.to,
          });
        }}
        onReset={resetFilters}
        onClose={() => {
          setFilterOpen(false);
          saveSidebarPref(false);
        }}
      />

      <main className={"@container w-full pt-0 pb-10 pr-6 pl-6 transition-[padding-left] duration-300 ease-out " + (filterOpen ? "md:pl-[304px]" : "")}>
        <div className="sticky top-16 z-10 -mx-6 mb-6 flex flex-wrap items-center gap-3 bg-[#f5f6f8] px-6 pt-4 pb-2">
          <CategorySwitch
            checked={filterOpen}
            onChange={(next) => {
              setFilterOpen(next);
              saveSidebarPref(next);
            }}
          />
          <div
            role="group"
            aria-label={t("home.sort.groupAria")}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-1 text-xs"
          >
            {/* 排序维度（Push 177）：固定创建时间，只作说明（不参与点击），维度切换按钮已下线 */}
            <span className="px-2.5 py-1.5 text-zinc-400 select-none">{t("home.sort.field")}</span>
            <span className="h-3.5 w-px bg-zinc-200" aria-hidden="true" />
            <button
              type="button"
              aria-pressed={sortDesc}
              aria-label={t("home.sort.descAria")}
              title={t("home.sort.descTitle")}
              onClick={() => {
                updateFilters({ sortDesc: true });
              }}
              className={
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 transition " +
                (sortDesc ? "bg-zinc-900 font-medium text-white" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700")
              }
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M12 5v14M12 19l-5-5M12 19l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("home.sort.desc")}
            </button>
            <button
              type="button"
              aria-pressed={!sortDesc}
              aria-label={t("home.sort.ascAria")}
              title={t("home.sort.ascTitle")}
              onClick={() => {
                updateFilters({ sortDesc: false });
              }}
              className={
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 transition " +
                (sortDesc ? "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700" : "bg-zinc-900 font-medium text-white")
              }
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M12 19V5M12 5l-5 5M12 5l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("home.sort.asc")}
            </button>
          </div>
          <span className="text-sm text-zinc-400">
            {keyword === "" && !hasFilters ? t("home.count.total", { n: total }) : t("home.count.found", { n: total })}
          </span>
          <div className="ml-auto flex w-full flex-col items-start gap-3 sm:w-auto sm:flex-row sm:items-center">
            {/* 导入项目（Push 316 待推）：新建项目左侧 —— 点开原生文件选择（.xlsx / .xlsm），选完在页内大屏面板里解析 / 校验 / 导入 */}
            {/* 导入说明（Push 328 追订 · 2026-10-15）：不常显 —— 悬停 / 键盘聚焦「导入项目」时按钮下方浮出入口（业务口径「鼠标触碰导入项目再上下显示」）；点击「导入说明」= 系统内浮层预览（Push 329 起：复用文件预览浮层 · iframe 浏览器内置 PDF 渲染 · Esc / 点遮罩关闭 · 浮层内可下载原文件），静态件随构建发布（public/docs/import-guide.pdf） */}
            <div className="group relative">
            <button
              type="button"
              data-import-project=""
              aria-disabled={canCreateProject ? undefined : true}
              title={canCreateProject ? undefined : noCreatePermission}
              onClick={() => {
                if (!canCreateProject) {
                  setCreateHint(noCreatePermission);
                  return;
                }
                importInputRef.current?.click();
              }}
              className={
                "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 " +
                (canCreateProject
                  ? "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200"
                  : "cursor-not-allowed border border-transparent bg-zinc-200 text-zinc-400")
              }
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M12 15V4M12 4L8 8M12 4l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t("home.import")}
            </button>
              <div className="invisible absolute left-0 top-full z-30 pt-2 opacity-0 pointer-events-none transition-[opacity,visibility] duration-150 group-hover:visible group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                <button
                  type="button"
                  data-import-guide=""
                  onClick={() => {
                    setGuideOpen(true);
                  }}
                  className="relative flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 shadow-lg transition hover:bg-zinc-50 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50"
                >
                  <span className="absolute -top-[5px] left-5 h-2.5 w-2.5 rotate-45 border-l border-t border-zinc-200 bg-white" aria-hidden="true" />
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  {t("home.importGuide")}
                </button>
              </div>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              data-import-file-input=""
              onChange={onImportFileChange}
            />
            {guideOpen ? (
              <FilePreviewOverlay
                pane={{ mode: "url", url: import.meta.env.BASE_URL + "docs/import-guide.pdf" }}
                name={t("home.importGuide")}
                kind="pdf"
                nonce={0}
                onRetry={() => {}}
                onDownload={() => {
                  const link = document.createElement("a");
                  link.href = import.meta.env.BASE_URL + "docs/import-guide.pdf";
                  link.download = "LibiaoLink导入表导入规则说明.pdf";
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                }}
                onClose={() => {
                  setGuideOpen(false);
                }}
              />
            ) : null}
            <button
              type="button"
              aria-disabled={canCreateProject ? undefined : true}
              title={canCreateProject ? undefined : noCreatePermission}
              onClick={() => {
                if (!canCreateProject) {
                  setCreateHint(noCreatePermission);
                  return;
                }
                setIsCreateOpen(true);
              }}
              className={
                "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 " +
                (canCreateProject
                  ? "bg-[#feca04] text-zinc-900 hover:brightness-95 active:brightness-90"
                  : "cursor-not-allowed bg-zinc-200 text-zinc-400 hover:brightness-100 active:brightness-100")
              }
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t("home.create")}
            </button>
            <SearchInput
              value={query}
              onChange={(value) => {
                updateFilters({ q: value });
              }}
              placeholder={t("home.search.placeholder")}
              className="w-full sm:w-72"
            />
          </div>
        </div>

        {loadError === null ? null : (
          <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <span>{loadErrorText}</span>
            <button
              type="button"
              onClick={() => {
                setReloadToken((value) => value + 1);
              }}
              className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs font-medium transition hover:bg-rose-100"
            >
              {t("home.retry")}
            </button>
          </div>
        )}

        {createHint === null ? null : (
          <Toast
            kind="info"
            text={createHint}
            onClose={() => {
              setCreateHint(null);
            }}
          />
        )}

        {savedFilterError === null ? null : (
          <Toast
            kind="error"
            text={savedFilterError}
            onClose={() => {
              setSavedFilterError(null);
            }}
          />
        )}

        {loading && items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-16 text-center">
            <p className="text-sm text-zinc-500">{t("home.loading")}</p>
          </div>
        ) : null}

        {!loading && items.length === 0 && loadError === null ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-16 text-center">
            <p className="text-sm text-zinc-500">
              {keyword === "" ? t("home.empty.filtered") : t("home.empty.keyword", { kw: keyword })}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              {keyword !== "" && (
                <button
                  type="button"
                  onClick={() => {
                    updateFilters({ q: "" });
                  }}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
                >
                  {t("home.clearSearch")}
                </button>
              )}
              {hasFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
                >
                  {t("home.clearFilters")}
                </button>
              )}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 @md:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4">
          {items.map((project) => (
            <div
              key={project.id}
              data-live-row={project.id}
              role="link"
              tabIndex={0}
              aria-label={t("home.openAria", { code: project.code })}
              onClick={() => openProject(project.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openProject(project.id);
                }
              }}
              className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <Card
                seqNo={project.seqNo}
                code={project.code}
                description={project.description}
                watermark={cardWatermark ? regionWatermarkText(locale, dicts, project.region) : undefined}
                watermarkBleed={locale === "zh"}
                tint={cardTintOf(backgroundTier, typeAccent(dicts, project.projectType).color)}
                tintBorder={cardBorderOf(backgroundTier, typeAccent(dicts, project.projectType).color)}
                vividInk={backgroundTier === "vivid"}
                typeLabel={projectTypeText(locale, dictLabel(dicts, "projectType", project.projectType))}
                status={project.status}
                statusText={projectStatusTextOf(locale, project.status)}
                accentColor={typeAccent(dicts, project.projectType).color}
                accentText={typeAccent(dicts, project.projectType).text}
                managerNames={projectManagerText(project)}
                time={project.createdAt}
                onEdit={
                  canUpdateProject
                    ? () => {
                        onEdit(project);
                      }
                    : undefined
                }
                onExport={
                  canExportProject
                    ? () => {
                        onExportProject(project);
                      }
                    : undefined
                }
                exporting={exportingProjectId === project.id}
                onDelete={
                  canDeleteProject
                    ? () => {
                        onDeleteProject(project);
                      }
                    : undefined
                }
              />
            </div>
          ))}
        </div>

        {total > items.length ? (
          <p className="mt-6 text-center text-xs text-zinc-400">
            {t("home.shown", { shown: items.length, total: total })}
          </p>
        ) : null}
      </main>

      {importFile === null ? null : (
        <ImportProjectPanel
          file={importFile}
          dicts={dicts}
          dictTools={dictTools}
          canManageDicts={canManageDicts}
          onReselect={() => {
            importInputRef.current?.click();
          }}
          onClose={() => {
            setImportFile(null);
          }}
          onImported={() => {
            setReloadToken((value) => value + 1);
          }}
        />
      )}

      {isCreateOpen && (
        <ProjectModal
          mode="create"
          dicts={dicts}
          dictTools={dictTools}
          canManageDicts={canManageDicts}
          managerOptions={managerChoices}
          onClose={() => setIsCreateOpen(false)}
          onSubmit={async (draft) => {
            const message = await onCreate(draft);
            if (message === null) {
              setIsCreateOpen(false);
              return { kind: "ok" };
            }
            return { kind: "error", message: message };
          }}
        />
      )}

      {/* 常用筛选删除的第二下确认条（Push 264 追订 · 业务口径「删除常用筛选无二次确认」）：与「删除项目 / 模板」同款
          非阻断固定底栏 —— 第一下只开口，第二下「删除」才落库。 */}
      {pendingDeleteFilter === null ? null : (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
          <div
            ref={deleteFilterConfirmTrapRef}
            role="dialog"
            aria-label={t("home.deleteFilter.aria")}
            data-saved-filter-delete-confirm=""
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
          >
            <span>
              {t("home.deleteFilter.pre")}<span className="font-semibold">{pendingDeleteFilter.name}</span>{t("home.deleteFilter.post")}
            </span>
            <button
              type="button"
              onClick={() => {
                setPendingDeleteFilter(null);
              }}
              className="shrink-0 whitespace-nowrap rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
            >
              {t("home.cancel")}
            </button>
            <button
              type="button"
              data-saved-filter-delete=""
              onClick={confirmDeleteSavedFilter}
              className="shrink-0 whitespace-nowrap rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
            >
              {t("home.delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
