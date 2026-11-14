/**
 * 公共节点审核企微通知设置与每日派发回归（0099 · 2026-11-15）：
 * 1) 设置仅公共节点审核管理员可读 / 写，保存写审计；
 * 2) 关闭 / 未到点 / 当日已派发不写 outbox；到点后一条申请给每位当前审核人一条 Markdown；
 * 3) 同一申请同一审核人永久只通知一次，次日不重复；新申请进入下一个通知日；
 * 4) 上海业务日与 HH:mm 换算固定 UTC+8。
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

class FakeSettingsRepository {
  row: TaskNodeReviewNotificationSettingsRow = {
    enabled: true,
    dailyTime: "09:00",
    lastDispatchedOn: null,
    updatedAt: AT,
    updatedBy: null,
  };
  marks: string[] = [];
  updates: Array<{ enabled: boolean; dailyTime: string; actorId: string }> = [];

  async getSettings(): Promise<TaskNodeReviewNotificationSettingsRow> {
    return { ...this.row };
  }

  async lockSettings(): Promise<TaskNodeReviewNotificationSettingsRow> {
    return { ...this.row };
  }

  async updateSettings(input: { enabled: boolean; dailyTime: string }, actorId: string): Promise<TaskNodeReviewNotificationSettingsRow> {
    this.updates.push({ ...input, actorId });
    this.row = { ...this.row, enabled: input.enabled, dailyTime: input.dailyTime, updatedAt: AT, updatedBy: actorId };
    return { ...this.row };
  }

  async markDispatched(on: string): Promise<void> {
    this.marks.push(on);
    this.row = { ...this.row, lastDispatchedOn: on };
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

describe("TaskNodeReviewNotificationService 设置", () => {
  it("读取与保存都要求公共节点审核权限；保存整份开关与时间并写审计", async () => {
    const h = createHarness();
    h.permission.allowed = false;
    await expectCode(() => h.service.getSettings(ACTOR), "FORBIDDEN");
    await expectCode(() => h.service.updateSettings({ enabled: false, dailyTime: "18:30" }, ACTOR), "FORBIDDEN");

    h.permission.allowed = true;
    expect(await h.service.getSettings(REVIEWER)).toEqual({ enabled: true, dailyTime: "09:00" });
    const saved = await h.service.updateSettings({ enabled: false, dailyTime: "18:30" }, REVIEWER);
    expect(saved).toEqual({ enabled: false, dailyTime: "18:30" });
    expect(h.settings.updates).toEqual([{ enabled: false, dailyTime: "18:30", actorId: REVIEWER }]);
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.records[0]).toMatchObject({
      actorId: REVIEWER,
      action: "update",
      objectType: "task_node_review_notification_settings",
      objectId: "default",
    });
  });

  it("非法时间格式由服务层兜底为 400", async () => {
    const h = createHarness();
    await expectCode(() => h.service.updateSettings({ enabled: true, dailyTime: "9:00" }, REVIEWER), "VALIDATION_FAILED");
  });
});

describe("TaskNodeReviewNotificationService 每日派发", () => {
  it("关闭时完全不写企微 outbox", async () => {
    const h = createHarness();
    h.settings.row.enabled = false;
    h.requests.rows = [makeRequest()];
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "disabled", produced: 0 });
    expect(h.database.outbox).toEqual([]);
    expect(h.settings.marks).toEqual([]);
  });

  it("未到每日时间不派发", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    expect(await h.service.flushScheduledNotifications(BEFORE_DUE_AT)).toEqual({ state: "not_due", produced: 0 });
    expect(h.database.outbox).toEqual([]);
  });

  it("到点后一条申请给每位审核人一条 Markdown，并标记当日已派发", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "dispatched", produced: 2 });
    expect(h.database.outbox).toHaveLength(2);
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
    expect(h.settings.marks).toEqual(["2026-11-15"]);
    expect(await h.service.flushScheduledNotifications(DUE_AT)).toEqual({ state: "already_dispatched", produced: 0 });
    expect(h.database.outbox).toHaveLength(2);
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
    expect(h.settings.marks).toEqual(["2026-11-15", "2026-11-16"]);
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
