import { copyTextToClipboard } from "../clipboard";
import { useT } from "../i18n";
import type { BindingNotice } from "./WecomBindingPanel";

/** 机器人资料页：只提供复制按钮，不在界面直接展示完整链接。 */
export const WECOM_BOT_PROFILE_URL =
  "https://work.weixin.qq.com/wework_admin/common/openBotProfile/24d86e241840bad3f952d1d7bbae4058a8";

/** 首登提醒与设置页共用同一套绑定引导文案 / 操作。 */
export function WecomBindingGuideContent(props: {
  onNotice: (notice: BindingNotice) => void;
  reserveCloseSpace?: boolean;
}) {
  const t = useT();

  const handleCopyBotLink = async (): Promise<void> => {
    const copied = await copyTextToClipboard(WECOM_BOT_PROFILE_URL);
    props.onNotice(
      copied
        ? { kind: "ok", text: t("settings.guide.linkCopied") }
        : { kind: "error", text: t("settings.guide.linkCopyFailed") },
    );
  };

  return (
    <div data-wecom-binding-guide-content="true">
      <div className={"flex items-start gap-3 " + (props.reserveCloseSpace === true ? "pr-8" : "")}>
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
        <li data-wecom-binding-step="1" className="flex gap-2.5">
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[10px] font-semibold text-white">
            1
          </span>
          <span>{t("settings.guide.step1")}</span>
        </li>
        <li data-wecom-binding-step="2" className="flex gap-2.5">
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
    </div>
  );
}
