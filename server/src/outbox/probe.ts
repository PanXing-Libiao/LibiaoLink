import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OutboxTopic } from "@libiaolink/contracts";
import { ClockService } from "../common/clock/clock.service.js";
import { AppConfig } from "../config/config.module.js";
import { OutboxStore, type OutboxStatsSnapshot } from "../db/outbox.store.js";
import {
  evaluateOutboxAlerts,
  outboxAlertThresholdsFromEnv,
  OUTBOX_ALERT_SINK,
  type OutboxAlert,
  type OutboxAlertCode,
  type OutboxAlertSink,
  type OutboxDailyDigestRecovery,
} from "./alert.js";
import { OUTBOX_REGISTRY } from "./dispatcher.js";
import type { OutboxTopicHandler } from "./handler.js";

/** 需要持续态门禁的即时告警（积压 / 最老合并为队列停滞；未消费主题单独门禁）。 */
const REPEATABLE_ALERT_CODES = ["outbox.queue_stalled", "outbox.unconsumed_topic"] as const;

type RepeatableAlertCode = (typeof REPEATABLE_ALERT_CODES)[number];

/**
 * 告警探针（S7-1 · ADR-005）：
 * - 即时告警只发「有处置动作」的事件：死信（dispatcher 直发）、队列停滞、未消费主题；
 * - `backlog` / `oldest_due` 只是内部信号：必须持续无消费进度才合并成 `outbox.queue_stalled`；
 * - `dead_letter`、恢复通知和日常统计只进日报，不再即时推送；
 * - 无处置动作的告警由出口回退日志，不升级为企微消息。
 */
@Injectable()
export class OutboxAlertProbe {
  private readonly logger = new Logger("OutboxAlertProbe");

  /**
   * 死信水位线：dead_total 只增，探针只对「自上次记录以来的新增死信」写日志；
   * 同一批死信不每轮重复，日报再按窗口汇总。
   */
  private lastReportedDeadTotal: number | null = null;

  /** 当前仍在告警态的即时告警；有记录 = 已经推送过并等待恢复。 */
  private readonly lastActiveAlertAt = new Map<RepeatableAlertCode, number>();

  /** 连续无完成进度的探针次数；达到阈值才把积压 / 最老信号升级为队列停滞告警。 */
  private stalledProbes = 0;

  /** 已恢复但尚未进入日报的事件。 */
  private readonly digestRecoveries: OutboxDailyDigestRecovery[] = [];

  constructor(
    private readonly store: OutboxStore,
    @Inject(OUTBOX_ALERT_SINK) private readonly alerts: OutboxAlertSink,
    private readonly config: AppConfig,
    @Inject(OUTBOX_REGISTRY) private readonly registry: ReadonlyMap<OutboxTopic, OutboxTopicHandler>,
    private readonly clock: ClockService,
  ) {}

  /** 一轮探测：读快照 → 判定信号 → 仅发送可执行即时告警；其余写结构化日志。 */
  async probeOnce(): Promise<OutboxAlert[]> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const env = this.config.env;
    const thresholds = outboxAlertThresholdsFromEnv(env);
    const snapshot = await this.store.stats({
      deadWindowMs: env.OUTBOX_ALERT_DEAD_WINDOW_MS,
      progressWindowMs: env.OUTBOX_ALERT_PROGRESS_WINDOW_MS,
    });
    const evaluated = evaluateOutboxAlerts(snapshot, thresholds, new Set(this.registry.keys()));
    const byCode = new Map(evaluated.map((alert) => [alert.code, alert]));
    const emitted: OutboxAlert[] = [];

    const backlogSignal = byCode.get("outbox.backlog");
    const oldestSignal = byCode.get("outbox.oldest_due");
    if (backlogSignal !== undefined || oldestSignal !== undefined) {
      this.logQueueSignals(backlogSignal, oldestSignal, snapshot);
    }

    const queuePressure = backlogSignal !== undefined || oldestSignal !== undefined;
    const stalled = this.observeQueueProgress(
      queuePressure,
      snapshot,
      env.OUTBOX_ALERT_PROGRESS_WINDOW_MS,
      env.OUTBOX_ALERT_STALL_PROBES,
    );
    if (stalled) {
      const alert = this.queueStalledAlert(snapshot, env.OUTBOX_ALERT_PROGRESS_WINDOW_MS);
      if (this.shouldEmitState("outbox.queue_stalled", nowMs)) {
        emitted.push(alert);
      }
    } else if (this.lastActiveAlertAt.delete("outbox.queue_stalled")) {
      this.recordRecovery(
        "outbox.queue_stalled.recovered",
        "outbox 队列停滞已恢复：" + describeQueueState(snapshot),
        now,
      );
    }

    const unconsumed = byCode.get("outbox.unconsumed_topic");
    if (unconsumed !== undefined) {
      if (this.shouldEmitState("outbox.unconsumed_topic", nowMs)) {
        emitted.push(unconsumed);
      }
    } else if (this.lastActiveAlertAt.delete("outbox.unconsumed_topic")) {
      this.recordRecovery(
        "outbox.unconsumed_topic.recovered",
        "outbox 未消费主题已恢复：当前没有待领取的未注册主题",
        now,
      );
    }

    const deadLetterSignal = byCode.get("outbox.dead_letter");
    if (deadLetterSignal !== undefined && this.isFreshDeadLetter(deadLetterSignal, snapshot)) {
      this.logSignal(deadLetterSignal, "死信汇总进入日报");
    }

    for (const alert of emitted) {
      this.alerts.emit(alert);
    }
    return emitted;
  }

  /** 取出并清空已恢复事件，供固定 08:00 管理员日报计数（不展示具体 ID / 对象名）。 */
  drainDailyDigestRecoveries(): OutboxDailyDigestRecovery[] {
    const result = [...this.digestRecoveries];
    this.digestRecoveries.length = 0;
    return result;
  }

  private shouldEmitState(code: RepeatableAlertCode, nowMs: number): boolean {
    const last = this.lastActiveAlertAt.get(code);
    if (last !== undefined && nowMs - last < this.config.env.OUTBOX_ALERT_REPEAT_MS) {
      return false;
    }
    this.lastActiveAlertAt.set(code, nowMs);
    return true;
  }

  private observeQueueProgress(
    queuePressure: boolean,
    snapshot: OutboxStatsSnapshot,
    progressWindowMs: number,
    stallProbes: number,
  ): boolean {
    if (!queuePressure) {
      this.stalledProbes = 0;
      return false;
    }
    if (snapshot.doneRecent > 0) {
      this.stalledProbes = 0;
      this.logger.warn(
        "outbox 信号仅记录：仍有消费进度，不升级即时告警（doneRecent=" +
          snapshot.doneRecent +
          " / " +
          Math.round(progressWindowMs / 60_000) +
          "min）",
      );
      return false;
    }
    this.stalledProbes += 1;
    this.logger.warn("outbox 疑似停滞：连续无完成 " + this.stalledProbes + "/" + stallProbes + " 轮");
    return this.stalledProbes >= stallProbes;
  }

  private queueStalledAlert(snapshot: OutboxStatsSnapshot, progressWindowMs: number): OutboxAlert {
    const windowMinutes = Math.max(1, Math.round(progressWindowMs / 60_000));
    return {
      code: "outbox.queue_stalled",
      level: "error",
      message:
        "outbox 队列停滞：待领取 " +
        snapshot.duePending +
        " 条，最老等待 " +
        formatOldest(snapshot.oldestDueMs) +
        "，近 " +
        windowMinutes +
        " 分钟完成 0 条",
      impact: "新通知、预览或规则任务可能延迟；积压期间用户可能收不到消息。",
      action: "检查 worker 进程 / 容器状态与心跳日志、outbox_events 待领取主题及下游（数据库 / 企微限速）；修复后确认 duePending 开始下降。",
      detail: {
        duePending: snapshot.duePending,
        oldestDueMs: snapshot.oldestDueMs,
        doneRecent: snapshot.doneRecent,
        stalledProbes: this.stalledProbes,
        byTopic: snapshot.byTopic.slice(0, 5),
      },
    };
  }

  private logQueueSignals(
    backlog: OutboxAlert | undefined,
    oldest: OutboxAlert | undefined,
    snapshot: OutboxStatsSnapshot,
  ): void {
    const messages = [backlog?.message, oldest?.message].filter((item): item is string => item !== undefined);
    this.logger.warn(
      "outbox 信号仅记录（不即时推送）：" +
        messages.join("；") +
        "；进度窗口完成 " +
        snapshot.doneRecent +
        " 条",
    );
  }

  private logSignal(alert: OutboxAlert, note: string): void {
    this.logger.warn("outbox 信号仅记录（不即时推送）：" + alert.code + " · " + alert.message + "；" + note);
  }

  private recordRecovery(code: OutboxAlertCode, message: string, now: Date): void {
    this.digestRecoveries.push({ code, message, at: now.toISOString() });
    this.logger.log("outbox 恢复（降级日报）：" + code + " · " + message);
  }

  /**
   * 死信告警增量门槛：非死信一律放行；死信 = 首次观测或 dead_total 增加才放行。
   * 回落（清理 / 异常）→ 重建基线并放行本条，避免静默丢新死信。
   */
  private isFreshDeadLetter(alert: OutboxAlert, snapshot: OutboxStatsSnapshot): boolean {
    if (alert.code !== "outbox.dead_letter") {
      return true;
    }
    const last = this.lastReportedDeadTotal;
    if (last !== null && snapshot.deadTotal < last) {
      this.lastReportedDeadTotal = snapshot.deadTotal;
      return true;
    }
    if (last !== null && snapshot.deadTotal === last) {
      return false;
    }
    this.lastReportedDeadTotal = snapshot.deadTotal;
    return true;
  }
}

function formatOldest(oldestDueMs: number | null): string {
  return oldestDueMs === null ? "无" : Math.round(oldestDueMs / 1000) + "s";
}

function describeQueueState(snapshot: OutboxStatsSnapshot): string {
  return "当前待领取 " + snapshot.duePending + " 条，最老 " + formatOldest(snapshot.oldestDueMs);
}
