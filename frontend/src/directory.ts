/**
 * 用户目录（A2）：GET /api/v1/users —— 首页「项目经理」筛选、项目卡片与新建 / 编辑下拉的姓名来源。
 * 契约 UserSummary = { id, username, displayName, email, status }（shared/src/modules/users.ts）；只返回启用用户。
 * 一期目录规模小，全量拉一页（limit 上限 200）；按需搜索留待 M3-07 接入 q。
 */
import { readAllPages } from "./api";
import type { Member } from "./data/members";

export type DirectoryUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: string;
};

export async function loadDirectory(): Promise<DirectoryUser[]> {
  const payload = await readAllPages<DirectoryUser>("/api/v1/users");
  return payload.items;
}

/** 按 id 取姓名；未知 id 回落 id 本身（脏链接 / 离职人员兜底，界面不出现空白）。 */
export function directoryName(users: readonly DirectoryUser[], id: string): string {
  const found = users.find((user) => user.id === id);
  return found === undefined ? id : found.displayName;
}

/** 多位按「、」连接（与任务负责人展示同一口径）。 */
export function directoryNames(users: readonly DirectoryUser[], ids: readonly string[]): string {
  return ids.map((id) => directoryName(users, id)).join("、");
}

/** 下拉选项：把用户目录映射成 MemberSelect 认的 Member（拼音列 = 工号）。 */
export function directoryMemberOptions(users: readonly DirectoryUser[]): Member[] {
  return users.map((user) => ({ id: user.id, name: user.displayName, handle: user.username, role: "项目经理" }));
}
