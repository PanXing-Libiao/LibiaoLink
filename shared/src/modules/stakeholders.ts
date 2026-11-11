import { z } from "../zod.ts";
import { DateTimeSchema, PageQuerySchema, SortQuerySchema, UuidSchema, paginated } from "../common/conventions.ts";

/**
 * 干系人台账契约（j6 · S8·stakeholder · A5-01 ~ A5-07）。
 * 口径来源：系统功能书.md A5-01 ~ A5-07、C3-04、C3-08；技术设计v0.2 §2.3 / §4.1；技术设计v0.3 §3.7（M6-04）。
 * 表口径见 database/migrations/0019_stakeholders.sql。
 *
 * 隐私字段（A5-07 / C3-08）：联系方式（phone / wechat / email）需 stakeholder.contact.view、company / title 需 stakeholder.view、
 * role（干系人角色，A5-01）未登记字段级策略 —— 登录且可见即返回（与 name / companyType 同档）；
 * remark 需 stakeholder.manage —— 无权时服务端**不返回该键**（不做打码，契约侧一律 optional），页面 / 导出 / 搜索 / 消息同一策略（五出口同源）。
 */

/** 公司分类（A5-02）：立镖机器人 / 供应商 / 总包单位 / 客户；可另在 company 补充具体公司名称。 */
export const STAKEHOLDER_COMPANY_TYPES = ["libiao", "supplier", "general_contractor", "customer"] as const;

export const StakeholderCompanyTypeSchema = z.enum(STAKEHOLDER_COMPANY_TYPES).openapi("StakeholderCompanyType", {
  description: "公司分类（A5-02）：libiao 立镖机器人 / supplier 供应商 / general_contractor 总包单位 / customer 客户",
});

export const STAKEHOLDER_COMPANY_TYPE_NAMES: Record<(typeof STAKEHOLDER_COMPANY_TYPES)[number], string> = {
  libiao: "立镖机器人",
  supplier: "供应商",
  general_contractor: "总包单位",
  customer: "客户",
};

export type StakeholderCompanyType = z.infer<typeof StakeholderCompanyTypeSchema>;

/** 干系人关联的项目（A5-03 按干系人反查参与项目）：只带展示必需的三项，详情走项目接口。 */
export const StakeholderProjectRefSchema = z
  .object({
    id: UuidSchema,
    code: z.string().openapi({ description: "项目编号（projects.code）" }),
    name: z.string().openapi({ description: "项目名称" }),
  })
  .openapi("StakeholderProjectRef", { description: "干系人关联的项目（按干系人反查参与项目）" });

/**
 * 干系人（A5-01 台账）。
 * name / companyType / createdBy 等未登记字段级策略，登录且可见即可返回；company / title / phone / wechat / email / remark 按字段级策略裁剪。
 */
export const StakeholderSchema = z
  .object({
    id: UuidSchema,
    name: z.string().openapi({ description: "干系人姓名" }),
    companyType: StakeholderCompanyTypeSchema,
    company: z.string().nullable().optional().openapi({ description: "具体公司名称（A5-02）；需 stakeholder.view，无权时**键不存在**，有权限但空为 null" }),
    title: z.string().nullable().optional().openapi({ description: "职务 / 责任板块；需 stakeholder.view，无权时键不存在" }),
    phone: z.string().nullable().optional().openapi({ description: "电话（含 WhatsApp）；需 stakeholder.contact.view，无权时键不存在（A5-07）" }),
    wechat: z.string().nullable().optional().openapi({ description: "微信号；需 stakeholder.contact.view，无权时键不存在（A5-07）" }),
    email: z.string().nullable().optional().openapi({ description: "邮箱；需 stakeholder.contact.view，无权时键不存在（A5-07）" }),
    remark: z.string().nullable().optional().openapi({ description: "备注；需 stakeholder.manage，无权时键不存在" }),
    role: z.string().nullable().openapi({ description: "干系人角色（A5-01 · Push 225 增列）；自由文本，未登记字段级策略 —— 与姓名 / 公司分类同档：登录且可见即返回，空为 null" }),
    createdBy: UuidSchema.nullable().openapi({ description: "录入人 users.id（A5-04 销售端口）；系统导入为空" }),
    createdByName: z.string().nullable().openapi({ description: "录入人显示名（清单「填写者」列）" }),
    projects: z.array(StakeholderProjectRefSchema).max(1).openapi({ description: "所属项目（一期单项目归属；数组为前端兼容，最多 1 项）" }),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema.openapi({ description: "最近更新时间（A5-01「最近更新时间」）" }),
  })
  .openapi("Stakeholder", { description: "干系人台账条目；联系方式等隐私字段按字段级策略裁剪（C3-08，不返回而非打码）" });

/** 新增干系人（A5-01 / A5-04）：stakeholder.manage；判重提示口径 = 姓名 + 手机号（A5-05，仅提示不阻断）。 */
export const StakeholderCreateBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    companyType: StakeholderCompanyTypeSchema,
    company: z.string().min(1).max(120).optional().openapi({ description: "具体公司名称；不传则空" }),
    title: z.string().min(1).max(80).optional(),
    phone: z.string().min(1).max(40).optional(),
    wechat: z.string().min(1).max(64).optional(),
    email: z.string().max(120).optional().openapi({ description: "邮箱（格式校验在服务端软校验，避免历史数据误拦）" }),
    remark: z.string().min(1).max(500).optional(),
    role: z.string().min(1).max(80).optional().openapi({ description: "干系人角色；不传则空" }),
    projectIds: z.array(UuidSchema).min(1).max(1).openapi({ description: "所属项目：每条干系人记录必须且只能归属一个项目；项目不存在 404" }),
  })
  .openapi("StakeholderCreateBody", { description: "新增干系人：变更写审计留痕（对象 = stakeholder）；判重提示（姓名 + 手机号）随批量导入（A5-05，lan 线 M8-01）落地，本切片不阻断" });

/** 更新干系人（PATCH 合并语义）：只传变更键；null 表示清空。 */
export const StakeholderUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    companyType: StakeholderCompanyTypeSchema.optional(),
    company: z.string().max(120).nullable().optional(),
    title: z.string().max(80).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    wechat: z.string().max(64).nullable().optional(),
    email: z.string().max(120).nullable().optional(),
    remark: z.string().max(500).nullable().optional(),
    role: z.string().max(80).nullable().optional(),
  })
  .openapi("StakeholderUpdateBody", { description: "更新干系人（部分更新；null = 清空该字段）：变更写审计留痕（字段级 before / after）" });

/** 列表查询：关键词（姓名 / 公司 / 职务）+ 公司分类 + 项目筛选 + 分页 / 排序。 */
export const StakeholderListQuerySchema = PageQuerySchema.extend({
  q: z.string().max(80).optional().openapi({ description: "关键词：姓名 / 公司 / 职务前缀匹配（大小写不敏感）" }),
  "filter[companyType]": z.string().optional().openapi({ description: "公司分类，多值逗号分隔（A5-02）" }),
  "filter[projectId]": UuidSchema.optional().openapi({ description: "只看该项目关联的干系人（A5-03 按项目查看联系人清单）" }),
  sort: SortQuerySchema.optional().openapi({ description: "排序白名单：updatedAt / createdAt / name；缺省 updatedAt:desc（A5-01 最近更新在前）" }),
}).openapi("StakeholderListQuery", { description: "干系人台账列表查询（记录级可见集由数据范围与项目关联决定）" });

export const StakeholderListResponseSchema = paginated(StakeholderSchema).openapi("StakeholderListResponse");

export type StakeholderProjectRef = z.infer<typeof StakeholderProjectRefSchema>;

/** 删除响应：软删只回标记，不回整行（前端列表本地移除即可）。 */
export const StakeholderDeleteResponseSchema = z
  .object({ id: UuidSchema, deleted: z.boolean().openapi({ description: "恒为 true（软删：deleted_at 置位）" }) })
  .openapi("StakeholderDeleteResponse", { description: "干系人删除结果（软删，不物理删行）" });
export type Stakeholder = z.infer<typeof StakeholderSchema>;
export type StakeholderCreateBody = z.infer<typeof StakeholderCreateBodySchema>;
export type StakeholderUpdateBody = z.infer<typeof StakeholderUpdateBodySchema>;
export type StakeholderListQuery = z.infer<typeof StakeholderListQuerySchema>;
export type StakeholderListResponse = z.infer<typeof StakeholderListResponseSchema>;
export type StakeholderDeleteResponse = z.infer<typeof StakeholderDeleteResponseSchema>;
