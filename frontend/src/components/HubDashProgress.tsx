import { useId, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { DASHBOARD_BINS, type DashboardProgress } from "../data/dashboardProgress";
import { stageText, useLocale, useT, type TextKey } from "../i18n";

/**
 * 仪表盘「项目进度」横条图（Push 331 首版；Push 358 从 HubDashboard 内联 JSX 原样抽成独立组件 ——
 * 「数据总览」与单视图共用同一份渲染，DOM 结构 / 类名 / 几何 / 动画逐值不变）：
 * 阶段 × 进度五档横向堆叠条，口径见 data/dashboardProgress.ts（取数 dashboardApi.ts）。
 *
 * 形态照业务确认过的效果图；按口径「多余的注释和文字不需要」只留标题 + 图例 + 数据。画布 1200 × 596
 * （viewBox 缩放填满面板，永不产生滚动条）。颜色 / 状态样式见 app.css 的 .hub-dash-*；
 * 入场动画（Push 357：柱段从行首生长 + 条上数字 300ms 后淡入）由 app.css 的 .hub-dash__seg /
 * .hub-dash__num 承担（本组件的内联 animation-delay 提供逐行 55ms 错峰）。
 *
 * 交互沿用 Push 335 / 340 口径：悬停行阴影出「行名 + 五档整排」卡、悬停柱段出「行名 + 单档」卡、
 * 点柱段开只读「数据详情」（「全部项目」下混合来源不可点）—— 浮层卡 / 数据详情的状态都在父组件
 * HubDashboard（本组件只上报事件）。
 */

const VIEW_W = 1200;
const VIEW_H = 596;
/** 行标题右对齐基线（英文阶段名最长 "Hardware Implementation"，留 216 宽够放）。 */
const LABEL_X = 216;
const PLOT_X0 = 236;
const PLOT_X1 = 1124;
const PLOT_W = PLOT_X1 - PLOT_X0;
/** 行右侧合计 x（浅灰小字）。 */
const TOTAL_X = 1140;
const ROWS_TOP = 68;
const AXIS_Y = 520;
const TICK_LABEL_Y = 544;
/** 行内柱高（上限 30；行数再多也跟着行高缩）。 */
const BAR_MAX_H = 30;

/** 图表入场动画错峰（Push 357 · 业务口径 2026-10-16「这些图表需要有动画效果 柱状图饼状图」+「颜色色调组件都不要改 只要加动画效果」）：行间 55ms；柱段数字 300ms 后起淡入（与各自的柱段同刻落定）。 */
const ROW_ANIM_STAGGER = 55;
const NUM_ANIM_OFFSET = 300;

/** 五档图例（与 DASHBOARD_BINS 同下标；父组件浮层卡的同款文案也用它）。 */
export const LEGEND_KEYS: readonly TextKey[] = ["hub.dash.b0", "hub.dash.b25", "hub.dash.b50", "hub.dash.b75", "hub.dash.b100"];

/** 估算文本宽（CJK 按 1 em、其余 0.55 em；只服务总览放大后的行名自适应与数字显隐阈值）。 */
function textWidthOf(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0x9fff ? fontSize : fontSize * 0.55;
  }
  return width;
}

/** x 轴刻度步长：按最大行合计挑 1 / 2 / 5 / 10 / 20。 */
function tickStepOf(maxTotal: number): number {
  if (maxTotal <= 10) {
    return 1;
  }
  if (maxTotal <= 20) {
    return 2;
  }
  if (maxTotal <= 50) {
    return 5;
  }
  if (maxTotal <= 100) {
    return 10;
  }
  return 20;
}

/** 轴上限：给最大行合计留约 6% 余量再进到整步（18 → 20；44 → 50）。 */
function tickMaxOf(maxTotal: number): { max: number; step: number } {
  const step = tickStepOf(Math.max(maxTotal, 1));
  const target = Math.ceil((maxTotal * 1.06) / step) * step;
  return { max: Math.max(step, target), step };
}

export function HubDashProgress({ progress, canDrill, onTip, onRowTip, onLeave, onPick, fontScale = 1 }: {
  readonly progress: DashboardProgress;
  /** 选中具体项目才可点柱段（开只读「数据详情」）；「全部项目」下混合来源不可点。 */
  readonly canDrill: boolean;
  /** 悬停柱段：父组件把鼠标位置换算成白卡坐标并出浮层卡（行名 + 档位 + 条数）。 */
  readonly onTip: (event: ReactMouseEvent<SVGGElement>, rowText: string, bin: number, count: number) => void;
  /** 悬停行阴影：浮层卡列出该行五档整排（Push 340）。 */
  readonly onRowTip: (event: ReactMouseEvent<SVGRectElement>, rowText: string, counts: readonly number[]) => void;
  /** 移出：收起浮层卡（行高亮是组件内部状态，一并清）。 */
  readonly onLeave: () => void;
  /** 点柱段：打开只读「数据详情」（仅选中具体项目时可点）。 */
  readonly onPick: (rowKey: string, bin: number) => void;
  /** 总览字号倍率（Push 360 · 业务口径 2026-10-16「文字不够清晰 那些小字还是要大一点」）：只有「数据总览」传 >1（格子小、等比缩放后小字不清晰），单视图不传、逐值不变。 */
  readonly fontScale?: number;
}) {
  const t = useT();
  const locale = useLocale();
  /** 每行一条圆角裁剪（柱条两端圆角、段与段之间直角）：id 需要实例级唯一。 */
  const uid = useId().replace(/:/g, "");
  /** 悬停行高亮（Push 340 行阴影常驻命中区；悬停出的浮层卡由 onRowTip 联动）。 */
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  /** 总览字号倍率（见上）：字号与随之变化的排版量都从这里取；倍率 1 时与旧值逐值一致。 */
  const fs = fontScale;
  const legendFont = 13 * fs;
  const legendStep = 150 * fs;
  const labelFont = 14.5 * fs;
  const totalFont = 13 * fs;
  const tickFont = 12 * fs;
  const numFont = 13 * fs;
  const rows = progress.rows;
  const maxTotal = rows.reduce((max, row) => Math.max(max, row.total), 0);
  const { max: tickMax, step } = tickMaxOf(maxTotal);
  const unit = PLOT_W / tickMax;
  const rowH = (AXIS_Y - ROWS_TOP) / rows.length;
  const barH = Math.min(BAR_MAX_H, Math.max(rowH - 12, 16));
  const ticks: number[] = [];
  for (let value = 0; value <= tickMax; value += step) {
    ticks.push(value);
  }
  const barYOf = (index: number): number => ROWS_TOP + index * rowH + (rowH - barH) / 2;
  return (
    <svg className="hub-dash" viewBox={"0 0 " + VIEW_W + " " + VIEW_H} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("hub.dash.aria")}>
      <defs>
        {rows.map((row, index) => (
          <clipPath key={row.key} id={uid + "-clip-" + index}>
            <rect x={PLOT_X0} y={barYOf(index)} width={Math.max(row.total * unit, 0)} height={barH} rx={6} />
          </clipPath>
        ))}
      </defs>
      {LEGEND_KEYS.map((key, index) => (
        <g key={key}>
          <rect className="hub-dash__swatch" data-bin={DASHBOARD_BINS[index]} x={40 + index * legendStep} y={10} width={14} height={14} rx={3} />
          <text x={60 + index * legendStep} y={22 + (legendFont - 13) * 0.35} fontSize={legendFont} fill="#4b5563">{t(key)}</text>
        </g>
      ))}
      {ticks.map((value) => (
        <line key={value} x1={PLOT_X0 + value * unit} y1={ROWS_TOP - 8} x2={PLOT_X0 + value * unit} y2={AXIS_Y} stroke="#e5e7eb" strokeDasharray="3,4" />
      ))}
      {rows.map((row, index) => {
        const barY = barYOf(index);
        const baseline = barY + barH / 2 + labelFont * 0.31;
        let cursor = PLOT_X0;
        const rowText = row.isUngrouped ? t("hub.dash.ungrouped") : stageText(locale, row.label);
        /** 行名自适应：估算宽超可用列宽（英文长阶段名 / 总览放大后）就收字，不裁字、不越界。 */
        const rowEmWidth = textWidthOf(rowText, 1);
        const rowFont = rowEmWidth > 0 ? Math.min(labelFont, (LABEL_X - 10) / rowEmWidth) : labelFont;
        return (
          <g key={row.key} onMouseEnter={() => setHoverRow(row.key)} onMouseLeave={() => { setHoverRow(null); onLeave(); }}>
            {/* Push 340 行阴影常驻命中区（悬停出「行名 + 五档整排」卡）；Push 341：默认态内联 style 真透明（呈现属性压不过 CSS 类），悬停才着色。 */}
            <rect
              className="hub-dash__rowband"
              style={hoverRow === row.key ? undefined : { fill: "transparent" }}
              x={16}
              y={barY - 7}
              width={VIEW_W - 32}
              height={barH + 14}
              rx={8}
              onMouseEnter={(event) => onRowTip(event, rowText, row.counts)}
              onMouseMove={(event) => onRowTip(event, rowText, row.counts)}
            />
            <text x={LABEL_X} y={baseline} textAnchor="end" fontSize={rowFont} fill="#374151">{rowText}</text>
            <g clipPath={"url(#" + uid + "-clip-" + index + ")"}>
              {row.counts.map((count, bin) => {
                if (count === 0) {
                  return null;
                }
                const width = count * unit;
                const x = cursor;
                cursor += width;
                return (
                  <g
                    key={bin}
                    onMouseEnter={(event) => onTip(event, rowText, bin, count)}
                    onMouseMove={(event) => onTip(event, rowText, bin, count)}
                    onMouseLeave={() => onLeave()}
                    onClick={canDrill ? () => onPick(row.key, bin) : undefined}
                  >
                    <rect className="hub-dash__seg" data-bin={DASHBOARD_BINS[bin]} data-drill={canDrill ? "true" : "false"} style={{ animationDelay: index * ROW_ANIM_STAGGER + "ms" }} x={x} y={barY} width={width} height={barH} />
                    {width >= Math.max(24, textWidthOf(String(count), numFont) + 10) ? (
                      <text className="hub-dash__num" data-tone={bin === 0 || bin === 2 ? "dark" : "light"} style={{ animationDelay: index * ROW_ANIM_STAGGER + NUM_ANIM_OFFSET + "ms" }} x={x + width / 2} y={baseline} textAnchor="middle" fontSize={numFont} fontWeight={600}>{count}</text>
                    ) : null}
                  </g>
                );
              })}
            </g>
            <text x={TOTAL_X} y={baseline} fontSize={totalFont} fill="#9ca3af">{row.total}</text>
          </g>
        );
      })}
      <line x1={PLOT_X0 - 8} y1={AXIS_Y} x2={PLOT_X1 + 8} y2={AXIS_Y} stroke="#b8bec6" />
      {ticks.map((value) => (
        <text key={value} x={PLOT_X0 + value * unit} y={TICK_LABEL_Y} textAnchor="middle" fontSize={tickFont} fill="#8a9099">{value}</text>
      ))}
    </svg>
  );
}
