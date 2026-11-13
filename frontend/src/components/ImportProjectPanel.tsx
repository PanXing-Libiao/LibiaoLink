import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api";
import { DICT_ACCENT_PALETTE, accentOfItem, dictLabel, type Dicts } from "../dicts";
import type { DictTools } from "../dictTools";
import { fieldText, projectTypeText, stageText, useLocale, useT } from "../i18n";
import { stageNameOf } from "../taskApi";
import {
  attachManualChangeFile,
  commitProjectImport,
  IMPORT_MAX_FILE_BYTES,
  previewProjectImport,
  type ImportIssue,
  type ImportManualImage,
  type ImportManualTarget,
  type ImportTaskNode,
  type ProjectImportPreview,
  type ProjectImportResult,
} from "../importApi";
import { uploadFile } from "../fileApi";
import { DictSelect } from "./DictSelect";
import { RegionSelect } from "./RegionSelect";
import { ScrollArea } from "./ScrollArea";
import { SelectMenu } from "./SelectMenu";
import { useFocusTrap } from "./useFocusTrap";

/**
 * 「导入项目」大屏面板（Push 316 待推 · 业务口径 2026-10-14「先在新建项目左侧加导入项目按钮 点击导入选择 Excel
 * 然后不切换页面 直接在项目空间里面有一块大屏里面操作」+ 同轮选型「直连 API 导入」）：
 * 选文件 → ① 解析（不写库）→ ② 校验预览（项目落位 / 条数统计 / 提醒清单 / 需手动导入文件 / 账号 / 未匹配节点）
 * → ③ 确认导入 → ④ 完成（提醒复述）。面板挂在项目空间内（fixed 全屏遮罩），不动路由、不刷新页面。
 * 口径（业务已回执）：解析不写库；完成日期未填不算完成；进度五档（进行中封顶 75%）；日期笔误照原值 + 提醒；
 * 名称一致自动复用；AI 建议逐条选择，保留原名可加入个人模板；微盘图片出清单人工上传。
 * 写入中可取消（Push 321）：「取消写入」/ 刷新 / 关页 = 断开请求 → 服务端单事务回滚（零残留），票据保留可再次确认。
 * 干系人（Push 324）：「干系人」表随导入落台账。
 * 手动文件就地补传（Push 396）：预览清单每行可选本地文件，确认导入后按提交结果的任务 / 变更目标一并直传；失败可重试。
 * 加载文案（业务口径 2026-10-14「项目在导入那个时间改成预计要多久」）：加载态从「已用 N 秒」改「还需要多长时间：N 秒」，并按墙钟已用时间每秒递减；文案口径「还需要  N 秒」（未完成前保底 1 秒）。
 * 公共节点申请（业务口径 2026-11-13「给一个申请的渠道，那边能够申请加入公共，然后让管理员审核」）：
 * 保留 Excel 原名的阶段内节点可以顺带申请加入公共节点库（与个人模板互相独立）；申请不改节点库、不阻塞导入，
 * 管理员在任务模板页审核通过后才落公共节点；完成页复述本次提交的申请条数与前几条名称。
 */

/** 一个补充附件未完成（上传失败，或已上传但变更回挂失败）。 */
type ManualUploadFailure = {
  id: string;
  name: string;
  message: string;
  /** 还没传成功 = 保留 File；已传成功但回挂失败 = null（重试只重挂）。 */
  file: File | null;
  fileId: string | null;
  changeId: string | null;
};

/** 补充附件上传结果（完成页复述；失败项可重试）。 */
type ManualUploadOutcome = {
  total: number;
  completedIds: string[];
  failures: ManualUploadFailure[];
};

/** 一项待上传的补充附件（id = 预览清单 id；fileId 给出 = 只重挂变更）。 */
type ManualUploadItem = { id: string; name: string; file: File | null; fileId: string | null };

type NodeCategory = "ai" | "pending";

type Phase =
  | { kind: "parsing" }
  | { kind: "preview"; preview: ProjectImportPreview }
  | { kind: "committing"; preview: ProjectImportPreview }
  | {
      kind: "uploading";
      preview: ProjectImportPreview;
      result: ProjectImportResult;
      total: number;
      done: number;
      currentName: string;
    }
  | { kind: "done"; preview: ProjectImportPreview; result: ProjectImportResult; upload: ManualUploadOutcome }
  | { kind: "failed"; stage: "parse" | "commit"; error: ApiError | null; reason: "empty" | "size" | null };

export type ImportProjectPanelProps = {
  /** 待导入的 Excel（父层文件选择器给；引用变化 = 重新解析）。 */
  file: File;
  /** 字典（项目地区选择小窗用）。 */
  dicts: Dicts;
  /** 字典工具（项目类型「＋ 添加项目类型」用；口径同新建项目弹窗）。 */
  dictTools: DictTools;
  /** 是否可管理字典（dict.manage；控制项目类型「新建」入口显隐）。 */
  canManageDicts: boolean;
  /** 重新选择文件（父层点同一个隐藏 input；选中后本面板自动重新解析）。 */
  onReselect: () => void;
  /** 关闭面板（父层清空已选文件）。 */
  onClose: () => void;
  /** 导入成功（父层刷新项目列表）。 */
  onImported: () => void;
};

/** 文件大小展示（KB / MB / B）。 */
function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    return (size / (1024 * 1024)).toFixed(1) + " MB";
  }
  if (size >= 1024) {
    return Math.round(size / 1024) + " KB";
  }
  return size + " B";
}

/**
 * 预计时长（业务口径 2026-10-14「项目在导入那个时间改成预计要多久」）：解析按文件大小估；
 * 写入按文件大小 + 图片数估（真机口径参考：61.4 MB / 151 张内嵌图导入表约 35 秒）。
 */
function estimateParseSeconds(size: number): number {
  return Math.max(2, Math.round((size / (1024 * 1024)) * 0.12 + 3));
}
function estimateCommitSeconds(size: number, imageCount: number): number {
  return Math.max(5, Math.round((size / (1024 * 1024)) * 0.1 + imageCount * 0.15 + 5));
}

/**
 * 动态剩余秒数（业务口径 2026-10-15「这个时间要变化的不能不动」）：按预估总耗时减墙钟已用秒数，
 * 每秒刷新；未完成前保底 1 秒，避免贴着完成点显示 0 秒。
 */
function useImportRemainingSeconds(estimatedSeconds: number, active: boolean): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, estimatedSeconds]);
  return Math.max(1, estimatedSeconds - elapsedSeconds);
}

/** 提醒等级配色（预览与完成页复述共用）。 */
const ISSUE_STYLE: Record<ImportIssue["level"], string> = {
  error: "border-rose-200 bg-rose-50 text-rose-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-zinc-200 bg-zinc-100 text-zinc-600",
};

const ISSUE_LEVEL_KEY: Record<ImportIssue["level"], "import.issues.level.error" | "import.issues.level.warning" | "import.issues.level.info"> = {
  error: "import.issues.level.error",
  warning: "import.issues.level.warning",
  info: "import.issues.level.info",
};

/** 一条提醒：等级徽标 + 文案 + 源表行号 / 关联对象。 */
function IssueRow({ issue }: { issue: ImportIssue }) {
  const t = useT();
  const meta: string[] = [];
  if (issue.row !== null) {
    meta.push(t("import.issues.row", { row: issue.row }));
  }
  if (issue.subject !== null && issue.subject !== "") {
    meta.push(issue.subject);
  }
  return (
    <li className="flex items-start gap-2 border-b border-zinc-100 py-2 last:border-b-0">
      <span className={"mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium " + ISSUE_STYLE[issue.level]}>
        {t(ISSUE_LEVEL_KEY[issue.level])}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-5 text-zinc-700">{issue.message}</span>
        {meta.length === 0 ? null : <span className="mt-0.5 block text-[11px] text-zinc-400">{meta.join(" · ")}</span>}
      </span>
    </li>
  );
}

/** 条数统计格。 */
function StatTile({ label, value, caption }: { label: string; value: number; caption?: string }) {
  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 px-3 py-2.5">
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-zinc-900" data-import-stat="">{value}</dd>
      {caption === undefined ? null : <p className="mt-0.5 text-[11px] text-amber-700">{caption}</p>}
    </div>
  );
}

/**
 * 加载动画（业务口径 2026-10-14「导入的时间加载时间动画用之前那个导出 pdf 的」）：与导出 PDF 等待浮层同款 ——
 * 品牌小车沿流动虚线路面循环前进（复用 app.css 的 export-progress__* 样式；该组样式不依赖浮层祖先，面板内可直接用）。
 */
function ImportCarStage() {
  return (
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
  );
}

type ManualImageListProps = {
  images: ImportManualImage[];
  /** 预览态：已选文件（id → File）。 */
  selections?: Readonly<Record<string, File>>;
  /** 预览态：选择 / 清除（不给 = 只读完成页）。 */
  onSelect?: (id: string, file: File | null) => void;
  /** 完成页：失败原因（id → message）。 */
  failureById?: Readonly<Record<string, string>>;
};

/** 「需手动导入」文件清单（预览与完成页共用）：可原地选文件，确认导入后一并上传。 */
function ManualImageList({ images, selections, onSelect, failureById }: ManualImageListProps) {
  const t = useT();
  return (
    <ul className="mt-3 max-h-72 space-y-2 overflow-auto">
      {images.map((image) => {
        const selected = selections?.[image.id] ?? null;
        const failure = failureById?.[image.id] ?? null;
        return (
          <li key={image.id} className="rounded-xl bg-white/85 px-3 py-2.5 text-xs ring-1 ring-amber-100">
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <span
                className={
                  "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium " +
                  (image.kind === "change_after" ? "bg-sky-50 text-sky-700" : "bg-amber-100 text-amber-800")
                }
              >
                {image.kind === "change_after" ? t("import.images.kind.change") : t("import.images.kind.task")}
              </span>
              <span className="min-w-0 flex-1 font-medium text-amber-900">{image.name}</span>
            </div>
            <p className="mt-1 text-amber-700">{image.reason}</p>
            <p className="mt-1 text-[11px] text-amber-700">
              {image.kind === "change_after"
                ? image.task === null || image.task === ""
                  ? t("import.images.targetChange", { change: "—" })
                  : t("import.images.targetChange", { change: image.task })
                : image.task === null || image.task === ""
                  ? t("import.images.targetProject")
                  : t("import.images.targetTask", { task: image.task })}
            </p>
            {failure === null ? null : <p className="mt-1 text-[11px] text-rose-600">{failure}</p>}
            {onSelect === undefined ? null : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {selected === null ? null : (
                  <span className="min-w-0 max-w-full truncate rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700" title={selected.name}>
                    {t("import.images.selectedFile", { name: selected.name, size: formatBytes(selected.size) })}
                  </span>
                )}
                <label className="cursor-pointer rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:bg-amber-50">
                  {selected === null ? t("import.images.pick") : t("import.images.replace")}
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(event) => {
                      const picked = event.currentTarget.files?.[0] ?? null;
                      event.currentTarget.value = "";
                      if (picked !== null) onSelect(image.id, picked);
                    }}
                  />
                </label>
                {selected === null ? null : (
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-[11px] text-amber-700 transition hover:bg-amber-100"
                    onClick={() => onSelect(image.id, null)}
                  >
                    {t("import.images.remove")}
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ImportProjectPanel({ file, dicts, dictTools, canManageDicts, onReselect, onClose, onImported }: ImportProjectPanelProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "parsing" });
  const locale = useLocale();
  /** 项目地区：解析给默认（标准国家 / 地区名）；识别不出 = 空串，必须由用户在面板里选。 */
  const [region, setRegion] = useState("");
  /** 项目类型：解析按源表关键字给默认（如 AIRROB → 飞箱）；空串 = 未指定（可留空，导入后也能改）。 */
  const [projectType, setProjectType] = useState("");
  const [nodeChoices, setNodeChoices] = useState<Record<number, string>>({});
  const [personalTemplateChoices, setPersonalTemplateChoices] = useState<Record<number, string>>({});
  /**
   * 「申请加入公共节点库」逐行状态（键 = groupIndex）：只对「保留 Excel 原名」的阶段内节点有效。
   * 缺省值现算（中文名 = 源表原名、英文名 = 预览补全值），所以用户没动过就不用往 state 里塞副本；
   * 与个人模板互相独立（两者可同时选）。申请本身不改节点库，导入后由管理员审核。
   */
  const [nodeRequestChoices, setNodeRequestChoices] = useState<Record<number, { on: boolean; title: string; titleEn: string }>>({});
  const [selectedNodeCategory, setSelectedNodeCategory] = useState<NodeCategory | null>(null);
  const nodeTabId = useId();
  const [nodePickerIndex, setNodePickerIndex] = useState<number | null>(null);
  const [nodeQuery, setNodeQuery] = useState("");
  const [conflictChoices, setConflictChoices] = useState<Record<string, number>>({});
  /** 「需手动导入」清单就地选中的文件（id → File；确认导入后一并直传并挂任务 / 变更）。 */
  const [manualSelections, setManualSelections] = useState<Record<string, File>>({});
  /** 地区小窗开着时按 Esc 只关小窗（再按一次才关面板，与项目弹窗同口径）。 */
  const [regionPopoverOpen, setRegionPopoverOpen] = useState(false);
  /** 记住上一份导入表：换文件才复位地区 / 类型 / 节点勾选。 */
  const mainFileRef = useRef<File | null>(null);
  /** 解析段预计秒数（只随主文件大小变）。 */
  const parseEtaSeconds = estimateParseSeconds(file.size);
  const dialogRef = useFocusTrap<HTMLDivElement>();
  /** 倒计时随解析 / 写入两段独立计时。 */
  const parseRemainingSeconds = useImportRemainingSeconds(parseEtaSeconds, phase.kind === "parsing");
  const committing = phase.kind === "committing";
  const uploading = phase.kind === "uploading";
  const busy = committing || uploading;
  /** 写入中取消（Push 321）：abort 请求 → 服务端回滚；回到预览态可再次确认导入。 */
  const commitAbortRef = useRef<AbortController | null>(null);
  /** 刚取消过写入（预览态给一行说明；换文件 / 再次提交时清掉）。 */
  const [commitCancelled, setCommitCancelled] = useState(false);

  // 选文件（或换主导入表）即解析：解析不写库；换导入表 = 整体重来（地区 / 勾选复位）。
  useEffect(() => {
    let cancelled = false;
    const mainChanged = mainFileRef.current !== file;
    mainFileRef.current = file;
    setPhase({ kind: "parsing" });
    setRegionPopoverOpen(false);
    if (mainChanged) {
      setRegion("");
      setProjectType("");
      setNodeChoices({});
      setPersonalTemplateChoices({});
      setNodeRequestChoices({});
      setSelectedNodeCategory(null);
      setNodePickerIndex(null);
      setNodeQuery("");
      setConflictChoices({});
      setManualSelections({});
      setCommitCancelled(false);
    }
    if (file.size === 0 || file.size > IMPORT_MAX_FILE_BYTES) {
      setPhase({ kind: "failed", stage: "parse", error: null, reason: file.size === 0 ? "empty" : "size" });
      return () => {
        cancelled = true;
      };
    }
    previewProjectImport(file)
      .then((preview) => {
        if (cancelled) {
          return;
        }
        setRegion((current) => (current !== "" ? current : (preview.project.region ?? "")));
        setProjectType((current) => (current !== "" ? current : (preview.project.projectType ?? "")));
        setPhase({ kind: "preview", preview });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setPhase({ kind: "failed", stage: "parse", error: error instanceof ApiError ? error : null, reason: null });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Esc 关闭（写入中 / 地区小窗打开时不关）。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || regionPopoverOpen || busy || document.querySelector('[data-select-popover="true"]') !== null) {
        return;
      }
      if (nodePickerIndex !== null) {
        setNodePickerIndex(null);
        setNodeQuery("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onClose, regionPopoverOpen, nodePickerIndex]);

  // 面板打开期间锁背景滚动（与项目弹窗同款：经典滚动条占位补回，锁滚动不横向跳动）。
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previous = { html: html.style.overflow, body: body.style.overflow, pad: body.style.paddingRight };
    const gap = window.innerWidth - html.clientWidth;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (gap > 0) {
      body.style.paddingRight = String(gap) + "px";
    }
    return () => {
      html.style.overflow = previous.html;
      body.style.overflow = previous.body;
      body.style.paddingRight = previous.pad;
    };
  }, []);

  /** 补充附件上传（逐项直传 + 变更回挂）：成功记 completedIds，失败保留 File / fileId 供重试。 */
  const uploadManualItems = (
    preview: ProjectImportPreview,
    result: ProjectImportResult,
    items: ManualUploadItem[],
    base: ManualUploadOutcome,
  ): void => {
    const targets = new Map<string, ImportManualTarget>((result.manualTargets ?? []).map((target) => [target.id, target]));
    const failures = base.failures.filter((failure) => !items.some((item) => item.id === failure.id));
    const completedIds = base.completedIds.filter((id) => !items.some((item) => item.id === id));
    const run = async (): Promise<void> => {
      for (const item of items) {
        const target = targets.get(item.id) ?? null;
        let fileId = item.fileId;
        setPhase({
          kind: "uploading",
          preview: preview,
          result: result,
          total: base.total,
          done: completedIds.length,
          currentName: item.name,
        });
        try {
          if (fileId === null) {
            if (item.file === null) throw new Error("附件文件已丢失，请重新导入");
            fileId = await uploadFile(
              result.projectId,
              item.file,
              item.file.name,
              target?.taskId === null || target?.taskId === undefined ? {} : { taskId: target.taskId },
            );
          }
          if (target?.changeId !== null && target?.changeId !== undefined) {
            await attachManualChangeFile(result.projectId, target.changeId, fileId);
          }
          completedIds.push(item.id);
        } catch (error) {
          failures.push({
            id: item.id,
            name: item.name,
            message: error instanceof ApiError ? error.message : t("import.images.uploadFailed"),
            file: fileId === null ? item.file : null,
            fileId: fileId,
            changeId: target?.changeId ?? null,
          });
        }
      }
      setPhase({ kind: "done", preview: preview, result: result, upload: { total: base.total, completedIds: completedIds, failures: failures } });
    };
    void run();
  };

  const startCommit = (preview: ProjectImportPreview): void => {
    const controller = new AbortController();
    commitAbortRef.current = controller;
    setCommitCancelled(false);
    const selectedFiles: ManualUploadItem[] = preview.imagesManual
      .filter((image) => manualSelections[image.id] !== undefined)
      .map((image) => ({ id: image.id, name: manualSelections[image.id]!.name, file: manualSelections[image.id]!, fileId: null }));
    // 公共节点申请：只取「阶段内 + 保留 Excel 原名 + 开关打开」的行；英文名空串按「无英文」传 null
    // （缺省不传会被服务端当成「用预览补全的英文」，明确清空必须显式 null）。
    const nodeRequestsInput = preview.nodes
      .filter((node) => node.inStageScope && nodeChoice(node) === "standalone" && nodeRequestOf(node).on)
      .map((node) => {
        const state = nodeRequestOf(node);
        const titleEn = state.titleEn.trim();
        return { groupIndex: node.groupIndex, title: state.title.trim(), titleEn: titleEn === "" ? null : titleEn };
      });
    setPhase({ kind: "committing", preview });
    commitProjectImport(
      {
        previewId: preview.previewId, region, projectType, addMissingNodes: false,
        nodeDecisions: preview.nodes.filter((node) => node.inStageScope).map((node) => {
          const choice = nodeChoice(node);
          return {
            groupIndex: node.groupIndex,
            action: choice.startsWith("existing:") ? "existing" as const : "standalone" as const,
            nodeId: choice.startsWith("existing:") ? choice.slice("existing:".length) : null,
          };
        }),
        personalTemplateSelections: preview.nodes.flatMap((node) => {
          const template = preview.personalTemplates.find((item) => item.id === personalTemplateChoices[node.groupIndex]);
          return template === undefined || nodeChoice(node) !== "standalone" ? [] :
            [{ groupIndex: node.groupIndex, templateId: template.id, version: template.version }];
        }),
        nodeRequests: nodeRequestsInput,
        conflictChoices: conflicts.map(([key]) => ({ key, taskIndex: conflictChoices[key]! })),
      },
      controller.signal,
    )
      .then((result) => {
        commitAbortRef.current = null;
        onImported();
        if (selectedFiles.length === 0) {
          setPhase({ kind: "done", preview: preview, result: result, upload: { total: 0, completedIds: [], failures: [] } });
          return;
        }
        uploadManualItems(preview, result, selectedFiles, { total: selectedFiles.length, completedIds: [], failures: [] });
      })
      .catch((error: unknown) => {
        commitAbortRef.current = null;
        const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        if (aborted || (error instanceof ApiError && error.code === "IMPORT_CANCELLED")) {
          setCommitCancelled(true);
          setPhase({ kind: "preview", preview: preview });
          return;
        }
        setPhase({ kind: "failed", stage: "commit", error: error instanceof ApiError ? error : null, reason: null });
      });
  };

  /** 「取消写入」：断开请求 → 服务端单事务回滚（不会写入任何数据）。 */
  const cancelCommit = (): void => {
    commitAbortRef.current?.abort();
  };

  /** 完成页「重试失败附件」：已传成功的只重挂变更，未传成功的重新直传。 */
  const retryManualUploads = (): void => {
    if (phase.kind !== "done" || phase.upload.failures.length === 0) return;
    const items: ManualUploadItem[] = phase.upload.failures.map((failure) => ({
      id: failure.id,
      name: failure.name,
      file: failure.file,
      fileId: failure.fileId,
    }));
    uploadManualItems(phase.preview, phase.result, items, phase.upload);
  };

  // 预览态派生：可导入 = 无阻断项 + 地区已选（用户补选地区后，服务端的「地区未识别」阻断项随之消解）。
  const preview =
    phase.kind === "preview" || phase.kind === "committing" || phase.kind === "uploading" || phase.kind === "done"
      ? phase.preview
      : null;
  const visibleIssues = preview === null ? [] : preview.issues.filter((issue) => !(issue.code === "REGION_UNRESOLVED" && region !== ""));
  const blockingCount = visibleIssues.filter((issue) => issue.level === "error").length;
  const nodeChoice = (node: ImportTaskNode): string =>
    node.matchKind === "exact" ? "existing:" + node.libraryId :
    node.matchKind === "temporary" ? "standalone" :
    // AI 判「新节点」默认保留原名，但用户显式改选（已有节点 / 保留原名）必须覆盖默认值
    nodeChoices[node.groupIndex] ?? (node.matchKind === "new" ? "standalone" : "");
  const nodeEnglish = (node: ImportTaskNode): string | null => {
    const choice = nodeChoice(node);
    const selected = choice.startsWith("existing:") ? preview?.nodeLibrary.find((item) => "existing:" + item.id === choice) : undefined;
    if (selected === undefined) return node.sourceNameEn;
    if (selected.titleEn) return selected.titleEn;
    if (selected.id === node.libraryId) return node.nameEn;
    return selected.title.replace(/\s+/g, "").toLowerCase() === node.name.replace(/\s+/g, "").toLowerCase() ? node.sourceNameEn : null;
  };
  /** 某行的申请状态（没动过 = 关；中文名缺省源表原名、英文名缺省预览补全值）。 */
  const nodeRequestOf = (node: ImportTaskNode): { on: boolean; title: string; titleEn: string } =>
    nodeRequestChoices[node.groupIndex] ?? { on: false, title: node.name, titleEn: nodeEnglish(node) ?? "" };
  /** 改一行申请状态（开关 / 中英文名）：先把缺省值固化下来再打补丁，避免输入框中途「回跳」到默认值。 */
  const updateNodeRequest = (node: ImportTaskNode, patch: Partial<{ on: boolean; title: string; titleEn: string }>): void => {
    setNodeRequestChoices((current) => ({
      ...current,
      [node.groupIndex]: { ...(current[node.groupIndex] ?? { on: false, title: node.name, titleEn: nodeEnglish(node) ?? "" }), ...patch },
    }));
  };
  const scopedNodes = preview?.nodes.filter((node) => node.inStageScope) ?? [];
  /** 已选完的判定不再搬栏，所以这里只按「还没选」筛，作为提交前的必填校验。 */
  const reviewNodes = scopedNodes.filter((node) => node.matchKind === "uncertain" && nodeChoice(node) === "");
  const exactMatches = scopedNodes.filter((node) => node.matchKind === "exact");
  const aiMatchedNodes = scopedNodes.filter((node) => node.matchKind === "semantic");
  /**
   * 分类只看「AI 判定结果」，**不**按用户是否已选择来搬移。
   * 「未匹配（AI 判断无同义节点）」与「AI 无法确认」在用户侧是同一个动作 —— 都要么选已有节点、要么保留原名
   * （保留原名可顺带申请进公共节点库），所以合并成一栏（业务口径 2026-11-13）；行内用一句来源说明区分。
   * 合并后「AI 判 new」的行也允许改选已有节点（原先按钮只对 uncertain 渲染，new 选不回来）。
   */
  const pendingNodes = scopedNodes.filter((node) => node.matchKind === "new" || node.matchKind === "uncertain");
  const nodesByCategory: Record<NodeCategory, ImportTaskNode[]> = {
    ai: aiMatchedNodes,
    pending: pendingNodes,
  };
  const hasCategorizedNodes = aiMatchedNodes.length + pendingNodes.length > 0;
  const currentNodeCategory: NodeCategory = selectedNodeCategory ??
    (aiMatchedNodes.length > 0 ? "ai" : "pending");
  const nodeCategoryTabs: Array<{ category: NodeCategory; label: string }> = [
    { category: "ai", label: t("import.nodes.summaryAi", { n: aiMatchedNodes.length }) },
    { category: "pending", label: t("import.nodes.summaryPending", { n: pendingNodes.length }) },
  ];
  const conflictBuckets = new Map<string, { name: string; tasks: Array<{ index: number; row: number; name: string }> }>();
  for (const node of scopedNodes) {
    const choice = nodeChoice(node);
    const key = choice.startsWith("existing:") ? choice : null;
    if (key === null) continue;
    const existingName = preview?.nodeLibrary.find((item) => "existing:" + item.id === key)?.title;
    const bucket = conflictBuckets.get(key) ?? { name: existingName ?? node.name, tasks: [] };
    for (const task of node.tasks) bucket.tasks.push({ ...task, name: node.name });
    conflictBuckets.set(key, bucket);
  }
  const conflicts = [...conflictBuckets.entries()].filter(([, bucket]) => bucket.tasks.length > 1);
  /** 打开了公共节点申请、但中文名还空着的行（服务端 title 必填：这一行必须补全才能提交）。 */
  const requestNodesMissingName = scopedNodes.filter(
    (node) => nodeChoice(node) === "standalone" && nodeRequestOf(node).on && nodeRequestOf(node).title.trim() === "",
  );
  const canCommit = phase.kind === "preview" && blockingCount === 0 && region !== "" && reviewNodes.length === 0 &&
    aiMatchedNodes.every((node) => nodeChoice(node) !== "") &&
    requestNodesMissingName.length === 0 &&
    conflicts.every(([key, bucket]) => bucket.tasks.some((task) => task.index === conflictChoices[key]));
  const selectedManualCount = preview === null ? 0 : preview.imagesManual.filter((image) => manualSelections[image.id] !== undefined).length;
  const doneManualPending =
    phase.kind === "done" ? phase.preview.imagesManual.filter((image) => !phase.upload.completedIds.includes(image.id)) : [];
  const doneFailureById: Record<string, string> = {};
  if (phase.kind === "done") {
    for (const failure of phase.upload.failures) doneFailureById[failure.id] = failure.message;
  }

  const commitEtaSeconds = phase.kind === "committing" ? estimateCommitSeconds(file.size, phase.preview.counts.images) : 0;
  const commitRemainingSeconds = useImportRemainingSeconds(commitEtaSeconds, phase.kind === "committing");

  const failedText =
    phase.kind !== "failed"
      ? ""
      : phase.reason === "empty"
        ? t("import.err.empty")
        : phase.reason === "size"
          ? t("import.err.tooLarge", { size: formatBytes(file.size) })
          : phase.error !== null
            ? phase.error.message
            : t("import.err.network");
  const failedCode = phase.kind === "failed" && phase.error !== null ? phase.error.code : null;
  const failedStatus = phase.kind === "failed" && phase.error !== null ? phase.error.status : null;
  /** 服务端导入接口还没上线（404 / 501）：多给一行说明，免得当成数据问题查。 */
  const failedNotReady = failedStatus === 404 || failedStatus === 501;

  const secondaryButtonClass = "rounded-lg border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100";
  const applyNodeChoice = (node: ImportTaskNode, choice: string): void => {
    setNodeChoices((current) => ({ ...current, [node.groupIndex]: choice }));
    if (choice !== "standalone") {
      setPersonalTemplateChoices((current) => ({ ...current, [node.groupIndex]: "" }));
      // 改选「已有节点」= 这行不再保留 Excel 原名，申请也就没有对象了（开关 / 名称一并作废，回到默认值）
      setNodeRequestChoices((current) => {
        const next = { ...current };
        delete next[node.groupIndex];
        return next;
      });
    }
    setConflictChoices({});
    setNodePickerIndex(null);
    setNodeQuery("");
  };
  const renderNodeRows = (nodes: ImportTaskNode[]) => (
    <ul className="mt-3 space-y-2">
      {nodes.map((node) => {
        const choice = nodeChoice(node);
        const selected = choice.startsWith("existing:")
          ? preview?.nodeLibrary.find((item) => "existing:" + item.id === choice)
          : undefined;
        const suggested = node.matchKind === "semantic" ? preview?.nodeLibrary.find((item) => item.id === node.libraryId) : undefined;
        const personalTemplates = (preview?.personalTemplates ?? []).filter((item) => item.stageKey === node.stageKey);
        const request = nodeRequestOf(node);
        /** 这一行是否已经选定复用公共节点库里的某条（此时申请无意义，置灰）。 */
        const usingExisting = choice.startsWith("existing:");
        const pickerOpen = nodePickerIndex === node.groupIndex;
        const query = nodeQuery.trim().toLocaleLowerCase();
        const stageNodes = pickerOpen ? (preview?.nodeLibrary ?? []).filter((item) => item.stageKey === node.stageKey) : [];
        const visibleNodes = stageNodes.filter((item) =>
          item.title.toLocaleLowerCase().includes(query) || (item.titleEn ?? "").toLocaleLowerCase().includes(query));
        const actionClass = (active: boolean): string =>
          "rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
          (active ? "border-zinc-800 bg-zinc-800 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50");
        return (
          <li key={node.groupIndex} className="rounded-lg border border-zinc-100 bg-white px-3 py-3 text-xs" data-import-node={node.groupIndex}>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="min-w-0"><span className="block font-medium text-zinc-800">{node.name}</span>
                {nodeEnglish(node) === null || nodeEnglish(node) === "" ? <span className="text-amber-600">{t("import.nodes.nameEnMissing")}</span> : <span className="text-zinc-400">{nodeEnglish(node)}</span>}
              </span>
              <span className="text-zinc-500">{stageText(locale, stageNameOf(node.stageKey))} · {t("import.nodes.count", { n: node.taskCount })}{node.matchKind === "semantic" && node.tasks[0] ? " · " + t("import.nodes.excelRow", { row: node.tasks[0].row }) : ""}</span>
            </div>
            {node.matchKind !== "uncertain" && node.matchKind !== "new" ? null : (
              <p className="mt-2 text-[11px] text-amber-700">
                {node.matchKind === "new" ? t("import.nodes.badgeNew") : t("import.nodes.badgeUncertain")}
              </p>
            )}
            {suggested === undefined ? null : (
              <p className="mt-2 text-xs text-blue-700">{t("import.nodes.aiSuggestion", { name: suggested.title })}</p>
            )}
            {selected === undefined ? null : (
              <p className="mt-2 text-xs text-emerald-700">{t("import.nodes.current", { name: selected.title })}</p>
            )}
            {node.matchKind !== "semantic" || suggested === undefined ? null : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" aria-pressed={selected?.id === suggested.id} className={actionClass(selected?.id === suggested.id)}
                  onClick={() => applyNodeChoice(node, "existing:" + suggested.id)} data-import-choose-suggestion={node.groupIndex}>
                  {t("import.nodes.useSuggestion")}
                </button>
                <button type="button" aria-pressed={choice === "standalone"} className={actionClass(choice === "standalone")}
                  onClick={() => applyNodeChoice(node, "standalone")} data-import-choose-standalone={node.groupIndex}>
                  {t("import.nodes.keepExcelName")}
                </button>
              </div>
            )}
            {node.matchKind === "semantic" || node.matchKind === "exact" || node.matchKind === "temporary" ? null : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" aria-expanded={pickerOpen} className={actionClass(selected !== undefined)}
                  onClick={() => { setNodePickerIndex(pickerOpen ? null : node.groupIndex); setNodeQuery(""); }}
                  data-import-choose-existing={node.groupIndex}>
                  {t("import.nodes.existing")}
                </button>
                <button type="button" aria-pressed={choice === "standalone"} className={actionClass(choice === "standalone")}
                  onClick={() => applyNodeChoice(node, "standalone")} data-import-choose-standalone={node.groupIndex}>
                  {t("import.nodes.standalone")}
                </button>
              </div>
            )}
            {!node.inStageScope ? null : (
              <div className="mt-3 border-t border-zinc-100 pt-3">
                {choice !== "standalone" ? null : (
                  <>
                    <p className="text-xs font-medium text-zinc-700">{t("import.nodes.personalTemplate")}</p>
                    {personalTemplates.length === 0 ? (
                      <p className="mt-1 text-xs text-zinc-500">{t("import.nodes.noPersonalTemplate")}</p>
                    ) : (
                      <div className="mt-1.5 max-w-md" data-import-personal-template={node.groupIndex}>
                        <SelectMenu
                          ariaLabel={t("import.nodes.personalTemplate") + " · " + node.name}
                          value={personalTemplateChoices[node.groupIndex] ?? ""}
                          options={[{ value: "", label: t("import.nodes.noTemplate") }, ...personalTemplates.map((template) => ({ value: template.id, label: template.name }))]}
                          onChange={(value) => setPersonalTemplateChoices((current) => ({ ...current, [node.groupIndex]: value }))}
                          popoverClassName="z-[80]"
                        />
                      </div>
                    )}
                  </>
                )}
                {/* 公共节点申请（业务口径 2026-11-13）：常驻在节点原本的分类里，不再等用户先选「保留原名」被挪去
                    「已人工处理」；勾选即等于保留 Excel 原名（未选时自动补上 standalone）。沿用已有节点时这条不适用，
                    置灰并说明，避免提交一条与「用标准名」矛盾的申请。 */}
                <div className={"mt-3 border-t border-zinc-100 pt-3" + (choice !== "standalone" ? "" : " border-t-0 pt-0")}>
                  <label
                    className={"flex items-center gap-2 text-xs font-medium " + (usingExisting ? "cursor-not-allowed text-zinc-400" : "cursor-pointer text-zinc-700")}
                  >
                    <input
                      type="checkbox"
                      checked={request.on}
                      disabled={usingExisting}
                      onChange={(event) => {
                        const next = event.currentTarget.checked;
                        if (next && nodeChoice(node) === "") applyNodeChoice(node, "standalone");
                        updateNodeRequest(node, { on: next });
                      }}
                      className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300 accent-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      data-import-request-node={node.groupIndex}
                    />
                    {t("import.nodes.requestTitle")}
                  </label>
                  <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                    {usingExisting ? t("import.nodes.requestSkipExisting") : t("import.nodes.requestHint")}
                  </p>
                  {!request.on || usingExisting ? null : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        value={request.title}
                        onChange={(event) => updateNodeRequest(node, { title: event.currentTarget.value })}
                        placeholder={t("import.nodes.requestName")}
                        aria-label={t("import.nodes.requestName") + " · " + node.name}
                        maxLength={200}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400"
                        data-import-request-title={node.groupIndex}
                      />
                      <input
                        type="text"
                        value={request.titleEn}
                        onChange={(event) => updateNodeRequest(node, { titleEn: event.currentTarget.value })}
                        placeholder={t("import.nodes.requestNameEn")}
                        aria-label={t("import.nodes.requestNameEn") + " · " + node.name}
                        maxLength={200}
                        className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400"
                        data-import-request-title-en={node.groupIndex}
                      />
                    </div>
                  )}
                  {request.on && !usingExisting && request.title.trim() === "" ? (
                    <p className="mt-1 text-[11px] text-rose-600" data-import-request-name-error={node.groupIndex}>
                      {t("import.nodes.requestNameRequired")}
                    </p>
                  ) : null}
                </div>
              </div>
            )}
            {node.matchKind === "semantic" || node.matchKind === "exact" || node.matchKind === "temporary" || !pickerOpen ? null : (
              <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3" data-import-node-picker="">
                <div className="flex items-center justify-between gap-3">
                  <span className="border-b-2 border-zinc-900 pb-1.5 text-xs font-semibold text-zinc-900">
                    {t("sac.tab.nodes")} <span className="font-normal text-zinc-400">{stageNodes.length}</span>
                  </span>
                  <button type="button" className="text-xs text-zinc-500 hover:text-zinc-900"
                    onClick={() => { setNodePickerIndex(null); setNodeQuery(""); }}>{t("import.nodes.collapse")}</button>
                </div>
                <div className="relative mt-2">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
                  </svg>
                  <input type="search" value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)}
                    placeholder={t("tpl.nodes.searchPlaceholder")} aria-label={t("tpl.nodes.searchAria")}
                    className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-8 pr-3 text-xs text-zinc-700 outline-none focus:border-zinc-400" />
                </div>
                {visibleNodes.length === 0 ? (
                  <p className="py-5 text-center text-xs text-zinc-500">{t("tpl.nodes.empty")}</p>
                ) : (
                  <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                    {visibleNodes.map((item) => {
                      const isSelected = selected?.id === item.id;
                      return (
                        <li key={item.id}>
                          <button type="button" aria-pressed={isSelected}
                            className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-white px-3 py-2 text-left transition hover:border-zinc-300"
                            onClick={() => applyNodeChoice(node, "existing:" + item.id)} data-import-node-option={item.id}>
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs font-medium text-zinc-700">{item.title}</span>
                              {item.titleEn ? <span className="mt-0.5 block text-[10px] text-zinc-400">{item.titleEn}</span> : null}
                            </span>
                            <span className="shrink-0 text-[11px] font-medium text-emerald-700">{t(isSelected ? "import.nodes.selected" : "import.nodes.select")}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  const primaryButtonClass =
    "rounded-lg bg-[#feca04] px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:brightness-95 active:brightness-90 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none";

  return (
    <div data-import-panel="" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-zinc-900/40 backdrop-blur-[2px]"
        onClick={() => {
          if (!busy) {
            onClose();
          }
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("import.aria")}
        className="relative flex max-h-[min(860px,calc(100dvh-2rem))] w-full max-w-6xl flex-col overflow-clip rounded-2xl bg-white shadow-[0_24px_60px_rgba(0,0,0,0.25)]" data-import-dialog=""
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-zinc-900">{t("import.title")}</h2>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span
              className="max-w-[300px] truncate rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-600"
              title={file.name}
              data-import-file-name=""
            >
              {file.name} · {formatBytes(file.size)}
            </span>
            <button
              type="button"
              aria-label={t("import.closeAria")}
              disabled={busy}
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        <ScrollArea
          viewportClassName="min-h-0 flex-1"
          className="px-6 py-5"
          ariaLabel={t("import.aria")}
          thumbAlwaysVisible={phase.kind === "preview" || phase.kind === "done"}
        >
          {phase.kind === "parsing" ? (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center">
              <div className="w-[364px] max-w-full" data-import-loading-anim="parse">
                <ImportCarStage />
                <p className="export-progress__title">{t("import.parsing")}</p>
                <p className="export-progress__hint">{t("import.parsing.hint")}</p>
                <p className="export-progress__hint">
                  {t("import.etaLead")}
                  <span className="export-progress__num">{parseRemainingSeconds}</span>
                  {t("import.etaTail")}
                </p>
                <div className="export-progress__bar is-waiting">
                  <span className="export-progress__bar-fill" />
                </div>
              </div>
            </div>
          ) : null}

          {phase.kind === "committing" ? (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center">
              <div className="w-[364px] max-w-full" data-import-loading-anim="commit">
                <ImportCarStage />
                <p className="export-progress__title">{t("import.committing")}</p>
                <p className="export-progress__hint">
                  {t("import.etaLead")}
                  <span className="export-progress__num">{commitRemainingSeconds}</span>
                  {t("import.etaTail")}
                </p>
                <div className="export-progress__bar is-waiting">
                  <span className="export-progress__bar-fill" />
                </div>
              </div>
              <dl className="mt-5 w-[364px] max-w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs text-zinc-600">
                <div className="flex gap-2">
                  <dt className="text-zinc-400">{t("import.field.code")}</dt>
                  <dd className="font-medium text-zinc-800">{phase.preview.project.code}</dd>
                </div>
                <div className="mt-1 flex gap-2">
                  <dt className="text-zinc-400">{t("import.field.name")}</dt>
                  <dd className="text-zinc-800">{phase.preview.project.name}</dd>
                </div>
                <div className="mt-1 flex gap-2">
                  <dt className="text-zinc-400">{t("import.field.region")}</dt>
                  <dd className="text-zinc-800">{dictLabel(dicts, "region", region)}</dd>
                </div>
                <div className="mt-1 flex gap-2">
                  <dt className="text-zinc-400">{t("import.field.type")}</dt>
                  <dd className="text-zinc-800">{projectType === "" ? t("import.value.none") : dictLabel(dicts, "projectType", projectType)}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          {phase.kind === "uploading" ? (
            <div className="flex h-full min-h-[420px] flex-col items-center justify-center">
              <div className="w-[420px] max-w-full text-center" data-import-loading-anim="upload-manual">
                <ImportCarStage />
                <p className="export-progress__title">{t("import.images.uploadingTitle")}</p>
                <p className="export-progress__hint">
                  {t("import.images.uploadingHint", {
                    done: phase.done,
                    total: phase.total,
                    name: phase.currentName,
                  })}
                </p>
                <div className="export-progress__bar is-waiting">
                  <span className="export-progress__bar-fill" />
                </div>
                <p className="mt-2 text-xs text-zinc-400">{t("import.images.uploadingFoot")}</p>
              </div>
            </div>
          ) : null}

          {phase.kind === "failed" ? (
            <div className="mx-auto flex h-full min-h-[420px] max-w-xl flex-col items-center justify-center text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-xl font-bold text-rose-500" aria-hidden="true">
                !
              </div>
              <p className="mt-4 text-base font-semibold text-zinc-900">{t("import.failed.title")}</p>
              <p className="mt-2 text-sm text-zinc-600" data-import-failed-text="">{failedText}</p>
              {failedCode === null ? null : <p className="mt-1 text-xs text-zinc-400">{t("import.err.code", { code: failedCode })}</p>}
              {failedNotReady ? (
                <p className="mt-2 max-w-md rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {t("import.notReady", { status: failedStatus === null ? 404 : failedStatus })}
                </p>
              ) : null}
              <p className="mt-3 text-xs text-zinc-400">{t("import.failed.hint")}</p>
            </div>
          ) : null}

          {phase.kind === "preview" ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-5">
                {commitCancelled ? (
                  <p
                    className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800"
                    data-import-cancelled-note=""
                  >
                    {t("import.cancel.note")}
                  </p>
                ) : null}
                <section className="rounded-2xl border border-zinc-200 bg-white p-5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900">{t("import.section.project")}</h3>
                    <p className="text-xs text-zinc-400">{t("import.section.project.hint")}</p>
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-zinc-400">{t("import.field.code")}</dt>
                      <dd className="mt-1 text-sm font-medium text-zinc-900" data-import-project-code="">
                        {phase.preview.project.code}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-400">{t("import.field.name")}</dt>
                      <dd className="mt-1 text-sm text-zinc-900">{phase.preview.project.name}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-zinc-400">
                        {t("import.field.region")}
                        {region === "" ? <span className="ml-1 text-rose-500">*</span> : null}
                      </dt>
                      <dd className="mt-1">
                        <RegionSelect
                          value={region}
                          valueLabel={region === "" ? "" : dictLabel(dicts, "region", region)}
                          items={dicts.region}
                          onChange={setRegion}
                          onOpenChange={setRegionPopoverOpen}
                        />
                        {region === "" ? <p className="mt-1 text-xs text-rose-600">{t("import.region.required")}</p> : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-400">{t("import.field.type")}</dt>
                      <dd className="mt-1">
                        <DictSelect
                          value={projectType}
                          items={dicts.projectType}
                          ariaLabel={t("import.field.type")}
                          placeholder={t("import.type.placeholder")}
                          renderContent={(name, item) => (
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-zinc-900/10"
                                style={{ backgroundColor: accentOfItem(item ?? undefined).color }}
                                aria-hidden="true"
                              />
                              <span className="truncate">{projectTypeText(locale, name)}</span>
                            </span>
                          )}
                          onAdd={canManageDicts ? (input) => dictTools.onAdd("projectType", input) : undefined}
                          addText={{
                            label: t("import.type.add"),
                            placeholder: t("import.type.namePlaceholder"),
                          }}
                          palette={{
                            label: fieldText(locale, "颜色模板"),
                            options: DICT_ACCENT_PALETTE,
                          }}
                          onChange={setProjectType}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-400">{t("import.field.managers")}</dt>
                      <dd className="mt-1 text-sm text-zinc-900">
                        {phase.preview.project.managerNames.length === 0 ? t("import.value.none") : phase.preview.project.managerNames.join("、")}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section className="rounded-2xl border border-zinc-200 bg-white p-5">
                  <h3 className="text-sm font-semibold text-zinc-900">{t("import.stats.title")}</h3>
                  <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <StatTile label={t("import.stats.tasks")} value={phase.preview.counts.tasks} />
                    <StatTile label={t("import.stats.reports")} value={phase.preview.counts.reports} />
                    <StatTile
                      label={t("import.stats.changes")}
                      value={phase.preview.counts.changes}
                      caption={phase.preview.counts.changesLinked === 0 ? undefined : t("import.stats.changes.linked", { n: phase.preview.counts.changesLinked })}
                    />
                    <StatTile label={t("import.stats.stakeholders")} value={phase.preview.counts.stakeholders} />
                    <StatTile
                      label={t("import.stats.images")}
                      value={phase.preview.counts.images}
                      caption={phase.preview.counts.imagesManual === 0 ? undefined : t("import.stats.images.manual", { n: phase.preview.counts.imagesManual })}
                    />
                    <StatTile label={t("import.stats.accountsNew")} value={phase.preview.counts.accountsNew} />
                  </dl>
                </section>

                {phase.preview.imagesManual.length === 0 ? null : (
                  <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5" data-import-manual-images="">
                    <h3 className="text-sm font-semibold text-amber-900">{t("import.images.title", { n: phase.preview.imagesManual.length })}</h3>
                    <p className="mt-1 text-xs text-amber-800">{t("import.images.hint")}</p>
                    <p className="mt-2 text-[11px] font-medium text-amber-800">
                      {t("import.images.selectedSummary", {
                        selected: selectedManualCount,
                        total: phase.preview.imagesManual.length,
                      })}
                    </p>
                    <ManualImageList
                      images={phase.preview.imagesManual}
                      selections={manualSelections}
                      onSelect={(id, picked) => {
                        setManualSelections((current) => {
                          const next = { ...current };
                          if (picked === null) delete next[id];
                          else next[id] = picked;
                          return next;
                        });
                      }}
                    />
                  </section>
                )}

                {scopedNodes.length === 0 ? null : (
                  <section className="rounded-2xl border border-zinc-200 bg-white p-5" data-import-node-summary="">
                    {/* 业务口径 2026-11-13（PM「这两条文字提示放在这里过于啰嗦了，因为下面已经有相似的文字提示了」）：
                        「节点比对结果」标题下的 summaryHint 与 adminNotice 两行提示不再渲染 —— 分类面板与每条节点行内
                        已各自给出同样的说明；键由 lead 统一清理。 */}
                    <h3 className="text-sm font-semibold text-zinc-900">{t("import.nodes.summaryTitle")}</h3>
                    <p className="mt-3 text-xs font-medium text-zinc-700" data-import-auto-matched="">
                      {t("import.nodes.autoMatched", { n: exactMatches.length })}
                    </p>
                    {!hasCategorizedNodes ? null : (<>
                    <div
                      role="tablist"
                      aria-label={t("import.nodes.summaryTitle")}
                      className="mt-3 flex flex-wrap gap-2 text-xs"
                      onKeyDown={(event) => {
                        const index = nodeCategoryTabs.findIndex((tab) => tab.category === currentNodeCategory);
                        const next = event.key === "ArrowRight" ? (index + 1) % nodeCategoryTabs.length :
                          event.key === "ArrowLeft" ? (index + nodeCategoryTabs.length - 1) % nodeCategoryTabs.length :
                          event.key === "Home" ? 0 : event.key === "End" ? nodeCategoryTabs.length - 1 : -1;
                        if (next < 0) return;
                        event.preventDefault();
                        setSelectedNodeCategory(nodeCategoryTabs[next]!.category);
                        setNodePickerIndex(null);
                        setNodeQuery("");
                        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                      }}
                    >
                      {nodeCategoryTabs.map((tab) => {
                        const selected = currentNodeCategory === tab.category;
                        return (
                          <button
                            key={tab.category}
                            id={nodeTabId + "-tab-" + tab.category}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls={nodeTabId + "-panel"}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => { setSelectedNodeCategory(tab.category); setNodePickerIndex(null); setNodeQuery(""); }}
                            className={"rounded-lg border px-2.5 py-1.5 font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 " +
                              (selected ? "border-blue-400 bg-blue-50 text-blue-800" : "border-transparent bg-zinc-100 text-zinc-600 hover:bg-zinc-200")}
                            data-import-node-tab={tab.category}
                          >
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>
                    <div
                      id={nodeTabId + "-panel"}
                      role="tabpanel"
                      aria-labelledby={nodeTabId + "-tab-" + currentNodeCategory}
                      className={"mt-4 rounded-xl border p-4 " +
                        (currentNodeCategory === "ai" ? "border-blue-200 bg-blue-50/50" : "border-amber-200 bg-amber-50/60")}
                      data-import-node-category={currentNodeCategory}
                    >
                      {nodesByCategory[currentNodeCategory].length === 0 ? (
                        <p className="py-4 text-center text-xs text-zinc-500">{t("import.nodes.categoryEmpty")}</p>
                      ) : (
                        <>
                          <h4 className={"text-sm font-semibold " + (currentNodeCategory === "ai" ? "text-blue-900" : "text-amber-900")}>
                            {currentNodeCategory === "ai"
                              ? t("import.nodes.aiMatchesTitle", { n: aiMatchedNodes.length })
                              : t("import.nodes.pendingTitle", { n: pendingNodes.length })}
                          </h4>
                          <p className={"mt-1 text-xs " + (currentNodeCategory === "ai" ? "text-blue-800" : "text-amber-800")}>
                            {currentNodeCategory === "ai" ? t("import.nodes.aiMatchesHint") : t("import.nodes.pendingHint")}
                          </p>
                          {renderNodeRows(nodesByCategory[currentNodeCategory])}
                        </>
                      )}
                    </div>
                    </>)}
                  </section>
                )}

                {conflicts.length === 0 ? null : (
                  <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5" data-import-node-conflicts="">
                    <h3 className="text-sm font-semibold text-amber-900">{t("import.nodes.conflictsTitle", { n: conflicts.length })}</h3>
                    <p className="mt-1 text-xs text-amber-800">{t("import.nodes.conflictsHint")}</p>
                    <ul className="mt-3 space-y-3">
                      {conflicts.map(([key, bucket]) => (
                        <li key={key} className="rounded-lg border border-amber-200 bg-white p-3 text-xs">
                          <p className="font-medium text-zinc-800">{bucket.name}</p>
                          <div className="mt-2">
                            <SelectMenu
                              ariaLabel={t("import.nodes.conflictAria", { name: bucket.name })}
                              value={conflictChoices[key] === undefined ? "" : String(conflictChoices[key])}
                              options={[{ value: "", label: t("import.nodes.conflictPick") }, ...bucket.tasks.map((task) => ({
                                value: String(task.index), label: t("import.nodes.conflictRow", { row: task.row, name: task.name }),
                              }))]}
                              onChange={(value) => setConflictChoices((current) => {
                                const next = { ...current };
                                if (value === "") delete next[key]; else next[key] = Number(value);
                                return next;
                              })}
                              popoverClassName="z-[80]"
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              <aside className="min-w-0 space-y-5">
                <section className="rounded-2xl border border-zinc-200 bg-white p-5" data-import-issues="">
                  <h3 className="text-sm font-semibold text-zinc-900">{t("import.issues.title", { n: visibleIssues.length })}</h3>
                  {visibleIssues.length === 0 ? (
                    <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{t("import.issues.clean")}</p>
                  ) : (
                    <ul className="mt-2">
                      {visibleIssues.map((issue, index) => (
                        <IssueRow key={index} issue={issue} />
                      ))}
                    </ul>
                  )}
                  {blockingCount === 0 ? null : (
                    <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700" data-import-blocking="">
                      {t("import.issues.blocking", { n: blockingCount })}
                    </p>
                  )}
                </section>

                {phase.preview.accounts.length === 0 ? null : (
                  <section className="rounded-2xl border border-zinc-200 bg-white p-5" data-import-accounts="">
                    <h3 className="text-sm font-semibold text-zinc-900">{t("import.accounts.title", { n: phase.preview.accounts.length })}</h3>
                    <ul className="mt-3 space-y-1.5">
                      {phase.preview.accounts.map((account, index) => (
                        <li key={index} className="flex items-center gap-2 rounded-lg border border-zinc-100 px-2.5 py-1.5 text-xs">
                          <span className="font-medium text-zinc-800">{account.displayName}</span>
                          <span className="text-zinc-400">{account.username}</span>
                          <span
                            className={
                              "ml-auto rounded-md px-1.5 py-0.5 text-[11px] " +
                              (account.isNew ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500")
                            }
                          >
                            {account.isNew ? t("import.accounts.new") : t("import.accounts.existing")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </aside>
            </div>
          ) : null}

          {phase.kind === "done" ? (
            <div className="mx-auto max-w-2xl">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-emerald-500">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="mt-3 text-base font-semibold text-zinc-900" data-import-done="">{t("import.done.title")}</p>
                <p className="mt-1 text-sm text-zinc-600">{t("import.done.desc", { code: phase.result.code, name: phase.result.name })}</p>
                <p className="mt-2 text-xs text-zinc-500">
                  {t("import.done.counts", {
                    tasks: phase.result.counts.tasks,
                    reports: phase.result.counts.reports,
                    changes: phase.result.counts.changes,
                    stakeholders: phase.result.counts.stakeholders,
                    images: phase.result.counts.images,
                    accounts: phase.result.counts.accountsCreated,
                  })}
                </p>
                {phase.upload.total === 0 ? null : (
                  <p className={"mt-2 text-xs " + (phase.upload.failures.length === 0 ? "text-emerald-600" : "text-rose-600")} data-import-manual-summary="">
                    {phase.upload.failures.length === 0
                      ? t("import.images.doneUploaded", { done: phase.upload.completedIds.length, total: phase.upload.total })
                      : t("import.images.doneFailed", {
                          done: phase.upload.completedIds.length,
                          total: phase.upload.total,
                          failed: phase.upload.failures.length,
                        })}
                  </p>
                )}
              </div>

              {phase.result.nodeRequests === undefined || phase.result.nodeRequests.length === 0 ? null : (
                <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5" data-import-done-node-requests="">
                  <h3 className="text-sm font-semibold text-zinc-900">
                    {t("import.done.nodeRequests", { n: phase.result.nodeRequests.length })}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-zinc-600">
                    <span>{phase.result.nodeRequests.slice(0, 5).map((request) => request.title).join("、")}</span>
                    {phase.result.nodeRequests.length > 5 ? (
                      <span className="ml-1 text-zinc-500">
                        {t("import.done.nodeRequestsMore", { n: phase.result.nodeRequests.length })}
                      </span>
                    ) : null}
                  </p>
                </section>
              )}

              {phase.result.issues.length === 0 ? null : (
                <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5" data-import-done-issues="">
                  <h3 className="text-sm font-semibold text-zinc-900">{t("import.done.issues")}</h3>
                  <ul className="mt-2">
                    {phase.result.issues.map((issue, index) => (
                      <IssueRow key={index} issue={issue} />
                    ))}
                  </ul>
                </section>
              )}

              {doneManualPending.length === 0 ? null : (
                <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-5" data-import-done-manual="">
                  <h3 className="text-sm font-semibold text-amber-900">
                    {t("import.images.remainingTitle", { n: doneManualPending.length })}
                  </h3>
                  <p className="mt-1 text-xs text-amber-800">{t("import.images.remainingHint")}</p>
                  <ManualImageList images={doneManualPending} failureById={doneFailureById} />
                  {phase.upload.failures.length === 0 ? null : (
                    <button type="button" className={secondaryButtonClass + " mt-3"} onClick={retryManualUploads} data-import-retry-manual="">
                      {t("import.images.retry")}
                    </button>
                  )}
                </section>
              )}
            </div>
          ) : null}
        </ScrollArea>

        <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-200 bg-zinc-50/70 px-6 py-4">
          {phase.kind === "uploading" ? (
            <p className="text-xs text-zinc-500">{t("import.images.uploadingFoot")}</p>
          ) : null}

          {phase.kind === "committing" ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={secondaryButtonClass} onClick={cancelCommit} data-import-cancel-commit="">
                {t("import.cancel.commit")}
              </button>
            </div>
          ) : null}

          {phase.kind === "preview" ? (
            <>
              <p className="text-xs text-zinc-500">
                {blockingCount > 0
                  ? t("import.commit.blocked", { n: blockingCount })
                  : t("import.commit.summary", {
                      code: phase.preview.project.code,
                      tasks: phase.preview.counts.tasks,
                      reports: phase.preview.counts.reports,
                      changes: phase.preview.counts.changes,
                      stakeholders: phase.preview.counts.stakeholders,
                    })}
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button type="button" className={secondaryButtonClass} onClick={onReselect} data-import-reselect="">
                  {t("import.reselect")}
                </button>
                <button type="button" className={secondaryButtonClass} onClick={onClose}>
                  {t("import.cancel")}
                </button>
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={!canCommit}
                  onClick={() => {
                    startCommit(phase.preview);
                  }}
                  data-import-commit=""
                >
                  {t("import.commit")}
                </button>
              </div>
            </>
          ) : null}

          {phase.kind === "failed" ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={secondaryButtonClass} onClick={onReselect} data-import-retry="">
                {t("import.retry")}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={onClose}>
                {t("import.close")}
              </button>
            </div>
          ) : null}

          {phase.kind === "done" ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={primaryButtonClass} onClick={onClose} data-import-finish="">
                {t("import.close")}
              </button>
            </div>
          ) : null}

        </footer>
      </div>
    </div>
  );
}
