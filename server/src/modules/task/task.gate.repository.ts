import { Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { DOC_TYPES } from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { files } from "../../db/schema/files.js";
import { nodeRequirements } from "../../db/schema/flow.js";
import { tasks } from "../../db/schema/tasks.js";

/** 门禁统计范围：任务自身上传，或直接挂在所属节点下的文件（兼容历史节点挂接）。 */
export interface TaskGateScope {
  taskId: string;
  nodeId: string | null;
}

export interface TaskGateDocCountRow {
  docType: string;
  present: number;
}

export interface TaskDeliveryRequirement {
  docType: string;
  minCount: number;
}

export interface TaskDeliveryMissing {
  docType: string;
  required: number;
  present: number;
}

export interface TaskDeliveryIssue {
  taskId: string;
  taskTitle: string;
  stageKey: string | null;
  docType: string;
  required: number;
  present: number;
}

export interface TaskDeliveryStatus {
  total: number;
  done: number;
  deliveryReady: number;
  issues: TaskDeliveryIssue[];
}

interface TaskDeliveryTaskRow {
  id: string;
  title: string;
  stageKey: string | null;
  nodeId: string | null;
  status: string;
  deliverableTypes: string[];
}

/**
 * 任务完成门禁数据访问（M3-03 · ADR-024）：只读 node_requirements / files，不做任何写。
 * 完成依据 = 已配置成果类型存在至少一份已上传文件（draft / final / changed 且 current_version_id 非空）；
 * 未配置成果类型 = 不要求文件。节点任务按节点挂接文件统计，无节点任务按任务挂接文件统计。
 * 说明：node 模块的 GateService 依赖 task（TaskStatsService），task 反向依赖会成环，
 * 故判定实现落本模块、与 GateService.evaluateNode 保持可解释的边界（node/README.md 已登记收敛点）。
 */
@Injectable()
export class TaskGateRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 所属节点的必交成果文件要求（required_doc；与 GateRepository.listRequirements 同表）。 */
  async listNodeDocRequirements(
    client: DbClient,
    nodeId: string,
  ): Promise<TaskDeliveryRequirement[]> {
    const rows = await client
      .select({ docType: nodeRequirements.docType, minCount: nodeRequirements.minCount })
      .from(nodeRequirements)
      .where(and(eq(nodeRequirements.nodeId, nodeId), eq(nodeRequirements.requirementType, "required_doc")));
    return rows
      .filter((row): row is { docType: string; minCount: number } => row.docType !== null)
      .map((row) => ({ docType: row.docType, minCount: Number(row.minCount) }));
  }

  /** 已上传文件计数：draft / final / changed 且 current_version_id 非空。 */
  async countUploadedFiles(client: DbClient, scope: TaskGateScope): Promise<TaskGateDocCountRow[]> {
    const rows = await client
      .select({ docType: files.docType, present: count() })
      .from(files)
      .where(
        and(
          scopeCondition(scope),
          inArray(files.status, ["draft", "final", "changed"]),
          isNotNull(files.currentVersionId),
        ),
      )
      .groupBy(files.docType);
    return toDocCountRows(rows);
  }

  /** 未定档（draft）计数：放行提示 warning 与 R02 触发用。 */
  async countDraftFiles(client: DbClient, scope: TaskGateScope): Promise<TaskGateDocCountRow[]> {
    const rows = await client
      .select({ docType: files.docType, present: count() })
      .from(files)
      .where(and(scopeCondition(scope), eq(files.status, "draft"), isNotNull(files.currentVersionId)))
      .groupBy(files.docType);
    return toDocCountRows(rows);
  }

  /**
   * 阶段 / 项目交付齐套状态：逐任务合并节点 required_doc 与任务 deliverable_types，
   * 仅对配置了成果类型的任务要求文件；未配置 = 不需要文件。
   * deliveryReady 只统计已完成任务中要求已满足的数量，供阶段通知 / 阶段推进判断。
   */
  async evaluateDeliveryStatus(
    client: DbClient,
    projectId: string,
    stageKey?: string,
  ): Promise<TaskDeliveryStatus> {
    const taskConditions: SQL[] = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt)];
    if (stageKey !== undefined) taskConditions.push(eq(tasks.stageKey, stageKey));
    const taskRows = (await client
      .select({
        id: tasks.id,
        title: tasks.title,
        stageKey: tasks.stageKey,
        nodeId: tasks.nodeId,
        status: tasks.status,
        deliverableTypes: tasks.deliverableTypes,
      })
      .from(tasks)
      .where(and(...taskConditions))) as TaskDeliveryTaskRow[];

    if (taskRows.length === 0) {
      return { total: 0, done: 0, deliveryReady: 0, issues: [] };
    }

    const nodeIds = [...new Set(taskRows.flatMap((row) => (row.nodeId === null ? [] : [row.nodeId])))];
    const requirementByNode = new Map<string, TaskDeliveryRequirement[]>();
    if (nodeIds.length > 0) {
      const requirementRows = await client
        .select({
          nodeId: nodeRequirements.nodeId,
          docType: nodeRequirements.docType,
          minCount: nodeRequirements.minCount,
        })
        .from(nodeRequirements)
        .where(
          and(
            inArray(nodeRequirements.nodeId, nodeIds),
            eq(nodeRequirements.requirementType, "required_doc"),
            isNotNull(nodeRequirements.docType),
          ),
        );
      for (const row of requirementRows) {
        if (row.docType === null || !isKnownDocType(row.docType)) continue;
        const current = requirementByNode.get(row.nodeId) ?? [];
        current.push({ docType: row.docType, minCount: Number(row.minCount) });
        requirementByNode.set(row.nodeId, current);
      }
    }

    const fileConditions: SQL[] = [
      eq(tasks.projectId, projectId),
      isNull(tasks.deletedAt),
      inArray(files.status, ["draft", "final", "changed"]),
      isNotNull(files.currentVersionId),
    ];
    if (stageKey !== undefined) fileConditions.push(eq(tasks.stageKey, stageKey));
    const fileJoin = or(
      eq(files.taskId, tasks.id),
      and(isNotNull(tasks.nodeId), eq(files.nodeId, tasks.nodeId)),
    ) as SQL;
    const fileRows = await client
      .select({ taskId: tasks.id, docType: files.docType, present: count() })
      .from(tasks)
      .innerJoin(files, fileJoin)
      .where(and(...fileConditions))
      .groupBy(tasks.id, files.docType);
    const uploadedByTask = new Map<string, TaskGateDocCountRow[]>();
    for (const row of fileRows) {
      if (row.docType === null) continue;
      const current = uploadedByTask.get(row.taskId) ?? [];
      current.push({ docType: row.docType, present: Number(row.present) });
      uploadedByTask.set(row.taskId, current);
    }

    let total = 0;
    let done = 0;
    let deliveryReady = 0;
    const issues: TaskDeliveryIssue[] = [];
    for (const task of taskRows) {
      total += 1;
      const requirements = mergeDeliveryRequirements(
        task.nodeId === null ? [] : requirementByNode.get(task.nodeId) ?? [],
        task.deliverableTypes,
      );
      const missing = missingDeliveryRequirements(requirements, uploadedByTask.get(task.id) ?? []);
      for (const item of missing) {
        issues.push({
          taskId: task.id,
          taskTitle: task.title,
          stageKey: task.stageKey,
          docType: item.docType,
          required: item.required,
          present: item.present,
        });
      }
      if (task.status !== "done") continue;
      done += 1;
      if (missing.length === 0) deliveryReady += 1;
    }
    return { total, done, deliveryReady, issues };
  }
}

export function mergeDeliveryRequirements(
  base: readonly TaskDeliveryRequirement[],
  deliverableTypes: readonly string[],
): TaskDeliveryRequirement[] {
  const merged = new Map<string, number>();
  for (const requirement of base) {
    if (!isKnownDocType(requirement.docType)) continue;
    merged.set(requirement.docType, Math.max(merged.get(requirement.docType) ?? 0, requirement.minCount));
  }
  for (const docType of deliverableTypes) {
    if (!isKnownDocType(docType) || merged.has(docType)) continue;
    merged.set(docType, 1);
  }
  return [...merged].map(([docType, minCount]) => ({ docType, minCount }));
}

export function missingDeliveryRequirements(
  requirements: readonly TaskDeliveryRequirement[],
  uploaded: readonly TaskGateDocCountRow[],
): TaskDeliveryMissing[] {
  const presentByType = new Map(uploaded.map((row) => [row.docType, row.present]));
  return requirements
    .filter((requirement) => (presentByType.get(requirement.docType) ?? 0) < requirement.minCount)
    .map((requirement) => ({
      docType: requirement.docType,
      required: requirement.minCount,
      present: presentByType.get(requirement.docType) ?? 0,
    }));
}

function isKnownDocType(value: string): boolean {
  return (DOC_TYPES as readonly string[]).includes(value);
}

function scopeCondition(scope: TaskGateScope): SQL {
  const ownFile = eq(files.taskId, scope.taskId);
  return scope.nodeId === null ? ownFile : (or(ownFile, eq(files.nodeId, scope.nodeId)) as SQL);
}

function toDocCountRows(rows: { docType: string | null; present: number }[]): TaskGateDocCountRow[] {
  return rows
    .filter((row): row is { docType: string; present: number } => row.docType !== null)
    .map((row) => ({ docType: row.docType, present: Number(row.present) }));
}