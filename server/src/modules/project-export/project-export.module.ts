import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { FileModule } from "../file/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ProjectModule } from "../project/index.js";
import { ReportIssueModule } from "../report-issue/index.js";
import { StakeholderModule } from "../stakeholder/index.js";
import { TaskModule } from "../task/index.js";
import { ProjectExportController } from "./project-export.controller.js";
import { ProjectExportService } from "./project-export.service.js";

/**
 * 项目数据导出（领域模块）：只读聚合 project / task / report-issue / file / stakeholder，
 * 在内存中生成 4 Sheet xlsx。依赖方向 = 领域 → 领域 + 平台 file；file 不反向依赖本模块。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule, ProjectModule, TaskModule, ReportIssueModule, StakeholderModule, FileModule],
  controllers: [ProjectExportController],
  providers: [ProjectExportService],
  exports: [ProjectExportService],
})
export class ProjectExportModule {}
