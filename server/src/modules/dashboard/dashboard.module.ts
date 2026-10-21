import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardRepository } from "./dashboard.repository.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * dashboard 模块（平台 · B4 / M7-02）：跨项目统计读面。
 * 只读 tasks / projects / issues / change_requests / users；可见性经 permission.projectScope；
 * 明细下钻不归本模块，由前端按项目复用既有领域接口。
 */
@Module({
  imports: [IdentityModule, PermissionModule],
  controllers: [DashboardController],
  providers: [DashboardRepository, DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
