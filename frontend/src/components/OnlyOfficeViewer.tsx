import { useEffect, useId, useRef, useState } from "react";
import type { OnlyOfficePreviewViewerConfig } from "../fileApi";
import { getLocale, textOf, useT } from "../i18n";

/** 查看器就绪超时（S4 · R5 / 2026-10-28 移动端修订）：api.js、DocServer 移动 UI 与文档会话全部就绪后 onDocumentReady。
 *  DocServer 查看器模板另有内建 require 超时；本轮随部署镜像延长到 120 秒，外层 90 秒先到时统一展示可重试降级。 */
const READY_TIMEOUT_MS = 90_000;

type DocEditorInstance = { destroyEditor: () => void };
type DocsApiConstructor = new (placeholderId: string, config: Record<string, unknown>) => DocEditorInstance;

declare global {
  interface Window {
    /** ONLYOFFICE 官方 api.js 的挂载点（DocEditor 构造器）。 */
    DocsAPI?: { DocEditor: DocsApiConstructor };
  }
}

/** api.js 单例加载（按 URL 缓存 Promise；失败删脚本 + 清缓存 —— 重试可重新加载）。 */
const apiScripts = new Map<string, Promise<void>>();
function loadDocsApi(scriptUrl: string): Promise<void> {
  const cached = apiScripts.get(scriptUrl);
  if (cached !== undefined) {
    return cached;
  }
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.dataset.ooApi = "true";
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      apiScripts.delete(scriptUrl);
      script.remove();
      reject(new Error(textOf(getLocale(), "oov.scriptFailed")));
    };
    document.head.appendChild(script);
  });
  apiScripts.set(scriptUrl, promise);
  return promise;
}

/**
 * DocServer onError 的 data → 面向用户的一句短文案（2026-10-10 修复「文件查看器透出原始 JSON」：
 * 此前把错误对象 JSON.stringify 原文直接塞进降级块）。错误明细留在 DocServer 日志，界面只给可读描述。
 */
function describeViewerError(data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const record = data as { errorCode?: unknown; errorDescription?: unknown };
    if (typeof record.errorDescription === "string") {
      const plain = record.errorDescription
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (plain.length > 0) {
        return plain.length > 120 ? plain.slice(0, 120) + "…" : plain;
      }
    }
    if (record.errorCode !== undefined) {
      return textOf(getLocale(), "oov.errorCode", { code: String(record.errorCode) });
    }
  }
  return textOf(getLocale(), "oov.unavailable");
}

/**
 * ONLYOFFICE 查看器外壳（计划 S4 · R5）：加载 api.js → 以服务端下发的 document（含 permissions · Push 258 错层修正）/ editorConfig + token 逐字初始化 DocEditor。
 * 状态机（data-oo-status，供回放探测）：loading → ready / error / timeout。
 * - 只读：documentType / document（含 permissions）/ editorConfig / token 逐字传（JWT 绑定字段不改写；events 是本地回调、不参与签名）；
 *   权限段嵌 document —— ONLYOFFICE api.js 只认该位置（顶层会被忽略、按默认值渲染）；download 图标保持可见、不加新按钮，
 *   点击由浮层透明命中层在原位接管 → 我方原文件下载链（DocServer 内置下载对 .doc/.xls 只能转 PDF，跨域改不了其逻辑）；
 * - 降级（R5）：加载失败 / onError / 超时 → 「暂无在线预览」+「重试」（父级重取配置 + nonce 自增重建）；「下载原文件」由浮层 caption 提供；
 * - 卸载（含重试重建）：destroyEditor —— 不留 DocServer 侧会话；
 * - 关闭（2026-10-10 修复「点击 iframe 内部后 Esc 关不掉」）：焦点守卫把被 iframe 抢走的焦点拉回包装层 —— Esc 回到浮层 capture 监听，见守卫段注释。
 */
export function OnlyOfficeViewer({ viewer, onRetry }: { viewer: OnlyOfficePreviewViewerConfig; onRetry: () => void }) {
  const t = useT();
  const rawId = useId();
  const placeholderId = "oo-viewer-" + rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "timeout">("loading");
  const [detail, setDetail] = useState<string | null>(null);
  const editorRef = useRef<DocEditorInstance | null>(null);
  // 焦点守卫（2026-10-10 修复「点击 iframe 内部后 Esc 关不掉」）：查看器 iframe 跨域，键盘落在其中时宿主页面
  // 的 capture 监听收不到；实测 DocServer 9.4 view 配置下 Esc 也不会回落 onRequestClose，只能宿主侧兜住 ——
  // 轻量轮询发现焦点被该 iframe 抢走即拉回包装层（tabIndex=-1），Esc 回到浮层监听；只在 activeElement 恰为
  // 本 iframe 时动作（不影响浮层其他控件），滚轮按指针命中、不受影响。
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (root !== null && active instanceof HTMLIFrameElement && root.contains(active)) {
        root.focus({ preventScroll: true });
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeoutTimer = window.setTimeout(() => {
      setStatus((current) => (current === "loading" ? "timeout" : current));
    }, READY_TIMEOUT_MS);
    loadDocsApi(viewer.docServerUrl + "/web-apps/apps/api/documents/api.js")
      .then(() => {
        if (cancelled) {
          return;
        }
        const docsApi = window.DocsAPI;
        if (docsApi === undefined) {
          throw new Error(t("oov.notMounted"));
        }
        editorRef.current = new docsApi.DocEditor(placeholderId, {
          width: "100%",
          height: "100%",
          documentType: viewer.documentType,
          document: viewer.document,
          editorConfig: viewer.editorConfig,
          token: viewer.token,
          events: {
            onDocumentReady: () => {
              if (!cancelled) {
                setStatus("ready");
              }
            },
            onError: (event: { data?: unknown }) => {
              if (cancelled) {
                return;
              }
              setDetail(describeViewerError(event.data));
              setStatus("error");
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetail(error instanceof Error ? error.message : String(error));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutTimer);
      const editor = editorRef.current;
      editorRef.current = null;
      if (editor !== null) {
        try {
          editor.destroyEditor();
        } catch {
          // 卸载路径允许「编辑器已销毁 / 未完成初始化」：不抛。
        }
      }
    };
  }, [placeholderId, viewer]);

  return (
    <div
      ref={rootRef}
      data-onlyoffice-viewer="true"
      data-oo-status={status}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
      }}
      className="relative h-[80vh] w-[min(90vw,calc(100vw-3rem))] overflow-hidden rounded-xl bg-white shadow-2xl outline-none"
    >
      <div id={placeholderId} className="h-full w-full" />
      {status === "loading" ? (
        <span data-oo-loading="true" className="absolute inset-0 flex items-center justify-center bg-white text-xs text-zinc-400">
          {t("oov.loading")}
        </span>
      ) : status === "ready" ? null : (
        <div data-oo-fallback="true" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white px-10 text-center">
          <p className="text-sm font-medium text-zinc-700">{status === "timeout" ? t("oov.timeout") : t("oov.noPreview")}</p>
          <p className="max-w-md text-xs leading-5 text-zinc-400">{detail ?? t("oov.unavailable")}</p>
          <button
            type="button"
            data-oo-retry="true"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs text-zinc-600 transition hover:bg-zinc-50 hover:text-zinc-900"
          >
            {t("common.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
