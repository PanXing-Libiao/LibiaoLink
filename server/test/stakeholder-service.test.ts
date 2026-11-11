/**
 * j6 干系人服务回归（A5-01 / A5-03 / A5-04 / A5-07 · 验收项「字段级脱敏用例通过」）：
 * 1) 字段级：联系方式（phone / wechat / email）需 stakeholder.contact.view、company / title 需 stakeholder.view、
 *    remark 需 stakeholder.manage —— 无权字段**键不存在**（C3-08：不返回而非打码）；
 * 2) 记录级：「我录入的」∪「关联项目在可见项目内」，其余一律 404（防 IDOR）；
 * 3) 留痕：建 / 改 / 关联写审计；关联幂等不重复写；项目不存在 404 且不落库。
 * 真机口径见 server/README.md「干系人（j6）」；策略纯函数回归见 test/stakeholder-rules.test.ts。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { AuditRecordInput } from "../src/modules/admin/index.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { ActorAuthorization } from "../src/modules/identity/index.js";
import type { PermissionService, ProjectScopeFilter } from "../src/modules/permission/index.js";
import { StakeholderService } from "../src/modules/stakeholder/stakeholder.service.js";
import type { StakeholderProjectRow, StakeholderRow } from "../src/modules/stakeholder/index.js";
import type { StakeholderRepository } from "../src/modules/stakeholder/stakeholder.repository.js";
import { matchesKeyword } from "../src/modules/stakeholder/index.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const STRANGER_PROJECT = "44444444-4444-4444-8444-444444444444";
const STAKEHOLDER = "55555555-5555-4555-8555-555555555555";
const AT = new Date("2026-09-22T06:00:00Z");

/** 销售（录入）：干系人三键全有（数据范围 own_stakeholders）。 */
const SALES: ActorAuthorization = {
  userId: ME,
  roleCodes: ["sales"],
  dataScopes: ["own_stakeholders"],
  permissionKeys: ["stakeholder.view", "stakeholder.manage", "stakeholder.contact.view"],
};

/** 任务负责人：只有 stakeholder.view（限制「干系人隐私字段按字段权限隐藏」）。 */
const TASK_OWNER: ActorAuthorization = {
  userId: ME,
  roleCodes: ["task_owner"],
  dataScopes: ["involved_projects"],
  permissionKeys: ["stakeholder.view"],
};

/** 只读：有 view、无 manage → remark 不可见。 */
const VIEWER: ActorAuthorization = {
  userId: ME,
  roleCodes: ["viewer"],
  dataScopes: ["granted"],
  permissionKeys: ["stakeholder.view"],
};

function makeRow(overrides: Partial<StakeholderRow> = {}): StakeholderRow {
  return {
    id: STAKEHOLDER,
    name: "Christian Winkler",
    companyType: "customer",
    company: "ACME Ltd",
    title: "项目经理",
    phone: "+49 170 000000",
    wechat: "christian-w",
    email: "christian@acme.example",
    remark: "决策人",
    role: "决策人",
    createdBy: ME,
    createdByName: "销售甲",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class FakeDatabase {
  readonly tx = {} as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
  } as unknown as DatabaseService["db"];
}

interface LinkRow {
  stakeholderId: string;
  projectId: string;
}

class FakeStakeholderRepository {
  rows: StakeholderRow[] = [makeRow()];
  links: LinkRow[] = [{ stakeholderId: STAKEHOLDER, projectId: PROJECT }];
  projects = new Set<string>([PROJECT, STRANGER_PROJECT]);
  private seq = 0;

  async list(filter: { keyword: string | null; companyTypes: string[] | null; projectId: string | null }, visibility: { kind: string; ownId?: string | null; projectIds?: string[] }, _sort: unknown, page: number, limit: number) {
    const projectIds = visibility.projectIds ?? [];
    const visible = this.rows.filter((row) => {
      if (visibility.kind === "all") return true;
      return this.links.some((link) => link.stakeholderId === row.id && projectIds.includes(link.projectId));
    });
    const filtered = visible.filter((row) => {
      if (filter.keyword !== null && !matchesKeyword(row, filter.keyword)) return false;
      if (filter.companyTypes !== null && !filter.companyTypes.includes(row.companyType)) return false;
      if (filter.projectId !== null && !this.links.some((link) => link.stakeholderId === row.id && link.projectId === filter.projectId)) return false;
      return true;
    });
    return { rows: filtered.slice((page - 1) * limit, page * limit), total: filtered.length };
  }

  async listForExport(
    filter: { keyword: string | null; companyTypes: string[] | null; projectId: string | null },
    visibility: { kind: string; ownId?: string | null; projectIds?: string[] },
    sort: unknown,
    page: number,
    limit: number,
  ): Promise<StakeholderRow[]> {
    return (await this.list(filter, visibility, sort, page, limit)).rows;
  }

  async countForExport(
    filter: { keyword: string | null; companyTypes: string[] | null; projectId: string | null },
    visibility: { kind: string; ownId?: string | null; projectIds?: string[] },
  ): Promise<number> {
    return (await this.list(filter, visibility, [], 1, 1)).total;
  }

  async findById(stakeholderId: string): Promise<StakeholderRow | null> {
    const row = this.rows.find((item) => item.id === stakeholderId);
    return row === undefined ? null : { ...row };
  }

  async insert(input: Omit<StakeholderRow, "id" | "createdByName" | "createdAt" | "updatedAt"> & { createdBy: string }, _actorId: string, at: Date): Promise<StakeholderRow> {
    this.seq += 1;
    const row = makeRow({ ...input, id: "6666666" + this.seq + "-6666-4666-8666-66666666666" + this.seq, createdAt: at, updatedAt: at, createdByName: "销售甲" });
    this.rows.push(row);
    return row;
  }

  async update(stakeholderId: string, patch: Record<string, unknown>, at: Date): Promise<StakeholderRow | null> {
    const stored = this.rows.find((item) => item.id === stakeholderId);
    if (stored === undefined) return null;
    Object.assign(stored, patch, { updatedAt: at });
    return { ...stored };
  }

  async softDelete(stakeholderId: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== stakeholderId);
    return this.rows.length < before;
  }

  async listProjects(stakeholderIds: string[]): Promise<StakeholderProjectRow[]> {
    return this.links
      .filter((link) => stakeholderIds.includes(link.stakeholderId))
      .map((link) => ({ stakeholderId: link.stakeholderId, projectId: link.projectId, code: "PRJ-" + link.projectId.slice(0, 4), name: "项目" }));
  }

  async projectExists(projectId: string): Promise<boolean> {
    return this.projects.has(projectId);
  }

  async insertLink(stakeholderId: string, projectId: string): Promise<boolean> {
    if (this.links.some((link) => link.stakeholderId === stakeholderId && link.projectId === projectId)) return false;
    this.links.push({ stakeholderId, projectId });
    return true;
  }

}

class FakePermissionService {
  globalWritable = true;
  projectLevels = new Map<string, "edit" | "view">();
  projectFinalLevels = new Map<string, "edit" | "view">();
  projectManagers = new Set<string>();
  lastAssertCanContext?: {
    member?: boolean;
    projectManager?: boolean;
    groupAccessLevel?: "edit" | "view";
    accessLevel?: "edit" | "view";
  };
  getAuthorizationCalls = 0;
  projectScopeCalls = 0;

  constructor(
    public authorization: ActorAuthorization,
    public scope: ProjectScopeFilter,
    private readonly knownProjects: ReadonlySet<string>,
  ) {}
  async getAuthorization(): Promise<ActorAuthorization> {
    this.getAuthorizationCalls += 1;
    return this.authorization;
  }
  async projectScope(): Promise<ProjectScopeFilter> {
    this.projectScopeCalls += 1;
    return this.scope;
  }
  async assertProjectVisible(_actorId: string, projectId: string): Promise<{
    projectId: string;
    member: boolean;
    projectManager: boolean;
    groupAccessLevel: "edit" | "view";
    accessLevel: "edit" | "view";
  }> {
    if (!this.knownProjects.has(projectId)) {
      throw new AppError("NOT_FOUND", "项目不存在或已删除：" + projectId);
    }
    const groupAccessLevel = this.projectLevels.get(projectId) ?? "edit";
    return {
      projectId,
      member: true,
      projectManager: this.projectManagers.has(projectId),
      groupAccessLevel,
      accessLevel: this.projectFinalLevels.get(projectId) ?? groupAccessLevel,
    };
  }
  async assertCan(
    _actorId: string,
    key: string,
    context?: {
      member?: boolean;
      projectManager?: boolean;
      groupAccessLevel?: "edit" | "view";
      accessLevel?: "edit" | "view";
    },
  ): Promise<void> {
    this.lastAssertCanContext = context;
    if (!this.authorization.permissionKeys.includes(key as never)) {
      throw new AppError("FORBIDDEN", "无权限：" + key);
    }
    if (context?.accessLevel !== "edit" && context?.groupAccessLevel === "view") {
      throw new AppError("FORBIDDEN", "当前项目仅浏览");
    }
  }
  async assertWritable(): Promise<void> {
    if (!this.globalWritable) throw new AppError("FORBIDDEN", "该操作需要全部项目编辑权限");
  }
}

class FakeAuditService {
  records: AuditRecordInput[] = [];
  async record(_client: DbClient, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

function makeService(
  authorization: ActorAuthorization,
  scope: ProjectScopeFilter = { kind: "ids", ids: [PROJECT] },
  repo = new FakeStakeholderRepository(),
) {
  const audit = new FakeAuditService();
  const permission = new FakePermissionService(authorization, scope, repo.projects);
  const service = new StakeholderService(
    new FakeDatabase() as unknown as DatabaseService,
    repo as unknown as StakeholderRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
  );
  return { service, repo, audit, permission };
}

const LIST_QUERY = { page: 1, limit: 50 } as const;

describe("字段级脱敏（A5-07 / C3-08）", () => {
  it("销售：联系方式 / 公司 / 职务 / 备注全可见", async () => {
    const { service } = makeService(SALES);
    const item = await service.get(STAKEHOLDER, ME);
    expect(item.phone).toBe("+49 170 000000");
    expect(item.wechat).toBe("christian-w");
    expect(item.email).toBe("christian@acme.example");
    expect(item.company).toBe("ACME Ltd");
    expect(item.title).toBe("项目经理");
    expect(item.remark).toBe("决策人");
    expect(item.role).toBe("决策人");
  });

  it("任务负责人：联系方式与备注**键不存在**（不返回而非打码），公司与职务仍在", async () => {
    const { service } = makeService(TASK_OWNER, { kind: "ids", ids: [PROJECT] });
    const item = await service.get(STAKEHOLDER, ME) as Record<string, unknown>;
    expect("phone" in item).toBe(false);
    expect("wechat" in item).toBe(false);
    expect("email" in item).toBe(false);
    expect("remark" in item).toBe(false);
    expect(item.company).toBe("ACME Ltd");
    expect(item.title).toBe("项目经理");
  });

  it("只读：无 manage → 备注键不存在；列表与详情同一策略", async () => {
    const { service } = makeService(VIEWER, { kind: "ids", ids: [PROJECT] });
    const detail = await service.get(STAKEHOLDER, ME) as Record<string, unknown>;
    const list = await service.list(LIST_QUERY, ME);
    const item = list.items[0] as Record<string, unknown>;
    expect("remark" in detail).toBe(false);
    expect("remark" in item).toBe(false);
    expect("phone" in item).toBe(false);
  });

  it("未登记字段（name / companyType / role / 录入人）恒返回", async () => {
    const { service } = makeService(VIEWER, { kind: "ids", ids: [PROJECT] });
    const item = await service.get(STAKEHOLDER, ME);
    expect(item.name).toBe("Christian Winkler");
    expect(item.companyType).toBe("customer");
    expect(item.createdByName).toBe("销售甲");
    expect(item.role).toBe("决策人");
  });
});

describe("干系人导出上下文（P3）", () => {
  it("授权与可见项目范围只解析一次，计数和多批读取共享同一上下文", async () => {
    const { service, permission, repo } = makeService(SALES, { kind: "all" });
    repo.links = [{ stakeholderId: STAKEHOLDER, projectId: PROJECT }];
    const context = await service.prepareExportContext(ME);
    expect(permission.getAuthorizationCalls).toBe(1);
    expect(permission.projectScopeCalls).toBe(1);

    const query = { "filter[projectId]": PROJECT, page: 1, limit: 1_000, sort: "createdAt:asc" } as const;
    await expect(service.countForExport(query, context)).resolves.toBe(1);
    const items = await service.listForExport(query, context);
    await service.listForExport({ ...query, page: 2 }, context);

    expect(items).toHaveLength(1);
    expect(items[0]?.phone).toBe("+49 170 000000");
    expect(permission.getAuthorizationCalls).toBe(1);
    expect(permission.projectScopeCalls).toBe(1);
  });
});

describe("记录级可见集（A5-03 / A5-04）", () => {
  it("项目可见集为空 → 404；不按录入人兜底", async () => {
    const { service } = makeService(SALES, { kind: "ids", ids: [] });
    await expect(service.get(STAKEHOLDER, ME)).rejects.toThrow(/干系人不存在/);
  });

  it("项目不在可见集 → 404", async () => {
    const repo = new FakeStakeholderRepository();
    repo.rows = [makeRow({ createdBy: OTHER })];
    repo.links = [];
    const { service } = makeService(VIEWER, { kind: "ids", ids: [PROJECT] }, repo);
    await expect(service.get(STAKEHOLDER, ME)).rejects.toThrow(/干系人不存在/);
  });

  it("他人录入 + 关联项目在可见集 → 可见", async () => {
    const repo = new FakeStakeholderRepository();
    repo.rows = [makeRow({ createdBy: OTHER })];
    repo.links = [{ stakeholderId: STAKEHOLDER, projectId: PROJECT }];
    const { service } = makeService(VIEWER, { kind: "ids", ids: [PROJECT] }, repo);
    const item = await service.get(STAKEHOLDER, ME);
    expect(item.projects.map((project) => project.id)).toEqual([PROJECT]);
  });

  it("同名干系人在不同项目是独立记录：互不共享、互不影响", async () => {
    const projectB = "88888888-8888-4888-8888-888888888888";
    const stakeholderB = "99999999-9999-4999-8999-999999999999";
    const repo = new FakeStakeholderRepository();
    repo.projects.add(projectB);
    repo.rows = [makeRow({ createdBy: ME }), makeRow({ id: stakeholderB, createdBy: ME })];
    repo.links = [
      { stakeholderId: STAKEHOLDER, projectId: PROJECT },
      { stakeholderId: stakeholderB, projectId: projectB },
    ];
    const admin: ActorAuthorization = {
      userId: ME,
      roleCodes: ["admin"],
      dataScopes: ["all"],
      permissionKeys: ["stakeholder.view", "stakeholder.manage", "stakeholder.contact.view"],
    };
    const { service } = makeService(admin, { kind: "all" }, repo);

    const list = await service.list(LIST_QUERY, ME);
    expect(list.items.map((item) => item.id).sort()).toEqual([STAKEHOLDER, stakeholderB].sort());
    const inProject = await service.list({ ...LIST_QUERY, "filter[projectId]": PROJECT }, ME);
    expect(inProject.items.map((item) => item.id)).toEqual([STAKEHOLDER]);
    expect(inProject.items[0]?.projects.map((project) => project.id)).toEqual([PROJECT]);
  });

  it("按无权项目筛选：本人录入的记录也返回空集（列表 / 总数 / 导出同口径）", async () => {
    const repo = new FakeStakeholderRepository();
    repo.rows = [makeRow({ createdBy: ME })];
    repo.links = [{ stakeholderId: STAKEHOLDER, projectId: STRANGER_PROJECT }];
    const { service } = makeService(SALES, { kind: "ids", ids: [] }, repo);
    const query = { ...LIST_QUERY, "filter[projectId]": STRANGER_PROJECT } as const;

    const list = await service.list(query, ME);
    expect(list.items).toEqual([]);
    expect(list.total).toBe(0);

    const context = await service.prepareExportContext(ME);
    await expect(service.countForExport(query, context)).resolves.toBe(0);
    await expect(service.listForExport(query, context)).resolves.toEqual([]);
  });

  it("管理员（可见集 all）：台账全量", async () => {
    const repo = new FakeStakeholderRepository();
    repo.rows = [makeRow({ createdBy: OTHER })];
    const admin: ActorAuthorization = { userId: ME, roleCodes: ["admin"], dataScopes: ["all"], permissionKeys: ["stakeholder.view", "stakeholder.manage", "stakeholder.contact.view"] };
    const { service } = makeService(admin, { kind: "all" }, repo);
    const list = await service.list(LIST_QUERY, ME);
    expect(list.total).toBe(1);
  });

  it("列表过滤：公司分类 + 项目筛选 + 关键词", async () => {
    const repo = new FakeStakeholderRepository();
    repo.rows = [
      makeRow(),
      makeRow({ id: "77777777-7777-4777-8777-777777777777", name: "张三", companyType: "supplier", company: "乙方", title: "采购", createdBy: ME }),
    ];
    repo.links = [
      { stakeholderId: STAKEHOLDER, projectId: PROJECT },
      { stakeholderId: "77777777-7777-4777-8777-777777777777", projectId: PROJECT },
    ];
    const { service } = makeService(SALES, { kind: "ids", ids: [PROJECT] }, repo);
    expect((await service.list({ ...LIST_QUERY, "filter[companyType]": "customer" }, ME)).total).toBe(1);
    expect((await service.list({ ...LIST_QUERY, "filter[projectId]": PROJECT }, ME)).total).toBe(2);
    expect((await service.list({ ...LIST_QUERY, q: "张三" }, ME)).total).toBe(1);
    expect((await service.list({ ...LIST_QUERY, q: "无此人" }, ME)).total).toBe(0);
  });
});

describe("写权限按项目裁决", () => {
  it("新建必须归属一个项目：空项目 400，且不写审计", async () => {
    const { service, audit } = makeService(SALES);
    await expect(service.create({ name: "李四", companyType: "supplier", projectIds: [] }, ME)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(audit.records).toHaveLength(0);
  });

  it("新建时目标项目仅浏览：403 且不落库、不写审计", async () => {
    const { service, repo, audit, permission } = makeService(SALES);
    permission.projectLevels.set(PROJECT, "view");
    const before = repo.rows.length;
    await expect(
      service.create({ name: "李四", companyType: "supplier", projectIds: [PROJECT] }, ME),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repo.rows).toHaveLength(before);
    expect(audit.records).toHaveLength(0);
  });

  it("更新 / 删除：所属项目仅浏览即 403", async () => {
    const { service, repo, permission } = makeService(SALES);
    repo.links = [{ stakeholderId: STAKEHOLDER, projectId: PROJECT }];
    permission.projectLevels.set(PROJECT, "view");
    await expect(service.update(STAKEHOLDER, { phone: "13900000000" }, ME)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.remove(STAKEHOLDER, ME)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("项目经理：部门规则仅浏览但最终 accessLevel=edit，仍可修改所属项目台账", async () => {
    const { service, repo, permission } = makeService(SALES);
    repo.links = [{ stakeholderId: STAKEHOLDER, projectId: PROJECT }];
    permission.projectLevels.set(PROJECT, "view");
    permission.projectManagers.add(PROJECT);
    permission.projectFinalLevels.set(PROJECT, "edit");

    const updated = await service.update(STAKEHOLDER, { phone: "13900000000" }, ME);
    expect(updated.phone).toBe("13900000000");
    expect(permission.lastAssertCanContext?.accessLevel).toBe("edit");
  });

  it("新建时只能关联一个项目：多项目直接 400，且不落库、不写审计", async () => {
    const { service, repo, audit } = makeService(SALES);
    repo.links = [];
    const before = repo.rows.length;
    await expect(
      service.create({ name: "李四", companyType: "supplier", projectIds: [PROJECT, STRANGER_PROJECT] }, ME),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(repo.rows).toHaveLength(before);
    expect(repo.links).toHaveLength(0);
    expect(audit.records).toHaveLength(0);
  });
});

describe("用例与留痕", () => {
  it("新建：写审计 create（九字段 before → after），并回读", async () => {
    const { service, audit } = makeService(SALES);
    const created = await service.create({ name: "李四", companyType: "supplier", phone: "13800000000", projectIds: [PROJECT] }, ME);
    expect(created.name).toBe("李四");
    expect(created.companyType).toBe("supplier");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.action).toBe("create");
    expect(audit.records[0]?.objectType).toBe("stakeholder");
    const changes = audit.records[0]?.changes ?? [];
    expect(changes.map((change) => change.field).sort()).toEqual([
      "company",
      "companyType",
      "email",
      "name",
      "phone",
      "remark",
      "role",
      "title",
      "wechat",
    ]);
  });

  it("新建带单个项目：写一条干系人归属关联", async () => {
    const { service, repo, audit } = makeService(SALES);
    repo.links = [];
    const created = await service.create({ name: "李四", companyType: "supplier", projectIds: [PROJECT] }, ME);
    expect(created.projects.map((project) => project.id)).toEqual([PROJECT]);
    expect(repo.links).toEqual([{ stakeholderId: created.id, projectId: PROJECT }]);
    expect(audit.records[0]?.metadata).toEqual({ companyType: "supplier", projectIds: [PROJECT] });
  });

  it("新建时关联不存在的项目 → 404（事务内失败，不写审计）", async () => {
    const { service, audit } = makeService(SALES);
    await expect(
      service.create({ name: "李四", companyType: "supplier", projectIds: ["99999999-9999-4999-8999-999999999999"] }, ME),
    ).rejects.toThrow(/项目不存在/);
    expect(audit.records).toHaveLength(0);
  });

  it("更新：只记变化字段（字段级 diff）", async () => {
    const { service, audit } = makeService(SALES);
    await service.update(STAKEHOLDER, { phone: "13900000000" }, ME);
    const changes = audit.records[0]?.changes ?? [];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ field: "phone", from: "+49 170 000000", to: "13900000000" });
  });

  it("删除：软删 + 审计 delete，之后详情 404", async () => {
    const { service, audit } = makeService(SALES);
    expect(await service.remove(STAKEHOLDER, ME)).toEqual({ id: STAKEHOLDER, deleted: true });
    expect(audit.records[0]?.action).toBe("delete");
    await expect(service.get(STAKEHOLDER, ME)).rejects.toThrow(/干系人不存在/);
  });
});
