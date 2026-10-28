import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { CadNameCodepageSchema, z } from "@libiaolink/contracts";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { ObjectStorage } from "../../storage/index.js";
import { FileRepository } from "./file.repository.js";
import { CadEngineBusyError, CadEngineClient } from "./cad-engine.client.js";
import { CadArchiveRepository, type CadFailureContext } from "./cad-archive.repository.js";
import { CAD_ARTIFACT_LIMIT, CAD_BUFFER_LIMIT, checkedCadStream, readCadManifest } from "./cad-archive.integrity.js";
import { CadInputService, CadInputIntegrityError, cadInputs, cadResourceFingerprint } from "./cad-inputs.js";
import { AppError } from "../../common/errors/app-error.js";

const definition = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().max(CAD_BUFFER_LIMIT) });
const archiveManifest = z.object({
  resourceLease: z.string().regex(/^[a-f0-9]{48}$/),
  presentation: z.object({ sourceSHA256: z.string() }),
  snapshot: z.object({ completeness: z.enum(["complete", "partial"]) }),
  document: z.object({ buffers: z.record(z.string(), definition).refine((value) => Object.keys(value).length <= 4096) }),
  bufferResources: z.record(z.string(), definition.extend({ url: z.string() })),
});

class CadArchiveFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); }
}

/** Runs only from the worker entry point; native execution stays inside the sandbox. */
@Injectable()
export class CadArchiveWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(CadArchiveWorker.name);
  private running?: Promise<void>;
  private abort?: AbortController;
  private readonly streams = new Set<Readable>();
  constructor(private readonly repository: CadArchiveRepository, private readonly files: FileRepository,
    private readonly engine: CadEngineClient, private readonly storage: ObjectStorage, private readonly inputs: CadInputService) {}

  async drainOnce(): Promise<void> {
    if (!this.engine.enabled || this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drain(): Promise<void> {
    await this.repository.clearExpiredViews();
    const row = await this.repository.claim();
    if (!row) return;
    const abort = this.abort = new AbortController();
    let prefix: string | undefined;
    let activeLease: string | undefined, nativeId: string | undefined;
    let terminalState: CadFailureContext["terminalState"];
    let archived = false;
    const namespace = createHash("sha256").update("cad-archive:" + row.id).digest("hex");
    const heartbeat = setInterval(() => {
      void this.repository.renew(row).then((owned) => { if (!owned) this.interrupt(); }).catch(() => this.interrupt());
    }, 15_000);
    heartbeat.unref();
    try {
      const file = await this.files.findFileById(row.fileId);
      if (!file || file.status === "recycled") {
        throw new CadArchiveFailure("source-unavailable", "原文件版本已不可用，请重新上传", false);
      }
      prefix = `projects/${file.projectId}/files/${row.fileId}/cad/${row.id}/${row.claimToken}/`;
      const source = cadInputs(row);
      if (row.sourceBytes > this.engine.inputLimit) {
        throw new CadArchiveFailure("source-integrity-failed", "原文件完整性检查未通过，请重新上传或下载核对", false);
      }
      await this.inputs.assertAvailable(source, null);
      const cacheScope = createHash("sha256").update(JSON.stringify([row.fileId, row.versionId, row.sourceSHA256, source.resourceSetHash])).digest("hex");
      const identity = { name: row.sourceName, namespace, cacheScope, sourceSHA256: row.sourceSHA256,
        sourceByteLength: row.sourceBytes, nameCodepage: CadNameCodepageSchema.parse(row.nameCodepage),
        ...(source.sourceFormat === "DXF" ? { resourceFingerprint: cadResourceFingerprint(source) } : {}) };
      abort.signal.throwIfAborted();
      let job = (await this.engine.lookup(identity) ?? await this.engine.submit({ ...identity, bytes: await this.inputs.payload(source) })).job;
      nativeId = job.id;
      const deadline = Date.now() + 26 * 60_000;
      while (job.state === "queued" || job.state === "running") {
        if (Date.now() > deadline) {
          await this.engine.cancel({ namespace, jobId: nativeId }).catch(() => {});
          throw new CadArchiveFailure("conversion-timeout", "CAD 后台解析超时，请稍后重试", false);
        }
        if (!await this.repository.renew(row, job.phase)) throw new Error("CAD claim no longer owned");
        await delay(500, undefined, { signal: abort.signal });
        job = await this.engine.status({ namespace, jobId: nativeId });
      }
      if (job.state !== "completed" && !((source.sourceFormat === "DXF" || source.sourceFormat === "DWG") && job.state === "partial")) {
        if (["failed", "timed-out", "cancelled"].includes(job.state)) terminalState = job.state as CadFailureContext["terminalState"];
        throw new CadArchiveFailure(job.error?.code ?? (job.state === "timed-out" ? "job-timeout" : "conversion-failed"),
          job.error?.error ?? "CAD 后台解析未完成，请下载原文件查看", false);
      }
      if (!await this.repository.renew(row, "persisting")) throw new Error("CAD claim no longer owned");
      const manifest = await this.engine.file("manifest", { namespace, jobId: nativeId });
      this.streams.add(manifest.stream);
      const raw = await readCadManifest(manifest.stream, manifest.bytes);
      this.streams.delete(manifest.stream);
      const packet = archiveManifest.parse(JSON.parse(raw.toString("utf8")));
      activeLease = packet.resourceLease;
      if (packet.presentation.sourceSHA256 !== row.sourceSHA256) throw new Error("CAD manifest source mismatch");
      if (packet.snapshot.completeness !== (job.state === "partial" ? "partial" : "complete")) throw new Error("CAD completeness mismatch");
      const buffers = new Map<string, { sha256: string; byteLength: number; objectKey: string }>();
      let total = raw.byteLength;
      for (const [id, buffer] of Object.entries(packet.document.buffers)) {
        const resource = packet.bufferResources[id];
        if (!resource || resource.sha256 !== buffer.sha256 || resource.byteLength !== buffer.byteLength
          || resource.url !== `/api/resources/${activeLease}/${buffer.sha256}`) throw new Error("CAD manifest resource mismatch");
        const previous = buffers.get(buffer.sha256);
        if (previous && previous.byteLength !== buffer.byteLength) throw new Error("CAD duplicate buffer mismatch");
        if (!previous) {
          total += buffer.byteLength;
          buffers.set(buffer.sha256, { ...buffer, objectKey: prefix + buffer.sha256 });
        }
      }
      if (total > CAD_ARTIFACT_LIMIT) throw new CadArchiveFailure("artifact-budget", "模型产物超过当前持久化大小限制，请下载原文件查看", false);
      for (const buffer of buffers.values()) {
        abort.signal.throwIfAborted();
        const resource = await this.engine.file("buffer", { namespace, jobId: nativeId, lease: activeLease, sha256: buffer.sha256 });
        if (resource.bytes !== buffer.byteLength) { resource.stream.destroy(); throw new Error("CAD resource size mismatch"); }
        const checked = checkedCadStream(resource.stream, buffer.byteLength, buffer.sha256);
        this.streams.add(checked);
        try { await this.storage.putObjectStream({ objectKey: buffer.objectKey, body: checked, sizeBytes: buffer.byteLength,
          contentType: "application/octet-stream" }); }
        finally { checked.destroy(); this.streams.delete(checked); }
      }
      abort.signal.throwIfAborted();
      await this.inputs.assertAvailable(source, null);
      await this.storage.putObject({ objectKey: prefix + "manifest.json", body: raw, contentType: "application/json" });
      const published = await this.repository.publish(row, { objectPrefix: prefix, manifestSHA256: createHash("sha256").update(raw).digest("hex"),
        manifestBytes: raw.byteLength, resourceLease: activeLease, buffers: [...buffers.values()], artifactBytes: total }, job.state);
      if (!published) throw new Error("CAD claim no longer owned");
      archived = true;
      if (row.objectPrefix && row.objectPrefix !== prefix) await this.storage.purgePrefix(row.objectPrefix).catch(() => {});
    } catch (error) {
      if (prefix) await this.storage.purgePrefix(prefix).catch(() => {});
      const failure = error instanceof CadArchiveFailure ? error
        : error instanceof CadInputIntegrityError ? new CadArchiveFailure("source-integrity-failed", error.message, false)
        : error instanceof AppError && error.code === "NOT_FOUND" ? new CadArchiveFailure("source-unavailable", "主图或配套版本已不可用，请重新选择文件", false)
        : error instanceof CadEngineBusyError ? new CadArchiveFailure("engine-busy", "CAD 转换服务繁忙，请稍后重试", true)
        : new CadArchiveFailure("archive-unavailable", "CAD 后台解析或保存暂不可用，请稍后重试", true);
      await this.repository.fail(row, failure.code, failure.message, failure.retryable, {
        ...(nativeId === undefined ? {} : { nativeJobId: nativeId }), ...(terminalState === undefined ? {} : { terminalState }),
      });
      this.logger.warn("CAD 后台任务未完成：" + row.id + " / " + failure.code);
    } finally {
      clearInterval(heartbeat);
      if (nativeId && activeLease) await this.engine.release({ namespace, jobId: nativeId, lease: activeLease, retire: archived }).catch(() => {});
      this.abort = undefined;
      for (const stream of this.streams) stream.destroy();
      this.streams.clear();
    }
  }

  private interrupt(): void {
    this.abort?.abort();
    for (const stream of this.streams) stream.destroy(new Error("CAD background task interrupted"));
  }

  async onApplicationShutdown(): Promise<void> {
    this.interrupt();
    await this.running?.catch(() => {});
  }
}
