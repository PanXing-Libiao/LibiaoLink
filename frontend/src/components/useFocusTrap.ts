import { useEffect, useRef, type MutableRefObject } from "react";

/** 同屏叠放弹层的接管顺序（栈顶 = 最后打开的那个）：只有栈顶弹层处理 Tab，其余不抢焦点。
 *  存 ref 不存元素：抽屉（TaskDrawer）的容器挂 `key={task.id}`，换任务时元素会被重建 —— 存 ref 才能在重建后继续认门。 */
type TrapEntry = { readonly current: HTMLElement | null };
const trapStack: TrapEntry[] = [];

/** 当前真正接管的陷阱 = 栈里最后一个「容器还在页面上」的条目（叠放时让给最后打开的那个）。 */
function topTrapIs(self: TrapEntry): boolean {
  for (let index = trapStack.length - 1; index >= 0; index -= 1) {
    const container = trapStack[index].current;
    if (container !== null && container.isConnected) {
      return trapStack[index] === self;
    }
  }
  return false;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** 可见（排掉 display:none；sr-only 这类仍有盒子的保留，键盘够得着才算数）。 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (item) => item.getClientRects().length > 0,
  );
}

/** 弹层里再开的**浮层**（下拉 / 行内编辑 / 地区 / 文件，一律 portal 到 body、DOM 上不在弹层容器里）都带这些标记 ——
 *  Tab 循环把它们并进当前陷阱：焦点在浮层里不会被硬拽回弹层容器，浮层尾再 Tab 才回弹层。 */
const SCOPE_SELECTOR = [
  '[data-select-popover="true"]',
  '[data-inline-popover="true"]',
  '[data-region-popover="true"]',
  '[data-multi-popover="true"]',
  '[data-task-files-popover="true"]',
  '[data-focus-scope="true"]',
  '[role="listbox"]',
].join(", ");

/** 焦点当前所在的「层外浮层」（不是本弹层容器里的元素）；没有 = null。 */
function scopeOutside(node: Element | null, container: HTMLElement): HTMLElement | null {
  if (node === null) {
    return null;
  }
  const scope = node.closest(SCOPE_SELECTOR);
  if (!(scope instanceof HTMLElement) || !scope.isConnected) {
    return null;
  }
  // 浮层本身就画在弹层容器里（非 portal 的实现）→ 不算层外，按容器一体处理
  return container.contains(scope) ? null : scope;
}

/**
 * 弹层键盘焦点陷阱（Push 264 追订 · 业务口径 2026-10-10「弹窗无键盘焦点陷阱」）：
 * 全站 `role="dialog"` 弹层（模态弹窗 / 抽屉 / 底部确认条 / 面板式浮层）统一接入：
 * - **打开时**：焦点还不在弹层内 → 移入第一个可聚焦元素（没有可聚焦元素则落到容器本身）；容器挂 data-focus-container 时把焦点收到容器本身（Push 340：数据详情弹窗不再一亮就选中 ✕）；
 * - **打开期间**：Tab / Shift+Tab 在弹层内循环，不再游走到背景控件（防误触背景的破坏性按钮）；
 * - **关闭时**：焦点还原到打开前的元素（还在页面上才还原；触发按钮随删除一起消失时跳过）；
 * - **同屏叠放多个弹层**：只有最后打开的那个接管 Tab（栈顶仲裁），其余不抢（如弹窗里再开预览层）。
 * - **层内再开的 portal 浮层**（下拉 / 行内编辑 / 人员多选 / 日期等，DOM 挂在 body）：并进同一次 Tab 循环 —— 先在浮层里走、走到头回弹层，焦点不会被硬拽回弹层开头。
 *
 * 用法：
 * - 容器没有自己的 ref：`const ref = useFocusTrap<HTMLDivElement>(active);` 然后 `ref={ref}`；
 * - 容器已有 ref：`useFocusTrapFor(existingRef, active);`；
 * - active 给「组件常驻、弹层按状态显隐」的调用方（常驻页面里的底部确认条 / 抽屉）；
 *   弹层随组件一起挂载卸载（ProjectModal 这类）直接用默认值 true。
 * - 希望「打开时不抢第一个可聚焦元素」的弹层：容器加 data-focus-container + tabIndex={-1}（焦点停在容器本身，不进第一个控件）。
 * - trapTab = false 只做「聚焦进入 + 关闭还原」、不循环 Tab（留给以后需要「Tab 即关闭浮层」的场景）。
 */
export function useFocusTrapFor<T extends HTMLElement>(
  ref: MutableRefObject<T | null> | { readonly current: T | null },
  active = true,
  trapTab = true,
): void {
  useEffect(() => {
    const container = ref.current;
    if (!active || container === null) {
      return;
    }
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: TrapEntry = ref;
    trapStack.push(entry);
    const frame = window.requestAnimationFrame(() => {
      const live = ref.current;
      if (live === null || !topTrapIs(entry)) {
        return;
      }
      if (document.activeElement !== null && live.contains(document.activeElement)) {
        return;
      }
      // 容器挂 data-focus-container 的弹层（Push 340）：把焦点收到容器本身，不抢第一个可聚焦元素
      // （数据详情弹窗的 ✕ 是容器里第一个按钮，一亮就被描上焦点环 —— 业务口径「一点进来这个叉号就被选中了」）。
      if (live.hasAttribute("data-focus-container")) {
        if (!live.hasAttribute("tabindex")) {
          live.setAttribute("tabindex", "-1");
        }
        live.focus();
        return;
      }
      const items = focusablesIn(live);
      if (items.length > 0) {
        items[0].focus();
        return;
      }
      if (!live.hasAttribute("tabindex")) {
        live.setAttribute("tabindex", "-1");
      }
      live.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!trapTab || event.key !== "Tab") {
        return;
      }
      const live = ref.current;
      if (live === null || !live.isConnected || !topTrapIs(entry)) {
        return;
      }
      const activeElement = document.activeElement;
      // 焦点在层外浮层（下拉 / 行内编辑等 portal 层）里时，把浮层并进循环：Tab 先在浮层内走，走到头才回弹层
      const scope = scopeOutside(activeElement, live);
      const items = scope === null ? focusablesIn(live) : focusablesIn(live).concat(focusablesIn(scope));
      if (items.length === 0) {
        event.preventDefault();
        live.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // 焦点就在容器本身（data-focus-container 初聚）时按「还没进控件」处理：Tab → 首控件、Shift+Tab → 末控件，不游出弹层。
      const inside = activeElement !== null && activeElement !== live && (live.contains(activeElement) || (scope !== null && scope.contains(activeElement)));
      if (event.shiftKey) {
        if (!inside || activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      const at = trapStack.indexOf(entry);
      if (at >= 0) {
        trapStack.splice(at, 1);
      }
      if (restoreTo !== null && restoreTo.isConnected) {
        restoreTo.focus();
      }
    };
  }, [ref, active, trapTab]);
}

/** 没有现成 ref 的容器用这个：返回一个挂到弹层容器上的 ref。 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(active = true, trapTab = true): MutableRefObject<T | null> {
  const ref = useRef<T | null>(null);
  useFocusTrapFor(ref, active, trapTab);
  return ref;
}
