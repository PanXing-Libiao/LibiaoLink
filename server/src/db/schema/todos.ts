/**
 * 自定义待办（C2-06 / A14 · M5-06-3 · 迁移 0062）：一条 = 一个待办，提醒时间 + 重复规则由
 * AutomationSubjectReader 按调度窗口展开为逐次 `todo.remind_date`；提醒对象 = `reminder_user_ids`
 * （逐人展开主体，多人时引擎幂等键编入成员 id，避免串人）。
 *
 * 口径来源：系统功能书 C2-06（标题 / 内容 / 关联项目或任务 / 提醒时间 / 提醒对象 / 重复规则）；
 * docs/rules/A01-A03-A14-扩展规则文案.md A14；docs/M5-06-实施方案与执行计划 §9 M5-06-3。
 * `repeat_rule`：none 仅提醒一次 / daily 每日 / weekly 每周同星期 / monthly 每月同日（短月无该日则跳过）；
 * `repeat_until` 含当日，null = 不限；提醒日期按 Asia/Shanghai（ADR-028）折算。
 * `user_id` = 待办归属人（创建人）；`reminder_user_ids` 为实际提醒对象（不设数组元素 FK，用户删除后由读面过滤）。
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
import { projects } from "./projects.js";
import { tasks } from "./tasks.js";

/** 待办状态（A14 条件：status != done 才提醒）。 */
export const TODO_STATUSES = ["pending", "done"] as const;
/** 重复规则（待办模块只存规则，展开在 automation 主体读取层按窗口逐日求值）。 */
export const TODO_REPEAT_RULES = ["none", "daily", "weekly", "monthly"] as const;

export const todos = pgTable(
  "todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 归属人 / 创建人（A6-05「我的待办」）。 */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** 待办内容（可空：A14 正文空内容止于句号）。 */
    content: text("content"),
    /** 关联项目 / 任务（C2-06；两者均可空、可同时给出，深链由投递层使用，不进正文）。 */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** 首次提醒时刻（timestamptz；业务日按 Asia/Shanghai 折算）。 */
    remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
    repeatRule: text("repeat_rule").notNull().default("none"),
    /** 重复截止日（含当日；null = 不限；none 时允许 null / 等于首次提醒日）。 */
    repeatUntil: date("repeat_until"),
    /** 提醒对象（至少 1 人；数组顺序 = 展示顺序）。 */
    reminderUserIds: uuid("reminder_user_ids")
      .array()
      .notNull()
      .default(sql`array[]::uuid[]`),
    status: text("status").notNull().default("pending"),
    /** 完成时刻（status = done 时非空，成对不变式）。 */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("ix_todos_remind").on(table.remindAt, table.id),
    index("ix_todos_owner").on(table.userId, table.id),
    index("ix_todos_reminder_users").using("gin", table.reminderUserIds),
    check("ck_todos_title", sql`char_length(btrim(${table.title})) between 1 and 200`),
    check(
      "ck_todos_content",
      sql`${table.content} is null or char_length(${table.content}) <= 4000`,
    ),
    check("ck_todos_repeat_rule", sql`${table.repeatRule} in ('none', 'daily', 'weekly', 'monthly')`),
    check(
      "ck_todos_repeat_until",
      sql`${table.repeatUntil} is null or ${table.repeatUntil} >= (${table.remindAt} at time zone 'Asia/Shanghai')::date`,
    ),
    check(
      "ck_todos_reminder_users",
      sql`cardinality(${table.reminderUserIds}) >= 1 and array_position(${table.reminderUserIds}, null) is null`,
    ),
    check("ck_todos_status", sql`${table.status} in ('pending', 'done')`),
    check(
      "ck_todos_completed",
      sql`(${table.status} = 'done') = (${table.completedAt} is not null)`,
    ),
    check("ck_todos_timestamps", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);
