import { useEffect, useRef, useState } from "react";

export type PopoverPosition = { top: number; left: number; width: number };

/**
 * 浮层优先落点（Push 167）：
 * - below（默认，全站既有口径）= 触发器的下 / 上，宽度至少与触发器等宽；
 * - belowOnly = 只向下展开，不因下方空间不足翻到上方（搜索下拉，2026-10-20 追订「我要下拉框」）。
 * - right = 触发器右侧、垂直对齐（宽屏放得下时用，如弹窗里的「项目地区 / 项目类型」「项目经理」——避免长列表压住表单其它字段），
 *   右侧放不下（窄屏 / 靠右面板）自动回落 below，不出现半截浮层。
 */
export type PopoverPlacement = "below" | "right";

/**
 * 触发器 + 浮层的定位 / 关闭口径（与分类筛选的日期选择器同一套实现）：
 * 浮层 fixed 定位、跟随触发器（窗口缩放 / 滚动时重算）；点触发器与浮层之外、按 Esc 关闭。
 * 浮层内容由调用方用 `createPortal` 挂到 body —— 避免被弹窗的毛玻璃 / overflow 影响定位与裁剪。
 */
export function usePopover(width: number, height: number, placement: PopoverPlacement = "below", belowOnly = false) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (trigger === null) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const popoverWidth = Math.max(width, rect.width);
      const gap = 6;
      if (placement === "right") {
        // 在弹窗（role="dialog"）里靠右弹出时，从弹窗卡片边缘让开：只按触发器右缘会压住卡片圆角与右侧留白，看着像粘在表单上
        const host = trigger.closest('[role="dialog"]') ?? trigger;
        const rightLeft = Math.max(rect.right, host.getBoundingClientRect().right) + gap;
        if (rightLeft + width <= window.innerWidth - 8) {
          const rightTop = Math.min(Math.max(8, rect.top - gap), Math.max(8, window.innerHeight - height - 8));
          setPosition({ top: rightTop, left: rightLeft, width });
          return;
        }
      }
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - popoverWidth - 8));
      const below = rect.bottom + gap;
      const top = belowOnly || below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - gap);
      setPosition({ top, left, width: popoverWidth });
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
  }, [open, width, height, placement]);

  return { open, setOpen, position, triggerRef, popoverRef };
}
