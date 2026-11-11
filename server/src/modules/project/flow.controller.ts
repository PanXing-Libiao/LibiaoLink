import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import {
  NodeCreateBodySchema,
  NodeDeleteBodySchema,
  StageAdvanceBodySchema,
  StageKeySchema,
  StageRollbackBodySchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { FlowService } from "./flow.service.js";
import type { ProjectFlow, ProjectNodeView, StageListResponse } from "./flow.service.js";

type NodeCreateBody = z.infer<typeof NodeCreateBodySchema>;
type NodeDeleteBody = z.infer<typeof NodeDeleteBodySchema>;
type StageAdvanceBody = z.infer<typeof StageAdvanceBodySchema>;
type StageRollbackBody = z.infer<typeof StageRollbackBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);
const stageKeyParam = new ZodValidationPipe(StageKeySchema);

/**
 * 流程接口（h3 · S6·blueprint/node）：契约 shared/src/modules/flow.ts。
 * 读接口要求登录 + 记录级可见（非成员 / 不可见项目 404，h6 ProjectAccessGuard）；
 * 节点增删（ADR-020）与阶段推进 / 回退（ADR-023）在服务层按最终项目编辑权判定，本层叠加矩阵键；所管项目经理已计入最终权限，非所管项目不提升。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  /** 项目流程：阶段 + 节点 + 约束 + 状态（详情 / 首页用）。 */
  @Get(":id/flow")
  getFlow(@Param("id", uuidParam) id: string): Promise<ProjectFlow> {
    return this.flow.getFlow(id);
  }

  /** 阶段列表：九阶段状态与完成度（节点 / 任务读时派生）。 */
  @Get(":id/stages")
  listStages(@Param("id", uuidParam) id: string): Promise<StageListResponse> {
    return this.flow.listStages(id);
  }

  /** 阶段推进：服务端门禁（任务 / 节点 / 成果文件）；失败 422 STAGE_GATE_NOT_PASSED + 缺项明细。 */
  @Post(":id/stages/:key/advance")
  @HttpCode(200)
  @RequirePermission("node.advance")
  advance(
    @Param("id", uuidParam) id: string,
    @Param("key", stageKeyParam) key: string,
    @Body(new ZodValidationPipe(StageAdvanceBodySchema)) body: StageAdvanceBody,
    @CurrentActorId() actorId: string,
  ): Promise<StageListResponse> {
    return this.flow.advanceStage(id, key, body.version, actorId);
  }

  /** 阶段回退：仅相邻上一阶段，原因必填并留痕；不做门禁（ADR-023）。 */
  @Post(":id/stages/:key/rollback")
  @HttpCode(200)
  @RequirePermission("node.rollback")
  rollback(
    @Param("id", uuidParam) id: string,
    @Param("key", stageKeyParam) key: string,
    @Body(new ZodValidationPipe(StageRollbackBodySchema)) body: StageRollbackBody,
    @CurrentActorId() actorId: string,
  ): Promise<StageListResponse> {
    return this.flow.rollbackStage(id, key, body, actorId);
  }

  /** 增补节点：仅项目编辑者；nodeKey 必须命中项目导入版本的模板节点池；留痕（原因可选）。 */
  @Post(":id/nodes")
  @RequirePermission("node.create")
  createNode(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(NodeCreateBodySchema)) body: NodeCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectNodeView> {
    return this.flow.createNode(id, body, actorId);
  }

  /** 删除节点：软删 + 留痕（原因必填）；有成果文件关联时 409 NODE_HAS_FILES。 */
  @Delete(":id/nodes/:nodeId")
  @RequirePermission("node.delete")
  removeNode(
    @Param("id", uuidParam) id: string,
    @Param("nodeId", uuidParam) nodeId: string,
    @Body(new ZodValidationPipe(NodeDeleteBodySchema)) body: NodeDeleteBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectNodeView> {
    return this.flow.deleteNode(id, nodeId, body, actorId);
  }
}
