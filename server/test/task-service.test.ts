import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type {
  TaskChangeLinkRow,
  TaskEventInput,
  TaskFileSummaryCounts,
  TaskListRow,
  TaskCompletionTargetRow,
  TaskProjectNodeRow,
  TaskProjectRow,
  TaskInsertInput,
  TaskRow,
  TaskUpdatePatch,
} from "../src/modules/task/task.repository.js";
import { TaskRepository } from "../src/modules/task/task.repository.js";
import type { TaskGateRepository } from "../src/modules/task/task.gate.repository.js";
import { shanghaiToday } from "../src/modules/task/task.rules.js";
import { TaskService } from "../src/modules/task/task.service.js";
import type { TaskNodeRepository, TemplateService } from "../src/modules/template/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const MANAGER = "caa8d763-4b6a-4967-9b26-7d1086272c9c";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const MANAGER_2 = "b0f1c9d2-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    projectId: PROJECT,
    stageKey: "install",
    nodeId: NODE,
    taskNodeId: null,
    title: "货架组装",
    titleEn: null,
    ownerIds: [MANAGER],
    status: "pending",
    statusOverride: null,
    progress: "0",
    sortIndex: 0,
    plannedStart: null,
    plannedEnd: null,
    actualEnd: null,
    estimatedDays: null,
    headcount: null,
    priority: null,
    deliverableTypes: [],
    note: null,
    onTime: null,
    changeRefs: [],
    version: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    deletedAt: null,
    deletedBy: null,
    finalizedAt: null,
    finalizedBy: null,
    ...overrides,
  };
}

class FakeTaskRepository {
  project: TaskProjectRow | null = { id: PROJECT, managerIds: [MANAGER], stageKey: "presale", status: "active" };
  node: TaskProjectNodeRow | null = { id: NODE, stageKey: "install", status: "active" };
  existingTaskId: string | null = null;
  task: TaskRow | null = makeRow();
  /** 变更关联（A1-07 多条）：列表 / 详情随行下发，测试按需替换。 */
  changeLinks: TaskChangeLinkRow[] = [];
  /** listChangeLinks 收到的 change_refs（追加序）。 */
  changeLinkQueries: string[][] = [];
  inserted: TaskRow | null = null;
  events: TaskEventInput[] = [];
  touched: string[] = [];
  counts = { overdue: 0, done: 0, total: 0 };
  /** 按阶段计数（summary 两阶段字段的输入；口径同 GET /projects/{id}/stages）。 */
  perStage: { stageKey: string | null; status: string; value: number }[] = [];

  async summaryCounts(): Promise<{ overdue: number; done: number; total: number }> {
    return this.counts;
  }
  async listPage(): Promise<{ items: TaskListRow[]; total: number }> {
    return { items: [], total: 0 };
  }
  async findListRowById(): Promise<TaskListRow | null> {
    return this.task === null
      ? null
      : {
          task: this.task,
          ownerNames: ["张三"],
          changeLinks: this.changeLinks,
        };
  }
  async listFiles(): Promise<never[]> {
    return [];
  }
  /** 写路径响应回读变更关联（edit / complete 不改动已有 change_refs）。 */
  async listChangeLinks(changeRefs: readonly string[]): Promise<TaskChangeLinkRow[]> {
    this.changeLinkQueries.push([...changeRefs]);
    return this.changeLinks.filter((link) => changeRefs.includes(link.id));
  }
  async fileSummaries(): Promise<Map<string, TaskFileSummaryCounts>> {
    return new Map();
  }
  async findProject(): Promise<TaskProjectRow | null> {
    return this.project;
  }
  async findProjectNode(): Promise<TaskProjectNodeRow | null> {
    return this.node;
  }
  async findTaskIdByNode(): Promise<string | null> {
    return this.existingTaskId;
  }
  async lockTask(): Promise<TaskRow | null> {
    return this.task;
  }
  async findCompletionTarget(): Promise<TaskCompletionTargetRow | null> {
    return this.task === null
      ? null
      : {
          id: this.task.id,
          projectId: this.task.projectId,
          nodeId: this.task.nodeId,
          status: this.task.status,
          deliverableTypes: this.task.deliverableTypes,
        };
  }
  group: { id: string; sortIndex: number }[] = [];
  groupSize = 0;
  shifted: { from: number; to: number | null; delta: number }[] = [];

  async insert(input: TaskInsertInput): Promise<TaskRow> {
    const row = makeRow({ id: TASK, status: "pending", progress: "0", version: 0, title: input.title, stageKey: input.stageKey, nodeId: input.nodeId, ownerIds: input.ownerIds, sortIndex: input.sortIndex });
    this.inserted = row;
    return row;
  }
  async updateWithVersion(_taskId: string, expectedVersion: number, patch: TaskUpdatePatch, at: Date): Promise<TaskRow | null> {
    const current = this.task;
    if (current === null || current.version !== expectedVersion) return null;
    const next: TaskRow = {
      ...current,
      title: patch.title !== undefined ? patch.title : current.title,
      titleEn: patch.titleEn !== undefined ? patch.titleEn : current.titleEn,
      ownerIds: patch.ownerIds !== undefined ? patch.ownerIds : current.ownerIds,
      status: patch.status ?? current.status,
      statusOverride: patch.statusOverride !== undefined ? patch.statusOverride : current.statusOverride,
      progress: patch.progress ?? current.progress,
      sortIndex: patch.sortIndex !== undefined ? patch.sortIndex : current.sortIndex,
      plannedStart: patch.plannedStart !== undefined ? patch.plannedStart : current.plannedStart,
      plannedEnd: patch.plannedEnd !== undefined ? patch.plannedEnd : current.plannedEnd,
      actualEnd: patch.actualEnd !== undefined ? patch.actualEnd : current.actualEnd,
      estimatedDays: patch.estimatedDays !== undefined ? patch.estimatedDays : current.estimatedDays,
      headcount: patch.headcount !== undefined ? patch.headcount : current.headcount,
      priority: patch.priority !== undefined ? patch.priority : current.priority,
      deliverableTypes: patch.deliverableTypes !== undefined ? patch.deliverableTypes : current.deliverableTypes,
      note: patch.note !== undefined ? patch.note : current.note,
      finalizedAt: patch.finalizedAt !== undefined ? patch.finalizedAt : current.finalizedAt,
      finalizedBy: patch.finalizedBy !== undefined ? patch.finalizedBy : current.finalizedBy,
      updatedAt: at,
      version: current.version + 1,
    };
    this.task = next;
    return next;
  }
  async insertEvents(_tx: DbClient, events: readonly TaskEventInput[]): Promise<void> {
    this.events.push(...events);
  }
  async touchProject(projectId: string): Promise<void> {
    this.touched.push(projectId);
  }
  /** 定档兜底撤销调用记录（防绕过补漏）。 */
  abortedTaskUploadSessions: { taskId: string; at: Date }[] = [];
  abortedTaskSessionCount = 0;
  async abortActiveTaskUploadSessions(taskId: string, at: Date): Promise<number> {
    this.abortedTaskUploadSessions.push({ taskId, at });
    return this.abortedTaskSessionCount;
  }
  async countStageTasks(): Promise<{ total: number; done: number }> {
    return { total: 0, done: 0 };
  }
  async findTaskBrief(): Promise<{ id: string; projectId: string; stageKey: string | null; sortIndex: number } | null> {
    return this.task === null
      ? null
      : { id: this.task.id, projectId: this.task.projectId, stageKey: this.task.stageKey, sortIndex: this.task.sortIndex };
  }
  async countGroup(): Promise<number> {
    return this.groupSize;
  }
  async listGroupOrder(): Promise<{ id: string; sortIndex: number }[]> {
    return this.group;
  }
  async shiftGroupIndexes(
    _projectId: string,
    _stageKey: string | null,
    from: number,
    to: number | null,
    delta: number,
  ): Promise<void> {
    this.shifted.push({ from, to, delta });
    for (const row of this.group) {
      if (row.sortIndex >= from && (to === null || row.sortIndex <= to)) row.sortIndex += delta;
    }
  }
  async taskCountsByStage(): Promise<{ stageKey: string | null; status: string; value: number }[]> {
    return this.perStage;
  }
}

/** 门禁替身（M3-03）：默认放行；用例可注入要求与计数（缺件 / draft 提示）。 */
class FakeTaskGateRepository {
  requirements: { docType: string; minCount: number }[] = [];
  finalCounts: { docType: string; present: number }[] = [];
  draftCounts: { docType: string; present: number }[] = [];
  async listNodeDocRequirements(): Promise<{ docType: string; minCount: number }[]> {
    return this.requirements;
  }
  async countFinalFiles(): Promise<{ docType: string; present: number }[]> {
    return this.finalCounts;
  }
  async countDraftFiles(): Promise<{ docType: string; present: number }[]> {
    return this.draftCounts;
  }
}

class FakePermissionService {
  groupAccessAdmin = false;
  projectManager = false;

  async assertProjectVisible(_actorId: string, projectId: string): Promise<{ projectId: string; member: boolean; projectManager: boolean }> {
    return { projectId, member: true, projectManager: this.projectManager };
  }

  async canManageGroupAccess(): Promise<boolean> {
    return this.groupAccessAdmin;
  }
}

class FakeDatabase {
  outbox: unknown[] = [];
  db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(this.makeTx()),
  };
  makeTx() {
    return {
      insert: () => ({
        values: async (value: unknown) => {
          this.outbox.push(value);
        },
      }),
    };
  }
}

/** 审计替身（h7）：只记录写入调用。 */
class FakeAuditService {
  entries: unknown[] = [];
  async record(_client: unknown, input: unknown): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(
  repo: FakeTaskRepository,
  permission: FakePermissionService = new FakePermissionService(),
  gate: FakeTaskGateRepository = new FakeTaskGateRepository(),
  audit: FakeAuditService = new FakeAuditService(),
): TaskService {
  const database = new FakeDatabase();
  return new TaskService(
    database as unknown as DatabaseService,
    repo as unknown as TaskRepository,
    gate as unknown as TaskGateRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    {} as unknown as TaskNodeRepository,
    {} as unknown as TemplateService,
  );
}

describe("TaskService.create（A10 / A1-13）", () => {
  it("带节点创建：ownerIds 缺省 = 「待分配」空数组（2026-09-24 业务口径：不兜底项目经理），状态 pending / 进度 0，写 outbox 与项目触点", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo);
    const created = await service.create(
      PROJECT,
      { stageKey: "install", title: "货架组装", taskNodeId: NODE },
      ACTOR,
    );
    expect(created.ownerIds).toEqual([]);
    expect(created.status).toBe("pending");
    expect(created.progress).toBe(0);
    expect(repo.touched).toEqual([PROJECT]);
  });

  it("ownerIds 口径（2026-09-24 修订）：缺省 = 「待分配」空数组；显式传多位经理 = 原样保留（顺序 = 传入顺序）", async () => {
    const repo = new FakeTaskRepository();
    repo.project = { id: PROJECT, managerIds: [MANAGER, MANAGER_2], stageKey: "presale", status: "active" };
    const service = makeService(repo);
    const blank = await service.create(PROJECT, { stageKey: "install", title: "货架组装", taskNodeId: NODE }, ACTOR);
    expect(blank.ownerIds).toEqual([]);
    const repo2 = new FakeTaskRepository();
    repo2.project = { id: PROJECT, managerIds: [MANAGER, MANAGER_2], stageKey: "presale", status: "active" };
    const assigned = await makeService(repo2).create(
      PROJECT,
      { stageKey: "install", title: "货架组装", taskNodeId: NODE, ownerIds: [MANAGER_2, MANAGER] },
      ACTOR,
    );
    expect(assigned.ownerIds).toEqual([MANAGER_2, MANAGER]);
  });

  it("节点判重 → 409 TASK_ALREADY_EXISTS", async () => {
    const repo = new FakeTaskRepository();
    repo.existingTaskId = TASK;
    const service = makeService(repo);
    await expect(service.create(PROJECT, { stageKey: "install", title: "货架组装", taskNodeId: NODE }, ACTOR)).rejects.toMatchObject({
      code: "TASK_ALREADY_EXISTS",
      httpStatus: 409,
    });
  });

  it("手工创建（无节点）非管理员 → 403；管理员 → 放行", async () => {
    const repo = new FakeTaskRepository();
    const permission = new FakePermissionService();
    const service = makeService(repo, permission);
    await expect(service.create(PROJECT, { stageKey: "install", title: "临时任务" }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
    permission.groupAccessAdmin = true;
    const created = await service.create(PROJECT, { stageKey: "install", title: "临时任务" }, ACTOR);
    expect(created.title).toBe("临时任务");
  });

  it("stageKey 与来源节点阶段不一致 → 400", async () => {
    const repo = new FakeTaskRepository();
    repo.node = { id: NODE, stageKey: "install", status: "active" };
    const service = makeService(repo);
    await expect(service.create(PROJECT, { stageKey: "deploy", title: "货架组装", taskNodeId: NODE }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("归档项目 → 409 PROJECT_ARCHIVED", async () => {
    const repo = new FakeTaskRepository();
    repo.project = { id: PROJECT, managerIds: [MANAGER], stageKey: "acceptance", status: "archived" };
    const service = makeService(repo);
    await expect(service.create(PROJECT, { stageKey: "install", title: "货架组装", taskNodeId: NODE }, ACTOR)).rejects.toMatchObject({
      code: "PROJECT_ARCHIVED",
      httpStatus: 409,
    });
  });
});

describe("TaskService.update（A12 状态联动 + 乐观锁 + 留痕）", () => {
  it("status=done → 进度满格 + 完成日期按当天补，留痕 status / progress / date 三类", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5" });
    const service = makeService(repo);
    const updated = await service.update(PROJECT, TASK, { status: "done", version: 3 }, ACTOR);
    expect(updated.status).toBe("done");
    expect(updated.progress).toBe(1);
    expect(updated.actualEnd).toBe(shanghaiToday(new Date()));
    expect(updated.displayStatus).toBe("done");
    expect(repo.events.map((event) => event.eventType)).toEqual(["status_change", "progress_change", "date_change"]);
    expect(repo.touched).toEqual([PROJECT]);
  });

  it("status=active（已满格）→ 退回 0.75 并清完成日期", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "done", progress: "1", actualEnd: "2026-09-10" });
    const service = makeService(repo);
    const updated = await service.update(PROJECT, TASK, { status: "active", version: 3 }, ACTOR);
    expect(updated.status).toBe("active");
    expect(updated.progress).toBe(0.75);
    expect(updated.actualEnd).toBeNull();
  });

  it("过期未完成的展示态保持「已延期」（派生优先，不因写状态改写）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5", plannedEnd: "2020-01-01" });
    const service = makeService(repo);
    const updated = await service.update(PROJECT, TASK, { status: "done", version: 3 }, ACTOR);
    expect(updated.status).toBe("done");
    const overdueRow = makeRow({ status: "pending", progress: "0.25", plannedEnd: "2020-01-01" });
    repo.task = overdueRow;
    const stillOverdue = await service.update(PROJECT, TASK, { status: "pending", version: 3 }, ACTOR);
    expect(stillOverdue.displayStatus).toBe("overdue");
  });
  it("status=overdue（已延期）→ 保持当前格数与完成日期、只落覆盖；展示态 = 已延期", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5", plannedEnd: "2026-12-31" });
    const updated = await makeService(repo).update(PROJECT, TASK, { status: "overdue", version: 3 }, ACTOR);
    expect(updated.status).toBe("active");
    expect(updated.progress).toBe(0.5);
    expect(updated.actualEnd).toBeNull();
    expect(updated.displayStatus).toBe("overdue");
    expect(repo.events.map((event) => event.eventType)).toEqual(["status_change"]);
  });

  it("status=early_done（提前完成）→ 四格全亮 + 缺省当天完成日期 + 覆盖；展示态 = 提前完成", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5" });
    const updated = await makeService(repo).update(PROJECT, TASK, { status: "early_done", version: 3 }, ACTOR);
    expect(updated.status).toBe("done");
    expect(updated.progress).toBe(1);
    expect(updated.actualEnd).toBe(shanghaiToday(new Date()));
    expect(updated.displayStatus).toBe("early_done");
  });

  it("写基础三态清覆盖：已延期覆盖 → pending 后展示态回派生", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5", statusOverride: "overdue", plannedEnd: "2026-12-31" });
    const updated = await makeService(repo).update(PROJECT, TASK, { status: "pending", version: 3 }, ACTOR);
    expect(updated.displayStatus).toBe("pending");
  });

  it("乐观锁冲突（stale version）→ 409 VERSION_CONFLICT", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo);
    await expect(service.update(PROJECT, TASK, { status: "done", version: 2 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
  });

  it("任务不属于该项目 → 404", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ projectId: "44444444-4444-4444-8444-444444444444" });
    const service = makeService(repo);
    await expect(service.update(PROJECT, TASK, { status: "done", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("临时任务（未归入阶段、无来源节点）改任务描述：title / titleEn 落库 + 版本 +1 + 审计含 title、不写 task_events（Push 196）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ stageKey: null, nodeId: null, taskNodeId: null, title: "临时任务", titleEn: null });
    const audit = new FakeAuditService();
    const service = makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit);
    const updated = await service.update(PROJECT, TASK, { title: "临时任务（改名）", titleEn: "Ad hoc task", version: 3 }, ACTOR);
    expect(updated.title).toBe("临时任务（改名）");
    expect(updated.titleEn).toBe("Ad hoc task");
    expect(repo.task?.version).toBe(4);
    // 任务描述不属于 task_events 四值闭集（status / progress / date / note）：改名只进审计
    expect(repo.events).toEqual([]);
    const entry = audit.entries.at(-1) as { changes: Array<{ field: string; to: unknown }> };
    expect(entry.changes.some((change) => change.field === "title" && change.to === "临时任务（改名）")).toBe(true);
    expect(entry.changes.some((change) => change.field === "titleEn" && change.to === "Ad hoc task")).toBe(true);
  });

  it("临时任务清空英文名（titleEn=null）→ 落库为 null", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ stageKey: null, nodeId: null, taskNodeId: null, title: "临时任务", titleEn: "Ad hoc task" });
    const updated = await makeService(repo).update(PROJECT, TASK, { titleEn: null, version: 3 }, ACTOR);
    expect(updated.titleEn).toBeNull();
    expect(updated.title).toBe("临时任务");
  });

  it("节点 / 模板生成的任务改任务描述 → 400 VALIDATION_FAILED，不落库（A1-17 锁定）", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo);
    await expect(service.update(PROJECT, TASK, { title: "改个名", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(repo.task?.title).toBe("货架组装");
    expect(repo.task?.version).toBe(3);
  });

  it("节点库来源（taskNodeId 非空）的任务同样锁定：titleEn 改不动 → 400", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ nodeId: null, taskNodeId: "55555555-5555-4555-8555-555555555555" });
    await expect(makeService(repo).update(PROJECT, TASK, { titleEn: "Renamed", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
  });

  it("阶段任务（stageKey 非空）即便没有来源节点也锁定：改名 → 400（Push 197 收窄）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ stageKey: "assembly", nodeId: null, taskNodeId: null });
    await expect(makeService(repo).update(PROJECT, TASK, { title: "改个名", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(repo.task?.title).toBe("货架组装");
    expect(repo.task?.version).toBe(3);
  });

  it("输出成果文件常规编辑开放（2026-10-08「文件输出成果也要可以选择」）：节点任务可直接改、去重保序、版本 +1 + 审计含 deliverableTypes", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ deliverableTypes: ["技术协议"] });
    const audit = new FakeAuditService();
    const service = makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit);
    const updated = await service.update(PROJECT, TASK, { deliverableTypes: ["CAD图纸", "技术协议", "CAD图纸"], version: 3 }, ACTOR);
    expect(updated.deliverableTypes).toEqual(["CAD图纸", "技术协议"]);
    expect(repo.task?.version).toBe(4);
    expect(repo.events).toEqual([]);
    const entry = audit.entries.at(-1) as { changes: Array<{ field: string; to: unknown }> };
    expect(entry.changes.some((change) => change.field === "deliverableTypes" && JSON.stringify(change.to) === JSON.stringify(["CAD图纸", "技术协议"]))).toBe(true);
  });

  it("输出成果文件清空（显式 []）→ 空数组 = 不要求；未知类型被过滤", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ deliverableTypes: ["验收单", "非字典值"] });
    const updated = await makeService(repo).update(PROJECT, TASK, { deliverableTypes: [], version: 3 }, ACTOR);
    expect(updated.deliverableTypes).toEqual([]);
  });
});

describe("TaskService.updateProgress（A13 清除完成日期的唯一方式）", () => {
  it("从已完成写回 0.75 → 进行中、清完成日期", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "done", progress: "1", actualEnd: "2026-09-10" });
    const service = makeService(repo);
    const updated = await service.updateProgress(PROJECT, TASK, { progress: 0.75, version: 3 }, ACTOR);
    expect(updated.status).toBe("active");
    expect(updated.progress).toBe(0.75);
    expect(updated.actualEnd).toBeNull();
    expect(repo.events.map((event) => event.eventType)).toContain("date_change");
    expect(repo.touched).toEqual([PROJECT]);
  });

  it("progress=1 显式完成日期 → 采用传入值", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.75", plannedEnd: "2026-12-31" });
    const service = makeService(repo);
    const updated = await service.updateProgress(PROJECT, TASK, { progress: 1, actualEnd: "2026-09-15", version: 3 }, ACTOR);
    expect(updated.status).toBe("done");
    expect(updated.actualEnd).toBe("2026-09-15");
    expect(updated.displayStatus).toBe("early_done");
  });

  it("点进度条清显式覆盖（与原型一致：进度写入即回派生）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ status: "active", progress: "0.5", statusOverride: "overdue", plannedEnd: "2026-12-31" });
    const updated = await makeService(repo).updateProgress(PROJECT, TASK, { progress: 0.75, version: 3 }, ACTOR);
    expect(updated.displayStatus).toBe("active");
    expect(repo.events.map((event) => event.eventType)).toContain("status_change");
  });
});

describe("TaskService w2 落库口径（A15 / A18 / A19 / A20 · Push 124）", () => {
  it("临时任务：stageKey 缺省 = 「未分组」、ownerIds 显式 [] = 「待分配」（不兜底项目经理）", async () => {
    const repo = new FakeTaskRepository();
    const permission = new FakePermissionService();
    permission.groupAccessAdmin = true;
    const service = makeService(repo, permission);
    const created = await service.create(PROJECT, { title: "临时任务", ownerIds: [] }, ACTOR);
    expect(created.stageKey).toBeNull();
    expect(created.ownerIds).toEqual([]);
  });

  it("带节点创建：stageKey 缺省取来源节点阶段；sortIndex 缺省 = 组尾（不平移）", async () => {
    const repo = new FakeTaskRepository();
    repo.groupSize = 3;
    const service = makeService(repo);
    const created = await service.create(PROJECT, { title: "货架组装", taskNodeId: NODE }, ACTOR);
    expect(created.stageKey).toBe("install");
    expect(created.sortIndex).toBe(3);
    expect(repo.shifted).toEqual([]);
  });

  it("插入位置：sortIndex=0 → 同组其余任务位次顺延（+1），新任务落 0 位", async () => {
    const repo = new FakeTaskRepository();
    repo.groupSize = 3;
    const permission = new FakePermissionService();
    permission.groupAccessAdmin = true;
    const service = makeService(repo, permission);
    const created = await service.create(PROJECT, { title: "临时任务", sortIndex: 0 }, ACTOR);
    expect(created.sortIndex).toBe(0);
    expect(repo.shifted).toEqual([{ from: 0, to: null, delta: 1 }]);
  });

  it("负责人显式置空：PATCH ownerIds=[] → 待分配（不保留原值）", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo);
    const updated = await service.update(PROJECT, TASK, { ownerIds: [], version: 3 }, ACTOR);
    expect(updated.ownerIds).toEqual([]);
  });

  it("拖动排序：移到组首 → 同组其余顺延；越界 = 组尾", async () => {
    const repo = new FakeTaskRepository();
    const other1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const other2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    repo.task = makeRow({ sortIndex: 1 });
    repo.group = [
      { id: other1, sortIndex: 0 },
      { id: TASK, sortIndex: 1 },
      { id: other2, sortIndex: 2 },
    ];
    const service = makeService(repo);
    const moved = await service.update(PROJECT, TASK, { sortIndex: 0, version: 3 }, ACTOR);
    expect(moved.sortIndex).toBe(0);
    expect(repo.shifted).toEqual([{ from: 0, to: 0, delta: 1 }]);

    repo.task = makeRow({ sortIndex: 0 });
    repo.shifted = [];
    repo.group = [
      { id: TASK, sortIndex: 0 },
      { id: other1, sortIndex: 1 },
      { id: other2, sortIndex: 2 },
    ];
    const toEnd = await service.update(PROJECT, TASK, { sortIndex: 99, version: 3 }, ACTOR);
    expect(toEnd.sortIndex).toBe(2);
    expect(repo.shifted).toEqual([{ from: 1, to: 2, delta: -1 }]);
  });
});

describe("TaskService.summary（汇总卡：最慢 / 最新阶段 + 三计数）", () => {
  it("最慢 = 九阶段序第一个存在未完成任务的阶段；最新 = 已动工任务里阶段序最靠后的阶段", async () => {
    const repo = new FakeTaskRepository();
    repo.counts = { overdue: 2, done: 5, total: 9 };
    repo.perStage = [
      { stageKey: "presale", status: "done", value: 1 },
      { stageKey: "design", status: "active", value: 1 },
      { stageKey: "purchase", status: "pending", value: 1 },
      { stageKey: "install", status: "done", value: 2 },
      { stageKey: null, status: "pending", value: 1 },
    ];
    const summary = await makeService(repo).summary(PROJECT);
    expect(summary).toEqual({
      projectId: PROJECT,
      slowestStage: "design",
      latestStage: "install",
      overdue: 2,
      done: 5,
      total: 9,
    });
  });

  it("全部完成 → 最慢为 null（未分组不参与判定）；尚无任务动工 → 最新为 null", async () => {
    const repo = new FakeTaskRepository();
    repo.perStage = [
      { stageKey: "presale", status: "done", value: 2 },
      { stageKey: null, status: "pending", value: 1 },
    ];
    const allDone = await makeService(repo).summary(PROJECT);
    expect(allDone.slowestStage).toBeNull();
    expect(allDone.latestStage).toBe("presale");

    repo.perStage = [
      { stageKey: "assembly", status: "pending", value: 3 },
      { stageKey: "install", status: "pending", value: 1 },
    ];
    const notStarted = await makeService(repo).summary(PROJECT);
    expect(notStarted.slowestStage).toBe("assembly");
    expect(notStarted.latestStage).toBeNull();
  });
});

describe("变更关联多条（A1-07 / R01 · Push 144）", () => {
  const CHANGE_1 = "aaaa1111-1111-4111-8111-111111111111";
  const CHANGE_2 = "bbbb2222-2222-4222-8222-222222222222";

  it("详情随行 changeLinks = change_refs 追加序（多条 + 原因截断，全文留给变更记录）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ changeRefs: [CHANGE_1, CHANGE_2] });
    repo.changeLinks = [
      { id: CHANGE_1, reason: "首次变更：孔位调整", appliedAt: "2026-09-20T02:00:00.000Z" },
      { id: CHANGE_2, reason: "x".repeat(50), appliedAt: "2026-09-21T02:00:00.000Z" },
    ];

    const detail = await makeService(repo).detail(PROJECT, TASK);

    expect(detail.changeLinks.map((link) => link.id)).toEqual([CHANGE_1, CHANGE_2]);
    expect(detail.changeLinks[0]).toEqual({
      id: CHANGE_1,
      reason: "首次变更：孔位调整",
      appliedAt: "2026-09-20T02:00:00.000Z",
    });
    expect(detail.changeLinks[1]!.reason).toBe("x".repeat(40) + "…");
  });

  it("编辑响应回读 change_refs：既有变更关联不被响应清空", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ changeRefs: [CHANGE_1] });
    repo.changeLinks = [{ id: CHANGE_1, reason: "设计变更", appliedAt: "2026-09-20T02:00:00.000Z" }];

    const updated = await makeService(repo).update(PROJECT, TASK, { version: 3, note: "改备注" }, ACTOR);

    expect(repo.changeLinkQueries).toEqual([[CHANGE_1]]);
    expect(updated.changeLinks.map((link) => link.id)).toEqual([CHANGE_1]);
  });

  it("无关联任务：changeLinks = []（空数组不下发 null）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ changeRefs: [] });

    const detail = await makeService(repo).detail(PROJECT, TASK);

    expect(detail.changeLinks).toEqual([]);
  });
});


describe("任务定档写口闸（Push 249 · 业务口径「若是则上传文件后该任务定档不支持任何修改」）", () => {
  const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");

  it("定档任务：编辑 → 409 TASK_FINALIZED（details 带定档时间）；批量 → failures 的 finalized", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: ACTOR });

    await expect(
      makeService(repo).update(PROJECT, TASK, { version: 3, note: "改备注" }, ACTOR),
    ).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      details: [{ code: "task_finalized", path: "finalizedAt" }],
    });

    const batch = await makeService(repo).batch(PROJECT, { ids: [TASK], changes: { note: "批量改" } }, ACTOR);
    expect(batch.succeededCount).toBe(0);
    expect(batch.failedCount).toBe(1);
    expect(batch.failures[0]).toMatchObject({ id: TASK, code: "finalized" });
  });

  it("定档任务：进度 / 完成 一律 409 TASK_FINALIZED", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: ACTOR });

    await expect(
      makeService(repo).updateProgress(PROJECT, TASK, { version: 3, progress: 0.5 }, ACTOR),
    ).rejects.toMatchObject({ code: "TASK_FINALIZED" });

    await expect(
      makeService(repo).complete(PROJECT, TASK, { version: 3 }, ACTOR),
    ).rejects.toMatchObject({ code: "TASK_FINALIZED" });
  });

  it("未定档任务：同一写口照常（对照）；响应 finalizedAt / finalizedBy = null", async () => {
    const repo = new FakeTaskRepository();
    const updated = await makeService(repo).update(PROJECT, TASK, { version: 3, note: "改备注" }, ACTOR);
    expect(updated.note).toBe("改备注");
    expect(updated.finalizedAt).toBeNull();
    expect(updated.finalizedBy).toBeNull();
  });

  it("详情 / 编辑响应下发 finalizedAt（ISO）/ finalizedBy（成对）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: ACTOR });

    const detail = await makeService(repo).detail(PROJECT, TASK);
    expect(detail.finalizedAt).toBe(FINALIZED_AT.toISOString());
    expect(detail.finalizedBy).toBe(ACTOR);
  });
});

describe("任务定档入口（Push 252 · 抽屉「定档」开关 + 二次确认）", () => {
  it("任务负责人：未定档任务 finalize 置位 finalizedAt / finalizedBy + version+1 + 审计「任务定档」+ 项目触点", async () => {
    const repo = new FakeTaskRepository();
    const audit = new FakeAuditService();
    repo.abortedTaskSessionCount = 3;
    const updated = await makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit).finalize(PROJECT, TASK, { version: 3 }, MANAGER);
    expect(updated.finalizedAt).not.toBeNull();
    expect(updated.finalizedBy).toBe(MANAGER);
    expect(updated.version).toBe(4);
    expect(repo.task?.finalizedAt).not.toBeNull();
    expect(repo.touched).toEqual([PROJECT]);
    expect(repo.abortedTaskUploadSessions).toEqual([{ taskId: TASK, at: expect.any(Date) }]);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as { action: string; objectType: string; objectId: string; summary: string; metadata?: unknown };
    expect(entry.action).toBe("update");
    expect(entry.objectType).toBe("task");
    expect(entry.objectId).toBe(TASK);
    expect(entry.summary).toContain("任务定档");
    expect(entry.metadata).toEqual({ abortedUploadSessions: 3 });
  });

  it("已定档任务：负责人 finalize 幂等短路（原样返回、不递增版本、不再写审计）", async () => {
    const repo = new FakeTaskRepository();
    const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: MANAGER, version: 7 });
    const audit = new FakeAuditService();
    const returned = await makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit).finalize(PROJECT, TASK, { version: 7 }, MANAGER);
    expect(returned.finalizedAt).toBe(FINALIZED_AT.toISOString());
    expect(returned.version).toBe(7);
    expect(repo.task?.version).toBe(7);
    expect(audit.entries).toHaveLength(0);
    expect(repo.touched).toEqual([]);
    expect(repo.abortedTaskUploadSessions).toEqual([]);
  });

  it("未定档任务：version 不匹配 → 409 VERSION_CONFLICT（不写库）", async () => {
    const repo = new FakeTaskRepository();
    await expect(makeService(repo).finalize(PROJECT, TASK, { version: 2 }, MANAGER)).rejects.toMatchObject({ code: "VERSION_CONFLICT", httpStatus: 409 });
    expect(repo.task?.finalizedAt).toBeNull();
  });

  it("已删除任务：finalize → 404（记录级 404 语义）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ deletedAt: new Date("2026-10-08T03:00:00Z"), deletedBy: ACTOR });
    await expect(makeService(repo).finalize(PROJECT, TASK, { version: 3 }, MANAGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("定档后写口闸不放松：负责人 finalize 置位后 update → 409 TASK_FINALIZED", async () => {
    const repo = new FakeTaskRepository();
    await makeService(repo).finalize(PROJECT, TASK, { version: 3 }, MANAGER);
    await expect(makeService(repo).update(PROJECT, TASK, { version: 4, note: "改备注" }, ACTOR)).rejects.toMatchObject({ code: "TASK_FINALIZED" });
  });
});

describe("任务取消定档入口（Push 260 · 「已」开关再次点击 + 二次确认）", () => {
  it("任务负责人：已定档任务 unfinalize 清位 finalizedAt / finalizedBy + version+1 + 审计「取消定档」+ 项目触点", async () => {
    const repo = new FakeTaskRepository();
    const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: ACTOR, version: 9 });
    const audit = new FakeAuditService();
    const updated = await makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit).unfinalize(PROJECT, TASK, { version: 9 }, MANAGER);
    expect(updated.finalizedAt).toBeNull();
    expect(updated.finalizedBy).toBeNull();
    expect(updated.version).toBe(10);
    expect(repo.task?.finalizedAt).toBeNull();
    expect(repo.touched).toEqual([PROJECT]);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as { action: string; objectType: string; objectId: string; summary: string; changes?: unknown };
    expect(entry.action).toBe("update");
    expect(entry.objectType).toBe("task");
    expect(entry.objectId).toBe(TASK);
    expect(entry.summary).toContain("取消定档");
    expect(entry.changes).toEqual([{ field: "finalizedAt", from: FINALIZED_AT.toISOString(), to: null }]);
  });

  it("未定档任务：负责人 unfinalize 幂等短路（原样返回、不递增版本、不再写审计）", async () => {
    const repo = new FakeTaskRepository();
    const audit = new FakeAuditService();
    const returned = await makeService(repo, new FakePermissionService(), new FakeTaskGateRepository(), audit).unfinalize(PROJECT, TASK, { version: 3 }, MANAGER);
    expect(returned.finalizedAt).toBeNull();
    expect(returned.version).toBe(3);
    expect(repo.task?.version).toBe(3);
    expect(audit.entries).toHaveLength(0);
    expect(repo.touched).toEqual([]);
  });

  it("已定档任务：version 不匹配 → 409 VERSION_CONFLICT（不写库）", async () => {
    const repo = new FakeTaskRepository();
    const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: ACTOR, version: 9 });
    await expect(makeService(repo).unfinalize(PROJECT, TASK, { version: 8 }, MANAGER)).rejects.toMatchObject({ code: "VERSION_CONFLICT", httpStatus: 409 });
    expect(repo.task?.finalizedAt).toBe(FINALIZED_AT);
  });

  it("取消定档后写口恢复：unfinalize 清位后 update 照常（与 finalize 置位后 409 对照）", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo);
    await service.finalize(PROJECT, TASK, { version: 3 }, MANAGER);
    await service.unfinalize(PROJECT, TASK, { version: 4 }, MANAGER);
    const updated = await service.update(PROJECT, TASK, { version: 5, note: "取消定档后改备注" }, ACTOR);
    expect(updated.note).toBe("取消定档后改备注");
  });

  it("已删除任务：unfinalize → 404（记录级 404 语义）", async () => {
    const repo = new FakeTaskRepository();
    repo.task = makeRow({ finalizedAt: new Date("2026-10-08T02:00:00Z"), finalizedBy: ACTOR, deletedAt: new Date("2026-10-08T03:00:00Z"), deletedBy: ACTOR });
    await expect(makeService(repo).unfinalize(PROJECT, TASK, { version: 3 }, MANAGER)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("任务定档角色权限（2026-10-27）", () => {
  it("项目经理非任务负责人也可定档 / 取消定档", async () => {
    const repo = new FakeTaskRepository();
    const permission = new FakePermissionService();
    permission.projectManager = true;
    const service = makeService(repo, permission);
    const finalized = await service.finalize(PROJECT, TASK, { version: 3 }, ACTOR);
    expect(finalized.finalizedBy).toBe(ACTOR);
    const unfinalized = await service.unfinalize(PROJECT, TASK, { version: 4 }, ACTOR);
    expect(unfinalized.finalizedAt).toBeNull();
    expect(unfinalized.version).toBe(5);
  });

  it("普通项目编辑者不能定档、不能取消，重复调用也不能维持已定档状态", async () => {
    const repo = new FakeTaskRepository();
    const service = makeService(repo, new FakePermissionService());
    await expect(service.finalize(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
      message: "仅任务负责人或项目经理可定档或取消定档",
    });
    const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");
    repo.task = makeRow({ finalizedAt: FINALIZED_AT, finalizedBy: MANAGER, version: 3 });
    await expect(service.finalize(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(service.unfinalize(PROJECT, TASK, { version: 3 }, ACTOR)).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    expect(repo.task?.finalizedAt).toBe(FINALIZED_AT);
  });
});
