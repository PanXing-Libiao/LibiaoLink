import { useLiveRefresh } from "../useLiveRefresh";
import { keepLiveOrder } from "../liveSync";
import { ApiError } from "../api";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { memberNameOf, type Member } from "../data/members";
import type { ReportPhoto } from "../data/reports";
import {
  TEMP_TASK_STAGE,
  dateOnlyText,
  ownersLabel,
  daysBetweenInclusive,
  lateDeliveryLabel,
  type ProjectTask,
  type TaskPriority,
  type TaskStatus,
} from "../data/tasks";
import { applyFileChange, ensurePreviewOutcome, fetchChangeRequest, fetchDownloadUrl, fetchFileVersions, finalizeFile, previewKindOf, triggerDownload, usePhotoUrl, type ChangeRequestDetail, type FilePreviewKind, type FileVersionBrief, type PreviewViewerConfig } from "../fileApi";
import { lockBodyScroll } from "../scrollLock";
import { fetchTaskDetail, toUiTask, stageKeyOfName, stageNameOf, type TaskFileBrief } from "../taskApi";
import { fieldText, isLocalizedLocale, mdText, priorityText, progressLabelOf, stageText, statusText, translationTargetOf, useLocale, useLocalizedText, useT } from "../i18n";
import { cachedZhTo, translateZhTo } from "../translateApi";
import { DateRangePicker, type DateRange } from "./DateRangePicker";
import { ChangeDetailModal } from "./ChangeDetailModal";
import { FilePreviewOverlay } from "./FilePreviewOverlay";
import { FileTypeIcon } from "./FileTypeIcon";
import { InlineDateCell } from "./InlineEdit";
import { MemberMultiSelect } from "./MemberSelect";
import { RowDeleteButton } from "./RowDeleteButton";
import { DeliverableCell, docTypeChip } from "./DeliverablePicker";
import { ScrollArea } from "./ScrollArea";
import { SelectMenu, type SelectOption } from "./SelectMenu";
import { AttachmentPicker, PhotoStrip } from "./ReportIssuePanel";
import { TRACKER_STEPS, TrackerBar, trackerStep } from "./Tracker";
import { useFocusTrapFor } from "./useFocusTrap";
const CLOSE_ANIMATION_MS = 170;
/** 「已保存」提示的停留时间。 */
const SAVED_FLASH_MS = 1600;

/**
 * 抽屉页标签（Push 254 · 业务口径「抽屉上方增加 页面标签导航栏 任务详情 变更申请 变更记录三个页面」）：
 * 任务详情 = 原抽屉内容（进度 + 字段清单）；变更申请 = 对已定档文件发起变更（A4-13 申请即通过；未定档文件行尾「定档」就地补前置门 —— Push 254 续）；
 * 变更记录 = 任务「变更关联」（R01 回写）逐条回溯 —— 列表带短原因，全文按需经变更详情接口取。
 */
type DrawerTab = "detail" | "change" | "history";
const DRAWER_TABS: Array<{ key: DrawerTab; label: string }> = [
  { key: "detail", label: "任务详情" },
  { key: "change", label: "变更申请" },
  { key: "history", label: "变更记录" },
];

/** 「变更记录」页每条的数据（Push 255）：detail = 变更全文；versions = 该文件版本链（取「变更前」v(n-1)，
 *  取不到记 null 只出「变更后」）；两者任一失败时 note = 灰字原因 + 「重试」。 */
type ChangeEntry =
  | { state: "loading" }
  | { state: "ready"; detail: ChangeRequestDetail; versions: FileVersionBrief[] | null }
  | { state: "error"; note: string };

/** 文件大小展示（变更记录版本行）：B / KB / MB / GB。 */
function fileSizeText(bytes: number): string {
  if (bytes < 1024) {
    return String(bytes) + " B";
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/** 可变更文件状态（A4-13）：只有已定档（final）/ 已变更（changed）文件可以发起变更；Push 254 续：任务已定档时的 draft 文件同视为已定档（见 taskFinalized）。 */
const CHANGEABLE_STATUS: Record<string, boolean> = { final: true, changed: true };

/** 变更申请页的文件状态签（这一页要讲清「能不能变更」—— 与「文件」行不标定档的展示口径分开）。 */
const CHANGE_FILE_STATUS_TEXT: Record<string, string> = {
  final: "已定档",
  changed: "已变更",
  draft: "未定档",
  archived: "已归档",
  recycled: "回收站",
};

/** 变更阶段下拉（A4-13「变更阶段」）：九阶段字典，与任务表阶段同名同序。 */
const CHANGE_STAGE_VALUES = ["售前规划", "设计开发", "加工采购", "组装发货", "硬件实施", "软件部署", "试运行", "生产阶段", "验收"];

/** 变更阶段展示（空 / 未知 → 「—」）。 */
function stageLabelOf(stageKey: string | null): string {
  const label = stageNameOf(stageKey);
  return label === "" ? "—" : label;
}

/** 文件状态标签（Push 226 续修 · Push 255 收窄）：**只标非定档档位** —— 「未定档 / 已定档」不再出现在文件清单里
 *  （业务口径 2026-09-29：定档是整个项目的定档安排，不由单个文件区分；定档功能后续单独开发）。
 *  Push 255（业务口径「文件显示 已变更 不如直接替换成变更后的啊 直接显示变更后添加的文件 不要显示已变更」）：
 *  changed 不再挂签 —— 变更完成后清单里这一行显示的就是**变更后的文件本身**（名称沿用 + 当前版本已是变更版本），
 *  再挂「已变更」只是赘述；归档 / 回收站档位保留（那是与在库文件的差异，仍要看得出）。 */
const FILE_STATUS_LABEL: Record<string, string> = {
  archived: "已归档",
  recycled: "回收站",
};
const FILE_STATUS_CLASS: Record<string, string> = {
  archived: "bg-zinc-100 text-zinc-500",
  recycled: "bg-zinc-100 text-zinc-400",
};

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  高: "bg-rose-50 text-rose-600",
  中: "bg-amber-50 text-amber-700",
  低: "bg-zinc-100 text-zinc-500",
};

const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  已完成: "bg-emerald-500",
  提前完成: "bg-emerald-500",
  进行中: "bg-blue-500",
  已延期: "bg-red-500",
  待开始: "bg-zinc-300",
};

const STATUS_CHIP_CLASS: Record<TaskStatus, string> = {
  已完成: "bg-emerald-50 text-emerald-700",
  提前完成: "bg-emerald-50 text-emerald-700",
  进行中: "bg-blue-50 text-blue-700",
  已延期: "bg-red-50 text-red-600",
  待开始: "bg-zinc-100 text-zinc-500",
};

/** 任务状态下拉（与任务表行内同一份五个状态、同一套色签）。 */
const STATUS_VALUES: TaskStatus[] = ["已延期", "进行中", "已完成", "待开始", "提前完成"];

/** 状态下拉选项（Push 301 字段 / 提示英译：状态名经 statusText 换当前语言；色签沿用中文字典键）。 */
function statusOptionsOf(statusOf: (value: string) => string): SelectOption[] {
  return STATUS_VALUES.map((status) => ({
    value: status,
    label: (
      <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + STATUS_CHIP_CLASS[status]}>{statusOf(status)}</span>
    ),
  }));
}

const PRIORITY_VALUES: TaskPriority[] = ["高", "中", "低"];

/** 抽屉里可编辑控件的统一外观（与任务编辑表单同一套）。 */
const FIELD_CLASS =
  "block w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10";

const CAPTION_CLASS = "mt-1 block text-[11px] leading-4 text-zinc-400";

/**
 * 「项目进展描述」整格一个框（业务口径 2026-10-13：「抽屉里面加英文的翻译」→ 追订「加在框里面好吗」）：
 * 中文编辑区 + 英文译文同框显示；焦点样式从内部 textarea 移到框上（focus-within），观感与 FIELD_CLASS 一致。
 */
const NOTE_BOX_CLASS =
  "rounded-lg border border-zinc-200 bg-white px-3 py-2 transition focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-900/10";

/** 任务编辑保存值：可编辑字段 = 项目经理（项目级，多位）/ 任务负责人（多位）/ 开始与预计完成日期（含联动天数）/ 施工人数 / 紧急重要度 / 进展描述。 */
export type TaskEditSubmit = {
  taskId: string;
  version: number;
  /** 项目经理 id 名单（项目级字段，Push 136）：至少一位，回写项目。 */
  managerIds: string[];
  /** Only an explicit manager edit may write this project-level field. */
  managerChanged: boolean;
  /** 任务负责人 id（多位，契约 ownerIds）：空数组 = 待分配。 */
  ownerIds: string[];
  /** 开始 / 预计完成日期（ISO，YYYY-MM-DD；空串 = 未填）。 */
  startDate: string;
  dueDate: string;
  days: number;
  headcount: number;
  priority: TaskPriority;
  /** 输出成果文件（2026-10-08 · 业务口径「文件输出成果也要可以选择」：常规编辑开放）。 */
  deliverableTypes: string[];
  note: string;
};

/** 抽屉里的表单草稿（「所见即所存」：抽屉打开期间不随父级刷新重置）。 */
type Draft = {
  /** 任务描述（Push 196：临时任务可改，中文必填 / 英文可留空）。 */
  title: string;
  titleEn: string;
  managerIds: string[];
  ownerIds: string[];
  range: DateRange | null;
  headcount: string;
  priority: TaskPriority;
  deliverableTypes: string[];
  note: string;
};

function rangeOf(task: ProjectTask): DateRange | null {
  const from = task.startDate;
  const to = task.dueDate;
  return from === "" || to === "" ? null : { from, to };
}

function draftOf(task: ProjectTask | null, managerIds: string[]): Draft {
  return {
    title: task === null ? "" : task.title,
    titleEn: task === null ? "" : task.titleEn,
    managerIds,
    ownerIds: task === null ? [] : [...task.ownerIds],
    range: task === null ? null : rangeOf(task),
    headcount: task !== null && task.headcount > 0 ? String(task.headcount) : "",
    priority: task === null || task.priority === null ? "中" : task.priority,
    deliverableTypes: task === null ? [] : [...task.deliverableTypes],
    note: task === null ? "" : task.note,
  };
}

type TaskDrawerProps = {
  /** 项目经理展示文本（项目级字段：多位按「、」连接；不传时回落常量占位）。 */
  managers?: string;
  /** 当前项目经理 id 名单（项目级字段，人员多选下拉的选中项，Push 136）。 */
  managerIds?: string[];
  task: ProjectTask | null;
  /** 抽屉内直接改字段后的即时保存；不传 = 抽屉只读（不渲染可编辑控件）。 */
  onSubmit?: (values: TaskEditSubmit) => Promise<number | null>;
  /**
   * 任务描述改名（Push 196 / Push 197 收窄）：只对**未归入阶段的「临时任务」**开放（阶段任务与节点 / 模板生成的任务按 A1-17 锁定，抽屉内只读）；
   * 失焦即存；不传 = 该行不渲染。
   */
  onRename?: (taskId: string, title: string, titleEn: string) => void;
  /** 点四格进度条（Push 98；联动口径同任务表 §6.4：0 格 = 待开始、1~3 格 = 进行中、4 格 = 交回完成态派生）。 */
  onProgress?: (taskId: string, progress: number) => void;
  /** 任务状态下拉（五态；联动由服务端裁决）；不传 = 状态字段只读。 */
  onSetStatus?: (taskId: string, status: TaskStatus) => void;
  /** 实际完成日期（填 = 完成、清 = 退回进行中）；不传 = 该字段只读。 */
  /**
   * 任务定档（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态，有二次提示」）：
   * 头部状态签旁「定档」开关点开 = 就地二次确认；确认后由调用方 POST …/tasks/{taskId}/finalize
   * （置位后任务不支持任何修改 —— 服务端 409 TASK_FINALIZED 兜底）；不传 = 未定档任务不渲染开关。
   */
  onSetActualEnd?: (taskId: string, iso: string) => void;
  onFinalize?: (taskId: string) => void;
  /**
   * 任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：已定档时「已」开关可再点 →
   * 就地二次确认；确认后由调用方 POST …/tasks/{taskId}/unfinalize（清位重开、留痕「取消定档」）；
   * 不传 = 已定档开关保持只读置灰。
   */
  onUnfinalize?: (taskId: string) => void;
  /**
   * 任务文件上传（Push 226 · 「文件」那一刀前端接线）：选完文件由调用方分片直传文件库并关联本任务（taskId）；
   * onProgress 供抽屉内「上传中 N/M」提示（done = 已完成份数）。不传 = 「文件」行只读（保留计数展示、无上传入口）。
   */
  onUploadFiles?: (taskId: string, files: File[], onProgress?: (done: number, total: number) => void) => Promise<void>;
  /**
   * 任务文件删除（Push 226 续）：抽屉清单里「删除」= 移入回收站（M4-02，30 天内可恢复），由调用方执行
   * （成功后整表重取刷新计数）；不传 = 清单不显示删除入口。
   */
  onDeleteFile?: (fileId: string) => Promise<void>;
  /**
   * 任务文件改名（Push 226 续二 · 业务口径「名称要可以修改」）：清单里点文件名进编辑 —— 只改主名、
   * 后缀由系统保留（同日报附图口径）；回车 / 失焦提交、Esc 取消、空名 / 没改不写回。由调用方执行并整表重取。
   * 不传 = 文件名只读。
   */
  onRenameFile?: (fileId: string, name: string) => Promise<void>;
  /** 当前登录人姓名（Push 254 · 「变更申请」页「变更申请人 / 填写者」只读展示 —— 提交时由服务端记 appliedBy）。 */
  actorName?: string;
  /**
   * 变更生效后的父级刷新（Push 254 · 抽屉「变更申请」页）：提交成功 = 变更记录 + 文件新版本 + 任务
   * 「变更关联」（R01 同事务回写）都已落库 —— 由调用方整表重取，把最新文件状态与变更关联带回来；
   * 不传 = 提交后只刷新抽屉内的文件清单。
   */
  onChanged?: () => void;
  /** 任务文件清单（详情接口 GET /projects/{id}/tasks/{taskId}）：不传 = 只显示列表随行计数（fileSummary）。 */
  projectId?: string;
  /** 人员候选（GET /api/v1/users 目录）：项目经理 / 任务负责人两个多选共用。 */
  members: readonly Member[];
  onClose: () => void;
};

/**
 * 任务详情抽屉（Push 63）：点任务行 / 看板卡片打开。
 * **要改直接在抽屉里改**（Push 88 业务口径：「编辑任务」弹窗不再需要）—— 项目经理 / 任务负责人 / 紧急重要度选完即存，
 * 日期区间选完即存，施工人数 / 进展描述失焦时存（值没变不写，避免无谓刷新项目时间）；保存后右下角闪一下「已保存」。
 * 进度自 Push 98 起也能在抽屉里改：进度条长度不变，**四颗点平均分布在条上**（刚开工 / 完成一半 / 快完成了 / 已完成），点哪颗写哪档；
 * 任务状态与实际完成日期自 Push 101 起也能在抽屉里直接改（口径与任务表行内 / 看板卡片完全一致，§6.9：
 * 状态 ↔ 四格进度双向联动、改成非完成态会清空实际完成日期；填实际完成日期 = 完成、清空 = 退回进行中）；
 * 仍只读：是否按时交付（读时派生）、变更关联（输出成果文件 2026-10-08 起可改 —— 业务口径「文件输出成果也要可以选择」）；
 * 「文件」自 Push 226 起可在抽屉内直接上传（点击「＋ 上传文件」→ 分片直传文件库并关联本任务；上传完成自动重取清单）；
 * 文件名 / 文档类型 / 状态清单随详情接口（GET …/tasks/{taskId}）下发；Push 226 续：清单里每份文件可「删除」（= 移入回收站，二次确认），
 * 图片文件点**缩略图**看大图预览（懒取短时签名 —— 点开才请求）；**点文件名改名**（Push 226 续二 · 只改主名、后缀保留）；
 * 每份文件可「下载」（Push 226 续四 · 原文件 attachment 签名 —— 与预览转换件区分；预览浮层 caption 也挂了「下载原文件」）；「未定档 / 已定档」不做文件级展示（定档是整个项目的安排，功能后续单独开发），
 * 版本 / 定档 / 回收站管理等文件库操作仍走站内文件库（后续切片）。
 * 任务描述（中文 / 英文）自 Push 196 起对「临时任务」开放（**Push 197 收窄：仅未归入阶段的临时任务** —— 业务口径 2026-09-28「这个不是临时任务 不能修改」；失焦即存，中文名必填），
 * 阶段任务与节点 / 模板生成的任务仍锁定（抽屉里不出这一行，服务端同口径 400 兜底）。
 */
export function TaskDrawer({ task, managers, managerIds = [], members, onSubmit, onRename, onProgress, onSetStatus, onSetActualEnd, onFinalize, onUnfinalize, onChanged, actorName, onUploadFiles, onDeleteFile, onRenameFile, projectId, onClose }: TaskDrawerProps) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const taskId = task === null ? null : task.id;
  const [draft, setDraft] = useState<Draft>(() => draftOf(task, managerIds));
  const baseDraft = useRef(draft);
  const baseVersion = useRef(task?.version ?? 0);
  const [unavailable, setUnavailable] = useState(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveFailed = useRef(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [latestDraft, setLatestDraft] = useState<{ version: number; draft: Draft } | null>(null);
  const identityRef = useRef(taskId);
  identityRef.current = taskId;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** 抽屉键盘焦点陷阱（Push 264 追订）：开着时 Tab 在抽屉内循环、关闭后焦点还回触发行；换任务（aside 重建）也能继续认门。 */
  const drawerRef = useRef<HTMLElement | null>(null);
  useFocusTrapFor(drawerRef, task !== null);
  /** 「已保存」提示（非 0 = 展示中）。 */
  const [savedTick, setSavedTick] = useState(0);
  /** 悬停 / 聚焦中的进度档位（0 = 没有）：悬停时档位文字与进度条一起预览点完的样子。 */
  const [hoveredStep, setHoveredStep] = useState(0);
  /** 「文件」行详情清单（Push 226）：null = 还没取到（或未接线）；[] = 确实没有文件。 */
  const [files, setFiles] = useState<TaskFileBrief[] | null>(null);
  /** 清单重取版本号：上传完成后 +1。 */
  const [filesTick, setFilesTick] = useState(0);
  /** 上传中的份数进度（null = 没有上传）。 */
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  /** 预览浮层（Push 226 续 / 续三 · S4 两通道）：点清单里的图片 / PDF → 产物浮层（大图 / 内置查看器 iframe）；
   *  Office / 文本族 → ONLYOFFICE 查看器外壳（viewer 配置逐字下发）。nonce = 重试自增，强制重建查看器（重取 token）。null = 未开。 */
  const [preview, setPreview] = useState<{
    pane: { mode: "url"; url: string } | { mode: "viewer"; viewer: PreviewViewerConfig };
    name: string;
    kind: FilePreviewKind;
    fileId: string;
    /** Push 255：版本态预览（变更记录里预览「变更前 / 变更后」）—— null = 当前版本（文件清单口径不变）。 */
    versionId: string | null;
    nonce: number;
  } | null>(null);
  /** 正在取预览签名的文件 id（null = 没有）。 */
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  /** 预览 / 下载取不到时的一行灰字提示（null = 不显示）。 */
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  /** 正在取下载签名的文件 id（Push 226 续四；null = 没有）。 */
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  /** 待二次确认删除的文件 id（null = 没有）。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 定档二次确认条（Push 252）：开关点开 = 就地提示「定档后不支持任何修改」，确认才调接口落库。 */
  const [finalizeConfirm, setFinalizeConfirm] = useState(false);
  /** 取消定档二次确认条（Push 260）：已定档开关再次点击 = 就地提示「取消后重新开放修改」，确认才调接口。 */
  const [unfinalizeConfirm, setUnfinalizeConfirm] = useState(false);
  /** 正在改名的文件 id（Push 226 续二；null = 没有在改名）。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** 编辑中的**主名**（后缀不参与编辑 —— 同日报口径「自定义把图片png格式删了怎么办」：格式由系统保留）。 */
  const [renameText, setRenameText] = useState("");
  /** 编辑中保留的后缀（含点；没后缀 = 空串）。 */
  const [renameExt, setRenameExt] = useState("");
  /** 页标签（Push 254）：默认「任务详情」；换任务时回到默认页。 */
  const [tab, setTab] = useState<DrawerTab>("detail");
  /** 「变更申请」页（A4-13 十三列字段面）：目标文件 / 变更阶段 / 变更内容描述 / 变更原因 / 变更前后 / 变更后文件。 */
  const [changeTargetId, setChangeTargetId] = useState<string | null>(null);
  const [changeStage, setChangeStage] = useState("");
  const [changeContent, setChangeContent] = useState("");
  const [changeCause, setChangeCause] = useState("");
  const [changeBefore, setChangeBefore] = useState("");
  const [changeAfter, setChangeAfter] = useState("");
  const [changeFile, setChangeFile] = useState<File | null>(null);
  /** Push 314（业务口径「这个变更要可以填图片」）：变更前 / 变更后摘要附图（粘贴 / 选图；随会话 fileIds 提交）。 */
  const [changeBeforePhotos, setChangeBeforePhotos] = useState<ReportPhoto[]>([]);
  const [changeAfterPhotos, setChangeAfterPhotos] = useState<ReportPhoto[]>([]);
  const changeInputRef = useRef<HTMLInputElement | null>(null);
  /** 变更提交中（防连点）与提交结果（成功绿条 / 失败红条）。 */
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeDone, setChangeDone] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  /** 「变更文件」就地定档（Push 254 续 · 业务反馈「这个选择不了啊」）：未定档文件行尾「定档」→ 就地二次确认 → 定档后该行随即可选。 */
  const [changeFinalizeId, setChangeFinalizeId] = useState<string | null>(null);
  const [changeFinalizeBusy, setChangeFinalizeBusy] = useState(false);
  const [changeFinalizeDone, setChangeFinalizeDone] = useState<string | null>(null);
  /** 「变更记录」页（Push 255 重构）：每条的详情 + 版本链随页预取 —— 列表行就要显示「之前是什么文件 / 这次是什么文件」，
   *  不能再等点「详情」才取；changeDetailId = 展开全文的那一条（数据已预取，展开只是展示切换）。 */
  const [changeDetailId, setChangeDetailId] = useState<string | null>(null);
  const [changeEntries, setChangeEntries] = useState<Record<string, ChangeEntry>>({});
  /** 「变更关联」点击弹窗（Push 256 · 业务口径「变更关联点击后要显示一个这样的内容在中间」）：非空 = 屏幕中央展示该变更的「变更管理」详情。 */
  const [changeModalId, setChangeModalId] = useState<string | null>(null);
  /** 预取重试版本号：取不到时点「重试」+1，触发预取 effect 重跑。 */
  const [changeDetailTick, setChangeDetailTick] = useState(0);

  /**
   * 「项目进展描述」英译（业务口径 2026-10-13「抽屉里面加英文的翻译」）：{ text, en } 成对存 ——
   * text 与当前原文一致才显示，改了输入就自动隐藏到新译文回来（防旧译文配新中文）。
   */
  const [noteEn, setNoteEn] = useState<{ text: string; en: string; target: string } | null>(null);
  /**
   * 语言切换（Push 296 追订 · 业务口径「因为页面有些内容是手打的 我建议是提前后台机翻」）：
   * 英文界面下抽屉标题按「titleEn 优先 → 机翻 → 原文」显示、副行给中文原名对照；
   * 只读态「项目进展描述」显示机翻译文（悬停看原文）；编辑态仍编辑中文原文（下方英译小字保留）。
   */
  const locale = useLocale();
  const t = useT();
  const localizedTitle = useLocalizedText(task === null ? "" : task.title);
  const localizedReadNote = useLocalizedText(task === null ? "" : task.note);
  const drawerTitleText = task === null
    ? ""
    : isLocalizedLocale(locale)
      ? (locale === "en" && task.titleEn !== "" ? task.titleEn : localizedTitle)
      : task.title;
  const drawerTitleSub = task === null
    ? ""
    : isLocalizedLocale(locale)
      ? (drawerTitleText === task.title ? "" : task.title)
      : task.titleEn;
  /** 「项目进展描述」输入框（随内容自适应高度，见下面的 resize effect）。 */
  const noteFieldRef = useRef<HTMLTextAreaElement | null>(null);
  /** 预取循环读的最新快照（避免闭包拿到旧值重复取）。 */
  const changeEntriesRef = useRef(changeEntries);
  changeEntriesRef.current = changeEntries;

  useEffect(() => {
    closingRef.current = false;
    setClosing(false);
    setSavedTick(0);
    setHoveredStep(0);
    setFiles(null);
    setFilesTick(0);
    setUploading(null);
    setPreview(null);
    setPreviewBusy(null);
    setPreviewNote(null);
    setDownloadBusy(null);
    setPendingDelete(null);
    setFinalizeConfirm(false);
    setRenamingId(null);
    setRenameText("");
    setRenameExt("");
    setTab("detail");
    setChangeTargetId(null);
    // 变更阶段默认 = 任务所属阶段（临时任务没有阶段 → 留空，提交前必选）
    setChangeStage(task === null ? "" : task.stageKey ?? stageKeyOfName(task.stage) ?? "");
    setChangeContent("");
    setChangeCause("");
    setChangeBefore("");
    setChangeAfter("");
    setChangeFile(null);
    setChangeBusy(false);
    setChangeDone(false);
    setChangeError(null);
    setChangeFinalizeId(null);
    setChangeFinalizeBusy(false);
    setChangeFinalizeDone(null);
    setChangeDetailId(null);
    setChangeEntries({});
    setChangeDetailTick(0);
    const initial = draftOf(task, managerIds);
    baseDraft.current = initial;
    baseVersion.current = task?.version ?? 0;
    setUnavailable(false);
    saveFailed.current = false;
    setSaveNote(null);
    setLatestDraft(null);
    setDraft(initial);
    // 换任务时把草稿重置成新任务的字段；同一个任务上父级刷新不重置，避免打断正在输入的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const draftDirty = JSON.stringify(draft) !== JSON.stringify(baseDraft.current);
  const protectingDraft = draftDirty || saveNote !== null || changeContent !== "" || changeCause !== "" || changeBefore !== "" || changeAfter !== "" || changeBeforePhotos.length > 0 || changeAfterPhotos.length > 0 || changeFile !== null || renamingId !== null || pendingDelete !== null || finalizeConfirm || unfinalizeConfirm;
  useEffect(() => {
    if (task === null || protectingDraft || (document.activeElement instanceof HTMLElement && drawerRef.current?.contains(document.activeElement) && document.activeElement.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]'))) return;
    const next = draftOf(task, managerIds);
    baseDraft.current = next;
    baseVersion.current = task.version;
    setDraft(next);
  }, [task?.version, managerIds.join(","), protectingDraft]);

  useLiveRefresh(["files", "tasks", "permissions"], async () => {
    if (projectId === undefined || taskId === null) return () => {};
    try {
      const detail = await fetchTaskDetail(projectId, taskId);
      const entries: Record<string, ChangeEntry> = {};
      if (tab === "history") {
        for (const change of detail.changeLinks ?? []) {
          const row = await fetchChangeRequest(change.id);
          const versions = row.fileId === null ? null : await fetchFileVersions(row.fileId);
          entries[change.id] = { state: "ready", detail: row, versions };
        }
      }
      return () => { setFiles((previous) => keepLiveOrder(previous ?? [], detail.files)); setUnavailable(false); if (tab === "history") setChangeEntries(entries); };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return () => { setUnavailable(true); setFiles([]); setPreviewNote(t("drawer.gone")); };
      throw error;
    }
  }, String(projectId) + ":" + String(taskId) + ":" + tab, taskId !== null, { readOnly: true });

  useEffect(() => {
    if (projectId === undefined || taskId === null) {
      return undefined;
    }
    let alive = true;
    void (async () => {
      try {
        const detail = await fetchTaskDetail(projectId, taskId);
        if (alive) {
          setFiles(detail.files);
        }
      } catch {
        // 清单取不到不打断抽屉：计数仍走列表随行摘要（fileSummary）
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, taskId, filesTick]);

  useEffect(() => {
    if (taskId === null) {
      return;
    }
    // Push 186：锁滚动时按滚动条实测宽度补 padding-right，否则抽屉一开一关会把整张表横向撑开再缩回（浏览器看起来是「抖一下」）。
    // 细节与还原口径见 frontend/src/scrollLock.ts。
    return lockBodyScroll();
  }, [taskId]);

  useEffect(() => {
    if (savedTick === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSavedTick(0);
    }, SAVED_FLASH_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [savedTick]);

  /** 「变更记录」页预取（Push 255）：进页即逐条取全文 + 版本链（列表行显示变更前 / 变更后文件）——
   *  已取到（或已取败）的不重复取；「重试」经 changeDetailTick 触发重跑。 */
  const changeIdsKey = task === null ? "" : task.changes.map((change) => change.id).join(",");
  useEffect(() => {
    if (tab !== "history" || changeIdsKey === "") {
      return undefined;
    }
    let alive = true;
    void (async () => {
      for (const id of changeIdsKey.split(",")) {
        if (changeEntriesRef.current[id] !== undefined) {
          continue;
        }
        setChangeEntries((previous) => (previous[id] === undefined ? { ...previous, [id]: { state: "loading" } } : previous));
        try {
          const detail = await fetchChangeRequest(id);
          const versions = detail.fileId === null ? null : await fetchFileVersions(detail.fileId).catch(() => null);
          if (!alive) {
            return;
          }
          setChangeEntries((previous) => ({ ...previous, [id]: { state: "ready", detail, versions } }));
        } catch (error: unknown) {
          if (!alive) {
            return;
          }
          setChangeEntries((previous) => ({
            ...previous,
            [id]: { state: "error", note: error instanceof Error && error.message !== "" ? error.message : t("drawer.record.missing") },
          }));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, changeIdsKey, changeDetailTick]);

  /** 「项目进展描述」英译原文：编辑态取草稿、只读态取任务现值（与保存口径一致，首尾空白不参与翻译）。 */
  const noteText = task === null ? "" : (onSubmit === undefined ? task.note : draft.note).trim();
  const noteTarget = translationTargetOf(locale);

  /**
   * 取「项目进展描述」英译（业务口径 2026-10-13「抽屉里面加英文的翻译」）：会话缓存命中立即显示；
   * 未命中则等输入停顿 600ms 再经译文通道取（与导出报告同一缓存，见 src/translateApi.ts）——失败 / 空文本不显示小字。
   */
  useEffect(() => {
    if (noteText === "" || noteTarget === null) {
      return;
    }
    const cached = cachedZhTo(noteText, noteTarget);
    if (cached !== null) {
      setNoteEn({ text: noteText, en: cached, target: noteTarget });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void translateZhTo([noteText], noteTarget).then((map) => {
        const en = map.get(noteText);
        if (!cancelled && en !== undefined) {
          setNoteEn({ text: noteText, en, target: noteTarget });
        }
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [noteText, noteTarget]);

  // 「项目进展描述」框随内容长（业务口径 2026-10-13 追订「正下方不要空这么多」）：一行就只占一行高、
  // 多行随文字长高（超过 max-h 才出内部滚动）—— 英文小字紧跟中文，不再顶着固定 3 行高度的空白。
  useEffect(() => {
    const element = noteFieldRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = element.scrollHeight + "px";
  }, [draft.note]);

  /** 「项目进展描述」译文小字（与中文同框；只读态在原文下方）：与导出报告同款灰色小字，取不到就不显示。 */
  const noteEnLine =
    noteEn !== null && noteEn.text === noteText && noteEn.target === noteTarget ? (
      <p data-note-en="true" lang={noteEn.target} className="mt-1 text-[11px] leading-4 text-zinc-400">
        {noteEn.en}
      </p>
    ) : null;

  const requestClose = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(onClose, CLOSE_ANIMATION_MS);
  }, [onClose]);

  useEffect(() => {
    if (taskId === null) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (finalizeConfirm) {
          // 「Esc 先关内层」（Push 252）：二次确认条开着时先收确认条，不连带关抽屉
          setFinalizeConfirm(false);
          return;
        }
        if (unfinalizeConfirm) {
          // 「Esc 先关内层」（Push 260）：取消定档确认条同口径
          setUnfinalizeConfirm(false);
          return;
        }
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [taskId, requestClose, finalizeConfirm, unfinalizeConfirm]);

  /** 改草稿：ref 与 state 一起写 —— 失焦可能与最后一次输入同一批处理，只写 state 会让失焦读到旧值。 */
  const updateDraft = useCallback((patch: Partial<Draft>) => {
    const next: Draft = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    return next;
  }, []);

  /** 即时保存：把草稿与改动合成一份完整保存值（字段口径同任务表行内编辑）。 */
  const commit = useCallback(
    (patch: Partial<Draft>) => {
      const current = task;
      if (current === null || onSubmit === undefined || unavailable) {
        return;
      }
      const next = updateDraft(patch);
      saveChain.current = saveChain.current.then(async () => {
        if (identityRef.current !== current.id || saveFailed.current) return;
        const headcountText = next.headcount.trim();
        const headcountValue = headcountText === "" ? 0 : Number(headcountText);
        const version = await onSubmit({
          taskId: current.id,
          version: baseVersion.current,
          managerIds: next.managerIds,
          managerChanged: next.managerIds.length !== baseDraft.current.managerIds.length || next.managerIds.some((id) => !baseDraft.current.managerIds.includes(id)),
          ownerIds: next.ownerIds,
          startDate: next.range === null ? "" : next.range.from,
          dueDate: next.range === null ? "" : next.range.to,
          days: next.range === null ? 0 : daysBetweenInclusive(next.range.from, next.range.to),
          headcount: headcountText === "" || Number.isNaN(headcountValue) ? 0 : Math.floor(headcountValue),
          priority: next.priority,
          deliverableTypes: next.deliverableTypes,
          note: next.note.trim(),
        });
        if (identityRef.current !== current.id) return;
        if (version === null) {
          saveFailed.current = true;
          setSaveNote(t("drawer.save.failed"));
          return;
        }
        baseVersion.current = version;
        baseDraft.current = next;
        setSavedTick(Date.now());
        setSaveNote(null);
      }).catch(() => {
        if (identityRef.current !== current.id) return;
        saveFailed.current = true;
        setSaveNote(t("drawer.save.failed"));
      });
    },
    [onSubmit, task, updateDraft, unavailable],
  );

  if (task === null) {
    return null;
  }

  const editable = onSubmit !== undefined && !unavailable;
  /** 任务描述改名（Push 196 / Push 197 收窄）：只有**未归入阶段**的「临时任务」能改 —— 归入阶段的任务即便没有来源节点也锁定（A1-17；服务端同口径 400 兜底）。 */
  const titleEditable = onRename !== undefined && task.stage === "" && task.nodeId === null && task.sourceNodeId === null;
  const canEditStatus = onSetStatus !== undefined;
  const canEditActualEnd = onSetActualEnd !== undefined;
  /** 逾期提示与服务端展示态同一口径（已延期 = 未完成且过了预计完成日期）。 */
  const overdue = task.status === "已延期";
  /** 「是否按时交付」的逾期标注（服务端展示态 + onTime 派生）。 */
  const late = lateDeliveryLabel(task);
  const status = task.status;
  const step = trackerStep(task.progress);
  /** 悬停预览：还没点就先亮到悬停那一档（进度条长度不变，只有填充随预览走）。 */
  const shownStep = hoveredStep > 0 ? hoveredStep : step;
  const stepPct = Math.round((shownStep / TRACKER_STEPS) * 100);
  const progressText = progressLabelOf(locale, hoveredStep > 0 ? hoveredStep : step);
  const fullOwners = ownersLabel(task.owners);
  /** 进度条与条上那四颗点一律用绿色（与任务表四格点 `bg-emerald-500` 同一个绿）—— 进度条只表达「做了多少」，
   *  状态色由状态签与色点单独表达；业务反馈：灰的看不懂，要和任务表一样绿。 */
  const barClass = "bg-emerald-500";
  /** 点亮的点 = 实心绿 + 白描边（压在绿条上也能看清）。 */
  const dotOnClass = "border-white bg-emerald-500";
  const dotClass = STATUS_DOT_CLASS[status];
  const statusChipClass = STATUS_CHIP_CLASS[status];
  const dash = <span className="text-zinc-300">—</span>;
  /** Push 301：字段 / 下拉 / 徽标显示名按当前语言换词（状态 / 优先级 / 变更阶段；数据层键仍是中文）。 */
  const statusOptions = statusOptionsOf((value) => statusText(locale, value));
  const priorityOptions: SelectOption[] = PRIORITY_VALUES.map((value) => ({ value, label: priorityText(locale, value) }));
  const changeStageOptions: SelectOption[] = CHANGE_STAGE_VALUES.map((name) => ({ value: stageKeyOfName(name) ?? name, label: stageText(locale, name) }));

  const draftDays = draft.range === null ? 0 : daysBetweenInclusive(draft.range.from, draft.range.to);
  const shownDays = editable ? draftDays : task.days;
  const headcountText = draft.headcount.trim();
  const headcountValue = headcountText === "" ? 0 : Number(headcountText);
  const headcountInvalid = headcountText !== "" && (Number.isNaN(headcountValue) || headcountValue < 0);
  /** 任务描述校验（Push 196）：中文名必填 —— 输入过程中为空只标红提示，失焦时还原成原值、不写库。 */
  const titleInvalid = titleEditable && draft.title.trim() === "";
  /** 「变更申请」页只读展示：变更时间（提交当天 = 系统记录口径）与变更申请人（当前登录人）。 */
  const changeToday = dateOnlyText(new Date().toISOString());
  const changeApplicant = actorName === undefined || actorName === "" ? t("drawer.currentUser") : actorName;

  /** 「文件」行（Push 226）：选文件 → 调用方分片直传（关联本任务）→ 完成后重取清单（列表计数由调用方刷新）。 */
  const beginFileUpload = (picked: FileList | null) => {
    if (picked === null || onUploadFiles === undefined) {
      return;
    }
    const list = Array.from(picked);
    if (list.length === 0) {
      return;
    }
    setUploading({ done: 0, total: list.length });
    void onUploadFiles(task.id, list, (done, total) => {
      setUploading({ done, total });
    }).finally(() => {
      setUploading(null);
      setFilesTick((tick) => tick + 1);
    });
  };

  /** 预览（Push 226 续 · S4 两通道裁决）：点开才懒取 —— 早先预览读取会写「查看」审计，不该随清单一开就铺开申请；Push 283 起预览不再写审计（操作日志不记录预览动作），懒取仍保留（不随清单铺开无谓的签发请求）。
   *  viewer = ONLYOFFICE 查看器外壳（Office / 文本族）；url = 产物浮层（图片大图 / PDF iframe）；
   *  unavailable = 确定性降级（failed / 判不出通道 —— 服务端 reason 或「请下载查看」口径）。 */
  const openPreview = async (fileId: string, name: string, versionId?: string) => {
    if (previewBusy !== null) {
      return;
    }
    setPreviewBusy(fileId);
    setPreviewNote(null);
    const outcome = await ensurePreviewOutcome(fileId, versionId);
    setPreviewBusy(null);
    const kind = previewKindOf(name) ?? "image";
    if (outcome.kind === "unavailable") {
      setPreviewNote(outcome.reason ?? t("drawer.preview.unavailable"));
      return;
    }
    if (outcome.kind === "viewer") {
      setPreview({ pane: { mode: "viewer", viewer: outcome.viewer }, name, kind, fileId, versionId: versionId ?? null, nonce: 0 });
      return;
    }
    setPreview({ pane: { mode: "url", url: outcome.url }, name, kind, fileId, versionId: versionId ?? null, nonce: 0 });
  };

  /** 查看器外壳「重试」（S4 · R5）：重取查看器配置（token 随签发刷新）+ nonce 自增强制重建；
   *  仍取不到（failed / 超时）→ 关浮层 + 一行灰字降级提示。 */
  const retryPreview = async (fileId: string, name: string, versionId?: string) => {
    if (previewBusy !== null) {
      return;
    }
    setPreviewBusy(fileId);
    const outcome = await ensurePreviewOutcome(fileId, versionId);
    setPreviewBusy(null);
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
      return { pane, name, kind: previous.kind, fileId, versionId: previous.versionId, nonce: previous.nonce + 1 };
    });
  };

  /** 下载原文件（Push 226 续四 · 业务口径「下载为什么都是pdf 你是不是签名调用错了」）：取当前版本的
   *  attachment 短时签名（原文件字节 + 原文件名；服务端写 download 审计），再触发浏览器落盘 ——
   *  与预览区分（S4）：Office / 文本族走 ONLYOFFICE 查看器渲染、图片 / PDF 走产物浮层；下载始终拿原文件。 */
  const downloadFile = async (fileId: string, versionId?: string) => {
    if (downloadBusy !== null) {
      return;
    }
    setDownloadBusy(versionId === undefined ? fileId : versionId);
    setPreviewNote(null);
    try {
      const signed = await fetchDownloadUrl(fileId, versionId);
      await triggerDownload(signed.url, signed.fileName);
    } catch (error) {
      setPreviewNote(error instanceof Error && error.message !== "" ? error.message : t("drawer.download.failed"));
    } finally {
      setDownloadBusy(null);
    }
  };

  /** 开始改名（Push 226 续二）：主名进输入框、后缀原位保留（图片 png 格式不会被改掉）。 */
  const startFileRename = (file: TaskFileBrief) => {
    const dot = file.name.lastIndexOf(".");
    const hasExt = dot > 0 && dot < file.name.length - 1;
    setRenamingId(file.id);
    setRenameText(hasExt ? file.name.slice(0, dot) : file.name);
    setRenameExt(hasExt ? file.name.slice(dot) : "");
  };

  /** 提交改名（Push 226 续二）：空名 / 没改 = 原样不写回；由调用方执行，完成重取清单（表格列由调用方整表重取刷新）。 */
  const commitFileRename = (file: TaskFileBrief) => {
    const base = renameText.trim();
    const next = base === "" ? file.name : base + renameExt;
    setRenamingId(null);
    if (onRenameFile === undefined || next === file.name) {
      return;
    }
    void onRenameFile(file.id, next).finally(() => {
      setFilesTick((tick) => tick + 1);
    });
  };

  /** 删除文件（Push 226 续 · 移入回收站）：二次确认后由调用方执行，完成重取清单（表格计数由调用方整表重取刷新）；
   *  任务已定档 = 删除入口整体下架（Push 260 · 业务口径「定档后还能删除是bug 不能删除定档后」；服务端 recycle 同闸
   *  409 TASK_FINALIZED）—— 本函数仍是二次确认后的唯一出口。 */
  const confirmFileDelete = (fileId: string) => {
    setPendingDelete(null);
    if (onDeleteFile === undefined) {
      return;
    }
    void onDeleteFile(fileId).finally(() => {
      setFilesTick((tick) => tick + 1);
    });
  };

  /** 失焦才存的字段（施工人数 / 进展描述）：值没变就不写；人数不合法时不写（红字提示留着）。
   *  读 `draftRef` 而不是渲染期的 `draft` —— 失焦可能与最后一次输入同一批处理，渲染期的值会是旧的。 */
  const commitDraft = () => {
    if (onSubmit === undefined) {
      return;
    }
    const current = draftRef.current;
    const text = current.headcount.trim();
    const value = text === "" ? 0 : Number(text);
    if (text !== "" && (Number.isNaN(value) || value < 0)) {
      return;
    }
    const nextHeadcount = text === "" ? 0 : Math.floor(value);
    if (nextHeadcount === task.headcount && current.note.trim() === task.note) {
      return;
    }
    commit({});
  };

  /**
   * 任务描述改名（Push 196）：失焦即存（与施工人数 / 进展描述同一套「值没变不写」）；
   * 中文名必填 —— 清空失焦时还原成原值、不写库。
   */
  const commitTitle = () => {
    if (!titleEditable || onRename === undefined) {
      return;
    }
    const current = draftRef.current;
    const nextTitle = current.title.trim();
    if (nextTitle === "") {
      updateDraft({ title: task.title });
      return;
    }
    const nextTitleEn = current.titleEn.trim();
    if (nextTitle === task.title && nextTitleEn === task.titleEn) {
      return;
    }
    updateDraft({ title: nextTitle, titleEn: nextTitleEn });
    onRename(task.id, nextTitle, nextTitleEn);
    setSavedTick(Date.now());
  };

  /** 任务已定档（Push 254 续 · 业务口径「不是已经定档了吗 为什么变更申请里面还是未定档」）：定档的可见口径是任务级动作（抽屉开关 / 表格侧签），已定档任务的 draft 文件同视为「定档后的文件」。 */
  const taskFinalized = task !== null && task.finalizedAt !== null;
  /** 可变更的目标文件（A4-13；Push 254 续）：状态 final / changed 的行，或任务已定档时的 draft 行。 */
  const changeableFiles = (files ?? []).filter((file) => CHANGEABLE_STATUS[file.status] === true || (taskFinalized && file.status === "draft"));
  /** 当前选中的变更目标（清单刷新后可能消失 —— 找不到按未选处理）。 */
  const changeTarget = (files ?? []).find((file) => file.id === changeTargetId) ?? null;

  /** 变更后文件选择（单份；选完在页面上显示文件名）。 */
  const pickChangeFile = (picked: FileList | null) => {
    if (picked === null) {
      return;
    }
    const list = Array.from(picked);
    if (list.length === 0) {
      return;
    }
    setChangeFile(list[0]);
    setChangeDone(false);
    setChangeError(null);
  };

  /**
   * 提交变更（A4-13 提交校验 + 一期「申请即通过」）：变更文件 / 变更内容描述 / 变更阶段 / 变更后文件四道必填 ——
   * 前端先拦一道（服务端同口径兜底：非定档 409 FILE_STATE_INVALID / 缺校验 400）；
   * 变更原因（选填）非空时与内容描述合并记入契约 reason（读面「变更原因」按该文本展示）；
   * 分片直传（intent=change）完成即生效：变更记录 + 新版本 + 文件状态 changed + R01 回写任务关联。
   * 成功后重取抽屉内文件清单，并让调用方整表重取（文件计数 / 变更关联回流）。
   */
  /** Push 314：可随变更提交的摘要附图 fileIds（上传中 / 失败的不在内 —— 提交入口先拦上传态）。 */
  const readySummaryFileIds = (photos: readonly ReportPhoto[]) =>
    photos.filter((photo) => photo.pending === undefined && photo.fileId !== "").map((photo) => photo.fileId);

  /** Push 314：读面摘要附图（只给 fileId）→ 展示条目（占位名作标题 / 预览字幕，图片按 id 懒取签名）。 */
  const summaryPhotoItems = (fileIds: readonly string[]): ReportPhoto[] =>
    fileIds.map((fileId, index) => ({ fileId, name: t("drawer.change.photo.name", { n: String(index + 1) }), url: null }));

  const submitChange = () => {
    if (changeBusy || projectId === undefined) {
      return;
    }
    if (changeTarget === null) {
      setChangeError(t("drawer.change.err.file"));
      return;
    }
    if (changeContent.trim() === "") {
      setChangeError(t("drawer.change.err.content"));
      return;
    }
    if (changeStage === "") {
      setChangeError(t("drawer.change.err.stage"));
      return;
    }
    if (changeFile === null) {
      setChangeError(t("drawer.change.err.newFile"));
      return;
    }
    if (changeBeforePhotos.some((photo) => photo.pending === "uploading") || changeAfterPhotos.some((photo) => photo.pending === "uploading")) {
      setChangeError(t("report.uploadPending"));
      return;
    }
    if (changeBeforePhotos.some((photo) => photo.pending === "failed") || changeAfterPhotos.some((photo) => photo.pending === "failed")) {
      setChangeError(t("report.uploadFailed"));
      return;
    }
    const cause = changeCause.trim();
    const reason = cause === "" ? changeContent.trim() : changeContent.trim() + t("drawer.change.reasonJoin") + cause;
    setChangeBusy(true);
    setChangeDone(false);
    setChangeError(null);
    void applyFileChange(projectId, changeTarget, changeFile, {
      reason,
      beforeSummary: changeBefore,
      afterSummary: changeAfter,
      beforeSummaryFileIds: readySummaryFileIds(changeBeforePhotos),
      afterSummaryFileIds: readySummaryFileIds(changeAfterPhotos),
      stageKey: changeStage,
    }, taskFinalized)
      .then(() => {
        setChangeDone(true);
        setChangeTargetId(null);
        setChangeContent("");
        setChangeCause("");
        setChangeBefore("");
        setChangeAfter("");
        setChangeBeforePhotos([]);
        setChangeAfterPhotos([]);
        setChangeFile(null);
        setFilesTick((tick) => tick + 1);
        onChanged?.();
      })
      .catch((error: unknown) => {
        setChangeError(error instanceof Error && error.message !== "" ? error.message : t("drawer.change.err.submit"));
      })
      .finally(() => {
        setChangeBusy(false);
      });
  };

  /**
   * 「变更文件」就地定档（Push 254 续 · 业务反馈「这个选择不了啊」）：未定档文件行尾「定档」把变更前置门
   * （A4-13：只有已定档文件可以发起变更）就地补上 —— POST /files/{id}/finalize（draft → final 锁版；
   * 挂接任务随文件定档一并锁定，此后修改走变更）→ 重取文件清单 → 自动选中该文件。
   */
  const finalizeForChange = (fileId: string) => {
    if (changeFinalizeBusy || projectId === undefined) {
      return;
    }
    setChangeFinalizeBusy(true);
    setChangeError(null);
    void finalizeFile(fileId)
      .then(() => {
        setChangeFinalizeId(null);
        setChangeFinalizeDone(fileId);
        setChangeTargetId(fileId);
        setFilesTick((tick) => tick + 1);
        onChanged?.();
      })
      .catch((error: unknown) => {
        setChangeError(error instanceof Error && error.message !== "" ? error.message : t("drawer.change.err.finalize"));
      })
      .finally(() => {
        setChangeFinalizeBusy(false);
      });
  };

  /** 变更记录展开 / 收起（Push 255：详情已随页预取，这里只切展开态；再点同一条 = 收起）。 */
  const toggleChangeDetail = (id: string) => {
    setChangeDetailId((previous) => (previous === id ? null : id));
  };

  /** 变更记录单条重试（详情 / 版本链取不到时）：清掉该条 + 触发预取 effect 重跑。 */
  const retryChangeEntry = (id: string) => {
    setChangeEntries((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setChangeDetailTick((tick) => tick + 1);
  };

  const rows: Array<{ label: string; value: ReactNode }> = [
    // 任务描述（Push 196 / Push 197 收窄）：只有未归入阶段的「临时任务」出这一行；阶段任务与节点 / 模板生成的任务保持锁定（不渲染可编辑控件）
    ...(titleEditable
      ? [
          {
            label: "任务描述",
            value: (
              <>
                <input
                  value={draft.title}
                  onChange={(event) => {
                    updateDraft({ title: event.target.value });
                  }}
                  onBlur={commitTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder={t("drawer.title.placeholder")}
                  aria-label={t("drawer.title.aria")}
                  className={FIELD_CLASS + (titleInvalid ? " border-rose-300 focus:border-rose-400 focus:ring-rose-500/15" : "")}
                />
                <input
                  value={draft.titleEn}
                  onChange={(event) => {
                    updateDraft({ titleEn: event.target.value });
                  }}
                  onBlur={commitTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder={t("drawer.titleEn.placeholder")}
                  aria-label={t("drawer.titleEn.aria")}
                  className={FIELD_CLASS + " mt-1.5"}
                />
                <span className={CAPTION_CLASS}>{t("drawer.temp.caption")}</span>
              </>
            ),
          },
        ]
      : []),
    {
      label: "项目经理",
      // 2026-10-10 业务追订「项目经理也不可以修改」：任务已定档 → 项目经理字段随行锁定（项目级字段同样不可改），
      // 只读展示名单 + 一句口径说明（未定档时行为不变）。
      value: editable && !taskFinalized ? (
        <>
          <MemberMultiSelect
            values={draft.managerIds}
            options={members}
            onChange={(memberIds) => {
              // 至少留一位（对齐契约 projects.manager_ids 非空）：全取消时不写
              if (memberIds.length === 0) {
                return;
              }
              commit({ managerIds: memberIds });
            }}
            placeholder={t("drawer.manager.placeholder")}
            ariaLabel={t("drawer.manager.aria")}
          />
          <span className={CAPTION_CLASS}>{t("drawer.manager.caption")}</span>
        </>
      ) : (
        <>
          <span className="font-medium text-zinc-800">{managers ?? ""}</span>
          {editable && taskFinalized ? (
            <span className={CAPTION_CLASS}>{t("drawer.locked.caption")}</span>
          ) : null}
        </>
      ),
    },
    {
      label: "任务负责人",
      value: editable ? (
        <>
          <MemberMultiSelect
            values={draft.ownerIds}
            options={members}
            onChange={(memberIds) => {
              commit({ ownerIds: memberIds });
            }}
            placeholder={t("drawer.owner.placeholder")}
            ariaLabel={t("drawer.owner.aria")}
          />
          <span className={CAPTION_CLASS}>{t("drawer.owner.caption")}</span>
        </>
      ) : task.owners.length === 0 ? (
        <span className="text-zinc-400">{fieldText(locale, "待分配")}</span>
      ) : (
        fullOwners
      ),
    },
    {
      label: "任务状态",
      value: canEditStatus ? (
        <>
          <SelectMenu
            value={status}
            options={statusOptions}
            onChange={(next) => {
              // 五态写入（2026-09-24 定案）：进度与完成日期的联动由服务端同事务裁决（口径与原型一致）
              onSetStatus(task.id, next as TaskStatus);
              setSavedTick(Date.now());
            }}
            ariaLabel={t("drawer.status.aria")}
          />
          <span className={CAPTION_CLASS}>{t("drawer.status.caption")}</span>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + dotClass} />
          {statusText(locale, status)}
        </span>
      ),
    },
    {
      label: "紧急重要度",
      value: editable ? (
        <SelectMenu
          value={draft.priority}
          options={priorityOptions}
          onChange={(value) => {
            commit({ priority: value as TaskPriority });
          }}
          ariaLabel={t("drawer.priority.aria")}
        />
      ) : task.priority === null ? (
        dash
      ) : (
        <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + PRIORITY_CLASS[task.priority]}>
          {priorityText(locale, task.priority)}
        </span>
      ),
    },
    {
      label: "是否按时交付",
      value:
        late === "逾期未交付" ? (
          <span className="inline-block rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600">{statusText(locale, "逾期未交付")}</span>
        ) : late === "逾期已交付" ? (
          <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{statusText(locale, "逾期已交付")}</span>
        ) : task.onTime !== true ? (
          dash
        ) : (
          <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">{statusText(locale, "按时交付")}</span>
        ),
    },
    {
      // 输出成果文件（2026-10-08 · 业务口径「文件输出成果也要可以选择」）：只读色签改可点选择（搜索 + 十类多选，
      // 彩签全量摊开）；勾选即存（与其它字段同一套写入口径）。不传 onSubmit（只读抽屉）= 静态色签。
      label: "输出成果文件",
      value: editable ? (
        <DeliverableCell
          all
          values={draft.deliverableTypes}
          onChange={(next) => {
            commit({ deliverableTypes: next });
          }}
        />
      ) : task.deliverableTypes.length === 0 ? (
        dash
      ) : (
        <span className="flex flex-wrap gap-1.5">
          {task.deliverableTypes.map((docType) => (
            <span key={docType}>{docTypeChip(docType, locale)}</span>
          ))}
        </span>
      ),
    },
    {
      label: "文件",
      value: (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {task.files.total === 0 ? (
              <span className="text-xs text-zinc-400">{t("drawer.files.empty")}</span>
            ) : (
              <>
                <span className="inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-600">
                  {t("drawer.files.count", { n: task.files.total })}
                </span>
              </>
            )}
            {onUploadFiles === undefined ? null : (
              <button
                type="button"
                data-drawer-upload="true"
                onClick={() => { uploadInputRef.current?.click(); }}
                disabled={uploading !== null}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {uploading === null ? t("drawer.files.upload") : uploading.done === 0 ? t("drawer.files.uploading") : t("drawer.files.uploadingCount", { done: uploading.done, total: uploading.total })}
              </button>
            )}
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              data-file-upload-input="true"
              className="hidden"
              aria-label={t("drawer.files.pickAria")}
              onChange={(event) => {
                beginFileUpload(event.currentTarget.files);
                // 清空 value：同一份文件再选一次仍会触发 change
                event.currentTarget.value = "";
              }}
            />
          </div>
          {taskFinalized ? (
            <p data-drawer-files-note-finalized="true" className="text-[11px] leading-4 text-amber-600">
              {t("drawer.files.lockedNote")}
            </p>
          ) : null}
          {files === null || files.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {files.map((file) => {
                const previewKind = previewKindOf(file.name);
                const previewing = previewBusy === file.id;
                const confirming = pendingDelete === file.id;
                return (
                  <li key={file.id} data-drawer-file-item="true" className="group flex min-w-0 items-center gap-2 rounded-lg border border-zinc-100 bg-zinc-50/70 px-2.5 py-1.5 transition-colors hover:bg-zinc-100">
                    {previewKind === "image" ? <FileThumb fileId={file.id} name={file.name} onOpen={() => { void openPreview(file.id, file.name); }} /> : <FileTypeIcon name={file.name} />}
                    {renamingId === file.id ? (
                      <span className="flex min-w-0 flex-1 items-center gap-0.5">
                        <input
                          data-file-rename-input="true"
                          value={renameText}
                          autoFocus
                          onChange={(event) => { setRenameText(event.target.value); }}
                          onBlur={() => { commitFileRename(file); }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.stopPropagation();
                              commitFileRename(file);
                            }
                            if (event.key === "Escape") {
                              // 只取消本次改名，不连带关抽屉（与预览浮层同一条「Esc 先关内层」口径）
                              event.stopPropagation();
                              setRenamingId(null);
                            }
                          }}
                          className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-700 outline-none focus:border-zinc-400"
                        />
                        {renameExt === "" ? null : <span className="shrink-0 text-xs text-zinc-400">{renameExt}</span>}
                      </span>
                    ) : onRenameFile === undefined ? (
                      previewKind !== null ? (
                        <button
                          type="button"
                          data-file-preview-open="true"
                          onClick={() => { void openPreview(file.id, file.name); }}
                          disabled={previewing}
                          title={t("drawer.file.previewTitle")}
                          className="min-w-0 flex-1 truncate text-left text-xs text-zinc-700 transition-colors hover:text-zinc-900 disabled:text-zinc-400"
                        >
                          {file.name}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-xs text-zinc-700" title={file.name}>{file.name}</span>
                      )
                    ) : (
                      <button
                        type="button"
                        data-file-rename="true"
                        onClick={() => { startFileRename(file); }}
                        title={t("drawer.file.renameTitle")}
                        className="min-w-0 flex-1 truncate text-left text-xs text-zinc-700 transition-colors hover:text-zinc-900"
                      >
                        {file.name}
                      </button>
                    )}
                    {file.docType === null ? null : <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{file.docType}</span>}
                    {FILE_STATUS_LABEL[file.status] === undefined ? null : (
                      <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium " + (FILE_STATUS_CLASS[file.status] ?? "bg-zinc-100 text-zinc-500")}>
                        {statusText(locale, FILE_STATUS_LABEL[file.status])}
                      </span>
                    )}
                    {previewing && previewKind === "image" ? <span className="shrink-0 text-[10px] text-zinc-400">{t("drawer.file.previewing")}</span> : null}
                    {previewKind !== null && previewKind !== "image" ? (
                      <button
                        type="button"
                        data-file-preview-open="true"
                        onClick={() => { void openPreview(file.id, file.name); }}
                        disabled={previewing}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300"
                      >
                        {previewing ? t("drawer.file.previewing") : t("drawer.file.preview")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-file-download="true"
                      onClick={() => { void downloadFile(file.id); }}
                      disabled={downloadBusy === file.id}
                      title={t("drawer.file.downloadTitle")}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300"
                    >
                      {downloadBusy === file.id ? t("drawer.file.downloading") : t("drawer.file.download")}
                    </button>
                    {onDeleteFile === undefined || taskFinalized ? null : confirming ? (
                      <span data-file-delete-confirm="true" className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => { confirmFileDelete(file.id); }} className="flex h-6 shrink-0 items-center justify-center rounded-full bg-red-500 px-2.5 text-[11px] font-semibold leading-none text-white shadow-[0_1px_2px_rgba(220,38,38,0.25)] transition-colors hover:bg-red-600">{t("drawer.file.deleteOk")}</button>
                        <button type="button" onClick={() => { setPendingDelete(null); }} className="flex h-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-medium leading-none text-zinc-600 transition-colors hover:bg-zinc-200">{t("drawer.file.deleteCancel")}</button>
                      </span>
                    ) : (
                      <span data-file-delete="true" className="flex h-6 w-12 shrink-0 items-center">
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
          {previewNote === null ? null : <p data-file-preview-note="true" className="text-[11px] text-zinc-400">{previewNote}</p>}
        </div>
      ),
    },
    {
      label: "项目进展描述",
      value: editable ? (
        <div className={NOTE_BOX_CLASS}>
          <textarea
            ref={noteFieldRef}
            rows={1}
            value={draft.note}
            onChange={(event) => {
              updateDraft({ note: event.target.value });
            }}
            onBlur={commitDraft}
            placeholder={t("drawer.note.placeholder")}
            aria-label={t("drawer.note.aria")}
            className="block max-h-40 w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-400"
          />
          {noteEnLine}
        </div>
      ) : (
        <div>
          {task.note === "" ? dash : isLocalizedLocale(locale) ? <span title={task.note}>{localizedReadNote}</span> : task.note}
          {locale === "zh" ? noteEnLine : null}
        </div>
      ),
    },
    {
      label: "开始 / 预计完成",
      value: editable ? (
        <>
          <DateRangePicker
            value={draft.range}
            onChange={(next) => {
              commit({ range: next });
            }}
            hintDate={task.startDate}
            placeholder={t("drawer.dates.placeholder")}
            ariaLabel={t("drawer.dates.aria")}
          />
          <span className={CAPTION_CLASS}>{t("drawer.dates.caption")}</span>
        </>
      ) : task.startDate === "" && task.dueDate === "" ? (
        dash
      ) : (
        (task.startDate === "" ? "—" : mdText(locale, task.startDate)) + " → " + (task.dueDate === "" ? "—" : mdText(locale, task.dueDate))
      ),
    },
    { label: "预计所需天数", value: shownDays > 0 ? shownDays + " " + fieldText(locale, "天") : dash },
    {
      label: "预计所需施工人数",
      value: editable ? (
        <>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.headcount}
              onChange={(event) => {
                updateDraft({ headcount: event.target.value });
              }}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder={t("drawer.headcount.placeholder")}
              aria-label={t("drawer.headcount.aria")}
              className={FIELD_CLASS + (headcountInvalid ? " border-rose-300 focus:border-rose-400 focus:ring-rose-500/15" : "")}
            />
            <span className="shrink-0 text-xs text-zinc-400">{t("drawer.headcount.unit")}</span>
          </div>
          {headcountInvalid ? <span className="mt-1 block text-[11px] text-rose-500">{t("drawer.headcount.invalid")}</span> : null}
        </>
      ) : task.headcount > 0 ? (
        t("drawer.headcount.value", { n: task.headcount })
      ) : (
        dash
      ),
    },
    {
      label: "实际完成日期",
      value: canEditActualEnd ? (
        <>
          <InlineDateCell
            valueIso={task.doneDate}
            ariaLabel={t("drawer.actual.aria")}
            display={
              task.doneDate !== "" ? <span className="text-zinc-600">{mdText(locale, task.doneDate)}</span> : <span className="text-zinc-400">—</span>
            }
            onChange={(iso) => {
              // 填 = 完成（四格全亮）；清 = 退回进行中（进度 3 格）—— 状态联动交给服务端
              onSetActualEnd(task.id, iso);
              setSavedTick(Date.now());
            }}
          />
          <span className={CAPTION_CLASS}>{t("drawer.actual.caption")}</span>
        </>
      ) : task.doneDate !== "" ? (
        mdText(locale, task.doneDate)
      ) : (
        dash
      ),
    },
    {
      label: "变更关联",
      value:
        task.changes.length === 0 ? (
          dash
        ) : (
          <span className="flex flex-col gap-1">
            {task.changes.map((change) => (
              <button
                key={change.id}
                type="button"
                data-change-link-open="true"
                title={t("drawer.change.linkTitle")}
                onClick={() => { setChangeModalId(change.id); }}
                className="flex flex-wrap items-center gap-1.5 text-left"
              >
                <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-200">
                  {t("drawer.change.badge", { date: dateOnlyText(change.appliedAt) })}
                </span>
                {change.reason === "" ? null : <span className="text-xs text-zinc-500">{change.reason}</span>}
              </button>
            ))}
          </span>
        ),
    },
  ];

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={"drawer-backdrop absolute inset-0 bg-zinc-900/25" + (closing ? " is-closing" : "")}
        onClick={(event) => {
          if (event.target !== event.currentTarget) { return; }
          requestClose();
        }}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        key={task.id}
        role="dialog"
        data-live-sync-readonly={protectingDraft ? "false" : "true"}
        aria-modal="true"
        aria-labelledby="task-drawer-title"
        className={
          "drawer-panel absolute right-0 top-0 flex h-full w-[460px] max-w-[94vw] flex-col bg-white shadow-[-24px_0_60px_rgba(15,23,42,0.18)]" +
          (closing ? " is-closing" : "")
        }
      >
        <header className="border-b border-zinc-100 px-6 pb-5 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-medium text-zinc-500">{stageText(locale, task.stage === "" ? TEMP_TASK_STAGE : task.stage)}</span>
              <span data-task-status-chip="true" className={"rounded-full px-2.5 py-0.5 text-[11px] font-medium " + statusChipClass}>{statusText(locale, status)}</span>
              {task.finalizedAt !== null ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-zinc-400">{t("drawer.finalize.label")}</span>
                  {onUnfinalize === undefined ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked="true"
                      aria-label={t("drawer.finalize.onAria")}
                      data-task-finalize="on"
                      title={t("drawer.finalize.onTitle")}
                      disabled
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-default items-center rounded-full bg-[#FECA04] transition-colors duration-200"
                    >
                      <span className="pointer-events-none absolute left-[3px] top-[3px] flex h-[18px] w-[18px] translate-x-5 items-center justify-center rounded-full bg-white text-[9px] font-semibold text-amber-700 shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition-all duration-200">{t("drawer.toggle.on")}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="switch"
                      aria-checked="true"
                      aria-label={t("drawer.finalize.offAria")}
                      data-task-finalize="on"
                      title={t("drawer.finalize.offTitle")}
                      onClick={() => { setUnfinalizeConfirm(true); }}
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-[#FECA04] transition-colors duration-200 hover:brightness-95"
                    >
                      <span className="pointer-events-none absolute left-[3px] top-[3px] flex h-[18px] w-[18px] translate-x-5 items-center justify-center rounded-full bg-white text-[9px] font-semibold text-amber-700 shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition-all duration-200">{t("drawer.toggle.on")}</span>
                    </button>
                  )}
                </span>
              ) : onFinalize === undefined ? null : (
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-zinc-400">{t("drawer.finalize.label")}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked="false"
                    aria-label={t("drawer.finalize.idleAria")}
                    data-task-finalize="off"
                    title={t("drawer.finalize.idleTitle")}
                    onClick={() => { setFinalizeConfirm(true); }}
                    className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-zinc-200 transition-colors duration-200 hover:bg-zinc-300"
                  >
                    <span className="pointer-events-none absolute left-[3px] top-[3px] flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white text-[9px] font-semibold text-zinc-400 shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition-all duration-200">{t("drawer.toggle.off")}</span>
                  </button>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t("drawer.close.aria")}
              className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {finalizeConfirm && task.finalizedAt === null ? (
            <div data-task-finalize-confirm="true" className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs leading-5 text-amber-800">{t("drawer.finalize.confirm")}</p>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  data-task-finalize-confirm-btn="true"
                  onClick={() => { setFinalizeConfirm(false); onFinalize?.(task.id); }}
                  className="flex h-6 shrink-0 items-center justify-center rounded-full bg-[#FECA04] px-2.5 text-[11px] font-semibold leading-none text-zinc-900 shadow-[0_1px_2px_rgba(202,154,0,0.35)] transition-colors hover:bg-[#F2BE00]"
                >
                  {t("drawer.finalize.confirmOk")}
                </button>
                <button
                  type="button"
                  data-task-finalize-cancel="true"
                  onClick={() => { setFinalizeConfirm(false); }}
                  className="flex h-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-semibold leading-none text-zinc-600 transition-colors hover:bg-zinc-200"
                >
                  {t("drawer.file.deleteCancel")}
                </button>
              </span>
            </div>
          ) : null}
          {unfinalizeConfirm && task.finalizedAt !== null ? (
            <div data-task-unfinalize-confirm="true" className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs leading-5 text-amber-800">{t("drawer.unfinalize.confirm")}</p>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  data-task-unfinalize-confirm-btn="true"
                  onClick={() => { setUnfinalizeConfirm(false); onUnfinalize?.(task.id); }}
                  className="flex h-6 shrink-0 items-center justify-center rounded-full bg-[#FECA04] px-2.5 text-[11px] font-semibold leading-none text-zinc-900 shadow-[0_1px_2px_rgba(202,154,0,0.35)] transition-colors hover:bg-[#F2BE00]"
                >
                  {t("drawer.unfinalize.confirmOk")}
                </button>
                <button
                  type="button"
                  data-task-unfinalize-cancel="true"
                  onClick={() => { setUnfinalizeConfirm(false); }}
                  className="flex h-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 px-2.5 text-[11px] font-semibold leading-none text-zinc-600 transition-colors hover:bg-zinc-200"
                >
                  {t("drawer.file.deleteCancel")}
                </button>
              </span>
            </div>
          ) : null}
          <h2 id="task-drawer-title" className="mt-3.5 text-lg font-semibold leading-7 text-zinc-900">
            {drawerTitleText}
          </h2>
          {drawerTitleSub === "" ? null : <p className="mt-1 text-xs leading-5 text-zinc-400">{drawerTitleSub}</p>}
        </header>

        {/* 页标签导航栏（Push 254 · 业务口径「抽屉上方增加 页面标签导航栏 任务详情 变更申请 变更记录三个页面」）：
            抽屉头部之下、页内容之上（与页面主标签栏同一套下划线交互）；任务详情 = 原抽屉内容（进度 + 字段清单），
            另两页收拢变更发起与追溯。 */}
        <div data-drawer-tabs="true" className="border-b border-zinc-100 px-6">
          <div role="tablist" aria-label={t("drawer.tabs.aria")} className="flex gap-1">
            {DRAWER_TABS.map((item) => {
              const active = item.key === tab;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-drawer-tab={item.key}
                  onClick={() => { setTab(item.key); }}
                  className={
                    "border-b-2 px-4 py-2.5 text-sm font-medium transition " +
                    (active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800")
                  }
                >
                  {fieldText(locale, item.label)}
                </button>
              );
            })}
          </div>
        </div>

        {tab === "detail" ? (
          <>
            <div className="border-b border-zinc-100 px-6 py-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">{fieldText(locale, "项目进度")}</span>
                <span className="text-sm font-semibold text-zinc-900">{progressText}</span>
              </div>
              {onProgress === undefined ? (
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div className={"h-full rounded-full " + barClass} style={{ width: stepPct + "%" }} />
                </div>
              ) : (
                <div className="mt-2.5">
                  <TrackerBar
                    progress={task.progress}
                    hovered={hoveredStep}
                    onHoverChange={setHoveredStep}
                    barClassName={barClass}
                    dotOnClassName={dotOnClass}
                    onChange={(progress) => {
                      onProgress(task.id, progress);
                      setSavedTick(Date.now());
                      setHoveredStep(0);
                    }}
                  />
                </div>
              )}
              {overdue ? (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">
                  {t("drawer.overdue", { date: mdText(locale, task.dueDate) })}
                </p>
              ) : null}
            </div>

            <ScrollArea viewportClassName="min-h-0 flex-1" className="px-6 py-1" ariaLabel={t("drawer.detail.aria")}>
              <dl>
                {rows.map((row) => (
                  <div
                    key={row.label}
                    className="grid grid-cols-[96px_1fr] items-start gap-x-4 border-b border-zinc-50 py-3 last:border-b-0"
                  >
                    <dt className="pt-px text-xs leading-5 text-zinc-400">{fieldText(locale, row.label)}</dt>
                    <dd className="min-w-0 text-sm leading-5 text-zinc-800">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </ScrollArea>
          </>
        ) : tab === "change" ? (
          <ScrollArea viewportClassName="min-h-0 flex-1" className="px-6" ariaLabel={t("drawer.change.aria")}>
            <div data-drawer-page="change" className="flex flex-col gap-5 py-4">
              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更时间")} <span className="text-rose-500">*</span></h3>
                <p data-change-time="true" className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">{changeToday}</p>
                <span className={CAPTION_CLASS}>{t("drawer.change.time.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更阶段")} <span className="text-rose-500">*</span></h3>
                <span className={CAPTION_CLASS}>{t("drawer.change.stage.caption")}</span>
                <div data-change-stage="true" className="mt-1.5">
                  <SelectMenu
                    value={changeStage}
                    options={changeStageOptions}
                    placeholder={t("drawer.change.select.placeholder")}
                    onChange={(next) => {
                      setChangeStage(next);
                      setChangeDone(false);
                      setChangeError(null);
                    }}
                    ariaLabel={t("drawer.change.stage.aria")}
                  />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更文件")} <span className="text-rose-500">*</span></h3>
                <span className={CAPTION_CLASS}>{t("drawer.change.file.caption")}</span>
                {files === null ? (
                  <p className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500">{t("drawer.change.filesLoading")}</p>
                ) : files.length === 0 ? (
                  <p data-change-empty="true" className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500">{t("drawer.change.filesEmpty")}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {files.map((file) => {
                      const selectable = CHANGEABLE_STATUS[file.status] === true || (taskFinalized && file.status === "draft");
                      const fileStatusLabel = file.status === "draft" && taskFinalized ? statusText(locale, "已定档") : statusText(locale, CHANGE_FILE_STATUS_TEXT[file.status] ?? file.status);
                      const pickedTarget = file.id === changeTargetId;
                      const finalizeOpen = changeFinalizeId === file.id;
                      return (
                        <li key={file.id}>
                          <div className="flex items-stretch gap-1.5">
                            <button
                              type="button"
                              data-change-target={file.id}
                              disabled={!selectable}
                              aria-pressed={pickedTarget}
                              onClick={() => {
                                setChangeTargetId(pickedTarget ? null : file.id);
                                setChangeDone(false);
                                setChangeError(null);
                              }}
                              className={
                                "flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left transition " +
                                (pickedTarget
                                  ? "border-zinc-900 bg-zinc-50"
                                  : selectable
                                    ? "border-zinc-200 bg-white hover:border-zinc-300"
                                    : "cursor-not-allowed border-zinc-100 bg-zinc-50/60")
                              }
                            >
                              <span className={"flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border " + (pickedTarget ? "border-zinc-900" : "border-zinc-300")}>
                                {pickedTarget ? <span className="h-1.5 w-1.5 rounded-full bg-zinc-900" /> : null}
                              </span>
                              <span className={"min-w-0 flex-1 truncate text-xs " + (selectable ? "text-zinc-700" : "text-zinc-400")} title={file.name}>{file.name}</span>
                              <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium " + (selectable ? "bg-amber-50 text-amber-700" : "bg-zinc-100 text-zinc-400")}>
                                {fileStatusLabel + (selectable ? "" : t("drawer.change.file.lockedSuffix"))}
                              </span>
                            </button>
                            {selectable || file.status !== "draft" ? null : (
                              <button
                                type="button"
                                data-change-finalize={file.id}
                                onClick={() => {
                                  setChangeFinalizeId(finalizeOpen ? null : file.id);
                                  setChangeError(null);
                                }}
                                title={t("drawer.change.file.finalizeTitle")}
                                className="shrink-0 self-center rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 transition hover:border-amber-300"
                              >
                                {t("drawer.finalize.label")}
                              </button>
                            )}
                          </div>
                          {finalizeOpen ? (
                            <div data-change-finalize-confirm={file.id} className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
                              <p className="text-[11px] leading-4 text-amber-800">{t("drawer.change.file.finalizeConfirm")}</p>
                              <div className="mt-1.5 flex items-center gap-2">
                                <button
                                  type="button"
                                  data-change-finalize-ok={file.id}
                                  disabled={changeFinalizeBusy}
                                  onClick={() => finalizeForChange(file.id)}
                                  className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 transition hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {changeFinalizeBusy ? t("drawer.change.file.finalizing") : t("drawer.change.file.finalizeOk")}
                                </button>
                                <button
                                  type="button"
                                  data-change-finalize-cancel={file.id}
                                  onClick={() => setChangeFinalizeId(null)}
                                  className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-700"
                                >
                                  {t("drawer.file.deleteCancel")}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {changeFinalizeDone !== null && changeableFiles.some((file) => file.id === changeFinalizeDone) ? (
                  <p data-change-finalize-done="true" className="mt-2 text-[11px] leading-4 text-emerald-600">{t("drawer.change.file.finalizedNote")}</p>
                ) : null}
                {files !== null && files.length > 0 && changeableFiles.length === 0 ? (
                  <p data-change-none-hint="true" className="mt-2 text-[11px] leading-4 text-zinc-400">{t("drawer.change.file.noneHint")}</p>
                ) : null}
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更内容描述")} <span className="text-rose-500">*</span></h3>
                <textarea
                  data-change-reason="true"
                  value={changeContent}
                  maxLength={1000}
                  rows={3}
                  onChange={(event) => {
                    setChangeContent(event.target.value);
                    setChangeDone(false);
                    setChangeError(null);
                  }}
                  placeholder={t("drawer.change.desc.placeholder")}
                  aria-label={t("drawer.change.desc.aria")}
                  className={FIELD_CLASS + " mt-1.5 resize-none leading-6"}
                />
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更前")}</h3>
                <textarea
                  data-change-before="true"
                  value={changeBefore}
                  maxLength={2000}
                  rows={2}
                  onChange={(event) => { setChangeBefore(event.target.value); }}
                  placeholder={t("drawer.change.before.placeholder")}
                  aria-label={fieldText(locale, "变更前")}
                  className={FIELD_CLASS + " mt-1.5 resize-none leading-6"}
                />
                <AttachmentPicker
                  projectId={projectId ?? ""}
                  field="change-before"
                  items={changeBeforePhotos}
                  onChange={(items) => { setChangeBeforePhotos(items); setChangeDone(false); setChangeError(null); }}
                  ariaLabel={t("drawer.change.beforePhotos.aria")}
                  disabled={projectId === undefined || changeBusy}
                  variant="compact"
                  size="md"
                />
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更后")}</h3>
                <textarea
                  data-change-after="true"
                  value={changeAfter}
                  maxLength={2000}
                  rows={2}
                  onChange={(event) => { setChangeAfter(event.target.value); }}
                  placeholder={t("drawer.change.after.placeholder")}
                  aria-label={fieldText(locale, "变更后")}
                  className={FIELD_CLASS + " mt-1.5 resize-none leading-6"}
                />
                <AttachmentPicker
                  projectId={projectId ?? ""}
                  field="change-after"
                  items={changeAfterPhotos}
                  onChange={(items) => { setChangeAfterPhotos(items); setChangeDone(false); setChangeError(null); }}
                  ariaLabel={t("drawer.change.afterPhotos.aria")}
                  disabled={projectId === undefined || changeBusy}
                  variant="compact"
                  size="md"
                />
                <span className={CAPTION_CLASS}>{t("drawer.change.summary.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更原因")}</h3>
                <input
                  data-change-cause="true"
                  value={changeCause}
                  maxLength={1000}
                  onChange={(event) => { setChangeCause(event.target.value); }}
                  placeholder={t("drawer.change.reason.placeholder")}
                  aria-label={fieldText(locale, "变更原因")}
                  className={FIELD_CLASS + " mt-1.5"}
                />
                <span className={CAPTION_CLASS}>{t("drawer.change.reason.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更申请人")} <span className="text-rose-500">*</span></h3>
                <p data-change-applicant="true" className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">{changeApplicant}</p>
                <span className={CAPTION_CLASS}>{t("drawer.change.applicant.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更后文件版本")} <span className="text-rose-500">*</span></h3>
                <p data-change-version="true" className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">{t("drawer.change.version.auto")}</p>
                <span className={CAPTION_CLASS}>{t("drawer.change.version.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "变更后文件")} <span className="text-rose-500">*</span></h3>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-change-pick="true"
                    onClick={() => { changeInputRef.current?.click(); }}
                    disabled={changeBusy}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t("drawer.change.newFile.pick")}
                  </button>
                  {changeFile === null ? (
                    <span className="text-[11px] text-zinc-400">{t("drawer.change.newFile.none")}</span>
                  ) : (
                    <span data-change-file="true" className="min-w-0 max-w-full truncate text-xs text-zinc-600" title={changeFile.name}>{changeFile.name}</span>
                  )}
                  <input
                    ref={changeInputRef}
                    type="file"
                    data-change-upload-input="true"
                    className="hidden"
                    aria-label={t("drawer.change.newFile.aria")}
                    onChange={(event) => {
                      pickChangeFile(event.currentTarget.files);
                      // 清空 value：同一份文件再选一次仍会触发 change
                      event.currentTarget.value = "";
                    }}
                  />
                </div>
                <span className={CAPTION_CLASS}>{t("drawer.change.newFile.caption")}</span>
              </section>

              <section>
                <h3 className="text-xs font-medium text-zinc-500">{fieldText(locale, "关联")}</h3>
                <p data-change-link="true" className="mt-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">{t("drawer.change.link.auto")}</p>
                <span className={CAPTION_CLASS}>{t("drawer.change.link.caption")}</span>
              </section>

              <section className="flex flex-col gap-2 border-t border-zinc-100 pt-4">
                {changeError === null ? null : (
                  <p data-change-error="true" className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{changeError}</p>
                )}
                {changeDone ? (
                  <p data-change-done="true" className="rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">{t("drawer.change.done")}</p>
                ) : null}
                <button
                  type="button"
                  data-change-submit="true"
                  onClick={submitChange}
                  disabled={changeBusy || projectId === undefined}
                  className="w-full rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  {changeBusy ? t("drawer.change.submitting") : t("drawer.change.submit")}
                </button>
                <p className="text-[11px] leading-4 text-zinc-400">{t("drawer.change.footnote")}</p>
              </section>
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea viewportClassName="min-h-0 flex-1" className="px-6" ariaLabel={t("drawer.history.aria")}>
            <div data-drawer-page="history" className="flex flex-col gap-2 py-4">
              {task.changes.length === 0 ? (
                <p data-drawer-history-empty="true" className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500">{t("drawer.history.empty")}</p>
              ) : (
                <>
                  <p className="text-[11px] leading-4 text-zinc-400">{t("drawer.history.hint")}</p>
                  {[...task.changes].reverse().map((change) => {
                    const open = changeDetailId === change.id;
                    const entry = changeEntries[change.id];
                    return (
                      <div key={change.id} data-change-item={change.id} className="rounded-xl border border-zinc-100 bg-zinc-50/60 px-3 py-2.5">
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">{t("drawer.change.badge", { date: dateOnlyText(change.appliedAt) })}</span>
                          <p className="min-w-0 flex-1 text-xs leading-5 text-zinc-600">{change.reason === "" ? t("drawer.history.noReason") : change.reason}</p>
                          <button
                            type="button"
                            data-change-item-open="true"
                            onClick={() => { toggleChangeDetail(change.id); }}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                          >
                            {open ? t("drawer.history.collapse") : t("drawer.history.expand")}
                          </button>
                        </div>
                        {entry === undefined || entry.state === "loading" ? (
                          <p data-change-item-files="true" className="mt-1.5 rounded-lg border border-zinc-100 bg-white px-2.5 py-2 text-[11px] text-zinc-400">{t("drawer.history.filesLoading")}</p>
                        ) : entry.state === "error" ? (
                          <p data-change-item-note="true" className="mt-1.5 flex items-center gap-2 rounded-lg border border-zinc-100 bg-white px-2.5 py-2 text-[11px] text-zinc-400">
                            <span className="min-w-0 flex-1">{entry.note}</span>
                            <button
                              type="button"
                              data-change-item-retry="true"
                              onClick={() => { retryChangeEntry(change.id); }}
                              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                            >
                              {t("drawer.history.retry")}
                            </button>
                          </p>
                        ) : (
                          <ChangeFileRows
                            detail={entry.detail}
                            versions={entry.versions}
                            previewBusy={previewBusy}
                            downloadBusy={downloadBusy}
                            onPreview={(versionId, rowName) => { if (entry.detail.file !== null) void openPreview(entry.detail.file.id, rowName, versionId); }}
                            onDownload={(versionId) => { if (entry.detail.file !== null) void downloadFile(entry.detail.file.id, versionId); }}
                          />
                        )}
                        {open ? (
                          <div data-change-item-detail="true" className="mt-2 flex flex-col gap-1 border-t border-zinc-100 pt-2 text-xs leading-5 text-zinc-600">
                            {entry !== undefined && entry.state === "ready" ? (
                              <>
                                {entry.detail.file === null || entry.detail.versionSeq === null ? (
                                  <span data-change-file-pending="true">{t("drawer.history.filePending")}</span>
                                ) : (
                                  <span>{t("drawer.history.afterFile", { name: entry.detail.file.name, n: String(entry.detail.versionSeq) })}</span>
                                )}
                                <span>{t("drawer.history.stage", { name: stageText(locale, stageLabelOf(entry.detail.stageKey)) })}</span>
                                <span>{t("drawer.history.reason", { text: entry.detail.reason })}</span>
                                <span>{t("drawer.history.status", { text: entry.detail.status === "applied" ? t("drawer.history.applied") : entry.detail.status })}</span>
                                {entry.detail.beforeSummary === null || entry.detail.beforeSummary === "" ? null : <span>{t("drawer.history.before", { text: entry.detail.beforeSummary })}</span>}
                                {entry.detail.beforeSummaryFileIds.length === 0 ? null : <PhotoStrip strip="change-before" size="md" items={summaryPhotoItems(entry.detail.beforeSummaryFileIds)} />}
                                {entry.detail.afterSummary === null || entry.detail.afterSummary === "" ? null : <span>{t("drawer.history.after", { text: entry.detail.afterSummary })}</span>}
                                {entry.detail.afterSummaryFileIds.length === 0 ? null : <PhotoStrip strip="change-after" size="md" items={summaryPhotoItems(entry.detail.afterSummaryFileIds)} />}
                                <span className="text-zinc-400">{t("drawer.history.applicant", { name: memberNameOf(members, entry.detail.appliedBy) ?? t("drawer.member"), date: dateOnlyText(entry.detail.appliedAt) })}</span>
                              </>
                            ) : entry !== undefined && entry.state === "error" ? (
                              <span data-change-item-note="true" className="text-zinc-400">{entry.note}</span>
                            ) : (
                              <span className="text-zinc-400">{t("drawer.history.loading")}</span>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </>
              )}
              {previewNote === null ? null : <p data-file-preview-note="true" className="text-[11px] text-zinc-400">{previewNote}</p>}
            </div>
          </ScrollArea>
        )}

        {saveNote === null ? null : (
          <div role="status" className="shrink-0 border-t border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-900">
            <p>{saveNote}</p>
            {latestDraft === null ? (
              <button type="button" className="mt-2 underline" onClick={() => {
                if (projectId === undefined) return;
                void fetchTaskDetail(projectId, task.id).then((latest) => {
                  if (identityRef.current !== latest.id) return;
                  setLatestDraft({ version: latest.version, draft: draftOf(toUiTask(latest, task, (id) => memberNameOf(members, id) ?? id), managerIds) });
                }).catch((error: unknown) => {
                  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) setUnavailable(true);
                  setSaveNote(t("drawer.save.unreadable"));
                });
              }}>{t("drawer.save.readLatest")}</button>
            ) : (
              <>
                <details className="mt-2"><summary>{t("drawer.save.latestFields")}</summary><p className="whitespace-pre-wrap">{t("drawer.save.latestOwner")}{latestDraft.draft.ownerIds.map((id) => memberNameOf(members, id) ?? id).join("、")}{t("drawer.save.latestHeadcount")}{latestDraft.draft.headcount || "0"}{t("drawer.save.latestDates")}{t("drawer.save.latestRange", { from: latestDraft.draft.range?.from ?? "—", to: latestDraft.draft.range?.to ?? "—" })}{t("drawer.save.latestPriority")}{priorityText(locale, latestDraft.draft.priority)}{t("drawer.save.latestDeliverables")}{latestDraft.draft.deliverableTypes.join("、")}<br />{t("drawer.save.latestNote")}{latestDraft.draft.note}</p></details>
                <button type="button" disabled={unavailable} className="mt-2 underline disabled:opacity-50" onClick={() => {
                  baseVersion.current = latestDraft.version;
                  baseDraft.current = latestDraft.draft;
                  saveFailed.current = false;
                  setLatestDraft(null);
                  commit({});
                }}>{t("drawer.save.retryDraft")}</button>
              </>
            )}
          </div>
        )}
        <footer className="flex items-center justify-between gap-3 border-t border-zinc-100 px-6 py-3">
          <p className="text-[11px] text-zinc-400">{t("drawer.footer.hint")}</p>
          {savedTick !== 0 ? (
            <p className="text-[11px] font-medium text-emerald-600">{t("drawer.save.saved")}</p>
          ) : editable ? (
            <p className="text-[11px] text-zinc-400">{t("drawer.save.autosave")}</p>
          ) : null}
        </footer>
      </aside>
      {preview === null ? null : (
        <FilePreviewOverlay
          pane={preview.pane}
          name={preview.name}
          kind={preview.kind}
          nonce={preview.nonce}
          onRetry={() => { void retryPreview(preview.fileId, preview.name, preview.versionId ?? undefined); }}
          onDownload={() => { void downloadFile(preview.fileId, preview.versionId ?? undefined); }}
          onClose={() => { setPreview(null); }}
        />
      )}
      {changeModalId === null ? null : (
        <ChangeDetailModal
          changeId={changeModalId}
          linkedTaskTitle={task.title}
          members={members}
          deliverableTypes={task.deliverableTypes}
          onOpenLinkedTask={() => { setChangeModalId(null); }}
          onClose={() => { setChangeModalId(null); }}
        />
      )}
    </div>
  );
}

/** 「变更记录」每条的变更文件行（Push 255 · 业务口径「变更记录也要显示 之前是什么文件 这次是什么文件…文件可以预览在变更里面」）：
 *  变更前 = 版本链里 seq = 变更版本号 - 1 的那一版（版本链只追加）；变更后 = 本次变更的版本（详情自带）。
 *  预览 / 下载都走版本态入口（A4-06：任意历史版本可预览与下载）—— 可预览类型（图片 / PDF / Office 文本族）出「预览」钮，其余只出「下载」。 */
function ChangeFileRows({ detail, versions, previewBusy, downloadBusy, onPreview, onDownload }: {
  detail: ChangeRequestDetail;
  versions: FileVersionBrief[] | null;
  previewBusy: string | null;
  downloadBusy: string | null;
  onPreview: (versionId: string, name: string) => void;
  onDownload: (versionId: string) => void;
}) {
  const locale = useLocale();
  const t = useT();
  if (detail.file === null || detail.version === null || detail.versionId === null || detail.versionSeq === null) {
    // Push 319：导入表导入变更没有变更后文件（源文件在微盘）→ 只出「待补」提示行（无预览 / 下载入口）。
    return (
      <div data-change-item-files="true" className="mt-1.5 flex flex-col gap-1 rounded-lg border border-zinc-100 bg-white px-2.5 py-2">
        <span data-change-file-pending="true" className="text-[11px] leading-4 text-zinc-400">{t("drawer.history.filePending")}</span>
      </div>
    );
  }
  const name = detail.file.name;
  // Push 256：变更同时更名时「变更前」行显示更名前名称（读面 filePreviousName，来自审计）；未更名回退当前名。
  const beforeName = detail.filePreviousName === null ? name : detail.filePreviousName;
  const versionSeq = detail.versionSeq;
  const before = versions === null ? null : versions.find((item) => item.seq === versionSeq - 1) ?? null;
  const rows: Array<{ kind: "before" | "after"; label: string; versionId: string | null; seq: number; sizeBytes: number; uploadedAt: string }> = [
    before === null
      ? { kind: "before", label: "变更前", versionId: null, seq: detail.versionSeq - 1, sizeBytes: 0, uploadedAt: "" }
      : { kind: "before", label: "变更前", versionId: before.id, seq: before.seq, sizeBytes: before.sizeBytes, uploadedAt: before.uploadedAt },
    { kind: "after", label: "变更后", versionId: detail.versionId, seq: detail.versionSeq, sizeBytes: detail.version.sizeBytes, uploadedAt: detail.version.uploadedAt },
  ];
  return (
    <div data-change-item-files="true" className="mt-1.5 flex flex-col gap-1 rounded-lg border border-zinc-100 bg-white px-2.5 py-2">
      {rows.map((row) => {
        const versionId = row.versionId;
        // 行名 / 可预览性都按「该版本自己的名称」判：变更前 = 更名前名称（各版本扩展名随版本对象键）。
        const rowName = row.kind === "before" ? beforeName : name;
        const previewable = previewKindOf(rowName) !== null;
        return (
          <span key={row.kind} data-change-file={row.kind} className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[11px] text-zinc-400">{isLocalizedLocale(locale) ? fieldText(locale, row.label) + ": " : fieldText(locale, row.label) + "："}</span>
            {versionId === null ? (
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-400" title={versions === null ? t("drawer.version.chainMissing") : t("drawer.version.first")}>{rowName}{isLocalizedLocale(locale) ? " (" : "（"}{versions === null ? t("drawer.version.chainMissing") : t("drawer.version.first")}{isLocalizedLocale(locale) ? ")" : "）"}</span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-700" title={rowName + " · v" + String(row.seq) + " · " + dateOnlyText(row.uploadedAt)}>
                {rowName}
                <span className="ml-1 text-[10px] text-zinc-400">v{String(row.seq)} · {fileSizeText(row.sizeBytes)}</span>
              </span>
            )}
            {previewable && versionId !== null ? (
              <button
                type="button"
                data-change-preview={row.kind}
                onClick={() => { onPreview(versionId, rowName); }}
                disabled={previewBusy !== null}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                {previewBusy === versionId ? t("drawer.file.previewing") : t("drawer.file.preview")}
              </button>
            ) : null}
            {versionId === null ? null : (
              <button
                type="button"
                data-change-download={row.kind}
                onClick={() => { onDownload(versionId); }}
                disabled={downloadBusy !== null}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-300"
              >
                {downloadBusy === versionId ? t("drawer.file.downloading") : t("drawer.file.download")}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** 图片文件的 40×40 小缩略图（Push 226 续 · 业务口径 2026-09-29「图片预览和日报那样的形式一样 抽屉里面直接存小图片」）：
 *  与日报 / 问题附图同款口径 —— 挂载即懒取预览签名（usePhotoUrl），点图开大图。 */
function FileThumb({ fileId, name, onOpen }: { fileId: string; name: string; onOpen: () => void }) {
  const url = usePhotoUrl(fileId, null);
  const t = useT();
  return (
    <button
      type="button"
      data-file-thumb="true"
      onClick={onOpen}
      title={t("drawer.file.previewTitle")}
      className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-zinc-200 bg-white transition hover:border-zinc-300"
    >
      {url === null ? (
        <span className="flex h-full w-full items-center justify-center text-[10px] text-zinc-300">…</span>
      ) : (
        <img src={url} alt={name} className="h-full w-full object-cover" />
      )}
    </button>
  );
}
