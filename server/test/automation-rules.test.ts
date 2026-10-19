import { describe, expect, it } from "vitest";
import { addDays, calendarWindow } from "../src/modules/calendar/index.js";
import {
  dedupeKey,
  evaluateOperator,
  evaluateRule,
  isoWeekKey,
  mondayOf,
  renderTemplate,
  resolveScheduleFire,
} from "../src/modules/automation/index.js";

const BUSINESS_DAY = "2026-09-23"; // 周三
const OPTIONS = { businessDate: BUSINESS_DAY };
const NO_EXCEPTIONS = calendarWindow("2026-09-01", "2026-12-31", []);

describe("条件求值（白名单操作符）", () => {
  it("eq / ne：标量相等（不做隐式类型转换）", () => {
    expect(evaluateOperator("eq", 100, 100, OPTIONS)).toBe(true);
    expect(evaluateOperator("eq", "100", 100, OPTIONS)).toBe(false);
    expect(evaluateOperator("ne", "active", "done", OPTIONS)).toBe(true);
  });

  it("in / notIn：集合命中", () => {
    expect(evaluateOperator("in", "pending", ["pending", "active"], OPTIONS)).toBe(true);
    expect(evaluateOperator("in", "done", ["pending", "active"], OPTIONS)).toBe(false);
    expect(evaluateOperator("notIn", "done", ["done", "early_done"], OPTIONS)).toBe(false);
  });

  it("isNull / notNull / notEmpty：空值三态", () => {
    expect(evaluateOperator("isNull", null, undefined, OPTIONS)).toBe(true);
    expect(evaluateOperator("isNull", undefined, undefined, OPTIONS)).toBe(true);
    expect(evaluateOperator("notNull", "2026-09-23", undefined, OPTIONS)).toBe(true);
    expect(evaluateOperator("notEmpty", [], undefined, OPTIONS)).toBe(false);
    expect(evaluateOperator("notEmpty", ["施工方案"], undefined, OPTIONS)).toBe(true);
    expect(evaluateOperator("notEmpty", "   ", undefined, OPTIONS)).toBe(false);
  });

  it("containsAny：多值命中任一（R01 交付类型口径）", () => {
    expect(evaluateOperator("containsAny", ["施工方案", "验收报告"], ["验收报告", "图纸"], OPTIONS)).toBe(true);
    expect(evaluateOperator("containsAny", ["施工方案"], ["图纸"], OPTIONS)).toBe(false);
    expect(evaluateOperator("containsAny", "施工方案", ["施工方案"], OPTIONS)).toBe(false);
  });

  it("gt / gte / lt / lte：数字与日期串", () => {
    expect(evaluateOperator("gt", 101, 100, OPTIONS)).toBe(true);
    expect(evaluateOperator("gte", 100, 100, OPTIONS)).toBe(true);
    expect(evaluateOperator("lt", "2026-09-22", "2026-09-23", OPTIONS)).toBe(true);
    expect(evaluateOperator("lte", "2026-09-23", "2026-09-23", OPTIONS)).toBe(true);
    expect(evaluateOperator("gt", null, 100, OPTIONS)).toBe(false);
  });

  it("eqOffsetDays：字段日期与业务日相差 N 天（T-1 = -1 / T+1 = 1）", () => {
    expect(evaluateOperator("eqOffsetDays", addDays(BUSINESS_DAY, 1), 1, OPTIONS)).toBe(true);
    expect(evaluateOperator("eqOffsetDays", addDays(BUSINESS_DAY, -1), -1, OPTIONS)).toBe(true);
    expect(evaluateOperator("eqOffsetDays", addDays(BUSINESS_DAY, 1), -1, OPTIONS)).toBe(false);
    expect(evaluateOperator("eqOffsetDays", null, 1, OPTIONS)).toBe(false);
  });
});

describe("模板逐字渲染", () => {
  it("变量替换不改字（R02 文案）", () => {
    expect(
      renderTemplate("项目：**{项目}**\n{完成人}已点击完成任务，请为项目任务「**{任务描述}**」及时添加成果文件", {
        "项目": "LBUSA-20261014-002·美国仓储公司订单",
        "完成人": "邵晨宇",
        "任务描述": "安装摄像头",
      }),
    ).toBe(
      "项目：**LBUSA-20261014-002·美国仓储公司订单**\n邵晨宇已点击完成任务，请为项目任务「**安装摄像头**」及时添加成果文件",
    );
  });

  it("缺变量显性失败（金标要求不静默）", () => {
    expect(() => renderTemplate("你好{任务负责人}", {})).toThrow();
  });
});

describe("规则求值（与运算）", () => {
  it("空条件 = 恒命中；任一不满足 = 不命中（明细保留逐条结果）", () => {
    const context = { "task.display_status": "active", "task.file_count": 0 };
    expect(evaluateRule({ conditions: [] }, context, OPTIONS).matched).toBe(true);
    const evaluation = evaluateRule(
      {
        conditions: [
          { field: "task.display_status", op: "in", value: ["pending", "active"] },
          { field: "task.file_count", op: "gt", value: 0 },
        ],
      },
      context,
      OPTIONS,
    );
    expect(evaluation.matched).toBe(false);
    expect(evaluation.conditions.map((item) => item.passed)).toEqual([true, false]);
  });
});

describe("窗口与幂等键", () => {
  it("mondayOf / isoWeekKey：同周稳定、跨周不同", () => {
    const monday = mondayOf(BUSINESS_DAY);
    expect(monday).toBe("2026-09-21");
    expect(isoWeekKey(monday)).toBe(isoWeekKey(addDays(monday, 6)));
    expect(isoWeekKey(monday)).toBe("2026-W39");
    expect(isoWeekKey(addDays(monday, 7))).toBe("2026-W40");
  });

  it("dedupeKey：规则 + 实体 + 窗口", () => {
    expect(dedupeKey("R03", "task-1", "2026-09-24")).toBe("R03:task-1:2026-09-24");
  });
});

describe("触发窗口求值", () => {
  it("T_MINUS_1：基准日前 1 天 08:00，键 = 触发日", () => {
    const fire = resolveScheduleFire({
      window: "T_MINUS_1",
      businessDate: BUSINESS_DAY,
      baseDate: addDays(BUSINESS_DAY, 1),
      time: "08:00",
      shiftEnabled: false,
      shiftDirection: "forward",
      calendar: NO_EXCEPTIONS,
    });
    expect(fire).not.toBeNull();
    expect(fire?.fireDate).toBe(BUSINESS_DAY);
    expect(fire?.windowKey).toBe(BUSINESS_DAY);
    expect(fire?.fireAt).toBe("2026-09-23T00:00:00.000Z"); // 08:00 Asia/Shanghai
  });

  it("T_PLUS_1：节假日顺延开关两态（开 = 顺延到下一工作日）", () => {
    const holiday = calendarWindow("2026-09-01", "2026-12-31", [
      { date: "2026-10-01", dayType: "holiday", name: "国庆节", note: null },
    ]);
    const base = {
      window: "T_PLUS_1" as const,
      businessDate: "2026-10-02",
      baseDate: "2026-09-30",
      time: "08:00",
      shiftDirection: "forward" as const,
      calendar: holiday,
    };
    expect(resolveScheduleFire({ ...base, shiftEnabled: false })?.fireDate).toBe("2026-10-01");
    expect(resolveScheduleFire({ ...base, shiftEnabled: true })?.fireDate).toBe("2026-10-02");
  });

  it("SAME_DAY：取基准日当天 10:00", () => {
    const fire = resolveScheduleFire({
      window: "SAME_DAY",
      businessDate: "2026-09-23",
      baseDate: "2026-09-23",
      time: "10:00",
      shiftEnabled: false,
      shiftDirection: "forward",
      calendar: NO_EXCEPTIONS,
    });
    expect(fire?.fireDate).toBe("2026-09-23");
    expect(fire?.fireAt).toBe("2026-09-23T02:00:00.000Z"); // 10:00 Asia/Shanghai
  });

  it("WEEKLY：取所在周周一 09:30，键 = ISO 周", () => {
    const fire = resolveScheduleFire({
      window: "WEEKLY",
      businessDate: "2026-09-23",
      baseDate: null,
      time: "09:30",
      shiftEnabled: false,
      shiftDirection: "forward",
      calendar: NO_EXCEPTIONS,
    });
    expect(fire?.fireDate).toBe("2026-09-21");
    expect(fire?.windowKey).toBe("2026-W39");
    expect(fire?.fireAt).toBe("2026-09-21T01:30:00.000Z"); // 09:30 Asia/Shanghai
  });

  it("基准字段缺失 → null（该实体本窗口不触发）", () => {
    const fire = resolveScheduleFire({
      window: "T_MINUS_1",
      businessDate: BUSINESS_DAY,
      baseDate: null,
      time: "08:00",
      shiftEnabled: false,
      shiftDirection: "forward",
      calendar: NO_EXCEPTIONS,
    });
    expect(fire).toBeNull();
  });
});
