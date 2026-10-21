import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { CadNameCodepage } from "@libiaolink/contracts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError } from "../../common/errors/app-error.js";
import { ObjectStorage, versionFileName } from "../../storage/index.js";
import { PermissionService } from "../permission/index.js";
import { FileRepository } from "./file.repository.js";
import { CadEngineClient } from "./cad-engine.client.js";

@Injectable()
export class CadPreviewService {
  private preparing = 0;
  private readonly submitting = new Map<string, ReturnType<CadEngineClient["submit"]>>();
  constructor(private readonly repository: FileRepository, private readonly permission: PermissionService,
    private readonly storage: ObjectStorage, private readonly engine: CadEngineClient) {}

  private async context(fileId: string, versionId: string, viewId: string, actorId: string) {
    const file = await this.repository.findFileById(fileId);
    if (file === null) throw new AppError("NOT_FOUND", "文件不存在或不可见");
    await this.permission.assertProjectVisible(actorId, file.projectId);
    const version = await this.repository.findVersionById(file.id, versionId);
    if (version === null) throw new AppError("NOT_FOUND", "版本不存在或不可访问");
    const name = versionFileName(file.name, version.objectKey);
    if (!/\.(step|stp)$/i.test(name)) throw new AppError("NOT_FOUND", "该版本暂无 CAD 在线查看能力");
    const namespace = createHash("sha256").update(JSON.stringify([actorId, file.id, version.id, version.contentHash, viewId])).digest("hex");
    const cacheScope = createHash("sha256").update(JSON.stringify([file.id, version.id, version.contentHash])).digest("hex");
    return { version, name, namespace, cacheScope };
  }

  async create(fileId: string, versionId: string, viewId: string, actorId: string, nameCodepage: CadNameCodepage = "UTF8") {
    const context = await this.context(fileId, versionId, viewId, actorId);
    const key = context.namespace + ":" + nameCodepage;
    const pending = this.submitting.get(key);
    if (pending !== undefined) return pending;
    if (!this.engine.enabled) throw new ServiceUnavailableException("CAD 转换服务未启用，请下载原文件查看");
    if (context.version.sizeBytes <= 0 || context.version.sizeBytes > this.engine.inputLimit) {
      throw new ServiceUnavailableException("文件超过当前 CAD 处理大小限制，请下载原文件查看");
    }
    const operation = this.submit(context, nameCodepage).finally(() => { this.submitting.delete(key); });
    this.submitting.set(key, operation);
    return operation;
  }

  private async submit(context: Awaited<ReturnType<CadPreviewService["context"]>>, nameCodepage: CadNameCodepage) {
    const identity = { name: context.name, sourceSHA256: context.version.contentHash, sourceByteLength: context.version.sizeBytes,
      namespace: context.namespace, cacheScope: context.cacheScope, nameCodepage };
    // Permissions and current version were checked above; cached bytes never cache access rights.
    const cached = await this.engine.lookup(identity);
    if (cached !== null) return cached;
    if (this.preparing >= 2) throw new ServiceUnavailableException("CAD 文件读取繁忙，请稍后重试");
    this.preparing += 1;
    const path = resolve(this.engine.root, "incoming", randomUUID() + ".step");
    try {
      const object = await this.storage.getObject(context.version.objectKey);
      if (object === null) throw new AppError("NOT_FOUND", "原文件不存在或不可访问");
      if (object.bytes.byteLength !== context.version.sizeBytes || object.bytes.byteLength > this.engine.inputLimit
        || createHash("sha256").update(object.bytes).digest("hex") !== context.version.contentHash) {
        throw new ServiceUnavailableException("原文件完整性检查未通过，请重新上传或下载核对");
      }
      await mkdir(resolve(this.engine.root, "incoming"), { recursive: true, mode: 0o700 });
      await writeFile(path, object.bytes, { flag: "wx", mode: 0o600 });
      return await this.engine.submit({ path, ...identity });
    } finally { this.preparing -= 1; await unlink(path).catch(() => {}); }
  }

  async job(action: "status" | "cancel", fileId: string, versionId: string, viewId: string, jobId: string, actorId: string) {
    const { namespace } = await this.context(fileId, versionId, viewId, actorId);
    return this.engine[action]({ namespace, jobId });
  }
  async resource(action: "manifest" | "buffer", fileId: string, versionId: string, viewId: string, jobId: string,
    actorId: string, lease?: string, sha256?: string) {
    const { namespace } = await this.context(fileId, versionId, viewId, actorId);
    return this.engine.file(action, { namespace, jobId, lease, sha256 });
  }
  async release(fileId: string, versionId: string, viewId: string, jobId: string, lease: string, actorId: string) {
    const { namespace } = await this.context(fileId, versionId, viewId, actorId);
    await this.engine.release({ namespace, jobId, lease });
    return { released: true };
  }
}
