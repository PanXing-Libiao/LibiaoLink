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
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { appendOutboxIfAbsent } from "../../db/outbox.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import { TaskNodeRepository } from "./task-node.repository.js";
import type { TaskNodeRow } from "./task-node.repository.js";
import { TaskNodeRequestRepository } from "./task-node-request.repository.js";
import type { TaskNodeRequestRow } from "./task-node-request.repository.js";
import { TaskNodeReviewNotificationSettingsRepository } from "./task-node-review-notification.repository.js";
import {
  buildTaskNodeReviewMessage,
  buildTaskNodeReviewResultMessage,
  looksLikeTaskNodeReviewReply,
  parseTaskNodeReviewReply,
} from "./task-node-review-wecom.js";

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
    private readonly reviewNotifications: TaskNodeReviewNotificationSettingsRepository,
    private readonly config: AppConfig,
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
    const createdRequests: TaskNodeRequestRow[] = [];
    const existingNodes: Array<{ stageKey: string; title: string }> = [];
    let reusedPending = 0;
    const seen = new Set<string>();
    const at = new Date();
    if (params.items.length > 0) {
      await this.requests.lockRequestNumbering(params.actorId, tx);
    }
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
          requestNo: await this.requests.nextRequestNo(params.actorId, tx),
          projectId: params.projectId,
          sourcePreviewId: params.previewId,
        },
        tx,
      );
      if (inserted !== null) {
        requests.push(inserted);
        createdRequests.push(inserted);
        continue;
      }
      // 并发下另一条同阶段同名申请抢先落库：复用既有 pending。
      const raced = await this.requests.findPendingByTitle(item.stageKey, title, tx);
      if (raced !== null) {
        requests.push(raced);
        reusedPending += 1;
      }
    }
    await this.enqueueImmediateReviewNotifications(createdRequests, tx);
    return { requests, existingNodes, reusedPending };
  }

  /**
   * 及时通知：新申请落库后，只给本人开启且选择 immediate 的当前有效审核人即时写 outbox。
   * 固定时间审核人留给 worker 到点派发；复用既有 pending 申请不算新申请，不重复通知。
   */
  private async enqueueImmediateReviewNotifications(
    createdRequests: readonly TaskNodeRequestRow[],
    tx: DbClient,
  ): Promise<void> {
    if (createdRequests.length === 0) return;
    const reviewerIds = await this.permission.listEffectiveTaskNodeReviewers();
    if (reviewerIds.length === 0) return;
    const immediateReviewerIds = await this.reviewNotifications.listImmediateEnabledReviewerIds(reviewerIds, tx);
    if (immediateReviewerIds.length === 0) return;
    const nodesByStage = new Map<string, TaskNodeRow[]>();
    const baseUrl = this.config.env.PUBLIC_APP_BASE_URL;
    for (const request of createdRequests) {
      let existingNodes = nodesByStage.get(request.stageKey);
      if (existingNodes === undefined) {
        existingNodes = await this.nodes.list(request.stageKey, tx);
        nodesByStage.set(request.stageKey, existingNodes);
      }
      const stageName = STAGE_NAME_BY_KEY[request.stageKey] ?? request.stageKey;
      const title = "公共节点入库审核｜" + stageName;
      const body = buildTaskNodeReviewMessage({ stageName, request, existingNodes, publicBaseUrl: baseUrl });
      for (const reviewerId of immediateReviewerIds) {
        await appendOutboxIfAbsent(tx, {
          topic: "notify.message",
          dedupeKey: "task-node-request-review:" + request.id + ":" + reviewerId,
          payload: {
            recipientId: reviewerId,
            type: "approval",
            channel: "wecom_aibot",
            title,
            body,
            refType: "task_node_request",
            refId: request.id,
            templateCode: "TASK_NODE_REQUEST_REVIEW",
            mergeKey: "task-node-request:" + request.id,
          },
        });
      }
    }
  }

  /**
   * 审批落定后给其他当前有效审核人各发一条结果通知。
   * 与申请状态变更同事务写 outbox；同一申请的行锁保证只有一个审核人能进入这里。
   */
  private async enqueueReviewResultNotifications(
    request: TaskNodeRequestRow,
    decision: "approved" | "rejected",
    actorId: string,
    reviewerIds: readonly string[],
    tx: DbClient,
  ): Promise<void> {
    const stageName = STAGE_NAME_BY_KEY[request.stageKey] ?? request.stageKey;
    const body = buildTaskNodeReviewResultMessage({ stageName, request, decision });
    for (const reviewerId of reviewerIds) {
      if (reviewerId === actorId) continue;
      await appendOutboxIfAbsent(tx, {
        topic: "notify.message",
        dedupeKey: "task-node-request-review-result:" + request.id + ":" + reviewerId,
        payload: {
          recipientId: reviewerId,
          type: "approval",
          channel: "wecom_aibot",
          title: "公共节点审核结果｜" + stageName,
          body,
          refType: "task_node_request",
          refId: request.id,
          templateCode: "TASK_NODE_REQUEST_REVIEW_RESULT",
          mergeKey: "task-node-request-result:" + request.id,
        },
      });
    }
  }

  /** 企微审核回复是否为完整可执行命令；格式错误但意图明显时另走 help 回执。 */
  acceptsWecomReview(text: string): boolean {
    return parseTaskNodeReviewReply(text) !== null;
  }

  looksLikeWecomReview(text: string): boolean {
    return looksLikeTaskNodeReviewReply(text);
  }

  /**
   * 执行企微回复审核：申请人显示名 + 申请号定位当前 pending；同意不改名，驳回省略理由时记「无」。
   * 返回会话内回执；任何失败都收敛为可读中文，不向企微透出内部 id。
   */
  async handleWecomReview(actorId: string, text: string): Promise<string> {
    const command = parseTaskNodeReviewReply(text);
    if (command === null) {
      return "回复格式：同意潘兴的1号申请 / 驳回潘兴的1号申请 与节点重复";
    }
    const label = command.requesterName + "的" + String(command.requestNo) + "号申请";
    try {
      await this.permission.assertCanReviewTaskNodeRequests(actorId, "审核公共节点申请需要已授权的管理员权限");
    } catch {
      return "无审核权限：仅公共节点审核管理员可处理";
    }
    const pending = await this.requests.findPendingByRequesterNameAndNo(command.requesterName, command.requestNo);
    if (pending === null) {
      const latest = await this.requests.findLatestByRequesterNameAndNo(command.requesterName, command.requestNo);
      return latest === null ? "未找到待审核申请：" + label : "该申请已处理：" + label;
    }
    if (command.decision === "reject" && command.reason !== null && command.reason.length > 200) {
      return "驳回理由最多 200 字";
    }
    try {
      if (command.decision === "approve") {
        const result = await this.approve(pending.id, {}, actorId);
        return "已同意：" + label + "，" + (result.node?.title ?? pending.title);
      }
      const result = await this.reject(pending.id, { reason: command.reason ?? "无" }, actorId);
      return "已驳回：" + label + "，原因：" + (result.request.reviewNote ?? "无");
    } catch (error) {
      if (error instanceof AppError && error.code === "FORBIDDEN") {
        return "无审核权限：仅公共节点审核管理员可处理";
      }
      if (error instanceof AppError && error.message.includes("已处理")) {
        return "该申请已处理：" + label;
      }
      return "审核失败：" + (error instanceof Error ? error.message : String(error));
    }
  }

  /** POST /api/v1/task-node-requests/{id}/approve：可先改中英文名；同阶段同名已存在则直接关联。 */
  async approve(id: string, body: TaskNodeRequestApproveBody, actorId: string): Promise<TaskNodeRequestDecisionResponse> {
    await this.permission.assertCanReviewTaskNodeRequests(actorId, "审核公共节点申请需要已授权的管理员权限");
    const reviewerIds = await this.permission.listEffectiveTaskNodeReviewers();
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
      await this.enqueueReviewResultNotifications(after, "approved", actorId, reviewerIds, tx);
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
    const reviewerIds = await this.permission.listEffectiveTaskNodeReviewers();
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
      await this.enqueueReviewResultNotifications(decided, "rejected", actorId, reviewerIds, tx);
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
