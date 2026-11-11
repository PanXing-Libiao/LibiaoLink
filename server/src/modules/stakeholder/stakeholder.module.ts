import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { StakeholderController } from "./stakeholder.controller.js";
import { StakeholderRepository } from "./stakeholder.repository.js";
import { StakeholderService } from "./stakeholder.service.js";

/**
 * stakeholder 模块（领域 · j6 · S8·stakeholder · A5）：干系人台账（A5-01 / A5-02）、单项目归属（A5-03 收敛）、
 * 销售录入端口（A5-04，权限来自角色与数据范围）、隐私字段权限（A5-07，h6 字段策略表出口）。
 * 依赖：identity（会话 / CSRF / 当前用户）、permission（stakeholder.* 判定 + 字段级策略 + 项目可见集）、admin（审计留痕，同事务）。
 * 边界：本模块不写项目主数据（归属只写 project_stakeholders 关系表，每条记录只归属一个项目）；导出（A5-09）与批量导入（A5-05）由 lan 线作业接入，
 * 接入时复用 permission.planExit(actor, exit, "stakeholder") 取同源字段集（C3-08）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule],
  controllers: [StakeholderController],
  providers: [StakeholderRepository, StakeholderService],
  exports: [StakeholderService],
})
export class StakeholderModule {}
