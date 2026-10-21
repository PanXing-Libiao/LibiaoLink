import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Member } from "../data/members";
import { MemberSearchList } from "./MemberSelect";
import { MultiOptionList, OptionList, type SelectOption } from "./SelectMenu";
import { Toast } from "./Toast";
import { usePopover } from "./usePopover";
import { monthYearText, useLocale, useMachineText, useT } from "../i18n";

const WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS_EN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const pad = (value: number) => String(value).padStart(2, "0");
const toKey = (date: Date) =>
  String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
const toDate = (key: string) => {
  const parts = key.split("-").map((part) => Number(part));
  return new Date(parts[0] ?? 2026, (parts[1] ?? 1) - 1, parts[2] ?? 1);
};

type InlineCellProps = {
  ariaLabel: string;
  title?: string;
  /** 单元格当前值的展示（表格里的样子）。 */
  display: ReactNode;
  /** 浮层尺寸（用于定位 / 翻转判断）。 */
  width: number;
  height: number;
  /** 触发器（单元格本体）附加类名，如右对齐列用 `justify-self-end`。 */
  triggerClassName?: string;
  /** 裸框模式（Push 134）：撤掉「液态玻璃」小框的底 / 边 / 模糊，底色 / 字色 / 内边距由 triggerClassName 给。 */
  bare?: boolean;
  /** 内容不裁剪（Push 217 续③ · 业务口径「会出现截断的问题」）：默认包裹层走 `truncate`（单行省略、超出即裁），
   *  true = 撤裁剪 —— 供「问题归类」这类**多枚色签折行**的单元格用：窄窗 / 列被挤到最小时色签不再被裁掉一角。 */
  wrapContent?: boolean;
  /** 锁定入口（Push 264 · P1-1 定档行内联编辑；2026-10-10 业务追订「点击后显示弹出即可 不要红色的圆提示」+
   *  「都用这个即可」）：true = 单元格保留可点（不再用 disabled 属性 / 不再出 not-allowed 红色圆圈光标），
   *  点击不弹编辑浮层、改为弹出站点同款顶部浮空 Toast（error 档 · 文案 = disabledHint）；悬停 title 仍出 disabledHint，
   *  测试钩子照旧落 [data-inline-cell=disabled]（Toast 上另挂 data-inline-locked-hint）。 */
  disabled?: boolean;
  /** 锁定说明文案（如「任务已定档，不支持任何修改（文件修改走变更）」）：悬停 title 与点击 Toast 共用。 */
  disabledHint?: string;
  /** 浮层内容；`close` 用于选完即关。 */
  render: (close: () => void) => ReactNode;
};

/**
 * 表格行内编辑的通用外壳（Push 64）：单元格本身是按钮，点击在被点的位置弹出浮层（portal 到 body，
 * 不被表格横向滚动裁掉），点浮层外 / Esc 关闭；浮层里的控件不冒泡到行（不会触发行选中的抽屉）。
 * Push 264（P1-1 定档锁定）：加 disabled 锁定态 —— 入口保留可点、样式与可编辑态全等，点击改为弹出站点同款顶部
 *  Toast（2026-10-10 业务追订「点击后显示弹出即可 不要红色的圆提示」+「都用这个即可」；见 InlineCellProps.disabled）。
 */
export function InlineCell({ ariaLabel, title, display, width, height, triggerClassName, bare = false, wrapContent = false, disabled = false, disabledHint, render }: InlineCellProps) {
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(width, height);
  /** 锁定说明 Toast（Push 264 续 · 2026-10-10 业务口径「都用这个即可」）：点击锁定入口 → 站点同款顶部浮空 Toast
   *  （error 档：rose 边框 / 浅底 + 「关闭」按钮，2s 自动消失）；tick 只增不减 —— 连点同一格也以新 key 重新计时。 */
  const [lockedHintTick, setLockedHintTick] = useState(0);
  const t = useT();
  const resolvedTitle = title ?? t("ie.clickEdit");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-disabled={disabled}
        title={disabled ? (disabledHint ?? resolvedTitle) : resolvedTitle}
        data-inline-cell={
          // 测试钩子（Push 226）：回放脚本据 [data-inline-cell=editor] 取「同款」参照；bare（裸框）模式另标；
          // 定档锁定（Push 264）落 [data-inline-cell=disabled] —— 回放脚本据此认锁定入口（点击出顶部 Toast、不出编辑浮层）。
          disabled ? "disabled" : bare ? "bare" : "editor"
        }
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) {
            // 锁定入口（Push 264 续）：不弹编辑浮层，改出站点同款顶部 Toast（文案 = 409 TASK_FINALIZED 同句）。
            setLockedHintTick((tick) => tick + 1);
            return;
          }
          setOpen((previous) => !previous);
        }}
        onKeyDown={(event) => {
          // Esc 直接关掉浮层（行本身只认 Enter / 空格，不需要拦 Esc）；Push 212 续：浮层开着时拦住冒泡 ——
          // 抽屉 / 弹层里的外层 Esc（如「问题详情」抽屉）不该被同一按连带关掉（「Esc 先关内层」口径）；
          // 浮层没开时不拦，Esc 照旧往外走（如焦点还在触发器上时按 Esc 关外层）。
          if (event.key === "Escape") {
            if (open) {
              event.stopPropagation();
            }
            setOpen(false);
            return;
          }
          event.stopPropagation();
        }}
        className={
          // 「液态玻璃」小框（Push 66）：可点区域 = 这个框本身 —— 不给负外边距。
          // 静止态 = 白底 + 淡灰描边（Push 67 按业务样张调）；悬停 / 展开时才稍微实一点。
          // Push 134：bare = 裸框模式 —— 撤掉小框的白底 / 描边 / 模糊，**尺寸与配色全交给调用方**（triggerClassName 给，
          // 例如状态列正常模式 = 色签填满整颗胶囊、醒目模式 = 只留深色字），基础类只留几何与过渡。
          // Push 264 续（2026-10-10）：锁定态不再套「只读灰框 + not-allowed 红色圆圈光标」—— 样式与可编辑态全等，
          // 点击换出的顶部 Toast 见下方渲染片段。
          (bare
            ? "inline-flex max-w-full items-center justify-start rounded-lg text-left transition "
            : "inline-flex max-w-full items-center gap-1 rounded-lg border px-1.5 py-[3px] text-left text-xs " +
              "backdrop-blur-[3px] transition " +
              (open
                ? "border-zinc-300 bg-white ring-1 ring-zinc-900/10 shadow-[0_4px_14px_rgba(15,23,42,0.12)] "
                : "border-zinc-200/90 bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] " +
                  "hover:border-zinc-300 hover:bg-white hover:shadow-[0_2px_6px_rgba(15,23,42,0.08)] ")) +
          (triggerClassName === undefined ? "" : " " + triggerClassName)
        }
      >
        <span className={wrapContent ? "min-w-0" : "min-w-0 truncate"}>{display}</span>
      </button>
      {disabled && lockedHintTick > 0 ? (
        <Toast
          key={"locked-hint-" + String(lockedHintTick)}
          kind="error"
          anchor={{ name: "data-inline-locked-hint", value: "true" }}
          text={disabledHint ?? resolvedTitle}
          onClose={() => {
            setLockedHintTick(0);
          }}
        />
      ) : null}
      {open && !disabled && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-inline-popover="true"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              className="fixed z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              {render(() => {
                setOpen(false);
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

type InlineMemberMultiCellProps = {
  /** 已选成员 id（有序，Push 136）。 */
  values: string[];
  options: readonly Member[];
  ariaLabel: string;
  /** 勾选 / 取消勾选一位成员（浮层不自动关 —— 接着点下一位）。 */
  onPick: (member: Member) => void;
  display: ReactNode;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
};

/**
 * 行内人员多选单元格（Push 136）：项目经理 / 任务负责人两列共用。
 * 勾选 / 取消勾选都不收浮层（一次可以连着点好几位），选完点浮层外 / Esc 收起。
 */
export function InlineMemberMultiCell({ values, options, ariaLabel, onPick, display, disabled = false, disabledHint }: InlineMemberMultiCellProps) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.pickMembers")}
      width={280}
      height={286}
      disabled={disabled}
      disabledHint={disabledHint}
      display={display}
      render={() => (
        <MemberSearchList
          options={options}
          value=""
          selectedIds={values}
          ariaLabel={ariaLabel}
          onPick={(member) => {
            onPick(member);
          }}
        />
      )}
    />
  );
}

type InlineMemberCellProps = {
  /** 当前选中成员 id（"" = 未选 / 待分派）。 */
  value: string;
  options: readonly Member[];
  ariaLabel: string;
  /** 选中一位成员（选完即收浮层）。 */
  onPick: (member: Member) => void;
  /** 给了才出「待分派」清空行（Push 244：问题处理人 / 责任人可回缺省）。 */
  onClear?: () => void;
  display: ReactNode;
  /** 裸框模式（Push 134）：不套「液态玻璃」白底小框，底色 / 字色 / 内边距由 triggerClassName 给。 */
  bare?: boolean;
  /** 触发器附加类名（表格 / 抽屉里给「悬停才现」的淡色可点提示）。 */
  triggerClassName?: string;
};

/** 行内成员单选单元格（Push 244 · 业务口径「这个负责人要可以编辑」）：浮层 = 成员搜索列表
 *  （与人员下拉同一份版式）+ 首行「待分派」清空项（给了 onClear 才有）；选完即收浮层。 */
export function InlineMemberCell({ value, options, ariaLabel, onPick, onClear, display, bare = false, triggerClassName }: InlineMemberCellProps) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.pickMember")}
      width={280}
      height={onClear === undefined ? 286 : 330}
      bare={bare}
      triggerClassName={triggerClassName}
      display={display}
      render={(close) => (
        <div>
          {onClear === undefined ? null : (
            <button
              type="button"
              data-member-clear=""
              onClick={() => {
                onClear();
                close();
              }}
              className="flex w-full items-center gap-2 border-b border-zinc-100 px-3 py-2.5 text-left text-sm text-zinc-500 transition hover:bg-zinc-50"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-xs text-zinc-400">—</span>
              {t("ie.unassigned")}
            </button>
          )}
          <MemberSearchList
            options={options}
            value={value}
            ariaLabel={ariaLabel}
            onPick={(member) => {
              onPick(member);
              close();
            }}
          />
        </div>
      )}
    />
  );
}

type InlineOptionCellProps = {
  value: string;
  options: SelectOption[];
  ariaLabel: string;
  onPick: (value: string) => void;
  display: ReactNode;
  /** 裸框模式（Push 134）：不套「液态玻璃」白底小框，底色 / 字色 / 内边距由 triggerClassName 给。 */
  bare?: boolean;
  /** 触发器附加类名（醒目模式下 = 状态字的深色档）。 */
  triggerClassName?: string;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
};

/** 行内枚举单元格（如紧急重要度）。 */
export function InlineOptionCell({ value, options, ariaLabel, onPick, display, bare = false, triggerClassName, disabled = false, disabledHint }: InlineOptionCellProps) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.pick")}
      width={140}
      height={options.length * 34 + 12}
      disabled={disabled}
      disabledHint={disabledHint}
      bare={bare}
      triggerClassName={triggerClassName}
      display={display}
      render={(close) => (
        <OptionList
          options={options}
          value={value}
          ariaLabel={ariaLabel}
          onPick={(next) => {
            onPick(next);
            close();
          }}
        />
      )}
    />
  );
}

type InlineMultiOptionCellProps = {
  values: readonly string[];
  options: readonly string[];
  ariaLabel: string;
  /** 勾选 / 取消勾选一枚（浮层不自动关 —— 可接着点下一枚）；落值 = 勾选顺序的数组。 */
  onChange: (values: string[]) => void;
  display: ReactNode;
  /** 选项文案渲染（Push 208 追加 · 业务口径「要有颜色 两处」）：转交 MultiOptionList —— 给 = 出小色签。 */
  renderLabel?: (option: string) => ReactNode;
  /** 裸框模式（Push 134）：不套「液态玻璃」白底小框，底色 / 字色 / 内边距由 triggerClassName 给。 */
  bare?: boolean;
  /** 触发器附加类名（表格里给「悬停才现」的淡色可点提示）。 */
  triggerClassName?: string;
  /** 内容不裁剪（Push 217 续③）：转交 InlineCell —— 多枚色签折行的单元格用（窄窗 / 列被挤到最小时不被裁掉一角）。 */
  wrapContent?: boolean;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
};

/** 行内多选单元格（Push 208 · 业务口径「问题归类都要可以修改」）：浮层 = 与「问题归类」表单侧同款的
 *  MultiOptionList（绿勾选中项、点选不收浮层、再点取消）；点浮层外 / Esc 收起。 */
export function InlineMultiOptionCell({ values, options, ariaLabel, onChange, display, renderLabel, bare = false, triggerClassName, wrapContent = false, disabled = false, disabledHint }: InlineMultiOptionCellProps) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.pickMulti")}
      width={180}
      height={options.length * 34 + 12}
      disabled={disabled}
      disabledHint={disabledHint}
      bare={bare}
      wrapContent={wrapContent}
      triggerClassName={triggerClassName}
      display={display}
      render={() => (
        <MultiOptionList values={values} options={options} ariaLabel={ariaLabel} onChange={onChange} renderLabel={renderLabel} />
      )}
    />
  );
}

/** 行内日期单元格（单个日期的小日历）。 */
export function InlineDateCell({
  valueIso,
  display,
  ariaLabel,
  onChange,
  triggerClassName,
  disabled = false,
  disabledHint,
}: {
  valueIso: string;
  display: ReactNode;
  ariaLabel: string;
  onChange: (iso: string) => void;
  triggerClassName?: string;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
}) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.pickDate")}
      width={264}
      height={336}
      disabled={disabled}
      disabledHint={disabledHint}
      display={display}
      triggerClassName={triggerClassName}
      render={(close) => (
        <MiniCalendar
          value={valueIso}
          onChange={(iso) => {
            onChange(iso);
            close();
          }}
        />
      )}
    />
  );
}

function MiniCalendar({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState(() => {
    const base = value === "" ? new Date() : toDate(value);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const cells = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(year, month, 1 - offset + index);
      return { key: toKey(date), day: date.getDate(), inMonth: date.getMonth() === month };
    });
  }, [view]);

  return (
    <div className="p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label={t("ie.prevMonth")}
          onClick={() => {
            setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <p className="text-sm font-semibold text-zinc-800">
          {monthYearText(locale, view.getFullYear(), view.getMonth() + 1)}
        </p>
        <button
          type="button"
          aria-label={t("ie.nextMonth")}
          onClick={() => {
            setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));
          }}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-y-1 text-center text-[11px] text-zinc-400">
        {(locale === "en" ? WEEKDAYS_EN : WEEKDAYS_ZH).map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-y-1">
        {cells.map((cell) => {
          const selected = cell.key === value;
          const base = "flex h-8 w-full items-center justify-center rounded-lg text-xs transition ";
          const tone = selected
            ? "bg-zinc-900 font-semibold text-white "
            : cell.inMonth
              ? "text-zinc-600 hover:bg-zinc-100 "
              : "text-zinc-300 ";
          return (
            <button
              key={cell.key}
              type="button"
              disabled={!cell.inMonth}
              onClick={() => {
                onChange(cell.key);
              }}
              className={base + tone}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2">
        <button
          type="button"
          onClick={() => {
            onChange("");
          }}
          className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-zinc-100"
        >
          {t("ie.clear")}
        </button>
        <button
          type="button"
          onClick={() => {
            onChange(toKey(new Date()));
          }}
          className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-600 transition hover:bg-zinc-100"
        >
          {t("ie.today")}
        </button>
      </div>
    </div>
  );
}

/** 行内数字单元格（预计所需施工人数；Push 217 续⑥起「问题详情」抽屉的「施工人数」共用）。
 *  「点「保存」才落值、落值即收浮层」（与 InlineTextCell 同一口径）；取消 / Esc / 点浮层外收起 = 原值不动。 */
export function InlineNumberCell({
  value,
  display,
  ariaLabel,
  suffix: suffixProp,
  onSave,
  disabled = false,
  disabledHint,
}: {
  value: number;
  display: ReactNode;
  ariaLabel: string;
  suffix?: string;
  onSave: (value: number) => void;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
}) {
  const t = useT();
  /** 人头单位后缀（Push 301）：默认「人」、英文界面 people；显式传入则原样用（如「天」）。 */
  const suffix = suffixProp ?? t("ie.headcountSuffix");
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.fill")}
      width={196}
      height={124}
      disabled={disabled}
      disabledHint={disabledHint}
      display={display}
      render={(close) => (
        <NumberEditor
          value={value}
          suffix={suffix}
          onSave={(next) => {
            onSave(next);
            close();
          }}
          onCancel={close}
        />
      )}
    />
  );
}

function NumberEditor({
  value,
  suffix,
  onSave,
  onCancel,
}: {
  value: number;
  suffix: string;
  onSave: (value: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(value > 0 ? String(value) : "");
  const trimmed = text.trim();
  const parsed = trimmed === "" ? 0 : Number(trimmed);
  const invalid = trimmed !== "" && (Number.isNaN(parsed) || parsed < 0);

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={text}
          aria-label={suffix === t("ie.headcountSuffix") ? t("ie.headcountAria") : t("ie.valueAria")}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !invalid) {
              onSave(trimmed === "" ? 0 : Math.floor(parsed));
            }
            if (event.key === "Escape") {
              onCancel();
            }
          }}
          className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
        />
        <span className="shrink-0 text-xs text-zinc-400">{suffix}</span>
      </div>
      {invalid ? <p className="mt-1.5 text-[11px] text-rose-500">{t("ie.intError")}</p> : null}
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={invalid}
          onClick={() => {
            onSave(trimmed === "" ? 0 : Math.floor(parsed));
          }}
          className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

/** 行内文本单元格（项目进展描述；Push 208 起「问题描述 / 解决方案或建议 / 当日完成工作 / 明日计划」共用）。
 *  「文字修改需要点击保存」（Push 208 业务口径）：浮层 = 多行框（自动聚焦）+ 取消 / 保存 —— **点「保存」才落值**
 *  （落值即收浮层）；取消 / Esc / 点浮层外收起 = 原值不动（Push 208 同批把「保存不收层」改成「保存即收层」）。 */
export function InlineTextCell({
  value,
  display,
  ariaLabel,
  onSave,
  placeholder,
  rows = 3,
  bare = false,
  triggerClassName,
  disabled = false,
  disabledHint,
}: {
  value: string;
  display: ReactNode;
  ariaLabel: string;
  onSave: (value: string) => void;
  /** 空值时的框内占位文案（缺省 = 项目总览「项目进展描述」原口径）。 */
  placeholder?: string;
  /** 多行框的初始高度下限（行数）。 */
  rows?: number;
  /** 裸框模式（Push 134）：不套「液态玻璃」白底小框，底色 / 字色 / 内边距由 triggerClassName 给。 */
  bare?: boolean;
  /** 触发器附加类名。 */
  triggerClassName?: string;
  /** 锁定入口（Push 264 · P1-1 定档锁定）：透传 InlineCell —— 定档任务的行内入口不弹编辑浮层，点击改弹站点同款顶部 Toast。 */
  disabled?: boolean;
  /** 锁定说明文案（定档口径同 409 TASK_FINALIZED 提示文案；悬停 title 与点击 Toast 共用）。 */
  disabledHint?: string;
}) {
  const t = useT();
  return (
    <InlineCell
      ariaLabel={ariaLabel}
      title={t("ie.fill")}
      width={268}
      height={186}
      disabled={disabled}
      disabledHint={disabledHint}
      bare={bare}
      triggerClassName={triggerClassName}
      display={display}
      render={(close) => (
        <TextEditor
          value={value}
          ariaLabel={ariaLabel}
          placeholder={placeholder ?? t("ie.notePlaceholder")}
          rows={rows}
          onSave={(next) => {
            onSave(next);
            close();
          }}
          onCancel={close}
        />
      )}
    />
  );
}

function TextEditor({
  value,
  ariaLabel,
  placeholder,
  rows,
  onSave,
  onCancel,
}: {
  value: string;
  ariaLabel: string;
  placeholder: string;
  rows: number;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  /** 机翻译文预览（Push 301 追订 · 业务口径：编辑浮层也要能看到译文）：英文界面 + 译文就绪时，
   *  在编辑框上方出一条只读译文行 —— 编辑的仍是原文、保存回写原文；译文只作阅读预览，不参与落值。 */
  const translation = useMachineText(value);

  return (
    <div className="p-3">
      {translation !== null && translation !== value ? (
        <p className="mb-2 max-h-24 overflow-y-auto rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs leading-5 text-zinc-600">
          <span className="mr-1.5 text-[11px] text-zinc-400">{t("ie.mtPreview")}</span>
          {translation}
        </p>
      ) : null}
      <textarea
        autoFocus
        rows={rows}
        value={text}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        className="w-full resize-none rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm leading-6 text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10"
      />
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          data-inline-cancel="true"
          onClick={onCancel}
          className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-inline-save="true"
          onClick={() => {
            onSave(text.trim());
          }}
          className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-800"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
