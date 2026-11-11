import { describe, expect, it } from "vitest";
import type { ProjectManagerCandidate } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { DepartmentRow } from "../src/modules/identity/department.repository.js";
import type { DepartmentService } from "../src/modules/identity/index.js";
import type { GroupAccessService } from "../src/modules/permission/group-access.service.js";
import type { PermissionRepository } from "../src/modules/permission/permission.repository.js";
import {
  parseProjectManagerDepartmentNames,
  ProjectManagerEligibilityService,
} from "../src/modules/permission/project-manager-eligibility.service.js";

const AT = new Date("2026-11-10T00:00:00.000Z");

type CandidateUser = {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
};

function department(id: string, name: string, sourceId: string, parentId: string | null = null): DepartmentRow {
  return { id, name, sourceId, parentId, status: "active", createdAt: AT, updatedAt: AT };
}

class FakePermissionRepository {
  constructor(
    private readonly memberships: ReadonlyMap<string, readonly CandidateUser[]>,
    private readonly activeUsers: readonly CandidateUser[],
  ) {}

  async listGroupAdminUsersByGroupKeys(groupKeys: readonly string[]): Promise<CandidateUser[]> {
    return groupKeys.flatMap((groupKey) => [...(this.memberships.get(groupKey) ?? [])]);
  }

  async listActiveUsersByIds(userIds: readonly string[]): Promise<CandidateUser[]> {
    const ids = new Set(userIds);
    return this.activeUsers.filter((user) => ids.has(user.userId));
  }
}

function makeService(options: {
  admins?: readonly CandidateUser[];
  departmentNames?: string;
} = {}): ProjectManagerEligibilityService {
  const users: CandidateUser[] = [
    { userId: "formal", username: "formal", displayName: "Formal PM", email: null, status: "active" },
    { userId: "cn", username: "cn", displayName: "中文项目经理", email: null, status: "active" },
    { userId: "child", username: "child", displayName: "子部门成员", email: null, status: "active" },
    { userId: "admin", username: "admin", displayName: "系统管理员", email: null, status: "active" },
    { userId: "sales", username: "sales", displayName: "销售同事", email: null, status: "active" },
    { userId: "disabled", username: "disabled", displayName: "停用同事", email: null, status: "disabled" },
  ];
  const departments = [
    department("d-formal", "Project Dept", "ProjectDept"),
    department("d-cn", "项目部", "项目部"),
    department("d-child", "Delivery", "Delivery", "d-cn"),
    department("d-sales", "Sales", "Sales"),
  ];
  const memberships = new Map<string, readonly CandidateUser[]>([
    ["libiaorobot.com/ProjectDept", [users[0]!]],
    ["libiaorobot.com/项目部", [users[1]!]],
    ["libiaorobot.com/Delivery", [users[2]!]],
    ["libiaorobot.com/Sales", [users[4]!]],
  ]);
  const repository = new FakePermissionRepository(memberships, users);
  const departmentService = {
    async listDepartments(): Promise<DepartmentRow[]> {
      return departments;
    },
  };
  const groupAccess = {
    async listAdmins(): Promise<readonly CandidateUser[]> {
      return options.admins ?? [users[3]!];
    },
  };
  const config = new AppConfig({
    CASDOOR_ORG_NAME: "libiaorobot.com",
    PROJECT_MANAGER_DEPARTMENT_NAMES: options.departmentNames ?? "Project Dept,项目部",
  } as Env);
  return new ProjectManagerEligibilityService(
    repository as unknown as PermissionRepository,
    departmentService as unknown as DepartmentService,
    groupAccess as unknown as GroupAccessService,
    config,
  );
}

describe("项目经理资格", () => {
  it("默认同时识别正式机 Project Dept 与测试机项目部；空配置回落默认值", () => {
    expect(parseProjectManagerDepartmentNames("")).toEqual(["Project Dept", "项目部"]);
    expect(parseProjectManagerDepartmentNames(" Project Dept ，项目部; project dept\n")).toEqual([
      "Project Dept",
      "项目部",
    ]);
  });

  it("候选 = 两个默认项目部门及其子部门有效成员 ∪ 有效系统管理员", async () => {
    const candidateList = await makeService().listCandidates();
    const byId = new Map<string, ProjectManagerCandidate>(candidateList.items.map((item) => [item.id, item]));

    expect([...byId.keys()].sort()).toEqual(["admin", "child", "cn", "formal"]);
    expect(byId.get("formal")?.inProjectDepartment).toBe(true);
    expect(byId.get("cn")?.inProjectDepartment).toBe(true);
    expect(byId.get("child")?.inProjectDepartment).toBe(true);
    expect(byId.get("admin")?.isSystemAdmin).toBe(true);
    expect(byId.has("sales")).toBe(false);
    expect(byId.has("disabled")).toBe(false);
  });

  it("停用的系统管理员不能进入候选", async () => {
    const disabledAdmin: CandidateUser = { userId: "old-admin", username: "old", displayName: "停用管理员", email: null, status: "disabled" };
    const candidateList = await makeService({ admins: [disabledAdmin] }).listCandidates();
    expect(candidateList.items.map((item) => item.id)).not.toContain("old-admin");
  });

  it("新增指派拒绝非候选；历史经理可保留；停用人员不能重新加入", async () => {
    const service = makeService();
    const eligibleIds = await service.eligibleUserIds();

    await expect(service.assertAssignable(["sales"], { eligibleIds })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
    await expect(service.assertAssignable(["disabled"], { eligibleIds })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
    await expect(service.assertAssignable(["sales"], { eligibleIds, existingUserIds: ["sales"] })).resolves.toBeUndefined();
  });
});
