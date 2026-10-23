import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { IdentityModule } from "../identity/index.js";
import { GroupAccessController } from "./group-access.controller.js";
import { GroupAccessGuard, GroupAccessAdminGuard } from "./group-access.guard.js";
import { GroupAccessService } from "./group-access.service.js";
import { PermissionController } from "./permission.controller.js";
import { PermissionRepository } from "./permission.repository.js";
import { PermissionService } from "./permission.service.js";
import { ProjectAccessGuard } from "./project-access.guard.js";

/**
 * permission 模块（领域 · h6 · PoC-6）：ADR-011 策略服务落地形态 ——
 * can（功能权限）/ 记录级可见集 / 字段级策略与五出口投影统一出口；依赖 identity（角色画像），
 * 不依赖 project / task（可见性判定直接读 project_members / project_nodes，避免循环）。
 */
@Module({
  imports: [IdentityModule, AuditModule],
  controllers: [PermissionController, GroupAccessController],
  providers: [
    PermissionRepository,
    PermissionService,
    ProjectAccessGuard,
    GroupAccessGuard,
    GroupAccessAdminGuard,
    GroupAccessService,
  ],
  exports: [PermissionService, ProjectAccessGuard, GroupAccessGuard, GroupAccessAdminGuard],
})
export class PermissionModule {}
