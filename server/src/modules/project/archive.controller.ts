import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ProjectArchiveBodySchema, UuidSchema } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { ArchiveService } from "./archive.service.js";
import type { ArchiveRequestBody, ProjectArchiveView } from "./archive.service.js";

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 归档接口（M7-04 · C4-02 / C4-03 · ADR-027）：契约 shared/src/modules/projects.ts。
 * 读接口要求登录 + 记录级可见（不可见 404）；归档写接口叠加 CsrfGuard + 功能权限位 project.archive，
 * 服务层再按最终项目编辑权判定（与阶段推进同口径；项目经理关系本身不提升编辑权）。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  /** 归档：门禁（验收完成 + 成果文件齐全性检查）；缺项 422 返回清单，confirm=true 确认越过后归档并生成清单。 */
  @Post(":id/archive")
  @HttpCode(200)
  @RequirePermission("project.archive")
  archiveProject(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectArchiveBodySchema)) body: ArchiveRequestBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectArchiveView> {
    return this.archive.archiveProject(id, body, actorId);
  }

  /** 归档清单读面（C4-03）：归档时点 + 统计口径 + 文件清单含版本；未归档 404。 */
  @Get(":id/archive")
  getArchive(@Param("id", uuidParam) id: string): Promise<ProjectArchiveView> {
    return this.archive.getArchive(id);
  }
}
