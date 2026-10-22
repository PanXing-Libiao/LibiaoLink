import { z } from "../zod.ts";
import { UuidSchema } from "../common/conventions.ts";

export const CadNameCodepageSchema = z.enum(["UTF8", "GB"]).openapi("CadNameCodepage", {
  description: "STEP 名称编码：GB 中文旧编码（默认），UTF8 标准编码；由用户按文件选择，不自动猜测，不同编码分别缓存。",
});
export type CadNameCodepage = z.infer<typeof CadNameCodepageSchema>;

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
  nameCodepage: CadNameCodepageSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  artifactBytes: z.number().int().nonnegative().optional(),
  workerPeakRSSBytes: z.number().int().nonnegative().optional(),
  workerWallSeconds: z.number().nonnegative().optional(),
  error: z.object({ code: z.string(), error: z.string().max(500) }).optional(),
}).openapi("CadJob", {
  description: "文件版本的 CAD 查看任务；后台在独立沙箱转换并将完整产物持久保存，API/worker/CAD 重启后可复用。窗口取消不取消共享后台解析。completed 只发布完整校验产物，已列举 nonMeshableFaces 保留，Partial 不算完整成功。",
});

export const CadJobCreateResponseSchema = z.object({ job: CadJobSchema, reused: z.boolean() }).openapi("CadJobCreateResponse");
