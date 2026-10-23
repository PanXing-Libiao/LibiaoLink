import { useState } from "react";
import { InlineCell } from "./InlineEdit";
import { DOC_TYPE_OPTIONS } from "../docTypes";
import { fieldText, useLocale, useT, type Locale } from "../i18n";

/**
 * 输出成果文件（deliverableTypes）选择器（2026-10-08 · 业务口径「文件输出成果也要可以选择」）：
 * 十类成果文件字典（契约 DocType 枚举；顺序 = 契约顺序：CAD图纸 / 技术协议 / 合同 / 评审单 / 设备清单 /
 * 物料总清单 / 发货装箱单 / 到货单 / 安装完成证明 / 验收单），样式照业务给的参考图 ——
 * 顶部搜索框（「查找选项」）+ 「多选」小标 + 彩签选项（悬停浅灰底、选中打绿勾、点选不收浮层、再点取消）。
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

/** 成果文件小色签（浮层选项 / 静态展示用；同「是否按时交付」徽标口径，未收录回落浅灰）。 */
export function docTypeChip(name: string, locale: Locale) {
  return (
    <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + (DOC_TYPE_CLASS[name] ?? "bg-zinc-100 text-zinc-600")}>
      {fieldText(locale, name)}
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
        "inline-block rounded px-1.5 py-0.5 text-[11px] font-medium transition hover:brightness-[0.97] " +
        (DOC_TYPE_CLASS[name] ?? "bg-zinc-100 text-zinc-600")
      }
    >
      {fieldText(locale, name)}
    </span>
  );
}

/** 选择面板（搜索 + 十类多选）：点选项不关浮层、可连着选；再点已选项 = 取消。 */
export function DeliverablePanel({ values, onChange }: { values: readonly string[]; onChange: (next: string[]) => void }) {
  const t = useT();
  const locale = useLocale();
  const [keyword, setKeyword] = useState("");
  const query = keyword.trim().toLowerCase();
  const filtered = query === "" ? DOC_TYPE_OPTIONS : DOC_TYPE_OPTIONS.filter((option) => option.toLowerCase().includes(query));
  return (
    <div data-deliverable-panel="true">
      <div className="border-b border-zinc-100 px-2 py-1.5">
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
      <div className="px-3 pb-1 pt-2 text-[11px] leading-4 text-zinc-400">{t("dp.multi")}</div>
      <div role="listbox" aria-multiselectable="true" aria-label={t("dp.listAria")} className="p-1">
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
    </div>
  );
}

type DeliverableCellProps = {
  values: readonly string[];
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
export function DeliverableCell({ values, onChange, all = false, disabled = false, disabledHint }: DeliverableCellProps) {
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
      height={DOC_TYPE_OPTIONS.length * 34 + 40 + 26 + 12}
      disabled={disabled}
      disabledHint={disabledHint}
      bare={filled}
      wrapContent={all}
      triggerClassName={filled ? "p-0" : undefined}
      display={display}
      render={() => <DeliverablePanel values={values} onChange={onChange} />}
    />
  );
}
