/**
 * 翻译接口（§6.16 ㉕ · Push 301）：契约 shared/src/modules/translate.ts。
 * 根路径 /api/v1/translate —— 登录即可（无功能权限位：产出仅译文库缓存，不写业务数据、不写审计）；
 * POST 挂 CsrfGuard（与其它写请求同口径）；batch = 只读查库（不调引擎，英文界面切页提速）。
 */
import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  TranslateBatchBodySchema,
  TranslateBodySchema,
  type TranslateBatchBody,
  type TranslateBatchResponse,
  type TranslateBody,
  type TranslateResponse,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, SessionGuard } from "../identity/index.js";
import { TranslateService } from "./translate.service.js";

@Controller("api/v1/translate")
@UseGuards(SessionGuard)
export class TranslateController {
  constructor(private readonly translate: TranslateService) {}

  /** 单条翻译：译文库优先；未命中调内网引擎后落库（引擎不可用 500 INTERNAL，前端静默降级跳过）。 */
  @Post()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async translateText(@Body(new ZodValidationPipe(TranslateBodySchema)) body: TranslateBody): Promise<TranslateResponse> {
    const translatedText = await this.translate.translate(body.q, body.source, body.target);
    return { translatedText };
  }

  /** 批量查库（只读）：一次请求拿整页已存译文；未命中条目由前端走单条通道。 */
  @Post("batch")
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async batch(@Body(new ZodValidationPipe(TranslateBatchBodySchema)) body: TranslateBatchBody): Promise<TranslateBatchResponse> {
    const translations = await this.translate.lookup(body.qs, body.source, body.target);
    return { translations };
  }
}
