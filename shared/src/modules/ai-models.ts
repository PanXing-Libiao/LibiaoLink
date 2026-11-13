import { z } from "../zod.ts";
import { DateTimeSchema, UuidSchema } from "../common/conventions.ts";

const ModelServiceUrlSchema = z.string().trim().min(1).max(500).url().refine((value) => {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1] ?? "";
  return authority !== "" && !authority.includes("@") && !/[?#]/.test(value);
}, "请输入不含账号、密码或查询参数的 HTTP(S) 接口地址");

const fields = {
  name: z.string().trim().min(1).max(80),
  baseUrl: ModelServiceUrlSchema,
  apiKey: z.string().trim().max(1024).optional(),
};

export const AiModelProviderCreateSchema = z.object(fields).strict().openapi("AiModelProviderCreate");
export const AiModelProviderUpdateSchema = z.object({
  ...fields,
  clearApiKey: z.boolean().default(false),
  version: z.number().int().nonnegative(),
}).strict().openapi("AiModelProviderUpdate");

export const AiModelProviderSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  version: z.number().int().nonnegative(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
}).openapi("AiModelProvider");

export const AiModelSelectionSchema = z.object({
  providerId: UuidSchema,
  modelId: z.string(),
}).openapi("AiModelSelection");

export const AiModelSettingsSchema = z.object({
  providers: z.array(AiModelProviderSchema),
  active: AiModelSelectionSchema.nullable(),
}).openapi("AiModelSettings");

export const AiModelActivateSchema = z.object({
  providerId: UuidSchema,
  modelId: z.string().trim().min(1).max(200),
}).strict().openapi("AiModelActivate");

export const AiModelListSchema = z.object({
  models: z.array(z.string()),
}).openapi("AiModelList");

export type AiModelProviderCreate = z.infer<typeof AiModelProviderCreateSchema>;
export type AiModelProviderUpdate = z.infer<typeof AiModelProviderUpdateSchema>;
export type AiModelProvider = z.infer<typeof AiModelProviderSchema>;
export type AiModelSettings = z.infer<typeof AiModelSettingsSchema>;
export type AiModelActivate = z.infer<typeof AiModelActivateSchema>;
export type AiModelList = z.infer<typeof AiModelListSchema>;
