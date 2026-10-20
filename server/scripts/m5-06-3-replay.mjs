#!/usr/bin/env node
/**
 * M5-06-3 真机回放（Docker PostgreSQL 18 / 已迁移库）：
 *   ① todos 主体读取：none / daily / weekly / monthly 重复规则按窗口逐日展开；
 *   ② 多提醒对象逐人展开：entityId 编入成员 id，A14 幂等键不串人；
 *   ③ 已完成待办仍产主体但引擎 not_matched；提醒对象全部删除 → recipient_missing；
 *   ④ A14 引擎产出：双渠道逐字、幂等键唯一、重复规划不新增 outbox（dedupe 唯一约束）；
 *   ⑤ A01 已提醒回读：仅 sent、按业务日与渠道后缀匹配，失败 / 前一日不算。
 *
 * 前置：server/dist 已构建；目标库已迁移（0001~0062）。空库创建与角色授权由调用方完成：
 *   docker exec libiaolink-pg createdb -U postgres <db>
 *   psql -U postgres -d <db> -f database/roles/0001_roles.sql
 *   DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/<db> node database/scripts/migrate.mjs
 * 用法：cd server && node scripts/m5-06-3-replay.mjs [--database-url <url>] [--json <path>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..");
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_06_3_REPLAY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_api@127.0.0.1:55432/libiaolink_m5_06_3";

const TAG = "M5-06-3-REPLAY-" + randomUUID().slice(0, 8);
const checks = [];
let pass = 0;
let fail = 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--keep") out.keep = true;
    else if (item === "--help" || item === "-h") {
      console.log("用法：node scripts/m5-06-3-replay.mjs [--database-url <url>] [--json <path>] [--keep]");
      process.exit(0);
    } else throw new Error("未知参数：" + item);
  }
  return out;
}

async function check(name, work) {
  try {
    const detail = await work();
    pass += 1;
    checks.push({ name, ok: true, detail: detail ?? null });
    console.log("PASS  " + name + (detail === undefined || detail === null ? "" : " —— " + detail));
  } catch (error) {
    fail += 1;
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    console.error("FAIL  " + name + " —— " + (error instanceof Error ? error.message : String(error)));
  }
}

function todoKey(todoId, memberId, date) {
  return "A14:" + todoId + (memberId === null ? "" : ":" + memberId) + ":" + date;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "m5-06-3-replay" });
  const db = drizzle(pool);
  const schemaPath = join(SERVER_ROOT, "dist", "db", "schema", "index.js");
  const subjectsPath = join(SERVER_ROOT, "dist", "outbox", "automation-subjects.js");
  const automationPath = join(SERVER_ROOT, "dist", "modules", "automation", "index.js");
  const deliveryReadPath = join(SERVER_ROOT, "dist", "modules", "notify", "notify.delivery-read.repository.js");
  const schema = await import(pathToFileURL(schemaPath).href);
  const subjectsModule = await import(pathToFileURL(subjectsPath).href);
  const automation = await import(pathToFileURL(automationPath).href);
  const deliveryReadModule = await import(pathToFileURL(deliveryReadPath).href);
  const {
    notifyDeliveryMessages,
    outboxEvents,
    projectMembers,
    projects,
    todos,
    users,
  } = schema;

  const ids = {
    u1: randomUUID(),
    u2: randomUUID(),
    u3: randomUUID(),
    deleted: randomUUID(),
    project: randomUUID(),
    todoDaily: randomUUID(),
    todoWeekly: randomUUID(),
    todoDone: randomUUID(),
    todoDeletedTarget: randomUUID(),
    todoMonthly31: randomUUID(),
  };
  const allTodoIds = [
    ids.todoDaily,
    ids.todoWeekly,
    ids.todoDone,
    ids.todoDeletedTarget,
    ids.todoMonthly31,
  ];
  const deliveryKeys = [
    "A01:" + ids.u1 + ":2026-10-21",
    "A01:" + ids.u2 + ":2026-10-21:aibot",
    "A01:" + ids.u3 + ":2026-10-21",
    "A01:" + ids.u3 + ":2026-10-21:app",
    "A01:" + ids.u1 + ":2026-10-20",
    "A14:" + ids.todoDaily + ":" + ids.u1 + ":2026-10-21",
  ];
  const outboxKeys = [];
  const database = { pool, db };
  const calendar = {
    async getYear() {
      return { year: 2026, days: [], settings: { shiftReminder: false, shiftDirection: "forward" } };
    },
  };
  const reader = new subjectsModule.AutomationSubjectReader(database, calendar);
  const deliveryReads = new deliveryReadModule.NotifyDeliveryReadRepository(database);

  try {
    await seedFixtures();

    const window = {
      from: new Date("2026-10-20T16:00:00.000Z"),
      to: new Date("2026-10-23T15:59:59.999Z"),
    };
    const at = new Date("2026-10-23T16:00:00.000Z");
    const bundle = await reader.loadWindow(window, at, db);
    const todoSubjects = bundle.subjects.filter((subject) => subject.kind === "todo");

    await check("A14 主体：daily 2 人 × 3 日 + weekly 1 次 + done 1 次 + 无可用对象 1 次 = 9", async () => {
      assert.equal(todoSubjects.length, 9);
      assert.equal(todoSubjects.filter((subject) => subject.id === ids.todoDaily + ":" + ids.u1).length, 3);
      assert.equal(todoSubjects.filter((subject) => subject.id === ids.todoDaily + ":" + ids.u2).length, 3);
      assert.equal(todoSubjects.filter((subject) => subject.id === ids.todoWeekly).length, 1);
      assert.equal(todoSubjects.filter((subject) => subject.id === ids.todoDone).length, 1);
      assert.equal(todoSubjects.filter((subject) => subject.id === ids.todoDeletedTarget).length, 1);
      return "todo 主体 9 条";
    });

    await check("A14 重复展开：daily 10-21/22/23；weekly 仅 10-21；monthly 短月跳过", async () => {
      const dailyDates = todoSubjects
        .filter((subject) => subject.id === ids.todoDaily + ":" + ids.u1)
        .map((subject) => subject.fields["todo.remind_date"])
        .sort();
      assert.deepEqual(dailyDates, ["2026-10-21", "2026-10-22", "2026-10-23"]);
      const weekly = todoSubjects.find((subject) => subject.id === ids.todoWeekly);
      assert.equal(weekly?.fields["todo.remind_date"], "2026-10-21");
      const february = await reader.loadWindow(
        { from: new Date("2026-01-31T16:00:00.000Z"), to: new Date("2026-02-28T15:59:59.999Z") },
        new Date("2026-02-28T16:00:00.000Z"),
        db,
      );
      assert.equal(february.subjects.filter((subject) => subject.id === ids.todoMonthly31).length, 0);
      return "daily 3 次 / weekly 1 次 / 2 月无 31 日";
    });

    await check("A14 提醒对象：多对象 entityId 编入成员 id；全删除对象留 recipient_missing", async () => {
      const dailyU1 = todoSubjects.find(
        (subject) => subject.id === ids.todoDaily + ":" + ids.u1 && subject.fields["todo.remind_date"] === "2026-10-21",
      );
      assert.equal(dailyU1?.recipients["rule.members"]?.id, ids.u1);
      assert.equal(dailyU1?.recipients["rule.members"]?.name, "提醒对象甲");
      const deletedTarget = todoSubjects.find((subject) => subject.id === ids.todoDeletedTarget);
      assert.equal(deletedTarget?.recipients["rule.members"], null);
      return "多对象键 = <todo>:<member>；删除对象 = null";
    });

    const rules = automation.BUILTIN_RULES.map((rule) => ({ ...rule, enabled: true }));
    const plan = automation.planWindowMessages({
      jobKind: automation.AUTOMATION_SCHEDULE_JOB_KIND,
      window,
      rules,
      subjects: bundle.subjects,
      at,
      calendar: bundle.calendar,
    });
    const a14 = plan.messages.filter((message) => message.ruleCode === "A14");

    await check("A14 引擎：daily 12 + weekly 2 = 14 条；done 不命中；删除对象 recipient_missing", async () => {
      assert.equal(a14.length, 14);
      assert.equal(a14.filter((message) => message.entityId === ids.todoDone).length, 0);
      assert.equal(a14.filter((message) => message.entityId === ids.todoDeletedTarget).length, 0);
      assert.equal(plan.details.find((detail) => detail.entityId === ids.todoDone)?.skipped, "not_matched");
      assert.equal(plan.details.find((detail) => detail.entityId === ids.todoDeletedTarget)?.skipped, "recipient_missing");
      return "A14 消息 14 条";
    });

    await check("A14 幂等键：多人不串键；双渠道同键；单对象保持 <todo>:<date>", async () => {
      const keys = new Set(a14.map((message) => message.dedupeKey));
      for (const date of ["2026-10-21", "2026-10-22", "2026-10-23"]) {
        assert.ok(keys.has(todoKey(ids.todoDaily, ids.u1, date)));
        assert.ok(keys.has(todoKey(ids.todoDaily, ids.u2, date)));
      }
      assert.ok(keys.has(todoKey(ids.todoWeekly, null, "2026-10-21")));
      assert.equal(keys.size, 7);
      assert.equal(new Set(a14.map((message) => message.dedupeKey + "|" + message.channel)).size, 14);
      return "去重键 7 个 / 投放面 14 个";
    });

    await check("A14 重复规划：两次结果逐键一致；outbox dedupe 唯一约束阻止第二份", async () => {
      const again = automation.planWindowMessages({
        jobKind: automation.AUTOMATION_SCHEDULE_JOB_KIND,
        window,
        rules,
        subjects: bundle.subjects,
        at,
        calendar: bundle.calendar,
      });
      const identity = (message) =>
        [message.ruleCode, message.entityId, message.windowKey, message.channel, message.recipientId, message.dedupeKey].join("|");
      assert.deepEqual(again.messages.map(identity).sort(), plan.messages.map(identity).sort());
      for (const message of a14) {
        outboxKeys.push(message.dedupeKey + (message.channel === "wecom_aibot" ? ":aibot" : ""));
      }
      const insert = () =>
        db
          .insert(outboxEvents)
          .values(outboxKeys.map((dedupeKey) => ({ topic: "notify.message", payload: {}, dedupeKey, status: "pending" })))
          .onConflictDoNothing()
          .returning({ id: outboxEvents.id });
      const first = await insert();
      const second = await insert();
      assert.equal(first.length, 14);
      assert.equal(second.length, 0);
      return "首次 14 / 复跑 0";
    });

    await check("A01 已提醒回读：仅 sent；按业务日 + 渠道后缀；失败 / 前一日不算", async () => {
      const result = await deliveryReads.findReminderSentAt(
        "A01",
        "2026-10-21",
        [ids.u1, ids.u2, ids.u3],
        db,
      );
      assert.equal(result.get(ids.u1)?.toISOString(), "2026-10-21T11:30:00.000Z");
      assert.equal(result.get(ids.u2)?.toISOString(), "2026-10-21T11:31:00.000Z");
      assert.equal(result.get(ids.u3)?.toISOString(), "2026-10-21T11:32:00.000Z");
      assert.equal(result.size, 3);
      return "u1 inbox / u2 aibot / u3 app";
    });

    await check("A01 已提醒回读：空名册不查库、其他规则不串", async () => {
      const empty = await deliveryReads.findReminderSentAt("A01", "2026-10-21", [], db);
      assert.equal(empty.size, 0);
      const otherRule = await deliveryReads.findReminderSentAt("A14", "2026-10-21", [ids.u1], db);
      assert.equal(otherRule.size, 0);
      return "空集 0 / A14 0";
    });
  } finally {
    if (!args.keep) await cleanup();
    await pool.end();
  }

  const result = {
    tag: TAG,
    database: DATABASE_URL.replace(/\/\/([^:@]+)(:[^@]*)?@/, "//$1:***@"),
    pass,
    fail,
    checks,
  };
  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2));
  console.log("M5-06-3 replay：" + pass + " / " + (pass + fail) + (fail === 0 ? " 全过" : " 有失败"));
  process.exit(fail === 0 ? 0 : 1);

  async function seedFixtures() {
    await db.insert(users).values([
      { id: ids.u1, casdoorId: TAG + "-u1", username: TAG + "-u1", displayName: "提醒对象甲" },
      { id: ids.u2, casdoorId: TAG + "-u2", username: TAG + "-u2", displayName: "提醒对象乙" },
      { id: ids.u3, casdoorId: TAG + "-u3", username: TAG + "-u3", displayName: "提醒对象丙" },
    ]);
    await db.insert(projects).values({
      id: ids.project,
      code: TAG + "-P",
      name: TAG + " 项目",
      region: "华东",
      projectType: "测试",
      managerIds: [ids.u1],
      stageKey: "install",
      status: "active",
    });
    await db.insert(projectMembers).values([
      { projectId: ids.project, userId: ids.u1, roleInProject: "project_manager" },
      { projectId: ids.project, userId: ids.u2, roleInProject: "project_member" },
    ]);
    await db.insert(todos).values([
      {
        id: ids.todoDaily,
        userId: ids.u1,
        title: "每日巡检",
        content: "核对机号与电池序列号。",
        projectId: ids.project,
        remindAt: new Date("2026-10-21T01:00:00.000Z"),
        repeatRule: "daily",
        repeatUntil: "2026-10-23",
        reminderUserIds: [ids.u1, ids.u2],
        status: "pending",
      },
      {
        id: ids.todoWeekly,
        userId: ids.u1,
        title: "周报复核",
        content: null,
        remindAt: new Date("2026-10-21T01:00:00.000Z"),
        repeatRule: "weekly",
        repeatUntil: "2026-11-30",
        reminderUserIds: [ids.u1],
        status: "pending",
      },
      {
        id: ids.todoDone,
        userId: ids.u1,
        title: "已完成待办",
        content: null,
        remindAt: new Date("2026-10-22T01:00:00.000Z"),
        repeatRule: "none",
        reminderUserIds: [ids.u1],
        status: "done",
        completedAt: new Date("2026-10-21T12:00:00.000Z"),
      },
      {
        id: ids.todoDeletedTarget,
        userId: ids.u1,
        title: "对象已删除",
        content: null,
        remindAt: new Date("2026-10-21T01:00:00.000Z"),
        repeatRule: "none",
        reminderUserIds: [ids.deleted],
        status: "pending",
      },
      {
        id: ids.todoMonthly31,
        userId: ids.u1,
        title: "月末提醒",
        content: null,
        remindAt: new Date("2026-01-31T01:00:00.000Z"),
        repeatRule: "monthly",
        reminderUserIds: [ids.u3],
        status: "pending",
      },
    ]);
    await db.insert(notifyDeliveryMessages).values([
      {
        sourceDedupeKey: deliveryKeys[0],
        topic: "notify.message",
        channel: "inbox",
        recipientId: ids.u1,
        body: "A01 回放：站内信",
        ruleCode: "A01",
        payload: {},
        lastState: "sent",
        sentAt: new Date("2026-10-21T11:30:00.000Z"),
      },
      {
        sourceDedupeKey: deliveryKeys[1],
        topic: "notify.message",
        channel: "wecom_aibot",
        recipientId: ids.u2,
        body: "A01 回放：单聊",
        ruleCode: "A01",
        payload: {},
        lastState: "sent",
        sentAt: new Date("2026-10-21T11:31:00.000Z"),
      },
      {
        sourceDedupeKey: deliveryKeys[2],
        topic: "notify.message",
        channel: "inbox",
        recipientId: ids.u3,
        body: "A01 回放：失败",
        ruleCode: "A01",
        payload: {},
        lastState: "failed",
        lastError: "回放：渠道失败",
      },
      {
        sourceDedupeKey: deliveryKeys[3],
        topic: "notify.message",
        channel: "wecom_app",
        recipientId: ids.u3,
        body: "A01 回放：应用消息",
        ruleCode: "A01",
        payload: {},
        lastState: "sent",
        sentAt: new Date("2026-10-21T11:32:00.000Z"),
      },
      {
        sourceDedupeKey: deliveryKeys[4],
        topic: "notify.message",
        channel: "inbox",
        recipientId: ids.u1,
        body: "A01 回放：前一日",
        ruleCode: "A01",
        payload: {},
        lastState: "sent",
        sentAt: new Date("2026-10-20T11:30:00.000Z"),
      },
      {
        sourceDedupeKey: deliveryKeys[5],
        topic: "notify.message",
        channel: "inbox",
        recipientId: ids.u1,
        body: "A14 回放：不串规则",
        ruleCode: "A14",
        payload: {},
        lastState: "sent",
        sentAt: new Date("2026-10-21T11:30:00.000Z"),
      },
    ]);
  }

  async function cleanup() {
    if (outboxKeys.length > 0) {
      await db.delete(outboxEvents).where(inArray(outboxEvents.dedupeKey, outboxKeys));
    }
    await db.delete(notifyDeliveryMessages).where(inArray(notifyDeliveryMessages.sourceDedupeKey, deliveryKeys));
    await db.delete(todos).where(inArray(todos.id, allTodoIds));
    await db.delete(projectMembers).where(eq(projectMembers.projectId, ids.project));
    await db.delete(projects).where(eq(projects.id, ids.project));
    await db.delete(users).where(inArray(users.id, [ids.u1, ids.u2, ids.u3]));
  }
}

await main();
