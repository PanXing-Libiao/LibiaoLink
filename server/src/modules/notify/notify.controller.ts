import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import {
  NotificationListQuerySchema,
  NotificationMarkBodySchema,
  NotificationSnoozeBodySchema,
  NotifyDeliveryListQuerySchema,
  NotifyDeliveryResendBodySchema,
  NotifyPrefsUpdateBodySchema,
  z,
  type Notification,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationMarkAllReadResponse,
  type NotificationMarkBody,
  type NotificationSnoozeBody,
  type NotificationSnoozeListResponse,
  type NotifyDeliveryDetail,
  type NotifyDeliveryListQuery,
  type NotifyDeliveryListResponse,
  type NotifyDeliveryResendBody,
  type NotifyDeliveryResendResponse,
  type NotifyPrefs,
  type NotifyPrefsUpdateBody,
} from "@libiaolink/contracts";
import type { Request, Response } from "express";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { NotifyDeliveryService } from "./notify.delivery.service.js";
import { NotifyService } from "./notify.service.js";
import { NotifyStreamService } from "./notify.stream.service.js";

const notificationIdParam = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * 消息中心接口（S7-4 · j1 / M5-04 首刀 + S8-3 M5-04-1 SSE / M5-04-2 稍后提醒）：契约 shared/src/modules/notifications.ts。
 * 根路径 /api/v1/notifications —— 个人资源（收件箱只属收件人）：无功能权限键；读 = 会话、写 = 会话 + CSRF；不写审计。
 * 路由顺序：静态段（prefs / stream / mark-all-read）声明在 `:id` 之前（Nest 按声明顺序匹配，否则 PATCH /prefs 会被 `:id` 吞掉）；
 * snooze 三件为 `:id/` 二级段（与静态段无冲突），与 `:id` 同级声明在后面。
 */
@Controller("api/v1/notifications")
@UseGuards(SessionGuard)
export class NotifyController {
  constructor(
    private readonly notify: NotifyService,
    private readonly streamService: NotifyStreamService,
    private readonly deliveries: NotifyDeliveryService,
  ) {}

  /** 收件箱清单（C5-01 / C5-02）：状态 / 类型 / 关联对象 + 投递时刻区间 + 分页；随行未读角标。 */
  @Get()
  list(
    @Query(new ZodValidationPipe(NotificationListQuerySchema)) query: NotificationListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<NotificationListResponse> {
    return this.notify.list(actorId, query);
  }

  /** 通知偏好（C2-09；生效值）。 */
  @Get("prefs")
  prefs(@CurrentActorId() actorId: string): Promise<NotifyPrefs> {
    return this.notify.getPrefs(actorId);
  }

  /**
   * 通知实时流（SSE · S8-3 / M5-04-1）：事件 `notification` / `unread`；心跳 = 注释行；重连不补发（读面补拉对齐）。
   * 手写 `res`（实现评审选择 · 对照 `@Sse`）：注释行心跳 / 停机告知 / 响应头与关闭语义直接可控。
   * 超限拒新 = 429（每用户连接上限 · 定案 §三-4；`RATE_LIMITED` 未入 shared 契约 —— M5-07 联调复评）。
   */
  @Get("stream")
  stream(@Req() request: Request, @Res() res: Response, @CurrentActorId() actorId: string): void {
    const connection = this.streamService.open(actorId, {
      write: (chunk) => {
        res.write(chunk);
      },
      end: () => {
        res.end();
      },
    });
    if (connection === null) {
      const requestId = (request as { id?: unknown }).id;
      res.status(429).json({
        code: "RATE_LIMITED",
        message: "通知实时流连接被拒绝：每用户连接数已达上限（或服务正在停止），请稍后重试",
        details: [],
        traceId: typeof requestId === "string" ? requestId : "",
      });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.on("close", () => connection.close());
  }

  /**
   * 发送记录列表（M5-06-2B · S8-4）：管理员读面；`deliveries` 静态段必须先于 `:id` 路由。
   * 目标地址只回掩码，完整 target / payload 不下发。
   */
  @Get("deliveries")
  @UseGuards(ProjectAccessGuard)
  @RequirePermission("notify.record.view")
  listDeliveries(
    @Query(new ZodValidationPipe(NotifyDeliveryListQuerySchema)) query: NotifyDeliveryListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<NotifyDeliveryListResponse> {
    return this.deliveries.list(actorId, query);
  }

  /** 发送记录详情：消息归档 + 全部尝试明细；不存在 404。 */
  @Get("deliveries/:id")
  @UseGuards(ProjectAccessGuard)
  @RequirePermission("notify.record.view")
  getDelivery(
    @Param("id", notificationIdParam) id: number,
    @CurrentActorId() actorId: string,
  ): Promise<NotifyDeliveryDetail> {
    return this.deliveries.detail(actorId, id);
  }

  /** 重发失败 / 死信外部消息：空请求体 + 必填 Idempotency-Key；原记录不改写。 */
  @Post("deliveries/:id/resend")
  @HttpCode(200)
  @UseGuards(CsrfGuard, ProjectAccessGuard)
  @RequirePermission("notify.resend")
  resendDelivery(
    @Param("id", notificationIdParam) id: number,
    @Headers("Idempotency-Key") idempotencyKey: string,
    @Body(new ZodValidationPipe(NotifyDeliveryResendBodySchema)) _body: NotifyDeliveryResendBody,
    @CurrentActorId() actorId: string,
  ): Promise<NotifyDeliveryResendResponse> {
    return this.deliveries.resend(actorId, id, idempotencyKey);
  }

  /** 更新通知偏好（局部更新；空更新 400）。 */
  @Patch("prefs")
  @UseGuards(CsrfGuard)
  updatePrefs(
    @Body(new ZodValidationPipe(NotifyPrefsUpdateBodySchema)) body: NotifyPrefsUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<NotifyPrefs> {
    return this.notify.updatePrefs(actorId, body);
  }

  /** 全部标记已读（幂等；无未读时 updated=0）。 */
  @Post("mark-all-read")
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  markAllRead(@CurrentActorId() actorId: string): Promise<NotificationMarkAllReadResponse> {
    return this.notify.markAllRead(actorId);
  }

  /** 标记状态（未读 / 已读 / 已处理；幂等）：他人 / 合并子行 / 未投递行统一 404。 */
  @Patch(":id")
  @UseGuards(CsrfGuard)
  mark(
    @Param("id", notificationIdParam) id: number,
    @Body(new ZodValidationPipe(NotificationMarkBodySchema)) body: NotificationMarkBody,
    @CurrentActorId() actorId: string,
  ): Promise<Notification> {
    return this.notify.mark(actorId, id, body.status);
  }

  /**
   * 设置 / 覆盖稍后提醒（C5-05 · S8-3 / M5-04-2）：设置即置读；重复设置 = 覆盖（旧记录标 cancelledAt + 新记录）；
   * 范围 400（> now + 5 分钟且 ≤ now + 30 天）；他人 / 合并子行 / 未投递行统一 404。POST 语义返回更新后通知 → 200。
   */
  @Post(":id/snooze")
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  snooze(
    @Param("id", notificationIdParam) id: number,
    @Body(new ZodValidationPipe(NotificationSnoozeBodySchema)) body: NotificationSnoozeBody,
    @CurrentActorId() actorId: string,
  ): Promise<Notification> {
    return this.notify.snooze(actorId, id, body);
  }

  /** 取消稍后提醒（C5-05）：幂等（无未触发也 200）；返回 snoozeUntil = null 的通知；404 族同上。 */
  @Delete(":id/snooze")
  @UseGuards(CsrfGuard)
  unsnooze(@Param("id", notificationIdParam) id: number, @CurrentActorId() actorId: string): Promise<Notification> {
    return this.notify.unsnooze(actorId, id);
  }

  /** 稍后提醒记录（C5-05「设置与触发记录可查」）：按 id 降序、不翻页；404 族同上。 */
  @Get(":id/snoozes")
  listSnoozes(
    @Param("id", notificationIdParam) id: number,
    @CurrentActorId() actorId: string,
  ): Promise<NotificationSnoozeListResponse> {
    return this.notify.listSnoozes(actorId, id);
  }
}
