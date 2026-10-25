/**
 * M3-05 余 · 任务节点库（A1-16 / A1-17 第一段）服务回归：
 * 1) 列表：GET /api/v1/task-nodes —— stage 缺省 = 全部阶段（null 透传仓库），指定阶段 = 只回该阶段；
 * 2) 新增：缺省 seq = 该阶段末位 + 10；title / titleEn 归一（trim；空串 → null）；同阶段同名 409 NODE_ALREADY_EXISTS，跨阶段同名放行；
 * 3) 编辑：PATCH /api/v1/task-nodes/{id} —— 改名 / 英文名（trim；空串 → null 清空）；乐观锁 version 过期 409 VERSION_CONFLICT；
 *    改成同阶段已有名字 409 NODE_ALREADY_EXISTS（排除自身）；不存在 404 NOT_FOUND；
 * 4) 删除：物理删行 + 删除前快照写审计（objectType = task_node）；不存在 404 NOT_FOUND；
 * 5) 权限：写（新增 / 编辑 / 删除）= blueprint.manage（ADR-019 / ADR-020 仅系统管理员）—— 无权 403，且不落库、不留痕；
 * 6) 留痕：新增 / 编辑 / 删除各一条审计（create / update / delete；编辑写字段级 changes）；本刀不写 outbox（与字典维护同口径）。
 * 契约见 shared/src/modules/templates.ts；真机口径见 server/src/modules/template/README.md。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { AuditRecordInput, AuditService } from "../src/modules/admin/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import { TemplateService } from "../src/modules/template/template.service.js";
import type { TaskNodeInsertInput, TaskNodeRepository, TaskNodeRow, TaskNodeUpdatePatch } from "../src/modules/template/index.js";
import type { TaskTemplateRepository } from "../src/modules/template/index.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const NODE = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-09-24T03:00:00Z");

function makeRow(overrides: Partial<TaskNodeRow> = {}): TaskNodeRow {
  return {
    id: NODE,
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

class FakeTaskNodeRepository {
  rows: TaskNodeRow[] = [makeRow()];
  listStages: (string | null)[] = [];
  private counter = 0;

  async list(stageKey: string | null): Promise<TaskNodeRow[]> {
    this.listStages.push(stageKey);
    return this.rows.filter((row) => stageKey === null || row.stageKey === stageKey).map((row) => ({ ...row }));
  }

  async findById(id: string): Promise<TaskNodeRow | null> {
    const row = this.rows.find((item) => item.id === id);
    return row === undefined ? null : { ...row };
  }

  async findByTitle(stageKey: string, title: string): Promise<TaskNodeRow | null> {
    const row = this.rows.find((item) => item.stageKey === stageKey && item.title === title);
    return row === undefined ? null : { ...row };
  }

  async maxSeq(stageKey: string): Promise<number> {
    const values = this.rows.filter((row) => row.stageKey === stageKey).map((row) => row.seq);
    return values.length === 0 ? 0 : Math.max(...values);
  }

  async insert(input: TaskNodeInsertInput): Promise<TaskNodeRow> {
    this.counter += 1;
    const row = makeRow({ ...input, id: "4444444" + this.counter + "-4444-4444-8444-44444444444" + this.counter });
    this.rows.push(row);
    return { ...row };
  }

  async updateWithVersion(id: string, expectedVersion: number, patch: TaskNodeUpdatePatch): Promise<TaskNodeRow | null> {
    const index = this.rows.findIndex((row) => row.id === id && row.version === expectedVersion);
    if (index < 0) return null;
    const current = this.rows[index] as TaskNodeRow;
    const next: TaskNodeRow = { ...current, ...patch, version: current.version + 1, updatedAt: AT };
    this.rows[index] = next;
    return { ...next };
  }

  async deleteById(id: string): Promise<TaskNodeRow | null> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) return null;
    const removed = this.rows[index] as TaskNodeRow;
    this.rows.splice(index, 1);
    return { ...removed };
  }
}

class FakePermissionService {
  lastKey: string | null = null;
  constructor(private readonly allowed: boolean) {}
  async assertCan(_actorId: string, key: string, _context?: unknown, message?: string): Promise<void> {
    this.lastKey = key;
    if (!this.allowed) throw new AppError("FORBIDDEN", message ?? "无权限：" + key);
  }
  async assertCanManageBlueprint(_actorId: string, message?: string): Promise<void> {
    this.lastKey = "blueprint.manage";
    if (!this.allowed) throw new AppError("FORBIDDEN", message ?? "维护任务模板需要编辑权限");
  }
}

class FakeAuditService {
  records: AuditRecordInput[] = [];
  async record(_client: DbClient, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

/** 模板侧最小替身：删节点时只问「多少份未删模板引用了它」（审计影响面）。 */
class FakeTemplateRepository {
  referencing = 0;
  async countActiveByNodeId(_nodeId: string): Promise<number> {
    return this.referencing;
  }
}

class FakeDatabase {
  readonly tx = {} as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
  } as unknown as DatabaseService["db"];
}

function makeService(options: { allowed?: boolean; repo?: FakeTaskNodeRepository } = {}) {
  const repo = options.repo ?? new FakeTaskNodeRepository();
  const templates = new FakeTemplateRepository();
  const audit = new FakeAuditService();
  const permission = new FakePermissionService(options.allowed ?? true);
  const service = new TemplateService(
    repo as unknown as TaskNodeRepository,
    templates as unknown as TaskTemplateRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    new FakeDatabase() as unknown as DatabaseService,
  );
  return { service, repo, templates, audit, permission };
}

describe("节点库列表（读 = 登录即可）", () => {
  it("stage 缺省 = 全部阶段（null 透传仓库），total 与 items 同步", async () => {
    const { service, repo } = makeService();
    repo.rows = [makeRow(), makeRow({ id: MISSING, stageKey: "design", title: "方案评审" })];
    const result = await service.listNodes({});
    expect(repo.listStages).toEqual([null]);
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.title)).toEqual(["货架组装", "方案评审"]);
  });

  it("指定阶段 = 只回该阶段节点；契约字段齐（ISO 时间 + version 只读 0）", async () => {
    const { service, repo } = makeService();
    repo.rows = [makeRow(), makeRow({ id: MISSING, stageKey: "design", title: "方案评审" })];
    const result = await service.listNodes({ stage: "design" });
    expect(repo.listStages).toEqual(["design"]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: MISSING,
      stageKey: "design",
      title: "方案评审",
      titleEn: "Shelf Assembly",
      version: 0,
      createdAt: AT.toISOString(),
      updatedAt: AT.toISOString(),
    });
  });
});

describe("新增节点（写 = blueprint.manage）", () => {
  it("缺省 seq = 该阶段末位 + 10；title / titleEn 归一（trim；空串 → null）；审计 action=create", async () => {
    const { service, repo, audit, permission } = makeService();
    const created = await service.createNode({ stageKey: "install", title: "  货品复核  ", titleEn: "   " }, ACTOR);
    expect(permission.lastKey).toBe("blueprint.manage");
    expect(created).toMatchObject({ stageKey: "install", seq: 20, title: "货品复核", titleEn: null, version: 0 });
    expect(repo.rows.map((row) => row.title)).toEqual(["货架组装", "货品复核"]);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "create",
      objectType: "task_node",
      objectId: created.id,
      summary: "新增任务节点：硬件实施 · 货品复核",
      metadata: { stageKey: "install", seq: 20 },
    });
    expect(audit.records[0]?.changes).toEqual([
      { field: "seq", from: null, to: 20 },
      { field: "stageKey", from: null, to: "install" },
      { field: "title", from: null, to: "货品复核" },
    ]);
  });

  it("英文名归一落库（有值 = trim 后写入）", async () => {
    const { service } = makeService();
    const created = await service.createNode({ stageKey: "install", title: "线缆铺设", titleEn: "  Cabling  " }, ACTOR);
    expect(created.titleEn).toBe("Cabling");
  });

  it("显式 seq 原样落库（插队场景）", async () => {
    const { service } = makeService();
    const created = await service.createNode({ stageKey: "install", title: "插队节点", seq: 15 }, ACTOR);
    expect(created.seq).toBe(15);
  });

  it("同阶段同名 → 409 NODE_ALREADY_EXISTS，不落库不留痕", async () => {
    const { service, repo, audit } = makeService();
    await expect(service.createNode({ stageKey: "install", title: "货架组装" }, ACTOR)).rejects.toMatchObject({
      code: "NODE_ALREADY_EXISTS",
    });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });

  it("跨阶段同名放行（唯一口径 = 同阶段内）", async () => {
    const { service } = makeService();
    const created = await service.createNode({ stageKey: "design", title: "货架组装" }, ACTOR);
    expect(created).toMatchObject({ stageKey: "design", seq: 10, title: "货架组装", titleEn: null });
  });

  it("非管理员 → 403 FORBIDDEN，不落库不留痕", async () => {
    const { service, repo, audit } = makeService({ allowed: false });
    await expect(service.createNode({ stageKey: "install", title: "新节点" }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });
});

describe("删除节点（物理删行 + 删除前快照留痕）", () => {
  it("删行成功：deleted=true、行消失、审计 action=delete（快照进 changes）", async () => {
    const { service, repo, audit } = makeService();
    const result = await service.deleteNode(NODE, ACTOR);
    expect(result).toEqual({ id: NODE, deleted: true });
    expect(repo.rows).toHaveLength(0);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "delete",
      objectType: "task_node",
      objectId: NODE,
      summary: "删除任务节点：硬件实施 · 货架组装",
      metadata: { stageKey: "install", seq: 10, removedFromTemplates: 0 },
    });
    expect(audit.records[0]?.changes).toEqual([
      { field: "seq", from: 10, to: null },
      { field: "stageKey", from: "install", to: null },
      { field: "title", from: "货架组装", to: null },
      { field: "titleEn", from: "Shelf Assembly", to: null },
    ]);
  });

  it("被模板引用时照删：审计记 removedFromTemplates = 影响面（引用行随外键级联清掉）", async () => {
    const { service, templates, audit } = makeService();
    templates.referencing = 2;
    await service.deleteNode(NODE, ACTOR);
    expect(audit.records[0]?.metadata).toMatchObject({ removedFromTemplates: 2 });
  });

  it("节点不存在 → 404 NOT_FOUND，不留痕", async () => {
    const { service, audit } = makeService();
    await expect(service.deleteNode(MISSING, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.records).toHaveLength(0);
  });

  it("非管理员 → 403 FORBIDDEN，不删行不留痕", async () => {
    const { service, repo, audit } = makeService({ allowed: false });
    await expect(service.deleteNode(NODE, ACTOR)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(0);
  });
});

describe("编辑节点（改名 / 英文名 + 乐观锁）", () => {
  it("改名成功：version +1、diff 只含 title、审计 action=update", async () => {
    const { service, repo, audit, permission } = makeService();
    const updated = await service.updateNode(NODE, { title: "  货架复装  ", version: 0 }, ACTOR);
    expect(permission.lastKey).toBe("blueprint.manage");
    expect(updated).toMatchObject({ id: NODE, title: "货架复装", titleEn: "Shelf Assembly", version: 1 });
    expect(repo.rows[0]).toMatchObject({ title: "货架复装", version: 1 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "update",
      objectType: "task_node",
      objectId: NODE,
      summary: "编辑任务节点：硬件实施 · 货架复装",
      metadata: { stageKey: "install", seq: 10 },
    });
    expect(audit.records[0]?.changes).toEqual([{ field: "title", from: "货架组装", to: "货架复装" }]);
  });

  it("只改英文名（空串 → null 清空）", async () => {
    const { service, audit } = makeService();
    const updated = await service.updateNode(NODE, { titleEn: "  ", version: 0 }, ACTOR);
    expect(updated).toMatchObject({ title: "货架组装", titleEn: null, version: 1 });
    expect(audit.records[0]?.changes).toEqual([{ field: "titleEn", from: "Shelf Assembly", to: null }]);
  });

  it("改成自己（同名）放行，不算重复", async () => {
    const { service, audit } = makeService();
    const updated = await service.updateNode(NODE, { title: "货架组装", titleEn: "Racks", version: 0 }, ACTOR);
    expect(updated).toMatchObject({ title: "货架组装", titleEn: "Racks", version: 1 });
    expect(audit.records[0]?.changes).toEqual([{ field: "titleEn", from: "Shelf Assembly", to: "Racks" }]);
  });

  it("改成同阶段已有名字 → 409 NODE_ALREADY_EXISTS，不落库不留痕", async () => {
    const { service, repo, audit } = makeService();
    repo.rows = [makeRow(), makeRow({ id: MISSING, title: "线缆铺设" })];
    await expect(service.updateNode(NODE, { title: "线缆铺设", version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "NODE_ALREADY_EXISTS",
    });
    expect(repo.rows[0]).toMatchObject({ title: "货架组装", version: 0 });
    expect(audit.records).toHaveLength(0);
  });

  it("版本过期 → 409 VERSION_CONFLICT，不落库不留痕", async () => {
    const { service, repo, audit } = makeService();
    repo.rows = [makeRow({ version: 3 })];
    await expect(service.updateNode(NODE, { title: "新名字", version: 2 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(repo.rows[0]).toMatchObject({ title: "货架组装", version: 3 });
    expect(audit.records).toHaveLength(0);
  });

  it("节点不存在 → 404 NOT_FOUND；非管理员 → 403 FORBIDDEN，不落库不留痕", async () => {
    const first = makeService();
    await expect(first.service.updateNode(MISSING, { title: "新名字", version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const second = makeService({ allowed: false });
    await expect(second.service.updateNode(NODE, { title: "新名字", version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(second.repo.rows[0]).toMatchObject({ title: "货架组装", version: 0 });
    expect(second.audit.records).toHaveLength(0);
  });
});
