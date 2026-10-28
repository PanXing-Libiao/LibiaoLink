import { Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { CadNameCodepage, CadJobCreateBody } from "@libiaolink/contracts";
import { createHash } from "node:crypto";
import { ObjectStorage } from "../../storage/index.js";
import { PermissionService } from "../permission/index.js";
import { FileRepository } from "./file.repository.js";
import { CadEngineClient } from "./cad-engine.client.js";
import { CadArchiveService } from "./cad-archive.service.js";
import { CadInputService, cadResourceFingerprint } from "./cad-inputs.js";

@Injectable()
export class CadPreviewService {
  private preparing = 0;
  private readonly submitting = new Map<string, ReturnType<CadEngineClient["submit"]>>();
  constructor(private readonly repository: FileRepository, private readonly permission: PermissionService,
    private readonly storage: ObjectStorage, private readonly engine: CadEngineClient,
    @Optional() private readonly archive?: CadArchiveService,
    private readonly inputs: CadInputService = new CadInputService(repository, permission, storage)) {}

  private async context(fileId: string, versionId: string, viewId: string, actorId: string, options: CadJobCreateBody = { companions: [] }) {
    const source = await this.inputs.resolve(fileId, versionId, actorId, options);
    const namespace = createHash("sha256").update(JSON.stringify([actorId, source.fileId, source.versionId, source.sourceSHA256, viewId])).digest("hex");
    const cacheScope = createHash("sha256").update(JSON.stringify([source.fileId, source.versionId, source.sourceSHA256, source.resourceSetHash])).digest("hex");
    return { source, namespace, cacheScope };
  }

  async create(fileId: string, versionId: string, viewId: string, actorId: string, nameCodepage: CadNameCodepage = "GB", options: CadJobCreateBody = { companions: [] }) {
    const context = await this.context(fileId, versionId, viewId, actorId, options);
    if (context.source.sourceFormat === "DXF" || context.source.sourceFormat === "DWG") nameCodepage = "UTF8";
    if (context.source.sourceFormat === "DWG" && !this.engine.dwgEnabled) {
      throw new ServiceUnavailableException("DWG 预览尚未启用，请下载原文件查看");
    }
    if (this.archive) {
      return this.archive.create(context.source, actorId, viewId, nameCodepage);
    }
    const key = context.namespace + ":" + nameCodepage;
    const pending = this.submitting.get(key);
    if (pending !== undefined) return pending;
    if (!this.engine.enabled) throw new ServiceUnavailableException("CAD 转换服务未启用，请下载原文件查看");
    if (context.source.companions.length || options.mainPath) throw new ServiceUnavailableException("配套文件需要启用 CAD 持久任务服务");
    if (context.source.sourceFormat === "DWG" && !this.archive) {
      throw new ServiceUnavailableException("DWG 需要启用 CAD 持久任务服务");
    }
    if (context.source.sourceBytes <= 0 || context.source.sourceBytes > this.engine.inputLimit) {
      throw new ServiceUnavailableException("文件超过当前 CAD 处理大小限制，请下载原文件查看");
    }
    const operation = this.submit(context, nameCodepage).finally(() => { this.submitting.delete(key); });
    this.submitting.set(key, operation);
    return operation;
  }

  private async submit(context: Awaited<ReturnType<CadPreviewService["context"]>>, nameCodepage: CadNameCodepage) {
    const source = context.source;
    const identity = { name: source.sourceName, sourceSHA256: source.sourceSHA256, sourceByteLength: source.sourceBytes,
      namespace: context.namespace, cacheScope: context.cacheScope, nameCodepage,
      ...(source.sourceFormat === "DXF" ? { resourceFingerprint: cadResourceFingerprint(source) } : {}) };
    // Permissions and current version were checked above; cached bytes never cache access rights.
    const cached = await this.engine.lookup(identity);
    if (cached !== null) return cached;
    if (this.preparing >= 2) throw new ServiceUnavailableException("CAD 文件读取繁忙，请稍后重试");
    this.preparing += 1;
    try {
      return await this.engine.submit({ bytes: await this.inputs.payload(source), ...identity });
    } finally { this.preparing -= 1; }
  }

  async job(action: "status" | "cancel", fileId: string, versionId: string, viewId: string, jobId: string, actorId: string) {
    const context = await this.context(fileId, versionId, viewId, actorId);
    if (this.archive) return this.archive.job(action, context.source, actorId, viewId, jobId);
    const { namespace } = context;
    return this.engine[action]({ namespace, jobId });
  }
  async resource(action: "manifest" | "buffer", fileId: string, versionId: string, viewId: string, jobId: string,
    actorId: string, lease?: string, sha256?: string) {
    const context = await this.context(fileId, versionId, viewId, actorId);
    if (this.archive) return this.archive.resource(action, context.source, actorId, viewId, jobId, lease, sha256);
    const { namespace } = context;
    return this.engine.file(action, { namespace, jobId, lease, sha256 });
  }
  async release(fileId: string, versionId: string, viewId: string, jobId: string, lease: string, actorId: string) {
    const context = await this.context(fileId, versionId, viewId, actorId);
    if (this.archive) return this.archive.release(context.source, actorId, viewId, jobId, lease);
    const { namespace } = context;
    await this.engine.release({ namespace, jobId, lease });
    return { released: true };
  }

}
