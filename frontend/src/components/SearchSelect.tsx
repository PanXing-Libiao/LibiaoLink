import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "./usePopover";
import { useT } from "../i18n";

/** 选项：搜索下拉的选项文案必须是字符串（搜索按它做包含匹配）。 */
export type SearchSelectOption = { value: string; label: string };

type SearchSelectBaseProps = {
  options: readonly SearchSelectOption[];
  /** 触发器占位（值为空时显示；缺省「请选择」）。 */
  placeholder?: string;
  ariaLabel: string;
  /** 浮层搜索框占位（缺省「搜索…」）。 */
  searchPlaceholder?: string;
  /** 搜索无命中的提示（缺省「没有匹配的选项。」）。 */
  emptyText?: string;
  disabled?: boolean;
};

/** 单选：点选项 = 选中并关闭浮层。 */
type SearchSelectSingleProps = SearchSelectBaseProps & {
  mode?: "single";
  value: string;
  onChange: (value: string) => void;
};

/**
 * 多选（2026-10-09 追订「要可以多项选择 再次点击取消选择」）：点选项 = 勾选 / 再点取消，**点选不关闭浮层**。
 * 触发器只显示筛选名称 label + 浅灰数量（追订「可以只显现这个筛选的名称 然后数量淡灰色的」）—— 空选无数量。
 */
type SearchSelectMultiProps = SearchSelectBaseProps & {
  mode: "multi";
  values: readonly string[];
  onToggle: (value: string) => void;
  /** 筛选名称（如「项目」「状态」「上传人」；触发器常显，不随选中项变化）。 */
  label: string;
};

export type SearchSelectProps = SearchSelectSingleProps | SearchSelectMultiProps;

/** 浮层宽度下限 / 列表高度上限（列表内部滚，不撑高浮层 —— 鼠标滚轮可滑）。 */
const POPOVER_WIDTH = 260;
const LIST_MAX_HEIGHT = 280;

/**
 * 可搜索下拉（Push 261 追订 · 业务口径 2026-10-09「这个全部项目展现的不好 应该是搜索下拉框加鼠标滑动」）。
 *
 * 触发器与 SelectMenu 同一套（白底描边 + 右侧箭头 + 选中项文字）；浮层 = 顶部搜索框 + 列表内部滚动：
 * 打开即清空搜索并聚焦、输入实时过滤（大小写不敏感的包含匹配）、回车 = 选当前命中第一条、
 * 方向键移动、Esc / 点浮层外关闭（usePopover 统一）；搜索下拉始终向下展开，下方空间不足时先把触发器滚到视口中间，打开时把当前选中项滚进可视区一次。
 * 多选（mode="multi"）：点选项勾选 / 再点取消选择，**点选不关闭浮层**；触发器只显示筛选项名称 label +
 * 浅灰数量（空选只显示名称 —— 业务口径 2026-10-09「可以只显现这个筛选的名称 然后数量淡灰色的」）。
 * 选项文案 = 触发器展示文案（label 原样渲染）—— 回放脚本按 `[data-select-popover] [role=option]` 文本定位。
 */
export function SearchSelect(props: SearchSelectProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(POPOVER_WIDTH, LIST_MAX_HEIGHT + 56, "below", true);
  const t = useT();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedValues: readonly string[] = props.mode === "multi" ? props.values : props.value === "" ? [] : [props.value];
  const selectedOptions = props.options.filter((option) => selectedValues.includes(option.value));
  /** 多选触发器 = 筛选名称 + 浅灰数量；单选触发器 = 选中项 label（无选中为占位）。 */
  const selectedCount = selectedOptions.length;
  const triggerText = props.mode === "multi" ? "" : selectedOptions[0] === undefined ? "" : selectedOptions[0].label;
  const matched = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === "") {
      return props.options;
    }
    return props.options.filter((option) => option.label.toLowerCase().indexOf(keyword) !== -1);
  }, [props.options, query]);

  /** 打开 = 干净态：清搜索、活跃项回第 0 条、聚焦搜索框，并把当前选中项滚进可视区一次。 */
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => {
      searchRef.current?.focus();
      const box = listRef.current;
      const row = box === null ? null : (box.querySelector("[aria-selected=" + JSON.stringify("true") + "]") as HTMLElement | null);
      if (box !== null && row !== null) {
        const top = row.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
          box.scrollTop = Math.max(0, top - 8);
        }
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  /**
   * 搜索下拉始终向下展开（2026-10-20 追订）；下方空间不足时先把触发器滚到视口中间。
   * 估算高度按条目数收敛，避免 4 条项目被 336px 的保守上限误判为「放不下」。
   */
  const prepareOpen = (): void => {
    const trigger = triggerRef.current;
    if (trigger === null) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(LIST_MAX_HEIGHT, props.options.length * 36) + 60;
    if (rect.bottom + estimatedHeight + 8 > window.innerHeight) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
    }
  };

  const pick = (value: string): void => {
    if (props.mode === "multi") {
      props.onToggle(value);
      return;
    }
    props.onChange(value);
    setOpen(false);
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matched.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((previous) => (previous + step + matched.length) % matched.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = matched[activeIndex];
      if (option !== undefined) {
        pick(option.value);
      }
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open && !props.disabled}
        aria-label={props.ariaLabel}
        data-select-trigger-label={props.mode === "multi" ? props.label : undefined}
        data-select-trigger-count={props.mode === "multi" ? String(selectedCount) : undefined}
        disabled={props.disabled === true}
        onClick={() => {
          if (props.disabled === true) {
            return;
          }
          if (!open) {
            prepareOpen();
          }
          setOpen((previous) => !previous);
        }}
        className={
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition " +
          (props.disabled === true
            ? "cursor-not-allowed border-zinc-200 bg-zinc-50"
            : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50")
        }
      >
        {props.mode === "multi" ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={"truncate " + (selectedCount > 0 ? "font-medium text-zinc-800" : "text-zinc-500")}>{props.label}</span>
            {selectedCount > 0 ? <span className="shrink-0 text-xs font-normal text-zinc-400">{selectedCount}</span> : null}
          </span>
        ) : triggerText === "" ? (
          <span className="truncate text-zinc-400">{props.placeholder ?? t("sel.placeholder")}</span>
        ) : (
          <span className={"truncate font-medium " + (props.disabled === true ? "text-zinc-400" : "text-zinc-800")}>{triggerText}</span>
        )}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={"ml-auto h-4 w-4 shrink-0 " + (props.disabled === true ? "text-zinc-300" : "text-zinc-400")}>
          <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-select-popover="true"
              data-search-select="true"
              className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <div className="shrink-0 border-b border-zinc-100 p-1.5">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  data-search-select-input="true"
                  aria-label={props.searchPlaceholder ?? t("sel.searchAria")}
                  placeholder={props.searchPlaceholder ?? t("sel.search")}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400"
                />
              </div>
              <div ref={listRef} data-search-select-list="true" className="overflow-y-auto overscroll-contain p-1" style={{ maxHeight: LIST_MAX_HEIGHT }}>
                {matched.length === 0 ? (
                  <p className="px-2.5 py-2 text-xs text-zinc-400">{props.emptyText ?? t("sel.empty")}</p>
                ) : (
                  matched.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={selectedValues.includes(option.value)}
                      onMouseEnter={() => {
                        setActiveIndex(index);
                      }}
                      onClick={() => {
                        pick(option.value);
                      }}
                      className={
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-700 transition " +
                        (index === activeIndex ? "bg-zinc-100" : "")
                      }
                    >
                      <span className="truncate">{option.label}</span>
                      {selectedValues.includes(option.value) ? (
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600">
                          <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
