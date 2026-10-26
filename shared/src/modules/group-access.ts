import { DateTimeSchema, UuidSchema } from "../common/conventions.ts";
import { z } from "../zod.ts";
import { UserStatusSchema } from "./users.ts";

/**
 * 部门（Casdoor 群组）访问规则（2026-10-24）：
 * 部门键统一为 owner/name（例如 libiaorobot.com/项目部）。群组限制开启后，所有登录账号都可以
 * 进入页面；每条规则用 projectScope 限定数据范围，并用 accessLevel 区分编辑 / 仅浏览（edit 隐含 view）。
 * 多部门规则取并集：任一适用规则为 edit 才获得写能力，否则只读；项目范围由部门规则裁决。
 * allowedPages 仅保留为旧客户端兼容字段，裁决时恒为全部页面。
 */
/** 页面键保留用于旧客户端兼容；2026-10-24 起群组规则不再限制页面入口。 */
export const GROUP_ACCESS_PAGE_KEYS = ["dashboard", "projects", "templates", "workspace", "files", "audit"] as const;

/** 虚拟「未分组」节点：仅聚合当前没有任何部门成员关系的账号，不是 Casdoor 群组。 */
export const GROUP_ACCESS_UNGROUPED_KEY = "__ungrouped__";

export const GROUP_ACCESS_UNGROUPED_NAME = "未分组";

export const GroupAccessPageSchema = z
  .enum(GROUP_ACCESS_PAGE_KEYS)
  .openapi("GroupAccessPage", { description: "页面键（旧客户端兼容）：dashboard / projects / templates / workspace / files / audit；群组规则恒放行全部页面" });

export type GroupAccessPage = z.infer<typeof GroupAccessPageSchema>;

export const GROUP_ACCESS_PROJECT_SCOPES = ["all", "own", "selected", "none"] as const;

export const GroupAccessProjectScopeSchema = z
  .enum(GROUP_ACCESS_PROJECT_SCOPES)
  .openapi("GroupAccessProjectScope", { description: "部门项目范围：all 全部项目 / own 仅本人负责或参与的项目 / selected 仅指定项目 / none 不可见任何项目" });

export type GroupAccessProjectScope = z.infer<typeof GroupAccessProjectScopeSchema>;

export const GROUP_ACCESS_ACCESS_LEVELS = ["edit", "view"] as const;

export const GroupAccessAccessLevelSchema = z
  .enum(GROUP_ACCESS_ACCESS_LEVELS)
  .openapi("GroupAccessAccessLevel", { description: "部门权限档位：edit 可编辑并浏览 / view 仅浏览；edit 隐含 view，存量规则默认 view" });

export type GroupAccessAccessLevel = z.infer<typeof GroupAccessAccessLevelSchema>;

export const GROUP_ACCESS_MEMBER_SCOPES = ["all", "selected"] as const;

export const GroupAccessMemberScopeSchema = z
  .enum(GROUP_ACCESS_MEMBER_SCOPES)
  .openapi("GroupAccessMemberScope", { description: "部门规则适用人员：all 全部门 / selected 仅勾选人员" });

export type GroupAccessMemberScope = z.infer<typeof GroupAccessMemberScopeSchema>;

/** 部门人员：权限页通讯录展示用；来源 = 已同步的 Casdoor 群组成员关系 + 系统用户。 */
export const GroupAccessMemberSchema = z
  .object({
    userId: UuidSchema,
    username: z.string().openapi({ description: "工号（users.username）" }),
    displayName: z.string().openapi({ description: "姓名（users.display_name）" }),
    email: z.string().nullable(),
    status: UserStatusSchema,
  })
  .openapi("GroupAccessMember", { description: "部门人员（姓名 / 工号 / 邮箱 / 状态）" });

export type GroupAccessMember = z.infer<typeof GroupAccessMemberSchema>;

export const GroupAccessRuleInputSchema = z
  .object({
    groupKey: z.string().trim().min(1).max(200).openapi({ example: "libiaorobot.com/项目部" }),
    groupName: z.string().trim().min(1).max(200).optional(),
    allowedPages: z.array(GroupAccessPageSchema).max(GROUP_ACCESS_PAGE_KEYS.length).optional().default([...GROUP_ACCESS_PAGE_KEYS]),
    projectScope: GroupAccessProjectScopeSchema,
    accessLevel: GroupAccessAccessLevelSchema.default("view").openapi({ description: "edit = 可编辑并浏览；view = 仅浏览。projectScope=none 时恒为 view" }),
    projectIds: z.array(UuidSchema).max(2000).default([]),
    memberScope: GroupAccessMemberScopeSchema.default("all").openapi({ description: "all = 全部门；selected = 仅 memberUserIds" }),
    memberUserIds: z.array(UuidSchema).max(2000).default([]).openapi({ description: "selected 时生效的直属人员 user id" }),
  })
  .openapi("GroupAccessRuleInput", { description: "保存群组访问规则：项目范围 + 编辑/仅浏览 + 指定项目 + 适用人员（selected 时生效）；allowedPages 兼容旧客户端且不再产生页面限制" });

export type GroupAccessRuleInput = z.infer<typeof GroupAccessRuleInputSchema>;

export const GroupAccessRuleSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    allowedPages: z.array(GroupAccessPageSchema).openapi({ description: "旧客户端兼容字段；恒返回全部页面" }),
    projectScope: GroupAccessProjectScopeSchema,
    accessLevel: GroupAccessAccessLevelSchema,
    projectIds: z.array(UuidSchema),
    memberScope: GroupAccessMemberScopeSchema,
    memberUserIds: z.array(UuidSchema),
    updatedAt: DateTimeSchema,
  })
  .openapi("GroupAccessRule", { description: "群组访问规则：accessLevel = edit / view；projectIds 仅项目 selected 时有值；memberUserIds 仅人员 selected 时有值" });

export type GroupAccessRule = z.infer<typeof GroupAccessRuleSchema>;

export const GroupAccessGroupSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    parentGroupKey: z.string().nullable().openapi({ description: "上级部门键；null = 根部门" }),
    memberCount: z.number().int().min(0),
    members: z.array(GroupAccessMemberSchema).openapi({ description: "部门直属人员（按姓名 / 工号排序）" }),
    rule: GroupAccessRuleSchema.nullable(),
  })
  .openapi("GroupAccessGroup", { description: "可配置部门：层级、直属人员与已保存规则；groupKey=__ungrouped__ 为虚拟未分组节点，仅聚合无部门成员关系的账号" });

export type GroupAccessGroup = z.infer<typeof GroupAccessGroupSchema>;

export const GroupAccessProjectSchema = z
  .object({
    id: UuidSchema,
    code: z.string(),
    name: z.string(),
  })
  .openapi("GroupAccessProject", { description: "群组规则可选项目（未进入回收站）" });

export type GroupAccessProject = z.infer<typeof GroupAccessProjectSchema>;

/** 系统管理员来源：configured = 环境变量（部门 / 用户白名单），manual = 权限页手工添加。 */
export const GROUP_ACCESS_ADMIN_SOURCES = ["configured", "manual"] as const;

export const GroupAccessAdminSourceSchema = z
  .enum(GROUP_ACCESS_ADMIN_SOURCES)
  .openapi("GroupAccessAdminSource", { description: "管理员来源：configured 环境配置 / manual 手工添加" });

export type GroupAccessAdminSource = z.infer<typeof GroupAccessAdminSourceSchema>;

export const GroupAccessAdminSchema = z
  .object({
    userId: UuidSchema,
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    status: UserStatusSchema,
    source: GroupAccessAdminSourceSchema,
    removable: z.boolean().openapi({ description: "仅手工添加的管理员可在权限页撤销" }),
  })
  .openapi("GroupAccessAdmin", { description: "系统管理员名单项（姓名 / 工号 / 邮箱 / 来源 / 是否可撤销）" });

export type GroupAccessAdmin = z.infer<typeof GroupAccessAdminSchema>;

export const GroupAccessAdminInputSchema = z
  .object({ userId: UuidSchema })
  .openapi("GroupAccessAdminInput", { description: "将系统用户设为权限管理员" });

export type GroupAccessAdminInput = z.infer<typeof GroupAccessAdminInputSchema>;

export const GroupAccessAdminResponseSchema = z
  .object({ admin: GroupAccessAdminSchema })
  .openapi("GroupAccessAdminResponse", { description: "当前生效的系统管理员" });

export type GroupAccessAdminResponse = z.infer<typeof GroupAccessAdminResponseSchema>;

export const GroupAccessOverviewSchema = z
  .object({
    enforced: z.boolean(),
    admin: z.boolean(),
    currentGroupKeys: z.array(z.string()),
    admins: z.array(GroupAccessAdminSchema).openapi({ description: "当前生效的系统管理员名单（环境配置 / 手工添加）" }),
    groups: z.array(GroupAccessGroupSchema),
    projects: z.array(GroupAccessProjectSchema),
  })
  .openapi("GroupAccessOverview", { description: "权限管理页数据：开关状态、当前账号部门、系统管理员、可配置部门树与项目；无部门账号汇总在虚拟未分组节点" });

export type GroupAccessOverview = z.infer<typeof GroupAccessOverviewSchema>;

export const GroupAccessRuleResponseSchema = z
  .object({ rule: GroupAccessRuleSchema })
  .openapi("GroupAccessRuleResponse", { description: "保存后的群组访问规则" });

export type GroupAccessRuleResponse = z.infer<typeof GroupAccessRuleResponseSchema>;
