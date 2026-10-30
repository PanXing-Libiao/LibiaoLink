import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useT } from "../i18n";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type LoadPhase = "loading" | "ready" | "error";
type RenderTask = { cancel: () => void };
let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsPromise === null) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((module) => {
        module.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        return module;
      })
      .catch((error: unknown) => {
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PDF 本地查看器：签名原件交给 PDF.js，不再经过 ONLYOFFICE 冷启动。
 * 单页渲染 + 上一页 / 下一页，按容器宽度和设备像素比重绘；退出时销毁加载任务与渲染任务。 */
export function PdfViewer({ src, name, onRetry }: { src: string; name: string; onRetry: () => void }) {
  const t = useT();
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [renderPhase, setRenderPhase] = useState<"rendering" | "ready">("rendering");
  const [detail, setDetail] = useState<string | null>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [availableWidth, setAvailableWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;
    setPhase("loading");
    setDetail(null);
    setDocumentProxy(null);
    setPageCount(0);
    setPageNumber(1);
    setRenderPhase("rendering");
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) {
          return;
        }
        const task = pdfjs.getDocument({ url: src, isEvalSupported: false, useSystemFonts: true });
        loadingTask = task;
        const loaded = await task.promise;
        if (cancelled) {
          return;
        }
        setDocumentProxy(loaded);
        setPageCount(loaded.numPages);
        setPhase("ready");
      } catch (error) {
        if (!cancelled) {
          setDetail(messageOf(error));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loadingTask !== null) {
        void loadingTask.destroy();
      }
    };
  }, [src]);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) {
      return;
    }
    const update = () => setAvailableWidth(Math.max(1, Math.floor(frame.clientWidth)));
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (documentProxy === null || availableWidth <= 0) {
      return;
    }
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setRenderPhase("rendering");
    void (async () => {
      try {
        const page = await documentProxy.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        const base = page.getViewport({ scale: 1 });
        const cssScale = availableWidth / base.width;
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const viewport = page.getViewport({ scale: cssScale * pixelRatio });
        const canvas = canvasRef.current;
        const context = canvas === null ? null : canvas.getContext("2d", { alpha: false });
        if (canvas === null || context === null) {
          throw new Error("Canvas is unavailable");
        }
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = Math.max(1, Math.floor(base.width * cssScale)) + "px";
        canvas.style.height = Math.max(1, Math.floor(base.height * cssScale)) + "px";
        const task = page.render({ canvasContext: context, viewport });
        renderTask = task;
        await task.promise;
        if (!cancelled) {
          setRenderPhase("ready");
        }
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "";
        if (!cancelled && errorName !== "RenderingCancelledException") {
          setDetail(messageOf(error));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask !== null) {
        renderTask.cancel();
      }
    };
  }, [availableWidth, documentProxy, pageNumber]);

  const goToPage = (next: number) => {
    setPageNumber(Math.min(Math.max(1, next), Math.max(1, pageCount)));
  };

  return (
    <div
      data-pdf-viewer="true"
      data-pdf-status={phase}
      aria-label={name}
      aria-busy={phase === "loading" || renderPhase === "rendering"}
      onClick={(event) => event.stopPropagation()}
      className="relative flex h-[min(80vh,calc(100dvh-128px))] w-[min(90vw,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl bg-zinc-100 shadow-2xl"
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-2 py-1.5">
        <button
          type="button"
          data-pdf-prev="true"
          disabled={pageNumber <= 1 || phase !== "ready"}
          onClick={() => goToPage(pageNumber - 1)}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("pdfv.prev")}
        </button>
        <span data-pdf-page="true" className="truncate text-center text-xs tabular-nums text-zinc-600">
          {phase === "ready" ? t("pdfv.page", { page: pageNumber, total: pageCount }) : name}
        </span>
        <button
          type="button"
          data-pdf-next="true"
          disabled={pageNumber >= pageCount || phase !== "ready"}
          onClick={() => goToPage(pageNumber + 1)}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("pdfv.next")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-2">
        <div ref={frameRef} className="mx-auto w-full min-w-0">
          <canvas ref={canvasRef} className="mx-auto block max-w-full bg-white shadow-sm" />
        </div>
      </div>
      {phase === "loading" ? (
        <div data-pdf-overlay="loading" className="absolute inset-x-0 bottom-0 top-11 flex items-center justify-center bg-zinc-100/95 px-8 text-center text-sm text-zinc-500">
          {t("pdfv.loading")}
        </div>
      ) : phase === "error" ? (
        <div data-pdf-overlay="error" role="alert" className="absolute inset-x-0 bottom-0 top-11 flex flex-col items-center justify-center gap-3 bg-white px-8 text-center">
          <p className="text-sm font-medium text-zinc-700">{t("pdfv.error")}</p>
          {detail === null ? null : <p className="max-w-md break-words text-xs leading-5 text-zinc-400">{detail.slice(0, 240)}</p>}
          <button
            type="button"
            data-pdf-retry="true"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
