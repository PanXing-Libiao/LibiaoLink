
import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ProjectModule } from "../project/index.js";
import { TemplateModule } from "../template/index.js";
import { TranslateModule } from "../translate/index.js";
import { ProjectImportController } from "./project-import.controller.js";
import { ProjectImportManualController } from "./project-import-manual.controller.js";
import { ProjectImportRepository } from "./project-import.repository.js";
import { ProjectImportService } from "./project-import.service.js";

/**
 * project-import 模块（领域 · 导入表导入 · 业务口径 2026-10-14）：项目空间「导入项目」按钮的服务端落点 ——
 * preview（解析预览票据）+ commit（单事务建项目写入全量数据），契约 shared/src/modules/imports.ts。
 * 依赖：identity（会话 / CSRF）、permission（project.create）、project（项目插入 / 蓝图快照 / 成员名册）、
 * template（任务节点库补库）、admin（审计留痕）、translate（项目名后台翻译预热）；对象存储走全局 ObjectStorage 端口。
 * 模块内四层：controller（HTTP / multipart）→ service（口径编排）→ repository（票据 + 批量写入）；
 * 解析层与存储层平级（xlsx.ts 零依赖 zip 读 / legacy.ts 导入表转换 / people.ts 人员注册表）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule, ProjectModule, TemplateModule, TranslateModule],
  controllers: [ProjectImportController, ProjectImportManualController],
  providers: [ProjectImportRepository, ProjectImportService],
  exports: [ProjectImportService, ProjectImportRepository],
})
export class ProjectImportModule {}
