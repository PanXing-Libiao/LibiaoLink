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
/** 编辑 = 可写并浏览；仅浏览 = 只读。 */
export type GroupAccessLevel = "edit" | "view";
export type AuditScope = "all" | "project_manager" | "self";

export type MyPermissions = {
  /** 角色码（roles.code；多角色并集），排障 / 调试用。 */
  roleCodes: string[];
  /** 功能权限位并集（role_permissions ↔ 契约 PERMISSION_KEYS）。 */
  permissionKeys: string[];
  /** 当前账号 Casdoor 群组键（owner/name）。 */
  groupKeys: string[];
  /** 群组访问限制下的可进入页面；管理员 / 开关关闭时为全量。 */
  pageKeys: GroupAccessPage[];
  groupAccessEnforced: boolean;
  groupAccessAdmin: boolean;
  /** 群组限制开启且非管理员：页面可进、业务数据按项目范围裁剪、所有写入口关闭。 */
  groupReadOnly: boolean;
  /** 部门项目权限三态：allowed 正常进入 / empty 无可见项目 / denied 仅登录。 */
  groupProjectAccess: GroupProjectAccess;
  /** 命中的项目范围并集，用于空态说明当前权限。 */
  groupProjectScopes: GroupAccessProjectScope[];
  /** 当前部门权限档位。 */
  groupAccessLevel: GroupAccessLevel;
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
      snapshot = {
        roleCodes: payload.permissions.roleCodes,
        permissionKeys: payload.permissions.permissionKeys,
        groupKeys: payload.permissions.groupKeys ?? [],
        pageKeys: payload.permissions.pageKeys ?? [...GROUP_ACCESS_PAGE_KEYS],
        groupAccessEnforced,
        groupAccessAdmin,
        groupReadOnly,
        groupProjectAccess,
        groupProjectScopes: payload.permissions.groupProjectScopes ?? (groupAccessEnforced && !groupAccessAdmin ? [] : ["all"]),
        groupAccessLevel: payload.permissions.groupAccessLevel ?? (groupReadOnly ? "view" : "edit"),
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

/** 页面入口恒放行：业务数据由页面级空状态与服务端数据范围收敛，模板 / 操作记录对登录账号开放。 */
export function hasPageAccess(_permissions: MyPermissions | null, _page: GroupAccessPage): boolean {
  return true;
}

/** 任务模板维护：系统管理员恒可编辑；部门限制开启且命中编辑规则时也可编辑。 */
export function canEditTaskTemplates(permissions: MyPermissions | null): boolean {
  if (permissions === null) return false;
  return permissions.groupAccessAdmin || (permissions.groupAccessEnforced && !permissions.groupReadOnly);
}
