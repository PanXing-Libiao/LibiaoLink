import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  FileArchiveRequestSchema,
  FileArchiveResponseSchema,
  FileListQuerySchema,
  FileListResponseSchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard } from "../permission/index.js";
import { FileArchiveService } from "./file-archive.service.js";
import { FileService } from "./file.service.js";

type FileListQuery = z.infer<typeof FileListQuerySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 项目文件库接口（M4-03 · A4-01 / A4-09）：契约 shared/src/modules/files.ts 的 `GET /projects/{id}/files`。
 *
 * 记录级可见性由 ProjectAccessGuard 处理（路径 `:id` 非成员 / 不存在 → 404，防 IDOR）；读 = 项目可见即可。
 * `file_links` 双向跳转：任务 / 节点 / 日报 / 问题 / 变更侧的「查文件」走本列表的 filter（读写链路见 FileService）。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class FileLibraryController {
  constructor(
    private readonly files: FileService,
    private readonly archives: FileArchiveService,
  ) {}

  /** 文件库列表：状态 / 类型 / 节点 / 任务 / 上传人筛选 + 文件名关键字 + 白名单排序 + 分页。 */
  @Get(":id/files")
  list(
    @Param("id", uuidParam) id: string,
    @Query(new ZodValidationPipe(FileListQuerySchema)) query: FileListQuery,
  ): Promise<z.infer<typeof FileListResponseSchema>> {
    return this.files.listProjectFiles(id, query);
  }

  /** 批量打包下载：单批最多 50 个版本，服务端生成临时 ZIP 后返回单次短时签名地址。 */
  @Post(":id/files/download-archive")
  @HttpCode(200)
  async downloadArchive(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(FileArchiveRequestSchema)) body: z.infer<typeof FileArchiveRequestSchema>,
    @CurrentActorId() actorId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.infer<typeof FileArchiveResponseSchema>> {
    const abort = new AbortController();
    const abortOnDisconnect = (): void => {
      if (!response.writableEnded) abort.abort(new AppError("INTERNAL", "文件打包已取消"));
    };
    response.once("close", abortOnDisconnect);
    if (response.destroyed) abortOnDisconnect();
    try {
      return await this.archives.createArchive(id, body, actorId, abort.signal);
    } finally {
      response.off("close", abortOnDisconnect);
    }
  }
}
