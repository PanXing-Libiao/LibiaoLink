import { Injectable } from "@nestjs/common";
import { CUSTOM_DELIVERABLE_DICT_TYPE, DOC_TYPES, type Dict, type DictItemCreateBody, type DictItemUpdateBody, type DictListResponse } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { AuditService } from "../audit/index.js";
import { diffRecords } from "./audit.rules.js";
import { DictRepository } from "./dict.repository.js";
import type { DictItemRow, DictTypeRow } from "./dict.repository.js";

/** 条目快照（字段级留痕的口径：name / sort / enabled / metadata 四项可改）。 */
function itemSnapshot(row: DictItemRow): Record<string, unknown> {
  return { name: row.name, sort: row.sort, enabled: row.enabled, metadata: row.metadata };
}

/**
 * 字典用例（h7 · C9）：读下发 + 管理端维护。
 * 口径：类型注册表含 region / projectType 与全站自定义成果类型 deliverableType；内置十类成果仍走契约枚举。条目可维护；「删除」= 物理删行（Push 173 起 DELETE 接口直接从 dict_items
 * 删除，删除前快照写审计；存量项目按原码 / 原名渲染，不受影响）；每次变更写审计留痕（对象 = dict_item，字段级 before / after）。
 * Push 174：删除前判**引用**（未删除项目数 > 0 → 409 DICT_ITEM_IN_USE，不删不写审计）；下发条目带 usageCount 供前端置灰。
 */
@Injectable()
export class DictService {
  constructor(
    private readonly database: DatabaseService,
    private readonly dicts: DictRepository,
    private readonly audit: AuditService,
  ) {}

  /** GET /api/v1/dicts：全量字典（前端启动拉一次）；includeDisabled 仅管理端（控制器已鉴权）。 */
  async list(includeDisabled: boolean): Promise<DictListResponse> {
    const types = await this.dicts.listTypes();
    const items: Dict[] = [];
    for (const type of types) {
      items.push(await this.toDict(type, includeDisabled));
    }
    return { items };
  }

  /** GET /api/v1/dicts/{type}：未知类型 404（契约口径）。 */
  async get(type: string, includeDisabled: boolean): Promise<Dict> {
    const row = await this.requireType(type);
    return this.toDict(row, includeDisabled);
  }

  /**
   * POST /api/v1/projects/{id}/deliverable-types（仅该项目项目经理）：
   * 自定义成果类型写入全站 deliverableType 字典，code = name、name = name；返回更新后的整类字典。
   * 内置十类不进 dict_items；与内置同名视为已存在（409 DICT_ITEM_EXISTS），避免选择器出现重复项。
   */
  async createCustomDeliverableType(name: string, actorId: string): Promise<Dict> {
    if ((DOC_TYPES as readonly string[]).includes(name)) {
      throw new AppError("DICT_ITEM_EXISTS", "内置成果文件类型已存在：" + name);
    }
    const items = await this.dicts.listItems(CUSTOM_DELIVERABLE_DICT_TYPE, true);
    const maxSort = items.reduce((max, item) => Math.max(max, item.sort), 0);
    return this.createItem(
      CUSTOM_DELIVERABLE_DICT_TYPE,
      { code: name, name, sort: maxSort + 10, enabled: true, metadata: {} },
      actorId,
    );
  }

  /** POST /api/v1/dicts/{type}/items（C9-02 修订：region = 登录即可；其余类型 dict.manage）：同类型内码唯一 409 DICT_ITEM_EXISTS；写审计 create。 */
  async createItem(type: string, body: DictItemCreateBody, actorId: string): Promise<Dict> {
    const typeRow = await this.requireType(type);
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const existing = await this.dicts.findItem(type, body.code, tx);
      if (existing !== null) {
        throw new AppError("DICT_ITEM_EXISTS", "该字典已存在同码条目：" + type + "/" + body.code);
      }
      const created = await this.dicts.insertItem(
        {
          typeCode: type,
          code: body.code,
          name: body.name,
          sort: body.sort ?? 0,
          enabled: body.enabled ?? true,
          metadata: body.metadata ?? {},
        },
        actorId,
        at,
        tx,
      );
      await this.dicts.touchType(type, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "dict_item",
        objectId: type + ":" + created.code,
        summary: "新增字典项：" + typeRow.name + " · " + created.name + "（" + created.code + "）",
        changes: [
          { field: "code", from: null, to: created.code },
          { field: "name", from: null, to: created.name },
          { field: "sort", from: null, to: created.sort },
          { field: "enabled", from: null, to: created.enabled },
          { field: "metadata", from: null, to: created.metadata },
        ],
        metadata: { type },
      });
    });
    return this.get(type, true);
  }

  /** PATCH /api/v1/dicts/{type}/items/{code}（dict.manage）：部分更新；每次留痕（无字段级变化时 changes=null）；码不可改。 */
  async updateItem(type: string, code: string, body: DictItemUpdateBody, actorId: string): Promise<Dict> {
    const typeRow = await this.requireType(type);
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.dicts.findItem(type, code, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "字典项不存在：" + type + "/" + code);
      }
      const updated = await this.dicts.updateItem(
        type,
        code,
        {
          name: body.name,
          sort: body.sort,
          enabled: body.enabled,
          metadata: body.metadata,
        },
        actorId,
        at,
        tx,
      );
      if (updated === null) {
        throw new AppError("NOT_FOUND", "字典项不存在：" + type + "/" + code);
      }
      await this.dicts.touchType(type, at, tx);
      const changes = diffRecords(itemSnapshot(before), itemSnapshot(updated));
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "dict_item",
        objectId: type + ":" + code,
        summary:
          "修改字典项：" + typeRow.name + " · " + updated.name + "（" + code + "）" + (updated.enabled ? "" : " —— 已停用"),
        changes: changes.length > 0 ? changes : null,
        metadata: { type },
      });
    });
    return this.get(type, true);
  }

  /**
   * DELETE /api/v1/dicts/{type}/items/{code}（dict.manage）：物理删除该条目；删除前快照写审计（action=delete）；未知条目 404。
   * **引用守卫（A3 · Push 174）**：条目正被未删除项目引用时拒绝删除 —— 409 DICT_ITEM_IN_USE（不落审计、不改任何行、事务内判定）。
   */
  async deleteItem(type: string, code: string, actorId: string): Promise<Dict> {
    const typeRow = await this.requireType(type);
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.dicts.findItem(type, code, tx);
      if (before === null) {
        throw new AppError("NOT_FOUND", "字典项不存在：" + type + "/" + code);
      }
      const usage = (await this.dicts.usageCounts(type, tx)).get(code) ?? 0;
      if (usage > 0) {
        throw new AppError(
          "DICT_ITEM_IN_USE",
          "该" + typeRow.name + "正被 " + String(usage) + " 个项目使用，不能删除：" + before.name + "（" + type + "/" + code + "）",
        );
      }
      const deleted = await this.dicts.deleteItem(type, code, tx);
      if (deleted === null) {
        throw new AppError("NOT_FOUND", "字典项不存在：" + type + "/" + code);
      }
      await this.dicts.touchType(type, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "dict_item",
        objectId: type + ":" + code,
        summary: "删除字典项：" + typeRow.name + " · " + before.name + "（" + before.code + "）",
        changes: diffRecords({ code: before.code, ...itemSnapshot(before) }, {}),
        metadata: { type },
      });
    });
    return this.get(type, true);
  }

  private async requireType(type: string): Promise<DictTypeRow> {
    const row = await this.dicts.findType(type);
    if (row === null) throw new AppError("NOT_FOUND", "未知字典类型：" + type);
    return row;
  }

  /**
   * 行 → 契约：updatedAt 取字典类型版本（条目变更会 touchType），供前端做 ETag 缓存；
   * usageCount = **未删除项目**对该码的引用数（A3 删除守卫 · Push 174；region / projectType 之外恒 0），前端据此把删除入口置灰。
   */
  private async toDict(type: DictTypeRow, includeDisabled: boolean): Promise<Dict> {
    const items = await this.dicts.listItems(type.code, includeDisabled);
    const usage = await this.dicts.usageCounts(type.code);
    return {
      type: type.code as Dict["type"],
      items: items.map((item) => ({
        code: item.code,
        name: item.name,
        sort: item.sort,
        enabled: item.enabled,
        usageCount: usage.get(item.code) ?? 0,
        metadata: item.metadata,
      })),
      updatedAt: type.updatedAt.toISOString(),
    };
  }
}
