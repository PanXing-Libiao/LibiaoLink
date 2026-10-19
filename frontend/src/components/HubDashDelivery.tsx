import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { DASHBOARD_DELIVERY_ORDER, type DashboardDelivery, type DashboardDeliveryBucket } from "../data/dashboardProgress";
import { statusText, useLocale, useT } from "../i18n";

/**
 * 仪表盘「交付时间」视图（Push 345 · 业务口径 2026-10-16「这个交付时间也要做一个图表 但是它的这个逻辑我没搞懂
 * 感觉也不好 请你重新设计一个告诉我」+「选择B方案 叫交付时间 加一个「按时率」的小结」；
 * Push 346 追订「取消提前完成展示」（提前完成并入按时交付、不再单独占一档）+「点击也要进入详情的」
 * （点「按时率」小结 / 点「未到交付节点」注记也开只读「数据详情」））：
 * 三结果竖直柱状图（按时交付 / 逾期已交付 / 逾期未交付，提前完成并入按时交付）+ 右上「按时率」小结 +
 * 「未到交付节点」注记；柱顶数字 + 柱下类别名；悬停柱出浮层卡（记录数 / 占比）、悬停按时率出公式卡；
 * 点柱 / 点按时率 / 点注记都开只读「数据详情」（选中具体项目才可点 —— 与柱段 / 扇区 / 问题柱同一套口径）。
 * 画布 1200 x 596（与其他视图同款 viewBox，等比缩放填满面板）；口径见 data/dashboardProgress.ts 的 buildDashboardDelivery。
 */

const VIEW_W = 1200;
const VIEW_H = 596;
/** 绘图区（左上让位纵轴刻度、右上让位「按时率」小结 + 注记）。 */
const PLOT_X0 = 96;
const PLOT_X1 = 1160;
const TOP = 118;
const AXIS_Y = 504;
/** 类别名基线（x 轴之下）。 */
const TICK_LABEL_Y = 542;
const SLOT_W = (PLOT_X1 - PLOT_X0) / DASHBOARD_DELIVERY_ORDER.length;
const BAR_W = 132;
const BAR_RADIUS = 8;
/** 悬停命中区宽度（整槽，柱太矮也好点中；< SLOT_W 避免相邻槽串扰）。 */
const HIT_W = 210;
/** 「按时率」小结命中区（含注记）。 */
const RATE_HIT_X = 840;
const RATE_HIT_Y = 6;
const RATE_HIT_W = 336;
const RATE_HIT_H = 100;
/** 「未到交付节点」注记命中区（Push 346；压在按时率命中区之上，只认注记那一行）。 */
const NOTE_HIT_X = PLOT_X1 - 330;
const NOTE_HIT_Y = 72;
const NOTE_HIT_W = 330;
const NOTE_HIT_H = 34;

/** 图表入场动画错峰（Push 357 · 业务口径 2026-10-16「这些图表需要有动画效果 柱状图饼状图」+「颜色色调组件都不要改 只要加动画效果」）：三根柱按序 90ms；柱顶数字 300ms 后起淡入（与柱同刻落定）。 */
const SERIES_ANIM_STAGGER = 90;
const NUM_ANIM_OFFSET = 300;

/** y 轴刻度步长：按最大柱挑 1 / 2 / 5 / 10 / 20（比行式图更粗一档 —— 三根柱的分布一眼可读）。 */
function tickStepOf(maxCount: number): number {
  if (maxCount <= 6) {
    return 1;
  }
  if (maxCount <= 12) {
    return 2;
  }
  if (maxCount <= 30) {
    return 5;
  }
  if (maxCount <= 60) {
    return 10;
  }
  return 20;
}

/** 轴上限：给最大柱留约 8% 余量再进到整步。 */
function tickMaxOf(maxCount: number): { max: number; step: number } {
  const step = tickStepOf(Math.max(maxCount, 1));
  const target = Math.ceil((Math.max(maxCount, 1) * 1.08) / step) * step;
  return { max: Math.max(step, target), step };
}

/** 顶部圆角柱路径（底边贴基线不收圆角）。 */
function barPathOf(x: number, top: number, width: number, height: number): string {
  const radius = Math.min(BAR_RADIUS, height / 2, width / 2);
  return "M " + x + " " + (top + height) + " L " + x + " " + (top + radius) + " Q " + x + " " + top + " " + (x + radius) + " " + top + " L " + (x + width - radius) + " " + top + " Q " + (x + width) + " " + top + " " + (x + width) + " " + (top + radius) + " L " + (x + width) + " " + (top + height) + " Z";
}

export function HubDashDelivery({ delivery, canDrill, onTip, onRateTip, onLeave, onPick, onRatePick, onNotePick, fontScale = 1 }: {
  readonly delivery: DashboardDelivery;
  readonly canDrill: boolean;
  readonly onTip: (event: ReactMouseEvent<SVGRectElement>, bucket: DashboardDeliveryBucket, count: number, share: string) => void;
  readonly onRateTip: (event: ReactMouseEvent<SVGRectElement>) => void;
  readonly onLeave: () => void;
  readonly onPick: (bucket: DashboardDeliveryBucket) => void;
  /** 点「按时率」小结（Push 346 · 业务口径「点击也要进入详情的」）：开按时交付口径的数据详情（与按时交付柱同一筛选）。 */
  readonly onRatePick: () => void;
  /** 点「未到交付节点」注记（Push 346）：开未到交付节点口径的数据详情（注记里那 N 条本体）。 */
  readonly onNotePick: () => void;
  /** 总览字号倍率（Push 360 · 业务口径 2026-10-16「文字不够清晰 那些小字还是要大一点」）：只有「数据总览」传 >1，单视图不传、逐值不变。 */
  readonly fontScale?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const [hoverBucket, setHoverBucket] = useState<DashboardDeliveryBucket | null>(null);
  /** 总览字号倍率（见上）：字号与随之变化的排版量都从这里取（右上「按时率」大数不动）；倍率 1 时与旧值逐值一致。 */
  const fs = fontScale;
  const tickFont = 12.5 * fs;
  const countFont = 20 * fs;
  const nameFont = 17 * fs;
  const rateLabelFont = 14 * fs;
  const rateNoteFont = 12.5 * fs;
  const maxCount = delivery.counts.reduce((max, count) => Math.max(max, count), 0);
  const { max: tickMax, step } = tickMaxOf(maxCount);
  const unit = (AXIS_Y - TOP) / tickMax;
  const ticks: number[] = [];
  for (let value = 0; value <= tickMax; value += step) {
    ticks.push(value);
  }
  const yOf = (value: number): number => AXIS_Y - value * unit;
  return (
    <svg className="hub-dash-delivery" viewBox={"0 0 " + VIEW_W + " " + VIEW_H} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("hub.dash.delivery.aria")}>
      {ticks.map((value) => (
        <g key={value}>
          {value > 0 ? <line className="hub-dash-delivery__grid" x1={PLOT_X0} y1={yOf(value)} x2={PLOT_X1} y2={yOf(value)} /> : null}
          <text className="hub-dash-delivery__tick" x={PLOT_X0 - 14} y={yOf(value) + tickFont * 0.36} textAnchor="end" fontSize={tickFont}>{value}</text>
        </g>
      ))}
      <line className="hub-dash-delivery__axis" x1={PLOT_X0 - 6} y1={AXIS_Y} x2={PLOT_X1 + 6} y2={AXIS_Y} />
      {DASHBOARD_DELIVERY_ORDER.map((bucket, index) => {
        const count = delivery.counts[index];
        const x = PLOT_X0 + SLOT_W * index + (SLOT_W - BAR_W) / 2;
        const barTop = yOf(count);
        const cx = x + BAR_W / 2;
        const share = delivery.total === 0 ? "0.00%" : ((count / delivery.total) * 100).toFixed(2) + "%";
        return (
          <g key={bucket}>
            {count > 0 ? (
              <path className="hub-dash-delivery__bar" data-bucket={bucket} data-hover={hoverBucket === bucket ? "true" : "false"} data-drill={canDrill ? "true" : "false"} style={{ animationDelay: index * SERIES_ANIM_STAGGER + "ms" }} d={barPathOf(x, barTop, BAR_W, AXIS_Y - barTop)} />
            ) : null}
            <text className="hub-dash-delivery__count" data-bucket={bucket} style={{ animationDelay: index * SERIES_ANIM_STAGGER + NUM_ANIM_OFFSET + "ms" }} x={cx} y={count > 0 ? barTop - countFont * 0.6 : AXIS_Y - 14} textAnchor="middle" fontSize={countFont} fontWeight={700}>{count}</text>
            <text className="hub-dash-delivery__name" x={cx} y={TICK_LABEL_Y} textAnchor="middle" fontSize={nameFont}>{statusText(locale, bucket)}</text>
            <rect
              className="hub-dash-delivery__hit"
              data-bucket={bucket}
              data-drill={canDrill ? "true" : "false"}
              x={cx - HIT_W / 2}
              y={TOP - 26}
              width={HIT_W}
              height={AXIS_Y - TOP + 46}
              onMouseEnter={(event) => {
                setHoverBucket(bucket);
                onTip(event, bucket, count, share);
              }}
              onMouseMove={(event) => onTip(event, bucket, count, share)}
              onMouseLeave={() => {
                setHoverBucket(null);
                onLeave();
              }}
              onClick={canDrill ? () => onPick(bucket) : undefined}
            />
          </g>
        );
      })}
      <text className="hub-dash-delivery__rateLabel" x={PLOT_X1} y={30} textAnchor="end" fontSize={rateLabelFont}>{t("hub.dash.delivery.rate")}</text>
      <text className="hub-dash-delivery__rateValue" x={PLOT_X1} y={64} textAnchor="end" fontSize={32} fontWeight={700}>{delivery.onTimeRate === null ? "—" : delivery.onTimeRate + "%"}</text>
      {delivery.pendingCount > 0 ? (
        <text className="hub-dash-delivery__rateNote" x={PLOT_X1} y={90} textAnchor="end" fontSize={rateNoteFont}>{t("hub.dash.delivery.note", { n: delivery.pendingCount })}</text>
      ) : null}
      <rect className="hub-dash-delivery__rateHit" data-drill={canDrill ? "true" : "false"} x={RATE_HIT_X} y={RATE_HIT_Y} width={RATE_HIT_W} height={RATE_HIT_H} onMouseEnter={onRateTip} onMouseMove={onRateTip} onMouseLeave={onLeave} onClick={canDrill ? onRatePick : undefined} />
      {delivery.pendingCount > 0 ? (
        <rect className="hub-dash-delivery__noteHit" data-drill={canDrill ? "true" : "false"} x={NOTE_HIT_X} y={NOTE_HIT_Y} width={NOTE_HIT_W} height={NOTE_HIT_H} onClick={canDrill ? onNotePick : undefined} />
      ) : null}
    </svg>
  );
}
