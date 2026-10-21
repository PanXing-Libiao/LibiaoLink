import { useState } from "react";
import { PROGRESS_LABELS, PROGRESS_STEPS, progressStep } from "../data/tasks";
import { progressLabelOf, textOf, useLocale } from "../i18n";

type TrackerProps = {
  progress: number;
  steps?: number;
  onChange?: (progress: number) => void;
  /** 炫彩档（Push 293 追订「炫彩下点这个进度条看不清」→「背景留白」→「带弧度的」→「胶囊的绿回到之前的版本」）：
   *  四格点底挖出一块胶囊白槽（rounded-full + bg-white），点回标配绿（点亮 emerald-500 / 空格 zinc-200）；缺省 = 原观感（简约 / 适中不改）。 */
  vivid?: boolean;
};

export const TRACKER_STEPS = PROGRESS_STEPS;

/** 档位名定义已收敛到 `data/tasks.ts` 的 `PROGRESS_LABELS`（导出报告同源引用）；此处保留历史导出名。 */
export const TRACKER_LABELS = PROGRESS_LABELS;

/** 格数换算与 `data/tasks.ts` 共用一套口径（Push 65 起任务状态与进度条联动）。 */
export const trackerStep = progressStep;

/** 点第 N 格的换算（口径见 §6.4）：点当前已点亮的最后一格回退一格（误点修正），其余点哪格就是几格。 */
export function trackerNextProgress(progress: number, step: number, steps: number = TRACKER_STEPS): number {
  const filled = trackerStep(progress, steps);
  const next = step === filled ? step - 1 : step;
  return next / steps;
}

/**
 * 四格进度点（从 `Tracker` 抽出，任务表 / 看板卡片这一行的「档位文字 + 四格点」用）：
 * 悬停 / 键盘聚焦即预览到该档，点击写进度；`hovered` 由父级持有 —— 抽屉要拿它把档位文字一起预览。
 */
export function TrackerDots({
  progress,
  steps = TRACKER_STEPS,
  hovered,
  onHoverChange,
  onChange,
  vivid = false,
}: {
  progress: number;
  steps?: number;
  /** 悬停 / 聚焦中的档位（0 = 没有）。 */
  hovered: number;
  onHoverChange: (step: number) => void;
  onChange?: (progress: number) => void;
  /** 炫彩档（Push 293 追订「背景留白」+「带弧度的」+「绿回标配」）：四格点外包一块胶囊白槽，点亮 = emerald-500、空格 = zinc-200 —— 白槽上清晰不打糊。 */
  vivid?: boolean;
}) {
  const locale = useLocale();
  const filled = trackerStep(progress, steps);

  return (
    <span
      className={"flex items-end gap-1" + (vivid ? " rounded-full bg-white px-2 py-1" : "")}
      onMouseLeave={() => {
        onHoverChange(0);
      }}
    >
      {Array.from({ length: steps }, (_item, index) => {
        const step = index + 1;
        const on = step <= filled || step <= hovered;
        return (
          <button
            key={step}
            type="button"
            aria-label={textOf(locale, "tracker.setAria", { name: progressLabelOf(locale, step) })}
            title={textOf(locale, "tracker.setTitle", { name: progressLabelOf(locale, step) })}
            onClick={(event) => {
              event.stopPropagation();
              onChange?.(trackerNextProgress(progress, step, steps));
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onMouseEnter={() => {
              onHoverChange(step);
            }}
            onFocus={() => {
              onHoverChange(step);
            }}
            onBlur={() => {
              onHoverChange(0);
            }}
            className={
              "block h-4 w-1.5 cursor-pointer rounded-sm transition-colors " +
              (on ? "bg-emerald-500" : "bg-zinc-200")
            }
          />
        );
      })}
    </span>
  );
}

/**
 * 进度条 + 条上四颗点（Push 98）：四颗点**平均分布**在进度条上（1/4、2/4、3/4、末尾各一颗，末尾那颗贴右端），
 * 点哪颗就写到哪一档、悬停 / 聚焦即预览 —— 任务详情抽屉的进度区用它（任务表另走 `Tracker` 的「档位文字 + 四格点」）。
 */
export function TrackerBar({
  progress,
  steps = TRACKER_STEPS,
  hovered,
  onHoverChange,
  onChange,
  barClassName,
  dotOnClassName,
}: {
  progress: number;
  steps?: number;
  /** 悬停 / 聚焦中的档位（0 = 没有）；悬停时填充也预览到该档。 */
  hovered: number;
  onHoverChange: (step: number) => void;
  onChange?: (progress: number) => void;
  /** 已填充部分的颜色（与任务状态联动：已完成 / 提前完成 = 绿、进行中 = 蓝、其余 = 灰）。 */
  barClassName: string;
  /** 点亮那几颗点的样子（实心 + 白描边，跟填充同一色系：绿 / 蓝 / 灰）。 */
  dotOnClassName: string;
}) {
  const locale = useLocale();
  const filled = trackerStep(progress, steps);
  const active = hovered > 0 ? hovered : filled;
  const pct = Math.round((active / steps) * 100);

  return (
    <span
      className="relative block h-3.5 w-full"
      onMouseLeave={() => {
        onHoverChange(0);
      }}
    >
      <span className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-zinc-100">
        <span
          className={"block h-full rounded-full transition-[width] duration-150 " + barClassName}
          style={{ width: pct + "%" }}
        />
      </span>
      {Array.from({ length: steps }, (_item, index) => {
        const step = index + 1;
        const on = step <= filled || step <= hovered;
        return (
          <button
            key={step}
            type="button"
            aria-label={textOf(locale, "tracker.setAria", { name: progressLabelOf(locale, step) })}
            title={textOf(locale, "tracker.setTitle", { name: progressLabelOf(locale, step) })}
            onClick={(event) => {
              event.stopPropagation();
              onChange?.(trackerNextProgress(progress, step, steps));
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onMouseEnter={() => {
              onHoverChange(step);
            }}
            onFocus={() => {
              onHoverChange(step);
            }}
            onBlur={() => {
              onHoverChange(0);
            }}
            className={
              "absolute top-1/2 h-2.5 w-2.5 cursor-pointer rounded-full border transition-colors " +
              (on ? dotOnClassName : "border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50")
            }
            style={
              step === steps
                ? { right: 0, transform: "translateY(-50%)" }
                : { left: (step / steps) * 100 + "%", transform: "translate(-50%, -50%)" }
            }
          />
        );
      })}
    </span>
  );
}

export function Tracker({ progress, steps = TRACKER_STEPS, onChange, vivid = false }: TrackerProps) {
  const [hovered, setHovered] = useState(0);
  const filled = trackerStep(progress, steps);
  const locale = useLocale();
  const active = hovered > 0 ? hovered : filled;
  const label = progressLabelOf(locale, active);

  return (
    <span className="flex shrink-0 items-center gap-2" title={textOf(locale, "tracker.overallTitle", { name: label })}>
      <span
        className={
          "w-12 text-right text-[11px] text-zinc-500 transition-opacity " + (hovered > 0 ? "opacity-100" : "opacity-0")
        }
      >
        {label}
      </span>
      <TrackerDots progress={progress} steps={steps} hovered={hovered} onHoverChange={setHovered} onChange={onChange} vivid={vivid} />
    </span>
  );
}