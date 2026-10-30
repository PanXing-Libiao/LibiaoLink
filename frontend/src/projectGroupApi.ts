/**
 * 项目群绑定客户端（设置页 · 复用现有 ProjectGroup 契约）。
 *
 * GET    /api/v1/projects/{id}/group/candidates  自动发现候选群（只回掩码）
 * GET    /api/v1/projects/{id}/group             恒 200，未绑定 = bound:false
 * PUT    /api/v1/projects/{id}/group             按 candidateId 或手工 chatid 绑定 / 换绑
 * DELETE /api/v1/projects/{id}/group             解绑（project.update，幂等）
 *
 * chatid 只在手工兜底写面提交全文；读面只有末 4 位掩码，前端不缓存、不落日志。
 */
import { apiRequest, apiSend } from "./api";

export type ProjectGroupBinding = {
  projectId: string;
  bound: boolean;
  name: string | null;
  chatidMasked: string | null;
  activated: boolean;
  /** 服务端按内部 actor 身份裁决；前端不得用 SSO user.id 与项目内部 managerIds 直接比较。 */
  canManage: boolean;
  updatedAt: string | null;
};

export type ProjectGroupCandidate = {
  id: number;
  name: string | null;
  chatidMasked: string;
  lastSeenAt: string;
};

export type ProjectGroupCandidateList = {
  items: ProjectGroupCandidate[];
};

export type ProjectGroupWriteInput =
  | { chatid: string; name?: string | null }
  | { candidateId: number; name?: string | null };

function groupPath(projectId: string): string {
  return "/api/v1/projects/" + encodeURIComponent(projectId) + "/group";
}

export function fetchProjectGroup(projectId: string, signal?: AbortSignal): Promise<ProjectGroupBinding> {
  return apiRequest<ProjectGroupBinding>(groupPath(projectId), signal === undefined ? {} : { signal });
}

export function fetchProjectGroupCandidates(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectGroupCandidateList> {
  return apiRequest<ProjectGroupCandidateList>(
    groupPath(projectId) + "/candidates",
    signal === undefined ? {} : { signal },
  );
}

export function putProjectGroup(projectId: string, input: ProjectGroupWriteInput): Promise<ProjectGroupBinding> {
  const name = input.name === null || input.name === undefined ? undefined : input.name.trim();
  const target =
    "candidateId" in input
      ? { candidateId: input.candidateId }
      : { chatid: input.chatid.trim() };
  return apiSend<ProjectGroupBinding>(groupPath(projectId), "PUT", {
    ...target,
    ...(input.name === undefined ? {} : { name: name === "" ? null : name }),
  });
}

export function deleteProjectGroup(projectId: string): Promise<ProjectGroupBinding> {
  return apiSend<ProjectGroupBinding>(groupPath(projectId), "DELETE");
}
