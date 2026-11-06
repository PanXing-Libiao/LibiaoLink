import { z } from "../zod.ts";
import { DateTimeSchema } from "../common/conventions.ts";

/**
 * 字典类型（A3）：一期只下发「可运营数据字典」（业务会变的主数据）。
 * 阶段 / 内置十类成果文件类型 / 紧急重要度仍属契约枚举，唯一来源是 shared/src/common/dicts.ts；
 * deliverableType 只承载项目经理新增的全站自定义成果名称，避免同一事实两处来源（v0.1 复盘头号问题）。
 */
export const CUSTOM_DELIVERABLE_DICT_TYPE = "deliverableType" as const;

export const DICT_TYPES = ["region", "projectType", CUSTOM_DELIVERABLE_DICT_TYPE] as const;

export const DictTypeSchema = z.enum(DICT_TYPES).openapi("DictType", {
  description: "字典类型：region 地区 / projectType 项目类型 / deliverableType 全站自定义成果文件类型；未知类型返回 404",
});

export const DictItemSchema = z
  .object({
    code: z.string().openapi({ description: "字典码（projects.region / projects.projectType 存该值）" }),
    name: z.string().openapi({ description: "显示名" }),
    sort: z.number().int().openapi({ description: "展示顺序（升序）" }),
    enabled: z
      .boolean()
      .openapi({ description: "是否启用；**兼容字段**（Push 173 起产品口径：删除走 DELETE 物理删除，前端不再有停用入口；值恒为 true）—— 保留给二期「临时下架」与存量数据" }),
    usageCount: z.number().int().openapi({
      description:
        "引用该条目的**未删除项目**数（region → projects.region、projectType → projects.project_type；其余字典维度恒 0）；> 0 时删除返回 409 DICT_ITEM_IN_USE（A3 删除守卫，Push 174），前端据此把删除入口置灰",
    }),
    metadata: z.record(z.string(), z.unknown()).openapi({
      description:
        "字典元数据；projectType 必含 accent（CSS 颜色字符串，如 #3b82f6）；另有 accentText（徽标文字色，可缺省，缺省按 #fff 处理；浅色底如品牌黄 #feca04 用深灰 #313033）。前端据此渲染，不硬编码",
    }),
  })
  .openapi("DictItem");

export const DictSchema = z
  .object({
    type: DictTypeSchema,
    items: z.array(DictItemSchema),
    updatedAt: DateTimeSchema,
  })
  .openapi("Dict", { description: "单个字典（含元数据）；响应带 ETag，前端启动拉一次、登出清缓存" });

export const DictListResponseSchema = z
  .object({
    items: z.array(DictSchema),
  })
  .openapi("DictListResponse", { description: "全量字典：region / projectType / deliverableType 全站自定义成果文件类型" });


/**
 * 字典读取参数（GET /dicts 与 GET /dicts/{type} 共用）：管理端带 includeDisabled=true 查看停用项（**兼容参数** ——
 * Push 173 起产品不再产生停用项：删除 = DELETE 物理删除；保留给二期「临时下架」）。
 */
export const DictReadQuerySchema = z
  .object({
    includeDisabled: z.enum(["true", "false"]).optional().openapi({
      description: "是否包含停用项（缺省 / false = 只见 enabled=true）；true 需要 dict.manage（缺权限 403）；兼容参数，见字段说明",
    }),
  })
  .openapi("DictReadQuery", {
    description: "字典读取参数：includeDisabled=true 用于管理端查看停用项（兼容保留；Push 173 起删除 = DELETE 物理删除，不再产生停用项）",
  });

/**
 * 新增字典条目：**region = 任何登录用户**（地区是全站共享的公共标签，C9-02 修订 —— 非管理员新增同样全站可见、
 * 可在首页按它筛选）；**其余类型（projectType）= 仅管理员 dict.manage**。码建后不可改（存量数据按码引用）。
 */
export const DictItemCreateBodySchema = z
  .object({
    code: z.string().min(1).max(64).openapi({ description: "字典码：同类型内唯一；重复返回 409 DICT_ITEM_EXISTS" }),
    name: z.string().min(1).max(80).openapi({ description: "显示名" }),
    sort: z.number().int().min(0).default(0).openapi({ description: "展示顺序（升序）；缺省 0" }),
    enabled: z.boolean().default(true).openapi({ description: "是否启用；缺省 true" }),
    metadata: z.record(z.string(), z.unknown()).default({}).openapi({ description: "字典元数据（projectType 必含 accent）" }),
  })
  .openapi("DictItemCreateBody", {
    description:
      "新增字典条目：region 任何登录用户可增（全站共享；重复码 409）；projectType 仅管理员 dict.manage；deliverableType 的自定义成果由项目经理走 POST /projects/{id}/deliverable-types（本通用端点仍仅 dict.manage）；变更写审计留痕（C9-02）；响应为更新后的整个字典",
  });

/**
 * 更新字典条目（仅管理员 · dict.manage）：PATCH 合并语义；code 不可改。
 * **删除走 DELETE 接口（物理删除，见 /dicts/{type}/items/{code} 的 delete）**；`enabled` 为兼容字段（二期临时下架用）。
 */
/**
 * 删除字典条目（**物理删除** · 仅管理员 dict.manage）：DELETE /dicts/{type}/items/{code}。
 * 删除 = 从 dict_items 直接删行，不保留停用位；删除前快照写审计（action = delete，objectId = "{type}:{code}"，C7-02）。
 * **引用守卫（A3 · Push 174）**：条目正被未删除项目引用（projects.region / project_type 命中，见 DictItem.usageCount > 0）时
 * 拒绝删除 —— 409 DICT_ITEM_IN_USE，不落审计、不改动任何行；前端不复刻判定，一律以服务端为准（缓存陈旧时同样被拦）。
 * 未知类型 / 未知条目 404；响应为更新后的整个字典。删除后同码可重新新增：按全新条目处理（本次颜色、排到末尾，界面无「恢复」提示）。
 */
export const DictItemUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    sort: z.number().int().min(0).optional(),
    enabled: z.boolean().optional().openapi({ description: "启用状态（兼容字段；一期删除走 DELETE 物理删除，前端不再调它）" }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("DictItemUpdateBody", {
    description: "更新字典条目（只传变更键）；本次变更写审计（含字段级 before / after，C9-02 / C7-02）",
  });


/** 字典类型 / 条目 / 字典的类型别名（前端与 handler 直接用；与 permissions.ts 同风格）。 */
export type DictType = z.infer<typeof DictTypeSchema>;
export type DictItem = z.infer<typeof DictItemSchema>;
export type Dict = z.infer<typeof DictSchema>;
export type DictListResponse = z.infer<typeof DictListResponseSchema>;
export type DictReadQuery = z.infer<typeof DictReadQuerySchema>;
export type DictItemCreateBody = z.infer<typeof DictItemCreateBodySchema>;
export type DictItemUpdateBody = z.infer<typeof DictItemUpdateBodySchema>;
