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
  type OutboxDailyDigest,
  type OutboxAlertThresholds,
} from "../src/outbox/alert.js";
import { OutboxAlertProbe } from "../src/outbox/probe.js";
import type { OutboxTopicHandler } from "../src/outbox/handler.js";
import { ALERT_SUPPRESS_MS, WecomAlertSink, composeAlertText, composeDigestText } from "../src/outbox/wecom-alert.sink.js";

/** 告警门禁：纯阈值判定 + 可执行即时告警 + 恢复/死信日报。 */

const THRESHOLDS: OutboxAlertThresholds = { backlogMax: 1000, oldestDueMs: 900000, deadRecentMax: 1 };

const ENV = {
  OUTBOX_ALERT_BACKLOG_MAX: 1000,
  OUTBOX_ALERT_OLDEST_MS: 900000,
  OUTBOX_ALERT_REPEAT_MS: 21600000,
  OUTBOX_ALERT_DEAD_RECENT_MAX: 1,
  OUTBOX_ALERT_DEAD_WINDOW_MS: 3600000,
  OUTBOX_ALERT_PROGRESS_WINDOW_MS: 900000,
  OUTBOX_ALERT_STALL_PROBES: 3,
  OUTBOX_ALERT_DIGEST_INTERVAL_MS: 86400000,
} as unknown as Env;

const REGISTERED_TOPICS = new Set<string>(OUTBOX_TOPICS);

function snapshot(overrides: Partial<OutboxStatsSnapshot> = {}): OutboxStatsSnapshot {
  return {
    duePending: 0,
    oldestDueMs: null,
    doneRecent: 0,
    deadRecent: 0,
    deadTotal: 0,
    byTopic: [],
    deadByTopic: [],
    ...overrides,
  };
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
    expect(alerts[0]).toMatchObject({ code: "outbox.dead_letter", level: "error" });
    expect(alerts[0]!.message).toContain("累计 3");
  });

  it("待领取主题无消费者：带影响 / 处置，且只列未消费主题", () => {
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
    expect(alerts[0]!.action).toContain("OUTBOX_TOPIC_ROLES");
    expect(alerts[0]!.impact).toContain("不会被处理");
  });
});

class FakeStatsStore {
  readonly inputs: { deadWindowMs: number; progressWindowMs: number }[] = [];
  current: OutboxStatsSnapshot = snapshot();

  async stats(input: { deadWindowMs: number; progressWindowMs: number }): Promise<OutboxStatsSnapshot> {
    this.inputs.push(input);
    return this.current;
  }
}

class FakeAlertSink implements OutboxAlertSink {
  readonly emitted: OutboxAlert[] = [];
  readonly digests: OutboxDailyDigest[] = [];

  emit(alert: OutboxAlert): void {
    this.emitted.push(alert);
  }

  emitDigest(report: OutboxDailyDigest): void {
    this.digests.push(report);
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
  return { probe, store, sink, setNowMs: (value: number) => (nowMs = value) };
}

describe("OutboxAlertProbe（可执行即时告警 + 日报）", () => {
  it("健康队列：不发即时告警；快照同时读取死信窗口与进度窗口", async () => {
    const { probe, store, sink } = makeProbe();

    expect(await probe.probeOnce()).toEqual([]);
    expect(store.inputs).toEqual([{ deadWindowMs: 3600000, progressWindowMs: 900000 }]);
    expect(sink.emitted).toEqual([]);
  });

  it("有积压但仍在消费：只记日志，不升级即时告警", async () => {
    const { probe, store, sink } = makeProbe();
    store.current = snapshot({ duePending: 1001, oldestDueMs: 1_000_000, doneRecent: 3 });

    expect(await probe.probeOnce()).toEqual([]);
    expect(await probe.probeOnce()).toEqual([]);
    expect(sink.emitted).toEqual([]);
  });

  it("连续无完成进度才合并升级 queue_stalled；6h 复报，积压/最老不双报", async () => {
    const { probe, store, sink, setNowMs } = makeProbe();
    store.current = snapshot({
      duePending: 4171,
      oldestDueMs: 2_313_651_000,
      doneRecent: 0,
      byTopic: [backlog("task.created", 1875, 2_313_651_000)],
    });

    expect(await probe.probeOnce()).toEqual([]);
    expect(await probe.probeOnce()).toEqual([]);
    const first = await probe.probeOnce();
    expect(first.map((alert) => alert.code)).toEqual(["outbox.queue_stalled"]);
    expect(first[0]).toMatchObject({
      level: "error",
      detail: { duePending: 4171, oldestDueMs: 2_313_651_000, doneRecent: 0, stalledProbes: 3 },
    });
    expect(first[0]!.action).toContain("检查 worker 进程 / 容器状态");
    expect(first[0]!.impact).toContain("用户可能收不到消息");

    expect(await probe.probeOnce()).toEqual([]);
    setNowMs(START_MS + ENV.OUTBOX_ALERT_REPEAT_MS);
    expect((await probe.probeOnce()).map((alert) => alert.code)).toEqual(["outbox.queue_stalled"]);
    expect(sink.emitted.map((alert) => alert.code)).toEqual(["outbox.queue_stalled", "outbox.queue_stalled"]);
  });

  it("队列停滞恢复：不即时推送，进入下一次日报", async () => {
    const { probe, store, sink } = makeProbe();
    store.current = snapshot({ duePending: 2000, oldestDueMs: 2_000_000, doneRecent: 0 });
    await probe.probeOnce();
    await probe.probeOnce();
    await probe.probeOnce();

    store.current = snapshot();
    expect(await probe.probeOnce()).toEqual([]);
    expect(sink.emitted.map((alert) => alert.code)).toEqual(["outbox.queue_stalled"]);

    const report = await probe.digestOnce();
    expect(report?.recoveries.map((item) => item.code)).toEqual(["outbox.queue_stalled.recovered"]);
    expect(sink.digests).toHaveLength(1);
  });

  it("未消费主题：即时告警带处置动作；恢复只进日报", async () => {
    const topics = OUTBOX_TOPICS.filter((topic) => topic !== "task.created");
    const { probe, store, sink } = makeProbe({ registeredTopics: topics });
    store.current = snapshot({
      duePending: 10,
      oldestDueMs: 1000,
      byTopic: [backlog("task.created", 10, 1000)],
    });

    const alerts = await probe.probeOnce();
    expect(alerts.map((alert) => alert.code)).toEqual(["outbox.unconsumed_topic"]);
    expect(alerts[0]!.action).toContain("OUTBOX_TOPIC_ROLES");
    expect(await probe.probeOnce()).toEqual([]);

    store.current = snapshot();
    expect(await probe.probeOnce()).toEqual([]);
    expect(sink.emitted.map((alert) => alert.code)).toEqual(["outbox.unconsumed_topic"]);

    const report = await probe.digestOnce();
    expect(report?.recoveries.map((item) => item.code)).toEqual(["outbox.unconsumed_topic.recovered"]);
  });

  it("近期死信：不再即时推送；日报汇总最近窗口死信", async () => {
    const { probe, store, sink } = makeProbe();
    store.current = snapshot({
      deadRecent: 2,
      deadTotal: 7,
      deadByTopic: [{ topic: "preview.job", count: 2 }],
    });

    expect(await probe.probeOnce()).toEqual([]);
    expect(sink.emitted).toEqual([]);

    const report = await probe.digestOnce();
    expect(report).toMatchObject({
      deadRecent: 2,
      deadTotal: 7,
      deadByTopic: [{ topic: "preview.job", count: 2 }],
      windowMs: 86400000,
    });
    expect(sink.digests).toHaveLength(1);
  });

  it("日报无异常：只写日志，不推送空消息", async () => {
    const { probe, sink } = makeProbe();
    expect(await probe.digestOnce()).toBeNull();
    expect(sink.digests).toEqual([]);
  });
});

/** 企微告警群出口：单一管理员群 + 15 分钟同族抑制 + 无处置动作只回日志。 */
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

function actionable(overrides: Partial<OutboxAlert> = {}): OutboxAlert {
  return {
    code: "outbox.queue_stalled",
    level: "error",
    message: "outbox 队列停滞",
    impact: "通知可能延迟",
    action: "检查 worker 与消费者",
    ...overrides,
  };
}

function digest(overrides: Partial<OutboxDailyDigest> = {}): OutboxDailyDigest {
  return {
    generatedAt: "2026-10-20T01:00:00.000Z",
    windowMs: 86400000,
    duePending: 0,
    oldestDueMs: null,
    deadRecent: 0,
    deadTotal: 0,
    byTopic: [],
    deadByTopic: [],
    recoveries: [],
    activeAlerts: [],
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("WecomAlertSink（单一管理员告警群）", () => {
  it("即时告警：头部 + 正文 + 影响 + 处置，且不回显 detail JSON", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert = actionable({
      code: "outbox.dead",
      message: "outbox 死信：notify.message#9（k）—— 文件损坏",
      impact: "该消息不会继续重试",
      action: "查看 outbox_events#9 后重放",
    });

    sink.emit(alert);
    await flush();

    expect(aibot.sends).toHaveLength(1);
    expect(aibot.sends[0]!.content).toBe(
      "【LibiaoLink 告警】outbox.dead\noutbox 死信：notify.message#9（k）—— 文件损坏\n影响：该消息不会继续重试\n处置：查看 outbox_events#9 后重放",
    );
    expect(fallback.emitted).toHaveLength(0);
  });

  it("主题明细随即时告警发送（前 5 条）", () => {
    const alert = actionable({
      detail: { byTopic: [backlog("task.created", 7, 1000), backlog("report.weekly", 3, 900)] },
    });

    expect(composeAlertText(alert)).toBe(
      "【LibiaoLink 告警】outbox.queue_stalled\noutbox 队列停滞\n主题：task.created 7 条 · report.weekly 3 条\n影响：通知可能延迟\n处置：检查 worker 与消费者",
    );
  });

  it("无处置动作：只回退日志，不推群", async () => {
    const aibot = new FakeAibot();
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);
    const alert: OutboxAlert = { code: "outbox.backlog", level: "warn", message: "积压 1001 条" };

    sink.emit(alert);
    await flush();

    expect(aibot.sends).toHaveLength(0);
    expect(fallback.emitted).toEqual([alert]);
  });

  it("同族抑制：15 分钟窗口内只推首条；不同 code 不受影响", async () => {
    const aibot = new FakeAibot();
    let nowMs = 1_000_000;
    const movable = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, new FakeAlertSink(), () => nowMs);

    movable.emit(actionable());
    await flush();
    nowMs += ALERT_SUPPRESS_MS - 1;
    movable.emit(actionable());
    movable.emit(actionable({ code: "outbox.unconsumed_topic", message: "未消费主题" }));
    await flush();
    expect(aibot.sends).toHaveLength(2);

    nowMs += 1;
    movable.emit(actionable());
    await flush();
    expect(aibot.sends).toHaveLength(3);
  });

  it("日报：同一群推送恢复、死信与当前队列快照", async () => {
    const aibot = new FakeAibot();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, new FakeAlertSink(), () => 0);
    const report = digest({
      duePending: 12,
      oldestDueMs: 120000,
      deadRecent: 2,
      deadTotal: 5,
      byTopic: [backlog("notify.message", 2, 120000)],
      deadByTopic: [{ topic: "preview.job", count: 2 }],
      recoveries: [
        { code: "outbox.queue_stalled.recovered", message: "队列恢复", at: "2026-10-20T00:10:00.000Z" },
      ],
      activeAlerts: ["outbox.unconsumed_topic"],
    });

    expect(composeDigestText(report)).toContain("【LibiaoLink 日报】outbox");
    expect(composeDigestText(report)).toContain("已恢复：outbox.queue_stalled.recovered");
    expect(composeDigestText(report)).toContain("仍未恢复：outbox.unconsumed_topic");
    expect(composeDigestText(report)).toContain("新增死信主题：preview.job 2 条");
    sink.emitDigest(report);
    await flush();
    expect(aibot.sends).toHaveLength(1);
    expect(aibot.sends[0]!.content).toContain("新增死信：2 条；累计：5 条");
  });

  it("发送失败 / 异常：回退日志出口（告警链不断）", async () => {
    const aibot = new FakeAibot();
    aibot.result = { ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪", retryAt: null, attempts: 0, state: "connecting" };
    const fallback = new FakeAlertSink();
    const sink = new WecomAlertSink(aibot as unknown as WecomAibotClient, ALERT_CHATID, fallback, () => 0);

    sink.emit(actionable());
    await flush();
    expect(fallback.emitted).toHaveLength(1);

    aibot.throwNext = true;
    sink.emit(actionable({ code: "outbox.unconsumed_topic" }));
    await flush();
    expect(fallback.emitted).toHaveLength(2);
  });
});
