/**
 * 当前用户权限画像（h6 · PoC-6）：GET /api/v1/permissions/me（契约 shared/src/modules/permissions.ts）。
 * 用途：管理入口的呈现层收敛 —— Push 172 起两处按它分叉：
 * ① 字典治理（「＋ 添加项目类型」、地区 / 项目类型的行内删除 = dict.manage）；② 卡片删除项目（project.delete）。
 * （Push 168 曾随「地区全站共享」下线；地区新增对所有人开放，仍然不看权限。）
 * 2026-10-25 起头像菜单「操作记录」对所有登录账号开放，由服务端按 auditScope 收敛记录。
 * 服务端逐请求仍是最终裁决，前端只做呈现层收敛；失败口径：拉取失败一律回落「无权限」（入口不渲染，误点会吃 403）。
 * 取数口径：统一单飞缓存和订阅（App、AppHeader及文件库共用）；权限/人员实时提示与周期补读更新画像。
 */
import { useSyncExternalStore } from "react";
import { apiRequest } from "./api";

export const GROUP_ACCESS_PAGE_KEYS = ["dashboard", "projects", "templates", "workspace", "files", "audit"] as const;
export type GroupAccessPage = (typeof GROUP_ACCESS_PAGE_KEYS)[number];

export type GroupProjectAccess = "allowed" | "empty" | "denied";
/** 部门规则的项目范围；多个部门命中时按并集展示。 */
export type GroupAccessProjectScope = "all" | "own" | "selected" | "none";
/** 可授予数据权限的项目范围（none 不进入权限数组；空数组 = 不显示项目数据）。 */
export type GroupAccessDataProjectScope = "all" | "own" | "selected";
/** 编辑 = 可写并浏览；仅浏览 = 只读。 */
export type GroupAccessLevel = "edit" | "view";
export type GroupAccessScopePermission = {
  projectScope: GroupAccessDataProjectScope;
  accessLevel: GroupAccessLevel;
};
export type AuditScope = "all" | "project_manager" | "self";

export type MyPermissions = {
  /** 遗留字段；服务端固定为空，不代表用户角色，不参与任何授权判定。 */
  roleCodes: string[];
  /** 全量功能权限基线；写能力另由部门规则的编辑 / 仅浏览档位裁决。 */
  permissionKeys: string[];
  /** 当前账号 Casdoor 群组键（owner/name）。 */
  groupKeys: string[];
  /** 群组访问限制下的可进入页面；管理员 / 开关关闭时为全量。 */
  pageKeys: GroupAccessPage[];
  groupAccessEnforced: boolean;
  groupAccessAdmin: boolean;
  /** 兼容摘要：所有范围均无编辑权限时为 true；写入口以项目 groupAccessLevel / 能力布尔值为准。 */
  groupReadOnly: boolean;
  /** 部门项目权限三态：allowed 正常进入 / empty 无可见项目 / denied 仅登录。 */
  groupProjectAccess: GroupProjectAccess;
  /** 命中的项目范围并集，用于空态说明当前权限。 */
  groupProjectScopes: GroupAccessProjectScope[];
  /** 兼容摘要：任一范围可编辑 = edit；项目级写权限以项目 groupAccessLevel 为准。 */
  groupAccessLevel: GroupAccessLevel;
  /** 多范围权限，同一范围取最高权限。 */
  groupScopePermissions: GroupAccessScopePermission[];
  /** 至少一个范围可编辑（任务模板 / 节点库）。 */
  groupAnyEdit: boolean;
  /** 全部项目编辑（字典 / 日历 / 自动化 / 重发）。 */
  groupAllEdit: boolean;
  /** 自己的项目编辑（可新建项目）。 */
  groupOwnEdit: boolean;
  /** 指定项目编辑（且至少选中一个项目）。 */
  groupSelectedEdit: boolean;
  /** 操作记录可见范围：管理员 / 项目经理 / 仅本人。 */
  auditScope: AuditScope;
};

type PermissionMeResponse = {
  permissions: {
    userId: string;
    roleCodes: string[];
    dataScopes: string[];
    permissionKeys: string[];
    groupKeys?: string[];
    pageKeys?: GroupAccessPage[];
    groupAccessEnforced?: boolean;
    groupAccessAdmin?: boolean;
    groupReadOnly?: boolean;
    groupProjectAccess?: GroupProjectAccess;
    groupProjectScopes?: GroupAccessProjectScope[];
    groupAccessLevel?: GroupAccessLevel;
    groupScopePermissions?: GroupAccessScopePermission[];
    groupAnyEdit?: boolean;
    groupAllEdit?: boolean;
    groupOwnEdit?: boolean;
    groupSelectedEdit?: boolean;
    auditScope?: AuditScope;
  };
};

let pending: Promise<MyPermissions> | null = null;
let snapshot: MyPermissions | null = null;
const listeners = new Set<() => void>();

export function useMyPermissions(): MyPermissions | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}

/** All entry points observe one profile. Refresh failures do not retain a potentially revoked grant. */
export function loadMyPermissions(refresh = false): Promise<MyPermissions> {
  if (!refresh && snapshot !== null) return Promise.resolve(snapshot);
  if (pending !== null) return pending;
  pending = apiRequest<PermissionMeResponse>("/api/v1/permissions/me")
    .then((payload) => {
      const groupAccessEnforced = payload.permissions.groupAccessEnforced === true;
      const groupAccessAdmin = payload.permissions.groupAccessAdmin === true;
      const groupReadOnly = payload.permissions.groupReadOnly === true;
      const groupProjectAccess = payload.permissions.groupProjectAccess ?? (groupAccessEnforced && !groupAccessAdmin ? "denied" : "allowed");
      const groupAccessLevel = payload.permissions.groupAccessLevel ?? (groupReadOnly ? "view" : "edit");
      const groupProjectScopes = payload.permissions.groupProjectScopes ?? (groupAccessEnforced && !groupAccessAdmin ? [] : ["all"]);
      const fallbackScope = (["all", "own", "selected"] as const).find((scope) => groupProjectScopes.includes(scope));
      const groupScopePermissions = payload.permissions.groupScopePermissions ??
        (fallbackScope === undefined ? [] : [{ projectScope: fallbackScope, accessLevel: groupAccessLevel }]);
      snapshot = {
        roleCodes: payload.permissions.roleCodes,
        permissionKeys: payload.permissions.permissionKeys,
        groupKeys: payload.permissions.groupKeys ?? [],
        pageKeys: payload.permissions.pageKeys ?? [...GROUP_ACCESS_PAGE_KEYS],
        groupAccessEnforced,
        groupAccessAdmin,
        groupReadOnly,
        groupProjectAccess,
        groupProjectScopes,
        groupAccessLevel,
        groupScopePermissions,
        groupAnyEdit: payload.permissions.groupAnyEdit ??
          (groupAccessAdmin || groupScopePermissions.some((permission) => permission.accessLevel === "edit")),
        groupAllEdit: payload.permissions.groupAllEdit ??
          (groupAccessAdmin || groupScopePermissions.some((permission) => permission.projectScope === "all" && permission.accessLevel === "edit")),
        groupOwnEdit: payload.permissions.groupOwnEdit ??
          (groupAccessAdmin || groupScopePermissions.some((permission) => permission.projectScope === "own" && permission.accessLevel === "edit")),
        groupSelectedEdit: payload.permissions.groupSelectedEdit ??
          (groupAccessAdmin || groupScopePermissions.some((permission) => permission.projectScope === "selected" && permission.accessLevel === "edit")),
        auditScope: payload.permissions.auditScope ?? (groupAccessAdmin ? "all" : "self"),
      };
      for (const listener of listeners) listener();
      return snapshot;
    })
    .catch((error: unknown) => {
      snapshot = null;
      for (const listener of listeners) listener();
      throw error;
    }).finally(() => { pending = null; });
  return pending;
}

/** 是否持有某个功能权限位（画像未拿到 = false：入口按「无权限」呈现）。 */
export function hasPermission(permissions: MyPermissions | null, key: string): boolean {
  return permissions !== null && permissions.permissionKeys.includes(key);
}

/** 页面入口恒放行：业务数据由页面级空状态与服务端数据范围收敛；模板读取跟随部门规则，操作记录对登录账号开放。 */
export function hasPageAccess(_permissions: MyPermissions | null, _page: GroupAccessPage): boolean {
  return true;
}

/** 任务模板维护：系统管理员恒可编辑；部门限制开启且任一范围可编辑时也可编辑。 */
export function canEditTaskTemplates(permissions: MyPermissions | null): boolean {
  if (permissions === null) return false;
  return permissions.groupAccessAdmin || (permissions.groupAccessEnforced && permissions.groupAnyEdit);
}
