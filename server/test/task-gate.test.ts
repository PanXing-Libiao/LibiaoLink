/**
 * M3-03 任务完成门禁回归（A4-20 / ADR-024 · 2026-10-29 口径）：
 * 配置了成果类型才要求对应上传文件；未配置成果类型不要求文件；draft 文件可完成并触发 R02。
 * 覆盖预检、完成提交、PATCH status / progress 与批量的同一门禁。
 */
import { describe, expect, it } from "vitest";
import type { AuditService } from "../src/modules/admin/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskCompletionTargetRow, TaskFileSummaryCounts, TaskListRow, TaskRow, TaskUpdatePatch } from "../src/modules/task/task.repository.js";
import type { TaskRepository } from "../src/modules/task/task.repository.js";
import type { TaskGateRepository } from "../src/modules/task/task.gate.repository.js";
import { shanghaiToday } from "../src/modules/task/task.rules.js";
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";

interface OutboxRow {
  topic: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

class FakeDatabase {
  outbox: OutboxRow[] = [];
  /** 事务桩：把 appendOutbox 的 insert().values() 收集到数组（不连库）。 */
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

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    projectId: PROJECT,
    stageKey: "install",
    nodeId: NODE,
    taskNodeId: null,
    title: "货架组装",
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

class FakeTaskRepository {
  async lockStageCompletion(): Promise<void> {}
  async countStageTasks(): Promise<{ total: number; done: number; deliveryReady: number }> {
    return { total: 0, done: 0, deliveryReady: 0 };
  }

  project = { id: PROJECT, managerIds: [] as string[], stageKey: "install", status: "active" };
  task: TaskRow | null = makeRow();
  eventCount = 0;
  touched: string[] = [];
  async findProject(): Promise<typeof this.project | null> {
    return this.project;
  }
  async lockTask(): Promise<TaskRow | null> {
    return this.task;
  }
  async findCompletionTarget(): Promise<TaskCompletionTargetRow | null> {
    return this.task === null
      ? null
      : {
          id: this.task.id,
          projectId: this.task.projectId,
          nodeId: this.task.nodeId,
          status: this.task.status,
          deliverableTypes: this.task.deliverableTypes,
        };
  }
  async updateWithVersion(_taskId: string, expectedVersion: number, patch: TaskUpdatePatch, at: Date): Promise<TaskRow | null> {
    const current = this.task;
    if (current === null || current.version !== expectedVersion) return null;
    const next: TaskRow = {
      ...current,
      status: patch.status ?? current.status,
      statusOverride: patch.statusOverride !== undefined ? patch.statusOverride : current.statusOverride,
      progress: patch.progress ?? current.progress,
      actualEnd: patch.actualEnd !== undefined ? patch.actualEnd : current.actualEnd,
      note: patch.note !== undefined ? patch.note : current.note,
      updatedAt: at,
      version: current.version + 1,
    };
    this.task = next;
    return next;
  }
  async insertEvents(): Promise<void> {
    this.eventCount += 1;
  }
  async touchProject(projectId: string): Promise<void> {
    this.touched.push(projectId);
  }
  async findListRowById(): Promise<TaskListRow | null> {
    return this.task === null ? null : { task: this.task, ownerNames: [], changeLinks: [] };
  }
  async listChangeLinks(): Promise<never[]> {
    return [];
  }
  async fileSummaries(): Promise<Map<string, TaskFileSummaryCounts>> {
    return new Map();
  }
}

/** 门禁替身：默认放行；用例注入 required_doc 要求与 final / draft 计数。 */
class FakeTaskGateRepository {
  requirements: { docType: string; minCount: number }[] = [];
  uploadedCounts: { docType: string | null; present: number }[] = [];
  draftCounts: { docType: string; present: number }[] = [];
  async listNodeDocRequirements(): Promise<{ docType: string; minCount: number }[]> {
    return this.requirements;
  }
  async countUploadedFiles(): Promise<{ docType: string | null; present: number }[]> {
    return this.uploadedCounts;
  }
  async countDraftFiles(): Promise<{ docType: string; present: number }[]> {
    return this.draftCounts;
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

function makeService(repo: FakeTaskRepository, gate: FakeTaskGateRepository): {
  service: TaskService;
  db: FakeDatabase;
  audit: FakeAuditService;
} {
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

describe("M3-03 · 任务完成门禁（A4-20 / ADR-024 · 2026-10-29 上传文件校验）", () => {
  it("预检：节点缺件 → canComplete=false + doc_type 缺件", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    const { service } = makeService(repo, gate);
    const result = await service.canComplete(PROJECT, TASK);
    expect(result.canComplete).toBe(false);
    expect(result.missing).toEqual([{ docType: "合同", required: 1, present: 0 }]);
    expect(result.warnings).toEqual([]);
  });

  it("预检：节点要求与任务输出成果合并校验（节点任务也不能漏掉任务侧新增类型）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ nodeId: NODE, deliverableTypes: ["验收单"] });
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    const { service } = makeService(repo, gate);
    const result = await service.canComplete(PROJECT, TASK);
    expect(result.canComplete).toBe(false);
    expect(result.missing).toEqual([{ docType: "验收单", required: 1, present: 0 }]);
  });

  it("预检：无节点任务按 deliverable_types 逐类校验", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ nodeId: null, deliverableTypes: ["合同", "验收单"] });
    const gate = new FakeTaskGateRepository();
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    const { service } = makeService(repo, gate);
    const result = await service.canComplete(PROJECT, TASK);
    expect(result.canComplete).toBe(false);
    expect(result.missing).toEqual([{ docType: "验收单", required: 1, present: 0 }]);
  });

  it("预检：未配置成果类型 → 直接通过（没有文件也放行）", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    const { service } = makeService(repo, gate);
    const result = await service.canComplete(PROJECT, TASK);
    expect(result.canComplete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("预检：配置成果类型且已上传 → 通过", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ nodeId: null, deliverableTypes: ["合同"] });
    const gate = new FakeTaskGateRepository();
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    const { service } = makeService(repo, gate);
    const result = await service.canComplete(PROJECT, TASK);
    expect(result.canComplete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("完成提交：缺件 → 422 TASK_REQUIRED_DOC_MISSING（不部分生效）+ outbox / 审计留痕", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    const { service, db, audit } = makeService(repo, gate);
    await expect(service.complete(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "TASK_REQUIRED_DOC_MISSING",
      httpStatus: 422,
    });
    expect(repo.task?.status).toBe("pending");
    const event = db.outbox.find((row) => row.topic === "task.gate_rejected");
    expect(event?.payload["taskId"]).toBe(TASK);
    expect(event?.dedupeKey.startsWith("task.gate_rejected:" + TASK + ":")).toBe(true);
    const failed = audit.entries.find((entry) => entry.result === "failed");
    expect(failed?.objectType).toBe("task");
    expect(failed?.action).toBe("complete");
  });

  it("完成提交：已配置成果类型但未上传 → 422（不能只点完成）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ nodeId: null, deliverableTypes: ["合同"] });
    const gate = new FakeTaskGateRepository();
    const { service, db } = makeService(repo, gate);
    await expect(service.complete(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "TASK_REQUIRED_DOC_MISSING",
      httpStatus: 422,
      message: "已配置的成果文件尚未上传，无法完成任务（TASK_REQUIRED_DOC_MISSING）",
    });
    expect(repo.task?.status).toBe("pending");
    expect(db.outbox.some((row) => row.topic === "task.completed")).toBe(false);
    expect(db.outbox.some((row) => row.topic === "task.gate_rejected")).toBe(true);
  });

  it("完成提交：门禁通过 → 200 task=done（满格 + 完成日期按当天）+ outbox task.completed", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.75" });
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    const { service, db } = makeService(repo, gate);
    const result = await service.complete(PROJECT, TASK, { version: 3 }, ACTOR);
    expect(result.task.status).toBe("done");
    expect(result.task.progress).toBe(1);
    expect(result.task.actualEnd).toBe(shanghaiToday(new Date()));
    expect(result.warnings).toEqual([]);
    expect(db.outbox.some((row) => row.topic === "task.completed")).toBe(true);
    expect(db.outbox.some((row) => row.topic === "task.draft_doc_reminded")).toBe(false);
  });

  it("完成提交：存在未定档（draft）→ 放行 + warning + R02 提醒入队", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    gate.draftCounts = [{ docType: "合同", present: 2 }];
    const { service, db } = makeService(repo, gate);
    const result = await service.complete(PROJECT, TASK, { version: 3 }, ACTOR);
    expect(result.task.status).toBe("done");
    expect(result.warnings).toEqual([{ code: "draft_doc_present", docType: "合同", count: 2 }]);
    expect(db.outbox.some((row) => row.topic === "task.draft_doc_reminded")).toBe(true);
  });

  it("已完成任务重复提交 → 409 TASK_ALREADY_DONE（不重复写）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "done", progress: "1", actualEnd: "2026-09-15" });
    const gate = new FakeTaskGateRepository();
    const { service } = makeService(repo, gate);
    await expect(service.complete(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "TASK_ALREADY_DONE",
      httpStatus: 409,
    });
  });

  it("表格编辑入口：PATCH status=done 缺件 422，不写库", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    const { service } = makeService(repo, gate);
    await expect(service.update(PROJECT, TASK, { status: "done", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "TASK_REQUIRED_DOC_MISSING",
      httpStatus: 422,
    });
    expect(repo.task?.status).toBe("pending");
  });

  it("表格编辑入口：PATCH status=early_done 已上传成果文件时触发 task.completed", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ deliverableTypes: ["合同"] });
    const gate = new FakeTaskGateRepository();
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    gate.draftCounts = [{ docType: "合同", present: 1 }];
    const { service, db } = makeService(repo, gate);
    const updated = await service.update(PROJECT, TASK, { status: "early_done", version: 3 }, ACTOR);
    expect(updated.displayStatus).toBe("early_done");
    expect(db.outbox.some((row) => row.topic === "task.completed")).toBe(true);
    expect(db.outbox.some((row) => row.topic === "task.draft_doc_reminded")).toBe(true);
  });

  it("批量状态完成：已上传成果文件时首次进入 done 也触发 task.completed", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ deliverableTypes: ["合同"] });
    const gate = new FakeTaskGateRepository();
    gate.uploadedCounts = [{ docType: "合同", present: 1 }];
    const { service, db } = makeService(repo, gate);
    const result = await service.batch(PROJECT, { ids: [TASK], changes: { status: "done" } }, ACTOR);
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(db.outbox.some((row) => row.topic === "task.completed")).toBe(true);
  });

  it("已完成任务再编辑其他字段：不重复发 task.completed", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "done", progress: "1", actualEnd: "2026-09-15" });
    const gate = new FakeTaskGateRepository();
    const { service, db } = makeService(repo, gate);
    await service.update(PROJECT, TASK, { note: "补充说明", version: 3 }, ACTOR);
    expect(db.outbox.some((row) => row.topic === "task.completed")).toBe(false);
  });

  it("看板 / 四格入口：PATCH progress=1 缺件 422", async () => {
    const repo = new FakeTaskRepository();
    const gate = new FakeTaskGateRepository();
    gate.requirements = [{ docType: "合同", minCount: 1 }];
    const { service } = makeService(repo, gate);
    await expect(service.updateProgress(PROJECT, TASK, { progress: 1, version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "TASK_REQUIRED_DOC_MISSING",
      httpStatus: 422,
    });
    expect(repo.task?.status).toBe("pending");
  });
});
