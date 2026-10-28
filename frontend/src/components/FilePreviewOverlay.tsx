import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { FilePreviewKind, PreviewViewerConfig } from "../fileApi";
import { FileImagePreview } from "./FileImagePreview";
import { PdfViewer } from "./PdfViewer";
import { isMobileOnlyOfficeEditor, OnlyOfficeViewer } from "./OnlyOfficeViewer";
import { CadModelViewer } from "./CadModelViewer";
import { useFocusTrap } from "./useFocusTrap";
import { useT } from "../i18n";

/** 预览浮层（Push 226 续 / 续三 · S4 · Push 246 起任务列表「文件」列下拉与详情抽屉共用）：
 *  图片 = 取签名字节后本地大图、PDF = PDF.js 本地分页查看、Office / 文本族 = ONLYOFFICE 查看器外壳
 *  （OnlyOfficeViewer；加载 → 就绪 / 超时 / 失败降级，重试自增 nonce 重建）。
 *  短时签名地址（D2-04 禁止匿名读取）。Esc / 点浮层关闭；capture 阶段拦 keydown，避免同一按 Esc
 *  连带把外层（详情抽屉 / 文件下拉）关掉（「Esc 先关内层」口径）。
 *  Push 226 续四：caption 挂「下载原文件」—— 查看器自带的下载拿的是**转换产物**，这里直取原文件。
 *  Push 273（业务口径 2026-10-10「图片预览要有缩放功能」）：图片分支改挂共享缩放组件（滚轮以光标为锚点
 *  缩放 / ＋− 按钮 1.25 步进 / 双击 100% ↔ 200% / 放大后拖动平移，25% ~ 800%）；口径收紧为「点遮罩关浮层」——
 *  图片上的点击留给缩放 / 拖动，点图不再关（原「Esc / 点浮层关闭」里的点图分支下架）。
 *  ADR-035：CAD viewer 配置进入独立 ViewerSession；未启用或旧就绪响应只提示暂不可预览。
 *  Push 258（业务口径「原本的下载不要隐藏 / 点击右上角下载给原文件」）：查看器工具栏的 download 图标保持可见（服务端
 *  document.permissions.download=true），在其原位盖一层**透明命中层**（data-file-preview-native-download）——
 *  点它走同一 onDownload（原格式字节 + download 审计）。DocServer 内置下载是跨域 iframe 原生控件、逻辑改不了，
 *  只能原位接管；命中层挡掉原生 hover 反馈 → 悬停自补与邻近按钮一致的原生观感（hover 用黑 8% 遮罩：白底上合成 ≈ #EAEAEA，且底下图标透出；圆角 4px + pointer 小手、无阴影；业务口径「鼠标变小手 / 效果和旁边搜索一致」）；命中层几何 = 下载子按钮盒（距右 92 / top 4 / 24×24，按 DocServer 9.4.0-cca10593 实测，升级 DocServer 须重新量）。 */
export function FilePreviewOverlay({ pane, name, kind, nonce, zClass = "z-[60]", onRetry, onDownload, onClose }: {
  pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
  name: string;
  kind: FilePreviewKind;
  nonce: number;
  /** 浮层层级（Push 256 续：变更详情弹窗内的预览要盖在弹窗 z-[70] 之上 → 传 z-[80]；默认同抽屉口径 z-[60]）。 */
  zClass?: string;
  onRetry: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const onlyOfficeMobile = pane.mode === "viewer" && pane.viewer.kind === "onlyoffice" && isMobileOnlyOfficeEditor();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  /** 键盘焦点陷阱（Push 264 追订）：打开时焦点进浮层、Tab 在浮层内循环、关闭还原到触发处。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  return createPortal(
    <div
      ref={trapRef}
      data-file-preview="true"
      data-file-preview-kind={kind}
      role="dialog" data-live-sync-readonly="true"
      aria-label={t("fpv.aria", { name })}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      className={"fixed inset-0 " + zClass + " flex items-center justify-center bg-zinc-900/60 " + (kind === "cad" ? "p-1 sm:p-3" : onlyOfficeMobile ? "p-2" : "p-6")}
    >
      <figure className="relative flex max-h-full max-w-full flex-col items-center">
        {kind !== "cad" && pane.mode === "viewer" && pane.viewer.kind === "onlyoffice" && !onlyOfficeMobile ? (
          <button
            type="button"
            data-file-preview-native-download="true"
            title={t("fpv.download")}
            aria-label={t("fpv.download")}
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            className="absolute z-20 cursor-pointer rounded border-0 bg-transparent p-0 hover:bg-black/[0.08]"
            style={{ right: 92, top: 4, width: 24, height: 24 }}
          />
        ) : null}
        {pane.mode === "viewer" && pane.viewer.kind === "cad" ? (
          <CadModelViewer key={`${pane.viewer.fileId}:${pane.viewer.versionId}:${nonce}`} viewer={pane.viewer} name={name} onClose={onClose} onDownload={onDownload} onRetry={onRetry} />
        ) : kind === "cad" ? (
          <div
            role="status"
            data-file-preview-cad-pending="true"
            onClick={(event) => event.stopPropagation()}
            className="flex min-h-48 w-[min(32rem,calc(100vw-3rem))] items-center justify-center rounded-xl bg-white p-8 text-center text-sm text-zinc-600 shadow-2xl"
          >
            {t("fpv.cadPending")}
          </div>
        ) : pane.mode === "viewer" && pane.viewer.kind === "onlyoffice" ? (
          <OnlyOfficeViewer key={nonce} viewer={pane.viewer} onRetry={onRetry} />
        ) : pane.mode === "url" && kind === "pdf" ? (
          <PdfViewer key={"pdf:" + String(nonce)} src={pane.url} name={name} onRetry={onRetry} />
        ) : pane.mode === "url" ? (
          <FileImagePreview key={"image:" + String(nonce)} src={pane.url} alt={name} onRetry={onRetry} />
        ) : null}
        {pane.mode === "viewer" && pane.viewer.kind === "cad" ? null : <figcaption className="relative z-10 mt-2 flex items-center gap-3 rounded-md bg-zinc-900/35 px-2 py-1 text-xs text-white/80 backdrop-blur-sm">
          <span>{name}</span>
          <button
            type="button"
            data-file-preview-download="true"
            onClick={(event) => {
              event.stopPropagation();
              onDownload();
            }}
            className="rounded-md border border-white/30 px-2 py-0.5 text-[11px] text-white/90 transition hover:bg-white/10"
          >
            {t("fpv.download")}
          </button>
        </figcaption>}
      </figure>
    </div>,
    document.body,
  );
}
