import { afterEach, describe, expect, it, vi } from "vitest";
import { photoStore } from "./fakes/report-issue-links.fake.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { IssueRepository, IssueRow } from "../src/modules/report-issue/issue.repository.js";
import { ReportDigestService } from "../src/modules/report-issue/report-digest.service.js";
import type { DailyReportRow, ReportRepository } from "../src/modules/report-issue/report.repository.js";

vi.mock("../src/modules/report-issue/report-issue.links.js", async () => {
  const { createReportIssueLinksFake } = await import("./fakes/report-issue-links.fake.js");
  return createReportIssueLinksFake();
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ALICE = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const BOB = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const FILE_REPORT = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const FILE_ISSUE = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const DATE = "2026-11-10";
const AT_EARLY = new Date("2026-11-10T01:00:00Z");
const AT_MIDDLE = new Date("2026-11-10T02:00:00Z");
const AT_LATE = new Date("2026-11-10T03:00:00Z");

function makeReport(id: string, overrides: Partial<DailyReportRow> = {}): DailyReportRow {
  return {
    id,
    projectId: PROJECT,
    authorId: ALICE,
    authorName: "张三",
    reportDate: DATE,
    state: "submitted",
    headcount: 2,
    doneWork: "完成设备安装",
    plan: "完成联调",
    foundIssue: null,
    issueCategories: [],
    suggestion: null,
    issueDrafts: [],
    stageKeys: ["design"],
    submittedAt: AT_EARLY,
    createdAt: AT_EARLY,
    updatedAt: AT_EARLY,
    version: 1,
    ...overrides,
  };
}

function makeIssue(id: string, overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id,
    projectId: PROJECT,
    taskId: null,
    sourceReportId: null,
    title: "现场发现问题",
    categories: ["机械部"],
    state: "processing",
    reporterId: ALICE,
    reporterName: "张三",
    ownerDepartment: "机械部",
    ownerId: BOB,
    ownerName: "李四",
    raisedAt: DATE,
    solution: "调整安装位置",
    closedBy: null,
    closedAt: null,
    createdAt: AT_EARLY,
    updatedAt: AT_EARLY,
    version: 1,
    ...overrides,
  };
}

class FakeReportRepository {
  project: { id: string; code: string; status: string; name: string; managerIds: string[] } | null = {
    id: PROJECT,
    code: "PRJ-001",
    status: "active",
    name: "临港数据中心",
    managerIds: [BOB],
  };
  rows: DailyReportRow[] = [];
  clients: unknown[] = [];
  dates: string[] = [];

  async findProject(_projectId: string, client: unknown) {
    this.clients.push(client);
    return this.project;
  }

  async listByDate(projectId: string, reportDate: string, client: unknown): Promise<DailyReportRow[]> {
    this.clients.push(client);
    this.dates.push(reportDate);
    return this.rows.filter((row) => row.projectId === projectId && row.reportDate === reportDate);
  }

  async listDisplayNames(userIds: readonly string[], client: unknown): Promise<Map<string, string>> {
    this.clients.push(client);
    const names = new Map([[BOB, "李四-test"]]);
    return new Map(
      [...new Set(userIds)]
        .map((id) => [id, names.get(id)?.replace(/-test$/i, "").trim() ?? ""] as const)
        .filter(([, name]) => name !== ""),
    );
  }
}

class FakeIssueRepository {
  rows: IssueRow[] = [];
  clients: unknown[] = [];
  dates: string[] = [];

  async listByRaisedDate(projectId: string, raisedDate: string, client: unknown): Promise<IssueRow[]> {
    this.clients.push(client);
    this.dates.push(raisedDate);
    return this.rows
      .filter((row) => row.projectId === projectId && row.raisedAt === raisedDate)
      .sort((left, right) => {
        if (left.createdAt.getTime() !== right.createdAt.getTime()) return left.createdAt.getTime() - right.createdAt.getTime();
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
  }
}

function linkPhoto(fileId: string, name: string, objectType: "report" | "issue", objectId: string, kind = ""): void {
  photoStore.seedFile(fileId, name, PROJECT);
  photoStore.links.push({ fileId, objectType, objectId, kind });
}

function makeService(reports: FakeReportRepository, issues: FakeIssueRepository) {
  const tx = { name: "read-only-tx" };
  const transactionCalls: Array<{ options: unknown; tx: unknown }> = [];
  const database = {
    db: {
      transaction: async (
        work: (client: unknown) => Promise<unknown>,
        options: unknown,
      ): Promise<unknown> => {
        transactionCalls.push({ options, tx });
        return work(tx);
      },
    },
  };
  return {
    service: new ReportDigestService(
      database as unknown as DatabaseService,
      reports as unknown as ReportRepository,
      issues as unknown as IssueRepository,
    ),
    transactionCalls,
    tx,
  };
}

afterEach(() => {
  photoStore.reset();
});

describe("ReportDigestService（S1 日报查询快照）", () => {
  it("只返回 submitted / supplement，草稿只计数且不读正文、阶段和附图", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("draft", {
        state: "draft",
        submittedAt: null,
        doneWork: "草稿正文不得返回",
        stageKeys: ["delivery"],
      }),
      makeReport("submitted"),
      makeReport("supplement", { state: "supplement", submittedAt: AT_MIDDLE }),
    ];
    linkPhoto(FILE_REPORT, "现场图.png", "report", "submitted", "onsite");
    linkPhoto("draft-photo", "草稿图.png", "report", "draft", "onsite");
    const { service } = makeService(reports, new FakeIssueRepository());

    const snapshot = await service.getSnapshot(PROJECT, DATE);

    expect(snapshot.draftCount).toBe(1);
    expect(snapshot.reports.map((report) => report.id)).toEqual(["submitted", "supplement"]);
    expect(snapshot.reports.some((report) => report.doneWork === "草稿正文不得返回")).toBe(false);
    expect(snapshot.reports[0]).toMatchObject({
      state: "submitted",
      headcount: 2,
      stageKeys: ["design"],
      stageNames: ["设计开发"],
      photos: [
        {
          fileId: FILE_REPORT,
          name: "现场图.png",
          objectKey: "objects/" + FILE_REPORT,
          mime: "image/png",
        },
      ],
    });
    expect(snapshot.project.managers).toEqual(["李四"]);
    expect(photoStore.calls.loadReportPosterPhotos).toEqual([["submitted", "supplement"]]);
  });

  it("同人同日多篇逐篇返回，按提交时间 → 创建时间 → id 稳定排序", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("late", { submittedAt: AT_LATE, createdAt: AT_EARLY }),
      makeReport("same-submit-late-create", { submittedAt: AT_MIDDLE, createdAt: AT_MIDDLE }),
      makeReport("same-submit-early-create", { submittedAt: AT_MIDDLE, createdAt: AT_EARLY }),
      makeReport("same-all-a", { submittedAt: AT_MIDDLE, createdAt: AT_EARLY }),
      makeReport("same-all-b", { submittedAt: AT_MIDDLE, createdAt: AT_EARLY }),
    ];
    const { service } = makeService(reports, new FakeIssueRepository());

    const snapshot = await service.getSnapshot(PROJECT, DATE);

    expect(snapshot.reports.map((report) => report.id)).toEqual([
      "same-all-a",
      "same-all-b",
      "same-submit-early-create",
      "same-submit-late-create",
      "late",
    ]);
    expect(snapshot.reports.every((report) => report.authorId === ALICE)).toBe(true);
  });

  it("问题按查询日读取手工 + 派生问题，返回当前责任人与批量附图", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [makeReport("source-report")];
    const issues = new FakeIssueRepository();
    issues.rows = [
      makeIssue("manual", { createdAt: AT_EARLY, solution: "手工处理方案" }),
      makeIssue("derived", { createdAt: AT_LATE, sourceReportId: "source-report" }),
      makeIssue("other-day", { raisedAt: "2026-11-09" }),
    ];
    linkPhoto(FILE_ISSUE, "问题图.png", "issue", "derived");
    const { service } = makeService(reports, issues);

    const snapshot = await service.getSnapshot(PROJECT, DATE);

    expect(issues.dates).toEqual([DATE]);
    expect(snapshot.issues.map((issue) => issue.id)).toEqual(["manual", "derived"]);
    expect(snapshot.issues[0]).toMatchObject({
      title: "现场发现问题",
      categories: ["机械部"],
      state: "processing",
      ownerDepartment: "机械部",
      ownerName: "李四",
      solution: "手工处理方案",
      raisedAt: DATE,
      sourceReportId: null,
      sourceReport: null,
      photos: [],
    });
    expect(snapshot.issues[1]).toMatchObject({
      sourceReportId: "source-report",
      sourceReport: {
        id: "source-report",
        authorId: ALICE,
        authorName: "张三",
        submittedAt: AT_EARLY.toISOString(),
      },
      photos: [
        {
          fileId: FILE_ISSUE,
          name: "问题图.png",
          objectKey: "objects/" + FILE_ISSUE,
          mime: "image/png",
        },
      ],
    });
    expect(photoStore.calls.loadIssuePosterPhotos).toEqual([["manual", "derived"]]);
  });

  it("同一次快照使用只读可重复读事务，所有仓储读取共用一个事务句柄", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [makeReport("r1")];
    const issues = new FakeIssueRepository();
    issues.rows = [makeIssue("i1")];
    const { service, transactionCalls, tx } = makeService(reports, issues);

    await service.getSnapshot(PROJECT, DATE);

    expect(transactionCalls).toEqual([
      { options: { isolationLevel: "repeatable read", accessMode: "read only" }, tx },
    ]);
    expect(reports.clients).toEqual([tx, tx, tx]);
    expect(issues.clients).toEqual([tx]);
  });

  it("空态仍返回项目与日期；项目不存在统一 NOT_FOUND", async () => {
    const reports = new FakeReportRepository();
    const { service } = makeService(reports, new FakeIssueRepository());

    const empty = await service.getSnapshot(PROJECT, DATE);
    expect(empty).toEqual({
      project: { id: PROJECT, code: "PRJ-001", name: "临港数据中心", managers: ["李四"] },
      date: DATE,
      reports: [],
      draftCount: 0,
      issues: [],
    });
    expect(photoStore.calls.loadReportPosterPhotos).toEqual([[]]);
    expect(photoStore.calls.loadIssuePosterPhotos).toEqual([[]]);

    reports.project = null;
    await expect(service.getSnapshot(PROJECT, DATE)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });
});
