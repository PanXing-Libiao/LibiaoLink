import { z } from "../zod.ts";
import { DateTimeSchema, DateOnlySchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { BlueprintStatusSchema, DocTypeSchema, NodeOriginSchema, NodeStatusSchema, STAGE_KEYS, StageKeySchema, StageStatusSchema } from "../common/dicts.ts";

const BLUEPRINT_STAGE_NODE_LIMIT = 200;
const BLUEPRINT_NODE_CONSTRAINT_LIMIT = 20;

/**
 * 蓝图与流程节点契约（v0.2 §3）。
 * 蓝图 = 项目全流程蓝图（九阶段 + 节点 + 约束），自建 JSON 格式；导出 / 导入 round-trip 无损。
 */

export const BlueprintRequiredDocConstraintSchema = z
  .object({
    type: z.literal("required_doc"),
    docType: DocTypeSchema,
    minCount: z.number().int().min(1).default(1),
  })
  .openapi("BlueprintRequiredDocConstraint", { description: "必交成果物（一期门禁实现的唯一约束类型）" });

/** field / dependency / deadline：一期仅结构就位，规则后置（Q28 定细则）。 */
export const BlueprintReservedConstraintSchema = z
  .object({
    type: z.enum(["field", "dependency", "deadline"]),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi("BlueprintReservedConstraint", { description: "预留约束类型（结构就位、规则后置）" });

export const BlueprintConstraintSchema = z
  .union([BlueprintRequiredDocConstraintSchema, BlueprintReservedConstraintSchema])
  .openapi("BlueprintConstraint");

export const BlueprintNodeSchema = z
  .object({
    key: z.string().openapi({ example: "design.mech", description: "节点稳定键；一经发布不可改名（改名 = 新增 + 废弃）" }),
    name: z.string().openapi({ example: "机械设计图纸" }),
    seq: z.number().int().positive().openapi({ description: "排序（建议 10/20/30 步长，便于插入）" }),
    constraints: z.array(BlueprintConstraintSchema).max(BLUEPRINT_NODE_CONSTRAINT_LIMIT).default([]).openapi({
      description: "节点约束（≤ 20 条）",
    }),
  })
  .openapi("BlueprintNode", { description: "每个节点至少一类约束（校验规则见 v0.2 §3.4）" });

export const BlueprintStageSchema = z
  .object({
    key: StageKeySchema,
    name: z.string(),
    seq: z.number().int().positive(),
    nodes: z.array(BlueprintNodeSchema).min(1).max(BLUEPRINT_STAGE_NODE_LIMIT).openapi({ description: "阶段节点（1~200 个）" }),
  })
  .openapi("BlueprintStage");

export const BlueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    blueprintVersion: z.number().int().positive(),
    name: z.string(),
    projectType: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .openapi({ description: "所属项目类型（ADR-019：按项目类型各一份，default 为兜底模板）；缺省 = 通用" }),
    updatedAt: DateTimeSchema,
    stages: z.array(BlueprintStageSchema).min(1).max(STAGE_KEYS.length).openapi({ description: "蓝图阶段（1~9 个，键取九阶段字典）" }),
  })
  .openapi("Blueprint", { description: "自建蓝图 JSON（v0.2 §3.2 + ADR-019）；导入校验 = schema + 引用 + 幂等" });

export const BlueprintViewSchema = z
  .object({
    blueprint: BlueprintSchema,
    status: BlueprintStatusSchema,
    projectType: z.string().openapi({ description: "所属项目类型（ADR-019）" }),
    isDefault: z.boolean().openapi({ description: "是否兜底默认模板（project_type = default）" }),
    publishedVersion: z.number().int().min(0).openapi({ description: "已发布版本号（0 = 尚未发布）" }),
    publishedAt: DateTimeSchema.nullable(),
    publishedBy: UuidSchema.nullable(),
  })
  .openapi("BlueprintView");

export const NodeRequirementSchema = z
  .object({
    requirementType: z.enum(["required_doc", "field", "dependency", "deadline"]),
    docType: DocTypeSchema.nullable(),
    minCount: z.number().int().min(1),
  })
  .openapi("NodeRequirement", { description: "节点约束实例（node_requirements）" });

export const ProjectNodeSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    stageId: UuidSchema,
    nodeKey: z.string(),
    name: z.string(),
    seq: z.number(),
    status: NodeStatusSchema,
    origin: NodeOriginSchema,
    doneAt: DateTimeSchema.nullable(),
    doneBy: UuidSchema.nullable(),
    sourceBlueprintVersion: z.number().int().positive(),
    version: VersionSchema,
    requirements: z.array(NodeRequirementSchema),
  })
  .openapi("ProjectNode");

export const ProjectStageSchema = z
  .object({
    id: UuidSchema,
    stageKey: StageKeySchema,
    name: z.string(),
    seq: z.number().int().positive(),
    status: StageStatusSchema,
    plannedStart: DateOnlySchema.nullable(),
    plannedEnd: DateOnlySchema.nullable(),
    actualStart: DateOnlySchema.nullable(),
    actualEnd: DateOnlySchema.nullable(),
    nodes: z.array(ProjectNodeSchema),
  })
  .openapi("ProjectStage");

export const ProjectFlowSchema = z
  .object({
    projectId: UuidSchema,
    blueprintVersion: z.number().int().min(0).openapi({ description: "项目导入时的蓝图版本（快照）；0 = 尚未导入（h3 之前建的项目）" }),
    stages: z.array(ProjectStageSchema),
  })
  .openapi("ProjectFlow", { description: "项目流程（阶段 + 节点 + 约束 + 状态）；导入即快照" });

/** 完成门禁未通过时的 missing 明细（HTTP 422 + code=NODE_REQUIRED_DOC_MISSING）。 */
export const NodeGateMissingSchema = z
  .object({
    docType: DocTypeSchema,
    required: z.number().int().min(1),
    present: z.number().int().min(0),
  })
  .openapi("NodeGateMissing", { description: "缺件明细（门禁拒绝时会一次性返回）" });

export const NodeCompleteBodySchema = z.object({ version: VersionSchema }).openapi("NodeCompleteBody");

export const NodeCompleteResponseSchema = z.object({ node: ProjectNodeSchema }).openapi("NodeCompleteResponse");

export const CanCompleteResponseSchema = z
  .object({
    canComplete: z.boolean(),
    missing: z.array(NodeGateMissingSchema),
  })
  .openapi("CanCompleteResponse", { description: "完成预检（UI 置灰依据；服务端仍在事务内强校验）" });

export const NodeCreateBodySchema = z
  .object({
    stageId: UuidSchema,
    nodeKey: z.string().openapi({ description: "模板节点池内的节点稳定键（一期仅允许项目导入版本的蓝图 key）" }),
    name: z.string().max(200).optional(),
    seq: z.number().positive().optional(),
    reason: z.string().max(500).optional().openapi({ description: "增补原因（留痕；ADR-020）" }),
  })
  .openapi("NodeCreateBody", { description: "新增节点（仅模板节点池，留痕）" });

export const NodeDeleteBodySchema = z
  .object({
    version: VersionSchema,
    reason: z.string().min(1).max(500).openapi({ description: "删除原因（必填并留痕；ADR-020）" }),
  })
  .openapi("NodeDeleteBody");

export const BlueprintSaveBodySchema = z.object({ blueprint: BlueprintSchema }).openapi("BlueprintSaveBody", {
  description: "保存蓝图草稿（必须通过 schema + 引用校验）",
});

export const BlueprintImportBodySchema = z.object({ blueprint: BlueprintSchema }).openapi("BlueprintImportBody", {
  description: "导入自建蓝图 JSON（保存为草稿；重复导入幂等）",
});

/** 蓝图读取 / 维护的 projectType 维度（ADR-019）：缺省 = default 兜底模板。 */
export const BlueprintQuerySchema = z.object({
  projectType: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .openapi({ description: "项目类型（ADR-019）；缺省 = default 兜底模板" }),
});

/** 阶段推进 / 回退（M2-03 · ADR-023；缺项明细走 422 STAGE_GATE_NOT_PASSED 的 details）。 */
export const StageProgressSchema = z
  .object({
    total: z.number().int().min(0),
    done: z.number().int().min(0),
  })
  .openapi("StageProgress", { description: "阶段完成度（读时派生，不落库）：已完成 ÷ 总数" });

export const ProjectStageSummarySchema = z
  .object({
    id: UuidSchema,
    stageKey: StageKeySchema,
    name: z.string(),
    seq: z.number().int().positive(),
    status: StageStatusSchema,
    plannedStart: DateOnlySchema.nullable(),
    plannedEnd: DateOnlySchema.nullable(),
    actualStart: DateOnlySchema.nullable(),
    actualEnd: DateOnlySchema.nullable(),
    nodes: StageProgressSchema,
    tasks: StageProgressSchema,
    advancedAt: DateTimeSchema.nullable(),
    advancedBy: UuidSchema.nullable(),
    rolledBackAt: DateTimeSchema.nullable(),
    rolledBackBy: UuidSchema.nullable(),
    rollbackReason: z.string().nullable(),
    version: VersionSchema,
  })
  .openapi("ProjectStageSummary", { description: "阶段状态与完成度（GET /projects/{id}/stages）" });

export const StageListResponseSchema = z
  .object({
    projectId: UuidSchema,
    stageKey: StageKeySchema,
    stages: z.array(ProjectStageSummarySchema),
  })
  .openapi("StageListResponse");

export const StageAdvanceBodySchema = z
  .object({ version: VersionSchema })
  .openapi("StageAdvanceBody", { description: "推进当前阶段：过门禁才生效；失败 422 STAGE_GATE_NOT_PASSED + 缺项明细（不部分推进）" });

export const StageRollbackBodySchema = z
  .object({
    reason: z.string().min(1).max(500).openapi({ description: "回退原因（必填并留痕；ADR-023）" }),
    version: VersionSchema,
  })
  .openapi("StageRollbackBody", { description: "回退到相邻上一阶段：仅相邻、无门禁、原因必填；projects.stage_key 回移" });
