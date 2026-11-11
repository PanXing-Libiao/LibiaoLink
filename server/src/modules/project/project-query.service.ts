import { Injectable } from "@nestjs/common";
import { PermissionService } from "../permission/index.js";
import { ProjectRepository, type ProjectReferenceRow } from "./project.repository.js";

/** 项目名称精确匹配前的唯一归一化口径。 */
export function normalizeProjectName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export type ProjectLookupResult =
  | { status: "unique"; project: ProjectReferenceRow }
  | { status: "ambiguous"; candidates: ProjectReferenceRow[] }
  | { status: "not_found" };

/**
 * 机器人项目解析（S1）：只在发送人可见项目中按 projects.code 或归一化名称精确匹配。
 * 编号命中优先于名称命中；名称命中多个时返回全部可见候选的编号 / 名称，不返回业务数据。
 */
@Injectable()
export class ProjectQueryService {
  constructor(
    private readonly permissions: PermissionService,
    private readonly projects: ProjectRepository,
  ) {}

  async lookup(actorId: string, reference: string): Promise<ProjectLookupResult> {
    const input = reference.trim();
    if (input === "") return { status: "not_found" };

    const scope = await this.permissions.projectScope(actorId);
    const visible = await this.projects.listVisibleReferences(scope);

    const codeMatch = visible.find((project) => project.code === input);
    if (codeMatch !== undefined) return { status: "unique", project: codeMatch };

    const normalized = normalizeProjectName(input);
    const nameMatches = visible
      .filter((project) => normalizeProjectName(project.name) === normalized)
      .sort((left, right) => {
        if (left.code !== right.code) return left.code < right.code ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    if (nameMatches.length === 0) return { status: "not_found" };
    const [only] = nameMatches;
    if (only !== undefined && nameMatches.length === 1) return { status: "unique", project: only };
    return { status: "ambiguous", candidates: nameMatches };
  }

  /** 群聊显式项目：只与群绑定项目比对，重名项目不得把群绑定项目误判为歧义。 */
  async matchesBoundProject(projectId: string, reference: string): Promise<boolean> {
    const input = reference.trim();
    if (input === "") return false;
    const project = await this.projects.findReferenceById(projectId);
    if (project === null) return false;
    return project.code === input || normalizeProjectName(project.name) === normalizeProjectName(input);
  }
}
