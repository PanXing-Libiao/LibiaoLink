import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCadFixture, LOCAL_COOKIE, LOCAL_COOKIE_B, LOCAL_CSRF } from "./cad-http.fixture.js";

const fixture = fileURLToPath(new URL("fixtures/cad/controlled-box.step", import.meta.url));
const python = process.env.CAD_TEST_PYTHON;
describe.skipIf(!python)("CAD 平台 HTTP 链路（真实转换，受控箱体夹具）", () => {
  let env: Awaited<ReturnType<typeof createCadFixture>>, cache: string;
  let base: string, jobId: string;
  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), "libiaolink-cad-"));
    env = await createCadFixture([fixture, fixture], cache, python!);
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
      expect(status.status).toBe(200); job = status.body;
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
    env.storage.corrupt = true;
    const response = await api().post(base.replace("1".repeat(32), "3".repeat(32))).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    env.storage.corrupt = false;
    expect(response.status).toBe(503);
  });

  it("可取消当前窗口任务，已取消任务不能发布模型清单", async () => {
    const own = base.replace("1".repeat(32), "4".repeat(32));
    const created = await api().post(own).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
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
    const call = api().post(base.replace("1".repeat(32), "5".repeat(32))).set("Cookie", LOCAL_COOKIE).set("X-CSRF-Token", LOCAL_CSRF);
    call.end(() => {});
    try {
      await reading; call.abort(); release();
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect((await cancelled.mock.results[0]!.value).state).toBe("cancelled");
    } finally { release(); env.storage.beforeRead = undefined; cancelled.mockRestore(); }
  });

  it("转换进程重启后保留已完成任务与产物校验", async () => {
    await env.engine.onModuleDestroy();
    const status = await api().get(base + "/" + jobId).set("Cookie", LOCAL_COOKIE);
    expect(status.status).toBe(200); expect(status.body.state).toBe("completed");
    const manifest = await api().get(base + "/" + jobId + "/manifest").set("Cookie", LOCAL_COOKIE);
    expect(manifest.status).toBe(200); expect(manifest.body.snapshot.completeness).toBe("complete");
  });
});
