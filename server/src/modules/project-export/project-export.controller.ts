import { Controller, Get, Headers, Param, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { UuidSchema } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { ProjectExportService } from "./project-export.service.js";
import { normalizeHttpOrigin } from "./project-export.workbook.js";

const uuidParam = new ZodValidationPipe(UuidSchema);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

/** 项目数据导出（project.export）：一次生成 4 个 Sheet 的 xlsx；文件链接指向项目详情「项目文件」视图。 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectExportController {
  constructor(private readonly exporter: ProjectExportService) {}

  @Get(":id/export")
  @RequirePermission("project.export")
  async export(
    @Param("id", uuidParam) id: string,
    @CurrentActorId() actorId: string,
    @Query("origin") requestedOrigin: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Headers("referer") referer: string | undefined,
    @Headers("x-forwarded-proto") forwardedProto: string | undefined,
    @Headers("host") host: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const result = await this.exporter.exportProject(id, actorId, requestOriginCandidate(requestedOrigin, origin, referer, forwardedProto, host));
    response.setHeader("Content-Type", XLSX_MIME);
    response.setHeader("Content-Disposition", contentDispositionFor(result.fileName));
    response.setHeader("Content-Length", String(result.buffer.length));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(result.buffer);
  }
}
