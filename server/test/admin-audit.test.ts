import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import { isUuidLike, objectRefOfUrl, shouldRecordDenied } from "../src/common/audit/audit-path.js";
import type { DatabaseService } from "../src/db/database.service.js";
import { diffRecords, stableValue } from "../src/modules/admin/audit.rules.js";
import { AuditService, toAuditLog } from "../src/modules/audit/audit.service.js";
import type { AuditInsertInput, AuditListFilter, AuditRepository, AuditRow } from "../src/modules/audit/audit.repository.js";
import { DictService } from "../src/modules/admin/dict.service.js";
import type { DictItemRow, DictRepository, DictTypeRow } from "../src/modules/admin/dict.repository.js";

const AT = new Date("2026-09-20T06:00:00.000Z");
const UUID_PROJECT = "11111111-1111-4111-8111-111111111111";
const UUID_ACTOR = "22222222-2222-4222-8222-222222222222";

async function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 AppError，但未抛出");
}

// ---------- 替身（不连库；方法签名与真实仓储同形，多余参数忽略） ----------

class FakeDictRepository {
  types: DictTypeRow[] = [{ code: "region", name: "地区", sort: 10, enabled: true, updatedAt: AT }];
  items: DictItemRow[] = [
    { id: UUID_PROJECT, typeCode: "region", code: "华东", name: "华东", sort: 10, enabled: true, metadata: {}, updatedAt: AT },
    { id: UUID_ACTOR, typeCode: "region", code: "华东旧", name: "华东（停用）", sort: 20, enabled: false, metadata: {}, updatedAt: AT },
  ];
  touched: string[] = [];

  async findType(type: string): Promise<DictTypeRow | null> {
    return this.types.find((row) => row.code === type) ?? null;
  }

  async listTypes(): Promise<DictTypeRow[]> {
    return this.types.filter((row) => row.enabled);
  }

  async listItems(type: string, includeDisabled: boolean): Promise<DictItemRow[]> {
    return this.items.filter((row) => row.typeCode === type && (includeDisabled || row.enabled));
  }

  async findItem(type: string, code: string): Promise<DictItemRow | null> {
    const row = this.items.find((item) => item.typeCode === type && item.code === code);
    return row === undefined ? null : { ...row };
  }

  async insertItem(input: { typeCode: string; code: string; name: string; sort: number; enabled: boolean; metadata: Record<string, unknown> }, _actorId: string, at: Date): Promise<DictItemRow> {
    const row: DictItemRow = { id: UUID_PROJECT, ...input, updatedAt: at };
    this.items.push(row);
    return row;
  }

  async updateItem(type: string, code: string, patch: { name?: string; sort?: number; enabled?: boolean; metadata?: Record<string, unknown> }, _actorId: string, at: Date): Promise<DictItemRow | null> {
    const row = this.items.find((item) => item.typeCode === type && item.code === code);
    if (row === undefined) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.sort !== undefined) row.sort = patch.sort;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.metadata !== undefined) row.metadata = patch.metadata;
    row.updatedAt = at;
    return { ...row };
  }

  async deleteItem(type: string, code: string): Promise<DictItemRow | null> {
    const index = this.items.findIndex((item) => item.typeCode === type && item.code === code);
    if (index < 0) return null;
    const [row] = this.items.splice(index, 1);
    return row === undefined ? null : { ...row };
  }

  /** 项目引用计数（A3 删除守卫 · Push 174）：用例按需注入；缺省空表 = 没有任何项目在用它。 */
  usage: Map<string, number> = new Map();

  async usageCounts(_type: string): Promise<Map<string, number>> {
    return new Map(this.usage);
  }

  async touchType(type: string, at: Date): Promise<void> {
    this.touched.push(type);
    const row = this.types.find((item) => item.code === type);
    if (row !== undefined) row.updatedAt = at;
  }
}

class FakeAuditRepository {
  inserted: AuditInsertInput[] = [];
  rows: AuditRow[] = [];
  lastFilter: AuditListFilter | null = null;

  async insert(_client: unknown, input: AuditInsertInput): Promise<void> {
    this.inserted.push(input);
  }

  async listPage(filter: AuditListFilter, limit: number, offset: number): Promise<{ items: AuditRow[]; total: number }> {
    this.lastFilter = filter;
    void limit;
    void offset;
    return { items: this.rows, total: this.rows.length };
  }

  async findUserDisplayName(userId: string): Promise<string | null> {
    return userId === UUID_ACTOR ? "张三" : null;
  }
}

class ExplodingAuditRepository extends FakeAuditRepository {
  override async insert(): Promise<void> {
    throw new Error("db down");
  }
}

const FAKE_DB = { db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) } };

function makeAuditService(repository: FakeAuditRepository = new FakeAuditRepository()): { service: AuditService; repo: FakeAuditRepository } {
  const service = new AuditService(FAKE_DB as unknown as DatabaseService, repository as unknown as AuditRepository);
  return { service, repo: repository };
}

function makeDictService(): { service: DictService; dicts: FakeDictRepository; audit: FakeAuditRepository } {
  const dicts = new FakeDictRepository();
  const audit = new FakeAuditRepository();
  const service = new DictService(
    FAKE_DB as unknown as DatabaseService,
    dicts as unknown as DictRepository,
    new AuditService(FAKE_DB as unknown as DatabaseService, audit as unknown as AuditRepository),
  );
  return { service, dicts, audit };
}

// ---------- 字段级 diff（C7-02） ----------

describe("diffRecords / stableValue（字段级留痕 C7-02）", () => {
  it("只输出发生变化的字段；新增 / 删除以 null 表示", () => {
    const changes = diffRecords(
      { name: "华东", sort: 10, enabled: true },
      { name: "华东区", sort: 10, enabled: false, metadata: { accent: "#3b82f6" } },
    );
    expect(changes).toEqual([
      { field: "enabled", from: true, to: false },
      { field: "metadata", from: null, to: { accent: "#3b82f6" } },
      { field: "name", from: "华东", to: "华东区" },
    ]);
  });

  it("键序无关：对象值按稳定序列化比较", () => {
    expect(stableValue({ a: 1, b: [2, 3] })).toBe(stableValue({ b: [2, 3], a: 1 }));
    expect(diffRecords({ metadata: { a: 1, b: 2 } }, { metadata: { b: 2, a: 1 } })).toEqual([]);
  });

  it("日期归一化为 ISO；数字与字符串不相等（1 与 \"1\" 记为变更）", () => {
    expect(stableValue(new Date("2026-09-20T06:00:00.000Z"))).toBe("2026-09-20T06:00:00.000Z");
    expect(diffRecords({ version: 1 }, { version: "1" })).toEqual([{ field: "version", from: 1, to: "1" }]);
  });
});

// ---------- 越权 / 未命中留痕的路径解析（C7-03） ----------

describe("objectRefOfUrl / shouldRecordDenied（越权留痕 C7-03）", () => {
  it("按最具体的资源段判定对象类型，objectId 取路径里最靠后的 uuid", () => {
    expect(objectRefOfUrl("/api/v1/projects/" + UUID_PROJECT)).toEqual({ objectType: "project", objectId: UUID_PROJECT });
    expect(objectRefOfUrl("/api/v1/projects/" + UUID_PROJECT + "/tasks/" + UUID_ACTOR)).toEqual({
      objectType: "task",
      objectId: UUID_ACTOR,
    });
    expect(objectRefOfUrl("/api/v1/projects/" + UUID_PROJECT + "/members/" + UUID_ACTOR)).toEqual({
      objectType: "project_member",
      objectId: UUID_ACTOR,
    });
    expect(objectRefOfUrl("/api/v1/dicts/region")).toEqual({ objectType: "dict_item", objectId: "region" });
    expect(objectRefOfUrl("/api/v1/dicts/region/items")).toEqual({ objectType: "dict_item", objectId: "region" });
    expect(objectRefOfUrl("/api/v1/dicts/region/items/" + encodeURIComponent("华东"))).toEqual({ objectType: "dict_item", objectId: "region:华东" });
    expect(objectRefOfUrl("/api/v1/blueprint?projectType=T-sort")).toEqual({ objectType: "blueprint", objectId: "blueprint" });
  });

  it("非 /api/v1 或未知资源段不记（返回 null）", () => {
    expect(objectRefOfUrl("/auth/login")).toBeNull();
    expect(objectRefOfUrl("/api/v1/permissions/me")).toBeNull();
    expect(isUuidLike(UUID_PROJECT)).toBe(true);
    expect(isUuidLike("华东")).toBe(false);
  });

  it("403 一律记录；404 只记写请求与项目域路径", () => {
    expect(shouldRecordDenied("GET", "/api/v1/permissions/me", "FORBIDDEN")).toBe(true);
    expect(shouldRecordDenied("GET", "/api/v1/projects/" + UUID_PROJECT, "NOT_FOUND")).toBe(true);
    expect(shouldRecordDenied("GET", "/api/v1/users", "NOT_FOUND")).toBe(false);
    expect(shouldRecordDenied("POST", "/api/v1/dicts/region/items", "NOT_FOUND")).toBe(true);
    expect(shouldRecordDenied("GET", "/api/v1/users", "VALIDATION_FAILED")).toBe(false);
  });
});

// ---------- 字典下发与维护（C9） ----------

describe("DictService（字典 C9）", () => {
  it("默认只下发启用项；includeDisabled=true 返回全集（管理端）", async () => {
    const { service } = makeDictService();
    const enabledOnly = await service.list(false);
    expect(enabledOnly.items[0]?.items.map((item) => item.code)).toEqual(["华东"]);
    const all = await service.get("region", true);
    expect(all.items.map((item) => item.code)).toEqual(["华东", "华东旧"]);
    expect(all.updatedAt).toBe(AT.toISOString());
  });

  it("未知类型 404 NOT_FOUND（契约口径）", async () => {
    const { service } = makeDictService();
    await expectAppErrorAsync(() => service.get("priority", false), "NOT_FOUND");
  });

  it("新增：同类型内码唯一（409 DICT_ITEM_EXISTS），成功后写审计并触碰字典版本", async () => {
    const { service, dicts, audit } = makeDictService();
    await expectAppErrorAsync(
      () => service.createItem("region", { code: "华东", name: "华东", sort: 0, enabled: true, metadata: {} }, UUID_ACTOR),
      "DICT_ITEM_EXISTS",
    );
    const dict = await service.createItem("region", { code: "西南", name: "西南", sort: 30, enabled: true, metadata: {} }, UUID_ACTOR);
    expect(dict.items.map((item) => item.code)).toContain("西南");
    expect(dicts.touched).toEqual(["region"]);
    expect(audit.inserted).toHaveLength(1);
    expect(audit.inserted[0]).toMatchObject({
      action: "create",
      objectType: "dict_item",
      objectId: "region:西南",
      actorId: UUID_ACTOR,
      actorName: "张三",
      result: "succeeded",
      entry: "api",
    });
  });

  it("兼容路径：PATCH enabled=false 仍可写（一期前端已改走物理删除），不删行", async () => {
    const { service, dicts, audit } = makeDictService();
    const dict = await service.updateItem("region", "华东", { enabled: false }, UUID_ACTOR);
    expect(dicts.items.find((item) => item.code === "华东")?.enabled).toBe(false);
    expect(dict.items.map((item) => item.code)).toEqual(["华东", "华东旧"]);
    const enabledOnly = await service.get("region", false);
    expect(enabledOnly.items.map((item) => item.code)).toEqual([]);
    expect(audit.inserted[0]).toMatchObject({ action: "update", objectId: "region:华东" });
    expect(audit.inserted[0]?.changes).toEqual([{ field: "enabled", from: true, to: false }]);
    expect(audit.inserted[0]?.summary).toContain("已停用");
  });

  it("更新不存在的码 404 NOT_FOUND；无实际变更仍留痕（changes=null）", async () => {
    const { service, audit } = makeDictService();
    await expectAppErrorAsync(() => service.updateItem("region", "不存在", { name: "x" }, UUID_ACTOR), "NOT_FOUND");
    await service.updateItem("region", "华东", { name: "华东" }, UUID_ACTOR);
    expect(audit.inserted[0]?.changes).toBeNull();
  });
  it("物理删除：删行 + 审计 action=delete（字段级 from→null）+ 触碰字典版本，响应不含该条目", async () => {
    const { service, dicts, audit } = makeDictService();
    const dict = await service.deleteItem("region", "华东旧", UUID_ACTOR);
    expect(dicts.items.some((item) => item.code === "华东旧")).toBe(false);
    expect(dict.items.map((item) => item.code)).toEqual(["华东"]);
    expect(dicts.touched).toEqual(["region"]);
    expect(audit.inserted).toHaveLength(1);
    expect(audit.inserted[0]).toMatchObject({
      action: "delete",
      objectType: "dict_item",
      objectId: "region:华东旧",
      actorId: UUID_ACTOR,
      actorName: "张三",
      result: "succeeded",
      entry: "api",
      summary: "删除字典项：地区 · 华东（停用）（华东旧）",
    });
    expect(audit.inserted[0]?.changes).toEqual([
      { field: "code", from: "华东旧", to: null },
      { field: "enabled", from: false, to: null },
      { field: "metadata", from: {}, to: null },
      { field: "name", from: "华东（停用）", to: null },
      { field: "sort", from: 20, to: null },
    ]);
  });

  it("删除后同码可重新新增（全新条目，不是「恢复」）：不 409，按本次参数落库", async () => {
    const { service, dicts } = makeDictService();
    await service.deleteItem("region", "华东旧", UUID_ACTOR);
    const dict = await service.createItem("region", { code: "华东旧", name: "华东新名", sort: 90, enabled: true, metadata: { accent: "#3b82f6" } }, UUID_ACTOR);
    const created = dict.items.filter((item) => item.code === "华东旧");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "华东新名", sort: 90, enabled: true, metadata: { accent: "#3b82f6" } });
    expect(dicts.items.filter((item) => item.code === "华东旧")).toHaveLength(1);
  });


  it("引用守卫：条目正被项目引用时 409 DICT_ITEM_IN_USE，不删行 / 不写审计 / 不触碰字典版本", async () => {
    const { service, dicts, audit } = makeDictService();
    dicts.usage.set("华东", 2);
    await expectAppErrorAsync(() => service.deleteItem("region", "华东", UUID_ACTOR), "DICT_ITEM_IN_USE");
    expect(dicts.items.some((item) => item.code === "华东")).toBe(true);
    expect(dicts.touched).toEqual([]);
    expect(audit.inserted).toHaveLength(0);
  });

  it("引用守卫：计数为 0（无引用 / 项目已软删）时照常物理删除", async () => {
    const { service, dicts, audit } = makeDictService();
    dicts.usage.set("华东旧", 0);
    const dict = await service.deleteItem("region", "华东旧", UUID_ACTOR);
    expect(dict.items.map((item) => item.code)).toEqual(["华东"]);
    expect(audit.inserted[0]).toMatchObject({ action: "delete", objectId: "region:华东旧" });
  });

  it("下发条目带 usageCount（未删除项目引用数；无引用为 0，删掉的条目不再出现）", async () => {
    const { service, dicts } = makeDictService();
    dicts.usage.set("华东", 3);
    const dict = await service.get("region", true);
    expect(dict.items.map((item) => [item.code, item.usageCount])).toEqual([["华东", 3], ["华东旧", 0]]);
  });
  it("删除未知类型 / 未知条目 404 NOT_FOUND，且不写审计", async () => {
    const { service, dicts, audit } = makeDictService();
    await expectAppErrorAsync(() => service.deleteItem("priority", "华东", UUID_ACTOR), "NOT_FOUND");
    await expectAppErrorAsync(() => service.deleteItem("region", "不存在", UUID_ACTOR), "NOT_FOUND");
    expect(audit.inserted).toHaveLength(0);
    expect(dicts.touched).toEqual([]);
  });

});

// ---------- 审计写入与检索（C7-01 / C7-04） ----------

describe("AuditService（审计 C7）", () => {
  it("事务内写审计时用同一连接读取操作人快照，不额外占用连接池", async () => {
    const { service, repo } = makeAuditService();
    const transaction = {} as never;
    repo.findUserDisplayName = async (_id: string, client?: unknown) => client === transaction ? "事务内姓名" : "旧姓名";
    await service.record(transaction, { actorId: UUID_ACTOR, action: "update", objectType: "file",
      objectId: UUID_PROJECT, summary: "取消 CAD 预览窗口" });
    expect(repo.inserted[0]?.actorName).toBe("事务内姓名");
  });

  it("record：补全 occurredAt / result / entry 与操作人姓名快照", async () => {
    const { service, repo } = makeAuditService();
    await service.record({} as never, {
      actorId: UUID_ACTOR,
      action: "create",
      objectType: "project",
      objectId: UUID_PROJECT,
      projectId: UUID_PROJECT,
      summary: "创建项目：X",
    });
    expect(repo.inserted[0]).toMatchObject({
      actorId: UUID_ACTOR,
      actorName: "张三",
      result: "succeeded",
      entry: "api",
      objectType: "project",
    });
    expect(repo.inserted[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it("recordDenied：result=denied / action=deny；写库失败只记日志不抛（不阻塞响应）", async () => {
    const healthy = makeAuditService();
    await healthy.service.recordDenied({
      actorId: UUID_ACTOR,
      actorName: null,
      objectType: "project",
      objectId: UUID_PROJECT,
      projectId: UUID_PROJECT,
      summary: "PATCH /api/v1/projects/x → FORBIDDEN",
      metadata: { errorCode: "FORBIDDEN" },
    });
    expect(healthy.repo.inserted[0]).toMatchObject({ action: "deny", result: "denied", entry: "api" });

    const broken = makeAuditService(new ExplodingAuditRepository());
    await expect(
      broken.service.recordDenied({
        actorId: UUID_ACTOR,
        actorName: "张三",
        objectType: "project",
        objectId: UUID_PROJECT,
        projectId: null,
        summary: "x",
        metadata: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("list：按对象 / 操作人过滤（h7 验收项②），时间入参与分页透传，行 → 契约映射", async () => {
    const { service, repo } = makeAuditService();
    repo.rows = [
      {
        id: 7,
        occurredAt: AT,
        actorId: UUID_ACTOR,
        actorName: "张三",
        action: "update",
        objectType: "project",
        objectId: UUID_PROJECT,
        projectId: UUID_PROJECT,
        result: "succeeded",
        entry: "api",
        summary: "修改项目",
        changes: [{ field: "name", from: "旧", to: "新" }],
        metadata: { traceId: "t-1" },
      },
    ];
    const page = await service.list({
      objectType: "project",
      objectId: UUID_PROJECT,
      actorId: UUID_ACTOR,
      page: 2,
      limit: 10,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T00:00:00.000Z",
    });
    expect(repo.lastFilter).toMatchObject({
      objectTypes: ["project"],
      objectId: UUID_PROJECT,
      actorIds: [UUID_ACTOR],
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-30T00:00:00.000Z"),
    });
    expect(page).toMatchObject({ page: 2, limit: 10, total: 1 });
    expect(page.items[0]).toMatchObject({
      id: 7,
      occurredAt: AT.toISOString(),
      actorName: "张三",
      changes: [{ field: "name", from: "旧", to: "新" }],
      metadata: { traceId: "t-1" },
    });
  });

  it("list：部门可见项目范围收窄审计查询；范围为空直接返回空页", async () => {
    const { service, repo } = makeAuditService();
    repo.rows = [
      {
        id: 8,
        occurredAt: AT,
        actorId: UUID_ACTOR,
        actorName: "张三",
        action: "update",
        objectType: "project",
        objectId: UUID_PROJECT,
        projectId: UUID_PROJECT,
        result: "succeeded",
        entry: "api",
        summary: "修改项目",
        changes: null,
        metadata: {},
      },
    ];
    const page = await service.list({ page: 1, limit: 50 }, [UUID_PROJECT]);
    expect(repo.lastFilter?.projectIds).toEqual([UUID_PROJECT]);
    expect(page.total).toBe(1);
    await service.list({ projectId: UUID_PROJECT, page: 1, limit: 50 }, [UUID_PROJECT]);
    expect(repo.lastFilter?.projectIds).toEqual([UUID_PROJECT]);
    const disjoint = await service.list({ projectId: "33333333-3333-4333-8333-333333333333", page: 1, limit: 50 }, [UUID_PROJECT]);
    expect(disjoint).toMatchObject({ items: [], total: 0, windowId: null });
    const empty = await service.list({ page: 1, limit: 50 }, []);
    expect(empty).toMatchObject({ items: [], total: 0, windowId: null });
  });

  it("list：多值筛选（2026-10-09 追订 · 操作记录里面也是）—— 逗号分隔 + 去重保序 + 逐值白名单，非法值 400", async () => {
    const { service, repo } = makeAuditService();
    await service.list({
      action: "update,create,update",
      objectType: "task,project",
      result: "denied,succeeded",
      actorId: UUID_ACTOR,
      page: 1,
      limit: 50,
    });
    expect(repo.lastFilter).toMatchObject({
      actions: ["update", "create"],
      objectTypes: ["task", "project"],
      results: ["denied", "succeeded"],
      actorIds: [UUID_ACTOR],
    });
    await expect(service.list({ action: "update,bogus", page: 1, limit: 50 })).rejects.toThrowError(/action/);
    await expect(service.list({ actorId: "not-a-uuid", page: 1, limit: 50 })).rejects.toThrowError(/actorId/);
  });

  it("list：关键字 q 透传（trim 后入 filter；空白 = 未传）—— Push 260 搜索", async () => {
    const { service, repo } = makeAuditService();
    await service.list({ q: "  定档  ", page: 1, limit: 50 });
    expect(repo.lastFilter?.keyword).toBe("定档");
    await service.list({ q: "   ", page: 1, limit: 50 });
    expect(repo.lastFilter?.keyword).toBeUndefined();
  });

  it("toAuditLog：changes 缺省为 null（无字段级变化）", () => {
    const view = toAuditLog({
      id: 1,
      occurredAt: AT,
      actorId: null,
      actorName: null,
      action: "deny",
      objectType: "node",
      objectId: UUID_PROJECT,
      projectId: null,
      result: "denied",
      entry: "api",
      summary: "拒绝",
      changes: null,
      metadata: {},
    });
    expect(view.changes).toBeNull();
    expect(view.actorId).toBeNull();
  });
});
