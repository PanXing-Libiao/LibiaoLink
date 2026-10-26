/**
 * M3-05 锁定字段例外调整回归（A1-17 / C9-07 · Push 153）：任务描述 / 输出成果文件按模板生成后锁定，
 * 常规编辑不可达；确需修正时仅系统管理员可执行，原因必填并留痕（审计 + outbox），空调整 400。
 * 真机口径见 server/README.md「M3-05 续卡」与 server/src/modules/task/README.md「锁定字段例外调整」。
 */
import { describe, expect, it } from "vitest";
import type { DocType } from "@libiaolink/contracts";
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
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const NODE = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
    deliverableTypes: ["合同"],
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

/** 任务仓储替身：只实现本切片涉及的读写（含锁定字段落库）。 */
class FakeTaskRepository {
  project: TaskProjectRow = { id: PROJECT, managerIds: [], stageKey: "install", status: "active" };
  tasks = new Map<string, TaskRow>();
  events: TaskEventInput[] = [];
  touched: string[] = [];

  constructor() {
    this.tasks.set(TASK_A, makeRow(TASK_A));
  }

  async findProject(): Promise<TaskProjectRow | null> {
    return this.project;
  }

  async lockTask(_tx: DbClient, taskId: string): Promise<TaskRow | null> {
    const row = this.tasks.get(taskId);
    return row !== undefined && row.deletedAt === null ? row : null;
  }

  async updateWithVersion(taskId: string, expectedVersion: number, patch: TaskUpdatePatch, at: Date): Promise<TaskRow | null> {
    const current = this.tasks.get(taskId);
    if (current === undefined || current.deletedAt !== null || current.version !== expectedVersion) return null;
    const next: TaskRow = {
      ...current,
      title: patch.title !== undefined ? patch.title : current.title,
      titleEn: patch.titleEn !== undefined ? patch.titleEn : current.titleEn,
      deliverableTypes: patch.deliverableTypes !== undefined ? patch.deliverableTypes : current.deliverableTypes,
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

  async findCompletionTarget(_client: DbClient, taskId: string): Promise<{ id: string; projectId: string; nodeId: string | null; status: string; deliverableTypes: string[] } | null> {
    const row = this.tasks.get(taskId);
    if (row === undefined || row.deletedAt !== null) return null;
    return { id: row.id, projectId: row.projectId, nodeId: row.nodeId, status: row.status, deliverableTypes: row.deliverableTypes };
  }

  async listChangeLinks(): Promise<never[]> {
    return [];
  }
}

class FakeTaskGateRepository {
  finalCounts: { docType: string; present: number }[] = [];
  async listNodeDocRequirements(): Promise<{ docType: string; minCount: number }[]> {
    return [];
  }
  async countFinalFiles(): Promise<{ docType: string; present: number }[]> {
    return this.finalCounts;
  }
  async countDraftFiles(): Promise<{ docType: string; present: number }[]> {
    return [];
  }
}

class FakeAuditService {
  entries: Record<string, unknown>[] = [];
  async record(_client: unknown, input: Record<string, unknown>): Promise<void> {
    this.entries.push(input);
  }
}

/** 部门权限管理员替身（assertAdmin 口径）：只有名单内账号可通过。 */
class FakePermissionService {
  admins = new Set<string>([ADMIN]);
  async canManageGroupAccess(actorId: string): Promise<boolean> {
    return this.admins.has(actorId);
  }
}

function makeService(repo: FakeTaskRepository, gate: FakeTaskGateRepository = new FakeTaskGateRepository()): { service: TaskService; db: FakeDatabase; audit: FakeAuditService } {
  const db = new FakeDatabase();
  const audit = new FakeAuditService();
  const service = new TaskService(
    db as unknown as DatabaseService,
    repo as unknown as TaskRepository,
    gate as unknown as TaskGateRepository,
    new FakePermissionService() as unknown as PermissionService,
    audit as unknown as AuditService,
    {} as unknown as TaskNodeRepository,
    {} as unknown as TemplateService,
  );
  return { service, db, audit };
}

/**
 * 锁定字段例外调整用例（A1-17 / C9-07）：仅系统管理员可达、原因必填、至少一个实际变化（空调整 400）；
 * 留痕 = 审计（changes = 锁定字段 diff）+ outbox task.locked_fields_adjusted；不写 task_events（四值闭集）。
 */
describe("M3-05 续卡 · 锁定字段例外调整（A1-17 / C9-07）", () => {
  it("管理员例外调整：title + deliverableTypes 落库 / 版本 +1 / 审计含原因 / outbox / touch 项目 / 不写 task_events", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    const view = await service.adjustLockedFields(
      PROJECT,
      TASK_A,
      { version: 3, reason: "模板修订：节点口径调整", title: "孔位复核（修订）", deliverableTypes: ["合同", "验收单"] },
      ADMIN,
    );
    expect(view.title).toBe("孔位复核（修订）");
    expect(view.deliverableTypes).toEqual(["合同", "验收单"]);
    expect(view.version).toBe(4);
    const row = repo.tasks.get(TASK_A);
    expect(row?.title).toBe("孔位复核（修订）");
    expect(row?.deliverableTypes).toEqual(["合同", "验收单"]);
    expect(row?.version).toBe(4);
    const outbox = db.outbox.filter((item) => item.topic === "task.locked_fields_adjusted");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.dedupeKey).toBe("task.locked_fields_adjusted:" + TASK_A + ":4");
    expect(outbox[0]?.payload).toMatchObject({
      projectId: PROJECT,
      taskId: TASK_A,
      fields: ["deliverableTypes", "title"],
      reason: "模板修订：节点口径调整",
      actorId: ADMIN,
    });
    const entry = audit.entries[0];
    expect(entry?.action).toBe("update");
    expect(entry?.objectType).toBe("task");
    expect(entry?.objectId).toBe(TASK_A);
    expect(entry?.projectId).toBe(PROJECT);
    expect(entry?.metadata).toMatchObject({
      reason: "模板修订：节点口径调整",
      kind: "locked_field_exception",
      adminOnly: true,
      fields: ["deliverableTypes", "title"],
    });
    const changes = entry?.changes as { field: string; from: unknown; to: unknown }[];
    expect(changes.map((change) => change.field)).toEqual(["deliverableTypes", "title"]);
    expect(changes.find((change) => change.field === "title")?.to).toBe("孔位复核（修订）");
    expect(repo.touched).toEqual([PROJECT]);
    expect(repo.events).toEqual([]);
  });

  it("非管理员：403 FORBIDDEN，不落库 / 无 outbox / 无审计 / 不 touch", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "自行修改", title: "改标题" }, MEMBER),
    ).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    expect(repo.tasks.get(TASK_A)?.title).toBe("任务 " + TASK_A.slice(0, 8));
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
    expect(repo.touched).toEqual([]);
  });
  it("空调整：同值 / 无字段 / 仅重复项 → 400 VALIDATION_FAILED，不写留痕", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    const sameTitle = "任务 " + TASK_A.slice(0, 8);
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "同值", title: sameTitle }, ADMIN),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "只给原因" }, ADMIN),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "去重后同值", deliverableTypes: ["合同", "合同"] }, ADMIN),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("乐观锁不匹配：409 VERSION_CONFLICT，不落库 / 无留痕", async () => {
    const repo = new FakeTaskRepository();
    const { service, db, audit } = makeService(repo);
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 2, reason: "过期版本", title: "改标题" }, ADMIN),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", httpStatus: 409 });
    expect(repo.tasks.get(TASK_A)?.title).toBe("任务 " + TASK_A.slice(0, 8));
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("归档项目：入口 409 PROJECT_ARCHIVED（权限校验之前，默认管理员也一样被拦）", async () => {
    const repo = new FakeTaskRepository();
    repo.project = { ...repo.project, status: "archived" };
    const { service, db, audit } = makeService(repo);
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "归档后修正", title: "改标题" }, ADMIN),
    ).rejects.toMatchObject({ code: "PROJECT_ARCHIVED", httpStatus: 409 });
    expect(repo.tasks.get(TASK_A)?.version).toBe(3);
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
  it("不存在 / 跨项目 / 已软删：统一 404 NOT_FOUND，不落库 / 无留痕", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_C, makeRow(TASK_C, { projectId: OTHER_PROJECT }));
    const { service, db, audit } = makeService(repo);
    const body = { version: 3, reason: "并发修正", title: "改标题" };
    await expect(service.adjustLockedFields(PROJECT, GONE, body, ADMIN)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(service.adjustLockedFields(PROJECT, TASK_C, body, ADMIN)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    repo.tasks.set(TASK_A, makeRow(TASK_A, { deletedAt: new Date("2026-09-10T00:00:00Z"), deletedBy: ADMIN }));
    await expect(service.adjustLockedFields(PROJECT, TASK_A, body, ADMIN)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(repo.tasks.get(TASK_C)?.title).toBe("任务 " + TASK_C.slice(0, 8));
    expect(repo.tasks.get(TASK_A)?.title).toBe("任务 " + TASK_A.slice(0, 8));
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("输出成果文件：去重 + 非法值过滤（normalizeDocTypes）；门禁暂时下线 2026-09-30 时缺件不参与预检", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { nodeId: null, deliverableTypes: ["合同"] }));
    const gate = new FakeTaskGateRepository();
    gate.finalCounts = [{ docType: "合同", present: 1 }];
    const { service } = makeService(repo, gate);
    await expect(service.canComplete(PROJECT, TASK_A)).resolves.toMatchObject({ canComplete: true, missing: [] });
    const view = await service.adjustLockedFields(
      PROJECT,
      TASK_A,
      { version: 3, reason: "补充验收单要求", deliverableTypes: ["验收单", "合同", "验收单", "非法值" as DocType] },
      ADMIN,
    );
    expect(view.deliverableTypes).toEqual(["验收单", "合同"]);
    // 门禁暂时下线（2026-09-30）：新增要求不再参与拦截（恢复门禁时还原：canComplete=false + missing=[{ docType: "验收单", required: 1, present: 0 }]）
    const blocked = await service.canComplete(PROJECT, TASK_A);
    expect(blocked.canComplete).toBe(true);
    expect(blocked.missing).toEqual([]);
    gate.finalCounts = [{ docType: "合同", present: 1 }, { docType: "验收单", present: 1 }];
    await expect(service.canComplete(PROJECT, TASK_A)).resolves.toMatchObject({ canComplete: true, missing: [] });
  });

  it("英文描述清空（titleEn = null）：落库 null，审计 changes 只记 titleEn", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { titleEn: "Kongwei review" }));
    const { service, db, audit } = makeService(repo);
    const view = await service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "英文名下线", titleEn: null }, ADMIN);
    expect(view.titleEn).toBeNull();
    expect(repo.tasks.get(TASK_A)?.titleEn).toBeNull();
    const changes = audit.entries[0]?.changes as { field: string; from: unknown; to: unknown }[];
    expect(changes).toEqual([{ field: "titleEn", from: "Kongwei review", to: null }]);
    expect(db.outbox[0]?.payload).toMatchObject({ fields: ["titleEn"] });
  });
});


describe("Push 249 · 定档任务写口闸（锁定字段例外调整）", () => {
  it("定档任务：管理员例外调整同样 409 TASK_FINALIZED（不支持任何修改；不落库 / 无 outbox / 无审计）", async () => {
    const repo = new FakeTaskRepository();
    repo.tasks.set(TASK_A, makeRow(TASK_A, { finalizedAt: new Date("2026-10-08T02:00:00Z"), finalizedBy: ADMIN }));
    const { service, db, audit } = makeService(repo);
    await expect(
      service.adjustLockedFields(PROJECT, TASK_A, { version: 3, reason: "定档后修正", title: "改标题" }, ADMIN),
    ).rejects.toMatchObject({ code: "TASK_FINALIZED", httpStatus: 409 });
    expect(db.outbox).toEqual([]);
    expect(audit.entries).toEqual([]);
  });
});
