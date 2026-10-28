#!/usr/bin/env node
/**
 * M4-05 压测（S7·file 预览管道出口验证 · PoC-1 报告骨架；真 PG + 真对象存储 + 真 api + 真 worker ×N + 真转换沙箱）：
 *   证据 0（配置与适用边界）：转换沙箱 /healthz 的限额（timeoutMs / maxConcurrency / maxQueue / maxBytes）与
 *           `deploy/preview/.env` 的声明值逐项比对；`docker inspect` 登记内存 / CPU / pids / OOM / 重启次数。
 *   证据 A（转换成功率 · PoC-1 硬项）：合成样本集（docx / xlsx / pdf / png × S/M/L）走真实上传 → 定档触发预生成 →
 *           轮询终态；整体与分类成功率（≥95% 门槛）；中文不乱码抽样（产物含内嵌 CJK 字体标记）。
 *   证据 B（并发与背压）：串行基线时延 → 并发提交（burst）→ 队列排空；healthz 的 inflight / queued 采样证明
 *           并发上限被遵守；三元组幂等（同内容并发 8 份 → 只转一次）；沙箱边界探针（直连 /convert 打满并发 + 队列
 *           → 503 SERVICE_BUSY，沙箱不崩）。
 *   证据 C（200MB 级 · PoC-1 续传演示）：分片并发直传 → 中断（只传部分）→ 会话状态报缺 → 只补缺片 → complete
 *           （哈希一致 + 回读逐字节一致）→ 秒传命中；转换侧 = 超 `PREVIEW_CONVERT_MAX_SOURCE_MB` 的**确定性降级**
 *           （failed + outbox dead + download-url 可用），**不占成功率分母**。
 *   证据 D（读面并发）：/preview + /download-url 混合并发读 → 时延分位与审计口径（2026-10-23 起预览 / download 均一条一次）。
 *   证据 E（长跑与内存曲线）：循环小样本 + 周期采样 api / worker（宿主进程 RSS）与转换器容器（docker stats）；
 *           断言无重启 / 无 OOM、峰值不越限额、尾段无泄漏趋势。
 *   证据 F（对账与零残留）：preview_artifacts 行数 = 唯一三元组数；outbox 无 stuck；清理后项目 / 对象 / 会话零残留。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 已起 api（BASE_URL）+ **N 个 worker 实例**
 *       （`OUTBOX_POLL_MS=1000`、`OUTBOX_BATCH_LIMIT=4` 起） + 转换沙箱（deploy/preview，默认 http://127.0.0.1:9900）。
 *       并发档位 = worker 实例数（PreviewService 单实例串行消费）：1 / 2 / 4 档；转换器侧 in-flight 上限由沙箱
 *       `CONVERT_MAX_CONCURRENCY` 决定（沙箱默认 2；ADR-013 生产档 2~4 —— 见 --label 与证据头登记）。
 *       本脚本只在本地沙箱 / 联调库跑：铸临时管理员会话（跑完撤销）、建 M4ST- 压测项目（跑完硬删项目及其文件 /
 *       版本 / 会话 / 关联 / 产物 / 审计 / outbox 事件 + 清桶内 projects/ 与本次 contentHash 的 previews/ 前缀）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-05-stress.mjs [--label <档位名>] [--workers 4] [--burst 8] \
 *         [--profile full|smoke] [--samples <dir>：真实业务样本复跑（层 = R）] [--long-run-min 20] [--skip-long-run] [--skip-large] [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M4_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL =
  args.databaseUrl ?? process.env.M4_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const CONVERTER_URL = args.converter ?? process.env.PREVIEW_CONVERTER_URL ?? "http://127.0.0.1:9900";
const CONVERTER_CONTAINER = args.container ?? process.env.M4_CONVERTER_CONTAINER ?? "libiaolink-preview-converter";
const MI_B = 1024 * 1024;
/** 十类成果文件字典之一（非字典值会被契约 400 拦下）。 */
const DOC_TYPE = "技术协议";
/** worker 真消费的主题（与 `server/src/modules/file/preview.job.ts` 同值）：F2 的「无 stuck」只对该主题成立。 */
const PREVIEW_JOB_TOPIC = "preview.job";
const LARGE_BYTES = 200 * MI_B;
const PART_BYTES = 8 * MI_B;
const PROFILE = args.profile ?? "full";
const WORKERS = Number(args.workers ?? process.env.M4_STRESS_WORKERS ?? 1);
const BURST = Number(args.burst ?? process.env.M4_STRESS_BURST ?? Math.max(WORKERS, 2));
const LONG_RUN_MIN = Number(args.longRunMin ?? process.env.M4_STRESS_LONG_RUN_MIN ?? 20);
const TERMINAL_TIMEOUT_MS = 8 * 60_000;
const report = [];
const evidence = { steps: [], samples: [], waves: {}, health: {}, memory: { points: [] }, success: {}, large: {}, read: {}, reconciliations: {}, limits: {} };
let failures = 0;
let db;
let admin;
let adminId;
let storage;
let rawClient;
let s3Module;
let project;
let projectCode = "";
let limits = {};
let apiPidList = [];
let label = args.label ?? "（未命名档位）";
const cleanup = { projectIds: [], sessions: [], contentHashes: new Set() };
// ---------- 通用 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--converter") out.converter = argv[++i];
    else if (item === "--container") out.container = argv[++i];
    else if (item === "--label") out.label = argv[++i];
    else if (item === "--workers") out.workers = argv[++i];
    else if (item === "--burst") out.burst = argv[++i];
    else if (item === "--profile") out.profile = argv[++i];
    else if (item === "--samples") out.samples = argv[++i];
    else if (item === "--long-run-min") out.longRunMin = argv[++i];
    else if (item === "--skip-long-run") out.skipLongRun = true;
    else if (item === "--skip-large") out.skipLarge = true;
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
function formatBytes(bytes) {
  if (bytes >= MI_B) return (bytes / MI_B).toFixed(2) + " MiB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return bytes + " B";
}
function short(value, max = 320) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "…" : text;
}

async function makeSession(userId, idToken) {
  const session = { userId, token: "m4st-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '4 hours')", [
    sha256(session.token),
    userId,
    idToken,
  ]);
  return session;
}

async function call(method, path, body, session, extraHeaders = {}) {
  const actor = session === null ? null : session ?? admin;
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (actor !== null) {
    headers.cookie = "ll_sid=" + actor.token + "; ll_csrf=" + actor.csrf;
    headers["x-csrf-token"] = actor.csrf;
  }
  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}

function check(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) throw new Error("M4-05 压测失败（" + id + "）：" + title);
}

function softCheck(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
}

function makeParts(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
    parts.push(bytes.subarray(offset, Math.min(offset + PART_BYTES, bytes.length)));
  }
  return parts;
}

async function putPart(url, body) {
  const response = await fetch(url, { method: "PUT", body });
  const payload = Buffer.from(await response.arrayBuffer());
  return { status: response.status, etag: response.headers.get("etag"), text: response.ok ? "" : payload.toString("utf8").slice(0, 300) };
}

/** 走真实上传管道（init → 分片直传 → complete）；parts 可指定子集（断点续传）。 */
async function uploadFile({ projectId, name, bytes, docType, parts: partList }) {
  const allParts = makeParts(bytes);
  const contentHash = sha256(bytes);
  cleanup.contentHashes.add(contentHash);
  const init = await call("POST", "/api/v1/files/uploads", {
    projectId,
    name,
    sizeBytes: bytes.length,
    contentHash,
    docType,
    intent: "version",
  }, admin);
  const fileId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  if (fileId === undefined || uploadId === undefined) {
    return { init, fileId, uploadId, contentHash, parts: allParts.length, completed: { status: 0, body: null } };
  }
  const indexes = partList ?? allParts.map((_unused, index) => index + 1);
  const signed = await call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts", { partNumbers: indexes }, admin);
  for (let i = 0; i < indexes.length; i += 1) {
    const index = indexes[i];
    await putPart(signed.body.parts[i].url, allParts[index - 1]);
  }
  const completed = partList === undefined
    ? await call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", { contentHash }, admin)
    : null;
  return { init, fileId, uploadId, contentHash, parts: allParts.length, completed };
}

async function completeUpload(fileId, uploadId, contentHash) {
  return call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", { contentHash }, admin);
}

const finalizeFile = (fileId, version) => call("POST", "/api/v1/files/" + fileId + "/finalize", { version }, admin);
const previewOf = (fileId, versionId) =>
  call("GET", "/api/v1/files/" + fileId + "/preview?" + (versionId === undefined ? "" : "versionId=" + versionId + "&") + "recordView=true", undefined, admin);
const downloadUrlOf = (fileId, versionId) =>
  call("GET", "/api/v1/files/" + fileId + "/versions/" + versionId + "/download-url", undefined, admin);

async function auditOf(projectId, action) {
  const rows = await db.query(
    "select action, object_type, object_id, project_id, metadata, summary, result from audit_logs where project_id = $1 and action = $2 order by occurred_at",
    [projectId, action],
  );
  return rows.rows;
}

async function fetchSigned(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, hash: sha256(bytes), disposition: response.headers.get("content-disposition") };
}

/** 流式哈希（200MB 级回读不整块进内存）。 */
async function fetchSignedStreamHash(url) {
  const response = await fetch(url);
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    total += chunk.length;
  }
  return { status: response.status, bytes: total, hash: hash.digest("hex") };
}

async function purgePrefix(prefix) {
  let keyMarker;
  let versionIdMarker;
  do {
    const listed = await rawClient.send(
      new s3Module.ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
    );
    const targets = [
      ...(listed.Versions ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
      ...(listed.DeleteMarkers ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
    ].filter((item) => item.Key !== undefined && item.Key.startsWith(prefix));
    for (let index = 0; index < targets.length; index += 500) {
      await rawClient.send(new s3Module.DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: targets.slice(index, index + 500) } }));
    }
    keyMarker = listed.IsTruncated === true ? listed.NextKeyMarker : undefined;
    versionIdMarker = listed.IsTruncated === true ? listed.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
}

async function converterHealth() {
  try {
    const response = await fetch(CONVERTER_URL + "/healthz", { signal: AbortSignal.timeout(5000) });
    return await response.json();
  } catch {
    return null;
  }
}

function dockerInspect() {
  try {
    const raw = execFileSync("docker", ["inspect", CONVERTER_CONTAINER], { encoding: "utf8" });
    const info = JSON.parse(raw)[0];
    return {
      memLimitBytes: info.HostConfig.Memory,
      nanoCpus: info.HostConfig.NanoCpus,
      pidsLimit: info.HostConfig.PidsLimit,
      oomKilled: info.State.OOMKilled,
      restarts: info.RestartCount,
      running: info.State.Running,
      startedAt: info.State.StartedAt,
      image: info.Config.Image,
    };
  } catch {
    return null;
  }
}

function dockerStats() {
  try {
    const raw = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}", CONVERTER_CONTAINER], { encoding: "utf8" }).trim();
    const [mem, cpu, pids] = raw.split("|");
    const match = /^([\d.]+)([KMGi]+B?) \/ ([\d.]+)([KMGi]+B?)$/.exec(mem ?? "");
    const toMiB = (value, unit) => {
      const n = Number(value);
      if (unit.startsWith("Gi")) return n * 1024;
      if (unit.startsWith("Mi")) return n;
      if (unit.startsWith("Ki")) return n / 1024;
      return n / (1024 * 1024);
    };
    return {
      memUsedMiB: match === null ? null : toMiB(match[1], match[2]),
      memLimitMiB: match === null ? null : toMiB(match[3], match[4]),
      cpuPercent: cpu === undefined ? null : Number(cpu.replace("%", "")),
      pids: pids === undefined ? null : Number(pids),
    };
  } catch {
    return null;
  }
}

/** 宿主进程 RSS（api / worker）：Windows 走 PowerShell Get-Process，其它平台走 ps。 */
/**
 * 容器 cgroup v2 的内存计数（`memory.peak` = **自容器启动以来的真实峰值**，含 page cache）。
 * 为什么不用 `docker stats`：那是 10s 一次的瞬时值，抓不到 soffice 的短时峰值，且把 page cache 混在里面 ——
 * 「峰值不越限额」这条只有 cgroup 计数器能证（preview-converter 镜像的 cgroup v2 始终挂载，读不到则返回 null 并降级）。
 */
function containerMemCgroup() {
  try {
    const raw = execFileSync("docker", ["exec", CONVERTER_CONTAINER, "cat", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.max"], { encoding: "utf8" });
    const [current, peak, max] = raw.trim().split(/\s+/).map((value) => Number(value));
    if (!Number.isFinite(current) || !Number.isFinite(peak) || !Number.isFinite(max)) return null;
    return { currentBytes: current, peakBytes: peak, maxBytes: max };
  } catch {
    return null;
  }
}

function discoverRuntimePids() {
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("bash", ["-lc", "ps -eo pid,args | grep -E 'dist/entry/(api|worker)\\.js' | grep -v grep"], { encoding: "utf8" });
      return out.trim().split("\n").filter(Boolean).map((line) => {
        const [pid, ...rest] = line.trim().split(/\s+/);
        return { pid: Number(pid), kind: rest.join(" ").includes("worker.js") ? "worker" : "api" };
      });
    } catch {
      return [];
    }
  }
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item) => typeof item.CommandLine === "string" && /dist[\\/]entry[\\/](api|worker)\.js/.test(item.CommandLine))
      .map((item) => ({ pid: item.ProcessId, kind: /worker\.js/.test(item.CommandLine) ? "worker" : "api" }));
  } catch {
    return [];
  }
}

function sampleRss(pids) {
  if (pids.length === 0) return {};
  if (process.platform !== "win32") {
    const out = {};
    for (const item of pids) {
      try {
        const raw = execFileSync("ps", ["-o", "rss=", "-p", String(item.pid)], { encoding: "utf8" }).trim();
        out[item.pid] = Number(raw) * 1024;
      } catch {
        out[item.pid] = null;
      }
    }
    return out;
  }
  const script = "Get-Process -Id " + pids.map((item) => item.pid).join(",") + " -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress";
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    if (raw === "") return {};
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const out = {};
    for (const item of list) out[item.Id] = item.WorkingSet64;
    return out;
  } catch {
    return {};
  }
}

function tailSlopePerMinute(points, valueKey) {
  const usable = points.filter((point) => typeof point[valueKey] === "number");
  if (usable.length < 6) return null;
  const tail = usable.slice(Math.floor(usable.length / 3));
  const n = tail.length;
  const meanX = tail.reduce((sum, point) => sum + point.t, 0) / n;
  const meanY = tail.reduce((sum, point) => sum + point[valueKey], 0) / n;
  let num = 0;
  let den = 0;
  for (const point of tail) {
    num += (point.t - meanX) * (point[valueKey] - meanY);
    den += (point.t - meanX) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 60_000;
}
// ---------- 合成样本生成器（零依赖：ZIP / DOCX / XLSX / PNG / PDF 手写容器；已用真转换器探针验证） ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 6 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, compressed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(compressed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}
function xmlEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const CJK_POOL = "机械设计图纸技术协议评审记录采购安装调试验收项目进度质量安全成本控制供应商合同变更申请定档归档预览下载公告会议纪要整改闭环节点门禁交付成果物";
function randomCjk(rng, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += CJK_POOL[Math.floor(rng() * CJK_POOL.length)];
  return out;
}
function genDocx(paragraphs) {
  const body = paragraphs.map((p) => '<w:p><w:r><w:t xml:space="preserve">' + xmlEscape(p) + "</w:t></w:r></w:p>").join("");
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  return zip([["[Content_Types].xml", contentTypes], ["_rels/.rels", rels], ["word/document.xml", document]]);
}
function genXlsx(rows) {
  const sheetRows = rows.map((cells, ri) => '<row r="' + (ri + 1) + '">' + cells.map((cell, ci) => {
    const ref = String.fromCharCode(65 + (ci % 26)) + (ri + 1);
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(cell) + "</t></is></c>";
  }).join("") + "</row>").join("");
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + "</sheetData></worksheet>";
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    "</Relationships>";
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    "</Types>";
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  return zip([["[Content_Types].xml", contentTypes], ["_rels/.rels", rels], ["xl/workbook.xml", workbook], ["xl/_rels/workbook.xml.rels", workbookRels], ["xl/worksheets/sheet1.xml", sheet]]);
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function genPng(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p++] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[p++] = (x + seed) % 256;
      raw[p++] = (y * 2 + seed) % 256;
      raw[p++] = (x + y + seed * 3) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function genPdf(pageCount, linesPerPage) {
  const objects = [];
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    const lines = [];
    for (let l = 0; l < linesPerPage; l += 1) {
      const y = 800 - (l % 45) * 17;
      lines.push("BT /F1 11 Tf 60 " + y + " Td (Stress sample page " + (i + 1) + " line " + (l + 1) + " , " + (i * linesPerPage + l) + ") Tj ET");
    }
    const stream = lines.join("\n");
    objects.push({ id: 4 + i * 2, body: "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream" });
    objects.push({ id: 5 + i * 2, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents " + (4 + i * 2) + " 0 R >>" });
    kids.push((5 + i * 2) + " 0 R");
  }
  objects.push({ id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });
  objects.push({ id: 2, body: "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pageCount + " >>" });
  objects.push({ id: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  objects.sort((a, b) => a.id - b.id);
  let out = "%PDF-1.4\n";
  const offsets = {};
  for (const obj of objects) {
    offsets[obj.id] = out.length;
    out += obj.id + " 0 obj\n" + obj.body + "\nendobj\n";
  }
  const xrefStart = out.length;
  const maxId = objects[objects.length - 1].id;
  out += "xref\n0 " + (maxId + 1) + "\n0000000000 65535 f \n";
  for (let id = 1; id <= maxId; id += 1) out += String(offsets[id] ?? 0).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + (maxId + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}
// ---------- 样本集（分层尺寸，全部已验证可转换；唯一内容避免三元组缓存串味） ----------
const LAYER_TARGETS = {
  docx: { S: 120 * 1024, M: 1.0 * MI_B, L: 3.5 * MI_B },
  xlsx: { S: 120 * 1024, M: 2.7 * MI_B, L: 10 * MI_B },
  pdf: { S: 24 * 1024, M: 0.75 * MI_B, L: 5.4 * MI_B },
  png: { S: 600 * 1024, M: 2 * MI_B, L: 6 * MI_B },
};
const DOCX_SECTION = "机械设计图纸 / 技术协议 / 合同评审单：中文排版样例，用于验证转换沙箱的中文字体映射与产物可用性。";

function grow(target, make, initial) {
  let n = initial;
  let buf = make(n);
  for (let i = 0; i < 8 && buf.length < target; i += 1) {
    n = Math.ceil(n * (target / Math.max(buf.length, 1)) * 1.03);
    buf = make(n);
  }
  return { n, buf };
}

function buildSampleBytes(entry, marker) {
  const rng = makeRng(entry.seed);
  if (entry.type === "docx") {
    const built = grow(entry.target, (n) => genDocx(Array.from({ length: n }, (_unused, i) => "样例 " + marker + " 第 " + (i + 1) + " 段：" + randomCjk(rng, 200) + " " + DOCX_SECTION)), 40);
    return { bytes: built.buf, units: built.n + " 段" };
  }
  if (entry.type === "xlsx") {
    const built = grow(entry.target, (n) => genXlsx(Array.from({ length: n }, (_unused, r) => ["行" + (r + 1), randomCjk(rng, 28), randomCjk(rng, 28), String(1000 + (r % 9000)) + "." + String(r % 100)])), 40);
    return { bytes: built.buf, units: built.n + " 行" };
  }
  if (entry.type === "pdf") {
    const pages = Math.max(1, Math.ceil(entry.target / 2900));
    return { bytes: genPdf(pages, 50), units: pages + " 页" };
  }
  let side = Math.max(64, Math.round(Math.sqrt(entry.target / 0.2 / 3)));
  let buf = genPng(side, side, entry.seed % 251);
  for (let i = 0; i < 4 && Math.abs(buf.length - entry.target) / entry.target > 0.25; i += 1) {
    side = Math.max(64, Math.round(side * Math.sqrt(entry.target / buf.length)));
    buf = genPng(side, side, entry.seed % 251);
  }
  return { bytes: buf, units: side + "×" + side };
}

function samplePlan() {
  // smoke = 每类每层 2 份（24 份：基线 12 + 并发 12）—— 少一份则 burst 为空、B2（inflight 打满）无从成立。
  const counts = PROFILE === "smoke" ? { S: 2, M: 2, L: 2 } : { S: 4, M: 4, L: 4 };
  const plan = [];
  let index = 0;
  for (const type of ["docx", "xlsx", "pdf", "png"]) {
    for (const layer of ["S", "M", "L"]) {
      for (let i = 0; i < counts[layer]; i += 1) {
        index += 1;
        const id = type + layer + String(i + 1);
        plan.push({ id, type, layer, seed: 20260924 + index * 7919, target: LAYER_TARGETS[type][layer], name: "压测-" + id + "." + type, baseline: i === 0 });
      }
    }
  }
  return plan;
}

/** 真实业务样本（--samples <dir>）：docx / xlsx / pdf / png 各按文件原名入样（层 = R）；用于 PoC-1 的版式保真 / Excel 分页 / 复杂字体回退复跑。 */
function loadRealSamples(dir) {
  const SUFFIX = { docx: "docx", xlsx: "xlsx", pdf: "pdf", png: "png" };
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    throw new Error("--samples 目录不可读：" + dir + "（" + error.message + "）");
  }
  const picked = names
    .map((name) => ({ name, type: SUFFIX[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] }))
    .filter((item) => item.type !== undefined);
  if (picked.length === 0) throw new Error("--samples 目录内没有 docx / xlsx / pdf / png 样本：" + dir);
  return picked.map((item, index) => ({
    id: "real-" + String(index + 1).padStart(2, "0"),
    type: item.type,
    layer: "R",
    name: "真实-" + item.name,
    bytes: readFileSync(join(dir, item.name)),
    units: "real",
    marker: null,
    real: true,
  }));
}

function parseEnvFile(path) {
  const map = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null) map[match[1]] = match[2];
  }
  return map;
}

// ---------- 主流程 ----------
try {
  // 证据 0：依赖与配置
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    const storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
    evidence.limits.serverEnv = {
      previewConverterUrl: env.PREVIEW_CONVERTER_URL,
      pipelineVersion: env.PREVIEW_PIPELINE_VERSION,
      convertTimeoutMs: env.PREVIEW_CONVERT_TIMEOUT_MS,
      maxAttempts: env.PREVIEW_CONVERT_MAX_ATTEMPTS,
      backoffMs: env.PREVIEW_CONVERT_BACKOFF_MS,
      maxSourceMb: env.PREVIEW_CONVERT_MAX_SOURCE_MB,
      outboxPollMs: env.OUTBOX_POLL_MS,
      outboxBatchLimit: env.OUTBOX_BATCH_LIMIT,
      uploadMaxSizeMb: env.UPLOAD_MAX_SIZE_MB,
    };
  } catch (error) {
    throw new Error("无法加载 dist / S3 环境（先 npm run build，并用 --env-file-if-exists=.env 带上 S3_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const healthz = await converterHealth();
  const inspect = dockerInspect();
  const previewDir = join(serverRoot, "..", "deploy", "preview");
  const sandboxEnvPath = join(previewDir, existsSync(join(previewDir, ".env")) ? ".env" : ".env.example");
  const sandboxEnv = parseEnvFile(sandboxEnvPath);
  evidence.limits.sandboxEnvFile = sandboxEnvPath;
  evidence.limits.sandbox = {
    maxConcurrency: Number(sandboxEnv.PREVIEW_CONVERT_MAX_CONCURRENCY),
    maxQueue: Number(sandboxEnv.PREVIEW_CONVERT_MAX_QUEUE),
    timeoutMs: Number(sandboxEnv.PREVIEW_CONVERT_TIMEOUT_MS),
    maxBytes: Number(sandboxEnv.PREVIEW_CONVERT_MAX_BYTES),
    memLimit: sandboxEnv.PREVIEW_CONVERTER_MEM_LIMIT,
    cpus: sandboxEnv.PREVIEW_CONVERTER_CPUS,
    pids: sandboxEnv.PREVIEW_CONVERTER_PIDS,
    tmpfs: sandboxEnv.PREVIEW_CONVERTER_TMPFS,
    tag: sandboxEnv.PREVIEW_CONVERTER_TAG,
  };
  evidence.limits.converterHealth = healthz;
  evidence.limits.dockerInspect = inspect;

  check("X0", "转换沙箱可用（/healthz ok）+ 管线版本与 server 配置同值", "ok=true + pipelineVersion=" + evidence.limits.serverEnv.pipelineVersion + " + cjkReady=true",
    short({ ok: healthz?.ok, pipelineVersion: healthz?.pipelineVersion, cjkReady: healthz?.fonts?.cjkReady, engine: healthz?.engine?.version }, 260),
    healthz?.ok === true && healthz?.pipelineVersion === evidence.limits.serverEnv.pipelineVersion && healthz?.fonts?.cjkReady === true);

  const l = healthz.limits;
  check("X1", "沙箱限额与 deploy/preview 声明值一致（证据头登记档位）", "timeout/concurrency/queue/maxBytes = " + [sandboxEnv.PREVIEW_CONVERT_TIMEOUT_MS, sandboxEnv.PREVIEW_CONVERT_MAX_CONCURRENCY, sandboxEnv.PREVIEW_CONVERT_MAX_QUEUE, sandboxEnv.PREVIEW_CONVERT_MAX_BYTES].join(" / "),
    short({ timeoutMs: l.timeoutMs, maxConcurrency: l.maxConcurrency, maxQueue: l.maxQueue, maxBytes: l.maxBytes, memLimit: sandboxEnv.PREVIEW_CONVERTER_MEM_LIMIT, cpus: sandboxEnv.PREVIEW_CONVERTER_CPUS }, 260),
    l.timeoutMs === Number(sandboxEnv.PREVIEW_CONVERT_TIMEOUT_MS) && l.maxConcurrency === Number(sandboxEnv.PREVIEW_CONVERT_MAX_CONCURRENCY) && l.maxQueue === Number(sandboxEnv.PREVIEW_CONVERT_MAX_QUEUE) && l.maxBytes === Number(sandboxEnv.PREVIEW_CONVERT_MAX_BYTES));

  check("X2", "容器限额（2C / 内存 / pids）与声明一致 + 无 OOM + 重启 0", "mem=" + sandboxEnv.PREVIEW_CONVERTER_MEM_LIMIT + " cpus=" + sandboxEnv.PREVIEW_CONVERTER_CPUS + " oom=false restarts=0",
    short({ memLimitBytes: inspect?.memLimitBytes, nanoCpus: inspect?.nanoCpus, pidsLimit: inspect?.pidsLimit, oomKilled: inspect?.oomKilled, restarts: inspect?.restarts, image: inspect?.image }, 260),
    inspect !== null && inspect.memLimitBytes === Number(String(sandboxEnv.PREVIEW_CONVERTER_MEM_LIMIT).replace(/g$/i, "")) * 1024 * MI_B && inspect.oomKilled === false && inspect.restarts === 0);


  const apiHealth = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  const apiReady = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("X3", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", apiHealth + " / " + apiReady, apiHealth === 200 && apiReady === 200);

  apiPidList = discoverRuntimePids();
  const workerCount = apiPidList.filter((item) => item.kind === "worker").length;
  evidence.limits.workers = { api: apiPidList.filter((item) => item.kind === "api").map((item) => item.pid), worker: apiPidList.filter((item) => item.kind === "worker").map((item) => item.pid) };
  check("X4", "worker 实例数 = 本次并发档位（--workers 登记值）", "worker 实例 " + WORKERS + " 个", "发现 " + workerCount + " 个（pids=" + evidence.limits.workers.worker.join(",") + "）", workerCount === WORKERS);

  const memCgroupStart = containerMemCgroup();
  evidence.limits.converterMem = { peakStartMiB: memCgroupStart === null ? null : Number((memCgroupStart.peakBytes / MI_B).toFixed(1)), maxMiB: memCgroupStart === null ? null : Number((memCgroupStart.maxBytes / MI_B).toFixed(0)), source: "cgroup v2 memory.peak（容器启动至今的真实峰值）" };
  softCheck("X5", "容器 cgroup v2 内存计数可读（`memory.peak` = 自容器启动的真实峰值，用于「峰值 ≤ 限额」判定）", "可读（读不到时降级为 docker stats 采样）",
    short(memCgroupStart ?? {}, 200), memCgroupStart !== null,
    "容器重建 = 峰值从当前用量起算，故本档判定要求重建后同一容器内跑完");

  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  admin = await makeSession(adminId, "m4st-stress-admin");
  cleanup.sessions.push(admin.token);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  projectCode = "M4ST-" + stamp;
  const created = await call("POST", "/api/v1/projects", { code: projectCode, name: "M4-05 压测项目", projectType: "default", managerIds: [adminId] });
  check("P1", "建压测项目（file 的 projectId 容器）", "201", short({ status: created.status, code: created.body?.code, id: created.body?.id }, 160), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  // ---------- 证据 A：样本集构建 ----------
  const plan = samplePlan();
  const samples = [];
  for (const entry of plan) {
    const marker = entry.id + "-" + randomBytes(3).toString("hex");
    const built = buildSampleBytes(entry, marker);
    samples.push({ ...entry, bytes: built.bytes, units: built.units, marker });
  }
  const realSamples = args.samples === undefined ? [] : loadRealSamples(args.samples);
  samples.push(...realSamples);
  const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes.length, 0);
  const byTypeLayer = {};
  for (const sample of samples) {
    const key = sample.type + "/" + sample.layer;
    byTypeLayer[key] = byTypeLayer[key] ?? { count: 0, bytes: 0 };
    byTypeLayer[key].count += 1;
    byTypeLayer[key].bytes += sample.bytes.length;
  }
  evidence.samples = samples.map((sample) => ({ id: sample.id, type: sample.type, layer: sample.layer, name: sample.name, bytes: sample.bytes.length, units: sample.units }));
  const syntheticCount = samples.length - realSamples.length;
  check("A0", (realSamples.length === 0 ? "合成样本集就位" : "合成 + 真实样本集就位") + "（" + PROFILE + " 档：" + syntheticCount + " 份合成" + (realSamples.length === 0 ? "" : " + " + realSamples.length + " 份真实") + " / " + formatBytes(totalBytes) + "）",
    "docx / xlsx / pdf / png × S/M/L 分层" + (realSamples.length === 0 ? "" : " + 真实样本（层 R）"),
    short(byTypeLayer, 400), syntheticCount >= 12 && samples.every((sample) => sample.bytes.length > 1024));

  async function uploadAndFinalize(sample) {
    const uploaded = await uploadFile({ projectId: project, name: sample.name, bytes: sample.bytes, docType: DOC_TYPE });
    const fileId = uploaded.fileId;
    const versionId = uploaded.completed.body?.version?.id;
    const versionNumber = uploaded.completed.body?.file?.version;
    sample.fileId = fileId;
    sample.versionId = versionId;
    sample.contentHash = uploaded.contentHash;
    sample.uploadedAt = Date.now();
    if (uploaded.completed.status !== 200) {
      sample.uploadError = short(uploaded.init?.body ?? uploaded.completed.body ?? null, 240);
      sample.finalizeStatus = 0;
      sample.terminalStatus = "upload_failed";
      return sample;
    }
    const finalized = await finalizeFile(fileId, versionNumber);
    sample.finalizeStatus = finalized.status;
    sample.finalizedAt = Date.now();
    if (finalized.status !== 200) sample.terminalStatus = "finalize_failed";
    return sample;
  }

  async function waitTerminal(sample, timeoutMs = TERMINAL_TIMEOUT_MS) {
    if (sample.terminalStatus !== undefined) return sample;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await previewOf(sample.fileId, sample.versionId);
      const status = response.body?.status;
      if (status === "ready" || status === "failed") {
        sample.terminalStatus = status;
        sample.terminalAt = Date.now();
        sample.latencyMs = sample.terminalAt - sample.finalizedAt;
        sample.previewTarget = response.body?.target ?? null;
        sample.url = response.body?.url ?? null;
        return sample;
      }
      await sleep(1000);
    }
    sample.terminalStatus = "timeout";
    sample.terminalAt = Date.now();
    sample.latencyMs = sample.terminalAt - sample.finalizedAt;
    return sample;
  }

  // ---------- 证据 1：串行基线（12 份：类型 × 分层） ----------
  const baseline = samples.filter((sample) => sample.baseline === true);
  for (const sample of baseline) {
    await uploadAndFinalize(sample);
    await waitTerminal(sample);
  }
  const baselineReady = baseline.filter((sample) => sample.terminalStatus === "ready");
  const baselineLatency = baselineReady.map((sample) => sample.latencyMs);
  check("A1", "串行基线（" + baseline.length + " 份：docx / xlsx / pdf / png × S/M/L）全部就绪 + 时延入库", "全部 ready；p95 ≤ " + (PROFILE === "full" ? 45000 : 60000) + " ms",
    short({ ready: baselineReady.length + "/" + baseline.length, p50: percentile(baselineLatency, 50), p95: percentile(baselineLatency, 95), max: baselineLatency.length === 0 ? null : Math.max(...baselineLatency), detail: baselineReady.map((sample) => sample.id + "=" + sample.latencyMs + "ms"), errors: baseline.filter((sample) => sample.terminalStatus !== "ready").map((sample) => sample.id + ":" + (sample.uploadError ?? sample.terminalStatus)) }, 420),
    baselineReady.length === baseline.length && (percentile(baselineLatency, 95) ?? 0) <= (PROFILE === "full" ? 45000 : 60000),
    "基线 = 单件串行、无排队；时延 = finalize 响应 → 预览终态（含 worker 轮询间隔）");

  // ---------- 真实业务样本（--samples <dir>）：串行复跑，计入 A2 成功率（不计入 A1 的「合成基线全就绪」严格项） ----------
  for (const sample of realSamples) {
    await uploadAndFinalize(sample);
    await waitTerminal(sample);
  }

  // ---------- 证据 2：并发提交（burst）+ 队列排空 + inflight / queued 采样 ----------
  const burstSamples = samples.filter((sample) => sample.baseline !== true && sample.real !== true);
  const healthPoints = [];
  let samplerStop = false;
  const sampler = (async () => {
    while (samplerStop === false) {
      const snapshot = await converterHealth();
      if (snapshot !== null) healthPoints.push({ t: Date.now(), inflight: snapshot.limits.inflight, queued: snapshot.limits.queued });
      await sleep(1000);
    }
  })();
  const burstStart = Date.now();
  let cursor = 0;
  while (cursor < burstSamples.length) {
    const batch = burstSamples.slice(cursor, cursor + BURST);
    cursor += batch.length;
    await Promise.all(batch.map((sample) => uploadAndFinalize(sample)));
  }
  const submitDoneAt = Date.now();
  for (const sample of burstSamples) await waitTerminal(sample);
  const drainDoneAt = Date.now();
  samplerStop = true;
  await sampler;
  const maxInflight = healthPoints.reduce((max, point) => Math.max(max, point.inflight), 0);
  const maxQueued = healthPoints.reduce((max, point) => Math.max(max, point.queued), 0);
  const burstReady = burstSamples.filter((sample) => sample.terminalStatus === "ready");
  const burstLatency = burstSamples.map((sample) => sample.latencyMs).filter((value) => typeof value === "number");
  evidence.waves.burst = { submitted: burstSamples.length, ready: burstReady.length, submitMs: submitDoneAt - burstStart, drainMs: drainDoneAt - submitDoneAt, maxInflight, maxQueued, p50: percentile(burstLatency, 50), p95: percentile(burstLatency, 95), healthPoints: healthPoints.length };
  check("B1", "并发提交（burst=" + BURST + " / worker=" + WORKERS + "）：全部终结且无超时", "全部 ready 或 failed（无 timeout）",
    short({ submitted: burstSamples.length, ready: burstReady.length, failed: burstSamples.filter((sample) => sample.terminalStatus === "failed").length, timeout: burstSamples.filter((sample) => sample.terminalStatus === "timeout").length, drainSec: Math.round((drainDoneAt - submitDoneAt) / 1000) }, 300),
    burstSamples.every((sample) => sample.terminalStatus === "ready" || sample.terminalStatus === "failed"));

  const declaredConcurrency = l.maxConcurrency;
  const expectSaturation = PROFILE === "full" || burstSamples.length >= WORKERS * 6;
  check("B2", "转换器 in-flight 被并发上限约束（healthz 采样）：maxInflight ≤ " + declaredConcurrency + " 且" + (expectSaturation === true ? "确实打满到 min(worker, 并发)" : "小样本档只判不越界"),
    "maxInflight = min(" + WORKERS + "," + declaredConcurrency + ") = " + Math.min(WORKERS, declaredConcurrency) + "（并发上限不被突破）",
    short({ maxInflight, maxQueued, declaredConcurrency, samples: healthPoints.length }, 260),
    maxInflight <= declaredConcurrency && (expectSaturation === false || maxInflight >= Math.min(WORKERS, declaredConcurrency)),
    "采样 = 提交 / 排空期间每秒 /healthz；queued 为转换器排队数（超过 maxQueue 才 503）；smoke 档 burst=" + burstSamples.length + " 打不满 min(worker, 并发) 属预期，只判「不越界」");

  // ---------- 证据 3：三元组幂等（同内容并发 8 份 → 只转一次） ----------
  const idemMarker = "IDEM-" + randomBytes(4).toString("hex");
  const idemBytes = genDocx(Array.from({ length: 120 }, (_unused, i) => "幂等样例 " + idemMarker + " 第 " + (i + 1) + " 段：" + DOCX_SECTION));
  const idemSamples = Array.from({ length: 8 }, (_unused, i) => ({ id: "I" + (i + 1), type: "docx", layer: "M", name: "压测-幂等-" + (i + 1) + ".docx", bytes: idemBytes, units: "120 段" }));
  await Promise.all(idemSamples.map((sample) => uploadAndFinalize(sample)));
  for (const sample of idemSamples) await waitTerminal(sample);
  const idemHash = sha256(idemBytes);
  cleanup.contentHashes.add(idemHash);
  const idemRows = await db.query("select count(*)::int as count from preview_artifacts where content_hash = $1 and status = 'ready'", [idemHash]);
  const idemObjects = await rawClient.send(new s3Module.ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: "previews/" + idemHash + "/" }));
  const idemObjectKeys = new Set([...(idemObjects.Versions ?? []).map((item) => item.Key), ...(idemObjects.DeleteMarkers ?? []).map((item) => item.Key)]);
  check("B3", "三元组幂等并发（同内容 8 份并发定档）：产物行 1 / 对象 1 / 8 份全部 ready", "ready 行 = 1 且对象键 = 1",
    short({ idemReady: idemSamples.filter((sample) => sample.terminalStatus === "ready").length, rows: idemRows.rows[0].count, objectKeys: [...idemObjectKeys].map((key) => String(key).slice(0, 60)) }, 400),
    idemSamples.every((sample) => sample.terminalStatus === "ready") && idemRows.rows[0].count === 1 && idemObjectKeys.size === 1,
    "D2-06「同一内容只转一次」在并发下成立；8 份各自秒级命中同一三元组");

  // ---------- 证据 4：沙箱边界探针（直连 /convert：打满并发 + 队列 → 503 SERVICE_BUSY，沙箱不崩） ----------
  if (PROFILE === "full") {
    const probeCount = declaredConcurrency + Number(sandboxEnv.PREVIEW_CONVERT_MAX_QUEUE) + 2;
    const probeBytes = genDocx(Array.from({ length: 40 }, (_unused, i) => "边界探针 " + i + " 段：" + DOCX_SECTION));
    const probeResults = await Promise.all(Array.from({ length: probeCount }, async (_unused, i) => {
      try {
        const response = await fetch(CONVERTER_URL + "/convert", {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "x-preview-target": "pdf", "x-file-name": encodeURIComponent("边界探针" + i + ".docx") },
          body: probeBytes,
          signal: AbortSignal.timeout(120000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, code: bytes.toString("utf8").slice(0, 80) };
      } catch (error) {
        return { status: 0, code: String(error).slice(0, 80) };
      }
    }));
    const busy = probeResults.filter((item) => item.status === 503).length;
    const okCount = probeResults.filter((item) => item.status === 200).length;
    const healthAfter = await converterHealth();
    check("B4", "沙箱边界（直连 /convert x " + probeCount + " = 并发 " + declaredConcurrency + " + 队列 " + sandboxEnv.PREVIEW_CONVERT_MAX_QUEUE + " + 2）：越界请求得 503 SERVICE_BUSY，沙箱不崩",
      "503 ≥ 1 + 200 ≥ 1 + 探针后 /healthz ok",
      short({ probeCount, status200: okCount, status503: busy, other: probeResults.filter((item) => item.status !== 200 && item.status !== 503).map((item) => item.status), healthAfter: healthAfter?.ok }, 300),
      busy >= 1 && okCount >= 1 && healthAfter?.ok === true,
      "直连探针不经 pipeline：证明「503 SERVICE_BUSY → worker 按可重试退避」这条降级链的触发面存在（pipeline 路径下 worker 串行 + 多实例不足以打满 2+8）");
  }
  // ---------- 证据 A2 / A3：成功率与中文不乱码 ----------
  const allForRate = [...samples, ...idemSamples];
  const artifactRows = await db.query(
    "select file_id, status, target, error from preview_artifacts where file_id = any($1::uuid[])",
    [allForRate.filter((sample) => sample.fileId !== undefined).map((sample) => sample.fileId)],
  );
  const artifactByFile = new Map(artifactRows.rows.map((row) => [row.file_id, row]));
  const rateStats = {};
  for (const sample of samples) {
    const key = sample.type + "/" + sample.layer;
    rateStats[key] = rateStats[key] ?? { total: 0, ready: 0, failed: 0, timeout: 0, reasons: [] };
    rateStats[key].total += 1;
    if (sample.terminalStatus === "ready") rateStats[key].ready += 1;
    else {
      rateStats[key].failed += 1;
      const artifact = artifactByFile.get(sample.fileId);
      rateStats[key].reasons.push(sample.id + ": " + short(artifact?.error ?? sample.terminalStatus, 120));
    }
  }
  const readyCount = samples.filter((sample) => sample.terminalStatus === "ready").length;
  const rate = samples.length === 0 ? 0 : readyCount / samples.length;
  evidence.success = { total: samples.length, ready: readyCount, rate, byTypeLayer: rateStats };
  check("A2", "转换成功率（PoC-1 硬项 ≥95%）：" + readyCount + "/" + samples.length + " = " + (rate * 100).toFixed(1) + "%", "≥ 95%（合成样本期望 100%" + (realSamples.length === 0 ? "" : "；真实样本 " + realSamples.length + " 份按业务实际") + "，未达 100% 的逐条归因）",
    short({ rate: (rate * 100).toFixed(1) + "%", ready: readyCount, total: samples.length, failures: samples.filter((sample) => sample.terminalStatus !== "ready").map((sample) => sample.id + ":" + short(sample.uploadError ?? artifactByFile.get(sample.fileId)?.error ?? sample.terminalStatus, 80)) }, 460),
    rate >= 0.95 && samples.length >= 12);

  const cjkCandidates = samples.filter((sample) => sample.terminalStatus === "ready" && (sample.type === "docx" || sample.type === "xlsx"));
  const cjkPick = cjkCandidates.slice(0, Math.max(4, Math.ceil(cjkCandidates.length * 0.2)));
  const cjkResults = [];
  for (const sample of cjkPick) {
    const fresh = await previewOf(sample.fileId, sample.versionId);
    if (fresh.status !== 200 || fresh.body?.url === null || fresh.body?.url === undefined) {
      cjkResults.push({ id: sample.id, ok: false, note: "无签名地址" });
      continue;
    }
    const product = await fetchSigned(fresh.body.url);
    const text = product.bytes.toString("latin1");
    cjkResults.push({ id: sample.id, ok: product.status === 200 && /FontFile2/.test(text) && /Noto/.test(text) && product.bytes.length > 10_000, bytes: product.bytes.length, embeddedFont: /FontFile2/.test(text), notoFont: /Noto/.test(text) });
  }
  check("A3", "中文不乱码（抽样 " + cjkPick.length + "/" + cjkCandidates.length + " 份 Office 产物）：内嵌 CJK 字体（Noto + FontFile2）", "全部产物含 FontFile2 与 Noto 字体标记",
    short(cjkResults, 420),
    cjkResults.length >= 4 && cjkResults.every((item) => item.ok === true),
    "与 M4-05b 容器自检（fonts.cjkReady + 中文乱码用例）同源口径；pdf / png 源为直通通道，不参与本项");

  // ---------- 证据 C：200MB 级（上传续传 + 秒传 + 转换确定性降级 + 读回一致） ----------
  if (args.skipLarge !== true) {
    const largeBuffer = Buffer.alloc(LARGE_BYTES);
    const block = randomBytes(64 * 1024);
    for (let offset = 0; offset < LARGE_BYTES; offset += block.length) block.copy(largeBuffer, offset);
    const largeHash = sha256(largeBuffer);
    cleanup.contentHashes.add(largeHash);
    const rssBefore = sampleRss(apiPidList.filter((item) => item.kind === "api"));
    const largeInit = await call("POST", "/api/v1/files/uploads", { projectId: project, name: "压测-200MB-超大样例.docx", sizeBytes: largeBuffer.length, contentHash: largeHash, docType: DOC_TYPE, intent: "version" }, admin);
    const largeFileId = largeInit.body?.file?.id;
    const largeUploadId = largeInit.body?.upload?.id;
    const largeParts = makeParts(largeBuffer);
    const firstBatch = largeParts.map((_unused, index) => index + 1).slice(0, 8);
    const signedFirst = await call("POST", "/api/v1/files/" + largeFileId + "/uploads/" + largeUploadId + "/parts", { partNumbers: firstBatch }, admin);
    const uploadStart = Date.now();
    for (let index = 0; index < firstBatch.length; index += 4) {
      await Promise.all(firstBatch.slice(index, index + 4).map((partNumber, offset) => putPart(signedFirst.body.parts[index + offset].url, largeParts[partNumber - 1])));
    }
    const view = await call("GET", "/api/v1/files/" + largeFileId + "/uploads/" + largeUploadId, undefined, admin);
    const uploadedSoFar = (view.body?.uploadedPartNumbers ?? []).length;
    const missing = view.body?.missingPartNumbers ?? [];
    check("C1", "200MB 断点续传：只传 8/25 分片 → 会话状态（ListParts 真相）报缺 17 片", "uploaded=8 + missing=17",
      short({ total: largeParts.length, uploaded: uploadedSoFar, missing: missing.length }, 200),
      largeParts.length === 25 && uploadedSoFar === 8 && missing.length === 17);

    const signedRest = await call("POST", "/api/v1/files/" + largeFileId + "/uploads/" + largeUploadId + "/parts", { partNumbers: missing }, admin);
    for (let index = 0; index < missing.length; index += 4) {
      await Promise.all(missing.slice(index, index + 4).map((partNumber, offset) => putPart(signedRest.body.parts[index + offset].url, largeParts[partNumber - 1])));
    }
    const uploadMs = Date.now() - uploadStart;
    const largeComplete = await completeUpload(largeFileId, largeUploadId, largeHash);
    const rssAfter = sampleRss(apiPidList.filter((item) => item.kind === "api"));
    const rssDelta = Object.keys(rssAfter).reduce((sum, pid) => sum + (rssAfter[pid] ?? 0), 0) - Object.keys(rssBefore).reduce((sum, pid) => sum + (rssBefore[pid] ?? 0), 0);
    const throughput = largeBuffer.length / (uploadMs / 1000) / MI_B;
    evidence.large = { bytes: largeBuffer.length, uploadMs, throughputMiBps: Number(throughput.toFixed(1)), apiRssDeltaBytes: rssDelta, complete: { status: largeComplete.status, sizeBytes: largeComplete.body?.version?.sizeBytes, seq: largeComplete.body?.version?.seq } };
    check("C2", "200MB complete（合并 + 哈希校验）：200 + sizeBytes 一致 + v1", "200 + sizeBytes=" + largeBuffer.length + " + seq=1",
      short({ status: largeComplete.status, sizeBytes: largeComplete.body?.version?.sizeBytes, seq: largeComplete.body?.version?.seq, uploadSec: Math.round(uploadMs / 1000), throughputMiBps: Number(throughput.toFixed(1)), apiRssDeltaMiB: Number((rssDelta / MI_B).toFixed(1)) }, 300),
      largeComplete.status === 200 && largeComplete.body?.version?.sizeBytes === largeBuffer.length && largeComplete.body?.version?.seq === 1,
      "分片并发 4；api 不代理流量（直传对象存储），RSS 增量登记用于排除 api 缓冲整文件");

    const dupInit = await call("POST", "/api/v1/files/uploads", { projectId: project, name: "压测-200MB-超大样例（秒传探测）.docx", sizeBytes: largeBuffer.length, contentHash: largeHash, docType: DOC_TYPE, intent: "version" }, admin);
    check("C3", "秒传命中（A4-04）：同内容再次 init → duplicateHint 指向既有文件（不阻断）", "duplicateHint ≠ null 且指向 200MB 文件",
      short({ status: dupInit.status, hintFileId: dupInit.body?.duplicateHint?.fileId, hintName: dupInit.body?.duplicateHint?.name, hit: dupInit.body?.duplicateHint?.fileId === largeFileId }, 260),
      dupInit.status === 201 && dupInit.body?.duplicateHint?.fileId === largeFileId);

    const largeFinalize = await finalizeFile(largeFileId, largeComplete.body.file.version);
    const largeSample = { id: "C-L", fileId: largeFileId, versionId: largeComplete.body.version.id, finalizedAt: Date.now(), terminalStatus: undefined };
    await waitTerminal(largeSample);
    const largeJobs = await db.query("select status, attempts, last_error from outbox_events where payload::text like '%' || $1 || '%' and topic = 'preview.job'", [largeFileId]);
    const largeArtifact = await db.query("select status, error from preview_artifacts where file_id = $1", [largeFileId]);
    check("C4", "200MB 转换侧：超 " + evidence.limits.serverEnv.maxSourceMb + "MB 上限 → 确定性降级（failed + outbox dead + 可下载）", "preview=failed + outbox=dead + download-url 200",
      short({ finalize: largeFinalize.status, terminal: largeSample.terminalStatus, jobs: largeJobs.rows, artifact: largeArtifact.rows[0]?.status, error: short(largeArtifact.rows[0]?.error, 120) }, 420),
      largeSample.terminalStatus === "failed" && largeJobs.rows.some((row) => row.status === "dead") && largeArtifact.rows[0]?.status === "failed",
      "按「200MB 只验上传续传 + 降级可下载、不要求可预览」口径登记；该样本不计入成功率分母");

    const largeSigned = await downloadUrlOf(largeFileId, largeComplete.body.version.id);
    const largeFetch = await fetchSignedStreamHash(largeSigned.body.url);
    check("C5", "200MB 读回逐字节一致（流式 sha256）", "sha256=" + largeHash.slice(0, 12) + "… bytes=" + largeBuffer.length,
      short({ status: largeSigned.status, fetchedBytes: largeFetch.bytes, hash: largeFetch.hash.slice(0, 12) + "…", downloadHashMatches: largeFetch.hash === largeHash }, 260),
      largeSigned.status === 200 && largeFetch.status === 200 && largeFetch.hash === largeHash && largeFetch.bytes === largeBuffer.length);
  }

  // ---------- 证据 D：读面并发（/preview + /download-url 混合 200 并发） ----------
  const readPool = samples.filter((sample) => sample.terminalStatus === "ready");
  const previewAuditsBefore = (await auditOf(project, "preview")).length;
  const downloadAuditsBefore = (await auditOf(project, "download")).length;
  const readTasks = [];
  for (let index = 0; index < 100; index += 1) {
    const sample = readPool[index % readPool.length];
    readTasks.push(async () => {
      const t0 = Date.now();
      const response = await previewOf(sample.fileId, sample.versionId);
      return { kind: "preview", status: response.status, ms: Date.now() - t0 };
    });
  }
  for (let index = 0; index < 100; index += 1) {
    const sample = readPool[index % readPool.length];
    readTasks.push(async () => {
      const t0 = Date.now();
      const response = await downloadUrlOf(sample.fileId, sample.versionId);
      return { kind: "download", status: response.status, ms: Date.now() - t0 };
    });
  }
  const readResults = await Promise.all(readTasks.map((task) => task()));
  const previewLatency = readResults.filter((item) => item.kind === "preview").map((item) => item.ms);
  const downloadLatency = readResults.filter((item) => item.kind === "download").map((item) => item.ms);
  const previewAuditsAfter = (await auditOf(project, "preview")).length;
  const downloadAuditsAfter = (await auditOf(project, "download")).length;
  evidence.read = {
    requests: readResults.length,
    ok: readResults.filter((item) => item.status === 200).length,
    preview: { p50: percentile(previewLatency, 50), p95: percentile(previewLatency, 95) },
    download: { p50: percentile(downloadLatency, 50), p95: percentile(downloadLatency, 95) },
    previewAuditDelta: previewAuditsAfter - previewAuditsBefore,
    downloadAuditDelta: downloadAuditsAfter - downloadAuditsBefore,
  };
  check("D1", "读面并发 200（100 /preview + 100 /download-url）：全 200 且 p95 ≤ 1000 ms", "200/200 + p95 ≤ 1000 ms",
    short({ ok: evidence.read.ok + "/200", previewP50: evidence.read.preview.p50, previewP95: evidence.read.preview.p95, downloadP50: evidence.read.download.p50, downloadP95: evidence.read.download.p95 }, 300),
    evidence.read.ok === 200 && (evidence.read.preview.p95 ?? 9999) <= 1000 && (evidence.read.download.p95 ?? 9999) <= 1000);
  check("D2", "审计口径（C7）：200 次读 → preview 100 条 + download 100 条（各一条一次）", "preview Δ=100 + download Δ=100",
    short({ previewDelta: evidence.read.previewAuditDelta, downloadDelta: evidence.read.downloadAuditDelta }, 200),
    evidence.read.previewAuditDelta === 100 && evidence.read.downloadAuditDelta === 100);
  // ---------- 证据 E：长跑 + 内存曲线 ----------
  if (args.skipLongRun !== true && LONG_RUN_MIN > 0) {
    const longRunSamples = [];
    let memoryStop = false;
    const memoryPoints = [];
    const memorySampler = (async () => {
      while (memoryStop === false) {
        const rss = sampleRss(apiPidList);
        const stats = dockerStats();
        const apiRss = apiPidList.filter((item) => item.kind === "api").reduce((sum, item) => sum + (rss[item.pid] ?? 0), 0);
        const workerRss = apiPidList.filter((item) => item.kind === "worker").reduce((sum, item) => sum + (rss[item.pid] ?? 0), 0);
        memoryPoints.push({ t: Date.now(), apiRss: apiRss === 0 ? null : apiRss, workerRss: workerRss === 0 ? null : workerRss, converterMiB: stats?.memUsedMiB ?? null, converterCpu: stats?.cpuPercent ?? null, converterPids: stats?.pids ?? null });
        await sleep(10_000);
      }
    })();
    const longRunEnd = Date.now() + LONG_RUN_MIN * 60_000;
    let round = 0;
    while (Date.now() < longRunEnd) {
      round += 1;
      const trio = ["docx", "xlsx"].map((type, index) => {
        const entry = { id: "LR" + round + "-" + (index + 1), type, layer: "S", seed: 20260924 + round * 131 + index * 17, target: LAYER_TARGETS[type].S };
        const built = buildSampleBytes(entry, "长跑-" + round + "-" + (index + 1) + "-" + randomBytes(3).toString("hex"));
        return { ...entry, name: "压测-长跑-" + round + "-" + (index + 1) + "." + type, bytes: built.bytes, units: built.units };
      });
      await Promise.all(trio.map((sample) => uploadAndFinalize(sample)));
      longRunSamples.push(...trio);
      await sleep(20_000);
    }
    for (const sample of longRunSamples) await waitTerminal(sample);
    memoryStop = true;
    await memorySampler;
    const inspectAfter = dockerInspect();
    const apiPoints = memoryPoints.filter((point) => point.apiRss !== null);
    const workerPoints = memoryPoints.filter((point) => point.workerRss !== null);
    const converterPoints = memoryPoints.filter((point) => point.converterMiB !== null);
    const apiSlope = tailSlopePerMinute(apiPoints, "apiRss");
    const workerSlope = tailSlopePerMinute(workerPoints, "workerRss");
    const apiPeak = apiPoints.reduce((max, point) => Math.max(max, point.apiRss), 0);
    const workerPeak = workerPoints.reduce((max, point) => Math.max(max, point.workerRss), 0);
    const converterPeak = converterPoints.reduce((max, point) => Math.max(max, point.converterMiB), 0);
    const cgroupPeak = containerMemCgroup();
    const cgroupPeakMiB = cgroupPeak === null ? null : cgroupPeak.peakBytes / MI_B;
    const converterLimitMiB = inspect?.memLimitBytes === undefined ? 2048 : inspect.memLimitBytes / MI_B;
    const longReady = longRunSamples.filter((sample) => sample.terminalStatus === "ready").length;
    evidence.memory = {
      minutes: LONG_RUN_MIN,
      points: memoryPoints.length,
      api: { peakMiB: Number((apiPeak / MI_B).toFixed(1)), tailSlopeMiBPerMin: apiSlope === null ? null : Number((apiSlope / MI_B).toFixed(2)), pids: evidence.limits.workers.api },
      worker: { peakMiB: Number((workerPeak / MI_B).toFixed(1)), tailSlopeMiBPerMin: workerSlope === null ? null : Number((workerSlope / MI_B).toFixed(2)), pids: evidence.limits.workers.worker },
      converter: { peakMiB: converterPeak === null ? null : Number(converterPeak.toFixed(1)), cgroupPeakMiB: cgroupPeakMiB === null ? null : Number(cgroupPeakMiB.toFixed(1)), limitMiB: Number(converterLimitMiB.toFixed(0)), maxPids: converterPoints.reduce((max, point) => Math.max(max, point.converterPids ?? 0), 0), maxCpuPercent: converterPoints.reduce((max, point) => Math.max(max, point.converterCpu ?? 0), 0) === 0 ? null : Number(converterPoints.reduce((max, point) => Math.max(max, point.converterCpu ?? 0), 0).toFixed(1)) },
      inspectAfter: inspectAfter === null ? null : { oomKilled: inspectAfter.oomKilled, restarts: inspectAfter.restarts, running: inspectAfter.running },
      longRunSamples: longRunSamples.length,
      longRunReady: longReady,
    };
    check("E1", "长跑 " + LONG_RUN_MIN + " 分钟（每轮 2 份小样本）：全部终态 ready（" + longReady + "/" + longRunSamples.length + "）", "全部 ready",
      short({ rounds: round, samples: longRunSamples.length, ready: longReady, failed: longRunSamples.filter((sample) => sample.terminalStatus === "failed").length, timeout: longRunSamples.filter((sample) => sample.terminalStatus === "timeout").length }, 260),
      longReady === longRunSamples.length);
    check("E2", "长跑稳定性：无 OOM / 无重启 / 转换器峰值内存 ≤ 限额 90%", "oom=false + restarts=0 + 峰值 ≤ " + (converterLimitMiB * 0.9).toFixed(0) + " MiB",
      short({ oomKilled: inspectAfter?.oomKilled, restarts: inspectAfter?.restarts, running: inspectAfter?.running, cgroupPeakMiB: evidence.memory.converter.cgroupPeakMiB, statsPeakMiB: evidence.memory.converter.peakMiB, limitMiB: evidence.memory.converter.limitMiB, maxCpuPercent: evidence.memory.converter.maxCpuPercent, maxPids: evidence.memory.converter.maxPids }, 320),
      inspectAfter !== null && inspectAfter.oomKilled === false && inspectAfter.restarts === 0 && (evidence.memory.converter.cgroupPeakMiB ?? converterPeak) <= converterLimitMiB * 0.9);
    check("E3", "无泄漏趋势：api / worker 宿主 RSS 尾段（后 1/3）斜率 ≤ 1 MiB/min", "斜率 ≤ 1 MiB/min（或点数不足时登记）",
      short({ apiPeakMiB: evidence.memory.api.peakMiB, apiSlope: evidence.memory.api.tailSlopeMiBPerMin, workerPeakMiB: evidence.memory.worker.peakMiB, workerSlope: evidence.memory.worker.tailSlopeMiBPerMin, points: memoryPoints.length }, 300),
      (apiSlope === null || apiSlope / MI_B <= 1) && (workerSlope === null || workerSlope / MI_B <= 1),
      "采样 = 每 10s 一次宿主进程 RSS（Get-Process / ps）+ docker stats；斜率按尾段最小二乘");
  }

  // ---------- 证据 F：对账 ----------
  const fileIds = [...samples, ...idemSamples].filter((sample) => sample.fileId !== undefined).map((sample) => sample.fileId);
  const tripleRows = await db.query("select count(distinct (content_hash, pipeline_version, target))::int as count from preview_artifacts where file_id = any($1::uuid[])", [fileIds]);
  const memCgroupEnd = containerMemCgroup();
  if (memCgroupEnd !== null && evidence.limits.converterMem !== undefined) {
    evidence.limits.converterMem.peakEndMiB = Number((memCgroupEnd.peakBytes / MI_B).toFixed(1));
    evidence.limits.converterMem.peakEndSource = "收尾读数（长跑段另有 E2 读数；两者同容器）";
  }
  const artifactCount = await db.query("select count(*)::int as count from preview_artifacts where file_id = any($1::uuid[])", [fileIds]);
  const outboxRows = await db.query("select topic, status, count(*)::int as count, max(attempts) as max_attempts from outbox_events where payload::text like '%' || $1 || '%' group by topic, status order by topic, status", [project]);
  const stuckRows = await db.query("select count(*)::int as count from outbox_events where payload::text like '%' || $1 || '%' and topic = $3 and status in ('pending','processing') and created_at < now() - ($2::int * interval '1 millisecond')", [project, evidence.limits.serverEnv.outboxPollMs * 100, PREVIEW_JOB_TOPIC]);
  evidence.reconciliations = {
    triples: tripleRows.rows[0].count,
    artifacts: artifactCount.rows[0].count,
    outbox: outboxRows.rows,
    stuck: stuckRows.rows[0].count,
    audits: { preview: (await auditOf(project, "preview")).length, download: (await auditOf(project, "download")).length },
  };
  check("F1", "对账：preview_artifacts 行 = 唯一三元组数（无重复登记、无缺行）", "行数 = 唯一三元组数",
    short({ rows: evidence.reconciliations.artifacts, triples: evidence.reconciliations.triples, outbox: outboxRows.rows }, 300),
    evidence.reconciliations.artifacts === evidence.reconciliations.triples);
  const previewOutbox = outboxRows.rows.filter((row) => row.topic === PREVIEW_JOB_TOPIC);
  const previewPending = previewOutbox.filter((row) => row.status === "pending" || row.status === "processing").reduce((sum, row) => sum + row.count, 0);
  check("F2", "预览队列（" + PREVIEW_JOB_TOPIC + "）排空且无 stuck（pending / processing 且超过轮询窗口 ×100 未动 = 0）", "stuck = 0 且 preview.job 无 pending（dead 属预期：200MB 降级）；其余主题一期无消费者，pending 只登记",
    short({ stuck: evidence.reconciliations.stuck, previewPending, preview: previewOutbox, otherTopics: outboxRows.rows.filter((row) => row.topic !== PREVIEW_JOB_TOPIC) }, 360),
    evidence.reconciliations.stuck === 0 && previewPending === 0);
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("M4-05 压测失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true) {
        for (const projectId of cleanup.projectIds) {
          await db.query("update files set current_version_id = null where project_id = $1", [projectId]);
          await db.query("delete from file_links where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from upload_sessions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from preview_artifacts where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from file_versions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from files where project_id = $1", [projectId]);
          await db.query("delete from audit_logs where project_id = $1", [projectId]);
          await db.query("delete from outbox_events where payload::text like '%' || $1::text || '%'", [projectId]);
          await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = $1)", [projectId]);
          await db.query("delete from project_nodes where project_id = $1", [projectId]);
          await db.query("delete from project_stages where project_id = $1", [projectId]);
          await db.query("delete from project_members where project_id = $1", [projectId]);
          await db.query("delete from projects where id = $1", [projectId]);
        }
        if (storage !== undefined) {
          for (const projectId of cleanup.projectIds) await purgePrefix("projects/" + projectId + "/").catch(() => undefined);
          for (const hash of cleanup.contentHashes) await purgePrefix("previews/" + hash + "/").catch(() => undefined);
        }
      }
      for (const token of cleanup.sessions) {
        await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      }
      if (project !== undefined) {
        const residue = await db.query(
          "select (select count(*) from projects where id = $1) as projects, (select count(*) from files where project_id = $1) as files, (select count(*) from file_versions where file_id in (select id from files where project_id = $1)) as versions, (select count(*) from preview_artifacts where file_id in (select id from files where project_id = $1)) as artifacts, (select count(*) from outbox_events where payload::text like '%' || $1::text || '%') as outbox, (select count(*) from audit_logs where project_id = $1) as audits",
          [project],
        );
        evidence.reconciliations.residue = residue.rows[0];
        if (args.keep !== true) {
          const row = residue.rows[0];
          const empty = Object.values(row).every((value) => Number(value) === 0);
          softCheck("F3", "收尾零残留（项目 / 文件 / 版本 / 产物 / outbox / 审计）", "全部 0", short(row, 260), empty);
          const storageLeft = await rawClient.send(new s3Module.ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: "projects/" + project + "/" }));
          const storageKeys = [...(storageLeft.Versions ?? []), ...(storageLeft.DeleteMarkers ?? [])].filter((item) => item.Key?.startsWith("projects/" + project + "/")).length;
          softCheck("F4", "对象存储零残留（projects/{projectId}/ 前缀）", "0 个对象版本", String(storageKeys), storageKeys === 0);
        }
      }
    } catch (error) {
      report.push("| WARN | 收尾未完全成功：" + (error instanceof Error ? error.message : String(error)) + " | ");
    }
    await db.end();
  }
}

// ---------- 证据文件 ----------
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: serverRoot }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: serverRoot }).toString().trim() !== "";
const lines = [];
lines.push("# M4-05 压测证据（S7·file 预览管道 · PoC-1：转换成功率 / 200MB 续传 / 并发与长跑）");
lines.push("");
lines.push("> 卡片：M4-05「预览管道」的**出口验证（压测）**（主责 lan，评审 wmj）｜口径来源：技术设计v0.1 §7.3 #1（PoC-1：200MB 级续传 + xlsx / docx / pdf 转换成功率 ≥95% + 中文不乱码）｜技术设计v0.3 §3.5 出口标准｜ADR-013（converter 2C4G / 并发 2~4）｜deploy/preview（沙箱限额与通道矩阵）。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-05 压测切片代记（压测脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 档位 | " + label + " |");
lines.push("| 压测时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + "（api） / " + CONVERTER_URL + "（转换沙箱） |");
lines.push("| 转换沙箱 | 镜像 " + (evidence.limits.dockerInspect?.image ?? "-") + "；内存 " + (evidence.limits.sandbox.memLimit ?? "-") + " / CPU " + (evidence.limits.sandbox.cpus ?? "-") + " / pids " + (evidence.limits.sandbox.pids ?? "-") + " / tmpfs " + (evidence.limits.sandbox.tmpfs ?? "-") + "；并发 " + (evidence.limits.sandbox.maxConcurrency ?? "-") + " / 队列 " + (evidence.limits.sandbox.maxQueue ?? "-") + " / 硬超时 " + (evidence.limits.sandbox.timeoutMs ?? "-") + " ms |");
lines.push("| 并发档位 | **worker 实例 " + evidence.limits.workers?.worker?.length + " 个**（PreviewService 单实例串行消费 = 每实例并发 1）；burst=" + BURST + " |");
lines.push("| 运行配置（`server/.env` 声明值） | `OUTBOX_POLL_MS=" + evidence.limits.serverEnv.outboxPollMs + "` / `OUTBOX_BATCH_LIMIT=" + evidence.limits.serverEnv.outboxBatchLimit + "` / `PREVIEW_CONVERT_MAX_ATTEMPTS=" + evidence.limits.serverEnv.maxAttempts + "` / `PREVIEW_CONVERT_BACKOFF_MS=" + evidence.limits.serverEnv.backoffMs + "` / `PREVIEW_CONVERT_MAX_SOURCE_MB=" + evidence.limits.serverEnv.maxSourceMb + "`；worker 实际启动参数以「复跑」段为准 |");
lines.push("| 数据库 / 对象存储 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " / " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 样本档 | " + PROFILE + "（docx / xlsx / pdf / png × S/M/L = " + evidence.samples.filter((sample) => sample.layer !== "R").length + " 份合成" + (evidence.samples.some((sample) => sample.layer === "R") ? " + 真实样本 " + evidence.samples.filter((sample) => sample.layer === "R").length + " 份（--samples " + String(args.samples) + "）" : "") + " + 幂等组 8 份 + 200MB 1 份） |");
lines.push("| 长跑 | " + (args.skipLongRun === true ? "跳过" : LONG_RUN_MIN + " 分钟") + " |");
lines.push("| 代码版本 | " + commit + (dirty ? "（压测时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 脚本 | server/scripts/m4-05-stress.mjs |");
lines.push("");
lines.push("## 样本与成功率");
lines.push("");
lines.push("| 类型 / 分层 | 份数 | 就绪 | 失败 | 归因 |");
lines.push("|---|---|---|---|---|");
for (const [key, stats] of Object.entries(evidence.success.byTypeLayer ?? {})) {
  lines.push("| " + key + " | " + stats.total + " | " + stats.ready + " | " + stats.failed + " | " + (stats.reasons.length === 0 ? "-" : stats.reasons.join("；")) + " |");
}
lines.push("");
lines.push("- 整体成功率：**" + ((evidence.success.rate ?? 0) * 100).toFixed(1) + "%**（" + (evidence.success.ready ?? 0) + "/" + (evidence.success.total ?? 0) + "）—— PoC-1 门槛 ≥95%。");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：配置与限额登记 / 串行基线 / 并发背压（inflight / queued 采样）/ 三元组幂等 / 沙箱边界 503 / 200MB 续传与秒传与降级与读回一致 / 读面并发与审计一条一次 / 长跑内存曲线 / 对账与零残留。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 关键读数");
lines.push("");
lines.push("- 串行基线 / 并发排空：" + short(evidence.waves.burst ?? {}, 400));
lines.push("- 200MB：" + short(evidence.large ?? {}, 400));
lines.push("- 读面：" + short(evidence.read ?? {}, 400));
lines.push("- 内存：" + short({ api: evidence.memory.api, worker: evidence.memory.worker, converter: evidence.memory.converter }, 400));
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **ADR-013 生产档（2C4G / 并发 2~4）未标定**：本档按沙箱声明值（" + (evidence.limits.sandbox.memLimit ?? "-") + " / 并发 " + (evidence.limits.sandbox.maxConcurrency ?? "-") + "）实跑；生产档位复标属 M8 容量验证（ADR-013 §影响与后果：容量数字需实测校准后再承诺）。");
lines.push("- **200MB 转换 = 确定性降级（口径登记）**：源文件超 `PREVIEW_CONVERT_MAX_SOURCE_MB`（" + evidence.limits.serverEnv.maxSourceMb + "MB）按 D2-05 降级「请下载」—— PoC-1「200MB 级」验收项只覆盖**上传续传 + 可下载**，不要求可预览；该样本不计入成功率分母。需 wmj / px 会签。");
lines.push("- **合成样本 ≠ 真实样本集**：本档成功率为合成样本（结构可控、全部为可转换类型）；PoC-1 真实业务样本（版式保真度、Excel 分页、复杂字体回退）用 `--samples <dir>` 复跑 —— 该入口已实现（目录内 docx / xlsx / pdf / png 逐份入样，层 = R，计入 A2 成功率与串行基线时延之外的真实复跑），本档未提供真实样本。");
lines.push("- **沙箱边界 503 为直连探针**：pipeline 路径下（worker 串行 + 多实例）打不满「并发 + 队列」，故 503 SERVICE_BUSY 触发面用直连 /convert 探针证明（worker 侧按可重试退避的分类由单测覆盖）。");
lines.push("- **不进 CI 业务断言**：本脚本需 docker / 对象存储 / 转换沙箱，CI 矩阵不具备（仅 `node --check` 语法门禁覆盖脚本本身）；证据以本机 / 联调环境真机运行为准。");
lines.push("- **内存读数的两个口径**：容器峰值以 cgroup v2 `memory.peak` 为准（**容器启动至今的真实峰值**，含 page cache）—— E2「峰值 ≤ 限额 90%」即用它；`docker stats` 的 10s 瞬时值只登记 cpu / pids / 趋势（抓不到 soffice 的短时峰值，且把 page cache 混在里）。容器重建 = 峰值重新起算（X5 登记起点；判档要求重建后同一容器内跑完）。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("# 前置：MinIO + api + N 个 worker + 转换沙箱（deploy/preview）");
lines.push("# cd server && npm run build");
lines.push("# $env:OUTBOX_POLL_MS=1000; $env:OUTBOX_BATCH_LIMIT=4; node .\\dist\\entry\\worker.js   # 起 1~4 个");
lines.push("cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \\");
lines.push("  node --env-file-if-exists=.env scripts/m4-05-stress.mjs --label \"沙箱档 2C2G / 并发 2\" --workers 4 --burst 8 \\");
lines.push("  --long-run-min 20 --out \"../docs/m4-05-压测证据(PoC-1·沙箱档).md\"");
lines.push("# 档 B（ADR-013 生产起点 2C4G / 并发 4）：先把 deploy/preview/.env 的 PREVIEW_CONVERTER_MEM_LIMIT=4g、");
lines.push("#   PREVIEW_CONVERT_MAX_CONCURRENCY=4 改好并 `docker compose -f deploy/preview/docker-compose.yml up -d` 重建，再同跑：");
lines.push("#   ... --label \"ADR-013 档 2C4G / 并发 4\" --workers 4 --burst 8 --long-run-min 20 \\");
lines.push("#       --out \"../docs/m4-05-压测证据(PoC-1·ADR013档).md\"");
lines.push("```");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);
