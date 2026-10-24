import { z } from "../zod.ts";
import { DateTimeSchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { StageKeySchema } from "../common/dicts.ts";

/**
 * 任务节点库与任务模板契约（系统功能书 A1-16 / A1-17；2026-09-19 定案，对齐项 A11）。
 * - 任务节点库（TaskNode）：一条「可生成任务的定义」——阶段 + 中英文名称 + 库内排序；是任务模板的节点来源。
 * - 任务模板（TaskTemplate）：名称 + 阶段 + 节点顺序（同一模板内按 nodeId 去重）；项目总览「添加任务」据此生成任务。
 * 与流程节点（ProjectNode / 蓝图）区分：这里回答「任务从哪来」，不是项目流程的节点实例。
 */

export const TaskNodeSchema = z
  .object({
    id: UuidSchema,
    stageKey: StageKeySchema,
    seq: z.number().int().positive().openapi({ description: "库内排序（建议 10/20/30 步长，便于插入）" }),
    title: z.string().openapi({ example: "货架组装", description: "节点名称（生成任务时写入任务描述）" }),
    titleEn: z.string().nullable().openapi({ example: "Shelf Assembly" }),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("TaskNode", { description: "任务节点库条目（任务模板的节点来源）" });

export const TaskNodeListQuerySchema = z.object({
  stage: StageKeySchema.optional().openapi({ description: "按阶段过滤；缺省 = 全部阶段" }),
});

/** 新增节点（管理端维护节点库；同阶段同名 409 NODE_ALREADY_EXISTS）。 */
export const TaskNodeCreateBodySchema = z
  .object({
    stageKey: StageKeySchema,
    title: z.string().min(1).max(200).openapi({ example: "货架组装", description: "节点名称（中文；同阶段内唯一）" }),
    titleEn: z.string().max(200).nullable().optional().openapi({ description: "英文名（可空）" }),
    seq: z.number().int().positive().optional().openapi({ description: "库内排序；缺省 = 追加到该阶段末尾（末位 seq + 10）" }),
  })
  .openapi("TaskNodeCreateBody", { description: "新增任务节点（管理端）" });

/**
 * 编辑节点（改名 / 英文名；不动的字段不传）：乐观锁 version 必传 —— 过期 409 VERSION_CONFLICT、
 * 改成同阶段已有的名字 409 NODE_ALREADY_EXISTS。
 */
export const TaskNodeUpdateBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({ example: "货架组装", description: "节点名称（中文；同阶段内唯一）" }),
    titleEn: z.string().max(200).nullable().optional().openapi({ description: "英文名（可空；显式 null = 清空）" }),
    version: VersionSchema,
  })
  .openapi("TaskNodeUpdateBody", { description: "编辑任务节点（改名 / 英文名；乐观锁 version 必传）" });

/** 节点物理删行结果（删除前快照写审计；不留软删标记 —— 与字典条目硬删同口径）。 */
export const TaskNodeDeleteResponseSchema = z
  .object({ id: UuidSchema, deleted: z.boolean() })
  .openapi("TaskNodeDeleteResponse");

export const TaskNodeListResponseSchema = z
  .object({ items: z.array(TaskNodeSchema), total: z.number().int().min(0) })
  .openapi("TaskNodeListResponse");

/** 模板内节点引用：数组顺序即模板内顺序；title / titleEn 随行下发，模板预览可直接渲染。 */
export const TaskTemplateNodeSchema = z
  .object({
    nodeId: UuidSchema,
    seq: z.number().int().positive(),
    title: z.string(),
    titleEn: z.string().nullable(),
  })
  .openapi("TaskTemplateNode", { description: "模板内节点（引用任务节点库 + 模板内顺序 + 名称摘要）" });

export const TaskTemplateSchema = z
  .object({
    id: UuidSchema,
    name: z.string().openapi({ example: "英国订单", description: "模板名称（列头可直接改名）" }),
    stageKey: StageKeySchema,
    nodes: z.array(TaskTemplateNodeSchema).openapi({ description: "节点顺序 = 数组顺序；同一模板内按 nodeId 去重" }),
    createdBy: UuidSchema.nullable().openapi({ description: "填写人 user id；存量种子 / 系统导入为空" }),
    createdByName: z.string().nullable().openapi({ description: "填写人姓名（users.display_name）；为空时界面显示系统" }),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("TaskTemplate", { description: "任务模板（名称 + 阶段 + 节点顺序 + 填写人；A1-16 / A1-17 的落点）" });

export const TaskTemplateListQuerySchema = z.object({
  stage: StageKeySchema.optional().openapi({ description: "按阶段过滤；缺省 = 全部阶段" }),
});

export const TaskTemplateListResponseSchema = z
  .object({ items: z.array(TaskTemplateSchema), total: z.number().int().min(0) })
  .openapi("TaskTemplateListResponse");

export const TaskTemplateCreateBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    stageKey: StageKeySchema,
    nodeIds: z
      .array(UuidSchema)
      .default([])
      .openapi({ description: "任务节点库内的节点 id，顺序即模板内顺序；允许空（新建后逐步添加）；重复 id 返回 400" }),
  })
  .openapi("TaskTemplateCreateBody");

export const TaskTemplateUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    nodeIds: z
      .array(UuidSchema)
      .optional()
      .openapi({ description: "全量替换节点顺序（含增删 / 重排）；同一模板内按 id 去重，重复 id 返回 400" }),
    version: VersionSchema,
  })
  .openapi("TaskTemplateUpdateBody", { description: "编辑模板（改名 / 节点全量替换；乐观锁 version 必传）" });

export const TaskTemplateDeleteBodySchema = z.object({ version: VersionSchema }).openapi("TaskTemplateDeleteBody");

export const TaskTemplateDeleteResponseSchema = z
  .object({ id: UuidSchema, deletedAt: DateTimeSchema })
  .openapi("TaskTemplateDeleteResponse", { description: "删除即生效；已生成的受影响项目任务不变" });

/** 类型别名（z.infer 单一真相）：服务端与前端只消费这里导出的类型。 */
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type TaskNodeListQuery = z.infer<typeof TaskNodeListQuerySchema>;
export type TaskNodeCreateBody = z.infer<typeof TaskNodeCreateBodySchema>;
export type TaskNodeDeleteResponse = z.infer<typeof TaskNodeDeleteResponseSchema>;
export type TaskNodeListResponse = z.infer<typeof TaskNodeListResponseSchema>;
export type TaskNodeUpdateBody = z.infer<typeof TaskNodeUpdateBodySchema>;

/** 模板侧别名（第二段落库：名称 + 阶段 + 节点顺序，全量替换 + 乐观锁）。 */
export type TaskTemplateNode = z.infer<typeof TaskTemplateNodeSchema>;
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export type TaskTemplateListQuery = z.infer<typeof TaskTemplateListQuerySchema>;
export type TaskTemplateListResponse = z.infer<typeof TaskTemplateListResponseSchema>;
export type TaskTemplateCreateBody = z.infer<typeof TaskTemplateCreateBodySchema>;
export type TaskTemplateUpdateBody = z.infer<typeof TaskTemplateUpdateBodySchema>;
export type TaskTemplateDeleteBody = z.infer<typeof TaskTemplateDeleteBodySchema>;
export type TaskTemplateDeleteResponse = z.infer<typeof TaskTemplateDeleteResponseSchema>;

