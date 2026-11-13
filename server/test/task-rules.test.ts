import { describe, expect, it } from "vitest";
import { parseTaskListFilter, parseTaskSort } from "../src/modules/task/task.query.js";
import {
  applyProgressWrite,
  applyStatusWrite,
  deriveDisplayStatus,
  deriveOnTime,
  isUnfinalizeLockedByPlannedEnd,
  shanghaiToday,
  type TaskDerivationInput,
} from "../src/modules/task/task.rules.js";
import { AppError } from "../src/common/errors/app-error.js";

const TODAY = "2026-09-20";

function input(overrides: Partial<TaskDerivationInput>): TaskDerivationInput {
  return {
    status: "pending",
    statusOverride: null,
    plannedEnd: null,
    actualEnd: null,
    storedOnTime: null,
    today: TODAY,
    ...overrides,
  };
}

describe("deriveDisplayStatus（A1-06 / A12 / A14 五态派生）", () => {
  it("未完成未到期 → 待开始 / 进行中（按基础态）", () => {
    expect(deriveDisplayStatus(input({ status: "pending", plannedEnd: "2026-09-30" }))).toBe("pending");
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: "2026-09-30" }))).toBe("active");
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: null }))).toBe("active");
  });

  it("未完成且已过预计完成日期 → 已延期（派生优先，不论基础态）", () => {
    expect(deriveDisplayStatus(input({ status: "pending", plannedEnd: "2026-09-19" }))).toBe("overdue");
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: "2026-09-19" }))).toBe("overdue");
  });

  it("完成按工期分 已完成 / 提前完成（同日 = 已完成；逾期补完不回退提前完成）", () => {
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-24" }))).toBe("early_done");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-25" }))).toBe("done");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-28" }))).toBe("done");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: null, actualEnd: "2026-09-28" }))).toBe("done");
  });

  it("显式覆盖优先，且边界按基础态判定（early_done 仅已完成生效、overdue 仅未完成生效）", () => {
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: "2026-09-30", statusOverride: "overdue" }))).toBe("overdue");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-24", statusOverride: "early_done" }))).toBe("early_done");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-25", statusOverride: "early_done" }))).toBe("early_done");
    expect(deriveDisplayStatus(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-25", statusOverride: "overdue" }))).toBe("done");
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: "2026-09-30", statusOverride: "early_done" }))).toBe("active");
  });

  it("预计完成日期 = 今天不算逾期（日界口径）", () => {
    expect(deriveDisplayStatus(input({ status: "active", plannedEnd: TODAY }))).toBe("active");
  });
});

describe("deriveOnTime（A14 是否按时交付）", () => {
  it("完成且实际完成不晚于预计 → true；晚于 → false", () => {
    expect(deriveOnTime(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-24" }))).toBe(true);
    expect(deriveOnTime(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-25" }))).toBe(true);
    expect(deriveOnTime(input({ status: "done", plannedEnd: "2026-09-25", actualEnd: "2026-09-28" }))).toBe(false);
  });

  it("已完成未填完成日期且预计完成已过 → false（逾期已交付）", () => {
    expect(deriveOnTime(input({ status: "done", plannedEnd: "2026-09-19", actualEnd: null }))).toBe(false);
  });

  it("未完成且已过预计完成日期 → false（配 overdue = 逾期未交付）", () => {
    expect(deriveOnTime(input({ status: "active", plannedEnd: "2026-09-19" }))).toBe(false);
  });

  it("派生不出时回落存储值（仍无则 null）", () => {
    expect(deriveOnTime(input({ status: "active", plannedEnd: "2026-09-30", storedOnTime: true }))).toBe(true);
    expect(deriveOnTime(input({ status: "pending", storedOnTime: null }))).toBeNull();
    expect(deriveOnTime(input({ status: "done", plannedEnd: "2026-09-30", actualEnd: null, storedOnTime: false }))).toBe(false);
  });
});

describe("applyStatusWrite（A12 状态写入联动 · 2026-09-24 五态可写）", () => {
  it("done → 满格 + 缺省当天完成日期；已有完成日期保留；清覆盖", () => {
    expect(applyStatusWrite({ status: "active", progress: 0.5, actualEnd: null, statusOverride: null }, "done", TODAY)).toEqual({
      status: "done",
      progress: 1,
      actualEnd: TODAY,
      statusOverride: null,
    });
    expect(applyStatusWrite({ status: "active", progress: 0.5, actualEnd: "2026-09-18", statusOverride: "overdue" }, "done", TODAY)).toEqual({
      status: "done",
      progress: 1,
      actualEnd: "2026-09-18",
      statusOverride: null,
    });
  });

  it("active → 至少 1 格（0 → 0.25、满格 → 0.75）、清完成日期、清覆盖", () => {
    expect(applyStatusWrite({ status: "pending", progress: 0, actualEnd: null, statusOverride: null }, "active", TODAY)).toEqual({
      status: "active",
      progress: 0.25,
      actualEnd: null,
      statusOverride: null,
    });
    expect(applyStatusWrite({ status: "done", progress: 1, actualEnd: "2026-09-18", statusOverride: "early_done" }, "active", TODAY)).toEqual({
      status: "active",
      progress: 0.75,
      actualEnd: null,
      statusOverride: null,
    });
    expect(applyStatusWrite({ status: "active", progress: 0.5, actualEnd: null, statusOverride: null }, "active", TODAY).progress).toBe(0.5);
  });

  it("pending → 清进度、清完成日期、清覆盖", () => {
    expect(applyStatusWrite({ status: "done", progress: 1, actualEnd: "2026-09-18", statusOverride: "early_done" }, "pending", TODAY)).toEqual({
      status: "pending",
      progress: 0,
      actualEnd: null,
      statusOverride: null,
    });
  });

  it("overdue（已延期）→ 保持当前格数与完成日期、只落覆盖（原型「已延期 = 保持当前格数」）", () => {
    expect(applyStatusWrite({ status: "active", progress: 0.5, actualEnd: null, statusOverride: null }, "overdue", TODAY)).toEqual({
      status: "active",
      progress: 0.5,
      actualEnd: null,
      statusOverride: "overdue",
    });
  });

  it("early_done（提前完成）→ 四格全亮 + 缺省当天完成日期 + 覆盖", () => {
    expect(applyStatusWrite({ status: "active", progress: 0.5, actualEnd: null, statusOverride: null }, "early_done", TODAY)).toEqual({
      status: "done",
      progress: 1,
      actualEnd: TODAY,
      statusOverride: "early_done",
    });
    expect(applyStatusWrite({ status: "done", progress: 1, actualEnd: "2026-09-15", statusOverride: null }, "early_done", TODAY).actualEnd).toBe("2026-09-15");
  });
});

describe("applyProgressWrite（A13 进度写入联动）", () => {
  it("0 → 待开始；0.25~0.75 → 进行中，都清完成日期（清除的唯一方式）", () => {
    expect(applyProgressWrite(0, null, TODAY)).toEqual({ status: "pending", progress: 0, actualEnd: null, statusOverride: null });
    expect(applyProgressWrite(0.5, null, TODAY)).toEqual({ status: "active", progress: 0.5, actualEnd: null, statusOverride: null });
    expect(applyProgressWrite(0.75, "2026-09-10", TODAY)).toEqual({ status: "active", progress: 0.75, actualEnd: null, statusOverride: null });
  });

  it("1 → 已完成 + 完成日期（缺省当天；显式传入用传入值）", () => {
    expect(applyProgressWrite(1, null, TODAY)).toEqual({ status: "done", progress: 1, actualEnd: TODAY, statusOverride: null });
    expect(applyProgressWrite(1, "2026-09-15", TODAY)).toEqual({ status: "done", progress: 1, actualEnd: "2026-09-15", statusOverride: null });
  });
});

describe("shanghaiToday（ADR-028 日界）", () => {
  it("UTC 16:00 后进入上海次日", () => {
    expect(shanghaiToday(new Date("2026-09-20T15:59:59Z"))).toBe("2026-09-20");
    expect(shanghaiToday(new Date("2026-09-20T16:00:00Z"))).toBe("2026-09-21");
  });
});

describe("isUnfinalizeLockedByPlannedEnd（定档取消时间闸）", () => {
  it("预计完成日期当天及之前可取消，空日期不锁", () => {
    expect(isUnfinalizeLockedByPlannedEnd(TODAY, TODAY)).toBe(false);
    expect(isUnfinalizeLockedByPlannedEnd("2026-09-21", TODAY)).toBe(false);
    expect(isUnfinalizeLockedByPlannedEnd(null, TODAY)).toBe(false);
  });

  it("预计完成日期已过（业务今天晚于 plannedEnd）只允许定档，不允许取消", () => {
    expect(isUnfinalizeLockedByPlannedEnd("2026-09-19", TODAY)).toBe(true);
  });
});

describe("parseTaskListFilter / parseTaskSort（M3-01 查询解析）", () => {
  const base = { page: 1, limit: 50 };

  it("解析合法筛选：stage / ownerId / 展示态多值 / 关键字 trim", () => {
    const filter = parseTaskListFilter({
      ...base,
      stage: "install",
      "filter[ownerId]": "caa8d763-4b6a-4967-9b26-7d1086272c9c",
      "filter[status]": "overdue,pending",
      q: "  货架  ",
    });
    expect(filter).toEqual({
      stageKey: "install",
      ownerId: "caa8d763-4b6a-4967-9b26-7d1086272c9c",
      displayStatuses: ["overdue", "pending"],
      keyword: "货架",
    });
  });

  it("非法 stage / ownerId / 展示态 → 400 VALIDATION_FAILED", () => {
    expect(() => parseTaskListFilter({ ...base, stage: "unknown" })).toThrow(AppError);
    expect(() => parseTaskListFilter({ ...base, "filter[ownerId]": "not-uuid" })).toThrow(/ownerId/);
    expect(() => parseTaskListFilter({ ...base, "filter[status]": "done,bogus" })).toThrow(/展示态/);
  });

  it("sort：缺省为空（默认顺序）；白名单字段可解析；非法字段 / 方向 400", () => {
    expect(parseTaskSort(undefined)).toEqual([]);
    expect(parseTaskSort("plannedEnd:asc,progress:desc")).toEqual([
      { field: "plannedEnd", direction: "asc" },
      { field: "progress", direction: "desc" },
    ]);
    expect(parseTaskSort("title")).toEqual([{ field: "title", direction: "asc" }]);
    expect(() => parseTaskSort("stageKey:asc")).toThrow(/白名单/);
    expect(() => parseTaskSort("title:up")).toThrow(/方向/);
  });
});
