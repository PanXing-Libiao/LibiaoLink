import { Module } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { NotifyModule } from "../notify/index.js";
import { PermissionModule } from "../permission/index.js";
import { ProjectModule } from "../project/index.js";
import { ReportIssueModule } from "../report-issue/index.js";
import { ReportQueryService } from "./report-query.service.js";

/** 仅 worker 装配：查询编排不拥有业务表，也不承载任何领域写操作。 */
@Module({
  imports: [PermissionModule, ProjectModule, ReportIssueModule, NotifyModule],
  providers: [ReportQueryService, ClockService],
  exports: [ReportQueryService],
})
export class ReportQueryModule {}
