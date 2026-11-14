/**
 * 公共任务节点申请（0096 · 2026-11-13）服务回归：
 * 1) 列表：mine=true 只看本人（任何账号可用，含本人待审数）；审核人视角需要公共节点审核人白名单（无权限 403），含全局待审数；
 * 2) 导入侧提交：跳过「该阶段已有同名公共节点」、复用同阶段同名待审申请、批内同名去重、名称 trim；
 * 3) 通过：可先改中英文名，按同阶段同名判重建公共节点并写节点 / 申请两条审计；已有同名节点时直接关联（linkedExisting）；
 * 4) 驳回：原因必填；已处理申请再审核 / 撤销一律 400；撤销仅本人且仅 pending；
 * 5) 权限：通过 / 驳回 / 审核人列表都走公共节点审核人白名单判定。
 * 6) 结果通知：审批成功后只给另一位当前有效审核人写一条四行 Markdown；并发后到者只回已处理，不重复建节点 / 发通知。
 * 契约见 shared/src/modules/templates.ts；真机口径见 server/src/modules/template/README.md。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditRecordInput, AuditService } from "../src/modules/admin/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskNodeInsertInput, TaskNodeRepository, TaskNodeRow } from "../src/modules/template/index.js";
import type {
  TaskNodeRequestInsertInput,
  TaskNodeRequestListFilter,
  TaskNodeRequestRepository,
  TaskNodeRequestRow,
} from "../src/modules/template/index.js";
import { TaskNodeRequestService } from "../src/modules/template/index.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const REVIEWER_B = "88888888-8888-4888-8888-888888888888";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const PREVIEW_ID = "55555555-5555-4555-8555-555555555555";
const AT = new Date("2026-11-13T02:00:00Z");

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

function makeNode(overrides: Partial<TaskNodeRow> = {}): TaskNodeRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    ownerTemplateId: null,
    stageKey: "install",
    seq: 10,
    title: "货架复检",
    titleEn: "Shelf Recheck",
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class FakeRequestRepository {
  rows: TaskNodeRequestRow[] = [];
  inserts: TaskNodeRequestInsertInput[] = [];
  listFilters: TaskNodeRequestListFilter[] = [];
  private counter = 0;

  async list(filter: TaskNodeRequestListFilter): Promise<TaskNodeRequestRow[]> {
    this.listFilters.push({ ...filter });
    return this.rows
      .filter((row) =>
        (filter.stageKey === null || row.stageKey === filter.stageKey) &&
        (filter.status === null || row.status === filter.status) &&
        (filter.requestedBy === null || row.requestedBy === filter.requestedBy))
      .map((row) => ({ ...row }));
  }

  async countPending(requestedBy: string | null): Promise<number> {
    return this.rows.filter((row) => row.status === "pending" && (requestedBy === null || row.requestedBy === requestedBy)).length;
  }

  async findById(id: string): Promise<TaskNodeRequestRow | null> {
    const row = this.rows.find((item) => item.id === id);
    return row === undefined ? null : { ...row };
  }

  /** 行锁读取（真库走 SELECT ... FOR UPDATE；替身只按 id 取，字段与服务层用到的本表字段一致）。 */
  async lockById(id: string): Promise<TaskNodeRequestRow | null> {
    return this.findById(id);
  }

  async findPendingByTitle(stageKey: string, title: string): Promise<TaskNodeRequestRow | null> {
    const row = this.rows.find((item) => item.stageKey === stageKey && item.title === title && item.status === "pending");
    return row === undefined ? null : { ...row };
  }

  async lockRequestNumbering(): Promise<void> {}

  async nextRequestNo(requestedBy: string): Promise<number> {
    const pendingNumbers = this.rows
      .filter((row) => row.requestedBy === requestedBy && row.status === "pending")
      .map((row) => row.requestNo);
    return (pendingNumbers.length === 0 ? 0 : Math.max(...pendingNumbers)) + 1;
  }

  async findPendingByRequesterNameAndNo(requestedByName: string, requestNo: number): Promise<TaskNodeRequestRow | null> {
    const row = this.rows.find(
      (item) => item.requestedByName === requestedByName && item.requestNo === requestNo && item.status === "pending",
    );
    return row === undefined ? null : { ...row };
  }

  async findLatestByRequesterNameAndNo(requestedByName: string, requestNo: number): Promise<TaskNodeRequestRow | null> {
    const rows = this.rows.filter((item) => item.requestedByName === requestedByName && item.requestNo === requestNo);
    const row = rows.at(-1);
    return row === undefined ? null : { ...row };
  }

  async insertIfAbsent(input: TaskNodeRequestInsertInput): Promise<TaskNodeRequestRow | null> {
    this.inserts.push({ ...input });
    const conflict = this.rows.some((row) => row.stageKey === input.stageKey && row.title === input.title && row.status === "pending");
    if (conflict) return null;
    this.counter += 1;
    const row = makeRequest({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa" + String(this.counter),
      stageKey: input.stageKey,
      title: input.title,
      titleEn: input.titleEn,
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      requestNo: input.requestNo,
      projectId: input.projectId,
      status: "pending",
    });
    this.rows.push(row);
    return { ...row };
  }

  async decide(
    id: string,
    input: { status: "approved" | "rejected"; reviewedBy: string; reviewedAt: Date; reviewNote: string | null; nodeId: string | null },
  ): Promise<TaskNodeRequestRow | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.status === "pending");
    if (index < 0) return null;
    const next = {
      ...this.rows[index]!,
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      reviewNote: input.reviewNote,
      nodeId: input.nodeId,
      updatedAt: input.reviewedAt,
    };
    this.rows[index] = next;
    return { ...next };
  }

  async withdraw(id: string, requestedBy: string, at: Date): Promise<TaskNodeRequestRow | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.status === "pending" && row.requestedBy === requestedBy);
    if (index < 0) return null;
    const next = { ...this.rows[index]!, status: "withdrawn", updatedAt: at };
    this.rows[index] = next;
    return { ...next };
  }
}

class FakeNodeRepository {
  rows: TaskNodeRow[] = [];
  inserts: TaskNodeInsertInput[] = [];
  private counter = 0;

  async findByTitle(stageKey: string, title: string, ownerTemplateId: string | null): Promise<TaskNodeRow | null> {
    const row = this.rows.find(
      (item) => item.stageKey === stageKey && item.title === title && item.ownerTemplateId === ownerTemplateId,
    );
    return row === undefined ? null : { ...row };
  }

  async maxSeq(): Promise<number> {
    return this.rows.length === 0 ? 0 : Math.max(...this.rows.map((row) => row.seq));
  }

  async list(stageKey: string): Promise<TaskNodeRow[]> {
    return this.rows.filter((row) => row.stageKey === stageKey).map((row) => ({ ...row }));
  }

  async insert(input: TaskNodeInsertInput): Promise<TaskNodeRow> {
    this.counter += 1;
    this.inserts.push({ ...input });
    const row = makeNode({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb" + String(this.counter),
      stageKey: input.stageKey,
      seq: input.seq,
      title: input.title,
      titleEn: input.titleEn,
    });
    this.rows.push(row);
    return { ...row };
  }
}

class FakePermission {
  allowed = true;
  reviewers: string[] = [];
  async assertCanReviewTaskNodeRequests(): Promise<void> {
    if (!this.allowed) throw new AppError("FORBIDDEN", "审核公共节点申请需要已授权的管理员权限");
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
  readonly outbox: OutboxRecord[] = [];
  private readonly tx = {
    insert: () => ({
      values: (value: OutboxRecord) => {
        this.outbox.push(value);
        return { onConflictDoUpdate: async () => {} };
      },
    }),
  };
  db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(this.tx) };
}

function createHarness(): {
  service: TaskNodeRequestService;
  requests: FakeRequestRepository;
  nodes: FakeNodeRepository;
  permission: FakePermission;
  audit: FakeAudit;
  database: FakeDatabase;
} {
  const requests = new FakeRequestRepository();
  const nodes = new FakeNodeRepository();
  const permission = new FakePermission();
  const audit = new FakeAudit();
  const database = new FakeDatabase();
  const service = new TaskNodeRequestService(
    requests as unknown as TaskNodeRequestRepository,
    nodes as unknown as TaskNodeRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    database as unknown as DatabaseService,
    { env: { PUBLIC_APP_BASE_URL: "https://test.example" } } as never,
  );
  return { service, requests, nodes, permission, audit, database };
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

describe("TaskNodeRequestService.list（申请列表）", () => {
  it("本人视角：任何账号可用，只回自己的申请并给本人待审数", async () => {
    const h = createHarness();
    h.permission.allowed = false;
    h.requests.rows = [
      makeRequest({ id: REQUEST_ID }),
      makeRequest({ id: "77777777-7777-4777-8777-777777777777", requestedBy: REVIEWER }),
    ];
    const result = await h.service.list({ mine: "true" }, ACTOR);
    expect(result.items.map((item) => item.id)).toEqual([REQUEST_ID]);
    expect(result.total).toBe(1);
    expect(result.pendingCount).toBe(1);
    expect(h.requests.listFilters[0]).toEqual({ stageKey: null, status: null, requestedBy: ACTOR });
  });

  it("审核人视角：需要公共节点审核权，无权限 403；有权限回全部 + 全局待审数", async () => {
    const h = createHarness();
    h.requests.rows = [
      makeRequest({ id: REQUEST_ID }),
      makeRequest({ id: "77777777-7777-4777-8777-777777777777", requestedBy: REVIEWER, status: "approved" }),
    ];
    h.permission.allowed = false;
    await expectCode(() => h.service.list({}, ACTOR), "FORBIDDEN");

    h.permission.allowed = true;
    const result = await h.service.list({}, REVIEWER);
    expect(result.items).toHaveLength(2);
    expect(result.pendingCount).toBe(1);
    // 403 那次不落查询，只有放行后的审核人视角查询
    expect(h.requests.listFilters).toEqual([{ stageKey: null, status: null, requestedBy: null }]);
  });
});

describe("TaskNodeRequestService.createFromImport（导入内提交）", () => {
  it("跳过已有同名公共节点、复用同名待审申请、批内同名只提交一次", async () => {
    const h = createHarness();
    h.nodes.rows = [makeNode({ title: "已有节点" })];
    h.requests.rows = [makeRequest({ id: REQUEST_ID, title: "在审节点" })];
    const outcome = await h.service.createFromImport(
      {
        actorId: ACTOR,
        projectId: PROJECT_ID,
        previewId: PREVIEW_ID,
        items: [
          { stageKey: "install", title: "已有节点", titleEn: null },
          { stageKey: "install", title: "在审节点", titleEn: null },
          { stageKey: "install", title: "新节点", titleEn: " New Node " },
          { stageKey: "install", title: "新节点", titleEn: "dup" },
        ],
      },
      {} as never,
    );
    expect(outcome.existingNodes).toEqual([{ stageKey: "install", title: "已有节点" }]);
    expect(outcome.reusedPending).toBe(1);
    expect(outcome.requests.map((row) => row.title)).toEqual(["在审节点", "新节点"]);
    expect(h.requests.inserts).toHaveLength(1);
    expect(h.requests.inserts[0]).toMatchObject({
      stageKey: "install",
      title: "新节点",
      titleEn: "New Node",
      requestedBy: ACTOR,
      projectId: PROJECT_ID,
    });
    expect(h.nodes.inserts).toEqual([]);
  });

  it("申请创建时按仍生效的审核人逐人写企微通知，一条申请一条消息", async () => {
    const h = createHarness();
    const reviewerA = REVIEWER;
    const reviewerB = "99999999-9999-4999-8999-999999999999";
    h.permission.reviewers = [reviewerA, reviewerB];
    const outbox: Array<{ topic: string; dedupeKey: string; payload: Record<string, unknown> }> = [];
    const tx = {
      insert: () => ({
        values: (value: { topic: string; dedupeKey: string; payload: Record<string, unknown> }) => ({
          onConflictDoUpdate: async () => {
            outbox.push(value);
          },
        }),
      }),
    };
    const outcome = await h.service.createFromImport(
      {
        actorId: ACTOR,
        projectId: PROJECT_ID,
        previewId: PREVIEW_ID,
        items: [{ stageKey: "install", title: "企微联调节点", titleEn: null }],
      },
      tx as never,
    );
    const request = outcome.requests[0];
    if (request === undefined) throw new Error("缺少新建申请");
    expect(outbox).toHaveLength(2);
    expect(outbox.map((row) => row.dedupeKey)).toEqual([
      "task-node-request-review:" + request.id + ":" + reviewerA,
      "task-node-request-review:" + request.id + ":" + reviewerB,
    ]);
    expect(outbox[0]?.topic).toBe("notify.message");
    expect(outbox[0]?.payload).toMatchObject({
      recipientId: reviewerA,
      type: "approval",
      channel: "wecom_aibot",
      refType: "task_node_request",
      refId: request.id,
      templateCode: "TASK_NODE_REQUEST_REVIEW",
    });
    const body = String(outbox[0]?.payload.body ?? "");
    expect(body).toContain("| 审核信息 | 潘兴的1号申请 |");
    expect(body).toContain("同意潘兴的1号申请");
  });

  it("并发下插入撞唯一索引（返回 null）时复用既有待审申请", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest({ id: REQUEST_ID, title: "并发节点" })];
    const original = h.requests.findPendingByTitle.bind(h.requests);
    let calls = 0;
    h.requests.findPendingByTitle = async (stageKey: string, title: string) => {
      calls += 1;
      return calls === 1 ? null : original(stageKey, title);
    };
    const outcome = await h.service.createFromImport(
      { actorId: ACTOR, projectId: PROJECT_ID, previewId: PREVIEW_ID, items: [{ stageKey: "install", title: "并发节点", titleEn: null }] },
      {} as never,
    );
    expect(outcome.requests.map((row) => row.id)).toEqual([REQUEST_ID]);
    expect(outcome.reusedPending).toBe(1);
  });
});

describe("TaskNodeRequestService.handleWecomReview（企微回复）", () => {
  it("同意：按申请人 + 申请号定位 pending，回执带通过后的节点名", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest({ requestNo: 1, title: "第四批空箱上架" })];
    const reply = await h.service.handleWecomReview(REVIEWER, "同意潘兴的1号申请");
    expect(reply).toBe("已同意：潘兴的1号申请，第四批空箱上架");
    expect(h.requests.rows[0]?.status).toBe("approved");
  });

  it("驳回：省略理由记「无」，带理由按原文落库", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest({ requestNo: 2, status: "pending" })];
    const reply = await h.service.handleWecomReview(REVIEWER, "驳回潘兴的2号申请");
    expect(reply).toBe("已驳回：潘兴的2号申请，原因：无");
    expect(h.requests.rows[0]?.reviewNote).toBe("无");
    h.requests.rows = [makeRequest({ id: "77777777-7777-4777-8777-777777777777", requestNo: 3, status: "pending" })];
    const withReason = await h.service.handleWecomReview(REVIEWER, "驳回潘兴的3号申请 与节点重复");
    expect(withReason).toBe("已驳回：潘兴的3号申请，原因：与节点重复");
  });

  it("无权限 / 已处理 / 不存在都回可读中文", async () => {
    const h = createHarness();
    h.permission.allowed = false;
    expect(await h.service.handleWecomReview(REVIEWER, "同意潘兴的1号申请")).toContain("无审核权限");
    h.permission.allowed = true;
    h.requests.rows = [makeRequest({ requestNo: 1, status: "approved" })];
    expect(await h.service.handleWecomReview(REVIEWER, "同意潘兴的1号申请")).toBe("该申请已处理：潘兴的1号申请");
    expect(await h.service.handleWecomReview(REVIEWER, "同意潘兴的9号申请")).toBe("未找到待审核申请：潘兴的9号申请");
  });
});

describe("TaskNodeRequestService.approve / reject / withdraw", () => {
  it("通过：按审核人口径改名建公共节点（追加到阶段末尾），写节点与申请两条审计", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.nodes.rows = [makeNode({ id: "99999999-9999-4999-8999-999999999999", title: "其它节点", seq: 30 })];
    const result = await h.service.approve(REQUEST_ID, { title: " 货架复检（改） ", titleEn: null, note: "名称统一" }, REVIEWER);
    expect(result.linkedExisting).toBe(false);
    expect(result.request).toMatchObject({ status: "approved", reviewNote: "名称统一", nodeId: result.node?.id });
    expect(result.node).toMatchObject({ stageKey: "install", title: "货架复检（改）", titleEn: null, seq: 40 });
    expect(h.nodes.inserts).toEqual([{ ownerTemplateId: null, stageKey: "install", seq: 40, title: "货架复检（改）", titleEn: null }]);
    expect(h.audit.records.map((record) => record.objectType)).toEqual(["task_node", "task_node_request"]);
    expect(h.audit.records[0]?.action).toBe("create");
    expect(h.audit.records[1]?.action).toBe("update");
  });

  it("通过：只给另一位审核人补发四行结果通知，并绑定申请去重键", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.permission.reviewers = [REVIEWER, REVIEWER_B];
    await h.service.approve(REQUEST_ID, {}, REVIEWER);
    expect(h.database.outbox).toHaveLength(1);
    const event = h.database.outbox[0];
    if (event === undefined) throw new Error("缺少结果通知");
    expect(event).toMatchObject({
      topic: "notify.message",
      dedupeKey: "task-node-request-review-result:" + REQUEST_ID + ":" + REVIEWER_B,
      payload: {
        recipientId: REVIEWER_B,
        type: "approval",
        channel: "wecom_aibot",
        title: "公共节点审核结果｜硬件实施",
        refType: "task_node_request",
        refId: REQUEST_ID,
        templateCode: "TASK_NODE_REQUEST_REVIEW_RESULT",
        mergeKey: "task-node-request-result:" + REQUEST_ID,
      },
    });
    expect(event.payload.body).toBe("**阶段**：硬件实施\n**任务**：货架复检\n**申请人**：潘兴\n**审核结果**：审核通过");
  });

  it("并发只有一个赢家：后到审核返回已处理，不重复建节点或发结果", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.permission.reviewers = [REVIEWER, REVIEWER_B];
    await h.service.approve(REQUEST_ID, {}, REVIEWER);
    await expectCode(() => h.service.approve(REQUEST_ID, {}, REVIEWER_B), "VALIDATION_FAILED");
    expect(h.nodes.inserts).toHaveLength(1);
    expect(h.database.outbox).toHaveLength(1);
    expect(h.requests.rows[0]?.reviewedBy).toBe(REVIEWER);
  });

  it("通过：该阶段已有同名节点时直接关联，不新建节点", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.nodes.rows = [makeNode({ title: "货架复检" })];
    const result = await h.service.approve(REQUEST_ID, {}, REVIEWER);
    expect(result.linkedExisting).toBe(true);
    expect(result.node?.id).toBe("66666666-6666-4666-8666-666666666666");
    expect(h.nodes.inserts).toEqual([]);
    expect(h.audit.records.map((record) => record.objectType)).toEqual(["task_node_request"]);
  });

  it("通过：已处理申请 400；无审核权 403；不存在 404", async () => {
    const h = createHarness();
    await expectCode(() => h.service.approve(REQUEST_ID, {}, REVIEWER), "NOT_FOUND");
    h.requests.rows = [makeRequest({ status: "approved", reviewedBy: REVIEWER, reviewedAt: AT, nodeId: "node-1" })];
    await expectCode(() => h.service.approve(REQUEST_ID, {}, REVIEWER), "VALIDATION_FAILED");
    h.requests.rows = [makeRequest()];
    h.permission.allowed = false;
    await expectCode(() => h.service.approve(REQUEST_ID, {}, REVIEWER), "FORBIDDEN");
    expect(h.nodes.inserts).toEqual([]);
  });

  it("驳回：只给另一位审核人发一条简洁结果通知", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    h.permission.reviewers = [REVIEWER, REVIEWER_B];
    await h.service.reject(REQUEST_ID, { reason: "与现有节点重复" }, REVIEWER);
    expect(h.database.outbox).toHaveLength(1);
    const event = h.database.outbox[0];
    if (event === undefined) throw new Error("缺少结果通知");
    expect(event.dedupeKey).toBe("task-node-request-review-result:" + REQUEST_ID + ":" + REVIEWER_B);
    expect(event.payload).toMatchObject({ recipientId: REVIEWER_B, templateCode: "TASK_NODE_REQUEST_REVIEW_RESULT" });
    expect(event.payload.body).toBe("**阶段**：硬件实施\n**任务**：货架复检\n**申请人**：潘兴\n**审核结果**：审核驳回");
  });

  it("驳回：原因必填；驳回后不再建节点", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    await expectCode(() => h.service.reject(REQUEST_ID, { reason: "   " }, REVIEWER), "VALIDATION_FAILED");
    const result = await h.service.reject(REQUEST_ID, { reason: "与现有节点重复" }, REVIEWER);
    expect(result.request).toMatchObject({ status: "rejected", reviewNote: "与现有节点重复", nodeId: null });
    expect(result.node).toBeNull();
    expect(h.nodes.inserts).toEqual([]);
    expect(h.audit.records.map((record) => record.objectType)).toEqual(["task_node_request"]);
    await expectCode(() => h.service.reject(REQUEST_ID, { reason: "再驳一次" }, REVIEWER), "VALIDATION_FAILED");
  });

  it("撤销：仅本人可撤销且仅 pending；他人 403、已处理 400", async () => {
    const h = createHarness();
    h.requests.rows = [makeRequest()];
    await expectCode(() => h.service.withdraw(REQUEST_ID, REVIEWER), "FORBIDDEN");
    const result = await h.service.withdraw(REQUEST_ID, ACTOR);
    expect(result.request.status).toBe("withdrawn");
    await expectCode(() => h.service.withdraw(REQUEST_ID, ACTOR), "VALIDATION_FAILED");
    expect(h.audit.records[0]?.objectType).toBe("task_node_request");
  });
});
