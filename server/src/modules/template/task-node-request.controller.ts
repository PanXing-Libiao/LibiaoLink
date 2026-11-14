import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import {
  TaskNodeRequestApproveBodySchema,
  TaskNodeRequestListQuerySchema,
  TaskNodeRequestRejectBodySchema,
  TaskNodeReviewNotificationSettingsBodySchema,
  UuidSchema,
} from "@libiaolink/contracts";
import type {
  TaskNodeRequestApproveBody,
  TaskNodeRequestDecisionResponse,
  TaskNodeRequestListQuery,
  TaskNodeRequestListResponse,
  TaskNodeRequestRejectBody,
  TaskNodeReviewNotificationSettings,
  TaskNodeReviewNotificationSettingsBody,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { TaskNodeRequestService } from "./task-node-request.service.js";
import { TaskNodeReviewNotificationService } from "./task-node-review-notification.service.js";

const idParam = new ZodValidationPipe(UuidSchema);

/**
 * 公共任务节点申请接口（0096 · 2026-11-13）：
 * 导入面板里「保留 Excel 原名」的任务可顺带申请加入公共节点库，由权限页勾选的公共节点审核管理员
 * 逐条通过（可改中英文名后直接建节点）或驳回（原因必填）；申请人可撤销本人待审申请。
 * 门禁：登录 + CSRF；审核面（列表审核人视角 / 通过 / 驳回）由服务层复核管理员身份 + 审核人白名单，本人视角只看自己。
 */
@Controller("api/v1/task-node-requests")
@UseGuards(SessionGuard, CsrfGuard)
export class TaskNodeRequestController {
  constructor(
    private readonly requests: TaskNodeRequestService,
    private readonly notifications: TaskNodeReviewNotificationService,
  ) {}

  /** 申请列表：mine=true 只看本人；缺省 = 审核人视角全部（含 pendingCount 供入口角标）。 */
  @Get()
  list(
    @Query(new ZodValidationPipe(TaskNodeRequestListQuerySchema)) query: TaskNodeRequestListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNodeRequestListResponse> {
    return this.requests.list(query, actorId);
  }

  /** 审核页左侧的企微通知设置：全局单例；只有当前公共节点审核管理员可读。 */
  @Get("notification-settings")
  getNotificationSettings(@CurrentActorId() actorId: string): Promise<TaskNodeReviewNotificationSettings> {
    return this.notifications.getSettings(actorId);
  }

  /** 保存开关与每日通知时间（Asia/Shanghai）；写审计，worker 到点派发。 */
  @Put("notification-settings")
  updateNotificationSettings(
    @Body(new ZodValidationPipe(TaskNodeReviewNotificationSettingsBodySchema)) body: TaskNodeReviewNotificationSettingsBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNodeReviewNotificationSettings> {
    return this.notifications.updateSettings(body, actorId);
  }

  /** 通过：可先改中英文名；同阶段已有同名公共节点时直接关联（linkedExisting=true），不重复建节点。 */
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(TaskNodeRequestApproveBodySchema)) body: TaskNodeRequestApproveBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNodeRequestDecisionResponse> {
    return this.requests.approve(id, body, actorId);
  }

  /** 驳回（原因必填，申请人可见）。 */
  @Post(":id/reject")
  @HttpCode(200)
  reject(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(TaskNodeRequestRejectBodySchema)) body: TaskNodeRequestRejectBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNodeRequestDecisionResponse> {
    return this.requests.reject(id, body, actorId);
  }

  /** 申请人撤销本人待审申请。 */
  @Post(":id/withdraw")
  @HttpCode(200)
  withdraw(@Param("id", idParam) id: string, @CurrentActorId() actorId: string): Promise<TaskNodeRequestDecisionResponse> {
    return this.requests.withdraw(id, actorId);
  }
}
