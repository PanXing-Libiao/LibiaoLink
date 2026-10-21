import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dateOnlyText, isCompleteStatus, type TaskPriority } from "../data/tasks";
import { fieldText, mdText, priorityText, statusText, useLocale, useT, type Locale } from "../i18n";
import { displayStatusLabel, type ApiTaskListItem } from "../taskApi";
import { docTypeCapsule } from "./DeliverablePicker";
import { TableScrollbar } from "./TableScrollbar";
import { PRIORITY_CAPSULE_CLASS, STATUS_CAPSULE_CLASS } from "./TaskBoard";
import { useFocusTrap } from "./useFocusTrap";

/**
 * 仪表盘「数据详情」（Push 335 · 2026-10-15 业务口径「点击某一段是这个只读效果」）：
 * 点柱段后铺满白卡的只读表 —— 标题 + 「来自 <项目名>」+ 搜索 + 任务明细，列序照业务给的参考图。只读：
 * 除搜索 / 关闭外没有任何编辑入口；「如果是全部项目的话不支持点击查看数据来源」由父组件把段上的点击关掉。
 * 传入的 tasks 已由父组件按「点中的行 × 档」筛好（口径见 data/dashboardProgress.ts 的 isTaskInCell，
 * 保证「段上数字 = 表行数」）。
 *
 * Push 336（2026-10-15 业务口径「点击具体的模块进入详细内容后是弹窗一样的效果 并且不支持鼠标滑动切换页面
 * 弹窗不用全屏 就像文件预览一样」+「项目详细里面横向滚动条没有看到啊」）：由**铺满白卡**改成中央浮层弹窗
 * （形态照 FilePreviewOverlay.tsx：portal 到 body + 半透明遮罩 + 点遮罩 / Esc 关闭 + 键盘焦点陷阱，不全屏、
 * 卡片最大 76rem 高宽都不撑满）；表体底部挂全站同款横向滑块 TableScrollbar（原生细条在 Windows 上看不出来的问题）。
 * 弹窗打开时地图 ⇄ 仪表盘转场停用：Hub.tsx 认本弹窗的 [data-hub-detail-dialog] 标记。
 * Push 338（2026-10-15 业务口径「英文[部分]鼠标触碰也要展现 现在只显示了中文」·「这个是数据详细页面」）：**截断格 hover 兜底** ——
 * 任务描述 title 挂显示全文（中文名+英文名连排），项目经理 / 任务负责人截断胶囊也补 title。
 * Push 340（2026-10-15 业务口径「一点进来这个叉号就被选中了」）：容器挂 data-focus-container + tabIndex={-1} ——
 * 焦点陷阱打开时把焦点收到容器本身，不再自动聚焦 ✕（✕ 不再一打开就被描上 :focus-visible 焦点环）；
 * Esc 关闭 / Tab 循环 / 关闭还原口径不变。
 */

/** 列（Push 337 起 = 项目空间任务表的口径「直接把项目空间的那一列展示即可」：项目空间 15 列全上，
 *  前面补一列行号、任务状态后插「项目进度」保留参考图那段条；显示名经 fieldText 换英文）。 */
const COLUMNS: readonly string[] = ["行号", "任务描述", "项目经理", "任务负责人", "任务状态", "紧急重要度", "项目进度", "是否按时交付", "输出成果文件", "文件", "项目进展描述", "开始日期", "预计所需天数", "预计完成日期", "预计所需施工人数", "实际完成日期", "变更关联"];

/** 「是否按时交付」徽标底色（与任务表 / 成果文件色签同套口径：浅彩底 + 同色系深字）。 */
const ONTIME_CHIP_CLASS: Record<string, string> = {
  "逾期未交付": "bg-red-50 text-red-600",
  "逾期已交付": "bg-amber-100 text-amber-700",
  "按时交付": "bg-emerald-50 text-emerald-700",
};

/** 任务名展示（参考图口径：中文名后紧跟英文名，无分隔符；英文界面下有英文名就只用英文名）。 */
function titleTextOf(task: ApiTaskListItem, locale: Locale): string {
  const titleEn = task.titleEn ?? "";
  if (locale === "en") {
    return titleEn === "" ? task.title : titleEn;
  }
  return task.title + titleEn;
}

/** 是否按时交付（口径与任务表同源：服务端展示态 + onTime 派生，前端不本地算日期）。 */
function onTimeLabelOf(task: ApiTaskListItem): "逾期未交付" | "逾期已交付" | "按时交付" | null {
  const status = displayStatusLabel(task.displayStatus);
  if (status === "已延期") {
    return "逾期未交付";
  }
  if (isCompleteStatus(status) && task.onTime === false) {
    return "逾期已交付";
  }
  return task.onTime === null ? null : "按时交付";
}

export function HubDashDetail({ projectName, manager, tasks, onClose }: {
  readonly projectName: string;
  readonly manager: string;
  readonly tasks: readonly ApiTaskListItem[];
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [keyword, setKeyword] = useState("");
  /** 表体横向滚动容器（Push 336）：底部滑块按它算溢出 / 拖动。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 表体横向溢出时才给滑块留位（不溢出收成 0 高，不留空当 —— 同项目总览口径）。 */
  const [overflow, setOverflow] = useState(false);
  /** 键盘焦点陷阱（Push 264 口径）：焦点进弹窗、Tab 在弹窗内循环、关闭还原到触发处；Push 340：焦点收在容器本身（data-focus-container），不抢 ✕。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  /** Esc 关弹窗：capture 阶段拦下（先于页面级快捷键），避免同一按 Esc 连带触发地图转场 / 外层弹层。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const query = keyword.trim().toLowerCase();
  /** 表行 = 任务 + 各列显示值 + 搜索索引串（搜索跨全部字段；列口径见 COLUMNS）。 */
  const rows = useMemo(() => tasks.map((task) => {
    const owners = task.ownerNames.filter((name): name is string => name !== null && name !== "").join("、");
    const status = displayStatusLabel(task.displayStatus);
    const onTime = onTimeLabelOf(task);
    const title = titleTextOf(task, locale);
    const start = mdText(locale, task.plannedStart ?? "");
    const due = mdText(locale, task.plannedEnd ?? "");
    const done = mdText(locale, task.actualEnd ?? "");
    const note = task.note ?? "";
    const percent = Math.round(task.progress * 100);
    const priority = task.priority;
    /** 各列文案走全站同一套（天数 / 人数 / 文件份数 / 变更）——与项目空间逐字一致。 */
    const days = task.estimatedDays === null ? "" : String(task.estimatedDays);
    const headcount = task.headcount !== null && task.headcount > 0 ? t("drawer.headcount.value", { n: task.headcount }) : "";
    const files = task.fileSummary?.total ?? 0;
    /** 只读读面：列表接口理论上带全（契约 TaskListItem），缺字段时退空而不是整表崩。 */
    const changeLinks = task.changeLinks ?? [];
    const changeCount = changeLinks.length;
    const changeTip = changeLinks.map((change) => t("board.change.tip", { date: dateOnlyText(change.appliedAt) }) + (change.reason === null || change.reason === "" ? "" : (locale === "en" ? " (" + change.reason + ")" : "（" + change.reason + "）"))).join(locale === "en" ? "; " : "；");
    const priorityName = priority === null ? "" : priorityText(locale, priority);
    const hay = [title, task.title, task.titleEn ?? "", owners, manager, statusText(locale, status), onTime ?? "", priorityName, task.deliverableTypes.join("、"), note, start, due, done, days, headcount].join(" ").toLowerCase();
    return { task, title, owners, status, onTime, priority, files, note, start, days, due, headcount, done, changeCount, changeTip, percent, hay };
  }), [tasks, locale, manager, t]);
  const filtered = query === "" ? rows : rows.filter((row) => row.hay.includes(query));
  return createPortal(
    <div
      data-hub-detail-dialog="true"
      role="dialog"
      aria-modal="true"
      aria-label={t("hub.dash.detail.title")}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/45 p-6"
    >
      <div
        ref={trapRef}
        data-focus-container="true"
        tabIndex={-1}
        onClick={(event) => { event.stopPropagation(); }}
        className="hub-dash-detail"
      >
        <div className="hub-dash-detail__head">
          <div>
            <div className="hub-dash-detail__title">{t("hub.dash.detail.title")}</div>
            <div className="hub-dash-detail__from">
              <span>{t("hub.dash.detail.from")}</span>
              <span className="hub-dash-detail__project">{projectName}</span>
            </div>
          </div>
          <button type="button" className="hub-dash-detail__close" aria-label={t("hub.dash.detail.close")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="hub-dash-detail__box">
          <label className="hub-dash-detail__search">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16.2 16.2L20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("hub.dash.detail.search")} aria-label={t("hub.dash.detail.search")} />
          </label>
          <div ref={scrollRef} id="hub-dash-detail-scroll" className="hub-dash-detail__scroll">
            <table className="hub-dash-detail__table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column} scope="col">{fieldText(locale, column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, index) => (
                  <tr key={row.task.id}>
                    <td className="hub-dash-detail__no">{index + 1}</td>
                    <td><span className="hub-dash-detail__task" title={row.title}>{row.title}</span></td>
                    <td>{manager === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={manager}>{manager}</span>}</td>
                    <td>{row.owners === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={row.owners}>{row.owners}</span>}</td>
                    <td><span className={"hub-dash-detail__tag " + STATUS_CAPSULE_CLASS[row.status]}>{statusText(locale, row.status)}</span></td>
                    <td>{row.priority === null ? <span className="hub-dash-detail__blank">—</span> : <span className={"hub-dash-detail__tag " + (PRIORITY_CAPSULE_CLASS[row.priority as TaskPriority] ?? "")}>{priorityText(locale, row.priority)}</span>}</td>
                    <td>
                      <span className="hub-dash-detail__bar"><span style={{ width: row.percent + "%" }} /></span>
                      <span className="hub-dash-detail__pct">{row.percent}%</span>
                    </td>
                    <td>{row.onTime === null ? <span className="hub-dash-detail__blank">—</span> : <span className={"hub-dash-detail__tag " + ONTIME_CHIP_CLASS[row.onTime]}>{statusText(locale, row.onTime)}</span>}</td>
                    <td>{row.task.deliverableTypes.length === 0 ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chips">{row.task.deliverableTypes.map((name) => (<span key={name}>{docTypeCapsule(name, locale)}</span>))}</span>}</td>
                    <td>{row.files === 0 ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={t("board.files.title", { n: row.files })}>{t("board.files.count", { n: row.files })}</span>}</td>
                    <td>{row.note === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={row.note}>{row.note}</span>}</td>
                    <td>{row.start === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{row.start}</span>}</td>
                    <td>{row.days === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{row.days}</span>}</td>
                    <td>{row.due === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{row.due}</span>}</td>
                    <td>{row.headcount === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{row.headcount}</span>}</td>
                    <td>{row.done === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{row.done}</span>}</td>
                    <td>{row.changeCount === 0 ? <span className="hub-dash-detail__blank">—</span> : (<span className="hub-dash-detail__chips" title={row.changeTip}><span className="hub-dash-detail__tag bg-amber-100 text-amber-700">{t("board.change.chip")}</span>{row.changeCount > 1 ? <span className="text-[10px] text-zinc-400">+{row.changeCount - 1}</span> : null}</span>)}</td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td className="hub-dash-detail__empty" colSpan={COLUMNS.length}>{t("hub.dash.detail.empty")}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className={overflow ? "pointer-events-none pt-2" : "pointer-events-none h-0 overflow-hidden"}>
          <TableScrollbar scrollRef={scrollRef} onOverflowChange={setOverflow} controlsId="hub-dash-detail-scroll" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
