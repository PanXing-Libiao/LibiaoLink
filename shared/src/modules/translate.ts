import { z } from "../zod.ts";

/**
 * 翻译通道（§6.16 ㉕ · Push 301）：手打内容英译的服务端落库通路 —— shared 契约唯一真相。
 * 业务口径 2026-10-13：「现在点击切换由于项目数量多 翻译不过来会有很大延迟 所以我希望当因为手打内容为中文
 * 并且保存的时候 后台自动翻译 并且写入数据库 下次切换翻译的时候直接调用即可」。
 * 形状与既有前端通道一致（q / source / target / format → translatedText）——前端零协议改动；
 * 语义增补：服务端先查译文库（content_translations · 迁移 0047），命中直出；
 * 未命中调内网引擎（HY-MT1.5-1.8B）后落库（下次切换 = 读库直出）。
 * 批量端点 batch = 只读查库（不调引擎）：英文界面切页一次请求拿整页已存译文，未命中的前端再走单条通道。
 */

/** 支持语言：zh 中文 / en 英文（一期仅中 → 英翻译）。 */
export const TRANSLATE_LANGS = ["zh", "en"] as const;
export const TranslateLangSchema = z.enum(TRANSLATE_LANGS).openapi("TranslateLang", {
  description: "语言：zh 中文 / en 英文",
});

/** 单条文本上限（与手打内容 2000 字级对齐、放宽一倍；超限 400 VALIDATION_FAILED）。 */
export const TRANSLATE_TEXT_MAX = 4000;
/** 批量条数硬顶（防御性；前端按 200 分片）。 */
export const TRANSLATE_BATCH_MAX = 400;

/** 单条翻译请求（q = 待译文本；术语占位符形态由前端保护，服务端原样透传）。 */
export const TranslateBodySchema = z
  .object({
    q: z.string().min(1).max(TRANSLATE_TEXT_MAX),
    source: TranslateLangSchema.default("zh"),
    target: TranslateLangSchema.default("en"),
    format: z.literal("text").default("text"),
  })
  .openapi("TranslateBody", { description: "单条翻译请求：译文库优先、未命中调引擎后落库" });

/** 单条翻译响应。 */
export const TranslateResponseSchema = z
  .object({
    translatedText: z.string().openapi({ description: "译文（译文库命中或引擎产出后落库）" }),
  })
  .openapi("TranslateResponse");

/** 批量查库请求（只读译文库、不触发引擎）。 */
export const TranslateBatchBodySchema = z
  .object({
    qs: z.array(z.string().min(1).max(TRANSLATE_TEXT_MAX)).min(1).max(TRANSLATE_BATCH_MAX),
    source: TranslateLangSchema.default("zh"),
    target: TranslateLangSchema.default("en"),
  })
  .openapi("TranslateBatchBody", { description: "批量查库请求（英文界面切页提速；只回已存译文）" });

/** 批量查库响应：仅命中条目（顺序与请求一致、剔除未命中）。 */
export const TranslateBatchResponseSchema = z
  .object({
    translations: z
      .array(
        z.object({
          q: z.string().openapi({ description: "原文（请求时原样回显）" }),
          translatedText: z.string().openapi({ description: "已存译文" }),
        }),
      )
      .openapi({ description: "命中条目（译文库已存；未命中的由前端走单条通道）" }),
  })
  .openapi("TranslateBatchResponse");

export type TranslateLang = z.infer<typeof TranslateLangSchema>;
export type TranslateBody = z.infer<typeof TranslateBodySchema>;
export type TranslateResponse = z.infer<typeof TranslateResponseSchema>;
export type TranslateBatchBody = z.infer<typeof TranslateBatchBodySchema>;
export type TranslateBatchResponse = z.infer<typeof TranslateBatchResponseSchema>;
