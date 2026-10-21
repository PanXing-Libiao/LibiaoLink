import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { DICT_NAME_MAX, accentOfItem, type DictAccent, type DictItem } from "../dicts";
import { OptionList } from "./SelectMenu";
import type { SelectOption } from "./SelectMenu";
import { usePopover } from "./usePopover";
import { textOf, useLocale, useT } from "../i18n";

/** 新增分支的文案（两类字典的影响范围 / 权限口径不同，由调用方给）。 */
type DictAddText = {
  /** 顶部固定行的文字：「添加地区」/「添加项目类型」。 */
  label: string;
  /** 名称输入框占位文案。 */
  placeholder: string;
  /** 保存口径说明（浮层里的一行小字；业务口径「这个文字不用显示」时由调用方省略）。 */
  note?: string;
};

type DictSelectProps = {  /** 当前值（字典码 / 存量自定义值）。 */
  value: string;
  /** 字典项（GET /api/v1/dicts，已按 sort 升序、只含启用项）。 */
  items: DictItem[];
  ariaLabel: string;
  /** 值为空时触发器上的占位文案。 */
  placeholder: string;
  /** 选项与触发器上的内容渲染（项目类型 = 色点 + 名称；缺省纯名称）。 */
  renderContent?: (name: string, item: DictItem | null) => ReactNode;
  /** 「＋ 添加」入口（不传 = 不渲染）：返回 null = 成功；返回文案 = 浮层内提示。 */
  onAdd?: (input: { name: string; metadata: Record<string, unknown> }) => Promise<string | null>;
  /** 新增分支的文案（给 onAdd 时成套使用）。 */
  addText?: DictAddText;
  /** 颜色模板（项目类型）：新增时选一个，写进条目 metadata.accent / metadata.accentText；已在用的颜色不进候选。 */
  palette?: { label: string; options: readonly DictAccent[] };
  /** 行内删除（物理删行 · 仅管理员 dict.manage；不传 = 不渲染）：返回 null = 成功；返回文案 = 浮层内提示。 */
  onDelete?: (code: string) => Promise<string | null>;
  /** 删除按钮的无障碍名（如「删除地区 华东」）。 */
  deleteLabelOf?: (code: string, name: string) => string;
  onChange: (value: string) => void;
};

/**
 * 字典下拉候选：字典项（按 sort 升序）→ 当前值兜底（已删除条目的存量值 / 他处自定义的值），按值去重。
 * 兜底项必须保留：编辑一个值不在字典候选里的项目时，触发器仍要显示当前值（不能空白）；
 * 兜底项不给删除入口（它已经不在字典里，删了也是空转）。
 */
/**
 * 引用守卫（A3 · Push 174）：条目正被项目卡片引用时不给删 —— 删除位置灰并在悬停时说明原因（服务端同样会 409
 * DICT_ITEM_IN_USE 兜底，缓存陈旧时不会误删）；无引用返回 undefined（正常可删）。
 */
function deleteBlockReason(item: DictItem, inUseText: (n: number) => string): string | undefined {
  return item.usageCount > 0 ? inUseText(item.usageCount) : undefined;
}

function buildOptions(
  items: DictItem[],
  value: string,
  renderContent: ((name: string, item: DictItem | null) => ReactNode) | undefined,
  inUseText: (n: number) => string,
): SelectOption[] {
  const options: SelectOption[] = [];
  const seen = new Set<string>();
  const labelOf = (name: string, item: DictItem | null): ReactNode =>
    renderContent === undefined ? <span className="truncate">{name}</span> : renderContent(name, item);
  for (const item of items) {
    if (seen.has(item.code)) {
      continue;
    }
    seen.add(item.code);
    options.push({
      value: item.code,
      label: labelOf(item.name, item),
      deleteDisabledReason: deleteBlockReason(item, inUseText)
    });
  }
  if (value !== "" && !seen.has(value)) {
    options.push({ value, label: labelOf(value, null), deletable: false });
  }
  return options;
}

/**
 * 新增时可选的颜色模板：**已在用的颜色不再出现**（Push 173 业务口径「已经使用的颜色就不要出现不就好了」——
 * 卡片底色按类型去重、各类型一眼可分）；11 色全用满时回落完整色板（否则加不了新类型，属「没有空位」的兜底，不另加文案）。
 * 「已用」= 本次拿到的条目（前端缓存只留启用项；已删除的条目不在候选里，其颜色视为可复用）。
 */
function availableAccents(items: DictItem[], options: readonly DictAccent[]): readonly DictAccent[] {
  const used = new Set(items.map((item) => accentOfItem(item).color));
  const free = options.filter((entry) => !used.has(entry.color));
  return free.length > 0 ? free : options;
}

/**
 * 字典下拉（Push 167；Push 172 抽成两类共用的一个组件；Push 195 起只剩「项目类型」在用 —— 项目地区改走
 * RegionPickerModal 模态窗，随之下线「按洲分组 + 顶部搜索」的浮层管线）：与任务域 SelectMenu 同一套自绘下拉
 * （原生 select 的弹层样式由浏览器控制，与全站不一致），浮层贴弹窗右侧弹出；顶部固定一行「＋ 添加…」，下面是可选条目。
 * - 新增：写字典（region = 任何登录用户 · 全站共享；projectType = dict.manage）；项目类型随颜色模板落 metadata；
 * - 删除：行内隐式（悬停 / 聚焦才浮现，与任务表行内删除同一套语言）= **物理删行**（Push 173，dict.manage）——
 *   条目从候选与首页筛选里消失，但存量项目仍按原码 / 原名渲染（无外键引用）；
 *   **Push 174 引用守卫**：条目正被项目卡片引用（usageCount > 0）时删除位置灰、点不动、悬停说明原因，
 *   服务端同样 409 DICT_ITEM_IN_USE 兜底（缓存陈旧也不会误删）；
 * - 删除无记忆（业务口径「删除了就没有记忆了」）：同码可以重新添加，按**全新条目**处理（本次所选颜色、排到末尾），
 *   界面不出现「已停用 / 恢复」字样；缓存陈旧时服务端仍可能回 409 DICT_ITEM_EXISTS，按浮层内提示处理；
 * - 名称校验：非空、≤ DICT_NAME_MAX 字、不含英文逗号（filter[...] 是多值逗号分隔，逗号会被拆成两个筛选值）；
 *   输入的名称已存在时直接选中、不重复添加。
 */
export function DictSelect({ value, items, ariaLabel, placeholder, renderContent, onAdd, addText, palette, onDelete, deleteLabelOf, onChange }: DictSelectProps) {
  const t = useT();
  const locale = useLocale();
  /** 候选 = 字典项（按 sort 升序）→ 当前值兜底（不在字典里的存量值），按值去重。 */
  const options = useMemo(
    () => buildOptions(items, value, renderContent, (n) => textOf(locale, "dictSelect.inUse", { n })),
    [items, value, renderContent, locale],
  );
  /** 浮层高度估算：选项最多按 8 行 + 顶部「＋ 添加」一行（超出部分列表内滚动）。 */
  const popoverHeight = useMemo(() => {
    const visible = Math.min(options.length, 8);
    const list = visible * 34 + 14;
    const addRow = onAdd === undefined ? 0 : 42;
    return Math.min(list + addRow, 420);
  }, [options, onAdd]);
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(280, popoverHeight, "right");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [accentKey, setAccentKey] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 打开浮层只把选中项带进可视区一次（用户自己滚过之后不再打扰）。 */
  const listScrollDone = useRef(false);
  const selected = options.find((option) => option.value === value) ?? null;
  const nameOf = (code: string): string => {
    const item = items.find((entry) => entry.code === code);
    return item === undefined ? code : item.name;
  };
  /** 色板名显示（Push 301）：英文界面用 nameEn（色板自身不翻译中文键）；分隔符同样按语言取。 */
  const accentNameOf = (entry: DictAccent): string => (locale === "en" ? entry.nameEn : entry.name);

  /** 收起浮层并复位「添加」分支（关闭后不留残留输入 / 报错；点浮层外关掉也走这里）。 */
  const close = (): void => {
    setOpen(false);
    setAdding(false);
    setDraft("");
    setError(null);
    setListError(null);
    setPending(false);
  };

  useEffect(() => {
    if (open && adding) {
      inputRef.current?.focus();
    }
  }, [open, adding]);

  /**
   * 打开浮层把当前选中项滚进可视区（Push 192：按洲重排后，选中的那一条可能不在第一屏 —— 用列表容器算，
   * 不碰页面滚动）。只在本次打开里做一次；没选中项 / 搜到 0 条时什么也不做。
   */
  useEffect(() => {
    if (!open) {
      listScrollDone.current = false;
      return;
    }
    if (listScrollDone.current || position === null) {
      return;
    }
    const listbox = popoverRef.current?.querySelector("[role=listbox]");
    const row = listbox?.querySelector("[aria-selected=true]");
    const scroller = listbox?.parentElement ?? null;
    if (listbox === undefined || listbox === null || row === undefined || row === null || scroller === null) {
      return;
    }
    const rowBox = row.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2;
    listScrollDone.current = true;
  }, [open, position, popoverRef]);

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setDraft("");
      setError(null);
      setListError(null);
      }
  }, [open]);

  /** 可选的色板：已在用的颜色不出现（业务口径）；全用满时回落完整色板。 */
  const accentChoices: readonly DictAccent[] = palette === undefined ? [] : availableAccents(items, palette.options);
  const enterAdd = (): void => {
    setAdding(true);
    setDraft("");
    setError(null);
    setListError(null);
    const [firstAccent] = accentChoices;
    setAccentKey(firstAccent === undefined ? null : firstAccent.key);
  };

  const submitAdd = async (): Promise<void> => {
    if (onAdd === undefined) {
      return;
    }
    const name = draft.trim();
    if (name === "") {
      setError(t("dictSelect.empty"));
      return;
    }
    if (name.length > DICT_NAME_MAX) {
      setError(t("dictSelect.tooLong", { n: DICT_NAME_MAX }));
      return;
    }
    if (name.includes(",")) {
      setError(t("dictSelect.comma"));
      return;
    }
    const existed = options.find((option) => option.value === name);
    if (existed !== undefined) {
      onChange(existed.value);
      close();
      return;
    }
    let metadata: Record<string, unknown> = {};
    if (palette !== undefined) {
      const entry = accentChoices.find((option) => option.key === accentKey);
      if (entry === undefined) {
        setError(t("dictSelect.pickColor"));
        return;
      }
      metadata = { accent: entry.color, accentText: entry.text };
    }
    setPending(true);
    const message = await onAdd({ name, metadata });
    setPending(false);
    if (message !== null) {
      setError(message);
      return;
    }
    onChange(name);
    close();
  };

  /**
   * 删除条目（物理删行）：成功后该条目立刻从候选里消失（父层替换缓存；服务端 404 由提示行兜住）。
   * 删掉的正好是当前值时**不改当前选中** —— 存量项目仍按原值展示，兜底项继续兜住它。
   */
  const submitDelete = async (code: string): Promise<void> => {
    if (onDelete === undefined || deleting !== null) {
      return;
    }
    setDeleting(code);
    setListError(null);
    const message = await onDelete(code);
    setDeleting(null);
    if (message !== null) {
      setListError(message);
    }
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitAdd();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setAdding(false);
      setDraft("");
      setError(null);
    }
  };


  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm transition hover:border-zinc-300 hover:bg-zinc-50"
      >
        {selected === null ? (
          <span className="truncate text-zinc-400">{placeholder}</span>
        ) : (
          <span className="truncate font-medium text-zinc-800">{selected.label}</span>
        )}
        {/* 箭头朝右：与「贴右侧弹出」的落点同向（Push 173）。 */}
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 -rotate-90 text-zinc-400">
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
              {adding ? (
                <div className="p-2">
                  <input
                    ref={inputRef}
                    value={draft}
                    aria-label={addText?.label}
                    placeholder={addText?.placeholder}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={handleDraftKeyDown}
                    className="w-full rounded-lg bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:bg-white focus:ring-1 focus:ring-zinc-300"
                  />
                  {palette === undefined ? null : (
                    <div className="mt-2">
                      <p className="text-[11px] font-medium text-zinc-500">{palette.label}</p>
                      <div className="mt-1.5 grid grid-cols-8 gap-1.5">
                        {accentChoices.map((entry) => (
                          <button
                            key={entry.key}
                            type="button"
                            aria-label={palette.label + (locale === "en" ? ": " : "：") + accentNameOf(entry)}
                            aria-pressed={entry.key === accentKey}
                            title={accentNameOf(entry)}
                            onClick={() => {
                              setAccentKey(entry.key);
                            }}
                            style={{ backgroundColor: entry.color }}
                            className={
                              "flex h-6 w-6 items-center justify-center rounded-full ring-2 transition " +
                              (entry.key === accentKey ? "ring-zinc-900/60" : "ring-transparent hover:ring-zinc-300")
                            }
                          >
                            {entry.key === accentKey ? (
                              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3 w-3" style={{ color: entry.text }}>
                                <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {(addText?.note ?? "") === "" ? null : (
                    <p className="mt-1.5 text-[11px] text-zinc-400">{addText?.note}</p>
                  )}
                  {error === null ? null : (
                    <p role="alert" className="mt-1 text-[11px] text-rose-600">
                      {error}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false);
                        setDraft("");
                        setError(null);
                      }}
                      className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition hover:bg-zinc-50"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        void submitAdd();
                      }}
                      className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pending ? t("dictSelect.adding") : t("dictSelect.add")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {onAdd === undefined ? null : (
                    <>
                      <div className="p-1">
                        <button
                          type="button"
                          onClick={enterAdd}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium text-blue-600 transition hover:bg-blue-50"
                        >
                          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4 shrink-0">
                            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                          {addText?.label}
                        </button>
                      </div>
                      <div className="border-t border-zinc-100" />
                    </>
                  )}
                  <div className="max-h-[280px] overflow-y-auto">
                    <OptionList
                      options={options}
                      value={value}
                      ariaLabel={ariaLabel}
                      onDeleteOption={
                        onDelete === undefined
                          ? undefined
                          : (option) => {
                              void submitDelete(option.value);
                            }
                      }
                      deleteLabelOf={
                        deleteLabelOf === undefined
                          ? undefined
                          : (option) => deleteLabelOf(option.value, nameOf(option.value))
                      }
                      onPick={(next) => {
                        onChange(next);
                        close();
                      }}
                    />
                  </div>
                  {listError === null ? null : (
                    <p role="alert" className="border-t border-zinc-100 px-3 py-2 text-[11px] text-rose-600">
                      {listError}
                    </p>
                  )}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
