import { Controller, Delete, Get, HttpCode, Put, Query, UseGuards, Body } from "@nestjs/common";
import { GroupAccessRuleInputSchema, z } from "@libiaolink/contracts";
import type { GroupAccessOverview, GroupAccessRuleInput, GroupAccessRuleResponse } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { GroupAccessAdminGuard } from "./group-access.guard.js";
import { GroupAccessService } from "./group-access.service.js";

const DeleteQuerySchema = z.object({ groupKey: z.string().trim().min(1).max(200) });

/** 群组权限管理（头像菜单「权限管理」· 2026-10-23）：入口与接口都按群组管理员收敛。 */
@Controller("api/v1/access")
@UseGuards(SessionGuard, CsrfGuard, GroupAccessAdminGuard)
export class GroupAccessController {
  constructor(private readonly access: GroupAccessService) {}

  @Get()
  overview(@CurrentActorId() actorId: string): Promise<GroupAccessOverview> {
    return this.access.overview(actorId);
  }

  @Put("rules")
  save(
    @Body(new ZodValidationPipe(GroupAccessRuleInputSchema)) body: GroupAccessRuleInput,
    @CurrentActorId() actorId: string,
  ): Promise<GroupAccessRuleResponse> {
    return this.access.save(actorId, body);
  }

  @Delete("rules")
  @HttpCode(204)
  async remove(
    @Query(new ZodValidationPipe(DeleteQuerySchema)) query: z.infer<typeof DeleteQuerySchema>,
    @CurrentActorId() actorId: string,
  ): Promise<void> {
    await this.access.remove(actorId, query.groupKey);
  }
}
