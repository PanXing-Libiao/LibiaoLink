import { Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { files } from "../../db/schema/files.js";
import { nodeRequirements } from "../../db/schema/flow.js";

/** 门禁统计范围：所属节点（有节点任务）或任务自身（无节点任务兜底，ADR-024）。 */
export type TaskGateScope = { nodeId: string } | { taskId: string };

export interface TaskGateDocCountRow {
  docType: string;
  present: number;
}

/**
 * 任务完成门禁数据访问（M3-03 · ADR-024）：只读 node_requirements / files，不做任何写。
 * 口径与 node 模块 GateRepository 一致（同表同 SQL 形态）：required_doc 逐 doc_type 统计
 * status ∈ (final, changed) 且 current_version_id 非空；draft 单独计数供 R02 放行提示。
 * 说明：node 模块的 GateService 依赖 task（TaskStatsService），task 反向依赖会成环，
 * 故判定实现落本模块、与 GateService.evaluateNode 保持同口径（node/README.md 已登记收敛点）。
 */
@Injectable()
export class TaskGateRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 所属节点的必交成果文件要求（required_doc；与 GateRepository.listRequirements 同表）。 */
  async listNodeDocRequirements(
    client: DbClient,
    nodeId: string,
  ): Promise<{ docType: string; minCount: number }[]> {
    const rows = await client
      .select({ docType: nodeRequirements.docType, minCount: nodeRequirements.minCount })
      .from(nodeRequirements)
      .where(and(eq(nodeRequirements.nodeId, nodeId), eq(nodeRequirements.requirementType, "required_doc")));
    return rows
      .filter((row): row is { docType: string; minCount: number } => row.docType !== null)
      .map((row) => ({ docType: row.docType, minCount: Number(row.minCount) }));
  }

  /** 定档口径（v0.2 §3.6）：status ∈ (final, changed) 且 current_version_id 非空才计入。 */
  async countFinalFiles(client: DbClient, scope: TaskGateScope): Promise<TaskGateDocCountRow[]> {
    const rows = await client
      .select({ docType: files.docType, present: count() })
      .from(files)
      .where(
        and(
          scopeCondition(scope),
          inArray(files.status, ["final", "changed"]),
          sql`${files.currentVersionId} is not null`,
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
}

function scopeCondition(scope: TaskGateScope): SQL {
  return "nodeId" in scope ? eq(files.nodeId, scope.nodeId) : eq(files.taskId, scope.taskId);
}

function toDocCountRows(rows: { docType: string | null; present: number }[]): TaskGateDocCountRow[] {
  return rows
    .filter((row): row is { docType: string; present: number } => row.docType !== null)
    .map((row) => ({ docType: row.docType, present: Number(row.present) }));
}
