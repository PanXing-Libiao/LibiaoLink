import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { mediumCardBorderOf, mediumCardTintOf, vividCardBorderOf, vividCardTintOf, type TintedTier } from "../backgroundTier";
import { PROJECT_STAGES } from "../data/projects";
import type { Member } from "../data/members";
import type { TaskFileRef } from "../fileApi";
import { TEMP_TASK_STAGE, addedNodeIdsOf, addedNodeKeysOf, dateOnlyText, daysBetweenInclusive, lateDeliveryLabel, ownersLabel, type ProjectTask, type TaskPriority, type TaskStatus } from "../data/tasks";
import { stageNameOf, type ApiProjectSummary, type TaskUpdateInput } from "../taskApi";
import { fieldText, mdText, priorityText, stageText, statusText, useLocale, useLocalizedText, useT } from "../i18n";
import { InlineDateCell, InlineMemberMultiCell, InlineNumberCell, InlineOptionCell, InlineTextCell } from "./InlineEdit";
import type { SelectOption } from "./SelectMenu";
import { ChangeDetailModal } from "./ChangeDetailModal";
import { TaskDrawer } from "./TaskDrawer";
import type { TaskEditSubmit } from "./TaskDrawer";
import { TaskFilesPopover } from "./TaskFilesPopover";
import { Tracker, TrackerDots } from "./Tracker";
import { RowDeleteButton } from "./RowDeleteButton";
import { DeliverableCell, docTypeCapsule } from "./DeliverablePicker";
import { StageAddCard } from "./StageAddCard";
import type { StagePlacement } from "./StageAddCard";
import { TempTaskCreateForm } from "./TempTaskCreateForm";
import { useFocusTrap } from "./useFocusTrap";
import type { TemplatePresetNode } from "../data/templatePresets";

const STAGE_ORDER: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");

/** 定档任务的行内编辑入口锁定提示（Push 264 · P1-1）：与 409 TASK_FINALIZED 的提示文案同一句；
 *  2026-10-10 业务追订「定档后不能修改就点击后显示弹出即可 不要红色的圆提示」+「都用这个即可」—— 锁定入口保留可点，点击弹站点同款顶部 Toast（这句文案）。 */
// Push 301：锁定提示文案移入词典 board.finalizedHint（英文界面换英文；原 FINALIZED_EDIT_HINT 常量删除）。

export type ColumnKey =
  | "title"
  | "manager"
  | "owner"
  | "status"
  | "priority"
  | "onTime"
  | "deliverable"
  | "files"
  | "note"
  | "start"
  | "days"
  | "due"
  | "headcount"
  | "doneDate"
  | "change";

export type ColumnDef = {
  key: ColumnKey;
  label: string;
  width: string;
  min: number;
  header?: string;
  headerClass?: string;
  locked?: boolean;
};

export const TABLE_COLUMNS: ColumnDef[] = [
  { key: "title", label: "任务描述", width: "340px", min: 340, locked: true },
  // 2026-10-13 业务口径「这个 PM 不要省略」：英文表头「Project manager」实测 ≈100px（微软雅黑 12px 中黑）；
  // 66px 最小宽下被截成「Project ma...」，抬到 104 留余量 —— 中英文表头都整词显示。
  { key: "manager", label: "项目经理", width: "0.66fr", min: 104 },
  { key: "owner", label: "任务负责人", width: "0.76fr", min: 76 },
  // 状态列最小宽 84（2026-10-10 业务口径「屏幕太小就要左右滑动，不要牺牲这个组件的可视化」）：
  // 最长档位「提前完成」实测 = 44px 文字 + 胶囊 / 单元格内衬 36px = 80px（刚好贴边）—— 抬到 84 留余量，
  // 68px 时代（最小宽下实际只剩约 65px）会截成「提…」/「已…」。
  { key: "status", label: "任务状态", width: "0.84fr", min: 84 },
  { key: "priority", label: "紧急重要度", width: "0.74fr", min: 74 },
  { key: "onTime", label: "是否按时交付", width: "0.86fr", min: 86 },
  { key: "deliverable", label: "输出成果文件", width: "0.86fr", min: 86 },
  { key: "files", label: "文件", width: "0.96fr", min: 96 },
  { key: "note", label: "项目进展描述", width: "0.9fr", min: 90 },
  { key: "start", label: "开始日期", width: "0.7fr", min: 70 }, // 日期文案（「9月12日」）最小宽下也要完整：66 → 70
  { key: "days", label: "预计所需天数", width: "56px", min: 56, header: "" },
  { key: "due", label: "预计完成日期", width: "0.86fr", min: 86 },
  { key: "headcount", label: "预计所需施工人数", width: "1.08fr", min: 108 },
  { key: "doneDate", label: "实际完成日期", width: "0.86fr", min: 86 },
  { key: "change", label: "变更关联", width: "0.54fr", min: 54 },
];

export type VisibleColumns = Partial<Record<ColumnKey, boolean>>;

/**
 * 默认显示的全部列（2026-10-10 业务口径「表格字段默认全部加上去吧 全选」）——
 * 「预计所需施工人数」原先默认隐藏，现改为**默认全选**：没有偏好记录（新账号 / 清空偏好）时表头 15 列一个不少，
 * 列显隐面板的「重置」也回到这份全选默认（落库值仍是「隐藏列 key 列表」，全选 = 空数组 = 不写任何隐藏列）。
 */
export const DEFAULT_VISIBLE_COLUMNS: VisibleColumns = {};

export function resolveColumns(visible: VisibleColumns): ColumnDef[] {
  const columns = TABLE_COLUMNS.filter((column) => column.locked === true || visible[column.key] !== false);
  const has = (key: ColumnKey) => columns.some((column) => column.key === key);
  if (!has("start") || !has("due")) {
    return columns.filter((column) => column.key !== "days");
  }
  return columns;
}

/**
 * 表头 / 数据行的左右内衬（`px-5` = 20px × 2）：算表格最小宽度时必须带上 —— 内衬吃的是同一根 grid 的可用宽，
 * 漏掉它每个 `fr` 列都会各少约 4%（2026-10-10 业务口径「屏幕太小就要左右滑动，不要牺牲这个组件的可视化」：
 * 状态胶囊 / 日期在最小宽下被挤到省略号，根因就是这 40px 没算进去）。
 */
export const TABLE_ROW_PADDING_X = 40;

/**
 * 网格列模板：`fr` 列一律套 `minmax(最小宽, fr)` —— 视口不够时列**不再被压到最小宽以下**，
 * 而是整张表撑到最小宽、由外层横向滚动接住（`#task-board-scroll` / 工作台表同套模板）。
 */
export function tableGridTemplate(columns: readonly ColumnDef[]): string {
  return columns
    .map((column) => (column.width.endsWith("fr") ? "minmax(" + column.min + "px, " + column.width + ")" : column.width))
    .join(" ");
}

/** 表格最小宽度 = 各显示列最小宽之和 + 行内衬（`TABLE_ROW_PADDING_X`）：窄于它的视口出横向滚动，各列保持最小宽不变。 */
export function tableMinWidth(columns: readonly ColumnDef[]): number {
  return columns.reduce((total, column) => total + column.min, TABLE_ROW_PADDING_X);
}

/**
 * 显隐映射 → 隐藏列 key 列表（A4「列显隐」· Push 170）：按表头顺序、跳过常显列。
 * 这份列表就是落库值（`user_preferences.prefs.taskTableHiddenColumns`；服务端按白名单校验）。
 */
export function hiddenColumnsOf(visible: VisibleColumns): ColumnKey[] {
  return TABLE_COLUMNS.filter((column) => column.locked !== true && visible[column.key] === false).map((column) => column.key);
}

/**
 * 隐藏列 key 列表 → 显隐映射（未列出的列一律显示）。未知 key 忽略（白名单外的旧值 / 新版本列），不抛错 ——
 * 与服务端读侧规范化同一收敛口径。
 */
export function visibleColumnsFromHidden(hidden: readonly string[]): VisibleColumns {
  const next: VisibleColumns = {};
  for (const column of TABLE_COLUMNS) {
    if (column.locked !== true && hidden.includes(column.key)) {
      next[column.key] = false;
    }
  }
  return next;
}

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  高: "bg-rose-50 text-rose-600",
  中: "bg-amber-50 text-amber-700",
  低: "bg-zinc-100 text-zinc-500",
};

/**
 * 正常模式的紧急重要度胶囊（Push 134 收口：业务口径「紧急程度也要」）——
 * 与状态列同一套做法：色签底色**铺满整颗胶囊**（不再套「液态玻璃」白底小框 + 内层色签），悬停再深一档。
 * 底色取色签同色系 100 档（原标签底是 50 档，铺满整颗胶囊后 50 档几乎看不出颜色，故抬一档），字色沿用原标签。
 */
export const PRIORITY_CAPSULE_CLASS: Record<TaskPriority, string> = {
  高: "bg-rose-100 text-rose-600 hover:bg-rose-200/70",
  中: "bg-amber-100 text-amber-700 hover:bg-amber-200/70",
  低: "bg-zinc-100 text-zinc-500 hover:bg-zinc-200/70",
};

export const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  已完成: "bg-emerald-500",
  提前完成: "bg-emerald-500",
  进行中: "bg-blue-500",
  已延期: "bg-red-500",
  待开始: "bg-zinc-300",
};

const STATUS_TEXT_CLASS: Record<TaskStatus, string> = {
  已完成: "text-zinc-600",
  提前完成: "text-emerald-700",
  进行中: "text-zinc-600",
  已延期: "text-red-600",
  待开始: "text-zinc-600",
};

/** 状态色标签（表格行内下拉与单元格共用；看板「任务进展」的表头也用同一套，口径 = 业务截图里的五个色签）。 */
export const STATUS_TAG_CLASS: Record<TaskStatus, string> = {
  已延期: "bg-rose-100 text-rose-700",
  进行中: "bg-amber-100 text-amber-800",
  已完成: "bg-emerald-100 text-emerald-700",
  待开始: "bg-sky-100 text-sky-700",
  提前完成: "bg-fuchsia-100 text-fuchsia-700",
};

/**
 * 背景档位 · 适中档的任务行底色（Push 289 追订「选择适中模式 … 项目总览的颜色应该也要变」→ 定稿
 * 「我要C方案是色调深浅参考 颜色本身不要换 不然我怎么区分状态啊」）：**颜色 = 任务状态色**（五色取图一 500 档），
 * **深浅 = 便签同款配方** —— 底色 = 状态色 × 0.15 + 白、悬停 = × 0.32 + 白
 * （直接复用 backgroundTier.ts 的 mediumCardTintOf / mediumCardBorderOf，与项目空间卡片同一套兑白比例）。
 */
const STATUS_TINT_BASE: Record<TaskStatus, string> = {
  已延期: "#f43f5e",
  进行中: "#f59e0b",
  已完成: "#10b981",
  待开始: "#0ea5e9",
  提前完成: "#d946ef",
};

/** 状态 → 行色对（tint = 常态底、hover = 悬停底）：兑白换算在模块加载时算好，行内只读表。 */
export const STATUS_ROW_TINT: Record<TaskStatus, { tint: string; hover: string }> = {
  已延期: { tint: mediumCardTintOf(STATUS_TINT_BASE.已延期) ?? "", hover: mediumCardBorderOf(STATUS_TINT_BASE.已延期) ?? "" },
  进行中: { tint: mediumCardTintOf(STATUS_TINT_BASE.进行中) ?? "", hover: mediumCardBorderOf(STATUS_TINT_BASE.进行中) ?? "" },
  已完成: { tint: mediumCardTintOf(STATUS_TINT_BASE.已完成) ?? "", hover: mediumCardBorderOf(STATUS_TINT_BASE.已完成) ?? "" },
  待开始: { tint: mediumCardTintOf(STATUS_TINT_BASE.待开始) ?? "", hover: mediumCardBorderOf(STATUS_TINT_BASE.待开始) ?? "" },
  提前完成: { tint: mediumCardTintOf(STATUS_TINT_BASE.提前完成) ?? "", hover: mediumCardBorderOf(STATUS_TINT_BASE.提前完成) ?? "" },
};

/**
 * 背景档位 · 炫彩档的任务行底色（Push 293 · 业务口径 2026-10-13「ok现在我们做炫彩 颜色饱和度偏高的色彩」）：
 * 色相照旧 = 任务状态色（定稿「颜色本身不要换 不然我怎么区分状态啊」），浓淡换高饱和配方 —— 底色 = 状态色 × 0.62 + 白、
 * 悬停 = × 0.82 + 白（复用 backgroundTier.ts 的 vividCardTintOf / vividCardBorderOf；行铺色沿用 .task-row-tint 变量机制）。
 */
export const STATUS_ROW_TINT_VIVID: Record<TaskStatus, { tint: string; hover: string }> = {
  已延期: { tint: vividCardTintOf(STATUS_TINT_BASE.已延期) ?? "", hover: vividCardBorderOf(STATUS_TINT_BASE.已延期) ?? "" },
  进行中: { tint: vividCardTintOf(STATUS_TINT_BASE.进行中) ?? "", hover: vividCardBorderOf(STATUS_TINT_BASE.进行中) ?? "" },
  已完成: { tint: vividCardTintOf(STATUS_TINT_BASE.已完成) ?? "", hover: vividCardBorderOf(STATUS_TINT_BASE.已完成) ?? "" },
  待开始: { tint: vividCardTintOf(STATUS_TINT_BASE.待开始) ?? "", hover: vividCardBorderOf(STATUS_TINT_BASE.待开始) ?? "" },
  提前完成: { tint: vividCardTintOf(STATUS_TINT_BASE.提前完成) ?? "", hover: vividCardBorderOf(STATUS_TINT_BASE.提前完成) ?? "" },
};

/**
 * 正常模式的状态列胶囊（Push 134 收口：业务口径「这个颜色填满胶囊」）——
 * 色签底色铺满整颗胶囊（不再套「液态玻璃」白底小框、也不留内层白边），悬停再深一档。
 */
export const STATUS_CAPSULE_CLASS: Record<TaskStatus, string> = {
  已延期: "bg-rose-100 text-rose-700 hover:bg-rose-200/70",
  进行中: "bg-amber-100 text-amber-800 hover:bg-amber-200/70",
  已完成: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200/70",
  待开始: "bg-sky-100 text-sky-700 hover:bg-sky-200/70",
  提前完成: "bg-fuchsia-100 text-fuchsia-700 hover:bg-fuchsia-200/70",
};

/**
 * 铺色档（适中 / 炫彩 · tierTint）下的状态列字色（Push 289 追订「字体颜色饱和度高一点」→「还不够 再高一点」→「饱和度高了 但是颜色深度不够」
 * →「深度加了 但是感觉还不是很吸睛」）：Tailwind 调色板里没有「又艳又深」这一档（500 档够艳但偏浅、700 档够深但彩度掉），
 * 直接自定 oklch —— **彩度再抬到 500 档之上（×1.08）、明度压到 52 ~ 58%**（色相取图一 500 档；进行中的琥珀明度只能到 58%、彩度也只能到 .20，再压出色域）。
 * 「吸睛」的另外两手在状态列的分支里：字号 13px、字重 700、字距 tracking-wide（见下面 triggerClassName）。
 * （Push 290 起「醒目模式」下架：本档 = 唯一的彩色字档，由背景档位铺色档「适中 / 炫彩」驱动。）
 */
export const STATUS_TAG_TEXT_TIER_CLASS: Record<TaskStatus, string> = {
  已延期: "text-[oklch(52%_.26_16.44)]",
  进行中: "text-[oklch(58%_.20_70.08)]",
  已完成: "text-[oklch(53%_.18_162.48)]",
  待开始: "text-[oklch(53%_.18_237.32)]",
  提前完成: "text-[oklch(53%_.30_322.15)]",
};

/** 任务状态可选项（顺序对齐业务截图：已延期 / 进行中 / 已完成 / 待开始 / 提前完成）。 */
const STATUS_VALUES: TaskStatus[] = ["已延期", "进行中", "已完成", "待开始", "提前完成"];

/** 状态下拉选项（Push 301 字段 / 提示英译：状态名经 statusText 换当前语言；色签沿用中文字典键）。 */
function statusOptionsOf(statusOf: (value: string) => string): SelectOption[] {
  return STATUS_VALUES.map((status) => ({
    value: status,
    label: <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + STATUS_TAG_CLASS[status]}>{statusOf(status)}</span>,
  }));
}

/** 行内编辑能改的任务字段（项目经理是项目级字段，不在其中）。 */
export type TaskPatch = Partial<Pick<ProjectTask, "title" | "titleEn" | "ownerIds" | "startDate" | "dueDate" | "days" | "headcount" | "priority" | "deliverableTypes" | "note">>;
/**
 * 行内编辑 / 抽屉编辑共用的「patch → PATCH body」映射（Push 279 从项目页 handlePatchTask 抽出 · version 由调用方带）：
 * 空串 = 清空（契约 nullable）这类字段口径只维护这一处 —— 项目页任务表与工作台「我的任务」的行内编辑同源。
 */
export function taskPatchBody(version: number, patch: TaskPatch): TaskUpdateInput {
  const body: TaskUpdateInput = { version };
  if (patch.title !== undefined) {
    body.title = patch.title;
  }
  if (patch.titleEn !== undefined) {
    body.titleEn = patch.titleEn === "" ? null : patch.titleEn;
  }
  if (patch.ownerIds !== undefined) {
    body.ownerIds = patch.ownerIds;
  }
  if (patch.startDate !== undefined) {
    body.plannedStart = patch.startDate === "" ? null : patch.startDate;
  }
  if (patch.dueDate !== undefined) {
    body.plannedEnd = patch.dueDate === "" ? null : patch.dueDate;
  }
  if (patch.days !== undefined) {
    body.estimatedDays = patch.days;
  }
  if (patch.headcount !== undefined) {
    body.headcount = patch.headcount;
  }
  if (patch.priority !== undefined) {
    body.priority = patch.priority;
  }
  if (patch.deliverableTypes !== undefined) {
    body.deliverableTypes = patch.deliverableTypes;
  }
  if (patch.note !== undefined) {
    body.note = patch.note;
  }
  return body;
}


const PRIORITY_VALUES: TaskPriority[] = ["高", "中", "低"];

type TaskBoardProps = {
  tasks: ProjectTask[];
  onSetProgress?: (taskId: string, progress: number) => void;
  /** 任务状态下拉（五态）：进度与完成日期的联动由服务端裁决（不传 = 状态列只读）。 */
  onSetStatus?: (taskId: string, status: TaskStatus) => void;
  /** 实际完成日期（填 = 完成、清 = 退回进行中）；不传 = 只读。 */
  onSetActualEnd?: (taskId: string, iso: string) => void;
  /** 人员候选（GET /api/v1/users 目录）：项目经理列 / 任务负责人列 / 抽屉共用。 */
  members: readonly Member[];
  visibleColumns?: VisibleColumns;
  scrollRef?: RefObject<HTMLDivElement | null>;
  collapsed: Record<string, boolean>;
  onToggleStage: (stage: string) => void;
  onToggleAllStages: () => void;
  /** 没有数据也要出分组头的阶段（还没有任务的项目：只出阶段骨架，展开后没有任务行）。 */
  skeletonStages?: readonly string[];
  /** 「添加任务」：从任务模板预设里挑节点加进项目（不传 = 阶段标签点不开右侧卡片）。 */
  onAddNode?: (stage: string, node: TemplatePresetNode) => void;
  /** 加一条 / 一批并指定插入位置（Push 113：点「＋ 添加」先弹位置浮层，选完才加进项目）。不传 = 点一条直接加到该阶段最后。 */
  onAddNodes?: (stage: string, nodes: readonly TemplatePresetNode[], placement: StagePlacement, templateId?: string) => void;
  /** 项目经理展示文本（项目级字段：取项目卡片上的名单，多位按「、」连接；不传时回落常量占位）。 */
  managers?: string;
  /** 项目经理 id 名单（项目级字段：行内多选下拉的当前选中项，Push 136）。 */
  managerIds?: string[];
  /** 任务编辑保存：负责人 / 日期（含联动天数）/ 施工人数 / 紧急重要度 / 进展描述 + 项目经理 id。 */
  onSubmitTaskEdit?: (values: TaskEditSubmit) => Promise<number | null>;
  /** 任务描述改名（Push 196：抽屉里改临时任务名；阶段任务与节点 / 模板生成的任务由抽屉按锁定口径自行只读）。 */
  onRenameTask?: (taskId: string, title: string, titleEn: string) => void;
  /**
   * 底部「临时任务」分组头的常驻新建入口（Push 197）：点分组头直接填名称新建（没有模板可挑），
   * 返回新任务 id（失败 = null）—— 拿到后直接打开它的详情抽屉补时间等细节；不传 = 分组头点不动。
   */
  onCreateTempTask?: (values: { title: string; titleEn: string }) => Promise<string | null>;
  /** 表格行内编辑：只改任务字段（负责人 / 日期（含联动天数）/ 施工人数 / 紧急重要度 / 进展描述）。 */
  onPatchTask?: (taskId: string, patch: TaskPatch) => void;
  /** 任务表行内删除（Push 141：行悬停的删除按钮，不传 = 不显示该按钮）。 */
  onDeleteTask?: (taskId: string) => void;
  /** 表格行内改「项目经理」：项目级字段（多位，Push 136），回写项目（不传 = 该列仍是只读文本）。 */
  onChangeManagers?: (managerIds: string[]) => void;
  /** 当前视图的阶段（「项目总览」或某个阶段）：换阶段时把右侧卡片关掉。 */
  viewStage?: string;
  /**
   * 背景档位 · 铺色档（Push 289 追订定稿「用 c · 色调深浅参考、颜色本身不要换」；Push 293 扩展炫彩）：
   * "medium" = 便签同款淡彩整行铺**任务状态色**（STATUS_ROW_TINT）；"vivid" = 同色相高饱和浓彩（STATUS_ROW_TINT_VIVID）；
   * 两档都把状态列收口成深色字。不传 / false = 白底行 + 色签胶囊（Push 290「醒目模式」下架后，本项 = 唯一的整行铺色开关）。
   */
  tierTint?: TintedTier | false;
  /**
   * 任务文件上传（Push 226 · 「文件」那一刀前端接线；Push 246 起入口收进「文件」列下拉顶部的「＋ 添加文件」）：
   * 选文件 → 调用方分片直传文件库并关联本任务，完成后整表重取刷新计数；不传 = 下拉里不显示添加入口。
   * onProgress 供下拉 / 单元格胶囊上的「上传中 N/M」提示（done = 已完成份数）；
   * finalize（Push 249 · 业务口径「若是则上传文件后该任务定档不支持任何修改」）= 定档上传：传完即对该文件定档
   * （任务随定档锁定，此后任务不支持任何修改、修改走变更）。
   */
  onUploadFiles?: (taskId: string, files: File[], onProgress?: (done: number, total: number) => void, finalize?: boolean) => Promise<void>;
  /**
   * 任务文件删除（Push 226 续；Push 246 起「文件」列下拉行尾也走同一入口）：抽屉清单 / 下拉里点「删除」
   * = 调用方走回收站（M4-02），完成后整表重取刷新计数；不传 = 清单与下拉只读（不显示删除入口）。
   */
  onDeleteFile?: (fileId: string) => Promise<void>;
  /** 任务文件改名（Push 226 续二）：抽屉清单里点名字 → 编辑提交（只改主名、后缀保留）；不传 = 名字只读。 */
  onRenameFile?: (fileId: string, name: string) => Promise<void>;
  /**
   * 任务定档（Push 252 · 抽屉头部「定档」开关 + 二次确认）：透传给任务详情抽屉，确认后由调用方 POST …/finalize
   * （置位后任务不支持任何修改，服务端 409 TASK_FINALIZED 兜底）；不传 = 抽屉不渲染开关。
   */
  onFinalize?: (taskId: string) => void;
  /**
   * 任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：透传给任务详情抽屉 —— 已定档开关
   * 再次点击 → 二次确认 → 由调用方 POST …/unfinalize（清位重开）；不传 = 已定档开关保持只读置灰。
   */
  onUnfinalize?: (taskId: string) => void;
  /**
   * 变更生效后的父级刷新（Push 254 · 抽屉「变更申请」页）：透传给任务详情抽屉 —— 提交变更是变更记录 +
   * 新版本 + 任务「变更关联」（R01）的合并落库，完成后由调用方整表重取刷新；不传 = 抽屉只刷新自己的文件清单。
   */
  onChanged?: () => void;
  /** 当前登录人姓名（Push 254 · 抽屉「变更申请」页「变更申请人」只读展示）；不传 = 显示「当前登录人」。 */
  actorName?: string;
  /** 任务 → 文件引用（Push 246 · fileApi.fetchTaskFiles）：「文件」列胶囊显示文件名 / 「+N」、
   *  下拉里点名字预览 + 删除；不传 / 取不到 = 退回「N 份」计数（老数据 / 请求失败）。 */
  filesByTask?: ReadonlyMap<string, TaskFileRef[]>;
  /** 任务详情接口所需（抽屉里的文件清单按它取详情）；不传 = 抽屉不拉清单。 */
  projectId?: string;
};

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={"h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform " + (collapsed ? "" : "rotate-90")}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** 任务表的行（项目总览 / 工作台「我的任务」共用 · Push 279 起导出给工作台复用）：各列按回调是否传入自动切换
 *  只读 / 可编辑 —— 行内进度（onProgress）/ 项目经理（onChangeManagers）/ 负责人（onPatch.ownerIds）/ 状态
 *  （onSetStatus）/ 紧急重要度与成果文件与进展描述（onPatch）/ 「文件」列下拉（onUploadFiles + onDeleteFile）/
 *  三段日期与人数（onPatch）；天数不单开编辑（随日期联动写回，与项目页同口径）。点行 = onSelect（开抽屉）；**onSelect 不传 = 整行不可点**（不出「点击查看任务详情」提示、不出 pointer 光标、不占键盘 Tab 焦点；行内各列仍按回调照常只读 / 可编辑 —— 甘特图「画不出时间轴」的兜底列表这样用，Push 294）。
 *  subtitle 缺省 = 英文名小行（项目页口径）；工作台传「阶段 / 临时任务 · 英文名」保持自己那张表的副行。 */
export function TaskRow({ task, columns, selected, onSelect, onProgress, onDelete, managers, managerIds, members, onSetStatus, onSetActualEnd, onChangeManagers, onPatch, onUploadFiles, onDeleteFile, files, tierTint, subtitle }: { task: ProjectTask; columns: ColumnDef[]; selected: boolean; onSelect?: () => void; onProgress?: (progress: number) => void; onDelete?: () => void; managers: string; managerIds: string[]; members: readonly Member[]; onSetStatus?: (status: TaskStatus) => void; onSetActualEnd?: (iso: string) => void; onChangeManagers?: (managerIds: string[]) => void; onPatch?: (patch: TaskPatch) => void; onUploadFiles?: (taskId: string, files: File[], onProgress?: (done: number, total: number) => void, finalize?: boolean) => Promise<void>; onDeleteFile?: (fileId: string) => Promise<void>; files?: readonly TaskFileRef[]; tierTint?: TintedTier | false; subtitle?: string }) {
  const locale = useLocale();
  const t = useT();
  /** 手打内容机翻显示（业务口径 2026-10-13「因为页面有些内容是手打的 我建议是提前后台机翻」）：
   *  英文界面任务名按「自带英文名 titleEn 优先 → 机翻译文 → 原文」回退；副行给中文原名对照；中文界面照旧。 */
  const localizedTitle = useLocalizedText(task.title);
  const localizedNote = useLocalizedText(task.note);
  const titleText = locale === "en" ? (task.titleEn !== "" ? task.titleEn : localizedTitle) : task.title;
  const subText = locale === "en" ? (subtitle ?? (titleText === task.title ? "" : task.title)) : (subtitle ?? task.titleEn);
  /** 「是否按时交付」列的逾期标注（服务端展示态 + onTime 派生，前端不再本地算日期）。 */
  const late = lateDeliveryLabel(task);
  const status = task.status;
  /** 背景档位铺色档（适中 / 炫彩）：行铺状态色 + 状态列收口深色字；simple / 未传 = 胶囊照旧。 */
  const tierTinted = tierTint === "medium" || tierTint === "vivid";
  /** 定档锁定（Push 264 · P1-1）：行内任务字段入口一律锁定（点击弹顶部 Toast、不弹编辑浮层）；
   *  2026-10-10 业务追订「项目经理也不可以修改」——「项目经理」列随行一并锁定；「文件」列仍走既有 taskFinalized 门控（修改走变更）。 */
  const taskFinalized = task.finalizedAt !== null;
  /** Push 301：状态 / 优先级下拉选项按当前语言换词（显示值经 statusText / priorityText）。 */
  const statusOptions = statusOptionsOf((value) => statusText(locale, value));
  const priorityOptions: SelectOption[] = PRIORITY_VALUES.map((value) => ({ value, label: priorityText(locale, value) }));
  const dotClass = STATUS_DOT_CLASS[status];
  /** 负责人展示（多位按「、」连接，Push 136；2026-09-24 定案「只按名字」—— 拼音口径下线）。 */
  const fullOwners = ownersLabel(task.owners);
  const startIso = task.startDate;
  const dueIso = task.dueDate;
  const doneIso = task.doneDate;
  const startText = mdText(locale, startIso);
  const dueText = mdText(locale, dueIso);
  const doneText = mdText(locale, doneIso);
  /** 行内改任一日期时，把两个显示日期与联动天数一起写回（含首尾）。 */
  const patchRange = (nextStartIso: string, nextDueIso: string) => {
    onPatch?.({
      startDate: nextStartIso,
      dueDate: nextDueIso,
      days: nextStartIso !== "" && nextDueIso !== "" ? daysBetweenInclusive(nextStartIso, nextDueIso) : 0,
    });
  };

  /** 「变更关联」列点击弹窗（Push 256 · 业务口径「变更关联点击后要显示一个这样的内容在中间」）：非空 = 中央展示该变更的「变更管理」详情。 */
  const [changeModalId, setChangeModalId] = useState<string | null>(null);
  /** 「文件」列胶囊内容（Push 226 续二 · 业务口径「应该是文件名字 超出长度后面写+1 +2」；Push 246 起兼作下拉触发器）：
   *  与「输出成果文件」列同套 —— 第一份出名字（截断 + title 全名）、后面还有就「+N」；
   *  文件清单没取到（老数据 / 请求失败）退回「N 份」计数。 */
  const filesForTask = files ?? [];
  const fileCellContent = task.files.total === 0 ? (
    <span className="text-xs text-zinc-300">—</span>
  ) : filesForTask.length > 0 ? (
    <>
      <span
        className="inline-block max-w-full truncate rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600"
        title={filesForTask.map((file) => file.name).join("、")}
      >
        {filesForTask[0].name}
      </span>
      {filesForTask.length > 1 ? <span className="text-[10px] text-zinc-400">+{filesForTask.length - 1}</span> : null}
    </>
  ) : (
    <span className="inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-600" title={t("board.files.title", { n: task.files.total })}>
      {t("board.files.count", { n: task.files.total })}
    </span>
  );

  const cells: Record<ColumnKey, ReactNode> = {
    title: (
      <div data-column="title" className="flex min-w-0 items-center gap-4 self-stretch">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-zinc-900" title={titleText + (subText === "" ? "" : " / " + subText)}>
            {titleText}
          </p>
          {subText === "" ? null : (
            <p className="mt-0.5 max-w-[280px] truncate text-[11px] leading-4 text-zinc-400" title={subText}>{subText}</p>
          )}
        </div>
        {onProgress === undefined ? (
          <span className="shrink-0">
            <TrackerDots progress={task.progress} hovered={0} onHoverChange={() => { /* 只读行：不接悬停预览 */ }} vivid={tierTint === "vivid"} />
          </span>
        ) : (
          <Tracker progress={task.progress} onChange={onProgress} vivid={tierTint === "vivid"} />
        )}
        {onDelete === undefined ? null : (
          // 删除动作位（Push 141，业务口径「不要这个笔作为编辑了…改成删除按钮吧」）：固定 48px 槽位 + 右侧 16px 留白（业务反馈「当项目经理大于两位时 就是会触碰到」—— 展开胶囊右缘原与「项目经理」列齐平，留白后不贴列），
          // 行悬停浮现 24px 幽灵态删除按钮（无底色，业务反馈「黑的太突兀了…要比较看不出来」）、悬停按钮展开成 48px 小号红底胶囊 —— 展开只吃槽位，不挤动四格进度条与描述文字。
          <span className="mr-4 flex w-12 shrink-0 items-center self-stretch">
            <RowDeleteButton onDelete={onDelete} />
          </span>
        )}
      </div>
    ),
    manager:
      onChangeManagers === undefined ? (
        <span className="truncate text-xs text-zinc-600" title={managers}>{managers}</span>
      ) : (
        <InlineMemberMultiCell
          values={managerIds}
          options={members}
          ariaLabel={t("board.edit.aria", { field: fieldText(locale, "项目经理") })}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          display={<span className="text-zinc-600" title={managers}>{managers}</span>}
          onPick={(member) => {
            if (managerIds.includes(member.id)) {
              // 至少留一位（对齐契约 projects.manager_ids 非空）：取消最后一位时不生效
              if (managerIds.length <= 1) {
                return;
              }
              onChangeManagers(managerIds.filter((id) => id !== member.id));
              return;
            }
            onChangeManagers([...managerIds, member.id]);
          }}
        />
      ),
    owner:
      onPatch === undefined ? (
        task.owners.length === 0 ? (
          <span className="text-xs text-zinc-300">{fieldText(locale, "待分配")}</span>
        ) : (
          <span className="truncate text-xs text-zinc-600" title={fullOwners}>
            {ownersLabel(task.owners)}
          </span>
        )
      ) : (
        <InlineMemberMultiCell
          values={task.ownerIds}
          options={members}
          ariaLabel={t("board.edit.aria", { field: fieldText(locale, "任务负责人") })}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          display={
            task.owners.length === 0 ? (
              <span className="text-zinc-300">{fieldText(locale, "待分配")}</span>
            ) : (
              <span className="text-zinc-600" title={fullOwners}>
                {ownersLabel(task.owners)}
              </span>
            )
          }
          onPick={(member) => {
            const next = task.ownerIds.includes(member.id)
              ? task.ownerIds.filter((id) => id !== member.id)
              : [...task.ownerIds, member.id];
            // 全部取消 = 「待分配」（合法中间状态，A18）；数组顺序 = 勾选顺序
            onPatch({ ownerIds: next });
          }}
        />
      ),
    status:
      onSetStatus === undefined ? (
        <span className={"inline-flex items-center gap-1.5 text-xs " + STATUS_TEXT_CLASS[status]}>
          <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + dotClass} />
          {statusText(locale, status)}
        </span>
      ) : (
        <InlineOptionCell
          value={status}
          options={statusOptions}
          ariaLabel={t("board.edit.aria", { field: fieldText(locale, "任务状态") })}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          // Push 134：状态列改成裸框胶囊 —— 简约档（默认）= 图一色签的色**填满整颗胶囊**（原白底小框 + 内层色签合成一颗）；
          // 背景档位铺色档（tierTint = medium / vivid）= 行上已有状态色，状态列收口 —— 撤掉胶囊底色只留该状态的深色字
          // （否则胶囊底 ≈ 行底色、看上去忽有忽无）。铺色档字色 = STATUS_TAG_TEXT_TIER_CLASS（自定 oklch：
          // 彩度 500 档 ×1.08、明度压深到 52~58%，外加 13px / 700 / 字距 tracking-wide ——
          // 追订「饱和度高了 但是颜色深度不够」→「深度加了 但是感觉还不是很吸睛」）。
          bare
          triggerClassName={
            tierTinted
              ? STATUS_TAG_TEXT_TIER_CLASS[status] + " px-1.5 py-[3px] text-[13px] font-bold tracking-wide hover:bg-zinc-900/[0.04]"
              : STATUS_CAPSULE_CLASS[status] + " px-3 py-1.5 text-[11px] font-medium"
          }
          display={<span className="truncate">{statusText(locale, status)}</span>}
          onPick={(value) => {
            // 五态写入（2026-09-24 定案）：进度与完成日期的联动由服务端同事务裁决，口径与原型逐条一致
            onSetStatus(value as TaskStatus);
          }}
        />
      ),
    priority: (
      <span>
        {task.priority === null ? (
          <span className="text-xs text-zinc-300">—</span>
        ) : onPatch === undefined ? (
          <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + PRIORITY_CLASS[task.priority]}>
            {priorityText(locale, task.priority)}
          </span>
        ) : (
          <InlineOptionCell
            value={task.priority}
            options={priorityOptions}
            ariaLabel={t("board.edit.aria", { field: fieldText(locale, "紧急重要度") })}
            disabled={taskFinalized}
            disabledHint={t("board.finalizedHint")}
            // Push 134：紧急重要度同状态列 —— 裸框胶囊，色签底色**填满整颗胶囊**（业务口径「紧急程度也要」）
            bare
            triggerClassName={PRIORITY_CAPSULE_CLASS[task.priority] + " px-3 py-1.5 text-[11px] font-medium"}
            display={<span className="truncate">{priorityText(locale, task.priority)}</span>}
            onPick={(value) => {
              onPatch({ priority: value as TaskPriority });
            }}
          />
        )}
      </span>
    ),
    onTime: (
      // 2026-10-13 业务口径（英文界面「留白太多 文字未居中」）：英文徽标（Overdue · delivered / Overdue · not delivered）
      // 在最小宽下断成两行、徽标撑满整列 —— 断行文本居中 + 行高收紧，右半列不再留一大片空白。
      <span>
        {late === "逾期未交付" ? (
          <span className="inline-block rounded bg-red-50 px-1.5 py-0.5 text-center text-[11px] font-medium leading-tight text-red-600">{statusText(locale, "逾期未交付")}</span>
        ) : late === "逾期已交付" ? (
          <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-center text-[11px] font-medium leading-tight text-amber-700">{statusText(locale, "逾期已交付")}</span>
        ) : task.onTime === null ? (
          <span className="text-xs text-zinc-300">—</span>
        ) : (
          <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-center text-[11px] leading-tight text-emerald-700">{statusText(locale, "按时交付")}</span>
        )}
      </span>
    ),
    // 输出成果文件（2026-10-08 · 业务口径「文件输出成果也要可以选择」）：只读徽标改可点选择 ——
    // 点开 = DeliverablePicker（搜索 + 十类彩签多选）；列窄走「首枚 + +N」，全名清单进浮层。
    deliverable:
      onPatch === undefined ? (
        <span className="flex min-w-0 items-center gap-1">
          {task.deliverableTypes.length === 0 ? (
            <span className="text-xs text-zinc-300">—</span>
          ) : (
            <>
              {docTypeCapsule(task.deliverableTypes[0], locale)}
              {task.deliverableTypes.length > 1 ? <span className="text-[10px] text-zinc-400">+{task.deliverableTypes.length - 1}</span> : null}
            </>
          )}
        </span>
      ) : (
        <DeliverableCell
          values={task.deliverableTypes}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          onChange={(next) => {
            onPatch({ deliverableTypes: next });
          }}
        />
      ),
    files: (
      <span className="relative flex min-w-0 items-center justify-center gap-1 self-stretch">
        {onUploadFiles === undefined && onDeleteFile === undefined ? (
          fileCellContent
        ) : (
          <TaskFilesPopover
            taskId={task.id}
            taskTitle={task.title}
            files={filesForTask}
            onUpload={onUploadFiles}
            onDelete={onDeleteFile}
            taskFinalized={task.finalizedAt !== null}
          >
            {fileCellContent}
          </TaskFilesPopover>
        )}
      </span>
    ),
    note: (
      <span className="min-w-0">
        {onPatch === undefined ? (
          task.note === "" ? (
            <span className="text-xs text-zinc-300">—</span>
          ) : (
            <span className="block truncate text-xs text-zinc-600" title={task.note}>{localizedNote}</span>
          )
        ) : (
          <InlineTextCell
            value={task.note}
            ariaLabel={t("board.edit.aria", { field: fieldText(locale, "项目进展描述") })}
            disabled={taskFinalized}
            disabledHint={t("board.finalizedHint")}
            display={task.note === "" ? <span className="text-zinc-300">—</span> : <span className="text-zinc-600" title={task.note}>{localizedNote}</span>}
            onSave={(value) => {
              onPatch({ note: value });
            }}
          />
        )}
      </span>
    ),
    start:
      onPatch === undefined ? (
        <span className="text-xs tabular-nums text-zinc-600">{startText}</span>
      ) : (
        <InlineDateCell
          valueIso={startIso}
          ariaLabel={t("board.edit.aria", { field: fieldText(locale, "开始日期") })}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          triggerClassName="tabular-nums text-zinc-600"
          display={startText === "" ? <span className="text-zinc-300">—</span> : startText}
          onChange={(iso) => {
            patchRange(iso, dueIso);
          }}
        />
      ),
    days: (
      <span className="relative flex items-center justify-center self-stretch">
        <span className="h-px w-10 bg-zinc-300" />
        <span className="absolute inset-x-0 bottom-1/2 mb-1 text-center text-[11px] leading-none tabular-nums text-zinc-500">{task.days}</span>
      </span>
    ),
    due:
      onPatch === undefined ? (
        <span className="text-xs tabular-nums text-zinc-600">{dueText}</span>
      ) : (
        <InlineDateCell
          valueIso={dueIso}
          ariaLabel={t("board.edit.aria", { field: fieldText(locale, "预计完成日期") })}
          disabled={taskFinalized}
          disabledHint={t("board.finalizedHint")}
          triggerClassName="tabular-nums text-zinc-600"
          display={dueText === "" ? <span className="text-zinc-300">—</span> : dueText}
          onChange={(iso) => {
            patchRange(startIso, iso);
          }}
        />
      ),
    headcount: (
      <span className="text-xs tabular-nums text-zinc-600">
        {onPatch === undefined ? (
          task.headcount > 0 ? (
            t("drawer.headcount.value", { n: task.headcount })
          ) : (
            <span className="text-zinc-300">—</span>
          )
        ) : (
          <InlineNumberCell
            value={task.headcount}
            ariaLabel={t("board.edit.aria", { field: fieldText(locale, "预计所需施工人数") })}
            disabled={taskFinalized}
            disabledHint={t("board.finalizedHint")}
            display={task.headcount > 0 ? t("drawer.headcount.value", { n: task.headcount }) : <span className="text-zinc-300">—</span>}
            onSave={(value) => {
              onPatch({ headcount: value });
            }}
          />
        )}
      </span>
    ),
    doneDate: (
      <span className="text-xs tabular-nums">
        {onSetActualEnd === undefined ? (
          task.doneDate !== "" ? (
            <span className="text-zinc-600">{doneText}</span>
          ) : (
            <span className="text-zinc-400">—</span>
          )
        ) : (
          <InlineDateCell
            valueIso={doneIso}
            ariaLabel={t("board.edit.aria", { field: fieldText(locale, "实际完成日期") })}
            disabled={taskFinalized}
            disabledHint={t("board.finalizedHint")}
            triggerClassName="tabular-nums"
            display={task.doneDate !== "" ? <span className="text-zinc-600">{doneText}</span> : <span className="text-zinc-400">—</span>}
            onChange={(iso) => {
              // 填实际完成日期 = 完成（四格全亮）；清空 = 退回进行中（进度 3 格）—— 状态联动交给服务端
              onSetActualEnd(iso);
            }}
          />
        )}
      </span>
    ),
    change: (
      <span
        className="flex items-center gap-1"
        title={
          task.changes.length === 0
            ? undefined
            : task.changes.map((change) => t("board.change.tip", { date: dateOnlyText(change.appliedAt) }) + (change.reason === "" ? "" : (locale === "en" ? " (" + change.reason + ")" : "（" + change.reason + "）"))).join(locale === "en" ? "; " : "；")
        }
      >
        {task.changes.length === 0 ? null : (
          <button
            type="button"
            data-change-link-open="true"
            title={t("drawer.change.linkTitle")}
            onClick={(event) => {
              event.stopPropagation();
              setChangeModalId(task.changes[0].id);
            }}
            className="flex items-center gap-1"
          >
            <span className="inline-block whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-200">{t("board.change.chip")}</span>
            {task.changes.length > 1 ? <span className="text-[10px] text-zinc-400">+{task.changes.length - 1}</span> : null}
          </button>
        )}
      </span>
    ),
  };

  return (
    <>
      <div
        role={onSelect === undefined ? undefined : "button"}
        data-task-finalized-row={task.finalizedAt === null ? undefined : task.id}
        data-live-row={task.id}
        tabIndex={onSelect === undefined ? -1 : 0}
        title={onSelect === undefined ? undefined : t("board.row.openTitle")}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (onSelect === undefined) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={
          "group grid items-center px-5 py-2.5 transition-colors focus-visible:outline-none " +
          (onSelect === undefined ? "" : "cursor-pointer ") +
          // 背景档位铺色档（tierTint = medium / vivid）：整行铺任务状态色（浓淡随档），悬停压深一档（app.css 的 .task-row-tint；
          // 选中行的黄色竖标线照旧；键盘焦点圈走 inset ring，不换底色）。
          (tierTinted
            ? "task-row-tint" + (tierTint === "vivid" ? " tint-vivid" : "") + " focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900/25" + (selected ? " shadow-[inset_3px_0_0_0_#feca04]" : "")
            : selected
              ? "bg-amber-50/70 shadow-[inset_3px_0_0_0_#feca04]"
              : "hover:bg-zinc-50/80 focus-visible:bg-zinc-50")
        }
        style={
          tierTinted
            ? ({
                gridTemplateColumns: tableGridTemplate(columns),
                "--row-tint": (tierTint === "vivid" ? STATUS_ROW_TINT_VIVID : STATUS_ROW_TINT)[status].tint,
                "--row-tint-hover": (tierTint === "vivid" ? STATUS_ROW_TINT_VIVID : STATUS_ROW_TINT)[status].hover,
              } as CSSProperties)
            : { gridTemplateColumns: tableGridTemplate(columns) }
        }
      >
        {columns.map((column) => (
          <Fragment key={column.key}>
            {column.key === "title" ? (
              cells[column.key]
            ) : (
              // 单元格内容一律居中于列标题（Push 67 业务口径）；任务描述列保持左对齐（内含四格进度条 + 铅笔）。
              // 左右各留 4px 内衬（业务口径 2026-09-30「这个触碰到了 要优化一下」）：满宽内容（文件名胶囊 / 进展描述胶囊）
              // 与相邻列不再贴边 —— 两格相邻时天然留出 8px 空隙；内容居中口径不变。
              <div data-column={column.key} className="flex min-w-0 items-center justify-center self-stretch px-1">{cells[column.key]}</div>
            )}
          </Fragment>
        ))}
      </div>
      {changeModalId === null ? null : (
        <ChangeDetailModal
          changeId={changeModalId}
          linkedTaskTitle={task.title}
          members={members}
          deliverableTypes={task.deliverableTypes}
          onOpenLinkedTask={() => { setChangeModalId(null); onSelect?.(); }}
          onClose={() => { setChangeModalId(null); }}
        />
      )}
    </>
  );
}

export function ProjectSummary({ summary }: { summary: ApiProjectSummary | null }) {
  const locale = useLocale();
  const t = useT();
  const total = summary?.total ?? 0;
  const done = summary?.done ?? 0;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  /** 阶段 key → 展示名；null = 服务端判不出（最慢阶段：全部完成或没有任务；最新阶段：还没任务动工）。 */
  const stageLabel = (stageKey: string | null): string => (stageKey === null ? "—" : stageText(locale, stageNameOf(stageKey)));
  const slowest = summary?.slowestStage ?? null;
  const latest = summary?.latestStage ?? null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl border border-zinc-200 bg-white px-5 py-3.5">
      <p className="text-xs text-zinc-500">
        {t("board.summary.slowest")}
        <span className="ml-1.5 text-sm font-bold text-zinc-800">{total > 0 && slowest === null ? t("board.summary.allDone") : stageLabel(slowest)}</span>
      </p>
      <p className="text-xs text-zinc-500">
        {t("board.summary.latest")}<span className="ml-1.5 text-sm font-bold text-zinc-800">{stageLabel(latest)}</span>
      </p>
      <div className="ml-auto flex items-center gap-2.5">
        <span className="text-xs text-zinc-500">{t("board.summary.progress")}</span>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-zinc-100">
          <div className="h-full rounded-full bg-zinc-900" style={{ width: pct + "%" }} />
        </div>
        <span className="text-sm font-semibold tabular-nums text-zinc-900">{pct}%</span>
        {/* 没有任务的项目：不显示 0/0 完成这种没有意义的计数 */}
        {total === 0 ? null : (
          <span className="text-xs text-zinc-400">
            {t("board.summary.done", { done: done, total: total })}
          </span>
        )}
      </div>
    </div>
  );
}

export function TaskBoard({ tasks, onSetProgress, onSetStatus, onSetActualEnd, members, visibleColumns, scrollRef, collapsed, onToggleStage, onToggleAllStages, skeletonStages, onAddNode, onAddNodes, onCreateTempTask, viewStage, managers, managerIds, onSubmitTaskEdit, onRenameTask, onPatchTask, onDeleteTask, onChangeManagers, onUploadFiles, onDeleteFile, onRenameFile, onFinalize, onUnfinalize, onChanged, actorName, filesByTask, projectId, tierTint }: TaskBoardProps) {
  const t = useT();
  const locale = useLocale();
  /**
   * 打开的任务详情抽屉（Push 197 起存 **id** 不存快照）：底部「临时任务」入口建完先落 id、列表重取后自动开
   * （与看板 Push 196 同一口径）；行内点选走同一个入口。
   */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** 右侧「任务节点 / 模板」卡片停在哪个阶段（点阶段标签打开）。 */
  const [cardStage, setCardStage] = useState<string | null>(null);
  /** 底部「临时任务」分组头的新建表单开着没有（Push 197；与阶段卡片互斥）。 */
  const [tempFormOpen, setTempFormOpen] = useState(false);
  /** 键盘焦点陷阱（Push 264 追订）：临时任务新建浮层开着时焦点进浮层、Tab 在浮层内循环。 */
  const tempFormTrapRef = useFocusTrap<HTMLDivElement>(tempFormOpen && onCreateTempTask !== undefined);
  /** 卡片的落点（Push 67：固定在表格表头正下方、左边缘对齐「项目经理」列，不浮在页面右上角、也不跟着点击跑）。 */
  const [cardBox, setCardBox] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const boardCardRef = useRef<HTMLDivElement | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const closeDrawer = () => setSelectedTaskId(null);
  /** 抽屉里的任务按 id 取当前值（Push 98）：抽屉里点四格进度、卡片上改实际完成日期后，抽屉要立刻跟着变 ——
   *  不能拿点击那一刻的任务快照，否则父级刷新后抽屉还显示旧进度。Push 197 起选中的是 id：新建的临时任务
   *  先落 id、列表重取回来才找得到行（找得到才开抽屉）。 */
  const drawerTask = selectedTaskId === null ? null : tasks.find((task) => task.id === selectedTaskId) ?? null;
  const columns = resolveColumns(visibleColumns ?? DEFAULT_VISIBLE_COLUMNS);
  const gridTemplate = tableGridTemplate(columns);
  const minWidth = tableMinWidth(columns);
  /** 项目里已添加的节点判重键（见 `addedNodeKeysOf`）：添加卡片的节点 / 模板条目按它显示「已添加」并跳过重复。 */
  const addedNodeKeys = addedNodeKeysOf(tasks);
  /** 来源节点 id 集合（见 `addedNodeIdsOf` · M3-07 刀 3）：精确判重，优先于上面的同阶段同名兜底。 */
  const addedNodeIds = addedNodeIdsOf(tasks);
  /**
   * 该阶段现有任务（Push 113）：给「点 ＋ 添加 → 选位置」当锚点 —— `tasks` 已经是展示顺序
   * （阶段为主键、组内按看板顺序表），所以这里的先后 = 项目总览里这些任务的先后。
   */
  const stageTasksOf = (stage: string) =>
    tasks.filter((task) => task.stage === stage).map((task) => ({ id: task.id, title: task.title }));
  // 换阶段标签（顶部）时把卡片关掉，避免卡片停在上一个阶段的上下文里；「临时任务」新建表单同口径
  useEffect(() => {
    setCardStage(null);
    setTempFormOpen(false);
  }, [viewStage]);

  /**
   * 量落点（Push 67，业务定稿版）：卡片**顶部与所点阶段的分组头在同一水平线**（卡顶 = 分组头顶，卡片正好贴在这一阶段左边，
   * 页面滚到哪都保持这条水平线），左边缘对齐「项目经理」列（该列被列显隐关掉时回落到表格右边、始终夹在表格内）。
   */
  const measureCardBox = (stage: string) => {
    const wrap = boardWrapRef.current;
    const board = boardCardRef.current;
    const header = headerRowRef.current;
    if (wrap === null || board === null || header === null) {
      return null;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const stageHeader = board.querySelector('[data-stage-header="' + stage + '"]');
    // 分组头找不到（异常情况）时回落到表头下沿
    const topRect = stageHeader === null ? null : stageHeader.getBoundingClientRect();
    const cardWidth = Math.min(400, wrapRect.width - 48);
    const managerCell = header.querySelector('[data-column="manager"]');
    const managerRect = managerCell === null ? null : managerCell.getBoundingClientRect();
    // 回落到右边（项目经理列被列显隐关掉时），并保证卡片不出表格
    const naturalLeft = managerRect === null ? boardRect.right - 24 - cardWidth : managerRect.left;
    const minLeft = boardRect.left + 16;
    const maxLeft = boardRect.right - 24 - cardWidth;
    const top = topRect === null ? headerRect.bottom + 10 : topRect.top;
    return {
      top: Math.round(top - wrapRect.top),
      left: Math.round(Math.max(minLeft, Math.min(maxLeft, naturalLeft)) - wrapRect.left),
      maxHeight: Math.round(Math.max(320, Math.min(window.innerHeight * 0.72, boardRect.bottom - top - 16))),
    };
  };

  /** 点阶段标签：再点同一个 = 关掉；开的时候先量好落点，避免卡片先闪在旧位置。 */
  const toggleCard = (stage: string) => {
    if (cardStage === stage) {
      setCardStage(null);
      return;
    }
    setTempFormOpen(false);
    setCardBox(measureCardBox(stage));
    setCardStage(stage);
  };

  /** 点底部「临时任务」分组头（Push 197）：再点 = 关掉；开的时候先量好落点（与阶段卡片同一套测量、同一落点）。 */
  const toggleTempForm = () => {
    if (tempFormOpen) {
      setTempFormOpen(false);
      return;
    }
    setCardStage(null);
    setCardBox(measureCardBox(TEMP_TASK_STAGE));
    setTempFormOpen(true);
  };

  /** 当前该量的浮层（Push 197）：「临时任务」新建表单开着就量它，否则量阶段卡片 —— 两者共用同一个落点。 */
  const measureStage = tempFormOpen ? TEMP_TASK_STAGE : cardStage;
  // 表格尺寸变化（列显隐 / 阶段折叠 / 换项目）与窗口缩放时重新量落点
  useEffect(() => {
    if (measureStage === null) {
      return;
    }
    const update = () => {
      setCardBox(measureStage === null ? null : measureCardBox(measureStage));
    };
    update();
    window.addEventListener("resize", update);
    // 表格横向滚动时「项目经理」列会跟着动，卡片跟着列走
    const scroller = scrollRef?.current ?? null;
    scroller?.addEventListener("scroll", update);
    const observer = new ResizeObserver(update);
    if (boardCardRef.current !== null) {
      observer.observe(boardCardRef.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      scroller?.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [measureStage, scrollRef]);

  /**
   * 列头固定（Push 141 业务反馈「这个标题栏要固定 鼠标移动可以依旧显示」）：表头已移出横向滚动容器、自身 sticky 在主标签栏（Push 201 起吸顶）之下，
   * 左右滚动（含底部滑块）时用 translateX 跟随 #task-board-scroll 的 scrollLeft，保证表头与各列始终对齐。
   */
  useEffect(() => {
    const scroller = scrollRef?.current ?? null;
    if (scroller === null) {
      return;
    }
    const sync = () => {
      const header = headerRowRef.current;
      if (header !== null) {
        header.style.transform = "translateX(" + String(-scroller.scrollLeft) + "px)";
      }
    };
    sync();
    scroller.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      scroller.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [scrollRef]);

  /**
   * 「定档」侧签（Push 252 · 业务口径 2026-10-08「不是在表格内 要在表格外部懂吗 延伸出一个小标签」）：
   * 定档任务的标记不落行内、也不进表内 —— 从表格左边缘**向外伸**一颗竖排小签（2 字 · amber-50 底 + amber-700 字；2026-10-08 业务口径定稿「竖着的定档二字、在表格外」）。
   * 表格的横向滚动容器（#task-board-scroll）会把越界内容裁掉，所以侧签画在卡片外的这个相对定位容器里：
   * TaskRow 在定档行的根节点落 data-task-finalized-row，本 effect 量出各定档行相对容器顶部的中心 y，逐个钉在卡片左边界外。
   * （deps 里 tasks / collapsed / viewStage 只用来保证「行变了 → 提交后重量一遍」；量的是 DOM，值来自真实布局。）
   */
  const [finalizedTags, setFinalizedTags] = useState<{ key: string; top: number }[]>([]);
  useLayoutEffect(() => {
    const wrap = boardWrapRef.current;
    if (wrap === null) {
      return;
    }
    const measure = () => {
      const wrapTop = wrap.getBoundingClientRect().top;
      const next: { key: string; top: number }[] = [];
      const rows = wrap.querySelectorAll("[data-task-finalized-row]");
      for (let index = 0; index < rows.length; index += 1) {
        const node = rows[index] as HTMLElement;
        const rect = node.getBoundingClientRect();
        next.push({ key: node.getAttribute("data-task-finalized-row") ?? String(index), top: Math.round(rect.top - wrapTop + rect.height / 2) });
      }
      // 同值不动 state：ResizeObserver 每次量完都回流一次，值没变时避免无谓重渲染（也就不会自激）。
      setFinalizedTags((current) =>
        current.length === next.length && current.every((item, index) => item.key === next[index].key && item.top === next[index].top) ? current : next);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (boardCardRef.current !== null) {
      observer.observe(boardCardRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [tasks, collapsed, viewStage]);

  /**
   * 阶段不在九阶段里的任务（看板「添加 → 临时任务」直接建的空任务）归到「临时任务」组（Push 196 改名，原「未分组」）：
   * 固定在最后一组 —— 与九阶段一样常显（骨架），有任务时组头带完成计数；**Push 197 起组头可点**：
   * 它没有节点 / 模板可挑，点击 = 直接出新建表单（自己填名称），建完直接打开详情抽屉补时间等细节。
   */
  const stageOf = (task: ProjectTask) => (task.stage === "" ? TEMP_TASK_STAGE : task.stage);
  const groups = [...STAGE_ORDER, TEMP_TASK_STAGE]
    .map((stage) => ({
      stage,
      items: tasks.filter((task) => stageOf(task) === stage),
    }))
    .filter((group) => group.items.length > 0 || (skeletonStages?.includes(group.stage) ?? false));
  const stages = groups.map((group) => group.stage);
  const allCollapsed = stages.length > 0 && stages.every((stage) => collapsed[stage] === true);

  return (
    <>
      <div ref={boardWrapRef} data-board-wrap="true" className="relative">
      <div ref={boardCardRef} className="rounded-xl border border-zinc-200 bg-white">
      {/* 列头固定（Push 141 业务反馈「这个标题栏要固定 鼠标移动可以依旧显示」）：表头移出横向滚动容器、自身 sticky 在应用顶栏（64px）之下；
          横向偏移由上方 useEffect 跟随 #task-board-scroll 的 scrollLeft，左右滚动时表头与各列仍对齐。
          Push 201：主标签栏也吸顶 —— 表头让位、叠在主标签栏下面（设计位 top = 顶栏 64 + 主标签栏 59 = 123px）。
          Push 201 补（业务口径「这个中间有条缝可以有办法解决一下吗」）：吸顶条的下边框在带缩放的屏上（Windows 150% 等）
          被按设备像素吸附成 0.67px —— 栏高 59 → 58.67、下沿实际落在 122.67，表头钉 123 就会露 0.33px 缝，
          滚动时白行 / 蓝色徽章从缝里闪过去。改为 top 122px：表头向上多叠 1px、缝被盖死（1x 下多叠的 1px
          正好藏进主标签栏下边框后，视觉不变）；z 20 → 19（低于主标签栏 z-20）：叠压时下边框仍画在表头上，
          边界保持一条实线而不是整条被表头盖掉。 */}
      <div data-board-head="true" className="sticky top-[122px] z-[19] overflow-hidden rounded-t-xl border-b border-zinc-200 bg-zinc-50">
        <div
          ref={headerRowRef}
          className="grid items-center px-5 py-2.5 text-xs font-medium text-zinc-400"
          style={{ gridTemplateColumns: gridTemplate, minWidth: minWidth }}
        >
            {columns.map((column) =>
              column.key === "title" ? (
                <span key={column.key} data-column={column.key} className="flex min-w-0 items-center gap-2.5">
                  <span className="truncate">{column.header ?? fieldText(locale, column.label)}</span>
                  <button
                    type="button"
                    onClick={onToggleAllStages}
                    disabled={stages.length === 0}
                    aria-label={allCollapsed ? t("board.allExpandStages") : t("board.allCollapseStages")}
                    title={allCollapsed ? t("board.allExpandStages") : t("board.allCollapseStages")}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="h-3 w-3">
                      {allCollapsed ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 6.5 12 11.5l5-5M7 11.5l5 5 5-5" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 11.5 12 6.5l5 5M7 16.5l5-5 5 5" />
                      )}
                    </svg>
                    {allCollapsed ? t("board.allExpand") : t("board.allCollapse")}
                  </button>
                </span>
              ) : (
                <span
                  key={column.key}
                  data-column={column.key}
                  title={column.label === "" ? undefined : fieldText(locale, column.label)}
                  className={"truncate text-center " + (column.headerClass ?? "")}
                >
                  {column.header ?? fieldText(locale, column.label)}
                </span>
              ),
            )}
        </div>
      </div>
      <div id="task-board-scroll" ref={scrollRef} className="overflow-x-auto rounded-b-xl">
        <div style={{ minWidth: minWidth }}>
          {groups.map((group) => {
            const done = group.items.filter((item) => item.status === "已完成" || item.status === "提前完成").length;
            const pct = group.items.length === 0 ? 0 : Math.round((done / group.items.length) * 100);
            const isCollapsed = collapsed[group.stage] === true;
            return (
              <section key={group.stage} className="border-b border-zinc-100 last:border-b-0">
                {/* 阶段分组头（业务口径 2026-09-24）：整行不再是点击区域 —— 只有左侧「折叠箭头 + 阶段标签」这一小片可点，
                    右边那一段空行点不动（原来整行是 role=button 的折叠开关，点在空白处也会折叠，容易被误触）。 */}
                <div data-stage-header={group.stage} className="flex w-full items-center gap-2.5 bg-zinc-100 px-5 py-3">
                  {/* 折叠开关只留这枚箭头（原先点整行也能折叠） */}
                  <button
                    type="button"
                    aria-label={isCollapsed ? t("board.stage.expand") : t("board.stage.collapse")}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? t("board.stage.expand") : t("board.stage.collapse")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleStage(group.stage);
                    }}
                    className="rounded-md p-1 transition hover:bg-zinc-200/70"
                  >
                    <Chevron collapsed={isCollapsed} />
                  </button>
                  {/* 点这个阶段标签 = 开 / 关右侧「任务节点 + 模板」卡片（再点同一个标签就关掉）；
                      「临时任务」没有节点 / 模板可挑（Push 197）：点它 = 直接出新建表单（自己填名称），外观与阶段标签一致。 */}
                  {group.stage === TEMP_TASK_STAGE ? (
                    <button
                      type="button"
                      data-temp-task-pill="true"
                      aria-label={t("board.temp.addAria")}
                      aria-expanded={tempFormOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleTempForm();
                      }}
                      title={t("board.temp.createTitle")}
                      className={
                        "relative inline-flex items-center gap-2 overflow-hidden rounded-lg bg-white px-3 py-1.5 ring-1 transition " +
                        (tempFormOpen ? "ring-2 ring-[#feca04]/70" : "ring-zinc-200 hover:ring-zinc-300")
                      }
                    >
                      <span className="liquid-fill" style={{ height: pct + "%" }} aria-hidden="true" />
                      <span className="relative text-sm font-semibold text-zinc-800">{stageText(locale, group.stage)}</span>
                      {/* 空分组（没有临时任务的项目）：只留组名，不显示 0/0 完成 */}
                      {group.items.length === 0 ? null : (
                        <span className="relative text-xs text-zinc-500">
                          {t("board.stage.done", { done: done, total: group.items.length })}
                        </span>
                      )}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="relative h-3 w-3 text-zinc-400">
                        <path d="M12 5.5v13M5.5 12h13" strokeLinecap="round" />
                      </svg>
                    </button>
                  ) : (
                  <button
                    type="button"
                    data-stage-pill="true"
                    aria-expanded={cardStage === group.stage}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCard(group.stage);
                    }}
                    title={t("board.stage.openCard")}
                    className={
                      "relative inline-flex items-center gap-2 overflow-hidden rounded-lg bg-white px-3 py-1.5 ring-1 transition " +
                      (cardStage === group.stage ? "ring-2 ring-[#feca04]/70" : "ring-zinc-200 hover:ring-zinc-300")
                    }
                  >
                    <span className="liquid-fill" style={{ height: pct + "%" }} aria-hidden="true" />
                    <span className="relative text-sm font-semibold text-zinc-800">{stageText(locale, group.stage)}</span>
                    {/* 空阶段（只出骨架的项目）：只留阶段名，不显示 0/0 完成 */}
                    {group.items.length === 0 ? null : (
                      <span className="relative text-xs text-zinc-500">
                        {t("board.stage.done", { done: done, total: group.items.length })}
                      </span>
                    )}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="relative h-3 w-3 text-zinc-400">
                      <path d="M4 5h16v14H4z" />
                      <path d="M14.5 5v14" />
                    </svg>
                  </button>
                  )}
                </div>
                {isCollapsed ? null : (
                  <div className="divide-y divide-zinc-100">
                    {group.items.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        tierTint={tierTint ?? false}
                        columns={columns}
                        selected={selectedTaskId !== null && selectedTaskId === task.id}
                        onSelect={() => setSelectedTaskId(task.id)}
                        onProgress={(progress) => onSetProgress?.(task.id, progress)}
                        onDelete={
                          onDeleteTask === undefined
                            ? undefined
                            : () => {
                                setSelectedTaskId((current) => (current === task.id ? null : current));
                                onDeleteTask(task.id);
                              }
                        }
                        managers={managers ?? ""}
                        managerIds={managerIds ?? []}
                        members={members}
                        onSetStatus={onSetStatus === undefined ? undefined : (status) => onSetStatus(task.id, status)}
                        onSetActualEnd={onSetActualEnd === undefined ? undefined : (iso) => onSetActualEnd(task.id, iso)}
                        onChangeManagers={onChangeManagers}
                        onPatch={onPatchTask === undefined ? undefined : (patch) => onPatchTask(task.id, patch)}
                        onUploadFiles={onUploadFiles}
                        onDeleteFile={onDeleteFile}
                        files={filesByTask?.get(task.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      </div>
      {/* 「定档」侧签（Push 252）：标签不从行内伸 —— 定档行的侧签挂在表格左边缘外侧（竖排 · 很淡的黄）。
          y 由上面的 effect 量出的行中心给出；横向滚动容器会裁掉越界内容，所以签画在卡片之外这一层。
          2026-10-08 业务口径演进：「不是在表格内 要在表格外部」→「改成定档两个字」→「竖排／横排来回」→ 定稿回到竖排「定档」，
          黄色取更淡的一档（amber-50 底 + amber-200 描边 + amber-700 字）；竖排正好一颗字宽，能整颗待在表格外（不再压进卡片）。 */}
      {finalizedTags.map((tag) => (
        <span
          key={tag.key}
          data-task-finalized-badge="true"
          title={t("board.finalized.title")}
          style={{ top: tag.top, writingMode: "vertical-rl" }}
          className="absolute right-full z-[5] -translate-y-1/2 rounded-l-md border border-r-0 border-amber-200 bg-amber-50 py-1.5 pl-1 pr-0.5 text-[10px] font-bold leading-none tracking-[0.18em] text-amber-700 shadow-[0_1px_2px_rgba(24,24,27,0.12)]"
        >
          {t("drawer.finalize.label")}
        </span>
      ))}
      {tempFormOpen && onCreateTempTask !== undefined ? (
        <div
          ref={tempFormTrapRef}
          role="dialog"
          aria-label={t("board.stage.newAria")}
          style={cardBox === null ? { top: 10, left: 24 } : cardBox}
          className="absolute z-40 w-[280px] max-w-[calc(100vw-3rem)] rounded-2xl border border-white/80 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.98),rgba(255,255,255,0.94))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_12px_40px_rgba(15,23,42,0.22)] backdrop-blur-2xl backdrop-saturate-150"
        >
          <TempTaskCreateForm
            onCreate={async (values) => {
              const createdId = await onCreateTempTask(values);
              if (createdId !== null) {
                setTempFormOpen(false);
                setSelectedTaskId(createdId);
              }
              return createdId;
            }}
            onCancel={() => { setTempFormOpen(false); }}
          />
        </div>
      ) : null}
      {cardStage !== null && (onAddNode !== undefined || onAddNodes !== undefined) ? (
        <StageAddCard
          stage={cardStage}
          addedNodeKeys={addedNodeKeys}
          addedNodeIds={addedNodeIds}
          onAddNode={onAddNode}
          placement={onAddNodes === undefined ? undefined : { tasks: stageTasksOf(cardStage) }}
          onAddNodes={onAddNodes}
          // Push 207 撤（业务口径「临时任务不应该存在于阶段里面新建」）：阶段卡片不再收「临时任务」入口 ——
          // 临时任务的新建仍走本表底部「临时任务」分组头（见下方常驻入口）与看板列底「添加」菜单
          onClose={() => setCardStage(null)}
          style={cardBox === null ? { top: 10, left: 24 } : cardBox}
        />
      ) : null}
      </div>
      <TaskDrawer
        task={drawerTask}
        managers={managers ?? ""}
        managerIds={managerIds ?? []}
        members={members}
        onSubmit={onSubmitTaskEdit}
        onRename={onRenameTask}
        onProgress={onSetProgress}
        onSetStatus={onSetStatus}
        onSetActualEnd={onSetActualEnd}
        onUploadFiles={onUploadFiles}
        onDeleteFile={onDeleteFile}
        onRenameFile={onRenameFile}
        onFinalize={onFinalize}
        onUnfinalize={onUnfinalize}
        onChanged={onChanged}
        actorName={actorName}
        projectId={projectId}
        onClose={closeDrawer}
      />
    </>
  );
}
