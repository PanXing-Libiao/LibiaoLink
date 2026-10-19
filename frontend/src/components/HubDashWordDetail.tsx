import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { memberNameOf, type Member } from "../data/members";
import { splitChangeReasonColumns } from "../data/changeWords";
import type { ApiChangeRequest } from "../fileApi";
import { stageNameOf, type ApiTaskListItem } from "../taskApi";
import { fieldText, stageText, useLocale, useT } from "../i18n";
import { docTypeCapsule } from "./DeliverablePicker";
import { STAGE_TAG_CLASS } from "./TaskKanban";
import { TableScrollbar } from "./TableScrollbar";
import { useFocusTrap } from "./useFocusTrap";

/**
 * 仪表盘「词频图」视图的只读「数据详情」（Push 353 · 业务口径 2026-10-16「现在做这个词频图」+ 效果参考图）：
 * 点某词的主枚（每词最中间的那一枚）后铺中央浮层的只读表（Push 356 起每词主枚可点） —— 标题 + 「来自 ▦ 变更管理」+ 搜索 + 变更明细，列序照业务给的参考图
 * （变更时间 / 变更阶段 / 变更文件 / 变更内容描述 / 变更前 / 变更后 / 变更原因 / 变更申请人 / 填写者），
 * 前面补一列行号。只读：除搜索 / 关闭外没有任何编辑入口。
 *
 * 形态与「项目进度」/「问题」的「数据详情」逐项对齐：portal 到 body + 半透明遮罩 + 点遮罩 / Esc 关闭
 * + 键盘焦点陷阱收在容器本身（不抢 ✕）+ 表体底部全站同款横向滑块；弹窗打开时地图 ⇄ 仪表盘转场停用
 * （Hub.tsx 认本弹窗的 [data-hub-detail-dialog] 标记）。
 * 传入的 rows 已由父组件按「点中的词」筛好（口径见 data/changeWords.ts 的 isChangeWordHit）。
 *
 * 列口径：
 * - 变更时间 = appliedAt（「YYYY/M/D」，与变更管理弹窗的大日期同口径）；
 * - 变更阶段 = stageKey → 九阶段展示名（色签复用看板 STAGE_TAG_CLASS）；
 * - 变更文件 = 所属任务「输出成果文件」类型（业务口径「变更文件就是输出成果文件这个类型」；列表读面不带
 *   文件 docType / 任务输出成果文件与变更管理弹窗同一回落规则：nodeId → 任务 → deliverableTypes[0]，
 *   零额外请求）；任务上没了 / 没有类型 = 「—」；
 * - 变更内容描述 / 变更原因 = reason 原文按标记拆分（导入「；原因：」/ 应用内「；变更原因：」都认；
 *   无标记 = 全文即内容描述、原因空 —— 与变更管理弹窗 splitChangeReason 同口径）；
 * - 变更申请人 / 填写者 = 用户目录（name + 工号）；填写者回落申请人（writerBy 空 = appliedBy）。
 */

/** 列（照业务参考图：行号 / 变更时间 / 变更阶段 / 变更文件 / 变更内容描述 / 变更前 / 变更后 / 变更原因 /
 *  变更申请人 / 填写者；显示名经 fieldText 换英文）。 */
const COLUMNS: readonly string[] = ["行号", "变更时间", "变更阶段", "变更文件", "变更内容描述", "变更前", "变更后", "变更原因", "变更申请人", "填写者"];

/** ISO 时间戳 → 「YYYY/M/D」（对齐变更管理弹窗的大日期口径）。 */
function slashDate(iso: string): string {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) {
    return iso;
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(day).split("-");
  return String(Number(parts[0])) + "/" + String(Number(parts[1])) + "/" + String(Number(parts[2]));
}

/** 申请人 / 填写者展示（名字 + (工号)；无工号 = 只有名字；目录里查不到 = 原样 id）。 */
function memberLabelOf(members: readonly Member[], id: string): string {
  if (id === "") {
    return "";
  }
  const name = memberNameOf(members, id) ?? id;
  const found = members.find((member) => member.id === id);
  const handle = found === undefined ? "" : found.handle;
  return handle === "" ? name : name + "(" + handle + ")";
}

export function HubDashWordDetail({ rows, members, tasks, onClose }: {
  readonly rows: readonly ApiChangeRequest[];
  readonly members: readonly Member[];
  /** 所属项目任务明细（nodeId → 任务，取「输出成果文件」类型回落展示变更文件；数据详情那一轮取数里已有）。 */
  readonly tasks: readonly ApiTaskListItem[];
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [keyword, setKeyword] = useState("");
  /** 表体横向滚动容器（口径同 HubDashDetail / HubDashIssueDetail）：底部滑块按它算溢出 / 拖动。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  /** 键盘焦点陷阱：焦点进弹窗、Tab 在弹窗内循环、关闭还原；焦点收在容器本身（不抢 ✕）。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  /** Esc 关弹窗：capture 阶段拦下（先于页面级快捷键），避免同一按 Esc 连带触发地图转场。 */
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
  /** nodeId → 任务（变更文件列取任务「输出成果文件」类型）。 */
  const taskByNodeId = useMemo(() => {
    const map = new Map<string, ApiTaskListItem>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);
  const query = keyword.trim().toLowerCase();
  /** 表行 = 一条变更 + 各列显示值 + 搜索索引串（搜索跨全部字段）。 */
  const cards = useMemo(() => rows.map((row) => {
    const split = splitChangeReasonColumns(row.reason);
    const stage = stageNameOf(row.stageKey);
    const task = row.nodeId === null ? undefined : taskByNodeId.get(row.nodeId);
    const docType = task === undefined || task.deliverableTypes.length === 0 ? null : task.deliverableTypes[0];
    const writerId = row.writerBy === null || row.writerBy === "" ? row.appliedBy : row.writerBy;
    const applicant = memberLabelOf(members, row.appliedBy);
    const writer = memberLabelOf(members, writerId);
    const date = slashDate(row.appliedAt);
    const before = row.beforeSummary ?? "";
    const after = row.afterSummary ?? "";
    const stageLabel = stage === "" ? "" : stageText(locale, stage);
    const hay = [date, stageLabel, docType ?? "", split.content, split.cause, before, after, applicant, writer].join(" ").toLowerCase();
    return { id: row.id, date, stage, stageLabel, docType, content: split.content, cause: split.cause, before, after, applicant, writer, hay };
  }), [rows, members, taskByNodeId, locale]);
  const filtered = query === "" ? cards : cards.filter((card) => card.hay.includes(query));
  return createPortal(
    <div
      data-hub-detail-dialog="true"
      data-word-detail="true"
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
        className="hub-dash-detail hub-dash-word-detail"
      >
        <div className="hub-dash-detail__head">
          <div>
            <div className="hub-dash-detail__title">{t("hub.dash.detail.title")}</div>
            <div className="hub-dash-detail__from">
              <span>{t("hub.dash.detail.from")}</span>
              <svg className="hub-dash-detail__sourceIcon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                <rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3.5 9.5h17M9.5 9.5V20.5M3.5 15h17" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              <span className="hub-dash-detail__project">{t("cd.source")}</span>
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
          <div ref={scrollRef} id="hub-dash-word-detail-scroll" className="hub-dash-detail__scroll">
            <table className="hub-dash-detail__table hub-dash-word-detail__table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column} scope="col">{fieldText(locale, column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((card, index) => (
                  <tr key={card.id}>
                    <td className="hub-dash-detail__no">{index + 1}</td>
                    <td><span className="hub-dash-detail__date">{card.date}</span></td>
                    <td>{card.stageLabel === "" ? <span className="hub-dash-detail__blank">—</span> : <span className={"hub-dash-detail__tag " + (STAGE_TAG_CLASS[card.stage] ?? "bg-zinc-100 text-zinc-600")}>{card.stageLabel}</span>}</td>
                    <td>{card.docType === null ? <span className="hub-dash-detail__blank">—</span> : <span>{docTypeCapsule(card.docType, locale)}</span>}</td>
                    <td>{card.content === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.content}>{card.content}</span>}</td>
                    <td>{card.before === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.before}>{card.before}</span>}</td>
                    <td>{card.after === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.after}>{card.after}</span>}</td>
                    <td>{card.cause === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.cause}>{card.cause}</span>}</td>
                    <td>{card.applicant === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={card.applicant}>{card.applicant}</span>}</td>
                    <td>{card.writer === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={card.writer}>{card.writer}</span>}</td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td className="hub-dash-detail__empty" colSpan={COLUMNS.length}>{t("hub.dash.wordDetail.empty")}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className={overflow ? "pointer-events-none pt-2" : "pointer-events-none h-0 overflow-hidden"}>
          <TableScrollbar scrollRef={scrollRef} onOverflowChange={setOverflow} controlsId="hub-dash-word-detail-scroll" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
