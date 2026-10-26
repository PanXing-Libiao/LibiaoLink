import { useT } from "../i18n";
import { useMyPermissions } from "../permissions";
import { listHref } from "../useHashRoute";

/** 有部门规则但当前没有可见项目：保留页面骨架，在页头下方显示非阻断提示；编辑规则仍可新建项目。 */
export function ProjectAccessNotice() {
  const t = useT();
  const permissions = useMyPermissions();
  if (permissions?.groupProjectAccess !== "empty") {
    return null;
  }
  return (
    <div data-project-access-notice="empty" role="status" className="border-b border-amber-200/70 bg-amber-50/90">
      <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-6 py-2.5 text-xs leading-5 text-amber-900">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-600">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 3h.01M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" />
        </svg>
        <span className="font-medium">{t("access.noProjects.title")}</span>
        <span className="text-amber-800/85">
          {t(permissions.groupReadOnly ? "access.noProjects.desc" : "access.noProjects.editDesc")}
        </span>
        {permissions.groupReadOnly ? null : (
          <a href={listHref()} className="font-medium text-amber-900 underline decoration-amber-400 underline-offset-4 transition hover:text-amber-950">
            {t("access.noProjects.openProjects")}
          </a>
        )}
      </div>
    </div>
  );
}
