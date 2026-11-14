import { Injectable } from "@nestjs/common";
import { STAGE_NAMES } from "@libiaolink/contracts";
import type {
  TaskNode,
  TaskNodeRequest,
  TaskNodeRequestApproveBody,
  TaskNodeRequestDecisionResponse,
  TaskNodeRequestListQuery,
  TaskNodeRequestListResponse,
  TaskNodeRequestRejectBody,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import { TaskNodeRepository } from "./task-node.repository.js";
import type { TaskNodeRow } from "./task-node.repository.js";
import { TaskNodeRequestRepository } from "./task-node-request.repository.js";
import type { TaskNodeRequestRow } from "./task-node-request.repository.js";

const STAGE_NAME_BY_KEY = STAGE_NAMES as Record<string, string>;

/** 节点快照（审计字段级留痕口径，与 template.service 同构）。 */
function nodeSnapshot(row: TaskNodeRow): Record<string, unknown> {
  return { stageKey: row.stageKey, seq: row.seq, title: row.title, titleEn: row.titleEn };
}

/** 申请快照（审计字段级留痕口径）：状态 / 名称 / 审核结论 / 最终节点。 */
function requestSnapshot(row: {
  status: string;
  stageKey: string;
  title: string;
  titleEn: string | null;
  reviewNote: string | null;
  nodeId: string | null;
}): Record<string, unknown> {
  return {
    status: row.status,
    stageKey: row.stageKey,
    title: row.title,
    titleEn: row.titleEn,
    reviewNote: row.reviewNote,
    nodeId: row.nodeId,
  };
}

/** 导入侧提交申请的单条（服务层已按预览分组校验过阶段与「保留原名」）。 */
export interface ImportNodeRequestItem {
  stageKey: string;
  title: string;
  titleEn: string | null;
}

/** 导入侧提交申请的结果：落库（或复用）的申请 + 因「该阶段已有同名公共节点」被跳过的名称。 */
export interface ImportNodeRequestResult {
  requests: TaskNodeRequestRow[];
  /** 该阶段已有同名公共节点 → 不提交申请（任务仍按原名导入）。 */
  existingNodes: Array<{ stageKey: string; title: string }>;
  /** 命中已存在的同阶段同名待审申请 → 直接沿用该申请，不重复提交。 */
  reusedPending: number;
}

/**
 * 公共任务节点申请域用例（0096 · 2026-11-13）。
 * 业务口径：导入表导入不再向公共节点库补节点；未匹配 / 保留 Excel 原名的任务改为「申请加入公共节点库」，
 * 由权限页勾选且当前仍为系统管理员的审核人逐条通过或驳回。
 * - 申请与导入同事务提交（createFromImport 接收外部事务），导入回滚则申请一起回滚；
 * - 通过时才写 task_nodes：同阶段同名已有公共节点则直接关联（不重复建），否则追加到该阶段末尾并写节点审计；
 * - 驳回原因必填，申请人可见；申请人可撤销本人 pending 申请；
 * - 待审列表是审核人视角（需要公共节点审核权）；本人视角任何登录账号可看自己的申请。
 */
@Injectable()
export class TaskNodeRequestService {
  constructor(
    private readonly requests: TaskNodeRequestRepository,
    private readonly nodes: TaskNodeRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /** GET /api/v1/task-node-requests：审核人看全部（可按阶段 / 状态筛），本人视角只看自己。 */
  async list(query: TaskNodeRequestListQuery, actorId: string): Promise<TaskNodeRequestListResponse> {
    if (query.mine === "true") {
      const rows = await this.requests.list(
        { stageKey: query.stage ?? null, status: query.status ?? null, requestedBy: actorId },
      );
      return {
        items: rows.map(toContract),
        total: rows.length,
        pendingCount: await this.requests.countPending(actorId),
      };
    }
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "查看公共节点申请需要已授权的管理员权限");
    const rows = await this.requests.list(
      { stageKey: query.stage ?? null, status: query.status ?? null, requestedBy: null },
    );
    return {
      items: rows.map(toContract),
      total: rows.length,
      pendingCount: await this.requests.countPending(null),
    };
  }

  /**
   * 导入提交时创建申请（在导入事务内调用）：同阶段同名已存在公共节点 → 跳过并回报（调用方出提醒）；
   * 已有同阶段同名 pending 申请 → 直接复用，不重复插行（部分唯一索引兜底并发）。
   */
  async createFromImport(
    params: { actorId: string; projectId: string; previewId: string; items: readonly ImportNodeRequestItem[] },
    tx: DbClient,
  ): Promise<ImportNodeRequestResult> {
    const requests: TaskNodeRequestRow[] = [];
    const existingNodes: Array<{ stageKey: string; title: string }> = [];
    let reusedPending = 0;
    const seen = new Set<string>();
    const at = new Date();
    for (const item of params.items) {
      const title = item.title.trim();
      if (title === "") continue;
      const dedupeKey = JSON.stringify([item.stageKey, title]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const existingNode = await this.nodes.findByTitle(item.stageKey, title, null, tx);
      if (existingNode !== null) {
        existingNodes.push({ stageKey: item.stageKey, title });
        continue;
      }
      const pending = await this.requests.findPendingByTitle(item.stageKey, title, tx);
      if (pending !== null) {
        requests.push(pending);
        reusedPending += 1;
        continue;
      }
      const inserted = await this.requests.insertIfAbsent(
        {
          stageKey: item.stageKey,
          title,
          titleEn: item.titleEn === null || item.titleEn.trim() === "" ? null : item.titleEn.trim(),
          requestedBy: params.actorId,
          requestedAt: at,
          projectId: params.projectId,
          sourcePreviewId: params.previewId,
        },
        tx,
      );
      if (inserted !== null) {
        requests.push(inserted);
        continue;
      }
      // 并发下另一条同阶段同名申请抢先落库：复用既有 pending。
      const raced = await this.requests.findPendingByTitle(item.stageKey, title, tx);
      if (raced !== null) {
        requests.push(raced);
        reusedPending += 1;
      }
    }
    return { requests, existingNodes, reusedPending };
  }

  /** POST /api/v1/task-node-requests/{id}/approve：可先改中英文名；同阶段同名已存在则直接关联。 */
  async approve(id: string, body: TaskNodeRequestApproveBody, actorId: string): Promise<TaskNodeRequestDecisionResponse> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "审核公共节点申请需要已授权的管理员权限");
    const at = new Date();
    const outcome = await this.database.db.transaction(async (tx) => {
      const before = await this.requests.lockById(id, tx);
      if (before === null) throw new AppError("NOT_FOUND", "公共节点申请不存在：" + id);
      if (before.status !== "pending") {
        throw new AppError("VALIDATION_FAILED", "该申请已处理，请刷新后重试");
      }
      const title = (body.title ?? before.title).trim();
      if (title === "") throw new AppError("VALIDATION_FAILED", "节点名称不能为空");
      const titleEn = body.titleEn === undefined
        ? before.titleEn
        : body.titleEn === null || body.titleEn.trim() === ""
          ? null
          : body.titleEn.trim();
      const existing = await this.nodes.findByTitle(before.stageKey, title, null, tx);
      let node = existing;
      if (node === null) {
        const seq = (await this.nodes.maxSeq(before.stageKey, tx)) + 10;
        node = await this.nodes.insert({ ownerTemplateId: null, stageKey: before.stageKey, seq, title, titleEn }, tx);
        await this.audit.record(tx, {
          actorId,
          action: "create",
          objectType: "task_node",
          objectId: node.id,
          summary: "审核通过公共节点申请：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + node.title,
          changes: diffRecords({}, nodeSnapshot(node)),
          metadata: { stageKey: node.stageKey, seq: node.seq, source: "task_node_request", requestId: id },
        });
      }
      const after = await this.requests.decide(
        id,
        {
          status: "approved",
          reviewedBy: actorId,
          reviewedAt: at,
          reviewNote: body.note === undefined || body.note.trim() === "" ? null : body.note.trim(),
          nodeId: node.id,
        },
        tx,
      );
      if (after === null) throw new AppError("VALIDATION_FAILED", "该申请已处理，请刷新后重试");
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node_request",
        objectId: id,
        summary: (existing === null ? "通过并新建公共节点申请：" : "通过公共节点申请并关联已有节点：") +
          STAGE_NAME_BY_KEY[before.stageKey] + " · " + node.title,
        changes: diffRecords(requestSnapshot(before), requestSnapshot(after)),
        metadata: { stageKey: before.stageKey, nodeId: node.id, linkedExisting: existing !== null },
      });
      return { after, node, linkedExisting: existing !== null };
    });
    return {
      request: toContract(outcome.after),
      node: toContractNode(outcome.node),
      linkedExisting: outcome.linkedExisting,
    };
  }

  /** POST /api/v1/task-node-requests/{id}/reject：原因必填；申请人可见。 */
  async reject(id: string, body: TaskNodeRequestRejectBody, actorId: string): Promise<TaskNodeRequestDecisionResponse> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "审核公共节点申请需要已授权的管理员权限");
    const reason = body.reason.trim();
    if (reason === "") throw new AppError("VALIDATION_FAILED", "驳回原因不能为空");
    const at = new Date();
    const after = await this.database.db.transaction(async (tx) => {
      const before = await this.requests.lockById(id, tx);
      if (before === null) throw new AppError("NOT_FOUND", "公共节点申请不存在：" + id);
      if (before.status !== "pending") {
        throw new AppError("VALIDATION_FAILED", "该申请已处理，请刷新后重试");
      }
      const decided = await this.requests.decide(
        id,
        { status: "rejected", reviewedBy: actorId, reviewedAt: at, reviewNote: reason, nodeId: null },
        tx,
      );
      if (decided === null) throw new AppError("VALIDATION_FAILED", "该申请已处理，请刷新后重试");
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node_request",
        objectId: id,
        summary: "驳回公共节点申请：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + before.title,
        changes: diffRecords(requestSnapshot(before), requestSnapshot(decided)),
        metadata: { stageKey: before.stageKey, reviewedResult: "rejected" },
      });
      return decided;
    });
    return { request: toContract(after), node: null, linkedExisting: false };
  }

  /** POST /api/v1/task-node-requests/{id}/withdraw：申请人撤销本人待审申请。 */
  async withdraw(id: string, actorId: string): Promise<TaskNodeRequestDecisionResponse> {
    const at = new Date();
    const after = await this.database.db.transaction(async (tx) => {
      const before = await this.requests.lockById(id, tx);
      if (before === null) throw new AppError("NOT_FOUND", "公共节点申请不存在：" + id);
      if (before.requestedBy !== actorId) {
        throw new AppError("FORBIDDEN", "只能撤销本人的申请");
      }
      if (before.status !== "pending") {
        throw new AppError("VALIDATION_FAILED", "该申请已处理，不能撤销");
      }
      const withdrawn = await this.requests.withdraw(id, actorId, at, tx);
      if (withdrawn === null) throw new AppError("VALIDATION_FAILED", "该申请已处理，不能撤销");
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node_request",
        objectId: id,
        summary: "撤销公共节点申请：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + before.title,
        changes: diffRecords(requestSnapshot(before), requestSnapshot(withdrawn)),
        metadata: { stageKey: before.stageKey },
      });
      return withdrawn;
    });
    return { request: toContract(after), node: null, linkedExisting: false };
  }
}

function toContract(row: TaskNodeRequestRow): TaskNodeRequest {
  return {
    id: row.id,
    stageKey: row.stageKey as TaskNodeRequest["stageKey"],
    title: row.title,
    titleEn: row.titleEn,
    status: row.status as TaskNodeRequest["status"],
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName,
    requestedAt: row.requestedAt.toISOString(),
    projectId: row.projectId,
    projectCode: row.projectCode,
    projectName: row.projectName,
    reviewedBy: row.reviewedBy,
    reviewedByName: row.reviewedByName,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewNote: row.reviewNote,
    nodeId: row.nodeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toContractNode(row: TaskNodeRow): TaskNode {
  return {
    id: row.id,
    stageKey: row.stageKey as TaskNode["stageKey"],
    seq: row.seq,
    title: row.title,
    titleEn: row.titleEn,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
