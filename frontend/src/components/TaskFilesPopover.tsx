import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ensurePreviewOutcome, fetchDownloadUrl, previewKindOf, triggerDownload, type FilePreviewKind, type PreviewViewerConfig, type TaskFileRef } from "../fileApi";
import { FilePreviewOverlay } from "./FilePreviewOverlay";
import { FileTypeIcon } from "./FileTypeIcon";
import { RowDeleteButton } from "./RowDeleteButton";
import { usePopover } from "./usePopover";
import { useT } from "../i18n";

/** 任务列表「文件」列下拉（Push 246 · 业务口径 2026-10-08「这里点击后出现右侧下拉框吧 最上方是添加文件
 *  下方是已有文件 点击即可预览 也有删除按钮」）：
 *  - 触发器 = 「文件」列胶囊（内容沿用「文件名 + +N」/「N 份」/「—」，液态玻璃样式与行内可编辑单元格同款）；
 *  - 下拉优先贴右侧展开（放不下自动回落上下 —— usePopover placement "right" 口径）：
 *    顶部一行 = 「＋ 添加文件」/「＋ 添加定档文件」（Push 251 改版：点哪个直接开选文件框、不再出一问——业务口径「这里直接取消按钮 直接在最上方改 改成 添加定档文件 和添加文件 在一行上」+「添加文件放前 定档文件放后 按钮」；上传中两个入口禁用、行尾「上传中 N/M」）+ 已有文件清单（服务端默认序 = 最新在前）；
 *  - 点文件名 = 预览（与详情抽屉同一套两通道裁决 + FilePreviewOverlay：图片大图 / PDF iframe /
 *    Office·文本 ONLYOFFICE 查看器外壳；R5 降级在同一下拉内出一行灰字提示）；
 *  - 行尾「删除」= 与任务表行删除**同款胶囊**（业务口径 2026-10-08「和胶囊的一样」—— 复用 RowDeleteButton：
 *    随行悬停浮现 24px 幽灵态、悬停按钮展开 48px 红胶囊「删除」，动效一致）→ 行内二次确认「确认删除 / 取消」，
 *    第二下才移入回收站（M4-02）；任务已定档 = 删除入口整体下架（Push 260 · 业务口径「定档后还能删除是bug
 *    不能删除定档后」—— 服务端 recycle 同闸 409 TASK_FINALIZED，修改走变更）；
 *  - 定档入口（Push 249 → Push 251 改版 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」→
 *    「这里直接取消按钮 直接在最上方改 改成 添加定档文件 和添加文件 在一行上」+「添加文件放前 定档文件放后 按钮」）：顶部并排两钮，
 *    「＋ 添加文件」在前 = 普通 draft 直传、「＋ 添加定档文件」在后 = 直接开选文件框、传完即对该文件定档（files.finalize），
 *    任务随文件定档一并锁定（服务端同事务）：此后任务不支持任何修改、修改走变更（两者都不再出一问、无取消按钮）；
 *    任务已定档（taskFinalized）时两个添加入口关闭并落一行提示、下拉顶出常驻提示（文案含「删除」口径）、删除入口下架；
 *  - Push 248 的行尾「替换」入口已在 Push 251 撤销（业务口径「取消这个替换按钮」）：入口与整套替换流程整体撤除 ——
 *    接口层保留（fileApi.replaceFileContent 未接线，服务端变更通道不动）；
 *  - 上传 / 进度 / 删除确认都托管在本组件：关掉下拉后台上传继续、重开还在；预览打开时收起下拉；
 *  - 点击冒泡（2026-10-08 修正 · 业务口径「点击这部分内容现在抽屉也会出来 是bug」）：portal 的 click 按 **React 树**冒泡 ——
 *    根节点拦一道 stopPropagation，点下拉里的空白 / 图标 / 提示条不再冒到任务行（行点击 = 开详情抽屉）。 */
export function TaskFilesPopover({ taskId, taskTitle, files, onUpload, onDelete, taskFinalized = false, children }: {
  taskId: string;
  taskTitle: string;
  files: readonly TaskFileRef[];
  onUpload?: (taskId: string, files: File[], onProgress?: (done: number, total: number) => void, finalize?: boolean) => Promise<void>;
  onDelete?: (fileId: string) => Promise<void>;
  /** 任务定档（Push 249 · 业务口径「若是则上传文件后该任务定档不支持任何修改」）：true = 该任务已定档 ——
   *  两个添加入口关闭（服务端 409 TASK_FINALIZED），下拉顶出常驻提示。 */
  taskFinalized?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const measuredHeight = Math.min(430, 84 + Math.max(files.length, 1) * 30);
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(276, measuredHeight, "right");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [finalizeUpload, setFinalizeUpload] = useState(false);
  const [finalizeNote, setFinalizeNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
    name: string;
    kind: FilePreviewKind;
    fileId: string;
    nonce: number;
  } | null>(null);

  /** 选完文件 → 交调用方分片直传（关联本任务；finalize = 定档上传 —— 传完即定档、任务连带锁定）；
   *  关掉下拉后台上传继续（进度状态留在本组件）。 */
  const beginFileUpload = (picked: FileList | null) => {
    if (picked === null || onUpload === undefined) {
      return;
    }
    const list = Array.from(picked);
    if (list.length === 0) {
      return;
    }
    const finalize = finalizeUpload;
    setFinalizeUpload(false);
    setUploading({ done: 0, total: list.length });
    void onUpload(taskId, list, (done, total) => {
      setUploading({ done, total });
    }, finalize).finally(() => {
      setUploading(null);
    });
  };

  /** 点顶部「＋ 添加文件」/「＋ 添加定档文件」（Push 251 改版 · 业务口径「这里直接取消按钮 直接在最上方改 改成 添加定档文件
   *  和添加文件 在一行上」+「添加文件放前 定档文件放后 按钮」）：两者都直接开选文件框、不再出定档一问（无取消按钮）—— 普通版 =
   *  普通 draft 直传、定档版 finalize = true（传完即定档、任务连带锁定）；任务已定档 = 直接出提示（服务端同口径 409 TASK_FINALIZED）。 */
  const beginAddFlow = (finalize: boolean) => {
    setPreviewNote(null);
    setPendingDelete(null);
    if (taskFinalized) {
      setFinalizeNote(t("files.finalizedNote"));
      return;
    }
    setFinalizeNote(null);
    setFinalizeUpload(finalize);
    inputRef.current?.click();
  };

  /** 点文件名 = 预览（两通道裁决同详情抽屉；取不到 → 下拉内一行灰字降级，不弹浮层）。 */
  const openPreview = async (fileId: string, name: string) => {
    if (previewing !== null) {
      return;
    }
    setPreviewing(fileId);
    setPreviewNote(null);
    const outcome = await ensurePreviewOutcome(fileId);
    setPreviewing(null);
    if (outcome.kind === "unavailable") {
      setPreviewNote(outcome.reason ?? t("drawer.preview.unavailable"));
      return;
    }
    const kind = previewKindOf(name) ?? "image";
    setPreview(outcome.kind === "viewer"
      ? { pane: { mode: "viewer", viewer: outcome.viewer }, name, kind, fileId, nonce: 0 }
      : { pane: { mode: "url", url: outcome.url }, name, kind, fileId, nonce: 0 });
    setOpen(false);
  };

  /** 查看器外壳「重试」（R5）：重取配置 + nonce 自增强制重建；仍取不到 → 关浮层 + 下拉一行降级提示。 */
  const retryPreview = async (fileId: string, name: string) => {
    setPreviewing(fileId);
    const outcome = await ensurePreviewOutcome(fileId);
    setPreviewing(null);
    if (outcome.kind === "unavailable") {
      setPreview(null);
      setPreviewNote(outcome.reason ?? t("drawer.preview.unavailable"));
      return;
    }
    setPreview((previous) => {
      if (previous === null || previous.fileId !== fileId) {
        return previous;
      }
      const pane = outcome.kind === "viewer"
        ? { mode: "viewer" as const, viewer: outcome.viewer }
        : { mode: "url" as const, url: outcome.url };
      return { pane, name, kind: previous.kind, fileId, nonce: previous.nonce + 1 };
    });
  };

  /** 浮层 caption「下载原文件」（与抽屉同口径：attachment 签名直取原文件；失败在下拉里留一行提示）。 */
  const downloadFile = async (fileId: string) => {
    try {
      const signed = await fetchDownloadUrl(fileId);
      await triggerDownload(signed.url, signed.fileName);
    } catch (error) {
      setPreviewNote(error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed"));
    }
  };

  /** 删除（同一行内二次确认；调用方走回收站 + 整表重取，失败提示由调用方统一写入出口）。 */
  const confirmDelete = (fileId: string) => {
    setPendingDelete(null);
    if (onDelete !== undefined) {
      void onDelete(fileId);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-cell-action="task-files"
        title={files.length === 0 ? t("files.emptyTitle") : t("files.manageTitle")}
        aria-label={t("files.aria", { name: taskTitle })}
        onClick={(event) => {
          // 「文件」列整格是管理入口：点击不冒泡到行（行点击 = 打开详情抽屉）
          event.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
        className="inline-flex max-w-full items-center gap-1 rounded-lg border border-zinc-200/90 bg-white/75 px-1.5 py-[3px] text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-[3px] transition hover:border-zinc-300 hover:bg-white hover:shadow-[0_2px_6px_rgba(15,23,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/15 disabled:cursor-not-allowed"
      >
        {uploading !== null ? (
          <span className="tabular-nums text-zinc-500">
            {uploading.done === 0 ? t("drawer.files.uploading") : t("drawer.files.uploadingCount", { done: uploading.done, total: uploading.total })}
          </span>
        ) : (
          children
        )}
      </button>
      {open && position !== null ? createPortal(
        <div
          ref={popoverRef}
          data-task-files-popover="true"
          style={{ top: position.top, left: position.left, width: position.width }}
          onClick={(event) => {
            // portal 的点击按 React 树冒泡：不拦的话，点下拉里的空白 / 图标 / 提示条会冒到任务行、连带开详情抽屉（同 InlineEdit / FilePreviewOverlay 口径）
            event.stopPropagation();
          }}
          className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
        >
          <div className="flex items-center gap-1 px-2 py-1.5">
            <button
              type="button"
              data-task-files-add="true"
              onClick={() => { beginAddFlow(false); }}
              disabled={uploading !== null}
              title={t("files.addTitle")}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent"
            >
              {t("files.add")}
            </button>
            <button
              type="button"
              data-task-files-add-finalize="true"
              onClick={() => { beginAddFlow(true); }}
              disabled={uploading !== null}
              title={t("files.addFinalTitle")}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent"
            >
              {t("files.addFinal")}
            </button>
            {uploading === null ? null : (
              <span className="ml-auto text-[11px] tabular-nums text-zinc-400">
                {uploading.done === 0 ? t("drawer.files.uploading") : t("drawer.files.uploadingCount", { done: uploading.done, total: uploading.total })}
              </span>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            data-file-upload-input="true"
            data-task-files-input="true"
            className="hidden"
            aria-label={t("drawer.files.pickAria")}
            onClick={(event) => {
              // 选文件对话框关掉后浏览器会向 input 补发一次 click：拦一道，不让它冒泡出下拉（回归 Push 226 修正）
              event.stopPropagation();
            }}
            onChange={(event) => {
              beginFileUpload(event.currentTarget.files);
              // 清空 value：同一份文件再选一次仍会触发 change
              event.currentTarget.value = "";
            }}
          />
          {taskFinalized ? (
            <p data-task-files-note-finalized="true" className="border-t border-zinc-100 px-3 py-1.5 text-[11px] leading-4 text-amber-600">
              {t("drawer.files.lockedNote")}
            </p>
          ) : null}
          <div className="border-t border-zinc-100">
            {files.length === 0 ? (
              <p className="px-3 py-2.5 text-[11px] text-zinc-400">{t("drawer.files.empty")}</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto py-1">
                {files.map((file) => {
                  const confirming = pendingDelete === file.id;
                  const previewingThis = previewing === file.id;
                  return (
                    <li key={file.id} data-task-files-item="true" className="group flex min-w-0 items-center gap-1.5 px-2 py-1 transition-colors hover:bg-zinc-100">
                      <FileTypeIcon name={file.name} />
                      <button
                        type="button"
                        data-task-files-preview="true"
                        onClick={() => { void openPreview(file.id, file.name); }}
                        disabled={previewingThis}
                        title={t("files.previewTitle", { name: file.name })}
                        className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs text-zinc-700 transition-colors hover:text-zinc-900 disabled:text-zinc-400"
                      >
                        {file.name}
                      </button>
                      {previewingThis ? <span className="shrink-0 text-[10px] text-zinc-400">{t("drawer.file.previewing")}</span> : null}
                      {onDelete === undefined || taskFinalized ? null : confirming ? (
                        <span data-task-files-delete-confirm="true" className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => { confirmDelete(file.id); }}
                            className="flex h-6 shrink-0 items-center justify-center rounded-full bg-red-500 px-2.5 text-[11px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(220,38,38,0.25)] transition-colors hover:bg-red-600"
                          >
                            {t("drawer.file.deleteOk")}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setPendingDelete(null); }}
                            className="flex h-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-medium leading-none text-zinc-600 transition-colors hover:bg-zinc-200"
                          >
                            {t("drawer.file.deleteCancel")}
                          </button>
                        </span>
                      ) : (
                        <span data-task-files-delete="true" className="flex h-6 w-12 shrink-0 items-center">
                          <RowDeleteButton
                            onDelete={() => { setPendingDelete(file.id); }}
                            label={t("drawer.file.deleteAria", { name: file.name })}
                          />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {finalizeNote === null ? null : <p data-task-files-note-finalize="true" className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-amber-600">{finalizeNote}</p>}
          {previewNote === null ? null : <p data-task-files-note="true" className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">{previewNote}</p>}
        </div>,
        document.body,
      ) : null}
      {preview === null ? null : (
        <FilePreviewOverlay
          pane={preview.pane}
          name={preview.name}
          kind={preview.kind}
          nonce={preview.nonce}
          onRetry={() => { void retryPreview(preview.fileId, preview.name); }}
          onDownload={() => { void downloadFile(preview.fileId); }}
          onClose={() => { setPreview(null); }}
        />
      )}
    </>
  );
}
