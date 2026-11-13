import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/config.module.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditService } from "../src/modules/audit/index.js";
import { ModelConfigService } from "../src/modules/model-config/index.js";
import { ModelConfigRepository, type AiModelProviderRow, type ProviderWrite } from "../src/modules/model-config/model-config.repository.js";
import { decryptModelKey, encryptModelKey } from "../src/modules/model-config/model-secret.js";
import { ImportNodeMatcher } from "../src/modules/project-import/import-node-matcher.js";
import { TranslateService } from "../src/modules/translate/translate.service.js";

const actor = "11111111-1111-4111-8111-111111111111";
const key = Buffer.alloc(32, 7).toString("base64");

function harness() {
  const records = new Map<string, AiModelProviderRow>();
  let selected: { providerId: string; modelId: string } | null = null;
  const repository = {
    async list() { return [...records.values()]; },
    async find(id: string) { return records.get(id) ?? null; },
    async insert(id: string, input: ProviderWrite) {
      const row: AiModelProviderRow = { id, ...input, version: 0, createdAt: new Date(), updatedAt: new Date(), createdBy: actor };
      records.set(id, row); return row;
    },
    async update(id: string, version: number, input: ProviderWrite) {
      const row = records.get(id);
      if (!row || row.version !== version) return null;
      const updated = { ...row, ...input, version: version + 1, updatedAt: new Date() };
      records.set(id, updated); return updated;
    },
    async remove(id: string) { if (selected?.providerId === id) selected = null; return records.delete(id); },
    async selection() { return selected; },
    async active() {
      if (selected === null) return null;
      const provider = records.get(selected.providerId);
      return provider ? { provider, modelId: selected.modelId } : null;
    },
    async activate(providerId: string, modelId: string) { selected = { providerId, modelId }; },
  };
  const config = { env: { MODEL_CONFIG_ENCRYPTION_KEY: key, TRANSLATE_TIMEOUT_MS: 1000 } } as AppConfig;
  const database = { db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } } as unknown as DatabaseService;
  const auditRecords: unknown[] = [];
  const audit = { record: async (_tx: unknown, input: unknown) => { auditRecords.push(input); } } as unknown as AuditService;
  const service = new ModelConfigService(config, database, repository as unknown as ModelConfigRepository, audit);
  return { service, records, auditRecords };
}

afterEach(() => vi.unstubAllGlobals());

describe("模型服务配置", () => {
  it("加密保存密钥，识别模型并只返回安全字段，支持多服务切换", async () => {
    const h = harness();
    const one = await h.service.create({ name: "服务一", baseUrl: "https://one.example/v1/", apiKey: "test-secret-one" }, actor);
    const two = await h.service.create({ name: "服务二", baseUrl: "https://two.example/v1", apiKey: "test-secret-two" }, actor);
    const stored = h.records.get(one.id)!;
    expect(stored.apiKeyEncrypted).not.toContain("test-secret-one");
    expect(decryptModelKey(key, one.id, stored.apiKeyEncrypted!)).toBe("test-secret-one");
    expect(() => decryptModelKey(key, two.id, stored.apiKeyEncrypted!)).toThrow("模型服务密钥无法读取");
    expect(JSON.stringify(await h.service.list())).not.toContain("test-secret");
    expect(JSON.stringify(h.auditRecords)).not.toContain("test-secret");

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await h.service.models(one.id)).toEqual({ models: ["model-a", "model-b"] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://one.example/v1/models");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-secret-one");
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");

    await h.service.activate({ providerId: one.id, modelId: "model-a" }, actor);
    expect(await h.service.active()).toEqual({ baseUrl: "https://one.example/v1", apiKey: "test-secret-one", modelId: "model-a" });
    await h.service.activate({ providerId: two.id, modelId: "model-b" }, actor);
    expect((await h.service.active())?.modelId).toBe("model-b");
    await h.service.remove(two.id, actor);
    expect(await h.service.active()).toBeNull();
  });

  it("更换地址需重新输入或清除密钥；版本冲突不能覆盖", async () => {
    const h = harness();
    const provider = await h.service.create({ name: "服务", baseUrl: "https://one.example/v1", apiKey: "test-secret" }, actor);
    await expect(h.service.update(provider.id, { name: "服务", baseUrl: "https://other.example/v1", version: 0, clearApiKey: false }, actor))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const updated = await h.service.update(provider.id, { name: "服务", baseUrl: "https://other.example/v1", version: 0, clearApiKey: true }, actor);
    expect(updated.hasApiKey).toBe(false);
    await expect(h.service.update(provider.id, { name: "服务", baseUrl: "https://other.example/v1", version: 0, clearApiKey: false }, actor))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("未配置加密密钥时不能保存 API Key", async () => {
    expect(() => encryptModelKey("", actor, "test-secret")).toThrow("模型密钥保护尚未配置");
  });

  it("导入匹配和翻译使用同一启用模型", async () => {
    const h = harness();
    const provider = await h.service.create({ name: "共享服务", baseUrl: "https://model.example/v1", apiKey: "test-key" }, actor);
    await h.service.activate({ providerId: provider.id, modelId: "shared-chat" }, actor);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const content = String(body.messages[0].content).includes("translator")
        ? "Power test"
        : JSON.stringify({ matches: [{ index: 0, decision: "match", nodeId: "node-1" }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { env: {
      TRANSLATE_PROVIDER: "local", TRANSLATE_ORIGIN: "http://old.local",
      TRANSLATE_API_BASE_URL: "", TRANSLATE_API_MODEL: "", TRANSLATE_API_KEY: "", TRANSLATE_TIMEOUT_MS: 1000,
    } } as AppConfig;
    const matcher = new ImportNodeMatcher(cfg, h.service);
    const matches = await matcher.match([{ index: 0, stageKey: "install", title: "上电检查", titleEn: null }],
      [{ id: "node-1", stageKey: "install", title: "通电测试", titleEn: null, version: 1 }]);
    expect(matches.get(0)).toEqual({ kind: "semantic", nodeId: "node-1" });
    const translations = { findByHash: async () => null, upsert: async () => {} };
    const translate = new TranslateService(cfg, translations as never, h.service);
    expect(await translate.translate("通电测试", "zh", "en")).toBe("Power test");
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://model.example/v1/chat/completions");
      expect(JSON.parse(String(init?.body)).model).toBe("shared-chat");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    }
  });
});
