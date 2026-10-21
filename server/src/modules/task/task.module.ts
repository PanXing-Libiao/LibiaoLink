import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { TemplateModule } from "../template/index.js";
import { TranslateModule } from "../translate/index.js";
import { TaskController } from "./task.controller.js";
import { TaskGateRepository } from "./task.gate.repository.js";
import { TaskRepository } from "./task.repository.js";
import { TaskService } from "./task.service.js";
import { TaskStatsService } from "./task.stats.js";

/**
 * task 模块（领域 · h4）：任务主数据（M3-01 列表 / 详情）、进度与状态（M3-02）、完成门禁（M3-03）、项目总览四格；
 * 统计出口（TaskStatsService）供 node 门禁复用；不依赖 project / node，避免循环（project → node → task）。
 * M3-07 刀 3 起依赖 template（节点库 / 模板）：从节点库生成任务与模板实例化（POST /tasks/from-template）都读节点库现值。
 * Push 301 起依赖 translate（横切）：写入成功后的手打中文（标题 / 备注）丢给译文库后台预热（保存即翻译落库）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule, TemplateModule, TranslateModule],
  controllers: [TaskController],
  providers: [TaskRepository, TaskGateRepository, TaskService, TaskStatsService],
  exports: [TaskService, TaskStatsService],
})
export class TaskModule {}
