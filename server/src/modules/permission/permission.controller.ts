import { Controller, Get, UseGuards } from "@nestjs/common";
import { PermissionMeResponseSchema, z } from "@libiaolink/contracts";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { PermissionService } from "./permission.service.js";

type PermissionMeResponse = z.infer<typeof PermissionMeResponseSchema>;

/** 权限画像（h6 · PoC-6）：前端据此置灰按钮 / 隐藏入口；字段级策略不下发（无权字段服务端不返回）。 */
@Controller("api/v1/permissions")
@UseGuards(SessionGuard, CsrfGuard)
export class PermissionController {
  constructor(private readonly permission: PermissionService) {}

  /** 当前用户授权画像：全量能力基线 + 部门规则裁决结果（规则调整后由策略缓存 TTL / invalidate 刷新）。 */
  @Get("me")
  async me(@CurrentActorId() actorId: string): Promise<PermissionMeResponse> {
    return { permissions: await this.permission.permissionsOf(actorId) };
  }
}
