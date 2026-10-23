import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "./ScrollArea";
import { DateRangePicker } from "./DateRangePicker";
import type { DateRange } from "./DateRangePicker";
import {
  SAVED_FILTER_LIMIT,
  SAVED_FILTER_NAME_MAX,
  criteriaOf,
  emptyCriteria,
  hasCriteria,
  normalizeFilterName,
} from "../savedFilters";
import type { FilterCriteria, SavedFilter } from "../savedFilters";
import { groupByContinent, type ContinentGroup } from "../data/regionContinents";
import { continentText, useLocale, useT } from "../i18n";

/** 「液态玻璃」材质（与任务表行内编辑单元格同口径，Push 66 / 67 定稿）：白底 + 发丝描边 + 顶部内高光 + 极轻投影。 */
const GLASS_SURFACE =
  "border-zinc-200/90 bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-[3px] hover:border-zinc-300 hover:bg-white hover:shadow-[0_2px_6px_rgba(15,23,42,0.08)]";

/** 侧栏玻璃底板（液态玻璃，与页面浮层同口径）：半透明白渐变 + 白色发丝边 + 顶缘高光 + 柔和投影 + 背景虚化。 */
const GLASS_PANEL =
  "border-r border-white/80 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.72),rgba(255,255,255,0.5))] " +
  "shadow-[inset_1px_0_0_rgba(255,255,255,0.75),0_8px_32px_rgba(15,23,42,0.14)] backdrop-blur-2xl backdrop-saturate-150";

/** 侧栏一组计数：value = 筛选值（字典码 / 经理 UUID），label = 展示名，count = 命中数。 */
export type FacetOption = { value: string; count: number; label: string };

type CategoryFilterSidebarProps = {
  open: boolean;
  /** 三组计数（各自排除自己那一维、其余条件照常参与；数据来自 GET /projects/facets）。 */
  regions: FacetOption[];
  types: FacetOption[];
  managers: FacetOption[];
  /** 项目状态计数（Push 262 追订）：固定四档 active / paused / done / archived。 */
  statuses: FacetOption[];
  /** 常用筛选胶囊的命中数（按组合单独取 total；缺数据按 0 显示）。 */
  savedFilterCounts: Record<string, number>;
  /** 时间区间选择器的提示日（当前项目集里最新的一天，YYYY-MM-DD）。 */
  newestDay: string;
  selectedRegions: string[];
  selectedManagerIds: string[];
  selectedTypes: string[];
  selectedStatuses: string[];
  dateRange: DateRange | null;
  savedFilters: SavedFilter[];
  appliedSavedFilterId: string | null;
  onToggleRegion: (region: string) => void;
  /** 批量勾选 / 取消（Push 193 整洲筛选：values = 该洲全部地区，checked = 选中还是取消）。 */
  onToggleRegions: (regions: string[], checked: boolean) => void;
  onToggleManager: (managerId: string) => void;
  onToggleType: (projectType: string) => void;
  onToggleStatus: (status: string) => void;
  onDateRangeChange: (range: DateRange | null) => void;
  onApplySavedFilter: (filter: SavedFilter) => void;
  /** 删除入口只「开口」：整组交给父层出顶部确认 Toast，第二下才真删（Push 264 追订 · 业务口径「删除常用筛选无二次确认」）。 */
  onRequestDeleteSavedFilter: (filter: SavedFilter) => void;
  onSaveSavedFilter: (input: { id: string | null; name: string; criteria: FilterCriteria }) => void;
  onReset: () => void;
  onClose: () => void;
};

/** 添加 / 编辑常用筛选的编辑态（id = null 为新建；prefilled = 由「一键添加」带入当前筛选、勾选还没动过）。 */
type ComposeState = {
  id: string | null;
  name: string;
  criteria: FilterCriteria;
  prefilled: boolean;
};

function criteriaCount(criteria: FilterCriteria): number {
  return (
    criteria.regions.length +
    criteria.projectTypes.length +
    criteria.managerIds.length +
    (criteria.timeFrom !== null && criteria.timeTo !== null ? 1 : 0)
  );
}

export function CategoryFilterSidebar({
  open,
  regions,
  types,
  managers,
  statuses,
  savedFilterCounts,
  newestDay,
  selectedRegions,
  selectedManagerIds,
  selectedTypes,
  selectedStatuses,
  dateRange,
  savedFilters,
  appliedSavedFilterId,
  onToggleRegion,
  onToggleRegions,
  onToggleManager,
  onToggleType,
  onToggleStatus,
  onDateRangeChange,
  onApplySavedFilter,
  onRequestDeleteSavedFilter,
  onSaveSavedFilter,
  onReset,
  onClose,
}: CategoryFilterSidebarProps) {
  const t = useT();
  const locale = useLocale();
  // 「添加」后的编辑态：勾选落在草稿上（不动当前筛选），保存 = 入库 + 立即生效（见《前端功能需求》§一.3）
  const [compose, setCompose] = useState<ComposeState | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (compose !== null) {
        setCompose(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, compose]);

  // 关面板即退出编辑态（下次打开是干净的浏览态）
  useEffect(() => {
    if (!open) {
      setCompose(null);
    }
  }, [open]);

  const activeCount =
    selectedRegions.length +
    selectedManagerIds.length +
    selectedTypes.length +
    selectedStatuses.length +
    (dateRange === null ? 0 : 1);

  // 编辑态下四组胶囊改「勾选到草稿」；非编辑态维持原有「点一下改当前筛选」
  const regionSelection = compose === null ? selectedRegions : compose.criteria.regions;
  const managerSelection = compose === null ? selectedManagerIds : compose.criteria.managerIds;
  const typeSelection = compose === null ? selectedTypes : compose.criteria.projectTypes;
  const rangeSelection: DateRange | null =
    compose === null
      ? dateRange
      : compose.criteria.timeFrom !== null && compose.criteria.timeTo !== null
        ? { from: compose.criteria.timeFrom, to: compose.criteria.timeTo }
        : null;

  /**
   * 「一键添加」（Push 286）：当前筛选里可存入常用筛选的部分（项目状态不参与组合保存）。
   * 任一条件有值（地区 / 项目类型 / 项目经理 / 项目时间）时，分组标题右侧的「+ 添加」改显「一键添加」：
   * 点一下把当前条件整组带进新建草稿 —— 当前筛选原样不动（不重置），直接让用户取名保存。
   */
  const currentCriteria: FilterCriteria = {
    regions: selectedRegions.slice(),
    projectTypes: selectedTypes.slice(),
    managerIds: selectedManagerIds.slice(),
    timeFrom: dateRange === null ? null : dateRange.from,
    timeTo: dateRange === null ? null : dateRange.to,
  };
  const canQuickAdd = hasCriteria(currentCriteria);

  /**
   * 「地区」按洲分组（Push 192；业务口径 2026-09-28「我觉得这里太乱了 要根据各个州分类 可以展开」）：
   * 组内还是原来那排胶囊（选中态 / 计数 / 点击口径一行没改），组间可折叠。分组口径见 src/data/regionContinents.ts
   * （与地图认国家同一套，不是第二套国名表）。
   */
  const regionGroups = useMemo(
    () => groupByContinent(regions, (option) => ({ name: option.label, code: option.value })),
    [regions],
  );
  /** 折叠记忆（只记「被手动折叠过 / 展开过」的洲）：没记过的洲默认「有勾选才展开」，面板打开就是干净的几行。 */
  const [collapsedContinents, setCollapsedContinents] = useState<Record<string, boolean>>({});
  const groupExpanded = (group: ContinentGroup<FacetOption>): boolean =>
    collapsedContinents[group.continent] === undefined
      ? group.items.some((option) => regionSelection.includes(option.value))
      : collapsedContinents[group.continent] === false;
  const allGroupsExpanded = regionGroups.length > 0 && regionGroups.every((group) => groupExpanded(group));
  const setAllGroupsExpanded = (expanded: boolean): void => {
    const next: Record<string, boolean> = {};
    for (const group of regionGroups) {
      next[group.continent] = !expanded;
    }
    setCollapsedContinents(next);
  };

  const toggleValue = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const patchDraft = (patch: Partial<FilterCriteria>) => {
    setCompose((current) => (current === null ? current : { ...current, criteria: { ...current.criteria, ...patch } }));
  };
  const handleToggleRegion = (region: string) => {
    if (compose === null) {
      onToggleRegion(region);
      return;
    }
    patchDraft({ regions: toggleValue(compose.criteria.regions, region) });
  };
  /** 批量勾选 / 取消一组地区（Push 193 整洲筛选）：编辑态写草稿，否则直接改当前筛选。 */
  const setRegionsChecked = (values: readonly string[], checked: boolean): void => {
    if (compose === null) {
      onToggleRegions(values.slice(), checked);
      return;
    }
    const current = new Set(compose.criteria.regions);
    for (const value of values) {
      if (checked) {
        current.add(value);
      } else {
        current.delete(value);
      }
    }
    patchDraft({ regions: Array.from(current) });
  };
  /**
   * 点洲名 = 整洲筛选（Push 193）：没选全 → 把该洲所有地区一起勾上并展开（看得见勾了哪些）；
   * 已选全 → 再点一次取消。业务口径「某一个洲点击可以直接筛选整个洲」。
   */
  const handleToggleContinent = (group: ContinentGroup<FacetOption>): void => {
    const values = group.items.map((option) => option.value);
    const allPicked = values.length > 0 && values.every((value) => regionSelection.includes(value));
    setRegionsChecked(values, !allPicked);
    if (!allPicked) {
      setCollapsedContinents((previous) => ({ ...previous, [group.continent]: false }));
    }
  };
  const handleToggleManager = (managerId: string) => {
    if (compose === null) {
      onToggleManager(managerId);
      return;
    }
    patchDraft({ managerIds: toggleValue(compose.criteria.managerIds, managerId) });
  };
  const handleToggleType = (projectType: string) => {
    if (compose === null) {
      onToggleType(projectType);
      return;
    }
    patchDraft({ projectTypes: toggleValue(compose.criteria.projectTypes, projectType) });
  };
  /**
   * 项目状态（Push 262 追订）：只作用于当前列表 —— 该维度不参与常用筛选的组合保存
   * （服务端口径 homeSavedFilters 暂不含 statuses，不扩契约）。
   */
  const handleToggleStatus = (status: string): void => {
    onToggleStatus(status);
  };
  const handleDateRangeChange = (range: DateRange | null) => {
    if (compose === null) {
      onDateRangeChange(range);
      return;
    }
    patchDraft({ timeFrom: range === null ? null : range.from, timeTo: range === null ? null : range.to });
  };

  const draftCount = compose === null ? 0 : criteriaCount(compose.criteria);
  const canSave = compose !== null && normalizeFilterName(compose.name) !== "" && hasCriteria(compose.criteria);
  const canCompose = compose === null && savedFilters.length < SAVED_FILTER_LIMIT;
  const submitCompose = () => {
    if (compose === null || !canSave) {
      return;
    }
    onSaveSavedFilter({ id: compose.id, name: normalizeFilterName(compose.name), criteria: compose.criteria });
    setCompose(null);
  };

  const renderChips = (
    options: ReadonlyArray<{ value: string; count: number; label?: string }>,
    selected: string[],
    onToggle: (value: string) => void,
    containerClass = "mt-3",
  ) => (
    <div className={(containerClass === "" ? "" : containerClass + " ") + "flex flex-wrap gap-2"}>
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            data-chip={option.value}
            aria-pressed={isSelected}
            onClick={() => {
              onToggle(option.value);
            }}
            className={
              "rounded-full border px-3 py-1 text-xs transition " +
              (isSelected
                ? "border-zinc-900 bg-zinc-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_2px_8px_rgba(15,23,42,0.18)]"
                : GLASS_SURFACE + " text-zinc-600")
            }
          >
            {option.label ?? option.value}
            <span className={"ml-1 " + (isSelected ? "text-white/60" : "text-zinc-400")}>{option.count}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={
          (open ? "opacity-100" : "pointer-events-none opacity-0") +
          " fixed inset-x-0 bottom-0 top-16 z-20 bg-zinc-900/30 transition-opacity duration-300 md:hidden"
        }
      />
      <aside
        id="category-filter-panel"
        aria-label={t("filter.aria")}
        className={
          (open ? "translate-x-0" : "-translate-x-full") +
          " fixed bottom-0 left-0 top-16 z-20 flex w-[280px] flex-col transition-transform duration-300 ease-out " + GLASS_PANEL
        }
      >
        <ScrollArea viewportClassName="min-h-0 flex-1" className="space-y-6 px-5 py-5" ariaLabel={t("filter.scrollAria")}>
          <section>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold tracking-wide text-zinc-700">{t("filter.saved")}</p>
              <button
                type="button"
                onClick={() => {
                  // 「一键添加」：把当前筛选整组带进草稿（不重置当前筛选）；没有任何可保存条件时才从空草稿开始
                  setCompose({
                    id: null,
                    name: "",
                    criteria: canQuickAdd ? currentCriteria : emptyCriteria(),
                    prefilled: canQuickAdd,
                  });
                }}
                disabled={!canCompose}
                title={
                  savedFilters.length >= SAVED_FILTER_LIMIT
                    ? t("filter.limitTitle", { n: SAVED_FILTER_LIMIT })
                    : canQuickAdd
                      ? t("filter.quickAddTitle")
                      : t("filter.addTitle")
                }
                className={
                  "rounded-lg px-2 py-1 text-xs font-medium transition " +
                  (canCompose ? "text-zinc-700 hover:bg-zinc-100" : "cursor-not-allowed text-zinc-300")
                }
              >
                {canQuickAdd ? t("filter.quickAdd") : t("filter.add")}
              </button>
            </div>

            {compose !== null && (
              <div className="mt-3 rounded-xl border border-amber-300/80 bg-amber-50/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <p className="text-xs font-semibold text-zinc-700">
                  {compose.id === null ? t("filter.compose.new") : t("filter.compose.edit")}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-zinc-500">
                  {compose.prefilled
                    ? t("filter.compose.prefilled")
                    : t("filter.compose.blank")}
                </p>
                <input
                  value={compose.name}
                  onChange={(event) => {
                    const value = event.target.value.slice(0, SAVED_FILTER_NAME_MAX);
                    setCompose((current) => (current === null ? current : { ...current, name: value }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      submitCompose();
                    }
                  }}
                  maxLength={SAVED_FILTER_NAME_MAX}
                  autoFocus
                  placeholder={t("filter.name.placeholder")}
                  aria-label={t("filter.name.aria")}
                  className="mt-2 w-full rounded-lg border border-zinc-200/90 bg-white/85 px-2.5 py-1.5 text-xs text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
                />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                  <span className="text-[11px] text-zinc-500">
                    {t("filter.draft.count", { n: draftCount })}
                    {!hasCriteria(compose.criteria) ? t("filter.draft.needOne") : ""}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCompose(null);
                      }}
                      className="whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                    >
                      {t("filter.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={submitCompose}
                      disabled={!canSave}
                      className={
                        "whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium transition " +
                        (canSave ? "bg-zinc-900 text-white hover:bg-zinc-700" : "cursor-not-allowed bg-zinc-200 text-zinc-400")
                      }
                    >
                      {t("filter.save")}
                    </button>
                  </span>
                </div>
              </div>
            )}

            {savedFilters.length === 0 ? (
              compose === null ? (
                <p className="mt-3 text-xs leading-5 text-zinc-400">
                  {canQuickAdd
                    ? t("filter.empty.quickAdd")
                    : t("filter.empty.add")}
                </p>
              ) : null
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {savedFilters.map((filter) => {
                  const applied = filter.id === appliedSavedFilterId;
                  const count = savedFilterCounts[filter.id] ?? 0;
                  return (
                    <span
                      key={filter.id}
                      className={
                        "group/chip inline-flex items-center overflow-hidden rounded-full border transition " +
                        (applied
                          ? "border-zinc-900 bg-zinc-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_2px_8px_rgba(15,23,42,0.18)]"
                          : GLASS_SURFACE + " text-zinc-600")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onApplySavedFilter(filter);
                        }}
                        title={t("filter.applyTitle", { name: filter.name, n: count })}
                        className="inline-flex max-w-[168px] items-center px-3 py-1 text-xs"
                      >
                        <span className="truncate">{filter.name}</span>
                        <span className={"ml-1 " + (applied ? "text-white/60" : "text-zinc-400")}>{count}</span>
                      </button>
                      <span
                        className={
                          "flex max-w-0 items-center overflow-hidden opacity-0 transition-all duration-200 " +
                          (applied ? "text-white/70" : "text-zinc-400") +
                          " group-hover/chip:max-w-[44px] group-hover/chip:opacity-100 group-focus-within/chip:max-w-[44px] group-focus-within/chip:opacity-100"
                        }
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setCompose({ id: filter.id, name: filter.name, criteria: criteriaOf(filter), prefilled: false });
                          }}
                          aria-label={t("filter.editAria", { name: filter.name })}
                          title={t("filter.editTitle")}
                          className={
                            "shrink-0 rounded-full py-0.5 pl-1.5 pr-0.5 transition " +
                            (applied ? "hover:text-white" : "hover:text-zinc-900")
                          }
                        >
                          <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
                            <path d="M4 20h4L18 10l-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onRequestDeleteSavedFilter(filter);
                          }}
                          aria-label={t("filter.deleteAria", { name: filter.name })}
                          title={t("filter.deleteTitle")}
                          className={
                            "shrink-0 rounded-full py-0.5 pl-0.5 pr-2 transition " +
                            (applied ? "hover:text-white" : "hover:text-zinc-900")
                          }
                        >
                          <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </section>
          <section data-region-section="true">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold tracking-wide text-zinc-700">{t("filter.region")}</p>
              {regionGroups.length === 0 ? null : (
                <button
                  type="button"
                  data-continent-all={allGroupsExpanded ? "collapse" : "expand"}
                  onClick={() => {
                    setAllGroupsExpanded(!allGroupsExpanded);
                  }}
                  className="text-[11px] text-zinc-400 transition hover:text-zinc-700"
                >
                  {allGroupsExpanded ? t("filter.collapseAll") : t("filter.expandAll")}
                </button>
              )}
            </div>
            <div className="mt-2 space-y-1.5">
              {regionGroups.map((group) => {
                const expanded = groupExpanded(group);
                const picked = group.items.filter((option) => regionSelection.includes(option.value)).length;
                const allPicked = group.items.length > 0 && group.items.every((option) => regionSelection.includes(option.value));
                return (
                  <div
                    key={group.continent}
                    data-continent-group={group.continent}
                    className="rounded-xl border border-zinc-200/70 bg-white/50 transition hover:border-zinc-300"
                  >
                    <div className="flex w-full items-center gap-1.5 rounded-xl pr-2.5">
                      <button
                        type="button"
                        data-continent-toggle={group.continent}
                        aria-expanded={expanded}
                        onClick={() => {
                          setCollapsedContinents((previous) => ({ ...previous, [group.continent]: expanded }));
                        }}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2.5 py-2 text-left"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          aria-hidden="true"
                          className={"h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform " + (expanded ? "rotate-90" : "")}
                        >
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="text-xs font-medium text-zinc-700">{continentText(locale, group.continent)}</span>
                        <span className="text-[11px] text-zinc-400">{t("filter.regionCount", { n: group.items.length })}</span>
                      </button>
                      {picked === 0 ? null : (
                        <span className="shrink-0 rounded-full bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-white">{t("filter.picked", { n: picked })}</span>
                      )}
                      {/* 整洲筛选复选框（Push 193 追订 · 业务参考代码）：行最右侧；勾上 = 该洲全部地区一起选中（再点取消） */}
                      <label
                        className="group/continent-check -m-1 flex shrink-0 cursor-pointer items-center p-1"
                        title={allPicked ? t("filter.continent.uncheckAll", { name: continentText(locale, group.continent) }) : t("filter.continent.checkAllCount", { name: continentText(locale, group.continent), n: group.items.length })}
                      >
                        <input
                          type="checkbox"
                          data-continent-check={group.continent}
                          className="peer sr-only"
                          checked={allPicked}
                          aria-label={t("filter.continent.checkAll", { name: continentText(locale, group.continent) })}
                          onChange={() => {
                            handleToggleContinent(group);
                          }}
                        />
                        <span className="relative flex h-4 w-4 items-center justify-center rounded-[5px] border border-zinc-300 bg-zinc-100 shadow-sm transition-all duration-500 group-hover/continent-check:scale-110 peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/60">
                          <span className="absolute inset-0 rounded-[5px] bg-gradient-to-br from-white/30 to-white/10 opacity-0 transition-all duration-500 peer-checked:animate-pulse peer-checked:opacity-100" />
                          <svg
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                            xmlns="http://www.w3.org/2000/svg"
                            className="hidden h-2.5 w-2.5 scale-50 text-white transition-transform duration-500 peer-checked:block peer-checked:scale-100"
                          >
                            <path
                              clipRule="evenodd"
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z"
                            />
                          </svg>
                        </span>
                      </label>
                    </div>
                    {expanded ? <div className="px-2.5 pb-2.5">{renderChips(group.items, regionSelection, handleToggleRegion, "")}</div> : null}
                  </div>
                );
              })}
            </div>
          </section>
          <section>
            <p className="text-sm font-semibold tracking-wide text-zinc-700">{t("filter.types")}</p>
            {renderChips(types, typeSelection, handleToggleType)}
          </section>
          <section>
            <p className="text-sm font-semibold tracking-wide text-zinc-700">{t("filter.managers")}</p>
            {renderChips(managers, managerSelection, handleToggleManager)}
          </section>
          <section data-status-section="true">
            <p className="text-sm font-semibold tracking-wide text-zinc-700">{t("filter.statuses")}</p>
            {renderChips(statuses, selectedStatuses, handleToggleStatus)}
            {compose === null ? null : (
              <p className="mt-2 text-[11px] leading-4 text-zinc-400">{t("filter.status.note")}</p>
            )}
          </section>
          <section>
            <p className="flex items-center gap-1.5 text-sm font-semibold tracking-wide text-zinc-700">
              {t("filter.time")}
              <span
                role="img"
                tabIndex={0}
                aria-label={t("filter.time.aria")}
                title={t("filter.time.title")}
                className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[10px] font-semibold tracking-normal text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                i
              </span>
            </p>
            <div className="mt-3">
              <DateRangePicker value={rangeSelection} onChange={handleDateRangeChange} hintDate={newestDay} triggerClassName={GLASS_SURFACE} />
            </div>
          </section>
        </ScrollArea>

        <div className="flex items-center justify-between border-t border-zinc-200/70 px-5 py-3">
          <span className="text-xs text-zinc-400">
            {compose === null
              ? activeCount === 0
                ? t("filter.footer.none")
                : t("filter.footer.count", { n: activeCount })
              : t("filter.footer.compose", { n: draftCount })}
          </span>
          <button
            type="button"
            data-filter-reset="true"
            onClick={onReset}
            disabled={activeCount === 0}
            className={
              "rounded-lg px-3 py-1.5 text-xs font-medium transition " +
              (activeCount === 0 ? "cursor-not-allowed text-zinc-300" : "text-zinc-700 hover:bg-zinc-100")
            }
          >
            {t("filter.reset")}
          </button>
        </div>
      </aside>
    </>
  );
}
