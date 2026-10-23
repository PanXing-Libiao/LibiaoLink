import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

/** 全局瞬态提示（2026-10-23 普通提示改为 react-hot-toast 风格顶部 toast）：
 *  - 白色圆角卡片、无深色遮罩、浅投影，自屏幕顶部弹性下落并轻微放大，停留 2s 后向上收拢淡出；
 *  - 验收交付完成确认仍单独固定底部，普通成功 / 失败 / 信息提示统一走本组件；
 *  - 成功 / 错误 / 信息统一材质，仅左侧图标与语义不同；右侧「关闭」可立即收起；
 *  - createPortal 挂 body，不被页面容器裁剪，也不吃滚动位置。
 *
 *  用法：瞬态成功 / 失败 / 校验提示统一用 Toast（kind / text / onClose）；需要「重试」的常驻加载失败
 *  仍留在页内。保留原页面 data-* 钩子时用 anchor 透传，回放脚本照旧按钩子定位。
 */
export type ToastKind = "ok" | "error" | "info";

const DEFAULT_DURATION: Record<ToastKind, number> = { ok: 2000, info: 2000, error: 2000 };
const EXIT_MS = 180;

const KIND_META: Record<ToastKind, { bg: string; path: string }> = {
  ok: {
    bg: "bg-emerald-500",
    path: "M5.2 10.1l3.1 3.1 6.5-6.5",
  },
  error: {
    bg: "bg-rose-500",
    path: "M6.1 6.1l7.8 7.8M13.9 6.1l-7.8 7.8",
  },
  info: {
    bg: "bg-sky-500",
    path: "M10 8.8v5.4",
  },
};

export function Toast(props: {
  kind: ToastKind;
  text: string;
  onClose: () => void;
  /** 覆盖自动消失时长（毫秒；缺省 = 2s，见 DEFAULT_DURATION）。 */
  durationMs?: number;
  /** 透传原页面的 data-* 钩子（例：{ name: "data-file-notice", value: kind }），回放脚本按它定位。 */
  anchor?: { name: string; value: string };
}) {
  const t = useT();
  const duration = props.durationMs ?? DEFAULT_DURATION[props.kind];
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const autoTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const onCloseRef = useRef(props.onClose);
  const beginCloseRef = useRef<() => void>(() => {});
  onCloseRef.current = props.onClose;

  beginCloseRef.current = () => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      onCloseRef.current();
    }, EXIT_MS);
  };

  useEffect(() => {
    closingRef.current = false;
    setClosing(false);
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    autoTimerRef.current = window.setTimeout(() => {
      autoTimerRef.current = null;
      beginCloseRef.current();
    }, duration);
    return () => {
      if (autoTimerRef.current !== null) {
        window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [duration, props.kind, props.text]);

  useEffect(() => () => {
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
    }
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
    }
  }, []);

  const anchorAttr = props.anchor === undefined ? {} : { [props.anchor.name]: props.anchor.value };
  const meta = KIND_META[props.kind];
  const className = "ll-toast ll-toast-top pointer-events-auto fixed inset-x-0 top-[max(1.25rem,env(safe-area-inset-top))] z-[90] mx-auto flex w-fit max-w-[min(92vw,640px)] items-center gap-3 rounded-[22px] border border-zinc-200/80 bg-white px-4 py-3 text-base text-zinc-800 shadow-[0_18px_50px_-16px_rgba(15,23,42,0.22),0_4px_12px_-4px_rgba(15,23,42,0.08)] outline-none sm:px-5" + (closing ? " is-closing" : "");

  return createPortal(
    <div
      {...anchorAttr}
      role={props.kind === "error" ? "alert" : "status"}
      aria-live={props.kind === "error" ? "assertive" : "polite"}
      aria-busy={closing}
      className={className}
      data-toast={props.kind}
      onPointerDown={(event) => { event.stopPropagation(); }}
      onMouseDown={(event) => { event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); }}
    >
      <span aria-hidden="true" className={"flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white " + meta.bg}>
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
          <path d={meta.path} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          {props.kind === "info" ? <circle cx="10" cy="5.9" r="1.15" fill="currentColor" /> : null}
        </svg>
      </span>
      <span className="min-w-0 flex-1 font-semibold leading-6">{props.text}</span>
      <button
        type="button"
        onClick={() => { beginCloseRef.current(); }}
        className="shrink-0 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
      >
        {t("toast.close")}
      </button>
    </div>,
    document.body,
  );
}
