import { describe, expect, it } from "vitest";
import { GROUP_ACCESS_PAGE_KEYS, GROUP_ACCESS_UNGROUPED_KEY, PERMISSION_KEYS, type GroupAccessRuleInput } from "@libiaolink/contracts";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { ActorAuthorization, RoleService } from "../src/modules/identity/index.js";
import { casdoorGroupKey, readCasdoorGroupKeys } from "../src/modules/identity/index.js";
import { UserService, normalizeSsoProfile } from "../src/modules/identity/user.service.js";
import type { UserGroupRepository } from "../src/modules/identity/user-group.repository.js";
import type { UserRepository } from "../src/modules/identity/user.repository.js";
import {
  effectiveGroupAccessRules,
  intersectProjectIds,
  parseGroupAccessAdminKeys,
  resolveGroupAccess,
  ruleAppliesToMember,
  type GroupAccessMemberRuleData,
  type GroupAccessRuleData,
} from "../src/modules/permission/group-access.rules.js";
import type { ProjectScopeSpec } from "../src/modules/permission/permission.rules.js";
import { GroupAccessService } from "../src/modules/permission/group-access.service.js";
import type { PermissionRepository } from "../src/modules/permission/permission.repository.js";
import { PermissionService } from "../src/modules/permission/permission.service.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_C = "33333333-3333-4333-8333-333333333333";
const PROJECT_D = "44444444-4444-4444-8444-444444444444";

function rule(partial: Partial<GroupAccessRuleData> & { groupKey: string }): GroupAccessRuleData {
  return {
    allowedPages: ["projects"],
    projectScope: "none",
    accessLevel: "view",
    projectIds: [],
    memberScope: "all",
    memberUserIds: [],
    ...partial,
  };
}

function memberRule(
  partial: Partial<GroupAccessMemberRuleData> & { groupKey: string; userId: string },
): GroupAccessMemberRuleData {
  return {
    projectScope: "none",
    accessLevel: "view",
    projectIds: [],
    ...partial,
  };
}

describe("Casdoor 群组键", () => {
  it("令牌 / 目录统一为 owner/name，并支持对象形式", () => {
    expect(casdoorGroupKey("libiaorobot.com", "项目部")).toBe("libiaorobot.com/项目部");
    expect(casdoorGroupKey(null, "libiaorobot.com/项目部")).toBe("libiaorobot.com/项目部");
    expect(readCasdoorGroupKeys(["项目部", "libiaorobot.com/交付部", "项目部"], "libiaorobot.com")).toEqual([
      "libiaorobot.com/项目部",
      "libiaorobot.com/交付部",
    ]);
    expect(readCasdoorGroupKeys([{ owner: "libiaorobot.com", name: "质量部" }], null)).toEqual(["libiaorobot.com/质量部"]);
  });

  it("groups 缺失返回 null，SSO 登录不会清空目录已同步关系", () => {
    expect(readCasdoorGroupKeys(undefined, "libiaorobot.com")).toBeNull();
    const profile = normalizeSsoProfile({ id: "u1", name: "A001", owner: "libiaorobot.com" });
    expect(profile.groups).toBeNull();
  });
});

describe("登录写入群组关系", () => {
  it("有 groups 声明时整体替换；声明缺失时保留；空数组时清空", async () => {
    const writes: string[][] = [];
    const users = {
      upsert: async (): Promise<{ id: string }> => ({ id: PROJECT_A }),
    };
    const groups = {
      replaceForUser: async (_userId: string, groupKeys: readonly string[]): Promise<void> => {
        writes.push([...groupKeys]);
      },
    };
    const service = new UserService(
      users as unknown as UserRepository,
      groups as unknown as UserGroupRepository,
    );
    await service.upsertFromClaims({
      id: "u1",
      name: "A001",
      owner: "libiaorobot.com",
      groups: ["项目部"],
    });
    await service.upsertFromClaims({ id: "u1", name: "A001", owner: "libiaorobot.com" });
    await service.upsertFromClaims({ id: "u1", name: "A001", owner: "libiaorobot.com", groups: [] });
    expect(writes).toEqual([["libiaorobot.com/项目部"], []]);
  });
});

describe("群组访问规则", () => {
  it("关闭开关：所有页面放行，不额外收窄项目", () => {
    const profile = resolveGroupAccess({ enforced: false, admin: false, groupKeys: ["g"], rules: [] });
    expect(profile.pages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(profile.readOnly).toBe(false);
    expect(profile.projectIds).toBeNull();
    expect(profile.ownProjects).toBe(false);
    expect(profile.projectScopes).toEqual(["all"]);
  });

  it("管理员群组：绕过页面与项目限制", () => {
    const profile = resolveGroupAccess({
      enforced: true,
      admin: true,
      groupKeys: ["libiaorobot.com/系统管理员"],
      rules: [rule({ groupKey: "libiaorobot.com/系统管理员", projectScope: "none" })],
    });
    expect(profile.pages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(profile.readOnly).toBe(false);
    expect(profile.projectIds).toBeNull();
    expect(profile.ownProjects).toBe(false);
    expect(profile.projectScopes).toEqual(["all"]);
  });

  it("所有页面恒放行；项目 selected 取并集，own 仅标记本人范围；任意 all 取消项目收窄", () => {
    const selected = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2", "g3", "g4"],
      rules: [
        rule({ groupKey: "g1", allowedPages: ["projects"], projectScope: "selected", projectIds: [PROJECT_A] }),
        rule({ groupKey: "g2", allowedPages: ["workspace"], projectScope: "selected", projectIds: [PROJECT_A, PROJECT_B] }),
        rule({ groupKey: "g3", allowedPages: ["files"], projectScope: "none" }),
        rule({ groupKey: "g4", projectScope: "own" }),
      ],
    });
    expect(selected.pages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(selected.readOnly).toBe(true);
    expect(selected.projectIds).toEqual([PROJECT_A, PROJECT_B]);
    expect(selected.ownProjects).toBe(true);
    expect(selected.projectScopes).toEqual(["selected", "none", "own"]);

    const all = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2", "g3"],
      rules: [
        rule({ groupKey: "g1", projectScope: "selected", projectIds: [PROJECT_A] }),
        rule({ groupKey: "g2", projectScope: "own" }),
        rule({ groupKey: "g3", projectScope: "all" }),
      ],
    });
    expect(all.projectIds).toBeNull();
    expect(all.ownProjects).toBe(false);
    expect(all.readOnly).toBe(true);
    expect(all.projectScopes).toEqual(["selected", "own", "all"]);
  });

  it("任一适用 edit 规则才解除只读，view / 无规则继续只读", () => {
    const view = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2"],
      rules: [
        rule({ groupKey: "g1", projectScope: "all", accessLevel: "view" }),
        rule({ groupKey: "g2", projectScope: "selected", projectIds: [PROJECT_A], accessLevel: "view" }),
      ],
    });
    expect(view.readOnly).toBe(true);

    const edit = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2"],
      rules: [
        rule({ groupKey: "g1", projectScope: "own", accessLevel: "view" }),
        rule({ groupKey: "g2", projectScope: "selected", projectIds: [PROJECT_A], accessLevel: "edit" }),
      ],
    });
    expect(edit.readOnly).toBe(false);
    expect(edit.projectIds).toEqual([PROJECT_A]);
  });

  it("人员范围 selected 仅匹配勾选人员；空选择不放行任何人", () => {
    expect(ruleAppliesToMember(rule({ groupKey: "g" }), PROJECT_A)).toBe(true);
    expect(ruleAppliesToMember(rule({ groupKey: "g", memberScope: "selected", memberUserIds: [PROJECT_A] }), PROJECT_A)).toBe(true);
    expect(ruleAppliesToMember(rule({ groupKey: "g", memberScope: "selected", memberUserIds: [PROJECT_B] }), PROJECT_A)).toBe(false);
    expect(ruleAppliesToMember(rule({ groupKey: "g", memberScope: "selected", memberUserIds: [] }), PROJECT_A)).toBe(false);
  });

  it("同部门个人规则优先且互不影响；删除个人规则后恢复部门默认", () => {
    const departmentDefault = rule({
      groupKey: "libiaorobot.com/项目部",
      projectScope: "own",
      accessLevel: "view",
    });
    const aliceRule = memberRule({
      groupKey: "libiaorobot.com/项目部",
      userId: PROJECT_A,
      projectScope: "all",
      accessLevel: "edit",
    });
    const bobRule = memberRule({
      groupKey: "libiaorobot.com/项目部",
      userId: PROJECT_B,
      projectScope: "selected",
      projectIds: [PROJECT_C],
      accessLevel: "view",
    });
    const memberRules = [aliceRule, bobRule];

    const alice = effectiveGroupAccessRules(["libiaorobot.com/项目部"], [departmentDefault], memberRules, PROJECT_A);
    const bob = effectiveGroupAccessRules(["libiaorobot.com/项目部"], [departmentDefault], memberRules, PROJECT_B);
    const carol = effectiveGroupAccessRules(["libiaorobot.com/项目部"], [departmentDefault], memberRules, PROJECT_C);

    expect(alice).toMatchObject([{ projectScope: "all", accessLevel: "edit", memberUserIds: [PROJECT_A] }]);
    expect(bob).toMatchObject([{ projectScope: "selected", accessLevel: "view", projectIds: [PROJECT_C], memberUserIds: [PROJECT_B] }]);
    expect(carol).toEqual([departmentDefault]);
    expect(effectiveGroupAccessRules(["libiaorobot.com/项目部"], [departmentDefault], [aliceRule], PROJECT_A)).toMatchObject([
      { accessLevel: "edit", projectScope: "all" },
    ]);
    expect(effectiveGroupAccessRules(["libiaorobot.com/项目部"], [departmentDefault], [], PROJECT_A)).toEqual([departmentDefault]);
  });

  it("个人 none 覆盖可以收紧部门默认，且多部门仍取并集", () => {
    const departmentDefault = rule({
      groupKey: "libiaorobot.com/项目部",
      projectScope: "all",
      accessLevel: "edit",
    });
    const personalNone = memberRule({
      groupKey: "libiaorobot.com/项目部",
      userId: PROJECT_A,
      projectScope: "none",
      accessLevel: "view",
    });
    const otherDepartment = rule({
      groupKey: "libiaorobot.com/交付部",
      projectScope: "selected",
      projectIds: [PROJECT_B],
      accessLevel: "view",
    });
    const effective = effectiveGroupAccessRules(
      ["libiaorobot.com/项目部", "libiaorobot.com/交付部"],
      [departmentDefault, otherDepartment],
      [personalNone],
      PROJECT_A,
    );
    expect(effective).toMatchObject([
      { groupKey: "libiaorobot.com/项目部", projectScope: "none" },
      { groupKey: "libiaorobot.com/交付部", projectScope: "selected" },
    ]);
    expect(resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["libiaorobot.com/项目部", "libiaorobot.com/交付部"],
      rules: effective,
    })).toMatchObject({ projectIds: [PROJECT_B], readOnly: true });
  });

  it("开启开关但群组无规则：页面全开、只读、项目为空", () => {
    const profile = resolveGroupAccess({ enforced: true, admin: false, groupKeys: ["g"], rules: [] });
    expect(profile.pages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(profile.readOnly).toBe(true);
    expect(profile.projectIds).toEqual([]);
    expect(profile.ownProjects).toBe(false);
    expect(profile.projectScopes).toEqual([]);
  });

  it("角色可见集与群组白名单取交集", () => {
    expect(intersectProjectIds([PROJECT_A, PROJECT_B], [PROJECT_B, PROJECT_C])).toEqual([PROJECT_B]);
    expect(intersectProjectIds(null, [PROJECT_B])).toEqual([PROJECT_B]);
    expect(intersectProjectIds([PROJECT_A], null)).toEqual([PROJECT_A]);
  });

  it("管理员群组配置解析去空白 / 去重", () => {
    expect(parseGroupAccessAdminKeys(" libiaorobot.com/a, ,libiaorobot.com/b,libiaorobot.com/a ")).toEqual([
      "libiaorobot.com/a",
      "libiaorobot.com/b",
    ]);
  });
});

describe("GroupAccessService 部门通讯录", () => {
  it("返回部门层级和直属人员，并合并既有规则与观察到的额外部门", async () => {
    const repository = {
      listUngroupedUsers: async () => [{
        userId: PROJECT_D,
        username: "1004",
        displayName: "Dana",
        email: "dana@libiaorobot.com",
        status: "active" as const,
      }],
      listGroupMembers: async () => [
        {
          groupKey: "libiaorobot.com/QA",
          groupName: "Quality",
          userId: PROJECT_A,
          username: "1001",
          displayName: "Alice",
          email: "alice@libiaorobot.com",
          status: "active",
        },
        {
          groupKey: "libiaorobot.com/QA",
          groupName: "Quality",
          userId: PROJECT_B,
          username: "1002",
          displayName: "Bob",
          email: null,
          status: "disabled",
        },
        {
          groupKey: "libiaorobot.com/Extra",
          groupName: "Extra",
          userId: PROJECT_C,
          username: "1003",
          displayName: "Carol",
          email: "carol@libiaorobot.com",
          status: "active",
        },
      ],
      listAccessRules: async () => [rule({ groupKey: "libiaorobot.com/QA", allowedPages: ["files"] })],
      listAccessMemberRules: async () => [memberRule({
        groupKey: "libiaorobot.com/QA",
        userId: PROJECT_A,
        projectScope: "selected",
        projectIds: [PROJECT_C],
        accessLevel: "edit",
        updatedAt: new Date("2026-10-26T00:00:00Z"),
      })],
      listAccessProjects: async () => [],
      findRuleMetadata: async () => ({ groupName: "Quality", updatedAt: new Date("2026-10-23T00:00:00Z") }),
      listActiveUsersByIds: async (userIds: readonly string[]) => userIds.includes(PROJECT_A) ? [{
        userId: PROJECT_A,
        username: "1001",
        displayName: "Alice",
        email: "alice@libiaorobot.com",
        status: "active" as const,
      }] : [],
      listGroupAdminUsersByGroupKeys: async () => [],
      listManualGroupAccessAdmins: async () => [],
    };
    const permission = {
      canManageGroupAccess: async () => true,
      groupAccessOf: async () => ({
        enforced: false,
        admin: true,
        readOnly: false,
        groupKeys: ["libiaorobot.com/QA"],
        pages: [...GROUP_ACCESS_PAGE_KEYS],
        projectIds: null,
        ownProjects: false,
        hasRule: false,
        projectScopes: ["all"],
      }),
    };
    const departments = {
      listDepartments: async () => [
        { id: PROJECT_A, parentId: null, sourceId: "RD", name: "R&D" },
        { id: PROJECT_B, parentId: PROJECT_A, sourceId: "QA", name: "Quality" },
      ],
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      departments as never,
      new AppConfig({
        CASDOOR_ORG_NAME: "libiaorobot.com",
        GROUP_ACCESS_ADMIN_USER_IDS: PROJECT_A,
      } as Env),
    );
    const overview = await service.overview(PROJECT_A);
    expect(overview.groups.map((group) => ({
      key: group.groupKey,
      parent: group.parentGroupKey,
      members: group.memberCount,
      pages: group.rule?.allowedPages ?? [],
    }))).toEqual([
      { key: GROUP_ACCESS_UNGROUPED_KEY, parent: null, members: 1, pages: [] },
      { key: "libiaorobot.com/Extra", parent: null, members: 1, pages: [] },
      { key: "libiaorobot.com/QA", parent: "libiaorobot.com/RD", members: 2, pages: [...GROUP_ACCESS_PAGE_KEYS] },
      { key: "libiaorobot.com/RD", parent: null, members: 0, pages: [] },
    ]);
    const qaWithPersonalRule = overview.groups.find((group) => group.groupKey === "libiaorobot.com/QA");
    expect(qaWithPersonalRule?.memberRules).toEqual([{
      groupKey: "libiaorobot.com/QA",
      userId: PROJECT_A,
      projectScope: "selected",
      accessLevel: "edit",
      projectIds: [PROJECT_C],
      updatedAt: "2026-10-26T00:00:00.000Z",
    }]);
    const ungrouped = overview.groups.find((group) => group.groupKey === GROUP_ACCESS_UNGROUPED_KEY);
    expect(ungrouped).toMatchObject({
      groupName: "未分组",
      parentGroupKey: null,
      memberCount: 1,
      members: [{ userId: PROJECT_D, username: "1004", displayName: "Dana", status: "active" }],
    });
    expect(overview.admins).toEqual([
      {
        userId: PROJECT_A,
        username: "1001",
        displayName: "Alice",
        email: "alice@libiaorobot.com",
        status: "active",
        source: "configured",
        removable: false,
      },
    ]);
    const qa = overview.groups.find((group) => group.groupKey === "libiaorobot.com/QA");
    expect(qa?.members).toEqual([
      {
        userId: PROJECT_A,
        username: "1001",
        displayName: "Alice",
        email: "alice@libiaorobot.com",
        status: "active",
      },
      {
        userId: PROJECT_B,
        username: "1002",
        displayName: "Bob",
        email: null,
        status: "disabled",
      },
    ]);
  });

  it("保存 selected 人员范围，并拒绝不在当前部门的成员", async () => {
    let savedArgs: unknown[] | null = null;
    const repository = {
      findRuleMetadata: async () => null,
      listExistingProjectIds: async () => [],
      listGroupMemberIds: async () => [PROJECT_A],
      upsertGroupAccessRule: async (...args: unknown[]) => { savedArgs = args; },
    };
    const permission = {
      canManageGroupAccess: async () => true,
      invalidate: () => undefined,
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      {} as never,
      new AppConfig({ CASDOOR_ORG_NAME: "libiaorobot.com" } as Env),
    );
    const input: GroupAccessRuleInput = {
      groupKey: "libiaorobot.com/QA",
      groupName: "Quality",
      allowedPages: ["projects"],
      projectScope: "none",
      accessLevel: "view",
      projectIds: [],
      memberScope: "selected",
      memberUserIds: [PROJECT_A],
    };

    const saved = await service.save(PROJECT_A, input);
    expect(saved.rule.allowedPages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(saved.rule.memberScope).toBe("selected");
    expect(saved.rule.memberUserIds).toEqual([PROJECT_A]);
    expect(savedArgs?.[4]).toBe("view");
    expect(savedArgs?.[6]).toBe("selected");
    expect(savedArgs?.[7]).toEqual([PROJECT_A]);

    await expect(
      service.save(PROJECT_A, { ...input, memberUserIds: [PROJECT_B] }),
    ).rejects.toThrow("所选人员已不在该部门");
  });

  it("保存编辑档位；不显示项目数据时强制仅浏览", async () => {
    let savedArgs: unknown[] | null = null;
    const repository = {
      findRuleMetadata: async () => null,
      listExistingProjectIds: async () => [],
      listGroupMemberIds: async () => [],
      upsertGroupAccessRule: async (...args: unknown[]) => { savedArgs = args; },
    };
    const permission = {
      canManageGroupAccess: async () => true,
      invalidate: () => undefined,
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      {} as never,
      new AppConfig({ CASDOOR_ORG_NAME: "libiaorobot.com" } as Env),
    );
    const base: GroupAccessRuleInput = {
      groupKey: "libiaorobot.com/QA",
      groupName: "Quality",
      allowedPages: ["projects"],
      projectScope: "all",
      accessLevel: "edit",
      projectIds: [],
      memberScope: "all",
      memberUserIds: [],
    };

    const saved = await service.save(PROJECT_A, base);
    expect(saved.rule.accessLevel).toBe("edit");
    expect(savedArgs?.[3]).toBe("all");
    expect(savedArgs?.[4]).toBe("edit");

    const normalized = await service.save(PROJECT_A, { ...base, projectScope: "none", accessLevel: "edit" });
    expect(normalized.rule.accessLevel).toBe("view");
    expect(savedArgs?.[3]).toBe("none");
    expect(savedArgs?.[4]).toBe("view");
  });

  it("未分组节点可保存指定人员规则，成员校验只接受当前未分组账号", async () => {
    let savedArgs: unknown[] | null = null;
    const repository = {
      findRuleMetadata: async () => null,
      listExistingProjectIds: async () => [],
      listGroupMemberIds: async () => {
        throw new Error("未分组不应读取真实群组成员");
      },
      listUngroupedUsers: async () => [
        { userId: PROJECT_C, username: "1003", displayName: "Carol", email: null, status: "active" as const },
        { userId: PROJECT_D, username: "1004", displayName: "Dana", email: "dana@libiaorobot.com", status: "active" as const },
      ],
      upsertGroupAccessRule: async (...args: unknown[]) => { savedArgs = args; },
    };
    const permission = {
      canManageGroupAccess: async () => true,
      invalidate: () => undefined,
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      {} as never,
      new AppConfig({ CASDOOR_ORG_NAME: "libiaorobot.com" } as Env),
    );
    const input: GroupAccessRuleInput = {
      groupKey: GROUP_ACCESS_UNGROUPED_KEY,
      allowedPages: ["projects"],
      projectScope: "own",
      accessLevel: "view",
      projectIds: [],
      memberScope: "selected",
      memberUserIds: [PROJECT_D],
    };

    const saved = await service.save(PROJECT_A, input);
    expect(saved.rule).toMatchObject({
      groupKey: GROUP_ACCESS_UNGROUPED_KEY,
      groupName: "未分组",
      projectScope: "own",
      memberScope: "selected",
      memberUserIds: [PROJECT_D],
    });
    expect(savedArgs?.[0]).toBe(GROUP_ACCESS_UNGROUPED_KEY);
    expect(savedArgs?.[1]).toBe("未分组");
    expect(savedArgs?.[7]).toEqual([PROJECT_D]);

    await expect(
      service.save(PROJECT_A, { ...input, memberUserIds: [PROJECT_A] }),
    ).rejects.toThrow("所选人员已不在该部门");
  });

  it("同一部门可分别保存个人权限，且不会改写部门默认规则", async () => {
    const upserts: unknown[][] = [];
    const deletions: unknown[][] = [];
    const repository = {
      findRuleMetadata: async () => null,
      listExistingProjectIds: async () => [PROJECT_C],
      listGroupMemberIds: async () => [PROJECT_A, PROJECT_B],
      listExistingMemberRuleUserIds: async (_groupKey: string, userIds: readonly string[]) => userIds.filter((userId) => userId === PROJECT_A),
      upsertGroupAccessMemberRules: async (...args: unknown[]) => { upserts.push(args); },
      deleteGroupAccessMemberRules: async (...args: unknown[]) => { deletions.push(args); return 1; },
      upsertGroupAccessRule: async () => { throw new Error("个人权限不应改写部门默认规则"); },
    };
    let invalidations = 0;
    const permission = {
      canManageGroupAccess: async () => true,
      invalidate: () => { invalidations += 1; },
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      {} as never,
      new AppConfig({ CASDOOR_ORG_NAME: "libiaorobot.com" } as Env),
    );

    await service.saveMemberRules(PROJECT_A, {
      groupKey: "libiaorobot.com/QA",
      groupName: "Quality",
      userIds: [PROJECT_A],
      projectScope: "all",
      accessLevel: "edit",
      projectIds: [],
    });
    await service.saveMemberRules(PROJECT_A, {
      groupKey: "libiaorobot.com/QA",
      groupName: "Quality",
      userIds: [PROJECT_B],
      projectScope: "selected",
      accessLevel: "view",
      projectIds: [PROJECT_C],
    });

    expect(upserts).toEqual([
      ["libiaorobot.com/QA", [PROJECT_A], "all", "edit", [], expect.any(Date)],
      ["libiaorobot.com/QA", [PROJECT_B], "selected", "view", [PROJECT_C], expect.any(Date)],
    ]);
    await expect(service.saveMemberRules(PROJECT_A, {
      groupKey: "libiaorobot.com/QA",
      userIds: [PROJECT_C],
      projectScope: "none",
      accessLevel: "view",
      projectIds: [],
    })).rejects.toThrow("所选人员已不在该部门");

    await service.removeMemberRules(PROJECT_A, {
      groupKey: "libiaorobot.com/QA",
      userIds: [PROJECT_A],
    });
    expect(deletions).toEqual([["libiaorobot.com/QA", [PROJECT_A]]]);
    expect(invalidations).toBe(3);
  });

  it("手工授予 / 撤销系统管理员，环境配置管理员不可撤销", async () => {
    const configuredAdmin = {
      userId: PROJECT_A,
      username: "1001",
      displayName: "Alice",
      email: "alice@libiaorobot.com",
      status: "active" as const,
    };
    const managedAdmin = {
      userId: PROJECT_B,
      username: "1002",
      displayName: "Bob",
      email: null,
      status: "active" as const,
    };
    let manual: Array<typeof managedAdmin & { grantedAt: Date }> = [];
    const auditActions: string[] = [];
    let invalidations = 0;
    const repository = {
      listActiveUsersByIds: async (userIds: readonly string[]) => userIds.includes(PROJECT_A) ? [configuredAdmin] : [],
      listGroupAdminUsersByGroupKeys: async () => [],
      listManualGroupAccessAdmins: async () => [...manual],
      findActiveGroupAccessUser: async (userId: string) => userId === PROJECT_B ? managedAdmin : null,
      grantGroupAccessAdmin: async (userId: string, _grantedBy: string, at: Date) => {
        if (manual.some((item) => item.userId === userId)) return false;
        manual = [...manual, { ...managedAdmin, grantedAt: at }];
        return true;
      },
      revokeGroupAccessAdmin: async (userId: string) => {
        const before = manual.length;
        manual = manual.filter((item) => item.userId !== userId);
        return manual.length < before;
      },
    };
    const permission = {
      canManageGroupAccess: async () => true,
      invalidate: () => { invalidations += 1; },
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async (entry: { action: string }) => { auditActions.push(entry.action); } } as never,
      {} as never,
      new AppConfig({
        CASDOOR_ORG_NAME: "libiaorobot.com",
        GROUP_ACCESS_ADMIN_USER_IDS: PROJECT_A,
      } as Env),
    );

    const assigned = await service.assignAdmin(PROJECT_A, PROJECT_B);
    expect(assigned.admin).toMatchObject({ userId: PROJECT_B, source: "manual", removable: true });
    expect(invalidations).toBe(1);
    await expect(service.removeAdmin(PROJECT_A, PROJECT_A)).rejects.toThrow("环境配置的管理员");
    await service.removeAdmin(PROJECT_A, PROJECT_B);
    expect(auditActions).toEqual(["create", "delete"]);
    expect(invalidations).toBe(2);
    expect(manual).toEqual([]);
  });
});

class FakeRoleService {
  constructor(private readonly authorization: ActorAuthorization) {}
  async getActorAuthorization(): Promise<ActorAuthorization> {
    return this.authorization;
  }
}

class FakeGroupRepository {
  groupKeys: string[] = [];
  rules: GroupAccessRuleData[] = [];
  memberRules: GroupAccessMemberRuleData[] = [];
  refs = new Map<string, { managerIds: string[]; deletedAt: Date | null }>();
  memberships = new Map<string, string>();
  manualAdminUserIds: string[] = [];

  async listUserGroupKeys(): Promise<string[]> {
    return [...this.groupKeys];
  }
  async listGroupAccessRules(groupKeys: readonly string[]): Promise<GroupAccessRuleData[]> {
    const allowed = new Set(groupKeys);
    return this.rules.filter((item) => allowed.has(item.groupKey));
  }
  async listMemberAccessRulesForUser(
    groupKeys: readonly string[],
    userId: string,
  ): Promise<GroupAccessMemberRuleData[]> {
    const allowed = new Set(groupKeys);
    return this.memberRules.filter((item) => item.userId === userId && allowed.has(item.groupKey));
  }
  async isManualGroupAccessAdmin(userId: string): Promise<boolean> {
    return this.manualAdminUserIds.includes(userId);
  }
  async listOwnedProjectIds(actorId: string): Promise<string[]> {
    return [...this.refs.entries()].filter(([, ref]) => ref.managerIds.includes(actorId)).map(([projectId]) => projectId);
  }
  async hasActiveProject(): Promise<boolean> {
    return [...this.refs.values()].some((ref) => ref.deletedAt === null);
  }
  async listActiveProjectIds(projectIds: readonly string[]): Promise<string[]> {
    return projectIds.filter((projectId) => this.refs.get(projectId)?.deletedAt === null);
  }
  async listManagedRosterProjectIds(): Promise<string[]> {
    return [...this.memberships.entries()].filter(([, role]) => role === "project_manager").map(([projectId]) => projectId);
  }
  async listVisibleProjectIds(actorId: string, spec: ProjectScopeSpec): Promise<string[]> {
    const ids = new Set<string>();
    for (const [projectId, ref] of this.refs) {
      if (ref.managerIds.includes(actorId)) ids.add(projectId);
      const role = this.memberships.get(projectId);
      if (spec.member && role !== undefined) ids.add(projectId);
      if (spec.managed && role === "project_manager") ids.add(projectId);
    }
    return [...ids];
  }
  async findProjectRef(projectId: string): Promise<{ managerIds: string[]; deletedAt: Date | null } | null> {
    return this.refs.get(projectId) ?? null;
  }
  async findMembership(_actorId: string, projectId: string): Promise<string | null> {
    return this.memberships.get(projectId) ?? null;
  }
}

function serviceWith(options: {
  groupKeys: string[];
  rules: GroupAccessRuleData[];
  memberRules?: GroupAccessMemberRuleData[];
  adminGroups?: string;
  groupEnforced?: boolean;
  adminUserIds?: string;
  manualAdminUserIds?: string[];
  roleCodes?: string[];
  dataScopes?: ActorAuthorization["dataScopes"];
  permissionKeys?: ActorAuthorization["permissionKeys"];
}): { service: PermissionService; repository: FakeGroupRepository } {
  const repository = new FakeGroupRepository();
  repository.groupKeys = options.groupKeys;
  repository.rules = options.rules;
  repository.memberRules = options.memberRules ?? [];
  repository.manualAdminUserIds = options.manualAdminUserIds ?? [];
  const authorization = {
    userId: PROJECT_A,
    roleCodes: options.roleCodes ?? ["admin"],
    dataScopes: options.dataScopes ?? ["all"],
    permissionKeys: options.permissionKeys ?? [...PERMISSION_KEYS],
  } satisfies ActorAuthorization;
  const config = new AppConfig({
    GROUP_ACCESS_ENFORCED: options.groupEnforced === false ? "false" : "true",
    GROUP_ACCESS_ADMIN_GROUP_KEYS: options.adminGroups ?? "libiaorobot.com/系统管理员",
    GROUP_ACCESS_ADMIN_USER_IDS: options.adminUserIds ?? "",
  } as Env);
  const service = new PermissionService(
    new FakeRoleService(authorization) as unknown as RoleService,
    repository as unknown as PermissionRepository,
    config,
  );
  return { service, repository };
}

describe("PermissionService 群组接入", () => {
  it("项目范围按角色可见集与群组白名单取交集，详情同口径", async () => {
    const { service, repository } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_A] })],
    });
    repository.refs.set(PROJECT_A, { managerIds: [PROJECT_A], deletedAt: null });
    repository.refs.set(PROJECT_B, { managerIds: [PROJECT_A], deletedAt: null });
    expect(await service.projectScope(PROJECT_A)).toEqual({ kind: "ids", ids: [PROJECT_A] });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_A)).toMatchObject({ projectId: PROJECT_A });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_B)).toBeNull();
  });

  it("无部门账号映射为未分组并应用未分组规则；已有部门不注入", async () => {
    const ungrouped = serviceWith({
      groupKeys: [],
      rules: [rule({
        groupKey: GROUP_ACCESS_UNGROUPED_KEY,
        projectScope: "selected",
        accessLevel: "edit",
        projectIds: [PROJECT_A],
        memberScope: "selected",
        memberUserIds: [PROJECT_A],
      })],
    });
    expect(await ungrouped.service.groupAccessOf(PROJECT_A)).toMatchObject({
      groupKeys: [GROUP_ACCESS_UNGROUPED_KEY],
      readOnly: false,
      projectIds: [PROJECT_A],
    });

    const grouped = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: GROUP_ACCESS_UNGROUPED_KEY, projectScope: "all", accessLevel: "edit" })],
    });
    expect(await grouped.service.groupAccessOf(PROJECT_A)).toMatchObject({
      groupKeys: ["libiaorobot.com/项目部"],
      readOnly: true,
      projectIds: [],
    });
  });

  it("selected 人员范围在权限画像入口过滤，不匹配人员按无规则处理", async () => {
    const denied = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({
        groupKey: "libiaorobot.com/项目部",
        allowedPages: ["projects"],
        memberScope: "selected",
        memberUserIds: [PROJECT_B],
      })],
    });
    expect(await denied.service.canAccessPage(PROJECT_A, "projects")).toBe(true);
    expect(await denied.service.projectScope(PROJECT_A)).toEqual({ kind: "ids", ids: [] });
    expect((await denied.service.permissionsOf(PROJECT_A)).groupReadOnly).toBe(true);

    const allowed = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({
        groupKey: "libiaorobot.com/项目部",
        allowedPages: ["projects"],
        memberScope: "selected",
        memberUserIds: [PROJECT_A],
      })],
    });
    expect(await allowed.service.canAccessPage(PROJECT_A, "projects")).toBe(true);
  });

  it("权限画像优先应用同部门个人覆盖，未被覆盖的人继续沿用部门默认", async () => {
    const departmentDefault = rule({
      groupKey: "libiaorobot.com/项目部",
      projectScope: "all",
      accessLevel: "edit",
    });
    const personalNone = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [departmentDefault],
      memberRules: [memberRule({
        groupKey: "libiaorobot.com/项目部",
        userId: PROJECT_A,
        projectScope: "none",
        accessLevel: "view",
      })],
    });
    expect(await personalNone.service.groupAccessOf(PROJECT_A)).toMatchObject({
      readOnly: true,
      projectIds: [],
      projectScopes: ["none"],
    });

    const personalSelected = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [departmentDefault],
      memberRules: [memberRule({
        groupKey: "libiaorobot.com/项目部",
        userId: PROJECT_A,
        projectScope: "selected",
        projectIds: [PROJECT_A],
        accessLevel: "view",
      })],
    });
    expect(await personalSelected.service.groupAccessOf(PROJECT_A)).toMatchObject({
      readOnly: true,
      projectIds: [PROJECT_A],
      projectScopes: ["selected"],
    });

    const inherited = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [departmentDefault],
    });
    expect(await inherited.service.groupAccessOf(PROJECT_A)).toMatchObject({
      readOnly: false,
      projectIds: null,
      projectScopes: ["all"],
    });
  });

  it("非管理员页面恒全量且只读；管理员群组绕过只读", async () => {
    const { service } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_A] })],
    });
    expect(await service.canAccessPage(PROJECT_A, "projects")).toBe(true);
    expect(await service.canAccessPage(PROJECT_A, "workspace")).toBe(true);
    expect(await service.canAccessPage(PROJECT_A, "audit")).toBe(true);
    expect(await service.can(PROJECT_A, "task.view")).toBe(true);
    expect(await service.can(PROJECT_A, "task.update")).toBe(false);
    expect(await service.can(PROJECT_A, "file.upload")).toBe(false);
    await expect(service.assertWritable(PROJECT_A)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await service.permissionsOf(PROJECT_A)).groupReadOnly).toBe(true);

    const admin = serviceWith({
      groupKeys: ["libiaorobot.com/系统管理员"],
      rules: [],
    });
    expect(await admin.service.canManageGroupAccess(PROJECT_A)).toBe(true);
    expect(await admin.service.canAccessPage(PROJECT_A, "audit")).toBe(true);
    expect(await admin.service.can(PROJECT_A, "task.update")).toBe(true);
    await expect(admin.service.assertWritable(PROJECT_A)).resolves.toBeUndefined();
    expect((await admin.service.permissionsOf(PROJECT_A)).groupReadOnly).toBe(false);
  });

  it("旧角色权限退出授权链后，部门管理员只来自环境配置、管理员部门或手工授权", async () => {
    const regular = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      groupEnforced: false,
    });
    const regularProfile = await regular.service.permissionsOf(PROJECT_A);
    expect(regularProfile.groupAccessEnforced).toBe(false);
    expect(regularProfile.groupReadOnly).toBe(false);
    expect(regularProfile.groupAccessAdmin).toBe(false);
    expect(await regular.service.canManageGroupAccess(PROJECT_A)).toBe(false);

    const explicitAdmin = serviceWith({
      groupKeys: ["libiaorobot.com/系统管理员"],
      rules: [],
      groupEnforced: false,
    });
    expect((await explicitAdmin.service.permissionsOf(PROJECT_A)).groupAccessAdmin).toBe(true);

    const userIdAdmin = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      groupEnforced: false,
      adminUserIds: PROJECT_A,
    });
    expect((await userIdAdmin.service.permissionsOf(PROJECT_A)).groupAccessAdmin).toBe(true);
  });

  it("权限页手工添加的管理员获得权限管理入口与完整写能力", async () => {
    const manual = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      groupEnforced: false,
      manualAdminUserIds: [PROJECT_A],
    });
    const profile = await manual.service.permissionsOf(PROJECT_A);
    expect(profile.groupAccessAdmin).toBe(true);
    expect(profile.groupReadOnly).toBe(false);
    expect(await manual.service.canManageGroupAccess(PROJECT_A)).toBe(true);
  });

  it("权限画像区分仅登录 / 无可浏览项目 / 可浏览，并给出操作记录范围", async () => {
    const denied = serviceWith({ groupKeys: ["libiaorobot.com/项目部"], rules: [] });
    expect(await denied.service.permissionsOf(PROJECT_A)).toMatchObject({
      groupProjectAccess: "denied",
      groupProjectScopes: [],
      groupAccessLevel: "view",
      auditScope: "self",
    });

    const loginOnly = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "none" })],
    });
    expect(await loginOnly.service.permissionsOf(PROJECT_A)).toMatchObject({
      groupProjectAccess: "denied",
      groupProjectScopes: ["none"],
      groupAccessLevel: "view",
      auditScope: "self",
    });

    const empty = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_A] })],
    });
    expect(await empty.service.permissionsOf(PROJECT_A)).toMatchObject({
      groupProjectAccess: "empty",
      groupProjectScopes: ["selected"],
      groupAccessLevel: "view",
      auditScope: "self",
    });

    const allowed = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_A], accessLevel: "edit" })],
    });
    allowed.repository.refs.set(PROJECT_A, { managerIds: [PROJECT_A], deletedAt: null });
    const profile = await allowed.service.permissionsOf(PROJECT_A);
    expect(profile).toMatchObject({
      groupProjectAccess: "allowed",
      groupProjectScopes: ["selected"],
      groupAccessLevel: "edit",
      auditScope: "project_manager",
    });
    expect(await allowed.service.auditAccessOf(PROJECT_A)).toEqual({
      scope: "project_manager",
      managedProjectIds: [PROJECT_A],
    });
  });

  it("项目经理仅能穿透当前有效项目范围，范围外项目仍只显示本人记录", async () => {
    const { service, repository } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_B] })],
    });
    repository.refs.set(PROJECT_A, { managerIds: [PROJECT_A], deletedAt: null });
    repository.refs.set(PROJECT_B, { managerIds: [PROJECT_B], deletedAt: null });
    expect((await service.permissionsOf(PROJECT_A)).groupProjectAccess).toBe("allowed");
    expect(await service.auditAccessOf(PROJECT_A)).toEqual({ scope: "self", managedProjectIds: [] });
  });

  it("软删项目不计入可浏览三态，也不为项目经理扩大操作记录范围", async () => {
    const { service, repository } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "all" })],
    });
    repository.refs.set(PROJECT_A, { managerIds: [PROJECT_A], deletedAt: new Date() });
    expect((await service.permissionsOf(PROJECT_A)).groupProjectAccess).toBe("empty");
    expect(await service.auditAccessOf(PROJECT_A)).toEqual({ scope: "self", managedProjectIds: [] });
  });

  it("系统管理员不受角色数据范围限制，仍可查看全部项目与操作记录", async () => {
    const { service, repository } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      manualAdminUserIds: [PROJECT_A],
      roleCodes: ["project_manager"],
      dataScopes: ["granted"],
      permissionKeys: ["task.view"],
    });
    repository.refs.set(PROJECT_A, { managerIds: [PROJECT_B], deletedAt: null });
    expect(await service.projectScope(PROJECT_A)).toEqual({ kind: "all" });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_A)).toMatchObject({ projectId: PROJECT_A });
    expect(await service.auditAccessOf(PROJECT_A)).toEqual({ scope: "all", managedProjectIds: [] });
    expect((await service.permissionsOf(PROJECT_A)).groupProjectAccess).toBe("allowed");
  });

  it("任务模板维护只认管理员或部门编辑规则，不因权限开关关闭而全员可写", async () => {
    const view = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "all", accessLevel: "view" })],
    });
    expect(await view.service.canManageBlueprint(PROJECT_A)).toBe(false);
    await expect(view.service.assertCanManageBlueprint(PROJECT_A)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const edit = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "all", accessLevel: "edit" })],
    });
    expect(await edit.service.canManageBlueprint(PROJECT_A)).toBe(true);

    const disabled = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      groupEnforced: false,
    });
    expect(await disabled.service.canManageBlueprint(PROJECT_A)).toBe(false);

    const admin = serviceWith({ groupKeys: ["libiaorobot.com/系统管理员"], rules: [], groupEnforced: false });
    expect(await admin.service.canManageBlueprint(PROJECT_A)).toBe(true);
  });

  it("任务节点 / 模板读取仅对有项目数据范围的账号放行，管理员或限制关闭恒可读", async () => {
    const denied = serviceWith({ groupKeys: ["libiaorobot.com/项目部"], rules: [] });
    expect(await denied.service.canReadBlueprint(PROJECT_A)).toBe(false);
    await expect(denied.service.assertCanReadBlueprint(PROJECT_A)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const loginOnly = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "none" })],
    });
    expect(await loginOnly.service.canReadBlueprint(PROJECT_A)).toBe(false);
    await expect(loginOnly.service.assertCanReadBlueprint(PROJECT_A)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const emptyScope = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "selected", projectIds: [PROJECT_A] })],
    });
    expect(await emptyScope.service.canReadBlueprint(PROJECT_A)).toBe(true);

    const disabled = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [],
      groupEnforced: false,
    });
    expect(await disabled.service.canReadBlueprint(PROJECT_A)).toBe(true);

    const admin = serviceWith({ groupKeys: ["libiaorobot.com/系统管理员"], rules: [] });
    expect(await admin.service.canReadBlueprint(PROJECT_A)).toBe(true);
  });

  it("own 项目范围展开为本人负责或进入名册的项目", async () => {
    const { service, repository } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", projectScope: "own" })],
    });
    repository.refs.set(PROJECT_A, { managerIds: [PROJECT_A], deletedAt: null });
    repository.refs.set(PROJECT_B, { managerIds: [PROJECT_B], deletedAt: null });
    repository.refs.set(PROJECT_C, { managerIds: [PROJECT_B], deletedAt: null });
    repository.memberships.set(PROJECT_B, "project_member");

    expect(await service.projectScope(PROJECT_A)).toEqual({ kind: "ids", ids: [PROJECT_A, PROJECT_B] });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_A)).toMatchObject({ projectId: PROJECT_A });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_B)).toMatchObject({ projectId: PROJECT_B });
    expect(await service.resolveProjectAccess(PROJECT_A, PROJECT_C)).toBeNull();
  });
});
