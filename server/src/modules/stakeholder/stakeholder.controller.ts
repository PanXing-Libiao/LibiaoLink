import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  StakeholderCreateBodySchema,
  StakeholderListQuerySchema,
  StakeholderProjectLinkBodySchema,
  StakeholderUpdateBodySchema,
  UuidSchema,
} from "@libiaolink/contracts";
import type {
  Stakeholder,
  StakeholderCreateBody,
  StakeholderDeleteResponse,
  StakeholderListQuery,
  StakeholderListResponse,
  StakeholderProjectLinkBody,
  StakeholderUpdateBody,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { StakeholderService } from "./stakeholder.service.js";

const idParam = new ZodValidationPipe(UuidSchema);

/**
 * 干系人接口（j6 · S8·stakeholder · A5-01 ~ A5-04 / A5-07；契约 shared/src/modules/stakeholders.ts）。
 * 读 = stakeholder.view（销售 / 项目经理 / 管理员 / 只读均有）；写 = stakeholder.manage + 目标项目 edit。
 * 写接口没有项目路径参数，因此不在控制器挂功能位，由服务层按关联项目逐项解析并裁决；
 * 未关联任何项目时要求全部项目编辑权限（groupAllEdit）。
 * 字段级脱敏在服务层执行：无权字段**键不存在**（C3-08）；记录级不可见一律 404（防 IDOR）。
 * 批量导入（A5-05）与导出（A5-09）分别随 M8-01（lan）/ M7-03（lan）接入，本控制器不含。
 */
@Controller("api/v1/stakeholders")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class StakeholderController {
  constructor(private readonly stakeholders: StakeholderService) {}

  /** 台账列表：关键词 / 公司分类 / 项目筛选 + 分页排序（记录级按数据范围裁剪）。 */
  @Get()
  @RequirePermission("stakeholder.view")
  list(
    @Query(new ZodValidationPipe(StakeholderListQuerySchema)) query: StakeholderListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<StakeholderListResponse> {
    return this.stakeholders.list(query, actorId);
  }

  /** 新增台账（可一并关联项目）：目标项目均须可编辑；写审计留痕。 */
  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(StakeholderCreateBodySchema)) body: StakeholderCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<Stakeholder> {
    return this.stakeholders.create(body, actorId);
  }

  /** 详情（含关联项目反查）。 */
  @Get(":stakeholderId")
  @RequirePermission("stakeholder.view")
  get(@Param("stakeholderId", idParam) stakeholderId: string, @CurrentActorId() actorId: string): Promise<Stakeholder> {
    return this.stakeholders.get(stakeholderId, actorId);
  }

  /** 更新（部分更新；null = 清空）：全部关联项目均须可编辑；字段级留痕。 */
  @Patch(":stakeholderId")
  update(
    @Param("stakeholderId", idParam) stakeholderId: string,
    @Body(new ZodValidationPipe(StakeholderUpdateBodySchema)) body: StakeholderUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<Stakeholder> {
    return this.stakeholders.update(stakeholderId, body, actorId);
  }

  /** 删除（软删）：全部关联项目均须可编辑；历史与关联保留。 */
  @Delete(":stakeholderId")
  remove(@Param("stakeholderId", idParam) stakeholderId: string, @CurrentActorId() actorId: string): Promise<StakeholderDeleteResponse> {
    return this.stakeholders.remove(stakeholderId, actorId);
  }

  /** 关联项目（A5-03；幂等）。 */
  @Post(":stakeholderId/projects")
  linkProject(
    @Param("stakeholderId", idParam) stakeholderId: string,
    @Body(new ZodValidationPipe(StakeholderProjectLinkBodySchema)) body: StakeholderProjectLinkBody,
    @CurrentActorId() actorId: string,
  ): Promise<Stakeholder> {
    return this.stakeholders.linkProject(stakeholderId, body.projectId, actorId);
  }

  /** 解除项目关联（A5-03）：未关联 404。 */
  @Delete(":stakeholderId/projects/:projectId")
  unlinkProject(
    @Param("stakeholderId", idParam) stakeholderId: string,
    @Param("projectId", idParam) projectId: string,
    @CurrentActorId() actorId: string,
  ): Promise<Stakeholder> {
    return this.stakeholders.unlinkProject(stakeholderId, projectId, actorId);
  }
}
