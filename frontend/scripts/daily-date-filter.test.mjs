import assert from "node:assert/strict";
import test from "node:test";

import {
  isDailyDate,
  matchesDailyDate,
  parseDailyDateParam,
  removeDailyDateParam,
} from "../src/dailyDateFilter.ts";

test("isDailyDate：只接受真实存在的 YYYY-MM-DD", () => {
  assert.equal(isDailyDate("2026-11-11"), true);
  assert.equal(isDailyDate("2024-02-29"), true);
  assert.equal(isDailyDate("2026-02-29"), false);
  assert.equal(isDailyDate("2026-02-31"), false);
  assert.equal(isDailyDate("2026-13-01"), false);
  assert.equal(isDailyDate("2026-1-01"), false);
  assert.equal(isDailyDate(" 2026-11-11 "), false);
  assert.equal(isDailyDate(""), false);
});

test("parseDailyDateParam：取第一个 date，非法值返回 null", () => {
  assert.equal(parseDailyDateParam("view=daily&date=2026-11-10"), "2026-11-10");
  assert.equal(parseDailyDateParam("date=2026-11-10&date=2026-11-11"), "2026-11-10");
  assert.equal(parseDailyDateParam("date=2026-11-10%20"), "2026-11-10");
  assert.equal(parseDailyDateParam("date=2026-02-31&date=2026-11-10"), null);
  assert.equal(parseDailyDateParam("view=daily"), null);
  assert.equal(parseDailyDateParam("date="), null);
});

test("removeDailyDateParam：移除全部 date，保留路径、其它参数与顺序", () => {
  assert.equal(
    removeDailyDateParam("#/project/p1?view=daily&date=2026-11-10&report=r1"),
    "#/project/p1?view=daily&report=r1",
  );
  assert.equal(
    removeDailyDateParam("#/project/p1?date=2026-11-10&view=daily&date=2026-11-11"),
    "#/project/p1?view=daily",
  );
  assert.equal(
    removeDailyDateParam("#/project/p1?view=daily&date=2026-11-10"),
    "#/project/p1?view=daily",
  );
  assert.equal(removeDailyDateParam("#/project/p1?view=daily"), "#/project/p1?view=daily");
  assert.equal(removeDailyDateParam("#/project/p1"), "#/project/p1");
});

test("matchesDailyDate：按日报日期 / 问题提出日期精确匹配", () => {
  assert.equal(matchesDailyDate("2026-11-10", null), true);
  assert.equal(matchesDailyDate("2026-11-10", "2026-11-10"), true);
  assert.equal(matchesDailyDate("2026-11-10", "2026-11-11"), false);
  assert.equal(matchesDailyDate("2026-11-10T09:00:00+08:00", "2026-11-10"), false);
});
