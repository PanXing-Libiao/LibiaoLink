import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { DASHBOARD_ISSUE_COLORS, dashboardIssueKey, type DashboardIssues } from "../data/dashboardProgress";
import { fieldText, statusText, useLocale, useT } from "../i18n";

/**
 * 仪表盘「问题」分组柱状图（Push 344 · 业务口径 2026-10-16「现在做这个问题 效果和上面做的一样」）：
 * 形态照业务参考图 —— 图例居中在顶（问题归类）、x 轴 = 问题状态（已完成 / 处理中 / 未解决）、
 * 每个状态一组柱子（组内按归类契约原序）、柱顶写同色数字、y 轴虚线网格（0 轴实线）；
 * 悬停柱 = 整组铺浅灰底 + 浮层卡（状态名 + 归类色点 + 归类 + 条数，参考图二的形态）；
 * 悬停组内空白 = 浮层卡列出该状态全部归类（与「项目进度」的行阴影卡同一口径）；
 * 点柱 = 打开只读「数据详情」—— 仅选中具体项目时可点（与柱段 / 扇区同一套，父组件按 canDrill 关掉点击）；
 * 「全部项目」下不可点。父组件负责悬停卡 / 数据详情两个浮层的状态。
 *
 * 口径（buildDashboardIssues，data/dashboardProgress.ts）：0 条的状态整组不出现、0 条的归类整条不出现
 * （业务口径「没有相关的问题才没显示在图中」，与「任务状态」饼图同一口径）；一条问题多归类时每个归类各计一条。
 */

const VIEW_W = 1200;
const VIEW_H = 596;
/** 绘图区（0 轴基线 AXIS_Y / 刻度文字基线 TICK_LABEL_Y 与「项目进度」逐值对齐，三视图共用同一套几何）。 */
const PLOT_X0 = 116;
const PLOT_X1 = 1156;
const PLOT_W = PLOT_X1 - PLOT_X0;
const PLOT_TOP = 68;
const AXIS_Y = 520;
const TICK_LABEL_Y = 544;
/** 图例（与饼图同款：14 色块 + 16 号字，居中在顶）。 */
const LEGEND_FONT = 16;
const LEGEND_SWATCH = 14;
const LEGEND_ITEM_GAP = 44;
/** 柱宽上限与柱间距比例（一组里柱子越多 / 组越窄，柱越窄）。 */
const BAR_MAX_W = 46;
const BAR_GAP_RATIO = 0.32;
/** 悬停高亮条左右内缩（不贴组边界）。 */
const BAND_INSET = 6;

/** 图表入场动画错峰（Push 357 · 业务口径 2026-10-16「这些图表需要有动画效果 柱状图饼状图」+「颜色色调组件都不要改 只要加动画效果」）：归类（series）间 70ms；柱顶数字 300ms 后起淡入（与柱同刻落定）。 */
const SERIES_ANIM_STAGGER = 70;
const NUM_ANIM_OFFSET = 300;

/** y 轴刻度：按最大单柱挑 1 / 2 / 5 / 10 / 20 整步（参考图最大柱 5 → 刻度 0 / 2 / 4 / 6）。 */
function axisOf(maxBar: number): { max: number; step: number } {
  if (maxBar <= 1) {
    return { max: 1, step: 1 };
  }
  const raw = maxBar / 3;
  const step = raw <= 1 ? 1 : raw <= 2 ? 2 : raw <= 5 ? 5 : raw <= 10 ? 10 : 20;
  return { max: Math.max(step, Math.ceil(maxBar / step) * step), step };
}

/** 估算文本宽（CJK 按 1 em、其余 0.55 em；只服务图例居中）。 */
function textWidthOf(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0x9fff ? fontSize : fontSize * 0.55;
  }
  return width;
}

/** 一组柱子里的分类行（只含有数据的归类）。 */
export type DashboardIssueRow = { readonly category: string; readonly count: number };

export function HubDashIssues({ issues, canDrill, onTip, onRowTip, onLeave, onPick, fontScale = 1 }: {
  readonly issues: DashboardIssues;
  /** 选中具体项目才可点柱（开「数据详情」）；「全部项目」下光标保持箭头、不给来源。 */
  readonly canDrill: boolean;
  /** 悬停柱：父组件把鼠标位置换算成白卡坐标并出浮层卡（状态名 + 归类 + 条数）。 */
  readonly onTip: (event: ReactMouseEvent<SVGRectElement>, state: string, category: string, count: number) => void;
  /** 悬停组内空白：浮层卡列出该状态全部归类（0 条的不列）。 */
  readonly onRowTip: (event: ReactMouseEvent<SVGRectElement>, state: string, rows: readonly DashboardIssueRow[]) => void;
  /** 移出：收起浮层卡并撤掉组高亮。 */
  readonly onLeave: () => void;
  /** 点柱：打开只读「数据详情」（仅选中具体项目时可点）。 */
  readonly onPick: (state: string, category: string) => void;
  /** 总览字号倍率（Push 360 · 业务口径 2026-10-16「文字不够清晰 那些小字还是要大一点」）：只有「数据总览」传 >1，单视图不传、逐值不变。 */
  readonly fontScale?: number;
}) {
  const t = useT();
  const locale = useLocale();
  /** 悬停中的状态组（整组铺浅灰底，与参考图二同款）。 */
  const [hover, setHover] = useState<string | null>(null);
  /** 总览字号倍率（见上）：字号与随之变化的排版量都从这里取；倍率 1 时与旧值逐值一致。 */
  const fs = fontScale;
  const legendBaseFont = LEGEND_FONT * fs;
  const numFont = 13 * fs;
  const tickFont = 12 * fs;
  const stateFont = 14 * fs;
  if (issues.states.length === 0 || issues.categories.length === 0) {
    return null;
  }
  /** 行 = 状态 × 归类 的计数矩阵（0 条不画柱、也不进浮层卡）。 */
  const groups = issues.states.map((state) => {
    const rows = issues.categories
      .map((category) => ({ category, count: issues.counts.get(dashboardIssueKey(state, category)) ?? 0 }))
      .filter((row) => row.count > 0);
    return { state, rows };
  });
  const maxBar = groups.reduce((max, group) => group.rows.reduce((inner, row) => Math.max(inner, row.count), max), 0);
  const { max: tickMax, step } = axisOf(Math.max(maxBar, 1));
  const unit = (AXIS_Y - PLOT_TOP) / tickMax;
  const groupW = PLOT_W / issues.states.length;
  const barW = Math.min(BAR_MAX_W, (groupW * 0.68) / issues.categories.length);
  const barGap = barW * BAR_GAP_RATIO;
  const ticks: number[] = [];
  for (let value = 0; value <= tickMax; value += step) {
    ticks.push(value);
  }
  /** 图例（居中）：归类色块 + 归类名（顺序 = 契约 C9 原序）。 */
  const legendItems: Array<{ category: string; text: string; x: number }> = [];
  /** 图例宽随字号涨：按可用宽收口（归类多时逐档收小，保证居中不越界；常规 5~6 个归类不触发）。 */
  const legendEmSum = issues.categories.reduce((sum, category) => sum + textWidthOf(fieldText(locale, category), 1), 0);
  const legendFitFont = legendEmSum > 0 ? (VIEW_W - 40 - issues.categories.length * (LEGEND_SWATCH + 8) - LEGEND_ITEM_GAP * Math.max(issues.categories.length - 1, 0)) / legendEmSum : legendBaseFont;
  const legendFont = Math.max(12, Math.min(legendBaseFont, legendFitFont));
  const legendWidths = issues.categories.map((category) => LEGEND_SWATCH + 8 + textWidthOf(fieldText(locale, category), legendFont));
  const legendTotal = legendWidths.reduce((sum, width) => sum + width, 0) + LEGEND_ITEM_GAP * Math.max(legendWidths.length - 1, 0);
  let legendX = (VIEW_W - legendTotal) / 2;
  issues.categories.forEach((category, index) => {
    legendItems.push({ category, text: fieldText(locale, category), x: legendX });
    legendX += legendWidths[index] + LEGEND_ITEM_GAP;
  });
  return (
    <svg className="hub-dash-issues" viewBox={"0 0 " + VIEW_W + " " + VIEW_H} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("hub.dash.issues.aria")} onMouseLeave={() => { setHover(null); onLeave(); }}>
      {legendItems.map((item) => (
        <g key={"legend-" + item.category}>
          <rect className="hub-dash-issues__swatch" data-category={item.category} x={item.x} y={9} width={LEGEND_SWATCH} height={LEGEND_SWATCH} rx={3} fill={DASHBOARD_ISSUE_COLORS[item.category] ?? "#c9ced6"} />
          <text className="hub-dash-issues__legendText" x={item.x + LEGEND_SWATCH + 8} y={22 + (legendFont - LEGEND_FONT) * 0.35} fontSize={legendFont}>{item.text}</text>
        </g>
      ))}
      {ticks.map((value) => (
        value > 0 ? <line key={"grid-" + value} className="hub-dash-issues__grid" x1={PLOT_X0} y1={AXIS_Y - value * unit} x2={PLOT_X1} y2={AXIS_Y - value * unit} /> : null
      ))}
      <line className="hub-dash-issues__axis" x1={PLOT_X0 - 8} y1={AXIS_Y} x2={PLOT_X1 + 8} y2={AXIS_Y} />
      {ticks.map((value) => (
        <text key={"tick-" + value} className="hub-dash-issues__tick" x={PLOT_X0 - 14} y={AXIS_Y - value * unit + tickFont * 0.33} textAnchor="end" fontSize={tickFont}>{value}</text>
      ))}
      {groups.map((group, groupIndex) => {
        const gx = PLOT_X0 + groupW * groupIndex;
        const center = gx + groupW / 2;
        const totalW = issues.categories.length * barW + (issues.categories.length - 1) * barGap;
        const startX = center - totalW / 2;
        return (
          <g key={group.state}>
            <rect
              className="hub-dash-issues__band"
              data-state={group.state}
              data-hover={hover === group.state ? "true" : "false"}
              x={gx + BAND_INSET}
              y={PLOT_TOP - 6}
              width={groupW - BAND_INSET * 2}
              height={AXIS_Y - PLOT_TOP + 6}
              onMouseEnter={() => { setHover(group.state); }}
              onMouseMove={(event) => { onRowTip(event, group.state, group.rows); }}
              onMouseLeave={() => { setHover(null); onLeave(); }}
            />
            {issues.categories.map((category, seriesIndex) => {
              const count = issues.counts.get(dashboardIssueKey(group.state, category)) ?? 0;
              if (count === 0) {
                return null;
              }
              const x = startX + seriesIndex * (barW + barGap);
              const height = Math.max(count * unit, 2);
              const y = AXIS_Y - height;
              return (
                <g key={group.state + "-" + category}>
                  <rect
                    className="hub-dash-issues__bar"
                    style={{ animationDelay: seriesIndex * SERIES_ANIM_STAGGER + "ms" }}
                    data-state={group.state}
                    data-category={category}
                    data-count={count}
                    data-drill={canDrill ? "true" : "false"}
                    x={x}
                    y={y}
                    width={barW}
                    height={height}
                    rx={3}
                    fill={DASHBOARD_ISSUE_COLORS[category] ?? "#c9ced6"}
                    onMouseEnter={(event) => { setHover(group.state); onTip(event, group.state, category, count); }}
                    onMouseMove={(event) => { setHover(group.state); onTip(event, group.state, category, count); }}
                    onMouseLeave={() => { setHover(null); onLeave(); }}
                    onClick={canDrill ? () => { onPick(group.state, category); } : undefined}
                  />
                  <text className="hub-dash-issues__num" data-category={category} style={{ animationDelay: seriesIndex * SERIES_ANIM_STAGGER + NUM_ANIM_OFFSET + "ms" }} x={x + barW / 2} y={y - numFont * 0.62} textAnchor="middle" fontSize={numFont} fontWeight={600} fill={DASHBOARD_ISSUE_COLORS[category] ?? "#c9ced6"}>{count}</text>
                </g>
              );
            })}
            <text className="hub-dash-issues__state" x={center} y={TICK_LABEL_Y} textAnchor="middle" fontSize={stateFont}>{statusText(locale, group.state)}</text>
          </g>
        );
      })}
    </svg>
  );
}
