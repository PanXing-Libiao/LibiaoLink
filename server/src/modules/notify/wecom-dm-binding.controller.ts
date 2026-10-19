import { Controller, Delete, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import type { WecomDmBindingCode, WecomDmBindingState } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { NotifyDmService } from "./notify.dm.service.js";

/**
 * 企业微信单聊绑定接口（M5-03-5-6 绑定码链路 · 契约刀 · Push 249）：契约 = shared/src/modules/notifications.ts
 * 末尾「企业微信单聊绑定」段；口径 = `docs/M5-03-5-绑定码方案设计口径(企微单聊).md` v1.8 §3 / §4 / §9 / §10（D2 · D3 · D5 · D6）。
 * 根路径 /api/v1/wecom-dm-binding —— 个人资源（同收件箱 / 通知偏好先例）：无功能权限键、无项目域判定；
 * 读 = 会话；取码 / 解绑 = 会话 + CSRF。与 NotifyController 分挂两个前缀：本组是「绑定资源」，不是通知条目。
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
   * 取码（D3 签发 · 频率 D3 修订 v1.8）：6 位数字 / TTL 5 分钟 / 一次性（重复取码作废上一条未用码）；
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
