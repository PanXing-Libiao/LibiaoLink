import { Body, Controller, Delete, Get, Header, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import {
  WecomDmBindingUpdateBodySchema,
  type WecomDmBindingCode,
  type WecomDmBindingState,
  type WecomDmBindingUpdateBody,
  type WecomDmBotDiagnostics,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { NotifyDmService } from "./notify.dm.service.js";

/**
 * 企业微信单聊绑定接口（M5-03-5-6 绑定码链路 · 契约刀 · Push 249）：契约 = shared/src/modules/notifications.ts
 * 末尾「企业微信单聊绑定」段；口径 = `docs/M5-03-5-绑定码方案设计口径(企微单聊).md` v2.1 §3 / §4 / §6 / §9 / §10（D2 · D3 · D5 · D6）。
 * 根路径 /api/v1/wecom-dm-binding —— 个人资源（同收件箱 / 通知偏好先例）：无功能权限键、无项目域判定；
 * 读 = 会话；取码 / 开关 / 解绑 = 会话 + CSRF。与 NotifyController 分挂两个前缀：本组是「绑定资源」，不是通知条目。
 * 链路：取码（POST codes）→ 用户把码发进企微单聊（worker `NotifyDmService.ingestCallback` 落绑定 + 会话内回执）
 * → 查绑定态（GET）→ 解绑（DELETE）。绑定只能由用户交互产生（企微后台无管理员权限的既有事实）。
 */
@Controller("api/v1/wecom-dm-binding")
@UseGuards(SessionGuard)
export class WecomDmBindingController {
  constructor(private readonly dm: NotifyDmService) {}

  /**
   * 绑定态（D5 · 恒 200）：按当前机器人（`WECOM_BOT_ID`）维度判定；未绑定 / 换机器人后 = bound:false。
   * v1.8 回填：另回当前未用绑定码（`bindingCode`）与取码限流可重试时刻（`retryAt`）—— 页面刷新 / 重进不丢状态。
   */
  @Get()
  state(@CurrentActorId() actorId: string): Promise<WecomDmBindingState> {
    return this.dm.getBindingState(actorId);
  }

  /**
   * 更新消息开关（个人设置）：关闭后停止企微单聊外发，站内信降级仍保留。
   * 未绑定时幂等返回未绑定态；绑定 / 换绑成功服务端恢复默认 true。
   */
  @Patch()
  @UseGuards(CsrfGuard)
  updateMessagesEnabled(
    @Body(new ZodValidationPipe(WecomDmBindingUpdateBodySchema)) body: WecomDmBindingUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<WecomDmBindingState> {
    return this.dm.setMessagesEnabled(actorId, body.messagesEnabled);
  }

  /**
   * 机器人诊断（仅非生产环境；WECOM_BOT_DIAGNOSTICS 开关）：回显本 api 进程实际读取的 bot_id / secret /
   * ws 地址 + 该 bot_id 的最近回调统计 —— 用于核对「企微后台凭据是否一致」与「worker 是否在收消息」。
   * `Cache-Control: no-store`：secret 不进任何缓存；生产（开关关闭）恒 enabled:false + 敏感字段 null。
   */
  @Get("diagnostics")
  @Header("Cache-Control", "no-store")
  diagnostics(): Promise<WecomDmBotDiagnostics> {
    return this.dm.getBotDiagnostics();
  }

  /**
   * 取码（D3 签发 · 频率 D3 修订 v1.8）：6 位数字 / TTL 3 分钟 / 一次性（重复取码作废上一条未用码）；
   * 频率到顶（5 次 / 3 分钟 / 用户）→ 429 `RATE_LIMITED` + `details[].meta.retryAt`（最长等待 ≤ 3 分钟）。
   */
  @Post("codes")
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async requestCode(@CurrentActorId() actorId: string): Promise<WecomDmBindingCode> {
    const result = await this.dm.requestBindingCode(actorId);
    if (!result.ok) {
      throw new AppError("RATE_LIMITED", "绑定码生成频率到顶（5 次 / 3 分钟），请稍后再试", [
        {
          code: "rate_limited",
          message: "可重试时刻：" + result.retryAt.toISOString(),
          path: "body",
          meta: { retryAt: result.retryAt.toISOString(), window: "3m" },
        },
      ]);
    }
    return { code: result.code, expiresAt: result.expiresAt.toISOString(), expiresInSeconds: result.expiresInSeconds };
  }

  /** 解绑（D6）：幂等（本就未绑定也 200 bound:false，不写审计）；成功时服务层同事务写 audit_logs。 */
  @Delete()
  @UseGuards(CsrfGuard)
  unbind(@CurrentActorId() actorId: string): Promise<WecomDmBindingState> {
    return this.dm.unbind(actorId, actorId);
  }
}
