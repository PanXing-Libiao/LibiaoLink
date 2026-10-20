import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { CalendarModule } from "../calendar/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ProjectModule } from "../project/index.js";
import { NotifyModule } from "../notify/index.js";
import { IssueRepository } from "./issue.repository.js";
import { IssueService } from "./issue.service.js";
import { IssueController, ReportController } from "./report-issue.controller.js";
import { ReportRepository } from "./report.repository.js";
import { ReportService } from "./report.service.js";
import { ReportSummaryService } from "./report-summary.service.js";

/**
 * report-issue 模块（领域 · M6）：日报（M6-01 / M6-02）与问题闭环（M6-02 / M6-03）。
 * 口径：同人同项目同日可多条 + 草稿写库 / 提交 / 补填（A3-01 ~ A3-04）；提交自动生成问题（A3-09 幂等）与问题图转挂（file_links kind）；
 * 问题三态允许回退且留痕（A3-10 / A3-13）；A3-08 回写停用、处理时限（A3-14 / ADR-026）删除 —— 均随 Push 215。
 * 当日汇总与应填未填（A7-01 / A7-05）经 report-summary.service 出口。
 * 依赖：identity / permission / admin（本模块基础）+ calendar（工作日判定，横切）+ project（项目名册出口，A7-05 应填范围）
 * + notify（发送归档只读，A01 已提醒标记 · M5-06-3）；
 * 不反向依赖 task / node 等其它领域模块（shanghaiToday 一侧为 task 纯规则出口，无 DI 依赖）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule, CalendarModule, ProjectModule, NotifyModule],
  controllers: [ReportController, IssueController],
  providers: [ReportRepository, IssueRepository, ReportService, IssueService, ReportSummaryService],
  exports: [ReportService, IssueService, ReportSummaryService],
})
export class ReportIssueModule {}

