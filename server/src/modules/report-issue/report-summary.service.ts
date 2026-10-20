import { Injectable } from "@nestjs/common";
import {
  CalendarDayViewSchema,
  DailyReportDayQuerySchema,
  DailyReportMissingResponseSchema,
  DailyReportSummaryResponseSchema,
  z,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { CalendarService } from "../calendar/index.js";
import { ProjectMemberService } from "../project/index.js";
import { NotifyDeliveryReadRepository } from "../notify/index.js";
import { shanghaiToday } from "../task/index.js";
import { ReportRepository, type DailyReportRow } from "./report.repository.js";
import { loadReportPhotos } from "./report-issue.links.js";
import { isFutureDate, type DailyReportState } from "./report-issue.rules.js";
import { toDailyReportView } from "./report.service.js";

type CalendarDayView = z.infer<typeof CalendarDayViewSchema>;
type DailyReportDayQuery = z.infer<typeof DailyReportDayQuerySchema>;
type DailyReportMissingResponse = z.infer<typeof DailyReportMissingResponseSchema>;
type DailyReportSummaryResponse = z.infer<typeof DailyReportSummaryResponseSchema>;

/** 已填口径（A7-01 / A7-05 共用）：draft 之外（submitted / supplement）一律算已提交；draft 仍计「应填未填」。 */
function isSubmittedState(state: string | null): boolean {
  return state !== null && state !== "draft";
}

/** 提交时刻升序、同刻按创建时间 / 作者 id 兜底（稳定序 —— 契约 entries 顺序口径，草稿 submittedAt 为空排最后）。 */
function bySubmittedAt(left: DailyReportRow, right: DailyReportRow): number {
  const leftAt = left.submittedAt === null ? 0 : left.submittedAt.getTime();
  const rightAt = right.submittedAt === null ? 0 : right.submittedAt.getTime();
  if (leftAt !== rightAt) return leftAt - rightAt;
  if (left.createdAt.getTime() !== right.createdAt.getTime()) return left.createdAt.getTime() - right.createdAt.getTime();
  return left.authorId < right.authorId ? -1 : left.authorId > right.authorId ? 1 : 0;
}

/** 现场发现问题非空（空白串不算 —— 与 A3-09 生成口径同源）。 */
function hasFoundIssue(row: DailyReportRow): boolean {
  return row.foundIssue !== null && row.foundIssue.trim().length > 0;
}

/**
 * 日报当日视图用例（M6-01 收口 · A7-01 汇总 / A7-05 应填未填）。
 * 口径：名册是「应填范围」；工作日 × 全员 − 当日已提交 = 应填未填（草稿未提交仍算未填）；非工作日整列为空（不催报，D5-03 共用手柄）。
 * 未来日期 400（与 A3-04 填报口径一致）；缺省日期 = 今天（Asia/Shanghai）。汇总只算已提交条目，未填人数按 0 计。
 * 数据面：前端日报中心（A7-01 汇总区 / A7-05 漏填名单）、A01 提醒与 A02 每日 19:00 群推送共用同一读出口。
 */
@Injectable()
export class ReportSummaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reports: ReportRepository,
    private readonly calendar: CalendarService,
    private readonly members: ProjectMemberService,
    private readonly deliveryReads: NotifyDeliveryReadRepository,
  ) {}

  /** GET /api/v1/projects/{id}/reports/summary（A7-01）：当日已提交条目聚合 + 工作日信息。 */
  async summary(projectId: string, query: DailyReportDayQuery): Promise<DailyReportSummaryResponse> {
    const day = await this.resolveDay(query.date);
    const rows = await this.reports.listByDate(projectId, day.date);
    const entries = rows.filter((row) => isSubmittedState(row.state)).sort(bySubmittedAt);
    const photos = await loadReportPhotos(entries.map((row) => row.id), this.database.db);
    return {
      date: day.date,
      isWorkday: day.isWorkday,
      dayKind: day.kind,
      dayName: day.name,
      entryCount: entries.length,
      draftCount: rows.length - entries.length,
      headcountTotal: entries.reduce((sum, row) => sum + (row.headcount ?? 0), 0),
      issueCount: entries.filter(hasFoundIssue).length,
      entries: entries.map((row) => toDailyReportView(row, photos.get(row.id) ?? { onsite: [], issue: [] })),
    };
  }

  /** GET /api/v1/projects/{id}/reports/missing（A7-05）：项目名册 × 工作日历 × 当日未提交。 */
  async missing(projectId: string, query: DailyReportDayQuery): Promise<DailyReportMissingResponse> {
    const day = await this.resolveDay(query.date);
    const rows = await this.reports.listByDate(projectId, day.date);
    const roster = await this.members.listMembers(projectId);
    // A01 已提醒标记（M5-06-3）：只回读发送归档，不写日报主体；仅 sent 算已提醒。
    const reminderSentAt = await this.deliveryReads.findReminderSentAt(
      "A01",
      day.date,
      roster.items.map((member) => member.userId),
    );
    // 同日多条（Push 215）：有已提交取已提交（首条），否则取任一条草稿；缺省 = 未填报。
    const byAuthor = new Map<string, DailyReportRow>();
    for (const row of rows) {
      const existing = byAuthor.get(row.authorId);
      if (existing === undefined) {
        byAuthor.set(row.authorId, row);
      } else if (!isSubmittedState(existing.state) && isSubmittedState(row.state)) {
        byAuthor.set(row.authorId, row);
      }
    }
    const members = roster.items.map((member) => {
      const row = byAuthor.get(member.userId);
      return {
        userId: member.userId,
        username: member.username,
        displayName: member.displayName,
        roleInProject: member.roleInProject,
        reportId: row === undefined ? null : row.id,
        state: row === undefined ? null : (row.state as DailyReportState),
        submittedAt: row === undefined || row.submittedAt === null ? null : row.submittedAt.toISOString(),
        reminderSentAt: reminderSentAt.get(member.userId)?.toISOString() ?? null,
      };
    });
    const submittedCount = members.filter((member) => isSubmittedState(member.state)).length;
    const draftCount = members.filter((member) => member.state === "draft").length;
    const missingUserIds = day.isWorkday
      ? members.filter((member) => !isSubmittedState(member.state)).map((member) => member.userId)
      : [];
    return {
      date: day.date,
      isWorkday: day.isWorkday,
      dayKind: day.kind,
      dayName: day.name,
      memberCount: members.length,
      submittedCount,
      draftCount,
      missingCount: day.isWorkday ? members.length - submittedCount : 0,
      members,
      missingUserIds,
    };
  }

  /** 当日口径：date 缺省 = 今天（Asia/Shanghai）；未来日期 400（A3-04 同口径）；工作日判定走日历横切出口（D5-03）。 */
  private async resolveDay(date: string | undefined): Promise<CalendarDayView> {
    const today = shanghaiToday(new Date());
    const target = date ?? today;
    if (isFutureDate(target, today)) {
      throw new AppError("VALIDATION_FAILED", "不能查询未来日期的日报视图（A3-04 同口径）", [
        { code: "future_date", message: "业务日期不得晚于今天（" + today + "）", path: "date" },
      ]);
    }
    return this.calendar.getDay(target);
  }
}
