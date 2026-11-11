import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { BlueprintController } from "./blueprint.controller.js";
import { BlueprintRepository } from "./blueprint.repository.js";
import { BlueprintService } from "./blueprint.service.js";

/** blueprint 模块（领域 · h3）：蓝图按项目类型版本化（ADR-019）、校验、导出 / 导入、建项目快照来源。
 * 依赖：identity（会话 / CSRF 守卫）、permission（蓝图写权限：仅系统管理员）、admin（AuditService 留痕，同事务 —— Push 173）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule],
  controllers: [BlueprintController],
  providers: [BlueprintRepository, BlueprintService],
  exports: [BlueprintService],
})
export class BlueprintModule {}
