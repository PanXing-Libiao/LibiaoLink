/** permission 模块唯一公开出口（跨模块只允许 import 本文件；ADR-011 / g6）。 */
export { PermissionModule } from "./permission.module.js";
export { PermissionService } from "./permission.service.js";
export { PermissionController } from "./permission.controller.js";
export { ProjectAccessGuard, ProjectAccess, AllowDeletedProjectAccess, RequirePermission, ProjectScope, CurrentProjectAccess } from "./project-access.guard.js";
export { GroupAccessGuard, GroupAccessAdminGuard, RequireAccessPage } from "./group-access.guard.js";
export { GroupAccessService } from "./group-access.service.js";
export { effectiveGroupAccessRules, intersectProjectIds, isGroupAccessAdmin, parseGroupAccessAdminKeys, resolveGroupAccess } from "./group-access.rules.js";
export type { GroupAccessMemberRuleData, GroupAccessProfile, GroupAccessRuleData } from "./group-access.rules.js";
export type { ProjectAccessSource, RequestWithProjectAccess } from "./project-access.guard.js";
export type { ProjectAccessContext } from "./permission.repository.js";
export {
  can,
  canManageTaskFinalization,
  canSeeField,
  exitsConsistent,
  hiddenFields,
  isKnownPermissionKey,
  isProjectVisible,
  planExit,
  projectFields,
  projectScopeSpec,
  visibleFields,
  ENTITY_FIELDS,
  EXIT_KINDS,
  EXIT_REQUIRED_PERMISSION,
  FIELD_ENTITIES,
  FIELD_POLICIES,
  PENDING_DATA_SCOPES,
  PROJECT_MANAGER_IMPLIED_KEYS,
  PROJECT_MEMBER_IMPLIED_KEYS,
  visibleProjectIds,
} from "./permission.rules.js";
export type {
  ExitKind,
  ProjectVisibilitySets,
  ExitPlan,
  FieldEntity,
  FieldPolicyRow,
  ProjectResourceContext,
  ProjectScopeFilter,
  ProjectScopeSpec,
} from "./permission.rules.js";
