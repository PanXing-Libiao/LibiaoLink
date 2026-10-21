import { Injectable } from "@nestjs/common";
import type {
  DashboardChangeWordsResponse,
  DashboardIssuesResponse,
  DashboardProgressResponse,
  DashboardTaskSummary,
} from "@libiaolink/contracts";
import { PermissionService } from "../permission/index.js";
import { DashboardRepository, type DashboardChangeRow, type DashboardIssueRow } from "./dashboard.repository.js";
import {
  addTaskBucket,
  buildChangeWords,
  buildIssues,
  emptyChangeWords,
  emptyIssues,
  emptyTaskAggregate,
  shanghaiToday,
  taskSummaryOf,
} from "./dashboard.rules.js";

/**
 * 仪表盘聚合用例（B4 / M7-02）：
 * - progress：首屏一次返回全部 / 逐项目任务聚合；
 * - issues / change-words：各自懒加载，只返回统计，不下发明细；
 * - 明细下钻由前端按选中项目复用现有项目读面，不在聚合响应里夹带大列表；
 * - 记录级可见性统一走 PermissionService.projectScope，空可见集直接返回空结果。
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly repository: DashboardRepository,
    private readonly permission: PermissionService,
  ) {}

  async progress(actorId: string): Promise<DashboardProgressResponse> {
    const today = shanghaiToday(new Date());
    const scope = await this.permission.projectScope(actorId);
    const projects = await this.repository.listProjects(scope);
    if (projects.length === 0) {
      return { all: emptyTaskSummary(), byProject: [] };
    }
    const buckets = await this.repository.listTaskBuckets(scope, today);
    const all = emptyTaskAggregate();
    const byProject = new Map(projects.map((project) => [project.id, emptyTaskAggregate(project.id)] as const));
    for (const bucket of buckets) {
      addTaskBucket(all, bucket);
      const aggregate = byProject.get(bucket.projectId);
      if (aggregate !== undefined) addTaskBucket(aggregate, bucket);
    }
    return {
      all: taskSummaryOf(all),
      byProject: projects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        managerNames: project.managerNames ?? [],
        summary: taskSummaryOf(byProject.get(project.id) ?? emptyTaskAggregate(project.id)),
      })),
    };
  }

  async issues(actorId: string): Promise<DashboardIssuesResponse> {
    const scope = await this.permission.projectScope(actorId);
    const projects = await this.repository.listProjects(scope);
    if (projects.length === 0) {
      return { all: emptyIssues(), byProject: [] };
    }
    const rows = await this.repository.listIssueRows(scope);
    const grouped = groupByProject(rows);
    return {
      all: buildIssues(rows),
      byProject: projects.flatMap((project) => {
        const projectRows = grouped.get(project.id);
        if (projectRows === undefined || projectRows.length === 0) return [];
        const summary = buildIssues(projectRows);
        return summary.totalIssues === 0 ? [] : [{ projectId: project.id, issues: summary }];
      }),
    };
  }

  async changeWords(actorId: string): Promise<DashboardChangeWordsResponse> {
    const scope = await this.permission.projectScope(actorId);
    const projects = await this.repository.listProjects(scope);
    if (projects.length === 0) {
      return { all: emptyChangeWords(), byProject: [] };
    }
    const rows = await this.repository.listChangeReasons(scope);
    const grouped = groupByProject(rows);
    return {
      all: buildChangeWords(rows),
      byProject: projects.flatMap((project) => {
        const projectRows = grouped.get(project.id);
        if (projectRows === undefined || projectRows.length === 0) return [];
        return [{ projectId: project.id, words: buildChangeWords(projectRows) }];
      }),
    };
  }
}

function emptyTaskSummary(): DashboardTaskSummary {
  return taskSummaryOf(emptyTaskAggregate());
}

function groupByProject<T extends { projectId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.projectId) ?? [];
    list.push(row);
    grouped.set(row.projectId, list);
  }
  return grouped;
}
