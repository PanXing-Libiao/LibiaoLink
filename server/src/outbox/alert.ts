import { Injectable, Logger } from "@nestjs/common";
import type { Env } from "../config/env.js";
import type { OutboxStatsSnapshot } from "../db/outbox.store.js";

/** 告警出口令牌（S7-1）：默认结构化日志；M5-03/04 通知模块可替换为企微 / 站内信实现。 */
export const OUTBOX_ALERT_SINK = Symbol("OUTBOX_ALERT_SINK");

export type OutboxAlertCode =
  | "outbox.dead"
  | "outbox.backlog"
  | "outbox.oldest_due"
  | "outbox.dead_letter"
  | "outbox.unconsumed_topic"
  | "outbox.backlog.recovered"
  | "outbox.oldest_due.recovered"
  | "outbox.unconsumed_topic.recovered";

export interface OutboxAlert {
  code: OutboxAlertCode;
  level: "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
}

export interface OutboxAlertSink {
  emit(alert: OutboxAlert): void;
}

/** 探针阈值：env 解析入口见 outboxAlertThresholdsFromEnv。 */
export interface OutboxAlertThresholds {
  backlogMax: number;
  oldestDueMs: number;
  deadRecentMax: number;
}

export function outboxAlertThresholdsFromEnv(env: Env): OutboxAlertThresholds {
  return {
    backlogMax: env.OUTBOX_ALERT_BACKLOG_MAX,
    oldestDueMs: env.OUTBOX_ALERT_OLDEST_MS,
    deadRecentMax: env.OUTBOX_ALERT_DEAD_RECENT_MAX,
  };
}

/**
 * 阈值判定（纯函数，S7-1）：积压条数 / 最老待领取年龄 / 近期新增死信。
 * 消息里带主题明细（截前 5 个）—— 积压排查第一眼要看「卡在哪个主题」；同时对照当前注册表，
 * 单独报告「有待领取行但无消费者」的配置漂移（drain-only 主题已在注册表内，不会被误报）。
 */
export function evaluateOutboxAlerts(
  stats: OutboxStatsSnapshot,
  thresholds: OutboxAlertThresholds,
  registeredTopics: ReadonlySet<string>,
): OutboxAlert[] {
  const alerts: OutboxAlert[] = [];
  const byTopic = stats.byTopic.slice(0, 5);
  if (stats.duePending > thresholds.backlogMax) {
    alerts.push({
      code: "outbox.backlog",
      level: "warn",
      message: "outbox 待领取积压 " + stats.duePending + " 条（阈值 " + thresholds.backlogMax + "）",
      detail: { duePending: stats.duePending, byTopic },
    });
  }
  const unconsumedByTopic = stats.byTopic.filter((item) => item.due > 0 && !registeredTopics.has(item.topic));
  if (unconsumedByTopic.length > 0) {
    const unconsumedPending = unconsumedByTopic.reduce((sum, item) => sum + item.due, 0);
    alerts.push({
      code: "outbox.unconsumed_topic",
      level: "error",
      message:
        "outbox 有 " +
        unconsumedByTopic.length +
        " 个待领取主题无消费者（共 " +
        unconsumedPending +
        " 条）",
      detail: { duePending: unconsumedPending, byTopic: unconsumedByTopic.slice(0, 5) },
    });
  }
  if (stats.oldestDueMs !== null && stats.oldestDueMs > thresholds.oldestDueMs) {
    alerts.push({
      code: "outbox.oldest_due",
      level: "error",
      message:
        "outbox 最老待领取消息已等待 " +
        Math.round(stats.oldestDueMs / 1000) +
        "s（阈值 " +
        Math.round(thresholds.oldestDueMs / 1000) +
        "s）",
      detail: { oldestDueMs: stats.oldestDueMs, byTopic },
    });
  }
  if (stats.deadRecent >= thresholds.deadRecentMax) {
    alerts.push({
      code: "outbox.dead_letter",
      level: "error",
      message:
        "outbox 近期新增死信 " + stats.deadRecent + " 条（阈值 " + thresholds.deadRecentMax + "；累计 " + stats.deadTotal + "）",
    });
  }
  return alerts;
}

/** 默认告警出口：结构化日志（worker 由 nestjs-pino 承接；后续替换实现即可接企微）。 */
@Injectable()
export class LogOutboxAlertSink implements OutboxAlertSink {
  private readonly logger = new Logger("OutboxAlert");

  emit(alert: OutboxAlert): void {
    const detail = alert.detail === undefined ? "" : " —— " + JSON.stringify(alert.detail);
    const text = "outbox 告警 [" + alert.code + "]：" + alert.message + detail;
    if (alert.level === "error") {
      this.logger.error(text);
    } else {
      this.logger.warn(text);
    }
  }
}
