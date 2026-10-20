import { describe, expect, it } from "vitest";
import type { AutomationRule } from "@libiaolink/contracts";
import { atShanghaiTime, calendarWindow } from "../src/modules/calendar/index.js";
import {
  AUTOMATION_SCHEDULE_JOB_KIND,
  BUILTIN_RULES,
  evaluateEventMessages,
  listEnabledRules,
  planWindowMessages,
  replayRules,
  toProjectDaySubject,
  toReportMemberSubject,
  toStageSubject,
  toTaskSubject,
  toTodoSubject,
  type ReplayMessage,
  type ReplaySubject,
  type ReplayTask,
} from "../src/modules/automation/index.js";

/** 金标基准日：2026-09-24（周四）；A14 待办提醒日 = 2026-09-25（窗口内命中）。A03 随处理时限下线 · Push 215。 */
const ENABLED_TEST_RULES = BUILTIN_RULES.map((rule) => ({ ...rule, enabled: true }));
const BUSINESS_DAY = "2026-09-24";
const CALENDAR = calendarWindow("2026-09-01", "2026-12-31", [
  { date: "2026-10-01", dayType: "holiday", name: "国庆节", note: null },
]);
const PROJECT = "项目：**LBUSA-20261014-002·美国仓储公司订单**";
const AT = new Date(atShanghaiTime(BUSINESS_DAY, "12:00"));

function task(overrides: Partial<ReplayTask>): ReplayTask {
  return {
    id: "t-1",
    title: "安装摄像头",
    version: 5,
    displayStatus: "active",
    urgency: "高",
    plannedStart: null,
    plannedEnd: null,
    actualStart: null,
    actualEnd: null,
    ownerId: "u-1",
    ownerName: "张三",
    managerId: "u-9",
    managerName: "李四",
    projectId: "p-1",
    projectCode: "LBUSA-20261014-002",
    projectName: "美国仓储公司订单",
    projectProgress: 50,
    completedByName: "邵晨宇",
    projectGroupId: "g-1",
    deliverableTypes: ["施工方案"],
    fileCount: 1,
    ...overrides,
  };
}

/** A01 日报名册槽位（映射器口径：slotId 缺省 = projectId|userId）。 */
function slot(input: { userId: string; name: string; projectId: string; project: string; date?: string; submitted?: boolean }): ReplaySubject {
  return toReportMemberSubject({
    date: input.date ?? BUSINESS_DAY,
    isWorkday: true,
    submitted: input.submitted ?? false,
    userId: input.userId,
    userName: input.name,
    projectId: input.projectId,
    projectName: input.project,
  });
}

/** A02 项目日报 / A14 待办（窗口形态用；日期按用例覆写）。 */
function projectDay(date: string): ReplaySubject {
  return toProjectDaySubject({
    projectId: "p-1",
    projectName: "临港数据中心",
    date,
    entryCount: 3,
    headcountTotal: 12,
    issueCount: 1,
    summaryText: "张三：安装摄像头 3 台；李四：现场勘查完毕。",
    groupId: "g-1",
  });
}

function todo(remindDate: string): ReplaySubject {
  return toTodoSubject({
    todoId: "todo-1",
    title: "复核无人机交付清单",
    content: "与供应商核对机号与电池序列号。",
    status: "pending",
    remindDate,
    memberId: "u-1",
    memberName: "张三",
  });
}

function sortKey(message: ReplayMessage): string {
  return message.ruleCode + "|" + message.entityId;
}
describe("evaluateEventMessages 事件形态（R02 金标等价 + 冷启动保护）", () => {
  const completed = task({ displayStatus: "done", actualEnd: BUSINESS_DAY, fileCount: 0 });
  const subject = toTaskSubject(completed);

  it("同一主体下与回放器逐字段一致（dedupeKey / channel / recipientName 全量比对）", () => {
    const runtime = evaluateEventMessages({ topic: "task.completed", rules: ENABLED_TEST_RULES, subject, at: AT });
    const replay = replayRules({ businessDate: BUSINESS_DAY, tasks: [completed], calendar: CALENDAR, shiftEnabled: false, rules: ENABLED_TEST_RULES });
    expect(runtime.messages).toEqual(replay.messages);
    expect(runtime.messages).toHaveLength(4);
    expect(runtime.messages.map((message) => message.channel)).toEqual(["inbox", "inbox", "wecom_aibot", "wecom_aibot"]);
    expect(runtime.messages.map((message) => message.recipientName)).toEqual(["张三", "李四", "张三", "李四"]);
    for (const message of runtime.messages) {
      expect(message.ruleCode).toBe("R02");
      expect(message.body).toBe(`${PROJECT}\n邵晨宇已点击完成任务，请为项目任务「**安装摄像头**」及时添加成果文件`);
    }
    expect(runtime.messages.map((message) => message.dedupeKey)).toEqual([
      "R02:t-1:v5:u-1",
      "R02:t-1:v5:u-9",
      "R02:t-1:v5:u-1",
      "R02:t-1:v5:u-9",
    ]);
    // R06 同主题命中但条件不满足（project.progress != 100）→ 登记 not_matched；A 系列不参与（主题不命中）。
    expect(runtime.skipped).toEqual([{ reason: "not_matched", ruleCode: "R06", entityId: "t-1" }]);
  });

  it("冷启动保护：超龄事件整体放弃 → 逐规则 event_too_old（不评估主体）", () => {
    const runtime = evaluateEventMessages({
      topic: "task.completed",
      rules: ENABLED_TEST_RULES,
      subject,
      at: AT,
      eventAt: new Date(AT.getTime() - 3_600_000),
      maxEventAgeMs: 30 * 60_000,
    });
    expect(runtime.messages).toEqual([]);
    expect(runtime.skipped).toEqual([
      { reason: "event_too_old", ruleCode: "R02", entityId: "t-1" },
      { reason: "event_too_old", ruleCode: "R06", entityId: "t-1" },
    ]);
  });

  it("未超龄：正常求值；给了阈值缺 eventAt → 显性抛错", () => {
    const fresh = evaluateEventMessages({
      topic: "task.completed",
      rules: ENABLED_TEST_RULES,
      subject,
      at: AT,
      eventAt: new Date(AT.getTime() - 10 * 60_000),
      maxEventAgeMs: 30 * 60_000,
    });
    expect(fresh.messages).toHaveLength(4);
    expect(() => evaluateEventMessages({ topic: "task.completed", rules: ENABLED_TEST_RULES, subject, at: AT, maxEventAgeMs: 1000 })).toThrow();
  });

  it("主题与主体类型：主题不命中 → 不参与；主体类型不符 → subject_mismatch", () => {
    const noTopic = evaluateEventMessages({ topic: "report.submitted", rules: ENABLED_TEST_RULES, subject, at: AT });
    expect(noTopic.messages).toEqual([]);
    expect(noTopic.skipped).toEqual([]);
    const mismatch = evaluateEventMessages({ topic: "task.completed", rules: ENABLED_TEST_RULES, subject: todo("2026-09-25"), at: AT });
    expect(mismatch.messages).toEqual([]);
    expect(mismatch.skipped.map((item) => item.reason)).toEqual(["subject_mismatch", "subject_mismatch"]);
    expect(mismatch.skipped.map((item) => item.ruleCode)).toEqual(["R02", "R06"]);
  });
});

describe("evaluateEventMessages 阶段事件（A08）", () => {
  it("stage.advanced 主体不套用任务完成态，直接命中阶段群播报", () => {
    const stage = toStageSubject({
      stageId: "stage-1",
      stageKey: "design",
      stageName: "设计开发",
      stageVersion: 7,
      nextStageKey: "purchase",
      nextStageName: "加工采购",
      advancedByName: "邵晨宇",
      projectId: "p-1",
      projectCode: "LBUSA-20261014-002",
      projectName: "美国仓储公司订单",
      groupId: "p-1",
    });
    const runtime = evaluateEventMessages({ topic: "stage.advanced", rules: ENABLED_TEST_RULES, subject: stage, at: AT });
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.messages[0]).toMatchObject({
      ruleCode: "A08",
      channel: "wecom_group",
      recipientId: "p-1",
      title: "大阶段完成通知",
      dedupeKey: "A08:stage-1:v7",
    });
    expect(runtime.messages[0]?.body).toBe(`${PROJECT}\n邵晨宇已完成大阶段「**设计开发**」，当前项目阶段：**加工采购**。`);
    expect(runtime.skipped).toEqual([]);
  });
});

describe("planWindowMessages 调度形态（与逐日回放等价）", () => {
  it("A01 / A02 / A14 跨日窗口 = 逐日回放并集（逐字段一致）", () => {
    const subjects: ReplaySubject[] = [
      slot({ userId: "u-1", name: "张三", projectId: "p-1", project: "临港数据中心" }),
      slot({ userId: "u-1", name: "张三", projectId: "p-2", project: "浦东机场" }),
      slot({ userId: "u-2", name: "王五", projectId: "p-1", project: "临港数据中心", submitted: true }),
      slot({ userId: "u-1", name: "张三", projectId: "p-1", project: "临港数据中心", date: "2026-09-25" }),
      projectDay("2026-09-24"),
      todo("2026-09-25"),
    ];
    const window = {
      from: new Date(atShanghaiTime("2026-09-24", "00:00")),
      to: new Date(atShanghaiTime("2026-09-26", "23:59")),
    };
    const plan = planWindowMessages({ jobKind: AUTOMATION_SCHEDULE_JOB_KIND, window, rules: ENABLED_TEST_RULES, subjects, at: window.to, calendar: CALENDAR });
    const union: ReplayMessage[] = [];
    for (const date of ["2026-09-24", "2026-09-25", "2026-09-26"]) {
      union.push(...replayRules({ businessDate: date, subjects, calendar: CALENDAR, shiftEnabled: false, rules: ENABLED_TEST_RULES }).messages);
    }
    expect(plan.messages).toEqual([...union].sort((left, right) => sortKey(left).localeCompare(sortKey(right))));
    expect(plan.messages).toHaveLength(7);
    expect(plan.messages.map((message) => message.ruleCode)).toEqual([
      "A01", "A01", "A01", "A01", "A02", "A14", "A14",
    ]);
    // A01 按人合并（跨项目清单）：u-1 当日两个项目；幂等键 = 规则 + 收件人 + 窗口。
    const mergedA01 = plan.messages.find((message) => message.ruleCode === "A01" && message.windowKey === "2026-09-24" && message.channel === "inbox");
    expect(mergedA01?.body).toBe("你今天还有日报未提交：临港数据中心、浦东机场请尽快填写，辛苦啦！");
    expect(mergedA01?.mergedFrom).toEqual(["p-1|u-1", "p-2|u-1"]);
    expect(mergedA01?.dedupeKey).toBe("A01:u-1:2026-09-24");
    // skipped 只登记「窗口内已触发但未产出」：u-2 已提交 → not_matched；其余（未触发窗口 / 主体类型不符）不入 skipped。
    expect(plan.skipped).toEqual([{ reason: "not_matched", ruleCode: "A01", entityId: "p-1|u-2" }]);
  });

  it("窗口半开 (from, to]：from 时刻本身的触发属上一窗口", () => {
    const subjects = [slot({ userId: "u-1", name: "张三", projectId: "p-1", project: "临港数据中心" })];
    const fireAt = atShanghaiTime("2026-09-24", "19:30");
    const after = new Date(atShanghaiTime("2026-09-24", "19:31"));
    const excluded = planWindowMessages({
      jobKind: AUTOMATION_SCHEDULE_JOB_KIND,
      window: { from: new Date(fireAt), to: after },
      rules: ENABLED_TEST_RULES,
      subjects,
      at: after,
      calendar: CALENDAR,
    });
    expect(excluded.messages).toEqual([]);
    expect(excluded.skipped).toEqual([]);
    const included = planWindowMessages({
      jobKind: AUTOMATION_SCHEDULE_JOB_KIND,
      window: { from: new Date(atShanghaiTime("2026-09-24", "19:29")), to: after },
      rules: ENABLED_TEST_RULES,
      subjects,
      at: after,
      calendar: CALENDAR,
    });
    expect(included.messages).toHaveLength(2);
    expect(included.messages.every((message) => message.ruleCode === "A01")).toBe(true);
    expect(included.messages.every((message) => message.windowKey === "2026-09-24")).toBe(true);
  });

  it("R07 三档口径（定案 · Push 171）：高 + 中命中、低不命中（窗口形态与逐日回放等价）", () => {
    const subjects: ReplaySubject[] = [
      toTaskSubject(task({ id: "t-1", title: "安装摄像头", urgency: "高" })),
      toTaskSubject(task({ id: "t-2", title: "调试网络", urgency: "中" })),
      toTaskSubject(task({ id: "t-3", title: "整理资料", urgency: "低" })),
    ];
    const window = {
      from: new Date(atShanghaiTime("2026-09-20", "12:00")),
      to: new Date(atShanghaiTime("2026-09-21", "23:59")),
    };
    const plan = planWindowMessages({ jobKind: AUTOMATION_SCHEDULE_JOB_KIND, window, rules: ENABLED_TEST_RULES, subjects, at: window.to, calendar: CALENDAR });
    const union: ReplayMessage[] = [];
    for (const date of ["2026-09-20", "2026-09-21"]) {
      union.push(...replayRules({ businessDate: date, subjects, calendar: CALENDAR, shiftEnabled: false, rules: ENABLED_TEST_RULES }).messages);
    }
    expect(plan.messages).toEqual([...union].sort((left, right) => sortKey(left).localeCompare(sortKey(right))));
    expect(plan.messages).toHaveLength(1);
    const merged = plan.messages[0];
    expect(merged?.ruleCode).toBe("R07");
    expect(merged?.channel).toBe("wecom_aibot");
    expect(merged?.dedupeKey).toBe("R07:u-1:2026-W39");
    expect(merged?.mergedFrom).toEqual(["t-1", "t-2"]);
    expect(merged?.body).toBe(`张三，以下重点任务正在进行中：\n${PROJECT}\n任务：「**安装摄像头**」\n${PROJECT}\n任务：「**调试网络**」\n请关注并及时推进任务~`);
    expect(plan.skipped).toEqual([{ reason: "not_matched", ruleCode: "R07", entityId: "t-3" }]);
  });
  it("disabled 规则登记一次；jobKind / 窗口边界错误显性抛错", () => {
    const base = BUILTIN_RULES.find((rule) => rule.code === "A01");
    if (base === undefined) throw new Error("A01 缺失");
    const disabled: AutomationRule = { ...base, enabled: false };
    const subjects = [slot({ userId: "u-1", name: "张三", projectId: "p-1", project: "临港数据中心" })];
    const from = new Date(atShanghaiTime("2026-09-24", "00:00"));
    const to = new Date(atShanghaiTime("2026-09-24", "23:59"));
    const plan = planWindowMessages({ jobKind: AUTOMATION_SCHEDULE_JOB_KIND, window: { from, to }, rules: [disabled], subjects, at: to, calendar: CALENDAR });
    expect(plan.messages).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: "disabled", ruleCode: "A01" }]);
    expect(() => planWindowMessages({ jobKind: "other.job", window: { from, to }, rules: [disabled], subjects, at: to, calendar: CALENDAR })).toThrow();
    expect(() => planWindowMessages({ jobKind: AUTOMATION_SCHEDULE_JOB_KIND, window: { from, to: new Date(to.getTime() + 1000) }, rules: [], subjects, at: to, calendar: CALENDAR })).toThrow();
    expect(() => planWindowMessages({ jobKind: AUTOMATION_SCHEDULE_JOB_KIND, window: { from: to, to: from }, rules: [], subjects, at: to, calendar: CALENDAR })).toThrow();
  });
});

describe("主体映射器（字段与收件人 = docs/rules 字段表）", () => {
  it("toReportMemberSubject：slotId 缺省 = projectId|userId；收件人 = report.member", () => {
    expect(slot({ userId: "u-1", name: "张三", projectId: "p-1", project: "临港数据中心" })).toEqual({
      kind: "report_slot",
      id: "p-1|u-1",
      fields: {
        "report.date": "2026-09-24",
        "report.is_workday": true,
        "report.submitted": false,
        "report.user_id": "u-1",
        "project.name": "临港数据中心",
      },
      recipients: { "report.member": { id: "u-1", name: "张三" } },
    });
  });

  it("toProjectDaySubject：收件人 = project.group（未绑定 → null）", () => {
    expect(projectDay("2026-09-24")).toEqual({
      kind: "project_day",
      id: "p-1",
      fields: {
        "report.date": "2026-09-24",
        "report.entry_count": 3,
        "report.headcount_total": 12,
        "report.issue_count": 1,
        "report.summary_text": "张三：安装摄像头 3 台；李四：现场勘查完毕。",
        "project.name": "临港数据中心",
      },
      recipients: { "project.group": { id: "g-1", name: null } },
    });
    const unbound = toProjectDaySubject({ projectId: "p-1", projectName: "临港数据中心", date: "2026-09-24", entryCount: 0, headcountTotal: 12, issueCount: 0, summaryText: "", groupId: null });
    expect(unbound.recipients?.["project.group"]).toBeNull();
  });

  it("toStageSubject：收件人 = project.group（未绑定 → null），项目 / 阶段 / 下一阶段字段齐备", () => {
    const stage = toStageSubject({
      stageId: "stage-1",
      stageKey: "design",
      stageName: "设计开发",
      stageVersion: 3,
      nextStageKey: "purchase",
      nextStageName: "加工采购",
      advancedByName: "邵晨宇",
      projectId: "p-1",
      projectCode: "LBUSA-20261014-002",
      projectName: "美国仓储公司订单",
      groupId: null,
    });
    expect(stage).toEqual({
      kind: "stage",
      id: "stage-1",
      version: 3,
      fields: {
        "stage.id": "stage-1",
        "stage.key": "design",
        "stage.name": "设计开发",
        "stage.next_key": "purchase",
        "stage.next_name": "加工采购",
        "stage.advanced_by_name": "邵晨宇",
        "project.id": "p-1",
        "project.code": "LBUSA-20261014-002",
        "project.name": "美国仓储公司订单",
        "project.label": "LBUSA-20261014-002·美国仓储公司订单",
      },
      recipients: { "project.group": null },
    });
  });

  it("toTodoSubject：收件人 = rule.members；entityId 可覆盖（多提醒对象按成员展开）", () => {
    expect(todo("2026-09-25")).toEqual({
      kind: "todo",
      id: "todo-1",
      fields: {
        "todo.title": "复核无人机交付清单",
        "todo.content": "与供应商核对机号与电池序列号。",
        "todo.status": "pending",
        "todo.remind_date": "2026-09-25",
      },
      recipients: { "rule.members": { id: "u-1", name: "张三" } },
    });
    const perMember = toTodoSubject({ todoId: "todo-1", entityId: "todo-1|u-1", title: "t", content: null, status: "pending", remindDate: "2026-09-25", memberId: "u-1", memberName: "张三" });
    expect(perMember.id).toBe("todo-1|u-1");
    expect(perMember.fields["todo.content"]).toBeNull();
  });
});

describe("规则来源 listEnabledRules（一期 = 内置集）", () => {
  it("返回启用中的内置规则（异步签名，M5-06 换读表实现不变）", async () => {
    const rules = await listEnabledRules();
    expect(rules).toHaveLength(3);
    expect(rules.every((rule) => rule.enabled)).toBe(true);
    expect(rules.map((rule) => rule.code)).toEqual(["R02", "R03", "R05"]);
    expect(rules.map((rule) => rule.code)).not.toEqual(expect.arrayContaining(["R04", "R06", "R07", "A01", "A02", "A08", "A14"]));
  });
});

