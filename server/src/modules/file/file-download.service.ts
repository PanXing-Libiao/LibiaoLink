import { Injectable } from "@nestjs/common";
import { FileDownloadUrlResponseSchema, z } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { contentDisposition, ObjectStorage, versionFileName } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import { OCTET_STREAM_MIME } from "./file-mime.js";
import { FileRepository } from "./file.repository.js";

type FileDownloadUrlResponse = z.infer<typeof FileDownloadUrlResponseSchema>;

/**
 * 下载读 API（M4-05f 下载切片 · `GET /files/{id}/versions/{versionId}/download-url` · 契约 shared/src/modules/files.ts）。
 *
 * 与预览读 API（`PreviewReadService`）的分工：
 * - **签名语义**：下载**传 `fileName`** → 签名 `Content-Disposition: attachment`（浏览器落到本地文件）；
 *   预览不传 → 内联渲染。同一个对象键，两种投递形态。
 * - **签名窗口**：下载取 `S3_DOWNLOAD_URL_TTL_SECONDS`（对象存储端口的分片 / 下载两个默认窗口之一）；
 *   预览另有 `PREVIEW_URL_TTL_SECONDS`（两者独立配置）。
 * - **权限**：预览 = 「项目可见即可」（Push 160 定案）；下载 = 可见之上再判 **`file.download`** 权限点
 *   （A4-10「离线下载受权限控制并记日志」）—— 缺权限 403（不可见仍是 404，防 IDOR）。
 * - **审计**：`action = download`（A4-10 / C7），`object_type = file`，metadata 记 `versionId`；
 *   与预览同口径**先签名后审计** —— 地址没签发成功就不算一次「下载」。一次下载一条，不写 preview 行。
 *
 * 版本口径（A4-06）：`versionId` 是**必填路径参数**（下载不像预览那样缺省当前版本 —— 前端始终从版本链 / 详情
 * 拿到明确版本），任意历史版本可下载；不属于该文件 / 不存在 → 404（与读面同形，不泄漏文件是否存在）。
 */
@Injectable()
export class FileDownloadService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FileRepository,
    private readonly storage: ObjectStorage,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /** `GET /files/{id}/versions/{versionId}/download-url`：可见性 → 下载权限 → 版本 → 签名 → 审计。 */
  async getDownloadUrl(fileId: string, versionId: string, actorId: string): Promise<FileDownloadUrlResponse> {
    const file = await this.repository.findFileById(fileId);
    if (file === null) {
      throw new AppError("NOT_FOUND", "文件不存在");
    }
    const access = await this.permission.assertProjectVisible(actorId, file.projectId);
    // 记录级 404 之后才判功能权限 403：不可见资源不因缺权限而暴露存在性（ADR-011 不变量 3）。
    await this.permission.assertCan(
      actorId,
      "file.download",
      { member: access.member, projectManager: access.projectManager },
      "无权限下载文件（file.download）",
    );
    const version = await this.repository.findVersionById(file.id, versionId);
    if (version === null) {
      throw new AppError("NOT_FOUND", "版本不存在或不属于该文件");
    }
    // Push 256：下载文件名按**该版本**对象键的扩展名（变更更名 / 改名后，历史版本仍以正确扩展名落盘 ——
    // 与预览通道判定同口径 versionFileName）；主名取当前文件名。
    const downloadName = versionFileName(file.name, version.objectKey);
    const signed = await this.storage.signDownloadUrl({
      objectKey: version.objectKey,
      responseContentType: OCTET_STREAM_MIME,
      responseContentDisposition: contentDisposition(downloadName),
      expiresInSeconds: this.config.env.S3_DOWNLOAD_URL_TTL_SECONDS,
    });
    await this.audit.record(this.database.db, {
      actorId,
      action: "download",
      objectType: "file",
      objectId: file.id,
      projectId: file.projectId,
      summary: "下载文件：" + file.name + "（版本 v" + version.seq + "）",
      metadata: { versionId: version.id },
    });
    return {
      url: signed.url,
      fileName: downloadName,
      sizeBytes: version.sizeBytes,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }
}
