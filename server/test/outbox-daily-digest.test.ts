import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { JobRunContext } from "../src/outbox/scheduler.js";
import {
  buildDailyDigest,
  formatDailyDigestRange,
  OUTBOX_DAILY_DIGEST_CRON,
  OUTBOX_DAILY_DIGEST_DEDUPE_KEY,
  OUTBOX_DAILY_DIGEST_JOB_KIND,
  outboxDailyDigestRegistrationRunAt,
  outboxDailyDigestWindow,
  type DailyDigestAttemptRecord,
  type DailyDigestMessageRecord,
  type DailyDigestPreviewDeadRecord,
  type DailyDigestSourceData,
} from "../src/outbox/daily-digest.js";
import type { OutboxDailyDigest } from "../src/outbox/alert.js";
import type { OutboxAlertSink } from "../src/outbox/alert.js";
import { OutboxDailyDigestService } from "../src/outbox/daily-digest.service.js";
import { composeDigestText } from "../src/outbox/wecom-alert.sink.js";

const REPORT_AT = new Date("2026-10-30T00:00:00.000Z");
const CREATED_AT = new Date("2026-10-29T02:00:00.000Z");

function message(overrides: Partial<DailyDigestMessageRecord> = {}): DailyDigestMessageRecord {
  return {
    id: 1,
    sourceDedupeKey: "R02:message-1",
    channel: "wecom_aibot",
    title: "任务延期提醒",
    templateCode: "A02",
    lastState: "sent",
    lastError: null,
    sentAt: new Date(CREATED_AT.getTime() + 60_000),
    createdAt: CREATED_AT,
    metadata: {},
    ...overrides,
  };
}

function sourceData(overrides: Partial<DailyDigestSourceData> = {}): DailyDigestSourceData {
  return { messages: [], attempts: [], previewDeaths: [], ...overrides };
}

function attempt(overrides: Partial<DailyDigestAttemptRecord> = {}): DailyDigestAttemptRecord {
  return {
    messageId: 1,
    state: "failed",
    error: "本地限速桶已满",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function previewDead(overrides: Partial<DailyDigestPreviewDeadRecord> = {}): DailyDigestPreviewDeadRecord {
  return {
    id: 1,
    lastError: "SVG 事件属性已拒绝",
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function build(data: Partial<DailyDigestSourceData> = {}): OutboxDailyDigest {
  return buildDailyDigest({
    reportAt: REPORT_AT,
    generatedAt: new Date("2026-10-30T00:05:00.000Z"),
    data: sourceData(data),
  });
}

describe("管理员日报领域计算", () => {
  it("上海自然日边界固定为昨日 00:00 至今日 00:00，首次注册落在当天 08:00", () => {
    expect(outboxDailyDigestWindow(REPORT_AT)).toEqual({
      from: new Date("2026-10-28T16:00:00.000Z"),
      to: new Date("2026-10-29T16:00:00.000Z"),
    });
    expect(formatDailyDigestRange(REPORT_AT)).toBe("2026-10-29 00:00–24:00（北京时间）");
    expect(outboxDailyDigestRegistrationRunAt(new Date("2026-10-30T02:00:00.000Z")).toISOString()).toBe(
      "2026-10-30T00:00:00.000Z",
    );
    expect(OUTBOX_DAILY_DIGEST_JOB_KIND).toBe("outbox.alert-digest");
    expect(OUTBOX_DAILY_DIGEST_CRON).toBe("0 8 * * *");
    expect(OUTBOX_DAILY_DIGEST_DEDUPE_KEY).toBe("system:outbox-alert-digest");
  });

  it("无异常仍生成心跳日报；昨日通知全部送达时不输出告警段落", () => {
    const report = build({
      messages: [
        message({ id: 1, sourceDedupeKey: "R02:one" }),
        message({ id: 2, sourceDedupeKey: "R02:two" }),
      ],
    });

    expect(report.delivery).toMatchObject({ total: 2, delivered: 2, retrying: 0, failed: 0 });
    expect(composeDigestText(report)).toBe(
      "【LibiaoLink 管理员日报】2026-10-30 08:00\n" +
        "统计范围：2026-10-29 00:00–24:00（北京时间）\n" +
        "昨日通知 2 条全部送达；无自动降级，无重复问题。",
    );
  });

  it("三类不可投递消息从日报明细与总数中整体排除", () => {
    const report = build({
      messages: [
        message({
          id: 1,
          sourceDedupeKey: "R02:unbound:aibot",
          lastState: "dead",
          sentAt: null,
          lastError: "收件人未绑定企业微信（张三，无可投递地址）",
        }),
        message({
          id: 2,
          sourceDedupeKey: "R03:unbound:2026-10-29",
          channel: "wecom_group",
          lastState: "dead",
          sentAt: null,
          lastError: "群未绑定（project xxx）：R03:unbound:2026-10-29",
        }),
        message({
          id: 3,
          sourceDedupeKey: "R05:not-activated:2026-10-29",
          channel: "wecom_group",
          lastState: "dead",
          sentAt: null,
          lastError: "已绑定，但机器人尚未激活（chatid ****）",
        }),
      ],
    });

    expect(report.delivery).toMatchObject({ total: 0, delivered: 0, retrying: 0, failed: 0 });
    expect(report.automaticFallbacks).toEqual([]);
    expect(report.repeatedIssues).toEqual([]);
  });

  it("C5-04 副本归并到原消息，不重复计数；其他兜底进入自动降级", () => {
    const report = build({
      messages: [
        message({
          id: 1,
          sourceDedupeKey: "R02:accepted:app",
          lastState: "dead",
          sentAt: null,
          lastError: "应用消息未送达（errcode=60011：userid 不存在或不可见）",
        }),
        message({
          id: 2,
          sourceDedupeKey: "R02:accepted:app:c504",
          channel: "inbox",
          lastState: "sent",
          sentAt: new Date(CREATED_AT.getTime() + 120_000),
          createdAt: new Date(CREATED_AT.getTime() + 60_000),
          metadata: { c5_04: true, sourceDedupeKey: "R02:accepted:app" },
        }),
      ],
    });

    expect(report.delivery).toMatchObject({ total: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(report.automaticFallbacks).toEqual([
      { label: "企业微信未送达", detail: "已自动转为站内信", count: 1 },
    ]);
  });

  it("超过 5 分钟送达与最长等待按昨日入组消息计算", () => {
    const lateSent = new Date(CREATED_AT.getTime() + 6 * 60_000);
    const report = build({
      messages: [
        message({ id: 1, sourceDedupeKey: "R02:fast", sentAt: new Date(CREATED_AT.getTime() + 60_000) }),
        message({ id: 2, sourceDedupeKey: "R02:slow", sentAt: lateSent }),
      ],
    });

    expect(report.delivery.lateDelivered).toBe(1);
    expect(report.delivery.maxLatencyMs).toBe(6 * 60_000);
    expect(composeDigestText(report)).toContain("超过 5 分钟送达 1 条，最长等待 6 分");
  });

  it("恢复计数只取昨日自然日窗口，窗口外恢复不串到日报", () => {
    const withRecoveries = buildDailyDigest({
      reportAt: REPORT_AT,
      generatedAt: new Date("2026-10-30T00:05:00.000Z"),
      data: sourceData(),
      recoveries: [
        {
          code: "outbox.queue_stalled.recovered",
          message: "昨日恢复",
          at: "2026-10-29T03:00:00.000Z",
        },
        {
          code: "outbox.unconsumed_topic.recovered",
          message: "明日恢复",
          at: "2026-10-30T03:00:00.000Z",
        },
      ],
    });

    expect(withRecoveries.recoveries).toEqual({
      total: 1,
      byCode: [{ code: "outbox.queue_stalled.recovered", count: 1 }],
    });
  });

  it("确定性预览拒绝聚合为自动降级，重复超时进入重复问题", () => {
    const report = build({
      previewDeaths: [
        previewDead({ id: 1, lastError: "SVG 事件属性已拒绝" }),
        previewDead({ id: 2, lastError: "SVG 事件属性已拒绝" }),
        previewDead({ id: 3, lastError: "SVG 事件属性已拒绝" }),
        previewDead({ id: 4, lastError: "源文件超过预览转换上限 20.0 MB，已降级「请下载查看」" }),
        previewDead({ id: 5, lastError: "预览转换器调用超时（客户端 15000 ms 未返回）" }),
        previewDead({ id: 6, lastError: "预览转换器调用超时（客户端 15000 ms 未返回）" }),
      ],
    });

    expect(report.automaticFallbacks).toEqual([
      { label: "文件预览不支持", detail: "SVG 事件属性已拒绝，已提示下载查看", count: 3 },
      { label: "文件超过预览上限", detail: "已提示下载查看", count: 1 },
    ]);
    expect(report.repeatedIssues).toEqual([
      expect.objectContaining({ label: "文件预览超时", yesterdayCount: 2, consecutiveDays: 1, outcome: "failed" }),
    ]);
    expect(composeDigestText(report)).toContain(
      "文件预览不支持 3 条：SVG 事件属性已拒绝，已提示下载查看",
    );
  });

  it("重复问题按近 7 个自然日计算连续天数、前日趋势与最终结果", () => {
    const report = build({
      messages: [
        message({
          id: 7,
          sourceDedupeKey: "R02:rate-limit",
          createdAt: new Date("2026-10-28T02:00:00.000Z"),
          sentAt: new Date("2026-10-29T02:10:00.000Z"),
        }),
      ],
      attempts: [
        attempt({ messageId: 7, createdAt: new Date("2026-10-28T02:00:00.000Z") }),
        attempt({ messageId: 7, createdAt: new Date("2026-10-29T02:00:00.000Z") }),
      ],
    });

    expect(report.repeatedIssues).toEqual([
      {
        label: "企业微信限速",
        yesterdayCount: 1,
        previousDayCount: 1,
        consecutiveDays: 2,
        affectedMessages: 1,
        outcome: "recovered",
      },
    ]);
    const text = composeDigestText(report);
    expect(text).toContain("企业微信限速连续 2 天出现，昨日 1 次");
    expect(text).toContain("均已自动恢复");
    expect(text).not.toContain("outbox_events");
    expect(text).not.toContain("R02:rate-limit");
  });
});

class FakeDigestSink implements OutboxAlertSink {
  readonly reports: OutboxDailyDigest[] = [];
  result = true;

  emit(): void {}

  async emitDigest(report: OutboxDailyDigest): Promise<boolean> {
    this.reports.push(report);
    return this.result;
  }
}

class FakeDigestRepository {
  readonly calls: unknown[] = [];
  data = sourceData();
  error: Error | null = null;

  async load(input: unknown): Promise<DailyDigestSourceData> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    return this.data;
  }
}

function context(attempts = 0, fireTimes: readonly Date[] = [REPORT_AT]): JobRunContext {
  return {
    job: {
      id: 1,
      kind: OUTBOX_DAILY_DIGEST_JOB_KIND,
      payload: {},
      cron: OUTBOX_DAILY_DIGEST_CRON,
      runAt: REPORT_AT,
      lastRunAt: null,
      status: "pending",
      attempts,
      lastError: null,
      lockedBy: null,
      lockedAt: null,
      dedupeKey: OUTBOX_DAILY_DIGEST_DEDUPE_KEY,
    },
    windowFrom: new Date("2026-10-29T00:00:00.000Z"),
    windowTo: REPORT_AT,
    fireTimes,
    tx: {} as never,
  };
}

function service(clockNow: Date): {
  service: OutboxDailyDigestService;
  repository: FakeDigestRepository;
  sink: FakeDigestSink;
  jobs: { input: unknown };
} {
  const repository = new FakeDigestRepository();
  const sink = new FakeDigestSink();
  const clock = new ClockService();
  clock.setSource(() => clockNow);
  const jobs = {
    input: undefined as unknown,
    ensureFixedCronJob: async (input: unknown) => {
      jobs.input = input;
      return "inserted" as const;
    },
  };
  const digest = new OutboxDailyDigestService(
    repository as never,
    jobs as never,
    clock,
    sink,
    undefined,
  );
  return { service: digest, repository, sink, jobs };
}

describe("OutboxDailyDigestService（固定 08:00）", () => {
  it("08:05 执行发送；多个补发窗口只报告最近一份", async () => {
    const h = service(new Date("2026-10-30T00:05:00.000Z"));
    const result = await h.service.run(context(0, [new Date("2026-10-29T00:00:00.000Z"), REPORT_AT]));

    expect(h.sink.reports).toHaveLength(1);
    expect(h.sink.reports[0]!.reportAt).toBe(REPORT_AT.toISOString());
    expect(h.repository.calls).toHaveLength(1);
    expect(result.note).toContain("已省略 1 个更早窗口");
  });

  it("超过 12:00 不补发，也不查询历史", async () => {
    const h = service(new Date("2026-10-30T04:01:00.000Z"));
    const result = await h.service.run(context());

    expect(h.repository.calls).toHaveLength(0);
    expect(h.sink.reports).toHaveLength(0);
    expect(result.note).toContain("超过 12:00");
  });

  it("发送失败回退日志仍推进当天任务，不进入无限重试", async () => {
    const h = service(new Date("2026-10-30T00:05:00.000Z"));
    h.sink.result = false;

    const result = await h.service.run(context());

    expect(h.sink.reports).toHaveLength(1);
    expect(result.note).toContain("回退结构化日志");
  });

  it("查询失败当天有界重试，第三次失败后跳过并保留下一天执行资格", async () => {
    const h = service(new Date("2026-10-30T00:05:00.000Z"));
    h.repository.error = new Error("数据库暂时不可用");

    await expect(h.service.run(context(0))).rejects.toThrow("数据库暂时不可用");
    await expect(h.service.run(context(1))).rejects.toThrow("数据库暂时不可用");
    await expect(h.service.run(context(2))).resolves.toMatchObject({
      note: "日报连续生成失败，已跳过当天并保留次日执行资格",
    });
    expect(h.sink.reports).toHaveLength(0);
  });

  it("启动注册使用幂等 dedupeKey 与当天 08:00", async () => {
    const h = service(new Date("2026-10-30T02:00:00.000Z"));
    await h.service.ensureScheduled();

    expect(h.jobs.input).toMatchObject({
      kind: OUTBOX_DAILY_DIGEST_JOB_KIND,
      dedupeKey: OUTBOX_DAILY_DIGEST_DEDUPE_KEY,
      cron: OUTBOX_DAILY_DIGEST_CRON,
    });
  });
});
