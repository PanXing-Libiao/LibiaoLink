import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  ProjectSummaryConfirmBodySchema,
  ProjectSummaryUpdateBodySchema,
  UuidSchema,
  z,
  type ProjectSummaryLatestResponse,
  type ProjectSummaryView,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { CurrentProjectAccess, ProjectAccessGuard, RequirePermission, type ProjectAccessContext } from "../permission/index.js";
import { ProjectSummaryService } from "./project-summary.service.js";

type ProjectSummaryUpdateBody = z.infer<typeof ProjectSummaryUpdateBodySchema>;
type ProjectSummaryConfirmBody = z.infer<typeof ProjectSummaryConfirmBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 项目总结（2026-10-27 · 项目空间卡片入口）：读取某项目的脚本事实包与可编辑叙述。
 * 读取走 project.view；生成 / 编辑 / 确认走 project.update，服务层再强校验项目经理或系统管理员 + 部门 edit。
 * 总结是业务项目的阶段性复盘，不是 LibiaoLink 开发日志，也不读取正式生产服务器。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectSummaryController {
  constructor(private readonly summaries: ProjectSummaryService) {}

  /** 最新总结：优先最近草稿，无草稿时取最新已确认版本；从未生成 = item:null。 */
  @Get(":id/project-summaries/latest")
  @RequirePermission("project.view")
  latest(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
  ): Promise<ProjectSummaryLatestResponse> {
    return this.summaries.latest(id, actorId, access);
  }

  /** 生成新草稿：脚本事实包先定稿，AI 仅写六段叙述；AI 不可用自动回退规则模板。 */
  @Post(":id/project-summaries")
  @RequirePermission("project.update")
  generate(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    return this.summaries.generate(id, actorId, access);
  }

  /** 保存项目经理修订后的叙述；facts 不接收、不可改。 */
  @Patch(":id/project-summaries/:summaryId")
  @RequirePermission("project.update")
  update(
    @Param("id", uuidParam) id: string,
    @Param("summaryId", uuidParam) summaryId: string,
    @Body(new ZodValidationPipe(ProjectSummaryUpdateBodySchema)) body: ProjectSummaryUpdateBody,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    return this.summaries.update(id, summaryId, body, actorId, access);
  }

  /** 确认发布：同项目上一版 confirmed 转 superseded；确认后只读，修订需重新生成草稿。 */
  @Post(":id/project-summaries/:summaryId/confirm")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("project.update")
  confirm(
    @Param("id", uuidParam) id: string,
    @Param("summaryId", uuidParam) summaryId: string,
    @Body(new ZodValidationPipe(ProjectSummaryConfirmBodySchema)) body: ProjectSummaryConfirmBody,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    return this.summaries.confirm(id, summaryId, body.version, actorId, access);
  }
}
