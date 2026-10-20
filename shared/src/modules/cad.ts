import { z } from "../zod.ts";
import { UuidSchema } from "../common/conventions.ts";

export const CadPreviewViewerSchema = z.object({
  kind: z.literal("cad"),
  fileId: UuidSchema,
  versionId: UuidSchema,
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.string(),
}).openapi("CadPreviewViewer", {
  description: "STEP 查看入口；模型就绪由独立 CAD 任务状态判定。每次模型/资源读取重新校验文件版本权限，不包含原文件签名。",
});

export const CadJobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  state: z.enum(["queued", "running", "completed", "failed", "cancelled", "timed-out"]),
  phase: z.string(),
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceByteLength: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  artifactBytes: z.number().int().nonnegative().optional(),
  workerPeakRSSBytes: z.number().int().nonnegative().optional(),
  workerWallSeconds: z.number().nonnegative().optional(),
  error: z.object({ code: z.string(), error: z.string().max(500) }).optional(),
}).openapi("CadJob", {
  description: "隔离且持久化的 STEP 任务；completed 只发布完整校验产物，已列举 nonMeshableFaces 保留，Partial 不算完整成功。",
});

export const CadJobCreateResponseSchema = z.object({ job: CadJobSchema, reused: z.boolean() }).openapi("CadJobCreateResponse");
