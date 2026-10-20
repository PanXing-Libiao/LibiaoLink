import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { CalendarModule } from "../calendar/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { JobsStore } from "../../db/jobs.store.js";
import { AutomationController } from "./automation.controller.js";
import { AutomationRuleRepository, AutomationRunRepository } from "./automation.repository.js";
import { AutomationService } from "./automation.service.js";

export interface AutomationModuleOptions {
  /** 试运行主体读取实现（生产 = outbox 的 AutomationSubjectReader；单测 / 回放可替换）。 */
  trialSubjects: Provider;
}

/**
 * automation 模块的 HTTP 面（M5-06-1B）：规则管理 / 试运行 / 运行记录。
 * 引擎纯函数与 repository 仍可从 index.ts 独立复用；本模块只装配 api 进程所需的控制器与用例。
 * 依赖：identity（会话 / CSRF）、permission（automation.view / manage）、audit（同事务留痕）、
 * calendar（业务日 / 顺延设置 / ClockService）。试运行主体端口由入口注入，避免平台模块反依赖业务模块。
 */
@Module({})
export class AutomationModule {
  static forRoot(options: AutomationModuleOptions): DynamicModule {
    return {
      module: AutomationModule,
      imports: [IdentityModule, PermissionModule, AuditModule, CalendarModule],
      controllers: [AutomationController],
      providers: [
        AutomationRuleRepository,
        AutomationRunRepository,
        JobsStore,
        AutomationService,
        options.trialSubjects,
      ],
      exports: [AutomationService, AutomationRuleRepository, AutomationRunRepository],
    };
  }
}
