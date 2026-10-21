import { Injectable } from "@nestjs/common";
import { DOC_TYPES, PRIORITY_VALUES } from "@libiaolink/contracts";
import type { WorkspaceIssueItem, WorkspaceProject, WorkspaceResponse, WorkspaceTaskItem } from "@libiaolink/contracts";
import { PermissionService } from "../permission/index.js";
import { deriveDisplayStatus, deriveOnTime, shanghaiToday, type TaskDerivationInput } from "../task/index.js";
import { WorkspaceRepository, type WorkspaceIssueRow, type WorkspaceProjectRow, type WorkspaceTaskRow } from "./workspace.repository.js";
import { emptyTaskGroups, taskGroupOf } from "./workspace.rules.js";

/**
 * 工作台用例（M6-05 · A6-01 / A6-03）：
 * 一次读出口返回「我的任务四组 + 我的问题两栏 + 涉及项目卡」；分组口径见 workspace.rules（基准日 = Asia/Shanghai 今天，ADR-028；
 * 2026-09-30 复评：不限窗口 / 项目经理含我 / 未排期单列）。
 * 记录级可见性：PermissionService.projectScope（管理员 = 全量；其余 = 可见项目 id 集合，空集短路）。
 * 2026-10-13 全字段修订（Push 302）：任务项 / 问题项随行下发任务表 15 列与问题追踪七列数据源，
 * 并补 projects（涉及项目卡，含 managerNames / managerIds / version）—— 前端不再逐项目回填。
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly permission: PermissionService,
  ) {}

  /** GET /api/v1/workspace（按会话用户；无项目路径参数 —— 跨项目个人读面）。 */
  async get(actorId: string): Promise<WorkspaceResponse> {
    const today = shanghaiToday(new Date());
    const scope = await this.permission.projectScope(actorId);
    const [taskRows, issueRows] = await Promise.all([
      this.repository.listMyTasks(actorId, scope),
      this.repository.listMyIssues(actorId, scope),
    ]);
    const myTasks = emptyTaskGroups<WorkspaceTaskItem>();
    for (const row of taskRows) {
      myTasks[taskGroupOf(row.plannedEnd, today)].push(toTaskItem(row, today));
    }
    const projects = await this.loadProjects(taskRows, issueRows);
    return {
      today,
      myTasks,
      myIssues: {
        handling: issueRows.filter((row) => row.ownerId === actorId).map(toIssueItem),
        raised: issueRows.filter((row) => row.reporterId === actorId).map(toIssueItem),
      },
      projects,
    };
  }

  /** 聚合涉及的项目卡：按任务组顺序 → 问题栏顺序的首次出现去重；取不到的 id 跳过（项目已被软删）。 */
  private async loadProjects(taskRows: readonly WorkspaceTaskRow[], issueRows: readonly WorkspaceIssueRow[]): Promise<WorkspaceProject[]> {
    const projectIds: string[] = [];
    const seen = new Set<string>();
    for (const projectId of [...taskRows.map((row) => row.projectId), ...issueRows.map((row) => row.projectId)]) {
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      projectIds.push(projectId);
    }
    const rows = await this.repository.listProjects(projectIds);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const projects: WorkspaceProject[] = [];
    for (const projectId of projectIds) {
      const row = byId.get(projectId);
      if (row !== undefined) projects.push(toProjectItem(row));
    }
    return projects;
  }
}

/**
 * 行 → 契约视图：任务表 15 列全字段（2026-10-13 全字段修订）；displayStatus / onTime 读时派生（A1-06 / A14，含显式覆盖 · Push 179）；
 * 进度 / 优先级 / 成果类型归一化与任务列表同口径。
 */
function toTaskItem(row: WorkspaceTaskRow, today: string): WorkspaceTaskItem {
  const input: TaskDerivationInput = {
    status: row.status,
    statusOverride: row.statusOverride,
    plannedEnd: row.plannedEnd,
    actualEnd: row.actualEnd,
    storedOnTime: row.onTime,
    today,
  };
  return {
    id: row.id,
    projectId: row.projectId,
    projectCode: row.projectCode,
    projectName: row.projectName,
    stageKey: row.stageKey as WorkspaceTaskItem["stageKey"],
    sortIndex: row.sortIndex,
    nodeId: row.nodeId,
    sourceNodeId: row.sourceNodeId,
    title: row.title,
    titleEn: row.titleEn,
    ownerIds: row.ownerIds,
    ownerNames: row.ownerNames ?? [],
    status: row.status as WorkspaceTaskItem["status"],
    displayStatus: deriveDisplayStatus(input),
    progress: normalizeProgress(Number(row.progress)),
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    actualEnd: row.actualEnd,
    estimatedDays: row.estimatedDays,
    headcount: row.headcount,
    priority: normalizePriority(row.priority),
    deliverableTypes: normalizeDocTypes(row.deliverableTypes),
    note: row.note,
    onTime: deriveOnTime(input),
    changeLinks: row.changeLinks,
    fileSummary: row.fileSummary,
    files: row.files as WorkspaceTaskItem["files"],
    finalizedAt: row.finalizedAt === null ? null : row.finalizedAt.toISOString(),
    finalizedBy: row.finalizedBy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 行 → 契约视图（枚举收窄沿用读面统一口径：库侧受 CHECK 约束，越界值理论不出现）。 */
function toIssueItem(row: WorkspaceIssueRow): WorkspaceIssueItem {
  return {
    id: row.id,
    projectId: row.projectId,
    projectCode: row.projectCode,
    projectName: row.projectName,
    taskId: row.taskId,
    title: row.title,
    categories: row.categories as WorkspaceIssueItem["categories"],
    state: row.state as WorkspaceIssueItem["state"],
    reporterId: row.reporterId,
    reporterName: row.reporterName,
    ownerDepartment: row.ownerDepartment,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    raisedAt: row.raisedAt,
    solution: row.solution,
    photos: row.photos,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/** 行 → 契约项目卡（ProjectSchema + managerNames；时间戳转 ISO8601）。 */
function toProjectItem(row: WorkspaceProjectRow): WorkspaceProject {
  return {
    id: row.id,
    code: row.code,
    seqNo: row.seqNo,
    name: row.name,
    customer: row.customer,
    region: row.region,
    projectType: row.projectType,
    managerIds: row.managerIds,
    managerNames: row.managerNames ?? [],
    stageKey: row.stageKey as WorkspaceProject["stageKey"],
    status: row.status as WorkspaceProject["status"],
    description: row.description,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    archivedBy: row.archivedBy,
    // 工作台只读未删除项目；契约统一携带回收站字段。
    deletedAt: null,
    deletedBy: null,
  };
}

/** 进度归一化到离散五档（与 task.service 同口径：任意小数四舍五入到最近档，非法回落 0）。 */
function normalizeProgress(value: number): WorkspaceTaskItem["progress"] {
  const rounded = Math.round(value * 4) / 4;
  if (rounded === 0 || rounded === 0.25 || rounded === 0.5 || rounded === 0.75 || rounded === 1) return rounded;
  return 0;
}

/** 紧急重要度归一化（与 task.service 同口径：非三档取值回落 null）。 */
function normalizePriority(value: string | null): WorkspaceTaskItem["priority"] {
  if (value === null) return null;
  return (PRIORITY_VALUES as readonly string[]).includes(value) ? (value as WorkspaceTaskItem["priority"]) : null;
}

/** 输出成果文件归一化（与 task.service 同口径：字典外取值剔除、保序去重、空数组 = 不要求）。 */
function normalizeDocTypes(values: readonly string[]): WorkspaceTaskItem["deliverableTypes"] {
  const seen = new Set<string>();
  const result: WorkspaceTaskItem["deliverableTypes"] = [];
  for (const value of values) {
    if (!(DOC_TYPES as readonly string[]).includes(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value as WorkspaceTaskItem["deliverableTypes"][number]);
  }
  return result;
}
