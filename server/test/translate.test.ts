/**
 * 翻译落库回归（§6.16 ㉕ · Push 301）：译文库优先短路 / 未命中调引擎并落库 / 术语保护与回换在服务端 /
 * 引擎故障 INTERNAL / 批量只读查库（绝不调引擎）/ 保存链路预热（CJK 过滤 + 同文本去重 + 失败静默）。
 * Push 310 增补：翻译 API 主模型 → 备用模型接力（deepseek 断流 → gemini-3.8-flash）。
 * 真机口径见 server/src/modules/translate/README.md。
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/config.module.js";
import type {
  ContentTranslationHitRow,
  ContentTranslationRow,
  ContentTranslationUpsert,
  TranslateRepository,
} from "../src/modules/translate/translate.repository.js";
import { TranslateService } from "../src/modules/translate/translate.service.js";

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

class FakeTranslationRepository {
  rows = new Map<string, { sourceText: string; translatedText: string; engine: string }>();
  upsertCalls: ContentTranslationUpsert[] = [];
  lookupCalls: string[][] = [];

  private key(sourceLang: string, targetLang: string, hash: string): string {
    return sourceLang + "|" + targetLang + "|" + hash;
  }

  async findByHash(sourceLang: string, targetLang: string, hash: string): Promise<ContentTranslationRow | null> {
    const row = this.rows.get(this.key(sourceLang, targetLang, hash));
    return row ?? null;
  }

  async findManyByHashes(sourceLang: string, targetLang: string, hashes: readonly string[]): Promise<ContentTranslationHitRow[]> {
    this.lookupCalls.push([...hashes]);
    const out: ContentTranslationHitRow[] = [];
    for (const hash of hashes) {
      const row = this.rows.get(this.key(sourceLang, targetLang, hash));
      if (row !== undefined) {
        out.push({ sourceHash: hash, translatedText: row.translatedText });
      }
    }
    return out;
  }

  async upsert(input: ContentTranslationUpsert, _at: Date): Promise<void> {
    this.upsertCalls.push(input);
    this.rows.set(this.key(input.sourceLang, input.targetLang, input.sourceHash), {
      sourceText: input.sourceText,
      translatedText: input.translatedText,
      engine: input.engine,
    });
  }
}

/** 完整 env 替身（含 Push 309/310 的 provider / API / 备用模型字段；用例只覆盖关心的键）。 */
function makeEnv(overrides: Record<string, unknown>): AppConfig["env"] {
  return {
    TRANSLATE_ORIGIN: "http://translate.test:5008",
    TRANSLATE_TIMEOUT_MS: 20000,
    TRANSLATE_PROVIDER: "local",
    TRANSLATE_API_BASE_URL: "",
    TRANSLATE_API_MODEL: "",
    TRANSLATE_API_MODEL_FALLBACK: "",
    TRANSLATE_API_KEY: "",
    TRANSLATE_FALLBACK_ORIGIN: "",
    ...overrides,
  } as unknown as AppConfig["env"];
}

const config = { env: makeEnv({}) } as unknown as AppConfig;
const openAiConfig = {
  env: makeEnv({ TRANSLATE_PROVIDER: "openai", TRANSLATE_API_BASE_URL: "https://api.example/v1", TRANSLATE_API_MODEL: "deepseek-chat", TRANSLATE_API_KEY: "sk-test" }),
} as unknown as AppConfig;
const openAiFallbackConfig = {
  env: makeEnv({ TRANSLATE_PROVIDER: "openai", TRANSLATE_API_BASE_URL: "https://api.example/v1", TRANSLATE_API_MODEL: "deepseek-chat", TRANSLATE_FALLBACK_ORIGIN: "http://fallback.test:5008" }),
} as unknown as AppConfig;
const openAiModelFallbackConfig = {
  env: makeEnv({ TRANSLATE_PROVIDER: "openai", TRANSLATE_API_BASE_URL: "https://api.example/v1", TRANSLATE_API_MODEL: "deepseek-chat", TRANSLATE_API_MODEL_FALLBACK: "gemini-3.8-flash" }),
} as unknown as AppConfig;
const openAiModelFallbackSameConfig = {
  env: makeEnv({ TRANSLATE_PROVIDER: "openai", TRANSLATE_API_BASE_URL: "https://api.example/v1", TRANSLATE_API_MODEL: "deepseek-chat", TRANSLATE_API_MODEL_FALLBACK: "deepseek-chat" }),
} as unknown as AppConfig;

function makeServiceWith(cfg: AppConfig): { repository: FakeTranslationRepository; service: TranslateService } {
  const repository = new FakeTranslationRepository();
  const service = new TranslateService(cfg, repository as unknown as TranslateRepository);
  return { repository, service };
}

function makeService(): { repository: FakeTranslationRepository; service: TranslateService } {
  return makeServiceWith(config);
}

/** fetch 替身：记录每次发往引擎的 q 并回包。 */
function stubEngineReply(reply: (q: string) => { status?: number; payload?: unknown; throwError?: boolean }): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { q?: unknown };
    const q = typeof body.q === "string" ? body.q : "";
    calls.push(q);
    const outcome = reply(q);
    if (outcome.throwError === true) {
      throw new Error("engine down");
    }
    return new Response(JSON.stringify(outcome.payload ?? { translatedText: "" }), {
      status: outcome.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TranslateService.translate（库优先 + 引擎兜底落库）", () => {
  it("译文库命中：直接返回，不调引擎、不重复写", async () => {
    const { repository, service } = makeService();
    repository.rows.set("zh|en|" + hashOf("任务一"), { sourceText: "任务一", translatedText: "Task one", engine: "hy-mt-1.5-1.8b" });
    const engine = stubEngineReply(() => ({ payload: { translatedText: "SHOULD NOT BE CALLED" } }));
    await expect(service.translate("任务一", "zh", "en")).resolves.toBe("Task one");
    expect(engine.calls).toHaveLength(0);
    expect(repository.upsertCalls).toHaveLength(0);
  });

  it("未命中：发原文的术语保护形态到引擎，回包回换 + 落库（键 = sha256(原文)）", async () => {
    const { repository, service } = makeService();
    const engine = stubEngineReply((q) => ({ payload: { translatedText: q } }));
    const final = await service.translate("基督城仓配中心扩建", "zh", "en");
    expect(engine.calls).toHaveLength(1);
    const sent = engine.calls[0] ?? "";
    expect(sent).not.toContain("基督城");
    expect(sent).toContain("Xq");
    expect(final).toContain("Christchurch");
    expect(final).toContain("Warehouse and Distribution Center");
    expect(final).not.toContain("Xq");
    expect(repository.upsertCalls).toHaveLength(1);
    const written = repository.upsertCalls[0];
    expect(written?.sourceText).toBe("基督城仓配中心扩建");
    expect(written?.sourceHash).toBe(hashOf("基督城仓配中心扩建"));
    expect(written?.translatedText).toBe(final);
    expect(written?.engine).toBe("hy-mt-1.5-1.8b");
  });

  it("整句全大写回包（小模型偶发）：规整成句首大写后落库", async () => {
    const { service, repository } = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "ACCEPTANCE REPORT SUBMITTED" } }));
    const final = await service.translate("验收报告已提交", "zh", "en");
    expect(final).toBe("Acceptance report submitted");
    expect(repository.upsertCalls[0]?.translatedText).toBe("Acceptance report submitted");
  });

  it("引擎 HTTP 失败 / 网络异常：抛 AppError INTERNAL，不落库", async () => {
    const first = makeService();
    stubEngineReply(() => ({ status: 502 }));
    await expect(first.service.translate("任务二", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(first.repository.upsertCalls).toHaveLength(0);

    const second = makeService();
    stubEngineReply(() => ({ throwError: true }));
    await expect(second.service.translate("任务三", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("引擎回包缺 translatedText：抛 INTERNAL", async () => {
    const { service } = makeService();
    stubEngineReply(() => ({ payload: {} }));
    await expect(service.translate("任务四", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("TranslateService.lookup（批量只读查库）", () => {
  it("按哈希去重查库、命中按请求序返回、未命中跳过、不调引擎", async () => {
    const { repository, service } = makeService();
    repository.rows.set("zh|en|" + hashOf("甲"), { sourceText: "甲", translatedText: "A", engine: "hy-mt-1.5-1.8b" });
    repository.rows.set("zh|en|" + hashOf("乙"), { sourceText: "乙", translatedText: "B", engine: "hy-mt-1.5-1.8b" });
    const engine = stubEngineReply(() => ({ payload: { translatedText: "SHOULD NOT BE CALLED" } }));
    const hits = await service.lookup(["甲", "丙", "乙", "甲"], "zh", "en");
    expect(hits).toEqual([
      { q: "甲", translatedText: "A" },
      { q: "乙", translatedText: "B" },
    ]);
    expect(engine.calls).toHaveLength(0);
    expect(repository.lookupCalls).toHaveLength(1);
    expect(repository.lookupCalls[0]).toHaveLength(3);
  });

  it("空入参：直接返回空表（查库层对空表短路，替身收到空哈希数组）", async () => {
    const { repository, service } = makeService();
    await expect(service.lookup([], "zh", "en")).resolves.toEqual([]);
    expect(repository.lookupCalls).toEqual([[]]);
  });
});

describe("TranslateService.warmup（保存即后台翻译）", () => {
  it("只排中文文本（去空去重），后台翻好落库；重复调用在去重窗口内不再排队", async () => {
    const { repository, service } = makeService();
    const engine = stubEngineReply((q) => ({ payload: { translatedText: q } }));
    service.warmup(["任务甲", "plain ascii", "", "任务甲", "   "]);
    await vi.waitFor(() => {
      expect(repository.upsertCalls).toHaveLength(1);
    });
    expect(engine.calls).toHaveLength(1);
    service.warmup(["任务甲"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.calls).toHaveLength(1);
    expect(repository.upsertCalls).toHaveLength(1);
  });

  it("已入库条目跳过（不调引擎）；引擎失败静默不抛错", async () => {
    const seeded = makeService();
    seeded.repository.rows.set("zh|en|" + hashOf("已翻文本"), { sourceText: "已翻文本", translatedText: "Done", engine: "hy-mt-1.5-1.8b" });
    const okEngine = stubEngineReply((q) => ({ payload: { translatedText: q } }));
    seeded.service.warmup(["已翻文本"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(okEngine.calls).toHaveLength(0);
    expect(seeded.repository.upsertCalls).toHaveLength(0);

    vi.unstubAllGlobals();
    const failing = makeService();
    stubEngineReply(() => ({ throwError: true }));
    failing.service.warmup(["失败文本"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failing.repository.upsertCalls).toHaveLength(0);
  });
});

/** 路由替身（Push 309/310）：/chat/completions 走 API 形态（并记录 body.model，供主 / 备模型断言），其余走本地引擎形态；记录 url / 授权头 / 模型 / 发出文本。 */
function stubFetchRouter(options: {
  api: (q: string, model: string) => { status?: number; content?: unknown; throwError?: boolean };
  local?: (q: string) => { status?: number; payload?: unknown; throwError?: boolean };
}): { calls: Array<{ url: string; authorization: string | null; model: string; q: string }> } {
  const calls: Array<{ url: string; authorization: string | null; model: string; q: string }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as { q?: unknown; model?: unknown; messages?: Array<{ role?: string; content?: unknown }> };
    if (url.includes("/chat/completions")) {
      const last = body.messages === undefined ? undefined : body.messages[body.messages.length - 1];
      const q = last !== undefined && typeof last.content === "string" ? last.content : "";
      const model = typeof body.model === "string" ? body.model : "";
      calls.push({ url, authorization: headers.get("Authorization"), model, q });
      const outcome = options.api(q, model);
      if (outcome.throwError === true) {
        throw new Error("api down");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: outcome.content ?? "" } }] }), {
        status: outcome.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const q = typeof body.q === "string" ? body.q : "";
    calls.push({ url, authorization: headers.get("Authorization"), model: "", q });
    const outcome = options.local === undefined ? undefined : options.local(q);
    if (outcome !== undefined && outcome.throwError === true) {
      throw new Error("engine down");
    }
    return new Response(JSON.stringify(outcome?.payload ?? { translatedText: "" }), {
      status: outcome?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

describe("TranslateService（Push 309/310 · provider 可插拔：API 主通道（主模型 → 备用模型接力）+ 本地兜底）", () => {
  it("provider=openai：发 /chat/completions（Bearer + 术语保护形态），回包规整回换后落库 engine=api:<模型>", async () => {
    const { repository, service } = makeServiceWith(openAiConfig);
    const router = stubFetchRouter({ api: (q) => ({ content: q }) });
    const final = await service.translate("基督城仓配中心扩建", "zh", "en");
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.url).toBe("https://api.example/v1/chat/completions");
    expect(router.calls[0]?.authorization).toBe("Bearer sk-test");
    expect(router.calls[0]?.q).toContain("Xq");
    expect(final).toContain("Warehouse and Distribution Center");
    expect(final).not.toContain("Xq");
    expect(repository.upsertCalls[0]?.engine).toBe("api:deepseek-chat");
  });

  it("provider=openai + 兜底：API 失败改调本地引擎（engine 标记回落 hy-mt-1.5-1.8b）", async () => {
    const { repository, service } = makeServiceWith(openAiFallbackConfig);
    const router = stubFetchRouter({ api: () => ({ throwError: true }), local: (q) => ({ payload: { translatedText: q } }) });
    const final = await service.translate("基督城扩建", "zh", "en");
    expect(router.calls).toHaveLength(2);
    expect(router.calls[0]?.url).toBe("https://api.example/v1/chat/completions");
    expect(router.calls[1]?.url).toBe("http://fallback.test:5008/translate");
    expect(final).toContain("Christchurch");
    expect(repository.upsertCalls[0]?.engine).toBe("hy-mt-1.5-1.8b");
  });

  it("Push 310 备用模型：主模型 HTTP 失败自动接力（两次调用模型依次为 deepseek-chat / gemini-3.8-flash，落库 engine 按实际产出模型）", async () => {
    const { repository, service } = makeServiceWith(openAiModelFallbackConfig);
    const router = stubFetchRouter({
      api: (q, model) => (model === "deepseek-chat" ? { status: 500 } : { content: q }),
    });
    const final = await service.translate("基督城仓配中心扩建", "zh", "en");
    expect(router.calls).toHaveLength(2);
    expect(router.calls[0]?.model).toBe("deepseek-chat");
    expect(router.calls[1]?.model).toBe("gemini-3.8-flash");
    expect(router.calls[1]?.q).toBe(router.calls[0]?.q ?? "");
    expect(final).toContain("Christchurch");
    expect(final).not.toContain("Xq");
    expect(repository.upsertCalls[0]?.engine).toBe("api:gemini-3.8-flash");
  });

  it("Push 310 备用模型：主模型成功即返回（不调备用，只 1 次调用）", async () => {
    const { service } = makeServiceWith(openAiModelFallbackConfig);
    const router = stubFetchRouter({ api: (q) => ({ content: q }) });
    await service.translate("基督城扩建", "zh", "en");
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.model).toBe("deepseek-chat");
  });

  it("Push 310 备用模型：两跳都失败 → 抛 INTERNAL、不落库（未配本地兜底时）", async () => {
    const { repository, service } = makeServiceWith(openAiModelFallbackConfig);
    const router = stubFetchRouter({ api: () => ({ throwError: true }) });
    await expect(service.translate("任务八", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(router.calls).toHaveLength(2);
    expect(router.calls[0]?.model).toBe("deepseek-chat");
    expect(router.calls[1]?.model).toBe("gemini-3.8-flash");
    expect(repository.upsertCalls).toHaveLength(0);
  });

  it("Push 310 备用模型：备用留空 → 不接力（只 1 次调用）；备用与主同名 → 同样不接力", async () => {
    const noFallback = makeServiceWith(openAiConfig);
    const routerA = stubFetchRouter({ api: () => ({ status: 502 }) });
    await expect(noFallback.service.translate("任务九", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(routerA.calls).toHaveLength(1);
    expect(routerA.calls[0]?.model).toBe("deepseek-chat");
    expect(noFallback.repository.upsertCalls).toHaveLength(0);

    const sameFallback = makeServiceWith(openAiModelFallbackSameConfig);
    const routerB = stubFetchRouter({ api: () => ({ status: 502 }) });
    await expect(sameFallback.service.translate("任务十", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(routerB.calls).toHaveLength(1);
    expect(routerB.calls[0]?.model).toBe("deepseek-chat");
  });

  it("Push 310 备用模型 + 本地兜底：两跳都失败 → 改调本地引擎（engine 回落 hy-mt-1.5-1.8b）", async () => {
    const cfg = {
      env: makeEnv({ TRANSLATE_PROVIDER: "openai", TRANSLATE_API_BASE_URL: "https://api.example/v1", TRANSLATE_API_MODEL: "deepseek-chat", TRANSLATE_API_MODEL_FALLBACK: "gemini-3.8-flash", TRANSLATE_FALLBACK_ORIGIN: "http://fallback.test:5008" }),
    } as unknown as AppConfig;
    const { repository, service } = makeServiceWith(cfg);
    const router = stubFetchRouter({ api: () => ({ throwError: true }), local: (q) => ({ payload: { translatedText: q } }) });
    const final = await service.translate("基督城扩建", "zh", "en");
    expect(router.calls).toHaveLength(3);
    expect(router.calls[0]?.model).toBe("deepseek-chat");
    expect(router.calls[1]?.model).toBe("gemini-3.8-flash");
    expect(router.calls[2]?.url).toBe("http://fallback.test:5008/translate");
    expect(final).toContain("Christchurch");
    expect(repository.upsertCalls[0]?.engine).toBe("hy-mt-1.5-1.8b");
  });

  it("provider=openai 无兜底：API 失败抛 INTERNAL，不落库", async () => {
    const { repository, service } = makeServiceWith(openAiConfig);
    stubFetchRouter({ api: () => ({ throwError: true }) });
    await expect(service.translate("任务六", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(repository.upsertCalls).toHaveLength(0);
  });

  it("provider=openai 未配置 base/model：抛 INTERNAL（静默降级口径不变）", async () => {
    const { service } = makeServiceWith({ env: makeEnv({ TRANSLATE_PROVIDER: "openai" }) } as unknown as AppConfig);
    const router = stubFetchRouter({ api: () => ({ content: "SHOULD NOT BE CALLED" }) });
    await expect(service.translate("任务七", "zh", "en")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(router.calls).toHaveLength(0);
  });
});

describe("TranslateService（Push 311 · 句首大写规整）", () => {
  it("小写开头回包（API / 小模型偶发）：句首转大写后落库", async () => {
    const { service, repository } = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "in dire straits" } }));
    const final = await service.translate("陷入困境", "zh", "en");
    expect(final).toBe("In dire straits");
    expect(repository.upsertCalls[0]?.translatedText).toBe("In dire straits");
  });

  it("品牌词形态开头（iPhone / eBay 类）：不误伤小写首字母", async () => {
    const first = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "iPhone 15 protective case inventory" } }));
    await expect(first.service.translate("iPhone 15 保护壳库存", "zh", "en")).resolves.toBe("iPhone 15 protective case inventory");

    vi.unstubAllGlobals();
    const second = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "eBay storefront listing" } }));
    await expect(second.service.translate("eBay 店铺上架", "zh", "en")).resolves.toBe("eBay storefront listing");
  });

  it("已句首大写 / 数字开头：保持原样（幂等）", async () => {
    const first = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "Commissioning completed" } }));
    await expect(first.service.translate("调试完成", "zh", "en")).resolves.toBe("Commissioning completed");

    vi.unstubAllGlobals();
    const second = makeService();
    stubEngineReply(() => ({ payload: { translatedText: "12 units shipped" } }));
    await expect(second.service.translate("发运 12 台", "zh", "en")).resolves.toBe("12 units shipped");
  });

  it("引擎把占位符一并小写且置于句首：仍回换术语 + 句首大写", async () => {
    const { service } = makeService();
    stubEngineReply((q) => ({ payload: { translatedText: q.toLowerCase() } }));
    const final = await service.translate("基督城仓配中心扩建", "zh", "en");
    expect(final.startsWith("Christchurch")).toBe(true);
    expect(final).toContain("Warehouse and Distribution Center");
    expect(final.toLowerCase()).not.toContain("xq");
  });
});
