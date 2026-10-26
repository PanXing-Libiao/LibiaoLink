import { Controller, Get, UseGuards } from "@nestjs/common";
import type { WorkspaceResponse } from "@libiaolink/contracts";
import { CurrentActorId, SessionGuard } from "../identity/index.js";
import { GroupAccessGuard, RequireAccessPage } from "../permission/index.js";
import { WorkspaceService } from "./workspace.service.js";

/**
 * 工作台接口（M6-05 第一刀 · S6·workspace）：契约 shared/src/modules/workspace.ts。
 * 根路径 /api/v1/workspace（无项目路径参数）—— 个人读面：仅会话；不做功能权限位，数据按项目可见性过滤。
 */
@Controller("api/v1/workspace")
@UseGuards(SessionGuard, GroupAccessGuard)
@RequireAccessPage("workspace")
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  /** 工作台聚合：我的任务三组 + 我的问题两栏（基准日 = Asia/Shanghai 今天）。 */
  @Get()
  get(@CurrentActorId() actorId: string): Promise<WorkspaceResponse> {
    return this.workspace.get(actorId);
  }
}
