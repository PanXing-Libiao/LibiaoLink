import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dateOnlyText, type ProjectTask } from "../data/tasks";
import type { Member } from "../data/members";
import { fullDateText, useLocale, useT } from "../i18n";
import { ChangeDetailModal, splitChangeReason } from "./ChangeDetailModal";
import { usePopover } from "./usePopover";

const CARD_WIDTH = 284;
const CARD_GAP = 12;

/**
 * 任务表「变更关联」气泡浮层（2026-11-10）：
 * - 触发按钮固定在任务行内；点击后在按钮正下方弹出横向卡片轨，顶部小箭头对准触发按钮；
 * - 卡片只承担“选一条变更”的轻量浏览，完整字段仍进入 ChangeDetailModal；
 * - 条目较多时在浮层内横向滚动，页面纵向高度不变；
 * - 「查看全部变更」由项目总览工具区打开项目级变更记录弹窗。
 */
export function TaskChangesPopover({ task, members, onOpenAllChanges, onOpenLinkedTask }: {
  task: ProjectTask;
  members: readonly Member[];
  onOpenAllChanges?: (() => void) | null;
  /** 详情弹窗「关联」回写任务：任务表传入选中当前行（打开任务抽屉）。 */
  onOpenLinkedTask?: (() => void) | null;
}) {
  const locale = useLocale();
  const t = useT();
  const changes = [...task.changes].sort((left, right) => Date.parse(right.appliedAt) - Date.parse(left.appliedAt));
  const viewportMax = typeof window === "undefined" ? 900 : Math.max(300, Math.min(900, window.innerWidth - 16));
  const popoverWidth = Math.min(viewportMax, Math.max(360, 48 + changes.length * CARD_WIDTH + Math.max(0, changes.length - 1) * CARD_GAP));
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(popoverWidth, 272, "below", false, "center");
  const railRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ atStart: true, atEnd: true });
  const [detailChangeId, setDetailChangeId] = useState<string | null>(null);

  const updateScrollState = () => {
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    setScrollState({
      atStart: rail.scrollLeft <= 1,
      atEnd: rail.scrollLeft >= max - 1,
    });
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    const frame = window.requestAnimationFrame(updateScrollState);
    rail.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      rail.removeEventListener("scroll", updateScrollState);
    };
  }, [open, changes.length, popoverWidth]);

  const scrollRail = (direction: -1 | 1) => {
    railRef.current?.scrollBy({ left: direction * (CARD_WIDTH + CARD_GAP), behavior: "smooth" });
  };

  const openDetail = (changeId: string) => {
    setOpen(false);
    setDetailChangeId(changeId);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-change-link-open="true"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("drawer.change.linkTitle")}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((previous) => !previous);
        }}
        className="group flex items-center gap-1 rounded px-0.5 py-0.5 transition hover:bg-amber-50"
      >
        <span className="inline-block whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition group-hover:bg-amber-200">{t("board.change.chip")}</span>
        {changes.length > 1 ? <span className="text-[10px] text-zinc-400">+{changes.length - 1}</span> : null}
      </button>
      {open && position !== null ? createPortal(
        <div
          ref={popoverRef}
          data-task-changes-popover="true"
          role="dialog"
          aria-label={t("changePopover.aria")}
          onClick={(event) => { event.stopPropagation(); }}
          style={{ top: position.top, left: position.left, width: position.width }}
          className="fixed z-[68] rounded-2xl border border-zinc-200 bg-white shadow-[0_22px_60px_-18px_rgba(15,23,42,0.35),0_8px_24px_-12px_rgba(15,23,42,0.22)]"
        >
          {position.arrowLeft === null ? null : (
            <span
              aria-hidden="true"
              style={{ left: position.arrowLeft - 6 }}
              className={
                "pointer-events-none absolute h-3 w-3 rotate-45 bg-white " +
                (position.side === "above" ? "-bottom-1.5 border-b border-r border-zinc-200" : "-top-1.5 border-l border-t border-zinc-200")
              }
            />
          )}
          <div className="flex items-start gap-3 px-3 pb-2 pt-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400">{t("changePopover.title")}</p>
              <p className="mt-0.5 truncate text-sm font-semibold text-zinc-800" title={task.title}>{task.title}</p>
            </div>
            <span className="mt-0.5 shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-700">
              {t("project.changeRecords.taskCount", { n: changes.length })}
            </span>
            {changes.length > 1 ? (
              <span className="mt-0.5 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={t("changePopover.prev")}
                  disabled={scrollState.atStart}
                  onClick={() => { scrollRail(-1); }}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-800 disabled:cursor-default disabled:opacity-35"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true" className="h-3 w-3"><path strokeLinecap="round" strokeLinejoin="round" d="m12 5-5 5 5 5" /></svg>
                </button>
                <button
                  type="button"
                  aria-label={t("changePopover.next")}
                  disabled={scrollState.atEnd}
                  onClick={() => { scrollRail(1); }}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-800 disabled:cursor-default disabled:opacity-35"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true" className="h-3 w-3"><path strokeLinecap="round" strokeLinejoin="round" d="m8 5 5 5-5 5" /></svg>
                </button>
              </span>
            ) : null}
          </div>
          <div ref={railRef} className="scrollbar-hidden flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-3 pb-3 pt-1">
            {changes.map((change) => {
              const split = splitChangeReason(change.reason);
              const content = split.content !== "" ? split.content : split.cause !== "" ? split.cause : t("changePopover.noReason");
              return (
                <button
                  key={change.id}
                  type="button"
                  data-change-popover-card="true"
                  onClick={() => { openDetail(change.id); }}
                  className="group flex h-[176px] w-[284px] shrink-0 snap-start flex-col rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 text-left transition hover:border-amber-300 hover:bg-amber-50/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                  <span className="inline-flex w-fit rounded bg-white px-2 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500 ring-1 ring-zinc-200">
                    {fullDateText(locale, dateOnlyText(change.appliedAt))}
                  </span>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-700">{content}</p>
                  {split.cause === "" ? null : (
                    <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-zinc-400">{t("changePopover.reason", { text: split.cause })}</p>
                  )}
                  <span className="mt-auto inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 transition group-hover:text-amber-700">
                    {t("changePopover.detail")}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-3 w-3"><path strokeLinecap="round" strokeLinejoin="round" d="m7 4 6 6-6 6" /></svg>
                  </span>
                </button>
              );
            })}
          </div>
          {onOpenAllChanges === undefined || onOpenAllChanges === null ? null : (
            <div className="flex items-center justify-between border-t border-zinc-100 px-3 py-2">
              <span className="text-[11px] text-zinc-400">{t("changePopover.hint")}</span>
              <button
                type="button"
                data-change-popover-all="true"
                onClick={() => {
                  setOpen(false);
                  onOpenAllChanges();
                }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-50"
              >
                {t("changePopover.viewAll")}
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-3 w-3"><path strokeLinecap="round" strokeLinejoin="round" d="m7 4 6 6-6 6" /></svg>
              </button>
            </div>
          )}
        </div>,
        document.body,
      ) : null}
      {detailChangeId === null ? null : (
        <ChangeDetailModal
          changeId={detailChangeId}
          linkedTaskTitle={task.title}
          members={members}
          deliverableTypes={task.deliverableTypes}
          onOpenLinkedTask={onOpenLinkedTask === undefined || onOpenLinkedTask === null ? undefined : () => { setDetailChangeId(null); onOpenLinkedTask(); }}
          onClose={() => { setDetailChangeId(null); }}
        />
      )}
    </>
  );
}
