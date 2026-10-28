import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  FileDetailSchema,
  FileDownloadUrlResponseSchema,
  FileFinalizeBodySchema,
  FilePurgeBodySchema,
  FilePreviewQuerySchema,
  FilePreviewResponseSchema,
  FilePurgeResponseSchema,
  FileRecycleBodySchema,
  FileRenameBodySchema,
  FileRestoreBodySchema,
  FileRollbackBodySchema,
  FileRollbackResponseSchema,
  FileSchema,
  FileVersionListResponseSchema,
  UploadAbortResponseSchema,
  UploadCompleteBodySchema,
  UploadCompleteResponseSchema,
  UploadCreateBodySchema,
  UploadCreateResponseSchema,
  UploadPartsBodySchema,
  UploadPartsResponseSchema,
  UploadSessionViewSchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { FileDownloadService } from "./file-download.service.js";
import { FileService } from "./file.service.js";
import { PreviewReadService } from "./preview-read.service.js";

type UploadCreateBody = z.infer<typeof UploadCreateBodySchema>;
type UploadCreateResponse = z.infer<typeof UploadCreateResponseSchema>;
type UploadPartsBody = z.infer<typeof UploadPartsBodySchema>;
type UploadPartsResponse = z.infer<typeof UploadPartsResponseSchema>;
type UploadSessionView = z.infer<typeof UploadSessionViewSchema>;
type UploadCompleteBody = z.infer<typeof UploadCompleteBodySchema>;
type UploadCompleteResponse = z.infer<typeof UploadCompleteResponseSchema>;
type UploadAbortResponse = z.infer<typeof UploadAbortResponseSchema>;
type FileDetail = z.infer<typeof FileDetailSchema>;
type FileView = z.infer<typeof FileSchema>;
type FileVersionList = z.infer<typeof FileVersionListResponseSchema>;
type FileFinalizeBody = z.infer<typeof FileFinalizeBodySchema>;
type FileRollbackBody = z.infer<typeof FileRollbackBodySchema>;
type FileRollbackResponse = z.infer<typeof FileRollbackResponseSchema>;
type FileRecycleBody = z.infer<typeof FileRecycleBodySchema>;
type FileRenameBody = z.infer<typeof FileRenameBodySchema>;
type FileRestoreBody = z.infer<typeof FileRestoreBodySchema>;
type FilePurgeBody = z.infer<typeof FilePurgeBodySchema>;
type FilePurgeResponse = z.infer<typeof FilePurgeResponseSchema>;
type FilePreviewQuery = z.infer<typeof FilePreviewQuerySchema>;
type FilePreviewResponse = z.infer<typeof FilePreviewResponseSchema>;
type FileDownloadUrlResponse = z.infer<typeof FileDownloadUrlResponseSchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 文件接口（M4-01 上传管道 + M4-02 版本 / 定档 / 回溯 / 回收站）：契约 shared/src/modules/files.ts。
 *
 * 权限在服务层判定（`file.upload` 需项目上下文：成员平权；读取会话状态 = 项目可见即可），
 * 因此这里只用会话 + CSRF 守卫；记录级可见性（非成员 404）在 FileService 装载文件时按项目判定。
 * 变更写入（M4-04 · 申请即通过）随上传完成 / 定档后回溯生效；预览读 API（M4-05）三态 + 短时签名（缺省只取签名；用户点开且传 recordView=true 时才写一条 preview 审计）；
 * 下载读 API（M4-05f）短时签名（attachment）+ `file.download` 权限 + download 审计。
 */
@Controller("api/v1/files")
@UseGuards(SessionGuard, CsrfGuard)
export class FileController {
  constructor(
    private readonly files: FileService,
    private readonly previews: PreviewReadService,
    private readonly downloads: FileDownloadService,
  ) {}

  /** 发起上传（分片直传；返回文件、会话与秒传提示）。 */
  @Post("uploads")
  create(
    @Body(new ZodValidationPipe(UploadCreateBodySchema)) body: UploadCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<UploadCreateResponse> {
    return this.files.createUpload(body, actorId);
  }

  /** 批量取分片预签名 URL（首传 / 断点续传共用）。契约响应码 = 200。 */
  @Post(":id/uploads/:uploadId/parts")
  @HttpCode(200)
  parts(
    @Param("id", uuidParam) id: string,
    @Param("uploadId", uuidParam) uploadId: string,
    @Body(new ZodValidationPipe(UploadPartsBodySchema)) body: UploadPartsBody,
    @CurrentActorId() actorId: string,
  ): Promise<UploadPartsResponse> {
    return this.files.signParts(id, uploadId, body, actorId);
  }

  /** 上传会话状态（已传 / 缺失分片；断点续传依据）。 */
  @Get(":id/uploads/:uploadId")
  status(
    @Param("id", uuidParam) id: string,
    @Param("uploadId", uuidParam) uploadId: string,
    @CurrentActorId() actorId: string,
  ): Promise<UploadSessionView> {
    return this.files.getUpload(id, uploadId, actorId);
  }

  /** 完成上传：校验分片 → 合并 → 复制到契约键 → 登记版本（intent=change 时同事务生效变更，M4-04）。契约响应码 = 200。 */
  @Post(":id/uploads/:uploadId/complete")
  @HttpCode(200)
  complete(
    @Param("id", uuidParam) id: string,
    @Param("uploadId", uuidParam) uploadId: string,
    @Body(new ZodValidationPipe(UploadCompleteBodySchema)) body: UploadCompleteBody,
    @CurrentActorId() actorId: string,
  ): Promise<UploadCompleteResponse> {
    return this.files.completeUpload(id, uploadId, body, actorId);
  }

  /** 取消上传（幂等；已完成会话 409）。契约响应码 = 200。 */
  @Post(":id/uploads/:uploadId/abort")
  @HttpCode(200)
  abort(
    @Param("id", uuidParam) id: string,
    @Param("uploadId", uuidParam) uploadId: string,
    @CurrentActorId() actorId: string,
  ): Promise<UploadAbortResponse> {
    return this.files.abortUpload(id, uploadId, actorId);
  }

  /** 文件详情（含当前版本）。读取面 = 项目可见即可（不可见 404）。 */
  @Get(":id")
  detail(@Param("id", uuidParam) id: string, @CurrentActorId() actorId: string): Promise<FileDetail> {
    return this.files.getFile(id, actorId);
  }

  /** 版本链（按 seq 升序；历史版本只读）。 */
  @Get(":id/versions")
  versions(@Param("id", uuidParam) id: string, @CurrentActorId() actorId: string): Promise<FileVersionList> {
    return this.files.listFileVersions(id, actorId);
  }

  /**
   * 预览状态与短时签名地址（M4-05 读 API）：ready 附签名 URL；
   * not_ready 幂等补投生成任务；
   * failed 记原因并降级「请下载查看」；可选 `versionId` 指定历史版本（不属于该文件 / 不存在 → 404）。
   * 预览审计只在 `recordView=true` 时写入（用户点开具体预览）；缩略图签名请求缺省不写。
   */
  @Get(":id/preview")
  preview(
    @Param("id", uuidParam) id: string,
    @Query(new ZodValidationPipe(FilePreviewQuerySchema)) query: FilePreviewQuery,
    @CurrentActorId() actorId: string,
  ): Promise<FilePreviewResponse> {
    return this.previews.getPreview(id, query.versionId ?? null, actorId, query.recordView === "true");
  }

  /**
   * 版本短时签名下载（M4-05f 下载切片，A4-06 / A4-10）：签名地址为 attachment（原名回写 Content-Disposition）；
   * 写一条 `action = download` 审计；权限 = 项目可见（404）+ `file.download`（403）；`versionId` 须属于该文件（否则 404）。
   */
  @Get(":id/versions/:versionId/download-url")
  downloadUrl(
    @Param("id", uuidParam) id: string,
    @Param("versionId", uuidParam) versionId: string,
    @CurrentActorId() actorId: string,
  ): Promise<FileDownloadUrlResponse> {
    return this.downloads.getDownloadUrl(id, versionId, actorId);
  }

  /** 定档锁版（draft → final；乐观锁 version 不匹配 409）。契约响应码 = 200。 */
  @Post(":id/finalize")
  @HttpCode(200)
  finalize(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileFinalizeBodySchema)) body: FileFinalizeBody,
    @CurrentActorId() actorId: string,
  ): Promise<FileView> {
    return this.files.finalizeFile(id, body, actorId);
  }

  /** 回溯生成新版本（不删历史；定档后走变更流，随 M4-04）。契约响应码 = 200。 */
  @Post(":id/rollback")
  @HttpCode(200)
  rollback(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileRollbackBodySchema)) body: FileRollbackBody,
    @CurrentActorId() actorId: string,
  ): Promise<FileRollbackResponse> {
    return this.files.rollbackFile(id, body, actorId);
  }

  /** 移入回收站（任意状态可删；保留 30 天可恢复）。契约响应码 = 200。 */
  @Post(":id/recycle")
  @HttpCode(200)
  recycle(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileRecycleBodySchema)) body: FileRecycleBody,
    @CurrentActorId() actorId: string,
  ): Promise<FileView> {
    return this.files.recycleFile(id, body, actorId);
  }

  /** 文件改名（Push 226 续 · 文件名可修改）：只改元数据名称，乐观锁 version 必传；回收站文件 409。契约响应码 = 200。 */
  @Patch(":id")
  @HttpCode(200)
  rename(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileRenameBodySchema)) body: FileRenameBody,
    @CurrentActorId() actorId: string,
  ): Promise<FileView> {
    return this.files.renameFile(id, body, actorId);
  }

  /** 从回收站恢复（回到进入前状态）。契约响应码 = 200。 */
  @Post(":id/restore")
  @HttpCode(200)
  restore(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileRestoreBodySchema)) body: FileRestoreBody,
    @CurrentActorId() actorId: string,
  ): Promise<FileView> {
    return this.files.restoreFile(id, body, actorId);
  }

  /** 彻底删除（仅管理员；仅回收站中的文件）。契约响应码 = 200 / 403。 */
  @Post(":id/purge")
  @HttpCode(200)
  purge(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FilePurgeBodySchema)) body: FilePurgeBody,
    @CurrentActorId() actorId: string,
  ): Promise<FilePurgeResponse> {
    return this.files.purgeFile(id, body, actorId);
  }
}
