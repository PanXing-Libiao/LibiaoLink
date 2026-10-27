import { DateTimeSchema, UuidSchema } from "../common/conventions.ts";
import { z } from "../zod.ts";
import { UserStatusSchema } from "./users.ts";

/**
 * 部门（Casdoor 群组）访问规则（2026-10-24）：
 * 部门键统一为 owner/name（例如 libiaorobot.com/项目部）。群组限制开启后，所有登录账号都可以
 * 进入页面；每条规则可同时配置 all / own / selected 多个数据范围，每个范围独立区分编辑 / 仅浏览
 * （edit 隐含 view）。多部门与个人覆盖取可见范围并集，同一项目命中多个范围时取最高权限；
 * 项目内写操作必须命中该项目的 edit。allowedPages 仅保留为旧客户端兼容字段，裁决时恒为全部页面。
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

/** 可授予数据权限的项目范围（none 不写入 scopePermissions；空数组 = 不显示项目数据）。 */
export const GROUP_ACCESS_DATA_PROJECT_SCOPES = ["all", "own", "selected"] as const;

export const GroupAccessDataProjectScopeSchema = z
  .enum(GROUP_ACCESS_DATA_PROJECT_SCOPES)
  .openapi("GroupAccessDataProjectScope", { description: "可授予数据权限的项目范围：all 全部项目 / own 仅自己的项目 / selected 仅指定项目" });

export type GroupAccessDataProjectScope = z.infer<typeof GroupAccessDataProjectScopeSchema>;

/** 单个项目范围的权限档位；多范围取并集，同一项目命中多范围时取最高权限（edit > view）。 */
export const GroupAccessScopePermissionSchema = z
  .object({
    projectScope: GroupAccessDataProjectScopeSchema,
    accessLevel: GroupAccessAccessLevelSchema,
  })
  .openapi("GroupAccessScopePermission", { description: "一个项目范围的权限档位：编辑 / 仅浏览" });

export type GroupAccessScopePermission = z.infer<typeof GroupAccessScopePermissionSchema>;

export const GroupAccessScopePermissionsSchema = z
  .array(GroupAccessScopePermissionSchema)
  .max(GROUP_ACCESS_DATA_PROJECT_SCOPES.length)
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of value.entries()) {
      if (seen.has(item.projectScope)) {
        ctx.addIssue({ code: "custom", message: "同一项目范围只能配置一次", path: [index, "projectScope"] });
      }
      seen.add(item.projectScope);
    }
  })
  .openapi("GroupAccessScopePermissions", {
    description: "多范围权限：各范围先去重，再取可见范围并集；同一项目命中多个范围时取最高权限；空数组 = 不显示项目数据",
  });

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
    scopePermissions: GroupAccessScopePermissionsSchema.optional().openapi({ description: "多范围权限（新口径）：all / own / selected 可多选，各带 edit / view；空数组 = 不显示项目数据" }),
    projectScope: GroupAccessProjectScopeSchema.optional().openapi({ description: "旧客户端兼容字段：未传 scopePermissions 时规范化为单范围；none = 不显示项目数据" }),
    accessLevel: GroupAccessAccessLevelSchema.optional().default("view").openapi({ description: "旧客户端兼容档位；scopePermissions 存在时忽略" }),
    projectIds: z.array(UuidSchema).max(2000).default([]).openapi({ description: "selected 范围的项目白名单；不存在 selected 时忽略" }),
    memberScope: GroupAccessMemberScopeSchema.default("all").openapi({ description: "all = 全部门；selected = 仅 memberUserIds" }),
    memberUserIds: z.array(UuidSchema).max(2000).default([]).openapi({ description: "selected 时生效的直属人员 user id" }),
  })
  .superRefine((value, ctx) => {
    if (value.scopePermissions === undefined && value.projectScope === undefined) {
      ctx.addIssue({ code: "custom", message: "scopePermissions 与 projectScope 至少提供一个", path: ["scopePermissions"] });
    }
    if (value.scopePermissions === undefined && value.projectScope === "none" && value.accessLevel === "edit") {
      ctx.addIssue({ code: "custom", message: "不显示项目数据时只能为仅浏览", path: ["accessLevel"] });
    }
  })
  .openapi("GroupAccessRuleInput", { description: "保存群组访问规则：可多选全部 / 自己的 / 指定项目并分别设置编辑或仅浏览；不显示项目数据为互斥清空项；旧 projectScope / accessLevel 继续兼容" });

export type GroupAccessRuleInput = z.infer<typeof GroupAccessRuleInputSchema>;

export const GroupAccessRuleSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    allowedPages: z.array(GroupAccessPageSchema).openapi({ description: "旧客户端兼容字段；恒返回全部页面" }),
    scopePermissions: GroupAccessScopePermissionsSchema.openapi({ description: "多范围权限；空数组 = 不显示项目数据" }),
    projectScope: GroupAccessProjectScopeSchema.openapi({ description: "旧客户端兼容摘要：优先 all，其次 own，再次 selected；无范围 = none" }),
    accessLevel: GroupAccessAccessLevelSchema.openapi({ description: "旧客户端兼容摘要：projectScope 对应范围的权限档位；无范围 = view" }),
    projectIds: z.array(UuidSchema).openapi({ description: "selected 范围项目白名单" }),
    memberScope: GroupAccessMemberScopeSchema,
    memberUserIds: z.array(UuidSchema),
    updatedAt: DateTimeSchema,
  })
  .openapi("GroupAccessRule", { description: "群组访问规则：scopePermissions 为裁决口径；projectScope / accessLevel 仅为旧客户端摘要" });

export type GroupAccessRule = z.infer<typeof GroupAccessRuleSchema>;

/** 部门内个人权限覆盖：命中时替代同部门默认规则，未命中时沿用默认规则。 */
export const GroupAccessMemberRuleSchema = z
  .object({
    groupKey: z.string(),
    userId: UuidSchema,
    scopePermissions: GroupAccessScopePermissionsSchema.openapi({ description: "个人多范围权限；存在个人规则时整体覆盖同部门默认规则" }),
    projectScope: GroupAccessProjectScopeSchema.openapi({ description: "旧客户端兼容摘要：优先 all，其次 own，再次 selected；无范围 = none" }),
    accessLevel: GroupAccessAccessLevelSchema.openapi({ description: "旧客户端兼容摘要：projectScope 对应范围的权限档位；无范围 = view" }),
    projectIds: z.array(UuidSchema),
    updatedAt: DateTimeSchema,
  })
  .openapi("GroupAccessMemberRule", { description: "部门内个人权限覆盖：scopePermissions 为裁决口径；projectIds 仅 selected 时有值；整体覆盖同部门默认规则" });

export type GroupAccessMemberRule = z.infer<typeof GroupAccessMemberRuleSchema>;

export const GroupAccessMemberRuleInputSchema = z
  .object({
    groupKey: z.string().trim().min(1).max(200).openapi({ example: "libiaorobot.com/项目部" }),
    groupName: z.string().trim().min(1).max(200).optional(),
    userIds: z.array(UuidSchema).min(1).max(2000),
    scopePermissions: GroupAccessScopePermissionsSchema.optional().openapi({ description: "个人多范围权限（新口径）；空数组 = 不显示项目数据" }),
    projectScope: GroupAccessProjectScopeSchema.optional().openapi({ description: "旧客户端兼容字段；未传 scopePermissions 时规范化为单范围" }),
    accessLevel: GroupAccessAccessLevelSchema.optional().default("view").openapi({ description: "旧客户端兼容档位；scopePermissions 存在时忽略" }),
    projectIds: z.array(UuidSchema).max(2000).default([]).openapi({ description: "selected 范围的项目白名单" }),
  })
  .superRefine((value, ctx) => {
    if (value.scopePermissions === undefined && value.projectScope === undefined) {
      ctx.addIssue({ code: "custom", message: "scopePermissions 与 projectScope 至少提供一个", path: ["scopePermissions"] });
    }
    if (value.scopePermissions === undefined && value.projectScope === "none" && value.accessLevel === "edit") {
      ctx.addIssue({ code: "custom", message: "不显示项目数据时只能为仅浏览", path: ["accessLevel"] });
    }
  })
  .openapi("GroupAccessMemberRuleInput", { description: "保存部门内个人权限覆盖：多范围可分别设置编辑 / 仅浏览；同一部门可按 userIds 批量写入，各成员仍保存为独立规则" });

export type GroupAccessMemberRuleInput = z.infer<typeof GroupAccessMemberRuleInputSchema>;

export const GroupAccessMemberRuleDeleteInputSchema = z
  .object({
    groupKey: z.string().trim().min(1).max(200),
    groupName: z.string().trim().min(1).max(200).optional(),
    userIds: z.array(UuidSchema).min(1).max(2000),
  })
  .openapi("GroupAccessMemberRuleDeleteInput", { description: "删除部门内个人权限覆盖并恢复部门默认规则" });

export type GroupAccessMemberRuleDeleteInput = z.infer<typeof GroupAccessMemberRuleDeleteInputSchema>;

export const GroupAccessMemberRuleResponseSchema = z
  .object({ rules: z.array(GroupAccessMemberRuleSchema) })
  .openapi("GroupAccessMemberRuleResponse", { description: "保存后的个人权限覆盖列表" });

export type GroupAccessMemberRuleResponse = z.infer<typeof GroupAccessMemberRuleResponseSchema>;

export const GroupAccessGroupSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    parentGroupKey: z.string().nullable().openapi({ description: "上级部门键；null = 根部门" }),
    memberCount: z.number().int().min(0),
    members: z.array(GroupAccessMemberSchema).openapi({ description: "部门直属人员（按姓名 / 工号排序）" }),
    memberRules: z.array(GroupAccessMemberRuleSchema).openapi({ description: "部门内个人权限覆盖；同一部门不同人员可分别设置" }),
    rule: GroupAccessRuleSchema.nullable().openapi({ description: "部门默认规则；未单独设置个人权限的成员沿用" }),
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
