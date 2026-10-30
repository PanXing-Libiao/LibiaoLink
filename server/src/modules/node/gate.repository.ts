import { Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { files } from "../../db/schema/files.js";
import { nodeRequirements, projectNodes } from "../../db/schema/flow.js";
import { projectStages } from "../../db/schema/projects.js";

export interface RequirementRow {
  requirementType: string;
  docType: string | null;
  minCount: number;
}

export interface DocCountRow {
  docType: string;
  present: number;
}

export interface StageNodeRow {
  id: string;
  nodeKey: string;
  name: string;
  status: string;
}

export interface StageProgressRow {
  stageKey: string;
  nodeTotal: number;
  nodeDone: number;
}

/**
 * 门禁数据访问（h3）：只读 node_requirements / files / tasks，不做任何写。
 * 注：files / tasks 表分别属 file、task 模块（均未落地）——本模块直读为过渡口径，
 * i1 file / h4 task 落地后改为对端 index.ts 出口（README 已登记）。
 */
@Injectable()
export class GateRepository {
  constructor(private readonly database: DatabaseService) {}

  async listRequirements(client: DbClient, nodeId: string): Promise<RequirementRow[]> {
    return client
      .select({
        requirementType: nodeRequirements.requirementType,
        docType: nodeRequirements.docType,
        minCount: nodeRequirements.minCount,
      })
      .from(nodeRequirements)
      .where(eq(nodeRequirements.nodeId, nodeId));
  }

  /** 定档口径（v0.2 §3.6）：status ∈ (final, changed) 且 current_version_id 非空才计入。 */
  async countFinalFilesByDocType(client: DbClient, nodeId: string): Promise<DocCountRow[]> {
    const rows = await client
      .select({ docType: files.docType, present: count() })
      .from(files)
      .where(
        and(
          eq(files.nodeId, nodeId),
          inArray(files.status, ["final", "changed"]),
          sql`${files.currentVersionId} is not null`,
        ),
      )
      .groupBy(files.docType);
    return rows
      .filter((row): row is { docType: string; present: number } => row.docType !== null)
      .map((row) => ({ docType: row.docType, present: Number(row.present) }));
  }

  async listStageNodes(client: DbClient, projectId: string, stageKey: string): Promise<StageNodeRow[]> {
    return client
      .select({ id: projectNodes.id, nodeKey: projectNodes.nodeKey, name: projectNodes.name, status: projectNodes.status })
      .from(projectNodes)
      .innerJoin(projectStages, eq(projectStages.id, projectNodes.stageId))
      .where(
        and(
          eq(projectNodes.projectId, projectId),
          eq(projectStages.stageKey, stageKey),
          ne(projectNodes.status, "deleted"),
        ),
      );
  }

  /** 节点关联成果文件数（删除前置提示：draft / final / changed 计入；v0.2 §3.7）。 */
  async countLinkedFiles(client: DbClient, nodeId: string): Promise<number> {
    const rows = await client
      .select({ value: count() })
      .from(files)
      .where(and(eq(files.nodeId, nodeId), inArray(files.status, ["draft", "final", "changed"]), isNotNull(files.currentVersionId)));
    return Number(rows[0]?.value ?? 0);
  }

  /** 阶段节点计数（读时派生）：任务侧计数由 task 模块 TaskStatsService 提供（h4 起本模块不直读 tasks 表）。 */
  async listStageProgress(client: DbClient, projectId: string): Promise<StageProgressRow[]> {
    const nodeRows = await client
      .select({ stageKey: projectStages.stageKey, status: projectNodes.status, value: count() })
      .from(projectNodes)
      .innerJoin(projectStages, eq(projectStages.id, projectNodes.stageId))
      .where(and(eq(projectNodes.projectId, projectId), ne(projectNodes.status, "deleted")))
      .groupBy(projectStages.stageKey, projectNodes.status);
    const map = new Map<string, StageProgressRow>();
    for (const row of nodeRows) {
      const entry = map.get(row.stageKey) ?? { stageKey: row.stageKey, nodeTotal: 0, nodeDone: 0 };
      const value = Number(row.value);
      entry.nodeTotal += value;
      if (row.status === "done") entry.nodeDone += value;
      map.set(row.stageKey, entry);
    }
    return [...map.values()];
  }
}
