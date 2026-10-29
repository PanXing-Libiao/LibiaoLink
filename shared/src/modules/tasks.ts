import { z } from "../zod.ts";
import { DateTimeSchema, DateOnlySchema, PageQuerySchema, SortQuerySchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { DOC_TYPES, DocTypeSchema, FileStatusSchema, PrioritySchema, StageKeySchema, TaskBaseStatusSchema, TaskDisplayStatusSchema } from "../common/dicts.ts";

const TASK_OWNER_IDS_LIMIT = 200;
const TASK_TEMPLATE_NODE_IDS_LIMIT = 500;

/**
 * 四格进度：0 / 0.25 / 0.5 / 0.75 / 1（写入即联动状态与完成日期，并写审计）。
 * 离散五档（A13 · Push 70）：写入只收这五个值；迁移 / 演示数据的任意小数先四舍五入到最近档（0.49 → 0.5），
 * 保证「四格显示 ↔ 进度值」一一对应。
 */
export const TaskProgressSchema = z
  .union([z.literal(0), z.literal(0.25), z.literal(0.5), z.literal(0.75), z.literal(1)])
  .openapi("TaskProgress", { description: "任务进度四格（离散五档）：0 / 25% / 50% / 75% / 100%；写入即联动状态与完成日期" });

/**
 * 变更关联项（A1-07 / R01「追加＋去重」）：一条任务可关联多条变更 —— 变更生效时由 R01 按
 * 「任务成果类型命中变更文件 doc_type」追加，重复引用去重（业务要求「变更关联」列展示多条，Push 146）。
 */
export const TaskChangeLinkSchema = z
  .object({
    id: UuidSchema.openapi({ description: "变更记录 id（change_requests；M4-04 读面按 id 跳变更详情）" }),
    reason: z
      .string()
      .nullable()
      .openapi({ description: "变更原因（列表下发短文本，超长由服务端截断；全文在变更详情）" }),
    appliedAt: DateTimeSchema.openapi({
      description: "变更生效时间（一期「申请即通过」= 提交生效时间）；「变更关联」列按此显示变更日期",
    }),
  })
  .openapi("TaskChangeLink", { description: "任务 ↔ 变更关联项（多条；列表 / 详情同形）" });

/** 任务（tasks 表；displayStatus 为服务端派生，不写回存储）。 */
export const TaskSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    stageKey: StageKeySchema.nullable().openapi({ description: "所属阶段；null = 「未分组」（A15 · Push 124：临时任务允许没有阶段）" }),
    sortIndex: z.number().int().min(0).openapi({
      description:
        "组内位次（A19 / A20 · Push 124）：一组 = 同一项目 + 同一阶段（null = 未分组），0 起、密集；看板列内顺序与项目总览排序都按它",
    }),
    nodeId: UuidSchema.nullable(),
    /**
     * 来源任务节点库节点（A1-16 · M3-07 刀 3）：与 nodeId（**项目流程节点** / 蓝图实例）并行、互不替代 ——
     * 节点库节点回答「任务从哪来」；手工创建与流程节点生成的任务为 null；同一项目内同一节点只留一份（重复添加 409）。
     */
    sourceNodeId: UuidSchema.nullable(),
    title: z.string(),
    titleEn: z.string().nullable(),
    ownerIds: z.array(UuidSchema).openapi({
      description: "任务负责人（A23 · Push 136：一位也可、可多位）：数组顺序 = 展示顺序；**空数组 = 「待分配」**（合法中间状态，沿用 A18）；与 ownerNames 同下标一一对应",
    }),
    status: TaskBaseStatusSchema,
    displayStatus: TaskDisplayStatusSchema,
    progress: TaskProgressSchema,
    plannedStart: DateOnlySchema.nullable(),
    plannedEnd: DateOnlySchema.nullable(),
    actualEnd: DateOnlySchema.nullable(),
    estimatedDays: z.number().int().min(0).nullable(),
    headcount: z.number().int().min(0).nullable(),
    priority: PrioritySchema.nullable(),
    deliverableTypes: z.array(DocTypeSchema).openapi({
      description:
        "要求输出成果文件（ADR-024 多选，Push 143）：取值属十类成果文件字典；服务端按首次出现去重；**空数组 = 不要求**；随模板 / 节点生成后默认锁定（A1-17，例外调整随 M3-05）",
    }),
    note: z.string().nullable(),
    onTime: z.boolean().nullable().openapi({
      description:
        "是否按时交付（服务端读时派生，A14 · Push 70）：完成且实际完成不晚于预计完成 → true；完成但晚于预计完成，或已完成未填完成日期且预计完成已过 → false；未完成且已过预计完成 → false（配 displayStatus=overdue 即「逾期未交付」）；未完成未到期 / 无预计完成日期 → 派生不出 → 回落迁移导入的存储值，仍无则 null（前端显示「—」）。前端标签「逾期未交付 / 逾期已交付」由本字段 + displayStatus 渲染，不再本地派生",
    }),
    changeLinks: z.array(TaskChangeLinkSchema).openapi({
      description:
        "变更关联（A1-07 / R01：**一条任务可关联多条变更**，写面「追加＋去重」）：数组顺序 = 关联先后（追加序，末位 = 最近一次变更）；空数组 = 无变更。前端「变更关联」列按本数组渲染多条变更徽标（悬浮显示变更日期）",
    }),
    finalizedAt: DateTimeSchema.nullable().openapi({
      description:
        "任务定档时间（Push 249 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」）：上传 / 替换时声明为「定档文件」→ 文件定档的同时本任务一并定档（同事务）；**定档后不支持任何修改** —— 字段编辑 / 状态 / 进度 / 完成提交 / 删除 / 文件新增 / 直接替换 / 改名一律 409 TASK_FINALIZED（含批量）；对已定档文件的修改走变更（A4-13 申请即通过）；null = 未定档。Push 260（业务口径「把现在的定档改成 再次点击取消定档吧」）：经 POST …/unfinalize 清回 null（任务重新开放修改；文件级定档不回退）",
    }),
    finalizedBy: UuidSchema.nullable().openapi({
      description: "任务定档操作人（随文件定档同事务写入；与 finalizedAt 成对出现，同为 null = 未定档）",
    }),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .openapi("Task", {
    description:
      "任务（v0.2 §2.3 tasks；展示态与是否按时交付的派生规则见 §2.4、A12~A14）；阶段与负责人可空、组内位次 sort_index 见 A15 / A18 / A19（Push 124）",
  });

/** 任务随行文件摘要（A7）：列表不下发文件名数组（省载荷、免 N+1），文件名清单只在详情接口给。 */
export const TaskFileSummarySchema = z
  .object({
    total: z.number().int().min(0),
    draft: z.number().int().min(0).openapi({ description: "未定档（draft）数量；>0 时完成门禁放行但返回 warning 并触发 R02" }),
    final: z.number().int().min(0).openapi({ description: "已定档（final / changed）数量，仅用于文件摘要展示；完成门禁统计已上传（draft / final / changed）" }),
  })
  .openapi("TaskFileSummary");

/** 任务文件摘要项（详情接口随行下发；列表不带）。 */
export const TaskFileBriefSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    status: FileStatusSchema,
    docType: DocTypeSchema.nullable(),
  })
  .openapi("TaskFileBrief");

/**
 * 任务列表项（A7）：表格 15 列 + 内联摘要（负责人姓名 / 文件摘要）。
 * 前端不再逐行反查 /users 或 /files，避免 N+1；「变更关联」列（第 15 列）直接吃 Task.changeLinks
 * 多条（A1-07），列表与详情同形，不再走单条 changeSummary。
 */
export const TaskListItemSchema = TaskSchema.extend({
  ownerNames: z.array(z.string().nullable()).openapi({
    description: "负责人姓名数组（users.display_name 随行下发，与 ownerIds 同下标一一对应）；「待分配」= 空数组；某位取不到姓名时该位为 null（前端显示「—」）",
  }),
  fileSummary: TaskFileSummarySchema,
}).openapi("TaskListItem");

/** 任务详情（抽屉全字段，A7）：含变更关联（多条）与文件清单；列表走 TaskListItem，抽屉打开时按需请求。 */
export const TaskDetailSchema = TaskSchema.extend({
  ownerNames: z.array(z.string().nullable()).openapi({ description: "负责人姓名数组：与 ownerIds 同下标一一对应；「待分配」= 空数组" }),
  files: z.array(TaskFileBriefSchema),
}).openapi("TaskDetail", { description: "任务详情（M3-01；列表 → 详情不再依赖列表随行数据）" });

/** 任务排序白名单（A8）：字段白名单 + asc / desc，多项逗号分隔；白名单外字段返回 400（不静默降级）。 */
export const TaskSortSchema = z
  .string()
  .regex(
    /^(plannedStart|plannedEnd|actualEnd|progress|title|createdAt)(:(asc|desc))?(,(plannedStart|plannedEnd|actualEnd|progress|title|createdAt)(:(asc|desc))?)*$/,
  )
  .openapi({
    description:
      "排序：sort=field:asc,field2:desc；字段白名单 plannedStart / plannedEnd / actualEnd / progress / title / createdAt（白名单外 400）",
    example: "plannedEnd:asc",
  });

/**
 * 任务列表查询。
 * A8 排序：sort 字段白名单 plannedStart / plannedEnd / actualEnd / progress / title / createdAt，白名单外返回 400；
 * 不传 sort 时为默认顺序 —— 阶段顺序（STAGE_KEYS 序；「未分组」落在最后）+ 组内位次 sort_index ASC + id ASC
 * （A19 / A20 · Push 124：与看板列内顺序同口径；id 兜底保证稳定，分页不跳行）。
 */
export const TaskListQuerySchema = z
  .object({
    stage: StageKeySchema.optional(),
    "filter[ownerId]": UuidSchema.optional().openapi({
      description: "任务负责人（单个 UUID）；命中口径（A23 · Push 136）= 该任务挂的任意一位负责人命中即命中",
    }),
    "filter[status]": z.string().optional().openapi({ description: "展示态（多值逗号分隔）：pending / active / done / overdue / early_done" }),
    q: z.string().optional().openapi({ description: "关键字（中英文任务描述）" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
    sort: TaskSortSchema.optional(),
  })
  .openapi("TaskListQuery", {
    description:
      "任务列表查询（分页 + 单阶段 / 负责人 / 展示态筛选 + 白名单排序）；缺省顺序 = 阶段序（「未分组」在最后）+ 组内位次 sort_index ASC + id ASC",
  });

export const TaskListResponseSchema = z
  .object({
    items: z.array(TaskListItemSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
  })
  .openapi("TaskListResponse", { description: "任务列表（items 为 TaskListItem：表格直接渲染 + 内联摘要）" });

/**
 * 进度更新（A12 / A13 · Push 70）：progress 联动状态与完成日期，回退同样写审计（前端只做展示）。
 * 联动（服务端裁决）：0 → pending；0.25 / 0.5 / 0.75 → active；1 → done（按 actualEnd 与 plannedEnd 派生「已完成 / 提前完成」）。
 * 已过 plannedEnd 且未完成时展示态仍为「已延期」（派生优先，A14），不因点进度条改成「待开始 / 进行中」。
 */
export const TaskProgressUpdateBodySchema = z
  .object({
    progress: TaskProgressSchema,
    actualEnd: DateOnlySchema.optional().openapi({ description: "完成日期（A13）：progress=1 且缺省时服务端按当天（Asia/Shanghai）写入；progress<1 时忽略并清空 —— 清除完成日期的唯一方式是「把进度写回 < 1 档」" }),
    note: z.string().max(2000).optional().openapi({ description: "进度更新备注：提供时写入任务的「项目进展描述」（note）并留痕" }),
    version: VersionSchema,
  })
  .openapi("TaskProgressUpdateBody");

/** 任务完成门禁缺件明细（TASK_REQUIRED_DOC_MISSING 的 details.missing；按已配置成果类型逐类给出）。 */
export const TaskGateMissingSchema = z
  .object({
    docType: DocTypeSchema,
    required: z.number().int().min(0),
    present: z.number().int().min(0),
  })
  .openapi("TaskGateMissing", { description: "缺件明细：required / present 按已配置的成果类型逐类给出；未配置成果类型时不产生缺件" });

/** 完成门禁放行提示（A2-10）：存在未定档（draft）成果文件时放行，返回 warning 并触发 R02（提醒定档）。 */
export const TaskGateWarningSchema = z
  .object({
    code: z.literal("draft_doc_present"),
    docType: DocTypeSchema,
    count: z.number().int().min(0),
  })
  .openapi("TaskGateWarning", { description: "放行提示：存在 draft 成果文件（放行但提示定档，R02 已入队）" });

/** 任务完成提交（M3-03）：表格 / 看板 / 详情三个入口调用同一服务，事务内强校验门禁。 */
export const TaskCompleteBodySchema = z
  .object({
    version: VersionSchema,
    actualEnd: DateOnlySchema.optional().openapi({ description: "完成日期：缺省 = 服务端按当天（Asia/Shanghai）" }),
    note: z.string().max(2000).optional().openapi({ description: "完成备注：提供时写入任务的「项目进展描述」（note）并留痕" }),
  })
  .openapi("TaskCompleteBody", { description: "完成提交（乐观锁 version 必传；门禁未通过 422 + missing）" });

export const TaskCompleteResponseSchema = z
  .object({ task: TaskSchema, warnings: z.array(TaskGateWarningSchema) })
  .openapi("TaskCompleteResponse", { description: "完成结果（warnings 非空 = 已放行但存在未定档成果文件，R02 已入队）" });

/** 任务定档提交（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态，有二次提示」）：抽屉头部开关二次确认后调用。
 * 未定档 → 置位 finalizedAt / finalizedBy 并锁定（此后写口全 409 TASK_FINALIZED）；已定档 → 幂等短路（200 原样返回，不重复写）。 */
export const TaskFinalizeBodySchema = z
  .object({
    version: VersionSchema.openapi({ description: "乐观锁版本（未定档路径必校验；已定档幂等短路不校验）" }),
  })
  .openapi("TaskFinalizeBody", { description: "任务定档提交（version = 抽屉当前行版本）" });

/** 任务取消定档提交（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：抽屉头部「已」开关再次点击 → 二次确认后调用。
 * 已定档 → 清空 finalizedAt / finalizedBy 并重新开放修改（此后可编辑 / 可删；version+1、留痕「取消定档」、outbox task.unfinalized）；未定档 → 幂等短路（200 原样返回，不重复写）。 */
export const TaskUnfinalizeBodySchema = z
  .object({
    version: VersionSchema.openapi({ description: "乐观锁版本（已定档路径必校验；未定档幂等短路不校验）" }),
  })
  .openapi("TaskUnfinalizeBody", { description: "任务取消定档提交（version = 抽屉当前行版本）" });

/** 完成预检（UI 置灰依据；不替代事务内强校验 —— 与节点 can-complete 同口径）。 */
export const TaskCanCompleteResponseSchema = z
  .object({
    canComplete: z.boolean(),
    missing: z.array(TaskGateMissingSchema),
    warnings: z.array(TaskGateWarningSchema),
  })
  .openapi("TaskCanCompleteResponse", { description: "完成预检（canComplete=false 时 missing 给缺件明细）" });

/**
 * 任务创建（A10；2026-09-19 定案入契约）：从任务节点库 / 任务模板生成或手工创建。
 * 默认值：状态 pending、进度 0；headcount / priority 可空（Q8 定案）。
 */
export const TaskCreateBodySchema = z
  .object({
    stageKey: StageKeySchema.nullable().optional().openapi({
      description:
        "所属阶段（A15 · Push 124：可选）—— 缺省 / null = 「未分组」（看板「＋ 添加 → 临时任务」）；带 taskNodeId 时缺省取来源节点所属阶段，显式给出且与节点不一致返回 400",
    }),
    sortIndex: z.number().int().min(0).optional().openapi({
      description:
        "插入位次（A20 · Push 124）：「插入位置」用 —— 0 起（0 = 组内最前）；越界 / 缺省 = 追加到组尾；同组其余任务顺延",
    }),
    title: z.string().min(1).max(200).openapi({ example: "货架组装", description: "任务描述（节点名称）" }),
    titleEn: z.string().max(200).nullable().optional(),
    taskNodeId: UuidSchema.optional().openapi({
      description:
        "来源**项目流程节点**（project_nodes）id：从流程节点生成任务（成员可建）—— 校验节点属于本项目且与 stageKey 一致；同一节点在项目里只留一份（重复 409 TASK_ALREADY_EXISTS）。与 sourceNodeId（节点库节点）二选一",
    }),
    sourceNodeId: UuidSchema.optional().openapi({
      description:
        "来源任务节点库节点（task_nodes）id：从节点库生成任务（A1-16，成员可建）—— 任务描述 / 英文名 / 阶段取节点现值（A1-17 锁定字段），同一项目内同一节点只留一份（重复 409 TASK_ALREADY_EXISTS）；与 taskNodeId（项目流程节点）二选一",
    }),
    ownerIds: z.array(UuidSchema).max(TASK_OWNER_IDS_LIMIT).optional().openapi({
      description:
        "任务负责人：缺省 / 显式 [] = 「待分配」（**2026-09-24 业务口径修订**：任务添加后负责人默认为空 —— 不再兜底项目经理）；传数组 = 整体设置（≤ 200 位），数组顺序 = 展示顺序",
    }),
    plannedStart: DateOnlySchema.nullable().optional(),
    plannedEnd: DateOnlySchema.nullable().optional(),
    estimatedDays: z.number().int().min(0).nullable().optional(),
    headcount: z.number().int().min(0).nullable().optional(),
    priority: PrioritySchema.nullable().optional(),
    deliverableTypes: z.array(DocTypeSchema).max(DOC_TYPES.length).optional().openapi({
      description: "要求输出成果文件（ADR-024 多选，≤ 10 类）：去重（首次出现保序）；缺省 / 空数组 = 不要求",
    }),
    note: z.string().max(2000).nullable().optional(),
  })
  .openapi("TaskCreateBody", { description: "创建任务（进度默认 0、状态默认 pending；从模板生成时与整套添加同口径）" });

/**
 * 任务状态写入值（五态可选 · 2026-09-24 定案「状态下拉五态、联动与原型一致」）。
 * - pending / active / done = 基础三态：服务端同事务联动进度与完成日期（A12）；
 * - overdue（已延期）/ early_done（提前完成）= **显式覆盖**：落 tasks.status_override，展示态优先取覆盖值 ——
 *   已延期 = 保持当前格数与完成日期（不动进度）；提前完成 = 四格全亮 + 完成日期缺省按当天（同已完成）。
 * 覆盖清除：写进度（PATCH …/progress）、写基础三态、完成门禁通过 —— 任一发生即清空，回到读时派生（A14）。
 * 覆盖生效边界（与原型一致）：overdue 仅在未完成时生效、early_done 仅在已完成时生效，其余回落派生。
 */
export const TaskStatusWriteSchema = z
  .enum(["pending", "active", "done", "overdue", "early_done"])
  .openapi("TaskStatusWrite", {
    description: "任务状态写入：基础三态 pending / active / done + 显式覆盖 overdue（已延期）/ early_done（提前完成）",
  });

/**
 * 任务编辑（A10 / A12 · Push 70）：仅开放未锁定字段；任务描述按 A1-17 生成后锁定，进度与完成日期走 /progress。
 * Push 196 起例外：**无来源节点**的任务（看板「添加 → 临时任务」手工创建）的任务描述（title / titleEn）可走本接口直接改 ——
 * 节点 / 模板生成的任务仍锁定；带这俩字段请求节点任务 = 400 VALIDATION_FAILED。
 * 2026-10-08（业务口径「文件输出成果也要可以选择」）：**输出成果文件（deliverableTypes）改为常规编辑开放** ——
 * 原「生成后锁定、修正走管理员例外调整（locked-fields）」下架；locked-fields 端点自身保留（任务描述例外调整）。
 */
export const TaskUpdateBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional().openapi({
      description:
        "任务描述（中文；Push 196）：仅**无来源节点**的任务可改（看板「添加 → 临时任务」手工创建）；节点 / 模板生成的任务按 A1-17 锁定，带该字段请求 400",
    }),
    titleEn: z.string().max(200).nullable().optional().openapi({
      description: "任务描述（英文；Push 196）：与 title 同一门禁；null = 清空",
    }),
    ownerIds: z.array(UuidSchema).max(TASK_OWNER_IDS_LIMIT).optional().openapi({
      description: "任务负责人（A23 · Push 136）：不传 = 不改；显式 [] = 置空为「待分配」（卡片拖进「待分配」列）；传数组 = 整体替换（≤ 200 位）、顺序 = 展示顺序",
    }),
    sortIndex: z.number().int().min(0).optional().openapi({
      description:
        "组内位次（A19 / A20 · Push 124）：把任务移到该组第 N 位（0 起，越界 = 组尾）—— 同组其余任务位次顺延；不传 = 不动顺序",
    }),
    status: TaskStatusWriteSchema.optional().openapi({
      description:
        "任务状态（五态可选 · 2026-09-24 定案）：pending / active / done 服务端同事务回填进度与完成日期（done → progress=1 且 actualEnd 缺省按当天；active → progress 至少 1 格（0 → 0.25；满格 → 0.75）并清 actualEnd；pending → progress=0 并清 actualEnd）；overdue / early_done 为显式覆盖（见 TaskStatusWrite）",
    }),
    plannedStart: DateOnlySchema.nullable().optional(),
    plannedEnd: DateOnlySchema.nullable().optional(),
    estimatedDays: z.number().int().min(0).nullable().optional(),
    headcount: z.number().int().min(0).nullable().optional(),
    priority: PrioritySchema.nullable().optional(),
    deliverableTypes: z.array(DocTypeSchema).max(DOC_TYPES.length).optional().openapi({
      description:
        "要求输出成果文件（2026-10-08 业务口径「文件输出成果也要可以选择」）：常规编辑开放 —— 传数组 = 整体替换（≤ 10 类，去重、首次出现保序）；显式 [] = 不要求；缺省 = 不改",
    }),
    note: z.string().max(2000).nullable().optional(),
    version: VersionSchema,
  })
  .openapi("TaskUpdateBody", {
    description:
      "编辑任务（乐观锁 version 必传；阶段不在本接口；status 支持五态并联动进度与完成日期，进度 / 完成日期仍走 /progress；ownerIds 显式 [] = 待分配、传数组 = 整体替换，sortIndex = 组内重排）；title / titleEn（Push 196）仅**未归入阶段**的临时任务可改，阶段任务 / 节点 / 模板生成的任务仍锁定（带字段请求 400）；deliverableTypes（2026-10-08 起）常规编辑开放，原「生成后锁定 / 仅管理员例外调整」下架",
  });

/** 从任务模板批量生成任务（「整套添加」）：按节点判重，已存在默认跳过。 */
export const TaskCreateFromTemplateBodySchema = z
  .object({
    templateId: UuidSchema,
    nodeIds: z.array(UuidSchema).max(TASK_TEMPLATE_NODE_IDS_LIMIT).optional().openapi({ description: "只添加模板内的部分节点（≤ 500 个；缺省 = 模板全部节点）；必须是该模板包含的节点，否则 400" }),
    skipExisting: z.boolean().default(true).openapi({ description: "已存在的节点跳过并计入 skipped（默认 true）；false 时遇重复返回 409" }),
    ownerIds: z.array(UuidSchema).max(TASK_OWNER_IDS_LIMIT).optional().openapi({ description: "任务负责人（≤ 200 位）：缺省 = 「待分配」（2026-09-24 业务口径修订：不再兜底项目经理）；显式 [] 同义" }),
    sortIndex: z.number().int().min(0).optional().openapi({
      description: "起始插入位次（A20）：整批按模板内顺序依次落位（第 k 条 = sortIndex + k）；越界 / 缺省 = 追加到组尾",
    }),
    priority: PrioritySchema.nullable().optional().openapi({
      description: "生成任务的紧急重要度（可空 = 不写）；节点库暂无「默认紧急重要度」列（A1-17 映射待补），先由调用方给",
    }),
  })
  .openapi("TaskCreateFromTemplateBody", { description: "从任务模板生成任务（批量；同一节点在项目里只留一份）" });

export const TaskCreateFromTemplateResponseSchema = z
  .object({
    created: z.array(TaskSchema),
    skipped: z
      .array(z.object({ nodeId: UuidSchema, taskId: UuidSchema }))
      .openapi({ description: "skipExisting=true 时跳过的节点及其已存在的任务" }),
  })
  .openapi("TaskCreateFromTemplateResponse");

/** 批量失败原因（A1-08：部分失败返回失败清单及原因；成功后失败项留在 failures，同批成功项照常生效）。 */
export const TASK_BATCH_FAILURE_CODES = [
  "not_found",
  "archived",
  "gate_not_passed",
  "already_done",
  "version_conflict",
  "invalid_state",
  "finalized",
] as const;

export const TaskBatchFailureCodeSchema = z.enum(TASK_BATCH_FAILURE_CODES).openapi("TaskBatchFailureCode", {
  description:
    "批量失败原因：not_found 任务不存在 / 不属于该项目 / 已软删；archived 项目已归档；gate_not_passed 完成门禁缺件；already_done 任务已完成；version_conflict 并发写入冲突；invalid_state 其它业务校验失败；finalized 任务已定档（不支持任何修改，Push 249）",
});

export const TaskBatchFailureSchema = z
  .object({
    id: UuidSchema.openapi({ description: "失败的任务 id（原样回传，前端按行标红）" }),
    code: TaskBatchFailureCodeSchema,
    message: z.string().openapi({ description: "失败原因（可直接展示）" }),
    missing: z
      .array(TaskGateMissingSchema)
      .optional()
      .openapi({ description: "code=gate_not_passed 时的缺件明细（与完成门禁同形：docType / required / present）" }),
  })
  .openapi("TaskBatchFailure", { description: "批量失败项（逐条校验结果；失败不影响同批成功项）" });

/**
 * 批量变更字段（白名单 · M3-04 / 系统功能书 A1-08）：批量指派负责人 / 改状态（含批量完成）/ 改日期 / 改重要度 / 改人数 / 改备注。
 * 不含任务描述 / 成果文件（A1-17 生成后锁定）与组内位次（顺序调整是「插入位置」的逐条语义）；至少给一个键，否则 400 VALIDATION_FAILED。
 * 语义与单条 TaskUpdateBody 一致（null = 清空该字段、缺键 = 不改）；status 只收基础三态，done 走同一完成门禁。
 */
export const TaskBatchChangesSchema = z
  .object({
    ownerIds: z.array(UuidSchema).max(TASK_OWNER_IDS_LIMIT).optional().openapi({ description: "批量指派负责人（A23，≤ 200 位）：显式 [] = 全部置为「待分配」；传数组 = 整体替换（顺序 = 展示顺序）" }),
    status: TaskStatusWriteSchema.optional().openapi({
      description:
        "批量改状态（五态可选，口径同单条编辑）：done = 批量完成（逐条走同一完成门禁，缺件项进 failures 的 gate_not_passed）；overdue / early_done = 显式覆盖",
    }),
    plannedStart: DateOnlySchema.nullable().optional(),
    plannedEnd: DateOnlySchema.nullable().optional().openapi({ description: "批量改期（开始 / 预计完成）；提醒重算随 C2 规则引擎（i8 / i9）" }),
    estimatedDays: z.number().int().min(0).nullable().optional(),
    headcount: z.number().int().min(0).nullable().optional(),
    priority: PrioritySchema.nullable().optional().openapi({ description: "批量改紧急重要度（A1-08）" }),
    note: z.string().max(2000).nullable().optional(),
  })
  .openapi("TaskBatchChanges", {
    description: "批量变更字段（白名单；语义同单条编辑：null = 清空、缺键 = 不改；至少给一个键）",
  });

/** 批量操作请求（M3-04）：ids（1~100，重复 id 只处理一次）+ 同一组变更。 */
export const TaskBatchBodySchema = z
  .object({
    ids: z
      .array(UuidSchema)
      .min(1)
      .max(100)
      .openapi({ description: "目标任务 id（1~100；重复 id 去重后按首次出现顺序逐条处理；不属于本项目的 id 计为该条 not_found，不影响同批其它项）" }),
    changes: TaskBatchChangesSchema,
  })
  .openapi("TaskBatchBody", {
    description: "批量操作（系统功能书 A1-08）：逐条校验 + 逐条独立事务（避免长事务）；部分失败返回失败清单，成功项照常生效",
  });

export const TaskBatchResponseSchema = z
  .object({
    total: z.number().int().min(0).openapi({ description: "去重后的目标条数" }),
    succeededCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    succeeded: z.array(TaskSchema).openapi({ description: "成功项（更新后的任务全量视图，前端按行替换）" }),
    failures: z.array(TaskBatchFailureSchema).openapi({ description: "失败项清单（含原因；顺序 = 处理顺序）" }),
  })
  .openapi("TaskBatchResponse", { description: "批量操作结果（整体 200：部分失败不影响成功项，失败清单给出逐条原因）" });

export type TaskBatchFailureCode = z.infer<typeof TaskBatchFailureCodeSchema>;
export type TaskBatchFailure = z.infer<typeof TaskBatchFailureSchema>;
export type TaskBatchChanges = z.infer<typeof TaskBatchChangesSchema>;
export type TaskBatchBody = z.infer<typeof TaskBatchBodySchema>;
export type TaskBatchResponse = z.infer<typeof TaskBatchResponseSchema>;

/**
 * 删除响应（M3-05 · A25 · 系统功能书 A1-01 修订）：软删只回标记，不回整行（前端列表本地移除即可）。
 * 重复删除 / 已删任务上的任何操作 = 统一 404（记录级 404 语义），不新增错误码。
 */
export const TaskDeleteResponseSchema = z
  .object({
    id: UuidSchema,
    deleted: z.boolean().openapi({ description: "恒为 true（软删：tasks.deleted_at 置位，不物理删行；历史与留痕保留）" }),
  })
  .openapi("TaskDeleteResponse", {
    description: "任务删除结果（软删）：列表 / 看板 / 甘特图 / 完成门禁一律不可见，来源节点约束随之释放",
  });

export type TaskDeleteResponse = z.infer<typeof TaskDeleteResponseSchema>;

/**
 * 锁定字段例外调整（A1-17 / C9-07 · M3-05 · Push 153）：任务描述按流程节点模板生成后锁定，
 * 常规编辑（PATCH /tasks/{taskId}）不可达；确需修正时由**系统管理员**执行「例外调整」—— 原因必填并留痕（模板本身由管理员修正，C9-07）。
 * 2026-10-08（业务口径「文件输出成果也要可以选择」）：输出成果文件（deliverableTypes）改为常规编辑开放，
 * 常规路径见 TaskUpdateBodySchema；本端点 body 该字段保留（既有例外修正通道不动）。
 * 「阶段性里程」一期任务无对应列（A1-17 映射修订），故 body 不做字段扩展。
 */
export const TaskLockedFieldsAdjustBodySchema = z
  .object({
    version: VersionSchema,
    reason: z.string().min(1).max(500).openapi({ description: "例外调整原因（必填并留痕；A1-17 / C9-07）" }),
    title: z.string().min(1).max(200).optional().openapi({ description: "任务描述（中文；锁定字段 —— 仅管理员例外修正）" }),
    titleEn: z.string().max(200).nullable().optional().openapi({ description: "任务描述（英文；锁定项；null = 清空）" }),
    deliverableTypes: z.array(DocTypeSchema).max(DOC_TYPES.length).optional().openapi({
      description:
        "要求输出成果文件（锁定项，≤ 10 类，多选去重、首次出现保序）：修正后即刻成为完成门禁依据（有节点任务仍以节点 node_requirements 为准，本字段只作无节点任务兜底）",
    }),
  })
  .openapi("TaskLockedFieldsAdjustBody", {
    description:
      "锁定字段例外调整（仅系统管理员）：至少给出一个实际变化的字段，否则 400；原因必填并留痕（审计 + task.locked_fields_adjusted）",
  });
