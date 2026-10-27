import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { AppConfig } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { CadEngineClient, CAD_ENGINE_VERSION } from "../src/modules/file/cad-engine.client.js";

let server: Server | undefined, client: CadEngineClient | undefined;
let socketDirectory: string | undefined;
const identity = { name: "box.step", sourceSHA256: "1".repeat(64), sourceByteLength: 3,
  namespace: "2".repeat(64), cacheScope: "3".repeat(64), nameCodepage: "UTF8" as const };
const job = { id: "4".repeat(32), state: "completed", phase: "completed", sourceSHA256: identity.sourceSHA256,
  sourceByteLength: 3, createdAt: 1, updatedAt: 1 };

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  server = createServer((request, response) => { response.setHeader("X-CAD-Engine-Version", CAD_ENGINE_VERSION); handler(request, response); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind TCP");
  client = new CadEngineClient(new AppConfig(loadEnv({ DATABASE_URL: "postgres://test/test", NODE_ENV: "test",
    CAD_ENGINE_URL: `http://127.0.0.1:${address.port}` })));
  return client;
}

afterEach(async () => {
  await client?.onModuleDestroy();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
  socketDirectory = undefined;
  client = undefined; server = undefined;
});

describe("CAD sandbox boundary", () => {
  it("生产客户端通过 Unix socket 工作，无需 TCP 或 CAD 文件目录", async () => {
    socketDirectory = await mkdtemp("/tmp/libiaolink-cad-client-");
    const socketPath = socketDirectory + "/engine.sock";
    server = createServer((_request, response) => { response.setHeader("X-CAD-Engine-Version", CAD_ENGINE_VERSION); response.end("null"); });
    await new Promise<void>(resolve => server!.listen(socketPath, resolve));
    const env = loadEnv({ DATABASE_URL: "postgres://test/test", CAD_ENGINE_SOCKET: socketPath });
    client = new CadEngineClient(new AppConfig({ ...env, NODE_ENV: "production" }));
    expect(await client.lookup(identity)).toBeNull();
  });

  it("旧 Python 配置不能重新开启 API 内解析；生产拒绝 TCP 回退", () => {
    const legacy = new CadEngineClient(new AppConfig(loadEnv({ DATABASE_URL: "postgres://test/test", CAD_ENGINE_PYTHON: "/unsafe/python" })));
    expect(legacy.enabled).toBe(false);
    expect(() => loadEnv({ DATABASE_URL: "postgres://test/test", NODE_ENV: "production", CAD_ENGINE_URL: "http://127.0.0.1:9910" })).toThrow(/CAD_ENGINE_URL/);
    expect(() => loadEnv({ DATABASE_URL: "postgres://test/test", CAD_ENGINE_SOCKET: "relative.sock" })).toThrow(/CAD_ENGINE_SOCKET/);
    expect(() => loadEnv({ DATABASE_URL: "postgres://test/test", CAD_ENGINE_URL: "http://example.com" })).toThrow(/CAD_ENGINE_URL/);
  });

  it("原件以字节传输，不传 API 文件路径、业务凭据或源对象 URL", async () => {
    let body: Buffer | undefined, metadata: Record<string, unknown> | undefined;
    const engine = await fixture((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        body = Buffer.concat(chunks);
        metadata = JSON.parse(Buffer.from(String(request.headers["x-cad-request"]), "base64url").toString("utf8")) as Record<string, unknown>;
        response.end(JSON.stringify({ job, reused: false }));
      });
    });
    const bytes = Uint8Array.of(0, 97, 98, 99, 0).subarray(1, 4);
    expect((await engine.submit({ ...identity, bytes })).job.id).toBe(job.id);
    expect(body?.toString()).toBe("abc");
    expect(metadata).toEqual({ action: "submit", ...identity, payloadByteLength: 3,
      payloadSHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });

  it("产物从响应流读取，不接受沙箱返回的本机路径", async () => {
    const engine = await fixture((_request, response) => { response.setHeader("Content-Length", 3); response.end("abc"); });
    const resource = await engine.file("buffer", { jobId: job.id, namespace: identity.namespace, sha256: identity.sourceSHA256, lease: "5".repeat(48) });
    let result = "";
    for await (const chunk of resource.stream) result += String(chunk);
    expect(result).toBe("abc"); expect(resource.bytes).toBe(3);
    expect(resource).not.toHaveProperty("path");
  });

  it("拒绝超额控制响应、超额资源和不同引擎版本", async () => {
    let mode = "json";
    const engine = await fixture((_request, response) => {
      if (mode === "json") response.end(" ".repeat(64 * 1024 + 1));
      else if (mode === "resource") { response.setHeader("Content-Length", 256 * 1024 * 1024 + 1); response.flushHeaders(); }
      else { response.setHeader("X-CAD-Engine-Version", "wrong-version"); response.end("null"); }
    });
    await expect(engine.lookup(identity)).rejects.toMatchObject({ status: 503 });
    mode = "resource";
    await expect(engine.file("manifest", { jobId: job.id, namespace: identity.namespace })).rejects.toMatchObject({ status: 503 });
    mode = "version";
    await expect(engine.lookup(identity)).rejects.toMatchObject({ status: 503 });
  });

  it("沙箱断连时返回受控错误，API 可继续处理后续请求", async () => {
    let disconnect = true;
    const engine = await fixture((request, response) => { if (disconnect) request.socket.destroy(); else response.end("null"); });
    await expect(engine.lookup(identity)).rejects.toMatchObject({ status: 503 });
    disconnect = false;
    expect(await engine.lookup(identity)).toBeNull();
  });

  it("仅将沙箱明确的配额拒绝识别为 busy，其他错误仍受控且有界", async () => {
    let body = JSON.stringify({ code: "busy" });
    const engine = await fixture((_request, response) => { response.statusCode = 503; response.end(body); });
    await expect(engine.lookup(identity)).rejects.toMatchObject({ name: "CadEngineBusyError", status: 503 });
    for (body of [JSON.stringify({ code: "unavailable" }), "invalid-json", " ".repeat(64 * 1024 + 1)]) {
      await expect(engine.lookup(identity)).rejects.toMatchObject({ name: "ServiceUnavailableException", status: 503 });
    }
  });
});
