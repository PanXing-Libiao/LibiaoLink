import { Injectable } from "@nestjs/common";
import type {
  GroupAccessGroup,
  GroupAccessOverview,
  GroupAccessRule,
  GroupAccessRuleInput,
  GroupAccessRuleResponse,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { AuditService } from "../audit/index.js";
import { casdoorGroupKey, casdoorGroupName, DepartmentService } from "../identity/index.js";
import type { GroupAccessRuleData } from "./group-access.rules.js";
import { PermissionRepository } from "./permission.repository.js";
import { PermissionService } from "./permission.service.js";

/** 群组权限管理用例：读取群组目录 + 规则，保存 / 删除规则并写审计。 */
@Injectable()
export class GroupAccessService {
  constructor(
    private readonly permission: PermissionService,
    private readonly repository: PermissionRepository,
    private readonly audit: AuditService,
    private readonly departments: DepartmentService,
    private readonly config: AppConfig,
  ) {}

  async overview(actorId: string): Promise<GroupAccessOverview> {
    await this.assertAdmin(actorId);
    const [membershipCounts, directory, rules, projects, groupAccess] = await Promise.all([
      this.repository.listGroupMembershipCounts(),
      this.departments.listDepartments(),
      this.repository.listAccessRules(),
      this.repository.listAccessProjects(),
      this.permission.groupAccessOf(actorId),
    ]);
    const metadata = new Map(
      await Promise.all(
        rules.map(async (rule) => {
          const meta = await this.repository.findRuleMetadata(rule.groupKey);
          return [rule.groupKey, meta] as const;
        }),
      ),
    );
    const membershipByKey = new Map(membershipCounts.map((item) => [item.groupKey, item] as const));
    const groups = new Map<string, GroupAccessGroup>();
    for (const department of directory) {
      if (department.sourceId === null) continue;
      const groupKey = casdoorGroupKey(this.config.env.CASDOOR_ORG_NAME, department.sourceId);
      if (groupKey === "") continue;
      groups.set(groupKey, {
        groupKey,
        groupName: department.name,
        memberCount: membershipByKey.get(groupKey)?.memberCount ?? 0,
        rule: null,
      });
    }
    for (const item of membershipCounts) {
      if (groups.has(item.groupKey)) continue;
      groups.set(item.groupKey, {
        groupKey: item.groupKey,
        groupName: item.groupName,
        memberCount: item.memberCount,
        rule: null,
      });
    }
    for (const rule of rules) {
      const meta = metadata.get(rule.groupKey) ?? null;
      const current = groups.get(rule.groupKey);
      groups.set(rule.groupKey, {
        groupKey: rule.groupKey,
        groupName: meta?.groupName ?? current?.groupName ?? casdoorGroupName(rule.groupKey),
        memberCount: current?.memberCount ?? 0,
        rule: toRule(rule, meta?.groupName ?? current?.groupName ?? casdoorGroupName(rule.groupKey), meta?.updatedAt ?? new Date(0)),
      });
    }
    return {
      enforced: groupAccess.enforced,
      admin: groupAccess.admin,
      currentGroupKeys: groupAccess.groupKeys,
      groups: Array.from(groups.values()).sort((left, right) => left.groupKey.localeCompare(right.groupKey)),
      projects,
    };
  }

  async save(actorId: string, input: GroupAccessRuleInput): Promise<GroupAccessRuleResponse> {
    await this.assertAdmin(actorId);
    const before = await this.repository.findRuleMetadata(input.groupKey);
    const projectIds = input.projectScope === "selected" ? Array.from(new Set(input.projectIds)) : [];
    if (projectIds.length > 0) {
      const existing = await this.repository.listExistingProjectIds(projectIds);
      if (existing.length !== projectIds.length) {
        throw new AppError("VALIDATION_FAILED", "项目不存在或已进入回收站，请刷新后重新选择");
      }
    }
    const groupName = input.groupName ?? before?.groupName ?? casdoorGroupName(input.groupKey) ?? input.groupKey;
    const allowedPages = Array.from(new Set(input.allowedPages));
    const at = new Date();
    await this.repository.upsertGroupAccessRule(input.groupKey, groupName, allowedPages, input.projectScope, projectIds, at);
    await this.audit.recordStandalone({
      actorId,
      action: before === null ? "create" : "update",
      objectType: "group_access_rule",
      objectId: input.groupKey,
      summary: (before === null ? "新增" : "修改") + "群组访问规则：" + groupName + "（" + input.groupKey + "）",
      metadata: {
        groupKey: input.groupKey,
        allowedPages,
        projectScope: input.projectScope,
        projectIds,
      },
    });
    this.permission.invalidate();
    return {
      rule: {
        groupKey: input.groupKey,
        groupName,
        allowedPages,
        projectScope: input.projectScope,
        projectIds,
        updatedAt: at.toISOString(),
      },
    };
  }

  async remove(actorId: string, groupKey: string): Promise<void> {
    await this.assertAdmin(actorId);
    const before = await this.repository.findRuleMetadata(groupKey);
    if (before === null) throw new AppError("NOT_FOUND", "群组访问规则不存在");
    await this.repository.deleteGroupAccessRule(groupKey);
    await this.audit.recordStandalone({
      actorId,
      action: "delete",
      objectType: "group_access_rule",
      objectId: groupKey,
      summary: "删除群组访问规则：" + before.groupName + "（" + groupKey + "）",
      metadata: { groupKey },
    });
    this.permission.invalidate();
  }

  private async assertAdmin(actorId: string): Promise<void> {
    if (await this.permission.canManageGroupAccess(actorId)) return;
    throw new AppError("FORBIDDEN", "仅群组权限管理员可以管理页面与项目权限");
  }
}

function toRule(rule: GroupAccessRuleData, groupName: string, updatedAt: Date): GroupAccessRule {
  return {
    groupKey: rule.groupKey,
    groupName,
    allowedPages: rule.allowedPages,
    projectScope: rule.projectScope,
    projectIds: rule.projectIds,
    updatedAt: updatedAt.toISOString(),
  };
}
