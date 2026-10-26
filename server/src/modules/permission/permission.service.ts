import { Injectable } from "@nestjs/common";
import {
  GROUP_ACCESS_UNGROUPED_KEY,
  type ActorPermissions,
  type AuditScope,
  type GroupAccessPage,
  type GroupProjectAccess,
  type PermissionKey,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { RoleService, type ActorAuthorization } from "../identity/index.js";
import {
  intersectProjectIds,
  isGroupAccessAdmin,
  parseGroupAccessAdminKeys,
  resolveGroupAccess,
  ruleAppliesToMember,
  type GroupAccessProfile,
} from "./group-access.rules.js";
import { PermissionRepository, type ProjectAccessContext } from "./permission.repository.js";
import {
  can,
  isGroupReadOnlyDeniedKey,
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
@Injectable()
export class PermissionService {
  private static readonly CACHE_TTL_MS = 10_000;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly roles: RoleService,
    private readonly repository: PermissionRepository,
    private readonly config?: AppConfig,
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
      permissionKeys: authorization.permissionKeys as PermissionKey[],
      groupKeys: groupAccess.groupKeys,
      pageKeys: groupAccess.pages,
      groupAccessEnforced: groupAccess.enforced,
      groupAccessAdmin: groupAccess.admin,
      groupReadOnly: groupAccess.readOnly,
      groupProjectAccess: await this.groupProjectAccessOf(groupAccess, projectScope),
      groupProjectScopes: [...groupAccess.projectScopes],
      groupAccessLevel: groupAccess.readOnly ? "view" : "edit",
      auditScope,
    };
  }

  /** 群组访问画像（与角色画像同一 10s 缓存）：管理员、页面 + 项目白名单 + 只读标志。 */
  async groupAccessOf(actorId: string): Promise<GroupAccessProfile> {
    const authorization = await this.getAuthorization(actorId);
    const entry = this.cache.get(actorId);
    if (entry !== undefined && entry.groupAccess !== undefined) return entry.groupAccess;
    const [memberGroupKeys, manualAdmin] = this.config === undefined
      ? [[] as string[], false] as const
      : await Promise.all([
          this.repository.listUserGroupKeys(actorId),
          this.repository.isManualGroupAccessAdmin(actorId),
        ]);
    const groupKeys = memberGroupKeys.length === 0 ? [GROUP_ACCESS_UNGROUPED_KEY] : memberGroupKeys;
    const enforced = this.config?.env.GROUP_ACCESS_ENFORCED === "true";
    const permissionEnforced = this.config?.env.PERMISSION_ENFORCED === "true";
    const permissionAdmin = authorization.permissionKeys.includes("access.manage");
    const adminUserIds = parseGroupAccessAdminKeys(this.config?.env.GROUP_ACCESS_ADMIN_USER_IDS ?? "");
    const admin =
      manualAdmin ||
      adminUserIds.includes(actorId) ||
      isGroupAccessAdmin(groupKeys, parseGroupAccessAdminKeys(this.config?.env.GROUP_ACCESS_ADMIN_GROUP_KEYS ?? "")) ||
      (permissionAdmin && permissionEnforced);
    const rules = enforced && !admin
      ? (await this.repository.listGroupAccessRules(groupKeys)).filter((rule) => ruleAppliesToMember(rule, actorId))
      : [];
    const profile = resolveGroupAccess({ enforced, admin, groupKeys, rules });
    if (entry !== undefined) entry.groupAccess = profile;
    return profile;
  }

  /** 权限管理页入口：显式部门管理员恒可进入；角色 access.manage 仅在 PERMISSION_ENFORCED=true 时计入。 */
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
    return !(groupAccess.readOnly && isGroupReadOnlyDeniedKey(key));
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

  /** 任务模板 / 节点库维护：系统管理员，或已开启部门限制且命中任一编辑规则的账号。 */
  async canManageBlueprint(actorId: string): Promise<boolean> {
    const groupAccess = await this.groupAccessOf(actorId);
    return groupAccess.admin || (groupAccess.enforced && !groupAccess.readOnly);
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

  /** 业务写入口兜底：部门规则开启且非管理员一律拒绝；用于未挂功能权限键的写接口。 */
  async assertWritable(actorId: string, message?: string): Promise<void> {
    if (!(await this.groupAccessOf(actorId)).readOnly) return;
    throw new AppError("FORBIDDEN", message ?? "当前部门为只读，不能新增、修改或删除业务数据");
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
    const groupVisible =
      groupAccess.projectIds === null ||
      groupAccess.projectIds.includes(projectId) ||
      (groupAccess.ownProjects && ownProject);
    if (!visible || !groupVisible) return null;
    return { projectId, member: rosterMember || managerOfRecord, projectManager };
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

/** 仅 none 范围（或没有规则）= 仅登录；至少一个 all / own / selected 才拥有业务数据读取范围。 */
function hasProjectDataScope(groupAccess: GroupAccessProfile): boolean {
  return groupAccess.projectScopes.some((scope) => scope !== "none");
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}
