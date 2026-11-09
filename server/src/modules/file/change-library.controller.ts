import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ChangeRequestListQuerySchema,
  ChangeRequestListResponseSchema,
  CreateMaterialReissueBodySchema,
  MaterialReissueResultSchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard } from "../permission/index.js";
import { ChangeService } from "./change.service.js";
import { MaterialReissueService } from "./material-reissue.service.js";

type ChangeListQuery = z.infer<typeof ChangeRequestListQuerySchema>;
type CreateMaterialReissueBody = z.infer<typeof CreateMaterialReissueBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);
const createMaterialReissueBody = new ZodValidationPipe(CreateMaterialReissueBodySchema);

/**
 * 项目变更记录列表（M4-04 读面 · A4-15）：契约 shared/src/modules/files.ts 的 `GET /projects/{id}/change-requests`。
 *
 * 记录级可见性由 ProjectAccessGuard 处理（路径 `:id` 非成员 / 不存在 → 404，防 IDOR）；读 = 项目可见即可。
 * 「按任务检索」契约无 filter[taskId]：任务侧经任务详情的 changeLinks 跳转，或前端用「任务 → 文件」两步取 fileId 后走
 * `filter[fileId]`（契约扩项请走契约切片，本切片零改动）。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ChangeRequestLibraryController {
  constructor(
    private readonly changes: ChangeService,
    private readonly materialReissues: MaterialReissueService,
  ) {}

  /** 变更记录列表：阶段（多值）/ 节点 / 文件 / 申请人筛选 + 关键字（原因 / 前后摘要）+ 白名单排序 + 分页。 */
  /**
   * POST /projects/{id}/change-requests/material-reissue（2026-11-09）：物料变更补发。
   * 服务端自动记录申请人 / 时间，生成补发申请 DOCX 并回写任务变更记录；返回三者供前端即时刷新。
   */
  @Post(":id/change-requests/material-reissue")
  createMaterialReissue(
    @Param("id", uuidParam) id: string,
    @Body(createMaterialReissueBody) body: CreateMaterialReissueBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof MaterialReissueResultSchema>> {
    return this.materialReissues.create(id, body, actorId);
  }

  @Get(":id/change-requests")
  list(
    @Param("id", uuidParam) id: string,
    @Query(new ZodValidationPipe(ChangeRequestListQuerySchema)) query: ChangeListQuery,
  ): Promise<z.infer<typeof ChangeRequestListResponseSchema>> {
    return this.changes.listProjectChanges(id, query);
  }
}
