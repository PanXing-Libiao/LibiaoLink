import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DictItem } from "../dicts";
import type { RegionPickerOption } from "../data/regionPicker";
import { buildRegionPickerOptions, groupRegionPickerOptions, regionNameEn, searchRegionPickerOptions, usedRegionPickerOptions } from "../data/regionPicker";
import { continentText, useLocale, useT } from "../i18n";
import { usePopover } from "./usePopover";

/**
 * 项目地区选择器（Push 195 返工 · 还是「贴字段弹出的小窗」）：业务口径（2026-09-28）
 * 「还是要之前的小窗 然后最上方是已有项目地区」＋「小窗做分页 已有项目地区 / 全部地区 然后选中标蓝即可 不要这个勾」。
 * - 顶部搜索框 + 两页签：「已有项目地区」（有项目在用的地区 —— Push 304 起按**项目落库值**聚合（facets 计数，
 *   含字典外的国名 / 存量值），按用量降序、带项目数）与「全部地区」（标准国家清单 201 条 + 字典独有条目，
 *   按洲分组 —— 字典没收录的国家也能搜到、选到）；
 * - 选中态 = 标蓝（底色 + 文字），不带对勾；纯选择：不支持手填 / 添加 / 删除（Push 194 口径延续，不写字典）；
 * - 打开默认停在「已有项目地区」页；当前值不在已有页（如刚选的冰岛）时默认停在「全部地区」页；
 * - 输入关键词自动切到「全部地区」全量搜（避免在已有页搜出「没有匹配」）；
 * - 打开即聚焦搜索框、中英文都能搜、回车 = 选当前页第一条；Esc / 点浮层外关闭（usePopover 统一）；
 * - 打开时把当前选中项滚进可视区一次；候选口径与地图立柱 / 侧栏筛选同源（src/data/regionPicker.ts）。
 */
type RegionSelectProps = {
  /** 当前值（字典码 / 标准中文国名 / 存量自定义值）。 */
  value: string;
  /** 当前值的展示名（字典条目 = 字典名；没有字典条目 = 值本身）。 */
  valueLabel: string;
  /** 地区字典启用条目（GET /api/v1/dicts）：命中国家的条目优先占位，同一国家不出现两条。 */
  items: readonly DictItem[];
  /** 「已有项目地区」计数（Push 304）：GET /api/v1/projects/facets 的 region 计数（值 → 未删除项目数，含字典外落库值）；缺省 = 回退字典条目 usageCount。 */
  usedRegions?: Readonly<Record<string, number>>;
  onChange: (value: string) => void;
  /** 开 / 合通知：ProjectModal 用它分派 Esc（小窗开着按 Esc 只关小窗，不关整个项目弹窗）。 */
  onOpenChange?: (open: boolean) => void;
};

/** 小窗分页：已有项目地区（有项目在用）/ 全部地区（标准清单全量）。 */
type RegionSelectTab = "used" | "all";
const TAB_USED: RegionSelectTab = "used";
const TAB_ALL: RegionSelectTab = "all";

/**
 * 小窗固定尺寸（Push 195 追订：「两个分页的高度位置要一致」）：两个页签共用同一宽高、同一落点 —— 切页不跳高度，
 * 搜索框 / 页签 / 列表起点都钉在同一条线上（候选多了在列表内部滚，不撑大小窗）。
 */
const POPOVER_WIDTH = 280;
const POPOVER_HEIGHT = 400;
/** usedRegions 缺省时的空计数（稳定引用：useMemo 依赖不抖动）。 */
const NO_USED_REGIONS: Readonly<Record<string, number>> = {};

export function RegionSelect({ value, valueLabel, items, usedRegions, onChange, onOpenChange }: RegionSelectProps) {
  const locale = useLocale();
  const t = useT();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<RegionSelectTab>(TAB_USED);
  const searchRef = useRef<HTMLInputElement | null>(null);
  /** 已经为哪一页做过「滚到选中项」（每次打开 / 每页各一次，之后用户自己滚不再打扰）。 */
  const scrolledForTab = useRef<string>("");
  const wasOpen = useRef(false);
  const options = useMemo(() => buildRegionPickerOptions(items), [items]);
  const matched = useMemo(() => searchRegionPickerOptions(options, query), [options, query]);
  /** 已有页 = 按项目落库值对账的用量行（Push 304；字典 usageCount 仅作兜底并入），搜索照旧过滤。 */
  const usedAll = useMemo(() => usedRegionPickerOptions(options, usedRegions ?? NO_USED_REGIONS), [options, usedRegions]);
  const used = useMemo(() => searchRegionPickerOptions(usedAll, query), [usedAll, query]);
  const groups = useMemo(() => groupRegionPickerOptions(matched), [matched]);
  /** 存量值兜底（不在候选里，如旧项目用的「华东」）：钉在「全部地区」页最上面一条，当前选中不悬空。 */
  const fallback = useMemo<RegionPickerOption | null>(() => {
    if (value === "" || options.some((option) => option.value === value)) {
      return null;
    }
    return { value: value, name: valueLabel === "" ? value : valueLabel, en: "", continent: "其他", usageCount: 0 };
  }, [value, valueLabel, options]);
  const fallbackVisible = useMemo(() => {
    if (fallback === null) {
      return false;
    }
    const keyword = query.trim().toLowerCase();
    return keyword === "" || (fallback.name + " " + fallback.value).toLowerCase().indexOf(keyword) >= 0;
  }, [fallback, query]);
  const fallbackShown = tab === TAB_ALL && fallbackVisible;
  const rowCount = (tab === TAB_USED ? used.length : matched.length) + (fallbackShown ? 1 : 0);
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(POPOVER_WIDTH, POPOVER_HEIGHT, "right");

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };

  /** 开 / 合通知（setOpen 的调用点统一收口在这里给父层）。 */
  useEffect(() => {
    if (onOpenChange !== undefined) {
      onOpenChange(open);
    }
  }, [open, onOpenChange]);

  /** 关闭时复位搜索与滚动标记（下次打开是干净的一份）。 */
  useEffect(() => {
    if (!open) {
      setQuery("");
      scrolledForTab.current = "";
    }
  }, [open]);

  /**
   * 每次「打开」选默认页：当前值在已有项目地区里 → 停在已有页；否则（如刚选的冰岛）→ 停在全部地区页，
   * 保证选中的那条在当前页里看得见。只在 false → true 那一下生效。
   */
  useEffect(() => {
    if (open && !wasOpen.current) {
      /** 新建（还没选）默认停在已有页；当前值不在已有页（如刚选的冰岛）才落在全部地区页。 */
      const inUsed = value === "" || usedAll.some((option) => option.value === value);
      setTab(inUsed ? TAB_USED : TAB_ALL);
    }
    wasOpen.current = open;
  }, [open, usedAll, value]);

  /**
   * 打开浮层就把光标放进搜索框：弹出即可直接打字；position 也要进依赖 —— 浮层要等定位算完才挂进
   * portal，第一帧 searchRef 还是空的（漏了它聚焦就落空）。
   */
  useEffect(() => {
    if (open && position !== null) {
      searchRef.current?.focus();
    }
  }, [open, position]);

  /**
   * 打开 / 切页时把当前选中项滚进可视区一次（本页没有选中项 = 回到列表顶部）——切页不沿用上一页的滚动位置，
   * 免得小标题被顶出可视区。每页各做一次，之后用户自己滚不再打扰。
   */
  useEffect(() => {
    if (!open || position === null || scrolledForTab.current === tab) {
      return;
    }
    const listbox = popoverRef.current?.querySelector("[role=listbox]");
    const scroller = listbox === null || listbox === undefined ? null : listbox.parentElement;
    if (listbox === undefined || listbox === null || scroller === null) {
      return;
    }
    scrolledForTab.current = tab;
    const row = listbox.querySelector("[aria-selected=true]");
    if (row === null) {
      scroller.scrollTop = 0;
      return;
    }
    const rowBox = row.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2;
  }, [open, position, tab, popoverRef]);

  /** 输入关键词自动切到「全部地区」页全量搜（已有页搜不到字典外的国家，别让用户撞上「没有匹配」）。 */
  const handleQueryChange = (next: string): void => {
    setQuery(next);
    if (next.trim() !== "" && tab === TAB_USED) {
      setTab(TAB_ALL);
    }
  };

  /** 搜索框回车 = 选当前页第一条候选（鼠标点行同效）。 */
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const first = tab === TAB_USED ? used[0] : fallbackShown ? fallback : matched[0];
    if (first === undefined || first === null) {
      return;
    }
    onChange(first.value);
    close();
  };

  /** 地区显示名（Push 301 英译）：英文界面先取候选自带英文名、再按中文名认标准国名，都认不出回退原文。 */
  const nameOf = (option: RegionPickerOption): string => (locale === "en" ? (option.en !== "" ? option.en : regionNameEn(option.name) || option.name) : option.name);
  const renderRow = (option: RegionPickerOption, count: number | null) => {
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={selected}
        data-region-option={option.value}
        onClick={() => {
          onChange(option.value);
          close();
        }}
        className={"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition " + (selected ? "bg-blue-50 font-medium text-blue-700" : "text-zinc-700 hover:bg-zinc-100")}
      >
        <span data-region-name={option.name} className="truncate">{nameOf(option)}</span>
        {count === null ? null : <span className="ml-auto shrink-0 text-[11px] font-normal text-zinc-400">{t("region.projects", { n: count })}</span>}
      </button>
    );
  };

  const tabClass = (active: boolean): string =>
    "flex-1 rounded-md px-2 py-1 text-xs transition " + (active ? "bg-white font-medium text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-700");

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("region.selectAria")}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition hover:border-zinc-300 hover:bg-zinc-50"
      >
        {valueLabel === "" ? (
          <span className="truncate text-zinc-400">{t("region.placeholder")}</span>
        ) : (
          <span className="truncate font-medium text-zinc-800">{locale === "en" ? regionNameEn(valueLabel) || valueLabel : valueLabel}</span>
        )}
        {/* 箭头朝右：与「贴右侧弹出」的落点同向。 */}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 -rotate-90 text-zinc-400">
          <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-region-popover="true"
              className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              /* 固定高度（Push 195 追订）：两个页签同高，切页不跳、列表起点同一条线。 */
              style={{ top: position.top, left: position.left, width: position.width, height: POPOVER_HEIGHT }}
            >
              <div className="shrink-0 border-b border-zinc-100 p-1.5">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  aria-label={t("region.searchAria")}
                  placeholder={t("region.searchPlaceholder")}
                  onChange={(event) => {
                    handleQueryChange(event.target.value);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  className="w-full rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:bg-white focus:ring-1 focus:ring-zinc-300"
                />
                <div role="tablist" aria-label={t("region.tabsAria")} className="mt-1.5 flex gap-1 rounded-lg bg-zinc-100 p-1">
                  <button type="button" role="tab" aria-selected={tab === TAB_USED} data-region-tab="used" onClick={() => { setTab(TAB_USED); }} className={tabClass(tab === TAB_USED)}>
                    {t("region.tab.used")}
                  </button>
                  <button type="button" role="tab" aria-selected={tab === TAB_ALL} data-region-tab="all" onClick={() => { setTab(TAB_ALL); }} className={tabClass(tab === TAB_ALL)}>
                    {t("region.tab.all")}
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div role="listbox" aria-label={t("region.listAria")} data-region-tab={tab} className="p-1">
                  {fallbackShown && fallback !== null ? (
                    <div key="@@fallback">
                      <p role="presentation" data-option-group="当前值" className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-zinc-400">
                        {t("region.current")}
                      </p>
                      {renderRow(fallback, null)}
                    </div>
                  ) : null}
                  {tab === TAB_USED ? used.map((option) => renderRow(option, option.usageCount)) : null}
                  {tab === TAB_ALL
                    ? groups.map((group) => (
                        <div key={group.continent}>
                          <p role="presentation" data-option-group={group.continent} className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-zinc-400">
                            {continentText(locale, group.continent)} · {String(group.items.length)}
                          </p>
                          {group.items.map((option) => renderRow(option, null))}
                        </div>
                      ))
                    : null}
                  {rowCount === 0 ? (
                    <p className="px-3 py-2 text-[11px] text-zinc-400">{t("region.empty")}</p>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
