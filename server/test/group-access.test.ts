import { describe, expect, it } from "vitest";
import { GROUP_ACCESS_PAGE_KEYS, PERMISSION_KEYS } from "@libiaolink/contracts";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { ActorAuthorization, RoleService } from "../src/modules/identity/index.js";
import { casdoorGroupKey, readCasdoorGroupKeys } from "../src/modules/identity/index.js";
import { UserService, normalizeSsoProfile } from "../src/modules/identity/user.service.js";
import type { UserGroupRepository } from "../src/modules/identity/user-group.repository.js";
import type { UserRepository } from "../src/modules/identity/user.repository.js";
import {
  intersectProjectIds,
  parseGroupAccessAdminKeys,
  resolveGroupAccess,
  type GroupAccessRuleData,
} from "../src/modules/permission/group-access.rules.js";
import { GroupAccessService } from "../src/modules/permission/group-access.service.js";
import type { PermissionRepository } from "../src/modules/permission/permission.repository.js";
import { PermissionService } from "../src/modules/permission/permission.service.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_C = "33333333-3333-4333-8333-333333333333";

function rule(partial: Partial<GroupAccessRuleData> & { groupKey: string }): GroupAccessRuleData {
  return { allowedPages: ["projects"], projectScope: "none", projectIds: [], ...partial };
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
    expect(profile.projectIds).toBeNull();
  });

  it("管理员群组：绕过页面与项目限制", () => {
    const profile = resolveGroupAccess({
      enforced: true,
      admin: true,
      groupKeys: ["libiaorobot.com/系统管理员"],
      rules: [rule({ groupKey: "libiaorobot.com/系统管理员", projectScope: "none" })],
    });
    expect(profile.pages).toEqual([...GROUP_ACCESS_PAGE_KEYS]);
    expect(profile.projectIds).toBeNull();
  });

  it("多群组页面取并集；项目 selected 取并集；任意 all 取消项目收窄", () => {
    const selected = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2", "g3"],
      rules: [
        rule({ groupKey: "g1", allowedPages: ["projects"], projectScope: "selected", projectIds: [PROJECT_A] }),
        rule({ groupKey: "g2", allowedPages: ["workspace"], projectScope: "selected", projectIds: [PROJECT_A, PROJECT_B] }),
        rule({ groupKey: "g3", allowedPages: ["files"], projectScope: "none" }),
      ],
    });
    expect(selected.pages).toEqual(["projects", "workspace", "files"]);
    expect(selected.projectIds).toEqual([PROJECT_A, PROJECT_B]);

    const all = resolveGroupAccess({
      enforced: true,
      admin: false,
      groupKeys: ["g1", "g2"],
      rules: [
        rule({ groupKey: "g1", projectScope: "selected", projectIds: [PROJECT_A] }),
        rule({ groupKey: "g2", projectScope: "all" }),
      ],
    });
    expect(all.projectIds).toBeNull();
  });

  it("开启开关但群组无规则：默认拒绝", () => {
    const profile = resolveGroupAccess({ enforced: true, admin: false, groupKeys: ["g"], rules: [] });
    expect(profile.pages).toEqual([]);
    expect(profile.projectIds).toEqual([]);
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

describe("GroupAccessService 群组目录", () => {
  it("展示 Casdoor 目录全量群组，并合并成员计数、既有规则与观察到的额外群组", async () => {
    const repository = {
      listGroupMembershipCounts: async () => [
        { groupKey: "libiaorobot.com/QA", groupName: "Quality", memberCount: 2 },
        { groupKey: "libiaorobot.com/Extra", groupName: "Extra", memberCount: 1 },
      ],
      listAccessRules: async () => [rule({ groupKey: "libiaorobot.com/QA", allowedPages: ["files"] })],
      listAccessProjects: async () => [],
      findRuleMetadata: async () => ({ groupName: "Quality", updatedAt: new Date("2026-10-23T00:00:00Z") }),
    };
    const permission = {
      canManageGroupAccess: async () => true,
      groupAccessOf: async () => ({ enforced: false, admin: true, groupKeys: ["libiaorobot.com/QA"] }),
    };
    const departments = {
      listDepartments: async () => [
        { sourceId: "RD", name: "R&D" },
        { sourceId: "QA", name: "Quality" },
      ],
    };
    const service = new GroupAccessService(
      permission as never,
      repository as never,
      { recordStandalone: async () => undefined } as never,
      departments as never,
      new AppConfig({ CASDOOR_ORG_NAME: "libiaorobot.com" } as Env),
    );
    const overview = await service.overview(PROJECT_A);
    expect(overview.groups.map((group) => ({ key: group.groupKey, members: group.memberCount, pages: group.rule?.allowedPages ?? [] }))).toEqual([
      { key: "libiaorobot.com/Extra", members: 1, pages: [] },
      { key: "libiaorobot.com/QA", members: 2, pages: ["files"] },
      { key: "libiaorobot.com/RD", members: 0, pages: [] },
    ]);
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
  refs = new Map<string, { managerIds: string[]; deletedAt: Date | null }>();
  memberships = new Map<string, string>();

  async listUserGroupKeys(): Promise<string[]> {
    return [...this.groupKeys];
  }
  async listGroupAccessRules(): Promise<GroupAccessRuleData[]> {
    return [...this.rules];
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
  adminGroups?: string;
}): { service: PermissionService; repository: FakeGroupRepository } {
  const repository = new FakeGroupRepository();
  repository.groupKeys = options.groupKeys;
  repository.rules = options.rules;
  const authorization = {
    userId: PROJECT_A,
    roleCodes: ["admin"],
    dataScopes: ["all"],
    permissionKeys: [...PERMISSION_KEYS],
  } satisfies ActorAuthorization;
  const config = new AppConfig({
    GROUP_ACCESS_ENFORCED: "true",
    GROUP_ACCESS_ADMIN_GROUP_KEYS: options.adminGroups ?? "libiaorobot.com/系统管理员",
    PERMISSION_ENFORCED: "false",
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

  it("页面画像来自规则；管理员群组绕过并拿到全量页面", async () => {
    const { service } = serviceWith({
      groupKeys: ["libiaorobot.com/项目部"],
      rules: [rule({ groupKey: "libiaorobot.com/项目部", allowedPages: ["projects"] })],
    });
    expect(await service.canAccessPage(PROJECT_A, "projects")).toBe(true);
    expect(await service.canAccessPage(PROJECT_A, "workspace")).toBe(false);

    const admin = serviceWith({
      groupKeys: ["libiaorobot.com/系统管理员"],
      rules: [],
    });
    expect(await admin.service.canManageGroupAccess(PROJECT_A)).toBe(true);
    expect(await admin.service.canAccessPage(PROJECT_A, "audit")).toBe(true);
  });
});
