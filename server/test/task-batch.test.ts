/**
 * M3-04 任务批量操作回归（A1-08 · Push 150）：同一组变更逐条独立事务（成功项照常生效 + 部分失败清单）、
 * ids 去重 / 空 changes 400 / 归档项目 409、批量完成走同一完成门禁（缺件进 failures.gate_not_passed + 拒绝留痕）、
 * 【暂时下线 · 2026-09-30】业务口径「暂时不要这个约束功能」：缺件不再拦截批量完成（无 gate_not_passed / 无拒绝留痕）；恢复门禁时把本文件断言与常量一起还原（原断言见 git 历史）。
 * 已完成条目 already_done、审计标注批量入口（entry=batch + 同批 batchId）。
 * 真机口径见 server/README.md「M3-04」；门禁判定与单条写入共用同一内核（见 test/task-gate.test.ts）。
 */
import { describe, expect, it } from "vitest";
import type { AuditService } from "../src/modules/admin/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskGateRepository } from "../src/modules/task/task.gate.repository.js";
import type {
  TaskEventInput,
  TaskProjectRow,
  TaskRepository,
  TaskRow,
  TaskUpdatePatch,
} from "../src/modules/task/task.repository.js";
import { shanghaiToday } from "../src/modules/task/task.rules.js";
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const NODE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const OWNER = "55555555-5555-4555-8555-555555555555";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

/** 任务仓储替身（多行）：批量逐条独立事务 —— lockTask / updateWithVersion 按 id 取行。 */
class FakeTaskRepository {
  project: TaskProjectRow = { id: PROJECT, managerIds: [], stageKey: "install", status: "active" };
  tasks = new Map<string, TaskRow>();
  events: TaskEventInput[] = [];
  touched: string[] = [];

  constructor() {
    this.tasks.set(TASK_A, makeRow(TASK_A));
    this.tasks.set(TASK_B, makeRow(TASK_B));
  }
  async findProject(): Promise<TaskProjectRow | null> {
    return this.project;
  }
  async lockTask(_tx: DbClient, taskId: string): Promise<TaskRow | null> {
    return this.tasks.get(taskId) ?? null;
  }
  async updateWithVersion(taskId: string, expectedVersion: number, patch: TaskUpdatePatch, at: Date): Promise<TaskRow | null> {
    const current = this.tasks.get(taskId);
    if (current === undefined || current.version !== expectedVersion) return null;
    const next: TaskRow = {
      ...current,
      ownerIds: patch.ownerIds !== undefined ? patch.ownerIds : current.ownerIds,
      status: patch.status ?? current.status,
      statusOverride: patch.statusOverride !== undefined ? patch.statusOverride : current.statusOverride,
      progress: patch.progress ?? current.progress,
      sortIndex: patch.sortIndex !== undefined ? patch.sortIndex : current.sortIndex,
      plannedStart: patch.plannedStart !== undefined ? patch.plannedStart : current.plannedStart,
      plannedEnd: patch.plannedEnd !== undefined ? patch.plannedEnd : current.plannedEnd,
      actualEnd: patch.actualEnd !== undefined ? patch.actualEnd : current.actualEnd,
      estimatedDays: patch.estimatedDays !== undefined ? patch.estimatedDays : current.estimatedDays,
      headcount: patch.headcount !== undefined ? patch.headcount : current.headcount,
      priority: patch.priority !== undefined ? patch.priority : current.priority,
      note: patch.note !== undefined ? patch.note : current.note,
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
  async findTaskBrief(): Promise<{ id: string; projectId: string; stageKey: string | null; sortIndex: number } | null> {
    return null;
  }
  async listChangeLinks(): Promise<never[]> {
    return [];
  }
}

/** 门禁替身：默认放行；用例注入 required_doc 要求与 final / draft 计数（与 task-gate.test.ts 同形）。 */
class FakeTaskGateRepository {
  requirements: { docType: string; minCount: number }[] = [];
  finalCounts: { docType: string; present: number }[] = [];
  draftCounts: { docType: string; present: number }[] = [];
  async listNodeDocRequirements(): Promise<{ docType: string; minCount: number }[]> {
    return this.requirements;
  }
  async countFinalFiles(): Promise<{ docType: string; present: number }[]> {
    return this.finalCounts;
  }
  async countDraftFiles(): Promise<{ docType: string; present: number }[]> {
    return this.draftCounts;
  }
}

class FakeAuditService {
  entries: Record<string, unknown>[] = [];
  async record(_client: unknown, input: Record<string, unknown>): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(
  repo: FakeTaskRepository,
  gate: FakeTaskGateRepository = new FakeTaskGateRepository(),
): { service: TaskService; db: FakeDatabase; audit: FakeAuditService } {
  const db = new FakeDatabase();
  const audit = new FakeAuditService();
  const service = new TaskService(
    db as unknown as DatabaseService,
    repo as unknown as TaskRepository,
    gate as unknown as TaskGateRepository,
    {} as unknown as PermissionService,
    audit as unknown as AuditService,
    {} as unknown as TaskNodeRepository,
    {} as unknown as TemplateService,
  );
  return { service, db, audit };
}

describe("M3-04 · 任务批量操作（A1-08）", () => {
  it("批量改字段：逐条生效 + 计数 / 顺序 / outbox / 审计（entry=batch + 同批 batchId）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    const result = await service.batch(
      PROJECT,
      {
        ids: [TASK_A, TASK_B],
        changes: { ownerIds: [OWNER], priority: "高", plannedEnd: "2026-10-01" },
      },
      ACTOR,
    );
    expect(result.total).toBe(2);
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.succeeded.map((task) => task.id)).toEqual([TASK_A, TASK_B]);
    expect(result.succeeded[0]?.ownerIds).toEqual([OWNER]);
    expect(result.succeeded[0]?.priority).toBe("高");
    expect(repo.tasks.get(TASK_A)?.plannedEnd).toBe("2026-10-01");
    expect(repo.tasks.get(TASK_A)?.version).toBe(4);
    expect(repo.events.filter((event) => event.eventType === "date_change")).toHaveLength(2);
    expect(db.outbox.filter((row) => row.topic === "task.updated")).toHaveLength(2);
    const audits = audit.entries.filter((entry) => entry.action === "update" && entry.objectType === "task");
    expect(audits).toHaveLength(2);
    const batchId = (audits[0]?.metadata as Record<string, unknown>)["batchId"];
    expect(typeof batchId).toBe("string");
    for (const entry of audits) {
      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata["entry"]).toBe("batch");
      expect(metadata["batchId"]).toBe(batchId);
      expect((entry.summary as string).startsWith("批量修改任务：")).toBe(true);
    }
    const batchEntry = audit.entries.find((entry) => entry.objectType === "project");
    expect(batchEntry?.summary).toBe("批量操作任务：2 条（成功 2，失败 0）");
    const batchMeta = batchEntry?.metadata as Record<string, unknown>;
    expect(batchMeta["taskIds"]).toEqual([TASK_A, TASK_B]);
    expect(batchMeta["changedFields"]).toEqual(["ownerIds", "priority", "plannedEnd"]);
    expect(batchMeta["batchId"]).toBe(batchId);
    expect(batchMeta["failures"]).toEqual([]);
  });

  it("部分失败：不存在 / 不属于该项目的 id 进 failures（not_found），成功项照常生效", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_C, makeRow(TASK_C, { projectId: OTHER_PROJECT }));
    const { service, audit } = makeService(repo);
    const result = await service.batch(PROJECT, { ids: [TASK_A, GONE, TASK_C], changes: { note: "批量备注" } }, ACTOR);
    expect(result.total).toBe(3);
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(2);
    expect(result.failures.map((failure) => failure.id)).toEqual([GONE, TASK_C]);
    expect(result.failures.every((failure) => failure.code === "not_found")).toBe(true);
    expect(repo.tasks.get(TASK_A)?.note).toBe("批量备注");
    expect(repo.tasks.get(TASK_C)?.version).toBe(3);
    const batchEntry = audit.entries.find((entry) => entry.objectType === "project");
    expect(batchEntry?.summary).toBe("批量操作任务：3 条（成功 1，失败 2）");
    expect((batchEntry?.metadata as Record<string, unknown>)["failures"]).toEqual([
      { id: GONE, code: "not_found" },
      { id: TASK_C, code: "not_found" },
    ]);
  });

  it("ids 去重：重复 id 只处理一次（total = 去重后条数）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db } = makeService(repo);
    const result = await service.batch(PROJECT, { ids: [TASK_A, TASK_A, TASK_B, TASK_A], changes: { headcount: 3 } }, ACTOR);
    expect(result.total).toBe(2);
    expect(result.succeededCount).toBe(2);
    expect(db.outbox.filter((row) => row.topic === "task.updated")).toHaveLength(2);
  });

  it("空 changes → 400 VALIDATION_FAILED（不进逐条处理）", async () => {
    const repo = new FakeTaskRepository();
    const { service, db } = makeService(repo);
    await expect(service.batch(PROJECT, { ids: [TASK_A], changes: {} }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(db.outbox).toEqual([]);
  });

  it("归档项目：入口 409 PROJECT_ARCHIVED（不进逐条处理）", async () => {
    const repo = new FakeTaskRepository();
    repo.project = { ...repo.project, status: "archived" };
    const { service } = makeService(repo);
    await expect(service.batch(PROJECT, { ids: [TASK_A], changes: { note: "x" } }, ACTOR)).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      httpStatus: 409,
    });
  });

  it("批量指派：ownerIds 显式 [] = 全部置为「待分配」（语义同单条编辑）", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { ownerIds: [OWNER] }));
    const { service } = makeService(repo);
    const result = await service.batch(PROJECT, { ids: [TASK_A, TASK_B], changes: { ownerIds: [] } }, ACTOR);
    expect(result.succeededCount).toBe(2);
    expect(result.succeeded[0]?.ownerIds).toEqual([]);
    expect(repo.tasks.get(TASK_A)?.ownerIds).toEqual([]);
  });

  it("批量完成（门禁放行）：done + 满格 + 完成日期按当天，逐条写事件留痕", async () => {
    const repo = new FakeTaskRepository();
    const { service } = makeService(repo);
    const result = await service.batch(PROJECT, { ids: [TASK_A, TASK_B], changes: { status: "done" } }, ACTOR);
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.succeeded.every((task) => task.status === "done" && task.progress === 1)).toBe(true);
    const done = repo.tasks.get(TASK_A);
    expect(done?.status).toBe("done");
    expect(Number(done?.progress)).toBe(1);
    expect(done?.actualEnd).toBe(shanghaiToday(new Date()));
    expect(repo.events.some((event) => event.eventType === "status_change")).toBe(true);
  });

  it("批量完成缺件（门禁暂时下线 2026-09-30）：两条都放行 —— 无 gate_not_passed、无拒绝留痕", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { nodeId: null, deliverableTypes: ["合同"] }));
    const gate = new FakeTaskGateRepository();
    const { service, db, audit } = makeService(repo, gate);
    const result = await service.batch(PROJECT, { ids: [TASK_A, TASK_B], changes: { status: "done" } }, ACTOR);
    // 恢复门禁时还原：TASK_A gate_not_passed + missing 明细 + task.gate_rejected 留痕 + batch 元数据审计
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(repo.tasks.get(TASK_A)?.status).toBe("done");
    expect(repo.tasks.get(TASK_B)?.status).toBe("done");
    expect(db.outbox.some((row) => row.topic === "task.gate_rejected")).toBe(false);
    expect(audit.entries.some((entry) => entry.result === "failed")).toBe(false);
  });

  it("批量完成遇已完成：该条 already_done（不重复写），同批其它条目照常完成", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { status: "done", progress: "1", actualEnd: "2026-09-10" }));
    const { service } = makeService(repo);
    const result = await service.batch(PROJECT, { ids: [TASK_A, TASK_B], changes: { status: "done" } }, ACTOR);
    expect(result.succeededCount).toBe(1);
    expect(result.failures).toEqual([{ id: TASK_A, code: "already_done", message: "任务已完成，无需重复提交" }]);
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(repo.tasks.get(TASK_A)?.actualEnd).toBe("2026-09-10");
    expect(repo.tasks.get(TASK_B)?.status).toBe("done");
  });
});
