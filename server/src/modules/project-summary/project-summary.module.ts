import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { FileModule } from "../file/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ProjectModule } from "../project/index.js";
import { ReportIssueModule } from "../report-issue/index.js";
import { TaskModule } from "../task/index.js";
import { ProjectSummaryAiService } from "./project-summary.ai.js";
import { ProjectSummaryController } from "./project-summary.controller.js";
import { ProjectSummaryRepository } from "./project-summary.repository.js";
import { ProjectSummaryService } from "./project-summary.service.js";

/**
 * 项目总结（领域）：只读聚合 project / task / report-issue / file / 变更，
 * 通过脚本规则生成事实包，再由 AI 或规则模板生成叙述。依赖方向只向领域与平台 file 出口。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule, ProjectModule, TaskModule, ReportIssueModule, FileModule],
  controllers: [ProjectSummaryController],
  providers: [ProjectSummaryRepository, ProjectSummaryAiService, ProjectSummaryService],
  exports: [ProjectSummaryService],
})
export class ProjectSummaryModule {}
