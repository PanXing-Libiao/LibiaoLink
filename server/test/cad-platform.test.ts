import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCadFixture, LOCAL_COOKIE, LOCAL_COOKIE_B, LOCAL_CSRF } from "./cad-http.fixture.js";

const fixture = fileURLToPath(new URL("fixtures/cad/controlled-box.step", import.meta.url));
const endpoint = process.env.CAD_TEST_ENDPOINT;
describe.skipIf(!endpoint)("CAD 平台 HTTP 链路（独立沙箱真实转换，受控箱体夹具）", () => {
  let env: Awaited<ReturnType<typeof createCadFixture>>, cache: string;
  let base: string, jobId: string;
  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), "libiaolink-cad-"));
    env = await createCadFixture([fixture, fixture], cache, endpoint!);
    const row = env.records[0]!;
    base = `/api/v1/files/${row.id}/versions/${row.versionId}/cad/views/${"1".repeat(32)}/jobs`;
  });
  afterAll(async () => { await env?.close(); if (cache) await rm(cache, { recursive: true, force: true }); });
  const api = () => request(env.app.getHttpServer());

  it("实际会话/CSRF 守卫拦截匿名与伪造写请求，STEP 入口不签原对象", async () => {
    expect((await api().post(base)).status).toBe(401);
    expect((await api().post(base).set("Cookie", LOCAL_COOKIE)).status).toBe(403);
    const preview = await api().get(`/api/v1/files/${env.records[0]!.id}/preview`).set("Cookie", LOCAL_COOKIE);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ status: "ready", target: null, url: null, viewer: { kind: "cad", versionId: env.records[0]!.versionId } });
  });

  it("文件版本→原文件 SHA→持久任务→完整二进制清单", async () => {
    const created = await api().post(base).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    jobId = created.body.job.id;
    let job = created.body.job;
    const deadline = Date.now() + 120_000;
    while (["queued", "running"].includes(job.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE);
      expect(status.status, JSON.stringify(status.body)).toBe(200); job = status.body;
    }
    expect(job.state, JSON.stringify(job)).toBe("completed");
    expect(job.sourceSHA256).toBe(env.records[0]!.sha);
    expect(job.workerPeakRSSBytes).toBeGreaterThan(0);
    const result = await api().get(base + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE).set("Accept-Encoding", "gzip");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(result.body.transportProfile).toBe("ucd-binary-compact/1");
    expect(result.body.snapshot.completeness).toBe("complete");
    expect(result.body.bufferPayloads).toBeUndefined();
  });

  it("跨用户、跨窗口和跨文件版本的 jobId 均不能借用", async () => {
    expect((await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE_B)).status).toBe(404);
    expect((await api().get(base.replace("1".repeat(32), "2".repeat(32)) + "/" + jobId).set("Cookie", LOCAL_COOKIE)).status).toBe(404);
    const other = env.records[1]!;
    const wrong = base.replace(env.records[0]!.id, other.id).replace(env.records[0]!.versionId, other.versionId);
    expect((await api().get(wrong + "/" + jobId).set("Cookie", LOCAL_COOKIE)).status).toBe(404);
  });

  it("新窗口复用已校验产物，跳过原件读取，lease 与取消仍按窗口隔离", async () => {
    const reading = vi.spyOn(env.storage, "getObject"), submitting = vi.spyOn(env.engine, "submit");
    const first = base.replace("1".repeat(32), "a".repeat(32));
    const second = base.replace("1".repeat(32), "b".repeat(32));
    try {
      for (const target of [first, second]) {
        const response = await api().post(target).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({ reused: true, job: { id: jobId, state: "completed" } });
      }
      expect(reading).not.toHaveBeenCalled(); expect(submitting).not.toHaveBeenCalled();
      const a = (await api().get(first + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE)).body;
      const b = (await api().get(second + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE)).body;
      expect(a.resourceLease).not.toBe(b.resourceLease);
      const entry = Object.values(b.bufferResources)[0] as { sha256: string };
      expect((await api().get(first + "/" + jobId + "/resources/" + b.resourceLease + "/" + entry.sha256).set("Cookie", LOCAL_COOKIE)).status).toBe(404);
      const cancelled = await api().post(first + "/" + jobId + "/cancel").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
      expect(cancelled.body.state).toBe("completed");
      expect((await api().get(second + "/" + jobId + "/resources/" + b.resourceLease + "/" + entry.sha256).set("Cookie", LOCAL_COOKIE)).status).toBe(200);
      env.permission.revoked = true;
      expect((await api().post(base.replace("1".repeat(32), "c".repeat(32))).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF)).status).toBe(404);
    } finally { env.permission.revoked = false; reading.mockRestore(); submitting.mockRestore(); }
  });

  it("同内容的新文件版本不借用旧版本缓存", async () => {
    const row = env.records[0]!, previous = row.versionId;
    row.versionId = "77777777-7777-4777-8777-777777777777";
    const target = base.replace(previous, row.versionId);
    try {
      const response = await api().post(target).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
      expect(response.status).toBe(201); expect(response.body.reused).toBe(false);
      expect(response.body.job.id).not.toBe(jobId);
      await api().post(target + "/" + response.body.job.id + "/cancel").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    } finally { row.versionId = previous; }
  });

  it("名称码页受控校验、隔离任务缓存并传到原生读取器", async () => {
    const invalid = await api().post(base + "?nameCodepage=guess").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(invalid.status).toBe(400);
    const created = await api().post(base + "?nameCodepage=UTF8").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(created.status).toBe(201);
    expect(created.body.job.id).not.toBe(jobId);
    expect(created.body.job.nameCodepage).toBe("UTF8");
    let job = created.body.job;
    const deadline = Date.now() + 120_000;
    while (["queued", "running"].includes(job.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await api().get(base + "/" + job.id).set("Cookie", LOCAL_COOKIE)).body;
    }
    expect(job.state, JSON.stringify(job)).toBe("completed");
    const readManifest = async (id: string) => (await api().get(base + "/" + id + "/manifest").set("Cookie", LOCAL_COOKIE)).body;
    const before = await readManifest(jobId), after = await readManifest(job.id);
    expect(before.document.extensions["org.cad-preview.step-audit/1"].nameEncoding.codepage).toBe("GB");
    expect(after.document.extensions["org.cad-preview.step-audit/1"].nameEncoding.codepage).toBe("UTF8");
    expect(after.document.buffers).toEqual(before.document.buffers);
    expect(after.snapshot.completeness).toBe("complete");
  });

  it("几何资源验证 SHA；撤销权限与释放 lease 后立即拒绝读取", async () => {
    const manifest = await api().get(base + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE);
    const packet = manifest.body;
    const entry = Object.values(packet.bufferResources)[0] as { sha256: string; byteLength: number };
    const url = base + "/" + jobId + "/resources/" + packet.resourceLease;
    const buffer = await api().get(url + "/" + entry.sha256).set("Cookie", LOCAL_COOKIE);
    expect(buffer.status).toBe(200);
    expect(buffer.body.byteLength).toBe(entry.byteLength);
    expect(createHash("sha256").update(buffer.body).digest("hex")).toBe(entry.sha256);
    env.permission.revoked = true;
    expect((await api().get(url + "/" + entry.sha256).set("Cookie", LOCAL_COOKIE)).status).toBe(404);
    env.permission.revoked = false;
    expect((await api().delete(url).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF)).status).toBe(200);
    expect((await api().get(url + "/" + entry.sha256).set("Cookie", LOCAL_COOKIE)).status).toBe(404);
  });

  it("原文件字节与版本摘要不符时不提交 CAD 任务", async () => {
    const other = env.records[1]!;
    const cold = base.replace(env.records[0]!.id, other.id).replace(env.records[0]!.versionId, other.versionId);
    env.storage.corrupt = true;
    const response = await api().post(cold.replace("1".repeat(32), "3".repeat(32))).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    env.storage.corrupt = false;
    expect(response.status).toBe(503);
  });

  it("可取消当前窗口任务，已取消任务不能发布模型清单", async () => {
    const other = env.records[1]!;
    const own = base.replace(env.records[0]!.id, other.id).replace(env.records[0]!.versionId, other.versionId).replace("1".repeat(32), "4".repeat(32));
    const created = await api().post(own + "?nameCodepage=GB").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(created.status).toBe(201);
    const path = own + "/" + created.body.job.id;
    const cancelled = await api().post(path + "/cancel").set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.state).toBe("cancelled");
    expect((await api().get(path + "/manifest").set("Cookie", LOCAL_COOKIE)).status).toBe(503);
  });

  it("读取原文件期间关闭窗口，尚未返回的任务也会取消", async () => {
    let release!: () => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    env.storage.beforeRead = async () => { entered(); await blocked; };
    const cancelled = vi.spyOn(env.engine, "cancel");
    const other = env.records[1]!;
    const cold = base.replace(env.records[0]!.id, other.id).replace(env.records[0]!.versionId, other.versionId).replace("1".repeat(32), "5".repeat(32));
    const call = api().post(cold).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    call.end(() => {});
    try {
      await reading; call.abort(); release();
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect((await cancelled.mock.results[0]!.value).state).toBe("cancelled");
    } finally { release(); env.storage.beforeRead = undefined; cancelled.mockRestore(); }
  });

  it.skipIf(!process.env.CAD_TEST_CONTAINER)("损坏的几何缓存不能命中，重新转换后恢复完整结果", async () => {
    const before = (await api().get(base + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE)).body;
    const entry = Object.values(before.bufferResources)[0] as { sha256: string };
    const path = "/var/lib/cad/jobs/buffers/" + entry.sha256;
    const run = (code: string) => execFileSync("docker", ["exec", process.env.CAD_TEST_CONTAINER!, "/opt/ocp/bin/python", "-c", code], { timeout: 15_000 });
    const bytes = run(`from pathlib import Path; import sys; sys.stdout.buffer.write(Path(${JSON.stringify(path)}).read_bytes())`);
    run(`from pathlib import Path; p=Path(${JSON.stringify(path)}); b=bytearray(p.read_bytes()); b[0]^=1; p.write_bytes(b)`);
    const response = await api().post(base).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(response.status).toBe(201); expect(response.body.reused).toBe(false);
    expect(response.body.job.id).not.toBe(jobId);
    jobId = response.body.job.id;
    let job = response.body.job;
    const deadline = Date.now() + 120_000;
    while (["queued", "running"].includes(job.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = (await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE)).body;
    }
    expect(job.state, JSON.stringify(job)).toBe("completed");
    expect(run(`from pathlib import Path; import sys; sys.stdout.buffer.write(Path(${JSON.stringify(path)}).read_bytes())`)).toEqual(bytes);
  });

  it("API 断开并重新连接后仍可从新窗口复用沙箱产物", async () => {
    await env.engine.onModuleDestroy();
    const status = await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE);
    expect(status.status).toBe(200); expect(status.body.state).toBe("completed");
    const manifest = await api().get(base + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE);
    expect(manifest.status).toBe(200); expect(manifest.body.snapshot.completeness).toBe("complete");
    const read = vi.spyOn(env.storage, "getObject");
    try {
      const created = await api().post(base.replace("1".repeat(32), "d".repeat(32))).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ reused: true, job: { id: jobId, state: "completed" } });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it.skipIf(!process.env.CAD_TEST_CONTAINER)("CAD 容器停止不阻断 API，重启后重新提交可恢复解析", async () => {
    const container = process.env.CAD_TEST_CONTAINER!;
    execFileSync("docker", ["stop", container], { timeout: 15_000 });
    try {
      const preview = await api().get(`/api/v1/files/${env.records[0]!.id}/preview`).set("Cookie", LOCAL_COOKIE);
      expect(preview.status).toBe(200);
      expect((await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE)).status).toBe(503);
    } finally { execFileSync("docker", ["start", container], { timeout: 15_000 }); }
    await vi.waitFor(async () => {
      const old = await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE);
      expect(old.status).toBe(404);
    }, { timeout: 15_000, interval: 200 });
    const created = await api().post(base).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    expect(created.status).toBe(201); expect(created.body.reused).toBe(false);
    expect(created.body.job.id).not.toBe(jobId);
    let state: string | undefined;
    await vi.waitFor(async () => {
      const result = await api().get(base + "/" + created.body.job.id).set("Cookie", LOCAL_COOKIE);
      expect(result.status).toBe(200); state = result.body.state;
      expect(["queued", "running"]).not.toContain(state);
    }, { timeout: 120_000, interval: 200 });
    expect(state).toBe("completed");
  });
});
