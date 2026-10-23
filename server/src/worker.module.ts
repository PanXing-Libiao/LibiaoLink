import { Module, type DynamicModule } from "@nestjs/common";
import { createLoggerModule } from "./common/logging/logger.module.js";
import { AppConfigModule } from "./config/config.module.js";
import type { Env } from "./config/env.js";
import { DatabaseModule } from "./db/db.module.js";
import { FileModule } from "./modules/file/index.js";
import { IdentityModule } from "./modules/identity/index.js";
import { ProjectModule } from "./modules/project/index.js";
import { ProjectImportModule } from "./modules/project-import/index.js";
import { NotifyModule } from "./modules/notify/index.js";
import { OutboxModule } from "./outbox/index.js";
import { StorageModule } from "./storage/index.js";

/**
 * worker 进程：Outbox 投递 / 调度 / 规则执行 / 转换编排 / 导出 / 导入表导入过期票据清理。
 * 已接入：Casdoor 组织目录自动同步（启动即同步 + 周期轮询）、上传会话过期清理（M4-01）、文件 / 项目回收站到期清理（M4-02 / 项目 30 天）、导入表导入过期票据清理（Push 325 · 风险⑤）、Outbox 运行时（S7-1：dispatcher 领取 + 消费 +
 * 重试退避 + dead 告警 + 积压探针 + done 行保留期清理，见 entry/worker.ts 的轮询循环；消费侧当前只有
 * `preview.job`，通用事件消费随 i11 / M5 接入）。调度器（cron / 窗口 / 补发）与规则编排随后续卡片接入。
 */
@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        createLoggerModule(env),
        AppConfigModule.forRoot(env),
        DatabaseModule,
        StorageModule,
        IdentityModule,
        FileModule,
        ProjectModule,
        ProjectImportModule,
        NotifyModule,
        OutboxModule.forRoot(env),
      ],
    };
  }
}
