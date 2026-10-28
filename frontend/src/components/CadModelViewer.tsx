import { useEffect, useMemo, useRef, useState } from "react";
import type { CadNameCodepage, CadPreviewViewerConfig } from "../fileApi";
import { apiFetch, redirectToLogin } from "../api";
import { useT } from "../i18n";

function savedNameCodepage(key: string): CadNameCodepage {
  try { return sessionStorage.getItem(key) === "UTF8" ? "UTF8" : "GB"; } catch { return "GB"; }
}

/** The isolated frame runs the pinned independent ViewerSession; no CAD rules live here. */
export function CadModelViewer({ viewer, name, onClose, onDownload, onRetry }: {
  viewer: CadPreviewViewerConfig;
  name: string;
  onClose: () => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const startedAt = useRef(performance.now());
  const [readyMs, setReadyMs] = useState<number | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameTimedOut, setFrameTimedOut] = useState(false);
  const [exportError, setExportError] = useState(false);
  const nameKey = `ll.cad.nameCodepage:${viewer.fileId}:${viewer.versionId}`;
  const [nameChoice, setNameChoice] = useState<{ key: string; value: CadNameCodepage } | null>(null);
  const nameCodepage = nameChoice?.key === nameKey ? nameChoice.value : savedNameCodepage(nameKey);
  const viewId = useMemo(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""), [viewer.fileId, viewer.versionId, nameCodepage]);
  const query = new URLSearchParams({ platform: "1", autoload: "0", fileId: viewer.fileId, versionId: viewer.versionId, viewId, engineVersion: viewer.engineVersion, nameCodepage });
  useEffect(() => { startedAt.current = performance.now(); setReadyMs(null); setFrameLoaded(false); setFrameTimedOut(false); }, [viewId]);
  useEffect(() => {
    if (frameLoaded) return;
    const timer = window.setTimeout(() => setFrameTimedOut(true), 30000);
    return () => window.clearTimeout(timer);
  }, [frameLoaded, viewId]);
  const sendContext = () => frame.current?.contentWindow?.postMessage({ type: "cad-context", name }, window.location.origin);
  useEffect(() => {
    const exportReport = async (report: unknown, name: string) => {
      const response = await apiFetch(`/api/v1/files/${encodeURIComponent(viewer.fileId)}/preview?versionId=${encodeURIComponent(viewer.versionId)}`);
      if (!response.ok) throw new Error("File access unavailable");
      const entry: unknown = await response.json();
      if (typeof entry !== "object" || entry === null || !("versionId" in entry) || entry.versionId !== viewer.versionId) throw new Error("File version mismatch");
      const output = { format: "libiaolink-cad-report/1", fileId: viewer.fileId, versionId: viewer.versionId, sourceSHA256: viewer.sourceSHA256, engineVersion: viewer.engineVersion, report };
      const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = name.split(/[\\/]/).at(-1) || "cad-report.json";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError(false);
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return;
      if (event.data.type === "cad-close") onClose();
      if (event.data.type === "cad-auth-expired") { onClose(); redirectToLogin(); }
      if (event.data.type === "cad-download") onDownload();
      if (event.data.type === "cad-retry") onRetry();
      if (event.data.type === "cad-context-request") frame.current?.contentWindow?.postMessage({ type: "cad-context", name }, window.location.origin);
      if (event.data.type === "cad-mounted" && "viewId" in event.data && event.data.viewId === viewId) { setFrameLoaded(true); setFrameTimedOut(false); }
      if (event.data.type === "cad-ready" && "viewId" in event.data && event.data.viewId === viewId) setReadyMs(Math.round(performance.now() - startedAt.current));
      if (event.data.type === "cad-name-codepage" && "value" in event.data && (event.data.value === "UTF8" || event.data.value === "GB")) {
        try { sessionStorage.setItem(nameKey, event.data.value); } catch { /* The current preview still works without storage. */ }
        setNameChoice({ key: nameKey, value: event.data.value });
      }
      if (event.data.type === "cad-export" && "report" in event.data && "name" in event.data && typeof event.data.name === "string") {
        void exportReport(event.data.report, event.data.name).catch(() => setExportError(true));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onClose, onDownload, onRetry, name, viewer.fileId, viewer.versionId, viewer.sourceSHA256, viewer.engineVersion, viewId, nameKey]);
  if (crypto.subtle === undefined) return <div role="alert" className="rounded-xl bg-white p-8 text-sm text-zinc-600">请通过 HTTPS 打开 CAD 在线预览，或下载原文件查看。</div>;
  return <div data-cad-ready-ms={readyMs} className="relative" onClick={(event) => event.stopPropagation()}>
    <iframe ref={frame} title={name} data-file-preview-cad="true" tabIndex={0}
    src={"/cad-viewer/index.html?" + query}
    onLoad={() => { setFrameLoaded(true); setFrameTimedOut(false); sendContext(); }}
    className="block h-[92dvh] w-[min(1440px,96vw)] rounded-xl border-0 bg-white shadow-2xl max-sm:h-[96dvh] max-sm:w-[98vw] max-sm:rounded-lg"
    />
    {frameLoaded ? null : (
      <div
        data-cad-viewer-loading="true"
        role={frameTimedOut ? "alert" : "status"}
        aria-live="polite"
        className={(frameTimedOut ? "pointer-events-auto" : "pointer-events-none") + " absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-white text-sm text-zinc-500 shadow-2xl max-sm:rounded-lg"}
      >
        {frameTimedOut ? (
          <>
            <span className="font-medium text-zinc-700">预览加载超时</span>
            <span className="max-w-[min(28rem,80vw)] text-center text-xs text-zinc-500">可能是网络较慢或登录状态已失效，请重试；仍无法打开可下载原文件。</span>
            <span className="max-w-[min(28rem,80vw)] truncate px-6 text-xs text-zinc-400">{name}</span>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(); }} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white">重试</button>
              <button type="button" onClick={(event) => { event.stopPropagation(); onDownload(); }} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700">{t("fpv.download")}</button>
              <button type="button" onClick={(event) => { event.stopPropagation(); redirectToLogin(); }} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700">重新登录</button>
            </div>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-emerald-600" />
            <span>{t("common.loading")}</span>
            <span className="max-w-[min(28rem,80vw)] truncate px-6 text-xs text-zinc-400">{name}</span>
          </>
        )}
      </div>
    )}
    {exportError ? <p role="alert" className="absolute bottom-3 left-3 rounded bg-white px-3 py-2 text-sm text-red-700">清单导出失败，请确认文件访问权限后重试。</p> : null}
  </div>;
}
