import { Body, Controller, Get, Headers, Logger, Param, Post, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { createReadStream } from "node:fs";
import type { Response } from "express";
import {
  PageExportRequestSchema,
  UuidSchema,
  type PageExportCatalogResponse,
  type PageExportRequest,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { CurrentProjectAccess, ProjectAccessGuard, RequirePermission, type ProjectAccessContext } from "../permission/index.js";
import type { ProjectExportFormat } from "./project-export.archive.js";
import {
  ProjectExportService,
  type PageExportResult,
  type ProjectExportResult,
} from "./project-export.service.js";
import { normalizeHttpOrigin } from "./project-export.workbook.js";

const uuidParam = new ZodValidationPipe(UuidSchema);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_MIME = "application/zip";
const EXPORT_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

export function projectExportFormat(value: string | undefined): ProjectExportFormat {
  if (value === undefined || value === "" || value === "xlsx") return "xlsx";
  if (value === "zip") return "zip";
  throw new AppError("VALIDATION_FAILED", "format 仅支持 xlsx 或 zip");
}

export function requestOriginCandidate(requestedOrigin: string | undefined, origin: string | undefined, referer: string | undefined, forwardedProto: string | undefined, host: string | undefined): string {
  // 前端显式回传站点 origin，优先于可能被同源 GET 省略的 Origin / 代理改写后的 Host。
  for (const candidate of [requestedOrigin, origin, referer]) {
    const normalized = normalizeHttpOrigin(candidate);
    if (normalized !== null) return normalized;
  }
  const protocol = (forwardedProto?.split(",")[0] ?? "http").trim() || "http";
  const fallback = host === undefined || host.trim() === "" ? "" : protocol + "://" + host;
  return normalizeHttpOrigin(fallback) ?? "";
}

export function contentDispositionFor(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).split("\u0027").join("%27");
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8" + "\u0027\u0027" + encoded;
}

type ExportResult = ProjectExportResult | PageExportResult;

/** 项目数据导出（project.export）：旧接口导出全部项目数据；页面级接口只导出勾选页面与列。 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectExportController {
  private readonly logger = new Logger(ProjectExportController.name);

  constructor(private readonly exporter: ProjectExportService) {}

  @Get(":id/export")
  @RequirePermission("project.export")
  async export(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @Query("format") requestedFormat: string | undefined,
    @Query("origin") requestedOrigin: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("referer") referer: string | undefined,
    @Headers("x-forwarded-proto") forwardedProto: string | undefined,
    @Headers("host") host: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const format = projectExportFormat(requestedFormat);
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new AppError("INTERNAL", "项目导出超时，请稍后重试")),
      EXPORT_GENERATION_TIMEOUT_MS,
    );
    timer.unref();
    const abortOnDisconnect = (): void => {
      if (!response.writableEnded) abort.abort(new AppError("INTERNAL", "项目导出已取消"));
    };
    response.once("close", abortOnDisconnect);
    let result: ProjectExportResult;
    try {
      result = await this.exporter.exportProject(
        id,
        actorId,
        requestOriginCandidate(requestedOrigin, origin, referer, forwardedProto, host),
        abort.signal,
        format,
      );
    } finally {
      clearTimeout(timer);
      response.off("close", abortOnDisconnect);
    }
    return this.sendResult(result, response, format);
  }

  @Get(":id/page-exports/catalog")
  @RequirePermission("project.export")
  async pageExportCatalog(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
  ): Promise<PageExportCatalogResponse> {
    return this.exporter.pageExportCatalog(id, actorId, access);
  }

  @Post(":id/page-exports")
  @RequirePermission("project.export")
  async exportPages(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @CurrentProjectAccess() access: ProjectAccessContext,
    @Body(new ZodValidationPipe(PageExportRequestSchema)) body: PageExportRequest,
    @Headers("origin") origin: string | undefined,
    @Headers("referer") referer: string | undefined,
    @Headers("x-forwarded-proto") forwardedProto: string | undefined,
    @Headers("host") host: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new AppError("INTERNAL", "项目导出超时，请稍后重试")),
      EXPORT_GENERATION_TIMEOUT_MS,
    );
    timer.unref();
    const abortOnDisconnect = (): void => {
      if (!response.writableEnded) abort.abort(new AppError("INTERNAL", "项目导出已取消"));
    };
    response.once("close", abortOnDisconnect);
    let result: PageExportResult;
    try {
      result = await this.exporter.exportPages(
        id,
        actorId,
        requestOriginCandidate(body.origin, origin, referer, forwardedProto, host),
        body.sheets,
        access,
        abort.signal,
      );
    } finally {
      clearTimeout(timer);
      response.off("close", abortOnDisconnect);
    }
    return this.sendResult(result, response, "xlsx");
  }

  private sendResult(result: ExportResult, response: Response, format: ProjectExportFormat = "xlsx"): StreamableFile {
    response.setHeader("Content-Type", format === "zip" ? ZIP_MIME : XLSX_MIME);
    response.setHeader("Content-Disposition", contentDispositionFor(result.fileName));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (result.kind === "buffer") {
      response.setHeader("Content-Length", String(result.buffer.length));
      return new StreamableFile(result.buffer);
    }
    response.setHeader("Content-Length", String(result.sizeBytes));
    const cleanup = (): void => {
      void result.cleanup().catch((error: unknown) => this.logger.warn("项目导出临时文件清理失败：" + String(error)));
    };
    response.once("finish", cleanup);
    response.once("close", cleanup);
    if (response.destroyed) cleanup();
    return new StreamableFile(createReadStream(result.filePath), { length: result.sizeBytes });
  }
}
