import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Member } from "../data/members";
import type { TintedTier } from "../backgroundTier";
import { PROJECT_STAGES } from "../data/projects";
import { PROGRESS_STEPS, TEMP_TASK_STAGE, daysBetweenInclusive, isCompleteStatus, isTaskDone, ownersLabel, type ProjectTask, type TaskStatus } from "../data/tasks";
import { SearchSelect, type SearchSelectItem } from "./MemberSelect";
import { fieldText, mdText, monthShortText, monthYearText, stageText, statusText, textOf, useLocale, useLocalizedTranslator, useT, yearText } from "../i18n";
import type { Locale } from "../i18n";
import { STATUS_DOT_CLASS, TaskRow, resolveColumns, tableGridTemplate, tableMinWidth, type TaskPatch } from "./TaskBoard";

/**
 * 项目详情「甘特图」视图（Push 142，业务口径「我想做甘特图 —— 在标签导航栏加一个甘特图页面」；
 * 第二轮业务口径「维持手绘尽量还原官方的功能」）。
 *
 * 形态与交互参考 VTable 甘特图基本用法（https://visactor.io/vtable/demo/gantt/gantt-basic?version=1.26.6）：
 * 左侧固定任务列表（行号 / 任务 / 开始 / 结束 / 进展）+ 右侧时间轴（月份 + 日期两级表头、逐日网格、周末底纹、
 * 任务条、里程碑菱形、今天虚线）。用 Tailwind + 绝对定位手绘，不引入第三方图表库 ——
 * 本仓库前端目前零图表依赖，而 VTable 的甘特图要真实 Date 记录与自有表格实例，和现有任务数据模型对不上。
 *
 * 已对齐的官方开关（尽量还原官方功能）：
 * - `taskListTable` 左表 + `frame.verticalSplitLineMoveable`：左表横向不滚、右边线可拖（列宽固定，拖的是「右侧时间轴盖住左表多少」的边界，双击复位）；
 * - `grid` / `headerRowHeight`：两级表头（月 + 日）、逐日竖线、周末底纹、每周一与每月一号分隔线；
 * - 滚动条（业务口径「滚动条右边的做出隐式的 下方滚动条要固定」）：原生滚动条隐藏，改自绘 —— 右侧**竖向隐式**
 *   （滚动 / 悬停才浮现，停手 900ms 隐去；与 `ScrollArea` 同一套材质）、下方**横向固定常驻**（有溢出一律可见、可直接拖）；
 * - 拖画面平移（业务口径「向左向右拖动画面要移动」）：在图表空白处按住左键拖动 = 时间轴跟手滑动（横向 / 纵向），
 *   只滚容器、不改任何任务字段；位移没过阈值仍算点击（左表行定位 / 阶段折叠 / 点空白清选中照常）；
 * - `timelineHeader.scales`：时间轴粒度可切日 / 周 / 月（表头分段与网格密度跟着换，条仍按天精确落点）；
 * - 甘特内筛选：按负责人（含「待分配」）、只看已延期、只看未排期（时间轴范围 / 阶段汇总跟着筛完的任务走）；
 * - 任务列表与甘特图同屏（Push 294）：工具条（含筛选栏）常驻；筛选生效（负责人 / 行筛选任一非「全部」）且
 *   **还有没排期的任务**时，甘特图**上方**出「项目页任务表」同款列表（15 列全列 + TaskRow 复用，口径同工作台「我的任务」表；可编辑列照常能改）；
 *   图表本身能画时仍在下方照常渲染 —— 一条排期齐的都没有时只出列表 + 提示条（业务口径「图二筛选后出现图三的情况
 *   直接把图一这样的列表展现」→「有多个行的话有一个已延期设置日期了 其他的还是要显示」+「甘特图也在下方同时显示」+「筛选栏都没有了 是bug」；
 *   Push 313 起「全部」不筛选 = 纯甘特、不出列表 —— 业务口径 2026-10-14「甘特图点击全部的时候不要显示这些列表」）；
 * - 任务列表按阶段分组 + 可折叠（Push 295，业务口径「也要分类可以折叠 在甘特图里」+「要有阶段标题分类的」）：分组口径同左表 / 项目总览
 *   （九阶段顺序 + 「临时任务」垫底 · 只出有任务的分组），分组头 = 阶段标题行（折叠箭头 + 阶段胶囊），只有折叠箭头可点；
 *   折叠状态与左表共用一份（工具栏「全部折叠 / 全部展开」一并收放）。
 * - 拖动时边缘自动滚动（业务口径「拖动进度条要移动 也要可以移画面」）：拖条 / 两端 / 进度圆点时指针进到
 *   时间轴左右边缘 72px 内，画面按深度逐帧滚，条跟着新滚到的日期走；
 * - `taskBar.moveable`：拖条整体平移改期（工期不变）；
 * - `taskBar.resizable`：拖条两端改工期（只动被拖的那一端）；
 * - 进度圆点：拖条上的圆点改进度（按四档吸附，与四格进度条同口径）；
 * - `taskBar.selectable` / `hoverBarStyle`：点条选中（蓝描边）、指针停在条上盖一层半透明遮罩；
 * - `taskBar.labelText: "{title} {progress}%"`：条内写「任务名 + 进度」；
 * - `gantt-locate-taskbar`：点左表任务行 = 选中它并把条定位到时间轴可视区；
 * - `taskBar.{startDateField,endDateField,progressField}`：拖动只写 `startDate` / `dueDate` / `days` / `progress`
 *   这批既有字段（与表格行内编辑同一套换算），松手写回服务端（进度走 /progress、日期走 PATCH）。
 *
 * 其余口径（详见 `前端功能需求.md` §6.14）：
 * - 分组 = 施工阶段（九个阶段按项目总览顺序，空阶段照样出骨架行；非九阶段的任务落「临时任务」垫底 · Push 196）；
 * - 任务条 = 开始日期 → 预计完成日期；条内青色 = 已完成进度（`task.progress`）、橙色 = 剩余工期；
 * - 单日任务（开始 = 预计完成）画菱形 —— 一期没有「是否里程碑」字段（系统功能书 A1-11 在二期），菱形按状态取色：已完成 = 绿色、未完成 = 灰色、已延期 = 红色；
 *   这里按单日派生，字段口径见 `前端功能需求.md` §3.8 A26；
 * - 深色竖线 = 实际完成日期刻度（系统功能书 B3-01「计划条 + 实际完成标注」）；
 * - 已延期 = 条头一段红内嵌色条（B3-05）；今天 = 蓝色虚线（今天落在时间轴范围内时才画）；
 * - 依赖箭头（B3-03）、关键路径（B3-04）、导出（B3-07）不在本期；B3-06 的粒度切换与筛选已在本轮补齐。
 *
 * 布局：左表与时间轴是同一个横向滚动容器里的两块并列面板 —— 左表 `sticky left-0`（横向不滚；列宽固定，
 * 可见宽度 = 分隔线位置，超出的列由右侧时间轴盖住 —— 业务口径「右侧看板是遮挡 不是压缩左侧」）、
 * 表头 `sticky top-0`（纵向吸顶）；两边逐行用同一组行高常量渲染，因此不需要 JS 同步滚动。
 */

/** 九个施工阶段（顺序 = 项目总览的分组顺序；「项目总览」是汇总视图，不作为阶段）。 */
const STAGE_ORDER: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");

/** 阶段不在九阶段里的任务（看板「添加 → 临时任务」建的空任务）→「临时任务」垫底（Push 196 起，原「未分组」；与项目总览最后一组同口径）。 */
const UNGROUPED = TEMP_TASK_STAGE;

/** 甘特图上方任务列表的列（Push 294）= 项目页任务表全列（口径同工作台「我的任务」表：resolveColumns({}) 一个不少）。 */
const FALLBACK_TASK_COLUMNS = resolveColumns({});
const FALLBACK_TASK_GRID = tableGridTemplate(FALLBACK_TASK_COLUMNS);
const FALLBACK_TASK_MIN_W = tableMinWidth(FALLBACK_TASK_COLUMNS);
/** 任务列表不带「项目经理」行内编辑（只读文本）：managerIds 占位同一份空数组（免得每行新建一个）。 */
const NO_MANAGER_IDS: string[] = [];

/**
 * 左表列宽 / 行高：左表与时间轴靠这一组常量逐行对齐。**列宽固定、不随可见宽度变** ——
 * 分隔线是「右侧时间轴盖住左表多少」的边界（业务口径「右侧看板是遮挡 不是压缩左侧」，对齐官方样例：
 * 拖窄了列是被裁掉，不是被挤窄）。「开始日期 / 预计完成日期」两列对齐官方样例左表的 start / end
 * （业务口径「我这个移动也要有这些信息」）：任务行 = 这条任务的开始 / 预计完成日期、阶段行 = 组内任务工期并集，
 * 拖动中的那条跟着预览值走。列宽按列头汉字数定：「预计完成日期」= 6 字 × 11px + 左右各 12px 内边距 = 90px，取 96。
 */
const COL_INDEX_W = 48;
const COL_TITLE_W = 284;
const COL_START_W = 72;
const COL_END_W = 96;
const COL_PROGRESS_W = 72;
/** 「任务」列至少要露出来的宽度：分隔线最窄只遮到这儿。 */
const COL_TITLE_MIN_W = 140;
/** 左表自然宽 = 各列固定宽之和：分隔线拖到最宽 = 各列全露出来（再宽也没东西可露）。 */
const LEFT_W_NATURAL = COL_INDEX_W + COL_TITLE_W + COL_START_W + COL_END_W + COL_PROGRESS_W;
/** 分隔线可拖范围：最窄 = 行号 + 一截任务列，最宽 = 左表自然宽。 */
const LEFT_W_MIN = COL_INDEX_W + COL_TITLE_MIN_W;
const LEFT_W_MAX = LEFT_W_NATURAL;
const LEFT_W_DEFAULT = LEFT_W_NATURAL;
const HEADER_H = 30;
const HEADER_TOTAL_H = HEADER_H * 2;
const ROW_H = 36;

/** 任务条 / 阶段汇总条高度；条两端的热区宽与进度圆点直径（拖拽交互用）。 */
const BAR_H = 20;
const GROUP_BAR_H = 10;
const EDGE_ZONE_W = 6;
const KNOB_SIZE = 10;

/** 拖空白平移画面：位移超过这个像素才算「拖动」（不到 = 还是点击，左表行定位 / 阶段折叠照常）。 */
const PAN_THRESHOLD_PX = 4;

/** 拖任务条时靠近时间轴左右边缘的自动滚动区宽度与逐帧最大速度（px）——条能拖到屏幕外的日期。 */
const DRAG_EDGE_PX = 72;
const DRAG_EDGE_MAX_SPEED = 16;

const DAY_MS = 86400000;

/** 时间轴两端各留的余量（天）。 */
const PAD_DAYS = 2;

/** 条色对齐参考样例：青 = 已完成进度、橙 = 剩余工期。 */
const BAR_DONE_CLASS = "bg-[#7fd1cb]";
const BAR_TODO_CLASS = "bg-[#f7a63c]";

/**
 * 条上不画描边（业务口径「末端 / 两色交接的地方还有橙色的边框」）：参考样例的条是平的，我们之前那圈
 * `ring-amber-600/40` 只压在橙色段上（青色进度是子层、盖住了它），看着就像给橙色块单独镶了个边。
 * 已延期按 B3-05「已延期变红」改成**条头一段红内嵌色条**（App 里「当前阶段」行也是这种内嵌色条），
 * 不再用红描边。色条要画成独立子层并抬到进度层之上 —— 直接给条挂 inset 阴影会被上面的青色进度层盖住。
 * 选中态另见 BAR_SELECTED_CLASS。
 */
const BAR_OVERDUE_STRIPE_CLASS = "pointer-events-none absolute inset-y-0 left-0 z-10 w-[3px] bg-red-500";

/** 选中条的描边（官方 taskBar.selectable 的选中态）。 */
const BAR_SELECTED_CLASS = "ring-2 ring-blue-600 shadow-[0_0_0_2px_rgba(37,99,235,0.25)]";

/** 逐日网格线（1px 线 + 空白，周期 = 每天宽度）；周末底纹块套同一套，免得盖住底下的日线。 */
function dayLineStyle(dayWidth: number): { backgroundImage: string } {
  return { backgroundImage: "repeating-linear-gradient(to right, #f1f2f4 0 1px, transparent 1px " + String(dayWidth) + "px)" };
}

/** 左表「开始 / 结束」单元格：拖动中（预览值）加一档强调，平时与「进展」同色。 */
function dateCellClass(live: boolean): string {
  return "px-3 text-[11px] tabular-nums " + (live ? "font-medium text-zinc-900" : "text-zinc-500");
}

/**
 * 「液态玻璃」材质（业务口径「改成同款液体玻璃」）：与首页分类筛选侧栏 / 任务表行内编辑单元格同一套 ——
 * 白底（半透明）+ 发丝描边 + 顶部内高光 + 极轻投影 + 背景虚化；工具条里的胶囊按钮（含负责人搜索下拉的触发器）用它。
 * 只换材质：圆角 / 内边距 / 字号与配色口径（青橙条色、状态色）一律不动。
 */
const GLASS_SURFACE =
  "border-zinc-200/90 bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-[3px] hover:border-zinc-300 hover:bg-white hover:shadow-[0_2px_6px_rgba(15,23,42,0.08)]";

/** 分段控件（粒度 / 缩放 / 行筛选）的轨道：与胶囊同一材质，但不带 hover 反馈 —— 悬停反馈留给里面的分段按钮。 */
const GLASS_TRACK = "border-zinc-200/90 bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-[3px]";

const ZOOM_LEVELS: ReadonlyArray<{ key: "compact" | "standard" | "wide"; label: string }> = [
  { key: "compact", label: "紧凑" },
  { key: "standard", label: "标准" },
  { key: "wide", label: "宽松" },
];

type ZoomKey = (typeof ZOOM_LEVELS)[number]["key"];

/**
 * 时间轴粒度（官方 `timelineHeader.scales`：日 / 周 / 月）—— 切的是**表头与网格的最小单位**，
 * 不是条的位置口径：几何基准始终是「每天多少 px」，所以三档缩放对每一档粒度都成立，
 * 任务条 / 里程碑 / 实际完成刻度 / 今天线一律按天精确落点（换粒度只变表头分段、列宽与网格密度）。
 * unitDays = 一列跨几天（月粒度按当月真实天数展开，所以月列宽 28~31 天不等）；
 * 列宽 = unitDays × dayWidth（标准档：日 26px、周 91px、月约 138px）。
 */
type ScaleKey = "day" | "week" | "month";

const SCALES: Record<ScaleKey, { label: string; unitDays: number; dayWidth: Record<ZoomKey, number> }> = {
  day: { label: "日", unitDays: 1, dayWidth: { compact: 18, standard: 26, wide: 36 } },
  week: { label: "周", unitDays: 7, dayWidth: { compact: 9, standard: 13, wide: 18 } },
  month: { label: "月", unitDays: 30, dayWidth: { compact: 3.2, standard: 4.6, wide: 6.4 } },
};

const SCALE_KEYS: readonly ScaleKey[] = ["day", "week", "month"];

/** 甘特内筛选（B3-06 余下）：负责人 + 行筛选（全部 / 只看已延期 / 只看未排期）。 */
type RowFilterKey = "all" | "overdue" | "unscheduled";

const ROW_FILTERS: ReadonlyArray<{ key: RowFilterKey; label: string; hint: string }> = [
  { key: "all", label: "全部", hint: "不按行筛（只看负责人）" },
  { key: "overdue", label: "只看已延期", hint: "只出状态为「已延期」的任务（同 B3-05 的口径）" },
  { key: "unscheduled", label: "只看未排期", hint: "只出没填齐「开始 + 预计完成」的任务" },
];

/** 负责人筛选项：`all` = 不限；`__none__` = 待分配（与看板「待分配」列同口径）。 */
const OWNER_ANY = "all";
const OWNER_NONE = "__none__";

/**
 * 任务日期域（M3-07 刀 1 后半）：任务日期一律 ISO（YYYY-MM-DD，契约 DateOnly），年份带着走 ——
 * 原「演示模型固定按 2026 解释、拖动不许跨年」的夹取口径随「M月D日」演示模型一起下线，拖动不再有年份边界。
 */

/** 自绘滚动条：轨道两端留白、滑块最短长度（与 `ScrollArea` 同一套手感）。 */
const BAR_TRACK_INSET = 4;
const BAR_MIN_THUMB = 28;
/** 隐式滚动条停手后隐去的延时（与 `ScrollArea` 一致）。 */
const BAR_HIDE_DELAY = 900;

/**
 * 自绘滑块的几何：`track` = 轨道长度（竖向 = 容器高；横向那条固定在窗口底部，轨道 = 整个窗口宽）、
 * `viewport` = 可视长度、`content` = 内容长度、`scrolled` = 已滚距离；没有溢出 = null。
 */
function thumbMetrics(track: number, viewport: number, content: number, scrolled: number): { size: number; offset: number; progress: number } | null {
  const usable = track - BAR_TRACK_INSET * 2;
  if (usable <= 0 || content <= viewport + 1) {
    return null;
  }
  const size = Math.max(BAR_MIN_THUMB, Math.round((viewport / content) * usable));
  const maxScroll = content - viewport;
  const ratio = maxScroll <= 0 ? 0 : clampNumber(scrolled / maxScroll, 0, 1);
  return { size, offset: Math.round(ratio * (usable - size)), progress: Math.round(ratio * 100) };
}

/**
 * 横向那条固定在整个窗口底部（业务口径「要固定在全局 不然不方便」）：轨道 = 窗口可视宽。
 * 用 `documentElement.clientWidth` 而不是 `window.innerWidth` —— 后者含页面竖向滚动条的宽度，
 * 会让滑块右端钻到滚动条底下 / 位置算偏。
 */
function bottomBarTrack(): number {
  return document.documentElement.clientWidth;
}

/** 拖到边缘时的逐帧滚动速度：越深入边缘区越快（最低 1px，最高 DRAG_EDGE_MAX_SPEED）。 */
function edgeScrollSpeed(depth: number): number {
  return clampNumber((depth / DRAG_EDGE_PX) * DRAG_EDGE_MAX_SPEED, 1, DRAG_EDGE_MAX_SPEED);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function utcFromIso(iso: string): number {
  return Date.parse(iso + "T00:00:00Z");
}

function shiftDays(utc: number, days: number): number {
  return utc + days * DAY_MS;
}

/** UTC 零点毫秒 →「YYYY-MM-DD」。 */
function isoOf(utc: number): string {
  return new Date(utc).toISOString().slice(0, 10);
}

/** 拖动的落点（写回任务字段）：日期写回 ISO（契约 DateOnly）、天数 = 含首尾（与表格行内编辑同一口径）。 */
function rangePatch(start: number, end: number): TaskPatch {
  const startIso = isoOf(start);
  const endIso = isoOf(end);
  return {
    startDate: startIso,
    dueDate: endIso,
    days: daysBetweenInclusive(startIso, endIso),
  };
}

/** 两个 UTC 零点日期相差的天数。 */
function dayDiff(from: number, to: number): number {
  return Math.round((to - from) / DAY_MS);
}

/** 今天（本地日历日的 UTC 零点）—— 任务日期统一按 UTC 零点换算，两边同一尺度。 */
function localToday(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function weekdayOf(utc: number): number {
  return new Date(utc).getUTCDay();
}

function dayOfMonth(utc: number): number {
  return new Date(utc).getUTCDate();
}

function monthTextOf(locale: Locale, utc: number): string {
  const date = new Date(utc);
  return monthYearText(locale, date.getUTCFullYear(), date.getUTCMonth() + 1);
}

/** 月粒度下排的月份文案（如「5月」—— 年份已经在上一行）。 */
function monthShortTextOf(locale: Locale, utc: number): string {
  return monthShortText(locale, new Date(utc).getUTCMonth() + 1);
}

/** 月粒度上排的年份文案（如「2026年」）。 */
function yearTextOf(locale: Locale, utc: number): string {
  return yearText(locale, new Date(utc).getUTCFullYear());
}

/** 周粒度下周列的文案（该周首日，如「5/18」）。 */
function shortDateTextOf(utc: number): string {
  const date = new Date(utc);
  return String(date.getUTCMonth() + 1) + "/" + String(date.getUTCDate());
}

type GanttBar = {
  task: ProjectTask;
  status: TaskStatus;
  /** 0~100（task.progress 是 0~1 的四档小数）。 */
  percent: number;
  /** 开始 / 预计完成 / 实际完成（UTC 零点毫秒）；日期空串 = null。 */
  start: number | null;
  end: number | null;
  done: number | null;
  /** 单日任务（开始 = 预计完成）= 里程碑。 */
  milestone: boolean;
  /** 悬停提示（多行）。 */
  label: string;
};

type GanttGroup = {
  stage: string;
  bars: GanttBar[];
  /** 组内任务的工期并集（画阶段汇总条）；组内没有「开始 + 预计完成」都齐的任务 = null。 */
  start: number | null;
  end: number | null;
  doneCount: number;
  /** 完成度（已完成 / 组内任务数）—— 与项目总览阶段头的「已完成 N/M」同口径。 */
  percent: number;
};

type GanttRow =
  | { kind: "group"; key: string; no: number; group: GanttGroup }
  | { kind: "task"; key: string; no: number; bar: GanttBar };

/** 表头分段（一段 = 表头里的一列）：days = 跨几天（列宽 = days × 每天宽度）、start = 首日在时间轴里的下标。 */
type GanttHeaderUnit = { key: string; label: string; days: number; start: number };

/** 月份段：多一个短文案（月粒度下排写「5月」，日 / 周粒度的上排写「2026年5月」）。 */
type GanttMonthUnit = GanttHeaderUnit & { short: string };

type GanttModel = {
  rows: GanttRow[];
  /** 时间轴首日（UTC 零点毫秒）与总天数。 */
  rangeStart: number;
  days: number;
  /** 今天在时间轴里的下标（今天不在范围内 = null，不画今天虚线）。 */
  todayIndex: number | null;
  /** 表头分段：月份 / 年份 / 周 —— 粒度决定用哪一套渲染（官方 timelineHeader.scales）。 */
  months: ReadonlyArray<GanttMonthUnit>;
  years: ReadonlyArray<GanttHeaderUnit>;
  weeks: ReadonlyArray<GanttHeaderUnit>;
  /** 周末日下标（列底纹）与每周一 / 每月一号 / 每年一号下标（分隔线）。 */
  weekends: readonly number[];
  weekStarts: readonly number[];
  monthStarts: readonly number[];
  yearStarts: readonly number[];
  /** 所有阶段都折叠（工具条按钮文案用）—— 只算真的出了行的阶段（筛掉的空阶段不算）。 */
  allCollapsed: boolean;
};

/** 拖动会话的四种模式：整体平移 / 只动起点（改工期）/ 只动终点（改工期）/ 只改进度。 */
type GanttDragMode = "move" | "start" | "end" | "progress";

/**
 * 拖动会话（对齐官方 taskBar.moveable / resizable 与进度圆点）：
 * base* = 按下时的原值、start / end / percent = 拖动中的预览值 —— 每次 move 都从 base 重新算（避免逐帧累加误差），
 * 松手才写回任务字段；Esc 或 pointercancel 取消 = 不写回。
 */
type GanttDrag = {
  taskId: string;
  mode: GanttDragMode;
  /** 按下时的指针 clientX 与「每天多少 px」（拖动期间不会变）。 */
  originX: number;
  pxPerDay: number;
  baseStart: number;
  baseEnd: number;
  basePercent: number;
  start: number;
  end: number;
  percent: number;
};

/** 任务 → 甘特条：日期直接吃 ISO（契约 DateOnly，空串 = 未填）。 */
function buildBar(locale: Locale, task: ProjectTask): GanttBar {
  const rawStart = task.startDate === "" ? null : utcFromIso(task.startDate);
  const rawEnd = task.dueDate === "" ? null : utcFromIso(task.dueDate);
  const done = task.doneDate === "" ? null : utcFromIso(task.doneDate);
  // 两个日期都齐才画条（只填一个 = 未排期）；数据反了（开始晚于预计完成）按小 → 大画。
  const start = rawStart === null || rawEnd === null ? null : Math.min(rawStart, rawEnd);
  const end = rawStart === null || rawEnd === null ? null : Math.max(rawStart, rawEnd);
  const status = task.status;
  const percent = Math.max(0, Math.min(100, Math.round(task.progress * 100)));
  const owners = ownersLabel(task.owners);
  /** 悬停提示里的日期按「M月D日」展示（模型里存的是 ISO）。 */
  const dayText = (iso: string): string => (iso === "" ? "—" : mdText(locale, iso));
  const gap = locale === "en" ? " · " : "　";
  const label = [
    task.title + (task.titleEn === "" ? "" : "（" + task.titleEn + "）"),
    textOf(locale, "gantt.tip.start", { date: dayText(task.startDate) }) + gap + textOf(locale, "gantt.tip.due", { date: dayText(task.dueDate) }),
    task.doneDate === "" ? "" : textOf(locale, "gantt.tip.done", { date: dayText(task.doneDate) }),
    textOf(locale, "gantt.tip.progress", { n: percent }) + gap + textOf(locale, "gantt.tip.status", { status: statusText(locale, status) }),
    textOf(locale, "gantt.tip.owners", { names: owners === "" ? textOf(locale, "gantt.owner.none") : owners }),
    textOf(locale, "gantt.tip.dragBar"),
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { task, status, percent, start, end, done, milestone: start !== null && end !== null && start === end, label };
}

/**
 * 建时间轴模型：没有任何「开始 + 预计完成」都齐的任务 = 返回 null（画不出时间轴）。
 * hideEmptyGroups = 正在筛选：阶段行只出真的有命中任务的阶段（筛完不再挂一排空阶段骨架）。
 * includeToday = 「回到今天」把今天并进范围（今天本来就在范围里 = 无影响，见下面的注释）。
 */
function buildModel(
  locale: Locale,
  tasks: readonly ProjectTask[],
  today: number,
  collapsed: Record<string, boolean>,
  hideEmptyGroups: boolean,
  includeToday: boolean,
  viewport?: { start: number; end: number },
): GanttModel | null {
  const bars = tasks.map((task) => buildBar(locale, task));

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    if (bar.start === null || bar.end === null) {
      continue;
    }
    min = Math.min(min, bar.start, bar.end);
    max = Math.max(max, bar.start, bar.end);
  }
  if (min === Number.POSITIVE_INFINITY) {
    return null;
  }
  /*
   * 时间轴范围默认 = 筛选后任务的范围（业务口径「时间轴范围跟着筛完剩下的任务走」）—— 所以筛到一个任务全在过去（或全在将来）
   * 的负责人时，今天会落在范围外。业务口径「为什么筛选后不能选择回到今天」：这时「回到今天」不再置灰，而是把今天并进范围
   * （includeToday）再居中，今天线也跟着画出来；不点就仍是紧致范围（范围一直不变时 includeToday 没有副作用）。
   */
  if (includeToday) {
    min = Math.min(min, today);
    max = Math.max(max, today);
  }

  const rangeStart = Math.min(shiftDays(min, -PAD_DAYS), viewport?.start ?? Number.POSITIVE_INFINITY);
  const rangeEnd = Math.max(shiftDays(max, PAD_DAYS), viewport?.end ?? Number.NEGATIVE_INFINITY);
  const days = dayDiff(rangeStart, rangeEnd) + 1;
  const todayIndex = today >= rangeStart && today <= rangeEnd ? dayDiff(rangeStart, today) : null;

  // 表头三套分段（日 / 周 / 月粒度各取所需）：月份、年份、周 —— 每段记下首日下标与跨的天数，列宽 = 天数 × 每天宽度。
  const months: Array<GanttMonthUnit> = [];
  const years: Array<GanttHeaderUnit> = [];
  const weeks: Array<GanttHeaderUnit> = [];
  const weekends: number[] = [];
  const weekStarts: number[] = [];
  const monthStarts: number[] = [];
  const yearStarts: number[] = [];
  for (let index = 0; index < days; index += 1) {
    const utc = shiftDays(rangeStart, index);
    const weekday = weekdayOf(utc);
    const label = monthTextOf(locale, utc);
    const last = months[months.length - 1];
    if (last !== undefined && last.label === label) {
      last.days += 1;
    } else {
      months.push({ key: "month-" + String(index), label, short: monthShortTextOf(locale, utc), days: 1, start: index });
    }
    const yearLabel = yearTextOf(locale, utc);
    const lastYear = years[years.length - 1];
    if (lastYear !== undefined && lastYear.label === yearLabel) {
      lastYear.days += 1;
    } else {
      years.push({ key: "year-" + String(index), label: yearLabel, days: 1, start: index });
    }
    // 周列：每周一开新列（时间轴两端有 PAD_DAYS 余量，首列 / 末列可能不满一周，不硬凑整周）。
    const lastWeek = weeks[weeks.length - 1];
    if (lastWeek === undefined || weekday === 1) {
      weeks.push({ key: "week-" + String(index), label: shortDateTextOf(utc), days: 1, start: index });
    } else {
      lastWeek.days += 1;
    }
    if (weekday === 0 || weekday === 6) {
      weekends.push(index);
    }
    if (weekday === 1) {
      weekStarts.push(index);
    }
    if (dayOfMonth(utc) === 1) {
      monthStarts.push(index);
      if (new Date(utc).getUTCMonth() === 0) {
        yearStarts.push(index);
      }
    }
  }

  // 分组 = 阶段（九个阶段按项目总览顺序 + 有内容才出现的「临时任务」，与项目总览最后一组同口径）。
  const byStage = new Map<string, GanttBar[]>();
  for (const bar of bars) {
    const stage = STAGE_ORDER.includes(bar.task.stage) ? bar.task.stage : UNGROUPED;
    const list = byStage.get(stage);
    if (list === undefined) {
      byStage.set(stage, [bar]);
    } else {
      list.push(bar);
    }
  }
  const stageNames: string[] = [...STAGE_ORDER];
  if (byStage.has(UNGROUPED)) {
    stageNames.push(UNGROUPED);
  }

  const rows: GanttRow[] = [];
  let no = 0;
  let visibleStages = 0;
  let collapsedCount = 0;
  for (const stage of stageNames) {
    const items = byStage.get(stage) ?? [];
    if (hideEmptyGroups && items.length === 0) {
      continue;
    }
    visibleStages += 1;
    let start: number | null = null;
    let end: number | null = null;
    for (const bar of items) {
      if (bar.start === null || bar.end === null) {
        continue;
      }
      start = start === null ? bar.start : Math.min(start, bar.start);
      end = end === null ? bar.end : Math.max(end, bar.end);
    }
    const doneCount = items.filter((bar) => isTaskDone(bar.task)).length;
    const percent = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);
    const isCollapsed = collapsed[stage] === true;
    // 行号：阶段行也占一个号（与参考样例的行号列一致）。
    no += 1;
    if (isCollapsed) {
      collapsedCount += 1;
    }
    rows.push({ kind: "group", key: "stage:" + stage, no, group: { stage, bars: items, start, end, doneCount, percent } });
    if (isCollapsed) {
      continue;
    }
    for (const bar of items) {
      no += 1;
      rows.push({ kind: "task", key: "task:" + bar.task.id, no, bar });
    }
  }

  return {
    rows,
    rangeStart,
    days,
    todayIndex,
    months,
    years,
    weeks,
    weekends,
    weekStarts,
    monthStarts,
    yearStarts,
    allCollapsed: visibleStages > 0 && collapsedCount === visibleStages,
  };
}

/** 工具条「回到今天」：把横向滚动位置挪到今天附近（今天落在时间轴**可视区**左 1/3 处；今天不在时间轴内 = 不动 ——
 * 那种情况下调用方（goToToday）会先把今天并进时间轴范围，再调这里）。
 * 打开视图时不自动滚动 —— 时间轴默认停在项目最早的任务那头（同参考样例），今天的虚线用这个按钮一键回位。
 * 左表 sticky 压着滚动容器左沿，可视的时间轴宽度与位置都要扣掉左表宽度。 */
function centerOnToday(element: HTMLDivElement | null, todayLeft: number | null, leftWidth: number): void {
  if (element === null || todayLeft === null) {
    return;
  }
  // 左表 sticky 压在容器左沿：可视的时间轴宽度要扣掉左表；时间轴面板自己的坐标系从 0 开始，所以只扣宽度、不再减偏移。
  const visible = Math.max(element.clientWidth - leftWidth, 0);
  element.scrollLeft = Math.max(0, todayLeft - visible / 3);
}

/**
 * 甘特图视图（项目详情第二个标签页）。数据 = 项目任务列表同一份（服务端任务接口）；
 * 传了 onPatchTask / onSetProgress 就能拖动改期 / 改进度（不传 = 拖动照常预览、松手不写回）。
 * members = 人员目录（负责人筛选项的成员行渲染）。
 */
export function GanttChart({ tasks, members, managers = "", tierTint = false, onPatchTask, onSetProgress }: { tasks: readonly ProjectTask[]; members: readonly Member[]; /** 项目经理展示文本（项目级；空态兜底列表的「项目经理」列用，同项目页任务表）。 */ managers?: string; /** 背景档位（适中 / 炫彩；空态兜底列表的行色与项目页任务行的铺色同口径，Push 294）。 */ tierTint?: TintedTier | false; onPatchTask?: (taskId: string, patch: TaskPatch) => void; onSetProgress?: (taskId: string, progress: number) => void }) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  /** 手打内容（任务名）机翻显示：英文界面 titleEn 优先 → 机翻 → 原文；中文界面照旧。 */
  const ganttTitle = (task: ProjectTask): string => (locale === "en" ? (task.titleEn !== "" ? task.titleEn : localize(task.title)) : task.title);
  const t = useT();
  const today = useMemo(localToday, []);
  const [zoom, setZoom] = useState<ZoomKey>("standard");
  /** 时间轴粒度（官方 timelineHeader.scales：日 / 周 / 月）—— 只换表头与网格密度，条仍按天精确落点。 */
  const [scale, setScale] = useState<ScaleKey>("day");
  /** 甘特内筛选（B3-06 余下）：负责人（含「待分配」）+ 行筛选（全部 / 只看已延期 / 只看未排期）。 */
  const [ownerFilter, setOwnerFilter] = useState<string>(OWNER_ANY);
  const [rowFilter, setRowFilter] = useState<RowFilterKey>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** 悬停行（左表与时间轴同一行一起高亮）。 */
  const [hovered, setHovered] = useState<string | null>(null);
  /** 悬停的任务条（官方 hoverBarStyle：指针真的落在条上才给条盖一层遮罩）。 */
  const [hoveredBar, setHoveredBar] = useState<string | null>(null);
  /** 选中的任务条（官方 taskBar.selectable）：点条选中、点空白 / Esc 取消。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 拖动会话：预览值挂在 state 上，松手才写回任务字段。 */
  const [drag, setDrag] = useState<GanttDrag | null>(null);
  /** 「回到今天」把今天并进时间轴范围（今天本来就在范围里 = 无影响）；清空筛选时收回。 */
  const [includeToday, setIncludeToday] = useState(false);
  /** 刚点「回到今天」但当时今天不在范围里：等范围延出来（todayLeft 有值）再居中一次。 */
  const [pendingToday, setPendingToday] = useState(false);
  /** 左表宽度（官方 frame.verticalSplitLineMoveable：拖左表右边线改宽窄），双击复位默认宽。 */
  const [leftWidth, setLeftWidth] = useState(LEFT_W_DEFAULT);
  const [splitHover, setSplitHover] = useState(false);
  const [splitActive, setSplitActive] = useState(false);
  /** 拖空白平移画面：拖动期间换抓手光标并禁掉文字选区。 */
  const [panActive, setPanActive] = useState(false);
  /** 自绘滚动条的两根滑块（null = 该方向没有溢出）；竖向隐式、横向固定常驻。 */
  const [vBar, setVBar] = useState<{ size: number; offset: number; progress: number } | null>(null);
  const [hBar, setHBar] = useState<{ size: number; offset: number; progress: number } | null>(null);
  const [barActive, setBarActive] = useState(false);
  const barHideTimerRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<{ originX: number; base: number } | null>(null);
  const panRef = useRef<{ pointerId: number; originX: number; originY: number; baseLeft: number; baseTop: number; moved: boolean } | null>(null);
  /** 平移收尾那一下补出来的 click：挡在容器捕获层（见 swallowClickAfterPan）。 */
  const panJustEndedRef = useRef(false);
  /** 拖条期间的指针位置与「按下时画面滚到哪儿了」：边缘自动滚动要靠它把滚动换算成日期位移。 */
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const dragScrollBaseRef = useRef(0);
  /** 刚拖完那一下（拖动收尾浏览器会补一个 click）：用来挡掉「拖完顺手把选中清掉」。 */
  const justDraggedRef = useRef(false);

  const scaleConfig = SCALES[scale];
  const dayWidth = scaleConfig.dayWidth[zoom];
  /** 粒度 / 缩放 / 行筛选的显示名（Push 301 词典；模块常量只留 key）。 */
  const scaleText = (key: ScaleKey): string => t(key === "day" ? "gantt.scale.day" : key === "week" ? "gantt.scale.week" : "gantt.scale.month");
  const densityText = (key: ZoomKey): string => t(key === "compact" ? "gantt.density.compact" : key === "standard" ? "gantt.density.standard" : "gantt.density.wide");
  const rowFilterText = (key: RowFilterKey): string => t(key === "all" ? "gantt.rowFilter.all" : key === "overdue" ? "gantt.rowFilter.overdue" : "gantt.rowFilter.unscheduled");
  const rowFilterHint = (key: RowFilterKey): string => t(key === "all" ? "gantt.rowFilter.all.hint" : key === "overdue" ? "gantt.rowFilter.overdue.hint" : "gantt.rowFilter.unscheduled.hint");

  /** 负责人筛选项（M3-07 刀 1 后半）：按任务出现顺序收集**负责人 id**（与看板「负责人按任务出现顺序」同口径）；有「没负责人」的任务才出「待分配」。 */
  const ownerOptions = useMemo(() => {
    const ids: string[] = [];
    let hasUnassigned = false;
    for (const task of tasks) {
      if (task.ownerIds.length === 0) {
        hasUnassigned = true;
        continue;
      }
      for (const ownerId of task.ownerIds) {
        if (!ids.includes(ownerId)) {
          ids.push(ownerId);
        }
      }
    }
    return { ids, hasUnassigned };
  }, [tasks]);

  /**
   * 负责人筛选项（Push 142 / M3-07 刀 1 后半）：全部 → 各负责人 → 待分配。
   * 负责人在人员目录（GET /api/v1/users → 本组件的 members）里的按成员行渲染（头像 + 姓名 + 工号 + 角色）；
   * 对不上的（目录外 / 已停用）退化成普通行 —— 不因为查不到人就把这个筛选项弄丢。
   * 选中值走**负责人 id**（与 visibleTasks 的过滤口径同一套字符串空间）。
   */
  const ownerItems = useMemo<SearchSelectItem[]>(() => {
    const items: SearchSelectItem[] = [{ kind: "plain", value: OWNER_ANY, name: textOf(locale, "gantt.owner.all"), hint: textOf(locale, "gantt.owner.allHint") }];
    for (const ownerId of ownerOptions.ids) {
      const member = members.find((item) => item.id === ownerId);
      items.push(member === undefined ? { kind: "plain", value: ownerId, name: ownerId, hint: fieldText(locale, "负责人") } : { kind: "member", value: ownerId, member });
    }
    if (ownerOptions.hasUnassigned) {
      items.push({ kind: "plain", value: OWNER_NONE, name: textOf(locale, "gantt.owner.none"), hint: textOf(locale, "gantt.owner.noneHint") });
    }
    return items;
  }, [ownerOptions, members, locale]);

  /** 筛选后的任务：时间轴范围、阶段汇总、左表行数全部跟着它走（业务口径「甘特内筛选」）。 */
  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => {
      const matchesOwner =
        ownerFilter === OWNER_ANY
          ? true
          : ownerFilter === OWNER_NONE
            ? task.ownerIds.length === 0
            : task.ownerIds.includes(ownerFilter);
      if (!matchesOwner) {
        return false;
      }
      if (rowFilter === "overdue" && task.status !== "已延期") {
        return false;
      }
      // 未排期 = 没填齐「开始 + 预计完成」（与条、左表日期列同一口径）—— 只看未排期时反过来：排期齐了的都筛掉。
      const scheduled = task.startDate !== "" && task.dueDate !== "";
      if (rowFilter === "unscheduled" && scheduled) {
        return false;
      }
      return true;
    });
  }, [tasks, ownerFilter, rowFilter]);

  const filtering = ownerFilter !== OWNER_ANY || rowFilter !== "all";
  const viewportKey = [ownerFilter, rowFilter, scale, zoom, leftWidth, includeToday].join("|");
  const viewportKeyRef = useRef(viewportKey);
  const model = useMemo(() => {
    const node = scrollRef.current;
    const keepViewport = viewportKeyRef.current === viewportKey;
    viewportKeyRef.current = viewportKey;
    const origin = Number(node?.dataset.liveDateOrigin);
    const previousDayWidth = Number(node?.dataset.liveDateWidth);
    // A short chart may have no scrollbar yet. Retain its visible dates as well,
    // so an earlier remote task cannot clamp the restored horizontal position.
    const viewport = keepViewport && node !== null && Number.isFinite(origin) && previousDayWidth > 0
      ? {
        start: origin + Math.floor(node.scrollLeft / previousDayWidth) * DAY_MS,
        end: origin + Math.ceil((node.scrollLeft + Math.max(0, node.clientWidth - leftWidth)) / previousDayWidth) * DAY_MS,
      }
      : undefined;
    return buildModel(locale, visibleTasks, today, collapsed, filtering, includeToday, viewport);
  }, [visibleTasks, today, collapsed, filtering, includeToday, viewportKey, leftWidth, locale]);
  const weekendSet = useMemo(() => new Set(model === null ? [] : model.weekends), [model]);

  /**
   * 任务列表（Push 294）的分组（Push 295，业务口径「也要分类可以折叠 在甘特图里」+「要有阶段标题分类的」）：
   * 口径同左表 / 项目总览 —— 九个阶段按顺序 + 「临时任务」垫底、只出有任务的分组；
   * 折叠状态与左表共用同一份 `collapsed`（列表箭头 / 左表箭头 / 工具栏「全部折叠 / 全部展开」三处联动）。
   */
  const listGroups = [...STAGE_ORDER, UNGROUPED]
    .map((stage) => ({
      stage,
      items: visibleTasks.filter((task) => (STAGE_ORDER.includes(task.stage) ? task.stage : UNGROUPED) === stage),
    }))
    .filter((group) => group.items.length > 0);
  const listStages = listGroups.map((group) => group.stage);
  const listAllCollapsed = listStages.length > 0 && listStages.every((stage) => collapsed[stage] === true);
  /** 工具栏「全部折叠 / 全部展开」的当前态：能画时间轴看左表阶段集；画不出（model === null）看列表分组。 */
  const allCollapsedNow = model === null ? listAllCollapsed : model.allCollapsed;

  const todayIndex = model === null ? null : model.todayIndex;
  const todayLeft = todayIndex === null ? null : todayIndex * dayWidth + dayWidth / 2;

  /** 周 / 月粒度下排的表头分段（日粒度没有分段 —— 逐日渲染，见下面的表头）。 */
  const headerUnits: ReadonlyArray<GanttHeaderUnit> | null =
    model === null || scale === "day"
      ? null
      : scale === "week"
        ? model.weeks
        : model.months.map((month) => ({ key: month.key, label: month.short, days: month.days, start: month.start }));
  /** 今天落在下排哪一列（周 / 月粒度给整列加一档蓝底；日粒度按当天那格，见下）。 */
  const todayUnitIndex =
    todayIndex === null || headerUnits === null
      ? null
      : headerUnits.findIndex((unit) => todayIndex >= unit.start && todayIndex < unit.start + unit.days);

  /** 「回到今天」点了之后范围才延到今天：等 todayLeft 有值再居中一次（范围没变 / 没这个挂起标记时什么都不做）。 */
  useEffect(() => {
    if (!pendingToday || todayLeft === null) {
      return;
    }
    centerOnToday(scrollRef.current, todayLeft, leftWidth);
    setPendingToday(false);
  }, [pendingToday, todayLeft, leftWidth]);

  /** Esc = 取消拖动（不写回、回到原日期）并清掉选中。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setDrag(null);
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const toggleStage = (stage: string) => {
    setCollapsed((previous) => ({ ...previous, [stage]: previous[stage] !== true }));
  };

  /** 清空甘特内筛选（负责人回到「全部」、行筛选回到「全部」），并把「回到今天」延出来的范围收回去。 */
  const clearFilters = () => {
    setOwnerFilter(OWNER_ANY);
    setRowFilter("all");
    setIncludeToday(false);
  };

  /**
   * 「回到今天」（业务口径「为什么筛选后不能选择回到今天」）：今天已在时间轴范围内 = 直接居中；
   * 今天在范围外（筛掉今天附近的任务后范围跟着剩下的任务走）= 先把今天并进范围，范围延出来后再居中一次。
   * 所以这个按钮只在「画不出时间轴」（没有排期齐的任务）时才置灰。
   */
  const goToToday = () => {
    if (todayIndex === null) {
      setIncludeToday(true);
      setPendingToday(true);
      return;
    }
    centerOnToday(scrollRef.current, todayLeft, leftWidth);
  };

  const toggleAll = () => {
    if (allCollapsedNow) {
      setCollapsed({});
      return;
    }
    /*
     * 画不出时间轴（model === null）：这枚按钮管的是任务列表的分组（Push 295，原先在空态下是空操作）；
     * 能画时照旧收左表全部阶段行 —— 列表分组是左表阶段集的子集，两边一起收。
     */
    const next: Record<string, boolean> = {};
    if (model === null) {
      for (const stage of listStages) {
        next[stage] = true;
      }
    } else {
      for (const row of model.rows) {
        if (row.kind === "group") {
          next[row.group.stage] = true;
        }
      }
    }
    setCollapsed(next);
  };

  /**
   * 按下任务条（官方 taskBar.moveable / resizable / 进度圆点）：按按下的是哪一块决定这一拖改什么 ——
   * 条上圆点 = 改进度，条两端 6px = 改那一端的日期（改工期），其余 = 整条平移（工期不变）。
   * 三种都只先改预览值，松手才写回；指针捕获失败也不影响（move / up 挂在条自己身上）。
   */
  const beginDrag = (event: ReactPointerEvent<HTMLElement>, bar: GanttBar, mode: GanttDragMode) => {
    if (bar.start === null || bar.end === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // 清掉页面里残留的选区：命中浮标文字时浏览器会把我们画的深色浮标高亮成蓝底白字。
    window.getSelection()?.removeAllRanges();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败 = 指针移出条之后收不到 move；条内拖动照常。
    }
    setSelectedId(bar.task.id);
    justDraggedRef.current = false;
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    dragScrollBaseRef.current = scrollRef.current === null ? 0 : scrollRef.current.scrollLeft;
    setDrag({
      taskId: bar.task.id,
      mode,
      originX: event.clientX,
      pxPerDay: dayWidth,
      baseStart: bar.start,
      baseEnd: bar.end,
      basePercent: bar.percent,
      start: bar.start,
      end: bar.end,
      percent: bar.percent,
    });
  };

  /**
   * 拖动预览的唯一算法：每次都从 base 出发重算（不累加），只按「起点不晚于终点」夹住（日期是 ISO，不再有年份边界）。
   * 入参是**等效 clientX** —— 画面滚了多少 = 指针在日期轴上等效多走多少（边缘自动滚动、拖动途中滚画面都走这条），
   * 条因此始终跟着指针，也才可能一次拖到当前屏幕外的日期。
   */
  const applyDrag = (clientX: number) => {
    const element = scrollRef.current;
    const scrolled = element === null ? 0 : element.scrollLeft - dragScrollBaseRef.current;
    setDrag((previous) => {
      if (previous === null) {
        return null;
      }
      const deltaDays = Math.round((clientX + scrolled - previous.originX) / previous.pxPerDay);
      if (previous.mode === "progress") {
        // 进度圆点：条宽（含首尾）= 100%，按四档吸附（0 / 25 / 50 / 75 / 100），与四格进度条同口径。
        const widthDays = dayDiff(previous.baseStart, previous.baseEnd) + 1;
        const step = Math.round(clampNumber(previous.basePercent + (deltaDays * 100) / widthDays, 0, 100) / (100 / PROGRESS_STEPS));
        return { ...previous, percent: clampNumber((step * 100) / PROGRESS_STEPS, 0, 100) };
      }
      if (previous.mode === "start") {
        // 只动起点：不许越过终点（单日任务拖左端仍是单日）。
        return { ...previous, start: Math.min(shiftDays(previous.baseStart, deltaDays), previous.baseEnd), end: previous.baseEnd };
      }
      if (previous.mode === "end") {
        // 只动终点：不许越过起点。
        return { ...previous, start: previous.baseStart, end: Math.max(shiftDays(previous.baseEnd, deltaDays), previous.baseStart) };
      }
      // 整条平移：工期不变，两端一起挪。
      const span = dayDiff(previous.baseStart, previous.baseEnd);
      const start = shiftDays(previous.baseStart, deltaDays);
      return { ...previous, start, end: shiftDays(start, span) };
    });
  };

  /** 条上的 pointermove：先记住指针位置（边缘自动滚动要用），再交给同一套算法。 */
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    applyDrag(event.clientX);
  };

  /**
   * 拖条时的边缘自动滚动（业务口径「拖动进度条要移动 也要可以移画面」）：指针停在时间轴左右边缘区内时，
   * 按进入深度逐帧滚容器，并让条跟着新滚到的位置重算日期 —— 一次拖动能把条放到当前屏幕外的日期上；
   * 指针停着不动也照样滚。循环只在拖动期间存在（松手 / Esc / pointercancel 即停）。
   */
  const barDragging = drag !== null;
  useEffect(() => {
    if (!barDragging) {
      return undefined;
    }
    let raf = window.requestAnimationFrame(function tick() {
      raf = window.requestAnimationFrame(tick);
      const element = scrollRef.current;
      const pointer = dragPointerRef.current;
      if (element === null || pointer === null) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const before = element.scrollLeft;
      if (pointer.x < rect.left + DRAG_EDGE_PX) {
        element.scrollLeft = before - edgeScrollSpeed(rect.left + DRAG_EDGE_PX - pointer.x);
      } else if (pointer.x > rect.right - DRAG_EDGE_PX) {
        element.scrollLeft = before + edgeScrollSpeed(pointer.x - (rect.right - DRAG_EDGE_PX));
      }
      if (element.scrollLeft !== before) {
        applyDrag(pointer.x);
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [barDragging]);

  /** 松手写回：进度走 onSetProgress（与四格进度条同一套状态联动）、日期走 onPatchTask；没动过 = 不写。 */
  const endDrag = () => {
    const session = drag;
    if (session === null) {
      return;
    }
    setDrag(null);
    dragPointerRef.current = null;
    if (session.mode === "progress") {
      if (session.percent === session.basePercent) {
        return;
      }
      justDraggedRef.current = true;
      onSetProgress?.(session.taskId, session.percent / 100);
      return;
    }
    if (session.start === session.baseStart && session.end === session.baseEnd) {
      return;
    }
    justDraggedRef.current = true;
    onPatchTask?.(session.taskId, rangePatch(session.start, session.end));
  };

  /** 拖左表右边线改左表宽度（官方 frame.verticalSplitLineMoveable）；双击复位默认宽。 */
  const beginSplit = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败也不影响：拖动期间 window 上还有一层兜底监听（见下面的 useEffect）。
    }
    splitRef.current = { originX: event.clientX, base: leftWidth };
    setSplitActive(true);
  };

  /** 分隔线拖动的唯一算法：从按下时的 base 出发按位移重算（不累加）。 */
  const applySplit = (clientX: number) => {
    const session = splitRef.current;
    if (session === null) {
      return;
    }
    setLeftWidth(clampNumber(session.base + (clientX - session.originX), LEFT_W_MIN, LEFT_W_MAX));
  };

  const moveSplit = (event: ReactPointerEvent<HTMLSpanElement>) => {
    applySplit(event.clientX);
  };

  const endSplit = () => {
    splitRef.current = null;
    setSplitActive(false);
  };

  /**
   * 拖画面平移（业务口径「向左向右拖动画面要移动」）：在图表空白处按住拖动 = 时间轴跟手滑（横向 / 纵向），
   * 只滚外层容器、不改任何任务字段。任务条与分隔线自己 stopPropagation，从条上 / 线上按下仍是原来那几种拖动；
   * 位移没过阈值就当成点击（左表行定位、阶段折叠、点空白清选中都不受影响）。只认鼠标左键 —— 触屏本来就能拖。
   */
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    panJustEndedRef.current = false;
    const element = scrollRef.current;
    if (element === null || event.pointerType === "touch" || event.button !== 0) {
      return;
    }
    panRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      baseLeft: element.scrollLeft,
      baseTop: element.scrollTop,
      moved: false,
    };
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = panRef.current;
    const element = scrollRef.current;
    if (session === null || element === null || session.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - session.originX;
    const dy = event.clientY - session.originY;
    if (!session.moved) {
      if (Math.abs(dx) < PAN_THRESHOLD_PX && Math.abs(dy) < PAN_THRESHOLD_PX) {
        return;
      }
      session.moved = true;
      // 拖动途中浏览器可能已经开始拉选区（与任务条拖动同一口径：先清掉再跟手）。
      window.getSelection()?.removeAllRanges();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 捕获失败只影响「指针移出容器后是否继续跟手」，容器内拖动照常。
      }
      setPanActive(true);
    }
    element.scrollLeft = session.baseLeft - dx;
    element.scrollTop = session.baseTop - dy;
  };

  const endPan = () => {
    const session = panRef.current;
    panRef.current = null;
    if (session === null || !session.moved) {
      return;
    }
    panJustEndedRef.current = true;
    setPanActive(false);
  };

  /** 平移收尾补的那一下 click 在捕获层吃掉：不落到左表行定位 / 阶段折叠 / 点空白清选中上。 */
  const swallowClickAfterPan = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panJustEndedRef.current) {
      return;
    }
    panJustEndedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  /** 重新量两根滑块（尺寸 / 位置 / 进度）——与 `ScrollArea` 同一套算法，只是两个方向一起维护。 */
  const syncScrollbars = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) {
      return;
    }
    setVBar(thumbMetrics(node.clientHeight, node.clientHeight, node.scrollHeight, node.scrollTop));
    setHBar(thumbMetrics(bottomBarTrack(), node.clientWidth, node.scrollWidth, node.scrollLeft));
  }, []);

  /** 竖向滑块是隐式的：滚动 / 拖它的时候浮现，停手 900ms 隐去（横向固定常驻，不走这条）。 */
  const revealScrollbars = useCallback(() => {
    setBarActive(true);
    window.clearTimeout(barHideTimerRef.current);
    barHideTimerRef.current = window.setTimeout(() => {
      setBarActive(false);
    }, BAR_HIDE_DELAY);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) {
      return undefined;
    }
    syncScrollbars();
    const onScroll = () => {
      syncScrollbars();
      revealScrollbars();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", syncScrollbars);
    const observer = new ResizeObserver(syncScrollbars);
    observer.observe(node);
    for (const child of Array.from(node.children)) {
      observer.observe(child);
    }
    return () => {
      node.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", syncScrollbars);
      observer.disconnect();
      window.clearTimeout(barHideTimerRef.current);
    };
  }, [revealScrollbars, syncScrollbars]);

  /** 拖滑块 = 滚容器（两根共用；`size` = 该方向滑块长度，用来把拖动距离换算成滚动距离）。 */
  const beginScrollbarDrag = (event: ReactPointerEvent<HTMLDivElement>, orientation: "horizontal" | "vertical", size: number, track: number) => {
    const node = scrollRef.current;
    if (node === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const thumbNode = event.currentTarget;
    try {
      thumbNode.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败只影响「指针移出滑块后是否继续跟手」，滑块内拖动照常。
    }
    const horizontal = orientation === "horizontal";
    const startPointer = horizontal ? event.clientX : event.clientY;
    const startScroll = horizontal ? node.scrollLeft : node.scrollTop;
    const usable = track - BAR_TRACK_INSET * 2;
    const maxScroll = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
    const distance = maxScroll / Math.max(1, usable - size);
    window.clearTimeout(barHideTimerRef.current);
    setBarActive(true);
    const onMove = (moveEvent: PointerEvent) => {
      const delta = (horizontal ? moveEvent.clientX : moveEvent.clientY) - startPointer;
      if (horizontal) {
        node.scrollLeft = startScroll + delta * distance;
      } else {
        node.scrollTop = startScroll + delta * distance;
      }
    };
    const onUp = () => {
      thumbNode.removeEventListener("pointermove", onMove);
      thumbNode.removeEventListener("pointerup", onUp);
      thumbNode.removeEventListener("pointercancel", onUp);
      revealScrollbars();
    };
    thumbNode.addEventListener("pointermove", onMove);
    thumbNode.addEventListener("pointerup", onUp);
    thumbNode.addEventListener("pointercancel", onUp);
  };

  /**
   * 指针捕获可能失效（无头调试、指针被拖出窗口、浏览器丢弃捕获）：拖动期间再在 window 上挂一层兜底，
   * 与把手自身的 pointermove 用同一套算法（同一个坐标重复触发是幂等的），保证拖到哪儿都跟手。
   */
  useEffect(() => {
    if (!splitActive) {
      return undefined;
    }
    const onMove = (event: PointerEvent) => {
      applySplit(event.clientX);
    };
    const onUp = () => {
      endSplit();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [splitActive]);

  // 空态 ①：项目一个任务都没有（同看板口径 —— 到「项目总览」加任务）。
  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center text-sm text-zinc-500">
        {t("gantt.empty.project")}
      </div>
    );
  }

  /**
   * 任务列表（业务口径 2026-10-13「图二筛选后出现图三的情况直接把图一这样的列表展现」→ 同日追订
   * 「有多个行的话有一个已延期设置日期了 其他的还是要显示」+「甘特图也在下方同时显示」+「只看未排期上分的甘特图筛选栏都没有了 是bug」）：
   * 筛选后**还有没排期的任务**就出这张表（15 列全列 + TaskRow 复用，口径同工作台「我的任务」表）；
   * 位置在甘特图**上方** —— 图表本身能画时仍在下方照常渲染，列表与甘特同屏，补日期不用离开这一屏。
   * 工具条（含筛选栏）常驻；只有「项目一个任务都没有」才整屏换空态（空态 ①，提前返回）。
   * Push 295：列表按阶段分组（口径同项目总览：九阶段顺序 +「临时任务」垫底、只出有任务的分组），
   * 分组头 = 折叠箭头 + 阶段胶囊（已完成 done/总数 + 完成率液面）；折叠状态与左表共用。
   * Push 313（业务口径 2026-10-14「甘特图点击全部的时候不要显示这些列表」）：**能画图时列表只在筛选生效
   * （负责人 / 行筛选任一非「全部」）后出现** —— 「全部」不筛选 = 纯甘特；画不出时间轴的早退分支
   * （model === null：整个筛选结果没有排期齐的任务）不受影响，仍出提示条 + 列表（此时列表是唯一工作内容）。
   */
  const hasUnscheduled = visibleTasks.some((task) => task.startDate === "" || task.dueDate === "");
  const taskListBlock = (
    <div data-gantt-task-list="true" className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="overflow-x-auto">
        <div style={{ minWidth: FALLBACK_TASK_MIN_W }}>
          <div
            className="grid items-center border-b border-zinc-200 bg-zinc-50 px-5 py-2.5 text-xs font-medium text-zinc-400"
            style={{ gridTemplateColumns: FALLBACK_TASK_GRID, minWidth: FALLBACK_TASK_MIN_W }}
          >
            {FALLBACK_TASK_COLUMNS.map((column) =>
              column.key === "title" ? (
                <span key={column.key} data-column={column.key} className="truncate">
                  {fieldText(locale, column.label)}
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
          {listGroups.map((group) => {
            const done = group.items.filter((task) => isTaskDone(task)).length;
            const pct = Math.round((done / group.items.length) * 100);
            const isCollapsed = collapsed[group.stage] === true;
            return (
              <section key={group.stage} className="border-b border-zinc-100 last:border-b-0">
                {/* 阶段标题分组头（Push 295）：外观口径同项目总览 —— 只有左边「折叠箭头」可点；这里没有节点 / 模板卡片，
                    阶段胶囊静态展示（阶段名 + 已完成 done/总数 + 完成率液面；完成数取 isTaskDone，与左表阶段行同一口径）。 */}
                <div data-gantt-list-stage={group.stage} className="flex w-full items-center gap-2.5 bg-zinc-100 px-5 py-3">
                  <button
                    type="button"
                    aria-label={isCollapsed ? t("board.stage.expand") : t("board.stage.collapse")}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? t("board.stage.expand") : t("board.stage.collapse")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleStage(group.stage);
                    }}
                    className="rounded-md p-1 transition hover:bg-zinc-200/70"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                      className={"h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform " + (isCollapsed ? "" : "rotate-90")}
                    >
                      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="relative inline-flex items-center gap-2 overflow-hidden rounded-lg bg-white px-3 py-1.5 ring-1 ring-zinc-200">
                    <span className="liquid-fill" style={{ height: pct + "%" }} aria-hidden="true" />
                    <span className="relative text-sm font-semibold text-zinc-800">{stageText(locale, group.stage)}</span>
                    <span className="relative text-xs text-zinc-500">
                      {t("board.stage.done", { done: done, total: group.items.length })}
                    </span>
                  </span>
                </div>
                {isCollapsed ? null : (
                  <div className="divide-y divide-zinc-100">
                    {group.items.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        columns={FALLBACK_TASK_COLUMNS}
                        selected={false}
                        tierTint={tierTint}
                        managers={managers}
                        managerIds={NO_MANAGER_IDS}
                        members={members}
                        onProgress={
                          onSetProgress === undefined
                            ? undefined
                            : (progress) => {
                                onSetProgress(task.id, progress);
                              }
                        }
                        onPatch={
                          onPatchTask === undefined
                            ? undefined
                            : (patch) => {
                                onPatchTask(task.id, patch);
                              }
                        }
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
  );

  /** 工具条（常驻，空态 ② / ③ 也在）：图例 + 粒度 / 缩放 / 折叠 / 回到今天 + 甘特内筛选 + 两行操作提示。 */
  const toolbarBlock = (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
          <li className="flex items-center gap-1.5">
            <span className={"h-2.5 w-4 rounded-[3px] " + BAR_DONE_CLASS} aria-hidden="true" />
            {t("gantt.legend.done")}
          </li>
          <li className="flex items-center gap-1.5">
            <span className={"h-2.5 w-4 rounded-[3px] " + BAR_TODO_CLASS} aria-hidden="true" />
            {t("gantt.legend.remaining")}
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-4 rounded-[3px] bg-[#f7a63c] shadow-[inset_3px_0_0_0_#ef4444]" aria-hidden="true" />
            {t("gantt.legend.overdue")}
          </li>
          <li className="flex items-center gap-1.5" title={t("gantt.legend.singleDayHint")}>
            <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-emerald-500 ring-1 ring-emerald-700/60" aria-hidden="true" />
            {t("gantt.legend.singleDay")}
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-3 w-[2px] bg-zinc-900/60" aria-hidden="true" />
            {t("gantt.legend.doneDate")}
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-3 border-l border-dashed border-blue-500" aria-hidden="true" />
            {t("gantt.legend.today")}
          </li>
        </ul>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span className="text-[11px] text-zinc-400">{t("gantt.label.granularity")}</span>
          <div className={"flex items-center gap-0.5 rounded-lg border p-0.5 " + GLASS_TRACK}>
            {SCALE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setScale(key);
                }}
                title={t("gantt.scale.title", { name: scaleText(key) })}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium transition " +
                  (key === scale ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800")
                }
              >
                {scaleText(key)}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-zinc-400">{t("gantt.label.zoom")}</span>
          <div className={"flex items-center gap-0.5 rounded-lg border p-0.5 " + GLASS_TRACK}>
            {ZOOM_LEVELS.map((level) => (
              <button
                key={level.key}
                type="button"
                onClick={() => {
                  setZoom(level.key);
                }}
                title={scale === "month" ? t("gantt.zoom.titleMonth", { n: Math.round(scaleConfig.unitDays * scaleConfig.dayWidth[level.key]) }) : t("gantt.zoom.titleUnit", { unit: locale === "en" ? (scale === "day" ? "day" : "week") : scaleText(scale), n: Math.round(scaleConfig.unitDays * scaleConfig.dayWidth[level.key]) })}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium transition " +
                  (level.key === zoom ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800")
                }
              >
                {densityText(level.key)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleAll}
            className={"rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:text-zinc-900 " + GLASS_SURFACE}
          >
            {allCollapsedNow ? t("gantt.toggle.allExpand") : t("gantt.toggle.allCollapse")}
          </button>
          <button
            type="button"
            onClick={goToToday}
            disabled={model === null}
            title={
              todayIndex === null
                ? t("gantt.today.outOfRange")
                : t("gantt.today.title")
            }
            className={
              "rounded-lg border px-2.5 py-1 text-xs font-medium transition " +
              (model === null
                ? "cursor-not-allowed border-zinc-200/60 bg-white/50 text-zinc-300"
                : GLASS_SURFACE + " text-zinc-600 hover:text-zinc-900")
            }
          >
            {t("gantt.today.button")}
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zinc-100 pt-2">
        <span className="text-[11px] text-zinc-400">{t("gantt.label.filter")}</span>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          {fieldText(locale, "负责人")}
          <SearchSelect
            value={ownerFilter}
            items={ownerItems}
            onChange={(next) => {
              setOwnerFilter(next);
            }}
            ariaLabel={t("gantt.owner.aria")}
            footer={t("gantt.owner.footer", { n: ownerOptions.ids.length })}
            triggerClassName={"flex min-w-[88px] items-center gap-1 rounded-lg border py-1 pl-2 pr-1.5 text-xs text-zinc-600 transition " + GLASS_SURFACE}
          />
        </label>
        <div className={"flex items-center gap-0.5 rounded-lg border p-0.5 " + GLASS_TRACK}>
          {ROW_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setRowFilter(item.key);
              }}
              title={rowFilterHint(item.key)}
              className={
                "rounded-md px-2.5 py-1 text-xs font-medium transition " +
                (item.key === rowFilter ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800")
              }
            >
              {rowFilterText(item.key)}
            </button>
          ))}
        </div>
        {filtering ? (
          <>
            <span className="text-[11px] tabular-nums text-zinc-500">
              {t("gantt.filter.result", { shown: visibleTasks.length, total: tasks.length })}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className={"rounded-lg border px-2 py-1 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-900 " + GLASS_SURFACE}
            >
              {t("gantt.filter.clear")}
            </button>
          </>
        ) : null}
      </div>
      <p className="mt-2 border-t border-zinc-100 pt-2 text-[11px] leading-4 text-zinc-400">
        {t("gantt.hint.barOps")}
      </p>
    </div>
  );

  // 空态 ② / ③：工具条（含筛选栏）常驻 —— ② 筛选到一条不剩出提示卡；③ 画不出时间轴出提示条 + 任务列表
  // （列表与甘特图同屏的口径见 taskListBlock 注释）。此分支不进入下面的图表区 —— 那边的常量 / 闭包按 model 非空写。
  if (model === null) {
    return (
      <div className="space-y-3">
        {toolbarBlock}
        {visibleTasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center text-sm text-zinc-500">
            <p>{t("gantt.empty.filtered", { n: tasks.length })}</p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
            >
              {t("gantt.filter.clear")}
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-xs text-zinc-500">
              {filtering ? (
                <p>{t("gantt.empty.unscheduledFiltered", { n: visibleTasks.length })}</p>
              ) : (
                <p>{t("gantt.empty.unscheduledProject", { n: tasks.length })}</p>
              )}
            </div>
            {taskListBlock}
          </>
        )}
      </div>
    );
  }

  const totalWidth = model.days * dayWidth;

  /** 条几何：左偏移 = 距时间轴首日的天数 × 每天宽度；宽 = 含首尾天数 × 每天宽度（最窄 4px）。 */
  const barBox = (start: number, end: number) => {
    return {
      left: dayDiff(model.rangeStart, start) * dayWidth,
      width: Math.max((dayDiff(start, end) + 1) * dayWidth, 4),
    };
  };

  /** 这一条的当前几何：正在拖的那条用预览值，其余用任务本身的值。 */
  const liveOf = (bar: GanttBar): { start: number; end: number; percent: number; dragging: boolean } => {
    if (drag !== null && drag.taskId === bar.task.id && bar.start !== null && bar.end !== null) {
      return { start: drag.start, end: drag.end, percent: drag.percent, dragging: true };
    }
    return { start: bar.start ?? 0, end: bar.end ?? 0, percent: bar.percent, dragging: false };
  };

  /**
   * 左表「开始 / 结束」两列（对齐官方样例左表的 start / end）：任务行 = 这条任务的日期、
   * 阶段行 = 组内任务工期并集（与阶段汇总条同源）；没排期 =「—」。拖动中的那条取**预览值**
   * （与条、浮标同一套 liveOf），松手才写回 —— 也正因此在条上拖动时这两列会跟着日期一起走。
   */
  const rowDateRange = (row: GanttRow): { start: string; end: string; live: boolean } => {
    if (row.kind === "group") {
      return {
        start: row.group.start === null ? "—" : mdText(locale, isoOf(row.group.start)),
        end: row.group.end === null ? "—" : mdText(locale, isoOf(row.group.end)),
        live: false,
      };
    }
    if (row.bar.start === null || row.bar.end === null) {
      return { start: "—", end: "—", live: false };
    }
    const live = liveOf(row.bar);
    return { start: mdText(locale, isoOf(live.start)), end: mdText(locale, isoOf(live.end)), live: live.dragging };
  };

  /** 点时间轴空白 / 左表空白：清掉选中（拖动收尾补的那一下 click 挡掉，免得刚拖完就取消选中）。 */
  const clearSelection = () => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    setSelectedId(null);
  };

  /**
   * 点左表任务行 = 选中这条 + 把条定位到时间轴可视区中间（官方 gantt-locate-taskbar）：
   * 条已经完整可见就不动（否则点一下就跳一下很晕），被挡住 / 在屏幕外才平滑滚过去。
   */
  const locateBar = (bar: GanttBar) => {
    setSelectedId(bar.task.id);
    const element = scrollRef.current;
    if (element === null || bar.start === null || bar.end === null) {
      return;
    }
    const box = barBox(bar.start, bar.end);
    const viewStart = element.scrollLeft + leftWidth;
    const viewEnd = element.scrollLeft + element.clientWidth;
    if (box.left >= viewStart && box.left + box.width <= viewEnd) {
      return;
    }
    element.scrollTo({ left: Math.max(0, box.left + box.width / 2 - (element.clientWidth - leftWidth) / 2), behavior: "smooth" });
  };

  /** 拖动中的浮标（贴在条上方，行坐标系）：改期 / 改工期写新日期区间与天数，改进度写新百分比。 */
  const dragBubble = (left: number, dragging: boolean) => {
    if (!dragging || drag === null) {
      return null;
    }
    const text =
      drag.mode === "progress"
        ? t("gantt.tip.progress", { n: drag.percent })
        : t("gantt.tip.dragRange", { from: mdText(locale, isoOf(drag.start)), to: mdText(locale, isoOf(drag.end)), n: dayDiff(drag.start, drag.end) + 1 });
    return (
      <span className="pointer-events-none absolute z-40 select-none whitespace-nowrap rounded-md bg-zinc-900/90 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-lg" style={{ left, top: -12 }}>
        {text}
      </span>
    );
  };

  /**
   * 任务条：单日任务 = 菱形（只给整条平移；已完成绿 / 未完成灰 / 已延期红）；其余 = 青色进度 + 橙色剩余 + 实际完成刻度；
   * 悬停 / 拖动时条两端浮出改工期的热区与进度圆点，拖动中的那条上方浮一枚日期（进度）浮标。
   */
  const renderTaskBar = (bar: GanttBar) => {
    if (bar.start === null || bar.end === null) {
      return <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-400">{t("gantt.unscheduled")}</span>;
    }
    const live = liveOf(bar);
    const box = barBox(live.start, live.end);
    const selected = selectedId === bar.task.id;
    const dragging = live.dragging;
    const barHovered = hoveredBar === bar.task.id;
    const showHandles = barHovered || dragging;
    const percent = Math.round(live.percent);
    // 条内标签对齐官方 labelText「{title} {progress}%」：条够宽写全，窄条只写百分比、再窄就不写。
    const barLabel = box.width >= 84 ? ganttTitle(bar.task) + " " + String(percent) + "%" : String(percent) + "%";
    // 实际完成日期刻度（B3-01）：按绝对日期落点，拖出条外就不画（免得贴边误导）。
    const done = bar.done;
    const doneLeft =
      done === null || done < live.start || done > live.end
        ? null
        : clampNumber((dayDiff(live.start, done) + 0.5) * dayWidth - 1, 0, Math.max(box.width - 2, 0));

    if (bar.milestone) {
      const size = 14;
      // 单日任务的菱形按状态取色（业务 2026-09-22）：已完成 / 提前完成 = 绿、未完成 = 灰、已延期 = 红。
      const tone = isCompleteStatus(bar.status)
        ? "bg-emerald-500 ring-emerald-700/60"
        : bar.status === "已延期"
          ? "bg-red-500 ring-red-700/60"
          : "bg-zinc-400 ring-zinc-500/60";
      return (
        <>
          <span
            className={"absolute block touch-none select-none " + (dragging ? "cursor-grabbing" : "cursor-grab")}
            style={{ left: box.left + dayWidth / 2 - size / 2, top: (ROW_H - size) / 2 }}
            title={bar.label}
            onPointerDown={(event) => {
              beginDrag(event, bar, "move");
            }}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onMouseEnter={() => {
              setHoveredBar(bar.task.id);
            }}
            onMouseLeave={() => {
              setHoveredBar(null);
            }}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedId(bar.task.id);
            }}
          >
            <span className={"block rotate-45 rounded-[2px] ring-1 " + tone + " " + (selected ? "shadow-[0_0_0_2px_rgba(37,99,235,0.45)]" : "")} style={{ width: size, height: size }} aria-hidden="true" />
          </span>
          {dragBubble(box.left + dayWidth / 2 - size / 2, dragging)}
        </>
      );
    }

    const overdue = bar.status === "已延期";
    return (
      <>
        <div
          className={
            "absolute flex touch-none select-none items-center overflow-hidden rounded-[4px] " +
            (selected ? BAR_SELECTED_CLASS : " ") +
            " " +
            BAR_TODO_CLASS +
            " " +
            (dragging ? "cursor-grabbing shadow-md" : "cursor-grab")
          }
          style={{ left: box.left, width: box.width, height: BAR_H, top: (ROW_H - BAR_H) / 2 }}
          title={bar.label}
          onPointerDown={(event) => {
            beginDrag(event, bar, "move");
          }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onMouseEnter={() => {
            setHoveredBar(bar.task.id);
          }}
          onMouseLeave={() => {
            setHoveredBar(null);
          }}
          onClick={(event) => {
            event.stopPropagation();
            setSelectedId(bar.task.id);
          }}
        >
          <span className={"absolute inset-y-0 left-0 " + BAR_DONE_CLASS} style={{ width: String(live.percent) + "%" }} aria-hidden="true" />
          {overdue ? <span className={BAR_OVERDUE_STRIPE_CLASS} aria-hidden="true" /> : null}
          {barHovered && !dragging ? <span className="pointer-events-none absolute inset-0 bg-zinc-900/10" aria-hidden="true" /> : null}
          {box.width < 40 ? null : (
            <span className="relative truncate pl-1.5 pr-1 text-[11px] font-semibold text-zinc-900">{barLabel}</span>
          )}
          {doneLeft === null ? null : (
            <span
              className="absolute inset-y-0 w-[2px] bg-zinc-900/60"
              style={{ left: doneLeft }}
              title={t("gantt.tip.done", { date: bar.task.doneDate === "" ? "—" : mdText(locale, bar.task.doneDate) })}
            />
          )}
          {showHandles ? (
            <>
              {/* 拖两端 = 改工期（官方 taskBar.resizable）：热区只在悬停 / 拖动时显形，平时不噪。 */}
              <span
                className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-white/40"
                onPointerDown={(event) => {
                  beginDrag(event, bar, "start");
                }}
              />
              <span
                className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-white/40"
                onPointerDown={(event) => {
                  beginDrag(event, bar, "end");
                }}
              />
            </>
          ) : null}
          {showHandles && box.width >= 60 ? (
            // 进度圆点 = 改进度（四档吸附）；左右各让开 6px，免得压住两端的改工期热区。
            <span
              className="absolute z-30 cursor-ew-resize rounded-full border border-zinc-400 bg-white shadow"
              style={{
                width: KNOB_SIZE,
                height: KNOB_SIZE,
                left: clampNumber((live.percent / 100) * box.width - KNOB_SIZE / 2, EDGE_ZONE_W, Math.max(box.width - KNOB_SIZE - EDGE_ZONE_W, EDGE_ZONE_W)),
                top: (BAR_H - KNOB_SIZE) / 2,
              }}
              title={t("gantt.tip.dragProgress", { n: percent })}
              onPointerDown={(event) => {
                beginDrag(event, bar, "progress");
              }}
            />
          ) : null}
        </div>
        {dragBubble(box.left, dragging)}
      </>
    );
  };

  /** 阶段行：组内任务工期并集的汇总条（比任务条细），进度 = 完成度（已完成 / 组内任务数）。 */
  const renderGroupBar = (group: GanttGroup) => {
    if (group.start === null || group.end === null) {
      return null;
    }
    const box = barBox(group.start, group.end);
    return (
      <div
        className={"absolute rounded-full " + BAR_TODO_CLASS}
        style={{ left: box.left, width: box.width, height: GROUP_BAR_H, top: (ROW_H - GROUP_BAR_H) / 2 }}
        title={t("gantt.groupSpan.tip", { text: String(group.doneCount) + "/" + String(group.bars.length) + " · " + String(group.percent) + "%" })}
      >
        <span className={"absolute inset-y-0 left-0 rounded-full " + BAR_DONE_CLASS} style={{ width: group.percent + "%" }} aria-hidden="true" />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {toolbarBlock}

      {/* 任务列表与甘特图同屏（Push 294；Push 295 起列表按阶段标题分组可折叠；Push 313 起「全部」（未筛选）不出列表）：筛选生效且还有没排期的任务才把列表出在甘特上方；图表本身照常在下方渲染（提示条 / 空态 ② 在 model === null 的早退分支里出）。 */}
      {filtering && hasUnscheduled ? taskListBlock : null}
              {/* 图表：左表（sticky left，横向不滚）+ 时间轴（表头 sticky top，纵向吸顶），两边逐行同一组行高 */}
              {/* 外面这层 relative 给自绘的竖向滑块（隐式浮在右缘）定位；下方横向那条是 fixed 在整个窗口底部的，不随页面滚 */}
              <div className="relative">
        <div
          ref={scrollRef}
          data-live-date-origin={model === null ? undefined : model.rangeStart}
          data-live-date-width={dayWidth}
          className={
            "scrollbar-hidden h-[calc(100vh-15rem)] min-h-[22rem] max-h-[52rem] overflow-auto rounded-xl border border-zinc-200 bg-white " +
            (panActive ? "cursor-grabbing select-none" : "cursor-grab")
          }
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClickCapture={swallowClickAfterPan}
        >
          <div className="flex w-max">
            {/*
              左表：列宽固定、每行按自然宽渲染，可见宽度 = 分隔线位置；超出的列由右侧时间轴盖住。
              只给「裁切层」上 clipPath（只裁不重排 —— 列宽一直不变，也不新建滚动容器，sticky 照常）。
              分隔线把手放在裁切层之外，否则悬停高亮线与外侧 8px 的抓手会被一起裁掉。
            */}
            {/* 层级（Push 244 业务口径「甘特图页面会挡住 日报子页面」）：左侧 sticky 表列 z-20 → **z-[19]** ——
                低于主标签栏的 z-20（同 TaskBoard 表头口径），两列齐平时不再按 DOM 靠后盖住「日报及问题」下拉面板；
                对时间轴各列仍是最高层（列本身 z-auto），左表「横向不滚」的吸层行为不变。 */}
            <div className="sticky left-0 z-[19] shrink-0" style={{ width: leftWidth }}>
              <div
                className="h-full border-r border-zinc-200 bg-white"
                style={{ width: leftWidth, clipPath: "inset(0)" }}
              >
                <div
                  className="flex items-center border-b border-zinc-200 bg-zinc-50 text-[11px] font-medium text-zinc-500"
                  style={{ height: HEADER_TOTAL_H, width: LEFT_W_NATURAL }}
                >
                  <div className="flex h-full items-center justify-center" style={{ width: COL_INDEX_W }}>
                    {fieldText(locale, "行号")}
                  </div>
                  <div className="flex h-full items-center px-3" style={{ width: COL_TITLE_W }}>
                    {fieldText(locale, "任务")}
                  </div>
                  <div className="flex h-full items-center px-3" style={{ width: COL_START_W }}>
                    {fieldText(locale, "开始日期")}
                  </div>
                  <div className="flex h-full items-center px-3" style={{ width: COL_END_W }}>
                    {fieldText(locale, "预计完成日期")}
                  </div>
                  <div className="flex h-full items-center justify-end pr-3" style={{ width: COL_PROGRESS_W }}>
                    {fieldText(locale, "进展")}
                  </div>
                </div>
                {model.rows.map((row) => {
                  const isHovered = hovered === row.key;
                  const range = rowDateRange(row);
                  return (
                    <div
                      key={row.key}
                      onMouseEnter={() => {
                        setHovered(row.key);
                      }}
                      onMouseLeave={() => {
                        setHovered(null);
                      }}
                      onClick={clearSelection}
                      className={"flex items-center border-b border-zinc-100 " + (isHovered ? "bg-zinc-50" : "bg-white")}
                      style={{ height: ROW_H, width: LEFT_W_NATURAL }}
                    >
                      <div className="flex items-center justify-center text-[11px] tabular-nums text-zinc-400" style={{ width: COL_INDEX_W }}>
                        {row.no}
                      </div>
                      {row.kind === "group" ? (
                        <button
                          type="button"
                          onClick={() => {
                            toggleStage(row.group.stage);
                          }}
                          title={collapsed[row.group.stage] === true ? t("board.stage.expand") : t("board.stage.collapse")}
                          className="flex h-full min-w-0 items-center gap-1.5 px-2 text-left"
                          style={{ width: COL_TITLE_W }}
                        >
                          <svg
                            viewBox="0 0 12 12"
                            className={
                              "h-2.5 w-2.5 shrink-0 text-zinc-400 transition-transform " +
                              (collapsed[row.group.stage] === true ? "" : "rotate-90")
                            }
                            aria-hidden="true"
                          >
                            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="truncate text-[13px] font-semibold text-zinc-800">{stageText(locale, row.group.stage)}</span>
                          <span className="ml-auto shrink-0 pr-1 text-[11px] text-zinc-400">
                            {row.group.bars.length === 0
                              ? t("board.stage.empty")
                              : t("board.stage.done", { done: row.group.doneCount, total: row.group.bars.length })}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            locateBar(row.bar);
                          }}
                          title={row.bar.label + "\n" + t("gantt.tip.selectTip")}
                          className="flex h-full min-w-0 items-center gap-1.5 pl-6 pr-2 text-left"
                          style={{ width: COL_TITLE_W }}
                        >
                          <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + STATUS_DOT_CLASS[row.bar.status]} aria-hidden="true" />
                          <span className={"truncate text-[13px] " + (selectedId === row.bar.task.id ? "font-semibold text-zinc-900" : "text-zinc-700")}>
                            {ganttTitle(row.bar.task)}
                          </span>
                        </button>
                      )}
                      <div className={dateCellClass(range.live)} style={{ width: COL_START_W }}>
                        {range.start}
                      </div>
                      <div className={dateCellClass(range.live)} style={{ width: COL_END_W }}>
                        {range.end}
                      </div>
                      <div className="pr-3 text-right text-[11px] tabular-nums text-zinc-500" style={{ width: COL_PROGRESS_W }}>
                        {row.kind === "group"
                          ? String(row.group.percent) + "%"
                          : row.bar.start === null
                            ? t("gantt.unscheduled")
                            : String(row.bar.percent) + "%"}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* 拖这条线 = 移动右侧时间轴的左边界（左表被盖住多少），双击复位到全露（官方 frame.verticalSplitLineMoveable + verticalSplitLineHighlight）：高亮线压在分隔线本身上 */}
              <span
                className="absolute -right-2 top-0 z-30 h-full w-4 cursor-col-resize touch-none"
                title={t("gantt.splitter.title")}
                onPointerDown={beginSplit}
                onPointerMove={moveSplit}
                onPointerUp={endSplit}
                onPointerCancel={endSplit}
                onDoubleClick={() => {
                  setLeftWidth(LEFT_W_DEFAULT);
                }}
                onMouseEnter={() => {
                  setSplitHover(true);
                }}
                onMouseLeave={() => {
                  setSplitHover(false);
                }}
              >
                <span
                  className={"absolute inset-y-0 left-2 w-[2px] " + (splitHover || splitActive ? "bg-blue-500" : "bg-transparent")}
                  aria-hidden="true"
                />
              </span>
            </div>

            <div className="relative" style={{ width: totalWidth }}>
              {/* 表头两排（官方 timelineHeader.scales）：上排 = 月粒度下写年份、日 / 周粒度下写月份；
                  下排 = 日粒度逐日、周粒度逐周（「M/D」）、月粒度逐月（「5月」）。今天那一列整列加蓝底。 */}
              <div className="sticky top-0 z-10 bg-white">
                <div className="flex border-b border-zinc-200 bg-zinc-50" style={{ height: HEADER_H }}>
                  {(scale === "month" ? model.years : model.months).map((unit) => (
                    <div
                      key={unit.key}
                      className="flex items-center justify-center border-r border-zinc-200 text-xs font-semibold text-zinc-700"
                      style={{ width: unit.days * dayWidth }}
                    >
                      {unit.label}
                    </div>
                  ))}
                </div>
                <div className="flex border-b border-zinc-200 bg-white" style={{ height: HEADER_H }}>
                  {headerUnits === null
                    ? Array.from({ length: model.days }, (_item, index) => {
                        const isWeekend = weekendSet.has(index);
                        const isToday = todayIndex === index;
                        return (
                          <div
                            key={"day-" + String(index)}
                            className={
                              "flex items-center justify-center text-[10px] tabular-nums " +
                              (isToday ? "bg-blue-50 font-semibold text-blue-600" : isWeekend ? "bg-zinc-50 text-zinc-400" : "text-zinc-600")
                            }
                            style={{ width: dayWidth }}
                          >
                            {String(dayOfMonth(shiftDays(model.rangeStart, index)))}
                          </div>
                        );
                      })
                    : headerUnits.map((unit, index) => {
                        const isToday = index === todayUnitIndex;
                        return (
                          <div
                            key={unit.key}
                            className={
                              "flex items-center justify-center border-r border-zinc-200 text-[10px] tabular-nums " +
                              (isToday ? "bg-blue-50 font-semibold text-blue-600" : "text-zinc-600")
                            }
                            style={{ width: unit.days * dayWidth }}
                          >
                            {unit.label}
                          </div>
                        );
                      })}
                </div>
              </div>

              {/* 网格随粒度：竖线 = 日粒度逐日 / 周粒度逐周（月粒度交给月线），周末底纹只在日粒度（周 / 月粒度太密），
                  月线一直有、年线只在月粒度 —— 条 / 今天线不受影响，仍按天精确落点。 */}
              <div className="relative" style={scale === "month" ? undefined : dayLineStyle(scale === "week" ? dayWidth * 7 : dayWidth)}>
                {scale !== "day"
                  ? null
                  : model.weekends.map((index) => (
                      <span
                        key={"weekend-" + String(index)}
                        className="absolute inset-y-0 bg-zinc-50"
                        style={{ left: index * dayWidth, width: dayWidth, ...dayLineStyle(dayWidth) }}
                        aria-hidden="true"
                      />
                    ))}
                {scale === "month"
                  ? null
                  : model.weekStarts.map((index) => (
                      <span
                        key={"week-" + String(index)}
                        className={"absolute inset-y-0 border-l " + (scale === "week" ? "border-zinc-300" : "border-zinc-200")}
                        style={{ left: index * dayWidth }}
                        aria-hidden="true"
                      />
                    ))}
                {model.monthStarts.map((index) => (
                  <span
                    key={"month-line-" + String(index)}
                    className="absolute inset-y-0 border-l border-zinc-300"
                    style={{ left: index * dayWidth }}
                    aria-hidden="true"
                  />
                ))}
                {scale !== "month"
                  ? null
                  : model.yearStarts.map((index) => (
                      <span
                        key={"year-line-" + String(index)}
                        className="absolute inset-y-0 border-l border-zinc-400"
                        style={{ left: index * dayWidth }}
                        aria-hidden="true"
                      />
                    ))}
                {model.rows.map((row) => {
                  const isHovered = hovered === row.key;
                  return (
                    <div
                      key={row.key}
                      onMouseEnter={() => {
                        setHovered(row.key);
                      }}
                      onMouseLeave={() => {
                        setHovered(null);
                      }}
                      onClick={clearSelection}
                      className={"relative border-b border-zinc-100 " + (isHovered ? "bg-zinc-50/70" : "")}
                      style={{ height: ROW_H }}
                    >
                      {row.kind === "group" ? renderGroupBar(row.group) : renderTaskBar(row.bar)}
                    </div>
                  );
                })}
                {todayLeft === null ? null : (
                  <span
                    className="pointer-events-none absolute inset-y-0 border-l border-dashed border-blue-500"
                    style={{ left: todayLeft }}
                    aria-hidden="true"
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      {vBar === null ? null : (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-40 w-3">
          <div
            role="scrollbar"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={vBar.progress}
            onPointerDown={(event) => {
              beginScrollbarDrag(event, "vertical", vBar.size, scrollRef.current === null ? 0 : scrollRef.current.clientHeight);
            }}
            style={{ height: vBar.size, top: BAR_TRACK_INSET + vBar.offset }}
            className={
              "pointer-events-auto absolute left-1/2 w-1.5 -translate-x-1/2 cursor-grab rounded-full bg-zinc-400/70 transition-opacity duration-200 hover:bg-zinc-500 active:cursor-grabbing active:bg-zinc-500 " +
              (barActive ? "opacity-100" : "opacity-0 hover:opacity-100")
            }
          />
        </div>
      )}
      {/* 横向滑块：fixed 在整个窗口底部（业务口径「要固定在全局 不然不方便」）——页面 / 卡片怎么滚都够得着；轨道宽按窗口可视宽算 */}
      {hBar === null ? null : (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 h-3">
          <div
            role="scrollbar"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hBar.progress}
            onPointerDown={(event) => {
              beginScrollbarDrag(event, "horizontal", hBar.size, bottomBarTrack());
            }}
            style={{ width: hBar.size, left: BAR_TRACK_INSET + hBar.offset }}
            className="pointer-events-auto absolute top-1/2 h-1.5 -translate-y-1/2 cursor-grab rounded-full bg-zinc-400/70 opacity-60 transition-opacity duration-200 hover:bg-zinc-500 hover:opacity-100 active:cursor-grabbing active:bg-zinc-500"
          />
        </div>
      )}
      </div>
    </div>
  );
}
