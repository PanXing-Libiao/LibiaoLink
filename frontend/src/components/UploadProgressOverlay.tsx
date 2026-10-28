import { useEffect } from "react";
import { useT } from "../i18n";
import { lockBodyScroll } from "../scrollLock";

export type UploadProgress = { done: number; total: number };

/** 文件上传等待浮层：复用导出 / 导入的小车动画，上传期间盖住页面并锁滚动。 */
export function UploadProgressOverlay({ progress }: { progress: UploadProgress | null }) {
  const t = useT();
  const open = progress !== null;
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    return lockBodyScroll();
  }, [open]);
  if (progress === null) {
    return null;
  }
  const total = Math.max(1, progress.total);
  const waiting = progress.done === 0;
  const percent = Math.min(100, Math.round((progress.done / total) * 100));
  return (
    <div className="export-progress" role="status" aria-live="polite" data-file-upload-progress="true">
      <div className="export-progress__card">
        <div className="export-progress__stage" aria-hidden="true">
          <span className="export-progress__road" />
          <span className="export-progress__cart">
            <span className="export-progress__cart-shadow" />
            <span className="export-progress__cart-bob">
              <img className="export-progress__cart-img" src="/libiaolink-car-icon.svg" alt="" />
              <span className="export-progress__trail export-progress__trail--long" />
              <span className="export-progress__trail export-progress__trail--short" />
            </span>
          </span>
        </div>
        <p className="export-progress__title">{t("upload.files.title")}</p>
        <p className="export-progress__hint">
          {waiting
            ? t("upload.files.preparing", { total: String(progress.total) })
            : t("upload.files.progress", { done: String(progress.done), total: String(progress.total) })}
        </p>
        <div className={"export-progress__bar" + (waiting ? " is-waiting" : "")}>
          <span className="export-progress__bar-fill" style={waiting ? undefined : { width: percent + "%" }} />
        </div>
      </div>
    </div>
  );
}
