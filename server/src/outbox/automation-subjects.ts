/**
 * automation 规则接线（S7-4 · M5-02 接线段）主体读取层：领域快照（只读）→ 回放主体（ReplaySubject）。
 *
 * 口径来源：docs/rules/A01-A03-A14-扩展规则文案.md「回放主体字段口径」表（字段 / 收件人唯一口径）+
 *   docs/rules/R01-R07-内置规则文案.md（任务类条件与模板变量）；映射器（toTaskSubject /
 *   toReportMemberSubject）在 automation 模块内（wmj 线）—— 本层只负责读库与快照组装，不算「应发给谁」。
 *
 * 读面（全部只读；接线层不写业务表）：
 *   - 任务类（R02 ~ R07）：tasks + projects（经理 / 完成度）+ users（姓名）+ files（件数）+ wecom_groups（群绑定）；
 *   - 日报名册槽位（A01）：projects（在办）× project_members（名册）× daily_reports（当日提交）× 工作日历；
 *   - 项目日报（A02 · 接线段 Push 224）：daily_reports（按项目 × 业务日聚合）+ projects + users（作者姓名）+ wecom_groups。
 *
 * 口径与差异（README / PR 同步登记）：
 *   - actual_start：无库列 → 恒 null（R04 的「尚未实际开始」条件据此恒真，待实际开始字段落地后收口）；
 *   - project.group：读 `wecom_groups`（enabled = 启用态）—— 一期寻址键 = projectId（一项目一群：投递层按项目 id 解析
 *     chatid 绑定，换绑后未投递消息仍可送出）；未绑定 / 已停用 → null（引擎按 recipient_missing 收口：不产出不误发）；
 *   - project.progress：读时派生完成率（项目内未删任务 status=done 占比，四舍五入取整；无任务 = 0）—— 供 R06；
 *   - task.urgency：直接透传 tasks.priority（三档「高 / 中 / 低」）；R07 条件已按三档定案（高 + 中命中 · wmj · Push 171）；
 *   - task.file_count：与任务详情「文件摘要」同口径（draft / final / changed / archived，排除回收站）；
 *   - A02（project_day）已产主体（接线段 Push 224）：项目 × 业务日聚合（entryCount / headcountTotal / issueCount /
 *     summaryText —— 与 reports/summary 数据面同口径：draft 之外一律算已提交；条目按提交时刻升序，逐条「作者：当日完成工作」换行拼接）；
 *     A14（todos 表未落）本层仍不产主体 —— 登记差异，随待办表落地补。
 *
 * 边界：窗口主体池排除软删项目 / 任务与归档项目（归档 = 冻结，不再提醒）；事件形态按事件载荷的实体 id 直读
 * （含软删行 —— 事件发生在删除前，快照仍可求值），行不存在 → null（消费侧按确定性失败收口）。
 */
import { Injectable } from "@nestjs/common";
import type { RuleEventTopic } from "@libiaolink/contracts";
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DbClient } from "../db/db-client.js";
import { DatabaseService } from "../db/database.service.js";
import { files } from "../db/schema/files.js";
import { users } from "../db/schema/identity.js";
import { wecomGroups } from "../db/schema/notify.js";
import { projectMembers, projects } from "../db/schema/projects.js";
import { dailyReports } from "../db/schema/reports.js";
import { tasks } from "../db/schema/tasks.js";
import {
  toProjectDaySubject,
  toReportMemberSubject,
  toTaskSubject,
  type ReplaySubject,
  type ReplayTask,
} from "../modules/automation/index.js";
import {
  addDays,
  CalendarService,
  calendarWindow,
  resolveDay,
  type CalendarException,
  type CalendarWindow,
} from "../modules/calendar/index.js";
import { deriveDisplayStatus, shanghaiToday } from "../modules/task/index.js";

/** 文件摘要口径（与 task.repository 的 FILE_STATUS_FOR_SUMMARY 同口径）：排除回收站（recycled）。 */
const FILE_STATUS_FOR_SUMMARY = ["draft", "final", "changed", "archived"] as const;
/** 工作日历求值余量（天）：T+3 最大基准偏移 + 连续假期顺延余量 —— 窗口两侧各扩这么多，窗口内求值不越界。 */
const CALENDAR_SPAN_DAYS = 17;
/** Asia/Shanghai 固定偏移（ADR-028：无夏令时，偏移恒为 +8）。 */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 上海业务日（YYYY-MM-DD）。 */
function businessDateOf(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 事件载荷取字符串字段（缺 / 空 = null）。 */
function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 闭区间业务日列表（YYYY-MM-DD，按 UTC 日算术 —— 与 calendar 的 addDays 同口径）。 */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** A02 聚合输入行（daily_reports 读面列；state = draft 之外一律算已提交）。 */
export interface ReportDayRow {
  projectId: string;
  authorId: string;
  reportDate: string;
  state: string;
  headcount: number | null;
  doneWork: string;
  foundIssue: string | null;
  submittedAt: Date | null;
  createdAt: Date;
}

/**
 * A02 聚合（纯函数 · 可单测）：已提交日报行 → entryCount / headcountTotal / issueCount / summaryText。
 * headcountTotal = 已提交条目 headcount 求和；issueCount = 现场发现问题非空条目数；
 * summaryText = 逐条「作者名：当日完成工作」换行拼接（条目顺序 = 调用方排序后的提交时刻升序）。
 */
export function summarizeProjectDay(
  rows: readonly ReportDayRow[],
  nameOf: (userId: string) => string,
): { entryCount: number; headcountTotal: number; issueCount: number; summaryText: string } {
  return {
    entryCount: rows.length,
    headcountTotal: rows.reduce((sum, row) => sum + (row.headcount ?? 0), 0),
    issueCount: rows.filter((row) => row.foundIssue !== null && row.foundIssue.trim() !== "").length,
    summaryText: rows.map((row) => nameOf(row.authorId) + "：" + row.doneWork).join("\n"),
  };
}
/** 日报提交序（与 reports/summary 同口径：submittedAt 升序、同刻按创建时间 / 作者 id 兜底；空提交时刻排最后）。 */
function byReportSubmittedAt(
  left: { submittedAt: Date | null; createdAt: Date; authorId: string },
  right: { submittedAt: Date | null; createdAt: Date; authorId: string },
): number {
  const leftAt = left.submittedAt === null ? 0 : left.submittedAt.getTime();
  const rightAt = right.submittedAt === null ? 0 : right.submittedAt.getTime();
  if (leftAt !== rightAt) return leftAt - rightAt;
  if (left.createdAt.getTime() !== right.createdAt.getTime()) return left.createdAt.getTime() - right.createdAt.getTime();
  return left.authorId < right.authorId ? -1 : left.authorId > right.authorId ? 1 : 0;
}

/** 调度 handler 一次取齐的窗口素材：主体池 + 覆盖窗口的工作日历（planWindowMessages 直接消费）。 */
export interface WindowSubjectBundle {
  subjects: ReplaySubject[];
  calendar: CalendarWindow;
}
/** tasks 行（任务主体所需列）。 */
interface TaskSubjectRow {
  id: string;
  title: string;
  version: number;
  status: string;
  statusOverride: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  ownerIds: string[];
  priority: string | null;
  deliverableTypes: string[];
  onTime: boolean | null;
  projectId: string;
}

/** tasks 主体列（与 TaskSubjectRow 同口径）。 */
const TASK_SUBJECT_COLUMNS = {
  id: tasks.id,
  title: tasks.title,
  version: tasks.version,
  status: tasks.status,
  statusOverride: tasks.statusOverride,
  plannedStart: tasks.plannedStart,
  plannedEnd: tasks.plannedEnd,
  actualEnd: tasks.actualEnd,
  ownerIds: tasks.ownerIds,
  priority: tasks.priority,
  deliverableTypes: tasks.deliverableTypes,
  onTime: tasks.onTime,
  projectId: tasks.projectId,
} as const;

@Injectable()
export class AutomationSubjectReader {
  constructor(
    private readonly database: DatabaseService,
    private readonly calendar: CalendarService,
  ) {}

  /**
   * 事件主体：task.* → 任务主体（payload.taskId）。
   * 其余规则主题（change.applied / node.completed / report.submitted / issue.updated —— issue 事件无订阅规则）
   * 暂无事件型规则与主体映射 → null
   * （消费侧对「无规则订阅」直接消费完成；新增订阅时在此补映射）。
   */
  async eventSubject(
    topic: RuleEventTopic,
    payload: Record<string, unknown>,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<ReplaySubject | null> {
    if (topic.startsWith("task.")) {
      const taskId = stringField(payload, "taskId");
      if (taskId === null) return null;
      const rows = await client.select(TASK_SUBJECT_COLUMNS).from(tasks).where(eq(tasks.id, taskId)).limit(1);
      const subjects = await this.buildTaskSubjects(rows, at, client, stringField(payload, "actorId"));
      return subjects.get(taskId) ?? null;
    }
    return null;
  }

  /**
   * 窗口主体包（调度形态）：任务池 + 窗口内每个业务日的日报名册槽位 + 工作日历窗口。
   * 说明：planWindowMessages 逐业务日求值，槽位需覆盖窗口内每个业务日（A01 的 report.date 基准）；
   *   任务主体为「当前快照」，触发日由基准字段折算出窗口命中（fireAtWithin 过滤）。
   */
  async loadWindow(
    window: { from: Date; to: Date },
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WindowSubjectBundle> {
    const firstDate = businessDateOf(window.from);
    const lastDate = businessDateOf(window.to);
    const calendar = await this.calendarWindowFor(firstDate, lastDate, client);
    const dates = datesBetween(firstDate, lastDate);
    const subjects: ReplaySubject[] = [
      ...(await this.allTaskSubjects(at, client)),
      ...(await this.reportSlotSubjects(dates, calendar, client)),
      ...(await this.projectDaySubjects(dates, client)),
    ];
    return { subjects, calendar };
  }

  /** 任务主体池（窗口形态）：在办项目的未删任务（软删任务 / 软删项目 / 归档项目不提醒）。 */
  private async allTaskSubjects(at: Date, client: DbClient): Promise<ReplaySubject[]> {
    const projectRows = await client
      .select({ id: projects.id })
      .from(projects)
      .where(and(isNull(projects.deletedAt), ne(projects.status, "archived")));
    if (projectRows.length === 0) return [];
    const rows = await client
      .select(TASK_SUBJECT_COLUMNS)
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), inArray(tasks.projectId, projectRows.map((row) => row.id))));
    return [...(await this.buildTaskSubjects(rows, at, client)).values()];
  }

  /** 日报名册槽位池（A01）：在办项目（未软删 / 未归档）× 名册 × 窗口内每个业务日。 */
  private async reportSlotSubjects(
    dates: readonly string[],
    calendar: CalendarWindow,
    client: DbClient,
  ): Promise<ReplaySubject[]> {
    const subjects: ReplaySubject[] = [];
    if (dates.length === 0) return subjects;
    const projectRows = await client
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(isNull(projects.deletedAt), ne(projects.status, "archived")));
    if (projectRows.length === 0) return subjects;
    const projectIds = projectRows.map((row) => row.id);
    const nameByProject = new Map(projectRows.map((row) => [row.id, row.name]));
    const memberRows = await client
      .select({ projectId: projectMembers.projectId, userId: projectMembers.userId, displayName: users.displayName })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inArray(projectMembers.projectId, projectIds));
    const reportRows = await client
      .select({
        projectId: dailyReports.projectId,
        authorId: dailyReports.authorId,
        state: dailyReports.state,
        reportDate: dailyReports.reportDate,
      })
      .from(dailyReports)
      .where(and(inArray(dailyReports.projectId, projectIds), inArray(dailyReports.reportDate, [...dates])));
    // 已填口径与日报读面同源（report-summary.service）：draft 之外（submitted / supplement）一律算已提交。
    const submitted = new Set(
      reportRows
        .filter((row) => row.state !== "draft")
        .map((row) => row.projectId + "|" + row.authorId + "|" + row.reportDate),
    );
    for (const date of dates) {
      const isWorkday = resolveDay(date, calendar)?.isWorkday ?? false;
      for (const member of memberRows) {
        subjects.push(
          toReportMemberSubject({
            slotId: member.projectId + "|" + member.userId,
            date,
            isWorkday,
            submitted: submitted.has(member.projectId + "|" + member.userId + "|" + date),
            userId: member.userId,
            userName: member.displayName,
            projectId: member.projectId,
            projectName: nameByProject.get(member.projectId) ?? "",
          }),
        );
      }
    }
    return subjects;
  }

  /** 任务快照 → 主体（批量：projects / users / files / 进度各一条查询，无逐行 N+1）。 */
  private async buildTaskSubjects(
    rows: readonly TaskSubjectRow[],
    at: Date,
    client: DbClient,
    actorId: string | null = null,
  ): Promise<Map<string, ReplaySubject>> {
    const result = new Map<string, ReplaySubject>();
    if (rows.length === 0) return result;
    const today = shanghaiToday(at);
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const projectRows = await client
      .select({ id: projects.id, code: projects.code, name: projects.name, managerIds: projects.managerIds })
      .from(projects)
      .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)));
    const projectById = new Map(projectRows.map((row) => [row.id, row]));
    const groupProjectIds = await this.enabledGroupProjectIds(projectIds, client);
    const progressByProject = await this.projectProgress(projectIds, client);
    const nameIds = new Set<string>();
    for (const row of rows) {
      const ownerId = row.ownerIds[0];
      if (ownerId !== undefined) nameIds.add(ownerId);
    }
    for (const project of projectRows) {
      const managerId = project.managerIds[0];
      if (managerId !== undefined) nameIds.add(managerId);
    }
    if (actorId !== null) nameIds.add(actorId);
    const nameById = await this.userNames([...nameIds], client);
    const fileCountByTask = await this.taskFileCounts(rows.map((row) => row.id), client);
    for (const row of rows) {
      // 项目已进回收站 / 已删除：丢弃迟到事件，避免继续生成提醒。
      const project = projectById.get(row.projectId);
      if (project === undefined) continue;
      // 多负责人只取首位（数组顺序 = 展示顺序）：单收件人口径随 M5-06 定案（README 登记）。
      const ownerId = row.ownerIds[0] ?? null;
      const managerId = project.managerIds[0] ?? null;
      const snapshot: ReplayTask = {
        id: row.id,
        title: row.title,
        version: row.version,
        displayStatus: deriveDisplayStatus({
          status: row.status,
          statusOverride: row.statusOverride,
          plannedEnd: row.plannedEnd,
          actualEnd: row.actualEnd,
          storedOnTime: row.onTime,
          today,
        }),
        urgency: row.priority,
        plannedStart: row.plannedStart,
        plannedEnd: row.plannedEnd,
        actualStart: null,
        actualEnd: row.actualEnd,
        ownerId,
        ownerName: ownerId === null ? null : (nameById.get(ownerId) ?? null),
        managerId,
        managerName: managerId === null ? null : (nameById.get(managerId) ?? null),
        projectId: row.projectId,
        projectCode: project.code,
        projectName: project.name,
        projectProgress: progressByProject.get(row.projectId) ?? 0,
        completedByName: actorId === null ? null : (nameById.get(actorId) ?? "未知用户"),
        projectGroupId: groupProjectIds.has(row.projectId) ? row.projectId : null,
        deliverableTypes: row.deliverableTypes,
        fileCount: fileCountByTask.get(row.id) ?? 0,
      };
      result.set(row.id, toTaskSubject(snapshot));
    }
    return result;
  }

  /** 启用中的群绑定项目集（project.group 寻址键解析：一项目一群；未绑定 / 已停用 = 不在集内 → 收件人缺省）。 */
  private async enabledGroupProjectIds(projectIds: readonly string[], client: DbClient): Promise<Set<string>> {
    const result = new Set<string>();
    if (projectIds.length === 0) return result;
    const rows = await client
      .select({ projectId: wecomGroups.projectId })
      .from(wecomGroups)
      .where(and(eq(wecomGroups.enabled, true), inArray(wecomGroups.projectId, [...projectIds])));
    for (const row of rows) result.add(row.projectId);
    return result;
  }

  /**
   * 项目日报槽位池（A02 · project_day）：在办项目 × 窗口内每个业务日（entry_count > 0 才产主体 —— 当日无提交不刷空汇总）。
   * 聚合口径与 reports/summary 数据面同源（draft 之外算已提交；条目按提交时刻升序，同刻按创建时间 / 作者 id 兜底）——
   * 逐字段口径见 summarizeProjectDay（纯函数 · 与 A02 补充设计逐字口径同源 · docs/rules/A01-A03-A14-扩展规则文案.md）。
   */
  private async projectDaySubjects(dates: readonly string[], client: DbClient): Promise<ReplaySubject[]> {
    const subjects: ReplaySubject[] = [];
    if (dates.length === 0) return subjects;
    const projectRows = await client
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(isNull(projects.deletedAt), ne(projects.status, "archived")));
    if (projectRows.length === 0) return subjects;
    const projectIds = projectRows.map((row) => row.id);
    const nameByProject = new Map(projectRows.map((row) => [row.id, row.name]));
    const rows = await client
      .select({
        projectId: dailyReports.projectId,
        authorId: dailyReports.authorId,
        reportDate: dailyReports.reportDate,
        state: dailyReports.state,
        headcount: dailyReports.headcount,
        doneWork: dailyReports.doneWork,
        foundIssue: dailyReports.foundIssue,
        submittedAt: dailyReports.submittedAt,
        createdAt: dailyReports.createdAt,
      })
      .from(dailyReports)
      .where(and(inArray(dailyReports.projectId, projectIds), inArray(dailyReports.reportDate, [...dates])));
    const submitted = rows.filter((row) => row.state !== "draft");
    if (submitted.length === 0) return subjects;
    const groupProjectIds = await this.enabledGroupProjectIds(projectIds, client);
    const nameById = await this.userNames([...new Set(submitted.map((row) => row.authorId))], client);
    const buckets = new Map<string, typeof submitted>();
    for (const row of submitted) {
      const key = row.projectId + "|" + row.reportDate;
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [row]);
      else bucket.push(row);
    }
    for (const bucket of buckets.values()) {
      const sorted = [...bucket].sort(byReportSubmittedAt);
      const first = sorted[0];
      if (first === undefined) continue;
      subjects.push(
        toProjectDaySubject({
          projectId: first.projectId,
          projectName: nameByProject.get(first.projectId) ?? "",
          date: first.reportDate,
          ...summarizeProjectDay(sorted, (authorId) => nameById.get(authorId) ?? ""),
          groupId: groupProjectIds.has(first.projectId) ? first.projectId : null,
        }),
      );
    }
    return subjects;
  }
  /** 项目完成度（R06 的 project.progress）：未删任务 status=done 占比四舍五入取整；无任务 = 0。 */
  private async projectProgress(projectIds: readonly string[], client: DbClient): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (projectIds.length === 0) return result;
    const rows = await client
      .select({ projectId: tasks.projectId, status: tasks.status, value: count() })
      .from(tasks)
      .where(and(inArray(tasks.projectId, [...projectIds]), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId, tasks.status);
    const totals = new Map<string, { done: number; total: number }>();
    for (const row of rows) {
      const entry = totals.get(row.projectId) ?? { done: 0, total: 0 };
      const value = Number(row.value);
      entry.total += value;
      if (row.status === "done") entry.done += value;
      totals.set(row.projectId, entry);
    }
    for (const [projectId, entry] of totals) {
      result.set(projectId, entry.total === 0 ? 0 : Math.round((entry.done * 100) / entry.total));
    }
    return result;
  }

  /** 任务文件件数（R02 条件 task.file_count = 0）：摘要口径、按 taskId 分组。 */
  private async taskFileCounts(taskIds: readonly string[], client: DbClient): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (taskIds.length === 0) return result;
    const rows = await client
      .select({ taskId: files.taskId, value: count() })
      .from(files)
      .where(and(inArray(files.taskId, [...taskIds]), inArray(files.status, [...FILE_STATUS_FOR_SUMMARY])))
      .groupBy(files.taskId);
    for (const row of rows) {
      if (row.taskId === null) continue;
      result.set(row.taskId, Number(row.value));
    }
    return result;
  }

  /** 用户显示名（收件人 / 文案称呼）。 */
  private async userNames(ids: readonly string[], client: DbClient): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const rows = await client
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ids]));
    for (const row of rows) result.set(row.id, row.displayName);
    return result;
  }

  /** 工作日历窗口（跨年自动覆盖）：读年例外 → calendarWindow(±余量)。 */
  private async calendarWindowFor(firstDate: string, lastDate: string, client: DbClient): Promise<CalendarWindow> {
    const from = addDays(firstDate, -CALENDAR_SPAN_DAYS);
    const to = addDays(lastDate, CALENDAR_SPAN_DAYS);
    const exceptions: CalendarException[] = [];
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
      const view = await this.calendar.getYear(year, client);
      for (const day of view.days) {
        exceptions.push({ date: day.date, dayType: day.dayType, name: day.name, note: day.note });
      }
    }
    return calendarWindow(from, to, exceptions);
  }
}