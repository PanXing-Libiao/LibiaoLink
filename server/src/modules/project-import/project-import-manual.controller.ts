import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ProjectImportManualAttachBodySchema, UuidSchema, z } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { ProjectImportService } from "./project-import.service.js";

type AttachBody = z.infer<typeof ProjectImportManualAttachBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 导入补充附件回挂（项目空间内）：前端在导入面板选中的「变更后文件」直传完成后，
 * 用本接口把文件首版本挂到导入变更（变更详情不再显示「待补」）。任务附件由上传管道的 taskId 直接挂接，不走本接口。
 * 门禁：登录 + CSRF + 项目可见（路径 :id）+ file.upload；项目 / 文件 / 变更归属在服务层复核。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectImportManualController {
  constructor(private readonly imports: ProjectImportService) {}

  @Post(":id/import-manual-files/attach-change")
  @HttpCode(204)
  @RequirePermission("file.upload")
  async attachChangeFile(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectImportManualAttachBodySchema)) body: AttachBody,
    @CurrentActorId() actorId: string,
  ): Promise<void> {
    await this.imports.attachManualChangeFile(id, body.changeId, body.fileId, actorId);
  }
}
