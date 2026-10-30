import { Injectable } from "@nestjs/common";
import { PERMISSION_KEYS } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { type DataScope } from "./data-scope.js";
import { RoleRepository, type RoleRow } from "./role.repository.js";

/**
 * 授权画像：部门权限模型的全量能力基线。
 * h6 策略服务（can / buildScopeWhere / fieldPolicy / exportPolicy）以本画像为唯一输入；
 * 旧角色表只保留为历史维护数据，不参与业务授权判定。
 */
export interface ActorAuthorization {
  userId: string;
  /** 遗留字段；固定为空，不参与任何授权或管理员判定。 */
  roleCodes: string[];
  /** 固定为 ["all"]；实际项目范围由部门规则再次收窄。 */
  dataScopes: DataScope[];
  /** 全量功能权限位基线；写能力由部门规则的编辑 / 仅浏览档位再裁决。 */
  permissionKeys: string[];
}

/**
 * 2026-10-26 部门权限收口：旧角色权限不再参与业务授权判定。
 * 画像固定为全量功能权限位 + dataScope=all，最终项目范围、编辑 / 仅浏览与资源可见性由部门规则裁决。
 * `roleCodes` 保留为空数组仅为契约兼容；系统管理员统一由部门权限画像判定，角色表 / 绑定数据不迁移、不删除。
 */
export function fullCapabilityAuthorization(userId: string): ActorAuthorization {
  return {
    userId,
    roleCodes: [],
    dataScopes: ["all"],
    permissionKeys: [...PERMISSION_KEYS],
  };
}

/** 角色用例（h1）：角色列表、授权画像、用户 ↔ 角色绑定；不新开 HTTP 端点（管理界面随 C3-09 / u12）。 */
@Injectable()
export class RoleService {
  constructor(private readonly roles: RoleRepository) {}

  /** 一期六个内置角色（种子维护）。 */
  listRoles(): Promise<RoleRow[]> {
    return this.roles.list();
  }

  /**
   * 授权基线：旧角色权限不再参与裁定，统一返回部门权限模型所需的全量能力画像。
   * 数据范围与部门规则在 PermissionService 中另行收窄。
   */
  async getActorAuthorization(userId: string): Promise<ActorAuthorization> {
    return fullCapabilityAuthorization(userId);
  }

  /** 授予角色（幂等）；未知角色码 → 404（与「不存在与无权统一 404」一致，ADR-011）。 */
  async assignRole(userId: string, roleCode: string): Promise<RoleRow> {
    const role = await this.requireRole(roleCode);
    await this.roles.assign(userId, role.id);
    return role;
  }

  /** 撤销角色（幂等）；返回撤销前是否存在绑定。 */
  async revokeRole(userId: string, roleCode: string): Promise<boolean> {
    const role = await this.requireRole(roleCode);
    return this.roles.revoke(userId, role.id);
  }

  private async requireRole(roleCode: string): Promise<RoleRow> {
    const role = await this.roles.findByCode(roleCode);
    if (role === null) {
      throw new AppError("NOT_FOUND", "角色不存在：" + roleCode);
    }
    return role;
  }
}
