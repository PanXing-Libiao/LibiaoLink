import {
  ACCESS_BASE_HASH,
  AUDIT_BASE_HASH,
  FILES_BASE_HASH,
  HUB_HASH,
  LIST_BASE_HASH,
  SETTINGS_BASE_HASH,
  TEMPLATE_BASE_HASH,
  WORKSPACE_BASE_HASH,
} from "./useHashRoute";
import { hasPageAccess, hasPermission, type GroupAccessPage, type MyPermissions } from "./permissions";

const PAGE_HOME_HREFS: ReadonlyArray<{ page: GroupAccessPage; href: string }> = [
  { page: "dashboard", href: HUB_HASH },
  { page: "projects", href: LIST_BASE_HASH },
  { page: "templates", href: TEMPLATE_BASE_HASH },
  { page: "workspace", href: WORKSPACE_BASE_HASH },
  { page: "files", href: FILES_BASE_HASH },
  { page: "audit", href: AUDIT_BASE_HASH },
];

/** 首个可访问页：登录落点 / 无仪表盘权限时 Logo 的回退；全部页面关闭时落权限管理或设置页。 */
export function firstAllowedHref(permissions: MyPermissions | null): string {
  for (const item of PAGE_HOME_HREFS) {
    if (item.page === "audit" && !hasPermission(permissions, "audit.view")) continue;
    if (hasPageAccess(permissions, item.page)) return item.href;
  }
  return permissions?.groupAccessAdmin === true ? ACCESS_BASE_HASH : SETTINGS_BASE_HASH;
}
