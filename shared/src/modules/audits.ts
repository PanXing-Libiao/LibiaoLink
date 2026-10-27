import { z } from "../zod.ts";
import { DateTimeSchema, PageQuerySchema, UuidSchema, paginated } from "../common/conventions.ts";

/**
 * 审计（C7）契约：操作留痕的读取面；写入由服务端在各业务用例内同事务完成。
 * 表口径见 database/migrations/0013_admin_dict_audit.sql 与技术设计v0.3 §3.2。
 */

/**
 * 审计动作（audit_logs.action）：新增 / 修改 / 删除 / 进度 / 完成 / 推进 / 回退 / 归档 / 访问 / 预览 / 下载 / 越权拒绝（C7-03；archive 随 M7-04 归档）。
 * 2026-10-23 起：进入项目详情记 visit（访问），登录成功也记 visit + objectType=user；预览恢复写 preview。
 * 2026-10-27 收口：GET /files/{id}/preview 的 recordView 缺省 false（缩略图只取签名）；用户点开具体预览并显式传 true 且实际送达就绪内容时才写一条 preview。
 */
export const AUDIT_ACTIONS = ["create", "update", "delete", "progress", "complete", "advance", "rollback", "archive", "visit", "preview", "download", "deny"] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS).openapi("AuditAction", {
  description:
    "审计动作：create 新增 / update 修改 / delete 删除 / progress 进度 / complete 节点完成 / advance 阶段推进 / rollback 阶段回退 / archive 项目归档（ADR-027：归档动作写审计，确认越过的缺项计数记 metadata）/ visit 访问（进入项目详情时由页面调用 POST /projects/{id}/visit 记录；登录成功也记 visit + objectType=user） / preview 预览查看（2026-10-23 起恢复；2026-10-27 起仅用户点开具体预览并显式传 recordView=true、实际送达就绪内容时记一条，缩略图不写） / download 离线下载（A4-10：下载受 file.download 权限点控制并写日志；对象类型 file，经 metadata 记 versionId） / deny 越权拒绝",
});

/** 审计对象类型（audit_logs.object_type）：覆盖 h7 全部写入点 + h8 工作日历 + M4 file（文件与上传会话生命周期 / 预览）+ 变更记录 + M6 日报 / 问题 + M3-05 余任务节点库 + M5-06 规则 / 发送记录。 */
export const AUDIT_OBJECT_TYPES = [
  "project",
  "project_summary",
  "project_member",
  "task",
  "node",
  "stage",
  "dict_item",
  "blueprint",
  "calendar_day",
  "calendar_settings",
  "file",
  "change",
  "stakeholder",
  "daily_report",
  "issue",
  "task_node",
  "task_template",
  "user",
  "wecom_dm_binding",
  "automation_rule",
  "notify_delivery",
  "group_access_rule",
  "group_access_admin",
] as const;
export const AuditObjectTypeSchema = z.enum(AUDIT_OBJECT_TYPES).openapi("AuditObjectType", {
  description:
    "审计对象类型：project 项目 / project_summary 项目总结（事实包 + 叙述存档、确认发布） / project_member 名册 / task 任务 / node 节点 / stage 阶段 / dict_item 字典条目 / blueprint 蓝图 / calendar_day 日历例外（对象 id = 业务日期） / calendar_settings 顺延配置（对象 id = default） / file 文件（对象 id = fileId；上传会话事件经 metadata.uploadId 定位；仅用户点开具体预览（recordView=true）且实际送达时写 preview 审计，缩略图不写 —— 不为同一 fileId 开第二种对象类型） / change 变更记录（对象 id = changeRequestId，M4-04） / stakeholder 干系人（对象 id = stakeholderId；项目关联 / 解除经 metadata.projectId 记录，j6） / daily_report 日报（对象 id = reportId，M6-01 / M6-02） / issue 问题（对象 id = issueId，M6-02 / M6-03） / task_node 任务节点（对象 id = taskNodeId，M3-05 余：节点库新增 / 编辑 / 删除） / task_template 任务模板（对象 id = templateId，M3-05 余第二段：模板新增 / 编辑 / 软删） / user 系统用户（对象 id = users.id；Push 173：离职回收 / 组织同步的停用 · 启用 · 软删；登录成功记 visit，metadata.operation=login） / wecom_dm_binding 企微绑定验证（对象 id = 机器人标识 + 掩码 open_userid；失败 / 锁定记 deny + denied，不落完整 userid 或绑定码） / automation_rule 自动化规则（对象 id = 规则 id；保存记录字段级 diff，metadata 带 code / beforeVersion / afterVersion，M5-06） / notify_delivery 发送记录（对象 id = 消息归档 id；仅管理员重发写 update + metadata.operation=resend，M5-06） / group_access_rule 部门访问规则（对象 id = 群组键；保存 / 删除写审计，2026-10-23） / group_access_admin 系统管理员（对象 id = users.id；手工授予 / 撤销写审计，2026-10-24）",
});

/** 审计结果：成功 / 越权拒绝（C7-03，管理员可按 result=denied 筛出）/ 失败（门禁拒绝等）。 */
export const AUDIT_RESULTS = ["succeeded", "denied", "failed"] as const;
export const AuditResultSchema = z.enum(AUDIT_RESULTS).openapi("AuditResult", {
  description: "审计结果：succeeded 成功 / denied 越权尝试（C7-03）/ failed 业务拒绝（门禁等）",
});

/** 审计入口：一期全部为 api；页面 / 系统任务 / 批量随各自卡片接入。 */
export const AUDIT_ENTRIES = ["api", "page", "system", "batch"] as const;
export const AuditEntrySchema = z.enum(AUDIT_ENTRIES).openapi("AuditEntry", {
  description: "审计入口：api / page / system / batch",
});

/** 字段级修改（C7-02）：谁、何时、从什么改成什么 —— changes 数组元素。 */
export const AuditChangeSchema = z
  .object({
    field: z.string().openapi({ description: "字段名（契约口径 camelCase）" }),
    from: z.unknown().openapi({ description: "修改前值（JSON；无值时为 null）" }),
    to: z.unknown().openapi({ description: "修改后值（JSON；无值时为 null）" }),
  })
  .openapi("AuditChange", { description: "字段级修改条目（C7-02）" });

export const AuditLogSchema = z
  .object({
    id: z.number().int().positive().openapi({ description: "审计序号（只增不减）" }),
    occurredAt: DateTimeSchema,
    actorId: UuidSchema.nullable().openapi({ description: "操作人 users.id（系统任务为 null）" }),
    actorName: z.string().nullable().openapi({ description: "操作人姓名快照（写入时冗余，改名后仍可追溯）" }),
    action: AuditActionSchema,
    objectType: AuditObjectTypeSchema,
    objectId: z.string().openapi({ description: "对象 id（uuid 或字典码等业务键）" }),
    projectId: UuidSchema.nullable().openapi({ description: "所属项目（非项目对象为 null）" }),
    result: AuditResultSchema,
    entry: AuditEntrySchema,
    summary: z.string().openapi({ description: "可读摘要（列表直接展示）" }),
    changes: z.array(AuditChangeSchema).nullable().openapi({ description: "字段级修改（C7-02）；无字段级变化时为 null" }),
    metadata: z.record(z.string(), z.unknown()).openapi({ description: "附加信息（trace_id / 请求方法路径等）" }),
  })
  .openapi("AuditLog", { description: "审计日志（C7）：追加写、不可改删、保留 ≥6 个月（C7-05）" });

export const AuditLogListQuerySchema = z
  .object({
    objectType: z.string().optional().openapi({ description: "对象类型（多值逗号分隔，取值见 AuditObjectType）" }),
    objectId: z.string().min(1).max(200).optional().openapi({
      description: "对象 id（与 objectType 组合 = 按对象检索 —— h7 验收项②）",
    }),
    actorId: z.string().optional().openapi({ description: "操作人 users.id（多值逗号分隔，按人检索 —— h7 验收项②）" }),
    action: z.string().optional().openapi({ description: "审计动作（多值逗号分隔，取值见 AuditAction）" }),
    result: z.string().optional().openapi({ description: "审计结果（多值逗号分隔，取值见 AuditResult）；result=denied 即越权尝试（C7-03）" }),
    projectId: z.string().optional().openapi({ description: "所属项目（多值逗号分隔）" }),
    q: z.string().max(200).optional().openapi({
      description: "关键字：操作内容（摘要 / 字段级修改明细）或操作人姓名快照（包含即命中，大小写不敏感）",
    }),
    from: DateTimeSchema.optional().openapi({ description: "时间下界（含，ISO8601）" }),
    to: DateTimeSchema.optional().openapi({ description: "时间上界（含，ISO8601）" }),
    beforeId: z.coerce.number().int().positive().optional().openapi({ description: "稳定阅读窗口的最大审计序号；总数仍为当前筛选的总数" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
  })
  .openapi("AuditLogListQuery", {
    description:
      "审计检索（C7-04）：按关键字 / 对象 / 操作人 / 动作 / 结果 / 项目 / 时间区间过滤；多个筛选值以逗号分隔（去重保序，2026-10-09 追订「别的筛选也是同理 要支持多选」+「操作记录里面也是」），逐值白名单校验、非法值 400；固定 occurredAt 降序",
  });

export const AuditLogListResponseSchema = paginated(AuditLogSchema).extend({ windowId: z.number().int().positive().nullable().openapi({ description: "该阅读窗口的最大审计序号，自动回读通过beforeId保持历史页稳定" }) }).openapi("AuditLogListResponse");


/** 审计枚举与视图的类型别名（前端与 handler 直接用）。 */
export type AuditAction = z.infer<typeof AuditActionSchema>;
export type AuditObjectType = z.infer<typeof AuditObjectTypeSchema>;
export type AuditResult = z.infer<typeof AuditResultSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditChange = z.infer<typeof AuditChangeSchema>;
export type AuditLog = z.infer<typeof AuditLogSchema>;
export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
