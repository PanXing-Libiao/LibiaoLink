import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { inspectPng } from "./png-policy.mjs";
import { DEFAULT_LIMITS, SvgPolicyError, inspectSvg } from "./svg-policy.mjs";

const WORKER_PATH = fileURLToPath(new URL("./render-worker.mjs", import.meta.url));
const PORT = boundedInteger("PORT", 9900, 1, 65_535);
const HOST = process.env.HOST ?? "0.0.0.0";
const PIPELINE_VERSION = safeVersion(process.env.PIPELINE_VERSION ?? "2.0.0");
const FONTS_DIR = process.env.FONTS_DIR ?? "/app/fonts";
const CONVERT_TIMEOUT_MS = boundedInteger("CONVERT_TIMEOUT_MS", 10_000, 1, 10_000);
const CONVERT_MAX_CONCURRENCY = boundedInteger("CONVERT_MAX_CONCURRENCY", 1, 1, 1);
const CONVERT_MAX_QUEUE = boundedInteger("CONVERT_MAX_QUEUE", 4, 0, 4);
const HEALTH_TIMEOUT_MS = 3_000;
const HEALTH_CACHE_MS = 10_000;
const MAX_ERROR_BODY = 16 * 1024;
const activeChildren = new Set();
const startedAt = Date.now();

function boundedInteger(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function safeVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : "2.0.0";
}

const limits = {
  ...DEFAULT_LIMITS,
  maxSourceBytes: boundedInteger("SVG_MAX_SOURCE_BYTES", DEFAULT_LIMITS.maxSourceBytes, 1, DEFAULT_LIMITS.maxSourceBytes),
  maxOutputBytes: boundedInteger("SVG_MAX_OUTPUT_BYTES", DEFAULT_LIMITS.maxOutputBytes, 1, DEFAULT_LIMITS.maxOutputBytes),
  maxLongEdge: boundedInteger("SVG_MAX_LONG_EDGE", DEFAULT_LIMITS.maxLongEdge, DEFAULT_LIMITS.minLongEdge, DEFAULT_LIMITS.maxLongEdge),
  maxPixels: boundedInteger("SVG_MAX_PIXELS", DEFAULT_LIMITS.maxPixels, 1, DEFAULT_LIMITS.maxPixels),
  maxAspectRatio: boundedInteger("SVG_MAX_ASPECT_RATIO", DEFAULT_LIMITS.maxAspectRatio, 1, DEFAULT_LIMITS.maxAspectRatio),
  maxNaturalEdge: boundedInteger("SVG_MAX_NATURAL_EDGE", DEFAULT_LIMITS.maxNaturalEdge, 1, DEFAULT_LIMITS.maxNaturalEdge),
  maxElements: boundedInteger("SVG_MAX_ELEMENTS", DEFAULT_LIMITS.maxElements, 1, DEFAULT_LIMITS.maxElements),
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

class SlotPool {
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.inflight = 0;
    this.waiters = [];
  }

  async acquire(timeoutMs) {
    if (this.inflight < this.limit) {
      this.inflight += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueue) throw new HttpError(503, "SERVICE_BUSY", "栅格化队列已满，请稍后重试");
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, settled: false };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new HttpError(503, "SERVICE_BUSY", "栅格化排队超时，请稍后重试"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next !== undefined) {
      clearTimeout(next.timer);
      next.settled = true;
      next.resolve();
      return;
    }
    this.inflight = Math.max(0, this.inflight - 1);
  }
}

const pool = new SlotPool(CONVERT_MAX_CONCURRENCY, CONVERT_MAX_QUEUE);

function workerEnvironment() {
  return {
    NODE_ENV: "production",
    FONTS_DIR,
    HOME: "/tmp",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    SVG_MAX_SOURCE_BYTES: String(limits.maxSourceBytes),
    SVG_MAX_OUTPUT_BYTES: String(limits.maxOutputBytes),
    SVG_MAX_LONG_EDGE: String(limits.maxLongEdge),
    SVG_MAX_PIXELS: String(limits.maxPixels),
    SVG_MAX_ASPECT_RATIO: String(limits.maxAspectRatio),
    SVG_MAX_NATURAL_EDGE: String(limits.maxNaturalEdge),
    SVG_MAX_ELEMENTS: String(limits.maxElements),
  };
}

function killChild(child) {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程已退出。
    }
  }
}

function parseWorkerError(stderr) {
  try {
    const body = JSON.parse(stderr);
    const code = typeof body.error === "string" && /^[A-Z0-9_]{1,64}$/.test(body.error) ? body.error : "SVG_RENDER_FAILED";
    const message = typeof body.message === "string" ? sanitize(body.message) : "SVG 栅格化失败，已拒绝";
    return new HttpError(422, code, message);
  } catch {
    return new HttpError(422, "SVG_RENDER_FAILED", "SVG 栅格化失败，已拒绝");
  }
}

function runWorker({ input = null, health = false }) {
  const timeoutMs = health ? HEALTH_TIMEOUT_MS : CONVERT_TIMEOUT_MS;
  const maxStdout = health ? 16 * 1024 : limits.maxOutputBytes;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", WORKER_PATH, ...(health ? ["--health"] : [])], {
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnvironment(),
    });
    activeChildren.add(child);
    let settled = false;
    let timedOut = false;
    let stdoutTooLarge = false;
    let stdoutBytes = 0;
    let stderr = "";
    const stdout = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if (error !== null) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);
    child.on("error", () => finish(new HttpError(503, "SERVICE_UNAVAILABLE", "SVG 栅格化进程不可用")));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdout) {
        stdoutTooLarge = true;
        killChild(child);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_ERROR_BODY) stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BODY - stderr.length);
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(new HttpError(504, "CONVERT_TIMEOUT", "SVG 栅格化超过 10 秒，已终止"));
        return;
      }
      if (stdoutTooLarge) {
        finish(new HttpError(422, "PNG_TOO_LARGE", "PNG 产物超过安全上限，已拒绝"));
        return;
      }
      if (code !== 0) {
        finish(parseWorkerError(stderr));
        return;
      }
      finish(null, Buffer.concat(stdout, stdoutBytes));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

async function rendererHealth() {
  const body = await runWorker({ health: true });
  const parsed = JSON.parse(body.toString("utf8"));
  if (parsed?.ok !== true || typeof parsed.resvgVersion !== "string") throw new Error("renderer health payload invalid");
  return parsed;
}

let healthCache = { at: 0, value: null };

async function currentHealth() {
  if (healthCache.value !== null && Date.now() - healthCache.at < HEALTH_CACHE_MS) return healthCache.value;
  if (activeChildren.size > 0 && healthCache.value !== null) return healthCache.value;
  const value = await rendererHealth();
  healthCache = { at: Date.now(), value };
  return value;
}

async function readBody(request) {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "BAD_REQUEST", "Content-Length 非法");
    if (size > limits.maxSourceBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "SVG 源文件超过安全上限");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > limits.maxSourceBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "SVG 源文件超过安全上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function normalizeSourceMime(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.split(";", 1)[0].trim().toLowerCase();
}

function decodeFileName(value) {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, "BAD_REQUEST", "缺少 x-file-name");
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // 兼容非编码文件名；扩展名仍需通过判决。
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  if (!base.toLowerCase().endsWith(".svg")) throw new HttpError(415, "UNSUPPORTED_MEDIA", "只接受 SVG 源文件");
  return base;
}

function requestIdOf(request) {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

function sanitize(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function setCommonHeaders(response, requestId) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", requestId);
}

function sendJson(response, status, body, requestId) {
  const payload = Buffer.from(JSON.stringify(body));
  setCommonHeaders(response, requestId);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(payload.byteLength) });
  response.end(payload);
}

function log(event, fields) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n");
}

async function handleConvert(request, response, requestId) {
  const target = typeof request.headers["x-preview-target"] === "string" ? request.headers["x-preview-target"].trim().toLowerCase() : "";
  if (target === "") throw new HttpError(400, "BAD_REQUEST", "缺少 x-preview-target");
  if (target !== "image") throw new HttpError(501, "UNSUPPORTED_TARGET", "只支持 x-preview-target: image");
  const fileName = decodeFileName(request.headers["x-file-name"]);
  const sourceMime = normalizeSourceMime(request.headers["x-source-mime"]);
  if (sourceMime !== null && sourceMime !== "image/svg+xml") throw new HttpError(415, "UNSUPPORTED_MEDIA", "只接受 image/svg+xml");

  await pool.acquire(CONVERT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const body = await readBody(request);
    const inspected = inspectSvg(body, limits);
    const png = await runWorker({ input: body });
    const info = inspectPng(png, inspected, limits);
    setCommonHeaders(response, requestId);
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      "content-disposition": `inline; filename="${fileName.replace(/\.svg$/i, "").replace(/[^A-Za-z0-9._-]/g, "_")}.png"`,
      "x-preview-target": "image",
      "x-pipeline-version": PIPELINE_VERSION,
      "x-convert-mode": "rasterize",
      "x-convert-duration-ms": String(Date.now() - started),
      "x-artifact-name": encodeURIComponent(fileName.replace(/\.svg$/i, "") + ".png"),
      "x-png-width": String(info.width),
      "x-png-height": String(info.height),
    });
    response.end(png);
    log("convert_ok", { requestId, inputBytes: body.byteLength, outputBytes: png.byteLength, width: info.width, height: info.height, durationMs: Date.now() - started });
  } finally {
    pool.release();
  }
}

async function route(request, response) {
  const requestId = requestIdOf(request);
  const started = Date.now();
  let path;
  try {
    path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "请求路径非法");
  }
  try {
    if (path === "/healthz") {
      if (request.method !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "只支持 GET");
      try {
        const renderer = await currentHealth();
        sendJson(response, 200, { ok: true, service: "libiaolink-svg-preview", pipelineVersion: PIPELINE_VERSION, resvgVersion: renderer.resvgVersion, limits, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }, requestId);
      } catch {
        sendJson(response, 503, { ok: false, service: "libiaolink-svg-preview", pipelineVersion: PIPELINE_VERSION, error: "SERVICE_UNAVAILABLE" }, requestId);
      }
      return;
    }
    if (path === "/convert") {
      if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "只支持 POST");
      await handleConvert(request, response, requestId);
      return;
    }
    throw new HttpError(404, "NOT_FOUND", "路径不存在");
  } catch (error) {
    const failure = error instanceof HttpError ? error : error instanceof SvgPolicyError
      ? new HttpError(422, error.code, error.message)
      : new HttpError(500, "INTERNAL", "服务内部错误");
    if (!response.headersSent) sendJson(response, failure.status, { error: failure.code, message: sanitize(failure.message), pipelineVersion: PIPELINE_VERSION }, requestId);
    log("request_failed", { requestId, path, status: failure.status, code: failure.code, durationMs: Date.now() - started });
  }
}

const server = createServer((request, response) => {
  route(request, response).catch(() => {
    if (!response.headersSent) {
      setCommonHeaders(response, randomUUID());
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "INTERNAL", message: "服务内部错误", pipelineVersion: PIPELINE_VERSION }));
    }
  });
});
server.headersTimeout = 5_000;
server.requestTimeout = CONVERT_TIMEOUT_MS + 5_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;
server.maxRequestsPerSocket = 10;

function shutdown(signal) {
  log("shutdown", { signal });
  server.close(() => process.exit(0));
  for (const child of activeChildren) killChild(child);
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT, pipelineVersion: PIPELINE_VERSION, limits }));
