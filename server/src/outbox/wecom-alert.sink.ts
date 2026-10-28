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

/** 日报文本：恢复通知、死信窗口统计、当前队列快照 —— 与即时告警共用同一管理员告警群。 */
export function composeDigestText(report: OutboxDailyDigest): string {
  const lines = ["【LibiaoLink 日报】outbox"];
  lines.push("统计窗口：" + Math.max(1, Math.round(report.windowMs / 3_600_000)) + "h");
  lines.push(
    "当前待领取：" +
      report.duePending +
      " 条；最老等待：" +
      (report.oldestDueMs === null ? "无" : Math.round(report.oldestDueMs / 1000) + "s"),
  );
  lines.push("新增死信：" + report.deadRecent + " 条；累计：" + report.deadTotal + " 条");
  const deadByTopic = report.deadByTopic.slice(0, 5).map((item) => item.topic + " " + item.count + " 条").join(" · ");
  if (deadByTopic !== "") {
    lines.push("新增死信主题：" + deadByTopic);
  }
  const breakdown = topicBreakdownLine({ byTopic: report.byTopic });
  if (breakdown !== null) {
    lines.push(breakdown);
  }
  if (report.recoveries.length > 0) {
    lines.push("已恢复：" + report.recoveries.map((item) => item.message).join(" · "));
  }
  if (report.activeAlerts.length > 0) {
    lines.push("仍未恢复：" + report.activeAlerts.join(" · "));
  }
  lines.push("处置：需重放的死信查看 outbox_events 的 last_error；预览确定性拒绝已降级「请下载查看」，无需即时处理。");
  return lines.join("\n");
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

  emitDigest(report: OutboxDailyDigest): void {
    void this.sendDigest(report);
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

  private async sendDigest(report: OutboxDailyDigest): Promise<void> {
    try {
      const result = await this.aibot.sendGroupMarkdown({
        chatid: this.chatid,
        content: composeDigestText(report),
        groupActivated: true,
      });
      if (result.ok) {
        this.logger.log("outbox 日报已推企微告警群 · chatid " + maskChatid(this.chatid));
        return;
      }
      this.logger.warn("企微日报发送失败（kind=" + result.kind + "），回退结构化日志");
      this.fallback.emitDigest(report);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("企微日报发送异常，回退结构化日志：" + detail);
      this.fallback.emitDigest(report);
    }
  }
}
