/**
 * M6-01 收口回归（A7-01 当日汇总 / A7-05 应填未填）：名册 = 应填范围；草稿未提交仍计未填；
 * 非工作日整列为空（不催报）；缺省日期 = 今天（Asia/Shanghai）；未来日期 400；汇总只算已提交条目、未填人数按 0 计。
 * 真机口径见 server/README.md「M6-01 收口」与 server/src/modules/report-issue/README.md。
 */
import { describe, expect, it, vi } from "vitest";
import { STAGE_NAMES } from "@libiaolink/contracts";
import { photoStore } from "./fakes/report-issue-links.fake.js";
import type { CalendarService } from "../src/modules/calendar/index.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { ProjectMemberListResult, ProjectMemberService, ProjectMemberView } from "../src/modules/project/index.js";
import type { DailyReportRow, ReportRepository } from "../src/modules/report-issue/report.repository.js";
import { ReportSummaryService } from "../src/modules/report-issue/report-summary.service.js";
import { shanghaiToday } from "../src/modules/task/task.rules.js";

vi.mock("../src/modules/report-issue/report-issue.links.js", async () => {
  const { createReportIssueLinksFake } = await import("./fakes/report-issue-links.fake.js");
  return createReportIssueLinksFake();
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const ALICE = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const BOB = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const CAROL = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const DAVE = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const FILE_A = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const PAST_DATE = "2026-01-05";
const FUTURE_DATE = "2099-01-01";
const AT_EARLY = new Date("2026-09-22T01:00:00Z");
const AT_LATE = new Date("2026-09-22T09:30:00Z");

interface CalendarDayStub {
  date: string;
  kind: string;
  isWorkday: boolean;
  name: string | null;
  note: string | null;
  source: string;
}

class FakeReportRepository {
  rows: DailyReportRow[] = [];

  async listByDate(projectId: string, reportDate: string): Promise<DailyReportRow[]> {
    return this.rows.filter((row) => row.projectId === projectId && row.reportDate === reportDate);
  }
}

/** 日历替身：记录被问的日期；未登记的日期按默认工作日返回（不连库）。 */
class FakeCalendarService {
  days = new Map<string, CalendarDayStub>();
  asked: string[] = [];

  async getDay(date?: string): Promise<CalendarDayStub> {
    const target = date ?? "(缺省)";
    this.asked.push(target);
    return (
      this.days.get(target) ?? { date: target, kind: "workday", isWorkday: true, name: null, note: null, source: "default" }
    );
  }
}

class FakeProjectMemberService {
  items: ProjectMemberView[] = [];

  async listMembers(): Promise<ProjectMemberListResult> {
    return { items: this.items, total: this.items.length };
  }
}

/** A01 发送归档替身（M5-06-3）：按规则 + 业务日 + 收件人回读成功时刻。 */
class FakeDeliveryReads {
  sentAt = new Map<string, Date>();
  calls: Array<{ ruleCode: string; businessDate: string; recipientIds: string[] }> = [];

  async findReminderSentAt(ruleCode: string, businessDate: string, recipientIds: readonly string[]): Promise<Map<string, Date>> {
    this.calls.push({ ruleCode, businessDate, recipientIds: [...recipientIds] });
    const result = new Map<string, Date>();
    for (const recipientId of recipientIds) {
      const sentAt = this.sentAt.get(recipientId);
      if (sentAt !== undefined) result.set(recipientId, sentAt);
    }
    return result;
  }
}

function makeMember(userId: string, overrides: Partial<ProjectMemberView> = {}): ProjectMemberView {
  return {
    userId,
    username: "工号-" + userId.slice(0, 4),
    displayName: "成员-" + userId.slice(0, 4),
    roleInProject: "project_member",
    joinedAt: AT_EARLY.toISOString(),
    ...overrides,
  };
}

function makeReport(id: string, overrides: Partial<DailyReportRow> = {}): DailyReportRow {
  return {
    id,
    projectId: PROJECT,
    authorId: ALICE,
    authorName: "成员-a1a1",
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
    submittedAt: AT_EARLY,
    createdAt: AT_EARLY,
    updatedAt: AT_EARLY,
    version: 1,
    ...overrides,
  };
}

function makeService(
  reports: FakeReportRepository,
  calendar: FakeCalendarService,
  members: FakeProjectMemberService,
  deliveryReads: FakeDeliveryReads = new FakeDeliveryReads(),
): ReportSummaryService {
  return new ReportSummaryService(
    {} as unknown as DatabaseService,
    reports as unknown as ReportRepository,
    calendar as unknown as CalendarService,
    members as unknown as ProjectMemberService,
    deliveryReads as unknown as ConstructorParameters<typeof ReportSummaryService>[4],
  );
}

const TODAY = shanghaiToday(new Date());

describe("当日汇总（M6-01 收口 · A7-01）", () => {
  it("只算已提交（submitted / supplement）：草稿只计数、不进正文也不计入人数", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r1", { authorId: ALICE, headcount: 3 }),
      makeReport("r2", { authorId: BOB, state: "supplement", headcount: 2 }),
      makeReport("r3", { authorId: CAROL, state: "draft", headcount: 9, submittedAt: null }),
    ];
    const result = await makeService(reports, new FakeCalendarService(), new FakeProjectMemberService()).summary(PROJECT, { date: PAST_DATE });
    expect(result.entryCount).toBe(2);
    expect(result.draftCount).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual(["r1", "r2"]);
    expect(result.headcountTotal).toBe(5);
  });

  it("人数合计：未填 headcount 按 0 计；「现场发现问题」非空才计 issueCount（空白串不算）", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r1", { headcount: null, foundIssue: "支架尺寸偏差" }),
      makeReport("r2", { authorId: BOB, headcount: 4, foundIssue: "   " }),
      makeReport("r3", { authorId: CAROL, headcount: 2, foundIssue: null }),
    ];
    const result = await makeService(reports, new FakeCalendarService(), new FakeProjectMemberService()).summary(PROJECT, { date: PAST_DATE });
    expect(result.headcountTotal).toBe(6);
    expect(result.issueCount).toBe(1);
  });

  it("entries 提交时刻升序；同刻按作者 id 兜底（稳定序）", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r-late", { authorId: CAROL, submittedAt: AT_LATE }),
      makeReport("r-early-b", { authorId: BOB, submittedAt: AT_EARLY }),
      makeReport("r-early-a", { authorId: ALICE, submittedAt: AT_EARLY }),
    ];
    const result = await makeService(reports, new FakeCalendarService(), new FakeProjectMemberService()).summary(PROJECT, { date: PAST_DATE });
    expect(result.entries.map((entry) => entry.id)).toEqual(["r-early-a", "r-early-b", "r-late"]);
  });

  it("entries 为契约形态：阶段 stageKeys / stageNames 同下标（查字典）；附图随行下发（Push 215）", async () => {
    const reports = new FakeReportRepository();
    photoStore.seedFile(FILE_A, "现场.jpg", PROJECT);
    photoStore.links.push({ fileId: FILE_A, objectType: "report", objectId: "r1", kind: "onsite" });
    reports.rows = [makeReport("r1", { stageKeys: ["install"], issueCategories: ["机械部"] })];
    const result = await makeService(reports, new FakeCalendarService(), new FakeProjectMemberService()).summary(PROJECT, { date: PAST_DATE });
    expect(result.entries[0]?.stageKeys).toEqual(["install"]);
    expect(result.entries[0]?.stageNames).toEqual([STAGE_NAMES.install]);
    expect(result.entries[0]?.issueCategories).toEqual(["机械部"]);
    expect(result.entries[0]?.photos).toEqual([{ fileId: FILE_A, name: "现场.jpg" }]);
    expect(result.entries[0]?.state).toBe("submitted");
    expect(result.entries[0]?.submittedAt).toBe(AT_EARLY.toISOString());
  });

  it("缺省日期 = 今天（Asia/Shanghai）；工作日信息随行下发（date / isWorkday / dayKind / dayName）", async () => {
    const reports = new FakeReportRepository();
    const calendar = new FakeCalendarService();
    calendar.days.set(TODAY, { date: TODAY, kind: "makeup_workday", isWorkday: true, name: "调休上班", note: null, source: "calendar" });
    const result = await makeService(reports, calendar, new FakeProjectMemberService()).summary(PROJECT, {});
    expect(calendar.asked).toEqual([TODAY]);
    expect(result.date).toBe(TODAY);
    expect(result.isWorkday).toBe(true);
    expect(result.dayKind).toBe("makeup_workday");
    expect(result.dayName).toBe("调休上班");
  });

  it("只取当日：其它日期与他项目的行不进汇总", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r1"),
      makeReport("r2", { reportDate: "2026-01-04" }),
      makeReport("r3", { projectId: OTHER_PROJECT }),
    ];
    const result = await makeService(reports, new FakeCalendarService(), new FakeProjectMemberService()).summary(PROJECT, { date: PAST_DATE });
    expect(result.entryCount).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("未来日期 400 VALIDATION_FAILED（与 A3-04 同口径，path=date），不读库", async () => {
    const reports = new FakeReportRepository();
    const calendar = new FakeCalendarService();
    const rejected = await makeService(reports, calendar, new FakeProjectMemberService())
      .summary(PROJECT, { date: FUTURE_DATE })
      .catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect((rejected as { details: { path?: string }[] }).details[0]?.path).toBe("date");
    expect(calendar.asked).toEqual([]);
  });
});

describe("应填未填清单（M6-01 收口 · A7-05）", () => {
  it("工作日：已提交 / 补填不算未填；草稿未提交仍计未填（名册 = 应填范围）", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r1", { authorId: ALICE }),
      makeReport("r2", { authorId: BOB, state: "draft", submittedAt: null }),
    ];
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE), makeMember(BOB), makeMember(CAROL, { roleInProject: "project_manager" })];
    const result = await makeService(reports, new FakeCalendarService(), members).missing(PROJECT, { date: PAST_DATE });
    expect(result.memberCount).toBe(3);
    expect(result.submittedCount).toBe(1);
    expect(result.draftCount).toBe(1);
    expect(result.missingCount).toBe(2);
    expect(result.missingUserIds).toEqual([BOB, CAROL]);
  });

  it("名单逐行携带状态：已提交带 reportId / submittedAt；草稿与从未填报为 null", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [
      makeReport("r1", { authorId: ALICE }),
      makeReport("r2", { authorId: BOB, state: "draft", submittedAt: null }),
    ];
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE), makeMember(BOB), makeMember(CAROL)];
    const result = await makeService(reports, new FakeCalendarService(), members).missing(PROJECT, { date: PAST_DATE });
    expect(result.members[0]).toMatchObject({ reportId: "r1", state: "submitted", submittedAt: AT_EARLY.toISOString() });
    expect(result.members[1]).toMatchObject({ reportId: "r2", state: "draft", submittedAt: null });
    expect(result.members[2]).toMatchObject({ reportId: null, state: null, submittedAt: null });
  });

  it("已提醒标记：按 A01 + 业务日 + 名册回读 sent 时刻；未提醒为 null（M5-06-3）", async () => {
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE), makeMember(BOB), makeMember(CAROL)];
    const deliveryReads = new FakeDeliveryReads();
    deliveryReads.sentAt.set(ALICE, new Date("2026-01-05T11:30:00Z"));
    const result = await makeService(new FakeReportRepository(), new FakeCalendarService(), members, deliveryReads).missing(PROJECT, {
      date: PAST_DATE,
    });
    expect(deliveryReads.calls).toEqual([
      { ruleCode: "A01", businessDate: PAST_DATE, recipientIds: [ALICE, BOB, CAROL] },
    ]);
    expect(result.members[0]?.reminderSentAt).toBe("2026-01-05T11:30:00.000Z");
    expect(result.members[1]?.reminderSentAt).toBeNull();
    expect(result.members[2]?.reminderSentAt).toBeNull();
  });

  it("missingUserIds 顺序同名册（项目经理在前，由名册出口保证）", async () => {
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE), makeMember(BOB), makeMember(CAROL)];
    const result = await makeService(new FakeReportRepository(), new FakeCalendarService(), members).missing(PROJECT, {});
    expect(result.missingUserIds).toEqual([ALICE, BOB, CAROL]);
    expect(result.missingCount).toBe(3);
  });

  it("非工作日整列为空：missingCount=0 / missingUserIds=[]，但名册仍全列且日历信息原样下发", async () => {
    const reports = new FakeReportRepository();
    const calendar = new FakeCalendarService();
    calendar.days.set(PAST_DATE, { date: PAST_DATE, kind: "holiday", isWorkday: false, name: "国庆节", note: null, source: "calendar" });
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE), makeMember(BOB)];
    const result = await makeService(reports, calendar, members).missing(PROJECT, { date: PAST_DATE });
    expect(result.isWorkday).toBe(false);
    expect(result.dayKind).toBe("holiday");
    expect(result.dayName).toBe("国庆节");
    expect(result.missingCount).toBe(0);
    expect(result.missingUserIds).toEqual([]);
    expect(result.members).toHaveLength(2);
    expect(result.submittedCount).toBe(0);
  });

  it("名册为空：memberCount=0 / missingCount=0（不因无成员报错）", async () => {
    const result = await makeService(new FakeReportRepository(), new FakeCalendarService(), new FakeProjectMemberService()).missing(PROJECT, { date: PAST_DATE });
    expect(result.memberCount).toBe(0);
    expect(result.submittedCount).toBe(0);
    expect(result.draftCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.members).toEqual([]);
    expect(result.missingUserIds).toEqual([]);
  });

  it("名册外的人提交不扩大应填范围（他项目 / 已移出成员的行不进当日汇总）", async () => {
    const reports = new FakeReportRepository();
    reports.rows = [makeReport("r1", { authorId: DAVE })];
    const members = new FakeProjectMemberService();
    members.items = [makeMember(ALICE)];
    const service = makeService(reports, new FakeCalendarService(), members);
    const missing = await service.missing(PROJECT, { date: PAST_DATE });
    expect(missing.memberCount).toBe(1);
    expect(missing.submittedCount).toBe(0);
    expect(missing.missingUserIds).toEqual([ALICE]);
    const summary = await service.summary(PROJECT, { date: PAST_DATE });
    expect(summary.entryCount).toBe(1);
  });

  it("未来日期 400 VALIDATION_FAILED（读接口同口径）", async () => {
    const rejected = await makeService(new FakeReportRepository(), new FakeCalendarService(), new FakeProjectMemberService())
      .missing(PROJECT, { date: FUTURE_DATE })
      .catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
  });
});
