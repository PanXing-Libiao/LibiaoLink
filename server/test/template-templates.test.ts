/**
 * M3-05 余 · 第二段（任务模板 A1-16 / A1-17）服务回归：
 * 1) 列表：GET /api/v1/task-templates —— stage 缺省 = 全部阶段（null 透传仓库），指定阶段只回该阶段；nodes 按 seq 组装、随行 title / titleEn；
 * 2) 详情：GET /api/v1/task-templates/{id} —— 不存在 / 已软删 404；
 * 3) 新建：POST —— 名称 trim（全空白 400）；nodeIds 允许空；重复 id / 未知节点 / 跨阶段节点 400 VALIDATION_FAILED 且不落库不留痕；
 * 4) 编辑：PATCH —— 改名 / nodeIds 全量替换（seq 重排为 10/20/30）；乐观锁 version 过期 409 VERSION_CONFLICT；不存在 404；
 * 5) 删除：DELETE —— **软删**（deletedAt 回包 + 审计 action=delete 快照）；version 过期 409；不存在 404；
 * 6) 权限：写（新建 / 编辑 / 删除）= blueprint.manage（ADR-019 / ADR-020 仅系统管理员）—— 无权 403，且不落库、不留痕；
 * 7) 留痕：写操作各一条审计（objectType = task_template，changes 记名称 + 节点名顺序）；不写 outbox（与节点库 / 字典同口径）。
 * 契约见 shared/src/modules/templates.ts；真机口径见 server/src/modules/template/README.md。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { AuditRecordInput, AuditService } from "../src/modules/admin/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import { TemplateService } from "../src/modules/template/template.service.js";
import type { TaskNodeRepository, TaskNodeRow } from "../src/modules/template/index.js";
import type { TaskTemplateNodeRef, TaskTemplateRepository, TaskTemplateRow, TaskTemplateUpdatePatch } from "../src/modules/template/index.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TEMPLATE = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const OTHER_NODE = "77777777-7777-4777-8777-777777777777";
const MISSING = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-09-24T03:00:00Z");

function makeNode(overrides: Partial<TaskNodeRow> = {}): TaskNodeRow {
  return {
    id: OTHER_NODE,
    stageKey: "install",
    seq: 10,
    title: "货架组装",
    titleEn: "Shelf Assembly",
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<TaskTemplateRow> = {}): TaskTemplateRow {
  return {
    id: TEMPLATE,
    name: "硬件实施模板一",
    stageKey: "install",
    version: 0,
    createdBy: null,
    createdByName: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** 节点仓库替身：模板用例只用到 listByIds（存在 + 同阶段校验）。 */
class FakeTaskNodeRepository {
  rows: TaskNodeRow[] = [makeNode()];
  async listByIds(ids: string[]): Promise<TaskNodeRow[]> {
    return this.rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row }));
  }
}

class FakeTaskTemplateRepository {
  rows: TaskTemplateRow[] = [makeTemplate()];
  refs: TaskTemplateNodeRef[] = [{ templateId: TEMPLATE, nodeId: OTHER_NODE, seq: 10, title: "货架组装", titleEn: "Shelf Assembly" }];
  listStages: (string | null)[] = [];
  private counter = 0;

  async list(stageKey: string | null): Promise<TaskTemplateRow[]> {
    this.listStages.push(stageKey);
    return this.rows.filter((row) => stageKey === null || row.stageKey === stageKey).map((row) => ({ ...row }));
  }

  async findById(id: string): Promise<TaskTemplateRow | null> {
    const row = this.rows.find((item) => item.id === id);
    return row === undefined ? null : { ...row };
  }

  async nodeRefsOf(ids: string[]): Promise<TaskTemplateNodeRef[]> {
    return this.refs.filter((ref) => ids.includes(ref.templateId)).map((ref) => ({ ...ref }));
  }

  async insert(input: { name: string; stageKey: string; createdBy: string }): Promise<TaskTemplateRow> {
    this.counter += 1;
    const row = makeTemplate({
      id: "8888888" + this.counter + "-8888-4888-8888-88888888888" + this.counter,
      name: input.name,
      stageKey: input.stageKey,
      createdBy: input.createdBy,
      createdByName: "测试填写人",
      version: 0,
    });
    this.rows.push(row);
    return { ...row };
  }

  async replaceNodes(templateId: string, nodeIds: string[]): Promise<void> {
    this.refs = this.refs.filter((ref) => ref.templateId !== templateId);
    nodeIds.forEach((nodeId, index) => {
      const node = this.nodesByRef.get(nodeId);
      this.refs.push({
        templateId,
        nodeId,
        seq: (index + 1) * 10,
        title: node?.title ?? nodeId,
        titleEn: node?.titleEn ?? null,
      });
    });
  }

  async updateWithVersion(id: string, expectedVersion: number, patch: TaskTemplateUpdatePatch, at: Date): Promise<TaskTemplateRow | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.version === expectedVersion);
    if (index < 0) return null;
    const current = this.rows[index] as TaskTemplateRow;
    const next: TaskTemplateRow = { ...current, ...patch, version: current.version + 1, updatedAt: at };
    this.rows[index] = next;
    return { ...next };
  }

  async softDelete(id: string, expectedVersion: number, _actorId: string, at: Date): Promise<TaskTemplateRow | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.version === expectedVersion);
    if (index < 0) return null;
    const current = this.rows[index] as TaskTemplateRow;
    this.rows.splice(index, 1);
    return { ...current, version: current.version + 1, updatedAt: at };
  }

  async countActiveByNodeId(_nodeId: string): Promise<number> {
    return 0;
  }

  /** replaceNodes 里按 id 取节点摘要（由 makeService 注入）。 */
  nodesByRef = new Map<string, { title: string; titleEn: string | null }>();
}

class FakePermissionService {
  lastKey: string | null = null;
  constructor(private readonly allowed: boolean) {}
  async assertCan(_actorId: string, key: string, _context?: unknown, message?: string): Promise<void> {
    this.lastKey = key;
    if (!this.allowed) throw new AppError("FORBIDDEN", message ?? "无权限：" + key);
  }
}

class FakeAuditService {
  records: AuditRecordInput[] = [];
  async record(_client: DbClient, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

class FakeDatabase {
  readonly tx = {} as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
  } as unknown as DatabaseService["db"];
}

function makeService(options: { allowed?: boolean; repo?: FakeTaskTemplateRepository; nodes?: FakeTaskNodeRepository } = {}) {
  const repo = options.repo ?? new FakeTaskTemplateRepository();
  const nodes = options.nodes ?? new FakeTaskNodeRepository();
  for (const node of nodes.rows) {
    repo.nodesByRef.set(node.id, { title: node.title, titleEn: node.titleEn });
  }
  const audit = new FakeAuditService();
  const permission = new FakePermissionService(options.allowed ?? true);
  const service = new TemplateService(
    nodes as unknown as TaskNodeRepository,
    repo as unknown as TaskTemplateRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    new FakeDatabase() as unknown as DatabaseService,
  );
  return { service, repo, nodes, audit, permission };
}

describe("模板列表 / 详情（读 = 登录即可）", () => {
  it("stage 缺省 = 全部阶段（null 透传仓库）；nodes 按 seq 组装、total 与 items 同步", async () => {
    const { service, repo } = makeService();
    repo.rows = [makeTemplate(), makeTemplate({ id: OTHER, stageKey: "design", name: "设计开发模板" })];
    const result = await service.listTemplates({});
    expect(repo.listStages).toEqual([null]);
    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({
      id: TEMPLATE,
      name: "硬件实施模板一",
      stageKey: "install",
      version: 0,
      createdAt: AT.toISOString(),
      updatedAt: AT.toISOString(),
      nodes: [{ nodeId: OTHER_NODE, seq: 10, title: "货架组装", titleEn: "Shelf Assembly" }],
    });
    expect(result.items[1]?.nodes).toEqual([]);
  });

  it("按阶段过滤；详情不存在 / 已软删（仓库返 null）→ 404 NOT_FOUND", async () => {
    const { service, repo } = makeService();
    repo.rows = [makeTemplate(), makeTemplate({ id: OTHER, stageKey: "design", name: "设计开发模板" })];
    const filtered = await service.listTemplates({ stage: "design" });
    expect(repo.listStages).toEqual(["design"]);
    expect(filtered.items.map((item) => item.name)).toEqual(["设计开发模板"]);
    await expect(service.getTemplate(MISSING)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("详情带节点顺序（title / titleEn 随行下发，模板预览可直接渲染）", async () => {
    const { service, repo } = makeService();
    repo.refs = [
      { templateId: TEMPLATE, nodeId: OTHER_NODE, seq: 20, title: "货架检查", titleEn: "Shelf inspection" },
      { templateId: TEMPLATE, nodeId: MISSING, seq: 10, title: "货架组装", titleEn: null },
    ];
    const detail = await service.getTemplate(TEMPLATE);
    expect(detail.nodes.map((node) => node.nodeId)).toEqual([OTHER_NODE, MISSING]);
    expect(detail.nodes[1]?.seq).toBe(10);
  });
});

describe("新建模板（写 = blueprint.manage）", () => {
  it("名称 trim + 节点顺序落库（seq = 10/20…）+ 审计 action=create", async () => {
    const { service, repo, audit, permission } = makeService();
    const created = await service.createTemplate(
      { name: "  英国订单  ", stageKey: "install", nodeIds: [OTHER_NODE] },
      ACTOR,
    );
    expect(permission.lastKey).toBe("blueprint.manage");
    expect(created).toMatchObject({
      name: "英国订单",
      stageKey: "install",
      createdBy: ACTOR,
      createdByName: "测试填写人",
      version: 0,
    });
    expect(created.nodes).toEqual([{ nodeId: OTHER_NODE, seq: 10, title: "货架组装", titleEn: "Shelf Assembly" }]);
    expect(repo.rows.map((row) => row.name)).toEqual(["硬件实施模板一", "英国订单"]);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "create",
      objectType: "task_template",
      objectId: created.id,
      summary: "新增任务模板：硬件实施 · 英国订单",
      metadata: { stageKey: "install", nodeCount: 1 },
      changes: [
        { field: "name", from: null, to: "英国订单" },
        { field: "nodes", from: null, to: ["货架组装"] },
      ],
    });
  });

  it("nodeIds 允许空数组（新建后逐步拖入）", async () => {
    const { service } = makeService();
    const created = await service.createTemplate({ name: "未命名模板", stageKey: "install", nodeIds: [] }, ACTOR);
    expect(created.nodes).toEqual([]);
  });

  it("名称全空白 → 400 VALIDATION_FAILED，不落库", async () => {
    const { service, repo, audit } = makeService();
    await expect(
      service.createTemplate({ name: "   ", stageKey: "install", nodeIds: [] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });

  it("重复 id → 400 VALIDATION_FAILED", async () => {
    const { service, repo, audit } = makeService();
    await expect(
      service.createTemplate({ name: "重复", stageKey: "install", nodeIds: [OTHER_NODE, OTHER_NODE] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });

  it("节点不存在 → 400；节点跨阶段 → 400（模板内节点必须同阶段）", async () => {
    const missing = makeService();
    await expect(
      missing.service.createTemplate({ name: "未知", stageKey: "install", nodeIds: [MISSING] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const foreign = makeService();
    foreign.nodes.rows = [makeNode({ id: OTHER_NODE, stageKey: "design", title: "规划设计" })];
    await expect(
      foreign.service.createTemplate({ name: "跨阶段", stageKey: "install", nodeIds: [OTHER_NODE] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(foreign.repo.rows).toHaveLength(1);
  });

  it("非管理员 → 403 FORBIDDEN，不落库不留痕", async () => {
    const { service, repo, audit } = makeService({ allowed: false });
    await expect(
      service.createTemplate({ name: "英国订单", stageKey: "install", nodeIds: [] }, ACTOR),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });
});

describe("编辑模板（改名 / 节点全量替换 + 乐观锁）", () => {
  it("改名 + 节点整体替换：version +1、diff 只含 name 与 nodes、审计 action=update", async () => {
    const { service, repo, audit, permission } = makeService();
    const updated = await service.updateTemplate(TEMPLATE, { name: "  英国订单  ", nodeIds: [OTHER_NODE], version: 0 }, ACTOR);
    expect(permission.lastKey).toBe("blueprint.manage");
    expect(updated).toMatchObject({ id: TEMPLATE, name: "英国订单", version: 1 });
    expect(updated.nodes).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: "update",
      objectType: "task_template",
      objectId: TEMPLATE,
      summary: "编辑任务模板：硬件实施 · 英国订单",
      metadata: { stageKey: "install", nodeCount: 1 },
    });
    expect(audit.records[0]?.changes).toEqual([{ field: "name", from: "硬件实施模板一", to: "英国订单" }]);
  });

  it("节点清空（nodeIds = []）：引用行清掉、审计记 nodes 变化", async () => {
    const { service, repo, audit } = makeService();
    const updated = await service.updateTemplate(TEMPLATE, { nodeIds: [], version: 0 }, ACTOR);
    expect(updated.nodes).toEqual([]);
    expect(repo.refs).toHaveLength(0);
    expect(audit.records[0]?.changes).toEqual([{ field: "nodes", from: ["货架组装"], to: [] }]);
  });

  it("version 过期 → 409 VERSION_CONFLICT，不落库不留痕", async () => {
    const { service, repo, audit } = makeService();
    repo.rows = [makeTemplate({ version: 3 })];
    await expect(
      service.updateTemplate(TEMPLATE, { name: "新名字", version: 2 }, ACTOR),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(repo.rows[0]).toMatchObject({ name: "硬件实施模板一", version: 3 });
    expect(audit.records).toHaveLength(0);
  });

  it("模板不存在 / 已软删 → 404 NOT_FOUND（非管理员 403 优先）", async () => {
    const first = makeService();
    await expect(first.service.updateTemplate(MISSING, { name: "新名字", version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const second = makeService({ allowed: false });
    await expect(second.service.updateTemplate(TEMPLATE, { name: "新名字", version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(second.repo.rows[0]).toMatchObject({ name: "硬件实施模板一", version: 0 });
  });
});

describe("删除模板（软删 + 审计快照）", () => {
  it("软删成功：回包 deletedAt、行从读面消失、审计 action=delete（快照进 changes）", async () => {
    const { service, repo, audit, permission } = makeService();
    const result = await service.deleteTemplate(TEMPLATE, { version: 0 }, ACTOR);
    expect(permission.lastKey).toBe("blueprint.manage");
    expect(result).toEqual({ id: TEMPLATE, deletedAt: expect.any(String) });
    expect(repo.rows).toHaveLength(0);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "delete",
      objectType: "task_template",
      objectId: TEMPLATE,
      summary: "删除任务模板：硬件实施 · 硬件实施模板一",
      metadata: { stageKey: "install", nodeCount: 1 },
      changes: [
        { field: "name", from: "硬件实施模板一", to: null },
        { field: "nodes", from: ["货架组装"], to: null },
      ],
    });
  });

  it("version 过期 → 409 VERSION_CONFLICT，不删不留痕", async () => {
    const { service, repo, audit } = makeService();
    repo.rows = [makeTemplate({ version: 2 })];
    await expect(service.deleteTemplate(TEMPLATE, { version: 1 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });

  it("模板不存在 → 404 NOT_FOUND；非管理员 → 403 FORBIDDEN，不删不留痕", async () => {
    const first = makeService();
    await expect(first.service.deleteTemplate(MISSING, { version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const second = makeService({ allowed: false });
    await expect(second.service.deleteTemplate(TEMPLATE, { version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(second.repo.rows).toHaveLength(1);
    expect(second.audit.records).toHaveLength(0);
  });
});
