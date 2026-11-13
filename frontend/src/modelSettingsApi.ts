import { apiRequest, apiSend } from "./api";

export type ModelProvider = {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ModelSettings = {
  providers: ModelProvider[];
  active: { providerId: string; modelId: string } | null;
};

type ProviderInput = { name: string; baseUrl: string; apiKey?: string };

export function loadModelSettings(): Promise<ModelSettings> {
  return apiRequest<ModelSettings>("/api/v1/model-settings");
}

export function createModelProvider(input: ProviderInput): Promise<ModelProvider> {
  return apiSend<ModelProvider>("/api/v1/model-settings/providers", "POST", input);
}

export function updateModelProvider(id: string, input: ProviderInput & { version: number; clearApiKey: boolean }): Promise<ModelProvider> {
  return apiSend<ModelProvider>("/api/v1/model-settings/providers/" + encodeURIComponent(id), "PUT", input);
}

export function deleteModelProvider(id: string): Promise<void> {
  return apiSend<void>("/api/v1/model-settings/providers/" + encodeURIComponent(id), "DELETE");
}

export function loadProviderModels(id: string): Promise<{ models: string[] }> {
  return apiRequest<{ models: string[] }>("/api/v1/model-settings/providers/" + encodeURIComponent(id) + "/models", { method: "GET" });
}

export function activateSystemModel(providerId: string, modelId: string): Promise<void> {
  return apiSend<void>("/api/v1/model-settings/active", "PUT", { providerId, modelId });
}
