import { Injectable } from "@nestjs/common";
import type { DbClient } from "../../db/db-client.js";
import { GateRepository } from "./gate.repository.js";
import { TaskStatsService } from "../task/index.js";

/** 节点完成门禁缺件明细（契约 NodeGateMissing；422 NODE_REQUIRED_DOC_MISSING 的 details.missing）。 */
export interface NodeGateMissing {
  docType: string;
  required: number;
  present: number;
}

/** 阶段推进门禁缺项（422 STAGE_GATE_NOT_PASSED 的 details）。 */
export type StageGateMissingItem =
  | { type: "node_not_done"; nodeId: string; nodeKey: string; name: string; status: string }
  | { type: "task_not_done"; total: number; done: number }
  | { type: "task_delivery_missing"; total: number; ready: number }
  | { type: "doc_missing"; nodeId: string; nodeKey: string; docType: string; required: number; present: number };

/** 项目标记完成前的任务交付缺项（FlowService 转 422 明细；缺少成果类型配置的任务不产生缺项）。 */
export type ProjectCompletionMissingItem =
  | { type: "task_not_done"; total: number; done: number }
  | {
      type: "task_delivery_missing";
      taskId: string;
      taskTitle: string;
      stageKey: string | null;
      docType: string;
      required: number;
      present: number;
    };

/**
 * 门禁判定唯一出口（v0.2 §3.6 / ADR-023）：节点完成与阶段推进共用同一实现，
 * 保证「节点 / 任务 / 阶段」三处判定一致；只读，不写库（拒绝留痕由调用方在同事务外补写）。
 */
@Injectable()
export class GateService {
  constructor(
    private readonly gate: GateRepository,
    private readonly taskStats: TaskStatsService,
  ) {}

  /** 节点完成门禁：required_doc 逐 doc_type 统计 files（status ∈ final / changed 且已定档）。 */
  async evaluateNode(client: DbClient, nodeId: string): Promise<{ missing: NodeGateMissing[] }> {
    const requirements = await this.gate.listRequirements(client, nodeId);
    const docRequirements = requirements
      .filter((item) => item.requirementType === "required_doc" && item.docType !== null)
      .map((item) => ({ docType: item.docType as string, minCount: item.minCount }));
    if (docRequirements.length === 0) return { missing: [] };
    const present = await this.gate.countFinalFilesByDocType(client, nodeId);
    const presentByType = new Map(present.map((row) => [row.docType, row.present]));
    const missing: NodeGateMissing[] = [];
    for (const requirement of docRequirements) {
      const presentCount = presentByType.get(requirement.docType) ?? 0;
      if (presentCount < requirement.minCount) {
        missing.push({ docType: requirement.docType, required: requirement.minCount, present: presentCount });
      }
    }
    return { missing };
  }

  /**
   * 阶段推进门禁（ADR-023）：
   * 1) 阶段内非 deleted 节点全部 done；2) 阶段内任务全部 done 且已配置成果类型均有上传文件；
   * 3) 节点 required_doc 逐条满足（节点完成仍沿用定档口径；防完成后文件被回收）。
   */
  async evaluateStageAdvance(
    client: DbClient,
    projectId: string,
    stageKey: string,
  ): Promise<{ ok: boolean; missing: StageGateMissingItem[] }> {
    const missing: StageGateMissingItem[] = [];
    const nodes = await this.gate.listStageNodes(client, projectId, stageKey);
    for (const node of nodes) {
      if (node.status !== "done") {
        missing.push({ type: "node_not_done", nodeId: node.id, nodeKey: node.nodeKey, name: node.name, status: node.status });
        continue;
      }
      const gate = await this.evaluateNode(client, node.id);
      for (const item of gate.missing) {
        missing.push({
          type: "doc_missing",
          nodeId: node.id,
          nodeKey: node.nodeKey,
          docType: item.docType,
          required: item.required,
          present: item.present,
        });
      }
    }
    const taskCounts = await this.taskStats.countStageTasks(client, projectId, stageKey);
    if (taskCounts.done < taskCounts.total) {
      missing.push({ type: "task_not_done", total: taskCounts.total, done: taskCounts.done });
    } else if (taskCounts.deliveryReady < taskCounts.total) {
      missing.push({
        type: "task_delivery_missing",
        total: taskCounts.total,
        ready: taskCounts.deliveryReady,
      });
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * 项目标记完成门禁：全部未删除任务 done；配置了成果类型的任务均有对应上传文件。
   * 未配置成果类型的任务只校验状态，不额外要求文件。
   */
  async evaluateProjectCompletion(
    client: DbClient,
    projectId: string,
  ): Promise<{ ok: boolean; missing: ProjectCompletionMissingItem[] }> {
    const status = await this.taskStats.evaluateProjectDelivery(client, projectId);
    const missing: ProjectCompletionMissingItem[] = [];
    if (status.done < status.total) {
      missing.push({ type: "task_not_done", total: status.total, done: status.done });
    }
    for (const issue of status.issues) {
      missing.push({ type: "task_delivery_missing", ...issue });
    }
    return { ok: missing.length === 0, missing };
  }

  /** 删除节点前置提示：关联成果文件数（> 0 → 调用方拒绝并给出行级原因）。 */
  countLinkedFiles(client: DbClient, nodeId: string): Promise<number> {
    return this.gate.countLinkedFiles(client, nodeId);
  }

  /** 阶段完成度（读时派生，不落库）：节点 / 任务计数；缺省补零由调用方处理，任务计数经 task 模块（h4 收口；未分组任务不计入，A15）。 */
  async stageProgress(
    client: DbClient,
    projectId: string,
  ): Promise<Record<string, { nodes: { total: number; done: number }; tasks: { total: number; done: number } }>> {
    const nodeRows = await this.gate.listStageProgress(client, projectId);
    const taskRows = await this.taskStats.stageTaskCounts(client, projectId);
    const result: Record<string, { nodes: { total: number; done: number }; tasks: { total: number; done: number } }> = {};
    const pick = (stageKey: string) => {
      const entry = result[stageKey] ?? { nodes: { total: 0, done: 0 }, tasks: { total: 0, done: 0 } };
      result[stageKey] = entry;
      return entry;
    };
    for (const row of nodeRows) {
      const entry = pick(row.stageKey);
      entry.nodes.total = row.nodeTotal;
      entry.nodes.done = row.nodeDone;
    }
    for (const row of taskRows) {
      // 未分组任务（stage_key 为 null，A15）不属于九阶段任一段：不计入阶段完成度。
      if (row.stageKey === null) continue;
      const entry = pick(row.stageKey);
      entry.tasks.total += row.value;
      if (row.status === "done") entry.tasks.done += row.value;
    }
    return result;
  }
}
