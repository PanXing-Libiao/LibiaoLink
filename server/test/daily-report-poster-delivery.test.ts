import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStorage } from "../src/storage/index.js";
import type {
  AibotSendResult,
  DailyReportDigestPosterData,
  DailyReportPosterData,
} from "../src/modules/notify/index.js";
import {
  DAILY_REPORT_POSTER_MAX_THUMBNAILS,
  WECOM_AIBOT_IMAGE_MAX_BYTES,
} from "../src/modules/notify/index.js";
import {
  DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT,
  DailyReportPosterDeliveryService,
} from "../src/modules/notify/daily-report-poster-delivery.service.js";

const renderMocks = vi.hoisted(() => ({
  daily: vi.fn(),
  issue: vi.fn(),
  digestDaily: vi.fn(),
  digestIssue: vi.fn(),
}));

vi.mock("../src/modules/notify/daily-report.poster.js", () => ({
  renderDailyReportPoster: renderMocks.daily,
  renderDailyReportIssuePoster: renderMocks.issue,
  renderDailyReportDigestPoster: renderMocks.digestDaily,
  renderDailyReportIssueDigestPoster: renderMocks.digestIssue,
}));

function posterData(overrides: Partial<DailyReportPosterData> = {}): DailyReportPosterData {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    projectCode: "PRJ 001",
    projectName: "临港数据中心",
    managers: ["王经理"],
    reportId: "report-1",
    reportDate: "2026-11-10",
    state: "submitted",
    authorName: "张三",
    headcount: 2,
    doneWork: "完成联调",
    plan: "继续验收",
    stages: ["设计开发"],
    submittedAt: "2026-11-10T01:12:00.000Z",
    photos: [
      {
        fileId: "report-photo",
        name: "现场.png",
        objectKey: "objects/shared-photo",
        mime: "image/png",
      },
    ],
    issues: [
      {
        id: "issue-1",
        title: "现场问题",
        categories: ["quality"],
        ownerName: "李四",
        state: "open",
        solution: null,
        photos: [
          {
            fileId: "issue-photo",
            name: "问题.png",
            objectKey: "objects/shared-photo",
            mime: "image/png",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function digestData(overrides: Partial<DailyReportDigestPosterData> = {}): DailyReportDigestPosterData {
  return {
    projectId: "11111111-1111-4111-8111-111111111111",
    projectCode: "PRJ 001",
    projectName: "临港数据中心",
    managers: ["王经理"],
    reportDate: "2026-11-10",
    draftCount: 1,
    reports: [
      {
        reportId: "report-1",
        authorName: "张三",
        submittedAt: "2026-11-10T01:12:00.000Z",
        state: "submitted",
        headcount: 2,
        stages: ["设计开发"],
        doneWork: "完成联调",
        plan: "继续验收",
        photos: [
          {
            fileId: "report-photo-1",
            name: "现场-1.png",
            objectKey: "objects/report-1",
            mime: "image/png",
          },
          {
            fileId: "report-photo-1-extra",
            name: "现场-1-extra.png",
            objectKey: "objects/report-1-extra",
            mime: "image/png",
          },
        ],
      },
      {
        reportId: "report-2",
        authorName: "李四",
        submittedAt: "2026-11-10T02:20:00.000Z",
        state: "supplement",
        headcount: 1,
        stages: ["现场施工"],
        doneWork: "完成巡检",
        plan: null,
        photos: [
          {
            fileId: "report-photo-2",
            name: "现场-2.png",
            objectKey: "objects/report-2",
            mime: "image/png",
          },
        ],
      },
    ],
    issues: [
      {
        id: "issue-1",
        title: "现场问题",
        categories: ["quality"],
        ownerName: "李四",
        state: "open",
        solution: "待复核",
        raisedAt: "2026-11-10",
        sourceReport: { id: "report-1", authorName: "张三", submittedAt: "2026-11-10T01:12:00.000Z" },
        photos: [
          {
            fileId: "issue-photo-1",
            name: "问题-1.png",
            objectKey: "objects/issue-1",
            mime: "image/png",
          },
          {
            fileId: "issue-photo-1-extra",
            name: "问题-1-extra.png",
            objectKey: "objects/issue-1-extra",
            mime: "image/png",
          },
        ],
      },
      {
        id: "issue-2",
        title: "手工登记问题",
        categories: ["safety"],
        ownerName: null,
        state: "in_progress",
        solution: null,
        raisedAt: "2026-11-10",
        sourceReport: null,
        photos: [],
      },
    ],
    ...overrides,
  };
}

class FakeStorage {
  objects = new Map<string, Uint8Array>([["objects/shared-photo", Buffer.from("photo")]]);
  calls: string[] = [];
  fail = false;

  async getObject(objectKey: string) {
    this.calls.push(objectKey);
    if (this.fail) throw new Error("storage failed");
    const bytes = this.objects.get(objectKey);
    if (bytes === undefined) return null;
    return { objectKey, bytes, contentType: "image/png", sizeBytes: bytes.length };
  }
}

class FakeAibot {
  constructor(private readonly events: string[]) {}

  groupResult: AibotSendResult = { ok: true, attempts: 1 };
  singleResult: AibotSendResult = { ok: true, attempts: 1 };
  groupCalls: Array<{
    chatid: string;
    content: Buffer;
    fileName: string;
    mime?: string | null;
    groupActivated?: boolean | null;
  }> = [];
  singleCalls: Array<{
    userid: string;
    content: Buffer;
    fileName: string;
    mime?: string | null;
    dmActivated?: boolean | null;
  }> = [];
  throwGroupOnCall: number | null = null;
  throwSingleOnCall: number | null = null;

  async sendGroupImage(params: FakeAibot["groupCalls"][number]): Promise<AibotSendResult> {
    this.events.push("send:" + params.fileName);
    this.groupCalls.push(params);
    if (this.throwGroupOnCall === this.groupCalls.length) throw new Error("group send failed");
    return this.groupResult;
  }

  async sendUserImage(params: FakeAibot["singleCalls"][number]): Promise<AibotSendResult> {
    this.events.push("send:" + params.fileName);
    this.singleCalls.push(params);
    if (this.throwSingleOnCall === this.singleCalls.length) throw new Error("single send failed");
    return this.singleResult;
  }
}

function makeHarness() {
  const events: string[] = [];
  const storage = new FakeStorage();
  const aibot = new FakeAibot(events);
  const service = new DailyReportPosterDeliveryService(
    storage as unknown as ObjectStorage,
    aibot as never,
  );
  renderMocks.daily.mockImplementation(async () => {
    events.push("render:daily");
    return Buffer.from("daily");
  });
  renderMocks.issue.mockImplementation(async () => {
    events.push("render:issue");
    return Buffer.from("issue");
  });
  renderMocks.digestDaily.mockImplementation(async () => {
    events.push("render:digest-daily");
    return Buffer.from("digest-daily");
  });
  renderMocks.digestIssue.mockImplementation(async () => {
    events.push("render:digest-issue");
    return Buffer.from("digest-issue");
  });
  return { service, storage, aibot, events };
}

beforeEach(() => {
  renderMocks.daily.mockReset();
  renderMocks.issue.mockReset();
  renderMocks.digestDaily.mockReset();
  renderMocks.digestIssue.mockReset();
});

describe("DailyReportPosterDeliveryService（S5 单篇复用 / 合集投递）", () => {
  it("单篇群聊仍按日报图 → 问题图发送，共用一次附件读取与同一图片映射", async () => {
    const harness = makeHarness();
    const data = posterData();

    const attempts = await harness.service.send({
      kind: "single",
      data,
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: true,
      trace: "msg-g-1",
    });

    expect(attempts).toBe(2);
    expect(harness.storage.calls).toEqual(["objects/shared-photo"]);
    expect(harness.events).toEqual([
      "render:daily",
      "send:DAILY-2026-11-10-PRJ-001.png",
      "render:issue",
      "send:ISSUE-2026-11-10-PRJ-001.png",
    ]);
    const images = renderMocks.daily.mock.calls[0]?.[1] as Map<string, Buffer>;
    expect([...images.keys()].sort()).toEqual(["issue-photo", "report-photo"]);
    expect(renderMocks.issue.mock.calls[0]?.[1]).toBe(images);
  });

  it("单聊走 sendUserImage，目标为回调发送人并标记已激活", async () => {
    const harness = makeHarness();

    await harness.service.send({
      kind: "single",
      data: posterData({ issues: [] }),
      target: { chattype: "single", userid: "wecom-user-1", dmActivated: true },
      sendIssues: true,
      trace: "msg-dm-1",
    });

    expect(harness.aibot.groupCalls).toHaveLength(0);
    expect(harness.aibot.singleCalls).toHaveLength(1);
    expect(harness.aibot.singleCalls[0]).toMatchObject({
      userid: "wecom-user-1",
      fileName: "DAILY-2026-11-10-PRJ-001.png",
      mime: "image/png",
      dmActivated: true,
    });
    expect(renderMocks.issue).not.toHaveBeenCalled();
  });

  it("多篇日报发送日报合集 → 问题合集，每项只读首张附件", async () => {
    const harness = makeHarness();
    for (const objectKey of ["objects/report-1", "objects/report-2", "objects/issue-1"]) {
      harness.storage.objects.set(objectKey, Buffer.from(objectKey));
    }

    const attempts = await harness.service.send({
      kind: "digest",
      data: digestData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: true,
      trace: "msg-digest-1",
    });

    expect(attempts).toBe(2);
    expect(harness.events).toEqual([
      "render:digest-daily",
      "send:DAILY-DIGEST-2026-11-10-PRJ-001.png",
      "render:digest-issue",
      "send:ISSUE-DIGEST-2026-11-10-PRJ-001.png",
    ]);
    expect([...harness.storage.calls].sort()).toEqual([
      "objects/issue-1",
      "objects/report-1",
      "objects/report-2",
    ]);
    const dailyImages = renderMocks.digestDaily.mock.calls[0]?.[1] as Map<string, Buffer>;
    expect([...dailyImages.keys()].sort()).toEqual(["report-photo-1", "report-photo-2"]);
    const issueImages = renderMocks.digestIssue.mock.calls[0]?.[1] as Map<string, Buffer>;
    expect([...issueImages.keys()].sort()).toEqual(["issue-photo-1"]);
  });

  it("0 篇日报只发问题合集，不调用日报合集渲染器", async () => {
    const harness = makeHarness();
    harness.storage.objects.set("objects/issue-1", Buffer.from("issue"));
    const data = digestData({ reports: [] });

    const attempts = await harness.service.send({
      kind: "digest",
      data,
      target: { chattype: "single", userid: "wecom-user-1", dmActivated: true },
      sendDaily: true,
      sendIssues: true,
      trace: "msg-zero",
    });

    expect(attempts).toBe(1);
    expect(renderMocks.digestDaily).not.toHaveBeenCalled();
    expect(renderMocks.digestIssue).toHaveBeenCalledTimes(1);
    expect(harness.aibot.singleCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-DIGEST-2026-11-10-PRJ-001.png",
    ]);
  });

  it("主题开关独立：只发日报合集或只发问题合集", async () => {
    const dailyOnly = makeHarness();
    await dailyOnly.service.send({
      kind: "digest",
      data: digestData({ issues: [] }),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: false,
    });
    expect(renderMocks.digestDaily).toHaveBeenCalledTimes(1);
    expect(renderMocks.digestIssue).not.toHaveBeenCalled();

    renderMocks.digestDaily.mockReset();
    renderMocks.digestIssue.mockReset();
    const issueOnly = makeHarness();
    await issueOnly.service.send({
      kind: "digest",
      data: digestData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: false,
      sendIssues: true,
    });
    expect(renderMocks.digestDaily).not.toHaveBeenCalled();
    expect(renderMocks.digestIssue).toHaveBeenCalledTimes(1);
  });

  it("合集取每项首图；超过 8 张缩略图时只跳过对应合集图，不截断凑图", async () => {
    const harness = makeHarness();
    const reports = Array.from({ length: DAILY_REPORT_POSTER_MAX_THUMBNAILS + 1 }, (_, index) => ({
      ...digestData().reports[0]!,
      reportId: "report-" + String(index),
      photos: [
        {
          fileId: "daily-" + String(index),
          name: "现场.png",
          objectKey: "objects/daily-" + String(index),
          mime: "image/png",
        },
      ],
    }));
    const issues = Array.from({ length: DAILY_REPORT_POSTER_MAX_THUMBNAILS }, (_, index) => ({
      ...digestData().issues[0]!,
      id: "issue-" + String(index),
      photos: [
        {
          fileId: "issue-" + String(index),
          name: "问题.png",
          objectKey: "objects/issue-" + String(index),
          mime: "image/png",
        },
      ],
    }));
    for (const item of [...reports, ...issues]) {
      for (const photo of item.photos) {
        if (photo.objectKey !== null) harness.storage.objects.set(photo.objectKey, Buffer.from(photo.fileId));
      }
    }

    await harness.service.send({
      kind: "digest",
      data: digestData({ reports, issues }),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: true,
    });

    expect(harness.storage.calls).toHaveLength(DAILY_REPORT_POSTER_MAX_THUMBNAILS);
    expect(renderMocks.digestDaily).not.toHaveBeenCalled();
    const issueImages = renderMocks.digestIssue.mock.calls[0]?.[1] as Map<string, Buffer>;
    expect(issueImages.size).toBe(DAILY_REPORT_POSTER_MAX_THUMBNAILS);
    expect(harness.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-DIGEST-2026-11-10-PRJ-001.png",
    ]);
  });

  it("不发送问题图时不读取问题附件", async () => {
    const harness = makeHarness();
    harness.storage.objects.set("objects/issue-only", Buffer.from("issue-photo"));
    const data = posterData({
      issues: [
        {
          id: "issue-1",
          title: "现场问题",
          categories: ["quality"],
          ownerName: "李四",
          state: "open",
          solution: null,
          photos: [
            {
              fileId: "issue-photo",
              name: "问题.png",
              objectKey: "objects/issue-only",
              mime: "image/png",
            },
          ],
        },
      ],
    });

    await harness.service.send({
      kind: "single",
      data,
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: false,
    });

    expect(harness.storage.calls).toEqual(["objects/shared-photo"]);
    expect(renderMocks.issue).not.toHaveBeenCalled();
  });

  it("合集日报图超过 10MB 时只跳过该图，问题合集继续发送", async () => {
    const harness = makeHarness();
    renderMocks.digestDaily.mockResolvedValue(Buffer.alloc(WECOM_AIBOT_IMAGE_MAX_BYTES + 1));

    const attempts = await harness.service.send({
      kind: "digest",
      data: digestData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: true,
    });

    expect(attempts).toBe(1);
    expect(harness.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-DIGEST-2026-11-10-PRJ-001.png",
    ]);
  });

  it("合集渲染异常或发送异常不会阻断下一张，也不会向调用方抛错", async () => {
    const renderFailure = makeHarness();
    renderMocks.digestDaily.mockRejectedValue(new Error("render failed"));
    await expect(
      renderFailure.service.send({
        kind: "digest",
        data: digestData(),
        target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(1);
    expect(renderFailure.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-DIGEST-2026-11-10-PRJ-001.png",
    ]);

    renderMocks.digestDaily.mockReset();
    renderMocks.digestIssue.mockReset();
    const sendFailure = makeHarness();
    sendFailure.aibot.groupResult = {
      ok: false,
      kind: "retryable",
      errcode: null,
      errmsg: "not ready",
      retryAt: null,
      attempts: 0,
      state: "subscribed",
    };
    await expect(
      sendFailure.service.send({
        kind: "digest",
        data: digestData(),
        target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(0);
    expect(sendFailure.aibot.groupCalls).toHaveLength(2);
  });

  it("附件读取失败和单聊发送异常均隔离到对应图片", async () => {
    const storageFailure = makeHarness();
    storageFailure.storage.fail = true;
    await expect(
      storageFailure.service.send({
        kind: "single",
        data: posterData(),
        target: { chattype: "single", userid: "wecom-user-1", dmActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(2);
    expect(storageFailure.aibot.singleCalls).toHaveLength(2);

    renderMocks.daily.mockReset();
    renderMocks.issue.mockReset();
    const sendThrow = makeHarness();
    sendThrow.aibot.throwSingleOnCall = 1;
    await expect(
      sendThrow.service.send({
        kind: "single",
        data: posterData(),
        target: { chattype: "single", userid: "wecom-user-1", dmActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(1);
    expect(sendThrow.aibot.singleCalls).toHaveLength(2);
  });

  it("合集渲染全局并发为 1；最多排队 2 个，第 4 张只跳过图片", async () => {
    const harness = makeHarness();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    renderMocks.digestDaily.mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve(Buffer.from("digest-daily"));
          });
        }),
    );

    const sends = Array.from({ length: DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT + 2 }, (_, index) =>
      harness.service.send({
        kind: "digest",
        data: digestData({ issues: [] }),
        target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
        sendDaily: true,
        sendIssues: false,
        trace: "queue-" + String(index),
      }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(renderMocks.digestDaily).toHaveBeenCalledTimes(1);
    for (let index = 0; index < DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT + 1; index += 1) {
      const release = releases.shift();
      expect(release).toBeDefined();
      release?.();
      if (index < DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT) {
        await vi.waitFor(() => expect(releases).toHaveLength(1));
      }
    }
    const results = await Promise.all(sends);
    expect(maxActive).toBe(1);
    expect(renderMocks.digestDaily).toHaveBeenCalledTimes(DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT + 1);
    expect(results.filter((attempts) => attempts === 1)).toHaveLength(
      DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT + 1,
    );
    expect(results.filter((attempts) => attempts === 0)).toHaveLength(1);
  });
});
