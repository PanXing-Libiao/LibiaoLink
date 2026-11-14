import { Injectable } from "@nestjs/common";
import type { ProjectManagerCandidate, ProjectManagerCandidateList } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { casdoorGroupKey, DepartmentService } from "../identity/index.js";
import { GroupAccessService } from "./group-access.service.js";
import { PermissionRepository } from "./permission.repository.js";

/** 默认项目部名称：正式机为英文名，测试机为中文名；同一套代码同时识别。 */
const DEFAULT_PROJECT_MANAGER_DEPARTMENT_NAMES = ["Project Dept", "项目部"] as const;
const DEPARTMENT_NAME_SEPARATORS = /[,，;；\n]+/u;

/** 解析可担任项目经理的部门名称：去空白、去重、忽略大小写；空配置回落到默认中英文名称。 */
export function parseProjectManagerDepartmentNames(raw: string): string[] {
  const names = raw
    .split(DEPARTMENT_NAME_SEPARATORS)
    .map((name) => name.trim().replace(/\s+/gu, " "))
    .filter((name) => name !== "");
  const effective = names.length === 0 ? [...DEFAULT_PROJECT_MANAGER_DEPARTMENT_NAMES] : names;
  const seen = new Set<string>();
  return effective.filter((name) => {
    const key = normalizeDepartmentName(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface CandidateSnapshot {
  candidates: ProjectManagerCandidate[];
  eligibleUserIds: Set<string>;
}

/**
 * 项目经理资格：有效项目部成员 ∪ 有效系统管理员。
 *
 * 规则同时覆盖 projects.manager_ids 与名册 role_in_project=project_manager 两条身份来源：
 * - 新建项目只能选择资格名单内人员；
 * - 编辑项目保留历史项目经理，但新加入的人必须符合资格；
 * - 名册新增 / 升级为项目经理同样校验；
 * - Excel 导入保留源表命中的项目经理账号，不受本资格规则约束；未命中仍回落导入人并提醒。
 */
@Injectable()
export class ProjectManagerEligibilityService {
  constructor(
    private readonly repository: PermissionRepository,
    private readonly departments: DepartmentService,
    private readonly groupAccess: GroupAccessService,
    private readonly config: AppConfig,
  ) {}

  /** 项目经理候选：仅启用、未离职账号；按姓名稳定排序。 */
  async listCandidates(): Promise<ProjectManagerCandidateList> {
    const snapshot = await this.snapshot();
    return { items: snapshot.candidates, total: snapshot.candidates.length };
  }

  /** 当前资格人员 id 集合；写路径可复用一次查询结果。 */
  async eligibleUserIds(): Promise<Set<string>> {
    return (await this.snapshot()).eligibleUserIds;
  }

  /**
   * 校验项目经理 id。existingUserIds = 项目当前已有经理（含名册经理）：
   * 历史不符合新规则的人可以继续保留 / 移除，但不能在移除后重新加入。
   */
  async assertAssignable(
    managerIds: readonly string[],
    options: { existingUserIds?: readonly string[]; eligibleIds?: ReadonlySet<string> } = {},
  ): Promise<void> {
    const eligibleIds = options.eligibleIds ?? (await this.eligibleUserIds());
    const preserved = new Set(options.existingUserIds ?? []);
    const invalidIds = uniqueStrings(managerIds).filter(
      (userId) => !eligibleIds.has(userId) && !preserved.has(userId),
    );
    if (invalidIds.length === 0) return;

    const users = await this.repository.listActiveUsersByIds(invalidIds);
    const usersById = new Map(users.map((user) => [user.userId, user]));
    const labels = invalidIds.map((userId) => {
      const user = usersById.get(userId);
      return user === undefined ? userId : user.displayName + "（" + user.username + "）";
    });
    throw new AppError(
      "VALIDATION_FAILED",
      "项目经理只能选择有效（启用且未离职）的项目部成员或系统管理员；不符合条件：" + labels.join("、"),
      [
        {
          code: "PROJECT_MANAGER_INELIGIBLE",
          message: "项目经理只能选择有效项目部成员或系统管理员",
          path: "managerIds",
          meta: { userIds: invalidIds },
        },
      ],
    );
  }

  private async snapshot(): Promise<CandidateSnapshot> {
    const groupKeys = await this.projectDepartmentGroupKeys();
    const [departmentUsers, admins] = await Promise.all([
      this.repository.listGroupAdminUsersByGroupKeys(groupKeys),
      this.groupAccess.listAdmins(),
    ]);
    const departmentUserIds = new Set(departmentUsers.map((user) => user.userId));
    const adminUserIds = new Set(
      admins.filter((admin) => admin.status === "active").map((admin) => admin.userId),
    );
    const activeUsers = await this.repository.listActiveUsersByIds(
      uniqueStrings([...departmentUserIds, ...adminUserIds]),
    );
    const candidates = activeUsers.map((user): ProjectManagerCandidate => ({
      id: user.userId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      status: user.status,
      inProjectDepartment: departmentUserIds.has(user.userId),
      isSystemAdmin: adminUserIds.has(user.userId),
    }));
    return {
      candidates,
      eligibleUserIds: new Set(candidates.map((candidate) => candidate.id)),
    };
  }

  /**
   * 匹配配置部门及其全部子部门，再转换为 Casdoor group_key。
   * 部门名称只用于定位配置中的组织节点；权限判定仍使用稳定 group_key。
   */
  private async projectDepartmentGroupKeys(): Promise<string[]> {
    const configuredNames = new Set(
      parseProjectManagerDepartmentNames(this.config.env.PROJECT_MANAGER_DEPARTMENT_NAMES).map(normalizeDepartmentName),
    );
    if (configuredNames.size === 0) return [];

    const directory = await this.departments.listDepartments();
    const selectedIds = new Set(
      directory
        .filter((department) => configuredNames.has(normalizeDepartmentName(department.name)))
        .map((department) => department.id),
    );
    if (selectedIds.size === 0) return [];

    let changed = true;
    while (changed) {
      changed = false;
      for (const department of directory) {
        if (
          department.parentId !== null &&
          selectedIds.has(department.parentId) &&
          !selectedIds.has(department.id)
        ) {
          selectedIds.add(department.id);
          changed = true;
        }
      }
    }

    return uniqueStrings(
      directory
        .filter((department) => selectedIds.has(department.id) && department.sourceId !== null)
        .map((department) => casdoorGroupKey(this.config.env.CASDOOR_ORG_NAME, department.sourceId ?? ""))
        .filter((groupKey) => groupKey !== ""),
    );
  }
}

function normalizeDepartmentName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
