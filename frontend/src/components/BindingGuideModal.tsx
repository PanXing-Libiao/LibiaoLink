import { useEffect, useState } from "react";
import { loadWecomDmBinding } from "../bindingApi";
import { isBindingGuideSkipped, skipBindingGuide } from "../bindingGuide";
import { useT } from "../i18n";
import type { MeResponse } from "../types";
import { SETTINGS_BASE_HASH } from "../useHashRoute";
import { Toast } from "./Toast";
import { WecomBindingGuideContent } from "./WecomBindingGuideContent";
import { WecomBindingPanel, type BindingNotice } from "./WecomBindingPanel";

/** 引导弹窗账号键（User.id 可能为空：回落到 name / owner，再兜底 anon —— 与顶栏展示同一套取值习惯）。 */
function guideKeyOf(me: MeResponse): string {
  return me.user.id ?? me.user.name ?? me.user.owner ?? "anon";
}

/** 引导自动收起时长（业务口径 2026-10-19：右侧悬浮提醒 10 秒后自动消失）。 */
const GUIDE_AUTO_DISMISS_MS = 10_000;

/**
 * 登录后「绑定企业微信」引导（D5 · Push 250；Push 368 改为右侧透明悬浮提醒）。
 *
 * 何时显示：登录后**未绑定**且本机未跳过（`../bindingGuide`）。已绑定 / 已跳过 = 不渲染。
 * 交互：右侧垂直居中悬浮、无遮罩、不锁页面滚动，页面其余区域保持可操作；10 秒后自动收起。
 * 关闭 X = 记下本机跳过位；自动收起只隐藏本次提醒，不写跳过位。
 * 「前往设置」= 记跳过 + 跳 `#/settings`（绑定面板的完整入口，含解绑）。
 * 取码 / 倒计时 / 复制与 429 置灰复用 WecomBindingPanel（与设置页同一份实现）。
 */
export function BindingGuideModal({ me }: { me: MeResponse }) {
  const t = useT();
  const accountKey = guideKeyOf(me);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState<BindingNotice | null>(null);

  useEffect(() => {
    setVisible(false);
    if (isBindingGuideSkipped(accountKey)) {
      return;
    }
    let cancelled = false;
    void loadWecomDmBinding()
      .then((state) => {
        if (!cancelled && !state.bound) {
          setVisible(true);
        }
      })
      .catch(() => {
        // 读态失败（后端不可达 / 混布窗口）：不弹引导，避免挡路 —— 设置页仍可自助绑定
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const timer = window.setTimeout(() => {
      setVisible(false);
    }, GUIDE_AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [visible]);

  const close = (): void => {
    setVisible(false);
  };

  const handleSkip = (): void => {
    skipBindingGuide(accountKey);
    close();
  };

  const handleGoSettings = (): void => {
    skipBindingGuide(accountKey);
    close();
    window.location.hash = SETTINGS_BASE_HASH.slice(1);
  };

  if (!visible) {
    return null;
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

        <WecomBindingGuideContent
          onNotice={setNotice}
          reserveCloseSpace={true}
        />

        <div className="mt-4 border-t border-zinc-200/70 pt-4">
          <WecomBindingPanel
            variant="guide"
            onNotice={(next) => {
              setNotice(next);
            }}
            onBoundChange={(bound) => {
              if (bound) {
                skipBindingGuide(accountKey);
                close();
              }
            }}
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
