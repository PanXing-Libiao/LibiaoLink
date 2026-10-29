import { describe, expect, it } from "vitest";
import { calendarWindow } from "../src/modules/calendar/index.js";
import {
  BUILTIN_MESSAGE_TEMPLATES,
  BUILTIN_RULES,
  SUBJECT_TEMPLATE_VARIABLES,
  dedupeKey,
  findMergedSpec,
  findTemplateForRecipient,
  replayRules,
  resolveScheduleFire,
  subjectKindOf,
  type ReplaySubject,
} from "../src/modules/automation/index.js";

/** 金标基准日：2026-09-24（周四）；A14 待办提醒用当日、A01/A02 用当日槽位（A03 随处理时限下线 · Push 215）。 */
const BUSINESS_DAY = "2026-09-24";
const NO_EXCEPTIONS = calendarWindow("2026-09-01", "2026-12-31", []);
const ENABLED_TEST_RULES = BUILTIN_RULES.map((rule) => ({ ...rule, enabled: true }));
const CALENDAR = calendarWindow("2026-09-01", "2026-12-31", [
  { date: "2026-10-01", dayType: "holiday", name: "国庆节", note: null },
]);

function replay(businessDate: string, subjects: ReplaySubject[], extra: Record<string, unknown> = {}) {
  return replayRules({ businessDate, subjects, calendar: CALENDAR, shiftEnabled: false, rules: ENABLED_TEST_RULES, ...extra });
}

/** A01 日报名册槽位：人员 × 项目 × 日期（数据面 = GET …/reports/missing，Push 162）。 */
function reportSlot(input: {
  userId: string;
  name: string;
  project: string;
  slotId?: string;
  date?: string;
  workday?: boolean;
  submitted?: boolean;
  recipientMissing?: boolean;
}): ReplaySubject {
  return {
    kind: "report_slot",
    id: input.slotId ?? input.project + "|" + input.userId,
    fields: {
      "report.date": input.date ?? BUSINESS_DAY,
      "report.is_workday": input.workday ?? true,
      "report.submitted": input.submitted ?? false,
      "report.user_id": input.userId,
      "project.name": input.project,
    },
    recipients:
      input.recipientMissing === true
        ? {}
        : { "report.member": { id: input.userId, name: input.name } },
  };
}

/** A02 项目日报：项目 × 日期（数据面 = GET …/reports/summary，Push 162）。 */
function projectDay(input: {
  project?: string;
  projectId?: string;
  date?: string;
  entries?: number;
  headcount?: number;
  issues?: number;
  text?: string;
}): ReplaySubject {
  return {
    kind: "project_day",
    id: input.projectId ?? "p-1",
    fields: {
      "report.date": input.date ?? BUSINESS_DAY,
      "report.entry_count": input.entries ?? 3,
      "report.headcount_total": input.headcount ?? 12,
      "report.issue_count": input.issues ?? 1,
      "report.summary_text": input.text ?? "张三：安装摄像头 3 台；李四：现场勘查完毕。",
      "project.name": input.project ?? "临港数据中心",
    },
    recipients: {
      "project.group": { id: input.projectId ?? "p-1", name: null },
    },
  };
}

/** A14 自定义待办：一次提醒基准日 = remind_date（重复规则展开随待办落库卡）。 */
function todoSubject(input: {
  id?: string;
  title?: string;
  content?: string;
  status?: string;
  remindDate: string;
  recipientMissing?: boolean;
}): ReplaySubject {
  return {
    kind: "todo",
    id: input.id ?? "todo-1",
    fields: {
      "todo.title": input.title ?? "复核无人机交付清单",
      "todo.content": input.content ?? "与供应商核对机号与电池序列号。",
      "todo.status": input.status ?? "pending",
      "todo.remind_date": input.remindDate,
    },
    recipients: {
      "rule.members": input.recipientMissing === true ? null : { id: "u-1", name: "张三" },
    },
  };
}
describe("A01 日报应填未填提醒（工作日 19:30 · 个人提醒双渠道 · 按人合并）", () => {
  it("工作日未提交 → 站内信 + 企微各一条，文案逐字、收件人 = 本人、幂等键落收件人粒度", () => {
    const report = replay(BUSINESS_DAY, [
      reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心", slotId: "s-1" }),
    ]);
    expect(report.messages).toHaveLength(2);
    const a01 = report.messages.filter((message) => message.ruleCode === "A01");
    expect(a01.map((message) => message.channel)).toEqual(["inbox", "wecom_aibot"]);
    for (const message of a01) {
      expect(message.title).toBe("📝 请及时填写今日日报");
      expect(message.body).toBe("你今天还有日报未提交：临港数据中心请尽快填写，辛苦啦！");
      expect(message.recipientId).toBe("u-1");
      expect(message.recipientName).toBe("张三");
      expect(message.windowKey).toBe(BUSINESS_DAY);
    }
    expect(a01[0]?.dedupeKey).toBe(dedupeKey("A01", "u-1", BUSINESS_DAY));
    expect(a01[0]?.mergedFrom).toEqual(["s-1"]);
  });

  it("非工作日不催（is_workday = false）", () => {
    const report = replay(BUSINESS_DAY, [
      reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心", workday: false }),
    ]);
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((detail) => detail.ruleCode === "A01")?.skipped).toBe("not_matched");
  });

  it("已提交不进名单（submitted = true）—— 未提交与草稿（false）才催", () => {
    const report = replay(BUSINESS_DAY, [
      reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心", submitted: true }),
    ]);
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((detail) => detail.ruleCode === "A01")?.skipped).toBe("not_matched");
  });

  it("同一人多项目合并为一条（清单顺序随入参；幂等键 = 人员粒度）", () => {
    const report = replay(BUSINESS_DAY, [
      reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心", slotId: "s-1" }),
      reportSlot({ userId: "u-1", name: "张三", project: "虹桥枢纽改造", slotId: "s-2" }),
      reportSlot({ userId: "u-2", name: "王五", project: "临港数据中心", slotId: "s-3" }),
    ]);
    const a01 = report.messages.filter((message) => message.ruleCode === "A01");
    expect(a01).toHaveLength(4);
    const zhang = a01.filter((message) => message.recipientId === "u-1");
    expect(zhang).toHaveLength(2);
    expect(zhang[0]?.body).toBe("你今天还有日报未提交：临港数据中心、虹桥枢纽改造请尽快填写，辛苦啦！");
    expect(zhang[0]?.mergedFrom).toEqual(["s-1", "s-2"]);
    expect(zhang[0]?.dedupeKey).toBe(dedupeKey("A01", "u-1", BUSINESS_DAY));
    const wang = a01.filter((message) => message.recipientId === "u-2");
    expect(wang[0]?.body).toBe("你今天还有日报未提交：临港数据中心请尽快填写，辛苦啦！");
  });

  it("跨天补跑幂等：同人同窗口已发送 → duplicate 跳过", () => {
    const report = replay(
      BUSINESS_DAY,
      [reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心" })],
      { sentKeys: [dedupeKey("A01", "u-1", BUSINESS_DAY)] },
    );
    expect(report.messages.filter((message) => message.ruleCode === "A01")).toHaveLength(0);
    expect(report.details.filter((detail) => detail.ruleCode === "A01").every((detail) => detail.skipped === "duplicate")).toBe(true);
  });

  it("非当日槽位不触发（窗口对齐）", () => {
    const report = replay(BUSINESS_DAY, [
      reportSlot({ userId: "u-1", name: "张三", project: "临港数据中心", date: "2026-09-25" }),
    ]);
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((detail) => detail.ruleCode === "A01")?.skipped).toBe("window_mismatch");
  });
});
describe("A02 日报每日汇总群播报（19:00 · 项目群）", () => {
  it("当日有提交 → 一条群播报，标题与正文取汇总数据面逐字", () => {
    const report = replay(BUSINESS_DAY, [projectDay({})]);
    expect(report.messages).toHaveLength(1);
    const message = report.messages[0];
    expect(message?.ruleCode).toBe("A02");
    expect(message?.channel).toBe("wecom_group");
    expect(message?.recipient).toBe("project.group");
    expect(message?.recipientId).toBe("p-1");
    expect(message?.title).toBe("📊 日报汇总 | 临港数据中心（2026-09-24）");
    expect(message?.body).toBe("今日 3 人已提交（应填 12 人），发现问题 1 条。张三：安装摄像头 3 台；李四：现场勘查完毕。");
    expect(message?.dedupeKey).toBe(dedupeKey("A02", "p-1", BUSINESS_DAY));
  });

  it("当日无提交（entry_count = 0）→ 不在群里刷空汇总", () => {
    const report = replay(BUSINESS_DAY, [projectDay({ entries: 0, headcount: 0, issues: 0, text: "" })]);
    expect(report.messages).toHaveLength(0);
    expect(report.details.find((detail) => detail.ruleCode === "A02")?.skipped).toBe("not_matched");
  });
});

describe("A14 自定义待办提醒（提醒日 09:00 · 站内信 + 企微）", () => {
  it("提醒日命中 → 双渠道逐字（标题含待办标题、正文含内容）", () => {
    const report = replay(BUSINESS_DAY, [todoSubject({ remindDate: BUSINESS_DAY })]);
    expect(report.messages).toHaveLength(2);
    for (const message of report.messages) {
      expect(message.ruleCode).toBe("A14");
      expect(message.title).toBe("⏰ 待办提醒：复核无人机交付清单");
      expect(message.body).toBe("张三，你的待办「复核无人机交付清单」已到提醒时间。与供应商核对机号与电池序列号。");
      expect(message.recipientId).toBe("u-1");
    }
    expect(report.messages[0]?.dedupeKey).toBe(dedupeKey("A14", "todo-1", BUSINESS_DAY));
  });

  it("待办内容为空 → 正文止于句号（无悬空冒号、无未替换变量）", () => {
    const report = replay(BUSINESS_DAY, [todoSubject({ remindDate: BUSINESS_DAY, content: "" })]);
    expect(report.messages[0]?.body).toBe("张三，你的待办「复核无人机交付清单」已到提醒时间。");
  });

  it("非提醒日 / 已完成待办 → 不提醒", () => {
    const future = replay(BUSINESS_DAY, [todoSubject({ remindDate: "2026-09-25" })]);
    expect(future.messages).toHaveLength(0);
    expect(future.details.find((detail) => detail.ruleCode === "A14")?.skipped).toBe("window_mismatch");
    const done = replay(BUSINESS_DAY, [todoSubject({ remindDate: BUSINESS_DAY, status: "done" })]);
    expect(done.messages).toHaveLength(0);
    expect(done.details.find((detail) => detail.ruleCode === "A14")?.skipped).toBe("not_matched");
  });

  it("幂等：同待办同提醒日已发送 → duplicate", () => {
    const report = replay(BUSINESS_DAY, [todoSubject({ remindDate: BUSINESS_DAY })], {
      sentKeys: [dedupeKey("A14", "todo-1", BUSINESS_DAY)],
    });
    expect(report.messages).toHaveLength(0);
    expect(report.details.filter((detail) => detail.ruleCode === "A14").every((detail) => detail.skipped === "duplicate")).toBe(true);
  });
});

describe("引擎扩项（M5-05 余项：主体类型 / T_PLUS_3 / 契约与文案一致性）", () => {
  it("T_PLUS_3 窗口：基准日后 3 天 09:00（窗口口径保留 —— A03 规则下线，调度器能力不动）", () => {
    const fire = resolveScheduleFire({
      window: "T_PLUS_3",
      businessDate: "2026-09-23",
      baseDate: "2026-09-20",
      time: "09:00",
      shiftEnabled: false,
      shiftDirection: "forward",
      calendar: NO_EXCEPTIONS,
    });
    expect(fire?.fireDate).toBe("2026-09-23");
    expect(fire?.windowKey).toBe("2026-09-23");
    expect(fire?.fireAt).toBe("2026-09-23T01:00:00.000Z");
  });

  it("主体类型不匹配 → subject_mismatch（A 系列主体不被 R 系列规则误命中，反之亦然）", () => {
    const report = replay("2026-09-22", [todoSubject({ remindDate: "2026-09-22" })]);
    expect(report.details.find((detail) => detail.ruleCode === "R02")?.skipped).toBe("subject_mismatch");
    expect(report.details.find((detail) => detail.ruleCode === "A01")?.skipped).toBe("subject_mismatch");
    expect(report.messages.every((message) => message.ruleCode === "A14")).toBe(true);
  });

  it("内置规则集：A 系列定义与主体类型登记齐备，当前不进入生产启用集", () => {
    const codes = BUILTIN_RULES.map((rule) => rule.code);
    for (const code of ["A01", "A02", "A14", "A08"]) expect(codes).toContain(code);
    expect(codes).not.toContain("A03"); // 问题主体类型 issue 随处理时限（due_at）一并下线，A 系列只剩三条
    expect(subjectKindOf("A01")).toBe("report_slot");
    expect(subjectKindOf("A02")).toBe("project_day");
    expect(subjectKindOf("A14")).toBe("todo");
    expect(subjectKindOf("A08")).toBe("stage");
    expect(subjectKindOf("R03")).toBe("task");
    expect(subjectKindOf("R06")).toBe("project");
    expect(BUILTIN_RULES.filter((rule) => rule.enabled).map((rule) => rule.code)).toEqual(["R02", "R03", "R05"]);
    for (const code of ["A01", "A02", "A08", "A14"]) {
      expect(BUILTIN_RULES.find((rule) => rule.code === code)?.enabled).toBe(false);
    }
  });

  it("模板一致性：所有动作模板存在，且模板变量都能由主体字段 / 合并清单提供", () => {
    for (const rule of BUILTIN_RULES) {
      const kindVariables = Object.keys(SUBJECT_TEMPLATE_VARIABLES[subjectKindOf(rule.code)]);
      for (const action of rule.actions) {
        const recipientKinds = Array.isArray(action.recipient) ? action.recipient : [action.recipient];
        for (const recipientKind of recipientKinds) {
          const template = findTemplateForRecipient(rule.code, action.template, recipientKind);
          expect(template, rule.code + " / " + action.template + " / " + recipientKind).not.toBeNull();
          const spec = findMergedSpec(rule.code, action.channel ?? "inbox");
          const names = new Set([...kindVariables, ...(spec === null ? [] : [spec.listVariable])]);
          for (const text of [template?.title ?? "", template?.body ?? ""]) {
            for (const match of text.matchAll(/\{([^}]+)\}/g)) {
              expect(names.has(match[1] ?? ""), rule.code + " 未登记变量 " + match[1]).toBe(true);
            }
          }
        }
      }
    }
  });

  it("所有内置消息标题均带 emoji", () => {
    for (const template of BUILTIN_MESSAGE_TEMPLATES) {
      expect(template.title ?? "", template.code).toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
