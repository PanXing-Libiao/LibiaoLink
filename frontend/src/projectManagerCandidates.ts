/**
 * 项目经理候选名单（GET /api/v1/projects/manager-candidates）。
 * 服务端口径：有效（启用且未离职）项目部成员 ∪ 有效系统管理员。
 * 只供「项目经理」选择器使用；任务负责人 / 问题处理人 / 日报人员仍使用完整用户目录。
 */
import { apiRequest } from "./api";
import type { DirectoryUser } from "./directory";

export type ProjectManagerCandidate = DirectoryUser & {
  inProjectDepartment: boolean;
  isSystemAdmin: boolean;
};

export async function loadProjectManagerCandidates(): Promise<ProjectManagerCandidate[]> {
  const payload = await apiRequest<{ items: ProjectManagerCandidate[]; total: number }>("/api/v1/projects/manager-candidates");
  return payload.items;
}
