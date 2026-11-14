/**
 * 公共任务节点申请（0096 · 2026-11-13）服务回归：
 * 1) 列表：mine=true 只看本人（任何账号可用，含本人待审数）；审核人视角需要公共节点审核人白名单（无权限 403），含全局待审数；
 * 2) 导入侧提交：跳过「该阶段已有同名公共节点」、复用同阶段同名待审申请、批内同名去重、名称 trim；
 * 3) 通过：可先改中英文名，按同阶段同名判重建公共节点并写节点 / 申请两条审计；已有同名节点时直接关联（linkedExisting）；
 * 4) 驳回：原因必填；已处理申请再审核 / 撤销一律 400；撤销仅本人且仅 pending；
 * 5) 权限：通过 / 驳回 / 审核人列表都走公共节点审核人白名单判定。
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
  async assertCanReviewTaskNodeRequests(): Promise<void> {
    if (!this.allowed) throw new AppError("FORBIDDEN", "审核公共节点申请需要已授权的管理员权限");
  }
}

class FakeAudit {
  records: AuditRecordInput[] = [];
  async record(_tx: unknown, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

function createHarness(): {
  service: TaskNodeRequestService;
  requests: FakeRequestRepository;
  nodes: FakeNodeRepository;
  permission: FakePermission;
  audit: FakeAudit;
} {
  const requests = new FakeRequestRepository();
  const nodes = new FakeNodeRepository();
  const permission = new FakePermission();
  const audit = new FakeAudit();
  const database = { db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } };
  const service = new TaskNodeRequestService(
    requests as unknown as TaskNodeRequestRepository,
    nodes as unknown as TaskNodeRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    database as unknown as DatabaseService,
  );
  return { service, requests, nodes, permission, audit };
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
