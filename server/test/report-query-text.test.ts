import { describe, expect, it } from "vitest";
import type { ReportDigestIssue, ReportDigestReport, ReportDigestSnapshot } from "../src/modules/report-issue/index.js";
import {
  buildAmbiguousProjectMessage,
  buildReportQueryText,
  REPORT_QUERY_LIST_TRUNCATION_SUFFIX,
} from "../src/modules/report-query/report-query.text.js";

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "PRJ-001",
  name: "临港数据中心",
  managers: ["王经理"],
};

function report(id: string, overrides: Partial<ReportDigestReport> = {}): ReportDigestReport {
  return {
    id,
    authorId: "user-1",
    authorName: "张三",
    submittedAt: "2026-11-10T01:12:00.000Z",
    state: "submitted",
    headcount: 2,
    stageKeys: [],
    stageNames: [],
    doneWork: "完成设备联调",
    plan: "继续现场验收",
    photos: [],
    ...overrides,
  };
}

function issue(id: string): ReportDigestIssue {
  return {
    id,
    title: "现场问题",
    categories: ["quality"],
    state: "open",
    ownerDepartment: null,
    ownerId: null,
    ownerName: null,
    solution: null,
    raisedAt: "2026-11-10",
    sourceReportId: null,
    sourceReport: null,
    photos: [],
  };
}

function snapshot(overrides: Partial<ReportDigestSnapshot> = {}): ReportDigestSnapshot {
  return {
    project: PROJECT,
    date: "2026-11-10",
    reports: [],
    draftCount: 0,
    issues: [],
    ...overrides,
  };
}

function build(data: ReportDigestSnapshot, options: { canViewIssues?: boolean; maxBytes?: number; topic?: "reports" | "issues" | "both" } = {}) {
  return buildReportQueryText({
    ...data,
    topic: options.topic ?? "both",
    canViewIssues: options.canViewIssues ?? true,
    publicBaseUrl: "https://pm.libiaorobot.com/",
    maxBytes: options.maxBytes ?? 20_000,
  });
}

describe("report-query text（S3 文字与深链）", () => {
  it("单篇日报使用 report 深链，并有当日问题链接", () => {
    const content = build(snapshot({ reports: [report("report-1")], issues: [issue("issue-1")] }));

    expect(content).toContain("**项目日报查询 · 2026-11-10**");
    expect(content).toContain("项目：临港数据中心（PRJ-001）");
    expect(content).toContain("已提交日报 1 篇，草稿 0 篇；问题 1 条");
    expect(content).toContain("[查看当天日报](https://pm.libiaorobot.com/#/project/" + PROJECT.id + "?view=daily&date=2026-11-10&report=report-1)");
    expect(content).toContain("[查看当天问题](https://pm.libiaorobot.com/#/project/" + PROJECT.id + "?view=daily&sub=issues&date=2026-11-10)");
    expect(content).toContain("1. 张三 · 09:12 · [打开该篇日报](");
  });

  it("多篇日报使用当天 date 深链，逐篇均保留", () => {
    const content = build(
      snapshot({
        reports: [report("report-1"), report("report-2", { authorName: "李四", state: "supplement" })],
      }),
      { canViewIssues: false },
    );

    expect(content).toContain("[查看当天全部日报](https://pm.libiaorobot.com/#/project/" + PROJECT.id + "?view=daily&date=2026-11-10)");
    expect(content).toContain("已提交日报 2 篇（其中补填 1 篇），草稿 0 篇");
    expect(content.match(/\[打开该篇日报\]/g)).toHaveLength(2);
    expect(content).toContain("2. 李四 · 09:12 · 补填");
  });

  it("无 issue.view 时问题数量、链接和正文全部隐藏", () => {
    const content = build(snapshot({ reports: [report("report-1")], issues: [issue("issue-1")] }), {
      canViewIssues: false,
    });

    expect(content).toContain("已提交日报 1 篇，草稿 0 篇");
    expect(content).not.toContain("问题");
    expect(content).not.toContain("sub=issues");
  });

  it("问题专项查询不输出日报数量与列表", () => {
    const content = build(snapshot({ reports: [report("report-1")], issues: [issue("issue-1")] }), {
      topic: "issues",
    });

    expect(content).toContain("问题 1 条");
    expect(content).toContain("[查看当天问题](");
    expect(content).not.toContain("已提交日报");
    expect(content).not.toContain("打开该篇日报");
    expect(content).not.toContain("view=daily&date=2026-11-10)");
  });

  it("空态仍保留主深链", () => {
    const content = build(snapshot());

    expect(content).toContain("已提交日报 0 篇，草稿 0 篇；问题 0 条");
    expect(content).toContain("当天暂无已提交日报。 当天暂无问题。");
    expect(content).toContain("[查看当天全部日报](");
    expect(content).toContain("[查看当天问题](");
  });

  it("项目名与填写者进入 Markdown 前转义", () => {
    const content = build(
      snapshot({
        project: { ...PROJECT, name: "A[1]*", code: "P_RJ" },
        reports: [report("report-1", { authorName: "*张_" })],
      }),
      { canViewIssues: false },
    );

    expect(content).toContain("项目：A\\[1\\]\\*（P\\_RJ）");
    expect(content).toContain("1. \\*张\\_ · 09:12");
  });

  it("超限时只截断逐篇列表，主深链保留", () => {
    const reports = Array.from({ length: 30 }, (_, index) => report("report-" + String(index + 1)));
    const content = build(snapshot({ reports }), { canViewIssues: false, maxBytes: 1_600 });

    expect(content).toContain("[查看当天全部日报](");
    expect(content).toContain(REPORT_QUERY_LIST_TRUNCATION_SUFFIX.trim());
    expect((content.match(/\[打开该篇日报\]/g) ?? []).length).toBeLessThan(30);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(1_600);
  });

  it("项目重名只输出编号与名称，并限制候选展示数量", () => {
    const candidates = Array.from({ length: 22 }, (_, index) => ({
      code: "PRJ-" + String(index + 1).padStart(3, "0"),
      name: "临港数据中心",
    }));
    const content = buildAmbiguousProjectMessage("临港数据中心", candidates);

    expect(content).toContain("匹配到 22 个可见项目，请使用编号查询");
    expect(content).toContain("1. PRJ-001（临港数据中心）");
    expect(content).toContain("20. PRJ-020（临港数据中心）");
    expect(content).not.toContain("21. PRJ-021");
    expect(content).toContain("…另有 2 个项目");
  });
});
