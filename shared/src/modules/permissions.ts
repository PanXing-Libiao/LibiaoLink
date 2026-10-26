import { z } from "../zod.ts";
import { UuidSchema } from "../common/conventions.ts";
import { GroupAccessAccessLevelSchema, GroupAccessPageSchema, GroupAccessProjectScopeSchema } from "./group-access.ts";

/**
 * 功能权限位（模块.操作）—— 本数组是唯一来源。
 * 2026-10-26 起部门规则是业务权限的唯一来源；本数组作为能力基线固定全量下发，
 * 旧 role_permissions 矩阵仅保留为历史数据，不再参与授权。
 * h8 起新增 calendar.manage（工作日历维护 D5-01 与顺延配置 D5-02，仅管理员）。
 * M6 起新增日报 / 问题四键（系统功能书 A3 与 §4.1「项目成员：日报、问题」）：report.view / report.fill / issue.view / issue.manage。
 * M7-04 起新增 project.archive（ADR-027 归档端点：仅项目经理 / 管理员，归档写清单与审计）。
 * M5-06 起新增 automation.view / automation.manage / notify.record.view / notify.resend（规则管理与发送记录）。
 */
export const PERMISSION_KEYS = [
  "project.view",
  "project.create",
  "project.update",
  "project.delete",
  "project.archive",
  "project.export",
  "member.view",
  "member.manage",
  "task.view",
  "task.create",
  "task.update",
  "task.progress",
  "report.view",
  "report.fill",
  "issue.view",
  "issue.manage",
  "node.view",
  "node.create",
  "node.delete",
  "node.complete",
  "node.advance",
  "node.rollback",
  "blueprint.view",
  "blueprint.manage",
  "file.upload",
  "file.download",
  "stakeholder.view",
  "stakeholder.manage",
  "stakeholder.contact.view",
  "dict.manage",
  "audit.view",
  "calendar.manage",
  "automation.view",
  "automation.manage",
  "notify.record.view",
  "notify.resend",
  "access.manage",
] as const;

export const PermissionKeySchema = z
  .enum(PERMISSION_KEYS)
  .openapi("PermissionKey", { description: "功能权限位（模块.操作）；部门权限模型下作为全量能力基线" });

export type PermissionKey = z.infer<typeof PermissionKeySchema>;

/** 角色数据范围（roles.data_scope）：由宽到窄，多角色取并集（技术设计v0.2 §4.1）。 */
export const DataScopeSchema = z
  .enum(["all", "managed_projects", "involved_projects", "own_stakeholders", "granted"])
  .openapi("DataScope", {
    description: "角色数据范围：all > managed_projects > involved_projects > own_stakeholders > granted（多角色并集）",
  });

export type DataScope = z.infer<typeof DataScopeSchema>;

export const GROUP_PROJECT_ACCESS_VALUES = ["allowed", "empty", "denied"] as const;

export const GroupProjectAccessSchema = z
  .enum(GROUP_PROJECT_ACCESS_VALUES)
  .openapi("GroupProjectAccess", {
    description: "部门项目权限三态：allowed 有可浏览范围 / empty 有 all、own 或 selected 数据范围但当前无可见项目 / denied 仅登录（无规则或适用规则均为 none）",
  });

export type GroupProjectAccess = z.infer<typeof GroupProjectAccessSchema>;

export const AUDIT_SCOPE_VALUES = ["all", "project_manager", "self"] as const;

export const AuditScopeSchema = z
  .enum(AUDIT_SCOPE_VALUES)
  .openapi("AuditScope", {
    description: "操作记录可见范围：all 管理员 / project_manager 本人记录 + 当前有权且本人担任项目经理的项目记录 / self 仅本人记录",
  });

export type AuditScope = z.infer<typeof AuditScopeSchema>;

/**
 * 授权画像（服务端 ActorAuthorization 的契约投影）：前端据此置灰按钮、显示当前身份；
 * 字段级策略不下发 —— 无权字段服务端直接不返回（ADR-011 / C3-08）。
 */
export const ActorPermissionsSchema = z
  .object({
    userId: UuidSchema,
    roleCodes: z.array(z.string()).openapi({ example: ["admin"], description: "兼容旧系统管理员硬检查的固定基线，不读取 user_roles" }),
    dataScopes: z.array(DataScopeSchema).openapi({ description: "固定全量数据范围基线；实际项目范围由部门规则收窄" }),
    permissionKeys: z.array(PermissionKeySchema).openapi({ description: "全量功能权限位基线；写能力由 groupReadOnly / 部门规则再裁决" }),
    groupKeys: z.array(z.string()).optional().openapi({ description: "当前账号的 Casdoor 群组键（owner/name；按登录或目录同步落地）" }),
    pageKeys: z.array(GroupAccessPageSchema).optional().openapi({ description: "GROUP_ACCESS_ENFORCED=true 时当前账号可进入的页面；管理员为全量" }),
    groupAccessEnforced: z.boolean().optional().openapi({ description: "群组访问限制是否已启用" }),
    groupAccessAdmin: z.boolean().optional().openapi({ description: "当前账号是否可进入群组权限管理页" }),
    groupReadOnly: z.boolean().optional().openapi({ description: "群组访问限制下当前账号是否只读；页面仍全部可见，但业务写接口一律 403" }),
    groupProjectAccess: GroupProjectAccessSchema.optional().openapi({ description: "部门项目权限三态：allowed / empty / denied；none 规则按仅登录处理，用于业务页面统一空状态" }),
    groupProjectScopes: z.array(GroupAccessProjectScopeSchema).optional().openapi({ description: "当前账号命中的部门项目范围并集：all / own / selected / none；用于空态展示当前权限" }),
    groupAccessLevel: GroupAccessAccessLevelSchema.optional().openapi({ description: "当前账号的部门权限档位：edit 可编辑并浏览 / view 仅浏览；与 groupReadOnly 同源" }),
    auditScope: AuditScopeSchema.optional().openapi({ description: "当前账号操作记录可见范围；所有登录账号至少可查看本人记录" }),
  })
  .openapi("ActorPermissions", { description: "当前用户授权画像（全量能力基线 + 部门规则裁决结果）" });

export type ActorPermissions = z.infer<typeof ActorPermissionsSchema>;

/** GET /api/v1/permissions/me 响应：包一层对象，便于后续追加策略版本号等字段。 */
export const PermissionMeResponseSchema = z
  .object({ permissions: ActorPermissionsSchema })
  .openapi("PermissionMeResponse", { description: "当前用户授权画像（未登录 401）" });
