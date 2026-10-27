import { PERMISSION_KEYS, type PermissionKey } from "@libiaolink/contracts";
import type { ActorAuthorization, DataScope } from "../identity/index.js";

/**
 * 权限策略（ADR-011 落地形态 · h6 · PoC-6）：本文件是**纯函数**策略层，不碰数据库，
 * 供五类出口统一调用（字段级 / 记录级 / 导出 / 搜索 / 通知），也是 CI 权限矩阵用例的主对象。
 * 数据面（全量能力基线、名册、项目可见集）由 permission.service + permission.repository 提供。
 */

// ---------- 记录级：数据范围 → 项目可见集规格 ----------

/** 项目可见性规格：由授权画像的数据范围解出（记录级）。 */
export interface ProjectScopeSpec {
  /** data_scope = all：全量（管理员），不做裁剪。 */
  all: boolean;
  /** data_scope = managed_projects：含「我管理的项目」（projects.manager_id 或名册 project_manager）。 */
  managed: boolean;
  /** data_scope = involved_projects（以及无角色 / 仅未落地范围时的名册兜底）：名册任意角色可见。 */
  member: boolean;
}

/**
 * 未落地的数据范围（登记差异）：own_stakeholders 依赖干系人表（j6 · S8·stakeholder）、
 * granted 依赖临时授权（C3-06）。两者落地前不贡献可见集。
 */
export const PENDING_DATA_SCOPES: readonly DataScope[] = ["own_stakeholders", "granted"];

/** 无项目级数据范围（无角色，或只持有未落地范围）：按记录级名册兜底，避免「有角色反而看得更少」。 */
function onlyPendingScopes(scopes: readonly DataScope[]): boolean {
  return scopes.length === 0 || scopes.every((scope) => PENDING_DATA_SCOPES.includes(scope));
}

/**
 * 数据范围 → 可见集规格（v0.2 §4.1）：
 * all → 全量；managed_projects → 我管理的；involved_projects → 我参与的（名册任意角色）；
 * own_stakeholders / granted → 未落地（仅兜底名册）。无角色时按名册兜底。
 */
export function projectScopeSpec(authorization: ActorAuthorization): ProjectScopeSpec {
  const scopes = authorization.dataScopes;
  return {
    all: scopes.includes("all"),
    managed: scopes.includes("managed_projects"),
    member: scopes.includes("involved_projects") || onlyPendingScopes(scopes),
  };
}

/** 渲染后的过滤条件：all = 不裁剪；ids = 只允许这些项目（空数组 = 无可见项目）。 */
export type ProjectScopeFilter = { kind: "all" } | { kind: "ids"; ids: string[] };

/** 记录级判定输入：三种关系命中的项目 id 集合（由数据层取回）。 */
export interface ProjectVisibilitySets {
  /** 名册任意角色（我参与的项目）。 */
  memberIds: readonly string[];
  /** 我作为主数据责任人（projects.manager_ids 含我；A22 多位，任一位命中）—— 建项目事务不写名册，故恒可见。 */
  ownedIds: readonly string[];
  /** 名册里我是 project_manager（managed_projects 数据范围）。 */
  managedRosterIds: readonly string[];
}

/**
 * 记录级可见项目 id 并集（列表 / 详情同一谓词，禁止两套口径）：
 * 名册成员（member） ∪ 主数据责任人（恒可见） ∪ managed_projects 下的名册项目经理。
 */
export function visibleProjectIds(spec: ProjectScopeSpec, sets: ProjectVisibilitySets): string[] {
  const ids = new Set<string>();
  if (spec.member) for (const id of sets.memberIds) ids.add(id);
  for (const id of sets.ownedIds) ids.add(id);
  if (spec.managed) for (const id of sets.managedRosterIds) ids.add(id);
  return [...ids];
}

/** 单项目可见性谓词（与 visibleProjectIds 同源）。 */
export function isProjectVisible(
  spec: ProjectScopeSpec,
  context: { rosterMember: boolean; managerOfRecord: boolean; rosterProjectManager: boolean },
): boolean {
  if (spec.all) return true;
  return context.managerOfRecord || (spec.member && context.rosterMember) || (spec.managed && context.rosterProjectManager);
}

// ---------- 功能权限：can ----------

/** 项目内上下文：记录级解析结果（名册角色 + 项目主数据），can 的项目级来源。 */
export interface ProjectResourceContext {
  member: boolean;
  projectManager: boolean;
  /** 当前项目的部门权限；项目内写操作必须为 edit。 */
  groupAccessLevel?: "edit" | "view";
}

/**
 * 项目内角色隐含的权限位（ADR-011 §4.3 平权例外 + ADR-020 / ADR-023 既有口径）：
 * 名册成员在其项目内即可读、可改任务进度、可完成节点（节点操作一期平权）、可填日报与处理问题（A3 与 §4.1）。
 */
export const PROJECT_MEMBER_IMPLIED_KEYS: readonly PermissionKey[] = [
  "project.view",
  "member.view",
  "task.view",
  "task.create",
  "task.update",
  "task.progress",
  "report.view",
  "report.fill",
  "issue.view",
  "issue.manage",
  "node.view",
  "node.complete",
  "file.upload",
  "file.download",
  "stakeholder.view",
];

/** 项目内项目经理隐含的权限位：成员全部 + 项目维护 / 名册 / 节点增删 / 阶段推进回退（ADR-020 / ADR-023）。 */
export const PROJECT_MANAGER_IMPLIED_KEYS: readonly PermissionKey[] = [
  ...PROJECT_MEMBER_IMPLIED_KEYS,
  "project.update",
  "project.delete",
  "project.archive",
  "member.manage",
  "node.create",
  "node.delete",
  "node.advance",
  "node.rollback",
  "stakeholder.manage",
  "stakeholder.contact.view",
];

/**
 * 任务定档 / 取消定档的唯一角色口径（2026-10-27）：仅任务当前负责人或项目经理。
 * 项目经理来自 ProjectAccessContext（主数据 managerIds 或项目名册 project_manager）；
 * 该规则同时供任务接口与文件定档联动任务定档的旁路复用，避免两套判定漂移。
 */
export function canManageTaskFinalization(
  actorId: string,
  taskOwnerIds: readonly string[],
  projectManager: boolean,
): boolean {
  return projectManager || taskOwnerIds.includes(actorId);
}

/** 策略层用到的全部权限键必须落在契约枚举内（防手写错字；用例覆盖）。 */
export function isKnownPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

/**
 * 权限判定（ADR-011）：三个来源取并集 ——
 * 1) 全量功能权限基线（旧角色权限已退出授权，写能力由部门规则再裁决）；
 * 2) 项目内角色隐含位（项目经理 / 成员，仅在该项目内生效）；
 * 3) 无需权限的读路径（不经过本函数，如 /auth/me）。
 * 无权访问**已有资源**返回 403；不可见资源一律 404（防 IDOR，由记录级负责）。
 */
export function can(authorization: ActorAuthorization, key: PermissionKey, context?: ProjectResourceContext): boolean {
  if (authorization.permissionKeys.includes(key)) return true;
  if (context?.projectManager === true && PROJECT_MANAGER_IMPLIED_KEYS.includes(key)) return true;
  if (context?.member === true && PROJECT_MEMBER_IMPLIED_KEYS.includes(key)) return true;
  return false;
}

// ---------- 字段级：字段策略表 ----------

export const FIELD_ENTITIES = ["stakeholder", "user"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

/** 字段策略行：登记「受字段级权限保护的字段」。未登记的字段不受约束（前向兼容）。 */
export interface FieldPolicyRow {
  entity: FieldEntity;
  field: string;
  /** 可见所需权限键；缺省 = 无需额外权限（登录即可见）。 */
  requires?: PermissionKey;
  /** 口径依据（评审追溯用）。 */
  basis: string;
}

/**
 * 字段策略表（表驱动 · ADR-011）：无权限字段**不返回**（不做前端打码，C3-08）。
 * 位形打码（masked 档）与「只读」档留待干系人卡片（j6）与权限管理界面（C3-09）定稿后启用。
 */
export const FIELD_POLICIES: readonly FieldPolicyRow[] = [
  { entity: "stakeholder", field: "phone", requires: "stakeholder.contact.view", basis: "A5-07 / C3-04：联系方式（电话）" },
  { entity: "stakeholder", field: "wechat", requires: "stakeholder.contact.view", basis: "A5-07 / C3-04：联系方式（微信）" },
  { entity: "stakeholder", field: "email", requires: "stakeholder.contact.view", basis: "A5-07 / C3-04：联系方式（邮箱）" },
  { entity: "stakeholder", field: "company", requires: "stakeholder.view", basis: "C3-04：商务字段（公司）" },
  { entity: "stakeholder", field: "title", requires: "stakeholder.view", basis: "C3-04：商务字段（职务）" },
  { entity: "stakeholder", field: "remark", requires: "stakeholder.manage", basis: "C3-04：商务字段（备注仅维护者可见）" },
  { entity: "user", field: "email", basis: "员工通讯录邮箱一期全员可见；商务字段类目随 C3-09 收敛" },
];

/** 实体字段全集：出口投影的输入（与各模块契约字段对齐；落地时以契约为准）。 */
export const ENTITY_FIELDS: Record<FieldEntity, readonly string[]> = {
  stakeholder: ["name", "company", "title", "phone", "wechat", "email", "remark", "role"],
  user: ["username", "displayName", "email", "status"],
};

/** 单个字段是否可返回（未登记 = 可返回）。 */
export function canSeeField(authorization: ActorAuthorization, entity: FieldEntity, field: string): boolean {
  const row = FIELD_POLICIES.find((policy) => policy.entity === entity && policy.field === field);
  if (row === undefined) return true;
  return row.requires === undefined || can(authorization, row.requires);
}

/** 该实体在当前画像下可返回的字段（五出口同源）。 */
export function visibleFields(authorization: ActorAuthorization, entity: FieldEntity): string[] {
  return ENTITY_FIELDS[entity].filter((field) => canSeeField(authorization, entity, field));
}

/** 该实体在当前画像下被裁掉的字段。 */
export function hiddenFields(authorization: ActorAuthorization, entity: FieldEntity): string[] {
  return ENTITY_FIELDS[entity].filter((field) => !canSeeField(authorization, entity, field));
}

/** 行投影：删掉无权字段（服务端裁剪，不返回 null 占位）。 */
export function projectFields<T extends Record<string, unknown>>(
  authorization: ActorAuthorization,
  entity: FieldEntity,
  row: T,
): Partial<T> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (canSeeField(authorization, entity, key)) projected[key] = value;
  }
  return projected as Partial<T>;
}

// ---------- 五出口：导出 / 搜索 / 通知与页面同源 ----------

export const EXIT_KINDS = ["page", "export", "search", "notify"] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

/** 出口级附加权限：导出单独授权并审计（C3-05 / C3-08）；页面 / 搜索 / 通知随可见性与字段策略放行。 */
export const EXIT_REQUIRED_PERMISSION: Partial<Record<ExitKind, PermissionKey>> = {
  export: "project.export",
};

export interface ExitPlan {
  exit: ExitKind;
  entity: FieldEntity;
  /** 出口是否放行（导出无权 = false，调用方转 403 并建议留痕）。 */
  allowed: boolean;
  /** 该出口可投影 / 可检索 / 可入消息内容的字段。 */
  fields: string[];
  /** 被策略裁掉的字段：导出、搜索、消息内容一律不得出现（C3-08）。 */
  hidden: string[];
}

export function planExit(authorization: ActorAuthorization, exit: ExitKind, entity: FieldEntity): ExitPlan {
  const required = EXIT_REQUIRED_PERMISSION[exit];
  return {
    exit,
    entity,
    allowed: required === undefined || can(authorization, required),
    fields: visibleFields(authorization, entity),
    hidden: hiddenFields(authorization, entity),
  };
}

/** 该实体下全部出口的投影必须一致（五出口一致性不变量 · ADR-011 / C3-08）。 */
export function exitsConsistent(authorization: ActorAuthorization, entity: FieldEntity): boolean {
  const first = visibleFields(authorization, entity).join(",");
  return EXIT_KINDS.every((exit) => planExit(authorization, exit, entity).fields.join(",") === first);
}
