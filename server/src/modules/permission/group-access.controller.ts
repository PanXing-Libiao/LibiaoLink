import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query, UseGuards } from "@nestjs/common";
import { GroupAccessAdminInputSchema, GroupAccessMemberRuleDeleteInputSchema, GroupAccessMemberRuleInputSchema, GroupAccessRuleInputSchema, UuidSchema, z } from "@libiaolink/contracts";
import type { GroupAccessAdminInput, GroupAccessAdminResponse, GroupAccessMemberRuleDeleteInput, GroupAccessMemberRuleInput, GroupAccessMemberRuleResponse, GroupAccessOverview, GroupAccessRuleInput, GroupAccessRuleResponse } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { GroupAccessAdminGuard } from "./group-access.guard.js";
import { GroupAccessService } from "./group-access.service.js";

const DeleteRuleQuerySchema = z.object({ groupKey: z.string().trim().min(1).max(200) });
const DeleteAdminQuerySchema = z.object({ userId: UuidSchema });

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

  @Put("member-rules")
  saveMemberRules(
    @Body(new ZodValidationPipe(GroupAccessMemberRuleInputSchema)) body: GroupAccessMemberRuleInput,
    @CurrentActorId() actorId: string,
  ): Promise<GroupAccessMemberRuleResponse> {
    return this.access.saveMemberRules(actorId, body);
  }

  @Delete("member-rules")
  @HttpCode(204)
  async removeMemberRules(
    @Body(new ZodValidationPipe(GroupAccessMemberRuleDeleteInputSchema)) body: GroupAccessMemberRuleDeleteInput,
    @CurrentActorId() actorId: string,
  ): Promise<void> {
    await this.access.removeMemberRules(actorId, body);
  }

  @Delete("rules")
  @HttpCode(204)
  async remove(
    @Query(new ZodValidationPipe(DeleteRuleQuerySchema)) query: z.infer<typeof DeleteRuleQuerySchema>,
    @CurrentActorId() actorId: string,
  ): Promise<void> {
    await this.access.remove(actorId, query.groupKey);
  }

  @Post("admins")
  @HttpCode(200)
  assignAdmin(
    @Body(new ZodValidationPipe(GroupAccessAdminInputSchema)) body: GroupAccessAdminInput,
    @CurrentActorId() actorId: string,
  ): Promise<GroupAccessAdminResponse> {
    return this.access.assignAdmin(actorId, body.userId);
  }

  @Delete("admins")
  @HttpCode(204)
  async removeAdmin(
    @Query(new ZodValidationPipe(DeleteAdminQuerySchema)) query: z.infer<typeof DeleteAdminQuerySchema>,
    @CurrentActorId() actorId: string,
  ): Promise<void> {
    await this.access.removeAdmin(actorId, query.userId);
  }
}
