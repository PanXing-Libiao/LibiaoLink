import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Member } from "../data/members";
import { usePopover } from "./usePopover";
import { useT } from "../i18n";

const AVATAR_TONES = [
  "bg-sky-100 text-sky-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-violet-100 text-violet-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

/** 头像底色按 id 稳定取色（原型阶段不接头像文件：姓名首字 + 底色）。 */
function toneOf(member: Member): string {
  let hash = 0;
  for (const char of member.id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function MemberAvatar({ member }: { member: Member }) {
  return (
    <span
      aria-hidden="true"
      className={"flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold " + toneOf(member)}
    >
      {Array.from(member.name)[0] ?? "?"}
    </span>
  );
}

/** 通用搜索下拉的选项：成员行（头像 + 姓名 + 拼音 + 角色）或普通行（首字圆底 + 名称 + 右侧说明，如筛选用的「全部」「待分配」）。 */
export type SearchSelectItem =
  | { kind: "member"; value: string; member: Member }
  | { kind: "plain"; value: string; name: string; hint: string };

/** 选项名（成员取姓名、普通行取名称）：触发器展示用。 */
function itemName(item: SearchSelectItem): string {
  return item.kind === "member" ? item.member.name : item.name;
}

/** 搜索匹配：成员按姓名 / 拼音 / 角色，普通行按名称 / 说明（大小写不敏感）。 */
function itemMatches(item: SearchSelectItem, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  const fields = item.kind === "member" ? [item.member.name, item.member.handle, item.member.role] : [item.name, item.hint];
  return fields.some((field) => field.includes(keyword) || field.toLowerCase().includes(lower));
}

/** 选中绿勾（与 SelectMenu 的选项勾同一枚图标）。 */
function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-600">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type SearchRowProps = { item: SearchSelectItem; selected: boolean; active: boolean; onHover: () => void; onPick: () => void };

/** 选项行：成员行 = 头像 + 姓名 + 拼音 + 角色；普通行 = 首字圆底 + 名称 + 右侧说明；选中态右侧绿勾。 */
function SearchRow({ item, selected, active, onHover, onPick }: SearchRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onPick}
      className={"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition " + (active ? "bg-zinc-100" : "")}
    >
      {item.kind === "member" ? (
        <MemberAvatar member={item.member} />
      ) : (
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-[11px] font-semibold text-zinc-600">
          {Array.from(item.name)[0] ?? "?"}
        </span>
      )}
      <span className="truncate text-sm text-zinc-800">{itemName(item)}</span>
      {item.kind === "member" ? <span className="truncate text-xs text-zinc-400">{item.member.handle}</span> : null}
      <span className="ml-auto shrink-0 pl-2 text-[11px] text-zinc-400">{item.kind === "member" ? item.member.role : item.hint}</span>
      {selected ? <CheckMark /> : null}
    </button>
  );
}

type SearchListProps = {
  items: readonly SearchSelectItem[];
  isSelected: (item: SearchSelectItem) => boolean;
  onPick: (item: SearchSelectItem) => void;
  ariaLabel: string;
  footer: string;
};

/** 搜索列表（搜索框 + 选项 + 页脚，无触发器）：人员下拉 / 行内编辑 / 通用搜索下拉共用。 */
function SearchList({ items, isSelected, onPick, ariaLabel, footer }: SearchListProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim();
    if (keyword === "") {
      return items;
    }
    return items.filter((item) => itemMatches(item, keyword));
  }, [items, query]);

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((previous) => Math.min(previous + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((previous) => Math.max(previous - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target !== undefined) {
        onPick(target);
      }
    }
  };

  return (
    <div role="listbox" aria-label={ariaLabel}>
      <div className="border-b border-zinc-100 p-2">
        <input
          ref={searchRef}
          value={query}
          aria-label={t("ms.search")}
          placeholder={t("ms.search")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleSearchKeyDown}
          className="w-full rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:bg-white focus:ring-1 focus:ring-zinc-300"
        />
      </div>
      <div className="max-h-[200px] overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-zinc-400">{t("ms.noMatch")}</p>
        ) : (
          filtered.map((item, index) => (
            <SearchRow
              key={item.value}
              item={item}
              selected={isSelected(item)}
              active={index === activeIndex}
              onHover={() => {
                setActiveIndex(index);
              }}
              onPick={() => {
                onPick(item);
              }}
            />
          ))
        )}
      </div>
      <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">{footer}</p>
    </div>
  );
}

type MemberSearchListProps = {
  options: readonly Member[];
  /** 当前选中成员 id（"" = 未选）。 */
  value: string;
  /** 多选模式（Push 136）：已选成员 id 列表；给出时选中判定改看「在不在列表里」，value 只作单选回退。 */
  selectedIds?: readonly string[];
  onPick: (member: Member) => void;
  ariaLabel: string;
};

/** 成员搜索列表（搜索框 + 选项 + 页脚）：人员下拉与任务表行内编辑共用。 */
export function MemberSearchList({ options, value, onPick, ariaLabel, selectedIds }: MemberSearchListProps) {
  const t = useT();
  const items = useMemo<SearchSelectItem[]>(() => options.map((member): SearchSelectItem => ({ kind: "member", value: member.id, member })), [options]);
  return (
    <SearchList
      items={items}
      ariaLabel={ariaLabel}
      isSelected={(item) => (selectedIds === undefined ? item.value === value : selectedIds.includes(item.value))}
      onPick={(item) => {
        if (item.kind === "member") {
          onPick(item.member);
        }
      }}
      footer={t("ms.footer", { n: options.length })}
    />
  );
}

type SearchSelectProps = {
  value: string;
  items: readonly SearchSelectItem[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** 页脚说明（人数 / 搜索口径）：与人员下拉的版式一致。 */
  footer: string;
  placeholder?: string;
  /** 浮层宽度（默认 280，与人员下拉同宽）。 */
  width?: number;
  /** 触发按钮类名（默认与 SelectMenu 同一档：白底描边 + 右侧箭头）。 */
  triggerClassName?: string;
};

/**
 * 单选搜索下拉（Push 142）：触发器 + 搜索列表（搜索框 / 选项 / 页脚）+ 选中后收起，
 * 与人员下拉 `MemberMultiSelect` / 行内成员单元格共用同一份列表版式与搜索口径（姓名 / 拼音 / 角色）。
 * 选项既可以是成员（头像 + 姓名 + 拼音 + 角色），也可以是普通项（如筛选用的「全部」「待分配」，首字圆底 + 说明）；
 * `value` / `onChange` 走调用方自己的字符串空间（甘特图负责人筛选直接用任务里的姓名，不换成成员 id）。
 */
export function SearchSelect({ value, items, onChange, ariaLabel, footer, placeholder: placeholderProp, width = 280, triggerClassName }: SearchSelectProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(width, 286);
  const t = useT();
  const placeholder = placeholderProp ?? t("sel.placeholder");
  const selected = items.find((item) => item.value === value) ?? null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          setOpen((previous) => !previous);
        }}
        className={
          triggerClassName ??
          "flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition hover:border-zinc-300 hover:bg-zinc-50"
        }
      >
        {selected === null ? (
          <span className="truncate text-zinc-400">{placeholder}</span>
        ) : (
          <span className="truncate font-medium text-zinc-800">{itemName(selected)}</span>
        )}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-zinc-400">
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
              <SearchList
                items={items}
                ariaLabel={ariaLabel}
                footer={footer}
                isSelected={(item) => item.value === value}
                onPick={(item) => {
                  onChange(item.value);
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

type MemberMultiSelectProps = {
  /** 已选成员 id（有序；空数组 = 未选）。 */
  values: string[];
  /** 勾选 / 取消勾选后回传完整选中集（顺序 = 展示顺序）。 */
  onChange: (memberIds: string[]) => void;
  options: readonly Member[];
  placeholder?: string;
  ariaLabel: string;
};

/**
 * 人员多选下拉（Push 136）：已选成员以胶囊列出（每颗可单个 ×移除），点右侧「添加 / 继续添加」开搜索列表接着勾选。
 * 用于「一个项目多位项目经理」「一个任务多位负责人」；与任务表行内多选 `InlineMemberMultiCell` 共用同一个搜索列表，
 * 浮层不随勾选关闭（可以连着点好几位）。
 * 浮层落点（Push 173）：与「项目地区 / 项目类型」字典下拉同口径，优先从触发器右侧弹出（不压住弹窗里其余表单字段），
 * 右侧放不下（窄屏 / 靠右的任务抽屉）自动回落 below；触发器右侧的箭头同步朝右（与弹出的方向一致）。
 */
export function MemberMultiSelect({ values, onChange, options, placeholder: placeholderProp, ariaLabel }: MemberMultiSelectProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(280, 286, "right");
  const t = useT();
  const placeholder = placeholderProp ?? t("ms.choose");
  const selected = values
    .map((id) => options.find((member) => member.id === id))
    .filter((member): member is Member => member !== undefined);
  const toggle = (member: Member) => {
    onChange(values.includes(member.id) ? values.filter((id) => id !== member.id) : [...values, member.id]);
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-white p-1.5 transition hover:border-zinc-300">
        {selected.map((member) => (
          <span
            key={member.id}
            className="inline-flex max-w-[200px] items-center gap-1.5 rounded-md bg-zinc-100 py-0.5 pl-0.5 pr-1 text-xs text-zinc-700"
          >
            <MemberAvatar member={member} />
            <span className="truncate">{member.name}</span>
            <button
              type="button"
              aria-label={t("ms.remove", { name: member.name })}
              onClick={() => {
                toggle(member);
              }}
              className="rounded p-0.5 text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-600"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3 w-3">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ))}
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => {
            setOpen((previous) => !previous);
          }}
          className="inline-flex min-w-[104px] flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm text-zinc-400 transition hover:bg-zinc-50"
        >
          {selected.length === 0 ? placeholder : t("ms.more")}
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 -rotate-90 text-zinc-400">
            <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-focus-scope="true"
              className="fixed z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <MemberSearchList
                options={options}
                value=""
                selectedIds={values}
                ariaLabel={ariaLabel}
                onPick={(member) => {
                  toggle(member);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
