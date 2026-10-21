import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ProjectCreateBodySchema,
  ProjectGroupPutBodySchema,
  ProjectListQuerySchema,
  ProjectMemberCreateBodySchema,
  ProjectRecycleActionBodySchema,
  ProjectUpdateBodySchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { AllowDeletedProjectAccess, ProjectAccess, ProjectAccessGuard, ProjectScope, RequirePermission } from "../permission/index.js";
import { TranslateService } from "../translate/index.js";
import type { ProjectScopeFilter } from "../permission/index.js";
import { ProjectGroupService } from "./project-group.service.js";
import type { ProjectGroupBindingView, ProjectGroupCandidateList } from "./project-group.service.js";
import { ProjectMemberService } from "./project-member.service.js";
import type { ProjectMemberListResult, ProjectMemberView } from "./project-member.service.js";
import { ProjectService } from "./project.service.js";
import type { ProjectFacetsResult, ProjectListResult, ProjectPurgeResult, ProjectView } from "./project.service.js";

type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;
type ProjectCreateBody = z.infer<typeof ProjectCreateBodySchema>;
type ProjectUpdateBody = z.infer<typeof ProjectUpdateBodySchema>;
type ProjectMemberCreateBody = z.infer<typeof ProjectMemberCreateBodySchema>;
type ProjectGroupPutBody = z.input<typeof ProjectGroupPutBodySchema>;
type ProjectRecycleActionBody = z.infer<typeof ProjectRecycleActionBodySchema>;

/** 路径参数 id 校验：非法 uuid 直接 400 VALIDATION_FAILED（不落到 SQL 层）。 */
const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 项目接口（h2 · M2-01 项目 CRUD + M2-04 首页列表 / facets）；契约 shared/src/modules/projects.ts。
 * 读接口要求登录 + 记录级可见（非成员 / 不可见项目 404）；写接口叠加 CsrfGuard（X-CSRF-Token）与功能权限位；
 * GET /facets 必须注册在 GET /:id 之前（否则被 :id 吃掉）。
 * 记录级与功能权限判定统一由 ProjectAccessGuard（h6 · ADR-011）完成：列表 / facets 取 @ProjectScope() 过滤。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectService,
    private readonly members: ProjectMemberService,
    private readonly groups: ProjectGroupService,
    private readonly translate: TranslateService,
  ) {}

  /**
   * 保存即后台翻译（§6.16 ㉕ · 2026-10-13 业务口径「保存的时候后台自动翻译 并且写入数据库」）：
   * 把项目的手打中文（项目名 / 描述 / 客户）丢给译文库预热 —— 不同步、不阻塞保存响应、失败静默重试；
   * 地区 / 类型等字典值不预热（英文界面走字典显示，不机翻）。
   */
  private warmupProjectText(project: { name: string; customer: string | null; description: string | null }): void {
    const texts: string[] = [project.name];
    if (project.customer !== null && project.customer !== "") {
      texts.push(project.customer);
    }
    if (project.description !== null && project.description !== "") {
      texts.push(project.description);
    }
    this.translate.warmup(texts);
  }

  /** 列表（M2-04）：多维筛选 + 时间闭区间 + 分页 + 排序；软删项目不可见（A5）。 */
  @Get()
  list(
    @Query(new ZodValidationPipe(ProjectListQuerySchema)) query: ProjectListQuery,
    @ProjectScope() scope: ProjectScopeFilter,
  ): Promise<ProjectListResult> {
    return this.projects.listProjects(query, scope);
  }

  /** 首页分类计数（A6）：与列表同一筛选口径（禁止两套 SQL）。 */
  @Get("facets")
  facets(
    @Query(new ZodValidationPipe(ProjectListQuerySchema)) query: ProjectListQuery,
    @ProjectScope() scope: ProjectScopeFilter,
  ): Promise<ProjectFacetsResult> {
    return this.projects.getFacets(query, scope);
  }

  /** 详情：软删 / 不存在统一 404 NOT_FOUND。 */
  @Get(":id")
  detail(@Param("id", uuidParam) id: string): Promise<ProjectView> {
    return this.projects.getProject(id);
  }

  /** 创建（M2-01）：201；编号重复 409 PROJECT_CODE_EXISTS；seq_no 由服务端分配（不接受传入）。需 project.create。 */
  @Post()
  @RequirePermission("project.create")
  async create(
    @Body(new ZodValidationPipe(ProjectCreateBodySchema)) body: ProjectCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectView> {
    const project = await this.projects.createProject(body, actorId);
    this.warmupProjectText(project);
    return project;
  }

  /** 更新（M2-01）：乐观锁（正文 version）；归档写保护（ADR-027）→ 409 PROJECT_ARCHIVED。需 project.update。 */
  @Patch(":id")
  @RequirePermission("project.update")
  async update(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectUpdateBodySchema)) body: ProjectUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectView> {
    const project = await this.projects.updateProject(id, body, actorId);
    this.warmupProjectText(project);
    return project;
  }

  /** 移入项目回收站（2026-10-19）：If-Match 回传当前 version 防误删；返回 deleted_at 已置位的项目。需 project.delete。 */
  @Delete(":id")
  @RequirePermission("project.delete")
  remove(
    @Param("id", uuidParam) id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectView> {
    return this.projects.deleteProject(id, parseIfMatch(ifMatch), actorId);
  }

  /** 从项目回收站恢复：路径项目允许已软删，记录级可见与 project.delete 仍由守卫判定。 */
  @Post(":id/restore")
  @HttpCode(200)
  @ProjectAccess("project")
  @AllowDeletedProjectAccess()
  @RequirePermission("project.delete")
  restore(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectRecycleActionBodySchema)) body: ProjectRecycleActionBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectView> {
    return this.projects.restoreProject(id, body, actorId);
  }

  /** 彻底删除项目：仅系统管理员（服务层硬闸）；数据库聚合 + projects/{id}/ 对象前缀一并清理。 */
  @Post(":id/purge")
  @HttpCode(200)
  @ProjectAccess("project")
  @AllowDeletedProjectAccess()
  @RequirePermission("project.delete")
  purge(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectRecycleActionBodySchema)) body: ProjectRecycleActionBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectPurgeResult> {
    return this.projects.purgeProject(id, body, actorId);
  }

  /** 成员名册（M2-05）：项目经理在前，同角色按工号升序；项目不存在 / 已软删统一 404。 */
  @Get(":id/members")
  listMembers(@Param("id", uuidParam) id: string): Promise<ProjectMemberListResult> {
    return this.members.listMembers(id);
  }

  /** 添加 / 更新成员（幂等 upsert；缺省角色 project_member）；归档项目 409 PROJECT_ARCHIVED。需 member.manage。 */
  @Post(":id/members")
  @HttpCode(200)
  @RequirePermission("member.manage")
  addMember(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectMemberCreateBodySchema)) body: ProjectMemberCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectMemberView> {
    return this.members.addMember(id, body, actorId);
  }

  /** 移除成员：返回被移除的行；成员不存在 / 项目不存在统一 404。需 member.manage。 */
  @Delete(":id/members/:userId")
  @RequirePermission("member.manage")
  removeMember(
    @Param("id", uuidParam) id: string,
    @Param("userId", uuidParam) userId: string,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectMemberView> {
    return this.members.removeMember(id, userId, actorId);
  }

  /** 自动发现但尚未绑定的群候选（只回掩码 + 最近活跃时间；需 project.update）。 */
  @Get(":id/group/candidates")
  @RequirePermission("project.update")
  getGroupCandidates(@Param("id", uuidParam) id: string): Promise<ProjectGroupCandidateList> {
    return this.groups.getCandidates(id);
  }

  /** 项目群绑定状态（M5-03-2 接线段）：GET 恒 200；未绑定 = bound:false；chatid 只回末 4 位掩码。 */
  @Get(":id/group")
  getGroup(@Param("id", uuidParam) id: string): Promise<ProjectGroupBindingView> {
    return this.groups.getGroup(id);
  }

  /** 绑定 / 换绑（B3 定案：project.update 权限档）：PUT 覆盖语义；chatid 变更 = 换绑（重置会话激活态）；归档 409。 */
  @Put(":id/group")
  @HttpCode(200)
  @RequirePermission("project.update")
  putGroup(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(ProjectGroupPutBodySchema)) body: ProjectGroupPutBody,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectGroupBindingView> {
    return this.groups.putGroup(id, body, actorId);
  }

  /** 解绑（幂等：未绑定也返回 bound:false）。需 project.update。 */
  @Delete(":id/group")
  @HttpCode(200)
  @RequirePermission("project.update")
  deleteGroup(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectGroupBindingView> {
    return this.groups.deleteGroup(id, actorId);
  }
}

/** If-Match 解析：口径与契约 ProjectDeleteHeadersSchema 一致（缺失 / 非纯数字 → 400 VALIDATION_FAILED）。 */
function parseIfMatch(value: string | undefined): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new AppError("VALIDATION_FAILED", "缺少 If-Match 请求头（需回传项目当前 version，防误删）");
  }
  return Number(value);
}
