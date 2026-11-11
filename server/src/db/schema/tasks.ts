import { desc, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projectNodes } from "./flow.js";
import { STAGE_KEYS, sqlValueList } from "./literals.js";
import { users } from "./identity.js";
import { projects } from "./projects.js";
import { taskNodes } from "./templates.js";

/** tasks（项目总览 15 列口径；status 为存储基础态，展示态派生，见 v0.2 §2.4）。 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    /** 可空（A15 · Push 124）：看板「＋ 添加 → 临时任务」先不带阶段，前端显示「未分组」。 */
    stageKey: text("stage_key"),
    nodeId: uuid("node_id").references(() => projectNodes.id),
    /**
     * 来源任务节点库节点（迁移 0034 · M3-07 刀 3 · A1-16）：与 node_id（**项目流程节点** / 蓝图实例）并行、互不替代 ——
     * 节点库节点回答「任务从哪来」，流程节点是门禁与锁定字段的依据。手工创建 / 流程节点生成的任务为 null。
     * 同一项目内同一节点只留一份（下方部分唯一索引，未删行参与）：重复 409 TASK_ALREADY_EXISTS，软删后回到「可添加」；
     * 节点库物理删行时置空（on delete set null），已生成的项目任务保留。
     */
    taskNodeId: uuid("task_node_id").references(() => taskNodes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    titleEn: text("title_en"),
    /**
     * 任务负责人（A23 · Push 136）：可多位、数组顺序 = 展示顺序；空数组 = 「待分配」（A18 合法中间状态）。
     * 空默认值与「未分配」同义，存量 / 新建都不写 null。
     */
    ownerIds: uuid("owner_ids").array().notNull().default(sql`array[]::uuid[]`),
    /**
     * 本条任务的项目经理（2026-11-10）：至少一位、数组顺序 = 展示顺序；新建继承项目当前经理，
     * 行内修改只影响本条任务。projects.manager_ids 独立维护，不汇总任务经理；任务经理不获得整项目编辑权。
     */
    managerIds: uuid("manager_ids").array().notNull(),
    status: text("status").notNull(),
    /**
     * 状态显式覆盖（2026-09-24 定案 · 迁移 0031）：五态下拉里的「已延期 / 提前完成」落这里（原型 statusOverride 的落库版）。
     * 读时优先：overdue 仅在未完成时生效、early_done 仅在已完成时生效，其余回落派生（task.rules.ts）；
     * 写进度 / 写基础三态 / 门禁完成即清空（回到派生）。null = 无覆盖。
     */
    statusOverride: text("status_override"),
    progress: numeric("progress", { precision: 3, scale: 2 }).notNull().default("0"),
    plannedStart: date("planned_start"),
    plannedEnd: date("planned_end"),
    actualEnd: date("actual_end"),
    estimatedDays: smallint("estimated_days"),
    headcount: smallint("headcount"),
    priority: text("priority"),
    /** 要求输出成果文件（ADR-024 多选 · Push 143）：text[] 非空、空数组 = 不要求；顺序 = 展示顺序（去重在应用层保证）。 */
    deliverableTypes: text("deliverable_types")
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    note: text("note"),
    onTime: boolean("on_time"),
    /**
     * 变更关联（A1-07 / R01「追加＋去重」· 迁移 0020）：一条任务可关联多条变更 —— 数组顺序 = 关联先后
     * （追加序，末位 = 最近一次变更）；空数组 = 无变更。多值后不再保留单列外键（Postgres 无数组外键；
     * change_requests 为只追加表、无删除路径），「无 NULL 元素」由 ck_tasks_change_refs_no_null 兜底。
     */
    changeRefs: uuid("change_refs")
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** 组内位次（A19 / A20 · Push 124）：一组 = 同一项目 + 同一阶段（null = 未分组）；0 起、密集。 */
    sortIndex: integer("sort_index").notNull().default(0),
    /**
     * 软删（M3-05 · A25 · 迁移 0022）：置位后列表 / 看板 / 甘特图 / 完成门禁 / 节点判重一律不可见
     * （读面统一过滤 deleted_at is null），节点约束随之释放；不物理删行（历史与留痕保留）。
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * 任务定档（Push 249 · 迁移 0044）：定档某文件（files.finalize → final）时同事务置位其挂接任务的这两列
     * （文件模块 finalizeFile）或任务侧显式定档（Push 252：POST /projects/{id}/tasks/{taskId}/finalize —— 抽屉头部「定档」开关）；置位后任务写口（编辑 / 批量 / 进度 / 完成 / 删除 /
     * 锁定字段例外调整）与文件直接写口（新增 / 直替 / 改名）一律 409 TASK_FINALIZED，修改走变更（A4-13）。
     * 成对不变式：要么都空（未定档）、要么都有（ck_tasks_finalized_pair）。
     */
    deletedBy: uuid("deleted_by").references(() => users.id),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by").references(() => users.id),
  },
  (table) => [
    index("ix_tasks_project_stage").on(table.projectId, table.stageKey),
    /**
     * 历史排序索引（0015 · w2）：M3-06 真机对照定案（p50 倍率 0.94x ~ 1.02x）后由迁移 `0024` 下线 ——
     *  读面恒带 `deleted_at is null`，由下方部分索引 ix_tasks_active_group 完整覆盖，双索引只剩写放大。
     */
    index("ix_tasks_owner_ids").using("gin", table.ownerIds),
    index("ix_tasks_manager_ids").using("gin", table.managerIds),
    index("ix_tasks_deliverable_types").using("gin", table.deliverableTypes),
    index("ix_tasks_change_refs").using("gin", table.changeRefs),
    index("ix_tasks_due").on(table.projectId, table.actualEnd, table.plannedEnd),
    /** 未删行专用（0022）：列表 / 看板顺序读（project_id, stage_key, sort_index）—— 读面恒带 deleted_at is null。 */
    index("ix_tasks_active_group").on(table.projectId, table.stageKey, table.sortIndex).where(sql`deleted_at is null`),
    /** 任务侧「节点库来源」判重（0034）：同一项目内同一节点库节点只留一份（只约束未删行）。 */
    uniqueIndex("uq_tasks_active_source_node")
      .on(table.projectId, table.taskNodeId)
      .where(sql`deleted_at is null and task_node_id is not null`),
    check(
      "ck_tasks_stage_key",
      sql`${table.stageKey} in ${sql.raw(sqlValueList(STAGE_KEYS))}`,
    ),
    check("ck_tasks_status", sql`${table.status} in ${sql.raw(sqlValueList(["pending", "active", "done"]))}`),
    check(
      "ck_tasks_status_override",
      sql`${table.statusOverride} is null or ${table.statusOverride} in ${sql.raw(sqlValueList(["overdue", "early_done"]))}`,
    ),
    check("ck_tasks_progress", sql`${table.progress} in (0, 0.25, 0.5, 0.75, 1)`),
    check("ck_tasks_headcount", sql`${table.headcount} is null or ${table.headcount} >= 0`),
    check(
      "ck_tasks_estimated_days",
      sql`${table.estimatedDays} is null or ${table.estimatedDays} >= 0`,
    ),
    check("ck_tasks_sort_index", sql`${table.sortIndex} >= 0`),
    check("ck_tasks_owner_ids_no_null", sql`array_position(${table.ownerIds}, null::uuid) is null`),
    check("ck_tasks_manager_ids", sql`cardinality(${table.managerIds}) >= 1`),
    check("ck_tasks_manager_ids_no_null", sql`array_position(${table.managerIds}, null::uuid) is null`),
    check("ck_tasks_deliverable_types_no_null", sql`array_position(${table.deliverableTypes}, null::text) is null`),
    check("ck_tasks_deliverable_types_no_empty", sql`array_position(${table.deliverableTypes}, ''::text) is null`),
    check("ck_tasks_change_refs_no_null", sql`array_position(${table.changeRefs}, null::uuid) is null`),
    check("ck_tasks_finalized_pair", sql`(${table.finalizedAt} is null) = (${table.finalizedBy} is null)`),
  ],
);

/** task_events（字段级留痕：状态 / 日期 / 进度 / 描述变更）。 */
export const taskEvents = pgTable(
  "task_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: uuid("task_id").notNull().references(() => tasks.id),
    eventType: text("event_type").notNull(),
    beforeValue: text("before_value"),
    afterValue: text("after_value"),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ix_task_events_task").on(table.taskId, desc(table.createdAt)),
    check(
      "ck_task_events_type",
      sql`${table.eventType} in ${sql.raw(sqlValueList(["status_change", "date_change", "progress_change", "note_change"]))}`,
    ),
  ],
);
