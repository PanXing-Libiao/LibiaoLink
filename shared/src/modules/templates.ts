import { z } from "../zod.ts";
import { DateTimeSchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { STAGE_KEYS, STAGE_NAMES } from "../common/dicts.ts";

const TASK_TEMPLATE_NODE_IDS_LIMIT = 500;

/**
 * 任务模板板块 key：九个项目阶段 + 「入库审核」特殊分组。
 * 入库审核只属于任务模板库，不是项目阶段，不能用于项目 / 任务 stageKey。
 */
export const TEMPLATE_SECTION_KEYS = [...STAGE_KEYS, "inbound_review"] as const;
export type TemplateSectionKey = (typeof TEMPLATE_SECTION_KEYS)[number];
export const TEMPLATE_SECTION_NAMES: Record<TemplateSectionKey, string> = {
  ...STAGE_NAMES,
  inbound_review: "入库审核",
};
export const TemplateSectionKeySchema = z.enum(TEMPLATE_SECTION_KEYS).openapi("TemplateSectionKey", {
  description: "任务模板板块 key：九阶段 + inbound_review（入库审核，不属于项目阶段）",
});

/**
 * 任务节点库与任务模板契约（系统功能书 A1-16 / A1-17；2026-09-19 定案，对齐项 A11）。
 * - 任务节点库（TaskNode）：一条「模板板块 + 中英文名称 + 库内排序」的定义；是任务模板的节点来源。
 * - 任务模板（TaskTemplate）：名称 + 板块 + 节点顺序（同一模板内按 nodeId 去重）；九阶段模板可供项目总览生成任务，入库审核只属于模板库。
 * 与流程节点（ProjectNode / 蓝图）区分：这里回答「任务从哪来」，不是项目流程的节点实例。
 */

export const TaskNodeSchema = z
  .object({
    id: UuidSchema,
    stageKey: TemplateSectionKeySchema,
    seq: z.number().int().positive().openapi({ description: "库内排序（建议 10/20/30 步长，便于插入）" }),
    title: z.string().openapi({ example: "货架组装", description: "节点名称（生成任务时写入任务描述）" }),
    titleEn: z.string().nullable().openapi({ example: "Shelf Assembly" }),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("TaskNode", { description: "任务节点库条目（任务模板的节点来源；stageKey 可为九阶段或入库审核）" });

export const TaskNodeListQuerySchema = z.object({
  stage: TemplateSectionKeySchema.optional().openapi({ description: "按模板板块过滤（九阶段或 inbound_review）；缺省 = 全部板块" }),
});

/** 新增节点（管理端维护节点库；同板块同名 409 NODE_ALREADY_EXISTS）。 */
export const TaskNodeCreateBodySchema = z
  .object({
    stageKey: TemplateSectionKeySchema,
    title: z.string().min(1).max(200).openapi({ example: "货架组装", description: "节点名称（中文；同板块内唯一）" }),
    titleEn: z.string().max(200).nullable().optional().openapi({ description: "英文名（可空）" }),
    seq: z.number().int().positive().optional().openapi({ description: "库内排序；缺省 = 追加到该板块末尾（末位 seq + 10）" }),
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

/**
 * 模板可见范围：private = 仅填写人可见；public = 有任务模板浏览权的账号均可见。
 * 创建时选择；创建后仅填写人本人可在模板编辑中调整，保存时走同一份 PATCH 契约。
 * 系统预置模板（createdBy 为空）没有填写人，任何人（包括管理员）都不能调整其可见范围。
 */
export const TaskTemplateVisibilitySchema = z
  .enum(["private", "public"])
  .openapi("TaskTemplateVisibility", { description: "模板可见范围：private = 仅填写人可见，public = 有浏览权的人可见" });

/** 模板内节点引用：数组顺序即模板内顺序；title / titleEn 随行下发，模板预览可直接渲染。 */
export const TaskTemplateNodeSchema = z
  .object({
    nodeId: UuidSchema,
    seq: z.number().int().positive(),
    title: z.string(),
    titleEn: z.string().nullable(),
  })
  .openapi("TaskTemplateNode", { description: "模板内节点（公共节点或该模板私有节点 + 模板内顺序 + 名称摘要）" });

/**
 * 在模板内新增私有节点：只属于当前模板，不写公共节点库。
 * 标题 / 英文名与公共节点同口径（标题 trim 后必填，英文名可空）；同模板内同名 409 NODE_ALREADY_EXISTS。
 */
export const TaskTemplateNodeCreateBodySchema = z
  .object({
    title: z.string().min(1).max(200).openapi({ example: "货架复检", description: "节点名称（当前模板内唯一）" }),
    titleEn: z.string().max(200).nullable().optional().openapi({ description: "英文名（可空）" }),
  })
  .openapi("TaskTemplateNodeCreateBody", { description: "在指定模板内新增私有节点（不进入公共节点库）" });

export const TaskTemplateSchema = z
  .object({
    id: UuidSchema,
    name: z.string().openapi({ example: "英国订单", description: "模板名称（列头可直接改名）" }),
    stageKey: TemplateSectionKeySchema,
    visibility: TaskTemplateVisibilitySchema.openapi({ description: "可见范围：private 仅填写人可见；public 有模板浏览权的人可见" }),
    nodes: z.array(TaskTemplateNodeSchema).openapi({ description: "节点顺序 = 数组顺序；同一模板内按 nodeId 去重" }),
    createdBy: UuidSchema.nullable().openapi({ description: "填写人 user id；存量种子 / 系统导入为空；系统预置模板没有填写人，任何人都不能调整其可见范围" }),
    createdByName: z.string().nullable().openapi({ description: "填写人姓名（users.display_name）；为空时界面显示系统配置填写人贾海洋" }),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("TaskTemplate", { description: "任务模板（名称 + 模板板块 + 可见范围 + 节点顺序 + 填写人；A1-16 / A1-17 的落点）" });

export const TaskTemplateListQuerySchema = z.object({
  stage: TemplateSectionKeySchema.optional().openapi({ description: "按模板板块过滤（九阶段或 inbound_review）；缺省 = 全部板块" }),
});

export const TaskTemplateListResponseSchema = z
  .object({ items: z.array(TaskTemplateSchema), total: z.number().int().min(0) })
  .openapi("TaskTemplateListResponse");

export const TaskTemplateCreateBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    stageKey: TemplateSectionKeySchema,
    visibility: TaskTemplateVisibilitySchema.default("public").openapi({ description: "可见范围；缺省 public（兼容旧客户端）。private = 仅填写人可见，public = 有模板浏览权的人可见" }),
    nodeIds: z
      .array(UuidSchema)
      .max(TASK_TEMPLATE_NODE_IDS_LIMIT)
      .default([])
      .openapi({ description: "任务节点库内的节点 id（≤ 500 个），顺序即模板内顺序；允许空（新建后逐步添加）；重复 id 返回 400" }),
  })
  .openapi("TaskTemplateCreateBody", { description: "新建任务模板（stageKey 为模板板块：九阶段或 inbound_review）；visibility 缺省 public（兼容旧客户端）" });

export const TaskTemplateUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    visibility: TaskTemplateVisibilitySchema.optional().openapi({
      description: "可见范围（可选）：private 仅填写人可见，public 有模板浏览权的人可见；只有填写人本人能实际切换，非填写人回传同值不视为切换；不传 = 保持原值",
    }),
    nodeIds: z
      .array(UuidSchema)
      .max(TASK_TEMPLATE_NODE_IDS_LIMIT)
      .optional()
      .openapi({ description: "全量替换节点顺序（≤ 500 个，含增删 / 重排）；同一模板内按 id 去重，重复 id 返回 400" }),
    version: VersionSchema,
  })
  .openapi("TaskTemplateUpdateBody", { description: "编辑模板（改名 / 可见范围 / 节点全量替换；乐观锁 version 必传）" });

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

/** 模板侧别名（第二段落库：名称 + 阶段 + 可见范围 + 节点顺序；可见范围与节点顺序均可随编辑更新，乐观锁必传）。 */
export type TaskTemplateVisibility = z.infer<typeof TaskTemplateVisibilitySchema>;
export type TaskTemplateNode = z.infer<typeof TaskTemplateNodeSchema>;
export type TaskTemplateNodeCreateBody = z.infer<typeof TaskTemplateNodeCreateBodySchema>;
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;
export type TaskTemplateListQuery = z.infer<typeof TaskTemplateListQuerySchema>;
export type TaskTemplateListResponse = z.infer<typeof TaskTemplateListResponseSchema>;
export type TaskTemplateCreateBody = z.infer<typeof TaskTemplateCreateBodySchema>;
export type TaskTemplateUpdateBody = z.infer<typeof TaskTemplateUpdateBodySchema>;
export type TaskTemplateDeleteBody = z.infer<typeof TaskTemplateDeleteBodySchema>;
export type TaskTemplateDeleteResponse = z.infer<typeof TaskTemplateDeleteResponseSchema>;

