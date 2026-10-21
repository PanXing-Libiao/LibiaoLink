import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { Loader } from "./Loader";
import { useFocusTrap } from "./useFocusTrap";

/**
 * 仪表盘数据详情的外层等待态（B4 服务端收口）：详情明细按选中项目懒加载，
 * 在任务 / 问题 / 变更明细回来之前先挂同一套弹窗壳，避免出现空表；
 * 失败时留在弹窗内重试，关闭 / 遮罩 / Esc / 焦点陷阱与三个详情弹窗一致。
 */
export function HubDashDetailLoading({ projectName, failed, onRetry, onClose }: {
  readonly projectName: string;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const trapRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      data-hub-detail-dialog="true"
      role="dialog"
      aria-modal="true"
      aria-label={t("hub.dash.detail.title")}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/45 p-6"
    >
      <div
        ref={trapRef}
        data-focus-container="true"
        tabIndex={-1}
        onClick={(event) => { event.stopPropagation(); }}
        className="hub-dash-detail"
      >
        <div className="hub-dash-detail__head">
          <div>
            <div className="hub-dash-detail__title">{t("hub.dash.detail.title")}</div>
            <div className="hub-dash-detail__from">
              <span>{t("hub.dash.detail.from")}</span>
              <span className="hub-dash-detail__project">{projectName}</span>
            </div>
          </div>
          <button type="button" className="hub-dash-detail__close" aria-label={t("hub.dash.detail.close")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-8">
          {failed ? (
            <>
              <div className="text-sm font-medium text-zinc-600">{t("hub.dash.detail.loadFailed")}</div>
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-blue-400 hover:text-blue-600"
              >
                {t("common.retry")}
              </button>
            </>
          ) : (
            <>
              <Loader />
              <div className="text-sm text-zinc-500">{t("hub.dash.detail.loading")}</div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
