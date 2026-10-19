import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 全站悬停提示（2026-10-19 · 业务口径「当前系统的提示如图二 我要改成如图1的样式 但是不用那个小点指向的效果」）：
 * 浏览器原生 title 灰框无法定制圆角 / 阴影 / 字体，这里统一接管带 title 的元素 —— 悬停短暂延迟后出白卡，
 * 贴合锚点居中、贴边夹紧、空间不足自动翻到下方；卡片与锚点之间无箭头 / 指向点。
 * 原生 title 在指针进入时临时移除，离开 / 滚动 / 点按 / Esc 时恢复，既阻断原生灰框，也保留 DOM 兜底文案。
 * 浮层 portal 到 body + position: fixed，因此表格滚动区与其它 overflow 容器不会裁掉提示。
 */

type TooltipRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type TooltipState = {
  readonly text: string;
  readonly rect: TooltipRect;
};

type TooltipLayout = {
  readonly left: number;
  readonly top: number;
};

type ActiveTitle = {
  readonly element: HTMLElement;
  readonly original: string;
};

const SHOW_DELAY_MS = 180;
const VIEWPORT_EDGE = 12;
const ANCHOR_GAP = 10;

export function SystemTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [layout, setLayout] = useState<TooltipLayout | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveTitle | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const restoreActiveTitle = useCallback(() => {
    const active = activeRef.current;
    if (active !== null) {
      if (!active.element.hasAttribute("title")) {
        active.element.setAttribute("title", active.original);
      }
      activeRef.current = null;
    }
  }, []);

  const dismissTooltip = useCallback(() => {
    clearTimer();
    setTip(null);
    setLayout(null);
  }, [clearTimer]);

  const release = useCallback(() => {
    clearTimer();
    restoreActiveTitle();
    setTip(null);
    setLayout(null);
  }, [clearTimer, restoreActiveTitle]);

  const schedule = useCallback((element: HTMLElement, text: string) => {
    release();
    activeRef.current = { element, original: text };
    element.removeAttribute("title");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!element.isConnected) {
        release();
        return;
      }
      const rect = element.getBoundingClientRect();
      setLayout(null);
      setTip({
        text,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      });
    }, SHOW_DELAY_MS);
  }, [release]);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const active = activeRef.current;
      if (active !== null && active.element.contains(target)) {
        return;
      }
      const element = target.closest("[title]");
      if (!(element instanceof HTMLElement)) {
        return;
      }
      const text = (element.getAttribute("title") ?? "").trim();
      if (text === "") {
        return;
      }
      schedule(element, text);
    };

    const onPointerOut = (event: PointerEvent): void => {
      const active = activeRef.current;
      if (active === null) {
        return;
      }
      const target = event.target;
      const related = event.relatedTarget;
      if (target instanceof Node && !active.element.contains(target)) {
        return;
      }
      if (related instanceof Node && active.element.contains(related)) {
        return;
      }
      release();
    };

    const onDismiss = (): void => {
      if (activeRef.current !== null) {
        dismissTooltip();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerdown", onDismiss, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);

    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerdown", onDismiss, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
      clearTimer();
      const active = activeRef.current;
      if (active !== null && !active.element.hasAttribute("title")) {
        active.element.setAttribute("title", active.original);
      }
      activeRef.current = null;
    };
  }, [clearTimer, dismissTooltip, release, schedule]);

  useLayoutEffect(() => {
    if (tip === null) {
      return;
    }
    const node = tooltipRef.current;
    if (node === null) {
      return;
    }
    const box = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = Math.min(
      Math.max(tip.rect.left + tip.rect.width / 2 - box.width / 2, VIEWPORT_EDGE),
      Math.max(VIEWPORT_EDGE, viewportWidth - box.width - VIEWPORT_EDGE),
    );
    const above = tip.rect.top - box.height - ANCHOR_GAP;
    const top = above >= VIEWPORT_EDGE
      ? above
      : Math.min(tip.rect.bottom + ANCHOR_GAP, Math.max(VIEWPORT_EDGE, viewportHeight - box.height - VIEWPORT_EDGE));
    setLayout({ left, top });
  }, [tip]);

  if (tip === null) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      data-system-tooltip="true"
      role="tooltip"
      className="ll-tooltip"
      style={{
        left: layout === null ? 0 : layout.left,
        top: layout === null ? 0 : layout.top,
        visibility: layout === null ? "hidden" : "visible",
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
