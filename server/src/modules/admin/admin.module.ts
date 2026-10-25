import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { AuditLogsController } from "./audit.controller.js";
import { DictRepository } from "./dict.repository.js";
import { DictService } from "./dict.service.js";
import { DictsController } from "./dicts.controller.js";

/**
 * admin 模块（平台 · h7 · S6·admin）：字典（C9）；操作审计（C7）的控制器仍在此，写入 / 检索出口随 Push 173 在 audit 模块。
 * 依赖：identity（会话 / CSRF 守卫）、permission（字典维护与操作记录范围的统一判定出口）、audit（AuditService）。
 * 边界：平台模块不反依赖业务模块 —— 业务模块反向 import 本模块 re-export 或 audit 模块注入留痕；
 * 越权留痕经 common 的 AUDIT_SINK 令牌由全局异常过滤器调用（common 不依赖 modules）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AuditModule],
  controllers: [DictsController, AuditLogsController],
  providers: [DictRepository, DictService],
  exports: [AuditModule],
})
export class AdminModule {}
