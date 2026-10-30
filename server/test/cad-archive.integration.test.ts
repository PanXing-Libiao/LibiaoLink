import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { Pool } from "pg";
import { AppConfig } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { DatabaseService } from "../src/db/database.service.js";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";
import { AuditService } from "../src/modules/audit/audit.service.js";
import { AppError } from "../src/common/errors/app-error.js";
import { S3ObjectStorage } from "../src/storage/s3-object-storage.js";
import { CadEngineClient } from "../src/modules/file/cad-engine.client.js";
import { CadArchiveRepository } from "../src/modules/file/cad-archive.repository.js";
import { CadArchiveService } from "../src/modules/file/cad-archive.service.js";
import { CadArchiveWorker } from "../src/modules/file/cad-archive.worker.js";
import { CadInputService } from "../src/modules/file/cad-inputs.js";
import { CadPreviewService } from "../src/modules/file/cad-preview.service.js";
import type { FileRepository } from "../src/modules/file/file.repository.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import { installCadAuditTables } from "./cad-audit.fixture.js";

const databaseUrl = process.env.CAD_TEST_DATABASE_URL;
const endpoint = process.env.CAD_TEST_ENDPOINT;
const minioPath = fileURLToPath(new URL("../cad-engine/.runtime/minio", import.meta.url));
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = randomUUID();
const schemaName = "cad_test_" + randomBytes(8).toString("hex");
const sources = Array.from({ length: 4 }, () => ({ fileId: randomUUID(), versionId: randomUUID(),
  sourceSHA256: "", sourceBytes: 0, sourceName: "受控箱体.step" }));
let database: DatabaseService, admin: Pool, minio: ChildProcess, directory: string, s3: S3Client;
let storage: S3ObjectStorage, repository: CadArchiveRepository, engine: CadEngineClient;
let archive: CadArchiveService, worker: CadArchiveWorker, preview: CadPreviewService, config: AppConfig;
let audit: AuditService;
let inputs: CadInputService;
const recycled = new Set<string>();
let denied = false;
const files = {
  async findFileById(id: string) { const source = sources.find((s) => s.fileId === id); return source ? { id, name: source.sourceName,
    projectId, status: recycled.has(id) ? "recycled" : "draft" } : null; },
  async findVersionById(id: string, versionId: string) { const source = sources.find((s) => s.fileId === id && s.versionId === versionId);
    return source ? { id: versionId, fileId: id, contentHash: source.sourceSHA256, sizeBytes: source.sourceBytes,
      objectKey: "sources/" + source.versionId + "." + source.sourceName.split(".").at(-1) } : null; },
} as unknown as FileRepository;
const permissions = { async assertProjectVisible() { if (denied) throw new AppError("NOT_FOUND", "不可访问"); } } as unknown as PermissionService;
const source = () => sources[0]!;
const rows = async (versionId = source().versionId) => (await database.pool.query("select * from cad_artifacts where version_id=$1 order by name_codepage", [versionId])).rows;
async function bytes(stream: Readable) { const result: Buffer[] = []; for await (const chunk of stream) result.push(Buffer.from(chunk)); return Buffer.concat(result); }
async function open(view: string, service = preview) { const s = source(); return service.create(s.fileId, s.versionId, view.repeat(32), actor); }
async function manifest(jobId: string, view: string, service = preview) {
  const s = source(); return JSON.parse((await bytes((await service.resource("manifest", s.fileId, s.versionId, view.repeat(32), jobId, actor)).stream)).toString());
}

describe.skipIf(!databaseUrl || !endpoint || !existsSync(minioPath))("CAD durable artifacts with PostgreSQL, MinIO and native sandbox", () => {
  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.startsWith("/libiaolink_cad_test")) throw new Error("Dedicated local CAD test database required");
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`create schema ${schemaName}`);
    target.searchParams.set("options", "-c search_path=" + schemaName);
    config = new AppConfig(loadEnv({ NODE_ENV: "test", DATABASE_URL: target.toString(), CAD_ENGINE_URL: endpoint! }));
    database = new DatabaseService(config);
    await installCadAuditTables(database, actor);
    audit = new AuditService(database, new AuditRepository(database));
    directory = await mkdtemp(join(tmpdir(), "libiaolink-cad-archive-test-"));
    const credentials = { accessKeyId: "cad-archive-test", secretAccessKey: randomBytes(24).toString("hex") };
    minio = spawn(minioPath, ["server", "--address", "127.0.0.1:19990", "--console-address", "127.0.0.1:19991", join(directory, "objects")],
      { env: { ...process.env, MINIO_ROOT_USER: credentials.accessKeyId, MINIO_ROOT_PASSWORD: credentials.secretAccessKey }, stdio: "ignore" });
    s3 = new S3Client({ endpoint: "http://127.0.0.1:19990", region: "us-east-1", forcePathStyle: true, credentials });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await s3.send(new CreateBucketCommand({ Bucket: "cad-artifact-tests" })); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error("Dedicated MinIO fixture did not start");
    storage = new S3ObjectStorage({ client: s3, bucket: "cad-artifact-tests", partUrlTtlSeconds: 60, downloadUrlTtlSeconds: 60,
      secretValues: [credentials.secretAccessKey], logger: { warn() {} } });
    const raw = await readFile(new URL("./fixtures/cad/controlled-box.step", import.meta.url));
    for (const s of sources) {
      s.sourceSHA256 = createHash("sha256").update(raw).digest("hex"); s.sourceBytes = raw.byteLength;
      await database.pool.query("insert into files(id, project_id) values($1,$2)", [s.fileId, projectId]);
      await database.pool.query("insert into file_versions(id) values($1)", [s.versionId]);
      await storage.putObject({ objectKey: "sources/" + s.versionId + ".step", body: raw });
    }
    Object.assign(files, {
      findFilesByIds: async (ids: string[]) => (await Promise.all(ids.map(id => files.findFileById(id)))).filter(Boolean),
      findVersionsByIds: async (ids: string[]) => (await Promise.all(sources.filter(row => ids.includes(row.versionId)).map(row => files.findVersionById(row.fileId, row.versionId)))).filter(Boolean),
    });
    inputs = new CadInputService(files, permissions, storage);
    repository = new CadArchiveRepository(database, audit);
    engine = new CadEngineClient(config);
    archive = new CadArchiveService(repository, storage, engine, inputs);
    worker = new CadArchiveWorker(repository, files, engine, storage, inputs);
    preview = new CadPreviewService(files, permissions, storage, engine, archive);
  });

  afterAll(async () => {
    await worker?.onApplicationShutdown(); await engine?.onModuleDestroy();
    s3?.destroy();
    if (minio?.exitCode === null) {
      minio.kill("SIGTERM");
      await new Promise<void>((resolve) => { const timer = setTimeout(() => { minio.kill("SIGKILL"); resolve(); }, 3000);
        minio.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
    await database?.onApplicationShutdown();
    if (admin) { await admin.query(`drop schema if exists ${schemaName} cascade`); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("上传事务只入队：回滚不留任务，重复登记幂等，默认 GB", async () => {
    const submit = vi.spyOn(engine, "submit");
    await expect(database.db.transaction(async (tx) => { await archive.uploaded(source(), tx); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await rows()).toHaveLength(0);
    await database.db.transaction(async (tx) => { await archive.uploaded(source(), tx); await archive.uploaded(source(), tx); });
    expect((await rows()).map((r) => [r.state, r.name_codepage])).toEqual([["queued", "GB"]]);
    expect(submit).not.toHaveBeenCalled(); submit.mockRestore();
  });

  it("独立 worker 并发领取只转换一次，全部对象写完才发布完整结果", async () => {
    const submit = vi.spyOn(engine, "submit");
    const second = new CadArchiveWorker(repository, files, engine, storage, inputs);
    await Promise.all([worker.drainOnce(), second.drainOnce()]);
    expect(await rows()).toMatchObject([{ state: "completed", name_codepage: "GB" }]);
    expect(submit).toHaveBeenCalledTimes(1);
    const submission = submit.mock.results[0];
    if (!submission || submission.type !== "return") throw new Error("Native submit did not return a job");
    const nativeJob = (await submission.value).job;
    const stored = (await rows())[0];
    const namespace = createHash("sha256").update("cad-archive:" + stored.id).digest("hex");
    await expect(engine.status({ namespace, jobId: nativeJob.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const created = await open("1"); expect(created.reused).toBe(true); expect(created.job.nameCodepage).toBe("GB");
    const packet = await manifest(created.job.id, "1");
    expect(packet.snapshot.completeness).toBe("complete");
    expect(packet.document.extensions["org.cad-preview.step-audit/1"].nameEncoding.codepage).toBe("GB");
    submit.mockRestore();
  });

  it("各窗口取消和资源租期独立，撤销权限仍立即拒绝读取", async () => {
    const a = await open("2"), b = await open("3");
    await preview.job("cancel", source().fileId, source().versionId, "2".repeat(32), a.job.id, actor);
    expect((await preview.job("status", source().fileId, source().versionId, "2".repeat(32), a.job.id, actor)).state).toBe("cancelled");
    expect((await rows())[0].state).toBe("completed");
    const packet = await manifest(b.job.id, "3");
    const entry = Object.values(packet.bufferResources)[0] as { sha256: string; byteLength: number };
    const read = () => preview.resource("buffer", source().fileId, source().versionId, "3".repeat(32), b.job.id, actor, packet.resourceLease, entry.sha256);
    denied = true; await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" }); denied = false;
    expect(createHash("sha256").update(await bytes((await read()).stream)).digest("hex")).toBe(entry.sha256);
    await preview.release(source().fileId, source().versionId, "3".repeat(32), b.job.id, packet.resourceLease, actor);
    await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.skipIf(!process.env.CAD_TEST_CONTAINER)("CAD 容器和 API/worker 实例重启后读取持久产物，零次 native 提交", async () => {
    execFileSync("docker", ["restart", process.env.CAD_TEST_CONTAINER!], { stdio: "ignore" });
    const restartedEngine = new CadEngineClient(config);
    const submitted = vi.spyOn(restartedEngine, "submit").mockRejectedValue(new Error("Must not reparse"));
    const lookup = vi.spyOn(restartedEngine, "lookup").mockRejectedValue(new Error("Must not query sandbox"));
    const restarted = new CadPreviewService(files, permissions, storage, restartedEngine, new CadArchiveService(new CadArchiveRepository(database, audit), storage, restartedEngine, inputs));
    const created = await open("4", restarted);
    expect(created.reused).toBe(true); expect((await manifest(created.job.id, "4", restarted)).snapshot.completeness).toBe("complete");
    await new CadArchiveWorker(new CadArchiveRepository(database, audit), files, restartedEngine, storage, inputs).drainOnce();
    expect(submitted).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    await restartedEngine.onModuleDestroy();
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(endpoint + "/healthz")).ok) { ready = true; break; } } catch { /* Native service is restarting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
  });

  it("显式 UTF8 单独解析并持久化，不覆盖默认 GB", async () => {
    const created = await preview.create(source().fileId, source().versionId, "5".repeat(32), actor, "UTF8");
    expect(created.job.state).toBe("queued"); await worker.drainOnce();
    const packet = await manifest(created.job.id, "5");
    expect(packet.document.extensions["org.cad-preview.step-audit/1"].nameEncoding.codepage).toBe("UTF8");
    expect((await rows()).map((r) => [r.name_codepage, r.state])).toEqual([["GB", "completed"], ["UTF8", "completed"]]);
  });

  it("对象丢失会撤销完成态并重建，不把残缺模型当缓存命中", async () => {
    const created = await open("6"), packet = await manifest(created.job.id, "6");
    const row = (await rows())[0], buffer = row.buffers[0];
    await storage.purgeObject(buffer.objectKey);
    await expect(preview.resource("buffer", source().fileId, source().versionId, "6".repeat(32), created.job.id, actor,
      packet.resourceLease, buffer.sha256)).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(async () => expect((await rows())[0].state).toBe("queued"));
    await worker.drainOnce(); expect((await rows())[0].state).toBe("completed");
    expect((await rows())[0].object_prefix).not.toBe(row.object_prefix);
  });

  it("保存失败不发布，过期 claim 不能覆盖新 worker 的完成记录", async () => {
    const s = sources[1]!; await archive.uploaded(s);
    const first = (await repository.claim())!;
    await database.pool.query("update cad_artifacts set claim_until=now()-interval '1 second' where id=$1", [first.id]);
    const failWrite = vi.spyOn(storage, "putObjectStream").mockRejectedValueOnce(new Error("controlled write failure"));
    await worker.drainOnce(); failWrite.mockRestore();
    expect((await rows(s.versionId))[0].state).toBe("queued");
    await database.pool.query("update cad_artifacts set available_at=now()-interval '1 second' where id=$1", [first.id]);
    await worker.drainOnce(); expect((await rows(s.versionId))[0].state).toBe("completed");
    expect(await repository.publish(first, { objectPrefix: null, manifestSHA256: null, manifestBytes: null,
      resourceLease: null, buffers: null, artifactBytes: 0 })).toBe(false);
  });

  it("同大小的内容损坏也会被 SHA 拒绝并重建，不能静默复用", async () => {
    const created = await open("7"), packet = await manifest(created.job.id, "7");
    const row = (await rows())[0], buffer = row.buffers.find((item: { byteLength: number }) => item.byteLength > 0);
    const saved = (await storage.getObject(buffer.objectKey))!;
    const corrupted = Buffer.from(saved.bytes); corrupted[0] = corrupted[0]! ^ 1;
    await storage.putObject({ objectKey: buffer.objectKey, body: corrupted });
    const response = await preview.resource("buffer", source().fileId, source().versionId, "7".repeat(32), created.job.id,
      actor, packet.resourceLease, buffer.sha256);
    await expect(bytes(response.stream)).rejects.toThrow("integrity mismatch");
    await vi.waitFor(async () => expect((await rows())[0].state).toBe("queued"));
    await worker.drainOnce(); expect((await rows())[0].state).toBe("completed");
  });

  it("原件 SHA 错误时后台失败，上传完成记录保留且不启动 native", async () => {
    const s = sources[2]!; await storage.putObject({ objectKey: "sources/" + s.versionId + ".step", body: Buffer.from("invalid") });
    await archive.uploaded(s);
    const submitted = vi.spyOn(engine, "submit");
    await worker.drainOnce();
    expect(await rows(s.versionId)).toMatchObject([{ state: "failed", error_code: "source-integrity-failed" }]);
    expect(submitted).not.toHaveBeenCalled(); submitted.mockRestore();
  });

  it("完成态受数据库约束保护，清理文件同时移除私有 CAD 对象", async () => {
    expect((await rows())[0].state).toBe("completed");
    await expect(database.pool.query("update cad_artifacts set manifest_sha256=null where version_id=$1", [source().versionId]))
      .rejects.toMatchObject({ code: "23514" });
    const row = (await rows())[0];
    expect(row.object_prefix.startsWith(`projects/${projectId}/files/${source().fileId}/cad/`)).toBe(true);
    await archive.purge(source().fileId, projectId);
    expect(await storage.headObject(row.object_prefix + "manifest.json")).toBeNull();
    await database.pool.query("delete from files where id=$1", [source().fileId]);
    expect(await rows()).toHaveLength(0);
  });
  it("DXF 缺少外参明示 partial，补齐固定配套版本后完整发布，并按输入集合复用及撤销", async () => {
    const selected = [] as typeof sources;
    for (const name of ["main.dxf", "detail.dxf"]) {
      const raw = await readFile(new URL("./fixtures/cad/dxf/" + name, import.meta.url));
      const input = { fileId: randomUUID(), versionId: randomUUID(), sourceName: name,
        sourceSHA256: createHash("sha256").update(raw).digest("hex"), sourceBytes: raw.byteLength };
      sources.push(input); selected.push(input);
      await database.pool.query("insert into files(id, project_id) values($1,$2)", [input.fileId, projectId]);
      await database.pool.query("insert into file_versions(id) values($1)", [input.versionId]);
      await storage.putObject({ objectKey: "sources/" + input.versionId + ".dxf", body: raw });
    }
    const [main, detail] = selected as [typeof sources[number], typeof sources[number]];
    const partial = await preview.create(main.fileId, main.versionId, "8".repeat(32), actor);
    await worker.drainOnce();
    expect((await preview.job("status", main.fileId, main.versionId, "8".repeat(32), partial.job.id, actor)).state).toBe("partial");
    const read = async (id: string, view: string) => JSON.parse((await bytes((await preview.resource("manifest", main.fileId, main.versionId, view.repeat(32), id, actor)).stream)).toString());
    expect((await read(partial.job.id, "8")).snapshot.completeness).toBe("partial");
    const options = { mainPath: "图纸/main.dxf", companions: [{ fileId: detail.fileId, versionId: detail.versionId, path: "图纸/refs/detail.dxf" }] };
    const complete = await preview.create(main.fileId, main.versionId, "9".repeat(32), actor, "GB", options);
    expect(complete.reused).toBe(false); await worker.drainOnce();
    const packet = await read(complete.job.id, "9");
    expect(packet.snapshot.completeness).toBe("complete");
    expect(packet.document.sources).toBeDefined();
    expect((await rows(main.versionId)).map(row => row.state).sort()).toEqual(["completed", "partial"]);
    const submit = vi.spyOn(engine, "submit"), objectReads = vi.spyOn(storage, "getObjectStream");
    const reused = await preview.create(main.fileId, main.versionId, "a".repeat(32), actor, "UTF8", options);
    expect(reused.reused).toBe(true); expect(submit).not.toHaveBeenCalled(); expect(objectReads).not.toHaveBeenCalled();
    submit.mockRestore(); objectReads.mockRestore();
    recycled.add(detail.fileId);
    await expect(read(complete.job.id, "9")).rejects.toMatchObject({ code: "NOT_FOUND" });
    recycled.delete(detail.fileId);
    const completedRow = (await rows(main.versionId)).find(row => row.state === "completed");
    await archive.purge(detail.fileId, projectId);
    expect(await storage.headObject(completedRow.object_prefix + "manifest.json")).toBeNull();
    expect((await rows(main.versionId)).map(row => row.state)).toEqual(["partial"]);
    await expect(read(complete.job.id, "9")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await read(partial.job.id, "8")).snapshot.completeness).toBe("partial");
  });

});
