import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import { projectNodes } from "../../db/schema/flow.js";
import { projectMembers, projects } from "../../db/schema/projects.js";
import { visibleProjectIds, type ProjectScopeSpec } from "./permission.rules.js";

/** 项目数据面引用：可见性解析需要的项目主数据字段（不做软删过滤，由调用方判定）。 */
export interface ProjectRef {
  /** 项目经理（A22 · Push 136：多位，任一位即视为项目责任人）。 */
  managerIds: string[];
  deletedAt: Date | null;
}

/** 记录级解析结果：可见项目上下文 + 项目内角色（can 的项目级来源）。 */
export interface ProjectAccessContext {
  projectId: string;
  member: boolean;
  projectManager: boolean;
}

/**
 * permission 数据访问（h6）：只读名册 / 项目主数据 / 节点 → 项目解析。
 * 边界：记录级判定需要「我参与的项目」与「节点属于哪个项目」，前者读 project_members、
 * 后者读 project_nodes —— 只读、只取判定所需列；名册与节点的写路径仍归 project 模块。
 */
@Injectable()
export class PermissionRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 我参与的项目 id（名册任意角色）。 */
  async listMemberProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actorId));
    return rows.map((row) => row.projectId);
  }

  /** 我作为主数据责任人的项目 id（projects.manager_ids 含我；含回收站项目，列表查询再按 filter[recycled] 过滤）。 */
  async listOwnedProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ projectId: projects.id })
      .from(projects)
      .where(sql`${projects.managerIds} @> array[${actorId}]::uuid[]`);
    return rows.map((row) => row.projectId);
  }

  /** 我在名册里是 project_manager 的项目 id（managed_projects 数据范围）。 */
  async listManagedRosterProjectIds(actorId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, actorId), eq(projectMembers.roleInProject, "project_manager")));
    return rows.map((row) => row.projectId);
  }

  /**
   * 可见项目 id 并集（记录级过滤；spec.all 由服务层短路，不查库）：
   * 名册成员（member） ∪ 我作为主数据责任人的项目（恒可见，见 resolveProjectAccess 同谓词） ∪ managed_projects 下的名册项目经理。
   */
  async listVisibleProjectIds(actorId: string, spec: ProjectScopeSpec): Promise<string[]> {
    return visibleProjectIds(spec, {
      memberIds: await this.listMemberProjectIds(actorId),
      ownedIds: await this.listOwnedProjectIds(actorId),
      managedRosterIds: await this.listManagedRosterProjectIds(actorId),
    });
  }

  /** 项目主数据引用（不存在返回 null；软删由调用方判定）。 */
  async findProjectRef(projectId: string): Promise<ProjectRef | null> {
    const rows = await this.database.db
      .select({ managerIds: projects.managerIds, deletedAt: projects.deletedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 名册行（项目内角色）。 */
  async findMembership(actorId: string, projectId: string): Promise<string | null> {
    const rows = await this.database.db
      .select({ roleInProject: projectMembers.roleInProject })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actorId)))
      .limit(1);
    return rows[0]?.roleInProject ?? null;
  }

  /** 节点 → 项目（/api/v1/nodes/* 路由没有项目路径参数，可见性判定需要这一步解析）。 */
  async findNodeProjectId(nodeId: string): Promise<string | null> {
    const rows = await this.database.db
      .select({ projectId: projectNodes.projectId })
      .from(projectNodes)
      .where(eq(projectNodes.id, nodeId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
}
