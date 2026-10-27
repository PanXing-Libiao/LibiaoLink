import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { CadNameCodepage } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { DbClient } from "../../db/db-client.js";
import { ObjectStorage } from "../../storage/index.js";
import { CadEngineClient, type CadJob, type CadResource } from "./cad-engine.client.js";
import { CadArchiveRepository, type CadArchiveSource, type CadArtifactRow, type CadViewRow } from "./cad-archive.repository.js";
import { checkedCadStream } from "./cad-archive.integrity.js";
import { CadInputService, cadInputs, CAD_DXF_INPUT_BYTES } from "./cad-inputs.js";

@Injectable()
export class CadArchiveService {
  constructor(private readonly repository: CadArchiveRepository, private readonly storage: ObjectStorage,
    private readonly engine: CadEngineClient, private readonly inputs: CadInputService) {}

  async uploaded(source: CadArchiveSource, client?: DbClient): Promise<void> {
    if (!this.engine.enabled || !/\.(step|stp|dxf)$/i.test(source.sourceName)
      || source.sourceBytes > Math.min(this.engine.inputLimit, /\.dxf$/i.test(source.sourceName) ? 64 * 1024 ** 2 : Infinity)) return;
    await this.repository.request(source, "GB", client);
  }

  async create(source: CadArchiveSource, actorId: string, viewId: string, codepage: CadNameCodepage) {
    const input = cadInputs(source);
    if (input.sourceFormat === "DXF") codepage = "UTF8";
    await this.inputs.assertAvailable(input, actorId);
    if (!this.engine.enabled) throw new ServiceUnavailableException("CAD 转换服务未启用，请下载原文件查看");
    const totalBytes = input.sourceBytes + input.companions.reduce((sum, row) => sum + row.sourceBytes, 0);
    const limitBytes = input.sourceFormat === "DXF" ? Math.min(this.engine.inputLimit, CAD_DXF_INPUT_BYTES) : this.engine.inputLimit;
    if (input.sourceBytes <= 0 || totalBytes > limitBytes) {
      await this.repository.rejectInput(input, actorId, viewId, codepage, limitBytes, totalBytes);
      throw new ServiceUnavailableException("文件超过当前 CAD 处理大小限制，请下载原文件查看");
    }
    const artifact = await this.repository.request(input, codepage);
    if (["failed", "timed-out"].includes(artifact.state)) await this.repository.retry(artifact.id, artifact.state);
    const view = await this.repository.openView(artifact.id, actorId, viewId);
    const current = await this.repository.view(view.id.replaceAll("-", ""), source, actorId, viewId);
    if (!current) throw new AppError("NOT_FOUND", "模型任务不存在或不可访问");
    return { job: this.public(current.artifact, current.view), reused: ["completed", "partial"].includes(artifact.state) };
  }

  async job(action: "status" | "cancel", source: CadArchiveSource, actorId: string, viewId: string, jobId: string): Promise<CadJob> {
    const bound = await this.bound(source, actorId, viewId, jobId);
    if (action === "cancel") {
      await this.repository.cancelView(bound.view.id);
      bound.view.cancelled = true;
    }
    return this.public(bound.artifact, bound.view);
  }

  async resource(action: "manifest" | "buffer", source: CadArchiveSource, actorId: string, viewId: string,
    jobId: string, lease?: string, sha256?: string): Promise<CadResource> {
    const { artifact, view } = await this.bound(source, actorId, viewId, jobId);
    if (view.cancelled || !["completed", "partial"].includes(artifact.state) || !artifact.objectPrefix || !artifact.manifestSHA256 || !artifact.manifestBytes) {
      throw new ServiceUnavailableException("模型尚未就绪或当前窗口已取消，请重新打开");
    }
    const buffer = action === "buffer" ? artifact.buffers?.find((item) => item.sha256 === sha256) : undefined;
    if (action === "buffer" && (!buffer || lease !== artifact.resourceLease || !view.leaseExpiresAt || view.leaseExpiresAt <= new Date())) {
      throw new AppError("NOT_FOUND", "模型资源不存在或不可访问");
    }
    const objectKey = buffer?.objectKey ?? artifact.objectPrefix + "manifest.json";
    const bytes = buffer?.byteLength ?? artifact.manifestBytes;
    const digest = buffer?.sha256 ?? artifact.manifestSHA256;
    if (!objectKey.startsWith(artifact.objectPrefix)) throw new AppError("NOT_FOUND", "模型资源不存在或不可访问");
    if (action === "manifest") await this.repository.lease(view.id);
    const object = await this.storage.getObjectStream(objectKey).catch(() => {
      throw new ServiceUnavailableException("模型资源暂时无法读取，请稍后重试");
    });
    const invalidate = () => { void this.repository.retry(artifact.id, artifact.state, artifact.objectPrefix).catch(() => {}); };
    if (!object || object.sizeBytes !== bytes) {
      object?.stream.destroy(); invalidate();
      throw new ServiceUnavailableException("模型缓存缺失或损坏，已排队重新生成，请重新打开");
    }
    return { stream: checkedCadStream(object.stream, bytes, digest, invalidate), bytes, artifactBytes: artifact.artifactBytes };
  }

  async release(source: CadArchiveSource, actorId: string, viewId: string, jobId: string, lease: string) {
    const { artifact, view } = await this.bound(source, actorId, viewId, jobId);
    if (lease !== artifact.resourceLease) throw new AppError("NOT_FOUND", "模型资源不存在或不可访问");
    await this.repository.lease(view.id, true);
    return { released: true };
  }

  async purge(fileId: string, projectId: string, client?: DbClient): Promise<void> {
    const prefixes = await this.repository.purgeInputs(fileId, client);
    for (const prefix of prefixes) await this.storage.purgePrefix(prefix);
    await this.storage.purgePrefix(`projects/${projectId}/files/${fileId}/cad/`);
  }

  private async bound(source: CadArchiveSource, actorId: string, viewId: string, jobId: string) {
    const result = await this.repository.view(jobId, source, actorId, viewId);
    if (!result) throw new AppError("NOT_FOUND", "模型任务不存在或不可访问");
    await this.inputs.assertAvailable(result.artifact, actorId);
    return result;
  }

  private public(row: CadArtifactRow, view: CadViewRow): CadJob {
    const state = view.cancelled ? "cancelled" : row.state as CadJob["state"];
    return { id: view.id.replaceAll("-", ""), state, format: row.sourceFormat, phase: view.cancelled ? "cancelled" : row.phase,
      sourceSHA256: row.sourceSHA256, sourceByteLength: row.sourceBytes, nameCodepage: row.nameCodepage as CadNameCodepage,
      createdAt: row.createdAt.getTime() / 1000, updatedAt: row.updatedAt.getTime() / 1000,
      ...(["completed", "partial"].includes(row.state) ? { artifactBytes: row.artifactBytes } : {}),
      ...(row.error && state === "failed" ? { error: { code: row.errorCode ?? "conversion-failed", error: row.error } } : {}) };
  }
}
