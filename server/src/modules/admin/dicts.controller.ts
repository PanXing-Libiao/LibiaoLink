import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  DictItemCreateBodySchema,
  DictItemUpdateBodySchema,
  DictReadQuerySchema,
  z,
} from "@libiaolink/contracts";
import type { Dict, DictItemCreateBody, DictItemUpdateBody, DictListResponse, DictReadQuery } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { PermissionService, ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { DictService } from "./dict.service.js";

// 类型 / 条目码都按普通路径段校验；未知类型由服务层统一 404（契约口径：未知类型 404，不是 400）
const segmentParam = new ZodValidationPipe(z.string().min(1).max(64));

/**
 * 字典接口（h7 · C9；契约 shared/src/modules/dicts.ts）：
 * 读 = 登录即可（前端启动拉一次后缓存）；includeDisabled=true（兼容参数，一期不再产生停用项）需要 dict.manage；
 * 写 = 新增条目按类型分权（C9-02 修订：**region 任何登录用户**，地区是全站共享的公共标签；projectType 仍 dict.manage），
 * 更新 / 删除条目 = 仅管理员（dict.manage）；每次变更写审计留痕，响应为更新后的整个字典（前端直接替换缓存）。
 * 删除 = DELETE 物理删除（Push 173）：删除不影响存量数据展示，项目仍按原码 / 原名渲染；同码可重新新增（按全新条目）。
 */
@Controller("api/v1/dicts")
@UseGuards(SessionGuard, CsrfGuard)
export class DictsController {
  constructor(
    private readonly dicts: DictService,
    private readonly permission: PermissionService,
  ) {}

  /** 全量字典（region / projectType；阶段与成果文件类型走契约枚举，不下发）。 */
  @Get()
  async list(
    @Query(new ZodValidationPipe(DictReadQuerySchema)) query: DictReadQuery,
    @CurrentActorId() actorId: string,
  ): Promise<DictListResponse> {
    const includeDisabled = query.includeDisabled === "true";
    if (includeDisabled) {
      await this.permission.assertCan(actorId, "dict.manage", undefined, "查看停用字典项需要 dict.manage");
    }
    return this.dicts.list(includeDisabled);
  }

  /** 单个字典：未知类型 404 NOT_FOUND。 */
  @Get(":type")
  async get(
    @Param("type", segmentParam) type: string,
    @Query(new ZodValidationPipe(DictReadQuerySchema)) query: DictReadQuery,
    @CurrentActorId() actorId: string,
  ): Promise<Dict> {
    const includeDisabled = query.includeDisabled === "true";
    if (includeDisabled) {
      await this.permission.assertCan(actorId, "dict.manage", undefined, "查看停用字典项需要 dict.manage");
    }
    return this.dicts.get(type, includeDisabled);
  }

  /**
   * 新增条目（C9-02 修订）：**region 任何登录用户可增**（地区是全站共享的公共标签 —— 非管理员新增同样全站可见、
   * 可在首页按它筛选；治理仍归管理员：改名 / 停用走 PATCH + dict.manage）；**projectType 等其余类型仍 dict.manage**。
   * 同类型内码唯一，重复 409 DICT_ITEM_EXISTS。
   */
  @Post(":type/items")
  @UseGuards(ProjectAccessGuard)
  async createItem(
    @Param("type", segmentParam) type: string,
    @Body(new ZodValidationPipe(DictItemCreateBodySchema)) body: DictItemCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<Dict> {
    await this.permission.assertWritable(actorId, "当前部门为只读，不能新增字典条目");
    if (type !== "region") {
      await this.permission.assertCan(actorId, "dict.manage", undefined, "新增该字典条目需要 dict.manage");
    }
    return this.dicts.createItem(type, body, actorId);
  }

  /** 更新条目（仅管理员）：code 不可改；enabled 为兼容字段（一期删除走 DELETE，前端不再调它）。 */
  @Patch(":type/items/:code")
  @UseGuards(ProjectAccessGuard)
  @RequirePermission("dict.manage")
  updateItem(
    @Param("type", segmentParam) type: string,
    @Param("code", segmentParam) code: string,
    @Body(new ZodValidationPipe(DictItemUpdateBodySchema)) body: DictItemUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<Dict> {
    return this.dicts.updateItem(type, code, body, actorId);
  }

  /**
   * 删除条目（仅管理员 · 物理删除）：未知类型 / 未知条目 404；删除前快照写审计；响应为更新后的整个字典。
   * **被未删除项目引用时 409 DICT_ITEM_IN_USE**（A3 删除守卫 · Push 174）。
   */
  @Delete(":type/items/:code")
  @UseGuards(ProjectAccessGuard)
  @RequirePermission("dict.manage")
  deleteItem(
    @Param("type", segmentParam) type: string,
    @Param("code", segmentParam) code: string,
    @CurrentActorId() actorId: string,
  ): Promise<Dict> {
    return this.dicts.deleteItem(type, code, actorId);
  }
}
