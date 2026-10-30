/**
 * M3-05 任务软删回归（A25 · Push 152）：DELETE /projects/{id}/tasks/{taskId} ——
 * 软删（不物理删行；历史与留痕保留）+ 重复删除统一 404 + 组内位次同事务压缩（0 起、密集）+ 来源节点约束释放 + 留痕（审计 / outbox）。
 * 读面过滤（列表 / 详情 / summary / 门禁 / 节点判重 / 锁行）由仓储统一承担（isNull(tasks.deletedAt)）；本文件用替身镜像该语义，
 * 锁定服务层口径：已删任务上的一切写路径 404、归档项目 409、删除不写 task_events（其类型为四值闭集）。
 * 真机口径见 server/README.md「M3-05」；门禁与批量用例见 test/task-gate.test.ts / test/task-batch.test.ts。
 * 引用守卫（Push 215 口径）：change_refs（变更记录）与问题（issues.task_id）两类判定 —— 日报「关联任务」改「关联阶段」后 report_ref 随批删除。
 */
import { describe, expect, it } from "vitest";
import type { AuditService } from "../src/modules/admin/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskGateRepository } from "../src/modules/task/task.gate.repository.js";
import type {
  TaskEventInput,
  TaskInsertInput,
  TaskOrderBrief,
  TaskProjectNodeRow,
  TaskProjectRow,
  TaskRepository,
  TaskRow,
  TaskUpdatePatch,
} from "../src/modules/task/task.repository.js";
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const NODE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const OTHER_ACTOR = "66666666-6666-4666-8666-666666666666";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEW_TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CHANGE = "77777777-7777-4777-8777-777777777777";
const AT = new Date("2026-09-22T08:00:00Z");

interface OutboxRow {
  topic: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

class FakeDatabase {
  outbox: OutboxRow[] = [];
  tx = {
    insert: () => ({
      values: (value: OutboxRow) => {
        this.outbox.push(value);
        return Promise.resolve();
      },
    }),
  } as unknown as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
    insert: this.tx.insert,
  } as unknown as DatabaseService["db"];
}

function makeRow(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    projectId: PROJECT,
    stageKey: "install",
    nodeId: NODE,
    taskNodeId: null,
    title: "任务 " + id.slice(0, 8),
    titleEn: null,
    ownerIds: [],
    status: "pending",
    statusOverride: null,
    progress: "0",
    sortIndex: 0,
    plannedStart: null,
    plannedEnd: null,
    actualEnd: null,
    estimatedDays: null,
    headcount: null,
    priority: null,
    deliverableTypes: [],
    note: null,
    onTime: null,
    changeRefs: [],
    version: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
    deletedBy: null,
    finalizedAt: null,
    finalizedBy: null,
    ...overrides,
  };
}

/**
 * 任务仓储替身（软删语义镜像）：所有读路径一律排除 deletedAt 非空的行（对应 SQL 侧 isNull(tasks.deletedAt)），
 * softDelete 条件带「未删」—— 重复删除返回 false（与真仓储同形）。
 */
class FakeTaskRepository {
  async lockStageCompletion(): Promise<void> {}
  async countStageTasks(): Promise<{ total: number; done: number; deliveryReady: number }> {
    return { total: 0, done: 0, deliveryReady: 0 };
  }

  project: TaskProjectRow = { id: PROJECT, managerIds: [], stageKey: "install", status: "active" };
  tasks = new Map<string, TaskRow>();
  deletedCalls: { taskId: string; actorId: string }[] = [];
  shifts: { projectId: string; stageKey: string | null; from: number; to: number | null; delta: number }[] = [];
  inserted: TaskInsertInput[] = [];
  events: TaskEventInput[] = [];
  touched: string[] = [];

  constructor() {
    this.tasks.set(TASK_A, makeRow(TASK_A, { sortIndex: 0 }));
    this.tasks.set(TASK_B, makeRow(TASK_B, { sortIndex: 1 }));
  }

  private active(): TaskRow[] {
    return [...this.tasks.values()].filter((row) => row.deletedAt === null);
  }

  private inGroup(projectId: string, stageKey: string | null): TaskRow[] {
    return this.active().filter((row) => row.projectId === projectId && row.stageKey === stageKey);
  }

  async findProject(): Promise<TaskProjectRow | null> {
    return this.project;
  }

  async findProjectNode(_projectId: string, nodeId: string): Promise<TaskProjectNodeRow | null> {
    return { id: nodeId, stageKey: "install", status: "active" };
  }

  /** 节点判重（A10 / A11）：只看未删行 —— 软删后同节点可重新添加。 */
  async findTaskIdByNode(projectId: string, nodeId: string): Promise<string | null> {
    return this.active().find((row) => row.projectId === projectId && row.nodeId === nodeId)?.id ?? null;
  }

  async countGroup(projectId: string, stageKey: string | null): Promise<number> {
    return this.inGroup(projectId, stageKey).length;
  }

  async listGroupOrder(projectId: string, stageKey: string | null): Promise<TaskRow[]> {
    return this.inGroup(projectId, stageKey).sort((left, right) => left.sortIndex - right.sortIndex);
  }

  async shiftGroupIndexes(projectId: string, stageKey: string | null, from: number, to: number | null, delta: number): Promise<void> {
    this.shifts.push({ projectId, stageKey, from, to, delta });
    for (const row of this.inGroup(projectId, stageKey)) {
      if (row.sortIndex >= from && (to === null || row.sortIndex <= to)) {
        this.tasks.set(row.id, { ...row, sortIndex: row.sortIndex + delta });
      }
    }
  }

  /** 软删（镜像真仓储）：只对未删行生效；重复删除返回 false。 */
  async softDelete(_tx: DbClient, taskId: string, actorId: string, at: Date): Promise<boolean> {
    this.deletedCalls.push({ taskId, actorId });
    const row = this.tasks.get(taskId);
    if (row === undefined || row.deletedAt !== null) return false;
    this.tasks.set(taskId, { ...row, deletedAt: at, deletedBy: actorId });
    return true;
  }

  async lockTask(_tx: DbClient, taskId: string): Promise<TaskRow | null> {
    const row = this.tasks.get(taskId);
    return row !== undefined && row.deletedAt === null ? row : null;
  }

  /** 引用守卫（A2-01 · Push 215）：替身按「问题 task_id 的引用条数」口径给数（日报一侧守卫随关联阶段删除）。 */
  issueRefs = 0;

  async countIssueRefs(): Promise<number> {
    return this.issueRefs;
  }

  async findTaskBrief(taskId: string): Promise<TaskOrderBrief | null> {
    const row = this.tasks.get(taskId);
    if (row === undefined || row.deletedAt !== null) return null;
    return { id: row.id, projectId: row.projectId, stageKey: row.stageKey, sortIndex: row.sortIndex };
  }

  async findCompletionTarget(_client: DbClient, taskId: string): Promise<{ id: string; projectId: string; nodeId: string | null; status: string; deliverableTypes: string[] } | null> {
    const row = this.tasks.get(taskId);
    if (row === undefined || row.deletedAt !== null) return null;
    return { id: row.id, projectId: row.projectId, nodeId: row.nodeId, status: row.status, deliverableTypes: row.deliverableTypes };
  }

  async insert(input: TaskInsertInput, at: Date): Promise<TaskRow> {
    this.inserted.push(input);
    const row = makeRow(NEW_TASK, {
      projectId: input.projectId,
      stageKey: input.stageKey,
      nodeId: input.nodeId,
      title: input.title,
      ownerIds: input.ownerIds,
      sortIndex: input.sortIndex,
      deliverableTypes: input.deliverableTypes,
      createdAt: at,
      updatedAt: at,
      version: 0,
    });
    this.tasks.set(NEW_TASK, row);
    return row;
  }

  async updateWithVersion(taskId: string, expectedVersion: number, patch: TaskUpdatePatch, at: Date): Promise<TaskRow | null> {
    const current = this.tasks.get(taskId);
    if (current === undefined || current.deletedAt !== null || current.version !== expectedVersion) return null;
    const next: TaskRow = {
      ...current,
      status: patch.status ?? current.status,
      statusOverride: patch.statusOverride !== undefined ? patch.statusOverride : current.statusOverride,
      progress: patch.progress ?? current.progress,
      updatedAt: at,
      version: current.version + 1,
    };
    this.tasks.set(taskId, next);
    return next;
  }

  async insertEvents(_tx: DbClient, events: readonly TaskEventInput[]): Promise<void> {
    this.events.push(...events);
  }

  async touchProject(projectId: string): Promise<void> {
    this.touched.push(projectId);
  }

  async listChangeLinks(): Promise<never[]> {
    return [];
  }
}

/** 门禁替身：任务软删用例不需要成果文件要求（create 的成果类型带出走空数组）。 */
class FakeTaskGateRepository {
  async listNodeDocRequirements(): Promise<{ docType: string; minCount: number }[]> {
    return [];
  }
  async countUploadedFiles(): Promise<{ docType: string | null; present: number }[]> {
    return [{ docType: null, present: 1 }];
  }
  async countDraftFiles(): Promise<{ docType: string; present: number }[]> {
    return [];
  }
  delivery: { total: number; done: number; deliveryReady: number; issues: unknown[] } = {
    total: 0,
    done: 0,
    deliveryReady: 0,
    issues: [],
  };
  async evaluateDeliveryStatus() {
    return this.delivery;
  }
}

class FakeAuditService {
  entries: Record<string, unknown>[] = [];
  async record(_client: unknown, input: Record<string, unknown>): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(repo: FakeTaskRepository): { service: TaskService; db: FakeDatabase; audit: FakeAuditService } {
  const db = new FakeDatabase();
  const audit = new FakeAuditService();
  const service = new TaskService(
    db as unknown as DatabaseService,
    repo as unknown as TaskRepository,
    new FakeTaskGateRepository() as unknown as TaskGateRepository,
    {} as unknown as PermissionService,
    audit as unknown as AuditService,
    {} as unknown as TaskNodeRepository,
    {} as unknown as TemplateService,
  );
  return { service, db, audit };
}
describe("M3-05 · 任务软删（A25）", () => {
  it("软删：置位 deleted_at / deleted_by + 组内位次压缩 + outbox task.deleted + 审计（删除前快照）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    const result = await service.remove(PROJECT, TASK_A, ACTOR);
    expect(result).toEqual({ id: TASK_A, deleted: true });
    const row = repo.tasks.get(TASK_A);
    expect(row?.deletedAt?.toISOString()).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(ACTOR);
    expect(repo.tasks.size).toBe(2);
    expect(repo.deletedCalls).toEqual([{ taskId: TASK_A, actorId: ACTOR }]);
    expect(repo.shifts[0]).toMatchObject({ projectId: PROJECT, stageKey: "install", from: 1, to: null, delta: -1 });
    expect(repo.tasks.get(TASK_B)?.sortIndex).toBe(0);
    expect(repo.touched).toEqual([PROJECT]);
    const outbox = db.outbox.filter((item) => item.topic === "task.deleted");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.dedupeKey).toBe("task.deleted:" + TASK_A + ":3");
    expect(outbox[0]?.payload).toMatchObject({
      projectId: PROJECT,
      taskId: TASK_A,
      stageKey: "install",
      nodeId: NODE,
      actorId: ACTOR,
    });
    const entry = audit.entries[0];
    expect(entry?.action).toBe("delete");
    expect(entry?.objectType).toBe("task");
    expect(entry?.objectId).toBe(TASK_A);
    expect(entry?.projectId).toBe(PROJECT);
    expect(entry?.summary).toBe("删除任务：任务 " + TASK_A.slice(0, 8));
    expect((entry?.changes as unknown[]).length).toBeGreaterThan(0);
    expect(entry?.metadata).toMatchObject({ softDelete: true, stageKey: "install", nodeId: NODE });
    expect(repo.events).toEqual([]);
  });

  it("重复删除：统一 404（不新增错误码，也不二次写留痕）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    await service.remove(PROJECT, TASK_A, ACTOR);
    await expect(service.remove(PROJECT, TASK_A, OTHER_ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(db.outbox.filter((item) => item.topic === "task.deleted")).toHaveLength(1);
    expect(audit.entries.filter((entry) => entry.action === "delete")).toHaveLength(1);
    expect(repo.tasks.get(TASK_A)?.deletedBy).toBe(ACTOR);
  });

  it("任务不存在 / 不属于该项目：统一 404（并发兜底：softDelete 返回 false 同样 404）", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_C, makeRow(TASK_C, { projectId: OTHER_PROJECT }));
    const { service, db, audit } = makeService(repo);
    await expect(service.remove(PROJECT, GONE, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(service.remove(PROJECT, TASK_C, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(repo.tasks.get(TASK_C)?.deletedAt).toBeNull();
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
    const racing = new FakeTaskRepository();
    racing.softDelete = async (): Promise<boolean> => false;
    const racingService = makeService(racing).service;
    await expect(racingService.remove(PROJECT, TASK_A, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("归档项目：入口 409 PROJECT_ARCHIVED（未软删、无留痕）", async () => {
    const repo = new FakeTaskRepository();
    repo.project = { ...repo.project, status: "archived" };
    const { service, db, audit } = makeService(repo);
    await expect(service.remove(PROJECT, TASK_A, ACTOR)).rejects.toMatchObject({ code: "PROJECT_ARCHIVED", httpStatus: 409 });
    expect(repo.tasks.get(TASK_A)?.deletedAt).toBeNull();
    expect(repo.deletedCalls).toEqual([]);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("已删任务上的写路径：编辑 / 进度 / 完成提交一律 404", async () => {
    const repo = new FakeTaskRepository();
    const { service, db } = makeService(repo);
    await service.remove(PROJECT, TASK_A, ACTOR);
    await expect(service.update(PROJECT, TASK_A, { version: 3, note: "补记" }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(service.updateProgress(PROJECT, TASK_A, { version: 3, progress: 0.5 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(service.complete(PROJECT, TASK_A, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(db.outbox.filter((item) => item.topic === "task.deleted")).toHaveLength(1);
  });

  it("已删任务：can-complete 预检 404（完成门禁读面不可见）；未删任务照常预检", async () => {
    const repo = new FakeTaskRepository();
    const { service } = makeService(repo);
    await service.remove(PROJECT, TASK_A, ACTOR);
    await expect(service.canComplete(PROJECT, TASK_A)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(service.canComplete(PROJECT, TASK_B)).resolves.toEqual({ canComplete: true, missing: [], warnings: [] });
  });

  it("节点释放：软删后同一节点可重新创建任务（判重只看未删行）", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_B, makeRow(TASK_B, { sortIndex: 1, nodeId: null }));
    const { service } = makeService(repo);
    const body = { title: "重装任务", taskNodeId: NODE };
    await expect(service.create(PROJECT, body, ACTOR)).rejects.toMatchObject({ code: "TASK_ALREADY_EXISTS", httpStatus: 409 });
    await service.remove(PROJECT, TASK_A, ACTOR);
    const created = await service.create(PROJECT, body, ACTOR);
    expect(created.id).toBe(NEW_TASK);
    expect(created.nodeId).toBe(NODE);
    expect(created.stageKey).toBe("install");
    expect(repo.inserted).toHaveLength(1);
  });

  it("位次压缩：删除中间一条后组内位次仍 0 起、密集", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_C, makeRow(TASK_C, { sortIndex: 2 }));
    const { service } = makeService(repo);
    await service.remove(PROJECT, TASK_B, ACTOR);
    expect(repo.shifts[0]).toMatchObject({ from: 2, to: null, delta: -1 });
    const order = (await repo.listGroupOrder(PROJECT, "install")).map((row) => row.sortIndex);
    expect(order).toEqual([0, 1]);
  });

  it("已有变更关联：409 TASK_HAS_REFERENCES（不软删 / 不变位次 / 不写留痕；系统功能书 A2-01）", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { sortIndex: 0, changeRefs: [CHANGE] }));
    const { service, db, audit } = makeService(repo);
    const rejected = await service.remove(PROJECT, TASK_A, ACTOR).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "TASK_HAS_REFERENCES", httpStatus: 409 });
    const details = (rejected as { details: { code: string; meta?: Record<string, unknown> }[] }).details;
    expect(details[0]?.code).toBe("change_ref");
    expect(details[0]?.meta?.["changeRequestId"]).toBe(CHANGE);
    expect(repo.tasks.get(TASK_A)?.deletedAt).toBeNull();
    expect(repo.tasks.get(TASK_B)?.sortIndex).toBe(1);
    expect(repo.shifts).toEqual([]);
    expect(repo.deletedCalls).toEqual([]);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("无任何引用：照常软删（change_refs 空数组 + 问题为 0）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db } = makeService(repo);
    repo.tasks.set(TASK_A, makeRow(TASK_A, { sortIndex: 0, changeRefs: [] }));
    await expect(service.remove(PROJECT, TASK_A, ACTOR)).resolves.toEqual({ id: TASK_A, deleted: true });
    expect(db.outbox.filter((row) => row.topic === "task.deleted")).toHaveLength(1);
  });

  it("问题引用：409 TASK_HAS_REFERENCES（details[].code = issue_ref）；变更 + 问题同报时明细齐全", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { sortIndex: 0, changeRefs: ["77777777-7777-4777-8777-777777777777"], }));
    repo.issueRefs = 3;
    const { service, db, audit } = makeService(repo);
    const rejected = await service.remove(PROJECT, TASK_A, ACTOR).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "TASK_HAS_REFERENCES", httpStatus: 409 });
    const details = (rejected as { details: { code: string; meta?: Record<string, unknown> }[] }).details;
    expect(details.map((item) => item.code)).toEqual(["change_ref", "issue_ref"]);
    expect(details[1]?.meta?.["count"]).toBe(3);
    expect(repo.tasks.get(TASK_A)?.deletedAt).toBeNull();
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
});


describe("Push 249 · 定档任务写口闸（删除）", () => {
  it("定档任务：删除 → 409 TASK_FINALIZED，不落库 / 无 outbox / 无审计", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { finalizedAt: new Date("2026-10-08T02:00:00Z"), finalizedBy: ACTOR }));
    const { service, db, audit } = makeService(repo);
    await expect(service.remove(PROJECT, TASK_A, ACTOR)).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
      details: [{ code: "task_finalized", path: "finalizedAt" }],
    });
    expect(repo.tasks.get(TASK_A)?.deletedAt).toBeNull();
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
});
