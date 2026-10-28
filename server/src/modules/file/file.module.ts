import { Module } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { CadEngineClient } from "./cad-engine.client.js";
import { CadPreviewService } from "./cad-preview.service.js";
import { CadPreviewController } from "./cad-preview.controller.js";
import { CadArchiveRepository } from "./cad-archive.repository.js";
import { CadArchiveService } from "./cad-archive.service.js";
import { CadArchiveWorker } from "./cad-archive.worker.js";
import { AdminModule } from "../admin/index.js";
import { IdentityModule } from "../identity/index.js";
import { PermissionModule } from "../permission/index.js";
import { ChangeRequestController } from "./change.controller.js";
import { ChangeRequestLibraryController } from "./change-library.controller.js";
import { ChangeService } from "./change.service.js";
import { FileController } from "./file.controller.js";
import { FileDownloadService } from "./file-download.service.js";
import { FileLibraryController } from "./file-library.controller.js";
import { FileRepository } from "./file.repository.js";
import { FileService } from "./file.service.js";
import { PreviewContentController } from "./preview-content.controller.js";
import { PreviewContentService } from "./preview-content.service.js";
import { PreviewConverter } from "./preview.converter.js";
import { PreviewReadService } from "./preview-read.service.js";
import { PreviewRepository } from "./preview.repository.js";
import { PreviewService } from "./preview.service.js";

/**
 * file 模块（平台 · S7·file · M4）：文件与版本、上传管道、定档锁版、变更（申请即通过）、回收站。
 * 依赖：identity（会话 / CSRF 守卫）、permission（file.upload / file.download 判定出口）、admin（AuditService 同事务留痕）、
 * storage（ObjectStorage 端口，@Global，经端口调用不直接碰 S3 SDK）。
 * 已落：M4-01 上传管道、M4-02 版本 / 定档 / 回溯 / 回收站、M4-03 文件库查询 + 多态关联（file_links）、
 * M4-04 变更写入 + 读面（变更记录列表 / 详情）、M4-05 预览（数据层 + 转换队列：outbox `preview.job`
 * 消费 / 转换器客户端 / 三元组幂等 / 失败降级；领取与重试 / dead 回写自 S7-1 起归 worker 的 OutboxDispatcher）+ 读 API（三态 + 短时签名 + 仅用户显式查看的 ready 写审计）+ 产物清理（彻底删除 / 到期清理按 content_hash 反查引用：有引用归属转移、无引用清对象）+ 下载切片（版本短时签名 —— attachment + file.download 权限 + download 审计）。
 * S3（ADR-030）起：Office / 文本族预览改由 ONLYOFFICE 查看器承接（`PreviewReadService` 签发只读查看器配置、不再投递转换任务）+
 * 受控预览内容端点（`/preview-content`：服务间 Bearer 自验 / fail-closed —— `PreviewContentController` + `PreviewContentService`）。
 */
@Module({
  imports: [IdentityModule, PermissionModule, AdminModule],
  controllers: [
    CadPreviewController,
    FileController,
    FileLibraryController,
    ChangeRequestLibraryController,
    ChangeRequestController,
    PreviewContentController,
  ],
  providers: [
    CadEngineClient,
    CadArchiveRepository,
    CadArchiveService,
    CadArchiveWorker,
    CadPreviewService,
    FileRepository,
    FileService,
    ChangeService,
    ClockService,
    // M4-05c 预览转换队列：只做「消费与分类」（S7-1 起领取 / 重试 / dead 回写由 worker 的 OutboxDispatcher 统一负责）。
    PreviewRepository,
    PreviewConverter,
    PreviewService,
    // M4-05 读 API：api 侧三态 + 短时签名（缩略图不写审计；用户显式查看且 ready 才写；worker 侧队列见 PreviewService）。
    PreviewReadService,
    // S3 受控预览内容端点：服务间 Bearer 自验 + fail-closed + 字节流直写（安全定稿 §3.2 / §3.3）。
    PreviewContentService,
    // M4-05f 下载切片：版本短时签名（attachment）+ file.download 权限 + download 审计。
    FileDownloadService,
  ],
  exports: [FileService, ChangeService, PreviewService, CadArchiveWorker],
})
export class FileModule {}
