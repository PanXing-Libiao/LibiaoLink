import { DateTimeSchema, UuidSchema } from "../common/conventions.ts";
import { z } from "../zod.ts";

/**
 * Casdoor 群组访问规则（2026-10-23）：群组键统一为 owner/name（例如 libiaorobot.com/项目部），
 * 页面权限按群组并集，项目权限按规则并集后再与角色可见范围取交集。
 * 规则不存在 = 该群组不额外放行；GROUP_ACCESS_ENFORCED=true 时未配置群组会落到空集合。
 */
export const GROUP_ACCESS_PAGE_KEYS = ["dashboard", "projects", "templates", "workspace", "files", "audit"] as const;

export const GroupAccessPageSchema = z
  .enum(GROUP_ACCESS_PAGE_KEYS)
  .openapi("GroupAccessPage", { description: "可按群组收敛的页面：dashboard 仪表盘 / projects 项目空间 / templates 任务模板 / workspace 我的任务 / files 文件库 / audit 操作记录" });

export type GroupAccessPage = z.infer<typeof GroupAccessPageSchema>;

export const GROUP_ACCESS_PROJECT_SCOPES = ["all", "selected", "none"] as const;

export const GroupAccessProjectScopeSchema = z
  .enum(GROUP_ACCESS_PROJECT_SCOPES)
  .openapi("GroupAccessProjectScope", { description: "群组项目范围：all 角色可见项目全放行 / selected 仅指定项目 / none 不可见任何项目" });

export type GroupAccessProjectScope = z.infer<typeof GroupAccessProjectScopeSchema>;

export const GroupAccessRuleInputSchema = z
  .object({
    groupKey: z.string().trim().min(1).max(200).openapi({ example: "libiaorobot.com/项目部" }),
    groupName: z.string().trim().min(1).max(200).optional(),
    allowedPages: z.array(GroupAccessPageSchema).max(GROUP_ACCESS_PAGE_KEYS.length),
    projectScope: GroupAccessProjectScopeSchema,
    projectIds: z.array(UuidSchema).max(2000).default([]),
  })
  .openapi("GroupAccessRuleInput", { description: "保存群组访问规则：页面集合 + 项目范围 + 指定项目（selected 时生效）" });

export type GroupAccessRuleInput = z.infer<typeof GroupAccessRuleInputSchema>;

export const GroupAccessRuleSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    allowedPages: z.array(GroupAccessPageSchema),
    projectScope: GroupAccessProjectScopeSchema,
    projectIds: z.array(UuidSchema),
    updatedAt: DateTimeSchema,
  })
  .openapi("GroupAccessRule", { description: "群组访问规则（projectIds 仅 selected 时有值）" });

export type GroupAccessRule = z.infer<typeof GroupAccessRuleSchema>;

export const GroupAccessGroupSchema = z
  .object({
    groupKey: z.string(),
    groupName: z.string(),
    memberCount: z.number().int().min(0),
    rule: GroupAccessRuleSchema.nullable(),
  })
  .openapi("GroupAccessGroup", { description: "可配置群组：当前目录观察到的人数 + 已保存规则" });

export type GroupAccessGroup = z.infer<typeof GroupAccessGroupSchema>;

export const GroupAccessProjectSchema = z
  .object({
    id: UuidSchema,
    code: z.string(),
    name: z.string(),
  })
  .openapi("GroupAccessProject", { description: "群组规则可选项目（未进入回收站）" });

export type GroupAccessProject = z.infer<typeof GroupAccessProjectSchema>;

export const GroupAccessOverviewSchema = z
  .object({
    enforced: z.boolean(),
    admin: z.boolean(),
    currentGroupKeys: z.array(z.string()),
    groups: z.array(GroupAccessGroupSchema),
    projects: z.array(GroupAccessProjectSchema),
  })
  .openapi("GroupAccessOverview", { description: "权限管理页数据：开关状态、当前账号群组、可配置群组与项目" });

export type GroupAccessOverview = z.infer<typeof GroupAccessOverviewSchema>;

export const GroupAccessRuleResponseSchema = z
  .object({ rule: GroupAccessRuleSchema })
  .openapi("GroupAccessRuleResponse", { description: "保存后的群组访问规则" });

export type GroupAccessRuleResponse = z.infer<typeof GroupAccessRuleResponseSchema>;
