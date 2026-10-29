import { Injectable } from "@nestjs/common";
import { ProjectFlowSchema, STAGE_NAMES, StageListResponseSchema, z } from "@libiaolink/contracts";
import type { OutboxTopic } from "@libiaolink/contracts";
import type { StageKey } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { appendOutbox } from "../../db/outbox.js";
import { AuditService } from "../admin/index.js";
import { BlueprintService } from "../blueprint/index.js";
import {
  GateService,
  type ProjectCompletionMissingItem,
  type StageGateMissingItem,
} from "../node/index.js";
import { PermissionService } from "../permission/index.js";
import { FlowRepository, type NodeWithRequirements, type ProjectNodeRow, type ProjectStageRow } from "./flow.repository.js";
import { ProjectMemberRepository } from "./project-member.repository.js";
import { ProjectRepository, type ProjectViewRow } from "./project.repository.js";

export type ProjectFlow = z.infer<typeof ProjectFlowSchema>;
export type StageListResponse = z.infer<typeof StageListResponseSchema>;
export type ProjectNodeView = ProjectFlow["stages"][number]["nodes"][number];

const STAGE_NAME_BY_KEY = STAGE_NAMES as Record<string, string>;

/** 门禁拒绝的内部信号（事务回滚后补写留痕，再转 422 契约错误）。 */
class GateRejectedSignal extends Error {
  constructor(readonly appError: AppError, readonly outbox: { topic: OutboxTopic; dedupeKey: string; payload: Record<string, unknown> }) {
    super("gate_rejected");
  }
}

/**
 * 流程用例（h3 · S6·blueprint/node）：建项目导入快照（M2-02）、流程读、节点增删、完成门禁、阶段推进 / 回退（M2-03）。
 * 事务与门禁：节点完成 / 阶段推进都在事务内 FOR UPDATE + GateService 判定，拒绝不部分生效（v0.2 §3.6 / ADR-023）。
 */
@Injectable()
export class FlowService {
  constructor(
    private readonly database: DatabaseService,
    private readonly flow: FlowRepository,
    private readonly projects: ProjectRepository,
    private readonly members: ProjectMemberRepository,
    private readonly blueprints: BlueprintService,
    private readonly gate: GateService,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 建项目导入快照（M2-02）：取该项目类型已发布蓝图（缺失回落 default 模板）→ 生成 stages / nodes / requirements，
   * 首个阶段置 active 并把 projects.stage_key 前移到它；全部在同一事务内（调用方传入 tx）。
   */
  async importSnapshot(
    tx: DbClient,
    input: { projectId: string; projectType: string; requestedStageKey?: string; requestedBlueprintVersion?: number; at: Date },
  ): Promise<{ activeStageKey: StageKey; blueprintVersion: number; stages: number; nodes: number; requirements: number }> {
    const snapshot =
      input.requestedBlueprintVersion === undefined
        ? await this.blueprints.getPublishedForProject(input.projectType)
        : await this.blueprints.getVersionForProject(input.projectType, input.requestedBlueprintVersion);
    if (snapshot === null) {
      throw new AppError(
        "BLUEPRINT_NOT_PUBLISHED",
        "项目类型 [" + input.projectType + "] 与 default 模板都没有已发布蓝图，无法导入流程节点",
      );
    }
    const ordered = [...snapshot.payload.stages].sort((left, right) => left.seq - right.seq);
    const first = ordered[0];
    if (first === undefined) throw new AppError("BLUEPRINT_SCHEMA_INVALID", "蓝图没有阶段，无法导入");
    let activeStageKey = first.key as StageKey;
    if (input.requestedStageKey !== undefined) {
      const requested = ordered.find((stage) => stage.key === input.requestedStageKey);
      if (requested === undefined) {
        throw new AppError("VALIDATION_FAILED", "stageKey 不在蓝图阶段内：" + input.requestedStageKey);
      }
      activeStageKey = requested.key as StageKey;
    }
    const counts = await this.flow.importSnapshot(tx, {
      projectId: input.projectId,
      blueprintVersion: snapshot.version,
      activeStageKey,
      stages: ordered,
      at: input.at,
    });
    await appendOutbox(tx, {
      topic: "project.created",
      dedupeKey: "project.created:" + input.projectId,
      payload: {
        projectId: input.projectId,
        blueprintId: snapshot.blueprintId,
        blueprintVersion: snapshot.version,
        activeStageKey,
        at: input.at.toISOString(),
      },
    });
    return { activeStageKey, blueprintVersion: snapshot.version, ...counts };
  }

  /** GET /projects/{id}/flow：阶段 + 节点 + 约束 + 状态（蓝图版本 = 导入快照）。 */
  async getFlow(projectId: string): Promise<ProjectFlow> {
    const view = await this.loadProjectOrFail(projectId);
    const stages = await this.flow.listStages(projectId);
    const nodes = await this.flow.listNodesWithRequirements(projectId);
    const blueprintVersion = await this.flow.maxSourceBlueprintVersion(projectId);
    return {
      projectId: view.project.id,
      blueprintVersion,
      stages: stages.map((stage) => ({
        id: stage.id,
        stageKey: stage.stageKey as ProjectFlow["stages"][number]["stageKey"],
        name: STAGE_NAME_BY_KEY[stage.stageKey] ?? stage.stageKey,
        seq: stage.seq,
        status: stage.status as ProjectFlow["stages"][number]["status"],
        plannedStart: stage.plannedStart,
        plannedEnd: stage.plannedEnd,
        actualStart: stage.actualStart,
        actualEnd: stage.actualEnd,
        nodes: nodes
          .filter((item) => item.node.stageId === stage.id)
          .map((item) => this.toNodeView(item)),
      })),
    };
  }

  /** GET /projects/{id}/stages：九阶段状态与完成度（节点 / 任务读时派生）。 */
  async listStages(projectId: string, client?: DbClient): Promise<StageListResponse> {
    const view = await this.loadProjectOrFail(projectId);
    const db = client ?? this.database.db;
    const stages = await this.flow.listStages(projectId, db);
    const progress = await this.gate.stageProgress(db, projectId);
    return {
      projectId: view.project.id,
      stageKey: view.project.stageKey as StageKey,
      stages: stages.map((stage) => {
        const entry = progress[stage.stageKey] ?? { nodes: { total: 0, done: 0 }, tasks: { total: 0, done: 0 } };
        return {
          id: stage.id,
          stageKey: stage.stageKey as StageKey,
          name: STAGE_NAME_BY_KEY[stage.stageKey] ?? stage.stageKey,
          seq: stage.seq,
          status: stage.status as StageListResponse["stages"][number]["status"],
          plannedStart: stage.plannedStart,
          plannedEnd: stage.plannedEnd,
          actualStart: stage.actualStart,
          actualEnd: stage.actualEnd,
          nodes: entry.nodes,
          tasks: entry.tasks,
          advancedAt: stage.advancedAt?.toISOString() ?? null,
          advancedBy: stage.advancedBy,
          rolledBackAt: stage.rolledBackAt?.toISOString() ?? null,
          rolledBackBy: stage.rolledBackBy,
          rollbackReason: stage.rollbackReason,
          version: stage.version,
        };
      }),
    };
  }

  /** POST /projects/{id}/nodes：仅项目经理；nodeKey 必须命中项目导入版本的模板节点池（ADR-020）。 */
  async createNode(
    projectId: string,
    body: { stageId: string; nodeKey: string; name?: string; seq?: number; reason?: string },
    actorId: string,
  ): Promise<ProjectNodeView> {
    const view = await this.loadProjectForWrite(projectId);
    await this.assertProjectManager(view.project.id, view.project.managerIds, actorId, "增删节点");
    const stages = await this.flow.listStages(projectId);
    const stage = stages.find((item) => item.id === body.stageId);
    if (stage === undefined) throw new AppError("NOT_FOUND", "阶段不属于该项目：" + body.stageId);
    const blueprintVersion = await this.flow.maxSourceBlueprintVersion(projectId);
    if (blueprintVersion === 0) {
      throw new AppError("BLUEPRINT_NOT_PUBLISHED", "项目尚未导入蓝图（h3 之前建的项目不支持增补节点）");
    }
    const template = await this.blueprints.findNodeTemplate(view.project.projectType, blueprintVersion, body.nodeKey);
    if (template === null) {
      throw new AppError("BLUEPRINT_REF_UNKNOWN", "nodeKey 不在项目导入版本的模板节点池：" + body.nodeKey);
    }
    const at = new Date();
    const maxSeq = await this.flow.listNodesWithRequirements(projectId);
    const nextSeq = body.seq ?? defaultNextSeq(maxSeq, stage.id);
    const node = await this.database.db.transaction(async (tx) => {
      const existing = await this.flow.findNodeByKey(tx, projectId, body.nodeKey);
      if (existing !== null && existing.deletedAt === null) {
        throw new AppError("NODE_ALREADY_EXISTS", "项目内已有同模板节点（" + body.nodeKey + "）：如需重做请先删除再增补");
      }
      const row =
        existing === null
          ? await this.flow.insertNode(tx, {
              projectId,
              stageId: stage.id,
              nodeKey: body.nodeKey,
              name: body.name ?? template.node.name,
              seq: String(nextSeq),
              sourceBlueprintVersion: blueprintVersion,
              at,
            })
          : await this.flow.restoreNode(tx, {
              nodeId: existing.id,
              stageId: stage.id,
              name: body.name ?? existing.name,
              seq: String(nextSeq),
            });
      if (existing === null) {
        await this.flow.insertRequirements(tx, row.id, template.node.constraints, at);
      }
      await appendOutbox(tx, {
        topic: "node.added",
        dedupeKey: (existing === null ? "node.added:" : "node.restored:") + row.id + ":" + row.version,
        payload: { projectId, nodeId: row.id, nodeKey: body.nodeKey, stageId: stage.id, actorId, reason: body.reason ?? null, restored: existing !== null, at: at.toISOString() },
      });
      await this.projects.touch(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "node",
        objectId: row.id,
        projectId,
        summary: (existing === null ? "增补节点：" : "恢复节点：") + row.name + "（" + body.nodeKey + "）",
        changes: [
          { field: "nodeKey", from: null, to: body.nodeKey },
          { field: "name", from: null, to: row.name },
          { field: "stageId", from: null, to: stage.id },
          { field: "reason", from: null, to: body.reason ?? null },
        ],
      });
      return row;
    });
    return this.loadNodeView(node.id);
  }

  /** DELETE /projects/{id}/nodes/{nodeId}：软删 + 留痕（原因必填）；关联成果物时拒绝（409 NODE_HAS_FILES）。 */
  async deleteNode(
    projectId: string,
    nodeId: string,
    body: { version: number; reason: string },
    actorId: string,
  ): Promise<ProjectNodeView> {
    const view = await this.loadProjectForWrite(projectId);
    await this.assertProjectManager(view.project.id, view.project.managerIds, actorId, "增删节点");
    const at = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const node = await this.flow.lockNode(tx, nodeId);
      if (node === null || node.projectId !== projectId) throw new AppError("NOT_FOUND", "节点不存在或不属于该项目");
      if (node.status === "deleted") throw new AppError("NODE_DELETED", "节点已删除");
      if (node.version !== body.version) throw new AppError("VERSION_CONFLICT", "节点已被他人更新，请刷新后重试");
      const linked = await this.gate.countLinkedFiles(tx, nodeId);
      if (linked > 0) {
        throw new AppError("NODE_HAS_FILES", "节点下已有 " + linked + " 个成果文件，删除前请先处理", [
          { code: "node_has_files", message: "关联成果文件数：" + linked, path: "nodeId", meta: { linked } },
        ]);
      }
      const version = await this.flow.softDeleteNode(tx, nodeId, body.version, actorId, at);
      if (version < 0) throw new AppError("VERSION_CONFLICT", "节点已被他人更新，请刷新后重试");
      await appendOutbox(tx, {
        topic: "node.deleted",
        dedupeKey: "node.deleted:" + nodeId + ":" + version,
        payload: { projectId, nodeId, nodeKey: node.nodeKey, actorId, reason: body.reason, at: at.toISOString() },
      });
      await this.projects.touch(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "node",
        objectId: nodeId,
        projectId,
        summary: "删除节点：" + node.name + "（" + node.nodeKey + "）；原因：" + body.reason,
        changes: [{ field: "status", from: node.status, to: "deleted" }],
        metadata: { reason: body.reason },
      });
      return { ...node, status: "deleted", deletedAt: at, deletedBy: actorId, version };
    });
    void result;
    return this.loadNodeView(nodeId);
  }

  /** POST /nodes/{id}/complete：事务内过门禁（缺件 422 + missing；拒绝也留痕）。 */
  async completeNode(nodeId: string, version: number, actorId: string): Promise<ProjectNodeView> {
    const at = new Date();
    try {
      await this.database.db.transaction(async (tx) => {
        const node = await this.flow.lockNode(tx, nodeId);
        if (node === null) throw new AppError("NOT_FOUND", "节点不存在或不可见");
        if (node.status === "deleted") throw new AppError("NODE_DELETED", "节点已删除");
        if (node.status === "done") throw new AppError("NODE_ALREADY_DONE", "节点已完成");
        const project = await this.projects.findRowById(node.projectId, tx);
        if (project !== null && project.status === "archived") {
          throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止修改流程");
        }
        if (node.version !== version) throw new AppError("VERSION_CONFLICT", "节点已被他人更新，请刷新后重试");
        const gate = await this.gate.evaluateNode(tx, nodeId);
        if (gate.missing.length > 0) {
          const rejection = new AppError(
            "NODE_REQUIRED_DOC_MISSING",
            "缺少必交成果文件，无法完成节点（NODE_REQUIRED_DOC_MISSING）",
            gate.missing.map((item) => ({
              code: "required_doc",
              message: "缺少必交成果文件：" + item.docType + "（需要 " + item.required + "，现有 " + item.present + "）",
              path: "missing",
              meta: { ...item },
            })),
          );
          throw new GateRejectedSignal(rejection, {
            topic: "node.gate_rejected",
            dedupeKey: "node.gate_rejected:" + nodeId + ":" + at.getTime(),
            payload: { nodeId, projectId: node.projectId, nodeKey: node.nodeKey, missing: gate.missing, actorId, at: at.toISOString() },
          });
        }
        const nextVersion = await this.flow.markNodeDone(tx, nodeId, version, actorId, at);
        if (nextVersion < 0) throw new AppError("VERSION_CONFLICT", "节点已被他人更新，请刷新后重试");
        await appendOutbox(tx, {
          topic: "node.completed",
          dedupeKey: "node.completed:" + nodeId + ":" + nextVersion,
          payload: { nodeId, projectId: node.projectId, nodeKey: node.nodeKey, actorId, at: at.toISOString() },
        });
        await this.projects.touch(node.projectId, at, tx);
        await this.audit.record(tx, {
          actorId,
          action: "complete",
          objectType: "node",
          objectId: nodeId,
          projectId: node.projectId,
          summary: "完成节点：" + node.name + "（" + node.nodeKey + "）",
          changes: [{ field: "status", from: node.status, to: "done" }],
        });
      });
      return await this.loadNodeView(nodeId);
    } catch (error) {
      if (error instanceof GateRejectedSignal) {
        await appendOutbox(this.database.db, error.outbox);
        const rejectedProjectId =
          typeof error.outbox.payload["projectId"] === "string" ? error.outbox.payload["projectId"] : null;
        await this.audit.record(this.database.db, {
          actorId,
          action: "complete",
          objectType: "node",
          objectId: nodeId,
          projectId: rejectedProjectId,
          result: "failed",
          summary: "完成节点被门禁拒绝：" + error.appError.message,
          metadata: { errorCode: error.appError.code, details: error.appError.details },
        });
        throw error.appError;
      }
      throw error;
    }
  }

  /** GET /nodes/{id}/can-complete：预检（UI 置灰依据；不替代事务内强校验）。 */
  async canComplete(nodeId: string): Promise<{ canComplete: boolean; missing: { docType: string; required: number; present: number }[] }> {
    const node = await this.flow.findNodeById(nodeId);
    if (node === null) throw new AppError("NOT_FOUND", "节点不存在或不可见");
    if (node.status === "deleted") throw new AppError("NODE_DELETED", "节点已删除");
    if (node.status === "done") return { canComplete: false, missing: [] };
    const gate = await this.gate.evaluateNode(this.database.db, nodeId);
    return { canComplete: gate.missing.length === 0, missing: gate.missing };
  }

  /** POST /projects/{id}/stages/{key}/advance：事务内门禁（任务 / 节点 / 成果文件）→ 阶段 done、下一阶段 active、stage_key 前移。 */
  async advanceStage(projectId: string, stageKey: string, version: number, actorId: string): Promise<StageListResponse> {
    const view = await this.loadProjectForWrite(projectId);
    await this.assertProjectManager(view.project.id, view.project.managerIds, actorId, "阶段推进");
    const at = new Date();
    try {
      await this.database.db.transaction(async (tx) => {
        const stage = await this.flow.findStage(projectId, stageKey);
        if (stage === null) throw new AppError("NOT_FOUND", "阶段不存在：" + stageKey);
        const locked = await this.flow.lockStage(tx, stage.id);
        if (locked === null) throw new AppError("NOT_FOUND", "阶段不存在：" + stageKey);
        if (locked.status !== "active") {
          throw new AppError("STAGE_STATE_INVALID", "仅当前阶段可推进（本阶段状态：" + locked.status + "）");
        }
        if (locked.version !== version) throw new AppError("VERSION_CONFLICT", "阶段已被他人更新，请刷新后重试");
        const gate = await this.gate.evaluateStageAdvance(tx, projectId, stageKey);
        if (!gate.ok) {
          throw new GateRejectedSignal(
            new AppError(
              "STAGE_GATE_NOT_PASSED",
              "阶段门禁未通过（" + gate.missing.length + " 项缺项）",
              gate.missing.map((item) => ({ code: item.type, message: stageMissingMessage(item), path: "missing", meta: { ...item } })),
            ),
            {
              topic: "stage.gate_rejected",
              dedupeKey: "stage.gate_rejected:" + locked.id + ":" + at.getTime(),
              payload: { projectId, stageKey, missing: gate.missing, actorId, at: at.toISOString() },
            },
          );
        }
        const stages = await this.flow.listStages(projectId, tx);
        const next = stages.find((item) => item.seq > locked.seq) ?? null;
        const nextVersion = await this.flow.updateStageAdvanced(tx, locked.id, version, actorId, at);
        if (nextVersion < 0) throw new AppError("VERSION_CONFLICT", "阶段已被他人更新，请刷新后重试");
        if (next === null) {
          await this.projects.touch(projectId, at, tx);
        } else {
          await this.flow.updateStageStatus(tx, next.id, "active", next.version);
          await this.flow.setStageNodesStatus(tx, next.id, "pending", "active");
          await this.projects.setStageKey(projectId, next.stageKey, at, tx);
        }
        await appendOutbox(tx, {
          topic: "stage.advanced",
          dedupeKey: "stage.advanced:" + locked.id + ":" + nextVersion,
          payload: { projectId, stageKey, nextStageKey: next?.stageKey ?? null, stageVersion: nextVersion, actorId, at: at.toISOString() },
        });
        await this.audit.record(tx, {
          actorId,
          action: "advance",
          objectType: "stage",
          objectId: stageKey,
          projectId,
          summary: "阶段推进：" + stageKey + " → " + (next?.stageKey ?? "（末阶段，流程完成）"),
          changes: [{ field: "status", from: "active", to: "done" }],
        });
      });
    } catch (error) {
      if (error instanceof GateRejectedSignal) {
        await appendOutbox(this.database.db, error.outbox);
        await this.audit.record(this.database.db, {
          actorId,
          action: "advance",
          objectType: "stage",
          objectId: stageKey,
          projectId,
          result: "failed",
          summary: "阶段推进被门禁拒绝：" + error.appError.message,
          metadata: { errorCode: error.appError.code, details: error.appError.details },
        });
        throw error.appError;
      }
      throw error;
    }
    return this.listStages(projectId);
  }

  /** POST /projects/{id}/stages/{key}/rollback：回退仅相邻上一阶段、原因必填、不做门禁（ADR-023）。 */
  async rollbackStage(
    projectId: string,
    stageKey: string,
    body: { reason: string; version: number },
    actorId: string,
  ): Promise<StageListResponse> {
    const view = await this.loadProjectForWrite(projectId);
    await this.assertProjectManager(view.project.id, view.project.managerIds, actorId, "阶段回退");
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const stage = await this.flow.findStage(projectId, stageKey);
      if (stage === null) throw new AppError("NOT_FOUND", "阶段不存在：" + stageKey);
      const locked = await this.flow.lockStage(tx, stage.id);
      if (locked === null) throw new AppError("NOT_FOUND", "阶段不存在：" + stageKey);
      if (locked.status !== "active") {
        throw new AppError("STAGE_STATE_INVALID", "仅当前阶段可回退（本阶段状态：" + locked.status + "）");
      }
      if (locked.version !== body.version) throw new AppError("VERSION_CONFLICT", "阶段已被他人更新，请刷新后重试");
      const stages = await this.flow.listStages(projectId, tx);
      const previous = stages.filter((item) => item.seq < locked.seq).sort((left, right) => right.seq - left.seq)[0];
      if (previous === undefined) {
        throw new AppError("STAGE_STATE_INVALID", "首阶段没有上一阶段可回退：" + stageKey);
      }
      const nextVersion = await this.flow.updateStageRolledBack(tx, locked.id, "pending", body.reason, body.version, actorId, at);
      if (nextVersion < 0) throw new AppError("VERSION_CONFLICT", "阶段已被他人更新，请刷新后重试");
      await this.flow.updateStageStatus(tx, previous.id, "active", previous.version);
      await this.flow.setStageNodesStatus(tx, locked.id, "active", "pending");
      await this.projects.setStageKey(projectId, previous.stageKey, at, tx);
      await appendOutbox(tx, {
        topic: "stage.rolled_back",
        dedupeKey: "stage.rolled_back:" + locked.id + ":" + nextVersion,
        payload: { projectId, stageKey, backTo: previous.stageKey, reason: body.reason, actorId, at: at.toISOString() },
      });
      await this.audit.record(tx, {
        actorId,
        action: "rollback",
        objectType: "stage",
        objectId: stageKey,
        projectId,
        summary: "阶段回退：" + stageKey + " → " + previous.stageKey + "（原因：" + body.reason + "）",
        changes: [{ field: "status", from: "active", to: "pending" }],
        metadata: { reason: body.reason, backTo: previous.stageKey },
      });
    });
    return this.listStages(projectId);
  }

  /** 项目可见性：软删 / 不存在统一 404（记录级 404 语义随 h6 策略服务）。 */
  private async loadProjectOrFail(projectId: string): Promise<ProjectViewRow> {
    const view = await this.projects.findViewById(projectId);
    if (view === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    return view;
  }

  /** 流程写入口：归档项目一律 409 PROJECT_ARCHIVED（ADR-027）。 */
  private async loadProjectForWrite(projectId: string): Promise<ProjectViewRow> {
    const view = await this.loadProjectOrFail(projectId);
    if (view.project.status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止修改流程");
    }
    return view;
  }

  /** 节点增删 / 阶段推进 / 项目归档的权限：项目经理（manager_ids 任一位）/ 名册项目经理 / 管理员（ADR-020 / A22 / ADR-027）；记录级 404 语义随 h6。 */
  /**
   * 项目标记完成门禁：所有任务已完成，且配置了成果类型的任务均已上传对应文件。
   * 未配置成果类型的任务只检查完成状态；缺交付文件时返回 422 TASK_REQUIRED_DOC_MISSING，前端沿用统一 Toast 提示。
   */
  async assertProjectCompletionGate(client: DbClient, projectId: string): Promise<void> {
    const gate = await this.gate.evaluateProjectCompletion(client, projectId);
    if (gate.ok) return;
    const pending = gate.missing.find((item) => item.type === "task_not_done");
    const deliveries = gate.missing.filter(
      (item): item is Extract<ProjectCompletionMissingItem, { type: "task_delivery_missing" }> =>
        item.type === "task_delivery_missing",
    );
    const parts: string[] = [];
    if (deliveries.length > 0) parts.push("有 " + deliveries.length + " 项已配置成果文件尚未上传");
    if (pending !== undefined) parts.push("有 " + (pending.total - pending.done) + " / " + pending.total + " 项任务未完成");
    const examples = [...new Set(deliveries.map((item) => "「" + item.taskTitle + "」" + item.docType))].slice(0, 3);
    const suffix = examples.length === 0 ? "" : "：" + examples.join("、");
    throw new AppError(
      deliveries.length > 0 ? "TASK_REQUIRED_DOC_MISSING" : "VALIDATION_FAILED",
      "项目无法标记为已完成 —— " + parts.join("；") + suffix,
      gate.missing.map((item) => ({
        code: item.type,
        message: projectCompletionMissingMessage(item),
        path: "missing",
        meta: { ...item },
      })),
    );
  }

  async assertProjectManager(projectId: string, managerIds: readonly string[], actorId: string, action: string): Promise<void> {
    if (await this.permission.canManageGroupAccess(actorId)) return;
    if (managerIds.includes(actorId)) return;
    const member = await this.members.findByProjectAndUser(projectId, actorId);
    if (member !== null && member.member.roleInProject === "project_manager") return;
    throw new AppError("FORBIDDEN", "仅项目经理可执行" + action + "（ADR-020）");
  }

  private toNodeView(item: NodeWithRequirements): ProjectNodeView {
    const node = item.node;
    return {
      id: node.id,
      projectId: node.projectId,
      stageId: node.stageId,
      nodeKey: node.nodeKey,
      name: node.name,
      seq: Number(node.seq),
      status: node.status as ProjectNodeView["status"],
      origin: node.origin as ProjectNodeView["origin"],
      doneAt: node.doneAt === null ? null : node.doneAt.toISOString(),
      doneBy: node.doneBy,
      sourceBlueprintVersion: node.sourceBlueprintVersion,
      version: node.version,
      requirements: item.requirements.map((requirement) => ({
        requirementType: requirement.requirementType as ProjectNodeView["requirements"][number]["requirementType"],
        docType: requirement.docType as ProjectNodeView["requirements"][number]["docType"],
        minCount: requirement.minCount,
      })),
    };
  }

  /** 读回节点（含约束）作为响应视图。 */
  private async loadNodeView(nodeId: string): Promise<ProjectNodeView> {
    const node = await this.flow.findNodeById(nodeId);
    if (node === null) throw new AppError("NOT_FOUND", "节点不存在或不可见");
    const requirements = await this.flow.listRequirementsByNode(nodeId);
    return this.toNodeView({ node, requirements });
  }
}

/** 阶段门禁缺项的可读说明（422 details）。 */
function projectCompletionMissingMessage(item: ProjectCompletionMissingItem): string {
  if (item.type === "task_not_done") return "项目仍有任务未完成：" + item.done + " / " + item.total;
  return "任务「" + item.taskTitle + "」缺少已上传的成果文件：" + item.docType + "（需要 " + item.required + "，现有 " + item.present + "）";
}

function stageMissingMessage(item: StageGateMissingItem): string {
  if (item.type === "node_not_done") return "节点未完成：" + item.name + "（" + item.nodeKey + "，状态 " + item.status + "）";
  if (item.type === "task_not_done") return "阶段内任务未全部完成：" + item.done + " / " + item.total;
  if (item.type === "task_delivery_missing") {
    return "阶段内已完成任务缺少交付文件：" + item.ready + " / " + item.total + " 份已齐套";
  }
  return "节点 " + item.nodeKey + " 缺少必交成果文件：" + item.docType + "（需要 " + item.required + "，现有 " + item.present + "）";
}

/** 增补节点排序：同阶段内现有最大 seq + 10（与蓝图步长一致；v0.2 §3.2）。 */
function defaultNextSeq(items: NodeWithRequirements[], stageId: string): number {
  let max = 0;
  for (const item of items) {
    if (item.node.stageId !== stageId) continue;
    const value = Number(item.node.seq);
    if (value > max) max = value;
  }
  return max + 10;
}
