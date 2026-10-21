import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { DEFAULT_LIMITS, inspectSvg } from "./svg-policy.mjs";
import { inspectPng } from "./png-policy.mjs";

const BASE = (process.env.SELFCHECK_URL ?? "http://127.0.0.1:9900").replace(/\/+$/, "");
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const SANDBOX = process.env.SVG_PREVIEW_SELFCHECK_SANDBOX === "1";
const results = [];

function record(name, state, detail = "") {
  results.push({ name, state, detail });
  process.stdout.write(`${state.padEnd(4)} ${name}${detail === "" ? "" : ` — ${detail}`}\n`);
}

function check(name, condition, detail = "") {
  record(name, condition ? "PASS" : "FAIL", detail);
}

function skip(name, detail) {
  record(name, "SKIP", detail);
}

const fixture = (group, name) => readFileSync(`${FIXTURES}${group}/${name}`);

async function convert(bytes, { fileName = "selfcheck.svg", target = "image", mime = "image/svg+xml", base = BASE } = {}) {
  const headers = { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(fileName) };
  if (target !== null) headers["x-preview-target"] = target;
  if (mime !== null) headers["x-source-mime"] = mime;
  const response = await fetch(`${base}/convert`, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(20_000) });
  const body = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  let json = null;
  if (type.includes("application/json")) {
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, body, json };
}

function pngPixels(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      const value = raw[cursor + x];
      const decoded = filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + Math.floor((left + up) / 2)
              : value + paeth(left, up, upLeft);
      line[x] = decoded & 0xff;
    }
    cursor += stride;
    line.copy(pixels, y * stride);
    previous = line;
  }
  return { width, height, pixels };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
}

function alphaCount(pixels) {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) count += 1;
  return count;
}

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // 实例仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function hugeContentLength() {
  const url = new URL("/convert", BASE);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-length": String(DEFAULT_LIMITS.maxSourceBytes + 1),
        "x-preview-target": "image",
        "x-file-name": "oversize.svg",
        "x-source-mime": "image/svg+xml",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

function countWorkerProcesses() {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (command.includes("render-worker.mjs")) count += 1;
    } catch {
      // 进程已退出。
    }
  }
  return count;
}

async function timeoutAndResidueChecks() {
  const port = 9901;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--max-old-space-size=128", SERVER], {
    env: { ...process.env, PORT: String(port), CONVERT_TIMEOUT_MS: "1", CONVERT_MAX_QUEUE: "0" },
    stdio: "ignore",
  });
  try {
    const ready = await waitForHealth(base, 15_000);
    check("超时实例就绪", ready, `port=${port}`);
    if (ready) {
      const response = await convert(fixture("normal", "basic-shapes.svg"), { base });
      check("硬超时返回 504 CONVERT_TIMEOUT", response.status === 504 && response.json?.error === "CONVERT_TIMEOUT", `status=${response.status}`);
    }
  } finally {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  check("超时后无 render-worker 残留进程", countWorkerProcesses() === 0, `count=${countWorkerProcesses()}`);
}

async function pixelLimitChecks() {
  const port = 9902;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--max-old-space-size=128", SERVER], {
    env: { ...process.env, PORT: String(port), CONVERT_MAX_QUEUE: "0", SVG_MAX_PIXELS: "1000000" },
    stdio: "ignore",
  });
  try {
    const ready = await waitForHealth(base, 15_000);
    check("像素上限实例就绪", ready, `port=${port}`);
    if (ready) {
      const response = await convert(fixture("malicious", "pixel-bomb.svg"), { fileName: "pixel-bomb.svg", base });
      check("像素炸弹返回 422 SVG_PIXEL_LIMIT", response.status === 422 && response.json?.error === "SVG_PIXEL_LIMIT", `status=${response.status} error=${response.json?.error ?? null}`);
    }
  } finally {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function sandboxChecks() {
  if (!SANDBOX) {
    skip("容器沙箱断言", "以 SVG_PREVIEW_SELFCHECK_SANDBOX=1 在容器内运行");
    return;
  }
  check("运行用户为非 root", process.getuid?.() === 1000, `uid=${process.getuid?.()}`);
  let rootWriteBlocked = false;
  try {
    writeFileSync("/app/.selfcheck-write", "x");
  } catch {
    rootWriteBlocked = true;
  }
  check("根文件系统禁止写入", rootWriteBlocked);
  check("无 Docker socket", !existsSync("/var/run/docker.sock"));
  const status = readFileSync("/proc/self/status", "utf8");
  check("capabilities 已清空", /CapEff:\s*0{16}/.test(status));
  check("no-new-privileges 生效", /NoNewPrivs:\s*1/.test(status));
  let outboundBlocked = false;
  try {
    await fetch("https://example.com/", { method: "HEAD", signal: AbortSignal.timeout(3_000) });
  } catch {
    outboundBlocked = true;
  }
  check("容器无外网", outboundBlocked);
  const pids = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
  const memory = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
  const cpu = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
  check("PIDs 上限 64", pids === "64", `pids.max=${pids}`);
  check("内存上限 256 MiB", memory === String(256 * 1024 * 1024), `memory.max=${memory}`);
  check("CPU 上限 1", cpu === "100000 100000", `cpu.max=${cpu}`);
}

async function main() {
  const health = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10_000) });
  const healthBody = await health.json();
  check("healthz 可用", health.status === 200 && healthBody.ok === true, `status=${health.status}`);
  check("管线版本 2.0.0", healthBody.pipelineVersion === "2.0.0", `pipelineVersion=${healthBody.pipelineVersion}`);
  check("固定渲染器 resvg-js 2.6.2", healthBody.resvgVersion === "2.6.2", `resvgVersion=${healthBody.resvgVersion}`);

  for (const name of ["basic-shapes.svg", "gradient.svg", "chinese-text.svg", "transparent.svg", "near-4096.svg"]) {
    const svg = fixture("normal", name);
    const expected = inspectSvg(svg);
    const response = await convert(svg, { fileName: name });
    let valid = false;
    let detail = `status=${response.status}`;
    if (response.status === 200 && response.headers.get("content-type") === "image/png") {
      try {
        const png = inspectPng(response.body, expected, DEFAULT_LIMITS);
        valid = true;
        detail = `${png.width}x${png.height} ${png.bytes}B`;
      } catch (error) {
        detail = error.message;
      }
    }
    check(`正常夹具 ${name}`, valid, detail);
  }

  const transparent = await convert(fixture("normal", "transparent.svg"), { fileName: "transparent.svg" });
  const transparentPixels = pngPixels(transparent.body);
  check("透明背景保持", transparentPixels.pixels[3] === 0, `cornerAlpha=${transparentPixels.pixels[3]}`);

  const glyphA = await convert(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><text x="12" y="92" font-family="Noto Sans CJK SC" font-size="88">中</text></svg>'), { fileName: "glyph-a.svg" });
  const glyphB = await convert(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><text x="12" y="92" font-family="Noto Sans CJK SC" font-size="88">文</text></svg>'), { fileName: "glyph-b.svg" });
  const glyphAPixels = pngPixels(glyphA.body);
  const glyphBPixels = pngPixels(glyphB.body);
  check("中文文字非空", alphaCount(glyphAPixels.pixels) > 100 && alphaCount(glyphBPixels.pixels) > 100, `alpha=${alphaCount(glyphAPixels.pixels)}/${alphaCount(glyphBPixels.pixels)}`);
  check("中文不同字形可分", createHash("sha256").update(glyphA.body).digest("hex") !== createHash("sha256").update(glyphB.body).digest("hex"));

  const expectedCodes = new Map([
    ["script.svg", "SVG_ACTIVE_CONTENT"],
    ["event-attribute.svg", "SVG_EVENT_ATTRIBUTE"],
    ["foreign-object.svg", "SVG_ACTIVE_CONTENT"],
    ["external-image.svg", "SVG_EXTERNAL_RESOURCE"],
    ["external-css.svg", "SVG_ACTIVE_CSS"],
    ["doctype.svg", "SVG_DTD_FORBIDDEN"],
    ["huge-dimensions.svg", "SVG_DIMENSION_TOO_LARGE"],
    ["extreme-aspect.svg", "SVG_ASPECT_RATIO"],
    ["css-xml-comment.svg", "SVG_CSS_COMMENT"],
    ["css-image-set.svg", "SVG_EXTERNAL_RESOURCE"],
  ]);
  for (const [name, code] of expectedCodes) {
    const response = await convert(fixture("malicious", name), { fileName: name });
    check(`恶意夹具 ${name}`, response.status === 422 && response.json?.error === code, `status=${response.status} error=${response.json?.error ?? null}`);
  }

  const bomb = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${'<rect width="1" height="1"/>'.repeat(DEFAULT_LIMITS.maxElements + 1)}</svg>`);
  const bombResponse = await convert(bomb, { fileName: "element-bomb.svg" });
  check("内存 / 元素炸弹预检拒绝", bombResponse.status === 422 && bombResponse.json?.error === "SVG_ELEMENT_LIMIT", `status=${bombResponse.status}`);

  check("非法 MIME 返回 415", (await convert(fixture("normal", "basic-shapes.svg"), { mime: "image/png" })).status === 415);
  check("非 image target 返回 501", (await convert(fixture("normal", "basic-shapes.svg"), { target: "pdf" })).status === 501);
  check("缺少 target 返回 400", (await convert(fixture("normal", "basic-shapes.svg"), { target: null })).status === 400);
  check("超长 Content-Length 返回 413", (await hugeContentLength()) === 413);

  await pixelLimitChecks();
  await timeoutAndResidueChecks();
  await sandboxChecks();

  const passed = results.filter((item) => item.state === "PASS").length;
  const failed = results.filter((item) => item.state === "FAIL").length;
  const skipped = results.filter((item) => item.state === "SKIP").length;
  process.stdout.write(`\n${passed} PASS / ${failed} FAIL / ${skipped} SKIP\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  record("selfcheck 执行", "FAIL", error instanceof Error ? error.message : String(error));
  process.stdout.write(`\n0 PASS / 1 FAIL / 0 SKIP\n`);
  process.exitCode = 1;
});
