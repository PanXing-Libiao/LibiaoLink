import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { UserRow } from "../src/modules/identity/user.repository.js";
import type { UserService } from "../src/modules/identity/user.service.js";
import {
  ProjectMemberRepository,
  type ProjectMemberRow,
  type ProjectMemberViewRow,
} from "../src/modules/project/project-member.repository.js";
import { ProjectMemberService, toProjectMemberView } from "../src/modules/project/project-member.service.js";
import type { ProjectRepository, ProjectViewRow } from "../src/modules/project/project.repository.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { ProjectManagerEligibilityService } from "../src/modules/permission/index.js";

const AT = new Date("2026-09-20T06:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const UUID_MANAGER = "22222222-2222-4222-8222-222222222222";
const UUID_MEMBER = "33333333-3333-4333-8333-333333333333";
const UUID_GHOST = "44444444-4444-4444-8444-444444444444";
const UUID_INELIGIBLE = "55555555-5555-4555-8555-555555555555";

function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  return fn().then(
    () => {
      throw new Error("预期抛出 AppError，但未抛出");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
    },
  );
}

function memberRow(overrides: Partial<ProjectMemberRow> & { userId: string }): ProjectMemberViewRow {
  return {
    member: {
      id: "row-" + overrides.userId,
      projectId: PROJECT_ID,
      roleInProject: "project_member",
      joinedAt: AT,
      ...overrides,
    },
    username: "10086",
    displayName: "张三",
  };
}

// ---------- 内存替身（不连库；与各 repository / service 方法签名同形） ----------

class FakeProjectMemberRepository {
  rows: ProjectMemberViewRow[] = [];
  calls: string[] = [];

  async listByProject(projectId: string): Promise<ProjectMemberViewRow[]> {
    this.calls.push("list:" + projectId);
    return this.rows
      .slice()
      .sort((left, right) =>
        left.member.roleInProject === right.member.roleInProject
          ? left.username.localeCompare(right.username)
          : left.member.roleInProject.localeCompare(right.member.roleInProject),
      );
  }

  async findByProjectAndUser(projectId: string, userId: string): Promise<ProjectMemberViewRow | null> {
    return this.rows.find((row) => row.member.projectId === projectId && row.member.userId === userId) ?? null;
  }

  async upsert(projectId: string, userId: string, roleInProject: string, at: Date): Promise<ProjectMemberRow> {
    this.calls.push("upsert:" + userId + ":" + roleInProject);
    const existing = this.rows.find((row) => row.member.userId === userId);
    if (existing !== undefined) {
      existing.member.roleInProject = roleInProject;
      return existing.member;
    }
    const created: ProjectMemberRow = { id: "new-" + userId, projectId, userId, roleInProject, joinedAt: at };
    this.rows.push({ member: created, username: "10087", displayName: "李四" });
    return created;
  }

  async remove(projectId: string, userId: string): Promise<ProjectMemberRow | null> {
    this.calls.push("remove:" + userId);
    const index = this.rows.findIndex((row) => row.member.userId === userId);
    if (index < 0) return null;
    const [removed] = this.rows.splice(index, 1);
    return removed?.member ?? null;
  }
}

class FakeProjectRepository {
  project: ProjectViewRow | null = null;
  touched: { id: string; at: Date }[] = [];

  async findViewById(id: string): Promise<ProjectViewRow | null> {
    return this.project !== null && this.project.project.id === id ? this.project : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    this.touched.push({ id, at });
  }
}

class FakeProjectManagerEligibilityService {
  eligible = new Set<string>([UUID_MANAGER, UUID_MEMBER]);

  async assertAssignable(
    managerIds: readonly string[],
    options: { existingUserIds?: readonly string[] } = {},
  ): Promise<void> {
    const preserved = new Set(options.existingUserIds ?? []);
    if (managerIds.some((userId) => !this.eligible.has(userId) && !preserved.has(userId))) {
      throw new AppError("VALIDATION_FAILED", "项目经理只能选择有效项目部成员或系统管理员");
    }
  }
}

class FakeUserService {
  directory = new Map<string, { username: string; displayName: string }>([
    [UUID_MANAGER, { username: "10001", displayName: "项目经理甲" }],
    [UUID_MEMBER, { username: "10002", displayName: "成员乙" }],
    [UUID_INELIGIBLE, { username: "10003", displayName: "外部人员丙" }],
  ]);

  async getUser(userId: string): Promise<UserRow> {
    const found = this.directory.get(userId);
    if (found === undefined) {
      throw new AppError("NOT_FOUND", "用户不存在");
    }
    return { id: userId, username: found.username, displayName: found.displayName } as unknown as UserRow;
  }
}

function projectRow(status = "active"): ProjectViewRow {
  return {
    project: {
      id: PROJECT_ID,
      code: "CNBJ-20260920-0001",
      seqNo: 1,
      name: "XX 客户分拣项目",
      customer: null,
      region: "华东",
      projectType: "分拣",
      managerIds: [UUID_MANAGER],
      stageKey: "presale",
      status,
      description: null,
      version: 0,
      createdAt: AT,
      updatedAt: AT,
      deletedAt: null,
      deletedBy: null,
      archivedAt: null,
      archivedBy: null,
    },
    managerNames: ["项目经理甲"],
  };
}

/** 审计替身（h7）：只记录写入调用；事务替身把 tx 直接透传给回调。 */
class FakeAuditService {
  entries: unknown[] = [];
  async record(_client: unknown, input: unknown): Promise<void> {
    this.entries.push(input);
  }
}

const FAKE_DB = { db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) } };

function makeService(options: { status?: string; members?: ProjectMemberViewRow[] } = {}): {
  service: ProjectMemberService;
  members: FakeProjectMemberRepository;
  projects: FakeProjectRepository;
  managerEligibility: FakeProjectManagerEligibilityService;
} {
  const members = new FakeProjectMemberRepository();
  members.rows = options.members ?? [];
  const projects = new FakeProjectRepository();
  projects.project = projectRow(options.status ?? "active");
  const managerEligibility = new FakeProjectManagerEligibilityService();
  const service = new ProjectMemberService(
    FAKE_DB as unknown as DatabaseService,
    members as unknown as ProjectMemberRepository,
    projects as unknown as ProjectRepository,
    managerEligibility as unknown as ProjectManagerEligibilityService,
    new FakeUserService() as unknown as UserService,
    new FakeAuditService() as unknown as AuditService,
  );
  return { service, members, projects, managerEligibility };
}

// ---------- 视图映射 ----------

describe("toProjectMemberView", () => {
  it("camelCase + 姓名随行下发 + ISO 加入时间", () => {
    const view = toProjectMemberView(memberRow({ userId: UUID_MEMBER, roleInProject: "project_manager" }));
    expect(view).toEqual({
      userId: UUID_MEMBER,
      username: "10086",
      displayName: "张三",
      roleInProject: "project_manager",
      joinedAt: "2026-09-20T06:00:00.000Z",
    });
  });
});

// ---------- 名册用例（M2-05） ----------

describe("ProjectMemberService（M2-05 名册）", () => {
  it("列表：项目经理在前、同角色按工号升序；项目不存在 / 已软删 404", async () => {
    const { service } = makeService({
      members: [
        memberRow({ userId: UUID_MEMBER, roleInProject: "project_member" }),
        memberRow({ userId: UUID_MANAGER, roleInProject: "project_manager" }),
      ],
    });
    const list = await service.listMembers(PROJECT_ID);
    expect(list.total).toBe(2);
    expect(list.items.map((item) => item.userId)).toEqual([UUID_MANAGER, UUID_MEMBER]);

    const missing = makeService();
    missing.projects.project = null;
    await expectAppErrorAsync(() => missing.service.listMembers(PROJECT_ID), "NOT_FOUND");
  });

  it("添加成员：upsert + 按 ADR-022 刷新项目 updatedAt；缺省角色 = project_member", async () => {
    const { service, members, projects } = makeService();
    const added = await service.addMember(PROJECT_ID, { userId: UUID_MEMBER }, UUID_MANAGER);
    expect(added.roleInProject).toBe("project_member");
    expect(members.calls).toEqual(["upsert:" + UUID_MEMBER + ":project_member"]);
    expect(projects.touched.map((entry) => entry.id)).toEqual([PROJECT_ID]);
  });

  it("添加成员：重复添加幂等（改角色、不动 joinedAt）", async () => {
    const { service, members } = makeService({ members: [memberRow({ userId: UUID_MEMBER })] });
    const updated = await service.addMember(PROJECT_ID, { userId: UUID_MEMBER, roleInProject: "project_manager" }, UUID_MANAGER);
    expect(updated.roleInProject).toBe("project_manager");
    expect(updated.joinedAt).toBe("2026-09-20T06:00:00.000Z");
    expect(members.rows).toHaveLength(1);
  });

  it("新增 / 升级为项目经理：非候选 400，不写名册、不 touch", async () => {
    const { service, members, projects } = makeService();
    await expectAppErrorAsync(
      () => service.addMember(PROJECT_ID, { userId: UUID_INELIGIBLE, roleInProject: "project_manager" }, UUID_MANAGER),
      "VALIDATION_FAILED",
    );
    expect(members.calls).toEqual([]);
    expect(projects.touched).toEqual([]);
  });

  it("添加成员：用户不存在 404（不写名册、不 touch）", async () => {
    const { service, members, projects } = makeService();
    await expectAppErrorAsync(() => service.addMember(PROJECT_ID, { userId: UUID_GHOST }, UUID_MANAGER), "NOT_FOUND");
    expect(members.calls).toEqual([]);
    expect(projects.touched).toEqual([]);
  });

  it("添加 / 移除：归档项目 409 PROJECT_ARCHIVED（ADR-027 写保护，不落任何写入）", async () => {
    const { service, members, projects } = makeService({ status: "archived" });
    await expectAppErrorAsync(() => service.addMember(PROJECT_ID, { userId: UUID_MEMBER }, UUID_MANAGER), "PROJECT_ARCHIVED");
    await expectAppErrorAsync(() => service.removeMember(PROJECT_ID, UUID_MEMBER, UUID_MANAGER), "PROJECT_ARCHIVED");
    expect(members.calls).toEqual([]);
    expect(projects.touched).toEqual([]);
  });

  it("移除成员：返回被移除行 + touch；不是成员 404（不 touch）", async () => {
    const { service, projects } = makeService({ members: [memberRow({ userId: UUID_MEMBER })] });
    const removed = await service.removeMember(PROJECT_ID, UUID_MEMBER, UUID_MANAGER);
    expect(removed.userId).toBe(UUID_MEMBER);
    expect(projects.touched).toHaveLength(1);

    const again = makeService({ members: [memberRow({ userId: UUID_MEMBER })] });
    await expectAppErrorAsync(() => again.service.removeMember(PROJECT_ID, UUID_GHOST, UUID_MANAGER), "NOT_FOUND");
    expect(again.projects.touched).toEqual([]);
  });
});
