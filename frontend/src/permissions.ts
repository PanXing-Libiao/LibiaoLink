/**
 * 当前用户权限画像（h6 · PoC-6）：GET /api/v1/permissions/me（契约 shared/src/modules/permissions.ts）。
 * 用途：管理入口的呈现层收敛 —— Push 172 起两处按它分叉：
 * ① 字典治理（「＋ 添加项目类型」、地区 / 项目类型的行内删除 = dict.manage）；② 卡片删除项目（project.delete）。
 * （Push 168 曾随「地区全站共享」下线；地区新增对所有人开放，仍然不看权限。）
 * 2026-10-08 第三处：头像菜单「操作记录」（audit.view，AppHeader 自取同一份画像）。
 * 服务端逐请求仍是最终裁决，前端只做呈现层收敛；失败口径：拉取失败一律回落「无权限」（入口不渲染，误点会吃 403）。
 * 取数口径：统一单飞缓存和订阅（App、AppHeader及文件库共用）；权限/人员实时提示与周期补读更新画像。
 */
import { useSyncExternalStore } from "react";
import { apiRequest } from "./api";

export const GROUP_ACCESS_PAGE_KEYS = ["dashboard", "projects", "templates", "workspace", "files", "audit"] as const;
export type GroupAccessPage = (typeof GROUP_ACCESS_PAGE_KEYS)[number];

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
      snapshot = {
        roleCodes: payload.permissions.roleCodes,
        permissionKeys: payload.permissions.permissionKeys,
        groupKeys: payload.permissions.groupKeys ?? [],
        pageKeys: payload.permissions.pageKeys ?? [...GROUP_ACCESS_PAGE_KEYS],
        groupAccessEnforced: payload.permissions.groupAccessEnforced === true,
        groupAccessAdmin: payload.permissions.groupAccessAdmin === true,
        groupReadOnly: payload.permissions.groupReadOnly === true,
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

/**
 * 页面是否放行：部门规则不再限制业务页面入口；
 * 任务模板属于系统维护配置，仅系统管理员可见（导航与直链同一口径）。
 * 服务端数据范围与只读裁决仍是最终边界。
 */
export function hasPageAccess(permissions: MyPermissions | null, page: GroupAccessPage): boolean {
  if (page === "templates") return permissions?.groupAccessAdmin === true;
  return true;
}
