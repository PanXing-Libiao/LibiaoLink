import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ObjectStorage } from "../src/storage/object-storage.js";
import type { CadArchiveRepository, CadArtifactRow, CadViewRow } from "../src/modules/file/cad-archive.repository.js";
import type { CadEngineClient } from "../src/modules/file/cad-engine.client.js";
import { CadArchiveService } from "../src/modules/file/cad-archive.service.js";
import { CAD_ENGINE_VERSION } from "../src/modules/file/cad-release.js";

const opened = new Set<Readable>();
afterEach(() => { for (const stream of opened) stream.destroy(); opened.clear(); });

function fixture() {
  const body = Buffer.from('{"snapshot":{"completeness":"complete"}}');
  const now = new Date();
  const artifact: CadArtifactRow = {
    id: "11111111-1111-4111-8111-111111111111", fileId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333", sourceSHA256: "1".repeat(64), sourceBytes: 3,
    sourceName: "box.step", engineVersion: CAD_ENGINE_VERSION, nameCodepage: "GB", state: "completed", phase: "completed",
    attempts: 1, availableAt: now, claimToken: null, claimUntil: null, objectPrefix: "projects/test/files/test/cad/test/",
    manifestSHA256: createHash("sha256").update(body).digest("hex"), manifestBytes: body.byteLength,
    resourceLease: "4".repeat(48), buffers: [], artifactBytes: body.byteLength, errorCode: null, error: null,
    createdAt: now, updatedAt: now,
  };
  const view: CadViewRow = { id: "55555555-5555-4555-8555-555555555555", artifactId: artifact.id,
    actorId: "66666666-6666-4666-8666-666666666666", viewId: "7".repeat(32), cancelled: false,
    expiresAt: new Date(Date.now() + 60_000), leaseExpiresAt: null };
  const repository = {
    view: vi.fn<CadArchiveRepository["view"]>().mockResolvedValue({ artifact, view }),
    lease: vi.fn<CadArchiveRepository["lease"]>().mockResolvedValue(undefined),
    retry: vi.fn<CadArchiveRepository["retry"]>().mockResolvedValue(undefined),
  };
  const storage = {
    getObjectStream: vi.fn<ObjectStorage["getObjectStream"]>().mockImplementation(async () => {
      const stream = Readable.from([body]); opened.add(stream);
      return { stream, sizeBytes: body.byteLength, contentType: "application/json" };
    }),
  };
  const service = new CadArchiveService(repository as unknown as CadArchiveRepository, storage as unknown as ObjectStorage,
    {} as CadEngineClient);
  const source = { fileId: artifact.fileId, versionId: artifact.versionId, sourceSHA256: artifact.sourceSHA256,
    sourceBytes: artifact.sourceBytes, sourceName: artifact.sourceName };
  const manifest = () => service.resource("manifest", source, view.actorId, view.viewId, view.id.replaceAll("-", ""));
  return { body, artifact, view, repository, storage, manifest };
}

describe("CAD cached resource lifecycle", () => {
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
