import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import { buildProjectFilter, parseProjectSort, type ProjectFilter } from "../src/modules/project/project.query.js";
import {
  ProjectRepository,
  isUniqueViolation,
  type ProjectChildrenCounts,
  type ProjectRow,
  type ProjectViewRow,
} from "../src/modules/project/project.repository.js";
import { ProjectService, toProjectView } from "../src/modules/project/project.service.js";
import { DatabaseService } from "../src/db/database.service.js";
import { FlowService } from "../src/modules/project/flow.service.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { ObjectStorage } from "../src/storage/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";

const AT = new Date("2026-09-20T06:00:00.000Z");
const DAY_MS = 86_400_000;
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 AppError，但未抛出");
}

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

function projectRow(overrides: Partial<ProjectRow> & { id: string }): ProjectRow {
  return {
    code: "CNBJ-20260708-0001",
    seqNo: 1,
    name: "XX 客户分拣项目",
    customer: "XX 客户",
    region: "华东",
    projectType: "分拣",
    managerIds: [UUID_A],
    stageKey: "presale",
    status: "active",
    description: null,
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    deletedBy: null,
    archivedAt: null,
    archivedBy: null,
    ...overrides,
  };
}

// ---------- 内存替身（不连库；与 ProjectRepository 方法签名同形） ----------

class FakeProjectRepository {
  rows: ProjectViewRow[] = [];
  lastList: { filter: ProjectFilter; sorts: unknown; limit: number; offset: number; scope: unknown } | null = null;
  lastFacetFilter: ProjectFilter | null = null;
  lastHardDelete: { id: string; expectedVersion: number } | null = null;
  lastRecycle: { id: string; expectedVersion: number; actorId: string } | null = null;
  lastRestore: { id: string; expectedVersion: number } | null = null;
  lastLock: string | null = null;
  lastTouched: { id: string; at: Date } | null = null;
  lastExpiredCutoff: Date | null = null;
  lastExpiredLimit: number | null = null;

  private visible(id: string): ProjectViewRow | null {
    return this.rows.find((view) => view.project.id === id && view.project.deletedAt === null) ?? null;
  }

  async listPage(
    filter: ProjectFilter,
    sorts: unknown,
    limit: number,
    offset: number,
    scope: unknown,
  ): Promise<{ items: ProjectViewRow[]; total: number }> {
    this.lastList = { filter, sorts, limit, offset, scope };
    const matched = this.rows.filter((view) =>
      filter.recycled ? view.project.deletedAt !== null : view.project.deletedAt === null,
    );
    return { items: matched.slice(offset, offset + limit), total: matched.length };
  }

  async facets(filter: ProjectFilter, _scope: unknown): Promise<{
    total: number;
    region: Record<string, number>;
    projectType: Record<string, number>;
    managerId: Record<string, number>;
    stageKey: Record<string, number>;
    status: Record<string, number>;
  }> {
    this.lastFacetFilter = filter;
    return {
      total: 1,
      region: { "华东": 1 },
      projectType: { "分拣": 1 },
      managerId: { [UUID_A]: 1 },
      stageKey: { presale: 1 },
      status: { active: 1 },
    };
  }

  async findViewById(id: string): Promise<ProjectViewRow | null> {
    return this.visible(id);
  }

  async findRowById(id: string): Promise<ProjectRow | null> {
    return this.rows.find((view) => view.project.id === id)?.project ?? null;
  }

  async lockRowById(id: string): Promise<ProjectRow | null> {
    this.lastLock = id;
    return this.findRowById(id);
  }

  async listExpiredRecycledProjects(cutoff: Date, limit: number): Promise<ProjectRow[]> {
    this.lastExpiredCutoff = cutoff;
    this.lastExpiredLimit = limit;
    return this.rows
      .map((view) => view.project)
      .filter((row) => row.deletedAt !== null && row.deletedAt.getTime() <= cutoff.getTime())
      .sort((left, right) => left.deletedAt!.getTime() - right.deletedAt!.getTime())
      .slice(0, limit);
  }

  async recycleWithVersion(id: string, expectedVersion: number, at: Date, actorId: string): Promise<ProjectRow | null> {
    this.lastRecycle = { id, expectedVersion, actorId };
    const found = this.visible(id);
    if (found === null || found.project.version !== expectedVersion) return null;
    Object.assign(found.project, { deletedAt: at, deletedBy: actorId, version: expectedVersion + 1, updatedAt: at });
    return found.project;
  }

  async restoreWithVersion(id: string, expectedVersion: number, at: Date): Promise<ProjectRow | null> {
    this.lastRestore = { id, expectedVersion };
    const found = this.rows.find((view) => view.project.id === id && view.project.deletedAt !== null) ?? null;
    if (found === null || found.project.version !== expectedVersion) return null;
    Object.assign(found.project, { deletedAt: null, deletedBy: null, version: expectedVersion + 1, updatedAt: at });
    return found.project;
  }

  async insert(
    input: {
      code: string;
      name: string;
      customer: string | null;
      region: string;
      projectType: string;
      managerIds: string[];
      stageKey: string;
      description: string | null;
    },
    at: Date,
  ): Promise<ProjectRow> {
    if (this.rows.some((view) => view.project.code === input.code)) {
      throw new AppError("PROJECT_CODE_EXISTS", "项目编号已存在：" + input.code);
    }
    const used = new Set(this.rows.map((view) => view.project.seqNo));
    let seqNo = 1;
    while (used.has(seqNo)) seqNo += 1;
    const row = projectRow({
      id: UUID_B,
      code: input.code,
      seqNo,
      name: input.name,
      customer: input.customer,
      region: input.region,
      projectType: input.projectType,
      managerIds: input.managerIds,
      stageKey: input.stageKey,
      status: "active",
      description: input.description,
      createdAt: at,
      updatedAt: at,
    });
    this.rows.push({ project: row, managerNames: ["张工"] });
    return row;
  }

  async updateWithVersion(id: string, patch: Record<string, unknown>, expectedVersion: number, at: Date): Promise<ProjectRow | null> {
    const found = this.visible(id);
    if (found === null || found.project.version !== expectedVersion) return null;
    const next: ProjectRow = { ...found.project, ...patch, version: found.project.version + 1, updatedAt: at };
    this.rows = this.rows.map((view) => (view.project.id === id ? { ...view, project: next } : view));
    return next;
  }

  async hardDeleteWithVersion(
    id: string,
    expectedVersion: number,
  ): Promise<{ project: ProjectRow; children: ProjectChildrenCounts } | null> {
    this.lastHardDelete = { id, expectedVersion };
    const index = this.rows.findIndex(
      (view) => view.project.id === id && view.project.deletedAt !== null && view.project.version === expectedVersion,
    );
    const removed = index < 0 ? undefined : this.rows.splice(index, 1)[0];
    if (removed === undefined) return null;
    return {
      project: removed.project,
      children: {
        tasks: 0,
        nodes: 0,
        stages: 0,
        members: 0,
        stakeholders: 0,
        reports: 0,
        issues: 0,
        changeRequests: 0,
        files: 0,
      },
    };
  }

  async touch(id: string, at: Date): Promise<void> {
    this.lastTouched = { id, at };
  }

  async setStageKey(id: string, stageKey: string): Promise<void> {
    const found = this.rows.find((row) => row.project.id === id);
    if (found !== undefined) found.project.stageKey = stageKey;
  }
}

/** 审计替身（h7）：只记录写入调用；审计内容断言见 test/admin-audit.test.ts。 */
class FakeAuditService {
  entries: Array<Record<string, unknown>> = [];
  async record(_client: unknown, input: Record<string, unknown>): Promise<void> {
    this.entries.push(input);
  }
}

class FakePermissionService {
  constructor(private readonly adminIds: readonly string[] = []) {}

  async permissionsOf(actorId: string): Promise<{ roleCodes: string[]; dataScopes: string[]; permissionKeys: string[] }> {
    return {
      roleCodes: this.adminIds.includes(actorId) ? ["admin"] : ["member"],
      dataScopes: [],
      permissionKeys: [],
    };
  }
}

class FakeObjectStorage {
  purgedPrefixes: string[] = [];
  purgeError: Error | null = null;

  async purgePrefix(prefix: string): Promise<{ deletedVersions: number; deleteMarkers: number; deletedObjects: number }> {
    this.purgedPrefixes.push(prefix);
    if (this.purgeError !== null) throw this.purgeError;
    return { deletedVersions: 2, deleteMarkers: 1, deletedObjects: 3 };
  }
}

function makeService(
  rows: ProjectRow[] = [],
  options: { adminIds?: readonly string[] } = {},
): {
  service: ProjectService;
  repo: FakeProjectRepository;
  audit: FakeAuditService;
  permission: FakePermissionService;
  storage: FakeObjectStorage;
  outbox: Array<Record<string, unknown>>;
} {
  const audit = new FakeAuditService();
  const repo = new FakeProjectRepository();
  const permission = new FakePermissionService(options.adminIds);
  const storage = new FakeObjectStorage();
  const outbox: Array<Record<string, unknown>> = [];
  repo.rows = rows.map((row) => ({ project: row, managerNames: ["张工"] }));
  const tx = {
    insert: (_table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        outbox.push(value);
      },
    }),
  };
  const fakeDb = {
    db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(tx) },
  };
  const fakeFlow = {
    importSnapshot: (_tx: unknown, input: { requestedStageKey?: string }) =>
      Promise.resolve({
        activeStageKey: input.requestedStageKey ?? "presale",
        blueprintVersion: 1,
        stages: 9,
        nodes: 19,
        requirements: 8,
      }),
  };
  return {
    service: new ProjectService(
      fakeDb as unknown as DatabaseService,
      repo as unknown as ProjectRepository,
      fakeFlow as unknown as FlowService,
      audit as unknown as AuditService,
      permission as unknown as PermissionService,
      storage as unknown as ObjectStorage,
    ),
    repo,
    audit,
    permission,
    storage,
    outbox,
  };
}

// ---------- 列表筛选解析（M2-04） ----------

describe("buildProjectFilter（列表 / facets 共用口径）", () => {
  it("多值逗号拆分：去空白、丢空段；未传维度为 null；默认排除项目回收站", () => {
    const filter = buildProjectFilter({ "filter[region]": "华东, 华南 ,,", "filter[status]": "active,paused", page: 1, limit: 20 });
    expect(filter.regions).toEqual(["华东", "华南"]);
    expect(filter.statuses).toEqual(["active", "paused"]);
    expect(filter.projectTypes).toBeNull();
    expect(filter.managerIds).toBeNull();
    expect(filter.stageKeys).toBeNull();
    expect(filter.keyword).toBeNull();
    expect(filter.createdFrom).toBeNull();
    expect(filter.createdToExclusive).toBeNull();
    expect(filter.recycled).toBe(false);
  });

  it("filter[recycled]=true 只切换到项目回收站口径", () => {
    expect(buildProjectFilter({ "filter[recycled]": "true", page: 1, limit: 20 }).recycled).toBe(true);
    expect(buildProjectFilter({ "filter[recycled]": "false", page: 1, limit: 20 }).recycled).toBe(false);
  });

  it("非法枚举 / uuid 一律 400（不静默返回空列表）", () => {
    expectAppError(() => buildProjectFilter({ "filter[status]": "active,unknown", page: 1, limit: 20 }), "VALIDATION_FAILED");
    expectAppError(() => buildProjectFilter({ "filter[stageKey]": "presale,nope", page: 1, limit: 20 }), "VALIDATION_FAILED");
    expectAppError(() => buildProjectFilter({ "filter[managerId]": "not-a-uuid", page: 1, limit: 20 }), "VALIDATION_FAILED");
    expectAppError(
      () => buildProjectFilter({ "filter[recycled]": "yes" as "true", page: 1, limit: 20 }),
      "VALIDATION_FAILED",
    );
  });

  it("时间区间（项目创建时间，Push 175）按 Asia/Shanghai 日界：下界含当日 00:00、上界取次日 00:00（不含）", () => {
    const filter = buildProjectFilter({ "filter[timeFrom]": "2026-09-14", "filter[timeTo]": "2026-09-15", page: 1, limit: 20 });
    expect(filter.createdFrom?.toISOString()).toBe("2026-09-13T16:00:00.000Z");
    expect(filter.createdToExclusive?.toISOString()).toBe("2026-09-15T16:00:00.000Z");
  });

  it("只传一端合法；timeFrom 晚于 timeTo 返回 400", () => {
    expect(buildProjectFilter({ "filter[timeFrom]": "2026-09-14", page: 1, limit: 20 }).createdToExclusive).toBeNull();
    expect(buildProjectFilter({ "filter[timeTo]": "2026-09-15", page: 1, limit: 20 }).createdFrom).toBeNull();
    expectAppError(
      () => buildProjectFilter({ "filter[timeFrom]": "2026-09-15", "filter[timeTo]": "2026-09-14", page: 1, limit: 20 }),
      "VALIDATION_FAILED",
    );
  });

  it("关键字去首尾空白；空白串视同未传", () => {
    expect(buildProjectFilter({ q: "  分拣  ", page: 1, limit: 20 }).keyword).toBe("分拣");
    expect(buildProjectFilter({ q: "   ", page: 1, limit: 20 }).keyword).toBeNull();
  });
});

describe("parseProjectSort（白名单 updatedAt / createdAt / seqNo）", () => {
  it("缺省 = createdAt:desc（Push 175：默认按创建时间，最近创建的在前）", () => {
    expect(parseProjectSort(undefined)).toEqual([{ field: "createdAt", direction: "desc" }]);
    expect(parseProjectSort("")).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("多字段与方向；省略方向按 asc", () => {
    expect(parseProjectSort("seqNo")).toEqual([{ field: "seqNo", direction: "asc" }]);
    expect(parseProjectSort("createdAt:asc,seqNo:desc")).toEqual([
      { field: "createdAt", direction: "asc" },
      { field: "seqNo", direction: "desc" },
    ]);
  });

  it("白名单外字段 / 非法方向 400", () => {
    expectAppError(() => parseProjectSort("name:asc"), "VALIDATION_FAILED");
    expectAppError(() => parseProjectSort("updatedAt:up"), "VALIDATION_FAILED");
  });
});

// ---------- 行 → 契约视图 ----------

describe("toProjectView", () => {
  it("camelCase 对齐 + managerNames 随行下发 + ISO 时间 + 回收站字段", () => {
    const view = toProjectView({ project: projectRow({ id: UUID_A, customer: null }), managerNames: [null] });
    expect(view.id).toBe(UUID_A);
    expect(view.seqNo).toBe(1);
    expect(view.managerNames).toEqual([null]);
    expect(view.customer).toBeNull();
    expect(view.createdAt).toBe("2026-09-20T06:00:00.000Z");
    expect(view.deletedAt).toBeNull();
    expect(view.deletedBy).toBeNull();
    expect(Object.keys(view).sort()).toEqual([
      "archivedAt",
      "archivedBy",
      "code",
      "createdAt",
      "customer",
      "deletedAt",
      "deletedBy",
      "description",
      "id",
      "managerIds",
      "managerNames",
      "name",
      "projectType",
      "region",
      "seqNo",
      "stageKey",
      "status",
      "updatedAt",
      "version",
    ]);
  });

  it("多位项目经理（A22 · Push 136）：managerIds / managerNames 同下标一一对应", () => {
    const view = toProjectView({
      project: projectRow({ id: UUID_A, managerIds: [UUID_A, UUID_B] }),
      managerNames: ["张工", null],
    });
    expect(view.managerIds).toEqual([UUID_A, UUID_B]);
    expect(view.managerNames).toEqual(["张工", null]);
  });
});

// ---------- 用例（M2-01） ----------

describe("ProjectService（M2-01 项目 CRUD + 项目回收站）", () => {
  it("创建：缺省 stageKey = presale；seq_no 由仓储分配；返回随行 managerNames", async () => {
    const { service, repo } = makeService();
    const created = await service.createProject(
      { code: "CNBJ-20260708-0002", name: "新项目", region: "华东", projectType: "分拣", managerIds: [UUID_A] },
      UUID_A,
    );
    expect(created.stageKey).toBe("presale");
    expect(created.status).toBe("active");
    expect(created.seqNo).toBe(1);
    expect(created.version).toBe(0);
    expect(created.managerNames).toEqual(["张工"]);
    expect(repo.rows).toHaveLength(1);
  });

  it("创建：显式 stageKey 生效；编号重复 409 PROJECT_CODE_EXISTS", async () => {
    const { service } = makeService([projectRow({ id: UUID_A })]);
    const created = await service.createProject(
      { code: "X-2", name: "新项目", region: "华东", projectType: "分拣", managerIds: [UUID_A], stageKey: "install" },
      UUID_A,
    );
    expect(created.stageKey).toBe("install");
    await expectAppErrorAsync(
      () =>
        service.createProject(
          { code: "CNBJ-20260708-0001", name: "撞号", region: "华东", projectType: "分拣", managerIds: [UUID_A] },
          UUID_A,
        ),
      "PROJECT_CODE_EXISTS",
    );
  });

  it("列表：普通栏排除回收站；项目回收站只返回已软删项目", async () => {
    const alive = projectRow({ id: UUID_A, seqNo: 1 });
    const removed = projectRow({ id: UUID_B, seqNo: 2, deletedAt: AT, deletedBy: UUID_A, version: 3 });
    const { service, repo } = makeService([alive, removed]);
    const page = await service.listProjects({ page: 1, limit: 10 }, { kind: "all" });
    expect(page.total).toBe(1);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(10);
    expect(page.items.map((item) => item.id)).toEqual([UUID_A]);
    expect(repo.lastList?.filter.recycled).toBe(false);

    const recycled = await service.listProjects({ "filter[recycled]": "true", page: 1, limit: 10 }, { kind: "all" });
    expect(recycled.total).toBe(1);
    expect(recycled.items[0]).toMatchObject({ id: UUID_B, deletedAt: AT.toISOString(), deletedBy: UUID_A });
    expect(repo.lastList?.filter.recycled).toBe(true);

    await service.listProjects({ page: 2, limit: 10 }, { kind: "all" });
    expect(repo.lastList?.offset).toBe(10);
  });

  it("facets：与列表同筛选口径（同一 buildProjectFilter）", async () => {
    const { service, repo } = makeService([projectRow({ id: UUID_A })]);
    const facets = await service.getFacets({ "filter[status]": "active", page: 1, limit: 20 }, { kind: "all" });
    expect(facets.total).toBe(1);
    expect(facets.region).toEqual({ "华东": 1 });
    expect(repo.lastFacetFilter?.statuses).toEqual(["active"]);
    expect(repo.lastFacetFilter?.recycled).toBe(false);
  });

  it("详情：不存在 / 已软删统一 404 NOT_FOUND", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, deletedAt: AT })]);
    await expectAppErrorAsync(() => service.getProject(UUID_B), "NOT_FOUND");
    await expectAppErrorAsync(() => service.getProject(UUID_A), "NOT_FOUND");
  });

  it("更新：version 匹配则 +1 并落 updatedAt；返回更新后视图", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, version: 3 })]);
    const updated = await service.updateProject(UUID_A, { name: "改名", version: 3 }, UUID_A);
    expect(updated.name).toBe("改名");
    expect(updated.version).toBe(4);
    expect(updated.managerNames).toEqual(["张工"]);
  });

  it("更新为已完成：仅首次进入 done 写 project.completed；保持 done 不重复触发", async () => {
    const { service, outbox } = makeService([projectRow({ id: UUID_A, version: 3, status: "active" })]);

    const updated = await service.updateProject(UUID_A, { status: "done", version: 3 }, UUID_B);
    expect(updated.status).toBe("done");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toEqual({
      topic: "project.completed",
      dedupeKey: "project.completed:" + UUID_A + ":4",
      payload: {
        projectId: UUID_A,
        status: "done",
        previousStatus: "active",
        version: 4,
        actorId: UUID_B,
        at: expect.any(String),
      },
      status: "pending",
    });

    await service.updateProject(UUID_A, { status: "done", version: 4 }, UUID_B);
    expect(outbox).toHaveLength(1);
  });

  it("更新：version 不匹配 409 VERSION_CONFLICT；期间被删则 404", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, version: 3 })]);
    await expectAppErrorAsync(() => service.updateProject(UUID_A, { name: "改名", version: 2 }, UUID_A), "VERSION_CONFLICT");
    const { service: gone } = makeService([projectRow({ id: UUID_A, version: 3, deletedAt: AT })]);
    await expectAppErrorAsync(() => gone.updateProject(UUID_A, { name: "改名", version: 3 }, UUID_A), "NOT_FOUND");
  });

  it("更新 / 删除：归档项目写保护 409 PROJECT_ARCHIVED（ADR-027）", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, status: "archived" })]);
    await expectAppErrorAsync(() => service.updateProject(UUID_A, { name: "改名", version: 0 }, UUID_A), "PROJECT_ARCHIVED");
    await expectAppErrorAsync(() => service.deleteProject(UUID_A, 0, UUID_B), "PROJECT_ARCHIVED");
  });

  it("删除：移入项目回收站（不物理删行），普通列表 / 详情不可见、回收站可见、编号仍占用", async () => {
    const { service, repo, audit, storage } = makeService([projectRow({ id: UUID_A, version: 2 })]);
    const removed = await service.deleteProject(UUID_A, 2, UUID_B);
    expect(removed.id).toBe(UUID_A);
    expect(removed.version).toBe(3);
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.deletedBy).toBe(UUID_B);
    expect(repo.lastRecycle).toEqual({ id: UUID_A, expectedVersion: 2, actorId: UUID_B });
    expect(repo.lastHardDelete).toBeNull();
    expect(storage.purgedPrefixes).toEqual([]);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.project).toMatchObject({ id: UUID_A, version: 3, deletedBy: UUID_B });

    await expectAppErrorAsync(() => service.getProject(UUID_A), "NOT_FOUND");
    expect((await service.listProjects({ page: 1, limit: 20 }, { kind: "all" })).total).toBe(0);
    expect(
      (await service.listProjects({ "filter[recycled]": "true", page: 1, limit: 20 }, { kind: "all" })).total,
    ).toBe(1);
    expect(audit.entries[0]).toMatchObject({
      action: "delete",
      objectType: "project",
      objectId: UUID_A,
      metadata: { recycled: true, previousStatus: "active" },
    });

    await expectAppErrorAsync(
      () =>
        service.createProject(
          { code: "CNBJ-20260708-0001", name: "回收站占用编号", region: "华东", projectType: "分拣", managerIds: [UUID_A] },
          UUID_A,
        ),
      "PROJECT_CODE_EXISTS",
    );
  });

  it("删除：version 不匹配 409 VERSION_CONFLICT；不存在 404", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, version: 2 })]);
    await expectAppErrorAsync(() => service.deleteProject(UUID_A, 1, UUID_B), "VERSION_CONFLICT");
    await expectAppErrorAsync(() => service.deleteProject(UUID_B, 0, UUID_A), "NOT_FOUND");
  });

  it("恢复：清 deleted_at / deleted_by、version +1；恢复后回到普通列表", async () => {
    const { service, repo, audit } = makeService([
      projectRow({ id: UUID_A, version: 3, deletedAt: AT, deletedBy: UUID_B }),
    ]);
    const restored = await service.restoreProject(UUID_A, { version: 3 }, UUID_A);
    expect(restored).toMatchObject({ id: UUID_A, version: 4, deletedAt: null, deletedBy: null });
    expect(restored.managerNames).toEqual(["张工"]);
    expect(repo.lastRestore).toEqual({ id: UUID_A, expectedVersion: 3 });
    expect((await service.listProjects({ page: 1, limit: 20 }, { kind: "all" })).total).toBe(1);
    expect(
      (await service.listProjects({ "filter[recycled]": "true", page: 1, limit: 20 }, { kind: "all" })).total,
    ).toBe(0);
    expect(audit.entries[0]).toMatchObject({
      action: "update",
      objectType: "project",
      objectId: UUID_A,
      metadata: { restoredFrom: "project-recycle" },
    });
    await expectAppErrorAsync(() => service.restoreProject(UUID_A, { version: 4 }, UUID_A), "VALIDATION_FAILED");
  });

  it("恢复：非回收站项目 400；version 不匹配 409", async () => {
    const alive = makeService([projectRow({ id: UUID_A, version: 1 })]);
    await expectAppErrorAsync(() => alive.service.restoreProject(UUID_A, { version: 1 }, UUID_A), "VALIDATION_FAILED");

    const deleted = makeService([projectRow({ id: UUID_A, version: 3, deletedAt: AT, deletedBy: UUID_B })]);
    await expectAppErrorAsync(() => deleted.service.restoreProject(UUID_A, { version: 2 }, UUID_A), "VERSION_CONFLICT");
  });

  it("彻底删除：管理员清对象前缀 + 聚合数据，写审计", async () => {
    const { service, repo, audit, storage } = makeService(
      [projectRow({ id: UUID_A, version: 4, deletedAt: AT, deletedBy: UUID_B })],
      { adminIds: [UUID_B] },
    );
    const result = await service.purgeProject(UUID_A, { version: 4 }, UUID_B);
    expect(result.projectId).toBe(UUID_A);
    expect(result.purgedAt).not.toBe("");
    expect(storage.purgedPrefixes).toEqual(["projects/" + UUID_A + "/"]);
    expect(repo.lastHardDelete).toEqual({ id: UUID_A, expectedVersion: 4 });
    expect(repo.rows).toEqual([]);
    expect(audit.entries[0]).toMatchObject({
      action: "delete",
      objectType: "project",
      objectId: UUID_A,
      metadata: {
        hardDelete: true,
        objectStorage: { deletedVersions: 2, deleteMarkers: 1, deletedObjects: 3 },
      },
    });
  });

  it("彻底删除：非系统管理员 403，不触碰存储与数据库", async () => {
    const { service, repo, storage } = makeService([
      projectRow({ id: UUID_A, version: 4, deletedAt: AT, deletedBy: UUID_B }),
    ]);
    await expectAppErrorAsync(() => service.purgeProject(UUID_A, { version: 4 }, UUID_A), "FORBIDDEN");
    expect(storage.purgedPrefixes).toEqual([]);
    expect(repo.lastHardDelete).toBeNull();
    expect(repo.rows).toHaveLength(1);
  });

  it("彻底删除：仅回收站项目可执行；version 不匹配 409 且不触碰存储", async () => {
    const alive = makeService([projectRow({ id: UUID_A, version: 1 })], { adminIds: [UUID_B] });
    await expectAppErrorAsync(() => alive.service.purgeProject(UUID_A, { version: 1 }, UUID_B), "VALIDATION_FAILED");
    expect(alive.storage.purgedPrefixes).toEqual([]);

    const stale = makeService([projectRow({ id: UUID_A, version: 4, deletedAt: AT, deletedBy: UUID_B })], {
      adminIds: [UUID_B],
    });
    await expectAppErrorAsync(() => stale.service.purgeProject(UUID_A, { version: 3 }, UUID_B), "VERSION_CONFLICT");
    expect(stale.storage.purgedPrefixes).toEqual([]);
    expect(stale.repo.rows).toHaveLength(1);
  });

  it("编号复用：彻底删除后新建项目取回最小空号", async () => {
    const { service } = makeService([], { adminIds: [UUID_B] });
    const first = await service.createProject(
      { code: "REUSE-1", name: "首建", region: "华东", projectType: "分拣", managerIds: [UUID_A] },
      UUID_A,
    );
    expect(first.seqNo).toBe(1);
    await service.deleteProject(first.id, first.version, UUID_A);
    await service.purgeProject(first.id, { version: first.version + 1 }, UUID_B);
    const second = await service.createProject(
      { code: "REUSE-2", name: "再建", region: "华东", projectType: "分拣", managerIds: [UUID_A] },
      UUID_A,
    );
    expect(second.seqNo).toBe(1);
  });

  it("30 天到期：只清理满 30 天的回收站项目，系统审计 actorId=null", async () => {
    const now = new Date("2026-10-19T06:00:00.000Z");
    const due = projectRow({
      id: UUID_A,
      version: 3,
      deletedAt: new Date(now.getTime() - 30 * DAY_MS),
      deletedBy: UUID_B,
    });
    const fresh = projectRow({
      id: UUID_B,
      seqNo: 2,
      code: "FRESH-1",
      version: 2,
      deletedAt: new Date(now.getTime() - 29 * DAY_MS),
      deletedBy: UUID_B,
    });
    const { service, repo, audit, storage } = makeService([due, fresh]);
    const result = await service.sweepExpiredRecycled(20, now);
    expect(result).toEqual({ scanned: 1, purged: 1 });
    expect(repo.lastExpiredCutoff?.toISOString()).toBe(new Date(now.getTime() - 30 * DAY_MS).toISOString());
    expect(repo.lastExpiredLimit).toBe(20);
    expect(repo.rows.map((view) => view.project.id)).toEqual([UUID_B]);
    expect(storage.purgedPrefixes).toEqual(["projects/" + UUID_A + "/"]);
    expect(audit.entries[0]).toMatchObject({
      actorId: null,
      action: "delete",
      objectType: "project",
      objectId: UUID_A,
      metadata: {
        hardDelete: true,
        source: "system",
        reason: "项目回收站到期自动清理",
        retentionDays: 30,
      },
    });
  });

  it("30 天到期：未满 30 天不清理", async () => {
    const now = new Date("2026-10-19T06:00:00.000Z");
    const fresh = projectRow({
      id: UUID_A,
      version: 3,
      deletedAt: new Date(now.getTime() - 29 * DAY_MS - 23 * 3_600_000),
      deletedBy: UUID_B,
    });
    const { service, repo, storage } = makeService([fresh]);
    expect(await service.sweepExpiredRecycled(20, now)).toEqual({ scanned: 0, purged: 0 });
    expect(storage.purgedPrefixes).toEqual([]);
    expect(repo.rows).toHaveLength(1);
  });

  it("彻底删除：对象存储失败 → INTERNAL，项目仍留在回收站可重试", async () => {
    const { service, repo, storage } = makeService(
      [projectRow({ id: UUID_A, version: 4, deletedAt: AT, deletedBy: UUID_B })],
      { adminIds: [UUID_B] },
    );
    storage.purgeError = new Error("storage down");
    await expectAppErrorAsync(() => service.purgeProject(UUID_A, { version: 4 }, UUID_B), "INTERNAL");
    expect(repo.lastHardDelete).toBeNull();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.project.deletedAt).not.toBeNull();
  });
});

// ---------- 唯一约束违例解包（drizzle 0.45 把驱动错误包在 cause 上） ----------

describe("isUniqueViolation", () => {
  const wrapped = { name: "DrizzleQueryError", cause: { code: "23505", constraint: "projects_code_key" } };

  it("解包 cause 链后命中 projects_code_key（编号重复 → 409 PROJECT_CODE_EXISTS）", () => {
    expect(isUniqueViolation(wrapped, "projects_code_key")).toBe(true);
    expect(isUniqueViolation({ cause: wrapped }, "projects_code_key")).toBe(true);
  });

  it("约束名不符 / 非唯一违例 / 非对象 一律 false", () => {
    expect(isUniqueViolation(wrapped, "uq_projects_seq_no")).toBe(false);
    expect(isUniqueViolation({ code: "23503", constraint: "projects_code_key" }, "projects_code_key")).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "projects_code_key")).toBe(false);
    expect(isUniqueViolation(null, "projects_code_key")).toBe(false);
  });
});
