import { Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PermissionKey } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { RequestWithUser } from "../identity/index.js";
import type { ProjectAccessContext } from "./permission.repository.js";
import { PermissionService } from "./permission.service.js";
import type { ProjectScopeFilter } from "./permission.rules.js";

/** 项目上下文来源：project = 路径 :id 即项目 id；node = 路径 :id 为节点 id（需解析到所属项目）。 */
export type ProjectAccessSource = "project" | "node";

export const PROJECT_ACCESS_SOURCE = "permission:access-source";
export const PROJECT_PERMISSION_KEY = "permission:required";
export const PROJECT_INCLUDE_DELETED_KEY = "permission:include-deleted";

export type RequestWithProjectAccess = RequestWithUser & {
  projectAccess?: ProjectAccessContext;
  projectScope?: ProjectScopeFilter;
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 标记控制器 / 路由的项目上下文来源（缺省 project）。 */
export const ProjectAccess = (source: ProjectAccessSource) => SetMetadata(PROJECT_ACCESS_SOURCE, source);

/** 项目回收站恢复 / 彻底删除专用：路径项目允许 deleted_at 非空，记录级与功能权限仍照常判定。 */
export const AllowDeletedProjectAccess = () => SetMetadata(PROJECT_INCLUDE_DELETED_KEY, true);

/** 标记路由所需的功能权限位（项目上下文由本守卫解析后作为 can 的项目级来源）。 */
export const RequirePermission = (key: PermissionKey) => SetMetadata(PROJECT_PERMISSION_KEY, key);

/** 参数装饰器：取守卫解析出的可见项目过滤（列表 / facets 用）。 */
export const ProjectScope = createParamDecorator((_data: unknown, context: ExecutionContext): ProjectScopeFilter => {
  const request = context.switchToHttp().getRequest<RequestWithProjectAccess>();
  if (request.projectScope === undefined) {
    throw new AppError("INTERNAL", "项目可见范围未就绪（当前路由未挂 ProjectAccessGuard）");
  }
  return request.projectScope;
});

/**
 * 项目访问守卫（h6 · 记录级 + 功能权限的统一入口）：
 * 1) 记录级：路径 :id（node 来源时先解析到项目）不可见 → 404 NOT_FOUND（防 IDOR，ADR-011 不变量 3）；
 * 2) 功能权限：路由标 @RequirePermission 时按 can 判定（项目内角色作为上下文一并传入），缺权限 → 403；
 * 3) 无项目路径参数的路由（列表 / facets / 创建）：把可见项目过滤挂到 request，供 @ProjectScope() 取用。
 * 用法：@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)，必须排在 SessionGuard 之后。
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permission: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithProjectAccess>();
    const actorId = request.actorId;
    if (actorId === undefined) throw new AppError("AUTH_REQUIRED", "未登录");
    const source =
      this.reflector.getAllAndOverride<ProjectAccessSource>(PROJECT_ACCESS_SOURCE, [context.getHandler(), context.getClass()]) ??
      "project";
    const required = this.reflector.getAllAndOverride<PermissionKey>(PROJECT_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const includeDeleted =
      this.reflector.getAllAndOverride<boolean>(PROJECT_INCLUDE_DELETED_KEY, [context.getHandler(), context.getClass()]) === true;
    const rawId = (request.params as Record<string, string | undefined> | undefined)?.["id"];
    const projectId = rawId !== undefined && UUID_PATTERN.test(rawId) ? await this.resolveProjectId(source, rawId) : null;
    if (projectId !== null) {
      const access = await this.permission.assertProjectVisible(actorId, projectId, { includeDeleted });
      request.projectAccess = access;
      if (required !== undefined) {
        await this.permission.assertCan(actorId, required, {
          member: access.member,
          projectManager: access.projectManager,
          groupAccessLevel: access.groupAccessLevel,
        });
      }
      return true;
    }
    if (required !== undefined) await this.permission.assertCan(actorId, required);
    request.projectScope = await this.permission.projectScope(actorId);
    return true;
  }

  private async resolveProjectId(source: ProjectAccessSource, rawId: string): Promise<string | null> {
    if (source === "node") return this.permission.projectIdOfNode(rawId);
    return rawId;
  }
}
