/**
 * PoC-6 权限矩阵与脱敏五出口回归（h6 · S6·PoC-6）：
 * 记录级（数据范围 → 可见集）、功能权限（can：全局位 ∪ 项目内角色隐含位）、
 * 字段级（字段策略表 → 服务端裁剪）、五出口一致性（页面 / 导出 / 搜索 / 通知同源）。
 * 不连库：策略层是纯函数，服务层用内存替身；真机证据见 docs/PoC-6-权限矩阵与脱敏五出口.md。
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, type PermissionKey } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import type { ActorAuthorization, RoleService } from "../src/modules/identity/index.js";
import { fullCapabilityAuthorization } from "../src/modules/identity/role.service.js";
import type { PermissionRepository } from "../src/modules/permission/permission.repository.js";
import { PermissionService } from "../src/modules/permission/permission.service.js";
import {
  can,
  exitsConsistent,
  hiddenFields,
  isProjectVisible,
  planExit,
  projectFields,
  projectScopeSpec,
  visibleFields,
  visibleProjectIds,
  ENTITY_FIELDS,
  EXIT_KINDS,
  FIELD_POLICIES,
  PROJECT_MANAGER_IMPLIED_KEYS,
  PROJECT_MEMBER_IMPLIED_KEYS,
} from "../src/modules/permission/index.js";
import type { ProjectScopeSpec } from "../src/modules/permission/index.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const MANAGER_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";

const ALL_SPEC: ProjectScopeSpec = { all: true, managed: false, member: false };
const MANAGED_SPEC: ProjectScopeSpec = { all: false, managed: true, member: false };
const MEMBER_SPEC: ProjectScopeSpec = { all: false, managed: false, member: true };

function actor(partial: Partial<ActorAuthorization> = {}): ActorAuthorization {
  return { userId: ACTOR_ID, roleCodes: [], dataScopes: [], permissionKeys: [], ...partial };
}

function actorWithKeys(keys: readonly PermissionKey[], partial: Partial<ActorAuthorization> = {}): ActorAuthorization {
  return actor({ ...partial, permissionKeys: [...keys] });
}

async function expectAppError(fn: () => Promise<unknown>, code: string): Promise<void> {
  await fn().then(
    () => {
      throw new Error("预期抛出 AppError，但未抛出");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(code);
    },
  );
}

// ---------- 记录级 ----------

describe("记录级：数据范围 → 可见集规格（v0.2 §4.1 / C3-02 / C3-03）", () => {
  it("系统管理员（all）→ 全量，不裁剪", () => {
    expect(projectScopeSpec(actor({ roleCodes: ["admin"], dataScopes: ["all"] }))).toEqual(ALL_SPEC);
  });

  it("项目经理（managed_projects）→ 只看我管理的", () => {
    expect(projectScopeSpec(actor({ roleCodes: ["project_manager"], dataScopes: ["managed_projects"] }))).toEqual(MANAGED_SPEC);
  });

  it("任务负责人 / 项目成员（involved_projects）→ 我参与的（名册）", () => {
    expect(projectScopeSpec(actor({ roleCodes: ["task_owner"], dataScopes: ["involved_projects"] }))).toEqual(MEMBER_SPEC);
    expect(projectScopeSpec(actor({ roleCodes: ["project_member"], dataScopes: ["involved_projects"] }))).toEqual(MEMBER_SPEC);
  });

  it("销售（own_stakeholders，未落地）→ 名册兜底，不锁死", () => {
    expect(projectScopeSpec(actor({ roleCodes: ["sales"], dataScopes: ["own_stakeholders"] }))).toEqual(MEMBER_SPEC);
  });

  it("只读（granted，未落地）→ 名册兜底", () => {
    expect(projectScopeSpec(actor({ roleCodes: ["viewer"], dataScopes: ["granted"] }))).toEqual(MEMBER_SPEC);
  });

  it("无角色 → 名册兜底（有角色不应比无角色看得更少）", () => {
    expect(projectScopeSpec(actor())).toEqual(MEMBER_SPEC);
  });

  it("多角色并集（managed + involved）→ 两者都放行", () => {
    expect(
      projectScopeSpec(actor({ roleCodes: ["project_manager", "task_owner"], dataScopes: ["managed_projects", "involved_projects"] })),
    ).toEqual({ all: false, managed: true, member: true });
  });

  it("可见 id 并集：manager_id 责任人恒可见，名册项目经理随 managed 放行", () => {
    const sets = { memberIds: ["p-member"], ownedIds: ["p-owned"], managedRosterIds: ["p-roster-pm"] };
    expect([...visibleProjectIds(MANAGED_SPEC, sets)].sort()).toEqual(["p-owned", "p-roster-pm"]);
    expect([...visibleProjectIds(MEMBER_SPEC, sets)].sort()).toEqual(["p-member", "p-owned"]);
  });

  it("单项目谓词与可见 id 同源（列表可见 = 详情可见）", () => {
    const roster = { rosterMember: true, managerOfRecord: false, rosterProjectManager: false };
    expect(isProjectVisible(MEMBER_SPEC, roster)).toBe(true);
    expect(isProjectVisible(MANAGED_SPEC, roster)).toBe(false);
    expect(isProjectVisible(MANAGED_SPEC, { rosterMember: false, managerOfRecord: true, rosterProjectManager: false })).toBe(true);
    expect(isProjectVisible(MEMBER_SPEC, { rosterMember: false, managerOfRecord: false, rosterProjectManager: false })).toBe(false);
    expect(isProjectVisible(ALL_SPEC, { rosterMember: false, managerOfRecord: false, rosterProjectManager: false })).toBe(true);
  });
});

// ---------- 功能权限 ----------

describe("功能权限：can（全局位 ∪ 项目内角色隐含位 · ADR-011）", () => {
  const memberContext = { member: true, projectManager: false };
  const managerContext = { member: true, projectManager: true };
  const outsiderContext = { member: false, projectManager: false };

  it("全局权限位：管理员（全键）项目删除 / 建项目 / 蓝图维护全放行", () => {
    const admin = actorWithKeys(PERMISSION_KEYS);
    expect(can(admin, "project.delete")).toBe(true);
    expect(can(admin, "project.create")).toBe(true);
    expect(can(admin, "blueprint.manage")).toBe(true);
    expect(can(admin, "stakeholder.contact.view")).toBe(true);
  });

  it("任务负责人：可改任务、完成节点，不可建 / 删项目、不可维护名册", () => {
    const owner = actorWithKeys(["project.view", "task.view", "task.update", "task.progress", "node.view", "node.complete"]);
    expect(can(owner, "task.update")).toBe(true);
    expect(can(owner, "node.complete")).toBe(true);
    expect(can(owner, "project.create")).toBe(false);
    expect(can(owner, "project.delete")).toBe(false);
    expect(can(owner, "member.manage")).toBe(false);
  });

  it("项目内项目经理：节点增删 / 名册 / 阶段推进放行；蓝图维护不放行", () => {
    const plain = actor();
    expect(can(plain, "node.create", managerContext)).toBe(true);
    expect(can(plain, "node.delete", managerContext)).toBe(true);
    expect(can(plain, "member.manage", managerContext)).toBe(true);
    expect(can(plain, "node.advance", managerContext)).toBe(true);
    expect(can(plain, "blueprint.manage", managerContext)).toBe(false);
  });

  it("项目内成员：任务进度与完成节点平权；名册 / 项目编辑 / 节点增删不放行", () => {
    const plain = actor();
    expect(can(plain, "task.progress", memberContext)).toBe(true);
    expect(can(plain, "node.complete", memberContext)).toBe(true);
    expect(can(plain, "project.view", memberContext)).toBe(true);
    expect(can(plain, "member.manage", memberContext)).toBe(false);
    expect(can(plain, "project.update", memberContext)).toBe(false);
    expect(can(plain, "node.create", memberContext)).toBe(false);
  });

  it("非成员（ctx 皆 false）：一律拒绝（记录级 404 先于功能权限）", () => {
    const plain = actor();
    for (const key of PROJECT_MEMBER_IMPLIED_KEYS) {
      expect(can(plain, key, outsiderContext)).toBe(false);
    }
  });

  it("项目内角色只在项目上下文生效：无 ctx 时仅看全局位", () => {
    const plain = actor();
    expect(can(plain, "node.create")).toBe(false);
    expect(can(plain, "task.progress")).toBe(false);
  });

  it("隐含位集合：成员 ⊆ 项目经理，且全部键都在契约枚举内", () => {
    for (const key of PROJECT_MEMBER_IMPLIED_KEYS) {
      expect(PROJECT_MANAGER_IMPLIED_KEYS).toContain(key);
      expect(PERMISSION_KEYS).toContain(key);
    }
    for (const key of PROJECT_MANAGER_IMPLIED_KEYS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });
});

// ---------- 字段级 ----------

describe("字段级：字段策略表（A5-07 / C3-04 / C3-08 无权字段不返回）", () => {
  it("持有 stakeholder.contact.view → 联系方式三字段与商务字段全部可见", () => {
    const sales = actorWithKeys(["stakeholder.view", "stakeholder.manage", "stakeholder.contact.view"]);
    expect(visibleFields(sales, "stakeholder")).toEqual(["name", "company", "title", "phone", "wechat", "email", "remark", "role"]);
    expect(hiddenFields(sales, "stakeholder")).toEqual([]);
  });

  it("只有 stakeholder.view → 联系方式被裁掉（A5-07「无关角色不可见」）", () => {
    const owner = actorWithKeys(["stakeholder.view"]);
    expect(hiddenFields(owner, "stakeholder")).toEqual(["phone", "wechat", "email", "remark"]);
    expect(visibleFields(owner, "stakeholder")).toEqual(["name", "company", "title", "role"]);
  });

  it("无干系人权限 → 仅未登记字段（姓名 / 角色）可见", () => {
    const outsider = actor();
    expect(visibleFields(outsider, "stakeholder")).toEqual(["name", "role"]);
  });

  it("行投影：删掉无权字段，不落 null 占位，未登记字段原样保留", () => {
    const row = { name: "张三", phone: "13800000000", wechat: "wx-zhangsan", company: "某公司", custom: "未登记字段" };
    const projected = projectFields(actorWithKeys(["stakeholder.view"]), "stakeholder", row);
    expect(Object.keys(projected).sort()).toEqual(["company", "custom", "name"]);
    expect("phone" in projected).toBe(false);
    expect("wechat" in projected).toBe(false);
  });

  it("员工目录邮箱一期全员可见（未加 requires）", () => {
    expect(visibleFields(actor(), "user")).toEqual(["username", "displayName", "email", "status"]);
  });

  it("字段策略表的实体与字段都在注册表内（防手写错字）", () => {
    for (const row of FIELD_POLICIES) {
      expect(ENTITY_FIELDS[row.entity]).toContain(row.field);
    }
  });
});

// ---------- 五出口 ----------

describe("五出口：页面 / 导出 / 搜索 / 通知同源（C3-08 不变量）", () => {
  const profiles: ActorAuthorization[] = [
    actorWithKeys(PERMISSION_KEYS, { roleCodes: ["admin"], dataScopes: ["all"] }),
    actorWithKeys(["stakeholder.view", "stakeholder.contact.view", "project.view", "project.export"]),
    actorWithKeys(["stakeholder.view", "project.view", "task.view"]),
    actor(),
  ];

  it("同一画像下四出口投影完全一致（exitsConsistent）", () => {
    for (const profile of profiles) {
      expect(exitsConsistent(profile, "stakeholder")).toBe(true);
      expect(exitsConsistent(profile, "user")).toBe(true);
    }
  });

  it("导出单独授权（C3-05）：无 project.export → allowed=false，其余出口不受影响", () => {
    const member = actorWithKeys(["project.view", "stakeholder.view"]);
    expect(planExit(member, "export", "stakeholder").allowed).toBe(false);
    expect(planExit(member, "page", "stakeholder").allowed).toBe(true);
    expect(planExit(member, "search", "stakeholder").allowed).toBe(true);
    expect(planExit(member, "notify", "stakeholder").allowed).toBe(true);
  });

  it("有权导出：字段仍按同一字段策略裁剪（联系方式不因导出而放开）", () => {
    const viewer = actorWithKeys(["project.export", "stakeholder.view"]);
    const plan = planExit(viewer, "export", "stakeholder");
    expect(plan.allowed).toBe(true);
    expect(plan.fields).toEqual(["name", "company", "title", "role"]);
    expect(plan.hidden).toEqual(["phone", "wechat", "email", "remark"]);
  });

  it("任一出口的投影都不含被裁字段（导出 / 搜索 / 消息内容不泄露）", () => {
    for (const profile of profiles) {
      for (const exit of EXIT_KINDS) {
        const plan = planExit(profile, exit, "stakeholder");
        for (const field of plan.hidden) {
          expect(plan.fields).not.toContain(field);
        }
      }
    }
  });

  it("出口集合固定为四类（页面 / 导出 / 搜索 / 通知）+ 记录级 = 五出口口径", () => {
    expect([...EXIT_KINDS]).toEqual(["page", "export", "search", "notify"]);
  });
});

// ---------- 部门权限基线（2026-10-26） ----------

describe("全量能力基线把五出口一并放开，项目范围由部门规则再次收窄", () => {
  const admin = fullCapabilityAuthorization(ACTOR_ID);

  it("画像：遗留角色码为空 + 数据范围 all + 契约全量权限位", () => {
    expect(admin).toEqual({
      userId: ACTOR_ID,
      roleCodes: [],
      dataScopes: ["all"],
      permissionKeys: [...PERMISSION_KEYS],
    });
  });

  it("功能权限：全键放行（含 project.export）；写能力在服务层按部门规则再裁决", () => {
    for (const key of PERMISSION_KEYS) {
      expect(can(admin, key)).toBe(true);
    }
  });

  it("记录级：不裁剪（all）—— 非名册成员 / 非责任人的项目同样可见", () => {
    expect(projectScopeSpec(admin)).toEqual(ALL_SPEC);
    expect(isProjectVisible(ALL_SPEC, { rosterMember: false, managerOfRecord: false, rosterProjectManager: false })).toBe(true);
  });

  it("字段级：无隐藏字段（联系人 / 备注不再裁剪），导出出口同样全量", () => {
    for (const entity of ["stakeholder", "user"] as const) {
      expect(hiddenFields(admin, entity)).toEqual([]);
      expect(visibleFields(admin, entity)).toEqual(ENTITY_FIELDS[entity]);
    }
    const plan = planExit(admin, "export", "stakeholder");
    expect(plan.allowed).toBe(true);
    expect(plan.hidden).toEqual([]);
  });
});

// ---------- 策略服务 ----------

class FakeRoleService {
  calls = 0;
  constructor(private readonly actors: Map<string, ActorAuthorization>) {}

  async getActorAuthorization(userId: string): Promise<ActorAuthorization> {
    this.calls += 1;
    const found = this.actors.get(userId);
    if (found === undefined) throw new Error("未知用户：" + userId);
    return found;
  }
}

class FakePermissionRepository {
  memberIds: string[] = [];
  ownedIds: string[] = [];
  managedRosterIds: string[] = [];
  refs = new Map<string, { managerIds: string[]; deletedAt: Date | null }>();
  memberships = new Map<string, string>();
  visibleCalls = 0;

  async listMemberProjectIds(): Promise<string[]> {
    return [...this.memberIds];
  }

  async listOwnedProjectIds(): Promise<string[]> {
    return [...this.ownedIds];
  }

  async listManagedRosterProjectIds(): Promise<string[]> {
    return [...this.managedRosterIds];
  }

  async listVisibleProjectIds(_actorId: string, spec: ProjectScopeSpec): Promise<string[]> {
    this.visibleCalls += 1;
    return visibleProjectIds(spec, {
      memberIds: this.memberIds,
      ownedIds: this.ownedIds,
      managedRosterIds: this.managedRosterIds,
    });
  }

  async findProjectRef(projectId: string): Promise<{ managerIds: string[]; deletedAt: Date | null } | null> {
    return this.refs.get(projectId) ?? null;
  }

  async findMembership(_actorId: string, projectId: string): Promise<string | null> {
    return this.memberships.get(projectId) ?? null;
  }

  async findNodeProjectId(_nodeId: string): Promise<string | null> {
    return null;
  }
}

function makeService(actors: ActorAuthorization[], repository: FakePermissionRepository) {
  const roles = new FakeRoleService(new Map(actors.map((item) => [item.userId, item])));
  const service = new PermissionService(roles as unknown as RoleService, repository as unknown as PermissionRepository);
  return { service, roles, repository };
}

describe("策略服务：可见集 / 项目上下文 / 404·403 / 缓存", () => {
  const admin = actor({ roleCodes: ["admin"], dataScopes: ["all"], permissionKeys: [...PERMISSION_KEYS] });
  const member = actor({ roleCodes: ["project_member"], dataScopes: ["involved_projects"], permissionKeys: ["project.view", "task.view"] });

  it("projectScope：管理员 → all（不查可见 id）", async () => {
    const { service, repository } = makeService([admin], new FakePermissionRepository());
    expect(await service.projectScope(ACTOR_ID)).toEqual({ kind: "all" });
    expect(repository.visibleCalls).toBe(0);
  });

  it("projectScope：成员 → ids 并集（名册 ∪ 责任人）", async () => {
    const repository = new FakePermissionRepository();
    repository.memberIds = [PROJECT_ID];
    repository.ownedIds = [OTHER_PROJECT];
    const { service } = makeService([member], repository);
    const scope = await service.projectScope(ACTOR_ID);
    expect(scope.kind).toBe("ids");
    if (scope.kind === "ids") expect([...scope.ids].sort()).toEqual([PROJECT_ID, OTHER_PROJECT].sort());
  });

  it("resolveProjectAccess：非成员 → null（统一 404 语义）", async () => {
    const repository = new FakePermissionRepository();
    repository.refs.set(PROJECT_ID, { managerIds: [MANAGER_ID], deletedAt: null });
    const { service } = makeService([member], repository);
    expect(await service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toBeNull();
    await expectAppError(() => service.assertProjectVisible(ACTOR_ID, PROJECT_ID), "NOT_FOUND");
  });

  it("resolveProjectAccess：名册成员 / 主数据责任人的角色位正确", async () => {
    const repository = new FakePermissionRepository();
    repository.refs.set(PROJECT_ID, { managerIds: [MANAGER_ID], deletedAt: null });
    repository.memberships.set(PROJECT_ID, "project_manager");
    const { service } = makeService([member], repository);
    expect(await service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      member: true,
      projectManager: true,
    });

    const rosterOnly = new FakePermissionRepository();
    rosterOnly.refs.set(PROJECT_ID, { managerIds: [MANAGER_ID], deletedAt: null });
    rosterOnly.memberships.set(PROJECT_ID, "project_member");
    const second = makeService([member], rosterOnly);
    expect(await second.service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      member: true,
      projectManager: false,
    });

    const owner = new FakePermissionRepository();
    owner.refs.set(PROJECT_ID, { managerIds: [ACTOR_ID], deletedAt: null });
    const third = makeService([actor()], owner);
    expect(await third.service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      member: true,
      projectManager: true,
    });
    // A22 · Push 136：multi-manager —— 责任人是第二位经理同样命中（任意一位）。
    const secondManager = new FakePermissionRepository();
    secondManager.refs.set(PROJECT_ID, { managerIds: [MANAGER_ID, ACTOR_ID], deletedAt: null });
    const fourth = makeService([actor()], secondManager);
    expect(await fourth.service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      member: true,
      projectManager: true,
    });
  });

  it("resolveProjectAccess：软删 / 不存在一律 null", async () => {
    const repository = new FakePermissionRepository();
    repository.refs.set(PROJECT_ID, { managerIds: [ACTOR_ID], deletedAt: new Date("2026-09-20T00:00:00.000Z") });
    const { service } = makeService([admin], repository);
    expect(await service.resolveProjectAccess(ACTOR_ID, PROJECT_ID)).toBeNull();
    expect(await service.resolveProjectAccess(ACTOR_ID, OTHER_PROJECT)).toBeNull();
  });

  it("assertCan：无权限键 → 403 FORBIDDEN；项目内角色隐含位参与判定", async () => {
    const repository = new FakePermissionRepository();
    const { service } = makeService([member], repository);
    await expectAppError(() => service.assertCan(ACTOR_ID, "member.manage"), "FORBIDDEN");
    await service.assertCan(ACTOR_ID, "task.progress", { member: true, projectManager: false });
  });

  it("授权画像缓存：同一用户两次判定只查一次库", async () => {
    const repository = new FakePermissionRepository();
    const { service, roles } = makeService([member], repository);
    await service.can(ACTOR_ID, "project.view");
    await service.can(ACTOR_ID, "task.view");
    expect(roles.calls).toBe(1);
    service.invalidate(ACTOR_ID);
    await service.can(ACTOR_ID, "project.view");
    expect(roles.calls).toBe(2);
  });
});
