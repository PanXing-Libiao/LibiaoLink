/**
 * 人员模型（M3-07 刀 1 后半接线版）：只保留 UI 侧的类型。
 * 演示用人员目录（MEMBER_DIRECTORY / PROJECT_MANAGERS / memberByName 等）已随接线下线 ——
 * 候选人来自服务端用户目录（GET /api/v1/users，见 frontend/src/directory.ts 的 directoryMemberOptions）。
 */
/** 按 id 取姓名（写回响应不带姓名时的兜底来源 = 同一份用户目录）；未知 id 返回 undefined。 */
export function memberNameOf(members: readonly Member[], id: string): string | undefined {
  const found = members.find((member) => member.id === id);
  return found === undefined ? undefined : found.name;
}

export type Member = {
  id: string;
  name: string;
  /** 副标题（用户目录接线口径 = 工号 username）。 */
  handle: string;
};
