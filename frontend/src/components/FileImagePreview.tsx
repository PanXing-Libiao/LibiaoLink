import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { ImageZoomViewer } from "./ImageZoomViewer";

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; src: string }
  | { kind: "error"; detail: string | null };

const IMAGE_LOAD_TIMEOUT_MS = 60_000;

function errorDetail(error: unknown): string | null {
  if (!(error instanceof Error) || error.message === "") {
    return null;
  }
  return error.message.length > 240 ? error.message.slice(0, 240) + "…" : error.message;
}

/** 文件预览图片：先把签名地址取成 Blob，再交给 img 解码。
 *  移动浏览器对直接挂在 img 上的长签名 URL 可能不发请求或静默丢图；改为同源 fetch 后，
 *  字节、MIME 与超时都可观测，失败时给出明确错误与重试，不再只显示破图图标。 */
export function FileImagePreview({ src, alt, onRetry }: { src: string; alt: string; onRetry: () => void }) {
  const t = useT();
  const [state, setState] = useState<ImageState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    let timedOut = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IMAGE_LOAD_TIMEOUT_MS);
    setState({ kind: "loading" });
    void fetch(src, { signal: controller.signal, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error("Empty image response");
        }
        if (blob.type !== "" && !blob.type.startsWith("image/")) {
          throw new Error("Unexpected content type: " + blob.type);
        }
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ kind: "ready", src: objectUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            detail: timedOut ? "Image request timed out" : errorDetail(error),
          });
        }
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  if (state.kind === "ready") {
    return (
      <div data-file-image-preview="true" data-file-image-status="ready" className="contents">
        <ImageZoomViewer src={state.src} alt={alt} />
      </div>
    );
  }

  return (
    <div
      data-file-image-preview="true"
      data-file-image-status={state.kind}
      role={state.kind === "error" ? "alert" : "status"}
      onClick={(event) => event.stopPropagation()}
      className="flex min-h-48 w-[min(32rem,calc(100vw-3rem))] flex-col items-center justify-center gap-3 rounded-xl bg-white p-8 text-center shadow-2xl"
    >
      {state.kind === "loading" ? (
        <p className="text-sm text-zinc-500">{t("imgv.loading")}</p>
      ) : (
        <>
          <p className="text-sm font-medium text-zinc-700">{t("imgv.error")}</p>
          {state.detail === null ? null : <p className="max-w-md break-words text-xs leading-5 text-zinc-400">{state.detail}</p>}
          <button
            type="button"
            data-file-image-retry="true"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            {t("common.retry")}
          </button>
        </>
      )}
    </div>
  );
}
