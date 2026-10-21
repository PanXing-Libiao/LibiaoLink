import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../i18n";

/** 图片预览缩放层（Push 273 · 业务口径 2026-10-10「图片预览要有缩放功能」）：
 *  全站图片大图预览三处入口（FilePreviewOverlay 图片分支 / 项目页「日报及问题」附图 / 工作台问题附图）
 *  共用这一枚组件 —— 滚轮以光标为锚点缩放、＋ / − 按钮 1.25 步进、百分比钮一键回默认（适应窗口）、
 *  双击在 100% / 200% 之间切换、放大后按住拖动平移；Esc / 点遮罩关闭仍由各浮层负责。
 *  - 倍率口径：100% = 各浮层原来的自适应图幅（max-h 80vh / max-w min(90vw,…)），范围 25% ~ 800%；
 *    倍率只走 transform（不重排）；因此原「点图片关浮层」收紧为「点遮罩关浮层」—— 图片上的点击留给
 *    拖动 / 双击（否则刚点一下就关了，缩放没法用）；
 *  - 滚轮挂 **window 原生监听（passive: false）**：React 的 onWheel 在根节点上是 passive 的、
 *    preventDefault 无效（浮层里滚轮会穿透去滚背景页）；浮层是模态，滚轮一律只作用于图片；
 *  - 拖动走 Pointer Capture（指针移出图片也不断线），偏移量夹在「图片不出窗口」范围（zoom ≤ 1 只能居中）。
 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
/** 双击放大档位：100% 附近双击 = 放大到 200%；已偏离 100%（放大或缩小过）双击 = 回 100%。 */
const DOUBLE_CLICK_ZOOM = 2;

type ZoomView = { zoom: number; x: number; y: number };

/** 偏移量夹取：允许拖到图片边缘贴住「自适应窗口」的边界（拖不丢图）；zoom ≤ 1 时只能居中。 */
function clampView(view: ZoomView, image: HTMLImageElement): ZoomView {
  const width = image.offsetWidth;
  const height = image.offsetHeight;
  const maxX = Math.max(0, (width * view.zoom - width) / 2);
  const maxY = Math.max(0, (height * view.zoom - height) / 2);
  return {
    zoom: view.zoom,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

export function ImageZoomViewer({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const [view, setView] = useState<ZoomView>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef<ZoomView>({ zoom: 1, x: 0, y: 0 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const commit = useCallback((next: ZoomView): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** 换图重置（同一实例换 src 时回 100% / 居中）。 */
  useEffect(() => {
    commit({ zoom: 1, x: 0, y: 0 });
  }, [src, commit]);

  /** 缩放到目标倍率：有锚点（滚轮光标 / 双击点）→ 锚点下的像素不动；无锚点 → 绕图心缩放。 */
  const zoomTo = useCallback(
    (target: number, anchor?: { x: number; y: number }): void => {
      const image = imageRef.current;
      if (image === null) {
        return;
      }
      const current = viewRef.current;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
      if (zoom === current.zoom) {
        return;
      }
      if (anchor === undefined) {
        const ratio = zoom / current.zoom;
        commit(clampView({ zoom, x: current.x * ratio, y: current.y * ratio }, image));
        return;
      }
      const rect = image.getBoundingClientRect();
      // 布局中心 = 实测中心 − 平移量（transform 以中心为原点：scale 不移动中心，translate 直接加在实测中心上）
      const centerX = rect.left + rect.width / 2 - current.x;
      const centerY = rect.top + rect.height / 2 - current.y;
      const ratio = zoom / current.zoom;
      commit(
        clampView(
          {
            zoom,
            x: anchor.x - centerX - ratio * (anchor.x - centerX - current.x),
            y: anchor.y - centerY - ratio * (anchor.y - centerY - current.y),
          },
          image,
        ),
      );
    },
    [commit],
  );

  const reset = useCallback((): void => {
    commit({ zoom: 1, x: 0, y: 0 });
  }, [commit]);

  /** 滚轮：window 原生监听（passive: false）—— 光标在图上以光标为锚点，否则绕图心；一律 preventDefault。 */
  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const image = imageRef.current;
      if (image === null) {
        return;
      }
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
      const rect = image.getBoundingClientRect();
      const overImage =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      zoomTo(viewRef.current.zoom * Math.exp(-delta * 0.0015), overImage ? { x: event.clientX, y: event.clientY } : undefined);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
    };
  }, [zoomTo]);

  /** 键盘：+ / − / 0（同按钮）；带修饰键（浏览器 Ctrl+± 缩放）与输入框内一律不接管。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const node = event.target;
      if (node instanceof HTMLElement && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable)) {
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomTo(viewRef.current.zoom * ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomTo(viewRef.current.zoom / ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [zoomTo, reset]);

  /** 拖动平移：只放大后（zoom > 1）起手；Pointer Capture 保证指针移出图片也不断线。 */
  const startDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (event.button !== 0 || viewRef.current.zoom <= 1) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: viewRef.current.x,
      baseY: viewRef.current.y,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    const image = imageRef.current;
    if (drag === null || image === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const current = viewRef.current;
    commit(
      clampView(
        {
          zoom: current.zoom,
          x: drag.baseX + (event.clientX - drag.startX),
          y: drag.baseY + (event.clientY - drag.startY),
        },
        image,
      ),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
  };

  /** 双击：100% 附近 → 200%（以双击点为锚点）；已缩放（> 或 < 100%）→ 回 100%。 */
  const handleDoubleClick = (event: ReactMouseEvent<HTMLImageElement>): void => {
    if (Math.abs(viewRef.current.zoom - 1) > 0.001) {
      reset();
      return;
    }
    zoomTo(DOUBLE_CLICK_ZOOM, { x: event.clientX, y: event.clientY });
  };

  const percent = Math.round(view.zoom * 100);
  const cursorClass = dragging ? "cursor-grabbing" : view.zoom > 1 ? "cursor-grab" : "cursor-zoom-in";
  return (
    <div
      data-image-zoom-viewer="true"
      data-image-zoom={String(view.zoom)}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className="flex max-h-full max-w-full flex-col items-center"
    >
      <img
        ref={imageRef}
        data-image-zoom-image="true"
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => {
          const image = imageRef.current;
          if (image !== null) {
            commit(clampView(viewRef.current, image));
          }
        }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={handleDoubleClick}
        style={{
          transform: "translate(" + String(view.x) + "px, " + String(view.y) + "px) scale(" + String(view.zoom) + ")",
          transformOrigin: "center center",
          touchAction: "none",
        }}
        className={
          "max-h-[min(80vh,calc(100dvh-128px))] max-w-[min(90vw,calc(100vw-3rem))] select-none rounded-xl bg-white p-1 shadow-2xl " +
          cursorClass
        }
      />
      <div data-image-zoom-bar="true" role="toolbar" aria-label={t("izv.aria")} className="relative z-10 mt-2 flex items-center gap-1.5 rounded-md bg-zinc-900/35 px-1.5 py-1 text-xs text-white/80 backdrop-blur-sm">
        <button
          type="button"
          data-image-zoom-out="true"
          title={t("izv.out")}
          aria-label={t("izv.out")}
          onClick={() => {
            zoomTo(viewRef.current.zoom / ZOOM_STEP);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/30 text-[13px] leading-none text-white/90 transition hover:bg-white/10"
        >
          −
        </button>
        <button
          type="button"
          data-image-zoom-reset="true"
          data-image-zoom-percent="true"
          title={t("izv.resetTitle")}
          aria-label={t("izv.resetAria", { p: percent })}
          onClick={reset}
          className="flex h-6 min-w-[3.25rem] items-center justify-center rounded-md border border-white/30 px-1.5 text-[11px] tabular-nums text-white/90 transition hover:bg-white/10"
        >
          {String(percent) + "%"}
        </button>
        <button
          type="button"
          data-image-zoom-in="true"
          title={t("izv.in")}
          aria-label={t("izv.in")}
          onClick={() => {
            zoomTo(viewRef.current.zoom * ZOOM_STEP);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/30 text-[13px] leading-none text-white/90 transition hover:bg-white/10"
        >
          ＋
        </button>
        <span data-image-zoom-hint="true" className="ml-1 hidden text-[11px] text-white/50 sm:inline">
          {t("izv.hint")}
        </span>
      </div>
    </div>
  );
}
