import { useEffect, useRef, useState } from "react";
import { lockBodyScroll } from "../scrollLock";
import { useT } from "../i18n";

/**
 * 导出等待浮层（2026-10-10 · §6.16 ⑳ · 业务口径「导出时间太长了要做加载动画提示用户 大概需要多长时间
 * 项目进展描述翻译中 预计需要XX秒」+「加载动画我想用我设计的svg小车移动 动画要美观」）：
 * 导出期间盖全屏浅色浮层，卡片里是品牌蓝小车（/libiaolink-car-icon.svg）沿流动虚线路面循环前进，
 * 下方给「项目进展描述翻译中…」+「预计需要 XX 秒 · 已完成 X / N 条」与进度条；打印窗口唤起前收起。
 *
 * 剩余秒数 = 实测吞吐外推：先验 1.0s/条（真机 47 条约 27–78s ≈ 0.55–1.65s/条，先验取偏慢值）与实测速率
 * 按 4 条样本权重混合，再加收尾固定项；显示值另加「上调限速」（见 MAX_RISE_PER_TICK）——正常场景只会
 * 一路变小，个别偏慢时最多按真实时间 2 倍速缓慢回调，秒数不跳涨。
 * 翻译完成（done >= total）后进入「正在生成报告…」态（一般一闪而过，随即唤起打印窗口）。
 */

export type ExportTranslateProgress = { done: number; total: number };

/** 先验：每条进展文本的墙钟耗时（含并发折算；实测 0.55–1.65s/条随负载波动，先验取偏慢的 1.0s —— 起手宁多不少）。 */
const PRIOR_SECONDS_PER_TEXT = 1.0;
/** 先验权重（条）：起步阶段把实测速率压稳，避免第 1 条快就报「还剩 3 秒」。 */
const PRIOR_WEIGHT = 4;
/** 收尾固定项：拼报告 + 唤起打印 + 兜底余量（秒）。 */
const TAIL_SECONDS = 3;
/** 秒数刷新间隔（毫秒）：250ms 一算，显示按整秒跳。 */
const TICK_MS = 250;
/** 上调限速（秒/跳）：预估允许按真实时间 2 倍速上抬（250ms 一跳 → 每次最多 +0.5s）。 */
const MAX_RISE_PER_TICK = 0.5;

/** 估算剩余秒数（导出浮层展示用；纯函数便于复查口径）。 */
export function estimateRemainingSeconds(elapsedSeconds: number, done: number, total: number): number {
  if (total <= 0 || done >= total) {
    return 0;
  }
  const left = total - done;
  if (done <= 0) {
    return Math.ceil(total * PRIOR_SECONDS_PER_TEXT + TAIL_SECONDS);
  }
  const rate = (elapsedSeconds + PRIOR_WEIGHT * PRIOR_SECONDS_PER_TEXT) / (done + PRIOR_WEIGHT);
  return Math.max(1, Math.ceil(rate * left + TAIL_SECONDS));
}

export type ExportProgressVariant = "overview" | "project-data";

export function ExportProgressOverlay({ progress, variant = "overview" }: { progress: ExportTranslateProgress | null; variant?: ExportProgressVariant }) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setElapsed(0);
    setRemaining(null);
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - startedAt.current) / 1000);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // 2026-10-10 修复「导出浮层打开时背景仍可滚动」（与变更详情弹窗同一现象）：等待期间锁背景滚动，
  // 浮层收起（导出结束 / 唤起打印窗口）即还原；同抽屉 / 弹窗口径（body overflow hidden + 滚动条宽度补偿）。
  useEffect(() => lockBodyScroll(), []);

  const done = progress === null ? 0 : progress.done;
  const total = progress === null ? 0 : progress.total;
  const waiting = total <= 0;
  const translating = !waiting && done < total;
  const projectData = variant === "project-data";
  const fresh = estimateRemainingSeconds(elapsed, done, total);
  const displayed = remaining === null ? fresh : remaining;
  const percent = waiting ? 0 : Math.min(100, Math.round((done / total) * 100));

  useEffect(() => {
    setRemaining((previous) => {
      if (previous === null || total <= 0 || done >= total) {
        return fresh;
      }
      return Math.min(fresh, previous + MAX_RISE_PER_TICK);
    });
  }, [elapsed, done, total, fresh]);

  return (
    <div className="export-progress" role="status" aria-live="polite" data-export-progress={variant}>
      <div className="export-progress__card">
        <div className="export-progress__stage" aria-hidden="true">
          <span className="export-progress__road" />
          <span className="export-progress__cart">
            <span className="export-progress__cart-shadow" />
            <span className="export-progress__cart-bob">
              <img className="export-progress__cart-img" src="/libiaolink-car-icon.svg" alt="" />
              <span className="export-progress__trail export-progress__trail--long" />
              <span className="export-progress__trail export-progress__trail--short" />
            </span>
          </span>
        </div>
        <p className="export-progress__title">{projectData ? t("exp.projectData.title") : waiting || translating ? t("exp.translating") : t("exp.generating")}</p>
        <p className="export-progress__hint">
          {projectData
            ? t("exp.projectData.hint")
            : waiting
              ? t("exp.preparing")
              : translating
                ? (
                    <>
                      {t("exp.etaLead")}<span className="export-progress__num">{Math.max(1, Math.round(displayed))}</span>{t("exp.etaTail", { d: done, t: total })}
                    </>
                  )
                : t("exp.ready")}
        </p>
        <div className={"export-progress__bar" + (waiting || projectData ? " is-waiting" : "")}>
          <span className="export-progress__bar-fill" style={waiting || projectData ? undefined : { width: percent + "%" }} />
        </div>
      </div>
    </div>
  );
}
