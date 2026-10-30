import { HUB_HASH, projectsHref, TEMPLATE_BASE_HASH, WORKSPACE_BASE_HASH, useHashRoute } from "../useHashRoute";
import { useT } from "../i18n";
import { hasPageAccess, useMyPermissions, type GroupAccessPage } from "../permissions";

export type MainNavKey = "hub" | "projects" | "templates" | "workspace";

export type MainNavItem = {
  key: MainNavKey;
  page: GroupAccessPage;
  label: string;
  href: string;
  active: boolean;
};

export function useMainNavItems(): MainNavItem[] {
  const route = useHashRoute();
  const t = useT();
  const permissions = useMyPermissions();
  const allItems: MainNavItem[] = [
    { key: "hub", page: "dashboard", label: t("nav.hub"), href: HUB_HASH, active: route.kind === "hub" },
    {
      key: "projects",
      page: "projects",
      label: t("nav.projects"),
      href: projectsHref(),
      active: route.kind === "list" || route.kind === "project",
    },
    {
      key: "templates",
      page: "templates",
      label: t("nav.templates"),
      href: TEMPLATE_BASE_HASH,
      active: route.kind === "placeholder" && route.page === "templates",
    },
    { key: "workspace", page: "workspace", label: t("nav.workspace"), href: WORKSPACE_BASE_HASH, active: route.kind === "workspace" },
  ];
  return allItems.filter((item) => hasPageAccess(permissions, item.page));
}
