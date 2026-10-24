/** 群组权限管理接口（GET /api/v1/access · PUT /api/v1/access/rules）。 */
import { apiRequest, apiSend } from "./api";
import type { GroupAccessPage } from "./permissions";

export type GroupAccessProjectScope = "all" | "own" | "selected" | "none";
export type GroupAccessMemberScope = "all" | "selected";

export type GroupAccessRule = {
  groupKey: string;
  groupName: string;
  allowedPages?: GroupAccessPage[];
  projectScope: GroupAccessProjectScope;
  projectIds: string[];
  memberScope: GroupAccessMemberScope;
  memberUserIds: string[];
  updatedAt: string;
};

export type GroupAccessMember = {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
};

export type GroupAccessGroup = {
  groupKey: string;
  groupName: string;
  parentGroupKey: string | null;
  memberCount: number;
  members: GroupAccessMember[];
  rule: GroupAccessRule | null;
};

export type GroupAccessProject = { id: string; code: string; name: string };

export type GroupAccessOverview = {
  enforced: boolean;
  admin: boolean;
  currentGroupKeys: string[];
  groups: GroupAccessGroup[];
  projects: GroupAccessProject[];
};

export type GroupAccessRuleInput = {
  groupKey: string;
  groupName?: string;
  projectScope: GroupAccessProjectScope;
  projectIds: string[];
  memberScope: GroupAccessMemberScope;
  memberUserIds: string[];
};

export function fetchAccessOverview(): Promise<GroupAccessOverview> {
  return apiRequest<GroupAccessOverview>("/api/v1/access");
}

export function saveGroupAccessRule(input: GroupAccessRuleInput): Promise<{ rule: GroupAccessRule }> {
  return apiSend<{ rule: GroupAccessRule }>("/api/v1/access/rules", "PUT", input);
}

export function deleteGroupAccessRule(groupKey: string): Promise<void> {
  return apiSend<void>("/api/v1/access/rules?groupKey=" + encodeURIComponent(groupKey), "DELETE");
}
