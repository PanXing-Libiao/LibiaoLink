import { z } from "../zod.ts";
import { DateTimeSchema, DateOnlySchema, PageQuerySchema, SortQuerySchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { ProjectStatusSchema, StageKeySchema } from "../common/dicts.ts";

/** 项目主数据（projects 表；API 字段 camelCase 与 DDL snake_case 的映射见 shared/README.md）。 */
export const ProjectSchema = z
  .object({
    id: UuidSchema,
    code: z.string().openapi({ example: "CNBJ-20260708-0001", description: "项目编号：创建人填写（建后可修改）；服务端只校验唯一性，不生成；格式仅前端提示" }),
    seqNo: z.number().int().positive().openapi({ example: 1, description: "项目序号：服务端创建时分配（全库唯一、不可修改、不回收；与项目编号一一对应同一项目）；卡片等展示场景两位补零，列表支持 sort=seqNo:asc|desc" }),
    name: z.string().openapi({ example: "XX 客户分拣项目" }),
    customer: z.string().nullable(),
    region: z.string().openapi({ description: "项目落地地区（字典 region；缺省「未分类」）" }),
    projectType: z.string().openapi({ description: "项目类型（字典 project_type；主题色随字典元数据下发，前端不硬编码）" }),
    managerIds: z.array(UuidSchema).min(1).openapi({
      description: "项目经理（A22 · Push 136：一位也可、可多位）：至少一位、数组顺序 = 展示顺序（前端按「、」连接展示）；与 managerNames 同下标一一对应",
    }),
    managerNames: z.array(z.string().nullable()).openapi({
      description: "项目经理姓名数组：服务端按 managerIds 解析后随行下发，与 managerIds 同下标一一对应（列表 / 详情 / 创建与编辑返回均含，免前端二次查目录）；人员停用 / 离职后仍返回姓名，取不到时该位为 null（前端显示「—」）",
    }),
    stageKey: StageKeySchema,
    status: ProjectStatusSchema,
    description: z.string().nullable(),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    archivedAt: DateTimeSchema.nullable().openapi({
      description: "归档时点（ADR-027 · M7-04）：仅归档端点置位；未归档 = null（归档后项目进入只读保护）",
    }),
    archivedBy: UuidSchema.nullable().openapi({
      description: "归档操作人（users.id；仅归档端点置位）；未归档 = null",
    }),
    deletedAt: DateTimeSchema.nullable().openapi({
      description: "进入项目回收站的时间；未删除 = null。回收站项目仅通过 GET /projects?filter[recycled]=true 返回，普通列表 / 详情 / facets 继续排除",
    }),
    deletedBy: UuidSchema.nullable().openapi({
      description: "将项目移入回收站的操作人（users.id）；未删除 = null",
    }),
  })
  .openapi("Project", { description: "项目（v0.2 §2.3 projects）" });

/**
 * 项目总览汇总卡：最慢阶段 / 最新阶段 / 逾期 / 已完成 / 总数。
 * 2026-09-24 定案：原 `currentStage`（= projects.stage_key 项目当前阶段）随本刀下线 —— 汇总卡改用两个任务派生字段；
 * 「未分组」任务（stage_key 为空）不参与阶段判定，只进三个计数。
 */
export const ProjectSummarySchema = z
  .object({
    projectId: UuidSchema,
    slowestStage: StageKeySchema.nullable().openapi({
      description: "最慢阶段：按九阶段顺序**第一个「存在未完成任务」的阶段**；全部完成或项目无任务 = null（前端显示「—」/「全部完成」按 done / total 判断）",
    }),
    latestStage: StageKeySchema.nullable().openapi({
      description: "最新阶段（最快）：**已动工任务**（基础态 active / done，即进度 ≥ 1 格）中**阶段序最靠后**的那一个阶段；尚无任务动工 = null",
    }),
    overdue: z.number().int().min(0),
    done: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .openapi("ProjectSummary", { description: "项目总览汇总卡统计（任务派生；口径见 v0.2 §2.4 与前端功能需求 §3.4）" });

/**
 * 列表查询：多维筛选 + 分页 + 排序；多值筛选用英文逗号分隔（与 v0.2 §8.2 filter[...] 口径一致）。
 * A1（Push 49；**Push 175 维度修订**）：filter[timeFrom] / filter[timeTo] 为 DateOnly 闭区间，按 Asia/Shanghai 日界截断
 * —— 下界取当日 00:00:00+08:00（含）、上界取次日 00:00:00+08:00（不含）；维度映射 **projects.created_at（项目创建时间）**
 * （业务定调 2026-09-23：「这个筛选是按照项目创建时间筛选」；原「最近活动时间（updated_at）」口径随之作废，
 * 卡片上展示的也是创建时间 —— 两处同一维度，不再出现「筛选看活动、卡片看创建」的错位）。
 * 边界：只传一端合法；timeFrom 晚于 timeTo 或格式非法返回 400 VALIDATION_FAILED（不返回空列表）。
 * 列表与 facets 共用本 schema 与同一 QueryBuilder（禁止两套 SQL）。
 * 缺省排序（**Push 175 修订**）：createdAt:desc（最近创建的在前，与「项目时间筛选 = 创建时间」同一维度）；
 * 排序白名单 updatedAt / createdAt / seqNo。
 * A9（Push 69）：白名单补 createdAt（sort=createdAt:asc|desc）；**Push 175 起前端 TIME 升级为「维度（创建时间 / 更新时间）× 方向」**，默认 = 创建时间 × 降序。
 */
export const ProjectListQuerySchema = z
  .object({
    "filter[region]": z.string().optional().openapi({ description: "地区（多值逗号分隔）" }),
    "filter[projectType]": z.string().optional().openapi({ description: "项目类型（多值逗号分隔）" }),
    "filter[managerId]": z
      .string()
      .optional()
      .openapi({ description: "项目经理（多值逗号分隔，UUID）；命中口径（A22 · Push 136）= 项目挂的任意一位经理命中即命中" }),
    "filter[stageKey]": z.string().optional().openapi({ description: "阶段 key（多值逗号分隔）" }),
    "filter[status]": z.string().optional().openapi({ description: "项目状态（多值逗号分隔）" }),
    "filter[timeFrom]": DateOnlySchema.optional().openapi({
      description: "项目**创建时间**下界（YYYY-MM-DD，含当日；按 Asia/Shanghai 取当日 00:00:00+08:00；Push 175 起维度 = projects.created_at）",
    }),
    "filter[timeTo]": DateOnlySchema.optional().openapi({
      description: "项目**创建时间**上界（YYYY-MM-DD，含当日；按次日 00:00:00+08:00 不含截断）",
    }),
    "filter[archivedYear]": z
      .string()
      .optional()
      .openapi({ description: "归档年份（C4-07 归档检索；多值逗号分隔，四位年份如 2025,2026；按 projects.archived_at 的 Asia/Shanghai 年判定 —— 未归档项目不命中）" }),
    "filter[recycled]": z
      .enum(["true", "false"])
      .optional()
      .openapi({ description: "项目回收站开关：true = 仅返回已移入项目回收站的项目；false / 缺省 = 仅返回未删除项目" }),
    q: z.string().optional().openapi({ description: "关键字（编号 / 名称 / 客户 / 序号）" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
    sort: SortQuerySchema.optional().openapi({
      description: "排序（field:asc|desc）；一期白名单 updatedAt / createdAt / seqNo；缺省 = createdAt:desc（最近创建的在前；Push 175 起默认维度 = 创建时间）",
    }),
  })
  .openapi("ProjectListQuery", {
    description: "首页列表筛选（多维 + 时间闭区间 + 分页 + 排序）；时间区间按 Asia/Shanghai 日界，timeFrom 晚于 timeTo 返回 400",
  });

export const ProjectListResponseSchema = z
  .object({
    items: z.array(ProjectSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
  })
  .openapi("ProjectListResponse");

/** 创建项目：编号由创建人填写（服务端保证唯一性）；项目序号由服务端分配（创建请求不传 seqNo）；默认按当前已发布蓝图导入节点（导入即快照）。 */
export const ProjectCreateBodySchema = z
  .object({
    code: z.string().min(1).max(50).openapi({ example: "CNBJ-20260708-0001", description: "项目编号：创建人填写；格式仅前端提示，服务端不做强校验；重复返回 409 PROJECT_CODE_EXISTS" }),
    name: z.string().min(1).max(200),
    customer: z.string().max(200).optional(),
    region: z
      .string()
      .min(1)
      .max(100)
      .default("未分类")
      .openapi({ description: "项目落地地区（字典 region）；未填写归入「未分类」（A1-12 定档）" }),
    projectType: z
      .string()
      .min(1)
      .max(100)
      .default("未分类")
      .openapi({ description: "项目类型（字典 project_type）；未填写归入「未分类」（A1-12 定档）" }),
    managerIds: z.array(UuidSchema).min(1).openapi({
      description: "项目经理（A22 · Push 136）：至少一位、可多位；数组顺序 = 展示顺序；判空失败返回 400 VALIDATION_FAILED",
    }),
    stageKey: StageKeySchema.optional(),
    description: z.string().max(2000).optional(),
    blueprintVersion: z.number().int().positive().optional().openapi({ description: "导入的蓝图版本；缺省 = 当前已发布版本" }),
  })
  .openapi("ProjectCreateBody", { description: "创建项目：项目序号 seqNo 不接受传入，由服务端分配并随响应返回" });

/** 项目更新：code 可选（编号建后可修改）；修改时同样校验唯一性。 */
export const ProjectUpdateBodySchema = z
  .object({
    code: z.string().min(1).max(50).optional().openapi({ example: "CNBJ-20260708-0001", description: "项目编号：建后可修改；同样校验唯一性，重复返回 409 PROJECT_CODE_EXISTS" }),
    name: z.string().min(1).max(200).optional(),
    customer: z.string().max(200).nullable().optional(),
    region: z.string().min(1).max(100).optional(),
    projectType: z.string().min(1).max(100).optional(),
    managerIds: z.array(UuidSchema).min(1).optional().openapi({
      description: "项目经理（A22 · Push 136）：至少一位、可多位；不传 = 不改、传空数组 = 400；数组顺序 = 展示顺序",
    }),
    stageKey: StageKeySchema.optional(),
    status: z
      .enum(["active", "paused", "done"])
      .optional()
      .openapi({ description: "项目状态（active / paused / done）；archived 不接受 PATCH —— 归档只能走 POST /projects/{id}/archive（ADR-027 门禁 + 清单），确保归档必有清单与留痕" }),
    description: z.string().max(2000).nullable().optional(),
    version: VersionSchema,
  })
  .openapi("ProjectUpdateBody");


const ZeroOrMore = z.number().int().min(0);

/**
 * 归档（C4-02 / C4-03 · ADR-027 · M7-04）：门禁 + 引用式清单 + 冻结状态位（projects.status = archived）。
 * 门禁两级：① 硬前置 = 验收阶段已完成（未完成 409 ARCHIVE_NOT_READY，不可确认越过）；
 * ② 缺项清单 = 未完成任务 / 未定档文件 / 必交成果缺件（422 ARCHIVE_GATE_NOT_PASSED 返回明细；
 *    项目经理确认（confirm = true）后放行归档，缺项随清单 acknowledgedMissing 留痕）。
 * 清单为引用式快照：只记 id 与摘要（任务数与状态分布 / 阶段状态 / 文件清单含版本 / 变更 / 日报 / 问题），不复制业务数据；
 * 归档不清数据、不改阶段；清单导出（目录结构 + 文件按类型 / 阶段组织）随 M7-03 导出框架。
 */
export const ProjectArchiveBodySchema = z
  .object({
    version: VersionSchema.openapi({ description: "项目当前 version（乐观锁；不匹配 409 VERSION_CONFLICT）" }),
    confirm: z
      .boolean()
      .default(false)
      .openapi({ description: "缺项确认：false（缺省）= 有缺项即 422；true = 确认带缺项归档（缺项入清单 acknowledgedMissing）" }),
  })
  .openapi("ProjectArchiveBody", { description: "归档请求：version 必带；缺项越过分两步（先 422 拿清单，再 confirm=true 重试）" });

/** 归档缺项条目：422 明细与清单 acknowledgedMissing 同形（code / message / meta 三件套，与门禁 details 口径一致）。 */
export const ProjectArchiveMissingSchema = z
  .object({
    code: z
      .enum(["task_not_done", "file_not_final", "doc_missing"])
      .openapi({ description: "缺项类型：task_not_done 未完成任务 / file_not_final 未定档文件 / doc_missing 必交成果缺件（A4-20 口径）" }),
    message: z.string(),
    meta: z.record(z.string(), z.unknown()).openapi({ description: "缺项定位（任务 id / 文件 id / 节点与文档类型等）" }),
  })
  .openapi("ProjectArchiveMissing", { description: "归档缺项条目（确认越过时原样入清单 acknowledgedMissing）" });

/** 归档清单（引用式快照）：归档时点 + 统计口径 + 文件清单含版本；只记 id 与摘要，不复制业务数据。 */
export const ProjectArchiveSnapshotSchema = z
  .object({
    stage: z.object({
      stageKey: StageKeySchema,
      status: z.string().openapi({ description: "阶段状态（归档时点；验收阶段应为 done）" }),
      advancedAt: DateTimeSchema.nullable(),
    }),
    tasks: z.object({
      total: ZeroOrMore,
      byStatus: z.object({ pending: ZeroOrMore, active: ZeroOrMore, done: ZeroOrMore }),
    }),
    files: z.object({
      total: ZeroOrMore,
      items: z.array(
        z.object({
          id: UuidSchema,
          name: z.string(),
          docType: z.string().nullable().openapi({ description: "文档类型（字典 docType；未归类 = null）" }),
          status: z.string().openapi({ description: "文件状态（draft / final / changed / archived / recycled 原样记）" }),
          nodeId: UuidSchema.nullable().openapi({ description: "挂接节点（未挂节点 = null）" }),
          versionCount: ZeroOrMore.openapi({ description: "版本数（含历史版本）" }),
          latestSeq: ZeroOrMore.nullable().openapi({ description: "最新版本序号（无版本 = null）" }),
          latestUploadedAt: DateTimeSchema.nullable(),
        }),
      ),
    }),
    changes: z.object({
      total: ZeroOrMore,
      items: z.array(
        z.object({
          id: UuidSchema,
          reason: z.string().openapi({ description: "变更原因（摘要）" }),
          stageKey: StageKeySchema.nullable(),
          appliedAt: DateTimeSchema,
        }),
      ),
    }),
    reports: z.object({ total: ZeroOrMore, byState: z.object({ draft: ZeroOrMore, submitted: ZeroOrMore, supplement: ZeroOrMore }) }),
    issues: z.object({ total: ZeroOrMore, byState: z.object({ open: ZeroOrMore, in_progress: ZeroOrMore, done: ZeroOrMore }) }),
  })
  .openapi("ProjectArchiveSnapshot", { description: "归档清单（引用式快照：统计口径 + 文件清单含版本 + 变更 / 日报 / 问题；只记 id 与摘要）" });

export const ProjectArchiveViewSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    archivedAt: DateTimeSchema,
    archivedBy: UuidSchema,
    archivedByName: z.string().nullable().openapi({ description: "归档操作人姓名（users.display_name；取不到 = null）" }),
    snapshot: ProjectArchiveSnapshotSchema,
    acknowledgedMissing: z.array(ProjectArchiveMissingSchema).openapi({ description: "确认越过的缺项清单（无缺项 = 空数组）" }),
  })
  .openapi("ProjectArchiveView", { description: "归档记录与清单（POST 归档返回；GET /projects/{id}/archive 读面同形）" });

/** 首页侧边栏计数（facets）：与列表同一过滤口径（v0.2 §8.2）。 */
export const ProjectFacetsSchema = z
  .object({
    total: z.number().int().min(0),
    region: z.record(z.string(), z.number().int().min(0)),
    projectType: z.record(z.string(), z.number().int().min(0)),
    managerId: z.record(z.string(), z.number().int().min(0)).openapi({
      description: "项目经理维度计数：键 = users.id；一个项目挂多位经理时**每位各计一次**（A22 · Push 136）",
    }),
    stageKey: z.record(z.string(), z.number().int().min(0)),
    status: z.record(z.string(), z.number().int().min(0)),
  })
  .openapi("ProjectFacets", { description: "首页分类计数；计数与列表同口径（同筛选条件）；五组固定返回，前端按需展示（A6）" });

/** 项目内角色（project_members.role_in_project，M2-05）：一期两值，与全局角色（roles / user_roles）相互独立。 */
export const ProjectMemberRoleSchema = z
  .enum(["project_manager", "project_member"])
  .openapi("ProjectMemberRole", {
    description: "项目内角色：project_manager（项目经理）/ project_member（项目成员）；只作用于项目名册，不改变全局功能权限",
  });

/**
 * 项目成员名册项（M2-05）：记录级权限（谁能看见这个项目）的唯一来源，由 h6 策略服务消费（ADR-011 统一 404 语义）。
 * 姓名随行下发（A2 / ADR-021：关联一律用 users.id，姓名只作展示）。
 */
export const ProjectMemberSchema = z
  .object({
    userId: UuidSchema,
    username: z.string().openapi({ description: "工号（users.username）", example: "10086" }),
    displayName: z.string().openapi({ description: "姓名（users.display_name；账号停用 / 离职后仍返回）" }),
    roleInProject: ProjectMemberRoleSchema,
    joinedAt: DateTimeSchema.openapi({ description: "加入名册时间（成员变更会按 ADR-022 刷新项目 updatedAt）" }),
  })
  .openapi("ProjectMember", { description: "项目成员（名册行）" });

/** 成员列表：项目经理在前，同角色按工号升序（与用户目录同一稳定序）。 */
export const ProjectMemberListResponseSchema = z
  .object({
    items: z.array(ProjectMemberSchema),
    total: z.number().int().min(0),
  })
  .openapi("ProjectMemberListResponse");

/** 添加 / 更新成员（幂等 upsert）：同项目 + 同用户唯一，重复提交覆盖角色，不报错（前端「已在项目中」直接改角色）。 */
export const ProjectMemberCreateBodySchema = z
  .object({
    userId: UuidSchema,
    roleInProject: ProjectMemberRoleSchema.default("project_member").openapi({ description: "缺省 = project_member（项目成员）" }),
  })
  .openapi("ProjectMemberCreateBody", { description: "添加成员：重复添加（同 project + user）幂等并覆盖角色；项目归档后拒绝（409 PROJECT_ARCHIVED）" });

/**
 * 项目删除（2026-10-19 起 = 移入项目回收站）：If-Match 回传当前 version 防误删（DELETE 不带 body，避免代理丢载荷）。
 * 口径：仅写 projects.deleted_at / deleted_by（version +1），项目聚合数据与对象存储图片保持原样；
 * 普通列表 / 详情 / facets 立即不可见，项目回收站通过 GET /projects?filter[recycled]=true 读取；
 * 编号在回收站期间仍占用（彻底删除后才释放）；非成员 / 不存在统一 404；仅项目经理 / 管理员。
 */
export const ProjectDeleteHeadersSchema = z
  .object({
    "If-Match": z
      .string()
      .regex(/^\d+$/)
      .openapi({
        description: "项目当前 version（防误删）；缺失或非数字 → 400 VALIDATION_FAILED，不匹配 → 409 VERSION_CONFLICT",
        example: "3",
      }),
  })
  .openapi("ProjectDeleteHeaders");

/**
 * 项目回收站写口（恢复 / 彻底删除）共用：version = 项目当前乐观锁版本。
 * restore → 清 deleted_at / deleted_by 并 +1；purge → 仅系统管理员，删库内聚合数据 + 对象存储 projects/{id}/ 前缀（含全部版本与暂存对象）。
 */
export const ProjectRecycleActionBodySchema = z
  .object({
    version: VersionSchema.openapi({ description: "项目当前 version（乐观锁；不匹配 409 VERSION_CONFLICT）" }),
  })
  .openapi("ProjectRecycleActionBody", { description: "项目回收站操作请求：恢复或彻底删除均回传当前 version" });

export const ProjectPurgeResponseSchema = z
  .object({
    projectId: UuidSchema,
    purgedAt: DateTimeSchema,
  })
  .openapi("ProjectPurgeResponse", { description: "项目彻底删除结果（数据库聚合数据与项目对象前缀已清理）" });

/**
 * 项目群绑定（M5-03-2 · P5 定案：企微智能机器人 + chatid）：C2-05 群聊绑定（项目主数据维护）。
 * 读面恒 200：`bound=false` = 未绑定（chatidMasked / name / updatedAt = null）；`chatidMasked` 只回末 4 位
 *   （最小暴露口径，沿用 S8-1 §三-4 只写不读形态）；`activated` = 会话已激活（群内有人给机器人发过
 *   消息 —— 主动推送前置条件；未激活推送命中 846607 未激活分支，投递层不重试 + 降级留痕）。
 * 写面：`project.update` 权限档（B3 定案：项目经理维护）；项目归档后拒绝（409 PROJECT_ARCHIVED）。
 */
export const ProjectGroupBindingSchema = z
  .object({
    projectId: UuidSchema,
    bound: z.boolean().openapi({ description: "是否已绑定（false = 未绑定，其余字段为 null / false）" }),
    name: z.string().nullable().openapi({ description: "群名 / 备注（绑定维护用）；未绑定 = null" }),
    chatidMasked: z.string().nullable().openapi({ description: "绑定 chatid 掩码（只回末 4 位）；未绑定 = null" }),
    activated: z.boolean().openapi({ description: "会话已激活（群内有人给机器人发过消息）；未绑定 = false" }),
    updatedAt: DateTimeSchema.nullable().openapi({ description: "绑定 / 换绑 / 解绑时点；未绑定 = null" }),
  })
  .openapi("ProjectGroupBinding", { description: "项目群绑定状态（GET 恒 200；未绑定 = bound:false）" });

/**
 * 绑定 / 换绑请求（PUT 覆盖语义）：`chatid` = 群消息回调自动落库的会话 id（机器人进群 + 群内激活一次后可得），
 * 也接受先绑后激活（activated 随回调置位）；掩码只作用于读面，写入需全文。
 */
export const ProjectGroupPutBodySchema = z
  .object({
    chatid: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,128}$/, "chatid 形态非法（企微会话 id：字母 / 数字 / _ / -）")
      .openapi({ description: "企微会话 id（群消息回调 body.chatid 自动落库；形如 34 位 base64url 串）" }),
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullish()
      .openapi({ description: "群名 / 备注（维护用；可空 —— 覆盖语义下缺省 = 清空）" }),
  })
  .openapi("ProjectGroupPutBody", { description: "绑定 / 换绑项目群：chatid 必填 + 群名备注可空；PUT = upsert 覆盖语义" });
