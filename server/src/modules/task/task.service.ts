import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  DOC_TYPES,
  PRIORITY_VALUES,
  STAGE_KEYS,
  ProjectSummarySchema,
  TaskBatchBodySchema,
  TaskBatchFailureSchema,
  TaskBatchResponseSchema,
  TaskCanCompleteResponseSchema,
  TaskCompleteBodySchema,
  TaskCompleteResponseSchema,
  TaskCreateBodySchema,
  TaskCreateFromTemplateBodySchema,
  TaskCreateFromTemplateResponseSchema,
  TaskDeleteResponseSchema,
  TaskDetailSchema,
  TaskFinalizeBodySchema,
  TaskUnfinalizeBodySchema,
  TaskGateMissingSchema,
  TaskGateWarningSchema,
  TaskListItemSchema,
  TaskListResponseSchema,
  TaskLockedFieldsAdjustBodySchema,
  TaskProgressSchema,
  TaskProgressUpdateBodySchema,
  TaskSchema,
  TaskUpdateBodySchema,
  z,
  type ErrorDetail,
} from "@libiaolink/contracts";
import type { OutboxTopic } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { DbClient } from "../../db/db-client.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutbox } from "../../db/outbox.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { RoleService } from "../identity/index.js";
import { TaskNodeRepository, TemplateService } from "../template/index.js";
import { clampSortIndex } from "./task.order.js";
import { parseTaskListFilter, parseTaskSort, type TaskListQueryInput } from "./task.query.js";
import {
  applyProgressWrite,
  applyStatusWrite,
  deriveDisplayStatus,
  deriveOnTime,
  shanghaiToday,
} from "./task.rules.js";
import {
  TaskRepository,
  type TaskChangeLinkRow,
  type TaskCompletionTargetRow,
  type TaskEventInput,
  type TaskFileSummaryCounts,
  type TaskListRow,
  type TaskProjectRow,
  type TaskRow,
  type TaskUpdatePatch,
} from "./task.repository.js";
import { TaskGateRepository, type TaskGateDocCountRow, type TaskGateScope } from "./task.gate.repository.js";

type Task = z.infer<typeof TaskSchema>;
type TaskDetail = z.infer<typeof TaskDetailSchema>;
type TaskFinalizeBody = z.infer<typeof TaskFinalizeBodySchema>;
type TaskUnfinalizeBody = z.infer<typeof TaskUnfinalizeBodySchema>;
type TaskListItem = z.infer<typeof TaskListItemSchema>;
type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
type TaskCreateBody = z.infer<typeof TaskCreateBodySchema>;
type TaskUpdateBody = z.infer<typeof TaskUpdateBodySchema>;
type TaskProgressUpdateBody = z.infer<typeof TaskProgressUpdateBodySchema>;
type TaskProgress = z.infer<typeof TaskProgressSchema>;
type TaskCompleteBody = z.infer<typeof TaskCompleteBodySchema>;
type TaskCompleteResponse = z.infer<typeof TaskCompleteResponseSchema>;
type TaskCanCompleteResponse = z.infer<typeof TaskCanCompleteResponseSchema>;
type TaskGateMissing = z.infer<typeof TaskGateMissingSchema>;
type TaskGateWarning = z.infer<typeof TaskGateWarningSchema>;
type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
type TaskBatchBody = z.infer<typeof TaskBatchBodySchema>;
type TaskCreateFromTemplateBody = z.infer<typeof TaskCreateFromTemplateBodySchema>;
type TaskCreateFromTemplateResponse = z.infer<typeof TaskCreateFromTemplateResponseSchema>;
type TaskBatchFailure = z.infer<typeof TaskBatchFailureSchema>;
type TaskBatchResponse = z.infer<typeof TaskBatchResponseSchema>;
type TaskDeleteResponse = z.infer<typeof TaskDeleteResponseSchema>;
type TaskLockedFieldsAdjustBody = z.infer<typeof TaskLockedFieldsAdjustBodySchema>;

/**
 * 单条写入内核的输入（编辑 / 批量共用）：expectedVersion = null 表示批量语义（按当前行覆盖，不做逐行乐观锁）；
 * sortIndex 仅单条编辑使用（批量白名单不含顺序调整 —— 顺序调整是「插入位置」的逐条语义）。
 */
type TaskWriteRequest = Pick<
  TaskUpdateBody,
  "title" | "titleEn" | "ownerIds" | "status" | "plannedStart" | "plannedEnd" | "estimatedDays" | "headcount" | "priority" | "deliverableTypes" | "note" | "sortIndex"
> & { expectedVersion: number | null };

const EMPTY_FILE_SUMMARY: TaskFileSummaryCounts = { total: 0, draft: 0, final: 0 };
const CHANGE_SUMMARY_MAX = 40;

/**
 * 任务完成「必交成果文件」门禁总开关（业务口径 2026-09-30：暂时不要这个约束功能）：
 * false = 任务完成不再校验必交成果文件缺件（单条编辑 / 批量 / 进度 / 完成提交四条写入路径同口径），预检恒放行（missing 恒空）；
 * draft 成果文件的放行提醒（R02）不受影响；节点完成 / 阶段推进 / 归档的同类门禁不随本开关。
 * 恢复门禁：把本常量改回 true 即可（判定与留痕逻辑原样保留，无需改其它代码）。
 */
const TASK_COMPLETION_DOC_GATE_ENABLED: boolean = false;

/** 门禁拒绝的内部信号（事务回滚后补写留痕，再转 422 契约错误）—— 与 FlowService 同模式。 */
class GateRejectedSignal extends Error {
  constructor(
    readonly appError: AppError,
    readonly outbox: { topic: OutboxTopic; dedupeKey: string; payload: Record<string, unknown> },
  ) {
    super("gate_rejected");
  }
}

/**
 * 任务用例（h4 · S6·task：M3-01 列表 / 详情 + M3-02 进度与状态 + 项目总览四格）。
 * 五态派生与按时交付读时计算（A1-06 / A14），状态与进度写入在同一事务内联动（A12 / A13），字段级留痕写 task_events（A1-10）。
 * 权限（h6 前口径）：读登录即可；任务编辑 / 进度为成员平权；手工创建非标准任务仅管理员（系统功能书 A1-13）；
 * 归档项目写保护 409 PROJECT_ARCHIVED（ADR-027）；任务变更写项目触点（ADR-022 ④）。
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: TaskRepository,
    private readonly gate: TaskGateRepository,
    private readonly roles: RoleService,
    private readonly audit: AuditService,
    private readonly nodes: TaskNodeRepository,
    private readonly templates: TemplateService,
  ) {}

  /**
   * GET /projects/{id}/summary：汇总卡（最慢阶段 / 最新阶段 / 逾期 / 已完成 / 总数）。
   * 2026-09-24 定案：`currentStage`（= projects.stage_key）下线，改两个任务派生阶段字段 ——
   * 最慢 = 按九阶段顺序第一个「存在未完成任务」的阶段；最新 = 已动工任务（基础态 active / done，即进度 ≥ 1 格）里阶段序最靠后者；
   * 「未分组」任务（stage_key 为空）不是阶段，只进三个计数。
   */
  async summary(projectId: string): Promise<ProjectSummary> {
    await this.loadProjectOrFail(projectId);
    const today = shanghaiToday(new Date());
    const counts = await this.repository.summaryCounts(projectId, today);
    const perStage = await this.repository.taskCountsByStage(this.database.db, projectId);
    const unfinished = new Set<string>();
    const started = new Set<string>();
    for (const row of perStage) {
      if (row.stageKey === null) continue;
      if (row.status === "done") {
        started.add(row.stageKey);
      } else {
        unfinished.add(row.stageKey);
        if (row.status === "active") started.add(row.stageKey);
      }
    }
    const slowestStage = STAGE_KEYS.find((key) => unfinished.has(key)) ?? null;
    const latestStage = [...STAGE_KEYS].reverse().find((key) => started.has(key)) ?? null;
    return {
      projectId,
      slowestStage,
      latestStage,
      overdue: counts.overdue,
      done: counts.done,
      total: counts.total,
    };
  }

  /** GET /projects/{id}/tasks：分页 + 阶段 / 负责人 / 展示态筛选 + 关键字 + 白名单排序；items 为 TaskListItem。 */
  async list(projectId: string, query: TaskListQueryInput): Promise<TaskListResponse> {
    await this.loadProjectOrFail(projectId);
    const filter = parseTaskListFilter(query);
    const sorts = parseTaskSort(query.sort);
    const today = shanghaiToday(new Date());
    const offset = (query.page - 1) * query.limit;
    const { items, total } = await this.repository.listPage(projectId, filter, sorts, query.limit, offset, today);
    const summaries = await this.repository.fileSummaries(items.map((row) => row.task.id));
    return {
      items: items.map((row) => toListItem(row, summaries.get(row.task.id) ?? EMPTY_FILE_SUMMARY, today)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  /** GET /projects/{id}/tasks/{taskId}：抽屉全字段 + 文件清单（A7：列表不再补第二次请求）。 */
  async detail(projectId: string, taskId: string): Promise<TaskDetail> {
    await this.loadProjectOrFail(projectId);
    const row = await this.repository.findListRowById(taskId, projectId);
    if (row === null) throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
    const files = await this.repository.listFiles(taskId);
    const today = shanghaiToday(new Date());
    return {
      ...toTaskView(row.task, today, toChangeLinks(row.changeLinks)),
      ownerNames: row.ownerNames ?? [],
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        status: file.status as TaskDetail["files"][number]["status"],
        docType: normalizeDocType(file.docType),
      })),
    };
  }

  /**
   * POST /projects/{id}/tasks：从任务节点生成（成员）或手工创建（仅管理员，A1-13）；按节点判重 409。
   * w2 · Push 124 / A23 · Push 136：stageKey 可选（缺省 / null = 「未分组」；带节点时缺省取节点阶段）、ownerIds 显式 [] = 「待分配」、
   * sortIndex = 插入位次（越界 / 缺省 = 组尾），组内其余任务位次顺延。
   */
  async create(projectId: string, body: TaskCreateBody, actorId: string): Promise<Task> {
    const project = await this.loadProjectForWrite(projectId);
    const nodeId = body.taskNodeId ?? null;
    const sourceNodeId = body.sourceNodeId ?? null;
    if (nodeId !== null && sourceNodeId !== null) {
      throw new AppError("VALIDATION_FAILED", "taskNodeId（项目流程节点）与 sourceNodeId（节点库节点）二选一");
    }
    let stageKey: string | null = body.stageKey ?? null;
    let title = body.title;
    let titleEn = body.titleEn ?? null;
    if (nodeId !== null) {
      const node = await this.repository.findProjectNode(projectId, nodeId);
      if (node === null || node.status === "deleted") {
        throw new AppError("VALIDATION_FAILED", "taskNodeId 不属于该项目或节点已删除");
      }
      if (stageKey !== null && node.stageKey !== stageKey) {
        throw new AppError("VALIDATION_FAILED", "stageKey 与来源节点所属阶段不一致（节点阶段：" + node.stageKey + "）");
      }
      stageKey = node.stageKey;
    } else if (sourceNodeId !== null) {
      // 节点库来源（M3-07 刀 3 · A1-16）：描述 / 英文名 / 阶段取节点库现值（A1-17 锁定字段），节点必须存在
      const node = await this.nodes.findById(sourceNodeId);
      if (node === null) {
        throw new AppError("VALIDATION_FAILED", "sourceNodeId 不存在或节点已从节点库删除");
      }
      if (stageKey !== null && node.stageKey !== stageKey) {
        throw new AppError("VALIDATION_FAILED", "stageKey 与来源节点所属阶段不一致（节点阶段：" + node.stageKey + "）");
      }
      stageKey = node.stageKey;
      title = node.title;
      titleEn = node.titleEn;
    } else {
      await this.assertAdmin(actorId, "手工创建非标准任务");
    }
    // 负责人缺省 = 「待分配」空数组（2026-09-24 业务口径：任务添加后负责人默认为空 —— 不再兜底项目经理；A23 的兜底口径据此修订）
    const ownerIds = body.ownerIds !== undefined ? body.ownerIds : [];
    const at = new Date();
    const row = await this.database.db.transaction(async (tx) => {
      if (nodeId !== null) {
        const existing = await this.repository.findTaskIdByNode(projectId, nodeId, tx);
        if (existing !== null) {
          throw new AppError("TASK_ALREADY_EXISTS", "该项目已存在该节点生成的任务：" + existing);
        }
      }
      if (sourceNodeId !== null) {
        const existing = await this.repository.findTaskIdsBySourceNodes(projectId, [sourceNodeId], tx);
        const hit = existing.get(sourceNodeId);
        if (hit !== undefined) {
          throw new AppError("TASK_ALREADY_EXISTS", "该项目已添加过该节点（任务：" + hit + "）");
        }
      }
      const groupSize = await this.repository.countGroup(projectId, stageKey, tx);
      const sortIndex = clampSortIndex(body.sortIndex ?? groupSize, groupSize);
      if (sortIndex < groupSize) {
        await this.repository.shiftGroupIndexes(projectId, stageKey, sortIndex, null, 1, tx);
      }
      const created = await this.repository.insert(
        {
          projectId,
          stageKey,
          nodeId,
          sourceNodeId,
          title,
          titleEn,
          ownerIds,
          sortIndex,
          plannedStart: body.plannedStart ?? null,
          plannedEnd: body.plannedEnd ?? null,
          estimatedDays: body.estimatedDays ?? null,
          headcount: body.headcount ?? null,
          priority: body.priority ?? null,
          deliverableTypes: await this.resolveDeliverableTypes(tx, nodeId, body.deliverableTypes),
          note: body.note ?? null,
        },
        at,
        tx,
      );
      await appendOutbox(tx, {
        topic: "task.created",
        dedupeKey: "task.created:" + created.id,
        payload: {
          projectId,
          taskId: created.id,
          stageKey,
          nodeId,
          status: created.status,
          progress: Number(created.progress),
          actorId,
          at: at.toISOString(),
        },
      });
      await this.repository.touchProject(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task",
        objectId: created.id,
        projectId,
        summary: "创建任务：" + created.title,
        changes: [
          { field: "stageKey", from: null, to: created.stageKey },
          { field: "title", from: null, to: created.title },
          { field: "ownerIds", from: null, to: created.ownerIds },
          { field: "plannedEnd", from: null, to: created.plannedEnd },
        ].filter((change) => change.to !== null),
        metadata: sourceNodeId === null ? undefined : { sourceNodeId, source: "task_node" },
      });
      return created;
    });
    return toTaskView(row, shanghaiToday(at), []);
  }

  /**
   * POST /projects/{id}/tasks/from-template（A1-16「批量生成节点任务」· M3-07 刀 3）：整批按模板内顺序生成 ——
   * 阶段取模板阶段、任务描述 / 英文名取节点库现值（A1-17 锁定字段）、负责人缺省 = 「待分配」空数组（Push 184 修订：不再兜底项目经理，A23 的兜底口径下线）。
   * 判重（系统功能书 A1-16「同一项目已生成过的节点默认不重复生成」）：已存在的节点进 skipped；skipExisting=false 时 409。
   * 整批**同事务**（要么全落、要么不落）；位次按模板内顺序依次落位（sortIndex 起，缺省 = 组尾，同组顺延）。
   * 留痕：逐条审计（action=create，metadata 记 templateId / sourceNodeId）+ outbox task.created；不写 task_events（非字段级变更）。
   */
  async createFromTemplate(
    projectId: string,
    body: TaskCreateFromTemplateBody,
    actorId: string,
  ): Promise<TaskCreateFromTemplateResponse> {
    const project = await this.loadProjectForWrite(projectId);
    const template = await this.templates.getTemplate(body.templateId);
    const ordered = template.nodes;
    let picked = ordered;
    if (body.nodeIds !== undefined) {
      const wanted = new Set(body.nodeIds);
      const unknown = [...wanted].filter((id) => !ordered.some((node) => node.nodeId === id));
      if (unknown.length > 0) {
        throw new AppError("VALIDATION_FAILED", "nodeIds 不属于该模板：" + unknown.join("、"));
      }
      picked = ordered.filter((node) => wanted.has(node.nodeId));
    }
    if (picked.length === 0) {
      return { created: [], skipped: [] };
    }
    // 同 create()：缺省 = 「待分配」（2026-09-24 业务口径）
    const ownerIds = body.ownerIds !== undefined ? body.ownerIds : [];
    const stageKey = template.stageKey as string;
    const at = new Date();
    const today = shanghaiToday(at);
    return this.database.db.transaction(async (tx) => {
      const existing = await this.repository.findTaskIdsBySourceNodes(projectId, picked.map((node) => node.nodeId), tx);
      const skipped: { nodeId: string; taskId: string }[] = [];
      const toCreate = picked.filter((node) => {
        const hit = existing.get(node.nodeId);
        if (hit === undefined) return true;
        if (!body.skipExisting) {
          throw new AppError("TASK_ALREADY_EXISTS", "该项目已添加过该节点（任务：" + hit + "）");
        }
        skipped.push({ nodeId: node.nodeId, taskId: hit });
        return false;
      });
      const groupSize = await this.repository.countGroup(projectId, stageKey, tx);
      const base = clampSortIndex(body.sortIndex ?? groupSize, groupSize);
      if (toCreate.length > 0 && base < groupSize) {
        await this.repository.shiftGroupIndexes(projectId, stageKey, base, null, toCreate.length, tx);
      }
      const created: Task[] = [];
      for (let index = 0; index < toCreate.length; index += 1) {
        const node = toCreate[index]!;
        const row = await this.repository.insert(
          {
            projectId,
            stageKey,
            nodeId: null,
            sourceNodeId: node.nodeId,
            title: node.title,
            titleEn: node.titleEn,
            ownerIds,
            sortIndex: base + index,
            plannedStart: null,
            plannedEnd: null,
            estimatedDays: null,
            headcount: null,
            priority: body.priority ?? null,
            deliverableTypes: [],
            note: null,
          },
          at,
          tx,
        );
        await appendOutbox(tx, {
          topic: "task.created",
          dedupeKey: "task.created:" + row.id,
          payload: {
            projectId,
            taskId: row.id,
            stageKey,
            nodeId: null,
            status: row.status,
            progress: Number(row.progress),
            actorId,
            at: at.toISOString(),
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: "create",
          objectType: "task",
          objectId: row.id,
          projectId,
          summary: "从模板创建任务：" + row.title,
          changes: [
            { field: "stageKey", from: null, to: row.stageKey },
            { field: "title", from: null, to: row.title },
            { field: "ownerIds", from: null, to: row.ownerIds },
          ].filter((change) => change.to !== null),
          metadata: { sourceNodeId: node.nodeId, templateId: template.id, templateName: template.name, kind: "from_template" },
        });
        created.push(toTaskView(row, today, []));
      }
      if (created.length > 0) {
        await this.repository.touchProject(projectId, at, tx);
      }
      return { created, skipped };
    });
  }
  /**
   * PATCH /projects/{id}/tasks/{taskId}：字段编辑 +（可选）基础三态写入联动（A12）+ 组内重排（A19 / A20，Push 124）；
   * 乐观锁 + 字段留痕。ownerIds 显式 [] = 「待分配」；sortIndex = 移到该组第 N 位（越界 = 组尾）。
   */
  async update(projectId: string, taskId: string, body: TaskUpdateBody, actorId: string): Promise<Task> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    const today = shanghaiToday(at);
    const row = await this.runCompletionGuarded(actorId, taskId, () =>
      this.database.db.transaction((tx) =>
        this.applyUpdate(
          tx,
          projectId,
          taskId,
          {
            expectedVersion: body.version,
            title: body.title,
            titleEn: body.titleEn,
            sortIndex: body.sortIndex,
            ownerIds: body.ownerIds,
            status: body.status,
            plannedStart: body.plannedStart,
            plannedEnd: body.plannedEnd,
            estimatedDays: body.estimatedDays,
            headcount: body.headcount,
            priority: body.priority,
            deliverableTypes: body.deliverableTypes,
            note: body.note,
          },
          actorId,
          at,
          today,
          null,
        ),
      ),
    );
    return toTaskView(row, today, await this.changeLinksOf(row));
  }

  /**
   * PATCH /projects/{id}/tasks/batch：批量操作（M3-04 · 系统功能书 A1-08）。
   * 口径：同一组变更（白名单）逐条应用到 ids —— 逐条独立事务（避免长事务）、逐条校验 + 部分失败清单；
   * 成功项照常生效（整体 200），条目级错误（不存在 / 门禁缺件 / 已完成 / 并发冲突）降级为 failures[]，非预期错误照旧抛出；
   * 批量完成 = changes.status=done，与单条编辑 / /complete 同一门禁（缺件项进 failures 的 gate_not_passed 并留痕）。
   * 留痕（C7-01 / A1-08 / A1-10）：批次一条（project 域，metadata 记 batchId / 计数 / 失败清单，「批量操作整体写审计日志」）+ 逐条字段级一条（entry=batch + 同批 batchId，每条任务的修改历史可查「批量」入口）。
   */
  async batch(projectId: string, body: TaskBatchBody, actorId: string): Promise<TaskBatchResponse> {
    await this.loadProjectForWrite(projectId);
    if (Object.values(body.changes).every((value) => value === undefined)) {
      throw new AppError("VALIDATION_FAILED", "批量操作至少给出一个变更字段（changes）");
    }
    const at = new Date();
    const today = shanghaiToday(at);
    const batchId = randomUUID();
    const ids = [...new Set(body.ids)];
    const request: TaskWriteRequest = { expectedVersion: null, ...body.changes };
    const succeeded: Task[] = [];
    const failures: TaskBatchFailure[] = [];
    for (const taskId of ids) {
      try {
        const row = await this.runCompletionGuarded(
          actorId,
          taskId,
          () => this.database.db.transaction((tx) => this.applyUpdate(tx, projectId, taskId, request, actorId, at, today, batchId)),
          batchId,
        );
        succeeded.push(toTaskView(row, today, await this.changeLinksOf(row)));
      } catch (error) {
        const failure = toBatchFailure(taskId, error);
        if (failure === null) throw error;
        failures.push(failure);
      }
    }
    // 批次审计（系统功能书 A1-08「批量操作整体写审计日志」）：一次请求一条（project 域），
    // 与逐条字段级审计（entry=batch + 同批 batchId）并存 —— 前者可查「谁在什么时候批了什么」，后者可查每条任务的修改历史。
    await this.audit.record(this.database.db, {
      actorId,
      action: "update",
      objectType: "project",
      objectId: projectId,
      projectId,
      summary: "批量操作任务：" + ids.length + " 条（成功 " + succeeded.length + "，失败 " + failures.length + "）",
      changes: null,
      metadata: {
        entry: "batch",
        batchId,
        taskIds: ids,
        changedFields: Object.entries(body.changes)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
        succeededCount: succeeded.length,
        failedCount: failures.length,
        failures: failures.map((failure) => ({ id: failure.id, code: failure.code })),
      },
    });
    return { total: ids.length, succeededCount: succeeded.length, failedCount: failures.length, succeeded, failures };
  }

  /**
   * DELETE /projects/{id}/tasks/{taskId}（M3-05 · A25 · 系统功能书 A1-01 修订）：软删 —— 不物理删行，历史与留痕保留。
   * 口径：① 列表 / 看板 / 甘特图 / 详情 / 完成门禁一律不可见（读面统一过滤 deleted_at is null）；
   * ② 重复删除 = 统一 404（记录级 404 语义，与已删任务上的任何写路径一致 —— 不新增错误码）；
   * ③ 组内位次同事务压缩，保持「0 起、密集」不变式（A19 / A20）；
   * ④ 来源节点约束随软删释放（节点回到「可添加」，A10 / A11 口径不变 —— 判重走 findTaskIdByNode 已过滤软删）；
   * ⑤ 权限沿用 task.update（与编辑同一权限位，不新增权限键）；归档项目写保护照旧 409 PROJECT_ARCHIVED。
   * ⑥ 已有引用（问题 / 变更记录）的任务不允许删除 = 409 TASK_HAS_REFERENCES（系统功能书 A2-01「已产生日报 / 问题 / 变更的任务不允许删除，只能关闭或标记」；
   *   Push 215 起日报「关联任务」改「关联阶段」，日报一侧引用守卫随批删除：details[].code = change_ref / issue_ref）；
   * 留痕：审计 action=delete（objectType=task，changes = 删除前快照）+ outbox task.deleted；
   * 不写 task_events —— 其类型为四值闭集（status_change / date_change / progress_change / note_change），删除不属于字段级变更。
   */
  async remove(projectId: string, taskId: string, actorId: string): Promise<TaskDeleteResponse> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.requireActiveTask(tx, projectId, taskId);
      this.assertTaskMutable(before);
      const references = await this.referencesOf(tx, before);
      if (references.length > 0) {
        throw new AppError(
          "TASK_HAS_REFERENCES",
          "任务已产生问题 / 变更，不允许删除（系统功能书 A2-01）；只能关闭或标记",
          references,
        );
      }
      const deleted = await this.repository.softDelete(tx, taskId, actorId, at);
      if (!deleted) throw new AppError("NOT_FOUND", "任务不存在或已删除：" + taskId);
      await this.repository.shiftGroupIndexes(projectId, before.stageKey, before.sortIndex + 1, null, -1, tx);
      await appendOutbox(tx, {
        topic: "task.deleted",
        dedupeKey: "task.deleted:" + taskId + ":" + before.version,
        payload: {
          projectId,
          taskId,
          stageKey: before.stageKey,
          nodeId: before.nodeId,
          actorId,
          at: at.toISOString(),
        },
      });
      await this.repository.touchProject(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "task",
        objectId: taskId,
        projectId,
        summary: "删除任务：" + before.title,
        changes: diffRecords(taskAuditSnapshot(before), null),
        metadata: { softDelete: true, stageKey: before.stageKey, nodeId: before.nodeId },
      });
    });
    return { id: taskId, deleted: true };
  }

  /**
   * PATCH /projects/{id}/tasks/{taskId}/locked-fields（M3-05 · A1-17 / C9-07 · Push 153）：锁定字段例外调整。
   * 任务描述 / 输出成果文件按流程节点模板生成后锁定（常规编辑不可达）；确需修正时 **仅系统管理员** 可执行，
   * 原因必填并留痕（模板本身由管理员修正，C9-07）；「阶段性里程」一期任务无对应列，不开放。
   * 口径：至少一个实际变化（否则 400 —— 防止空调整刷留痕）；乐观锁 409；归档项目 409；不存在 / 已删 404。
   * 留痕：审计（changes = 锁定字段 before → after；metadata 记原因与 kind）+ outbox `task.locked_fields_adjusted` + touch 项目；
   * 不写 `task_events`（四值闭集不含锁定字段）。成果文件类型修正后即刻成为无节点任务的完成门禁依据。
   */
  async adjustLockedFields(
    projectId: string,
    taskId: string,
    body: TaskLockedFieldsAdjustBody,
    actorId: string,
  ): Promise<Task> {
    await this.loadProjectForWrite(projectId);
    await this.assertAdmin(actorId, "例外调整锁定字段（A1-17 / C9-07）");
    const at = new Date();
    const today = shanghaiToday(at);
    const row = await this.database.db.transaction(async (tx) => {
      const before = await this.requireActiveTask(tx, projectId, taskId);
      this.assertTaskMutable(before);
      if (before.version !== body.version) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      const patch: TaskUpdatePatch = {};
      if (body.title !== undefined && body.title !== before.title) patch.title = body.title;
      if (body.titleEn !== undefined && body.titleEn !== before.titleEn) patch.titleEn = body.titleEn;
      if (body.deliverableTypes !== undefined) {
        const next = normalizeDocTypes(body.deliverableTypes);
        if (next.join(",") !== normalizeDocTypes(before.deliverableTypes).join(",")) patch.deliverableTypes = next;
      }
      if (Object.keys(patch).length === 0) {
        throw new AppError("VALIDATION_FAILED", "锁定字段没有实际变化，无需例外调整");
      }
      const updated = await this.repository.updateWithVersion(taskId, body.version, patch, at, tx);
      if (updated === null) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      const changes = diffRecords(lockedFieldsSnapshot(before), lockedFieldsSnapshot(updated));
      await appendOutbox(tx, {
        topic: "task.locked_fields_adjusted",
        dedupeKey: "task.locked_fields_adjusted:" + taskId + ":" + updated.version,
        payload: {
          projectId,
          taskId,
          fields: changes.map((change) => change.field),
          reason: body.reason,
          actorId,
          at: at.toISOString(),
        },
      });
      await this.repository.touchProject(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task",
        objectId: taskId,
        projectId,
        summary: "例外调整任务锁定字段：" + updated.title + "（原因：" + body.reason + "）",
        changes,
        metadata: {
          reason: body.reason,
          kind: "locked_field_exception",
          adminOnly: true,
          fields: changes.map((change) => change.field),
        },
      });
      return updated;
    });
    return toTaskView(row, today, await this.changeLinksOf(row));
  }

  /** 写路径统一前置（M3-05）：锁行 + 校验归属本项目 + 未软删；已删任务 = 404（与读面不可见同口径）。 */
  /**
   * 删除引用守卫明细（A2-01；Push 152 登记「问题随 M5 加判定」；Push 215 删日报一侧）：
   * ① 变更记录（tasks.change_refs）逐条明细；② 问题（issues.task_id）。
   * 任一非空即 409 TASK_HAS_REFERENCES —— 拒绝时不软删 / 不压缩位次 / 不写留痕（抛在事务内，整体回滚）。
   */
  private async referencesOf(tx: DbClient, task: TaskRow): Promise<ErrorDetail[]> {
    const details: ErrorDetail[] = task.changeRefs.map((changeId) => ({
      code: "change_ref",
      message: "关联变更：" + changeId,
      path: "changeRefs",
      meta: { changeRequestId: changeId },
    }));
    const issueRefs = await this.repository.countIssueRefs(task.id, tx);
    if (issueRefs > 0) {
      details.push({ code: "issue_ref", message: "关联问题：" + issueRefs + " 条", path: "issues", meta: { count: issueRefs } });
    }
    return details;
  }

  private async requireActiveTask(tx: DbClient, projectId: string, taskId: string): Promise<TaskRow> {
    const row = await this.repository.lockTask(tx, taskId);
    if (row === null || row.projectId !== projectId || row.deletedAt !== null) {
      throw new AppError("NOT_FOUND", "任务不存在或已删除：" + taskId);
    }
    return row;
  }
  /**
   * 任务定档写口闸（Push 249 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」）：
   * 定档后的任务不支持任何修改 —— 编辑 / 批量 / 进度 / 完成提交 / 删除 / 锁定字段例外调整一律 409 TASK_FINALIZED。
   * 唯一保留的修改通道 = 对已定档文件的变更（A2-10「定档后修改须走变更管理」，A4-13 申请即通过）。
   */
  private assertTaskMutable(task: TaskRow): void {
    if (task.finalizedAt !== null) {
      throw new AppError("TASK_FINALIZED", "任务已定档，不支持任何修改（文件修改走变更）", [
        { code: "task_finalized", message: "任务定档时间：" + task.finalizedAt.toISOString(), path: "finalizedAt" },
      ]);
    }
  }

  /**
   * 单条写入内核（编辑 / 批量共用）：锁行 → 校验 → 状态联动 → 门禁 → 落库 + 事件 + outbox + 审计。
   * expectedVersion = null 表示批量（按当前行覆盖：批量是「把选中行统一改成同一值」，不带逐行乐观锁）；
   * batchId 非空时审计 metadata 标注「批量」入口（entry=batch）并共享批次号。
   */
  private async applyUpdate(
    tx: DbClient,
    projectId: string,
    taskId: string,
    request: TaskWriteRequest,
    actorId: string,
    at: Date,
    today: string,
    batchId: string | null,
  ): Promise<TaskRow> {
    if (request.sortIndex !== undefined) {
      const brief = await this.repository.findTaskBrief(taskId, tx);
      if (brief === null || brief.projectId !== projectId) {
        throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
      }
      await this.repository.listGroupOrder(projectId, brief.stageKey, tx, true);
    }
    const before = await this.repository.lockTask(tx, taskId);
    if (before === null || before.projectId !== projectId) {
      throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
    }
    this.assertTaskMutable(before);
    if (request.expectedVersion !== null && before.version !== request.expectedVersion) {
      throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
    }
    if (request.title !== undefined || request.titleEn !== undefined) {
      // Push 196：任务描述（title / titleEn）只对**临时任务**开放（看板「添加 → 临时任务」手工创建、未归入阶段）；
      // Push 197 收窄（业务口径「这个不是临时任务 不能修改」）：归入阶段的任务即便没有来源节点也锁定 ——
      // 阶段任务与节点 / 模板生成的任务仍按 A1-17 走常规编辑不可达，修正走管理员「例外调整」（PATCH …/locked-fields）。
      if (before.stageKey !== null || before.nodeId !== null || before.taskNodeId !== null) {
        throw new AppError("VALIDATION_FAILED", "只有未归入阶段的「临时任务」可改任务描述（阶段任务 / 节点 / 模板生成的任务按 A1-17 锁定），修正请走管理员「例外调整」");
      }
    }
    if (batchId !== null && request.status === "done" && before.status === "done") {
      throw new AppError("TASK_ALREADY_DONE", "任务已完成，无需重复提交");
    }
    const sortIndex =
      request.sortIndex === undefined ? before.sortIndex : await this.moveWithinGroup(tx, projectId, before, request.sortIndex);
    const current = {
      status: before.status,
      progress: Number(before.progress),
      actualEnd: before.actualEnd,
      statusOverride: before.statusOverride,
    };
    const linked = request.status === undefined ? null : applyStatusWrite(current, request.status, today);
    const completionWarnings =
      linked !== null && linked.status === "done" && before.status !== "done"
        ? await this.assertCompletionGate(tx, before, at, actorId)
        : null;
    const patch: TaskUpdatePatch = {
      title: request.title !== undefined ? request.title : before.title,
      titleEn: request.titleEn !== undefined ? request.titleEn : before.titleEn,
      ownerIds: request.ownerIds !== undefined ? request.ownerIds : before.ownerIds,
      status: linked === null ? before.status : linked.status,
      statusOverride: linked === null ? before.statusOverride : linked.statusOverride,
      progress: String(linked === null ? current.progress : linked.progress),
      sortIndex,
      plannedStart: request.plannedStart !== undefined ? request.plannedStart : before.plannedStart,
      plannedEnd: request.plannedEnd !== undefined ? request.plannedEnd : before.plannedEnd,
      actualEnd: linked === null ? before.actualEnd : linked.actualEnd,
      estimatedDays: request.estimatedDays !== undefined ? request.estimatedDays : before.estimatedDays,
      headcount: request.headcount !== undefined ? request.headcount : before.headcount,
      priority: request.priority !== undefined ? request.priority : before.priority,
      // 2026-10-08（业务口径「文件输出成果也要可以选择」）：输出成果文件常规编辑开放（去重保序；[] = 不要求）
      deliverableTypes: request.deliverableTypes !== undefined ? normalizeDocTypes(request.deliverableTypes) : before.deliverableTypes,
      note: request.note !== undefined ? request.note : before.note,
    };
    const updated = await this.repository.updateWithVersion(taskId, request.expectedVersion ?? before.version, patch, at, tx);
    if (updated === null) {
      throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
    }
    await this.repository.insertEvents(tx, buildEvents(before, patch), actorId, at);
    await appendOutbox(tx, {
      topic: "task.updated",
      dedupeKey: "task.updated:" + taskId + ":" + updated.version,
      payload: {
        projectId,
        taskId,
        status: updated.status,
        progress: Number(updated.progress),
        plannedEnd: updated.plannedEnd,
        actualEnd: updated.actualEnd,
        actorId,
        at: at.toISOString(),
      },
    });
    if (completionWarnings !== null) {
      await this.appendCompletionOutbox(tx, { projectId, task: updated, warnings: completionWarnings, actorId, at });
    }
    await this.repository.touchProject(projectId, at, tx);
    const changes = diffRecords(taskAuditSnapshot(before), taskAuditSnapshot(updated));
    await this.audit.record(tx, {
      actorId,
      action: "update",
      objectType: "task",
      objectId: taskId,
      projectId,
      summary: (batchId === null ? "" : "批量") + "修改任务：" + updated.title,
      changes: changes.length > 0 ? changes : null,
      metadata: batchId === null ? undefined : { entry: "batch", batchId },
    });
    return updated;
  }

  /** PATCH /projects/{id}/tasks/{taskId}/progress：四格进度 + 完成日期（A12 / A13）；响应为 TaskListItem 同形。 */
  async updateProgress(
    projectId: string,
    taskId: string,
    body: TaskProgressUpdateBody,
    actorId: string,
  ): Promise<TaskListItem> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    const today = shanghaiToday(at);
    const row = await this.runCompletionGuarded(actorId, taskId, () =>
      this.database.db.transaction(async (tx) => {
      const before = await this.repository.lockTask(tx, taskId);
      if (before === null || before.projectId !== projectId) {
        throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
      }
      this.assertTaskMutable(before);
      if (before.version !== body.version) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      const linked = applyProgressWrite(body.progress, body.actualEnd ?? null, today);
      const completionWarnings =
        linked.status === "done" && before.status !== "done"
          ? await this.assertCompletionGate(tx, before, at, actorId)
          : null;
      const patch: TaskUpdatePatch = {
        status: linked.status,
        statusOverride: linked.statusOverride,
        progress: String(linked.progress),
        actualEnd: linked.actualEnd,
        note: body.note !== undefined ? body.note : before.note,
      };
      const updated = await this.repository.updateWithVersion(taskId, body.version, patch, at, tx);
      if (updated === null) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      await this.repository.insertEvents(tx, buildEvents(before, patch), actorId, at);
      await appendOutbox(tx, {
        topic: "task.progress_changed",
        dedupeKey: "task.progress_changed:" + taskId + ":" + updated.version,
        payload: {
          projectId,
          taskId,
          status: updated.status,
          progress: Number(updated.progress),
          actualEnd: updated.actualEnd,
          actorId,
          at: at.toISOString(),
        },
      });
      if (completionWarnings !== null) {
        await this.appendCompletionOutbox(tx, { projectId, task: updated, warnings: completionWarnings, actorId, at });
      }
      await this.repository.touchProject(projectId, at, tx);
      const changes = diffRecords(taskAuditSnapshot(before), taskAuditSnapshot(updated));
      await this.audit.record(tx, {
        actorId,
        action: "progress",
        objectType: "task",
        objectId: taskId,
        projectId,
        summary: "更新任务进度：" + updated.title + "（进度 " + Number(updated.progress) + "）",
        changes: changes.length > 0 ? changes : null,
      });
      return updated;
      }),
    );
    const listRow = await this.repository.findListRowById(row.id, projectId);
    if (listRow === null) throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
    const summaries = await this.repository.fileSummaries([row.id]);
    return toListItem(listRow, summaries.get(row.id) ?? EMPTY_FILE_SUMMARY, today);
  }

  /**
   * 组内重排（A19 / A20 · Push 124）：把任务移到该组第 N 位（越界 = 组尾），返回落定位次。
   * 调用方必须已锁住该组（listGroupOrder lock=true）—— 只平移其余任务的位次，不逐个改版本 / updated_at。
   */
  /**
   * GET /projects/{id}/tasks/{taskId}/can-complete：完成任务预检（UI 置灰依据；不替代事务内强校验 —— 与节点 can-complete 同口径）。
   * 门禁口径（ADR-024 / A4-20）：有节点任务按所属节点 node_requirements 判定；无节点任务按自身 deliverable_types 兜底（每类 ≥ 1 份）。
   * 【暂时下线 · 2026-09-30】缺件不拦截（见 TASK_COMPLETION_DOC_GATE_ENABLED）：预检随缺件恒空而恒放行（missing 恒空）；draft 提醒保留。
   */
  async canComplete(projectId: string, taskId: string): Promise<TaskCanCompleteResponse> {
    await this.loadProjectOrFail(projectId);
    const target = await this.repository.findCompletionTarget(this.database.db, taskId);
    if (target === null || target.projectId !== projectId) {
      throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
    }
    if (target.status === "done") return { canComplete: false, missing: [], warnings: [] };
    const gate = await this.evaluateGate(this.database.db, target);
    return { canComplete: gate.missing.length === 0, missing: gate.missing, warnings: gate.warnings };
  }

  /**
   * POST /projects/{id}/tasks/{taskId}/complete：任务完成提交（M3-03 · PoC 9 后半）。
   * 事务内乐观锁 + 门禁强校验；缺件 422 TASK_REQUIRED_DOC_MISSING（拒绝也留痕）；存在 draft 成果文件放行 + warning 并触发 R02。
   * 【暂时下线 · 2026-09-30】缺件不再 422（见 TASK_COMPLETION_DOC_GATE_ENABLED）；draft 放行 + warning（R02）保留。
   */
  async complete(projectId: string, taskId: string, body: TaskCompleteBody, actorId: string): Promise<TaskCompleteResponse> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    const today = shanghaiToday(at);
    const result = await this.runCompletionGuarded(actorId, taskId, () =>
      this.database.db.transaction(async (tx) => {
        const before = await this.repository.lockTask(tx, taskId);
        if (before === null || before.projectId !== projectId) {
          throw new AppError("NOT_FOUND", "任务不存在或不属于该项目");
        }
        this.assertTaskMutable(before);
        if (before.status === "done") {
          throw new AppError("TASK_ALREADY_DONE", "任务已完成，无需重复提交");
        }
        if (before.version !== body.version) {
          throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
        }
        const warnings = await this.assertCompletionGate(tx, before, at, actorId);
        const linked = applyStatusWrite(
          {
            status: before.status,
            progress: Number(before.progress),
            actualEnd: body.actualEnd ?? before.actualEnd,
            statusOverride: before.statusOverride,
          },
          "done",
          today,
        );
        const patch: TaskUpdatePatch = {
          status: linked.status,
          statusOverride: linked.statusOverride,
          progress: String(linked.progress),
          actualEnd: linked.actualEnd,
          note: body.note !== undefined ? body.note : before.note,
        };
        const updated = await this.repository.updateWithVersion(taskId, body.version, patch, at, tx);
        if (updated === null) {
          throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
        }
        await this.repository.insertEvents(tx, buildEvents(before, patch), actorId, at);
        await this.appendCompletionOutbox(tx, { projectId, task: updated, warnings, actorId, at });
        await this.repository.touchProject(projectId, at, tx);
        const changes = diffRecords(taskAuditSnapshot(before), taskAuditSnapshot(updated));
        await this.audit.record(tx, {
          actorId,
          action: "complete",
          objectType: "task",
          objectId: taskId,
          projectId,
          summary: "完成任务：" + updated.title + (warnings.length > 0 ? "（存在未定档成果文件，已触发 R02 提醒）" : ""),
          changes: changes.length > 0 ? changes : null,
        });
        return { task: updated, warnings };
      }),
    );
    return { task: toTaskView(result.task, today, await this.changeLinksOf(result.task)), warnings: result.warnings };
  }

  /**
   * POST /projects/{id}/tasks/{taskId}/finalize：任务定档（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态，有二次提示」）。
   * 口径：未定档 → 置位 finalized_at / finalized_by（version+1、留痕、outbox task.finalized、项目触点）；此后写口一律 409 TASK_FINALIZED（assertTaskMutable）；修改走变更。
   * 防绕过补漏：定档同时撤销该任务在途的 version 上传会话；completeUpload 事务内再复核（会话早于定档发起时状态门禁不够）。
   * 已定档 → 幂等短路（200 原样返回，不写库 / 不递增版本 —— 抽屉开关重复点击 / 与文件定档并发都只生效一次）；version 不匹配 → 409 VERSION_CONFLICT。
   * 与文件定档（file.finalizeFile → markTaskFinalized）双入口并存：两条路径都只置位一次。
   */
  async finalize(projectId: string, taskId: string, body: TaskFinalizeBody, actorId: string): Promise<Task> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    const today = shanghaiToday(at);
    const row = await this.database.db.transaction(async (tx) => {
      const before = await this.requireActiveTask(tx, projectId, taskId);
      if (before.finalizedAt !== null) {
        return before;
      }
      if (before.version !== body.version) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      const updated = await this.repository.updateWithVersion(
        taskId,
        body.version,
        { finalizedAt: at, finalizedBy: actorId },
        at,
        tx,
      );
      if (updated === null) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      await appendOutbox(tx, {
        topic: "task.finalized",
        dedupeKey: "task.finalized:" + taskId + ":" + updated.version,
        payload: {
          projectId,
          taskId,
          finalizedAt: at.toISOString(),
          finalizedBy: actorId,
          actorId,
          at: at.toISOString(),
        },
      });
      await this.repository.touchProject(projectId, at, tx);
      // 定档兜底（防绕过补漏）：撤销该任务在途的 version 上传会话（change = A4-13 唯一保留的修改通道，不撤）；
      // 漏网会话（如并发发起）由 completeUpload 的任务定档复核兜住。
      const abortedUploadSessions = await this.repository.abortActiveTaskUploadSessions(taskId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task",
        objectId: taskId,
        projectId,
        summary: "任务定档：" + updated.title + "（此后不支持任何修改；文件修改走变更）",
        changes: [{ field: "finalizedAt", from: null, to: at.toISOString() }],
        metadata: { abortedUploadSessions },
      });
      return updated;
    });
    return toTaskView(row, today, await this.changeLinksOf(row));
  }

  /**
   * POST /projects/{id}/tasks/{taskId}/unfinalize：任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）。
   * 口径：已定档 → 清空 finalized_at / finalized_by（version+1、留痕「取消定档」、outbox task.unfinalized、项目触点），
   * 任务重新开放修改（编辑 / 删除 / 文件写口恢复）；文件级定档（files.status=final）不回退 —— 文件修改仍走变更（A4-13）。
   * 未定档 → 幂等短路（200 原样返回，不写库 / 不递增版本）；version 不匹配 → 409 VERSION_CONFLICT。
   * 操作记录（业务口径「点击定档按钮应该也要计入操作记录」）：定档 / 取消定档各留一条「任务」记录（action=update，摘要前缀「任务定档」/「取消定档」）。
   */
  async unfinalize(projectId: string, taskId: string, body: TaskUnfinalizeBody, actorId: string): Promise<Task> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    const today = shanghaiToday(at);
    const row = await this.database.db.transaction(async (tx) => {
      const before = await this.requireActiveTask(tx, projectId, taskId);
      if (before.finalizedAt === null) {
        return before;
      }
      if (before.version !== body.version) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      const updated = await this.repository.updateWithVersion(
        taskId,
        body.version,
        { finalizedAt: null, finalizedBy: null },
        at,
        tx,
      );
      if (updated === null) {
        throw new AppError("VERSION_CONFLICT", "任务已被他人更新，请刷新后重试");
      }
      await appendOutbox(tx, {
        topic: "task.unfinalized",
        dedupeKey: "task.unfinalized:" + taskId + ":" + updated.version,
        payload: {
          projectId,
          taskId,
          unfinalizedAt: at.toISOString(),
          actorId,
          at: at.toISOString(),
        },
      });
      await this.repository.touchProject(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task",
        objectId: taskId,
        projectId,
        summary: "取消定档：" + updated.title + "（任务重新开放修改；文件修改仍走变更）",
        changes: [{ field: "finalizedAt", from: before.finalizedAt.toISOString(), to: null }],
      });
      return updated;
    });
    return toTaskView(row, today, await this.changeLinksOf(row));
  }

  /**
   * 门禁判定（ADR-024 / A4-20）：有节点任务按所属节点 node_requirements 逐类统计；无节点任务按自身 deliverable_types 兜底（每类 ≥ 1 份）。
   * 定档口径：files.status ∈ (final, changed) 且 current_version_id 非空；draft 单独计数作放行提示（R02）。
   * 【暂时下线 · 2026-09-30】缺件判定整体短路（恒空清单 = 放行，见 TASK_COMPLETION_DOC_GATE_ENABLED）；draft 放行提示（R02）保留；恢复 = 常量改回 true。
   */
  private async evaluateGate(
    client: DbClient,
    task: TaskCompletionTargetRow,
  ): Promise<{ missing: TaskGateMissing[]; warnings: TaskGateWarning[] }> {
    const scope: TaskGateScope = task.nodeId !== null ? { nodeId: task.nodeId } : { taskId: task.id };
    // 门禁暂时下线（业务口径 2026-09-30，见 TASK_COMPLETION_DOC_GATE_ENABLED）：缺件恒放行 —— 要求 / 定档计数两处查询整体跳过；
    // draft 放行提示（R02）照旧。恢复门禁 = 常量改回 true，下面的判定逻辑原样保留、无需改动。
    if (!TASK_COMPLETION_DOC_GATE_ENABLED) {
      return { missing: [], warnings: buildDraftWarnings(await this.gate.countDraftFiles(client, scope)) };
    }
    const requirements: { docType: string; minCount: number }[] =
      task.nodeId !== null
        ? await this.gate.listNodeDocRequirements(client, task.nodeId)
        : normalizeDocTypes(task.deliverableTypes).map((docType) => ({ docType, minCount: 1 }));
    const presentByType = new Map((await this.gate.countFinalFiles(client, scope)).map((row) => [row.docType, row.present]));
    const missing: TaskGateMissing[] = [];
    for (const requirement of requirements) {
      // 蓝图校验（BLUEPRINT_REF_UNKNOWN）已限制 required_doc 取值；非法历史值静默跳过，不让门禁误拦。
      if (!(DOC_TYPES as readonly string[]).includes(requirement.docType)) continue;
      const presentCount = presentByType.get(requirement.docType) ?? 0;
      if (presentCount < requirement.minCount) {
        missing.push({
          docType: requirement.docType as TaskGateMissing["docType"],
          required: requirement.minCount,
          present: presentCount,
        });
      }
    }
    const warnings = buildDraftWarnings(await this.gate.countDraftFiles(client, scope));
    return { missing, warnings };
  }

  /**
   * 完成事件统一出口：完成提交 / PATCH 状态 / PATCH 进度 / 批量完成在首次进入 done 时共用同一事件与幂等键，
   * 避免只有 POST …/complete 触发 R02 而页面常态操作漏发。
   */
  private async appendCompletionOutbox(
    tx: DbClient,
    input: { projectId: string; task: TaskRow; warnings: TaskGateWarning[]; actorId: string; at: Date },
  ): Promise<void> {
    await appendOutbox(tx, {
      topic: "task.completed",
      dedupeKey: "task.completed:" + input.task.id + ":" + input.task.version,
      payload: {
        projectId: input.projectId,
        taskId: input.task.id,
        status: input.task.status,
        progress: Number(input.task.progress),
        actualEnd: input.task.actualEnd,
        warnings: input.warnings,
        actorId: input.actorId,
        at: input.at.toISOString(),
      },
    });
    if (input.warnings.length > 0) {
      await appendOutbox(tx, {
        topic: "task.draft_doc_reminded",
        dedupeKey: "task.draft_doc_reminded:" + input.task.id + ":" + input.task.version,
        payload: { projectId: input.projectId, taskId: input.task.id, warnings: input.warnings, actorId: input.actorId, at: input.at.toISOString() },
      });
    }
  }

  /** 事务内门禁强校验：缺件 → GateRejectedSignal（422 + missing）；通过 → 放行提示（R02）。拒绝留痕由调用方在事务外补写。【暂时下线 · 2026-09-30】evaluateGate 缺件恒空 → 本方法实际只剩放行提示；拒绝分支保留备恢复（见 TASK_COMPLETION_DOC_GATE_ENABLED）。 */
  private async assertCompletionGate(client: DbClient, task: TaskRow, at: Date, actorId: string): Promise<TaskGateWarning[]> {
    const gate = await this.evaluateGate(client, task);
    if (gate.missing.length > 0) {
      const rejection = new AppError(
        "TASK_REQUIRED_DOC_MISSING",
        "缺少必交成果文件，无法完成任务（TASK_REQUIRED_DOC_MISSING）",
        gate.missing.map((item) => ({
          code: "required_doc",
          message: "缺少必交成果文件：" + item.docType + "（需要 " + item.required + "，现有 " + item.present + "）",
          path: "missing",
          meta: { ...item },
        })),
      );
      throw new GateRejectedSignal(rejection, {
        topic: "task.gate_rejected",
        dedupeKey: "task.gate_rejected:" + task.id + ":" + at.getTime(),
        payload: {
          taskId: task.id,
          projectId: task.projectId,
          nodeId: task.nodeId,
          missing: gate.missing,
          actorId,
          at: at.toISOString(),
        },
      });
    }
    return gate.warnings;
  }

  /** 门禁拒绝的事务外善后（照 FlowService 模式）：补写 outbox 留痕 + 审计 failed，再抛 422 契约错误；batchId 非空时审计标注批量入口（entry=batch）。 */
  private async runCompletionGuarded<T>(
    actorId: string,
    taskId: string,
    run: () => Promise<T>,
    batchId: string | null = null,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GateRejectedSignal) {
        await appendOutbox(this.database.db, error.outbox);
        const projectId =
          typeof error.outbox.payload["projectId"] === "string" ? error.outbox.payload["projectId"] : null;
        await this.audit.record(this.database.db, {
          actorId,
          action: "complete",
          objectType: "task",
          objectId: taskId,
          projectId,
          result: "failed",
          summary: (batchId === null ? "" : "批量") + "任务完成被门禁拒绝：" + error.appError.message,
          metadata:
            batchId === null
              ? { errorCode: error.appError.code, details: error.appError.details }
              : { errorCode: error.appError.code, details: error.appError.details, entry: "batch", batchId },
        });
        throw error.appError;
      }
      throw error;
    }
  }

  /**
   * 创建时解析「要求输出成果文件」（A1-17 模板带出）：显式传入优先；缺省时从所属节点的 required_doc 类型带出；
   * 无节点任务缺省 = 空数组（不要求）。数组去重、首次出现保序。
   */
  private async resolveDeliverableTypes(
    client: DbClient,
    nodeId: string | null,
    requested: readonly string[] | undefined,
  ): Promise<string[]> {
    if (requested !== undefined) return normalizeDocTypes(requested);
    if (nodeId === null) return [];
    const requirements = await this.gate.listNodeDocRequirements(client, nodeId);
    return normalizeDocTypes(requirements.map((item) => item.docType));
  }

  private async moveWithinGroup(tx: DbClient, projectId: string, task: TaskRow, requested: number): Promise<number> {
    const rows = await this.repository.listGroupOrder(projectId, task.stageKey, tx);
    const currentIndex = rows.findIndex((row) => row.id === task.id);
    const from = currentIndex >= 0 ? currentIndex : Number(task.sortIndex);
    const target = clampSortIndex(requested, rows.length - 1);
    if (target !== from) {
      if (target < from) {
        await this.repository.shiftGroupIndexes(projectId, task.stageKey, target, from - 1, 1, tx);
      } else {
        await this.repository.shiftGroupIndexes(projectId, task.stageKey, from + 1, target, -1, tx);
      }
    }
    return target;
  }

  /** 项目可见性：软删 / 不存在统一 404（记录级 404 语义随 h6 策略服务）。 */
  /** 写路径响应用：按任务行的 change_refs（追加序）取回关联变更，保证「编辑 / 完成」不改动已有变更关联。 */
  private async changeLinksOf(task: TaskRow): Promise<TaskChangeLinkRow[]> {
    return this.repository.listChangeLinks(task.changeRefs);
  }

  private async loadProjectOrFail(projectId: string): Promise<TaskProjectRow> {
    const project = await this.repository.findProject(projectId);
    if (project === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    return project;
  }

  /** 任务写入口：归档项目一律 409 PROJECT_ARCHIVED（ADR-027）。 */
  private async loadProjectForWrite(projectId: string): Promise<TaskProjectRow> {
    const project = await this.loadProjectOrFail(projectId);
    if (project.status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止修改任务");
    }
    return project;
  }

  /** 手工创建非标准任务仅管理员（系统功能书 A1-13）。 */
  private async assertAdmin(actorId: string, action: string): Promise<void> {
    const authorization = await this.roles.getActorAuthorization(actorId);
    if (!authorization.roleCodes.includes("admin")) {
      throw new AppError("FORBIDDEN", "仅管理员可" + action + "（系统功能书 A1-13）");
    }
  }
}

/**
 * 批量条目错误降级（M3-04）：可预期的业务错误映射为 failures[] 条目（同批其它项照常处理）；
 * 非 AppError（程序缺陷 / 基础设施故障）返回 null —— 由 batch() 照旧抛出（500），避免系统错误被吞成「部分失败」。
 */
function toBatchFailure(taskId: string, error: unknown): TaskBatchFailure | null {
  if (!(error instanceof AppError)) return null;
  const message = error.message;
  switch (error.code) {
    case "NOT_FOUND":
      return { id: taskId, code: "not_found", message };
    case "PROJECT_ARCHIVED":
      return { id: taskId, code: "archived", message };
    case "TASK_REQUIRED_DOC_MISSING": {
      const missing = gateMissingFrom(error);
      return missing.length > 0
        ? { id: taskId, code: "gate_not_passed", message, missing }
        : { id: taskId, code: "gate_not_passed", message };
    }
    case "TASK_ALREADY_DONE":
      return { id: taskId, code: "already_done", message };
    case "VERSION_CONFLICT":
      return { id: taskId, code: "version_conflict", message };
    case "TASK_FINALIZED":
      return { id: taskId, code: "finalized", message };
    default:
      return error.httpStatus >= 400 && error.httpStatus < 500
        ? { id: taskId, code: "invalid_state", message }
        : null;
  }
}

/** 门禁缺件明细还原（assertCompletionGate 的 details[].meta → 契约 TaskGateMissing；缺 meta 的明细跳过）。 */
function gateMissingFrom(error: AppError): TaskGateMissing[] {
  const missing: TaskGateMissing[] = [];
  for (const detail of error.details) {
    const meta = detail.meta;
    if (meta === undefined) continue;
    const docType = meta["docType"];
    const required = meta["required"];
    const present = meta["present"];
    if (typeof docType !== "string" || typeof required !== "number" || typeof present !== "number") continue;
    if (!(DOC_TYPES as readonly string[]).includes(docType)) continue;
    missing.push({ docType: docType as TaskGateMissing["docType"], required, present });
  }
  return missing;
}

/** 锁定字段快照（A1-17 例外调整留痕 · M3-05）：任务描述 / 输出成果文件 —— 不在 taskAuditSnapshot 内（后者只覆盖可编辑字段），故单列一份。 */
function lockedFieldsSnapshot(row: { title: string; titleEn: string | null; deliverableTypes: string[] }): Record<string, unknown> {
  return { title: row.title, titleEn: row.titleEn, deliverableTypes: normalizeDocTypes(row.deliverableTypes) };
}

/** 任务字段级留痕快照（C7-02：任务描述（Push 196 起临时任务可改）/ 负责人（多位）/ 状态 / 进度 / 组内位次 / 计划与实际日期 / 工期 / 人数 / 重要度 / 备注）。 */
function taskAuditSnapshot(row: {
  title: string;
  titleEn: string | null;
  ownerIds: string[];
  status: string;
  statusOverride: string | null;
  progress: string | number;
  sortIndex: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  priority: string | null;
  deliverableTypes: string[];
  note: string | null;
}): Record<string, unknown> {
  return {
    title: row.title,
    titleEn: row.titleEn,
    ownerIds: row.ownerIds,
    status: row.status,
    statusOverride: row.statusOverride,
    progress: Number(row.progress),
    sortIndex: row.sortIndex,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    actualEnd: row.actualEnd,
    estimatedDays: row.estimatedDays,
    headcount: row.headcount,
    priority: row.priority,
    deliverableTypes: normalizeDocTypes(row.deliverableTypes),
    note: row.note,
  };
}

/** 行 → 契约视图：displayStatus / onTime 读时派生（A12 / A14），不写回存储。 */
function toTaskView(row: TaskRow, today: string, changeLinks: Task["changeLinks"]): Task {
  const input = {
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
    stageKey: row.stageKey as Task["stageKey"],
    sortIndex: row.sortIndex,
    nodeId: row.nodeId,
    sourceNodeId: row.taskNodeId,
    title: row.title,
    titleEn: row.titleEn,
    ownerIds: row.ownerIds,
    status: row.status as Task["status"],
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
    changeLinks,
    finalizedAt: row.finalizedAt === null ? null : row.finalizedAt.toISOString(),
    finalizedBy: row.finalizedBy,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 列表项：TaskListItem（Task + ownerNames / fileSummary；「变更关联」列吃 changeLinks 多条）。 */
function toListItem(row: TaskListRow, fileSummary: TaskFileSummaryCounts, today: string): TaskListItem {
  return {
    ...toTaskView(row.task, today, toChangeLinks(row.changeLinks)),
    ownerNames: row.ownerNames ?? [],
    fileSummary,
  };
}

/**
 * 字段级留痕（A1-10）：状态 / 进度 / 日期 / 备注四类；before / after 为 JSON（键 = 字段名，只记本次变化的字段）。
 * 2026-09-24 起「状态」含显式覆盖（status_override）：只改覆盖（如进行中 → 已延期）同样记 status_change，避免没有留痕。
 */
function buildEvents(before: TaskRow, after: TaskUpdatePatch): TaskEventInput[] {
  const events: TaskEventInput[] = [];
  const statusBefore: Record<string, string | null> = {};
  const statusAfter: Record<string, string | null> = {};
  if (after.status !== undefined && after.status !== before.status) {
    statusBefore.status = before.status;
    statusAfter.status = after.status;
  }
  if (after.statusOverride !== undefined && (after.statusOverride ?? null) !== (before.statusOverride ?? null)) {
    statusBefore.statusOverride = before.statusOverride ?? null;
    statusAfter.statusOverride = after.statusOverride;
  }
  if (Object.keys(statusAfter).length > 0) {
    events.push({
      taskId: before.id,
      eventType: "status_change",
      beforeValue: JSON.stringify(statusBefore),
      afterValue: JSON.stringify(statusAfter),
    });
  }
  if (after.progress !== undefined && Number(after.progress) !== Number(before.progress)) {
    events.push({
      taskId: before.id,
      eventType: "progress_change",
      beforeValue: JSON.stringify({ progress: Number(before.progress) }),
      afterValue: JSON.stringify({ progress: Number(after.progress) }),
    });
  }
  const dateBefore: Record<string, string | null> = {};
  const dateAfter: Record<string, string | null> = {};
  if (after.plannedStart !== undefined && after.plannedStart !== before.plannedStart) {
    dateBefore.plannedStart = before.plannedStart;
    dateAfter.plannedStart = after.plannedStart;
  }
  if (after.plannedEnd !== undefined && after.plannedEnd !== before.plannedEnd) {
    dateBefore.plannedEnd = before.plannedEnd;
    dateAfter.plannedEnd = after.plannedEnd;
  }
  if (after.actualEnd !== undefined && after.actualEnd !== before.actualEnd) {
    dateBefore.actualEnd = before.actualEnd;
    dateAfter.actualEnd = after.actualEnd;
  }
  if (Object.keys(dateAfter).length > 0) {
    events.push({
      taskId: before.id,
      eventType: "date_change",
      beforeValue: JSON.stringify(dateBefore),
      afterValue: JSON.stringify(dateAfter),
    });
  }
  if (after.note !== undefined && after.note !== before.note) {
    events.push({
      taskId: before.id,
      eventType: "note_change",
      beforeValue: JSON.stringify({ note: before.note }),
      afterValue: JSON.stringify({ note: after.note }),
    });
  }
  return events;
}

/** 变更关联项（A1-07 多条）：行上已按 change_refs 追加序取好；原因在服务端截短（列表短文本，全文在变更记录）。 */
function toChangeLinks(rows: readonly TaskChangeLinkRow[]): Task["changeLinks"] {
  return rows.map((row) => ({ id: row.id, reason: shortenChangeReason(row.reason), appliedAt: row.appliedAt }));
}

/** 变更原因短文本（列表用）：超长截断；详情跳变更记录看全文。 */
function shortenChangeReason(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim();
  if (text === "") return null;
  return text.length > CHANGE_SUMMARY_MAX ? text.slice(0, CHANGE_SUMMARY_MAX) + "…" : text;
}

/** 进度归一化到离散五档（迁移 / 演示数据的任意小数先四舍五入到最近档，契约注释口径）。 */
function normalizeProgress(value: number): TaskProgress {
  const rounded = Math.round(value * 4) / 4;
  if (rounded === 0 || rounded === 0.25 || rounded === 0.5 || rounded === 0.75 || rounded === 1) {
    return rounded;
  }
  return 0;
}

function normalizePriority(value: string | null): Task["priority"] {
  if (value === null) return null;
  return (PRIORITY_VALUES as readonly string[]).includes(value) ? (value as Task["priority"]) : null;
}

/** 文件侧单值类型归一（files.doc_type）：非十类字典值回落 null（文件清单展示用）。 */
function normalizeDocType(value: string | null): Task["deliverableTypes"][number] | null {
  if (value === null) return null;
  return (DOC_TYPES as readonly string[]).includes(value) ? (value as Task["deliverableTypes"][number]) : null;
}

/** 十类字典过滤 + 去重（首次出现保序）—— ADR-024：取值属成果文件字典、数组去重、空数组 = 不要求。 */
function normalizeDocTypes(values: readonly string[]): Task["deliverableTypes"] {
  const seen = new Set<string>();
  const result: Task["deliverableTypes"] = [];
  for (const value of values) {
    if (!(DOC_TYPES as readonly string[]).includes(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value as Task["deliverableTypes"][number]);
  }
  return result;
}

/** 放行提示（A2-10 / R02）：存在未定档（draft）成果文件时按字典顺序出 warning（计数 > 0 才出）。 */
function buildDraftWarnings(rows: readonly TaskGateDocCountRow[]): TaskGateWarning[] {
  const counts = new Map(rows.map((row) => [row.docType, row.present]));
  const warnings: TaskGateWarning[] = [];
  for (const docType of DOC_TYPES) {
    const count = counts.get(docType) ?? 0;
    if (count > 0) warnings.push({ code: "draft_doc_present", docType, count });
  }
  return warnings;
}
