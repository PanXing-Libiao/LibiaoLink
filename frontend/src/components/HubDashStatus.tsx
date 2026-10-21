import type { MouseEvent as ReactMouseEvent } from "react";
import type { DashboardStatus, DashboardStatusSlice } from "../data/dashboardProgress";
import { statusText, useLocale, useT } from "../i18n";

/**
 * 仪表盘「任务状态」饼图（Push 339 · 业务口径 2026-10-15「现在准备做这个任务状态的」+「鼠标触碰效果」
 * +「点击后效果」+「这些都要参考项目进度一览 之前都做过的」）：
 * 形态照业务参考图 —— 图例居中在顶、饼图居中、两侧色字标签 + 引线；悬停扇区出浮层卡、点扇区开只读
 * 「数据详情」（两者都走「项目进度」的既有交互；悬停卡 / 数据详情两个浮层的状态在父组件 HubDashboard）。
 *
 * 口径：
 * - 扇区 = 任务五态（DASHBOARD_STATUS_ORDER：进行中 / 已完成 / 待开始 / 提前完成 / 已延期），
 *   顺时针自 12 点起排；0 条的状态整条不出现 —— 业务口径「已延期也要的 只是没有相关的任务状态才没显示在图中」。
 * - 画布 1200 x 596（与「项目进度」同款 viewBox，等比缩放填满面板）；扇区 = 全直角扇形（各自从圆心出发、
 *   在圆心尖角相汇，没有缺口），扇区之间只留 1.5 单位白描边当分隔线 —— 业务口径「中间的缝不要」。
 * - 标签 = 状态名: 条数 (占比%)（占比两位小数），色字与引线同状态色；引线从扇区外缘中角出发、
 *   先沿半径外探一小段再连到标签；同侧标签按理想位从上往下摊开防重叠。
 * - 配色由 app.css 的 --hub-status 就地定义（.hub-dash-status [data-status] 与 .hub-dash-tip--status[data-status]）。
 */

const VIEW_W = 1200;
const VIEW_H = 596;
const CX = 600;
const CY = 330;
const R = 155;

/** 标签 / 图例字号（按参考图比例）。 */
const LABEL_FONT = 18;
const LEGEND_FONT = 16;
const LEGEND_SWATCH = 14;
const LEGEND_ITEM_GAP = 44;
/** 标签贴白卡左右内衬（与图内 x=40 同款，与「项目进度」同一竖线）。 */
const LABEL_PAD = 40;
const LABEL_Y_MIN = 96;
const LABEL_Y_MAX = 552;
/** 同侧标签最小行距。 */
const LABEL_MIN_GAP = 46;
/** 引线：沿半径外探长度 / 标签与引线端点间的留白。 */
const LEADER_STUB = 14;
const LEADER_END_GAP = 12;

type Pt = { readonly x: number; readonly y: number };

/** 角度（0 = 12 点，顺时针，单位度）→ 单位方向向量（屏幕坐标 y 向下）。 */
function dirOf(angle: number): Pt {
  const rad = (angle * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** 极坐标点（角度 0 = 12 点，顺时针）。 */
function polarOf(angle: number, radius: number): Pt {
  const direction = dirOf(angle);
  return { x: CX + direction.x * radius, y: CY + direction.y * radius };
}

/** 估算文本宽（CJK 按 1 em、其余 0.55 em；只服务图例居中与引线落点）。 */
function textWidthOf(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0x9fff ? fontSize : fontSize * 0.55;
  }
  return width;
}

/** 扇区路径（业务口径「中间的缝不要」· 全直角扇形，与业务参考图 / MUI 饼图同形）：圆心 → 外弧起点 →
 *  外弧终点 → 回圆心 Z；不在圆心留缺口、也不收圆角 —— 扇区之间只靠 1.5 单位的白描边（CSS）当分隔线。 */
function sectorPathOf(startAngle: number, endAngle: number): string {
  const outerLarge = endAngle - startAngle > 180 ? 1 : 0;
  const start = polarOf(startAngle, R);
  const end = polarOf(endAngle, R);
  return (
    "M " + CX.toFixed(2) + " " + CY.toFixed(2) +
    " L " + start.x.toFixed(2) + " " + start.y.toFixed(2) +
    " A " + R + " " + R + " 0 " + outerLarge + " 1 " + end.x.toFixed(2) + " " + end.y.toFixed(2) +
    " Z"
  );
}

export function HubDashStatus({ status, canDrill, onTip, onLeave, onPick, fontScale = 1 }: {
  readonly status: DashboardStatus;
  readonly canDrill: boolean;
  /** 悬停 / 移动扇区：父组件把鼠标位置换算成白卡坐标并出浮层卡（占比文本一并带上）。 */
  readonly onTip: (event: ReactMouseEvent<SVGGElement>, slice: DashboardStatusSlice, share: string) => void;
  /** 移出扇区：收起浮层卡。 */
  readonly onLeave: () => void;
  /** 点扇区：打开只读「数据详情」（仅选中具体项目时可点，由父组件按 canDrill 挂 onClick）。 */
  readonly onPick: (slice: DashboardStatusSlice) => void;
  /** 总览字号倍率（Push 360 · 业务口径 2026-10-16「文字不够清晰 那些小字还是要大一点」）：只有「数据总览」传 >1，单视图不传、逐值不变。 */
  readonly fontScale?: number;
}) {
  const t = useT();
  const locale = useLocale();
  /** 总览字号倍率（见上）：字号与随之变化的排版量都从这里取；倍率 1 时与旧值逐值一致。 */
  const fs = fontScale;
  const legendFont = LEGEND_FONT * fs;
  const labelFont = LABEL_FONT * fs;
  const labelMinGap = LABEL_MIN_GAP * fs;
  const slices = status.slices;
  if (slices.length === 0 || status.totalTasks <= 0) {
    return null;
  }
  /** 每片扇区：起止角 / 中角 / 占比文本（0 = 12 点，顺时针累加）。 */
  const arcs: Array<{ slice: DashboardStatusSlice; a0: number; a1: number; mid: number; share: string }> = [];
  let cursor = 0;
  for (const slice of slices) {
    const a0 = cursor;
    const a1 = cursor + (slice.count / status.totalTasks) * 360;
    cursor = a1;
    arcs.push({ slice, a0, a1, mid: (a0 + a1) / 2, share: ((slice.count / status.totalTasks) * 100).toFixed(2) + "%" });
  }
  /** 图例（居中）：状态色块 + 状态名（顺序 = 扇区顺序）。 */
  const legendItems: Array<{ slice: DashboardStatusSlice; text: string; x: number }> = [];
  const legendWidths = arcs.map((arc) => LEGEND_SWATCH + 8 + textWidthOf(statusText(locale, arc.slice.status), legendFont));
  const legendTotal = legendWidths.reduce((sum, width) => sum + width, 0) + LEGEND_ITEM_GAP * Math.max(legendWidths.length - 1, 0);
  let legendX = (VIEW_W - legendTotal) / 2;
  arcs.forEach((arc, index) => {
    legendItems.push({ slice: arc.slice, text: statusText(locale, arc.slice.status), x: legendX });
    legendX += legendWidths[index] + LEGEND_ITEM_GAP;
  });
  /** 标签：按中角投影的理想位分左右；同侧摊开防重叠（至少 LABEL_MIN_GAP），整体压回上下界。 */
  const labelItems = arcs.map((arc) => {
    const direction = dirOf(arc.mid);
    return { arc, right: direction.x >= 0, y: CY + direction.y * R * 1.06 };
  });
  for (const right of [false, true]) {
    const group = labelItems.filter((item) => item.right === right).sort((a, b) => a.y - b.y);
    for (let index = 1; index < group.length; index += 1) {
      group[index].y = Math.max(group[index].y, group[index - 1].y + labelMinGap);
    }
    const last = group[group.length - 1];
    if (last !== undefined && last.y > LABEL_Y_MAX) {
      const shiftDown = last.y - LABEL_Y_MAX;
      for (const item of group) {
        item.y -= shiftDown;
      }
    }
    const first = group[0];
    if (first !== undefined && first.y < LABEL_Y_MIN) {
      const shiftUp = LABEL_Y_MIN - first.y;
      for (const item of group) {
        item.y += shiftUp;
      }
    }
  }
  return (
    <svg className="hub-dash-status" viewBox={"0 0 " + VIEW_W + " " + VIEW_H} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("hub.dash.status.aria")}>
      {legendItems.map((item) => (
        <g key={"legend-" + item.slice.status}>
          <rect className="hub-dash-status__swatch" data-status={item.slice.status} x={item.x} y={9} width={LEGEND_SWATCH} height={LEGEND_SWATCH} rx={3} />
          <text className="hub-dash-status__legendText" x={item.x + LEGEND_SWATCH + 8} y={22 + (legendFont - LEGEND_FONT) * 0.35} fontSize={legendFont}>{item.text}</text>
        </g>
      ))}
      {arcs.map((arc) => (
        slices.length === 1 ? (
          <circle
            key={"arc-" + arc.slice.status}
            className="hub-dash-status__arc"
            data-status={arc.slice.status}
            data-drill={canDrill ? "true" : "false"}
            cx={CX}
            cy={CY}
            r={R}
            onMouseEnter={(event) => onTip(event, arc.slice, arc.share)}
            onMouseMove={(event) => onTip(event, arc.slice, arc.share)}
            onMouseLeave={onLeave}
            onClick={canDrill ? () => onPick(arc.slice) : undefined}
          />
        ) : (
          <path
            key={"arc-" + arc.slice.status}
            className="hub-dash-status__arc"
            data-status={arc.slice.status}
            data-drill={canDrill ? "true" : "false"}
            d={sectorPathOf(arc.a0, arc.a1)}
            onMouseEnter={(event) => onTip(event, arc.slice, arc.share)}
            onMouseMove={(event) => onTip(event, arc.slice, arc.share)}
            onMouseLeave={onLeave}
            onClick={canDrill ? () => onPick(arc.slice) : undefined}
          />
        )
      ))}
      {labelItems.map((item) => {
        const direction = dirOf(item.arc.mid);
        const attach = { x: CX + direction.x * (R - 1), y: CY + direction.y * (R - 1) };
        const bend = { x: CX + direction.x * (R + LEADER_STUB), y: CY + direction.y * (R + LEADER_STUB) };
        const text = statusText(locale, item.arc.slice.status) + ": " + item.arc.slice.count + " (" + item.arc.share + ")";
        const innerX = item.right ? VIEW_W - LABEL_PAD - textWidthOf(text, labelFont) - LEADER_END_GAP : LABEL_PAD + textWidthOf(text, labelFont) + LEADER_END_GAP;
        return (
          <g key={"label-" + item.arc.slice.status} data-status={item.arc.slice.status}>
            <polyline
              className="hub-dash-status__line"
              strokeWidth={1}
              fill="none"
              points={attach.x.toFixed(2) + "," + attach.y.toFixed(2) + " " + bend.x.toFixed(2) + "," + bend.y.toFixed(2) + " " + innerX.toFixed(2) + "," + item.y.toFixed(2)}
            />
            <text
              className="hub-dash-status__label"
              x={item.right ? VIEW_W - LABEL_PAD : LABEL_PAD}
              y={item.y + labelFont / 3}
              fontSize={labelFont}
              textAnchor={item.right ? "end" : "start"}
            >
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
