import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useT } from "../i18n";

/**
 * 表格底部滑块（Push 221）：项目总览 / 干系人宽表共用的横向滚动条 —— 吸附在视口底部（外层 `#table-scrollbar-bar`），
 * 拖块即拖横向滚动，聚焦后可用方向键步进。
 * 2026-10-10 修「浮动滑块盖住末行 / 遮挡行内按钮点击」（业务反馈）：整条不再铺白底、不拦截指针（外层容器
 * pointer-events-none），轨道只作视觉（本组件根节点 pointer-events-none）—— 吸附在视口底时不再遮字、点击穿透到
 * 行内按钮；可交互面只剩滑块本体（pointer-events-auto，拖拽 / 悬停 / 键盘）。为免遮挡行内点击，轨道点击跳转
 * 随之**下架**；拖拽 / 键盘方向键 / 触控板（含 Shift+滚轮）横向滚动不受影响。
 */
type TableScrollbarProps = {
  scrollRef: RefObject<HTMLDivElement | null>;
  onOverflowChange?: (overflowing: boolean) => void;
  /** 受控表格的滚动容器 id（aria-controls；缺省 = 项目总览的任务表）。 */
  controlsId?: string;
};

type Metrics = {
  visible: boolean;
  thumbWidth: number;
  offset: number;
  progress: number;
};

const HIDDEN: Metrics = { visible: false, thumbWidth: 0, offset: 0, progress: 0 };

const MIN_THUMB_WIDTH = 56;
const KEYBOARD_STEP = 160;

export function TableScrollbar({ scrollRef, onOverflowChange, controlsId = "task-board-scroll" }: TableScrollbarProps) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(HIDDEN);
  const overflowHandlerRef = useRef(onOverflowChange);
  const reportedRef = useRef(false);

  useEffect(() => {
    overflowHandlerRef.current = onOverflowChange;
  }, [onOverflowChange]);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    maxScroll: number;
    maxOffset: number;
  } | null>(null);

  const sync = useCallback(() => {
    const report = (overflowing: boolean) => {
      if (reportedRef.current === overflowing) {
        return;
      }
      reportedRef.current = overflowing;
      overflowHandlerRef.current?.(overflowing);
    };
    const element = scrollRef.current;
    const track = trackRef.current;
    if (element === null || track === null) {
      report(false);
      setMetrics((previous) => (previous.visible ? HIDDEN : previous));
      return;
    }
    const trackWidth = track.clientWidth;
    const maxScroll = element.scrollWidth - element.clientWidth;
    if (trackWidth === 0 || maxScroll <= 1) {
      report(false);
      setMetrics((previous) => (previous.visible ? HIDDEN : previous));
      return;
    }
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(MIN_THUMB_WIDTH, Math.round((element.clientWidth / element.scrollWidth) * trackWidth)),
    );
    const maxOffset = Math.max(0, trackWidth - thumbWidth);
    const offset = Math.round((element.scrollLeft / maxScroll) * maxOffset);
    const progress = Math.round((element.scrollLeft / maxScroll) * 100);
    report(true);
    setMetrics((previous) =>
      previous.visible && previous.thumbWidth === thumbWidth && previous.offset === offset && previous.progress === progress
        ? previous
        : { visible: true, thumbWidth, offset, progress },
    );
  }, [scrollRef]);

  useEffect(() => {
    let attached: HTMLDivElement | null = null;
    let observer: ResizeObserver | null = null;
    const attach = () => {
      const element = scrollRef.current;
      if (element !== attached) {
        if (attached !== null) {
          attached.removeEventListener("scroll", sync);
        }
        observer?.disconnect();
        observer = null;
        attached = element;
        if (element !== null) {
          element.addEventListener("scroll", sync, { passive: true });
          observer = new ResizeObserver(sync);
          observer.observe(element);
        }
      }
      sync();
    };
    attach();
    const timer = window.setInterval(attach, 300);
    window.addEventListener("resize", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", sync);
      if (attached !== null) {
        attached.removeEventListener("scroll", sync);
      }
      observer?.disconnect();
    };
  }, [scrollRef, sync]);

  const scrollTo = (target: number) => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, target));
  };

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    const track = trackRef.current;
    if (element === null || track === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
      maxScroll: element.scrollWidth - element.clientWidth,
      maxOffset: Math.max(1, track.clientWidth - metrics.thumbWidth),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = scrollRef.current;
    if (drag === null || element === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const delta = ((event.clientX - drag.startX) / drag.maxOffset) * drag.maxScroll;
    element.scrollLeft = drag.startScrollLeft + delta;
  };

  const handleThumbPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: { key: string; preventDefault: () => void }) => {
    const element = scrollRef.current;
    if (element === null) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scrollTo(element.scrollLeft - KEYBOARD_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      scrollTo(element.scrollLeft + KEYBOARD_STEP);
    }
  };

  return (
    <div ref={trackRef} className="pointer-events-none relative h-6 w-full select-none">
      <div
        className={
          "absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-colors " +
          (metrics.visible ? "bg-zinc-200/80" : "bg-transparent")
        }
      />
      {metrics.visible ? (
        <div
          role="scrollbar"
          aria-orientation="horizontal"
          aria-controls={controlsId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={metrics.progress}
          tabIndex={0}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerUp}
          onPointerCancel={handleThumbPointerUp}
          onKeyDown={handleKeyDown}
          title={t("ts.dragTitle")}
          style={{ width: metrics.thumbWidth, left: metrics.offset }}
          className="pointer-events-auto absolute top-1/2 h-3 -translate-y-1/2 cursor-grab rounded-full bg-zinc-400 transition-colors hover:bg-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 active:cursor-grabbing active:bg-zinc-600"
        />
      ) : null}
    </div>
  );
}
