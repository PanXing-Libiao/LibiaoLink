/**
 * 企微告警群出口（M5-03-3 · 管理员告警 B2 / 技术设计v0.3 §4.10）：OUTBOX_ALERT_SINK 的企微群实现 ——
 * 告警文本经智能机器人长连接（aibot_send_msg · chatid）推管理员告警群；发送失败 / 未配置回退
 * LogOutboxAlertSink（结构化日志），防告警链自断。
 * 抑制：同族在 ALERT_SUPPRESS_MS 窗口内只发首条（防告警风暴 —— 实施方案 §六 口径；被抑条目记日志）；
 * `outbox.dead` 与 `outbox.dead_letter` 同族，避免死信事件与探针双报。
 * 可执行性：没有 `action` 的告警不推群，只回退 `LogOutboxAlertSink`；恢复通知与死信汇总由 `emitDigest` 进日报。
 * 文案（核心语义口径 · 2026-10-13）：code + message（+ 积压主题明细紧凑行）—— 不再原样回显 detail JSON、
 * 企微 errmsg 机器尾巴（hint / from ip / more info）与 kind / state 内部态（源头收敛见 describeWecomFailure）。
 * 安全：chatid 掩码（末 4 位），日志不回显全文；detail 由调用方保证不含凭据。
 */
import { Logger } from "@nestjs/common";
import { maskChatid, WecomAibotClient } from "../modules/notify/index.js";
import type { OutboxAlert, OutboxAlertSink, OutboxDailyDigest } from "./alert.js";
import {
  formatDailyDigestRange,
  formatShanghaiDateTime,
} from "./daily-digest.js";

/**
 * 告警抑制窗口（15 分钟 = 3 × 探针周期）：> 探针周期才不会被「窗口 ≈ 周期」的轮询竞态穿透
 * （M5-03-4 T5 反向发现：5 分钟窗口与 5 分钟探针同拍 → 每轮都放行）。
 */
export const ALERT_SUPPRESS_MS = 900_000;

/** 抑制族：死信即时（outbox.dead）与探针（outbox.dead_letter）归为一族 —— 同一条死信不双报。 */
export function alertSuppressFamily(code: OutboxAlert["code"]): string {
  return code === "outbox.dead_letter" ? "outbox.dead" : code;
}

/** 告警文本：头部 + 核心语义 message（+ 主题明细 / 影响 / 处置）；不再原样回显 detail JSON。 */
export function composeAlertText(alert: OutboxAlert): string {
  const breakdown = topicBreakdownLine(alert.detail);
  const impact = alert.impact === undefined || alert.impact.trim() === "" ? "" : "\n影响：" + alert.impact;
  const action = alert.action === undefined || alert.action.trim() === "" ? "" : "\n处置：" + alert.action;
  return (
    "【LibiaoLink 告警】" +
    alert.code +
    "\n" +
    alert.message +
    (breakdown === null ? "" : "\n" + breakdown) +
    impact +
    action
  );
}

/** 管理员日报：固定 08:00、昨日自然日、交付结果 / 自动降级 / 重复问题 / 必要结论。 */
export function composeDigestText(report: OutboxDailyDigest): string {
  const lines = [
    "【LibiaoLink 管理员日报】" + formatShanghaiDateTime(new Date(report.reportAt)),
    "统计范围：" + formatDailyDigestRange(new Date(report.reportAt)),
  ];
  const fallbackCount = report.automaticFallbacks.reduce((sum, item) => sum + item.count, 0);
  const quiet =
    report.delivery.failed === 0 &&
    report.delivery.retrying === 0 &&
    report.delivery.lateDelivered === 0 &&
    fallbackCount === 0 &&
    report.repeatedIssues.length === 0 &&
    report.recoveries.total === 0;

  if (quiet) {
    lines.push(
      report.delivery.total === 0
        ? "昨日无通知投递；无自动降级，无重复问题。"
        : "昨日通知 " + String(report.delivery.total) + " 条全部送达；无自动降级，无重复问题。",
    );
    return lines.join("\n");
  }

  lines.push("");
  if (report.delivery.total === 0) {
    lines.push("昨日无通知投递。");
  } else {
    lines.push("昨日通知 " + String(report.delivery.total) + " 条（按消息去重）：");
    lines.push(
      "送达 " +
        String(report.delivery.delivered) +
        " · 待重试 " +
        String(report.delivery.retrying) +
        " · 最终失败 " +
        String(report.delivery.failed),
    );
  }
  if (report.delivery.lateDelivered > 0) {
    const longest =
      report.delivery.maxLatencyMs === null ? null : formatLatency(report.delivery.maxLatencyMs);
    lines.push(
      "超过 5 分钟送达 " +
        String(report.delivery.lateDelivered) +
        " 条" +
        (longest === null ? "" : "，最长等待 " + longest),
    );
  }

  if (fallbackCount > 0) {
    lines.push("");
    lines.push("自动降级 " + String(fallbackCount) + " 次（均已兜底，无需处理）：");
    for (const item of report.automaticFallbacks) {
      lines.push(
        "• " +
          item.label +
          " " +
          String(item.count) +
          " 条" +
          (item.detail.trim() === "" ? "" : "：" + item.detail),
      );
    }
  }

  lines.push("");
  lines.push("重复问题：");
  if (report.repeatedIssues.length === 0) {
    lines.push("• 无");
  } else {
    for (const issue of report.repeatedIssues) {
      lines.push("• " + composeRepeatedIssue(issue));
    }
  }

  if (report.recoveries.total > 0) {
    lines.push("");
    lines.push(
      "已恢复 " +
        String(report.recoveries.total) +
        " 项：" +
        report.recoveries.byCode.map((item) => recoveryLabel(item.code) + " " + String(item.count) + " 次").join(" · "),
    );
  }

  lines.push("");
  if (report.delivery.failed > 0) {
    lines.push("结论：" + String(report.delivery.failed) + " 条最终失败，请按即时告警处置。");
  } else if (report.delivery.retrying > 0) {
    lines.push("结论：无最终失败，" + String(report.delivery.retrying) + " 条待重试将继续自动发送。");
  } else {
    lines.push("结论：无最终失败。");
  }
  return lines.join("\n");
}

function composeRepeatedIssue(issue: OutboxDailyDigest["repeatedIssues"][number]): string {
  const prefix =
    issue.consecutiveDays >= 2
      ? issue.label + "连续 " + String(issue.consecutiveDays) + " 天出现，昨日 " + String(issue.yesterdayCount) + " 次"
      : issue.yesterdayCount > 0
        ? issue.label + "昨日 " + String(issue.yesterdayCount) + " 次"
        : issue.previousDayCount > 0
          ? issue.label + "前日 " + String(issue.previousDayCount) + " 次，昨日未再出现"
          : issue.label + "近 7 日多次出现，昨日未再出现";
  const trend =
    issue.yesterdayCount > 0 && issue.previousDayCount > 0 && issue.yesterdayCount !== issue.previousDayCount
      ? "，较前日" +
        (issue.yesterdayCount > issue.previousDayCount ? "增加 " : "减少 ") +
        String(Math.abs(issue.yesterdayCount - issue.previousDayCount)) +
        " 次"
      : "";
  const outcome =
    issue.outcome === "failed"
      ? "，存在最终失败"
      : issue.outcome === "retrying"
        ? "，仍在自动重试"
        : issue.outcome === "downgraded"
          ? "，已自动降级"
          : "，均已自动恢复";
  const suggestion =
    issue.label.includes("预览超时")
      ? "；建议关注转换服务负载"
      : issue.label.includes("连接")
        ? "；建议关注机器人长连接状态"
        : issue.label.includes("限速")
          ? "；建议结合发送高峰评估配额"
          : "";
  return prefix + trend + outcome + suggestion;
}

function formatLatency(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return String(hours) + " 小时" + (minutes === 0 ? "" : " " + String(minutes) + " 分");
  }
  if (minutes > 0) {
    return String(minutes) + " 分";
  }
  return String(Math.max(1, Math.round(milliseconds / 1000))) + " 秒";
}

function recoveryLabel(code: OutboxDailyDigest["recoveries"]["byCode"][number]["code"]): string {
  if (code === "outbox.queue_stalled.recovered") return "队列停滞恢复";
  if (code === "outbox.unconsumed_topic.recovered") return "未消费主题恢复";
  return "其它告警恢复";
}

/** 主题明细紧凑行（积压 / 最老待领取类告警）：`主题：a 7 条 · b 3 条`（截前 5；detail 非该形状时返回 null）。 */
function topicBreakdownLine(detail: OutboxAlert["detail"]): string | null {
  const byTopic: unknown = detail?.["byTopic"];
  if (!Array.isArray(byTopic)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of byTopic.slice(0, 5)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const topic = (item as { topic?: unknown }).topic;
    const due = (item as { due?: unknown }).due;
    if (typeof topic === "string" && typeof due === "number") {
      parts.push(topic + " " + String(due) + " 条");
    }
  }
  return parts.length === 0 ? null : "主题：" + parts.join(" · ");
}

export class WecomAlertSink implements OutboxAlertSink {
  private readonly logger = new Logger("WecomAlertSink");
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly aibot: WecomAibotClient,
    private readonly chatid: string,
    private readonly fallback: OutboxAlertSink,
    private readonly now: () => number = Date.now,
  ) {}

  emit(alert: OutboxAlert): void {
    if (alert.action === undefined || alert.action.trim() === "") {
      this.logger.warn("告警无处置动作，仅记录日志：" + alert.code + " · " + alert.message);
      this.fallback.emit(alert);
      return;
    }
    const at = this.now();
    const family = alertSuppressFamily(alert.code);
    const last = this.lastSentAt.get(family);
    if (last !== undefined && at - last < ALERT_SUPPRESS_MS) {
      this.logger.warn("告警抑制（" + alert.code + " · 族 " + family + "，窗口内已推）：" + alert.message);
      return;
    }
    this.lastSentAt.set(family, at);
    void this.send(alert);
  }

  async emitDigest(report: OutboxDailyDigest): Promise<boolean> {
    return this.sendDigest(report);
  }

  private async send(alert: OutboxAlert): Promise<void> {
    try {
      // 告警群按「已接入并激活」口径传 groupActivated=true（846607 超频 → rate_limited；接入未完成时同样回退日志）。
      const result = await this.aibot.sendGroupMarkdown({ chatid: this.chatid, content: composeAlertText(alert), groupActivated: true });
      if (result.ok) {
        this.logger.log("告警已推企微告警群：" + alert.code + " · chatid " + maskChatid(this.chatid));
        return;
      }
      this.logger.warn("企微告警群发送失败（kind=" + result.kind + "），回退结构化日志：" + alert.message);
      this.fallback.emit(alert);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("企微告警群发送异常，回退结构化日志：" + detail);
      this.fallback.emit(alert);
    }
  }

  private async sendDigest(report: OutboxDailyDigest): Promise<boolean> {
    try {
      const result = await this.aibot.sendGroupMarkdown({
        chatid: this.chatid,
        content: composeDigestText(report),
        groupActivated: true,
      });
      if (result.ok) {
        this.logger.log("outbox 日报已推企微告警群 · chatid " + maskChatid(this.chatid));
        return true;
      }
      this.logger.warn("企微日报发送失败（kind=" + result.kind + "），回退结构化日志");
      await this.fallback.emitDigest(report);
      return false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("企微日报发送异常，回退结构化日志：" + detail);
      await this.fallback.emitDigest(report);
      return false;
    }
  }
}
