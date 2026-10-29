import { Injectable, Optional } from "@nestjs/common";
import {
  GROUP_ACCESS_UNGROUPED_KEY,
  type ActorPermissions,
  type AuditScope,
  type GroupAccessAccessLevel,
  type GroupAccessPage,
  type GroupProjectAccess,
  type PermissionKey,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { casdoorGroupKey, DepartmentService, RoleService, type ActorAuthorization } from "../identity/index.js";
import {
  intersectProjectIds,
  isGroupAccessAdmin,
  parseGroupAccessAdminKeys,
  effectiveGroupAccessRules,
  projectGroupAccessLevelOf,
  resolveGroupAccess,
  type GroupAccessProfile,
} from "./group-access.rules.js";
import { PermissionRepository, type ProjectAccessContext } from "./permission.repository.js";
import {
  can,
  isProjectVisible,
  projectScopeSpec,
  type ProjectResourceContext,
  type ProjectScopeFilter,
} from "./permission.rules.js";

/** 操作记录服务端可见范围：管理员全量；项目经理附有效管理项目；其余仅本人。 */
export interface AuditAccess {
  scope: AuditScope;
  managedProjectIds: string[];
}

/** 缓存条目：ADR-011「策略全量加载内存 + 版本号失效」的一期形态 —— 短 TTL + 显式 invalidate。 */
interface CacheEntry {
  at: number;
  authorization: ActorAuthorization;
  groupAccess?: GroupAccessProfile;
}

/**
 * 权限策略服务（h6 · ADR-011 落地形态）：can / 记录级可见集 / 项目上下文解析的**唯一出口**，
 * 供 Manager Guard（HTTP 入口）、project 模块（列表裁剪）与后续导出 / 搜索 / 通知复用。
 * 判定只在服务端执行（ADR-011 不变量 1）；不可见资源统一 404、无功能权限 403。
 */
/** 项目内业务写操作：必须命中该项目的 edit 权限。 */
const PROJECT_GROUP_WRITE_KEYS: readonly PermissionKey[] = [
  "project.update",
  "project.delete",
  "project.archive",
  "member.manage",
  "task.create",
  "task.update",
  "task.progress",
  "report.fill",
  "issue.manage",
  "node.create",
  "node.delete",
  "node.complete",
  "node.advance",
  "node.rollback",
  "file.upload",
  "stakeholder.manage",
];

/**
 * M5-06 管理面四键：规则管理、运行记录、发送记录与重发仅系统管理员可用。
 * 必须先于部门限制开关 / 项目编辑范围裁决；否则全量能力基线会让普通登录账号通过读权限，
 * 全部项目编辑账号也会获得规则管理或重发能力。
 */
export const GROUP_ACCESS_ADMIN_ONLY_KEYS: readonly PermissionKey[] = [
  "automation.view",
  "automation.manage",
  "notify.record.view",
  "notify.resend",
];

/** 无项目上下文的全局业务写操作：仅全部项目编辑或系统管理员可写。 */
const GLOBAL_GROUP_WRITE_KEYS: readonly PermissionKey[] = [
  "dict.manage",
  "calendar.manage",
];

@Injectable()
export class PermissionService {
  private static readonly CACHE_TTL_MS = 10_000;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly roles: RoleService,
    private readonly repository: PermissionRepository,
    private readonly config?: AppConfig,
    @Optional() private readonly departments?: DepartmentService,
  ) {}

  /** 授权画像（带缓存）：同一请求内多处判定只查一次库。 */
  async getAuthorization(actorId: string): Promise<ActorAuthorization> {
    const now = Date.now();
    const cached = this.cache.get(actorId);
    if (cached !== undefined && now - cached.at < PermissionService.CACHE_TTL_MS) {
      return cached.authorization;
    }
    const authorization = await this.roles.getActorAuthorization(actorId);
    this.cache.set(actorId, { at: now, authorization });
    return authorization;
  }

  /** 显式失效（角色 / 授权变更后调用；管理端点在 u12 · C3-09）。 */
  invalidate(actorId?: string): void {
    if (actorId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(actorId);
  }

  /** GET /api/v1/permissions/me 的响应投影。 */
  async permissionsOf(actorId: string): Promise<ActorPermissions> {
    const authorization = await this.getAuthorization(actorId);
    const groupAccess = await this.groupAccessOf(actorId);
    const projectScope = await this.projectScope(actorId);
    const auditScope = groupAccess.admin
      ? "all" as const
      : (await this.auditAccessWithin(actorId, projectScope)).scope;
    return {
      userId: authorization.userId,
      roleCodes: authorization.roleCodes,
      dataScopes: authorization.dataScopes,
      permissionKeys: effectivePermissionKeys(authorization, groupAccess.admin),
      groupKeys: groupAccess.groupKeys,
      pageKeys: groupAccess.pages,
      groupAccessEnforced: groupAccess.enforced,
      groupAccessAdmin: groupAccess.admin,
      groupReadOnly: groupAccess.readOnly,
      groupProjectAccess: await this.groupProjectAccessOf(groupAccess, projectScope),
      groupProjectScopes: [...groupAccess.projectScopes],
      groupAccessLevel: groupAccess.anyEdit ? "edit" : "view",
      groupScopePermissions: groupAccess.scopePermissions,
      groupAnyEdit: groupAccess.anyEdit,
      groupAllEdit: groupAccess.allEdit,
      groupOwnEdit: groupAccess.ownEdit,
      groupSelectedEdit: groupAccess.selectedEdit,
      auditScope,
    };
  }

  /** 部门访问画像（与能力基线同一 10s 缓存）：管理员、页面 + 项目白名单 + 多范围编辑能力与兼容只读摘要。 */
  async groupAccessOf(actorId: string): Promise<GroupAccessProfile> {
    await this.getAuthorization(actorId);
    const entry = this.cache.get(actorId);
    if (entry !== undefined && entry.groupAccess !== undefined) return entry.groupAccess;
    const [memberGroupKeys, manualAdmin] = this.config === undefined
      ? [[] as string[], false] as const
      : await Promise.all([
          this.activeGroupKeys(actorId),
          this.repository.isManualGroupAccessAdmin(actorId),
        ]);
    const groupKeys = memberGroupKeys.length === 0 ? [GROUP_ACCESS_UNGROUPED_KEY] : memberGroupKeys;
    const enforced = this.config?.env.GROUP_ACCESS_ENFORCED === "true";
    const adminUserIds = parseGroupAccessAdminKeys(this.config?.env.GROUP_ACCESS_ADMIN_USER_IDS ?? "");
    const admin =
      manualAdmin ||
      adminUserIds.includes(actorId) ||
      isGroupAccessAdmin(groupKeys, parseGroupAccessAdminKeys(this.config?.env.GROUP_ACCESS_ADMIN_GROUP_KEYS ?? ""));
    const rules = enforced && !admin
      ? await (async () => {
          const [groupRules, memberRules] = await Promise.all([
            this.repository.listGroupAccessRules(groupKeys),
            this.repository.listMemberAccessRulesForUser(groupKeys, actorId),
          ]);
          return effectiveGroupAccessRules(groupKeys, groupRules, memberRules, actorId);
        })()
      : [];
    const profile = resolveGroupAccess({ enforced, admin, groupKeys, rules });
    if (entry !== undefined) entry.groupAccess = profile;
    return profile;
  }

  /** 只认当前在编部门；登录令牌或历史成员关系里的虚拟应用访问组不进入权限裁定。 */
  private async activeGroupKeys(actorId: string): Promise<string[]> {
    const groupKeys = await this.repository.listUserGroupKeys(actorId);
    if (this.config === undefined || this.departments === undefined || groupKeys.length === 0) return groupKeys;
    const directory = await this.departments.listDepartments();
    const activeKeys = new Set(
      directory
        .filter((department) => department.sourceId !== null)
        .map((department) => casdoorGroupKey(this.config?.env.CASDOOR_ORG_NAME ?? "", department.sourceId ?? ""))
        .filter((groupKey) => groupKey !== ""),
    );
    return groupKeys.filter((groupKey) => activeKeys.has(groupKey));
  }

  /** 权限管理页入口：仅环境配置、管理员部门或权限页手工授权账号可进入。 */
  async canManageGroupAccess(actorId: string): Promise<boolean> {
    return (await this.groupAccessOf(actorId)).admin;
  }

  async canAccessPage(actorId: string, page: GroupAccessPage): Promise<boolean> {
    return (await this.groupAccessOf(actorId)).pages.includes(page);
  }

  async assertPageAccess(actorId: string, page: GroupAccessPage): Promise<void> {
    if (await this.canAccessPage(actorId, page)) return;
    throw new AppError("FORBIDDEN", "当前部门无权访问该页面：" + page);
  }

  async can(actorId: string, key: PermissionKey, context?: ProjectResourceContext): Promise<boolean> {
    if (!can(await this.getAuthorization(actorId), key, context)) return false;
    const groupAccess = await this.groupAccessOf(actorId);
    if (GROUP_ACCESS_ADMIN_ONLY_KEYS.includes(key)) return groupAccess.admin;
    if (!groupAccess.enforced || groupAccess.admin) return true;
    if (PROJECT_GROUP_WRITE_KEYS.includes(key)) {
      return context?.groupAccessLevel === "edit";
    }
    if (GLOBAL_GROUP_WRITE_KEYS.includes(key)) return groupAccess.allEdit;
    if (key === "blueprint.manage") return groupAccess.anyEdit;
    if (key === "project.create") return groupAccess.allEdit || groupAccess.ownEdit;
    return true;
  }

  /** 403：资源可见但缺少功能权限位（不可见资源的 404 由 assertProjectVisible 负责）。 */
  async assertCan(
    actorId: string,
    key: PermissionKey,
    context?: ProjectResourceContext,
    message?: string,
  ): Promise<void> {
    if (await this.can(actorId, key, context)) return;
    throw new AppError("FORBIDDEN", message ?? "无权限：" + key);
  }

  /** 任务模板 / 节点库维护：系统管理员，或已开启部门限制且任一范围拥有编辑权限的账号。 */
  async canManageBlueprint(actorId: string): Promise<boolean> {
    const groupAccess = await this.groupAccessOf(actorId);
    return groupAccess.admin || (groupAccess.enforced && groupAccess.anyEdit);
  }

  async assertCanManageBlueprint(actorId: string, message?: string): Promise<void> {
    if (await this.canManageBlueprint(actorId)) return;
    throw new AppError("FORBIDDEN", message ?? "维护任务模板需要编辑权限");
  }

  /** 任务节点 / 模板读取：管理员、限制关闭或有项目数据范围的账号可读；仅登录 / none 范围拒绝。 */
  async canReadBlueprint(actorId: string): Promise<boolean> {
    const groupAccess = await this.groupAccessOf(actorId);
    if (!groupAccess.enforced || groupAccess.admin) return true;
    return hasProjectDataScope(groupAccess);
  }

  async assertCanReadBlueprint(actorId: string, message?: string): Promise<void> {
    if (await this.canReadBlueprint(actorId)) return;
    throw new AppError("FORBIDDEN", message ?? "当前账号仅可登录，不能查看任务节点与模板");
  }

  /** 全局写入口兜底（无项目上下文）：部门规则开启时仅全部项目编辑 / 管理员可写。 */
  async assertWritable(actorId: string, message?: string): Promise<void> {
    const groupAccess = await this.groupAccessOf(actorId);
    if (!groupAccess.enforced || groupAccess.admin || groupAccess.allEdit) return;
    throw new AppError("FORBIDDEN", message ?? "该操作需要全部项目编辑权限");
  }

  /** 批量裁决项目级部门权限；用于项目列表 / 工作台项目卡随行下发，避免逐项目查库。 */
  async projectGroupAccessLevelsOf(
    actorId: string,
    projectIds: readonly string[],
  ): Promise<Map<string, GroupAccessAccessLevel>> {
    const levels = new Map<string, GroupAccessAccessLevel>();
    const groupAccess = await this.groupAccessOf(actorId);
    let ownProjectIds = new Set<string>();
    if (groupAccess.enforced && !groupAccess.admin && groupAccess.ownProjects) {
      ownProjectIds = new Set(
        await this.repository.listVisibleProjectIds(actorId, { all: false, managed: false, member: true }),
      );
    }
    for (const projectId of projectIds) {
      levels.set(
        projectId,
        projectGroupAccessLevelOf(groupAccess, projectId, ownProjectIds.has(projectId)) ?? "view",
      );
    }
    return levels;
  }

  /** 可见项目过滤（列表 / facets 用）：all = 不裁剪；ids 空集 = 无可见项目。 */
  async projectScope(actorId: string): Promise<ProjectScopeFilter> {
    const groupAccess = await this.groupAccessOf(actorId);
    if (groupAccess.admin) return { kind: "all" };
    const spec = projectScopeSpec(await this.getAuthorization(actorId));
    const roleIds = spec.all ? null : await this.repository.listVisibleProjectIds(actorId, spec);
    const groupIds = groupAccess.projectIds === null || !groupAccess.ownProjects
      ? groupAccess.projectIds
      : uniqueIds([
          ...groupAccess.projectIds,
          ...(await this.repository.listVisibleProjectIds(actorId, { all: false, managed: false, member: true })),
        ]);
    const ids = intersectProjectIds(roleIds, groupIds);
    return ids === null ? { kind: "all" } : { kind: "ids", ids };
  }

  /** 解析项目上下文：不可见 / 不存在返回 null（调用方转 404）；回收站写口可选包含已软删项目。 */
  async resolveProjectAccess(
    actorId: string,
    projectId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ProjectAccessContext | null> {
    const spec = projectScopeSpec(await this.getAuthorization(actorId));
    const groupAccess = await this.groupAccessOf(actorId);
    const ref = await this.repository.findProjectRef(projectId);
    if (ref === null || (ref.deletedAt !== null && options.includeDeleted !== true)) return null;
    const membershipRole = await this.repository.findMembership(actorId, projectId);
    const rosterMember = membershipRole !== null;
    const managerOfRecord = ref.managerIds.includes(actorId);
    const projectManager = managerOfRecord || membershipRole === "project_manager";
    const visible = groupAccess.admin || isProjectVisible(spec, {
      rosterMember,
      managerOfRecord,
      rosterProjectManager: membershipRole === "project_manager",
    });
    const ownProject = managerOfRecord || rosterMember;
    const groupAccessLevel = projectGroupAccessLevelOf(groupAccess, projectId, ownProject);
    if (!visible || groupAccessLevel === null) return null;
    return {
      projectId,
      member: rosterMember || managerOfRecord,
      projectManager,
      groupAccessLevel,
    };
  }

  /** 记录级门禁：不可见 → 404（防 IDOR，ADR-011 不变量 3）；includeDeleted 仅供项目回收站恢复 / 彻底删除。 */
  async assertProjectVisible(
    actorId: string,
    projectId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ProjectAccessContext> {
    const access = await this.resolveProjectAccess(actorId, projectId, options);
    if (access === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    return access;
  }

  /** 节点 → 项目（/api/v1/nodes/* 的可见性判定用）。 */
  projectIdOfNode(nodeId: string): Promise<string | null> {
    return this.repository.findNodeProjectId(nodeId);
  }

  /** 操作记录可见范围：管理员全量；项目经理含有效管理项目，否则仅本人。 */
  async auditAccessOf(actorId: string): Promise<AuditAccess> {
    const groupAccess = await this.groupAccessOf(actorId);
    if (groupAccess.admin) return { scope: "all", managedProjectIds: [] };
    return this.auditAccessWithin(actorId, await this.projectScope(actorId));
  }

  private async auditAccessWithin(actorId: string, projectScope: ProjectScopeFilter): Promise<AuditAccess> {
    const managerIds = uniqueIds([
      ...(await this.repository.listOwnedProjectIds(actorId)),
      ...(await this.repository.listManagedRosterProjectIds(actorId)),
    ]);
    const scopedManagerIds = projectScope.kind === "all"
      ? managerIds
      : managerIds.filter((projectId) => projectScope.ids.includes(projectId));
    const managedProjectIds = await this.repository.listActiveProjectIds(scopedManagerIds);
    return managedProjectIds.length > 0
      ? { scope: "project_manager", managedProjectIds }
      : { scope: "self", managedProjectIds: [] };
  }

  private async groupProjectAccessOf(
    groupAccess: GroupAccessProfile,
    projectScope: ProjectScopeFilter,
  ): Promise<GroupProjectAccess> {
    if (!groupAccess.enforced || groupAccess.admin) return "allowed";
    if (!hasProjectDataScope(groupAccess)) return "denied";
    const hasActiveProject = projectScope.kind === "all"
      ? await this.repository.hasActiveProject()
      : (await this.repository.listActiveProjectIds(projectScope.ids)).length > 0;
    return hasActiveProject ? "allowed" : "empty";
  }
}

/** 没有任何数据范围（或只有 none 规则）= 仅登录；至少一个 all / own / selected 才有业务数据读取范围。 */
function hasProjectDataScope(groupAccess: GroupAccessProfile): boolean {
  return groupAccess.scopePermissions.length > 0;
}

/** /permissions/me 只下发当前账号实际可用的功能权限键；管理员保留全量契约键。 */
function effectivePermissionKeys(authorization: ActorAuthorization, admin: boolean): PermissionKey[] {
  const keys = authorization.permissionKeys as PermissionKey[];
  return admin ? keys : keys.filter((key) => !GROUP_ACCESS_ADMIN_ONLY_KEYS.includes(key));
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}
