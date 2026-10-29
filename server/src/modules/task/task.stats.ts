import { Injectable } from "@nestjs/common";
import type { DbClient } from "../../db/db-client.js";
import { TaskGateRepository, type TaskDeliveryStatus } from "./task.gate.repository.js";
import { TaskRepository } from "./task.repository.js";

/**
 * 任务统计出口（跨模块只读）：GateService 阶段 / 项目完成门禁与阶段完成度（GET /projects/{id}/stages）复用。
 * h4 起 node 模块不再直读 tasks 表（h3 过渡口径收口）；写路径仍归 TaskService。
 */
@Injectable()
export class TaskStatsService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly gate: TaskGateRepository,
  ) {}

  /** 阶段内任务数 / 已完成数 / 交付要求已满足的完成数（未配置成果类型的任务视为已满足）。 */
  async countStageTasks(client: DbClient, projectId: string, stageKey: string): Promise<TaskDeliveryStatus> {
    return this.gate.evaluateDeliveryStatus(client, projectId, stageKey);
  }

  /** 全项目任务数 / 已完成数 / 交付缺项（项目标记完成前复核）。 */
  async evaluateProjectDelivery(client: DbClient, projectId: string): Promise<TaskDeliveryStatus> {
    return this.gate.evaluateDeliveryStatus(client, projectId);
  }

  /** 全项目任务按阶段 / 状态的计数（调用方按阶段聚合；stage_key 可空，A15：未分组任务自成一组）。 */
  async stageTaskCounts(client: DbClient, projectId: string): Promise<{ stageKey: string | null; status: string; value: number }[]> {
    return this.repository.taskCountsByStage(client, projectId);
  }
}