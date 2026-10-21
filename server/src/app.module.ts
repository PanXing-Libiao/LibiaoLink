import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ResourceChangeInterceptor } from "./common/realtime/resource-change.js";
import { AUDIT_SINK } from "./common/audit/audit-sink.js";
import { ApiErrorFilter } from "./common/errors/api-error.filter.js";
import { createLoggerModule } from "./common/logging/logger.module.js";
import { AppConfigModule } from "./config/config.module.js";
import type { Env } from "./config/env.js";
import { DatabaseModule } from "./db/db.module.js";
import { HealthModule } from "./health/health.module.js";
import { AdminModule, AuditService } from "./modules/admin/index.js";
import { AutomationModule } from "./modules/automation/automation.module.js";
import { AUTOMATION_TRIAL_SUBJECTS } from "./modules/automation/automation.service.js";
import { CalendarModule } from "./modules/calendar/index.js";
import { DashboardModule } from "./modules/dashboard/index.js";
import { FileModule } from "./modules/file/index.js";
import { IdentityModule } from "./modules/identity/index.js";
import { NotifyModule } from "./modules/notify/index.js";
import { PermissionModule } from "./modules/permission/index.js";
import { ProjectModule } from "./modules/project/index.js";
import { ProjectImportModule } from "./modules/project-import/index.js";
import { ReportIssueModule } from "./modules/report-issue/index.js";
import { StakeholderModule } from "./modules/stakeholder/index.js";
import { TaskModule } from "./modules/task/index.js";
import { TemplateModule } from "./modules/template/index.js";
import { WorkspaceModule } from "./modules/workspace/index.js";
import { ViewModule } from "./modules/view/index.js";
import { TranslateModule } from "./modules/translate/index.js";
import { FollowModule } from "./modules/follow/index.js";
import { StorageModule } from "./storage/index.js";
import { AutomationSubjectReader } from "./outbox/automation-subjects.js";

/** api 进程：HTTP 入口（无状态、不跑 CPU 密集任务）。 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        createLoggerModule(env),
        AppConfigModule.forRoot(env),
        DatabaseModule,
        StorageModule,
        HealthModule,
        IdentityModule,
        PermissionModule,
        ProjectModule,
        ProjectImportModule,
        StakeholderModule,
        TaskModule,
        TemplateModule,
        WorkspaceModule,
        DashboardModule,
        ViewModule,
        FollowModule,
        TranslateModule,
        ReportIssueModule,
        AdminModule,
        CalendarModule,
        FileModule,
        NotifyModule,
        AutomationModule.forRoot({
          trialSubjects: { provide: AUTOMATION_TRIAL_SUBJECTS, useClass: AutomationSubjectReader },
        }),
      ],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: ResourceChangeInterceptor },
        { provide: APP_FILTER, useClass: ApiErrorFilter },
        // 越权留痕出口：全局异常过滤器经 common 令牌调用 admin 的 AuditService（避免 common → modules 反向依赖）
        { provide: AUDIT_SINK, useExisting: AuditService },
      ],
    };
  }
}
