import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer as collect } from "node:stream/consumers";
import type { ObjectStorage } from "../src/storage/object-storage.js";
import type { CadArchiveRepository, CadArtifactRow, CadViewRow } from "../src/modules/file/cad-archive.repository.js";
import type { CadEngineClient } from "../src/modules/file/cad-engine.client.js";
import { CadArchiveService } from "../src/modules/file/cad-archive.service.js";
import { CAD_ENGINE_VERSION, CAD_FORMAT_VERSIONS } from "../src/modules/file/cad-release.js";

const opened = new Set<Readable>();
afterEach(() => { for (const stream of opened) stream.destroy(); opened.clear(); });

function fixture() {
  const body = Buffer.from('{"snapshot":{"completeness":"complete"}}');
  const now = new Date();
  const artifact: CadArtifactRow = {
    id: "11111111-1111-4111-8111-111111111111", fileId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333", sourceSHA256: "1".repeat(64), sourceBytes: 3,
    sourceFormat: "STEP", mainPath: "box.step", companions: [], resourceSetHash: "0".repeat(64),
    sourceName: "box.step", engineVersion: CAD_ENGINE_VERSION, formatVersion: CAD_FORMAT_VERSIONS.STEP,
    nameCodepage: "GB", state: "completed", phase: "completed",
    attempts: 1, availableAt: now, claimToken: null, claimUntil: null, objectPrefix: "projects/test/files/test/cad/test/",
    manifestSHA256: createHash("sha256").update(body).digest("hex"), manifestBytes: body.byteLength,
    resourceLease: "4".repeat(48), buffers: [], artifactBytes: body.byteLength, errorCode: null, error: null,
    lastAccessedAt: null, createdAt: now, updatedAt: now,
  };
  const view: CadViewRow = { id: "55555555-5555-4555-8555-555555555555", artifactId: artifact.id,
    actorId: "66666666-6666-4666-8666-666666666666", viewId: "7".repeat(32), cancelled: false,
    expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date(), leaseExpiresAt: null };
  const repository = {
    view: vi.fn<CadArchiveRepository["view"]>().mockResolvedValue({ artifact, view }),
    touchView: vi.fn<CadArchiveRepository["touchView"]>().mockResolvedValue(undefined),
    lease: vi.fn<CadArchiveRepository["lease"]>().mockResolvedValue(undefined),
    retry: vi.fn<CadArchiveRepository["retry"]>().mockResolvedValue(undefined),
  };
  const storage = {
    getObjectStream: vi.fn<ObjectStorage["getObjectStream"]>().mockImplementation(async () => {
      const stream = Readable.from([body]); opened.add(stream);
      return { stream, sizeBytes: body.byteLength, contentType: "application/json" };
    }),
  };
  const inputs = { assertAvailable: vi.fn(async () => {}) };
  const service = new CadArchiveService(repository as unknown as CadArchiveRepository, storage as unknown as ObjectStorage,
    {} as CadEngineClient, inputs as never);
  const source = { fileId: artifact.fileId, versionId: artifact.versionId, sourceSHA256: artifact.sourceSHA256,
    sourceBytes: artifact.sourceBytes, sourceName: artifact.sourceName };
  const manifest = () => service.resource("manifest", source, view.actorId, view.viewId, view.id.replaceAll("-", ""));
  const status = () => service.job("status", source, view.actorId, view.viewId, view.id.replaceAll("-", ""));
  return { body, artifact, view, repository, storage, manifest, inputs, status, service, source };
}

describe("CAD cached resource lifecycle", () => {
  it("only authorized uncancelled waiting views refresh scheduling intent", async () => {
    const f = fixture();f.artifact.state = "queued";
    await f.status();expect(f.repository.touchView).toHaveBeenCalledWith(f.view.id);
    f.repository.touchView.mockClear();f.artifact.state = "running";
    await f.status();expect(f.repository.touchView).toHaveBeenCalledWith(f.view.id);
    f.repository.touchView.mockClear();f.artifact.state = "completed";
    await f.status();expect(f.repository.touchView).not.toHaveBeenCalled();
    f.artifact.state = "queued";f.view.cancelled = true;
    await f.status();expect(f.repository.touchView).not.toHaveBeenCalled();
    f.view.cancelled = false;f.inputs.assertAvailable.mockRejectedValue(new Error("revoked"));
    await expect(f.status()).rejects.toThrow("revoked");expect(f.repository.touchView).not.toHaveBeenCalled();
  });

  it("任务状态只发布可并行预取的资源摘要，不泄露对象存储键", async () => {
    const { artifact, status } = fixture();
    artifact.buffers = [{ sha256: "a".repeat(64), byteLength: 12, objectKey: "projects/private/geometry.bin" }];

    const state = await status();

    expect(state.resources).toEqual({ lease: artifact.resourceLease, buffers: [{ sha256: "a".repeat(64), byteLength: 12 }] });
    expect(JSON.stringify(state)).not.toContain("projects/private");
  });

  it("曲线派生资源使用当前视图租约，损坏时仍可从正式清单回退", async () => {
    const { artifact, view, storage, repository, service, source, manifest, status, body } = fixture();
    artifact.sourceFormat = "DWG";
    const sha = "a".repeat(64);
    artifact.buffers = [{ kind: "dwg-curve-columns-v1", sha256: sha, byteLength: body.length,
      objectKey: artifact.objectPrefix + sha }];
    const state = await status();
    expect(state.dwgCurveColumnsV1).toEqual({ sha256: sha, byteLength: body.length });
    expect(state.resources?.buffers).toEqual([]);
    const buffer = () => service.resource("buffer", source, view.actorId, view.viewId, view.id.replaceAll("-", ""),
      artifact.resourceLease!, sha);
    await expect(buffer()).rejects.toThrow();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    view.leaseExpiresAt = new Date(Date.now() + 60_000);
    const resource = await buffer();
    await expect(collect(resource.stream)).rejects.toThrow();
    expect(repository.retry).not.toHaveBeenCalled();
    expect(await collect((await manifest()).stream)).toEqual(body);
  });

  it("任务完成状态在返回资源摘要前续租，避免长转换后的预取命中过期租约", async () => {
    const { repository, view, status } = fixture();
    view.leaseExpiresAt = new Date(Date.now() - 1000);

    const state = await status();

    expect(state.state).toBe("completed");
    expect(repository.lease).toHaveBeenCalledWith(view.id);
  });

  it("任务仍在转换时不续租资源窗口", async () => {
    const { artifact, repository, status } = fixture();
    artifact.state = "running";

    await status();

    expect(repository.lease).not.toHaveBeenCalled();
  });

  it("已释放的资源窗口不会因状态查询被重新租用", async () => {
    const { repository, status } = fixture();

    await status();

    expect(repository.lease).not.toHaveBeenCalled();
  });

  it("资源摘要最多发布 256 项且不泄露对象存储键", async () => {
    const { artifact, status } = fixture();
    artifact.buffers = Array.from({ length: 300 }, (_, index) => ({
      sha256: (index + 1).toString(16).padStart(64, "0"), byteLength: index,
      objectKey: `projects/private/${index}.bin`,
    }));

    const state = await status();

    expect(state.resources?.buffers).toHaveLength(256);
    expect(JSON.stringify(state)).not.toContain("projects/private");
  });

  it("数据库续租失败后不遗留已打开的对象读取流，也不触发重新解析", async () => {
    const { repository, manifest } = fixture();
    const failure = new Error("lease write unavailable");
    repository.lease.mockRejectedValue(failure);

    await expect(manifest()).rejects.toBe(failure);

    expect([...opened].filter((stream) => !stream.destroyed)).toHaveLength(0);
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it("续租成功后仍返回通过摘要校验的完整模型清单", async () => {
    const { body, view, repository, manifest } = fixture();
    const resource = await manifest();
    const chunks: Buffer[] = [];
    for await (const chunk of resource.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks)).toEqual(body);
    expect(resource.bytes).toBe(body.byteLength);
    expect(repository.lease).toHaveBeenCalledWith(view.id);
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it("对象存储暂时不可用时保留已完成缓存，不重新解析", async () => {
    const { repository, storage, manifest } = fixture();
    storage.getObjectStream.mockRejectedValue(new Error("object storage unavailable"));

    await expect(manifest()).rejects.toMatchObject({ status: 503 });

    expect(opened.size).toBe(0);
    expect(repository.retry).not.toHaveBeenCalled();
  });

  it("对象长度损坏时关闭读取流并将对应缓存排队重建", async () => {
    const { body, artifact, repository, storage, manifest } = fixture();
    const stream = Readable.from([body]); opened.add(stream);
    storage.getObjectStream.mockResolvedValue({ stream, sizeBytes: body.byteLength + 1, contentType: "application/json" });

    await expect(manifest()).rejects.toMatchObject({ status: 503 });

    expect(stream.destroyed).toBe(true);
    expect(repository.retry).toHaveBeenCalledWith(artifact.id, "completed", artifact.objectPrefix);
  });

  it("查看器取消读取时关闭上游对象流", async () => {
    const { manifest } = fixture();
    const resource = await manifest();
    const upstream = [...opened][0]!;
    const closed = new Promise<void>((resolve) => resource.stream.once("close", resolve));

    resource.stream.destroy();
    await closed;

    expect(upstream.destroyed).toBe(true);
  });
});
