/**
 * 翻译服务（§6.16 ㉕ ㉖ · Push 301 / 309）：手打内容英译的落库通路 —— 单条（库优先 + 引擎兜底）/ 批量查库 / 保存链路后台预热。
 *
 * 业务口径 2026-10-13：「现在点击切换由于项目数量多 翻译不过来会有很大延迟 所以我希望当因为手打内容为中文
 * 并且保存的时候 后台自动翻译 并且写入数据库 下次切换翻译的时候直接调用即可」。
 *
 *  - translate：先查译文库（content_translations），命中直出；未命中调翻译通道（Push 309 起 provider 可插拔：
 *    `openai` = OpenAI 兼容 API（TRANSLATE_API_*，公司 New API 网关；可选 TRANSLATE_FALLBACK_ORIGIN 本地兜底）/
 *    `local` = 内网引擎（TRANSLATE_ORIGIN，HY-MT1.5-1.8B 薄壳））后 upsert 落库 —— 之后任何端命中即读库直出。
 *  - lookup：批量只读查库（不调引擎）—— 英文界面切页一次请求拿整页已存译文。
 *  - warmup：保存链路（任务 / 项目控制器挂点）把新写入的手打中文文本丢进来，后台异步翻好落库；
 *    去重（同文本 5 分钟窗口）+ 限并发 2 + 从不抛错（失败静默，下次保存 / 页面到达再试）。
 *
 * 键口径：hash = sha256(q)，q = **原文**（Push 301 起所有通路统一 —— 前端读路径与保存链路预热同键）。
 * 术语保护 / 回换 / 规整内聚在服务端 translate.text.ts（原先在前端按占位符形态发引擎；保存链路预热
 * 不经过前端，保护必须挪到服务端才能保证「预热落库的译文」与「前端读库的键 / 质量」一致）。
 */
import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { TranslateLang } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { TranslateRepository } from "./translate.repository.js";
import { finalizeTranslation, protectGlossary } from "./translate.text.js";

/** 译文库行的引擎标识（换引擎后按此列可批量重翻）。 */
export const TRANSLATE_ENGINE = "hy-mt-1.5-1.8b";

/** 预热去重窗口（毫秒）：同文本在此窗口内不重复排队。 */
const WARMUP_RECENT_TTL_MS = 300000;
/** 预热队列每次调用的条数硬顶（防大列表保存时内存失控）。 */
const WARMUP_MAX_PER_CALL = 300;
/** 预热并发（2 并发足够且不打满；本地小模型 / API 网关均适用）。 */
const WARMUP_CONCURRENCY = 2;
/** 中文痕迹（含 CJK 基本区即排队；纯英文 / 数字文本不翻）。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/;

interface EngineHit { translatedText: string }

/** OpenAI 兼容 chat/completions 回包（只取首条 message.content）。 */
interface ApiChatReply {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** 引擎产出：译文 + 落库 engine 标记（按实际产出通道标记，换引擎可按列批量重翻）。 */
interface EngineOutput { translatedText: string; engine: string }

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);
  /** 预热去重表（文本 → 最近排队时间）。 */
  private readonly warmupRecent = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: TranslateRepository,
  ) {}

  /** 单条翻译（译文库优先；未命中调引擎后落库）。 */
  async translate(q: string, source: TranslateLang, target: TranslateLang): Promise<string> {
    const hash = hashOf(q);
    const hit = await this.repository.findByHash(source, target, hash);
    if (hit !== null && hit.translatedText !== "") {
      return hit.translatedText;
    }
    const output = await this.callEngine(q, source, target);
    await this.repository.upsert({ sourceLang: source, targetLang: target, sourceHash: hash, sourceText: q, translatedText: output.translatedText, engine: output.engine }, new Date());
    return output.translatedText;
  }

  /** 批量查库（只读，不调引擎）：按请求顺序返回命中条目。 */
  async lookup(qs: readonly string[], source: TranslateLang, target: TranslateLang): Promise<Array<{ q: string; translatedText: string }>> {
    const unique: string[] = [];
    const hashToText = new Map<string, string>();
    for (const q of qs) {
      const hash = hashOf(q);
      if (hashToText.has(hash)) {
        continue;
      }
      hashToText.set(hash, q);
      unique.push(hash);
    }
    const rows = await this.repository.findManyByHashes(source, target, unique);
    const textByHash = new Map(rows.map((row) => [row.sourceHash, row.translatedText]));
    const out: Array<{ q: string; translatedText: string }> = [];
    for (const hash of unique) {
      const translatedText = textByHash.get(hash);
      if (translatedText !== undefined && translatedText !== "") {
        out.push({ q: hashToText.get(hash) ?? "", translatedText });
      }
    }
    return out;
  }

  /**
   * 保存即后台翻译（业务口径）：把一批手打文本静默翻好落库 —— 不同步、不抛错、不阻塞保存响应。
   * 只排「非空 + 含中文痕迹 + 去重窗口外」的文本；已入库的条目在后台逐条跳过。
   */
  warmup(texts: readonly string[]): void {
    const now = Date.now();
    this.pruneWarmupRecent(now);
    const queue: string[] = [];
    for (const raw of texts) {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "" || !CJK_PATTERN.test(text)) {
        continue;
      }
      if (this.warmupRecent.has(text)) {
        continue;
      }
      this.warmupRecent.set(text, now);
      queue.push(text);
      if (queue.length >= WARMUP_MAX_PER_CALL) {
        break;
      }
    }
    if (queue.length === 0) {
      return;
    }
    let cursor = 0;
    void Promise.all(
      Array.from({ length: Math.min(WARMUP_CONCURRENCY, queue.length) }, async () => {
        while (cursor < queue.length) {
          const at = cursor;
          cursor += 1;
          const text = queue[at];
          if (text === undefined) {
            return;
          }
          await this.warmupOne(text);
        }
      }),
    );
  }

  /** 单条预热：已入库跳过；未入库调引擎翻好落库；任何失败静默（下次再试）。 */
  private async warmupOne(text: string): Promise<void> {
    try {
      const hash = hashOf(text);
      const hit = await this.repository.findByHash("zh", "en", hash);
      if (hit !== null && hit.translatedText !== "") {
        return;
      }
      const output = await this.callEngine(text, "zh", "en");
      await this.repository.upsert({ sourceLang: "zh", targetLang: "en", sourceHash: hash, sourceText: text, translatedText: output.translatedText, engine: output.engine }, new Date());
    } catch (error) {
      this.logger.debug("warmup skipped: " + String(error instanceof Error ? error.message : error));
    }
  }

  /** 去重表瘦身（仅在超阈值时扫过期项）。 */
  private pruneWarmupRecent(now: number): void {
    if (this.warmupRecent.size <= 2000) {
      return;
    }
    for (const [key, at] of this.warmupRecent) {
      if (now - at > WARMUP_RECENT_TTL_MS) {
        this.warmupRecent.delete(key);
      }
    }
  }

  /**
   * 调翻译通道（Push 309/310 · provider 可插拔）：`openai` = API 主通道（主模型 → 备用模型两跳；仍失败且配置了 TRANSLATE_FALLBACK_ORIGIN 时改调本地引擎）；
   * `local` = 本地引擎直连（TRANSLATE_ORIGIN）。术语保护对两种通道一致：出引擎前占位符化（translate.text.ts），回包规整 + 回换。
   */
  private async callEngine(q: string, source: TranslateLang, target: TranslateLang): Promise<EngineOutput> {
    if (this.config.env.TRANSLATE_PROVIDER === "openai") {
      try {
        const result = await this.callOpenAiApi(q, source, target);
        return { translatedText: result.translatedText, engine: "api:" + result.model };
      } catch (error) {
        const fallback = this.config.env.TRANSLATE_FALLBACK_ORIGIN ?? "";
        if (fallback === "") {
          throw error;
        }
        this.logger.warn("翻译 API 失败，改走本地兜底引擎：" + (error instanceof Error ? error.message : String(error)));
        const translatedText = await this.callLocalEngine(fallback, q, source, target);
        return { translatedText, engine: TRANSLATE_ENGINE };
      }
    }
    const translatedText = await this.callLocalEngine(this.config.env.TRANSLATE_ORIGIN, q, source, target);
    return { translatedText, engine: TRANSLATE_ENGINE };
  }

  /** 本地引擎（LibreTranslate 兼容 POST /translate：{q, source, target, format} → {translatedText}）。失败一律 AppError INTERNAL。 */
  private async callLocalEngine(origin: string, q: string, source: TranslateLang, target: TranslateLang): Promise<string> {
    const { protectedText, tokens } = protectGlossary(q);
    let response: Response;
    try {
      response = await fetch(new URL("/translate", origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: protectedText, source, target, format: "text" }),
        signal: AbortSignal.timeout(this.config.env.TRANSLATE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError("INTERNAL", "翻译引擎不可用（" + (error instanceof Error ? error.message : String(error)) + "）");
    }
    if (!response.ok) {
      throw new AppError("INTERNAL", "翻译引擎返回 HTTP " + String(response.status));
    }
    const data = (await response.json().catch(() => null)) as EngineHit | null;
    const raw = data !== null && typeof data.translatedText === "string" ? data.translatedText : "";
    if (raw === "") {
      throw new AppError("INTERNAL", "翻译引擎响应缺少 translatedText");
    }
    const finalText = finalizeTranslation(raw, tokens);
    if (finalText === "") {
      throw new AppError("INTERNAL", "翻译引擎响应规整后为空");
    }
    return finalText;
  }

  /**
   * OpenAI 兼容 API（Push 310：主模型 → 备用模型两跳）。主模型失败（网络 / HTTP / 解析）时，
   * 若配置了 TRANSLATE_API_MODEL_FALLBACK 且不同于主模型 → 改调备用模型（如 deepseek 断流 → gemini-3.8-flash）。
   */
  private async callOpenAiApi(q: string, source: TranslateLang, target: TranslateLang): Promise<{ translatedText: string; model: string }> {
    const env = this.config.env;
    if ((env.TRANSLATE_API_BASE_URL ?? "") === "" || (env.TRANSLATE_API_MODEL ?? "") === "") {
      throw new AppError("INTERNAL", "翻译 API 未配置（TRANSLATE_API_BASE_URL / TRANSLATE_API_MODEL）");
    }
    const primary = env.TRANSLATE_API_MODEL;
    try {
      return { translatedText: await this.callOpenAiModel(primary, q, source, target), model: primary };
    } catch (error) {
      const fallbackModel = env.TRANSLATE_API_MODEL_FALLBACK ?? "";
      if (fallbackModel === "" || fallbackModel === primary) {
        throw error;
      }
      this.logger.warn("翻译 API 主模型失败，改走备用模型 " + fallbackModel + "：" + (error instanceof Error ? error.message : String(error)));
      return { translatedText: await this.callOpenAiModel(fallbackModel, q, source, target), model: fallbackModel };
    }
  }

  /** 单次 OpenAI 兼容请求（POST {base}/chat/completions；密钥 = TRANSLATE_API_KEY 可空）。失败一律 AppError INTERNAL。 */
  private async callOpenAiModel(model: string, q: string, source: TranslateLang, target: TranslateLang): Promise<string> {
    const env = this.config.env;
    const { protectedText, tokens } = protectGlossary(q);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if ((env.TRANSLATE_API_KEY ?? "") !== "") {
      headers["Authorization"] = "Bearer " + env.TRANSLATE_API_KEY;
    }
    let response: Response;
    try {
      response = await fetch(joinApiUrl(env.TRANSLATE_API_BASE_URL, "/chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: buildSystemPrompt(source, target) },
            { role: "user", content: protectedText },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(env.TRANSLATE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError("INTERNAL", "翻译 API 不可用（模型 " + model + "：" + (error instanceof Error ? error.message : String(error)) + "）");
    }
    if (!response.ok) {
      throw new AppError("INTERNAL", "翻译 API 返回 HTTP " + String(response.status) + "（模型 " + model + "）");
    }
    const data = (await response.json().catch(() => null)) as ApiChatReply | null;
    const picked = data !== null && data.choices !== undefined && data.choices.length > 0 ? data.choices[0] : undefined;
    const content = picked !== undefined && picked.message !== undefined ? picked.message.content : undefined;
    const raw = typeof content === "string" ? content : "";
    if (raw === "") {
      throw new AppError("INTERNAL", "翻译 API 响应缺少内容（模型 " + model + "）");
    }
    const finalText = finalizeTranslation(stripWrappingQuotes(raw), tokens);
    if (finalText === "") {
      throw new AppError("INTERNAL", "翻译 API 响应规整后为空（模型 " + model + "）");
    }
    return finalText;
  }
}

/** sha256 十六进制（译文库键）。 */
function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 语言名（system prompt 用）。 */
const LANG_NAMES: Record<TranslateLang, string> = { zh: "Simplified Chinese", en: "English" };

/** 拼 API 基址与路径（吞掉基址尾部斜杠；基址通常已含 /v1）。 */
function joinApiUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/** API 通道 system prompt：只出译文；占位符（Xq…Y）、数字与专名原样保留。 */
function buildSystemPrompt(source: TranslateLang, target: TranslateLang): string {
  return (
    "You are a translator for an internal robotics project-management system. " +
    "Translate the text from " + LANG_NAMES[source] + " to " + LANG_NAMES[target] + ". " +
    "Keep placeholder tokens that look like Xq followed by digits and ending with Y unchanged. " +
    "Keep numbers, codes, and proper nouns unchanged. " +
    "Output only the translation, without quotes, notes, or explanations."
  );
}

/** 去回包首尾成对引号（模型偶发把译文包进引号 / 书名号）。 */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  const pairs: ReadonlyArray<readonly [string, string]> = [["\u0022", "\u0022"], ["\u201c", "\u201d"], ["\u300c", "\u300d"], ["\u0027", "\u0027"]];
  for (const pair of pairs) {
    if (first === pair[0] && last === pair[1]) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}
