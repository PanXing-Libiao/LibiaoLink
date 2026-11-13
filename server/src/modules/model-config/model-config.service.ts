import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { AiModelActivate, AiModelList, AiModelProvider, AiModelProviderCreate, AiModelProviderUpdate, AiModelSettings } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { AuditService } from "../audit/index.js";
import { ModelConfigRepository, type AiModelProviderRow } from "./model-config.repository.js";
import { decryptModelKey, encryptModelKey } from "./model-secret.js";

export type ActiveModelConnection = { baseUrl: string; apiKey: string; modelId: string };

function publicProvider(row: AiModelProviderRow): AiModelProvider {
  return {
    id: row.id, name: row.name, baseUrl: row.baseUrl, hasApiKey: row.apiKeyEncrypted !== null,
    version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function canonicalUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

@Injectable()
export class ModelConfigService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly repository: ModelConfigRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AiModelSettings> {
    const [providers, active] = await Promise.all([this.repository.list(), this.repository.selection()]);
    return { providers: providers.map(publicProvider), active };
  }

  async create(input: AiModelProviderCreate, actorId: string): Promise<AiModelProvider> {
    const id = randomUUID();
    const encrypted = input.apiKey ? encryptModelKey(this.config.env.MODEL_CONFIG_ENCRYPTION_KEY, id, input.apiKey) : null;
    return this.database.db.transaction(async (tx) => {
      const row = await this.repository.insert(id, {
        name: input.name, baseUrl: canonicalUrl(input.baseUrl), apiKeyEncrypted: encrypted, updatedBy: actorId,
      }, tx);
      await this.audit.record(tx, {
        actorId, action: "create", objectType: "ai_model_provider", objectId: id,
        summary: "新增模型服务：" + row.name, metadata: { hasApiKey: encrypted !== null },
      });
      return publicProvider(row);
    });
  }

  async update(id: string, input: AiModelProviderUpdate, actorId: string): Promise<AiModelProvider> {
    if (input.clearApiKey && input.apiKey) throw new AppError("VALIDATION_FAILED", "不能同时输入和清除密钥");
    return this.database.db.transaction(async (tx) => {
      const before = await this.repository.find(id, tx);
      if (before === null) throw new AppError("NOT_FOUND", "模型服务不存在");
      if (before.version !== input.version) throw new AppError("VERSION_CONFLICT", "模型服务已更新，请刷新后重试");
      const baseUrl = canonicalUrl(input.baseUrl);
      if (baseUrl !== before.baseUrl && before.apiKeyEncrypted !== null && !input.apiKey && !input.clearApiKey) {
        throw new AppError("VALIDATION_FAILED", "修改接口地址时，请重新输入密钥或明确清除原密钥");
      }
      const encrypted = input.clearApiKey ? null : input.apiKey
        ? encryptModelKey(this.config.env.MODEL_CONFIG_ENCRYPTION_KEY, id, input.apiKey)
        : before.apiKeyEncrypted;
      const row = await this.repository.update(id, input.version, { name: input.name, baseUrl, apiKeyEncrypted: encrypted, updatedBy: actorId }, tx);
      if (row === null) throw new AppError("VERSION_CONFLICT", "模型服务已更新，请刷新后重试");
      await this.audit.record(tx, {
        actorId, action: "update", objectType: "ai_model_provider", objectId: id,
        summary: "更新模型服务：" + row.name, metadata: { credentialChanged: Boolean(input.apiKey || input.clearApiKey) },
      });
      return publicProvider(row);
    });
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const before = await this.repository.find(id, tx);
      if (before === null || !(await this.repository.remove(id, tx))) throw new AppError("NOT_FOUND", "模型服务不存在");
      await this.audit.record(tx, {
        actorId, action: "delete", objectType: "ai_model_provider", objectId: id,
        summary: "删除模型服务：" + before.name,
      });
    });
  }

  async activate(input: AiModelActivate, actorId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const provider = await this.repository.find(input.providerId, tx);
      if (provider === null) throw new AppError("NOT_FOUND", "模型服务不存在");
      await this.repository.activate(provider.id, input.modelId, actorId, tx);
      await this.audit.record(tx, {
        actorId, action: "update", objectType: "ai_model_provider", objectId: provider.id,
        summary: "切换系统模型：" + provider.name + " / " + input.modelId,
        metadata: { modelId: input.modelId },
      });
    });
  }

  async models(id: string): Promise<AiModelList> {
    const provider = await this.repository.find(id);
    if (provider === null) throw new AppError("NOT_FOUND", "模型服务不存在");
    const apiKey = provider.apiKeyEncrypted === null ? "" : decryptModelKey(this.config.env.MODEL_CONFIG_ENCRYPTION_KEY, id, provider.apiKeyEncrypted);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey !== "") headers.Authorization = "Bearer " + apiKey;
    let response: Response;
    try {
      response = await fetch(provider.baseUrl + "/models", {
        headers, redirect: "error", signal: AbortSignal.timeout(this.config.env.TRANSLATE_TIMEOUT_MS),
      });
    } catch {
      throw new AppError("VALIDATION_FAILED", "无法连接模型服务，请检查接口地址和网络");
    }
    if (!response.ok) throw new AppError("VALIDATION_FAILED", "获取模型列表失败（HTTP " + response.status + "），请检查地址和密钥");
    let data: unknown;
    try { data = await response.json(); } catch { throw new AppError("VALIDATION_FAILED", "模型服务返回的列表格式无效"); }
    if (data === null || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) {
      throw new AppError("VALIDATION_FAILED", "模型服务未返回兼容的模型列表");
    }
    const models = new Set<string>();
    for (const item of data.data) {
      if (item !== null && typeof item === "object" && "id" in item && typeof item.id === "string") {
        const name = item.id.trim();
        if (name !== "" && name.length <= 200) models.add(name);
      }
    }
    return { models: [...models].sort((a, b) => a.localeCompare(b)) };
  }

  async active(): Promise<ActiveModelConnection | null> {
    const active = await this.repository.active();
    if (active === null) return null;
    return {
      baseUrl: active.provider.baseUrl, modelId: active.modelId,
      apiKey: active.provider.apiKeyEncrypted === null ? "" :
        decryptModelKey(this.config.env.MODEL_CONFIG_ENCRYPTION_KEY, active.provider.id, active.provider.apiKeyEncrypted),
    };
  }
}
