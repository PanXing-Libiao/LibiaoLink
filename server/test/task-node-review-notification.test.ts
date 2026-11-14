/**
 * 公共节点审核企微通知个人设置与派发回归（0100 · 2026-11-15）：
 * 1) 每位审核人独立读写自己的开关 / 通知方式 / 固定时间，保存写审计；
 * 2) 及时通知不进入 worker；固定时间按各自的北京时间到点派发；
 * 3) 关闭只影响本人，last_dispatched_on 也按审核人独立；
 * 4) 同一申请同一审核人永久只通知一次；到点前已被处理则不再补发待审通知；
 * 5) 上海业务日与 HH:mm 换算固定 UTC+8。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { ClockService } from "../src/common/clock/clock.service.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditRecordInput, AuditService } from "../src/modules/admin/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskNodeRepository, TaskNodeRow } from "../src/modules/template/index.js";
import type {
  TaskNodeRequestListFilter,
  TaskNodeRequestRepository,
  TaskNodeRequestRow,
} from "../src/modules/template/index.js";
import type {
  TaskNodeReviewNotificationSettingsRepository,
  TaskNodeReviewNotificationSettingsRow,
  TaskNodeReviewNotificationSettingsUpdate,
} from "../src/modules/template/index.js";
import {
  shanghaiWallClockOf,
  TaskNodeReviewNotificationService,
} from "../src/modules/template/index.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const REVIEWER_B = "88888888-8888-4888-8888-888888888888";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID_B = "77777777-7777-4777-8777-777777777777";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const AT = new Date("2026-11-15T01:00:00Z");
const DUE_AT = new Date("2026-11-15T01:00:00Z");
const TEN_AT = new Date("2026-11-15T02:00:00Z");
const ELEVEN_AT = new Date("2026-11-15T03:00:00Z");
const BEFORE_DUE_AT = new Date("2026-11-15T00:59:00Z");
const NEXT_DAY_AT = new Date("2026-11-16T01:00:00Z");

function makeRequest(overrides: Partial<TaskNodeRequestRow> = {}): TaskNodeRequestRow {
  return {
    id: REQUEST_ID,
    stageKey: "install",
    title: "货架复检",
    titleEn: "Shelf Recheck",
    status: "pending",
    requestedBy: ACTOR,
    requestedByName: "潘兴",
    requestedAt: AT,
    requestNo: 1,
    projectId: PROJECT_ID,
    projectCode: "LBGW-20260331-1459",
    projectName: "UK-VANILLA",
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    nodeId: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function makeNode(): TaskNodeRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    ownerTemplateId: null,
    stageKey: "install",
    seq: 10,
    title: "空箱上架",
    titleEn: "Empty box palletizing",
    version: 0,
    createdAt: AT,
    updatedAt: AT,
  };
}

function defaultRow(reviewerId: string): TaskNodeReviewNotificationSettingsRow {
  return {
    reviewerId,
    enabled: true,
    notificationMode: "scheduled",
    dailyTime: "09:00",
    lastDispatchedOn: null,
    updatedAt: new Date(0),
    updatedBy: null,
  };
}

class FakeSettingsRepository {
  rows = new Map<string, TaskNodeReviewNotificationSettingsRow>();
  marks: Array<{ reviewerId: string; on: string }> = [];
  updates: Array<{ reviewerId: string; input: TaskNodeReviewNotificationSettingsUpdate; actorId: string }> = [];

  async getSettings(reviewerId: string): Promise<TaskNodeReviewNotificationSettingsRow> {
    return { ...(this.rows.get(reviewerId) ?? defaultRow(reviewerId)) };
  }

  async listSettings(reviewerIds: readonly string[]): Promise<TaskNodeReviewNotificationSettingsRow[]> {
    return reviewerIds.map((reviewerId) => ({ ...(this.rows.get(reviewerId) ?? defaultRow(reviewerId)) }));
  }

  async listImmediateEnabledReviewerIds(reviewerIds: readonly string[]): Promise<string[]> {
    return reviewerIds.filter((reviewerId) => {
      const row = this.rows.get(reviewerId);
      return row !== undefined && row.enabled && row.notificationMode === "immediate";
    });
  }

  async lockSettings(reviewerId: string): Promise<TaskNodeReviewNotificationSettingsRow> {
    const row = this.rows.get(reviewerId) ?? defaultRow(reviewerId);
    this.rows.set(reviewerId, row);
    return { ...row };
  }

  async updateSettings(
    reviewerId: string,
    input: TaskNodeReviewNotificationSettingsUpdate,
    actorId: string,
  ): Promise<TaskNodeReviewNotificationSettingsRow> {
    this.updates.push({ reviewerId, input: { ...input }, actorId });
    const row: TaskNodeReviewNotificationSettingsRow = {
      ...(this.rows.get(reviewerId) ?? defaultRow(reviewerId)),
      ...input,
      updatedAt: AT,
      updatedBy: actorId,
    };
    this.rows.set(reviewerId, row);
    return { ...row };
  }

  async markDispatched(reviewerId: string, on: string): Promise<void> {
    this.marks.push({ reviewerId, on });
    const row = this.rows.get(reviewerId) ?? defaultRow(reviewerId);
    this.rows.set(reviewerId, { ...row, lastDispatchedOn: on });
  }
}

class FakeRequestRepository {
  rows: TaskNodeRequestRow[] = [];
  filters: TaskNodeRequestListFilter[] = [];

  async list(filter: TaskNodeRequestListFilter): Promise<TaskNodeRequestRow[]> {
    this.filters.push({ ...filter });
    return this.rows
      .filter((row) =>
        (filter.stageKey === null || row.stageKey === filter.stageKey) &&
        (filter.status === null || row.status === filter.status) &&
        (filter.requestedBy === null || row.requestedBy === filter.requestedBy))
      .map((row) => ({ ...row }));
  }
}

class FakeNodeRepository {
  rows: TaskNodeRow[] = [];
  async list(stageKey: string): Promise<TaskNodeRow[]> {
    return this.rows.filter((row) => row.stageKey === stageKey).map((row) => ({ ...row }));
  }
}

class FakePermission {
  allowed = true;
  reviewers: string[] = [REVIEWER, REVIEWER_B];
  async assertCanReviewTaskNodeRequests(): Promise<void> {
    if (!this.allowed) throw new AppError("FORBIDDEN", "需要公共节点审核权限");
  }
  async listEffectiveTaskNodeReviewers(): Promise<string[]> {
    return this.allowed ? [...this.reviewers] : [];
  }
}

class FakeAudit {
  records: AuditRecordInput[] = [];
  async record(_tx: unknown, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

type OutboxRecord = { topic: string; dedupeKey: string; payload: Record<string, unknown> };

class FakeDatabase {
  outbox: OutboxRecord[] = [];
  private readonly seen = new Set<string>();
  private readonly tx = {
    insert: () => ({
      values: (value: OutboxRecord) => ({
        onConflictDoUpdate: async () => {
          if (this.seen.has(value.dedupeKey)) return;
          this.seen.add(value.dedupeKey);
          this.outbox.push(value);
        },
      }),
    }),
  };
  db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(this.tx) };
}

function createHarness(): {
  service: TaskNodeReviewNotificationService;
  settings: FakeSettingsRepository;
  requests: FakeRequestRepository;
  nodes: FakeNodeRepository;
  permission: FakePermission;
  audit: FakeAudit;
  database: FakeDatabase;
} {
  const settings = new FakeSettingsRepository();
  const requests = new FakeRequestRepository();
  const nodes = new FakeNodeRepository();
  nodes.rows = [makeNode()];
  const permission = new FakePermission();
  const audit = new FakeAudit();
  const database = new FakeDatabase();
  const service = new TaskNodeReviewNotificationService(
    settings as unknown as TaskNodeReviewNotificationSettingsRepository,
    requests as unknown as TaskNodeRequestRepository,
    nodes as unknown as TaskNodeRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    database as unknown as DatabaseService,
    { now: () => AT } as unknown as ClockService,
    { env: { PUBLIC_APP_BASE_URL: "https://test.example" } } as never,
  );
  return { service, settings, requests, nodes, permission, audit, database };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 AppError（" + code + "），但未抛出");
}

describe("上海业务时间", () => {
  it("固定 UTC+8 换算业务日与 HH:mm", () => {
    expect(shanghaiWallClockOf(new Date("2026-11-15T00:59:00Z"))).toEqual({ date: "2026-11-15", time: "08:59" });
    expect(shanghaiWallClockOf(new Date("2026-11-15T16:01:00Z"))).toEqual({ date: "2026-11-16", time: "00:01" });
  });
});

describe("TaskNodeReviewNotificationService 个人设置", () => {
  it("读取与保存都要求审核权限；只读写当前审核人的设置并写个人审计", async () => {
    const h = createHarness();
    h.permission.allowed = false;
    await expectCode(() => h.service.getSettings(ACTOR), "FORBIDDEN");
    await expectCode(
      () => h.service.updateSettings({ enabled: false, notificationMode: "scheduled", dailyTime: "18:30" }, ACTOR),
      "FORBIDDEN",
    );

    h.permission.allowed = true;
    expect(await h.service.getSettings(REVIEWER)).toEqual({
      enabled: true,
      notificationMode: "scheduled",
      dailyTime: "09:00",
    });
    const saved = await h.service.updateSettings(
      { enabled: true, notificationMode: "immediate", dailyTime: "11:00" },
      REVIEWER_B,
    );
    expect(saved).toEqual({ enabled: true, notificationMode: "immediate", dailyTime: "11:00" });
    expect(h.settings.updates).toEqual([{
      reviewerId: REVIEWER_B,
      input: { enabled: true, notificationMode: "immediate", dailyTime: "11:00" },
      actorId: REVIEWER_B,
    }]);
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.records[0]).toMatchObject({
      actorId: REVIEWER_B,
      action: "update",
      objectType: "task_node_review_notification_settings",
      objectId: REVIEWER_B,
    });
    expect(await h.service.getSettings(REVIEWER)).toEqual({
      enabled: true,
      notificationMode: "scheduled",
      dailyTime: "09:00",
    });
  });

  it("非法时间格式由服务层兜底为 400", async () => {
    const h = createHarness();
    await expectCode(
      () => h.service.updateSettings({ enabled: true, notificationMode: "scheduled", dailyTime: "9:00" }, REVIEWER),
      "VALIDATION_FAILED",
    );
  });
});

describe("TaskNodeReviewNotificationService 固定时间派发", () => {
  it("关闭只影响本人，另一位审核人仍按自己的时间收到", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER, { ...defaultRow(REVIEWER), enabled: false });
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "dispatched", produced: 1 });
    expect(h.database.outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER_B,
    ]);
    expect(h.settings.marks).toEqual([{ reviewerId: REVIEWER_B, on: "2026-11-15" }]);
  });

  it("两位审核人各自 09:00 / 11:00，前一位 10:00 审批后后一位不再补发待审通知", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER, { ...defaultRow(REVIEWER), dailyTime: "09:00" });
    h.settings.rows.set(REVIEWER_B, { ...defaultRow(REVIEWER_B), dailyTime: "11:00" });

    expect(await h.service.flushScheduledNotifications(TEN_AT)).toEqual({ state: "dispatched", produced: 1 });
    expect(h.database.outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER,
    ]);

    h.requests.rows[0] = { ...h.requests.rows[0]!, status: "approved" };
    expect(await h.service.flushScheduledNotifications(ELEVEN_AT)).toEqual({ state: "dispatched", produced: 0 });
    expect(h.database.outbox).toHaveLength(1);
    expect(h.settings.marks).toEqual([
      { reviewerId: REVIEWER, on: "2026-11-15" },
      { reviewerId: REVIEWER_B, on: "2026-11-15" },
    ]);
  });

  it("两位审核人都按各自时间收到同一条 pending 申请，且 same-day 不重复", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER, { ...defaultRow(REVIEWER), dailyTime: "09:00" });
    h.settings.rows.set(REVIEWER_B, { ...defaultRow(REVIEWER_B), dailyTime: "11:00" });
    expect(await h.service.flushScheduledNotifications(TEN_AT)).toEqual({ state: "dispatched", produced: 1 });
    expect(await h.service.flushScheduledNotifications(TEN_AT)).toEqual({ state: "not_due", produced: 0 });
    expect(await h.service.flushScheduledNotifications(ELEVEN_AT)).toEqual({ state: "dispatched", produced: 1 });
    expect(h.database.outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER,
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER_B,
    ]);
    const first = h.database.outbox[0];
    if (first === undefined) throw new Error("缺少通知");
    expect(first).toMatchObject({
      topic: "notify.message",
      payload: {
        recipientId: REVIEWER,
        type: "approval",
        channel: "wecom_aibot",
        refType: "task_node_request",
        refId: REQUEST_ID,
        templateCode: "TASK_NODE_REQUEST_REVIEW",
      },
    });
    const body = String(first.payload.body ?? "");
    expect(body).toContain("| 审核信息 | 潘兴的1号申请 |");
    expect(body).toContain("同意潘兴的1号申请");
    expect(await h.service.flushScheduledNotifications(ELEVEN_AT)).toEqual({ state: "already_dispatched", produced: 0 });
    expect(h.database.outbox).toHaveLength(2);
  });

  it("及时通知的审核人不参与固定时间派发，另一位固定时间审核人照常收到", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER_B, { ...defaultRow(REVIEWER_B), notificationMode: "immediate" });
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "dispatched", produced: 1 });
    expect(h.database.outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER,
    ]);
    expect(h.settings.marks).toEqual([{ reviewerId: REVIEWER, on: "2026-11-15" }]);
  });

  it("未到自己的固定时间不派发", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER, { ...defaultRow(REVIEWER), dailyTime: "09:00" });
    h.settings.rows.set(REVIEWER_B, { ...defaultRow(REVIEWER_B), dailyTime: "11:00" });
    expect(await h.service.flushScheduledNotifications(BEFORE_DUE_AT)).toEqual({ state: "not_due", produced: 0 });
    expect(h.database.outbox).toEqual([]);
  });

  it("全部关闭时完全不写企微 outbox", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.settings.rows.set(REVIEWER, { ...defaultRow(REVIEWER), enabled: false });
    h.settings.rows.set(REVIEWER_B, { ...defaultRow(REVIEWER_B), enabled: false });
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "disabled", produced: 0 });
    expect(h.database.outbox).toEqual([]);
    expect(h.settings.marks).toEqual([]);
  });

  it("次日不重复提醒同一申请；次日新申请只发新申请", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    await h.service.flushScheduledNotifications(DUE_AT);
    h.requests.rows.push(makeRequest({ id: REQUEST_ID_B, title: "第二批空箱上架", requestNo: 2, requestedAt: NEXT_DAY_AT }));
    expect(await h.service.flushScheduledNotifications(NEXT_DAY_AT)).toEqual({ state: "dispatched", produced: 4 });
    expect(h.database.outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER,
      "task-node-request-review:" + REQUEST_ID + ":" + REVIEWER_B,
      "task-node-request-review:" + REQUEST_ID_B + ":" + REVIEWER,
      "task-node-request-review:" + REQUEST_ID_B + ":" + REVIEWER_B,
    ]);
    expect(h.settings.marks.map((mark) => mark.on)).toEqual(["2026-11-15", "2026-11-15", "2026-11-16", "2026-11-16"]);
  });

  it("没有当前有效审核人时不派发也不推进日期，配置审核人后下一轮可补发", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.permission.reviewers = [];
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "no_reviewers", produced: 0 });
    expect(h.settings.marks).toEqual([]);
    h.permission.reviewers = [REVIEWER];
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "dispatched", produced: 1 });
  });
});
