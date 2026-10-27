import { useEffect, useMemo, useRef, useState } from "react";
import type { CadInputSelection, CadNameCodepage, CadPreviewViewerConfig } from "../fileApi";
import { apiFetch } from "../api";
import { CadResourcePicker } from "./CadResourcePicker";

function savedNameCodepage(key: string): CadNameCodepage {
  try { return sessionStorage.getItem(key) === "UTF8" ? "UTF8" : "GB"; } catch { return "GB"; }
}

/** The isolated frame runs the pinned independent ViewerSession; no CAD rules live here. */
export function CadModelViewer({ viewer, name, onClose, onDownload }: {
  viewer: CadPreviewViewerConfig;
  name: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const startedAt = useRef(performance.now());
  const [readyMs, setReadyMs] = useState<number | null>(null);
  const [exportError, setExportError] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [selection, setSelection] = useState<CadInputSelection>({ companions: [] });
  const [retry, setRetry] = useState(0);
  const selectionKey = JSON.stringify(selection);
  const nameKey = `ll.cad.nameCodepage:${viewer.fileId}:${viewer.versionId}`;
  const [nameChoice, setNameChoice] = useState<{ key: string; value: CadNameCodepage } | null>(null);
  const nameCodepage = nameChoice?.key === nameKey ? nameChoice.value : savedNameCodepage(nameKey);
  const viewId = useMemo(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""), [viewer.fileId, viewer.versionId, nameCodepage, selectionKey, retry]);
  const query = new URLSearchParams({ platform: "1", autoload: "0", format: viewer.format, fileId: viewer.fileId, versionId: viewer.versionId, viewId, engineVersion: viewer.engineVersion, nameCodepage });
  useEffect(() => { startedAt.current = performance.now(); setReadyMs(null); }, [viewId]);
  const sendContext = () => frame.current?.contentWindow?.postMessage({ type: "cad-context", name, selection }, window.location.origin);
  useEffect(() => {
    const exportReport = async (report: unknown, name: string, jobId: string) => {
      const response = await apiFetch(`/api/v1/files/${encodeURIComponent(viewer.fileId)}/versions/${encodeURIComponent(viewer.versionId)}/cad/views/${viewId}/jobs/${jobId}`);
      if (!response.ok) throw new Error("File access unavailable");
      const entry: unknown = await response.json();
      if (typeof entry !== "object" || entry === null || !("id" in entry) || entry.id !== jobId
        || !("sourceSHA256" in entry) || entry.sourceSHA256 !== viewer.sourceSHA256
        || !("state" in entry) || !["completed", "partial"].includes(String(entry.state))) throw new Error("CAD input set unavailable");
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
      if (event.data.type === "cad-download") onDownload();
      if (event.data.type === "cad-retry") setRetry((value) => value + 1);
      if (event.data.type === "cad-resources" && viewer.format === "DXF") setResourcesOpen(true);
      if (event.data.type === "cad-context-request") frame.current?.contentWindow?.postMessage({ type: "cad-context", name, selection }, window.location.origin);
      if (event.data.type === "cad-ready" && "viewId" in event.data && event.data.viewId === viewId) setReadyMs(Math.round(performance.now() - startedAt.current));
      if (event.data.type === "cad-name-codepage" && "value" in event.data && (event.data.value === "UTF8" || event.data.value === "GB")) {
        try { sessionStorage.setItem(nameKey, event.data.value); } catch { /* The current preview still works without storage. */ }
        setNameChoice({ key: nameKey, value: event.data.value });
      }
      if (event.data.type === "cad-export" && "report" in event.data && "name" in event.data && typeof event.data.name === "string"
        && "jobId" in event.data && typeof event.data.jobId === "string" && /^[a-f0-9]{32}$/.test(event.data.jobId)) {
        void exportReport(event.data.report, event.data.name, event.data.jobId).catch(() => setExportError(true));
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onClose, onDownload, name, viewer.fileId, viewer.versionId, viewer.sourceSHA256, viewer.engineVersion, viewer.format, viewId, nameKey, selection]);
  if (crypto.subtle === undefined) return <div role="alert" className="rounded-xl bg-white p-8 text-sm text-zinc-600">请通过 HTTPS 打开 CAD 在线预览，或下载原文件查看。</div>;
  return <div data-cad-ready-ms={readyMs} className="relative" onClick={(event) => event.stopPropagation()}>
    <iframe ref={frame} key={viewId} title={name} data-file-preview-cad="true" tabIndex={0}
    src={"/cad-viewer/index.html?" + query}
    onLoad={sendContext}
    className="block h-[92dvh] w-[min(1440px,96vw)] rounded-xl border-0 bg-white shadow-2xl max-sm:h-[96dvh] max-sm:w-[98vw] max-sm:rounded-lg"
    />
    {resourcesOpen ? <CadResourcePicker projectId={viewer.projectId} fileId={viewer.fileId} name={viewer.sourceName} selection={selection}
      onClose={() => setResourcesOpen(false)} onApply={(value) => { setSelection(value); setResourcesOpen(false); }} /> : null}
    {exportError ? <p role="alert" className="absolute bottom-3 left-3 rounded bg-white px-3 py-2 text-sm text-red-700">清单导出失败，请确认文件访问权限后重试。</p> : null}
  </div>;
}
