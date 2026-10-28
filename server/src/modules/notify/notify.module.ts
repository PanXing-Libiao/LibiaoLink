import { Module } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { AuditModule } from "../audit/index.js";
import { PermissionModule } from "../permission/index.js";
import { IdentityModule } from "../identity/index.js";
import { NotifyAppRepository } from "./notify.app.repository.js";
import { NotifyAppService } from "./notify.app.service.js";
import { NotifyDmRepository } from "./notify.dm.repository.js";
import { NotifyDmService } from "./notify.dm.service.js";
import { NotifyGroupRepository } from "./notify.group.repository.js";
import { NotifyGroupService } from "./notify.group.service.js";
import { ProjectGroupDeliveryAlertService } from "./project-group-delivery-alert.service.js";
import { NotifyController } from "./notify.controller.js";
import { NotifyDeliveryArchiveRepository } from "./notify.delivery-archive.repository.js";
import { NotifyDeliveryReadRepository } from "./notify.delivery-read.repository.js";
import { NotifyDeliveryService } from "./notify.delivery.service.js";
import { NotifyRepository } from "./notify.repository.js";
import { NotifyService } from "./notify.service.js";
import { NotifyStreamPublisher } from "./notify.stream.publisher.js";
import { NotifyStreamService } from "./notify.stream.service.js";
import { ResourceChangePublisher } from "./resource-change.publisher.js";
import { WecomDmBindingController } from "./wecom-dm-binding.controller.js";
import { RESOURCE_CHANGE_SINK } from "../../common/realtime/resource-change.js";
import { createWecomAibotClientFromEnv, WecomAibotClient } from "./wecom.aibot.js";
import { createWecomClientFromEnv, WecomClient } from "./wecom.client.js";
import { PgRateWindowStore } from "./wecom.rate.pg.js";

/**
 * notify 模块（平台 · S7-4 · j1 / M5-04 首刀）：站内信投递内核 —— outbox `notify.message` 消费 +
 * 合并（同人同时段）+ 免打扰（次日补发）+ 每人每日上限 + 收件箱读面 + 全量留档 + 通知偏好。
 * 依赖：identity（会话 / CSRF / 当前用户）+ audit（**仅**单聊绑定解绑留痕 —— D6）—— 个人资源不做功能权限位；
 * 收件箱 / 通知偏好仍不写审计（先例 user_preferences / project_views）。
 * 装配：api 侧挂控制器（AppModule）；worker 侧经 OutboxModule 的消费注册表 + entry/worker.ts 的 flush 循环。
 * 实时流（S8-3 · M5-04-1）：`NotifyStreamService` 惰性 LISTEN（首个 SSE 连接建立才启动 —— worker 不建连接 → 不启动）；
 * `NotifyStreamPublisher` 供投递 / 标记在事务内 pg_notify（worker 写方同样生效，api 各实例桥到本地连接）。
 * 群通道（M5-03-2 接线段）：`NotifyGroupService` 消费 `notify.group`（worker 注册表）+ 回调 ingest；
 * `WecomAibotClient` 由工厂装配（api 侧构造不建连；worker 侧入口显式 `start()`）。
 * 应用消息（M5-03-3）：`NotifyAppService` 消费 `notify.message` 的 channel=wecom_app 分支（OutboxModule 路由）；
 * `WecomClient`（自建应用）由工厂装配，限速计数同走 `PgRateWindowStore`。
 * 单聊 aibot（M5-03-5-3 实现段）：`NotifyDmService` 消费 `notify.message` 的 channel=wecom_aibot 分支
 * （发送面 = 长连接 `sendUserMarkdown` · 限速 kind `single` · 绑定行寻址 / 激活表读 · 846607 分流 + C5-04 降级；
 * 生产路由 / 产出接线 / worker 回调分流随 M5-03-5-4 —— 见执行计划 §4）。
 * 单聊绑定码链路（M5-03-5-6 实现刀 · 迁移 0055）：`NotifyDmService` 扩 `requestBindingCode`（取码）/
 * `ingestCallback`（单聊发码 → 同事务写绑定 + 标记码已用 → 会话内回执）/ `getBindingState`（绑定态读）/
 * `setMessagesEnabled`（企微单聊消息开关）/ `unbind`（解绑 + 同事务写审计 —— D6）；HTTP 面 = `WecomDmBindingController`（契约刀 Push 249 ·
 * `/api/v1/wecom-dm-binding`：GET 绑定态 / PATCH 消息开关 / POST codes 取码 / DELETE 解绑 —— 个人资源，读 = 会话、写 = 会话 + CSRF）。
 * audit 依赖为平台 → 平台（`check:boundaries` 规则允许非领域模块互引）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AuditModule],
  controllers: [NotifyController, WecomDmBindingController],
  providers: [
    NotifyRepository,
    NotifyDeliveryArchiveRepository,
    NotifyDeliveryReadRepository,
    NotifyDeliveryService,
    NotifyService,
    NotifyStreamPublisher,
    NotifyStreamService,
    ResourceChangePublisher,
    { provide: RESOURCE_CHANGE_SINK, useExisting: ResourceChangePublisher },
    NotifyGroupRepository,
    NotifyGroupService,
    ProjectGroupDeliveryAlertService,
    NotifyAppRepository,
    NotifyAppService,
    NotifyDmRepository,
    NotifyDmService,
    PgRateWindowStore,
    {
      // 群通道长连接客户端（M5-03-2 接线段）：构造不建连（start() 由 worker 启动流程显式调用）；
      // 限速计数 = PgRateWindowStore（DB 计数，跨进程共享配额 —— 差异登记①收口）。
      provide: WecomAibotClient,
      useFactory: (config: AppConfig, database: DatabaseService) =>
        createWecomAibotClientFromEnv(config.env, { store: new PgRateWindowStore(database) }).aibot,
      inject: [AppConfig, DatabaseService],
    },
    {
      // 自建应用消息客户端（M5-03-3）：token 单飞缓存 + app 限速桶；构造无副作用（无后台任务）。
      provide: WecomClient,
      useFactory: (config: AppConfig, database: DatabaseService) =>
        createWecomClientFromEnv(config.env, { store: new PgRateWindowStore(database) }).client,
      inject: [AppConfig, DatabaseService],
    },
    ClockService,
  ],
  exports: [
    NotifyService,
    NotifyDeliveryService,
    NotifyDeliveryReadRepository,
    NotifyGroupService,
    ProjectGroupDeliveryAlertService,
    NotifyAppService,
    NotifyDmService,
    WecomAibotClient,
    WecomClient,
    RESOURCE_CHANGE_SINK,
  ],
})
export class NotifyModule {}
