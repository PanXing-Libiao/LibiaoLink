import { useState } from "react";
import { InlineCell } from "./InlineEdit";
import {
  DOC_TYPE_NAME_MAX,
  DOC_TYPE_NAME_PATTERN,
  DOC_TYPE_OPTIONS,
  DOC_TYPE_SELECTION_MAX,
  isBuiltinDocType,
} from "../docTypes";
import { fieldText, useLocale, useT, type Locale } from "../i18n";

/**
 * 输出成果文件（deliverableTypes）选择器（2026-10-08 · 业务口径「文件输出成果也要可以选择」）：
 * 内置十类成果文件（契约 DOC_TYPES；顺序 = 契约顺序：CAD图纸 / 技术协议 / 合同 / 评审单 / 设备清单 /
 * 物料总清单 / 发货装箱单 / 到货单 / 安装完成证明 / 验收单）+ 全站 deliverableType 自定义类型。项目项目经理可新增，新增后所有项目共享。
 * 样式照业务给的参考图 —— 顶部搜索框（「查找选项」）+ 「多选」小标 + 彩签选项（悬停浅灰底、选中打绿勾、
 * 点选不收浮层、再点取消）；列表底部新增「＋ 自定义」，输入名称后立即选中并保存。
 * 色表（2026-10-08 业务口径「和这个相同即可 简约一点」）对齐「是否按时交付」列徽标：浅彩底（Tailwind 50 档 hex）+ 同色系深字小签（rounded + px-1.5 py-0.5 + text-[11px]）。
 * 任务表「输出成果文件」列与任务详情抽屉「输出成果文件」行共用（DeliverableCell）。
 */


/** 彩签色表（十类色相：CAD图纸粉 / 技术协议蓝 / 合同青 / 评审单绿 / 设备清单红 / 物料总清单橙 /
 *  发货装箱单黄 / 到货单紫 / 安装完成证明黄 / 验收单橙）：50 档浅彩底 + 同色系深字（同「是否按时交付」徽标口径，2026-10-08 业务口径「和这个相同即可 简约一点」）。 */
export const DOC_TYPE_CLASS: Record<string, string> = {
  CAD图纸: "bg-[#FDF2F8] text-pink-600",
  技术协议: "bg-[#EFF6FF] text-blue-600",
  合同: "bg-[#ECFEFF] text-cyan-600",
  评审单: "bg-[#ECFDF5] text-emerald-600",
  设备清单: "bg-[#FEF2F2] text-red-600",
  物料总清单: "bg-[#FFF7ED] text-orange-600",
  发货装箱单: "bg-[#FFFBEB] text-amber-700",
  到货单: "bg-[#FAF5FF] text-purple-600",
  安装完成证明: "bg-[#FEFCE8] text-yellow-700",
  验收单: "bg-[#FFF7ED] text-orange-600",
};

/** 自定义类型的浅彩底候选：按名称稳定取色，同一名称跨任务 / 刷新保持一致（未收录的内置值也复用此表）。 */
const CUSTOM_DOC_TYPE_CLASSES = [
  "bg-[#F5F3FF] text-violet-600",
  "bg-[#F0F9FF] text-sky-600",
  "bg-[#ECFDF5] text-emerald-600",
  "bg-[#FFF1F2] text-rose-600",
  "bg-[#FFFBEB] text-amber-700",
] as const;

function docTypeClass(name: string): string {
  const known = DOC_TYPE_CLASS[name];
  if (known !== undefined) return known;
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return CUSTOM_DOC_TYPE_CLASSES[hash % CUSTOM_DOC_TYPE_CLASSES.length] ?? "bg-zinc-100 text-zinc-600";
}

/** 选择面板最大高度（px）：与 InlineCell 的浮层定位估算共用，超出后只滚动选项区。 */
const DELIVERABLE_PANEL_MAX_HEIGHT = 524;

function docTypeText(name: string, locale: Locale): string {
  return isBuiltinDocType(name) ? fieldText(locale, name) : name;
}

/** 成果文件小色签（浮层选项 / 静态展示用；同「是否按时交付」徽标口径，未收录回落浅灰）。 */
export function docTypeChip(name: string, locale: Locale) {
  return (
    <span className={"inline-block max-w-full break-words rounded px-1.5 py-0.5 text-[11px] font-medium " + docTypeClass(name)}>
      {docTypeText(name, locale)}
    </span>
  );
}

/** 成果文件小色签（单元格 / 抽屉展示用 · 2026-10-08 业务口径「和这个相同即可 简约一点」）：
 *  对齐「是否按时交付」列徽标 —— 浅彩底 + 同色系字（rounded + px-1.5 py-0.5，无白框 / 无描边），
 *  悬停亮一档（brightness 微降，色相不动）。 */
export function docTypeCapsule(name: string, locale: Locale) {
  return (
    <span
      data-deliverable-value={name}
      className={
        "inline-block max-w-full break-words rounded px-1.5 py-0.5 text-[11px] font-medium transition hover:brightness-[0.97] " +
        docTypeClass(name)
      }
    >
      {docTypeText(name, locale)}
    </span>
  );
}

/** 选择面板（搜索 + 内置十类 + 全站自定义）：点选项不关浮层、可连着选；再点已选项 = 取消。 */
type DeliverablePanelProps = {
  values: readonly string[];
  /** 勾选 / 取消一枚（浮层不自动关；落值 = 勾选顺序的数组）。 */
  onChange: (next: string[]) => void;
  /** 全站 deliverableType 字典名称（后端已按 sort 排好；面板再去重并追加当前任务里尚未入字典的历史值）。 */
  customTypes?: readonly string[];
  /** 当前项目项目经理 = true；非项目经理仍显示入口，但置灰并给出说明。 */
  canCreateCustom?: boolean;
  /** 新增全站自定义类型：返回 null = 成功；返回文案 = 面板内联错误。 */
  onCreateCustom?: (name: string) => Promise<string | null>;
};

export function DeliverablePanel({ values, onChange, customTypes = [], canCreateCustom = false, onCreateCustom }: DeliverablePanelProps) {
  const t = useT();
  const locale = useLocale();
  const [keyword, setKeyword] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [customSaving, setCustomSaving] = useState(false);
  const query = keyword.trim().toLowerCase();
  const options = Array.from(
    new Set([
      ...DOC_TYPE_OPTIONS,
      ...customTypes.filter((name) => name.trim() !== "" && !isBuiltinDocType(name)),
      ...values.filter((value) => value.trim() !== "" && !isBuiltinDocType(value)),
    ]),
  );
  const filtered = query === "" ? options : options.filter((option) => option.toLowerCase().includes(query));

  const closeCustom = (): void => {
    setCustomOpen(false);
    setCustomName("");
    setCustomError(null);
  };

  const addCustom = async (): Promise<void> => {
    if (customSaving) return;
    const name = customName.trim();
    if (name === "") {
      setCustomError(t("dp.customRequired"));
      return;
    }
    if (name.length > DOC_TYPE_NAME_MAX) {
      setCustomError(t("dp.customTooLong"));
      return;
    }
    if (!DOC_TYPE_NAME_PATTERN.test(name)) {
      setCustomError(t("dp.customInvalidChars"));
      return;
    }
    if (!values.includes(name) && values.length >= DOC_TYPE_SELECTION_MAX) {
      setCustomError(t("dp.customMax"));
      return;
    }
    // 内置十类或已存在的全站自定义项：直接选中，不重复写字典。
    if (options.includes(name)) {
      if (!values.includes(name)) onChange([...values, name]);
      setKeyword("");
      closeCustom();
      return;
    }
    if (!canCreateCustom || onCreateCustom === undefined) {
      setCustomError(t("dp.customManagerOnlyHint"));
      return;
    }
    setCustomSaving(true);
    try {
      const error = await onCreateCustom(name);
      if (error !== null) {
        setCustomError(error);
        return;
      }
      if (!values.includes(name)) onChange([...values, name]);
      setKeyword("");
      closeCustom();
    } catch (error: unknown) {
      setCustomError(error instanceof Error && error.message !== "" ? error.message : t("app.fail.addDeliverableType"));
    } finally {
      setCustomSaving(false);
    }
  };

  const customLabel = t("dp.customWithRole");
  return (
    <div
      data-deliverable-panel="true"
      className="flex flex-col"
      style={{ maxHeight: "min(calc(100vh - 16px), " + DELIVERABLE_PANEL_MAX_HEIGHT + "px)" }}
    >
      <div className="shrink-0 border-b border-zinc-100 px-2 py-1.5">
        <input
          data-deliverable-search="true"
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          placeholder={t("dp.search")}
          className="w-full rounded-md bg-transparent px-1.5 py-1 text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
        />
      </div>
      <div className="shrink-0 px-3 pb-1 pt-2 text-[11px] leading-4 text-zinc-400">{t("dp.multi")}</div>
      <div
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("dp.listAria")}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      >
        {filtered.length === 0 ? <div className="px-2.5 py-2 text-xs text-zinc-400">{t("dp.noMatch")}</div> : null}
        {filtered.map((option) => {
          const selected = values.includes(option);
          return (
            <button
              key={option}
              type="button"
              role="option"
              data-deliverable-option={option}
              aria-selected={selected}
              onClick={() => {
                onChange(selected ? values.filter((value) => value !== option) : [...values, option]);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-zinc-100"
            >
              {docTypeChip(option, locale)}
              {selected ? (
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600">
                  <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-zinc-100 p-2">
        {customOpen && canCreateCustom ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void addCustom();
            }}
          >
            <input
              autoFocus
              data-deliverable-custom-input="true"
              value={customName}
              maxLength={DOC_TYPE_NAME_MAX}
              disabled={customSaving}
              aria-label={t("dp.customAria")}
              placeholder={t("dp.customPlaceholder")}
              onChange={(event) => {
                setCustomName(event.target.value);
                setCustomError(null);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeCustom();
                }
              }}
              className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 disabled:bg-zinc-50 disabled:text-zinc-400"
            />
            {customError === null ? null : (
              <p role="alert" className="mt-1 text-[11px] leading-4 text-rose-600">
                {customError}
              </p>
            )}
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button
                type="button"
                disabled={customSaving}
                onClick={closeCustom}
                className="rounded-md px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("dp.customCancel")}
              </button>
              <button
                type="submit"
                data-deliverable-custom-submit="true"
                disabled={customSaving}
                className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
              >
                {customSaving ? t("dp.customSaving") : t("dp.customAdd")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            data-deliverable-custom-button="true"
            aria-expanded="false"
            aria-label={canCreateCustom ? customLabel : customLabel + "，" + t("dp.customManagerOnlyHint")}
            title={canCreateCustom ? undefined : t("dp.customManagerOnlyHint")}
            disabled={!canCreateCustom}
            onClick={() => {
              setCustomOpen(true);
              setCustomError(null);
            }}
            className={"flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-zinc-500 transition " + (canCreateCustom ? "hover:bg-zinc-100 hover:text-zinc-700" : "cursor-not-allowed opacity-45")}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3.5 w-3.5 shrink-0">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            {customLabel}
          </button>
        )}
      </div>
    </div>
  );
}

type DeliverableCellProps = {
  values: readonly string[];
  /** 全站自定义成果类型名称（bootstrap 字典 deliverableType）。 */
  customTypes?: readonly string[];
  /** 当前项目项目经理才可新增；false = 入口置灰。 */
  canCreateCustom?: boolean;
  /** 新增全站自定义类型（返回 null = 成功；文案 = 错误）。 */
  onCreateCustom?: (name: string) => Promise<string | null>;
  /** 勾选 / 取消一枚（浮层不自动关；落值 = 勾选顺序的数组）。 */
  onChange: (next: string[]) => void;
  /** 全量摊开（抽屉行用：色签折行全显）；缺省 = 首枚 + 「+N」（任务表列用，窄列单行）。 */
  all?: boolean;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
};

/** 行内选择单元格（任务表列 / 抽屉行共用）：空值 = 「—」（液态玻璃小框，同列内其它空态口径）；
 *  有值 = 浅彩底小色签（首枚 + 「+N」；抽屉行 all = 全量摊开逐枚）—— 点开 = DeliverablePanel。 */
export function DeliverableCell({ values, onChange, customTypes = [], canCreateCustom = false, onCreateCustom, all = false, disabled = false, disabledHint }: DeliverableCellProps) {
  const t = useT();
  const locale = useLocale();
  const filled = values.length > 0;
  const shown = all ? values : values.slice(0, 1);
  const display = filled ? (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((docType) => (
        <span key={docType}>{docTypeCapsule(docType, locale)}</span>
      ))}
      {all || values.length <= 1 ? null : <span className="text-[10px] text-zinc-400">+{values.length - 1}</span>}
    </span>
  ) : (
    <span className="text-zinc-300">—</span>
  );
  return (
    <InlineCell
      ariaLabel={t("dp.editAria")}
      title={t("dp.pickTitle")}
      width={200}
      height={DELIVERABLE_PANEL_MAX_HEIGHT}
      disabled={disabled}
      disabledHint={disabledHint}
      bare={filled}
      wrapContent={all}
      triggerClassName={filled ? "p-0" : undefined}
      display={display}
      render={() => (
        <DeliverablePanel
          values={values}
          onChange={onChange}
          customTypes={customTypes}
          canCreateCustom={canCreateCustom}
          onCreateCustom={onCreateCustom}
        />
      )}
    />
  );
}
