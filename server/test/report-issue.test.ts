/**
 * M6-01 ~ M6-03 日报 / 问题回归（A3 · Push 215 口径）：
 * 同日多条（原「一人一天一条」重复 409 REPORT_ALREADY_EXISTS 随批删除）、草稿写库（A3-02）、未来日期 400（A3-04）、
 * 提交自动生成问题（A3-09 幂等 + 问题图转挂）、问题三态允许回退且留痕（A3-10 / A3-13）、
 * 附图（方案一：file_links kind 区分 onsite 现场图 / issue 问题图）、成对删除（删日报 / 删问题）、
 * 乐观锁 409、归档项目 409、跨项目 / 不存在 404、空更新 400。
 * 附图与成对删除的 SQL 边界（report-issue.links）在单测里以内存替身承接（vi.mock）—— 替身只镜像链路语义，
 * 真机口径见 server/README.md「M6-01 ~ M6-03」与 server/src/modules/report-issue/README.md。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DailyReportCreateBodySchema, DailyReportUpdateBodySchema } from "@libiaolink/contracts";
import type { AuditService } from "../src/modules/admin/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { IssueRepository, IssueRow } from "../src/modules/report-issue/issue.repository.js";
import { IssueService } from "../src/modules/report-issue/issue.service.js";
import type { DailyReportRow, ReportRepository } from "../src/modules/report-issue/report.repository.js";
import type { ProjectGroupService } from "../src/modules/project/index.js";
import { ReportService } from "../src/modules/report-issue/report.service.js";
import { shanghaiToday } from "../src/modules/task/task.rules.js";

import { photoStore } from "./fakes/report-issue-links.fake.js";

vi.mock("../src/modules/report-issue/report-issue.links.js", async () => {
  const { createReportIssueLinksFake } = await import("./fakes/report-issue-links.fake.js");
  return createReportIssueLinksFake();
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const OTHER_ACTOR = "66666666-6666-4666-8666-666666666666";
const REPORT_1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const REPORT_2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const ISSUE_1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const ISSUE_2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const FILE_A = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const FILE_B = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const PAST_DATE = "2026-01-05";
const FUTURE_DATE = "2099-01-01";
const AT = new Date("2026-09-22T08:00:00Z");
const TODAY = shanghaiToday(AT);

interface OutboxRow {
  topic: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

interface AuditEntry {
  action: string;
  objectType: string;
  objectId: string;
  projectId: string | null;
  changes: unknown;
  metadata?: Record<string, unknown>;
}

class FakeDatabase {
  outbox: OutboxRow[] = [];
  tx = {
    insert: () => ({
      values: (value: OutboxRow) => {
        this.outbox.push(value);
        return {
          onConflictDoUpdate: async () => undefined,
        };
      },
    }),
  } as unknown as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
    insert: this.tx.insert,
  } as unknown as DatabaseService["db"];
}

class FakeAuditService {
  entries: AuditEntry[] = [];
  record = async (_client: DbClient, input: AuditEntry): Promise<void> => {
    this.entries.push(input);
  };
}

class FakeProjectGroupService {
  bound = false;
  name: string | null = "交付项目群";

  async getGroup(projectId: string) {
    return {
      projectId,
      bound: this.bound,
      name: this.bound ? this.name : null,
      chatidMasked: this.bound ? "****abcd" : null,
      activated: this.bound,
      updatedAt: null,
    };
  }
}

function makeReport(id: string, overrides: Partial<DailyReportRow> = {}): DailyReportRow {
  return {
    id,
    projectId: PROJECT,
    authorId: ACTOR,
    authorName: "填报人",
    reportDate: PAST_DATE,
    state: "submitted",
    headcount: 3,
    doneWork: "完成设备安装",
    plan: null,
    foundIssue: null,
    issueCategories: [],
    suggestion: null,
    issueDrafts: [],
    stageKeys: [],
    submittedAt: AT,
    createdAt: AT,
    updatedAt: AT,
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
    state: "open",
    reporterId: ACTOR,
    reporterName: "填报人",
    ownerDepartment: "机械部",
    ownerId: null,
    ownerName: null,
    raisedAt: PAST_DATE,
    solution: null,
    closedBy: null,
    closedAt: null,
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    ...overrides,
  };
}

/** 日报仓储替身：镜像真仓储的读面过滤（项目 + 筛选）、插入与乐观锁（同日多条 —— 无唯一键判重）。 */
class FakeReportRepository {
  project: { id: string; status: string } | null = { id: PROJECT, status: "active" };
  reports = new Map<string, DailyReportRow>();
  inserted: DailyReportRow[] = [];
  reportIds = [REPORT_1, REPORT_2, "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3", "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4"];
  issuedReports = 0;
  updateCalls = 0;

  async list(
    projectId: string,
    filter: { dateFrom: string | null; dateTo: string | null; states: string[] | null; authorId: string | null },
  ): Promise<{ rows: DailyReportRow[]; total: number }> {
    const rows = [...this.reports.values()]
      .filter((row) => row.projectId === projectId)
      .filter((row) => filter.dateFrom === null || row.reportDate >= filter.dateFrom)
      .filter((row) => filter.dateTo === null || row.reportDate <= filter.dateTo)
      .filter((row) => filter.states === null || filter.states.includes(row.state))
      .filter((row) => filter.authorId === null || row.authorId === filter.authorId)
      .sort((left, right) => (left.reportDate < right.reportDate ? 1 : -1));
    return { rows, total: rows.length };
  }

  async findById(projectId: string, reportId: string): Promise<DailyReportRow | null> {
    const row = this.reports.get(reportId);
    return row !== undefined && row.projectId === projectId ? row : null;
  }

  async insert(
    input: Omit<DailyReportRow, "id" | "authorName" | "version" | "createdAt" | "updatedAt">,
    at: Date,
  ): Promise<DailyReportRow> {
    const id = this.reportIds[this.issuedReports] ?? REPORT_2 + "-" + String(this.issuedReports);
    this.issuedReports += 1;
    const row = makeReport(id, { ...input, version: 1, createdAt: at, updatedAt: at });
    this.inserted.push(row);
    this.reports.set(row.id, row);
    return row;
  }

  async updateWithVersion(reportId: string, expectedVersion: number, patch: Partial<DailyReportRow>, at: Date): Promise<boolean> {
    this.updateCalls += 1;
    const row = this.reports.get(reportId);
    if (row === undefined || row.version !== expectedVersion) return false;
    this.reports.set(reportId, { ...row, ...patch, version: row.version + 1, updatedAt: at });
    return true;
  }

  async findProject(projectId: string): Promise<{ id: string; status: string } | null> {
    return this.project !== null && this.project.id === projectId ? this.project : null;
  }
}

/** 问题仓储替身：镜像 source_report_id 唯一（A3-09 幂等）、乐观锁与事件表。 */
class FakeIssueRepository {
  project: { id: string; status: string } | null = { id: PROJECT, status: "active" };
  issues = new Map<string, IssueRow>();
  events: { id: string; issueId: string; eventType: string; fromState: string | null; toState: string | null; actorId: string; actorName: string | null; note: string | null; createdAt: Date }[] = [];
  issueIds = [ISSUE_2, "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3", "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"];
  issuedIssues = 0;

  async list(projectId: string): Promise<{ rows: IssueRow[]; total: number }> {
    const rows = [...this.issues.values()].filter((row) => row.projectId === projectId);
    return { rows, total: rows.length };
  }

  async findById(projectId: string, issueId: string): Promise<IssueRow | null> {
    const row = this.issues.get(issueId);
    return row !== undefined && row.projectId === projectId ? row : null;
  }

  /** Push 243：一日报多条问题 —— 反查返回全部（生成序）；幂等改由服务层按计数兜底。 */
  async listBySourceReport(reportId: string): Promise<IssueRow[]> {
    return [...this.issues.values()].filter((row) => row.sourceReportId === reportId);
  }

  async countBySourceReport(reportId: string): Promise<number> {
    return [...this.issues.values()].filter((row) => row.sourceReportId === reportId).length;
  }

  async insert(
    input: Omit<IssueRow, "id" | "reporterName" | "ownerName" | "version" | "createdAt" | "updatedAt">,
    at: Date,
  ): Promise<IssueRow> {
    const id = this.issueIds[this.issuedIssues] ?? ISSUE_2 + "-" + String(this.issuedIssues);
    this.issuedIssues += 1;
    const row = makeIssue(id, { ...input, version: 1, createdAt: at, updatedAt: at });
    this.issues.set(row.id, row);
    return row;
  }

  async updateWithVersion(issueId: string, expectedVersion: number, patch: Partial<IssueRow>, at: Date): Promise<boolean> {
    const row = this.issues.get(issueId);
    if (row === undefined || row.version !== expectedVersion) return false;
    this.issues.set(issueId, { ...row, ...patch, version: row.version + 1, updatedAt: at });
    return true;
  }

  async listEvents(issueId: string) {
    return this.events.filter((event) => event.issueId === issueId);
  }

  async insertEvent(
    input: { issueId: string; eventType: string; fromState: string | null; toState: string | null; note: string | null },
    actorId: string,
    at: Date,
  ): Promise<void> {
    this.events.push({
      id: "event-" + String(this.events.length + 1),
      issueId: input.issueId,
      eventType: input.eventType,
      fromState: input.fromState,
      toState: input.toState,
      actorId,
      actorName: null,
      note: input.note,
      createdAt: at,
    });
  }

  async findProject(projectId: string): Promise<{ id: string; status: string } | null> {
    return this.project !== null && this.project.id === projectId ? this.project : null;
  }
}

function makeReportService(
  db: FakeDatabase,
  reports: FakeReportRepository,
  issues: FakeIssueRepository,
  audit: FakeAuditService,
  group: FakeProjectGroupService = new FakeProjectGroupService(),
): ReportService {
  return new ReportService(
    db as unknown as DatabaseService,
    reports as unknown as ReportRepository,
    issues as unknown as IssueRepository,
    audit as unknown as AuditService,
    group as unknown as ProjectGroupService,
  );
}

function makeIssueService(db: FakeDatabase, issues: FakeIssueRepository, audit: FakeAuditService): IssueService {
  return new IssueService(db as unknown as DatabaseService, issues as unknown as IssueRepository, audit as unknown as AuditService);
}

/** 把附图替身的成对删除钩子接到假仓储上（保持「删日报 = 连派生问题」「删问题 = 连来源日报」语义一致）。 */
function wireLinks(reports: FakeReportRepository, issues: FakeIssueRepository): void {
  photoStore.hooks.issueIdsByReport = (reportId) =>
    [...issues.issues.values()].filter((row) => row.sourceReportId === reportId).map((row) => row.id);
  photoStore.hooks.onIssuesPurged = (issueIds) => {
    for (const id of issueIds) issues.issues.delete(id);
    issues.events = issues.events.filter((event) => !issueIds.includes(event.issueId));
  };
  photoStore.hooks.onReportPurged = (reportId) => {
    reports.reports.delete(reportId);
  };
}

beforeEach(() => {
  photoStore.reset();
});

/** 当天（Asia/Shanghai，与 service 同口径）：用真实 now 求值，避免用例随日期推移失真。 */
const NOW_DAY = shanghaiToday(new Date());

describe("日报（M6-01 / M6-02 · A3-01 ~ A3-09）", () => {
  function seed() {
    const db = new FakeDatabase();
    const reports = new FakeReportRepository();
    const issues = new FakeIssueRepository();
    const audit = new FakeAuditService();
    const group = new FakeProjectGroupService();
    wireLinks(reports, issues);
    return { db, reports, issues, audit, group, service: makeReportService(db, reports, issues, audit, group) };
  }

  it("提交当天日报：state=submitted；submittedAt 落库；审计 create + outbox report.submitted；无现场问题不生成问题", async () => {
    const { db, issues, audit, service } = seed();
    const created = await service.create(
      PROJECT,
      { date: NOW_DAY, state: "submitted", doneWork: "完成设备安装", headcount: 3 },
      ACTOR,
    );
    expect(created.state).toBe("submitted");
    expect(created.authorId).toBe(ACTOR);
    expect(created.submittedAt).not.toBeNull();
    expect(created.stageKeys).toEqual([]);
    expect(created.photos).toEqual([]);
    expect(created.issuePhotos).toEqual([]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "create", objectType: "daily_report", projectId: PROJECT });
    expect(db.outbox.map((row) => row.topic)).toEqual(["report.submitted"]);
    expect(issues.issues.size).toBe(0);
  });

  it("草稿写库（Push 215）：state=draft 落行；submittedAt 为空；不生成问题（A3-02）", async () => {
    const { reports, issues, service } = seed();
    const created = await service.create(PROJECT, { date: NOW_DAY, state: "draft", doneWork: "草稿内容" }, ACTOR);
    expect(created.state).toBe("draft");
    expect(created.submittedAt).toBeNull();
    expect([...reports.reports.values()].map((row) => row.state)).toEqual(["draft"]);
    expect(issues.issues.size).toBe(0);
  });

  it("同人同项目同日可多条（Push 215）：两次提交各落一行，无 409 判重", async () => {
    const { reports, service } = seed();
    const first = await service.create(PROJECT, { date: NOW_DAY, state: "submitted", doneWork: "上午完成" }, ACTOR);
    const second = await service.create(PROJECT, { date: NOW_DAY, state: "submitted", doneWork: "下午完成" }, ACTOR);
    expect(first.id).not.toBe(second.id);
    expect(reports.inserted.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("补填：对过去日期首次提交 = state=supplement（服务端推导，客户端不可指定，A3-02）", async () => {
    const { service } = seed();
    const created = await service.create(PROJECT, { date: PAST_DATE, state: "submitted", doneWork: "补填内容" }, ACTOR);
    expect(created.state).toBe("supplement");
    expect(created.date).toBe(PAST_DATE);
  });

  it("未来日期：400 VALIDATION_FAILED（A3-04 只允许当天或补填过去日期）", async () => {
    const { reports, service } = seed();
    await expect(
      service.create(PROJECT, { date: FUTURE_DATE, state: "submitted", doneWork: "未来" }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect(reports.inserted).toEqual([]);
  });

  it("现场发现问题：提交时自动生成问题（open + 多值归类 + 按归类自动分派 + created 事件 + 审计 + outbox）", async () => {
    const { db, issues, audit, service } = seed();
    await service.create(
      PROJECT,
      {
        date: PAST_DATE,
        state: "submitted",
        doneWork: "安装完成",
        foundIssue: "液压泵渗油",
        issueCategories: ["机械部", "供应商原因"],
        stageKeys: ["install", "install"],
      },
      ACTOR,
    );
    const generated = [...issues.issues.values()];
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      state: "open",
      categories: ["机械部", "供应商原因"],
      ownerDepartment: "机械部",
      sourceReportId: REPORT_1,
      reporterId: ACTOR,
      taskId: null,
      raisedAt: PAST_DATE,
    });
    expect(issues.events.map((event) => event.eventType)).toEqual(["created"]);
    expect(issues.events[0]).toMatchObject({ fromState: null, toState: "open" });
    expect(audit.entries.map((entry) => entry.objectType)).toEqual(["daily_report", "issue"]);
    expect(db.outbox.map((row) => row.topic)).toContain("issue.created");
  });

  it("A3-12 无匹配归类：不自动分派（ownerDepartment 为空）—— 原因类归「待分派」", async () => {
    const { issues, service } = seed();
    await service.create(
      PROJECT,
      { date: PAST_DATE, state: "submitted", doneWork: "观察中", foundIssue: "客户改期", issueCategories: ["客户原因"] },
      ACTOR,
    );
    const generated = [...issues.issues.values()];
    expect(generated[0]?.ownerDepartment).toBeNull();
    expect(generated[0]?.state).toBe("open");
  });

  it("A3-09 幂等：重编辑重复提交不重复生成问题（source_report_id 唯一兜底，事件不重复）", async () => {
    const { issues, service } = seed();
    const created = await service.create(
      PROJECT,
      { date: PAST_DATE, state: "submitted", doneWork: "安装完成", foundIssue: "液压泵渗油", issueCategories: ["机械部"] },
      ACTOR,
    );
    expect(issues.issues.size).toBe(1);
    await service.update(
      PROJECT,
      created.id,
      { version: created.version, state: "submitted", doneWork: "安装完成（补记）" },
      ACTOR,
    );
    expect(issues.issues.size).toBe(1);
    expect(issues.events).toHaveLength(1);
  });

  it("Push 243 内联问题清单：一次填报多条问题 → 提交逐条生成独立问题（各自归类 / 处理人 / 解决方案 / 附图）", async () => {
    const { db, issues, audit, service } = seed();
    photoStore.seedFile(FILE_A, "问题一.jpg", PROJECT);
    const created = await service.create(
      PROJECT,
      {
        date: PAST_DATE,
        state: "submitted",
        doneWork: "安装完成",
        issues: [
          { title: "液压泵渗油", categories: ["机械部"], ownerId: OTHER_ACTOR, solution: "更换密封圈", photoFileIds: [FILE_A] },
          { title: "清关单证缺失", categories: ["物流原因"] },
        ],
      },
      ACTOR,
    );
    const generated = [...issues.issues.values()];
    expect(generated).toHaveLength(2);
    expect(generated[0]).toMatchObject({
      sourceReportId: created.id,
      state: "open",
      categories: ["机械部"],
      ownerId: OTHER_ACTOR,
      ownerDepartment: "机械部",
      solution: "更换密封圈",
      raisedAt: PAST_DATE,
    });
    expect(generated[1]).toMatchObject({ categories: ["物流原因"], ownerId: null, ownerDepartment: null, solution: null });
    expect(issues.events).toHaveLength(2);
    expect(issues.events.every((event) => event.eventType === "created")).toBe(true);
    expect(db.outbox.filter((row) => row.topic === "issue.created")).toHaveLength(2);
    expect(audit.entries.map((entry) => entry.objectType)).toEqual(["daily_report", "issue", "issue"]);
    // 附图：新口径直接挂问题侧（不落日报侧 kind=issue）；日报侧 issuePhotos 为空
    const firstIssueId = generated[0]?.id ?? "";
    expect(photoStore.refs("issue", firstIssueId).map((ref) => ref.fileId)).toEqual([FILE_A]);
    expect(photoStore.refs("report", created.id, "issue")).toEqual([]);
  });

  it("Push 243 草稿携带清单：state=draft 落 issue_drafts 不生成问题；PATCH 提交后逐条生成", async () => {
    const { reports, issues, service } = seed();
    const created = await service.create(
      PROJECT,
      {
        date: PAST_DATE,
        state: "draft",
        doneWork: "草稿内容",
        issues: [
          { title: "问题甲", categories: ["采购部"] },
          { title: "问题乙", categories: ["生产原因"] },
        ],
      },
      ACTOR,
    );
    expect(issues.issues.size).toBe(0);
    expect(reports.reports.get(created.id)?.issueDrafts).toHaveLength(2);
    const submitted = await service.update(PROJECT, created.id, { version: created.version, state: "submitted" }, ACTOR);
    expect(submitted.state).toBe("supplement");
    expect(issues.issues.size).toBe(2);
  });

  it("Push 243 幂等：已生成后重编辑不重复生成（按 source_report_id 计数兜底）", async () => {
    const { issues, service } = seed();
    const created = await service.create(
      PROJECT,
      { date: PAST_DATE, state: "submitted", doneWork: "安装完成", issues: [{ title: "问题甲", categories: ["项目部"] }] },
      ACTOR,
    );
    expect(issues.issues.size).toBe(1);
    await service.update(PROJECT, created.id, { version: created.version, state: "submitted", doneWork: "安装完成（补记）" }, ACTOR);
    expect(issues.issues.size).toBe(1);
    expect(issues.events).toHaveLength(1);
  });

  it("Push 243 契约：issues 与旧单问题字段按内容互斥（null / 空数组不算冲突；更新体空数组 = 清空清单）", () => {
    const draft = { title: "问题甲", categories: ["机械部"] as const };
    expect(DailyReportCreateBodySchema.safeParse({ date: NOW_DAY, doneWork: "x", issues: [draft] }).success).toBe(true);
    expect(
      DailyReportCreateBodySchema.safeParse({
        date: NOW_DAY,
        doneWork: "x",
        foundIssue: "旧口径问题",
        issueCategories: ["机械部"],
        issues: [draft],
      }).success,
    ).toBe(false);
    expect(
      DailyReportUpdateBodySchema.safeParse({
        version: 1,
        issues: [],
        foundIssue: null,
        issueCategories: null,
        suggestion: null,
        issuePhotoFileIds: [],
      }).success,
    ).toBe(true);
    expect(DailyReportUpdateBodySchema.safeParse({ version: 1, issues: [draft], foundIssue: null, issueCategories: null }).success).toBe(true);
  });

  it("附图（方案一）：日报两张图都挂 file_links(report)（kind 区分）；提交生成问题时问题图转挂到问题侧", async () => {
    const { issues, service } = seed();
    photoStore.seedFile(FILE_A, "现场.jpg", PROJECT);
    photoStore.seedFile(FILE_B, "渗油.jpg", PROJECT);
    const created = await service.create(
      PROJECT,
      {
        date: PAST_DATE,
        state: "submitted",
        doneWork: "安装完成",
        foundIssue: "液压泵渗油",
        issueCategories: ["机械部"],
        photoFileIds: [FILE_A],
        issuePhotoFileIds: [FILE_B],
      },
      ACTOR,
    );
    const issueId = [...issues.issues.values()][0]?.id ?? "";
    expect(created.photos).toEqual([{ fileId: FILE_A, name: "现场.jpg" }]);
    expect(created.issuePhotos).toEqual([]);
    expect(photoStore.refs("report", created.id, "onsite")).toEqual([{ fileId: FILE_A, name: "现场.jpg" }]);
    expect(photoStore.refs("report", created.id, "issue")).toEqual([]);
    expect(photoStore.refs("issue", issueId)).toEqual([{ fileId: FILE_B, name: "渗油.jpg" }]);
  });

  it("附图校验：文件不属于本项目 / 不存在 = 400 VALIDATION_FAILED（不落行）", async () => {
    const { reports, service } = seed();
    photoStore.seedFile(FILE_A, "别家的.jpg", OTHER_PROJECT);
    await expect(
      service.create(PROJECT, { date: NOW_DAY, state: "submitted", doneWork: "带图", photoFileIds: [FILE_A] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect(reports.inserted).toEqual([]);
  });

  it("附图编辑（PATCH）：现场图整体替换；已生成问题时问题图改挂问题侧", async () => {
    const { issues, service } = seed();
    photoStore.seedFile(FILE_A, "问题.jpg", PROJECT);
    photoStore.seedFile(FILE_B, "问题-新.jpg", PROJECT);
    const created = await service.create(
      PROJECT,
      { date: PAST_DATE, state: "submitted", doneWork: "安装", foundIssue: "渗油", issueCategories: ["机械部"], issuePhotoFileIds: [FILE_A] },
      ACTOR,
    );
    const issueId = [...issues.issues.values()][0]?.id ?? "";
    expect(photoStore.refs("issue", issueId)).toEqual([{ fileId: FILE_A, name: "问题.jpg" }]);
    const updated = await service.update(PROJECT, created.id, { version: created.version, issuePhotoFileIds: [FILE_B] }, ACTOR);
    expect(updated.issuePhotos).toEqual([]);
    expect(photoStore.refs("report", created.id, "issue")).toEqual([]);
    expect(photoStore.refs("issue", issueId)).toEqual([{ fileId: FILE_B, name: "问题-新.jpg" }]);
  });

  it("草稿 → 提交（PATCH）：state 变 submitted 且 submittedAt 落库；审计 update 一条", async () => {
    const { audit, service } = seed();
    const created = await service.create(PROJECT, { date: NOW_DAY, state: "draft", doneWork: "草稿" }, ACTOR);
    const submitted = await service.update(PROJECT, created.id, { version: created.version, state: "submitted" }, ACTOR);
    expect(submitted.state).toBe("submitted");
    expect(submitted.submittedAt).not.toBeNull();
    expect(submitted.version).toBe(created.version + 1);
    expect(audit.entries.map((entry) => entry.action)).toEqual(["create", "update"]);
  });

  it("已提交行不允许退回草稿：400 VALIDATION_FAILED（A3-02）", async () => {
    const { reports, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    await expect(service.update(PROJECT, REPORT_1, { version: 1, state: "draft" }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("编辑时改出「现场发现问题」但未给归类：400 VALIDATION_FAILED（合并后校验，A3-04）", async () => {
    const { reports, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    await expect(service.update(PROJECT, REPORT_1, { version: 1, foundIssue: "新问题" }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("乐观锁：version 不匹配 409 VERSION_CONFLICT（不写审计）", async () => {
    const { reports, audit, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1, { version: 2 }));
    await expect(service.update(PROJECT, REPORT_1, { version: 1, doneWork: "改" }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(audit.entries).toEqual([]);
  });

  it("成对删除（DELETE）：删日报 = 连它派生的全部问题 + 两侧附图链；审计 delete + outbox report.deleted", async () => {
    const { db, reports, issues, audit, service } = seed();
    photoStore.seedFile(FILE_A, "现场.jpg", PROJECT);
    photoStore.seedFile(FILE_B, "渗油.jpg", PROJECT);
    const created = await service.create(
      PROJECT,
      {
        date: PAST_DATE,
        state: "submitted",
        doneWork: "安装",
        foundIssue: "渗油",
        issueCategories: ["机械部"],
        photoFileIds: [FILE_A],
        issuePhotoFileIds: [FILE_B],
      },
      ACTOR,
    );
    const issueId = [...issues.issues.values()][0]?.id ?? "";
    const removed = await service.remove(PROJECT, created.id, ACTOR);
    expect(removed).toEqual({ id: created.id, deleted: true, cascadedIssueIds: [issueId] });
    expect(issues.issues.size).toBe(0);
    expect(reports.reports.has(created.id)).toBe(false);
    expect(photoStore.links).toEqual([]);
    expect(audit.entries.filter((entry) => entry.action === "delete").map((entry) => entry.objectType)).toEqual([
      "issue",
      "daily_report",
    ]);
    expect(db.outbox.map((row) => row.topic)).toContain("report.deleted");
  });

  it("归档项目：写入口一律 409 PROJECT_ARCHIVED（ADR-027）", async () => {
    const { reports, issues, service } = seed();
    reports.project = { id: PROJECT, status: "archived" };
    issues.project = { id: PROJECT, status: "archived" };
    await expect(
      service.create(PROJECT, { date: NOW_DAY, state: "submitted", doneWork: "归档后" }, ACTOR),
    ).rejects.toMatchObject({ code: "PROJECT_ARCHIVED", httpStatus: 409 });
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    await expect(service.update(PROJECT, REPORT_1, { version: 1, doneWork: "改" }, ACTOR)).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      httpStatus: 409,
    });
    await expect(service.remove(PROJECT, REPORT_1, ACTOR)).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      httpStatus: 409,
    });
  });

  it("跨项目 / 不存在：日报详情统一 404 NOT_FOUND", async () => {
    const { reports, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    await expect(service.detail(PROJECT, "ffffffff-ffff-4fff-8fff-ffffffffffff")).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(service.detail(OTHER_PROJECT, REPORT_1)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(service.remove(PROJECT, "ffffffff-ffff-4fff-8fff-ffffffffffff", ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("同步项目群：非项目经理 403，不写审计 / outbox", async () => {
    const { db, reports, audit, group, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    group.bound = true;

    await expect(service.syncToProjectGroup(PROJECT, REPORT_1, ACTOR, false)).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
    expect(audit.entries).toEqual([]);
    expect(db.outbox).toEqual([]);
  });

  it("同步项目群：未绑定 409、草稿 400，均不写审计 / outbox", async () => {
    const { db, reports, audit, group, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));

    await expect(service.syncToProjectGroup(PROJECT, REPORT_1, ACTOR, true)).rejects.toMatchObject({
      code: "REPORT_GROUP_NOT_BOUND",
      httpStatus: 409,
    });

    group.bound = true;
    reports.reports.set(REPORT_1, makeReport(REPORT_1, { state: "draft", submittedAt: null }));
    await expect(service.syncToProjectGroup(PROJECT, REPORT_1, ACTOR, true)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(audit.entries).toEqual([]);
    expect(db.outbox).toEqual([]);
  });

  it("同步项目群：PM + 已提交 + 已绑定 → 202 受理；审计与 outbox 载荷 / 去重键按日报版本收口", async () => {
    const { db, reports, audit, group, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1, { reportDate: "2026-10-27", version: 7 }));
    group.bound = true;
    group.name = "总装项目交付群";

    await expect(service.syncToProjectGroup(PROJECT, REPORT_1, ACTOR, true)).resolves.toEqual({
      reportId: REPORT_1,
      version: 7,
      queued: true,
      message: "已提交同步",
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: "update",
      objectType: "daily_report",
      objectId: REPORT_1,
      projectId: PROJECT,
      metadata: { templateCode: "DAILY_REPORT_GROUP", reportVersion: 7, groupName: "总装项目交付群" },
    });
    expect(db.outbox).toEqual([
      {
        topic: "notify.group",
        dedupeKey: "report.group-sync:" + REPORT_1 + ":v7",
        status: "pending",
        payload: {
          projectId: PROJECT,
          title: null,
          body: "日报已就绪",
          refType: "report",
          refId: REPORT_1,
          templateCode: "DAILY_REPORT_GROUP",
        },
      },
    ]);
  });

  it("列表：日期区间与状态筛选 + 日期倒序；dateFrom > dateTo 400", async () => {
    const { reports, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1, { reportDate: "2026-03-02", state: "supplement" }));
    reports.reports.set(REPORT_2, makeReport(REPORT_2, { reportDate: "2026-03-05", state: "submitted" }));
    const listed = await service.list(PROJECT, { "filter[dateFrom]": "2026-03-01", "filter[dateTo]": "2026-03-03", page: 1, limit: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(REPORT_1);
    const all = await service.list(PROJECT, { page: 1, limit: 20 });
    expect(all.items.map((item) => item.id)).toEqual([REPORT_2, REPORT_1]);
    await expect(
      service.list(PROJECT, { "filter[dateFrom]": "2026-03-09", "filter[dateTo]": "2026-03-01", page: 1, limit: 20 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("日报状态筛选取值非法：400 VALIDATION_FAILED", async () => {
    const { service } = seed();
    await expect(service.list(PROJECT, { "filter[state]": "closed", page: 1, limit: 20 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });
});

describe("问题（M6-02 / M6-03 · A3-10 ~ A3-13 / A3-16）", () => {
  function seed() {
    const db = new FakeDatabase();
    const reports = new FakeReportRepository();
    const issues = new FakeIssueRepository();
    const audit = new FakeAuditService();
    wireLinks(reports, issues);
    issues.issues.set(ISSUE_1, makeIssue(ISSUE_1));
    return { db, reports, issues, audit, service: makeIssueService(db, issues, audit) };
  }

  it("状态流转：写一条 state_change 事件（from → to）+ 审计 update；note 随事件落库", async () => {
    const { issues, audit, service } = seed();
    const updated = await service.update(PROJECT, ISSUE_1, { version: 1, state: "in_progress", note: "已联系厂家" }, ACTOR);
    expect(updated.state).toBe("in_progress");
    expect(updated.version).toBe(2);
    expect(issues.events).toEqual([
      expect.objectContaining({ eventType: "state_change", fromState: "open", toState: "in_progress", note: "已联系厂家" }),
    ]);
    expect(audit.entries[0]).toMatchObject({ action: "update", objectType: "issue", objectId: ISSUE_1, projectId: PROJECT });
  });

  it("三态允许回退且留痕：done → open 清空 closed_at / closed_by；审计 action=complete 记在关闭那一次", async () => {
    const { issues, service, audit } = seed();
    const done = await service.update(PROJECT, ISSUE_1, { version: 1, state: "done", solution: "已更换密封件" }, ACTOR);
    expect(done.state).toBe("done");
    expect(done.closedAt).not.toBeNull();
    expect(done.closedBy).toBe(ACTOR);
    expect(issues.events.map((event) => event.eventType)).toEqual(["state_change", "solution"]);
    expect(audit.entries[0]?.action).toBe("complete");
    const reopened = await service.update(PROJECT, ISSUE_1, { version: done.version, state: "open", note: "复验未通过" }, ACTOR);
    expect(reopened.state).toBe("open");
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedBy).toBeNull();
    expect(issues.events).toHaveLength(3);
    expect(issues.events[2]).toMatchObject({ eventType: "state_change", fromState: "done", toState: "open" });
  });

  it("分派：ownerId / ownerDepartment 变化写 assignment 事件（A3-12 / A3-13）；处理时限 dueAt 已随批删除", async () => {
    const { issues, service } = seed();
    const assigned = await service.update(
      PROJECT,
      ISSUE_1,
      { version: 1, ownerId: OTHER_ACTOR, ownerDepartment: "采购部", note: "转采购部" },
      ACTOR,
    );
    expect(assigned.ownerId).toBe(OTHER_ACTOR);
    expect(assigned.ownerDepartment).toBe("采购部");
    expect("dueAt" in assigned).toBe(false);
    expect(issues.events.map((event) => event.eventType)).toEqual(["assignment"]);
  });

  it("描述与归类可改（PATCH 扩项）：title / categories 多值整体替换，走审计不写事件", async () => {
    const { issues, audit, service } = seed();
    const updated = await service.update(
      PROJECT,
      ISSUE_1,
      { version: 1, title: "液压泵渗油（复测）", categories: ["机械部", "供应商原因"] },
      ACTOR,
    );
    expect(updated.title).toBe("液压泵渗油（复测）");
    expect(updated.categories).toEqual(["机械部", "供应商原因"]);
    expect(issues.events).toEqual([]);
    expect(audit.entries[0]).toMatchObject({ action: "update", objectType: "issue" });
  });

  it("问题附图：整体替换（空数组 = 清空）；文件不属于本项目 = 400", async () => {
    const { service } = seed();
    photoStore.seedFile(FILE_A, "证据.jpg", PROJECT);
    const attached = await service.update(PROJECT, ISSUE_1, { version: 1, photoFileIds: [FILE_A] }, ACTOR);
    expect(attached.photos).toEqual([{ fileId: FILE_A, name: "证据.jpg" }]);
    const cleared = await service.update(PROJECT, ISSUE_1, { version: attached.version, photoFileIds: [] }, ACTOR);
    expect(cleared.photos).toEqual([]);
    photoStore.seedFile(FILE_B, "别家.jpg", OTHER_PROJECT);
    await expect(
      service.update(PROJECT, ISSUE_1, { version: cleared.version, photoFileIds: [FILE_B] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });

  it("空更新防护：可改字段全缺省 = 400 VALIDATION_FAILED（防刷留痕）", async () => {
    const { issues, audit, service } = seed();
    await expect(service.update(PROJECT, ISSUE_1, { version: 1 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(issues.events).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it("乐观锁：version 不匹配 409 VERSION_CONFLICT（不写事件）", async () => {
    const { issues, service } = seed();
    await expect(service.update(PROJECT, ISSUE_1, { version: 9, state: "done" }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(issues.events).toEqual([]);
  });

  it("归档项目：问题写入口 409 PROJECT_ARCHIVED", async () => {
    const { issues, service } = seed();
    issues.project = { id: PROJECT, status: "archived" };
    await expect(service.update(PROJECT, ISSUE_1, { version: 1, state: "done" }, ACTOR)).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      httpStatus: 409,
    });
  });

  it("跨项目 / 不存在：问题详情与更新统一 404 NOT_FOUND", async () => {
    const { service } = seed();
    await expect(service.detail(OTHER_PROJECT, ISSUE_1)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(
      service.update(PROJECT, "ffffffff-ffff-4fff-8fff-ffffffffffff", { version: 1, state: "done" }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("详情：问题本体 + 处理过程留痕按写入顺序返回（时间正序）", async () => {
    const { service } = seed();
    const first = await service.update(PROJECT, ISSUE_1, { version: 1, state: "in_progress" }, ACTOR);
    await service.update(PROJECT, ISSUE_1, { version: first.version, solution: "已修复", note: "复验通过" }, ACTOR);
    const detail = await service.detail(PROJECT, ISSUE_1);
    expect(detail.events.map((event) => event.eventType)).toEqual(["state_change", "solution"]);
    expect(detail.events[1]).toMatchObject({ actorId: ACTOR, note: "复验通过" });
  });

  it("列表：按项目返回（状态 / 归类筛选由仓储承担）；问题看板与问题追踪同源", async () => {
    const { service } = seed();
    const listed = await service.list(PROJECT, { page: 1, limit: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe(ISSUE_1);
    expect(listed.items[0]?.categories).toEqual(["机械部"]);
    await expect(service.list(PROJECT, { "filter[category]": "不存在的归类", page: 1, limit: 20 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("成对删除（DELETE）：删问题带来源日报 = 连它来源的日报及其全部问题；无来源日报 = 只删自己", async () => {
    const { db, reports, issues, audit, service } = seed();
    reports.reports.set(REPORT_1, makeReport(REPORT_1));
    issues.issues.set(ISSUE_2, makeIssue(ISSUE_2, { sourceReportId: REPORT_1 }));
    const removed = await service.remove(PROJECT, ISSUE_2, ACTOR);
    expect(removed).toEqual({ id: ISSUE_2, deleted: true, cascadedReportId: REPORT_1, cascadedIssueIds: [] });
    expect(reports.reports.has(REPORT_1)).toBe(false);
    expect(issues.issues.has(ISSUE_1)).toBe(true);
    expect(issues.issues.has(ISSUE_2)).toBe(false);
    expect(db.outbox.map((row) => row.topic)).toContain("issue.deleted");
    const single = await service.remove(PROJECT, ISSUE_1, ACTOR);
    expect(single).toEqual({ id: ISSUE_1, deleted: true, cascadedReportId: null, cascadedIssueIds: [] });
    expect(issues.issues.has(ISSUE_1)).toBe(false);
    expect(audit.entries.filter((entry) => entry.action === "delete")).toHaveLength(3);
  });
});
