import { Injectable } from "@nestjs/common";
import { STAGE_NAMES } from "@libiaolink/contracts";
import type {
  TaskNode,
  TaskNodeCreateBody,
  TaskNodeDeleteResponse,
  TaskNodeListQuery,
  TaskNodeListResponse,
  TaskNodeUpdateBody,
  TaskTemplate,
  TaskTemplateCreateBody,
  TaskTemplateDeleteBody,
  TaskTemplateDeleteResponse,
  TaskTemplateListQuery,
  TaskTemplateListResponse,
  TaskTemplateNode,
  TaskTemplateUpdateBody,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import { TaskNodeRepository } from "./task-node.repository.js";
import type { TaskNodeRow, TaskNodeUpdatePatch } from "./task-node.repository.js";
import { TaskTemplateRepository } from "./template.repository.js";
import type { TaskTemplateNodeRef, TaskTemplateRow, TaskTemplateUpdatePatch } from "./template.repository.js";

/** 阶段 key → 展示名（与 project 模块 flow.service 同口径）。 */
const STAGE_NAME_BY_KEY = STAGE_NAMES as Record<string, string>;

/** 节点快照（审计字段级留痕口径）。 */
function nodeSnapshot(row: TaskNodeRow): Record<string, unknown> {
  return { stageKey: row.stageKey, seq: row.seq, title: row.title, titleEn: row.titleEn };
}

/**
 * 任务模板域用例（M3-05 余 · 第一段：任务节点库）。
 * - 读（GET /api/v1/task-nodes）：登录且命中部门规则 —— 任务模板页左列与「项目总览 → 添加任务」卡片的节点来源；仅登录账号 403；
 * - 写（POST / PATCH / DELETE）：系统管理员，或已开启部门限制且命中编辑规则的账号；
 * - 留痕：新增 / 编辑 / 删除各写一条审计（对象类型 task_node；编辑写字段级 changes、删除为物理删行快照进 changes）；不写 outbox（与字典维护同口径）。
 * 第二段（任务模板 TaskTemplate）沿用同一套口径：读 = 登录且命中部门规则、写 = 系统管理员 / 部门编辑账号、留痕 objectType = task_template、不写 outbox；
 * 差异只有一处 —— 模板删除是**软删**（deleted_at / deleted_by，契约返回 deletedAt），节点库是物理删行。
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly nodes: TaskNodeRepository,
    private readonly templates: TaskTemplateRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  async listNodes(query: TaskNodeListQuery): Promise<TaskNodeListResponse> {
    const rows = await this.nodes.list(query.stage ?? null);
    return { items: rows.map(toContract), total: rows.length };
  }

  /** POST /api/v1/task-nodes：新增节点（同阶段同名 409 NODE_ALREADY_EXISTS）；缺省 seq = 该阶段末位 + 10。 */
  async createNode(body: TaskNodeCreateBody, actorId: string): Promise<TaskNode> {
    await this.assertEditor(actorId, "新增任务节点");
    const title = body.title.trim();
    const titleEn = body.titleEn === undefined || body.titleEn === null || body.titleEn.trim() === "" ? null : body.titleEn.trim();
    const created = await this.database.db.transaction(async (tx) => {
      const duplicate = await this.nodes.findByTitle(body.stageKey, title, tx);
      if (duplicate !== null) {
        throw new AppError(
          "NODE_ALREADY_EXISTS",
          "该阶段已有同名节点：" + STAGE_NAME_BY_KEY[body.stageKey] + " · " + title,
        );
      }
      const seq = body.seq ?? (await this.nodes.maxSeq(body.stageKey, tx)) + 10;
      const row = await this.nodes.insert({ stageKey: body.stageKey, seq, title, titleEn }, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task_node",
        objectId: row.id,
        summary: "新增任务节点：" + STAGE_NAME_BY_KEY[body.stageKey] + " · " + row.title,
        changes: diffRecords({}, nodeSnapshot(row)),
        metadata: { stageKey: row.stageKey, seq: row.seq },
      });
      return row;
    });
    return toContract(created);
  }

  /**
   * PATCH /api/v1/task-nodes/{id}：改名 / 英文名（乐观锁 version 必传）。
   * 不存在 404 NOT_FOUND；版本过期 409 VERSION_CONFLICT；改成同阶段已有名字 409 NODE_ALREADY_EXISTS（排除自身）。
   */
  async updateNode(id: string, body: TaskNodeUpdateBody, actorId: string): Promise<TaskNode> {
    await this.assertEditor(actorId, "编辑任务节点");
    const at = new Date();
    const updated = await this.database.db.transaction(async (tx) => {
      const before = await this.nodes.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务节点不存在：" + id);
      }
      const patch: TaskNodeUpdatePatch = {};
      if (body.title !== undefined) {
        const title = body.title.trim();
        const duplicate = await this.nodes.findByTitle(before.stageKey, title, tx);
        if (duplicate !== null && duplicate.id !== id) {
          throw new AppError(
            "NODE_ALREADY_EXISTS",
            "该阶段已有同名节点：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + title,
          );
        }
        patch.title = title;
      }
      if (body.titleEn !== undefined) {
        patch.titleEn = body.titleEn === null || body.titleEn.trim() === "" ? null : body.titleEn.trim();
      }
      const row = await this.nodes.updateWithVersion(id, body.version, patch, at, tx);
      if (row === null) {
        throw new AppError("VERSION_CONFLICT", "任务节点已被他人更新，请刷新后重试");
      }
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_node",
        objectId: id,
        summary: "编辑任务节点：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + row.title,
        changes: diffRecords(nodeSnapshot(before), nodeSnapshot(row)),
        metadata: { stageKey: row.stageKey, seq: row.seq },
      });
      return row;
    });
    return toContract(updated);
  }

  /** DELETE /api/v1/task-nodes/{id}：物理删行（删除前快照写审计）；不存在 / 非 UUID 404。已生成的项目任务不变。 */
  async deleteNode(id: string, actorId: string): Promise<TaskNodeDeleteResponse> {
    await this.assertEditor(actorId, "删除任务节点");
    await this.database.db.transaction(async (tx) => {
      const before = await this.nodes.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务节点不存在：" + id);
      }
      // 影响面：删节点会把它在各模板里的引用一并带走（task_template_nodes.node_id on delete cascade）
      const removedFromTemplates = await this.templates.countActiveByNodeId(id, tx);
      await this.nodes.deleteById(id, tx);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "task_node",
        objectId: id,
        summary: "删除任务节点：" + STAGE_NAME_BY_KEY[before.stageKey] + " · " + before.title,
        changes: diffRecords(nodeSnapshot(before), {}),
        metadata: { stageKey: before.stageKey, seq: before.seq, removedFromTemplates },
      });
    });
    return { id, deleted: true };
  }

  // ---------- 任务模板（第二段 · A1-16 / A1-17）----------

  /** GET /api/v1/task-templates?stage=：模板列表（登录即可）；缺省全部阶段，排序 = 九阶段 → created_at → id。 */
  async listTemplates(query: TaskTemplateListQuery): Promise<TaskTemplateListResponse> {
    const rows = await this.templates.list(query.stage ?? null);
    const refs = await this.templates.nodeRefsOf(rows.map((row) => row.id));
    const grouped = groupNodeRefs(refs);
    return { items: rows.map((row) => toTemplateContract(row, grouped.get(row.id) ?? [])), total: rows.length };
  }

  /** GET /api/v1/task-templates/{id}：详情（登录即可）；不存在 / 已软删 404。 */
  async getTemplate(id: string): Promise<TaskTemplate> {
    const row = await this.templates.findById(id);
    if (row === null) {
      throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
    }
    return toTemplateContract(row, await this.templates.nodeRefsOf([id]));
  }

  /**
   * POST /api/v1/task-templates：新建（名称 + 阶段 + 节点顺序）。
   * 名称 trim 后为空 400；`nodeIds` 允许空数组（新建后逐步拖入）；重复 id / 节点不存在 / 节点跨阶段一律 400 VALIDATION_FAILED。
   */
  async createTemplate(body: TaskTemplateCreateBody, actorId: string): Promise<TaskTemplate> {
    await this.assertEditor(actorId, "新建任务模板");
    const name = normalizeTemplateName(body.name);
    const created = await this.database.db.transaction(async (tx) => {
      await this.assertNodesSameStage(body.stageKey, body.nodeIds, tx);
      const row = await this.templates.insert({ name, stageKey: body.stageKey, createdBy: actorId }, tx);
      await this.templates.replaceNodes(row.id, body.nodeIds, tx);
      const refs = await this.templates.nodeRefsOf([row.id], tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task_template",
        objectId: row.id,
        summary: "新增任务模板：" + stageName(row.stageKey) + " · " + row.name,
        changes: diffRecords({}, templateSnapshot(row, refs)),
        metadata: { stageKey: row.stageKey, nodeCount: refs.length },
      });
      return { row, refs };
    });
    const persisted = await this.templates.findById(created.row.id);
    return toTemplateContract(persisted ?? created.row, created.refs);
  }

  /**
   * PATCH /api/v1/task-templates/{id}：改名 / 节点全量替换（不动的字段不传；`nodeIds` 传了就整体替换，含增删与重排）。
   * 不存在 / 已软删 404；`version` 过期 409 VERSION_CONFLICT；重复 id / 未知节点 / 跨阶段节点 400。
   */
  async updateTemplate(id: string, body: TaskTemplateUpdateBody, actorId: string): Promise<TaskTemplate> {
    await this.assertEditor(actorId, "编辑任务模板");
    const at = new Date();
    const updated = await this.database.db.transaction(async (tx) => {
      const before = await this.templates.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
      }
      const beforeRefs = await this.templates.nodeRefsOf([id], tx);
      const patch: TaskTemplateUpdatePatch = {};
      if (body.name !== undefined) {
        patch.name = normalizeTemplateName(body.name);
      }
      if (body.nodeIds !== undefined) {
        await this.assertNodesSameStage(before.stageKey, body.nodeIds, tx);
      }
      const row = await this.templates.updateWithVersion(id, body.version, patch, at, tx);
      if (row === null) {
        throw new AppError("VERSION_CONFLICT", "任务模板已被他人更新，请刷新后重试");
      }
      if (body.nodeIds !== undefined) {
        await this.templates.replaceNodes(id, body.nodeIds, tx);
      }
      const refs = await this.templates.nodeRefsOf([id], tx);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_template",
        objectId: id,
        summary: "编辑任务模板：" + stageName(row.stageKey) + " · " + row.name,
        changes: diffRecords(templateSnapshot(before, beforeRefs), templateSnapshot(row, refs)),
        metadata: { stageKey: row.stageKey, nodeCount: refs.length },
      });
      return { row, refs };
    });
    const persisted = await this.templates.findById(updated.row.id);
    return toTemplateContract(persisted ?? updated.row, updated.refs);
  }

  /**
   * DELETE /api/v1/task-templates/{id}：**软删**（deleted_at / deleted_by，契约返回 deletedAt）—— 删除即生效、
   * 已生成的项目任务不变；`version` 过期 409、不存在 / 已删 404。模板内引用行连同软删一起物理清掉。
   */
  async deleteTemplate(id: string, body: TaskTemplateDeleteBody, actorId: string): Promise<TaskTemplateDeleteResponse> {
    await this.assertEditor(actorId, "删除任务模板");
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.templates.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
      }
      const beforeRefs = await this.templates.nodeRefsOf([id], tx);
      const row = await this.templates.softDelete(id, body.version, actorId, at, tx);
      if (row === null) {
        throw new AppError("VERSION_CONFLICT", "任务模板已被他人更新，请刷新后重试");
      }
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "task_template",
        objectId: id,
        summary: "删除任务模板：" + stageName(before.stageKey) + " · " + before.name,
        changes: diffRecords(templateSnapshot(before, beforeRefs), {}),
        metadata: { stageKey: before.stageKey, nodeCount: beforeRefs.length, deletedAt: at.toISOString() },
      });
    });
    return { id, deletedAt: at.toISOString() };
  }

  /**
   * 模板内节点校验：重复 id / 节点不存在 / 节点跨阶段一律 400 VALIDATION_FAILED（在写入前、同事务内判）。
   * 「同阶段」是模板的硬口径：模板页左列只给同阶段节点，「项目总览 → 添加任务」也按模板阶段建任务。
   */
  private async assertNodesSameStage(stageKey: string, nodeIds: string[], tx: DbClient): Promise<void> {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of nodeIds) {
      if (seen.has(id)) {
        duplicates.push(id);
      }
      seen.add(id);
    }
    if (duplicates.length > 0) {
      throw new AppError("VALIDATION_FAILED", "模板内节点不能重复：" + [...new Set(duplicates)].join("、"));
    }
    const rows = await this.nodes.listByIds(nodeIds, tx);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = nodeIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new AppError("VALIDATION_FAILED", "任务节点不存在：" + missing.join("、"));
    }
    const foreign = nodeIds.filter((id) => byId.get(id)?.stageKey !== stageKey);
    if (foreign.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "模板内节点必须属于同一阶段（" + stageName(stageKey) + "）：" + foreign.join("、"),
      );
    }
  }

  /** 维护权限：系统管理员恒可写；部门限制开启时，命中任一「编辑」规则的账号可写。 */
  private async assertEditor(actorId: string, action: string): Promise<void> {
    await this.permission.assertCanManageBlueprint(actorId, action + "需要编辑权限");
  }
}

/** 行 → 契约 TaskNode（version = 编辑用的乐观锁，PATCH 时必传）。 */
function toContract(row: TaskNodeRow): TaskNode {
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
/** 行 → 契约 TaskTemplate（nodes 顺序 = 数组顺序 = 模板内 seq 升序）。 */
function toTemplateContract(row: TaskTemplateRow, refs: TaskTemplateNodeRef[]): TaskTemplate {
  return {
    id: row.id,
    name: row.name,
    stageKey: row.stageKey as TaskTemplate["stageKey"],
    nodes: refs.map<TaskTemplateNode>((ref) => ({
      nodeId: ref.nodeId,
      seq: ref.seq,
      title: ref.title,
      titleEn: ref.titleEn,
    })),
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 按模板分组节点引用（列表一次查完再分发，避免 N 次查询）。 */
function groupNodeRefs(refs: TaskTemplateNodeRef[]): Map<string, TaskTemplateNodeRef[]> {
  const grouped = new Map<string, TaskTemplateNodeRef[]>();
  for (const ref of refs) {
    const list = grouped.get(ref.templateId);
    if (list === undefined) {
      grouped.set(ref.templateId, [ref]);
    } else {
      list.push(ref);
    }
  }
  return grouped;
}

/** 模板快照（审计字段级留痕口径）：名称 + 节点名顺序 —— 改名 / 增删 / 重排都能在 changes 里看出来。 */
function templateSnapshot(row: TaskTemplateRow, refs: TaskTemplateNodeRef[]): Record<string, unknown> {
  return { name: row.name, nodes: refs.map((ref) => ref.title) };
}

/** 模板名称归一（trim）；trim 后为空 400（契约 min(1) 挡不住全空白）。 */
function normalizeTemplateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new AppError("VALIDATION_FAILED", "模板名称不能为空");
  }
  return trimmed;
}

/** 阶段 key → 展示名（未知 key 原样返回，仅用于提示文案）。 */
function stageName(stageKey: string): string {
  return STAGE_NAME_BY_KEY[stageKey] ?? stageKey;
}
