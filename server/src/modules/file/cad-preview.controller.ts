import { Controller, Delete, Get, Inject, Param, Post, Query, Req, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { CadNameCodepageSchema, UuidSchema, z, type CadNameCodepage } from "@libiaolink/contracts";
import { createGzip } from "node:zlib";
import type { Request, Response } from "express";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { CadPreviewService } from "./cad-preview.service.js";

const uuid = new ZodValidationPipe(UuidSchema);
const view = new ZodValidationPipe(z.string().regex(/^[a-f0-9]{32}$/));
const leaseParam = new ZodValidationPipe(z.string().regex(/^[a-f0-9]{48}$/));
const hashParam = new ZodValidationPipe(z.string().regex(/^[a-f0-9]{64}$/));

@Controller("api/v1/files/:fileId/versions/:versionId/cad/views/:viewId/jobs")
@UseGuards(SessionGuard, CsrfGuard)
export class CadPreviewController {
  constructor(@Inject(CadPreviewService) private readonly cad: CadPreviewService) {}

  @Post()
  async create(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @CurrentActorId() actorId: string,
    @Query("nameCodepage", new ZodValidationPipe(CadNameCodepageSchema.default("GB"))) nameCodepage: CadNameCodepage,
    @Res({ passthrough: true }) response: Response) {
    let disconnected = false;
    let created: Awaited<ReturnType<CadPreviewService["create"]>> | undefined;
    const cancel = () => this.cad.job("cancel", fileId, versionId, viewId, created!.job.id, actorId).catch(() => {});
    // A window may close while the source is being read, before it knows its jobId.
    response.once("close", () => {
      if (response.writableFinished) return;
      disconnected = true;
      if (created !== undefined) void cancel();
    });
    created = await this.cad.create(fileId, versionId, viewId, actorId, nameCodepage);
    if (disconnected) await cancel();
    return created;
  }

  @Get(":jobId")
  status(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @Param("jobId", view) jobId: string, @CurrentActorId() actorId: string) {
    return this.cad.job("status", fileId, versionId, viewId, jobId, actorId);
  }

  @Post(":jobId/cancel")
  cancel(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @Param("jobId", view) jobId: string, @CurrentActorId() actorId: string) {
    return this.cad.job("cancel", fileId, versionId, viewId, jobId, actorId);
  }

  @Get(":jobId/manifest")
  async manifest(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @Param("jobId", view) jobId: string, @CurrentActorId() actorId: string,
    @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const file = await this.cad.resource("manifest", fileId, versionId, viewId, jobId, actorId);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Accept-Encoding");
    response.setHeader("X-CAD-Artifact-Bytes", String(file.artifactBytes ?? file.bytes));
    const source = file.stream;
    const gzip = (request.headers["accept-encoding"] ?? "").split(",").some((item) => /^\s*gzip\s*(;|$)/i.test(item) && !/;\s*q=0(?:\.0*)?\s*$/i.test(item));
    response.once("close", () => source.destroy());
    if (gzip) {
      response.setHeader("Content-Encoding", "gzip");
      const encoded = createGzip(); source.on("error", (error) => encoded.destroy(error));
      return new StreamableFile(source.pipe(encoded));
    }
    response.setHeader("Content-Length", String(file.bytes));
    return new StreamableFile(source);
  }

  @Get(":jobId/resources/:lease/:sha256")
  async buffer(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @Param("jobId", view) jobId: string, @Param("lease", leaseParam) lease: string,
    @Param("sha256", hashParam) sha256: string, @CurrentActorId() actorId: string,
    @Res({ passthrough: true }) response: Response) {
    const file = await this.cad.resource("buffer", fileId, versionId, viewId, jobId, actorId, lease, sha256);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const source = file.stream;
    response.once("close", () => source.destroy());
    return new StreamableFile(source, { type: "application/octet-stream", length: file.bytes });
  }

  @Delete(":jobId/resources/:lease")
  release(@Param("fileId", uuid) fileId: string, @Param("versionId", uuid) versionId: string,
    @Param("viewId", view) viewId: string, @Param("jobId", view) jobId: string, @Param("lease", leaseParam) lease: string,
    @CurrentActorId() actorId: string) {
    return this.cad.release(fileId, versionId, viewId, jobId, lease, actorId);
  }
}
