import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

/** 全局浮动提示（Push 261 追订 · 业务口径 2026-10-09「系统中这样的提示 要直接在屏幕上方浮空的 然后保持3s消失
 *  不要在页面顶部不然鼠标要滑到上方才能看到」）。
 *
 *  屏幕上方居中浮空（createPortal 挂 body —— 不被页面容器裁剪 / 不吃滚动位置，鼠标不用往页面上方滑），
 *  停留 2s 自动消失（业务口径 2026-10-09 追订「另外停留改成2s」），右侧「关闭」可立即收起；
 *  同一位置再出提示 = 以新文案重新计时。
 *
 *  用法：把各页原有的行内提示条换成 `<Toast kind text onClose />`（保留原 data-* 钩子的页用 anchor 透传，
 *  回放脚本照旧按钩子定位）。加载失败 + 「重试」这类常驻状态提示不走本组件（留在页内）。
 */
export type ToastKind = "ok" | "error" | "info";

const DEFAULT_DURATION: Record<ToastKind, number> = { ok: 2000, info: 2000, error: 2000 };

const KIND_STYLE: Record<ToastKind, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
  info: "border-zinc-200 bg-white text-zinc-700",
};

export function Toast(props: {
  kind: ToastKind;
  text: string;
  onClose: () => void;
  /** 覆盖自动消失时长（毫秒；缺省 = 2s，见 DEFAULT_DURATION）。 */
  durationMs?: number;
  /** 透传原页面的 data-* 钩子（例：`{ name: "data-file-notice", value: kind }`），回放脚本按它定位。 */
  anchor?: { name: string; value: string };
}) {
  const t = useT();
  const duration = props.durationMs ?? DEFAULT_DURATION[props.kind];
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onCloseRef.current();
    }, duration);
    return () => {
      window.clearTimeout(timer);
    };
  }, [duration, props.kind, props.text]);
  const anchorAttr = props.anchor === undefined ? {} : { [props.anchor.name]: props.anchor.value };
  return createPortal(
    <div
      {...anchorAttr}
      role="status"
      aria-live="polite"
      className={
        "pointer-events-auto fixed left-1/2 top-4 z-[90] flex w-[min(92vw,720px)] -translate-x-1/2 items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-lg " +
        KIND_STYLE[props.kind]
      }
      data-toast={props.kind}
    >
      <span className="min-w-0 flex-1">{props.text}</span>
      <button
        type="button"
        onClick={props.onClose}
        className="shrink-0 rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium text-current transition hover:bg-black/5"
      >
        {t("toast.close")}
      </button>
    </div>,
    document.body,
  );
}
