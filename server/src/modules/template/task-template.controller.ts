/**
 * 任务模板接口（M3-05 余 · 第二段；契约 shared/src/modules/templates.ts · A1-16 / A1-17）。
 * 读（列表 / 详情）= 登录且命中部门规则 —— 任务模板页右侧模板面板与「项目总览 → 添加任务」卡片的模板来源；仅登录账号 403；
 * 写（新建 / 编辑 / 删除）= 服务层 `assertCanManageBlueprint` 复核（系统管理员或部门编辑账号），每次变更写审计留痕；
 * 删除 = 软删（deleted_at），已按该模板生成的项目任务不受影响；`version` 乐观锁：编辑 / 删除都要带。
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  TaskTemplateCreateBodySchema,
  TaskTemplateDeleteBodySchema,
  TaskTemplateListQuerySchema,
  TaskTemplateUpdateBodySchema,
  UuidSchema,
} from "@libiaolink/contracts";
import type {
  TaskTemplate,
  TaskTemplateCreateBody,
  TaskTemplateDeleteBody,
  TaskTemplateDeleteResponse,
  TaskTemplateListQuery,
  TaskTemplateListResponse,
  TaskTemplateUpdateBody,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { PermissionService } from "../permission/index.js";
import { TemplateService } from "./template.service.js";

const idParam = new ZodValidationPipe(UuidSchema);

@Controller("api/v1/task-templates")
@UseGuards(SessionGuard, CsrfGuard)
export class TaskTemplateController {
  constructor(
    private readonly templates: TemplateService,
    private readonly permission: PermissionService,
  ) {}

  /** 模板列表（按阶段过滤；缺省全部阶段，排序 = 九阶段顺序 → created_at → id）。 */
  @Get()
  async list(
    @Query(new ZodValidationPipe(TaskTemplateListQuerySchema)) query: TaskTemplateListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<TaskTemplateListResponse> {
    await this.permission.assertCanReadBlueprint(actorId);
    return this.templates.listTemplates(query);
  }

  /** 模板详情；不存在 / 已软删 404。 */
  @Get(":id")
  async get(@Param("id", idParam) id: string, @CurrentActorId() actorId: string): Promise<TaskTemplate> {
    await this.permission.assertCanReadBlueprint(actorId);
    return this.templates.getTemplate(id);
  }

  /** 新建模板（name + stageKey + nodeIds）：重复 id / 未知节点 / 跨阶段节点 400；无编辑权限 403。 */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(TaskTemplateCreateBodySchema)) body: TaskTemplateCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskTemplate> {
    return this.templates.createTemplate(body, actorId);
  }

  /** 编辑模板（改名 / nodeIds 全量替换，乐观锁 version 必传）：不存在 404；版本过期 409。 */
  @Patch(":id")
  update(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(TaskTemplateUpdateBodySchema)) body: TaskTemplateUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskTemplate> {
    return this.templates.updateTemplate(id, body, actorId);
  }

  /** 删除模板（软删；body 带 version 乐观锁）：不存在 / 已删 404；版本过期 409。 */
  @Delete(":id")
  remove(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(TaskTemplateDeleteBodySchema)) body: TaskTemplateDeleteBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskTemplateDeleteResponse> {
    return this.templates.deleteTemplate(id, body, actorId);
  }
}
