import type { PointerEvent as ReactPointerEvent } from "react";
import { formatPlanRelative, planColorOf, planFontOf, type PlanNote } from "../myPlan";
import { useLocale, useT } from "../i18n";

/**
 * 便签卡（便签墙单张 · Push 266 照 MiniMemo 参考页照搬）：
 * 整卡是一个按钮 —— 点击进编辑弹窗；键盘 Tab 聚焦、Enter / Space 同款，悬停轻微抬起 + 右上角浮现铅笔。
 * 照搬口径：min-height 198 / 内衬 18 / 圆角 18；卡片 = 调色板底色 + 描边 + 字色（7 色 hex，
 * 编辑弹窗同源）；标题 16.5px（单行截断）+ 内容 13px（5 行截断、保留换行）+ 底行 = 分类签（swatch 底）+ 相对时间。
 * Push 268：完成态右上角常显绿勾（替换悬停铅笔）—— 「已完成」视图里的卡片一眼可辨；未完成卡片照旧悬停浮现铅笔。
 * Push 269：卡片可拖拽（指针事件）—— 按住拖动超 6px 进入拖拽态（拖进「完成」区即完成、已完成的拖回「全部便签」即恢复）；
 * 没拖出阈值仍是点击打开编辑弹窗（便签墙按时间戳挡掉拖完松手那一下 click）。
 * Push 270：拖动中卡片本体隐去（原位保留槽位高度，由便签墙叠虚线占位框）—— 便签「脱离原来的位置」，只以悬浮小卡示人。
 */
export function PlanNoteCard({
  note,
  onOpen,
  onPointerDown,
  lifted = false,
}: {
  note: PlanNote;
  onOpen: () => void;
  /** 拖拽起点（Push 269）：按下交给便签墙统一处理（超阈值才算拖；松手落点决定完成 / 恢复）。 */
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** Push 270：正在被拖走 —— 卡片本体隐去（保留槽位尺寸，便签墙在原位叠虚线占位框）。 */
  lifted?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const color = planColorOf(note.colorId);
  const font = planFontOf(note.fontId);
  return (
    <button
      type="button"
      data-plan-note={note.id}
      onClick={onOpen}
      onPointerDown={onPointerDown}
      title={t("plan.cardOpen")}
      aria-label={t("plan.cardEditAria", { name: note.title === "" ? t("plan.untitled") : note.title })}
      style={{ backgroundColor: color.bg, borderColor: color.border, color: color.ink }}
      className={
        "group relative flex min-h-[198px] w-full cursor-grab select-none flex-col active:cursor-grabbing justify-between gap-3.5 rounded-[18px] border p-[18px] text-left shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition duration-[180ms] ease-out hover:-translate-y-[3px] hover:shadow-[0_18px_36px_-20px_rgba(28,25,23,0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1c1917]/25 " +
        (lifted ? "invisible " : "") +
        font.className
      }
    >
      <span className="min-h-0 overflow-hidden">
        <span data-plan-note-title="" className="mb-2 line-clamp-1 text-[16.5px] font-semibold leading-[1.3]">
          {note.title === "" ? t("plan.untitled") : note.title}
        </span>
        <span className="line-clamp-5 whitespace-pre-wrap text-[13px] leading-[1.7] opacity-[0.85]">
          {note.content === "" ? t("plan.noContent") : note.content}
        </span>
      </span>
      <span className="flex items-center justify-between gap-2 text-[10.5px] uppercase tracking-[0.08em]">
        <span
          data-plan-note-category=""
          style={{ backgroundColor: color.swatch }}
          className="max-w-[60%] truncate rounded-full px-2.5 py-1 font-semibold"
        >
          {note.category}
        </span>
        <span className="shrink-0 font-medium opacity-[0.55]">{formatPlanRelative(note.updatedAt, locale)}</span>
      </span>
      {note.done ? (
        <span
          data-plan-note-done=""
          title={t("plan.done")}
          className="pointer-events-none absolute right-3 top-3 grid h-[26px] w-[26px] place-items-center rounded-full bg-emerald-600 text-white shadow-[0_8px_18px_-8px_rgba(5,150,105,0.8)]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M5 12.5 10 17.5 19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : (
        <span className="pointer-events-none absolute right-3 top-3 grid h-[26px] w-[26px] place-items-center rounded-full bg-white/70 backdrop-blur-[2px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
            <path
              d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </button>
  );
}
