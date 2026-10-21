import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "./usePopover";
import { useT } from "../i18n";

/** 选项文案：普通枚举用字符串，带色标签的枚举（如任务状态）直接用 ReactNode。 */
export type SelectOption = {
  value: string;
  label: ReactNode;
  /** 行内删除是否可用（缺省 = 可用；字典下拉里「不在字典中的存量值」兜底项传 false，删了也是空转）。 */
  deletable?: boolean;
  /**
   * 删除被业务拦住时的原因（Push 174 字典引用守卫：条目正被项目卡片使用）—— 给了就渲染**置灰、点不动**的删除位，
   * 悬停出原因（title）、无障碍名带上原因；与 deletable=false（根本不渲染删除位）是两种语义。
   */
  deleteDisabledReason?: string;
};

type OptionListProps = {
  options: SelectOption[];
  value: string;
  onPick: (value: string) => void;
  ariaLabel: string;
  /**
   * 行内删除（Push 172）：给了才渲染，每行**悬停 / 键盘聚焦才浮现**（隐式，与任务表行内删除同一套语言）。
   * 删除按钮是选项行的**兄弟节点**（绝对定位在行尾）—— 按钮不能嵌套按钮；行本身仍是 role=option。
   */
  onDeleteOption?: (option: SelectOption) => void;
  /** 删除按钮的无障碍名（如「删除地区 华东」）；不给回落「删除」。 */
  deleteLabelOf?: (option: SelectOption) => string;
};

/** 垃圾桶图标（与任务表行内删除同形）。 */
function TrashIcon() {
  return (
    <svg viewBox="0 0 448 512" aria-hidden="true" className="h-3 w-3">
      <path
        fill="currentColor"
        d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"
      />
    </svg>
  );
}

/** 选项列表（单选 + 勾选态）：普通下拉、任务表行内编辑与字典下拉共用；可选「行内删除」。 */
export function OptionList({ options, value, onPick, ariaLabel, onDeleteOption, deleteLabelOf }: OptionListProps) {
  const t = useT();
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));

  return (
    <div role="listbox" aria-label={ariaLabel} className="p-1">
      {options.map((option, index) => {
        const row = (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onMouseEnter={() => {
              setActiveIndex(index);
            }}
            onClick={() => {
              onPick(option.value);
            }}
            className={
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-700 transition " +
              (onDeleteOption !== undefined ? "pr-8 " : "") +
              (index === activeIndex ? "bg-zinc-100" : "")
            }
          >
            {option.label}
            {option.value === value ? (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600">
                <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        );
        if (onDeleteOption === undefined || option.deletable === false) {
          return row;
        }
        const label = deleteLabelOf === undefined ? t("common.delete") : deleteLabelOf(option);
        const reason = option.deleteDisabledReason;
        if (reason !== undefined) {
          // 业务拦住的删除位（Push 174 字典引用守卫）：置灰、点不动、悬停出原因；aria-label 把原因读全。
          return (
            <div key={option.value} className="group/opt relative">
              {row}
              <span
                title={reason}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-not-allowed items-center justify-center rounded-md text-zinc-200 opacity-0 transition group-hover/opt:opacity-100 group-focus-within/opt:opacity-100"
              >
                <button type="button" disabled aria-label={label + "（" + reason + "）"} className="flex h-full w-full cursor-not-allowed items-center justify-center">
                  <TrashIcon />
                </button>
              </span>
            </div>
          );
        }
        return (
          <div key={option.value} className="group/opt relative">
            {row}
            <button
              type="button"
              aria-label={label}
              title={label}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteOption(option);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:opacity-100 focus-visible:outline-none group-hover/opt:opacity-100"
            >
              <TrashIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}

type SelectMenuProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  /** 前置条件未满足时禁用（与原先原生 select 的 disabled 同口径：灰底灰字、点不开）。 */
  disabled?: boolean;
};

/** 普通下拉（不可搜索）：状态 / 紧急重要度这类枚举字段。 */
export function SelectMenu({ value, options, onChange, placeholder: placeholderProp, ariaLabel, disabled = false }: SelectMenuProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(160, options.length * 34 + 12);
  const t = useT();
  const placeholder = placeholderProp ?? t("sel.placeholder");
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) {
            return;
          }
          setOpen((previous) => !previous);
        }}
        className={
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition " +
          (disabled
            ? "cursor-not-allowed border-zinc-200 bg-zinc-50"
            : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50")
        }
      >
        {selected === null ? (
          <span className="truncate text-zinc-400">{placeholder}</span>
        ) : (
          <span className={"truncate font-medium " + (disabled ? "text-zinc-400" : "text-zinc-800")}>{selected.label}</span>
        )}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={"ml-auto h-4 w-4 shrink-0 " + (disabled ? "text-zinc-300" : "text-zinc-400")}>
          <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-select-popover="true"
              className="fixed z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <OptionList
                options={options}
                value={value}
                ariaLabel={ariaLabel}
                onPick={(next) => {
                  onChange(next);
                  setOpen(false);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

type MultiOptionListProps = {
  values: readonly string[];
  options: readonly string[];
  ariaLabel: string;
  onChange: (values: string[]) => void;
  /** 选项文案渲染（Push 208 追加 · 业务口径「要有颜色 两处」）：不给 = 纯文字；给 = 出小色签。 */
  renderLabel?: (option: string) => ReactNode;
};

/** 多选项列表（Push 202 多选下拉 / Push 208 行内多选单元格共用）：点选中项打绿勾、再点取消，**点选不收浮层**（可连着点）；
 *  Push 208 追加：可选 renderLabel —— 选项按各自的色表出小色签（问题归类 / 关联阶段两处）。 */
export function MultiOptionList({ values, options, ariaLabel, onChange, renderLabel }: MultiOptionListProps) {
  return (
    <div role="listbox" aria-multiselectable="true" aria-label={ariaLabel} className="p-1">
      {options.map((option) => {
        const selected = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            role="option"
            data-multi-option={option}
            aria-selected={selected}
            onClick={() => {
              onChange(selected ? values.filter((value) => value !== option) : [...values, option]);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100"
          >
            {renderLabel === undefined ? option : renderLabel(option)}
            {selected ? (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600">
                <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

type MultiSelectMenuProps = {
  values: readonly string[];
  options: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel: string;
  /** 选项显示文案（触发器已选联结 + 选项行共用；不给 = 原样显示。Push 301 追订：「问题归类」表单侧英文界面出译文）。 */
  labelOf?: (option: string) => string;
  /** 前置条件未满足时禁用（与 SelectMenu 同口径：灰底灰字、点不开）。 */
  disabled?: boolean;
};

/**
 * 多选下拉（Push 202「问题归类可以多选」）：视觉与 SelectMenu 同一套（白底描边触发器 + 弹层绿勾选中项），
 * 差异全在弹层交互 —— 点选项**不关闭**（可连续勾选），选中项打绿勾、再点即取消；
 * 触发器显示已选项（顿号连接）、空选回落占位文案；关闭口径与站点其它浮层一致（点外部 / Esc / 再点触发器）。
 */
export function MultiSelectMenu({ values, options, onChange, placeholder: placeholderProp, ariaLabel, labelOf, disabled = false }: MultiSelectMenuProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(180, options.length * 34 + 12);
  const t = useT();
  const placeholder = placeholderProp ?? t("sel.placeholder");
  /** 选项显示文案（labelOf 缺省 = 原样，等价旧行为）。 */
  const optionLabel = (value: string): string => (labelOf === undefined ? value : labelOf(value));
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) {
            return;
          }
          setOpen((previous) => !previous);
        }}
        className={
          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition " +
          (disabled
            ? "cursor-not-allowed border-zinc-200 bg-zinc-50"
            : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50")
        }
      >
        {values.length === 0 ? (
          <span className="truncate text-zinc-400">{placeholder}</span>
        ) : (
          <span className={"truncate font-medium " + (disabled ? "text-zinc-400" : "text-zinc-800")}>{values.map(optionLabel).join(t("sel.multiJoin"))}</span>
        )}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={"ml-auto h-4 w-4 shrink-0 " + (disabled ? "text-zinc-300" : "text-zinc-400")}>
          <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-multi-popover="true"
              className="fixed z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <MultiOptionList values={values} options={options} ariaLabel={ariaLabel} onChange={onChange} renderLabel={labelOf === undefined ? undefined : optionLabel} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
