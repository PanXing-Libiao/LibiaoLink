import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { monthYearText, useLocale, useT } from "../i18n";

export type DateRange = {
  from: string;
  to: string;
};

type DateRangePickerProps = {
  value: DateRange | null;
  onChange: (value: DateRange | null) => void;
  hintDate?: string;
  /** 未选日期时触发器上的文案（默认「全部时间」，分类筛选用；任务编辑表单传业务文案）。 */
  placeholder?: string;
  /** 触发器的无障碍名称（默认「选择日期范围」）。 */
  ariaLabel?: string;
  /** 触发器附加类名（分类筛选侧栏传「液态玻璃」材质；不传保持默认白底描边）。 */
  triggerClassName?: string;
  /**
   * 选择模式（Push 128）：`range` = 选一段（默认，筛选 / 任务开始预计完成用）；
   * `single` = 单选一天（日报「时间」这类单日期字段用）——点哪天就只选哪天，触发器只显示一个日期。
   */
  mode?: "range" | "single";
};

const WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS_EN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const pad = (value: number) => String(value).padStart(2, "0");

const toKey = (date: Date) =>
  String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());

const toDate = (key: string) => {
  const parts = key.split("-").map((part) => Number(part));
  return new Date(parts[0] ?? 2026, (parts[1] ?? 1) - 1, parts[2] ?? 1);
};

const formatKey = (key: string) => key.replace(/-/g, "/");

export function DateRangePicker({ value, onChange, hintDate, placeholder, ariaLabel, triggerClassName, mode = "range" }: DateRangePickerProps) {
  const locale = useLocale();
  const t = useT();
  const placeholderText = placeholder ?? t("picker.allTime");
  const ariaText = ariaLabel ?? t("picker.aria");
  const weekdays = locale === "en" ? WEEKDAYS_EN : WEEKDAYS_ZH;
  const single = mode === "single";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | null>(value);
  const [view, setView] = useState(() => {
    const fallback = hintDate === undefined || hintDate === "" ? new Date() : toDate(hintDate);
    const base = value === null ? fallback : toDate(value.from);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(value);
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (trigger === null) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const width = 264;
      const height = 348;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      const below = rect.bottom + 8;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
      setPosition({ top, left });
    };
    updatePosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideTrigger = triggerRef.current !== null && triggerRef.current.contains(target);
      const insidePopover = popoverRef.current !== null && popoverRef.current.contains(target);
      if (!insideTrigger && !insidePopover) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, value]);

  const cells = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(year, month, 1 - offset + index);
      return { key: toKey(date), day: date.getDate(), inMonth: date.getMonth() === month };
    });
  }, [view]);

  const label = value === null ? placeholderText : single ? formatKey(value.from) : formatKey(value.from) + " – " + formatKey(value.to);

  const pick = (key: string) => {
    setDraft((previous) => {
      if (single) {
        return { from: key, to: key };
      }
      if (previous === null || previous.from !== previous.to) {
        return { from: key, to: key };
      }
      return key < previous.from ? { from: key, to: previous.from } : { from: previous.from, to: key };
    });
  };

  const shiftMonth = (step: number) => {
    setView(new Date(view.getFullYear(), view.getMonth() + step, 1));
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={ariaText}
        onClick={() => {
          setOpen((previous) => !previous);
        }}
        className={
          "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition " +
          (triggerClassName === undefined ? "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50" : triggerClassName)
        }
      >
        <span className={"truncate " + (value === null ? "text-zinc-400" : "font-medium text-zinc-700")}>{label}</span>
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={popoverRef}
              data-focus-scope="true"
              className="fixed z-50 w-[264px] rounded-xl border border-zinc-200 bg-white p-3 shadow-[0_16px_40px_rgba(0,0,0,0.18)]"
              style={{ top: position.top, left: position.left }}
            >
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label={t("picker.prevMonth")}
              onClick={() => {
                shiftMonth(-1);
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
              aria-label={t("picker.nextMonth")}
              onClick={() => {
                shiftMonth(1);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="mt-2 grid grid-cols-7 gap-y-1 text-center text-[11px] text-zinc-400">
            {weekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="mt-1 grid grid-cols-7 gap-y-1">
            {cells.map((cell) => {
              const isEdge = draft !== null && (cell.key === draft.from || cell.key === draft.to);
              const inRange = draft !== null && cell.key > draft.from && cell.key < draft.to;
              const base = "flex h-8 w-full items-center justify-center rounded-lg text-xs transition ";
              const tone = isEdge
                ? "bg-zinc-900 font-semibold text-white "
                : inRange
                  ? "bg-zinc-100 text-zinc-700 "
                  : cell.inMonth
                    ? "text-zinc-600 hover:bg-zinc-100 "
                    : "text-zinc-300 ";
              return (
                <button key={cell.key} type="button" disabled={!cell.inMonth} onClick={() => { pick(cell.key); }} className={base + tone}>
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2">
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                onChange(null);
                setOpen(false);
              }}
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-zinc-100"
            >
              {t("picker.clear")}
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-800"
            >
              {t("picker.ok")}
            </button>
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
