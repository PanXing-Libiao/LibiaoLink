import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { NodeCompleteBodySchema, UuidSchema, z } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccess, ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { FlowService } from "./flow.service.js";
import type { ProjectNodeView } from "./flow.service.js";

type NodeCompleteBody = z.infer<typeof NodeCompleteBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 节点接口（h3）：完成门禁经 /api/v1/nodes；服务端事务内强校验，预检不替代判定（v0.2 §3.6）。
 * 路径 :id 是节点 id，ProjectAccessGuard 先解析到所属项目再做记录级 404（h6）；
 * 完成是成员平权（ADR-011 §4.3 例外），但 @RequirePermission 仍用于部门只读画像的统一拦截；预检不挂。
 */
@Controller("api/v1/nodes")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
@ProjectAccess("node")
export class NodesController {
  constructor(private readonly flow: FlowService) {}

  /** 完成节点：缺件 → 422 NODE_REQUIRED_DOC_MISSING + missing；已完成 409 NODE_ALREADY_DONE；已删 409 NODE_DELETED。响应按契约 NodeCompleteResponse（{ node }）。 */
  @Post(":id/complete")
  @HttpCode(200)
  @RequirePermission("node.complete")
  async complete(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(NodeCompleteBodySchema)) body: NodeCompleteBody,
    @CurrentActorId() actorId: string,
  ): Promise<{ node: ProjectNodeView }> {
    return { node: await this.flow.completeNode(id, body.version, actorId) };
  }

  /** 完成预检：UI 置灰依据（canComplete + missing）。 */
  @Get(":id/can-complete")
  canComplete(@Param("id", uuidParam) id: string): Promise<{ canComplete: boolean; missing: { docType: string; required: number; present: number }[] }> {
    return this.flow.canComplete(id);
  }
}
