import { describe, expect, it } from "vitest";
import { OUTBOX_TOPICS, type OutboxTopic } from "@libiaolink/contracts";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { OutboxStatsSnapshot, OutboxStore } from "../src/db/outbox.store.js";
import type { OutboxTopicBacklog } from "../src/db/outbox.store.js";
import type { AibotSendResult, WecomAibotClient } from "../src/modules/notify/wecom.aibot.js";
import {
  evaluateOutboxAlerts,
  type OutboxAlert,
  type OutboxAlertSink,
  type OutboxAlertThresholds,
} from "../src/outbox/alert.js";
import { OutboxAlertProbe } from "../src/outbox/probe.js";
import type { OutboxTopicHandler } from "../src/outbox/handler.js";
import { ALERT_SUPPRESS_MS, WecomAlertSink } from "../src/outbox/wecom-alert.sink.js";

/** S7-1 告警门禁：阈值判定（纯函数）与探针接线（读快照 → 发告警）。 */

const THRESHOLDS: OutboxAlertThresholds = { backlogMax: 1000, oldestDueMs: 900000, deadRecentMax: 1 };

const ENV = {
  OUTBOX_ALERT_BACKLOG_MAX: 1000,
  OUTBOX_ALERT_OLDEST_MS: 900000,
  OUTBOX_ALERT_REPEAT_MS: 21600000,
  OUTBOX_ALERT_DEAD_RECENT_MAX: 1,
  OUTBOX_ALERT_DEAD_WINDOW_MS: 3600000,
} as unknown as Env;

const REGISTERED_TOPICS = new Set<string>(OUTBOX_TOPICS);

function snapshot(overrides: Partial<OutboxStatsSnapshot> = {}): OutboxStatsSnapshot {
  return { duePending: 0, oldestDueMs: null, deadRecent: 0, deadTotal: 0, byTopic: [], ...overrides };
}

function backlog(topic: string, due: number, oldestMs: number): OutboxTopicBacklog {
  return { topic, due, oldestMs };
}

describe("evaluateOutboxAlerts（S7-1 阈值判定）", () => {
  it("积压超阈值：warn + 主题明细（按积压排序截前 5）", () => {
    const topics = OUTBOX_TOPICS.slice(0, 7).map((topic, index) => backlog(topic, 7 - index, 1000));
    const alerts = evaluateOutboxAlerts(
      snapshot({ duePending: 1001, oldestDueMs: 1000, byTopic: topics }),
      THRESHOLDS,
      REGISTERED_TOPICS,
    );

    const backlogAlert = alerts.find((alert) => alert.code === "outbox.backlog");
    expect(backlogAlert).toMatchObject({ level: "warn", detail: { duePending: 1001 } });
    expect((backlogAlert!.detail!.byTopic as OutboxTopicBacklog[])).toHaveLength(5);
  });

  it("积压等于阈值不告警（严格大于才报）", () => {
    expect(evaluateOutboxAlerts(snapshot({ duePending: 1000, oldestDueMs: 1000 }), THRESHOLDS, REGISTERED_TOPICS)).toHaveLength(0);
  });

  it("最老待领取超阈值：error；无积压（oldestDueMs = null）不告警", () => {
    const alerts = evaluateOutboxAlerts(snapshot({ duePending: 1, oldestDueMs: 900001 }), THRESHOLDS, REGISTERED_TOPICS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "outbox.oldest_due", level: "error" });

    expect(evaluateOutboxAlerts(snapshot({ oldestDueMs: null }), THRESHOLDS, REGISTERED_TOPICS)).toHaveLength(0);
  });

  it("近期死信 >= 阈值：error（默认 1 = 窗口内出现任何死信都告警）", () => {
    const alerts = evaluateOutboxAlerts(snapshot({ deadRecent: 1, deadTotal: 3 }), THRESHOLDS, REGISTERED_TOPICS);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "outbox.dead_letter", level: "error" });
    expect(alerts[0]!.message).toContain("累计 3");
  });

  it("多判定同时超限：三条告警全出（死信/积压/最老可并发）", () => {
    const alerts = evaluateOutboxAlerts(
      snapshot({ duePending: 5000, oldestDueMs: 3600000, deadRecent: 2, deadTotal: 2 }),
      THRESHOLDS,
      REGISTERED_TOPICS,
    );

    expect(alerts.map((alert) => alert.code).sort()).toEqual(["outbox.backlog", "outbox.dead_letter", "outbox.oldest_due"]);
  });

  it("待领取主题无消费者：error + 只列未消费主题（drain-only / 已注册主题不误报）", () => {
    const alerts = evaluateOutboxAlerts(
      snapshot({
        duePending: 12,
        oldestDueMs: 1000,
        byTopic: [backlog("task.created", 10, 1000), backlog("task.updated", 2, 1000)],
      }),
      THRESHOLDS,
      new Set(["task.updated"]),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      code: "outbox.unconsumed_topic",
      level: "error",
      detail: { duePending: 10, byTopic: [backlog("task.created", 10, 1000)] },
    });
  });
});

/** Outbox 快照替身：只实现探针用到的 stats。 */
class FakeStatsStore {
  readonly inputs: { deadWindowMs: number }[] = [];
  current: OutboxStatsSnapshot = snapshot();

  async stats(input: { deadWindowMs: number }): Promise<OutboxStatsSnapshot> {
    this.inputs.push(input);
    return this.current;
  }
}

class FakeAlertSink implements OutboxAlertSink {
  readonly emitted: OutboxAlert[] = [];

  emit(alert: OutboxAlert): void {
    this.emitted.push(alert);
  }
}

const START_MS = Date.parse("2026-10-19T00:00:00Z");

function makeProbe(options: { registeredTopics?: readonly OutboxTopic[] } = {}): {
  probe: OutboxAlertProbe;
  store: FakeStatsStore;
  sink: FakeAlertSink;
  setNowMs: (value: number) => void;
} {
  const store = new FakeStatsStore();
  const sink = new FakeAlertSink();
  let nowMs = START_MS;
  const clock = new ClockService();
  clock.setSource(() => new Date(nowMs));
  const handler: OutboxTopicHandler = { handle: async () => ({ outcome: "done" }) };
  const registry = new Map<OutboxTopic, OutboxTopicHandler>(
    (options.registeredTopics ?? OUTBOX_TOPICS).map((topic): [OutboxTopic, OutboxTopicHandler] => [topic, handler]),
  );
  const probe = new OutboxAlertProbe(store as unknown as OutboxStore, sink, new AppConfig(ENV), registry, clock);
  return { probe, store, sink, setNowMs: (value: number) => { nowMs = value; } };
}

describe("OutboxAlertProbe.probeOnce（S7-1）", () => {
  it("读快照（带死信窗口）→ 阈值判定 → 逐条发出并返回本轮告警", async () => {
    const { probe, store, sink } = makeProbe();
    store.current = snapshot({ duePending: 1001, oldestDueMs: 1000 });

    const alerts = await probe.probeOnce();

    expect(store.inputs).toEqual([{ deadWindowMs: 3600000 }]);
    expect(alerts).toHaveLength(1);
    expect(sink.emitted).toEqual(alerts);
  });

  it("健康队列：不发任何告警", async () => {
    const { probe, sink } = makeProbe();

    const alerts = await probe.probeOnce();

    expect(alerts).toHaveLength(0);
    expect(sink.emitted).toHaveLength(0);
  });

  it("死信水位线：首次命中照发；同量复报抑制；新增再放行；回落重建基线", async () => {
    const { probe, store, sink } = makeProbe();

    store.current = snapshot({ deadRecent: 1, deadTotal: 1 });
    const first = await probe.probeOnce();
    expect(first.map((alert) => alert.code)).toEqual(["outbox.dead_letter"]);

    expect(await probe.probeOnce()).toHaveLength(0);

    store.current = snapshot({ deadRecent: 2, deadTotal: 2 });
    const grown = await probe.probeOnce();
    expect(grown.map((alert) => alert.code)).toEqual(["outbox.dead_letter"]);

    store.current = snapshot({ deadRecent: 0, deadTotal: 0 });
    expect(await probe.probeOnce()).toHaveLength(0);

    store.current = snapshot({ deadRecent: 1, deadTotal: 1 });
    const afterReset = await probe.probeOnce();
    expect(afterReset.map((alert) => alert.code)).toEqual(["outbox.dead_letter"]);
    expect(await probe.probeOnce()).toHaveLength(0);

    expect(sink.emitted).toHaveLength(3);
  });

  it("状态告警冷却：首轮立即报，冷却内静默，到期复报；死信继续按水位线抑制", async () => {
    const { probe, store, setNowMs } = makeProbe();
    store.current = snapshot({ duePending: 1001, oldestDueMs: 1000, deadRecent: 1, deadTotal: 1 });

    const first = await probe.probeOnce();
    expect(first.map((alert) => alert.code).sort()).toEqual(["outbox.backlog", "outbox.dead_letter"]);

    const second = await probe.probeOnce();
    expect(second).toHaveLength(0);

    setNowMs(START_MS + ENV.OUTBOX_ALERT_REPEAT_MS);
    const repeated = await probe.probeOnce();
    expect(repeated.map((alert) => alert.code)).toEqual(["outbox.backlog"]);
  });

  it("恢复通知：状态告警回到阈值内只发一次恢复，后续健康轮次静默", async () => {
    const { probe, store, sink } = makeProbe();
    store.current = snapshot({ duePending: 1001, oldestDueMs: 1000 });
    expect((await probe.probeOnce()).map((alert) => alert.code)).toEqual(["outbox.backlog"]);

    store.current = snapshot({ duePending: 0, oldestDueMs: null });
    const recovered = await probe.probeOnce();
    expect(recovered.map((alert) => alert.code)).toEqual(["outbox.backlog.recovered"]);
    expect(await probe.probeOnce()).toHaveLength(0);
    expect(sink.emitted.map((alert) => alert.code)).toEqual(["outbox.backlog", "outbox.backlog.recovered"]);
  });

  it("未消费主题：运行时报告并带主题明细；排空后发恢复", async () => {
    const topics = OUTBOX_TOPICS.filter((topic) => topic !== "task.created");
    const { probe, store } = makeProbe({ registeredTopics: topics });
    store.current = snapshot({
      duePending: 10,
      oldestDueMs: 1000,
      byTopic: [backlog("task.created", 10, 1000)],
    });

    const alerts = await probe.probeOnce();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      code: "outbox.unconsumed_topic",
      detail: { duePending: 10, byTopic: [backlog("task.created", 10, 1000)] },
    });

    store.current = snapshot();
    const recovered = await probe.probeOnce();
    expect(recovered.map((alert) => alert.code)).toEqual(["outbox.unconsumed_topic.recovered"]);
  });
});

/** 企微告警群出口（M5-03-3）：智能机器人推管理员告警群 + 同族抑制（15 分钟窗口）+ 失败回退日志出口。 */
const ALERT_CHATID = "AlertChatIdAbcDef-99";

class FakeAibot {
  readonly sends: { chatid: string; content: string; groupActivated?: boolean | null }[] = [];
  result: AibotSendResult = { ok: true, attempts: 1 };
  throwNext = false;

  async sendGroupMarkdown(params: {
    chatid: string;
    content: string;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.sends.push(params);
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("socket 已断开");
    }
    return this.result;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("WecomAlertSink（M5-03-3 告警群出口）", () => {
  it("emit：经智能机器人推告警群（文本 = 头部 + message；不回显 detail JSON），不回退", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert: OutboxAlert = { code: "outbox.dead_letter", level: "error", message: "近期死信 2 条", detail: { deadRecent: 2 } };

    sink.emit(alert);
    await flush();

    expect(aibot.sends).toHaveLength(1);
    expect(aibot.sends[0]!.chatid).toBe(ALERT_CHATID);
    expect(aibot.sends[0]!.content).toBe("【LibiaoLink 告警】outbox.dead_letter\n近期死信 2 条");
    expect(fallback.emitted).toHaveLength(0);
  });

  it("积压告警：主题明细紧凑行（前 5 条），不回显 detail JSON", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert: OutboxAlert = {
      code: "outbox.backlog",
      level: "warn",
      message: "outbox 待领取积压 1001 条（阈值 1000）",
      detail: { duePending: 1001, byTopic: [backlog("task.overdue", 7, 1000), backlog("report.weekly", 3, 900)] },
    };

    sink.emit(alert);
    await flush();

    expect(aibot.sends[0]!.content).toBe(
      "【LibiaoLink 告警】outbox.backlog\noutbox 待领取积压 1001 条（阈值 1000）\n主题：task.overdue 7 条 · report.weekly 3 条",
    );
  });

  it("同族抑制：窗口内只推首条；不同族不受影响；窗口过期恢复", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    let nowMs = 1_000_000;
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => nowMs);
    const backlogAlert: OutboxAlert = { code: "outbox.backlog", level: "warn", message: "积压 1001 条" };
    const deadAlert: OutboxAlert = { code: "outbox.dead_letter", level: "error", message: "近期死信 1 条" };

    sink.emit(backlogAlert);
    await flush();
    nowMs += ALERT_SUPPRESS_MS - 1;
    sink.emit(backlogAlert);
    sink.emit(deadAlert);
    await flush();
    expect(aibot.sends).toHaveLength(2);

    nowMs += 1;
    sink.emit(backlogAlert);
    await flush();
    expect(aibot.sends).toHaveLength(3);
    expect(fallback.emitted).toHaveLength(0);
  });

  it("死信同族抑制：即时（outbox.dead）后探针（outbox.dead_letter）窗口内不双报；窗口过期恢复", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    let nowMs = 1_000_000;
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => nowMs);

    sink.emit({ code: "outbox.dead", level: "error", message: "死信 notify.message#9000" });
    await flush();
    sink.emit({ code: "outbox.dead_letter", level: "error", message: "近期死信 1 条" });
    await flush();
    expect(aibot.sends).toHaveLength(1);
    expect(aibot.sends[0]!.content).toContain("outbox.dead");

    nowMs += ALERT_SUPPRESS_MS;
    sink.emit({ code: "outbox.dead_letter", level: "error", message: "近期死信 2 条" });
    await flush();
    expect(aibot.sends).toHaveLength(2);
    expect(aibot.sends[1]!.content).toContain("outbox.dead_letter");
    expect(fallback.emitted).toHaveLength(0);
  });

  it("发送失败（ok=false）：回退日志出口", async () => {
    const aibot = new FakeAibot();
    aibot.result = { ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪", retryAt: null, attempts: 0, state: "connecting" };
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert: OutboxAlert = { code: "outbox.oldest_due", level: "error", message: "最老待领取超阈值" };

    sink.emit(alert);
    await flush();

    expect(aibot.sends).toHaveLength(1);
    expect(fallback.emitted).toEqual([alert]);
  });

  it("发送异常（抛错）：回退日志出口（告警链不断）", async () => {
    const aibot = new FakeAibot();
    aibot.throwNext = true;
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert: OutboxAlert = { code: "outbox.backlog", level: "warn", message: "积压 1001 条" };

    sink.emit(alert);
    await flush();

    expect(fallback.emitted).toEqual([alert]);
  });
});
