import { useEffect, useRef, useState } from "react";
import { loadWecomDmBinding } from "../bindingApi";
import { isBindingGuideSkipped, skipBindingGuide } from "../bindingGuide";
import { copyTextToClipboard } from "../clipboard";
import { useT } from "../i18n";
import type { MeResponse } from "../types";
import { SETTINGS_BASE_HASH } from "../useHashRoute";
import { Toast } from "./Toast";
import { WecomBindingPanel, type BindingNotice } from "./WecomBindingPanel";

/** 引导弹窗账号键（User.id 可能为空：回落到 name / owner，再兜底 anon —— 与顶栏展示同一套取值习惯）。 */
function guideKeyOf(me: MeResponse): string {
  return me.user.id ?? me.user.name ?? me.user.owner ?? "anon";
}

/** 引导自动收起时长（业务口径 2026-10-19：右侧悬浮提醒 10 秒后自动消失）。 */
const GUIDE_AUTO_DISMISS_MS = 10_000;

/** 绑定成功后先让卡片内的「已绑定」态短暂可见，再关闭并弹成功提示。 */
const BOUND_CLOSE_DELAY_MS = 700;

/** 机器人资料页：只提供复制按钮，不在界面直接展示完整链接。 */
const WECOM_BOT_PROFILE_URL =
  "https://work.weixin.qq.com/wework_admin/common/openBotProfile/24d86e241840bad3f952d1d7bbae4058a8";

/**
 * 登录后「绑定企业微信」引导（D5 · Push 250；Push 368 改为右侧透明悬浮提醒）。
 *
 * 何时显示：登录后**未绑定**且本机未跳过（`../bindingGuide`）。已绑定 / 已跳过 = 不渲染。
 * 交互：右侧垂直居中悬浮、无遮罩、不锁页面滚动，页面其余区域保持可操作；10 秒后自动收起。
 * 关闭 X = 记下本机跳过位；自动收起只隐藏本次提醒，不写跳过位。
 * 「前往设置」= 记跳过 + 跳 `#/settings`（绑定面板的完整入口，含解绑）。
 * 取码 / 倒计时 / 复制与 429 置灰复用 WecomBindingPanel（与设置页同一份实现）。
 * 绑定成功：自动轮询 / 手动刷新读到已绑定 → 让「已绑定」态停留约 700ms → 关闭卡片 → 浅绿「绑定成功」2 秒。
 */
export function BindingGuideModal({ me }: { me: MeResponse }) {
  const t = useT();
  const accountKey = guideKeyOf(me);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState<BindingNotice | null>(null);
  const [boundSettling, setBoundSettling] = useState(false);
  const [boundSuccess, setBoundSuccess] = useState(false);
  const boundCloseTimerRef = useRef<number | null>(null);
  const guideOpenRef = useRef(false);

  const clearBoundCloseTimer = (): void => {
    if (boundCloseTimerRef.current !== null) {
      window.clearTimeout(boundCloseTimerRef.current);
      boundCloseTimerRef.current = null;
    }
  };

  useEffect(() => {
    clearBoundCloseTimer();
    guideOpenRef.current = false;
    setVisible(false);
    setBoundSettling(false);
    setBoundSuccess(false);
    setNotice(null);
    if (isBindingGuideSkipped(accountKey)) {
      return;
    }
    let cancelled = false;
    void loadWecomDmBinding()
      .then((state) => {
        if (!cancelled && !state.bound) {
          guideOpenRef.current = true;
          setVisible(true);
        }
      })
      .catch(() => {
        // 读态失败（后端不可达 / 混布窗口）：不弹引导，避免挡路 —— 设置页仍可自助绑定
      });
    return () => {
      cancelled = true;
      clearBoundCloseTimer();
    };
  }, [accountKey]);

  useEffect(() => {
    if (!visible || boundSettling) {
      return;
    }
    const timer = window.setTimeout(() => {
      guideOpenRef.current = false;
      setVisible(false);
    }, GUIDE_AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [boundSettling, visible]);

  const close = (): void => {
    guideOpenRef.current = false;
    setVisible(false);
    setBoundSettling(false);
  };

  const handleSkip = (): void => {
    clearBoundCloseTimer();
    setBoundSettling(false);
    setBoundSuccess(false);
    setNotice(null);
    skipBindingGuide(accountKey);
    close();
  };

  const handleGoSettings = (): void => {
    clearBoundCloseTimer();
    setBoundSettling(false);
    setBoundSuccess(false);
    setNotice(null);
    skipBindingGuide(accountKey);
    close();
    window.location.hash = SETTINGS_BASE_HASH.slice(1);
  };

  const handleBoundChange = (bound: boolean): void => {
    if (!bound || !guideOpenRef.current || boundCloseTimerRef.current !== null) {
      return;
    }
    skipBindingGuide(accountKey);
    setNotice(null);
    setBoundSettling(true);
    boundCloseTimerRef.current = window.setTimeout(() => {
      boundCloseTimerRef.current = null;
      guideOpenRef.current = false;
      setVisible(false);
      setBoundSettling(false);
      setNotice(null);
      setBoundSuccess(true);
    }, BOUND_CLOSE_DELAY_MS);
  };

  const handleCopyBotLink = async (): Promise<void> => {
    const copied = await copyTextToClipboard(WECOM_BOT_PROFILE_URL);
    setNotice(
      copied
        ? { kind: "ok", text: t("settings.guide.linkCopied") }
        : { kind: "error", text: t("settings.guide.linkCopyFailed") },
    );
  };

  if (!visible) {
    return boundSuccess ? (
      <Toast
        kind="ok"
        text={t("settings.guide.boundSuccess")}
        onClose={() => {
          setBoundSuccess(false);
        }}
      />
    ) : null;
  }

  return (
    <>
      <aside
        role="region"
        aria-label={t("settings.guide.title")}
        data-wecom-binding-guide="true"
        data-wecom-binding-guide-auto-dismiss={String(GUIDE_AUTO_DISMISS_MS)}
        className="fixed right-5 top-1/2 z-[70] max-h-[calc(100dvh-2rem)] w-[min(calc(100vw-2.5rem),24rem)] -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/80 bg-white/85 p-5 text-zinc-900 shadow-[0_18px_50px_rgba(15,23,42,0.16),0_2px_8px_rgba(15,23,42,0.06)] ring-1 ring-zinc-900/5 backdrop-blur-xl sm:right-6"
      >
        <button
          type="button"
          data-wecom-binding-guide-skip="true"
          aria-label={t("settings.guide.close")}
          title={t("settings.guide.close")}
          onClick={handleSkip}
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-zinc-400 transition hover:bg-zinc-900/5 hover:text-zinc-700"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="h-4 w-4">
            <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
          </svg>
        </button>

        <div className="flex items-start gap-3 pr-8">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="h-5 w-5">
              <path d="M5 6.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4.5 3v-3.2A2 2 0 0 1 3 15.3v-6.8a2 2 0 0 1 2-2Z" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">{t("settings.guide.title")}</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{t("settings.guide.desc")}</p>
          </div>
        </div>

        <ol className="mt-4 space-y-2.5 text-[13px] leading-5 text-zinc-600">
          <li className="flex gap-2.5">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[10px] font-semibold text-white">
              1
            </span>
            <span>{t("settings.guide.step1")}</span>
          </li>
          <li className="flex gap-2.5">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[10px] font-semibold text-white">
              2
            </span>
            <span>{t("settings.guide.step2")}</span>
          </li>
        </ol>

        <button
          type="button"
          data-wecom-binding-guide-copy-link="true"
          onClick={() => void handleCopyBotLink()}
          className="ml-[1.875rem] mt-2 inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:bg-white hover:text-zinc-900"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="h-3.5 w-3.5">
            <rect x="7" y="7" width="9" height="9" rx="2" />
            <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          </svg>
          {t("settings.guide.copyLink")}
        </button>

        <div className="mt-4 border-t border-zinc-200/70 pt-4">
          <WecomBindingPanel
            variant="guide"
            onNotice={(next) => {
              setNotice(next);
            }}
            onBoundChange={handleBoundChange}
          />
        </div>

        <div className="mt-4 flex justify-end border-t border-zinc-200/70 pt-3">
          <button
            type="button"
            data-wecom-binding-guide-goto="true"
            onClick={handleGoSettings}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-900/5 hover:text-zinc-900"
          >
            {t("settings.guide.go")}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="h-3.5 w-3.5">
              <path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </aside>
      {notice === null ? null : (
        <Toast
          kind={notice.kind}
          text={notice.text}
          onClose={() => {
            setNotice(null);
          }}
        />
      )}
    </>
  );
}
