import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DailyReport, Issue, ReportPhoto } from "../data/reports";
import { usePhotoUrl } from "../fileApi";
import { fieldText, useLocale, useT } from "../i18n";
import { ISSUE_CATEGORY_CLASS } from "./ReportIssuePanel";
import { TableScrollbar } from "./TableScrollbar";
import { ImageZoomViewer } from "./ImageZoomViewer";
import { useFocusTrap } from "./useFocusTrap";

/**
 * 仪表盘「问题」视图的只读「数据详情」（Push 344 · 业务口径 2026-10-16「现在做这个问题 效果和上面做的一样」）：
 * 点柱后铺中央浮层的只读表 —— 标题 + 「来自 <项目名>」+ 搜索 + 问题明细，列序照业务给的参考图
 * （日报侧五列 + 问题侧三列），另补「问题描述」一列（参考图没有，但我们的问题可无来源日报，
 * 不补这列时报告侧全空的行认不出是什么问题）。只读：除搜索 / 关闭 / 点附图预览外没有任何编辑入口。
 *
 * 形态与「项目进度」的「数据详情」（HubDashDetail.tsx）逐项对齐：portal 到 body + 半透明遮罩 +
 * 点遮罩 / Esc 关闭 + 键盘焦点陷阱收在容器本身（不抢 ✕）+ 表体底部全站同款横向滑块；
 * 弹窗打开时地图 ⇄ 仪表盘转场停用（Hub.tsx 认本弹窗的 [data-hub-detail-dialog] 标记）。
 * 传入的 rows 已由父组件按「点中的状态 × 归类」筛好（口径见 data/dashboardProgress.ts 的 isIssueInCell，
 * 保证「柱上数字 = 表行数」）。
 * 表行 = 一条问题 + 它的来源日报（issue.reportId → reportsByProject；无来源日报时报告侧整列出杠）。
 * Push 351（2026-10-16 · Push 350 同源修正）：Esc 优先级 —— 附图大图预览开着时 Esc 先关预览、弹窗仍在（PhotoTiles onPreviewOpenChange + 本弹窗 Esc 让位；原为一下全关）。
 */

/** 表行：问题 + 来源日报（可为空）。 */
export type HubDashIssueDetailRow = {
  readonly issue: Issue;
  readonly report: DailyReport | null;
};

/** 列（照业务参考图：行号 / 日期 / 当日完成工作 / 施工人数 / 填写者 / 明日计划 / 现场工作附图 / 问题归类 /
 *  解决方案或建议 / 问题附图；「问题描述」为补列，见文件头。显示名经 fieldText 换英文）。 */
const COLUMNS: readonly string[] = ["行号", "日期", "问题描述", "当日完成工作", "施工人数", "填写者", "明日计划", "现场工作附图", "问题归类", "解决方案或建议", "问题附图"];

/** 附图大图预览层（与「问题追踪」同款：点遮罩 / Esc 关闭；图挂共享组件 ImageZoomViewer —— 滚轮 / ＋− / 双击 / 拖动平移）。 */
function PhotoPreview({ url, name, onClose }: { readonly url: string; readonly name: string; readonly onClose: () => void }) {
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
  const trapRef = useFocusTrap<HTMLDivElement>();
  const t = useT();
  return createPortal(
    <div
      ref={trapRef}
      data-photo-preview=""
      role="dialog"
      aria-label={t("ws.previewNamed", { name })}
      onClick={(event) => { event.stopPropagation(); onClose(); }}
      onPointerDown={(event) => { event.stopPropagation(); }}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-900/60 p-6"
    >
      <figure className="flex max-h-full max-w-full flex-col items-center">
        <ImageZoomViewer src={url} alt={name} />
        <figcaption className="relative z-10 mt-2 rounded-md bg-zinc-900/35 px-2 py-1 text-center text-xs text-white/80 backdrop-blur-sm">{name}</figcaption>
      </figure>
    </div>,
    document.body,
  );
}

/** 单枚附图小图（懒取服务端预览签名；点开 = 大图预览层）。 */
function PhotoTile({ photo, onPreview }: { readonly photo: ReportPhoto; readonly onPreview: (url: string, name: string) => void }) {
  const url = usePhotoUrl(photo.fileId, photo.url);
  const t = useT();
  if (url === null) {
    return <span aria-hidden="true" className="inline-block h-11 w-14 shrink-0 animate-pulse rounded-md border border-zinc-200 bg-zinc-100" />;
  }
  return (
    <button
      type="button"
      data-issue-photo={photo.name}
      title={photo.name}
      aria-label={t("ws.previewNamed", { name: photo.name })}
      onClick={() => { onPreview(url, photo.name); }}
      className="shrink-0 rounded-md transition hover:opacity-80"
    >
      <img src={url} alt={photo.name} className="h-11 w-14 rounded-md border border-zinc-200 object-cover" />
    </button>
  );
}

/** 附图列（小图瓦片 56 x 44、多张折行；空 = 「—」）。 */
function PhotoTiles({ photos, onPreviewOpenChange }: { readonly photos: readonly ReportPhoto[]; /** 大图预览开 / 关通知（Push 351：宿主弹窗据此让出 Esc 优先级 —— 预览开着时 Esc 先关预览、弹窗仍在）。 */ onPreviewOpenChange?: (open: boolean) => void }) {
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  /** 大图预览开 / 关（Push 351：带出开合通知 —— 宿主弹窗 Esc 让位给预览层）。 */
  const setPreviewOpen = (next: { url: string; name: string } | null) => {
    setPreview(next);
    onPreviewOpenChange?.(next !== null);
  };
  if (photos.length === 0) {
    return <span className="hub-dash-detail__blank">—</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-start gap-1.5">
      {photos.map((photo, index) => (
        <PhotoTile key={photo.fileId + "#" + String(index)} photo={photo} onPreview={(url, name) => { setPreviewOpen({ url, name }); }} />
      ))}
      {preview === null ? null : <PhotoPreview url={preview.url} name={preview.name} onClose={() => { setPreviewOpen(null); }} />}
    </span>
  );
}

/** 问题归类色签组（与「问题追踪」同一张浅底色表；空数组 = 「未归类」灰签）。 */
function CategoryPills({ values }: { readonly values: readonly string[] }) {
  const locale = useLocale();
  const items = values.length === 0 ? ["未归类"] : values;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {items.map((item, index) => (
        <span key={item + "#" + String(index)} data-issue-category={item} className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 " + (ISSUE_CATEGORY_CLASS[item] ?? "bg-zinc-100")}>
          {fieldText(locale, item)}
        </span>
      ))}
    </span>
  );
}

export function HubDashIssueDetail({ projectName, rows, onClose }: {
  readonly projectName: string;
  readonly rows: readonly HubDashIssueDetailRow[];
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [keyword, setKeyword] = useState("");
  /** 表体横向滚动容器（口径同 HubDashDetail）：底部滑块按它算溢出 / 拖动。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  /** 键盘焦点陷阱：焦点进弹窗、Tab 在弹窗内循环、关闭还原；焦点收在容器本身（不抢 ✕）。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  /** Push 351：附图大图预览的开合（Esc 让位用 —— 预览开着时 Esc 先关预览、弹窗仍在）。 */
  const thumbPreviewOpenRef = useRef(false);
  /** Esc 关弹窗：capture 阶段拦下（先于页面级快捷键），避免同一按 Esc 连带触发地图转场；
   *  Push 351：附图大图预览开着时让位给预览层自己的 Esc（先关预览、弹窗仍在）。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        // Push 351：附图大图预览开着时让位给预览层自己的 Esc（先关预览、弹窗仍在）。
        if (!thumbPreviewOpenRef.current) {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const query = keyword.trim().toLowerCase();
  /** 表行 = 问题 + 来源日报 + 各列显示值 + 搜索索引串（搜索跨全部字段）。 */
  const cards = useMemo(() => rows.map((row) => {
    const { issue, report } = row;
    const date = report !== null && report.date !== "" ? report.date : issue.raisedAt;
    const doneWork = report === null ? "" : report.doneWork;
    const headcount = report === null || report.headcount === null ? "" : String(report.headcount);
    const author = report === null ? "" : report.author;
    const plan = report === null ? "" : report.plan;
    const solution = issue.solution;
    const hay = [issue.title, issue.categories.join("、"), solution, date, doneWork, headcount, author, plan].join(" ").toLowerCase();
    return { issue, report, date, doneWork, headcount, author, plan, solution, hay };
  }), [rows]);
  const filtered = query === "" ? cards : cards.filter((card) => card.hay.includes(query));
  return createPortal(
    <div
      data-hub-detail-dialog="true"
      data-issue-detail="true"
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
        className="hub-dash-detail hub-dash-issue-detail"
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
          <div ref={scrollRef} id="hub-dash-issue-detail-scroll" className="hub-dash-detail__scroll">
            <table className="hub-dash-detail__table hub-dash-issue-detail__table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column} scope="col">{fieldText(locale, column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((card, index) => (
                  <tr key={card.issue.id}>
                    <td className="hub-dash-detail__no">{index + 1}</td>
                    <td>{card.date === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{card.date}</span>}</td>
                    <td><span className="hub-dash-detail__task" title={card.issue.title}>{card.issue.title}</span></td>
                    <td>{card.doneWork === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.doneWork}>{card.doneWork}</span>}</td>
                    <td>{card.headcount === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__date">{card.headcount}</span>}</td>
                    <td>{card.author === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__chip" title={card.author}>{card.author}</span>}</td>
                    <td>{card.plan === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.plan}>{card.plan}</span>}</td>
                    <td><PhotoTiles photos={card.report === null ? [] : card.report.photos} onPreviewOpenChange={(open) => { thumbPreviewOpenRef.current = open; }} /></td>
                    <td><CategoryPills values={card.issue.categories} /></td>
                    <td>{card.solution === "" ? <span className="hub-dash-detail__blank">—</span> : <span className="hub-dash-detail__note" title={card.solution}>{card.solution}</span>}</td>
                    <td><PhotoTiles photos={card.issue.photos} onPreviewOpenChange={(open) => { thumbPreviewOpenRef.current = open; }} /></td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td className="hub-dash-detail__empty" colSpan={COLUMNS.length}>{t("hub.dash.issueDetail.empty")}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className={overflow ? "pointer-events-none pt-2" : "pointer-events-none h-0 overflow-hidden"}>
          <TableScrollbar scrollRef={scrollRef} onOverflowChange={setOverflow} controlsId="hub-dash-issue-detail-scroll" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
