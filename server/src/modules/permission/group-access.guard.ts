import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { GroupAccessPage } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { RequestWithUser } from "../identity/index.js";
import { PermissionService } from "./permission.service.js";

export const GROUP_ACCESS_PAGE_KEY = "permission:group-access-page";

/** 标记专用页面接口（仪表盘 / 工作台 / 操作记录）需要当前账号拥有哪个群组页面。 */
export const RequireAccessPage = (page: GroupAccessPage) => SetMetadata(GROUP_ACCESS_PAGE_KEY, page);

@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permission: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const page = this.reflector.getAllAndOverride<GroupAccessPage>(GROUP_ACCESS_PAGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (page === undefined) return true;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.actorId === undefined) throw new AppError("AUTH_REQUIRED", "未登录");
    await this.permission.assertPageAccess(request.actorId, page);
    return true;
  }
}

@Injectable()
export class GroupAccessAdminGuard implements CanActivate {
  constructor(private readonly permission: PermissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.actorId === undefined) throw new AppError("AUTH_REQUIRED", "未登录");
    if (await this.permission.canManageGroupAccess(request.actorId)) return true;
    throw new AppError("FORBIDDEN", "仅群组权限管理员可以管理页面与项目权限");
  }
}
