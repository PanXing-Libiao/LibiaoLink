import { z } from "../zod.ts";
import { UuidSchema } from "../common/conventions.ts";

export const CadNameCodepageSchema = z.enum(["UTF8", "GB"]).openapi("CadNameCodepage", {
  description: "STEP 名称编码：GB 中文旧编码（默认），UTF8 标准编码；由用户按文件选择，不自动猜测，不同编码分别缓存。",
});
export type CadNameCodepage = z.infer<typeof CadNameCodepageSchema>;

export const CadFormatSchema = z.enum(["STEP", "DXF"]).openapi("CadFormat");
export type CadFormat = z.infer<typeof CadFormatSchema>;

export const CadLogicalPathSchema = z.string().min(1).max(1024)
  .transform((value) => value.replaceAll("\\", "/"))
  .refine((value) => !/[\uD800-\uDFFF]/u.test(value) && !value.startsWith("/") && !/[\x00-\x1f\x7f:]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && /\.(dxf|dwg|shx|shp|ttf|otf|png|jpe?g|bmp|gif|tiff?|webp|pdf|dgn|dwf|dwfx|ctb|stb)$/i.test(value), "请选择资源集合内的相对文件路径")
  .openapi("CadLogicalPath", { description: "资源包内相对路径；保留目录，不允许绝对路径、上级目录、URL 或任意类型。" });

export const CadCompanionSchema = z.object({ fileId: UuidSchema, versionId: UuidSchema, path: CadLogicalPathSchema }).strict().openapi("CadCompanion");
export type CadCompanion = z.infer<typeof CadCompanionSchema>;
export const CadJobCreateBodySchema = z.object({
  mainPath: CadLogicalPathSchema.optional(),
  companions: z.array(CadCompanionSchema).max(127).default([]),
}).strict().superRefine((value, ctx) => {
  const paths = value.companions.map((item) => item.path);
  if (new Set(paths).size !== paths.length || value.mainPath && paths.includes(value.mainPath)) {
    ctx.addIssue({ code: "custom", message: "主图与配套文件路径不能重复" });
  }
}).openapi("CadJobCreateBody", { description: "DXF 主图与当前项目中明确选择的配套文件版本；缺省仅使用主图。STEP 不接受配套文件。资源选择变化创建独立产物身份。" });
export type CadJobCreateBody = z.infer<typeof CadJobCreateBodySchema>;

export const CadPreviewViewerSchema = z.object({
  kind: z.literal("cad"),
  fileId: UuidSchema,
  versionId: UuidSchema,
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.string(),
  sourceName: z.string(),
  format: CadFormatSchema,
  projectId: UuidSchema,
}).openapi("CadPreviewViewer", {
  description: "STEP / 二维 DXF 查看入口；模型就绪由 CAD 任务判定。每次读取重新校验主图与全部配套版本权限，不包含原文件签名。",
});

export const CadJobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  state: z.enum(["queued", "running", "completed", "partial", "failed", "cancelled", "timed-out"]),
  phase: z.string(),
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceByteLength: z.number().int().nonnegative(),
  nameCodepage: CadNameCodepageSchema.optional(),
  format: CadFormatSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  artifactBytes: z.number().int().nonnegative().optional(),
  workerPeakRSSBytes: z.number().int().nonnegative().optional(),
  workerWallSeconds: z.number().nonnegative().optional(),
  error: z.object({ code: z.string(), error: z.string().max(500) }).optional(),
}).openapi("CadJob", {
  description: "CAD 查看任务，产物可持久复用；窗口取消不取消共享后台任务。completed 发布完整产物；partial 仅用于有校验产物及缺失说明的 DXF，页面必须明确展示限制。STEP 保持完整性接收规则。",
});

export const CadJobCreateResponseSchema = z.object({ job: CadJobSchema, reused: z.boolean() }).openapi("CadJobCreateResponse");
