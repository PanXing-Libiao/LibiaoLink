import { Injectable } from "@nestjs/common";
import { STAGE_KEYS, TEMPLATE_SECTION_NAMES } from "@libiaolink/contracts";
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
  TaskTemplateNodeCreateBody,
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

/** 任务模板板块 key → 展示名（九阶段 + 入库审核特殊分组）。 */
const SECTION_NAME_BY_KEY = TEMPLATE_SECTION_NAMES as Record<string, string>;
const PROJECT_STAGE_KEYS = new Set<string>(STAGE_KEYS);

/** 节点快照（审计字段级留痕口径）。 */
function nodeSnapshot(row: TaskNodeRow): Record<string, unknown> {
  return { stageKey: row.stageKey, seq: row.seq, title: row.title, titleEn: row.titleEn };
}

/**
 * 任务模板域用例（M3-05 余 · 第一段：任务节点库）。
 * - 读（GET /api/v1/task-nodes）：管理员、有项目数据范围，或至少有一个有效项目关系（经理 / 成员 / 任务负责人）—— 任务模板页左列与「项目总览 → 添加任务」卡片的节点来源；仅登录账号 403；
 * - 写公共节点（POST / PATCH / DELETE）：仅系统管理员；模板内私有节点另随模板编辑权；
 * - 留痕：新增 / 编辑 / 删除各写一条审计（对象类型 task_node；编辑写字段级 changes、删除为物理删行快照进 changes）；不写 outbox（与字典维护同口径）。
 * 第二段（任务模板 TaskTemplate）：读面与节点库相同；新建 = 系统管理员或至少管理一个有效项目的项目经理，编辑 / 删除还要求创建人本人或管理员，留痕 objectType = task_template、不写 outbox；
 * 可见范围：public 对所有具备模板浏览权的账号可见；private 仅填写人本人可见（列表 / 详情 / 从模板生成任务统一过滤）；只有填写人本人可随编辑保存
 * 在 private / public 间切换，管理员也不能调整他人模板或系统预置模板。
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
    await this.assertNodeEditor(actorId, "新增任务节点");
    const title = body.title.trim();
    const titleEn = body.titleEn === undefined || body.titleEn === null || body.titleEn.trim() === "" ? null : body.titleEn.trim();
    const created = await this.database.db.transaction(async (tx) => {
      const duplicate = await this.nodes.findByTitle(body.stageKey, title, null, tx);
      if (duplicate !== null) {
        throw new AppError(
          "NODE_ALREADY_EXISTS",
          "该板块已有同名节点：" + SECTION_NAME_BY_KEY[body.stageKey] + " · " + title,
        );
      }
      const seq = body.seq ?? (await this.nodes.maxSeq(body.stageKey, tx)) + 10;
      const row = await this.nodes.insert({ ownerTemplateId: null, stageKey: body.stageKey, seq, title, titleEn }, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task_node",
        objectId: row.id,
        summary: "新增任务节点：" + SECTION_NAME_BY_KEY[body.stageKey] + " · " + row.title,
        changes: diffRecords({}, nodeSnapshot(row)),
        metadata: { stageKey: row.stageKey, seq: row.seq },
      });
      return row;
    });
    return toContract(created);
  }

  /**
   * POST /api/v1/task-templates/{id}/nodes：在指定模板内新增私有节点。
   * 节点不进入公共节点库，也不会出现在其它模板；先保存到 task_nodes（owner_template_id = 模板 id），
   * 模板「保存」时再通过 nodeIds 建立引用并重排。权限跟随模板编辑权（创建人或系统管理员）。
   */
  async createTemplateNode(
    templateId: string,
    body: TaskTemplateNodeCreateBody,
    actorId: string,
  ): Promise<TaskTemplateNode> {
    await this.assertTemplateEditor(actorId, "在任务模板内新增节点");
    const title = body.title.trim();
    if (title === "") {
      throw new AppError("VALIDATION_FAILED", "节点名称不能为空");
    }
    const titleEn = body.titleEn === undefined || body.titleEn === null || body.titleEn.trim() === ""
      ? null
      : body.titleEn.trim();
    const created = await this.database.db.transaction(async (tx) => {
      const template = await this.templates.findById(templateId, tx);
      if (template === null) {
        throw new AppError("NOT_FOUND", "任务模板不存在：" + templateId);
      }
      this.assertTemplateVisible(template, actorId);
      await this.permission.assertCanManageTaskTemplate(
        actorId,
        template.createdBy,
        "在任务模板内新增节点需要创建人或系统管理员权限",
      );
      const duplicate = await this.nodes.findByTitle(template.stageKey, title, templateId, tx);
      if (duplicate !== null) {
        throw new AppError("NODE_ALREADY_EXISTS", "该模板已有同名节点：" + title);
      }
      const seq = (await this.nodes.maxOwnerSeq(templateId, tx)) + 10;
      const row = await this.nodes.insert(
        { ownerTemplateId: templateId, stageKey: template.stageKey, seq, title, titleEn },
        tx,
      );
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task_node",
        objectId: row.id,
        summary: "在任务模板内新增节点：" + template.name + " · " + row.title,
        changes: diffRecords({}, nodeSnapshot(row)),
        metadata: {
          stageKey: row.stageKey,
          seq: row.seq,
          ownerTemplateId: templateId,
          templateId,
          scope: "template",
        },
      });
      return row;
    });
    return { nodeId: created.id, seq: created.seq, title: created.title, titleEn: created.titleEn };
  }

  /**
   * PATCH /api/v1/task-nodes/{id}：改名 / 英文名（乐观锁 version 必传）。
   * 不存在 404 NOT_FOUND；版本过期 409 VERSION_CONFLICT；改成同阶段已有名字 409 NODE_ALREADY_EXISTS（排除自身）。
   */
  async updateNode(id: string, body: TaskNodeUpdateBody, actorId: string): Promise<TaskNode> {
    await this.assertNodeEditor(actorId, "编辑任务节点");
    const at = new Date();
    const updated = await this.database.db.transaction(async (tx) => {
      const before = await this.nodes.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务节点不存在：" + id);
      }
      const patch: TaskNodeUpdatePatch = {};
      if (body.title !== undefined) {
        const title = body.title.trim();
        const duplicate = await this.nodes.findByTitle(before.stageKey, title, null, tx);
        if (duplicate !== null && duplicate.id !== id) {
          throw new AppError(
            "NODE_ALREADY_EXISTS",
            "该板块已有同名节点：" + SECTION_NAME_BY_KEY[before.stageKey] + " · " + title,
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
        summary: "编辑任务节点：" + SECTION_NAME_BY_KEY[before.stageKey] + " · " + row.title,
        changes: diffRecords(nodeSnapshot(before), nodeSnapshot(row)),
        metadata: { stageKey: row.stageKey, seq: row.seq },
      });
      return row;
    });
    return toContract(updated);
  }

  /** DELETE /api/v1/task-nodes/{id}：物理删行（删除前快照写审计）；不存在 / 非 UUID 404。已生成的项目任务不变。 */
  async deleteNode(id: string, actorId: string): Promise<TaskNodeDeleteResponse> {
    await this.assertNodeEditor(actorId, "删除任务节点");
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
        summary: "删除任务节点：" + SECTION_NAME_BY_KEY[before.stageKey] + " · " + before.title,
        changes: diffRecords(nodeSnapshot(before), {}),
        metadata: { stageKey: before.stageKey, seq: before.seq, removedFromTemplates },
      });
    });
    return { id, deleted: true };
  }

  // ---------- 任务模板（第二段 · A1-16 / A1-17）----------

  /** GET /api/v1/task-templates?stage=：模板列表；public 全员可见，private 仅填写人可见。 */
  async listTemplates(query: TaskTemplateListQuery, actorId: string): Promise<TaskTemplateListResponse> {
    const rows = (await this.templates.list(query.stage ?? null)).filter(
      (row) => row.visibility === "public" || row.createdBy === actorId,
    );
    const refs = await this.templates.nodeRefsOf(rows.map((row) => row.id));
    const grouped = groupNodeRefs(refs);
    return { items: rows.map((row) => toTemplateContract(row, grouped.get(row.id) ?? [])), total: rows.length };
  }

  /** GET /api/v1/task-templates/{id}：详情；个人模板对非填写人按不存在处理。 */
  async getTemplate(id: string, actorId: string): Promise<TaskTemplate> {
    const row = await this.templates.findById(id);
    if (row === null) {
      throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
    }
    this.assertTemplateVisible(row, actorId);
    return toTemplateContract(row, await this.templates.nodeRefsOf([id]));
  }

  /**
   * POST /api/v1/task-templates：新建（名称 + 阶段 + 节点顺序）。
   * 名称 trim 后为空 400；`nodeIds` 允许空数组（新建后逐步拖入）；重复 id / 节点不存在 / 节点跨阶段一律 400 VALIDATION_FAILED。
   */
  async createTemplate(body: TaskTemplateCreateBody, actorId: string): Promise<TaskTemplate> {
    await this.assertTemplateEditor(actorId, "新建任务模板");
    const name = normalizeTemplateName(body.name);
    const created = await this.database.db.transaction(async (tx) => {
      await this.assertNodesSameStage(body.stageKey, body.nodeIds, null, tx);
      const row = await this.templates.insert(
        { name, stageKey: body.stageKey, visibility: body.visibility, createdBy: actorId },
        tx,
      );
      await this.templates.replaceNodes(row.id, body.nodeIds, tx);
      const refs = await this.templates.nodeRefsOf([row.id], tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "task_template",
        objectId: row.id,
        summary: "新增任务模板：" + stageName(row.stageKey) + " · " + row.name,
        changes: diffRecords({}, templateSnapshot(row, refs)),
        metadata: { stageKey: row.stageKey, visibility: row.visibility, createdBy: row.createdBy, nodeCount: refs.length },
      });
      return { row, refs };
    });
    const persisted = await this.templates.findById(created.row.id);
    return toTemplateContract(persisted ?? created.row, created.refs);
  }

  /**
   * PATCH /api/v1/task-templates/{id}：改名 / 可见范围 / 节点全量替换（不动的字段不传；`nodeIds` 传了就整体替换，含增删与重排）。
   * 不存在 / 已软删 404；`version` 过期 409 VERSION_CONFLICT；重复 id / 未知节点 / 跨阶段节点 400。
   */
  async updateTemplate(id: string, body: TaskTemplateUpdateBody, actorId: string): Promise<TaskTemplate> {
    await this.assertTemplateEditor(actorId, "编辑任务模板");
    const at = new Date();
    const updated = await this.database.db.transaction(async (tx) => {
      const before = await this.templates.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
      }
      this.assertTemplateVisible(before, actorId);
      await this.permission.assertCanManageTaskTemplate(
        actorId,
        before.createdBy,
        "编辑任务模板需要创建人或系统管理员权限",
      );
      const beforeRefs = await this.templates.nodeRefsOf([id], tx);
      const patch: TaskTemplateUpdatePatch = {};
      if (body.name !== undefined) {
        patch.name = normalizeTemplateName(body.name);
      }
      if (body.visibility !== undefined && body.visibility !== before.visibility) {
        if (before.createdBy === null || before.createdBy !== actorId) {
          throw new AppError("FORBIDDEN", "仅填写人可以调整模板可见范围");
        }
        patch.visibility = body.visibility;
      }
      if (body.nodeIds !== undefined) {
        await this.assertNodesSameStage(before.stageKey, body.nodeIds, id, tx);
      }
      const row = await this.templates.updateWithVersion(id, body.version, patch, at, tx);
      if (row === null) {
        throw new AppError("VERSION_CONFLICT", "任务模板已被他人更新，请刷新后重试");
      }
      if (body.nodeIds !== undefined) {
        await this.templates.replaceNodes(id, body.nodeIds, tx);
        await this.nodes.deleteUnreferencedOwned(id, body.nodeIds, tx);
      }
      const refs = await this.templates.nodeRefsOf([id], tx);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "task_template",
        objectId: id,
        summary: "编辑任务模板：" + stageName(row.stageKey) + " · " + row.name,
        changes: diffRecords(templateSnapshot(before, beforeRefs), templateSnapshot(row, refs)),
        metadata: { stageKey: row.stageKey, visibility: row.visibility, createdBy: row.createdBy, nodeCount: refs.length },
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
    await this.assertTemplateEditor(actorId, "删除任务模板");
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.templates.findById(id, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "任务模板不存在：" + id);
      }
      this.assertTemplateVisible(before, actorId);
      await this.permission.assertCanManageTaskTemplate(
        actorId,
        before.createdBy,
        "删除任务模板需要创建人或系统管理员权限",
      );
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
        metadata: { stageKey: before.stageKey, visibility: before.visibility, nodeCount: beforeRefs.length, deletedAt: at.toISOString() },
      });
    });
    return { id, deletedAt: at.toISOString() };
  }

  /** 导入页只列出本人已有的个人模板。 */
  async listPersonalImportTemplates(actorId: string): Promise<Array<{ id: string; name: string; stageKey: string; version: number }>> {
    if (!await this.permission.canManageTaskTemplates(actorId)) return [];
    return (await this.templates.list(null))
      .filter((row) => PROJECT_STAGE_KEYS.has(row.stageKey) && row.visibility === "private" && row.createdBy === actorId)
      .map(({ id, name, stageKey, version }) => ({ id, name, stageKey, version }));
  }

  /** 将导入任务加入所选个人模板，与项目导入处于同一事务。 */
  async appendImportedPrivateNodes(
    selections: Array<{ templateId: string; version: number; stageKey: string; title: string; titleEn: string | null }>,
    actorId: string,
    tx: DbClient,
  ): Promise<void> {
    if (selections.length === 0) return;
    await this.assertTemplateEditor(actorId, "编辑任务模板");
    const groups = new Map<string, typeof selections>();
    for (const item of selections) {
      const items = groups.get(item.templateId) ?? [];
      items.push(item);
      groups.set(item.templateId, items);
    }
    for (const [id, items] of groups) {
      const before = await this.templates.findById(id, tx);
      if (before === null || before.visibility !== "private" || before.createdBy !== actorId) {
        throw new AppError("VALIDATION_FAILED", "只能添加到本人的个人模板");
      }
      if (items.some((item) => item.stageKey !== before.stageKey || item.version !== before.version)) {
        throw new AppError("VERSION_CONFLICT", "个人模板已变化，请重新解析导入文件");
      }
      const refs = await this.templates.nodeRefsOf([id], tx);
      const row = await this.templates.updateWithVersion(id, before.version, {}, new Date(), tx);
      if (row === null) throw new AppError("VERSION_CONFLICT", "个人模板已变化，请重新解析导入文件");
      const ids = refs.map((ref) => ref.nodeId);
      let seq = await this.nodes.maxOwnerSeq(id, tx);
      for (const item of items) {
        let node = await this.nodes.findByTitle(item.stageKey, item.title, id, tx);
        if (node === null) {
          seq += 10;
          node = await this.nodes.insert({ ownerTemplateId: id, stageKey: item.stageKey, title: item.title, titleEn: item.titleEn, seq }, tx);
          await this.audit.record(tx, {
            actorId, action: "create", objectType: "task_node", objectId: node.id,
            summary: "导入任务加入模板节点：" + before.name + " · " + node.title,
            changes: diffRecords({}, nodeSnapshot(node)),
            metadata: { stageKey: node.stageKey, seq: node.seq, ownerTemplateId: id, templateId: id, scope: "template" },
          });
        }
        if (!ids.includes(node.id)) ids.push(node.id);
      }
      await this.templates.replaceNodes(id, ids, tx);
      const afterRefs = await this.templates.nodeRefsOf([id], tx);
      await this.audit.record(tx, {
        actorId, action: "update", objectType: "task_template", objectId: id,
        summary: "导入任务加入个人模板：" + stageName(before.stageKey) + " · " + before.name,
        changes: diffRecords(templateSnapshot(before, refs), templateSnapshot(row, afterRefs)),
        metadata: { stageKey: before.stageKey, visibility: before.visibility, nodeCount: afterRefs.length },
      });
    }
  }

  /**
   * 模板内节点校验：重复 id / 节点不存在 / 节点跨阶段一律 400 VALIDATION_FAILED（在写入前、同事务内判）。
   * 「同阶段」是模板的硬口径：模板页左列只给同阶段节点，「项目总览 → 添加任务」也按模板阶段建任务。
   */
  private async assertNodesSameStage(
    stageKey: string,
    nodeIds: string[],
    templateId: string | null,
    tx: DbClient,
  ): Promise<void> {
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
    const privateFromOtherTemplate = nodeIds.filter((id) => {
      const owner = byId.get(id)?.ownerTemplateId ?? null;
      return owner !== null && owner !== templateId;
    });
    if (privateFromOtherTemplate.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "模板内节点不属于该模板：" + privateFromOtherTemplate.join("、"),
      );
    }
    const foreign = nodeIds.filter((id) => byId.get(id)?.stageKey !== stageKey);
    if (foreign.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "模板内节点必须属于同一板块（" + stageName(stageKey) + "）：" + foreign.join("、"),
      );
    }
  }

  /** 个人模板仅填写人可见；公共模板对所有已过整体读权限的账号可见。 */
  private assertTemplateVisible(row: TaskTemplateRow, actorId: string): void {
    if (row.visibility === "private" && row.createdBy !== actorId) {
      throw new AppError("NOT_FOUND", "任务模板不存在：" + row.id);
    }
  }

  /** 公共节点库维护：仅系统管理员；模板私有节点不走此闸。 */
  private async assertNodeEditor(actorId: string, action: string): Promise<void> {
    await this.permission.assertCanManageTaskNodes(actorId, action + "需要系统管理员权限");
  }

  /** 公共任务模板维护：系统管理员，或至少管理一个有效项目的项目经理；任务负责人只读。 */
  private async assertTemplateEditor(actorId: string, action: string): Promise<void> {
    await this.permission.assertCanManageTaskTemplates(actorId, action + "需要项目经理或管理员权限");
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
    visibility: row.visibility,
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

/** 模板快照（审计字段级留痕口径）：名称 + 可见范围 + 节点名顺序。 */
function templateSnapshot(row: TaskTemplateRow, refs: TaskTemplateNodeRef[]): Record<string, unknown> {
  return { name: row.name, nodes: refs.map((ref) => ref.title), visibility: row.visibility, createdBy: row.createdBy };
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
  return SECTION_NAME_BY_KEY[stageKey] ?? stageKey;
}
