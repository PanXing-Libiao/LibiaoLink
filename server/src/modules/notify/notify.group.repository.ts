/**
 * wecom_groups / wecom_group_candidates / notify_deliveries 数据访问（M5-03-2 接线段 · C2-05 / C2-07 / C5-03）。
 * 边界（ADR 架构检查）：notify 属 PLATFORM、project 属 DOMAIN —— 本层**不得 import project 模块**，
 * 直接读 `db/schema/notify.ts` 的表（表访问允许；寻址键 = projectId，绑定行由 project 模块维护）。
 * 口径：投递时读绑定（换绑后未投递消息仍按当前绑定送出）；notify_deliveries 每次尝试一行，
 * 非 sent 行必须带非空 error（0046 CHECK）；activated_at 由群消息回调 ingest 置位（主动推送前置）；
 * 未绑定群回调写入 wecom_group_candidates staging 表（0058），绑定成功后由 project 模块删除。
 */
import { Injectable } from "@nestjs/common";
import { STAGE_NAMES } from "@libiaolink/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";
import { files, fileLinks, fileVersions } from "../../db/schema/files.js";
import { notifyDeliveries, wecomGroupCandidates, wecomGroups } from "../../db/schema/notify.js";
import { projectMembers, projects } from "../../db/schema/projects.js";
import { dailyReports, issues } from "../../db/schema/reports.js";
import { tasks } from "../../db/schema/tasks.js";
import type {
  DailyReportPosterData,
  DailyReportPosterIssue,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";

export type WecomGroupRow = typeof wecomGroups.$inferSelect;
export type WecomGroupCandidateRow = typeof wecomGroupCandidates.$inferSelect;

/** R06 动态海报数据（项目 + 成员 + 任务统计一次读齐；姓名只用于 Poster 展示，不回写业务表）。 */
export interface R06PosterData {
  projectCode: string;
  projectName: string;
  status: string;
  managers: string[];
  participants: string[];
  taskTotal: number;
  taskDone: number;
  onTimeDone: number;
  startDate: string | null;
  plannedEnd: string | null;
}

/** 日报海报附图行：objectKey / mime 缺失时仍返回引用，渲染器会留空片位。 */
type DailyReportPosterPhotoRow = {
  fileId: string;
  objectId: string;
  name: string;
  objectKey: string | null;
  mime: string | null;
};

/** 投递留痕输入（服务层保证 CHECK 语义：sent ↔ sentAt 非空且 error 为空）。 */
export interface NotifyDeliveryInsert {
  outboxId: number | null;
  target: string;
  state: "sent" | "failed" | "deferred" | "dead";
  attempts: number;
  error: string | null;
  sentAt: Date | null;
}

/** 已完成任务是否按时（纯函数）：有实际 / 计划完成日时按日期比较，否则只接受显式 on_time=true。 */
export function isCompletedTaskOnTime(row: {
  status: string;
  plannedEnd: string | null;
  actualEnd: string | null;
  onTime: boolean | null;
}): boolean {
  if (row.status !== "done") return false;
  if (row.actualEnd !== null && row.plannedEnd !== null) return row.actualEnd <= row.plannedEnd;
  return row.onTime === true;
}

/** R06 按时交付判定（纯函数）：无任务 / 任一未完成 / 任一延期 = false。 */
export function areAllProjectTasksOnTime(
  rows: readonly {
    status: string;
    plannedEnd: string | null;
    actualEnd: string | null;
    onTime: boolean | null;
  }[],
  at: Date,
): boolean {
  if (rows.length === 0) return false;
  const today = new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  return rows.every((row) => {
    if (row.status !== "done") return false;
    if (row.actualEnd !== null && row.plannedEnd !== null) return row.actualEnd <= row.plannedEnd;
    if (row.actualEnd === null && row.plannedEnd !== null && row.plannedEnd < today) return false;
    return row.onTime === true;
  });
}

@Injectable()
export class NotifyGroupRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 按项目读当前群绑定（投递时读；未绑定 = null）。 */
  async findGroupByProject(projectId: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.select().from(wecomGroups).where(eq(wecomGroups.projectId, projectId)).limit(1);
    return rows[0] ?? null;
  }

  /** 按 chatid 读绑定（回调 ingest 用；未绑定 = null）。 */
  async findGroupByChatid(chatid: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.select().from(wecomGroups).where(eq(wecomGroups.chatid, chatid)).limit(1);
    return rows[0] ?? null;
  }

  /** 项目名（告警正文只展示名称；项目不存在 / 已软删 = null）。 */
  async findProjectName(projectId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /**
   * 群失败降级（C5-04 / B4 定案）读项目经理：projects.manager_ids[0]（软删 / 不存在 = null）。
   * 边界同文件头注：直接读表，不 import project 模块。
   */
  async findProjectManagerId(projectId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ managerIds: projects.managerIds })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0]?.managerIds[0] ?? null;
  }

  /**
   * R06 动态海报数据：项目编号 / 名称 / 状态、项目经理、项目成员与任务负责人去重姓名、任务完成与按期统计。
   * 参与成员顺序 = 项目经理 → 项目成员（入册顺序）→ 任务负责人（任务读取顺序）；展示名去掉测试数据后缀 "-test"。
   * 边界同文件头注：直接读表，不 import project 模块；项目不存在 / 已软删 = null。
   */
  async findR06PosterData(projectId: string, client: DbClient = this.database.db): Promise<R06PosterData | null> {
    const projectRows = await client
      .select({
        code: projects.code,
        name: projects.name,
        status: projects.status,
        managerIds: projects.managerIds,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    const project = projectRows[0];
    if (project === undefined) {
      return null;
    }
    const memberRows = await client
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(asc(projectMembers.joinedAt), asc(projectMembers.id));
    const taskRows = await client
      .select({
        ownerIds: tasks.ownerIds,
        status: tasks.status,
        plannedStart: tasks.plannedStart,
        plannedEnd: tasks.plannedEnd,
        actualEnd: tasks.actualEnd,
        onTime: tasks.onTime,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    const participantIds: string[] = [];
    const seen = new Set<string>();
    const addId = (id: string): void => {
      if (!seen.has(id)) {
        seen.add(id);
        participantIds.push(id);
      }
    };
    for (const id of project.managerIds) addId(id);
    for (const row of memberRows) addId(row.userId);
    for (const row of taskRows) {
      for (const id of row.ownerIds) addId(id);
    }
    const userRows = participantIds.length === 0
      ? []
      : await client
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, participantIds));
    const nameById = new Map(userRows.map((row) => [row.id, row.displayName.replace(/-test$/i, "").trim()]));
    const managerNames = project.managerIds
      .map((id) => nameById.get(id) ?? "")
      .filter((name) => name !== "");
    const participantNames = participantIds
      .map((id) => nameById.get(id) ?? "")
      .filter((name) => name !== "");
    const doneRows = taskRows.filter((row) => row.status === "done");
    const starts = taskRows
      .map((row) => row.plannedStart?.slice(0, 10) ?? null)
      .filter((value): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    const ends = taskRows
      .map((row) => row.plannedEnd?.slice(0, 10) ?? null)
      .filter((value): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return {
      projectCode: project.code,
      projectName: project.name,
      status: project.status,
      managers: managerNames,
      participants: participantNames,
      taskTotal: taskRows.length,
      taskDone: doneRows.length,
      onTimeDone: doneRows.filter((row) => isCompletedTaskOnTime(row)).length,
      startDate: starts[0] ?? null,
      plannedEnd: ends.at(-1) ?? null,
    };
  }

  /**
   * 日报群同步海报快照：项目 / 项目经理 / 日报正文 / 关联阶段 / 全部现场图 / 派生问题、处理记录及全部问题图。
   *
   * 边界同文件头注：notify 是平台模块，直接读 report-issue 所需表，不 import 领域模块。
   * 图片只返回 objectKey；worker 用 ObjectStorage 读字节后交给纯渲染器。
   * 日报不存在 / 项目软删 = null；草稿照常返回 state，由投递层拒绝生成。
   */
  async findDailyReportPosterData(
    projectId: string,
    reportId: string,
    client: DbClient = this.database.db,
  ): Promise<DailyReportPosterData | null> {
    const projectRows = await client
      .select({
        code: projects.code,
        name: projects.name,
        managerIds: projects.managerIds,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    const project = projectRows[0];
    if (project === undefined) {
      return null;
    }

    const reportRows = await client
      .select({
        id: dailyReports.id,
        reportDate: dailyReports.reportDate,
        state: dailyReports.state,
        authorId: dailyReports.authorId,
        authorName: users.displayName,
        headcount: dailyReports.headcount,
        doneWork: dailyReports.doneWork,
        plan: dailyReports.plan,
        stageKeys: dailyReports.stageKeys,
        submittedAt: dailyReports.submittedAt,
      })
      .from(dailyReports)
      .leftJoin(users, eq(users.id, dailyReports.authorId))
      .where(and(eq(dailyReports.id, reportId), eq(dailyReports.projectId, projectId)))
      .limit(1);
    const report = reportRows[0];
    if (report === undefined) {
      return null;
    }

    const issueRows = await client
      .select({
        id: issues.id,
        title: issues.title,
        categories: issues.categories,
        state: issues.state,
        solution: issues.solution,
        ownerName: users.displayName,
      })
      .from(issues)
      .leftJoin(users, eq(users.id, issues.ownerId))
      .where(and(eq(issues.projectId, projectId), eq(issues.sourceReportId, reportId)))
      .orderBy(asc(issues.createdAt), asc(issues.id));

    const personIds = [...new Set([...project.managerIds, report.authorId])];
    const personRows = personIds.length === 0
      ? []
      : await client
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, personIds));
    const nameById = new Map(personRows.map((row) => [row.id, row.displayName.replace(/-test$/i, "").trim()]));
    const managers = project.managerIds
      .map((id) => nameById.get(id) ?? "")
      .filter((name) => name !== "");

    const photoColumns = {
      fileId: fileLinks.fileId,
      objectId: fileLinks.objectId,
      name: files.name,
      objectKey: fileVersions.objectKey,
      mime: fileVersions.mime,
    };
    const onsiteRows = await client
      .select(photoColumns)
      .from(fileLinks)
      .innerJoin(files, eq(files.id, fileLinks.fileId))
      .leftJoin(fileVersions, eq(fileVersions.id, files.currentVersionId))
      .where(and(eq(fileLinks.objectType, "report"), eq(fileLinks.objectId, reportId), eq(fileLinks.kind, "onsite")))
      .orderBy(asc(fileLinks.createdAt), asc(fileLinks.id));
    const issueIds = issueRows.map((row) => row.id);
    const issuePhotoRows = issueIds.length === 0
      ? []
      : await client
          .select(photoColumns)
          .from(fileLinks)
          .innerJoin(files, eq(files.id, fileLinks.fileId))
          .leftJoin(fileVersions, eq(fileVersions.id, files.currentVersionId))
          .where(and(eq(fileLinks.objectType, "issue"), inArray(fileLinks.objectId, issueIds)))
          .orderBy(asc(fileLinks.createdAt), asc(fileLinks.id));

    const photoOf = (row: DailyReportPosterPhotoRow): DailyReportPosterPhoto => ({
      fileId: row.fileId,
      name: row.name,
      objectKey: row.objectKey,
      mime: row.mime,
    });
    const photosByIssue = new Map<string, DailyReportPosterPhoto[]>();
    for (const row of issuePhotoRows) {
      const list = photosByIssue.get(row.objectId) ?? [];
      list.push(photoOf(row));
      photosByIssue.set(row.objectId, list);
    }
    const posterIssues: DailyReportPosterIssue[] = issueRows.map((row) => ({
      id: row.id,
      title: row.title,
      categories: row.categories,
      ownerName: row.ownerName,
      state: row.state,
      solution: row.solution,
      photos: photosByIssue.get(row.id) ?? [],
    }));
    const stageNames = STAGE_NAMES as Record<string, string>;

    return {
      projectId,
      projectCode: project.code,
      projectName: project.name,
      managers,
      reportId: report.id,
      reportDate: report.reportDate,
      state: report.state,
      authorName: report.authorName,
      headcount: report.headcount,
      doneWork: report.doneWork,
      plan: report.plan,
      stages: report.stageKeys.map((key) => stageNames[key] ?? key),
      submittedAt: report.submittedAt === null ? null : report.submittedAt.toISOString(),
      photos: onsiteRows.map(photoOf),
      issues: posterIssues,
    };
  }

  /**
   * R06 图片分支：项目内未删任务是否全部按时交付（R06 项目完成事件投递时读）。
   * 口径与任务读面 A14 一致：完成日不晚于预计完成；日期不全时仅接受显式 on_time=true，
   * 预计完成已过但未填实际完成 = 未按时。无任务 / 任一未完成 = false。
   */
  async areProjectTasksAllOnTime(
    projectId: string,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<boolean> {
    const rows = await client
      .select({
        status: tasks.status,
        plannedEnd: tasks.plannedEnd,
        actualEnd: tasks.actualEnd,
        onTime: tasks.onTime,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    return areAllProjectTasksOnTime(rows, at);
  }

  /**
   * R06 火箭动画门槛：项目状态为 done，且项目内未删任务全部完成、全部按期。
   * 项目不存在 / 已软删 / 非 done / 无任务 / 任一完成或按期不满足 = false。
   */
  async isProjectCompletedWithAllTasksOnTime(
    projectId: string,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<boolean> {
    const projectRows = await client
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (projectRows[0]?.status !== "done") {
      return false;
    }
    return await this.areProjectTasksAllOnTime(projectId, at, client);
  }

  /** 回调 ingest：会话激活置位（仅未激活行命中；已激活 / 未绑定返回 null —— 幂等）。 */
  async activateByChatid(chatid: string, at: Date, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client
      .update(wecomGroups)
      .set({ activatedAt: at, updatedAt: at })
      .where(and(eq(wecomGroups.chatid, chatid), isNull(wecomGroups.activatedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** 群名命令：更新已绑定群的展示名（不改寻址 / 权限；调用方负责命令解析与长度校验）。 */
  async setGroupName(
    chatid: string,
    name: string,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WecomGroupRow | null> {
    const rows = await client
      .update(wecomGroups)
      .set({ name, updatedAt: at })
      .where(eq(wecomGroups.chatid, chatid))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * 未绑定群回调暂存（自动发现）：同 chatid upsert，保留首次发现时间并刷新最后活跃时间；
   * 回调没有群名时不清空已有名称。读面由 project 模块按候选 id 解析，不在这里暴露全文。
   */
  async observeCandidate(
    input: { chatid: string; name: string | null },
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WecomGroupCandidateRow> {
    const rows = await client
      .insert(wecomGroupCandidates)
      .values({ chatid: input.chatid, name: input.name, firstSeenAt: at, lastSeenAt: at })
      .onConflictDoUpdate({
        target: [wecomGroupCandidates.chatid],
        set: {
          name: input.name === null ? sql`${wecomGroupCandidates.name}` : input.name,
          lastSeenAt: at,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("wecom_group_candidates upsert 未返回记录");
    }
    return row;
  }

  /** 投递留痕：一次尝试一行（outbox_id 指向来源事件；事件行清理后置 null 留档不回删）。 */
  async insertDelivery(input: NotifyDeliveryInsert, client: DbClient = this.database.db): Promise<void> {
    await client.insert(notifyDeliveries).values({
      outboxId: input.outboxId,
      channel: "wecom_group",
      target: input.target,
      state: input.state,
      attempts: input.attempts,
      error: input.error,
      sentAt: input.sentAt,
    });
  }
}
