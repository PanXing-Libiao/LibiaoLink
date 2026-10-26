import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditRecordInput, AuditService } from "../src/modules/audit/index.js";
import { sortDataScopes, widestDataScope } from "../src/modules/identity/data-scope.js";
import { DepartmentRepository, type DepartmentRow, type DepartmentUpsertInput } from "../src/modules/identity/department.repository.js";
import { DepartmentService } from "../src/modules/identity/department.service.js";
import { OrgSyncService, type OrgDirectorySnapshot } from "../src/modules/identity/org-sync.service.js";
import { RoleRepository, type RoleRow } from "../src/modules/identity/role.repository.js";
import { RoleService } from "../src/modules/identity/role.service.js";
import { SessionService } from "../src/modules/identity/session.service.js";
import { UserRepository, type DirectoryUserProfile, type UserRow } from "../src/modules/identity/user.repository.js";

const AT = new Date("2026-09-20T02:00:00.000Z");

// ---------- 内存假仓库（不连库，验证领域语义） ----------

class FakeDepartmentRepository {
  rows: DepartmentRow[] = [];
  upserts: DepartmentUpsertInput[] = [];
  private seq = 0;

  async list(options: { includeDisabled?: boolean } = {}): Promise<DepartmentRow[]> {
    return this.rows.filter((row) => options.includeDisabled === true || row.status === "active");
  }

  async listSynced(): Promise<DepartmentRow[]> {
    return this.rows.filter((row) => row.sourceId !== null);
  }

  async findBySourceId(sourceId: string): Promise<DepartmentRow | null> {
    return this.rows.find((row) => row.sourceId === sourceId) ?? null;
  }

  async upsertBySourceId(input: DepartmentUpsertInput, at: Date): Promise<DepartmentRow> {
    this.upserts.push(input);
    const index = this.rows.findIndex((row) => row.sourceId === input.sourceId);
    if (index >= 0) {
      // 模仿 DB 语义：写入后返回新行快照，不复用调用方先前的读取结果
      const current = this.rows[index];
      if (current === undefined) throw new Error("fake 部门行丢失");
      const updated: DepartmentRow = { ...current, name: input.name, parentId: input.parentId, status: input.status, updatedAt: at };
      this.rows[index] = updated;
      return updated;
    }
    this.seq += 1;
    const row: DepartmentRow = {
      id: "dep-" + String(this.seq),
      name: input.name,
      parentId: input.parentId,
      sourceId: input.sourceId,
      status: input.status,
      createdAt: at,
      updatedAt: at,
    };
    this.rows.push(row);
    return row;
  }

  async disableByIds(ids: readonly string[], at: Date): Promise<string[]> {
    const changed: string[] = [];
    for (const row of this.rows) {
      if (ids.includes(row.id) && row.status === "active") {
        row.status = "disabled";
        row.updatedAt = at;
        changed.push(row.id);
      }
    }
    return changed;
  }
}

function userRow(id: string, profile: DirectoryUserProfile): UserRow {
  return {
    id,
    casdoorId: profile.casdoorId,
    username: profile.username,
    displayName: profile.displayName,
    email: profile.email,
    owner: null,
    status: profile.status,
    removedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

class FakeUserRepository {
  rows: UserRow[] = [];
  private seq = 0;

  async listAll(): Promise<UserRow[]> {
    return [...this.rows];
  }

  async upsertFromDirectory(profile: DirectoryUserProfile, at: Date): Promise<UserRow> {
    const index = this.rows.findIndex((row) => row.casdoorId === profile.casdoorId);
    if (index >= 0) {
      const current = this.rows[index];
      if (current === undefined) throw new Error("fake 用户行丢失");
      const updated: UserRow = {
        ...current,
        username: profile.username,
        displayName: profile.displayName,
        email: profile.email,
        status: profile.status,
        updatedAt: at,
      };
      this.rows[index] = updated;
      return updated;
    }
    this.seq += 1;
    const row = userRow("user-" + String(this.seq), profile);
    this.rows.push(row);
    return row;
  }

  async findByCasdoorId(casdoorId: string): Promise<UserRow | null> {
    return this.rows.find((row) => row.casdoorId === casdoorId) ?? null;
  }

  async updateStatus(id: string, status: "active" | "disabled", at: Date): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row !== undefined) {
      row.status = status;
      row.updatedAt = at;
    }
  }
}

class FakeSessionService {
  revokedFor: string[] = [];
  async revokeAllForUser(userId: string): Promise<number> {
    this.revokedFor.push(userId);
    return 1;
  }
}

class FakeAuditService {
  records: AuditRecordInput[] = [];
  async record(_client: unknown, input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

class FakeDatabase {
  readonly db = {} as unknown as DatabaseService["db"];
}

function buildOrgSync(
  departments: FakeDepartmentRepository,
  users: FakeUserRepository,
  sessions: FakeSessionService,
  audit: FakeAuditService = new FakeAuditService(),
): OrgSyncService {
  return new OrgSyncService(
    departments as unknown as DepartmentRepository,
    users as unknown as UserRepository,
    sessions as unknown as SessionService,
    audit as unknown as AuditService,
    new FakeDatabase() as unknown as DatabaseService,
  );
}

function snapshot(partial: Partial<OrgDirectorySnapshot> = {}): OrgDirectorySnapshot {
  return { pulledAt: AT, departments: [], users: [], ...partial };
}

// ---------- data-scope：范围并集与粗判序 ----------

describe("data-scope（ADR-011 数据范围）", () => {
  it("去重并按由宽到窄排序", () => {
    expect(sortDataScopes(["own_stakeholders", "all", "own_stakeholders"])).toEqual(["all", "own_stakeholders"]);
  });

  it("widestDataScope 取约定序最宽者，空集为 null", () => {
    expect(widestDataScope(["granted", "managed_projects"])).toBe("managed_projects");
    expect(widestDataScope([])).toBeNull();
  });

  it("非法范围直接抛错（表上有 CHECK，出现即数据 / 代码问题）", () => {
    expect(() => sortDataScopes(["everyone"])).toThrow("未知数据范围");
  });
});

// ---------- 角色数据范围用例（h1 验收） ----------

const ROLE_ROWS: RoleRow[] = [
  { code: "admin", name: "系统管理员", dataScope: "all" },
  { code: "project_manager", name: "项目经理", dataScope: "managed_projects" },
  { code: "task_owner", name: "任务负责人", dataScope: "involved_projects" },
  { code: "project_member", name: "项目成员", dataScope: "involved_projects" },
  { code: "sales", name: "销售（录入）", dataScope: "own_stakeholders" },
  { code: "viewer", name: "只读", dataScope: "granted" },
].map((role, index) => ({
  ...role,
  id: "role-" + String(index + 1),
  createdAt: AT,
  updatedAt: AT,
}));

class FakeRoleRepository {
  bound = new Map<string, string[]>();

  async list(): Promise<RoleRow[]> {
    return ROLE_ROWS;
  }

  async findByCode(code: string): Promise<RoleRow | null> {
    return ROLE_ROWS.find((role) => role.code === code) ?? null;
  }

  async assign(userId: string, roleId: string): Promise<void> {
    const code = ROLE_ROWS.find((role) => role.id === roleId)?.code;
    if (code === undefined) throw new Error("未知角色 id");
    const codes = new Set(this.bound.get(userId) ?? []);
    codes.add(code);
    this.bound.set(userId, [...codes]);
  }

  async revoke(userId: string, roleId: string): Promise<boolean> {
    const code = ROLE_ROWS.find((role) => role.id === roleId)?.code;
    const codes = this.bound.get(userId) ?? [];
    const next = codes.filter((item) => item !== code);
    this.bound.set(userId, next);
    return next.length !== codes.length;
  }
}

/** 构造被测服务：旧角色权限已退出授权链。 */
function buildRoleService(fake: FakeRoleRepository): RoleService {
  return new RoleService(fake as unknown as RoleRepository);
}

describe("部门权限基线（2026-10-26 旧角色权限退出授权链）", () => {
  it("无论角色绑定如何，画像固定为无角色特权的全量能力基线", async () => {
    const fake = new FakeRoleRepository();
    fake.bound.set("user-1", ["viewer"]);
    const auth = await buildRoleService(fake).getActorAuthorization("user-1");
    expect(auth).toEqual({
      userId: "user-1",
      roleCodes: [],
      dataScopes: ["all"],
      permissionKeys: [...PERMISSION_KEYS],
    });
  });

  it("授权入口不依赖任何角色仓库数据", async () => {
    const service = new RoleService({} as RoleRepository);
    await expect(service.getActorAuthorization("user-anon")).resolves.toMatchObject({
      roleCodes: [],
      dataScopes: ["all"],
      permissionKeys: [...PERMISSION_KEYS],
    });
  });

  it("assignRole 幂等；未知角色码 404", async () => {
    const fake = new FakeRoleRepository();
    const service = buildRoleService(fake);
    await service.assignRole("user-4", "admin");
    await service.assignRole("user-4", "admin");
    expect(fake.bound.get("user-4")).toEqual(["admin"]);
    await expect(service.assignRole("user-4", "nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await service.revokeRole("user-4", "admin")).toBe(true);
    expect(await service.revokeRole("user-4", "admin")).toBe(false);
  });
});

// ---------- listDepartments 出口（h1 验收） ----------

describe("listDepartments（h1 验收 · v0.2 §1.2）", () => {
  it("默认只返回在编部门，includeDisabled 时含停用", async () => {
    const fake = new FakeDepartmentRepository();
    await fake.upsertBySourceId({ sourceId: "d1", name: "研发部", parentId: null, status: "active" }, AT);
    await fake.upsertBySourceId({ sourceId: "d2", name: "历史部门", parentId: null, status: "disabled" }, AT);
    const service = new DepartmentService(fake as unknown as DepartmentRepository);
    expect((await service.listDepartments()).map((row) => row.name)).toEqual(["研发部"]);
    expect((await service.listDepartments({ includeDisabled: true })).map((row) => row.name)).toEqual(["研发部", "历史部门"]);
  });
});

// ---------- 组织同步引擎（h1 · D1-02 / D1-07） ----------

describe("OrgSyncService（组织同步差异）", () => {
  it("部门父先于子落库并解析 parent_id；新增计入 created", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const service = buildOrgSync(departments, users, new FakeSessionService());
    const report = await service.applySnapshot(
      snapshot({
        departments: [
          { sourceId: "child", name: "后端组", parentSourceId: "root", status: "active" },
          { sourceId: "root", name: "研发部", parentSourceId: null, status: "active" },
        ],
      }),
    );
    expect(departments.upserts.map((item) => item.sourceId)).toEqual(["root", "child"]);
    expect(departments.upserts[1]?.parentId).toBe(departments.rows[0]?.id);
    expect(report.departments.created).toBe(2);
    expect(report.departments.unresolvedParents).toEqual([]);
  });

  it("重命名计入 updated；快照缺失的在编部门置 disabled", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const service = buildOrgSync(departments, users, new FakeSessionService());
    await service.applySnapshot(
      snapshot({
        departments: [
          { sourceId: "d1", name: "研发部", parentSourceId: null, status: "active" },
          { sourceId: "d2", name: "交付部", parentSourceId: null, status: "active" },
        ],
      }),
    );
    const report = await service.applySnapshot(
      snapshot({ departments: [{ sourceId: "d1", name: "研发中心", parentSourceId: null, status: "active" }] }),
    );
    expect(report.departments.updated).toBe(1);
    expect(report.departments.disabled).toBe(1);
    expect(report.departments.disabledNames).toEqual(["交付部"]);
    expect(report.missing.departmentSourceIds).toEqual(["d2"]);
    expect((await new DepartmentService(departments as unknown as DepartmentRepository).listDepartments()).map((row) => row.name)).toEqual(["研发中心"]);
  });

  it("父部门不在快照：按根处理并记入 unresolvedParents", async () => {
    const departments = new FakeDepartmentRepository();
    const service = buildOrgSync(departments, new FakeUserRepository(), new FakeSessionService());
    const report = await service.applySnapshot(
      snapshot({ departments: [{ sourceId: "d1", name: "孤立部门", parentSourceId: "ghost", status: "active" }] }),
    );
    expect(report.departments.unresolvedParents).toEqual(["d1"]);
    expect(departments.upserts[0]?.parentId).toBeNull();
  });

  it("部门快照成环 → 400 VALIDATION_FAILED（不静默）", async () => {
    const service = buildOrgSync(new FakeDepartmentRepository(), new FakeUserRepository(), new FakeSessionService());
    await expect(
      service.applySnapshot(
        snapshot({
          departments: [
            { sourceId: "a", name: "A", parentSourceId: "b", status: "active" },
            { sourceId: "b", name: "B", parentSourceId: "a", status: "active" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("用户：新增 / 变更计数；在职 → 离职触发禁用 + 会话撤销", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const sessions = new FakeSessionService();
    const audit = new FakeAuditService();
    const service = buildOrgSync(departments, users, sessions, audit);
    await service.applySnapshot(
      snapshot({
        users: [
          { casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "active" },
          { casdoorId: "c2", username: "li", displayName: "李工", email: "li@example.com", status: "active" },
        ],
      }),
    );
    const report = await service.applySnapshot(
      snapshot({
        users: [
          { casdoorId: "c1", username: "wang", displayName: "王工程师", email: null, status: "active" },
          { casdoorId: "c2", username: "li", displayName: "李工", email: "li@example.com", status: "disabled" },
          { casdoorId: "c3", username: "zhao", displayName: "赵工", email: null, status: "active" },
        ],
      }),
    );
    expect(report.users.created).toBe(1);
    expect(report.users.updated).toBe(2);
    expect(report.users.disabled).toBe(1);
    expect(report.users.disabledUsernames).toEqual(["li"]);
    expect(report.users.sessionsRevoked).toBe(1);
    expect(sessions.revokedFor).toEqual(["user-2"]);
    expect(users.rows.find((row) => row.casdoorId === "c2")?.status).toBe("disabled");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: null,
      action: "update",
      objectType: "user",
      objectId: "user-2",
      entry: "system",
      changes: [{ field: "status", from: "active", to: "disabled" }],
      metadata: { source: "org_sync", reason: "directory_disabled", casdoorId: "c2", sessionsRevoked: 1 },
    });
  });

  it("缺失用户默认只报告（missingUserPolicy=report），不禁用不踢线", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const sessions = new FakeSessionService();
    const audit = new FakeAuditService();
    const service = buildOrgSync(departments, users, sessions, audit);
    await service.applySnapshot(
      snapshot({ users: [{ casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "active" }] }),
    );
    const report = await service.applySnapshot(snapshot({ users: [] }));
    expect(report.missing.casdoorIds).toEqual(["c1"]);
    expect(report.missing.policy).toBe("report");
    expect(report.missing.disabled).toBe(false);
    expect(users.rows[0]?.status).toBe("active");
    expect(sessions.revokedFor).toEqual([]);
    expect(audit.records).toEqual([]);
  });

  it("missingUserPolicy=disable：阈值内禁用缺失用户并踢线（离职回收闭环）", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const sessions = new FakeSessionService();
    const audit = new FakeAuditService();
    const service = buildOrgSync(departments, users, sessions, audit);
    await service.applySnapshot(
      snapshot({
        users: [
          { casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "active" },
          { casdoorId: "c2", username: "li", displayName: "李工", email: null, status: "active" },
        ],
      }),
    );
    const report = await service.applySnapshot(
      snapshot({ users: [{ casdoorId: "c2", username: "li", displayName: "李工", email: null, status: "active" }] }),
      { missingUserPolicy: "disable" },
    );
    expect(report.missing.disabled).toBe(true);
    expect(report.missing.skippedByThreshold).toBe(false);
    expect(report.users.disabledUsernames).toEqual(["wang"]);
    expect(report.users.sessionsRevoked).toBe(1);
    expect(users.rows.find((row) => row.casdoorId === "c1")?.status).toBe("disabled");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: null,
      action: "update",
      objectType: "user",
      objectId: "user-1",
      entry: "system",
      changes: [{ field: "status", from: "active", to: "disabled" }],
      metadata: { source: "org_sync", reason: "missing_from_snapshot", casdoorId: "c1", sessionsRevoked: 1 },
    });
  });

  it("缺失超过安全阀阈值：只报告不执行（防快照故障误伤全员）", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const sessions = new FakeSessionService();
    const audit = new FakeAuditService();
    const service = buildOrgSync(departments, users, sessions, audit);
    const all = Array.from({ length: 10 }, (_, index) => ({
      casdoorId: "c" + String(index),
      username: "u" + String(index),
      displayName: "员工" + String(index),
      email: null,
      status: "active" as const,
    }));
    await service.applySnapshot(snapshot({ users: all }));
    const report = await service.applySnapshot(snapshot({ users: all.slice(0, 5) }), { missingUserPolicy: "disable" });
    expect(report.missing.skippedByThreshold).toBe(true);
    expect(report.missing.disabled).toBe(false);
    expect(report.users.disabled).toBe(0);
    expect(sessions.revokedFor).toEqual([]);
    expect(users.rows.filter((row) => row.status === "active")).toHaveLength(10);
    expect(audit.records).toEqual([]);
  });

  it("复职：目录恢复 active 时置回并计数（不自动重建会话）", async () => {
    const departments = new FakeDepartmentRepository();
    const users = new FakeUserRepository();
    const sessions = new FakeSessionService();
    const audit = new FakeAuditService();
    const service = buildOrgSync(departments, users, sessions, audit);
    await service.applySnapshot(
      snapshot({ users: [{ casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "disabled" }] }),
    );
    const report = await service.applySnapshot(
      snapshot({ users: [{ casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "active" }] }),
    );
    expect(report.users.enabled).toBe(1);
    expect(report.users.disabled).toBe(0);
    expect(users.rows[0]?.status).toBe("active");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: null,
      action: "update",
      objectType: "user",
      objectId: "user-1",
      entry: "system",
      changes: [{ field: "status", from: "disabled", to: "active" }],
      metadata: { source: "org_sync", reason: "directory_enabled", casdoorId: "c1" },
    });
  });

  it("用户快照重复 casdoorId → 400 VALIDATION_FAILED", async () => {
    const service = buildOrgSync(new FakeDepartmentRepository(), new FakeUserRepository(), new FakeSessionService());
    const duplicated = { casdoorId: "c1", username: "wang", displayName: "王工", email: null, status: "active" as const };
    await expect(service.applySnapshot(snapshot({ users: [duplicated, duplicated] }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
