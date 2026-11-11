import { describe, expect, it } from "vitest";
import { isReportQueryText, normalizeReportQueryText, parseReportQuery } from "../src/modules/report-query/report-query.parser.js";

const TODAY = "2026-11-11";

function parse(text: string, requireProject: boolean) {
  return parseReportQuery(text, { today: TODAY, requireProject });
}

describe("report-query parser（S3 命令 / 日期 / 项目）", () => {
  it("去除开头 @ 提及，支持“项目 + 引号名称 + 相对日期 + 主题”", () => {
    expect(normalizeReportQueryText("@LibiaoLink 查询 项目 \"临港 数据中心\" 昨天日报")).toBe(
      "查询 项目 \"临港 数据中心\" 昨天日报",
    );
    expect(parse("@LibiaoLink 查询 项目 \"临港 数据中心\" 昨天日报", true)).toEqual({
      ok: true,
      command: { projectReference: "临港 数据中心", date: "2026-11-10", topic: "reports" },
    });
  });

  it("群聊省略项目时可识别紧凑的“昨天日报和问题”", () => {
    expect(parse("<@bot-id> 查询 昨天日报和问题", false)).toEqual({
      ok: true,
      command: { projectReference: null, date: "2026-11-10", topic: "both" },
    });
  });

  it("缺省日期为 Asia/Shanghai 今天，缺省主题为日报和问题", () => {
    expect(parse("查询 PRJ-001", false)).toEqual({
      ok: true,
      command: { projectReference: "PRJ-001", date: TODAY, topic: "both" },
    });
  });

  it("项目名以主题词或相对日期词开头时不会误判为省略项目", () => {
    expect(parse("查询 问题中心 昨天日报", false)).toEqual({
      ok: true,
      command: { projectReference: "问题中心", date: "2026-11-10", topic: "reports" },
    });
    expect(parse("查询 今天项目 昨天日报", false)).toEqual({
      ok: true,
      command: { projectReference: "今天项目", date: "2026-11-10", topic: "reports" },
    });
  });

  it("支持 / 与中文日期格式，并按日历校验", () => {
    expect(parse("查询 PRJ-001 2026/11/09 日报", true)).toEqual({
      ok: true,
      command: { projectReference: "PRJ-001", date: "2026-11-09", topic: "reports" },
    });
    expect(parse("查询 项目 PRJ-001 2026年11月8日 问题", true)).toEqual({
      ok: true,
      command: { projectReference: "PRJ-001", date: "2026-11-08", topic: "issues" },
    });
    expect(parse("查询 PRJ-001 2026-02-30 日报", true)).toEqual({ ok: false, reason: "invalid_date" });
  });

  it("拒绝未来日期", () => {
    expect(parse("查询 PRJ-001 2026-11-12 日报", true)).toEqual({ ok: false, reason: "future_date" });
  });

  it("单聊必须显式指定项目；语法错误不进入绑定码链路", () => {
    expect(parse("查询 昨天日报", true)).toEqual({ ok: false, reason: "missing_project" });
    expect(parse("查询 项目", true)).toEqual({ ok: false, reason: "missing_project" });
  });

  it("名称含空格但未加引号视为语法错误", () => {
    expect(parse("查询 项目 临港 数据中心 昨天日报", true)).toEqual({ ok: false, reason: "unexpected_tail" });
  });

  it("未闭合引号与多余尾部均拒绝", () => {
    expect(parse("查询 项目 \"临港数据中心 昨天日报", true)).toEqual({ ok: false, reason: "unclosed_quote" });
    expect(parse("查询 PRJ-001 昨天日报 额外", true)).toEqual({ ok: false, reason: "unexpected_tail" });
  });

  it("查询候选只要求正文以“查询”开头", () => {
    expect(isReportQueryText("@LibiaoLink 查询")).toBe(true);
    expect(isReportQueryText("查询功能说明")).toBe(true);
    expect(isReportQueryText("请查询日报")).toBe(false);
    expect(isReportQueryText(null)).toBe(false);
  });
});
