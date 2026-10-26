/** 部门权限管理接口（GET /api/v1/access · 规则保存 / 删除 · 系统管理员授予 / 撤销）。 */
import { apiRequest, apiSend } from "./api";
import type { GroupAccessPage } from "./permissions";

export type GroupAccessProjectScope = "all" | "own" | "selected" | "none";
export type GroupAccessAccessLevel = "edit" | "view";
export type GroupAccessMemberScope = "all" | "selected";

export type GroupAccessRule = {
  groupKey: string;
  groupName: string;
  allowedPages?: GroupAccessPage[];
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
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

export type GroupAccessAdminSource = "configured" | "manual";

export type GroupAccessAdmin = {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  source: GroupAccessAdminSource;
  removable: boolean;
};

export type GroupAccessProject = { id: string; code: string; name: string };

export type GroupAccessOverview = {
  enforced: boolean;
  admin: boolean;
  currentGroupKeys: string[];
  admins: GroupAccessAdmin[];
  groups: GroupAccessGroup[];
  projects: GroupAccessProject[];
};

export type GroupAccessRuleInput = {
  groupKey: string;
  groupName?: string;
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
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

export function assignGroupAccessAdmin(userId: string): Promise<{ admin: GroupAccessAdmin }> {
  return apiSend<{ admin: GroupAccessAdmin }>("/api/v1/access/admins", "POST", { userId });
}

export function revokeGroupAccessAdmin(userId: string): Promise<void> {
  return apiSend<void>("/api/v1/access/admins?userId=" + encodeURIComponent(userId), "DELETE");
}
