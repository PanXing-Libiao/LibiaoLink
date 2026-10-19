import { describe, expect, it } from "vitest";
import { addDays, calendarWindow } from "../src/modules/calendar/index.js";
import { dedupeKey, replayRules, toStageSubject, type ReplayTask } from "../src/modules/automation/index.js";

const CALENDAR = calendarWindow("2026-09-01", "2026-12-31", [
  { date: "2026-10-01", dayType: "holiday", name: "国庆节", note: null },
]);

const PROJECT = "项目：**LBUSA-20261014-002·美国仓储公司订单**";

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

function replay(businessDate: string, tasks: ReplayTask[], extra: Record<string, unknown> = {}) {
  return replayRules({ businessDate, tasks, calendar: CALENDAR, shiftEnabled: false, ...extra });
}

describe("R02 成果文件自动化通知（事件型 · 逐字）", () => {
  it("负责人与项目经理各收到站内信 + 企微单聊，文案逐字", () => {
    const report = replay("2026-09-23", [
      task({ displayStatus: "done", actualEnd: "2026-09-23", fileCount: 0, deliverableTypes: ["施工方案"] }),
    ]);
    expect(report.messages).toHaveLength(4);
    expect(report.messages.map((message) => message.channel)).toEqual(["inbox", "inbox", "wecom_aibot", "wecom_aibot"]);
    expect(report.messages.map((message) => message.recipientId)).toEqual(["u-1", "u-9", "u-1", "u-9"]);
    for (const message of report.messages) {
      expect(message.title).toBe("及时添加文件");
      expect(message.body).toBe(`${PROJECT}\n邵晨宇已点击完成任务，请为项目任务「**安装摄像头**」及时添加成果文件`);
    }
    expect(report.messages.map((message) => message.dedupeKey)).toEqual([
      "R02:t-1:v5:u-1",
      "R02:t-1:v5:u-9",
      "R02:t-1:v5:u-1",
      "R02:t-1:v5:u-9",
    ]);
  });

  it("负责人为空 → 只回退项目经理；负责人与项目经理为同一人时只产出一份", () => {
    const fallback = replay("2026-09-23", [
      task({ displayStatus: "done", actualEnd: "2026-09-23", fileCount: 0, ownerId: null, ownerName: null }),
    ]);
    expect(fallback.messages).toHaveLength(2);
    expect(fallback.messages.every((message) => message.recipientId === "u-9")).toBe(true);
    expect(fallback.messages.every((message) => message.dedupeKey === "R02:t-1:v5")).toBe(true);

    const samePerson = replay("2026-09-23", [
      task({ displayStatus: "done", actualEnd: "2026-09-23", fileCount: 0, managerId: "u-1", managerName: "张三" }),
    ]);
    expect(samePerson.messages).toHaveLength(2);
    expect(samePerson.messages.every((message) => message.recipientId === "u-1")).toBe(true);
    expect(samePerson.messages.every((message) => message.dedupeKey === "R02:t-1:v5")).toBe(true);
  });

  it("已上传成果文件 → 不命中", () => {
    const uploaded = replay("2026-09-23", [task({ displayStatus: "done", actualEnd: "2026-09-23", fileCount: 1 })]);
    expect(uploaded.messages).toHaveLength(0);
    expect(uploaded.details.find((item) => item.ruleCode === "R02")?.skipped).toBe("not_matched");
  });

  it("幂等：同任务同完成版本每个收件人只发一次（sentKeys 命中 → duplicate）", () => {
    const sent = ["R02:t-1:v5:u-1", "R02:t-1:v5:u-9"];
    const report = replay("2026-09-23", [task({ displayStatus: "done", actualEnd: "2026-09-23", fileCount: 0 })], {
      sentKeys: sent,
    });
    expect(report.messages).toHaveLength(0);
    const r02Details = report.details.filter((item) => item.ruleCode === "R02");
    expect(r02Details).toHaveLength(1);
    expect(r02Details.every((item) => item.skipped === "duplicate")).toBe(true);
  });
});

describe("R03 任务即将延期提醒（T-1 · 仅负责人单聊）", () => {
  it("预计完成日期前 1 天命中，标题与正文逐字、只发给任务负责人", () => {
    const report = replay("2026-09-23", [task({ plannedEnd: "2026-09-24", displayStatus: "active" })]);
    expect(report.messages).toHaveLength(1);
    const message = report.messages[0];
    expect(message?.ruleCode).toBe("R03");
    expect(message?.title).toBe("任务即将延期提醒");
    expect(message?.body).toBe(`${PROJECT}\nhello，张三，你的任务「**安装摄像头**」还有1天就要截止了，快加加油，尽快追上进度吧！`);
    expect(message?.channel).toBe("wecom_aibot");
    expect(message?.recipient).toBe("task.owner");
    expect(message?.recipientId).toBe("u-1");
    expect(message?.dedupeKey).toBe("R03:t-1:2026-09-23");
    expect(message?.windowKey).toBe("2026-09-23");
  });

  it("负责人为空时不回退项目经理：零投递 + recipient_missing", () => {
    const report = replay("2026-09-23", [
      task({ plannedEnd: "2026-09-24", displayStatus: "active", ownerId: null, ownerName: null }),
    ]);
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((item) => item.ruleCode === "R03")?.skipped).toBe("recipient_missing");
  });

  it("已完成 / 提前完成不命中；非窗口日不命中", () => {
    const done = replay("2026-09-23", [task({ plannedEnd: "2026-09-24", displayStatus: "done" })]);
    expect(done.messages).toHaveLength(0);
    const early = replay("2026-09-23", [task({ plannedEnd: "2026-09-24", displayStatus: "early_done" })]);
    expect(early.messages).toHaveLength(0);
    const offWindow = replay("2026-09-22", [task({ plannedEnd: "2026-09-24", displayStatus: "active" })]);
    expect(offWindow.messages).toHaveLength(0);
    expect(offWindow.details.find((item) => item.ruleCode === "R03")?.skipped).toBe("window_mismatch");
  });

  it("节假日顺延开关两态：开 = 顺延到工作日触发，关 = 落在非窗口日", () => {
    const base = task({ plannedEnd: "2026-10-05", displayStatus: "active" }); // T-1 = 2026-10-04 周日
    const off = replay("2026-10-05", [base], { shiftEnabled: false });
    expect(off.messages.filter((item) => item.ruleCode === "R03")).toHaveLength(0);
    expect(off.details.find((item) => item.ruleCode === "R03")?.skipped).toBe("window_mismatch");
    const on = replay("2026-10-05", [base], { shiftEnabled: true, shiftDirection: "forward" });
    const shifted = on.messages.filter((item) => item.ruleCode === "R03");
    expect(shifted).toHaveLength(1);
    expect(shifted[0]?.windowKey).toBe("2026-10-05");
    // 2026-10-05 恰逢周一：R07 周窗口同时命中（两条规则互不影响）
    expect(on.messages.filter((item) => item.ruleCode === "R07")).toHaveLength(1);
  });
});

describe("R04 任务启动提醒（当天 10:00）", () => {
  it("开始日期当天且未填实际开始日期 → 命中，标题与正文逐字", () => {
    const report = replay("2026-09-23", [task({ plannedStart: "2026-09-23", displayStatus: "pending" })]);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]?.title).toBe("有新任务已到启动时间");
    expect(report.messages[0]?.body).toBe(`${PROJECT}\n张三你好呀，你的任务「**安装摄像头**」已到启动时间，快查看任务详情吧~今日工作加油`);
  });

  it("已填实际开始日期 → 不命中", () => {
    const report = replay("2026-09-23", [
      task({ plannedStart: "2026-09-23", displayStatus: "active", actualStart: "2026-09-23" }),
    ]);
    expect(report.messages).toHaveLength(0);
  });
});

describe("R05 任务超时提醒（T+1 · 负责人 + 项目经理单聊）", () => {
  it("预计完成日期后 1 天命中，标题逐字，负责人与项目经理各一条单聊", () => {
    const report = replay("2026-09-23", [task({ plannedEnd: "2026-09-22", displayStatus: "overdue" })]);
    expect(report.messages).toHaveLength(2);
    expect(report.messages.map((message) => message.channel)).toEqual(["wecom_aibot", "wecom_aibot"]);
    expect(report.messages.map((message) => message.recipientId)).toEqual(["u-1", "u-9"]);
    expect(report.messages.map((message) => message.dedupeKey)).toEqual([
      "R05:t-1:2026-09-23:u-1",
      "R05:t-1:2026-09-23:u-9",
    ]);
    for (const message of report.messages) {
      expect(message.title).toBe("！任务超时提醒");
      expect(message.body).toBe(`${PROJECT}\nhello，张三，你的任务「**安装摄像头**」已经超时一天了，快加加油，尽快追上进度吧！`);
    }
  });

  it("负责人与项目经理同一人时只发一条", () => {
    const report = replay("2026-09-23", [
      task({ plannedEnd: "2026-09-22", displayStatus: "overdue", managerId: "u-1", managerName: "张三" }),
    ]);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]?.recipientId).toBe("u-1");
    expect(report.messages[0]?.dedupeKey).toBe("R05:t-1:2026-09-23");
  });

  it("已完成不命中", () => {
    const report = replay("2026-09-23", [task({ plannedEnd: "2026-09-22", displayStatus: "done" })]);
    expect(report.messages).toHaveLength(0);
  });
});

describe("R06 任务完成喜报", () => {
  it("项目整体进度 100% → 命中，文案逐字", () => {
    const report = replay("2026-09-23", [
      task({ displayStatus: "done", actualEnd: "2026-09-23", projectProgress: 100 }),
    ]);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]?.title).toBe("叮咚~喜报来啦！");
    expect(report.messages[0]?.body).toBe(
      `项目：**LBUSA-20261014-002·美国仓储公司订单**\n恭喜张三成功拿下一项重要任务：「**安装摄像头**」。大家一起为这位优秀的伙伴喝彩吧`,
    );
  });

  it("项目整体进度 99% → 不命中", () => {
    const report = replay("2026-09-23", [
      task({ displayStatus: "done", actualEnd: "2026-09-23", projectProgress: 99 }),
    ]);
    expect(report.messages).toHaveLength(0);
  });
});

describe("A08 大阶段完成播报", () => {
  function stage(groupId: string | null) {
    return toStageSubject({
      stageId: "stage-1",
      stageKey: "design",
      stageName: "设计开发",
      stageVersion: 4,
      nextStageKey: "purchase",
      nextStageName: "加工采购",
      advancedByName: "邵晨宇",
      projectId: "p-1",
      projectCode: "LBUSA-20261014-002",
      projectName: "美国仓储公司订单",
      groupId,
    });
  }

  it("阶段推进完成 → 项目群播报，项目与推进人明确", () => {
    const report = replayRules({ businessDate: "2026-09-23", subjects: [stage("p-1")], calendar: CALENDAR, shiftEnabled: false });
    expect(report.messages).toHaveLength(1);
    const message = report.messages[0];
    expect(message?.ruleCode).toBe("A08");
    expect(message?.channel).toBe("wecom_group");
    expect(message?.recipientId).toBe("p-1");
    expect(message?.title).toBe("大阶段完成通知");
    expect(message?.body).toBe(`${PROJECT}\n邵晨宇已完成大阶段「**设计开发**」，当前项目阶段：**加工采购**。`);
    expect(message?.dedupeKey).toBe("A08:stage-1:v4");
  });

  it("项目未绑定群 → recipient_missing，不误发", () => {
    const report = replayRules({ businessDate: "2026-09-23", subjects: [stage(null)], calendar: CALENDAR, shiftEnabled: false });
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((item) => item.ruleCode === "A08")?.skipped).toBe("recipient_missing");
  });
});

describe("R07 每周一重点任务提醒（周窗口 + 合并 + 幂等）", () => {
  const MONDAY = "2026-09-21";

  it("同一负责人两条重点任务合并为一条清单式消息（标题逐字 + 清单顺序稳定）", () => {
    const report = replay(MONDAY, [
      task({ id: "t-1", title: "安装摄像头", displayStatus: "active", urgency: "高" }),
      task({ id: "t-2", title: "调试网络", displayStatus: "active", urgency: "中" }),
      task({ id: "t-3", title: "整理资料", displayStatus: "active", urgency: "低" }),
    ]);
    const r07 = report.messages.filter((item) => item.ruleCode === "R07");
    expect(r07).toHaveLength(1);
    expect(r07[0]?.title).toBe("重点任务提醒");
    expect(r07[0]?.body).toBe(
      `张三，以下重点任务正在进行中：\n${PROJECT}\n任务：「**安装摄像头**」\n${PROJECT}\n任务：「**调试网络**」\n请关注并及时推进任务~`,
    );
    expect(r07[0]?.mergedFrom).toEqual(["t-1", "t-2"]);
    expect(r07[0]?.dedupeKey).toBe(dedupeKey("R07", "u-1", "2026-W39"));
    const skipped = report.details.filter((item) => item.ruleCode === "R07" && item.skipped === "not_matched");
    expect(skipped.map((item) => item.entityId)).toEqual(["t-3"]);
  });

  it("跨周窗口幂等：同周已发送 → 本条不再产出（duplicate）", () => {
    const report = replay(MONDAY, [task({ displayStatus: "active" })], {
      sentKeys: [dedupeKey("R07", "u-1", "2026-W39")],
    });
    expect(report.messages.filter((item) => item.ruleCode === "R07")).toHaveLength(0);
    expect(report.details.find((item) => item.ruleCode === "R07")?.skipped).toBe("duplicate");
  });

  it("非周一不触发（窗口对齐）", () => {
    const report = replay(addDays(MONDAY, 1), [task({ displayStatus: "active" })]);
    expect(report.messages.filter((item) => item.ruleCode === "R07")).toHaveLength(0);
  });
});
