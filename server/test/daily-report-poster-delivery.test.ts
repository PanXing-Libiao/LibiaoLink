import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStorage } from "../src/storage/index.js";
import type { AibotSendResult, DailyReportPosterData } from "../src/modules/notify/index.js";
import { WECOM_AIBOT_IMAGE_MAX_BYTES } from "../src/modules/notify/index.js";
import { DailyReportPosterDeliveryService } from "../src/modules/notify/daily-report-poster-delivery.service.js";

const renderMocks = vi.hoisted(() => ({
  daily: vi.fn(),
  issue: vi.fn(),
}));

vi.mock("../src/modules/notify/daily-report.poster.js", () => ({
  renderDailyReportPoster: renderMocks.daily,
  renderDailyReportIssuePoster: renderMocks.issue,
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
  return { service, storage, aibot, events };
}

beforeEach(() => {
  renderMocks.daily.mockReset();
  renderMocks.issue.mockReset();
});

describe("DailyReportPosterDeliveryService（S4 单篇海报投递）", () => {
  it("群聊按日报图 → 问题图发送，共用一次附件读取与同一图片映射", async () => {
    const harness = makeHarness();
    const data = posterData();

    const attempts = await harness.service.send({
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
    expect(harness.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "DAILY-2026-11-10-PRJ-001.png",
      "ISSUE-2026-11-10-PRJ-001.png",
    ]);
    expect(harness.aibot.groupCalls.every((call) => call.chatid === "chatid_12345")).toBe(true);
    expect(harness.aibot.groupCalls.every((call) => call.groupActivated === true)).toBe(true);
    const images = renderMocks.daily.mock.calls[0]?.[1] as Map<string, Buffer>;
    expect([...images.keys()].sort()).toEqual(["issue-photo", "report-photo"]);
    expect(renderMocks.issue.mock.calls[0]?.[1]).toBe(images);
  });

  it("单聊走 sendUserImage，目标为回调发送人并标记已激活", async () => {
    const harness = makeHarness();

    await harness.service.send({
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

  it("主题开关独立：只发日报或只发问题", async () => {
    const dailyOnly = makeHarness();
    await dailyOnly.service.send({
      data: posterData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: false,
    });
    expect(renderMocks.daily).toHaveBeenCalledTimes(1);
    expect(renderMocks.issue).not.toHaveBeenCalled();

    renderMocks.daily.mockReset();
    renderMocks.issue.mockReset();
    const issueOnly = makeHarness();
    await issueOnly.service.send({
      data: posterData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: false,
      sendIssues: true,
    });
    expect(renderMocks.daily).not.toHaveBeenCalled();
    expect(renderMocks.issue).toHaveBeenCalledTimes(1);
    expect(issueOnly.events).toEqual(["render:issue", "send:ISSUE-2026-11-10-PRJ-001.png"]);
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
      data,
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: false,
    });

    expect(harness.storage.calls).toEqual(["objects/shared-photo"]);
    expect(renderMocks.issue).not.toHaveBeenCalled();
  });

  it("日报图超过 10MB 时只跳过该图，问题图继续发送", async () => {
    const harness = makeHarness();
    renderMocks.daily.mockResolvedValue(Buffer.alloc(WECOM_AIBOT_IMAGE_MAX_BYTES + 1));

    const attempts = await harness.service.send({
      data: posterData(),
      target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
      sendDaily: true,
      sendIssues: true,
    });

    expect(attempts).toBe(1);
    expect(harness.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-2026-11-10-PRJ-001.png",
    ]);
  });

  it("日报渲染异常或发送异常都不会阻断问题图，也不会向调用方抛错", async () => {
    const renderFailure = makeHarness();
    renderMocks.daily.mockRejectedValue(new Error("render failed"));
    await expect(
      renderFailure.service.send({
        data: posterData(),
        target: { chattype: "group", chatid: "chatid_12345", groupActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(1);
    expect(renderFailure.aibot.groupCalls.map((call) => call.fileName)).toEqual([
      "ISSUE-2026-11-10-PRJ-001.png",
    ]);

    renderMocks.daily.mockReset();
    renderMocks.issue.mockReset();
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
        data: posterData(),
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
        data: posterData(),
        target: { chattype: "single", userid: "wecom-user-1", dmActivated: true },
        sendDaily: true,
        sendIssues: true,
      }),
    ).resolves.toBe(1);
    expect(sendThrow.aibot.singleCalls).toHaveLength(2);
  });
});
