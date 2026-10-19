import { useEffect, useRef, useState } from "react";
import {
  loadWecomDmBinding,
  rateLimitedRetryAt,
  requestWecomDmBindingCode,
  unbindWecomDm,
  type WecomDmBindingCode,
  type WecomDmBindingState,
} from "../bindingApi";
import { copyTextToClipboard } from "../clipboard";
import { useT } from "../i18n";
import { formatDateTime } from "../projectApi";

/**
 * 企业微信绑定操作面板（D5 / D6 · M5-03-5-6 绑定码链路前端 · Push 250）。
 *
 * 两处复用：设置页「企业微信绑定」卡片（variant = page）与首登引导弹窗（variant = guide）。
 * 面板只做「状态 + 取码 / 倒计时 / 复制 + 解绑」，引导文案与外壳由宿主给（见 SettingsPage / BindingGuideModal）。
 *
 * 取码：`POST /wecom-dm-binding/codes` → 6 位码 + `expiresInSeconds` 倒计时（重复取码作废旧码，
 *  一律以最新响应为准）；频率到顶 = 429 `RATE_LIMITED` → 按 `details[].meta.retryAt` 置灰按钮 + 倒计时。
 * 解绑：`DELETE /wecom-dm-binding`（幂等）—— 二次确认后提交，成功回未绑定态。
 * 安全（口径 §9）：界面只展示掩码（末 4 位）；除 6 位码本身外不缓存 / 不落日志企微标识。
 *
 * 绑定态刷新（Push 253 修「企微已回执绑定成功、设置页仍显示未绑定」）：绑定只能由用户在企微里发码完成，
 *  页面侧无法从写口响应得知 —— 未绑定时每 5 秒静默重读（上限 15 分钟）+ 「刷新绑定状态」按钮 +
 *  窗口重新可见 / 聚焦立即读一次。
 * 状态持久（Push 254 修「刷新页面后绑定码 / 罚时消失」）：码面与倒计时的唯一真源 = 服务端读面（GET 回
 *  bindingCode / retryAt）—— `applyState` 把「绑定态 + 未用码 + 罚时」一起播种，刷新 / 重进页面后原样恢复；
 *  码失效（倒计时归零）时主动提示「请重新获取」（toast + 码面内文案）。
 * 复制（Push 253 修「复制一直失败」）：走 `../clipboard` 双通道 —— 异步剪贴板 API 不可用
 *  （http 非安全上下文 / 权限被拒）时回退 `document.execCommand("copy")`，码面同时置为可全选。
 */
export type BindingNotice = { kind: "ok" | "error"; text: string };

/** 未绑定时的绑定态轮询间隔（5 秒）。 */
const BINDING_POLL_INTERVAL_MS = 5_000;
/** 轮询上限（15 分钟）：到点停表，改由「刷新绑定状态」按钮手动读（避免开着的引导弹窗长期空转）。 */
const BINDING_POLL_MAX_MS = 15 * 60_000;

/** 频率等待时长口径（把「2000 多秒」写成「33 分 20 秒」：Push 253 可读性修订）。 */
function formatWait(seconds: number): string {
  if (seconds < 60) {
    return String(seconds) + " 秒";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? String(minutes) + " 分钟" : String(minutes) + " 分 " + String(rest) + " 秒";
}

export function WecomBindingPanel(props: {
  variant: "page" | "guide";
  onNotice: (notice: BindingNotice) => void;
  onBoundChange?: (bound: boolean) => void;
}) {
  const t = useT();
  const [state, setState] = useState<WecomDmBindingState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [code, setCode] = useState<WecomDmBindingCode | null>(null);
  const [retryAt, setRetryAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "unbind" | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /**
   * 读面 → 本地（Push 254 · v1.8 回填）：绑定态 + 当前未用码 + 取码罚时**一起**播种 —— 刷新 / 重进页面
   * 不丢码面、倒计时与罚时；状态真源在服务端，前端不另存（localStorage 不落企微标识 —— 口径 §9）。
   */
  const applyState = (next: WecomDmBindingState): void => {
    setState(next);
    setCode(next.bindingCode);
    setRetryAt(next.retryAt);
    props.onBoundChange?.(next.bound);
  };

  const reload = (): void => {
    setLoadFailed(false);
    setState(null);
    void loadWecomDmBinding()
      .then((next) => {
        applyState(next);
      })
      .catch(() => {
        setLoadFailed(true);
      });
  };

  useEffect(() => {
    reload();
    // 挂载拉一次 —— 后续：写口（取码 / 解绑）响应回读 + 未绑定时轮询（见下方 effect）
  }, []);

  /** 静默重读绑定态（不闪 loading）：轮询 / 回到前台 / 「刷新绑定状态」共用。 */
  const refreshState = async (): Promise<void> => {
    try {
      const next = await loadWecomDmBinding();
      applyState(next);
      setLoadFailed(false);
    } catch {
      // 静默失败：保留当前状态（下一轮 / 手动刷新再试），不把已绑定的界面打回错误态
    }
  };

  /** 手动「刷新绑定状态」：按钮置忙，读毕复位。 */
  const manualRefresh = async (): Promise<void> => {
    setChecking(true);
    try {
      await refreshState();
    } finally {
      setChecking(false);
    }
  };

  /**
   * 未绑定 → 轮询绑定态：绑定由用户在企微侧发码完成，页面侧只能轮询 / 回前台得知。
   * 每 5 秒静默重读（上限 15 分钟）；已绑定 / 卸载即停表。
   */
  const boundFlag = state === null ? null : state.bound;
  useEffect(() => {
    if (boundFlag !== false) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > BINDING_POLL_MAX_MS) {
        window.clearInterval(timer);
        return;
      }
      void refreshState();
    }, BINDING_POLL_INTERVAL_MS);
    const onWake = (): void => {
      if (document.visibilityState === "visible") {
        void refreshState();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [boundFlag]);

  const codeLeft = code === null ? 0 : Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now) / 1000));
  const retryLeft = retryAt === null ? 0 : Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000));
  const ticking = codeLeft > 0 || retryLeft > 0;

  useEffect(() => {
    if (!ticking) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [ticking]);

  /**
   * 码失效提醒（Push 254 · 用户口径「绑定码失效后需要提醒用户重新获取」）：倒计时归零时提示一次
   * （码面内文案同时切「已失效，请重新获取」）；同一枚码只提醒一次，刷新后由读面回填的新码各自计时。
   */
  const expirationNotified = useRef<string | null>(null);
  useEffect(() => {
    if (code === null || codeLeft > 0 || expirationNotified.current === code.code) {
      return;
    }
    expirationNotified.current = code.code;
    props.onNotice({ kind: "error", text: t("settings.bind.codeExpiredNotice") });
  }, [code, codeLeft]);

  const handleGetCode = async (): Promise<void> => {
    setBusy("code");
    try {
      const result = await requestWecomDmBindingCode();
      setNow(Date.now());
      setCode(result);
      setRetryAt(null);
      props.onNotice({ kind: "ok", text: t("settings.bind.codeReady") });
    } catch (error) {
      const limit = rateLimitedRetryAt(error);
      if (limit !== null) {
        setRetryAt(limit);
        props.onNotice({ kind: "error", text: t("settings.bind.rateLimited") });
      } else {
        props.onNotice({ kind: "error", text: t("settings.bind.codeFailed") });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (code === null) {
      return;
    }
    const copied = await copyTextToClipboard(code.code);
    props.onNotice(
      copied
        ? { kind: "ok", text: t("settings.bind.copied") }
        : { kind: "error", text: t("settings.bind.copyFailed") },
    );
  };

  const handleUnbind = async (): Promise<void> => {
    setBusy("unbind");
    try {
      const next = await unbindWecomDm();
      applyState(next);
      setConfirmUnbind(false);
      props.onNotice({ kind: "ok", text: t("settings.bind.unboundOk") });
    } catch {
      props.onNotice({ kind: "error", text: t("settings.bind.unbindFailed") });
    } finally {
      setBusy(null);
    }
  };

  if (loadFailed) {
    return (
      <div data-wecom-binding="error" className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
        <span>{t("settings.bind.loadFailed")}</span>
        <button
          type="button"
          data-wecom-binding-retry="true"
          onClick={reload}
          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
        >
          {t("settings.bind.retry")}
        </button>
      </div>
    );
  }

  if (state === null) {
    return <div data-wecom-binding="loading" className="text-xs text-zinc-400">{t("settings.bind.loading")}</div>;
  }

  const codeBlock =
    code === null ? null : (
      <div
        data-wecom-binding-code={code.code}
        data-wecom-binding-code-state={codeLeft > 0 ? "active" : "expired"}
        className="mt-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3"
      >
        <p className="text-xs text-amber-800">{t("settings.bind.codeHint")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span
            data-wecom-binding-code-text="true"
            className="cursor-text select-all font-mono text-2xl font-semibold tracking-[0.3em] text-zinc-900"
          >
            {code.code}
          </span>
          <button
            type="button"
            data-wecom-binding-copy="true"
            onClick={() => void handleCopy()}
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            {t("settings.bind.copy")}
          </button>
          <span data-wecom-binding-countdown={String(codeLeft)} className="text-xs tabular-nums text-amber-800">
            {codeLeft > 0 ? t("settings.bind.codeLeft", { seconds: codeLeft }) : t("settings.bind.codeExpired")}
          </span>
        </div>
      </div>
    );

  if (state.bound) {
    return (
      <div data-wecom-binding="bound" className={props.variant === "guide" ? "" : "space-y-1"}>
        <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-800">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            {t("settings.bind.bound")}
          </span>
          {state.wecomUseridMasked === null ? null : (
            <span className="font-mono text-xs text-zinc-500">{t("settings.bind.masked", { mask: state.wecomUseridMasked })}</span>
          )}
        </p>
        {state.boundAt === null ? null : (
          <p className="text-xs text-zinc-500">{t("settings.bind.boundAt", { time: formatDateTime(state.boundAt) })}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirmUnbind ? (
            <>
              <span className="text-xs text-zinc-500">{t("settings.bind.unbindAsk")}</span>
              <button
                type="button"
                data-wecom-binding-unbind-confirm="true"
                disabled={busy !== null}
                onClick={() => void handleUnbind()}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-95 disabled:opacity-60"
              >
                {busy === "unbind" ? t("settings.bind.unbinding") : t("settings.bind.unbindConfirm")}
              </button>
              <button
                type="button"
                data-wecom-binding-unbind-cancel="true"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmUnbind(false);
                }}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-60"
              >
                {t("settings.bind.unbindCancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-wecom-binding-unbind="true"
              onClick={() => {
                setConfirmUnbind(true);
              }}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
            >
              {t("settings.bind.unbind")}
            </button>
          )}
        </div>
        {props.variant === "page" ? <p className="pt-2 text-xs text-zinc-500">{t("settings.bind.unbindNote")}</p> : null}
      </div>
    );
  }

  const codeDisabled = busy !== null || retryLeft > 0;
  return (
    <div data-wecom-binding="unbound">
      <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-800">
        <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
          {t("settings.bind.unbound")}
        </span>
        <span className="text-xs text-zinc-500">{t("settings.bind.unboundHint")}</span>
      </p>
      {props.variant === "page" ? <p className="mt-2 text-xs leading-5 text-zinc-500">{t("settings.bind.steps")}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-wecom-binding-get-code="true"
          disabled={codeDisabled}
          onClick={() => void handleGetCode()}
          className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          {busy === "code" ? t("settings.bind.codeBusy") : code === null ? t("settings.bind.getCode") : t("settings.bind.regetCode")}
        </button>
        <button
          type="button"
          data-wecom-binding-refresh="true"
          disabled={checking}
          onClick={() => void manualRefresh()}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-60"
        >
          {checking ? t("settings.bind.checking") : t("settings.bind.refresh")}
        </button>
        {retryLeft > 0 ? (
          <span data-wecom-binding-rate-limit={String(retryLeft)} className="text-xs tabular-nums text-rose-600">
            {t("settings.bind.rateLimitedLeft", { wait: formatWait(retryLeft) })}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{t("settings.bind.pollHint")}</p>
      {codeBlock}
    </div>
  );
}
