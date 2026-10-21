/**
 * 工作台接口封装（M6-06 前端接线 · 系统功能书 A6-01 / A6-03；契约 shared/src/modules/workspace.ts，Push 166 已 HTTP 落地）。
 * - 聚合读面 GET /api/v1/workspace（跨项目个人读面：无项目路径参数、仅会话）。
 * 2026-10-13 全字段修订（Push 302）：任务项 = 任务表全字段（TaskListItem + 项目编号 / 名称 + 文件清单）、
 * 问题项随行 solution / photos、响应带 projects（涉及项目卡）—— 页面直接渲染，不再逐项目回填。
 */
import { apiRequest } from "./api";
import type { ApiProject } from "./projectApi";
import type { ApiTaskListItem, TaskFileBrief } from "./taskApi";

/** 契约 WorkspaceTaskItem：工作台任务项（跨项目 = TaskListItem 全字段 + 项目编号 / 名称 + 随行文件清单）。 */
export type ApiWorkspaceTask = ApiTaskListItem & {
  projectCode: string;
  projectName: string;
  /** 随行文件清单（口径同任务详情 files：排除回收站、创建时间倒序；行内「文件」列下拉数据源）。 */
  files: TaskFileBrief[];
};

/** 契约 WorkspaceIssueItem：工作台问题项（跨项目；保留 version —— 工作台内快速流转 / 关闭确认时带乐观锁）。 */
export type ApiWorkspaceIssue = {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  taskId: string | null;
  title: string;
  categories: string[];
  state: string;
  reporterId: string;
  reporterName: string | null;
  ownerDepartment: string | null;
  ownerId: string | null;
  ownerName: string | null;
  raisedAt: string;
  /** 解决方案或建议（2026-10-13 全字段修订随行）。 */
  solution: string | null;
  /** 问题附图（file_links(object_type=issue)，插入序；预览签名由瓦片懒取）。 */
  photos: Array<{ fileId: string; name: string }>;
  updatedAt: string;
  version: number;
};

/** 契约 WorkspaceResponse：分组基准日（Asia/Shanghai 今天）+ 我的任务四组 + 我的问题两栏 + 涉及项目卡。 */
export type ApiWorkspace = {
  today: string;
  myTasks: {
    today: ApiWorkspaceTask[];
    upcoming: ApiWorkspaceTask[];
    overdue: ApiWorkspaceTask[];
    unscheduled: ApiWorkspaceTask[];
  };
  myIssues: {
    handling: ApiWorkspaceIssue[];
    raised: ApiWorkspaceIssue[];
  };
  /** 聚合涉及的项目卡（Push 302：「项目经理」列与项目经理回写用；按首次出现顺序去重）。 */
  projects: ApiProject[];
};

/**
 * GET /api/v1/workspace：工作台聚合读面。
 * 口径（2026-09-30 复评）：任务 = 未完成，且「任务负责人含我」或「项目项目经理含我」；预计完成日期不设天数窗口
 * （已逾期 / 今天 / 远期分别落 overdue / today / upcoming，未排期落 unscheduled）；
 * 问题 = 我处理（ownerId 我）与我提出的（reporterId 我）两栏，同一问题两边都命中时两栏都出现；
 * 归档 / 软删项目整项目不进；排序由服务端给定（任务按 plannedEnd 升序、问题未关闭在前）。
 * 2026-10-13 全字段修订：任务项含任务表全字段与文件清单、问题项含 solution / photos、projects 随行。
 */
/**
 * 读面兜底（Push 302 部署顺序差防护）：新前端 + 旧后端（服务端未重启 / 分批上线）时，聚合读面没有
 * projects / files / solution / photos 等本次新增字段 —— 缺字段按空值收敛，页面降级显示而不是整页白屏；
 * 服务端更新后同一份代码照常读到全字段。
 */
function normalizeWorkspaceTask(task: ApiWorkspaceTask): ApiWorkspaceTask {
  return {
    ...task,
    projectCode: task.projectCode ?? "",
    projectName: task.projectName ?? "",
    ownerIds: Array.isArray(task.ownerIds) ? task.ownerIds : [],
    ownerNames: Array.isArray(task.ownerNames) ? task.ownerNames : [],
    deliverableTypes: Array.isArray(task.deliverableTypes) ? task.deliverableTypes : [],
    changeLinks: Array.isArray(task.changeLinks) ? task.changeLinks : [],
    files: Array.isArray(task.files) ? task.files : [],
  };
}

function normalizeWorkspaceIssue(issue: ApiWorkspaceIssue): ApiWorkspaceIssue {
  return {
    ...issue,
    categories: Array.isArray(issue.categories) ? issue.categories : [],
    solution: issue.solution ?? null,
    photos: Array.isArray(issue.photos) ? issue.photos : [],
  };
}

export async function fetchWorkspace(): Promise<ApiWorkspace> {
  const data = await apiRequest<ApiWorkspace>("/api/v1/workspace");
  const tasks = data.myTasks ?? { today: [], upcoming: [], overdue: [], unscheduled: [] };
  const issues = data.myIssues ?? { handling: [], raised: [] };
  return {
    today: data.today,
    myTasks: {
      today: (Array.isArray(tasks.today) ? tasks.today : []).map(normalizeWorkspaceTask),
      upcoming: (Array.isArray(tasks.upcoming) ? tasks.upcoming : []).map(normalizeWorkspaceTask),
      overdue: (Array.isArray(tasks.overdue) ? tasks.overdue : []).map(normalizeWorkspaceTask),
      unscheduled: (Array.isArray(tasks.unscheduled) ? tasks.unscheduled : []).map(normalizeWorkspaceTask),
    },
    myIssues: {
      handling: (Array.isArray(issues.handling) ? issues.handling : []).map(normalizeWorkspaceIssue),
      raised: (Array.isArray(issues.raised) ? issues.raised : []).map(normalizeWorkspaceIssue),
    },
    projects: Array.isArray(data.projects) ? data.projects : [],
  };
}
