import { Injectable } from "@nestjs/common";
import { ProjectMemberCreateBodySchema, ProjectMemberListResponseSchema, ProjectMemberSchema, z } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { AuditService } from "../admin/index.js";
import { UserService } from "../identity/index.js";
import { ProjectManagerEligibilityService } from "../permission/index.js";
import { ProjectMemberRepository, type ProjectMemberViewRow } from "./project-member.repository.js";
import { ProjectRepository } from "./project.repository.js";

export type ProjectMemberView = z.infer<typeof ProjectMemberSchema>;
export type ProjectMemberListResult = z.infer<typeof ProjectMemberListResponseSchema>;

/** 入参按「契约输入」收：HTTP 侧 roleInProject 的缺省由 ZodValidationPipe 落定，直接调用服务时同口径兜底。 */
type ProjectMemberCreateBody = z.input<typeof ProjectMemberCreateBodySchema>;

/** 名册行 → 契约视图（camelCase + ISO 时间）。 */
export function toProjectMemberView(row: ProjectMemberViewRow): ProjectMemberView {
  return {
    userId: row.member.userId,
    username: row.username,
    displayName: row.displayName,
    roleInProject: row.member.roleInProject as ProjectMemberView["roleInProject"],
    joinedAt: row.member.joinedAt.toISOString(),
  };
}

/**
 * 项目成员用例（M2-05 名册部分）：添加 / 移除 / 列表。
 * 名册是记录级权限（非成员 404）与「我参与的项目」的数据来源，消费方是 h6 策略服务（ADR-011）；
 * 本批只做名册维护与可见性，不做列表 / 详情的成员过滤（随 h6）。
 * 成员变更按 ADR-022 ② 刷新项目 updatedAt（ProjectRepository.touch 单点）。
 */
@Injectable()
export class ProjectMemberService {
  constructor(
    private readonly database: DatabaseService,
    private readonly members: ProjectMemberRepository,
    private readonly projects: ProjectRepository,
    private readonly managerEligibility: ProjectManagerEligibilityService,
    private readonly users: UserService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(projectId: string): Promise<ProjectMemberListResult> {
    await this.requireProject(projectId);
    const rows = await this.members.listByProject(projectId);
    return { items: rows.map(toProjectMemberView), total: rows.length };
  }

  /** 添加 / 更新成员：项目归档后拒绝（与主数据写保护同口径）；用户不存在 → 404（复用用户目录语义）；变更写审计。 */
  async addMember(projectId: string, body: ProjectMemberCreateBody, actorId: string): Promise<ProjectMemberView> {
    const project = await this.requireProject(projectId);
    this.assertWritable(project.project.status);
    const user = await this.users.getUser(body.userId);
    const roleInProject = body.roleInProject ?? "project_member";
    if (roleInProject === "project_manager") {
      const existing = await this.members.findByProjectAndUser(projectId, body.userId);
      const existingManagerIds = [
        ...project.project.managerIds,
        ...(existing?.member.roleInProject === "project_manager" ? [body.userId] : []),
      ];
      await this.managerEligibility.assertAssignable([body.userId], {
        existingUserIds: existingManagerIds,
      });
    }
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      await this.members.upsert(projectId, body.userId, roleInProject, at, tx);
      await this.projects.touch(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "project_member",
        objectId: body.userId,
        projectId,
        summary: "添加项目成员：" + user.displayName + "（" + user.username + "，角色 " + roleInProject + "）",
        changes: [
          { field: "userId", from: null, to: body.userId },
          { field: "roleInProject", from: null, to: roleInProject },
        ],
      });
    });
    const row = await this.requireMemberRow(projectId, body.userId);
    return toProjectMemberView(row);
  }

  /** 移除成员：不是成员 / 项目不存在统一 404（ADR-011 统一 404 语义）。 */
  async removeMember(projectId: string, userId: string, actorId: string): Promise<ProjectMemberView> {
    const project = await this.requireProject(projectId);
    this.assertWritable(project.project.status);
    const user = await this.users.getUser(userId);
    const at = new Date();
    const removed = await this.database.db.transaction(async (tx) => {
      const row = await this.members.remove(projectId, userId, tx);
      if (row === null) {
        throw new AppError("NOT_FOUND", "该用户不在项目成员中");
      }
      await this.projects.touch(projectId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "project_member",
        objectId: userId,
        projectId,
        summary: "移除项目成员：" + user.displayName + "（" + user.username + "）",
        changes: [{ field: "roleInProject", from: row.roleInProject, to: null }],
      });
      return row;
    });
    return toProjectMemberView({ member: removed, username: user.username, displayName: user.displayName });
  }

  private async requireProject(projectId: string) {
    const project = await this.projects.findViewById(projectId);
    if (project === null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    return project;
  }

  private async requireMemberRow(projectId: string, userId: string): Promise<ProjectMemberViewRow> {
    const row = await this.members.findByProjectAndUser(projectId, userId);
    if (row === null) {
      throw new AppError("NOT_FOUND", "该用户不在项目成员中");
    }
    return row;
  }

  /** 归档写保护（ADR-027）：名册变更属项目写路径，与主数据同口径。 */
  private assertWritable(status: string): void {
    if (status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止修改成员");
    }
  }
}
