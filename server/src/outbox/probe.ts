import { Inject, Injectable } from "@nestjs/common";
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
  type OutboxAlertThresholds,
} from "./alert.js";
import { OUTBOX_REGISTRY } from "./dispatcher.js";
import type { OutboxTopicHandler } from "./handler.js";

/** 持续超阈值时允许复报的三类状态告警（死信另按水位线增量判断，不走本冷却）。 */
const REPEATABLE_ALERT_CODES = [
  "outbox.backlog",
  "outbox.oldest_due",
  "outbox.unconsumed_topic",
] as const;

type RepeatableAlertCode = (typeof REPEATABLE_ALERT_CODES)[number];

function isRepeatableAlertCode(code: OutboxAlertCode): code is RepeatableAlertCode {
  return REPEATABLE_ALERT_CODES.includes(code as RepeatableAlertCode);
}

/**
 * 告警探针（S7-1 · ADR-005：Outbox 积压量与最老消息年龄纳入告警；死信单条即时告警见 dispatcher）。
 * worker 周期调用；只覆盖「worker 活着但队列不健康」——进程级探活由部署侧探针负责（M11 告警接线登记）。
 *
 * 状态告警（积压 / 最老待领取 / 未消费主题）只在阈值跨越时首报，持续超限按
 * `OUTBOX_ALERT_REPEAT_MS` 复报，回到阈值内发恢复通知；状态在进程内，重启后会重新首报一次。
 */
@Injectable()
export class OutboxAlertProbe {
  /**
   * 死信水位线（M5-03-4 T5 反向发现修复）：dead_total 只增，探针只对「自上次上报以来的新增死信」告警 ——
   * 同一批死信在 1 小时窗口内不再每轮复报；即时告警（dispatcher `outbox.dead`）承担事件级通报。
   * 首次观测照发（重启后提醒窗口内死信）；总数回落（清理等异常）时重建基线。
   */
  private lastReportedDeadTotal: number | null = null;

  /** 持续态告警上次上报时刻；无记录 = 当前不在告警态，下一次命中按「阈值跨越」首报。 */
  private readonly lastRepeatableAlertAt = new Map<RepeatableAlertCode, number>();

  constructor(
    private readonly store: OutboxStore,
    @Inject(OUTBOX_ALERT_SINK) private readonly alerts: OutboxAlertSink,
    private readonly config: AppConfig,
    @Inject(OUTBOX_REGISTRY) private readonly registry: ReadonlyMap<OutboxTopic, OutboxTopicHandler>,
    private readonly clock: ClockService,
  ) {}

  /** 一轮探测：读快照 → 阈值 / 未消费主题判定 → 死信水位线 + 状态告警冷却 → 逐条发出。 */
  async probeOnce(): Promise<OutboxAlert[]> {
    const nowMs = this.clock.now().getTime();
    const thresholds = outboxAlertThresholdsFromEnv(this.config.env);
    const snapshot = await this.store.stats({ deadWindowMs: this.config.env.OUTBOX_ALERT_DEAD_WINDOW_MS });
    const evaluated = evaluateOutboxAlerts(snapshot, thresholds, new Set(this.registry.keys()));
    const fresh = evaluated.filter((alert) => this.isFreshDeadLetter(alert, snapshot));
    const alerts = this.applyStateAlertPolicy(fresh, evaluated, snapshot, thresholds, nowMs);
    for (const alert of alerts) {
      this.alerts.emit(alert);
    }
    return alerts;
  }

  /**
   * 状态告警收敛：首次超阈值立即报；持续超限仅在复报冷却到期时再报；回到阈值内只发一次恢复。
   * 死信告警保持原有水位线语义，不受本冷却影响。
   */
  private applyStateAlertPolicy(
    candidates: OutboxAlert[],
    evaluated: OutboxAlert[],
    snapshot: OutboxStatsSnapshot,
    thresholds: OutboxAlertThresholds,
    nowMs: number,
  ): OutboxAlert[] {
    const activeCodes = new Set(evaluated.map((alert) => alert.code));
    const repeatMs = this.config.env.OUTBOX_ALERT_REPEAT_MS;
    const emitted: OutboxAlert[] = [];

    for (const alert of candidates) {
      if (!isRepeatableAlertCode(alert.code)) {
        emitted.push(alert);
        continue;
      }
      const last = this.lastRepeatableAlertAt.get(alert.code);
      if (last === undefined || nowMs - last >= repeatMs) {
        this.lastRepeatableAlertAt.set(alert.code, nowMs);
        emitted.push(alert);
      }
    }

    for (const code of REPEATABLE_ALERT_CODES) {
      if (activeCodes.has(code)) {
        continue;
      }
      if (this.lastRepeatableAlertAt.delete(code)) {
        emitted.push(this.recoveryAlert(code, snapshot, thresholds));
      }
    }
    return emitted;
  }

  private recoveryAlert(
    code: RepeatableAlertCode,
    snapshot: OutboxStatsSnapshot,
    thresholds: OutboxAlertThresholds,
  ): OutboxAlert {
    switch (code) {
      case "outbox.backlog":
        return {
          code: "outbox.backlog.recovered",
          level: "warn",
          message: "outbox 待领取积压已恢复：当前 " + snapshot.duePending + " 条（阈值 " + thresholds.backlogMax + "）",
          detail: { duePending: snapshot.duePending },
        };
      case "outbox.oldest_due": {
        const current =
          snapshot.oldestDueMs === null ? "当前无待领取消息" : "当前最老 " + Math.round(snapshot.oldestDueMs / 1000) + "s";
        return {
          code: "outbox.oldest_due.recovered",
          level: "warn",
          message: "outbox 最老待领取已恢复：" + current + "（阈值 " + Math.round(thresholds.oldestDueMs / 1000) + "s）",
          detail: { oldestDueMs: snapshot.oldestDueMs },
        };
      }
      case "outbox.unconsumed_topic":
        return {
          code: "outbox.unconsumed_topic.recovered",
          level: "warn",
          message: "outbox 未消费主题已恢复：当前没有待领取的未注册主题",
          detail: { duePending: snapshot.duePending },
        };
      default:
        throw new Error("未知的 outbox 状态告警码：" + String(code));
    }
  }

  /**
   * 死信告警增量门槛：非死信告警一律放行；死信告警 = 首次观测或 dead_total 增加才放行。
   * 回落（清理 / 异常）→ 重建基线并放行本条（按「重新出现」处理），避免静默丢新死信。
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
