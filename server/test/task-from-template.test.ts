/**
 * M3-07 刀 3 · 添加任务模板化（A1-16 / A1-17 / A11）：
 * - POST /projects/{id}/tasks 的 sourceNodeId（节点库来源）：描述 / 英文名 / 阶段取节点现值、成员可建、按项目判重 409；
 * - POST /projects/{id}/tasks/from-template（模板实例化）：「整套添加」整批落库 + skipped 清单 + 同事务 + 位次。
 * 替身测试（仓储 / 门禁 / 审计 / 部门权限 / 节点库 / 模板服务替身），不连库、不起 Nest。
 */
import { describe, expect, it } from "vitest";
import type { AuditService } from "../src/modules/admin/index.js";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { TaskGateRepository } from "../src/modules/task/task.gate.repository.js";
import type { TaskInsertInput, TaskProjectRow, TaskRepository, TaskRow } from "../src/modules/task/task.repository.js";
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TaskNodeRow, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const MANAGER = "caa8d763-4b6a-4967-9b26-7d1086272c9c";
const MANAGER_2 = "b0f1c9d2-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const NODE_A = "33333333-3333-4333-8333-333333333331";
const NODE_B = "33333333-3333-4333-8333-333333333332";
const NODE_C = "33333333-3333-4333-8333-333333333333";
const TEMPLATE = "44444444-4444-4444-8444-444444444444";

function makeNode(id: string, title: string, titleEn: string | null): TaskNodeRow {
  return {
    id,
    stageKey: "install",
    seq: 10,
    title,
    titleEn,
    version: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    projectId: PROJECT,
    stageKey: "install",
    nodeId: null,
    taskNodeId: null,
    title: "货架组装",
    titleEn: null,
    ownerIds: [MANAGER],
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
    version: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
    deletedBy: null,
    finalizedAt: null,
    finalizedBy: null,
    ...overrides,
  };
}

/** 任务仓储替身：只实现 create / createFromTemplate 用到的读与写。 */
class FakeTaskRepository {
  async lockStageCompletion(): Promise<void> {}
  async countStageTasks(): Promise<{ total: number; done: number; deliveryReady: number }> {
    return { total: 0, done: 0, deliveryReady: 0 };
  }

  project: TaskProjectRow = { id: PROJECT, managerIds: [MANAGER], stageKey: "presale", status: "active" };
  /** 节点库来源判重表：sourceNodeId → 已存在任务 id。 */
  bySourceNode = new Map<string, string>();
  inserted: TaskInsertInput[] = [];
  touched: string[] = [];
  shifted: { from: number; to: number | null; delta: number }[] = [];
  groupSize = 0;
  private seq = 0;

  async findProject(): Promise<TaskProjectRow | null> {
    return this.project;
  }
  async findTaskIdsBySourceNodes(_projectId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const id of ids) {
      const hit = this.bySourceNode.get(id);
      if (hit !== undefined) found.set(id, hit);
    }
    return found;
  }
  async countGroup(): Promise<number> {
    return this.groupSize;
  }
  async shiftGroupIndexes(
    _projectId: string,
    _stageKey: string | null,
    from: number,
    to: number | null,
    delta: number,
  ): Promise<void> {
    this.shifted.push({ from, to, delta });
  }
  async insert(input: TaskInsertInput): Promise<TaskRow> {
    this.inserted.push(input);
    this.seq += 1;
    return makeRow({
      id: "aaaaaaaa-0000-4000-8000-" + String(this.seq).padStart(12, "0"),
      stageKey: input.stageKey,
      nodeId: input.nodeId,
      taskNodeId: input.sourceNodeId,
      title: input.title,
      titleEn: input.titleEn,
      ownerIds: input.ownerIds,
      sortIndex: input.sortIndex,
      priority: input.priority,
    });
  }
  async touchProject(projectId: string): Promise<void> {
    this.touched.push(projectId);
  }
}

/** 节点库替身：只实现 findById（sourceNodeId 校验）。 */
class FakeTaskNodeRepository {
  nodes = new Map<string, TaskNodeRow>();
  async findById(id: string): Promise<TaskNodeRow | null> {
    return this.nodes.get(id) ?? null;
  }
}

/** 模板服务替身：只实现 getTemplate（契约 TaskTemplate，nodes 顺序 = 模板内顺序）。 */
class FakeTemplateService {
  template: {
    id: string;
    name: string;
    stageKey: string;
    nodes: { nodeId: string; seq: number; title: string; titleEn: string | null }[];
  } | null = {
    id: TEMPLATE,
    name: "硬件实施模板一",
    stageKey: "install",
    nodes: [
      { nodeId: NODE_A, seq: 10, title: "货架组装", titleEn: "Rack assembly" },
      { nodeId: NODE_B, seq: 20, title: "货架检查", titleEn: null },
      { nodeId: NODE_C, seq: 30, title: "挂件安装", titleEn: "Hanger installation" },
    ],
  };
  async getTemplate(id: string): Promise<unknown> {
    if (this.template === null) throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
    return this.template;
  }
}

class FakePermissionService {
  async canManageGroupAccess(): Promise<boolean> {
    return false;
  }
}

class FakeDatabase {
  outbox: unknown[] = [];
  db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(this.makeTx()),
  };
  makeTx() {
    return {
      insert: () => ({
        values: async (value: unknown) => {
          this.outbox.push(value);
        },
      }),
    };
  }
}

class FakeAuditService {
  entries: { objectId?: string; summary?: string; metadata?: unknown }[] = [];
  async record(_client: unknown, input: { objectId?: string; summary?: string; metadata?: unknown }): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(
  repo: FakeTaskRepository,
  nodes: FakeTaskNodeRepository = new FakeTaskNodeRepository(),
  templates: FakeTemplateService = new FakeTemplateService(),
  permission: FakePermissionService = new FakePermissionService(),
): { service: TaskService; audit: FakeAuditService; database: FakeDatabase } {
  const database = new FakeDatabase();
  const audit = new FakeAuditService();
  const service = new TaskService(
    database as unknown as DatabaseService,
    repo as unknown as TaskRepository,
    {} as unknown as TaskGateRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    nodes as unknown as TaskNodeRepository,
    templates as unknown as TemplateService,
  );
  return { service, audit, database };
}

describe("TaskService.create · sourceNodeId（节点库来源 · A1-16）", () => {
  it("从节点库生成：描述 / 英文名 / 阶段取节点现值，落来源，成员可建（不上管理员门禁）", async () => {
    const repo = new FakeTaskRepository();
    const nodes = new FakeTaskNodeRepository();
    nodes.nodes.set(NODE_A, makeNode(NODE_A, "货架组装", "Rack assembly"));
    const { service, audit } = makeService(repo, nodes);

    const created = await service.create(PROJECT, { title: "占位（以节点为准）", sourceNodeId: NODE_A }, ACTOR);

    expect(created.title).toBe("货架组装");
    expect(created.titleEn).toBe("Rack assembly");
    expect(created.stageKey).toBe("install");
    expect(created.sourceNodeId).toBe(NODE_A);
    expect(created.ownerIds).toEqual([]);
    expect(repo.inserted[0]?.sourceNodeId).toBe(NODE_A);
    expect(repo.touched).toEqual([PROJECT]);
    expect(audit.entries[0]?.metadata).toMatchObject({ sourceNodeId: NODE_A, source: "task_node" });
  });

  it("同节点重复添加 → 409 TASK_ALREADY_EXISTS", async () => {
    const repo = new FakeTaskRepository();
    const nodes = new FakeTaskNodeRepository();
    nodes.nodes.set(NODE_A, makeNode(NODE_A, "货架组装", null));
    repo.bySourceNode.set(NODE_A, "66666666-6666-4666-8666-666666666666");
    const { service } = makeService(repo, nodes);

    await expect(service.create(PROJECT, { title: "货架组装", sourceNodeId: NODE_A }, ACTOR)).rejects.toMatchObject({
      code: "TASK_ALREADY_EXISTS",
      httpStatus: 409,
    });
    expect(repo.inserted).toHaveLength(0);
  });

  it("sourceNodeId 不在节点库 → 400 VALIDATION_FAILED", async () => {
    const repo = new FakeTaskRepository();
    const { service } = makeService(repo);
    await expect(service.create(PROJECT, { title: "货架组装", sourceNodeId: NODE_A }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("stageKey 与节点阶段不一致 → 400", async () => {
    const repo = new FakeTaskRepository();
    const nodes = new FakeTaskNodeRepository();
    nodes.nodes.set(NODE_A, makeNode(NODE_A, "货架组装", null));
    const { service } = makeService(repo, nodes);
    await expect(
      service.create(PROJECT, { title: "货架组装", stageKey: "deploy", sourceNodeId: NODE_A }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("taskNodeId（流程节点）与 sourceNodeId（节点库）同传 → 400", async () => {
    const repo = new FakeTaskRepository();
    const nodes = new FakeTaskNodeRepository();
    nodes.nodes.set(NODE_A, makeNode(NODE_A, "货架组装", null));
    const { service } = makeService(repo, nodes);
    await expect(
      service.create(PROJECT, { title: "货架组装", taskNodeId: NODE_B, sourceNodeId: NODE_A }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("手工创建（无节点、无来源）非管理员仍 403（A1-13 口径未变）", async () => {
    const repo = new FakeTaskRepository();
    const { service } = makeService(repo);
    await expect(service.create(PROJECT, { stageKey: "install", title: "临时任务" }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
  });
});

describe("TaskService.createFromTemplate（模板实例化 · A11 / A1-16）", () => {
  it("整批按模板内顺序创建：阶段取模板、描述取节点、负责人缺省 = 「待分配」空数组、位次从 sortIndex 起、逐条 outbox 与审计", async () => {
    const repo = new FakeTaskRepository();
    repo.groupSize = 2;
    const { service, audit, database } = makeService(repo);

    const result = await service.createFromTemplate(
      PROJECT,
      { templateId: TEMPLATE, skipExisting: true, sortIndex: 1, priority: "中" },
      ACTOR,
    );

    expect(result.created.map((task) => task.title)).toEqual(["货架组装", "货架检查", "挂件安装"]);
    expect(result.created.every((task) => task.stageKey === "install")).toBe(true);
    expect(result.created.map((task) => task.sourceNodeId)).toEqual([NODE_A, NODE_B, NODE_C]);
    expect(result.skipped).toEqual([]);
    expect(repo.inserted.map((input) => input.sortIndex)).toEqual([1, 2, 3]);
    expect(repo.inserted.every((input) => input.nodeId === null)).toBe(true);
    expect(repo.inserted.every((input) => String(input.titleEn ?? "") !== "undefined")).toBe(true);
    expect(repo.inserted[1]?.titleEn).toBeNull();
    expect(repo.inserted.map((input) => input.priority)).toEqual(["中", "中", "中"]);
    expect(repo.inserted[0]?.ownerIds).toEqual([]);
    expect(repo.shifted).toEqual([{ from: 1, to: null, delta: 3 }]);
    expect(database.outbox).toHaveLength(3);
    expect(audit.entries).toHaveLength(3);
    expect(audit.entries[0]?.metadata).toMatchObject({ templateId: TEMPLATE, sourceNodeId: NODE_A, kind: "from_template" });
    expect(repo.touched).toEqual([PROJECT]);
  });

  it("已存在的节点进 skipped（带已存在任务 id），不重复创建", async () => {
    const repo = new FakeTaskRepository();
    const existing = "66666666-6666-4666-8666-666666666666";
    repo.bySourceNode.set(NODE_B, existing);
    const { service } = makeService(repo);

    const result = await service.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: true }, ACTOR);

    expect(result.skipped).toEqual([{ nodeId: NODE_B, taskId: existing }]);
    expect(result.created.map((task) => task.sourceNodeId)).toEqual([NODE_A, NODE_C]);
    expect(repo.inserted).toHaveLength(2);
  });

  it("skipExisting=false 且存在重复 → 409，且一条都不落（整批同事务）", async () => {
    const repo = new FakeTaskRepository();
    repo.bySourceNode.set(NODE_C, "66666666-6666-4666-8666-666666666666");
    const { service } = makeService(repo);

    await expect(
      service.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: false }, ACTOR),
    ).rejects.toMatchObject({ code: "TASK_ALREADY_EXISTS", httpStatus: 409 });
    expect(repo.inserted).toHaveLength(0);
  });

  it("nodeIds 子集：只创建选中的节点（顺序仍按模板内顺序）；不属于模板 → 400", async () => {
    const repo = new FakeTaskRepository();
    const { service } = makeService(repo);

    const result = await service.createFromTemplate(
      PROJECT,
      { templateId: TEMPLATE, skipExisting: true, nodeIds: [NODE_C, NODE_A] },
      ACTOR,
    );
    expect(result.created.map((task) => task.sourceNodeId)).toEqual([NODE_A, NODE_C]);

    await expect(
      service.createFromTemplate(
        PROJECT,
        { templateId: TEMPLATE, skipExisting: true, nodeIds: ["77777777-7777-4777-8777-777777777777"] },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("缺省位次 = 组尾（不触发顺延）；空模板返回空结果（不写审计、不 touch）", async () => {
    const repo = new FakeTaskRepository();
    repo.groupSize = 5;
    const templates = new FakeTemplateService();
    const { service, audit } = makeService(repo, new FakeTaskNodeRepository(), templates);

    const tail = await service.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: true }, ACTOR);
    expect(repo.inserted.map((input) => input.sortIndex)).toEqual([5, 6, 7]);
    expect(repo.shifted).toEqual([]);
    expect(tail.created).toHaveLength(3);

    templates.template = { id: TEMPLATE, name: "空模板", stageKey: "install", nodes: [] };
    const empty = await service.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: true }, ACTOR);
    expect(empty).toEqual({ created: [], skipped: [] });
    expect(audit.entries).toHaveLength(3);
  });

  it("模板不存在 → 404 冒泡；归档项目 → 409 PROJECT_ARCHIVED", async () => {
    const repo = new FakeTaskRepository();
    const templates = new FakeTemplateService();
    templates.template = null;
    const { service } = makeService(repo, new FakeTaskNodeRepository(), templates);
    await expect(
      service.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: true }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });

    const archived = new FakeTaskRepository();
    archived.project = { id: PROJECT, managerIds: [MANAGER, MANAGER_2], stageKey: "install", status: "archived" };
    const { service: archivedService } = makeService(archived);
    await expect(
      archivedService.createFromTemplate(PROJECT, { templateId: TEMPLATE, skipExisting: true }, ACTOR),
    ).rejects.toMatchObject({ code: "PROJECT_ARCHIVED", httpStatus: 409 });
  });
});
