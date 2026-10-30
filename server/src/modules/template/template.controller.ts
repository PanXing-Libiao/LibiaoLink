import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { TaskNodeCreateBodySchema, TaskNodeListQuerySchema, TaskNodeUpdateBodySchema, UuidSchema } from "@libiaolink/contracts";
import type { TaskNode, TaskNodeCreateBody, TaskNodeDeleteResponse, TaskNodeListQuery, TaskNodeListResponse, TaskNodeUpdateBody } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { PermissionService } from "../permission/index.js";
import { TemplateService } from "./template.service.js";

const idParam = new ZodValidationPipe(UuidSchema);

/**
 * 任务节点库接口（M3-05 余 · 第一段；契约 shared/src/modules/templates.ts · A1-16 / A1-17）。
 * 读 = 登录且命中部门规则（任务模板页左列 / 「项目总览 → 添加任务」卡片的节点来源）；仅登录账号 403；
 * 写（新增 / 编辑 / 删除）= 服务层 `assertCanManageBlueprint` 复核（系统管理员或部门编辑账号），每次变更写审计留痕。
 * 删除 = 物理删行（与字典条目硬删同口径，Push 173）；已按该节点生成的项目任务不受影响。
 * 模板（TaskTemplate）的读写随本域第二段落，本控制器暂不含。
 */
@Controller("api/v1/task-nodes")
@UseGuards(SessionGuard, CsrfGuard)
export class TemplateController {
  constructor(
    private readonly templates: TemplateService,
    private readonly permission: PermissionService,
  ) {}

  /** 节点库列表（按阶段过滤；缺省全部阶段，排序 = 九阶段顺序 → seq）。 */
  @Get()
  async list(
    @Query(new ZodValidationPipe(TaskNodeListQuerySchema)) query: TaskNodeListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNodeListResponse> {
    await this.permission.assertCanReadBlueprint(actorId);
    return this.templates.listNodes(query);
  }

  /** 新增节点：同阶段同名 409 NODE_ALREADY_EXISTS；缺省追加到该阶段末尾。 */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(TaskNodeCreateBodySchema)) body: TaskNodeCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNode> {
    return this.templates.createNode(body, actorId);
  }

  /** 编辑节点（改名 / 英文名，乐观锁 version 必传）：不存在 404；版本过期 / 同阶段同名 409；无编辑权限 403。 */
  @Patch(":id")
  update(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(TaskNodeUpdateBodySchema)) body: TaskNodeUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<TaskNode> {
    return this.templates.updateNode(id, body, actorId);
  }

  /** 删除节点（物理删行）：不存在 404；无编辑权限 403。 */
  @Delete(":id")
  remove(@Param("id", idParam) id: string, @CurrentActorId() actorId: string): Promise<TaskNodeDeleteResponse> {
    return this.templates.deleteNode(id, actorId);
  }
}
