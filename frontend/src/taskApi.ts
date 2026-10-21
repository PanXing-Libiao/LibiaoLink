/**
 * 任务接口封装（M3-07 刀 1 后半接线）：契约 shared/src/modules/tasks.ts + projects.ts。
 * - 列表 GET /api/v1/projects/{id}/tasks（一次取满，limit 上限 200；分页超限由页面提示）
 * - 详情 GET /api/v1/projects/{id}/tasks/{taskId}（抽屉按需取，含文件名清单）
 * - 汇总卡 GET /api/v1/projects/{id}/summary（slowestStage / latestStage / overdue / done / total）
 * - 创建 POST /api/v1/projects/{id}/tasks（节点生成 / 手工创建；Idempotency-Key 由调用方给）
 * - 编辑 PATCH /api/v1/projects/{id}/tasks/{taskId}（乐观锁 version 必传）
 * - 进度 PATCH /api/v1/projects/{id}/tasks/{taskId}/progress（联动状态与完成日期）
 * - 删除 DELETE /api/v1/projects/{id}/tasks/{taskId}（If-Match 回传 version）
 * 契约字段 → UI 模型（data/tasks.ts 的 ProjectTask）的映射只在本文件做。
 */
import { apiRequest, apiSend, readAllPages } from "./api";
import { textOf, type Locale } from "./i18n";
import { daysBetweenInclusive, type ProjectTask, type TaskChange, type TaskFileSummary, type TaskPriority, type TaskStatus } from "./data/tasks";

/** 契约 Task / TaskListItem / TaskDetail（本文件只需用到的字段；服务端可能多给，忽略即可）。 */
export type ApiTask = {
  id: string;
  projectId: string;
  stageKey: string | null;
  sortIndex: number;
  nodeId: string | null;
  sourceNodeId: string | null;
  title: string;
  titleEn: string | null;
  ownerIds: string[];
  status: string;
  displayStatus: string;
  progress: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  priority: string | null;
  deliverableTypes: string[];
  note: string | null;
  onTime: boolean | null;
  changeLinks: Array<{ id: string; reason: string | null; appliedAt: string }>;
  /** 任务定档（Push 249）：非空 = 已定档，任务不支持任何修改；与 finalizedBy 成对。 */
  finalizedAt: string | null;
  finalizedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ApiTaskListItem = ApiTask & {
  ownerNames: Array<string | null>;
  fileSummary: { total: number; draft: number; final: number };
};

/** 随行文件清单（详情接口 GET /projects/{id}/tasks/{taskId}）：文件名 / 状态 / 文档类型 —— 抽屉里的文件清单随「文件」那一刀接线。 */
export type TaskFileBrief = { id: string; name: string; status: string; docType: string | null };

export type ApiTaskDetail = ApiTask & {
  ownerNames: Array<string | null>;
  files: TaskFileBrief[];
};

export type ApiTaskListResult = { items: ApiTaskListItem[]; page: number; limit: number; total: number };

/** 项目总览汇总卡（契约 ProjectSummary）。 */
export type ApiProjectSummary = {
  projectId: string;
  slowestStage: string | null;
  latestStage: string | null;
  overdue: number;
  done: number;
  total: number;
};

/** 九阶段字典（契约 STAGE_KEYS / STAGE_NAMES）：阶段名 ↔ key 的双向映射在前端本地维护。 */
const STAGE_NAMES_BY_KEY: Record<string, string> = {
  presale: "售前规划",
  design: "设计开发",
  purchase: "加工采购",
  assembly: "组装发货",
  install: "硬件实施",
  deploy: "软件部署",
  trial: "试运行",
  production: "生产阶段",
  acceptance: "验收",
};

const STAGE_KEYS_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_NAMES_BY_KEY).map(([key, name]) => [name, key]),
);

/** 阶段 key → 展示名；null / 未知 key → 空串（展示层垫底归「临时任务」分组，Push 196 起原「未分组」；看板临时任务）。 */
export function stageNameOf(stageKey: string | null): string {
  return stageKey === null ? "" : STAGE_NAMES_BY_KEY[stageKey] ?? "";
}

/** 舞台展示名 → 阶段 key；不在九阶段内（「临时任务」等分组名）→ null。 */
export function stageKeyOfName(stageName: string): string | null {
  return STAGE_KEYS_BY_NAME[stageName] ?? null;
}

/** 服务端展示态（displayStatus）→ 界面五态中文标签。 */
export function displayStatusLabel(displayStatus: string): TaskStatus {
  if (displayStatus === "done") {
    return "已完成";
  }
  if (displayStatus === "overdue") {
    return "已延期";
  }
  if (displayStatus === "early_done") {
    return "提前完成";
  }
  if (displayStatus === "active") {
    return "进行中";
  }
  return "待开始";
}

/** 界面五态中文标签 → 写入值（TaskStatusWrite：基础三态 + 覆盖两态）。 */
export function statusWriteValue(status: TaskStatus): string {
  if (status === "已完成") {
    return "done";
  }
  if (status === "已延期") {
    return "overdue";
  }
  if (status === "提前完成") {
    return "early_done";
  }
  if (status === "进行中") {
    return "active";
  }
  return "pending";
}

function priorityOf(value: string | null): TaskPriority | null {
  return value === "高" || value === "中" || value === "低" ? value : null;
}

function changeLinksOf(links: ReadonlyArray<{ id: string; reason: string | null; appliedAt: string }>): TaskChange[] {
  return links.map((link) => ({ id: link.id, reason: link.reason ?? "", appliedAt: link.appliedAt }));
}

function fileSummaryOf(summary: { total: number; draft: number; final: number } | undefined): TaskFileSummary {
  return summary === undefined ? { total: 0, draft: 0, final: 0 } : { total: summary.total, draft: summary.draft, final: summary.final };
}

/**
 * 契约任务 → UI 模型。previous = 列表里已有的那一行（缺省 undefined 表示新行）：
 * POST / PATCH 只回契约 Task（不带 ownerNames / fileSummary）：文件摘要从 previous 继承 ——
 * 2026-10-08 修正（Push 249 · 业务口径「当我修改别的信息 文件一栏的内容就消失了 要刷新才能回来」）：
 * 原来这行漏继承（previous?.files 没接上，摘要归零）→ 改完任一字段「文件」列退回「—」、刷新才回来；现按注释口径继承；
 * 负责人姓名按「用户目录（resolveName，ProjectDetail 传 members）→ 旧行同 id 姓名 → —」三级兜底 ——
 * 2026-09-24 修：原来直接沿用旧行姓名，改负责人后要刷新才变（勾上 / 取消即时可见）。
 */
export function toUiTask(
  view: ApiTaskListItem | ApiTask,
  previous?: ProjectTask,
  resolveName?: (id: string) => string | undefined,
): ProjectTask {
  const startDate = view.plannedStart ?? "";
  const dueDate = view.plannedEnd ?? "";
  const derivedDays = startDate !== "" && dueDate !== "" ? daysBetweenInclusive(startDate, dueDate) : 0;
  const ownerNames = "ownerNames" in view ? view.ownerNames : undefined;
  /** 写回响应不带姓名时：先查用户目录（调用方传 resolveName），查不到再按 id 对回旧行的姓名，最后才「—」。 */
  const previousIds = previous?.ownerIds ?? [];
  const owners =
    ownerNames === undefined
      ? view.ownerIds.map((id) => {
          const resolved = resolveName?.(id);
          if (resolved !== undefined && resolved !== "") {
            return resolved;
          }
          const at = previousIds.indexOf(id);
          return at < 0 ? "—" : (previous?.owners[at] ?? "—");
        })
      : ownerNames.map((name) => (name === null || name === "" ? "—" : name));
  return {
    id: view.id,
    nodeId: view.nodeId,
    sourceNodeId: view.sourceNodeId ?? null,
    stageKey: view.stageKey,
    stage: stageNameOf(view.stageKey),
    sortIndex: view.sortIndex,
    title: view.title,
    titleEn: view.titleEn ?? "",
    ownerIds: [...view.ownerIds],
    owners,
    status: displayStatusLabel(view.displayStatus),
    progress: view.progress,
    startDate,
    dueDate,
    doneDate: view.actualEnd ?? "",
    days: view.estimatedDays ?? derivedDays,
    deliverableTypes: [...view.deliverableTypes],
    files: fileSummaryOf("fileSummary" in view ? view.fileSummary : previous?.files),
    changes: changeLinksOf(view.changeLinks),
    onTime: view.onTime,
    note: view.note ?? "",
    headcount: view.headcount ?? 0,
    priority: priorityOf(view.priority),
    finalizedAt: view.finalizedAt ?? null,
    version: view.version,
  };
}

export function fetchProjectTasks(projectId: string): Promise<ApiTaskListResult> {
  return readAllPages<ApiTaskListItem>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks",
  );
}

export function fetchProjectSummary(projectId: string): Promise<ApiProjectSummary> {
  return apiRequest<ApiProjectSummary>("/api/v1/projects/" + encodeURIComponent(projectId) + "/summary");
}

export function fetchTaskDetail(projectId: string, taskId: string): Promise<ApiTaskDetail> {
  return apiRequest<ApiTaskDetail>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId),
  );
}

/** 创建任务（节点生成 / 手工创建）：响应 = 契约 Task（不带姓名与文件摘要，调用方随后重取列表）。 */
export function createTask(projectId: string, body: TaskCreateInput): Promise<ApiTask> {
  return apiSend<ApiTask>("/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks", "POST", body);
}

export type TaskCreateInput = {
  stageKey: string | null;
  sortIndex?: number;
  title: string;
  titleEn?: string | null;
  /** 来源流程节点（project_nodes；成员可建，按项目判重）。 */
  taskNodeId?: string;
  /** 来源任务节点库节点（task_nodes；M3-07 刀 3）—— 描述 / 英文名 / 阶段取节点现值，与 taskNodeId 二选一。 */
  sourceNodeId?: string;
  ownerIds?: string[];
  plannedStart?: string | null;
  plannedEnd?: string | null;
  estimatedDays?: number | null;
  headcount?: number | null;
  priority?: string | null;
  deliverableTypes?: string[];
  note?: string | null;
};

/** 模板实例化入参（契约 TaskCreateFromTemplateBody · `POST …/tasks/from-template`）。 */
export type TaskFromTemplateInput = {
  templateId: string;
  /** 只加模板内的部分节点（缺省 = 模板全部节点）；顺序仍按模板内顺序。 */
  nodeIds?: string[];
  /** 已存在的节点跳过并计入 skipped（默认 true）；false 时遇重复整批 409。 */
  skipExisting?: boolean;
  ownerIds?: string[];
  /** 起始插入位次（缺省 / 越界 = 组尾）。 */
  sortIndex?: number;
  priority?: string | null;
};

/** 模板实例化结果：created = 新建的任务（模板内顺序）；skipped = 已存在而跳过的节点 + 既有任务 id。 */
export type TaskFromTemplateResult = {
  created: ApiTask[];
  skipped: Array<{ nodeId: string; taskId: string }>;
};

/** 编辑可写字段（契约 TaskUpdateBody 白名单；阶段不在此；任务描述仅临时任务可改）。 */
/** 「整套添加」（A1-16）：一次调用整批生成，服务端同事务 + 按节点判重（已存在的进 skipped）。 */
export function createTasksFromTemplate(projectId: string, body: TaskFromTemplateInput): Promise<TaskFromTemplateResult> {
  return apiSend<TaskFromTemplateResult>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/from-template",
    "POST",
    body,
  );
}

export type TaskUpdateInput = {
  /** 任务描述（中文；Push 196）：仅**无来源节点**的临时任务可改（服务端对节点任务 400 拦截）。 */
  title?: string;
  /** 任务描述（英文；Push 196）：同 title；null = 清空。 */
  titleEn?: string | null;
  ownerIds?: string[];
  sortIndex?: number;
  status?: string;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  estimatedDays?: number | null;
  headcount?: number | null;
  priority?: string | null;
  /** 输出成果文件（2026-10-08 · 业务口径「文件输出成果也要可以选择」）：传数组 = 整体替换（去重保序）、[] = 不要求。 */
  deliverableTypes?: string[];
  note?: string | null;
  version: number;
};

export function updateTask(projectId: string, taskId: string, body: TaskUpdateInput): Promise<ApiTask> {
  return apiSend<ApiTask>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId),
    "PATCH",
    body,
  );
}

/** 进度写入（联动状态与完成日期）：响应 = TaskListItem（整行，可直接替换列表行）。 */
export function updateTaskProgress(
  projectId: string,
  taskId: string,
  body: { progress: number; actualEnd?: string; note?: string; version: number },
): Promise<ApiTaskListItem> {
  return apiSend<ApiTaskListItem>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId) + "/progress",
    "PATCH",
    body,
  );
}

/** 任务定档（Push 252 · 抽屉头部「定档」开关 + 二次确认）：未定档 → 置位并锁定（此后写口 409 TASK_FINALIZED）；已定档 → 幂等原样返回。 */
export function finalizeTask(projectId: string, taskId: string, version: number): Promise<ApiTask> {
  return apiSend<ApiTask>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId) + "/finalize",
    "POST",
    { version },
  );
}

/** 任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：抽屉「已」开关再次点击 → 二次确认后调用；已定档 → 清位重开（此后可修改）；未定档 → 幂等原样返回。 */
export function unfinalizeTask(projectId: string, taskId: string, version: number): Promise<ApiTask> {
  return apiSend<ApiTask>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId) + "/unfinalize",
    "POST",
    { version },
  );
}

/** 删除任务（软删）：版本走 If-Match 请求头；响应只回标记。 */
export function deleteTask(projectId: string, taskId: string, version: number): Promise<{ id: string; deleted: boolean }> {
  return apiRequest<{ id: string; deleted: boolean }>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId),
    { method: "DELETE", headers: { "If-Match": String(version) } },
  );
}

/** 写入冲突 / 不可写时的统一文案（Push 301：随语言切换；409 VERSION_CONFLICT 由调用方负责重取列表）。 */
export function taskWriteMessage(locale: Locale, error: { code: string; message: string }): string {
  if (error.code === "VERSION_CONFLICT") {
    return textOf(locale, "tw.versionConflict");
  }
  if (error.code === "PROJECT_ARCHIVED") {
    return textOf(locale, "tw.archived");
  }
  if (error.code === "TASK_FINALIZED") {
    return textOf(locale, "tw.finalized");
  }
  if (error.code === "TASK_HAS_REFERENCES") {
    return textOf(locale, "tw.hasReferences");
  }
  if (error.code === "TASK_ALREADY_EXISTS") {
    return textOf(locale, "tw.alreadyExists");
  }
  return error.message;
}
