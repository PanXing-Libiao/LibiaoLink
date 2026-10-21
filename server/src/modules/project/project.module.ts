import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/index.js";
import { BlueprintModule } from "../blueprint/index.js";
import { IdentityModule } from "../identity/index.js";
import { NodeModule } from "../node/index.js";
import { PermissionModule } from "../permission/index.js";
import { TranslateModule } from "../translate/index.js";
import { ArchiveController } from "./archive.controller.js";
import { ArchiveRepository } from "./archive.repository.js";
import { ArchiveService } from "./archive.service.js";
import { FlowController } from "./flow.controller.js";
import { FlowRepository } from "./flow.repository.js";
import { FlowService } from "./flow.service.js";
import { NodesController } from "./nodes.controller.js";
import { ProjectsController } from "./project.controller.js";
import { ProjectGroupRepository } from "./project-group.repository.js";
import { ProjectGroupService } from "./project-group.service.js";
import { ProjectMemberRepository } from "./project-member.repository.js";
import { ProjectMemberService } from "./project-member.service.js";
import { ProjectRepository } from "./project.repository.js";
import { ProjectService } from "./project.service.js";

/**
 * project 模块（领域 · h2 / h3）：项目主数据 CRUD（M2-01）、列表 / facets（M2-04）、成员名册（M2-05）、
 * 流程实例与导入快照（M2-02）、节点增删与完成门禁（v0.2 §3.6）、阶段推进 / 回退（M2-03）、
 * 项目群绑定读写（M5-03-2 接线段 · C2-05）。
 * 归档：门禁 + 引用式清单 + 冻结状态位（M7-04 · ADR-027）。
 * 依赖方向：project → { blueprint, node(GateService), identity, permission(策略守卫), translate(横切) }（node 不反依赖 project，避免循环）。
 * Push 301 起依赖 translate：项目写入成功后的手打中文（项目名 / 描述 / 客户）丢给译文库后台预热（保存即翻译落库）。
 */
@Module({
  imports: [IdentityModule, BlueprintModule, NodeModule, PermissionModule, AdminModule, TranslateModule],
  controllers: [ProjectsController, FlowController, NodesController, ArchiveController],
  providers: [
    ProjectRepository,
    ProjectService,
    ProjectMemberRepository,
    ProjectMemberService,
    ProjectGroupRepository,
    ProjectGroupService,
    FlowRepository,
    FlowService,
    ArchiveRepository,
    ArchiveService,
  ],
  // Push 316：project-import（导入表导入）复用项目插入 / 成员名册写口 —— 两个仓库随本模块导出（同事务建项目 + upsert 项目经理）。
  exports: [ProjectService, ProjectMemberService, ProjectRepository, ProjectMemberRepository, FlowService],
})
export class ProjectModule {}
