#!/usr/bin/env node
/**
 * 预览 / 导入大对象内存冒烟（2026-10-23 · 高分 OOM 修复的复跑入口）：
 * - import：生成指定单元格数的 xlsx，在受限 V8 堆中按盘上区间解析，输出峰值 RSS；
 * - preview：用真实 PreviewContentService 消费 2 GiB 合成对象流并写入丢弃型响应，验证流式直写不随对象大小增长。
 *
 * 用法（先 npm run build）：
 *   node scripts/import-memory-smoke.mjs --mode import --cells 2000000
 *   node scripts/import-memory-smoke.mjs --mode preview --bytes 2147483648 --concurrency 4
 * 退出码：峰值超过阈值 / 子进程 OOM / 断言失败 = 1。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const args = parseArgs(process.argv.slice(2));
const MI_B = 1024 * 1024;
const MODE = args.mode ?? "import";
const CELLS = Number(args.cells ?? 2_000_000);
const COLS = Number(args.cols ?? 40);
const BYTES = Number(args.bytes ?? 2 * 1024 * MI_B);
const CONCURRENCY = Number(args.concurrency ?? 1);
const HEAP_MIB = Number(args.heapMib ?? (MODE === "preview" ? 128 : 384));
const RSS_MIB = Number(args.rssMib ?? 512);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  if (args.child) {
    if (MODE === "preview") await runPreviewChild();
    else await runImportChild();
    return;
  }
  if (MODE === "preview") {
    if (!Number.isSafeInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 16) throw new Error("--concurrency 必须在 1..16");
    await runChild([
      "--mode", "preview", "--bytes", String(BYTES), "--concurrency", String(CONCURRENCY),
      "--heap-mib", String(HEAP_MIB), "--rss-mib", String(RSS_MIB),
    ]);
    return;
  }
  if (MODE !== "import") throw new Error("未知 --mode：" + MODE);
  if (!Number.isSafeInteger(CELLS) || CELLS < 1) throw new Error("--cells 必须是正整数");
  if (!Number.isSafeInteger(COLS) || COLS < 1 || COLS > 256) throw new Error("--cols 必须在 1..256");

  const root = await mkdtemp(join(tmpdir(), "libiaolink-memory-smoke-"));
  try {
    const file = join(root, "cells.xlsx");
    console.log("生成导入样本：" + CELLS + " 单元格 / " + COLS + " 列");
    await generateWorkbook(file, CELLS, COLS);
    const bytes = (await stat(file)).size;
    console.log("样本大小：" + (bytes / MI_B).toFixed(2) + " MiB");
    await runChild([
      "--mode", "import", "--file", file, "--cells", String(CELLS), "--cols", String(COLS),
      "--heap-mib", String(HEAP_MIB), "--rss-mib", String(RSS_MIB),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--child") out.child = true;
    else if (item === "--mode") out.mode = argv[++i];
    else if (item === "--cells") out.cells = argv[++i];
    else if (item === "--cols") out.cols = argv[++i];
    else if (item === "--bytes") out.bytes = argv[++i];
    else if (item === "--concurrency") out.concurrency = argv[++i];
    else if (item === "--heap-mib") out.heapMib = argv[++i];
    else if (item === "--rss-mib") out.rssMib = argv[++i];
    else if (item === "--file") out.file = argv[++i];
    else throw new Error("未知参数：" + item);
  }
  return out;
}

async function runChild(extra) {
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=" + String(HEAP_MIB), fileURLToPath(import.meta.url), "--child", ...extra],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error("子进程失败（code=" + String(code) + " / signal=" + String(signal) + "）：" + (stderr || stdout).trim());
  }
  const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (last === undefined) throw new Error("子进程没有输出指标");
  const result = JSON.parse(last);
  if (!Number.isFinite(result.maxRssMiB) || result.maxRssMiB > RSS_MIB) {
    throw new Error("峰值 RSS " + String(result.maxRssMiB) + " MiB 超过阈值 " + String(RSS_MIB) + " MiB");
  }
  console.log("通过：" + JSON.stringify(result));
}

async function runImportChild() {
  if (typeof args.file !== "string" || args.file === "") throw new Error("缺少 --file");
  const module = await dynamicImport("dist/modules/project-import/xlsx.js");
  const startedAt = Date.now();
  const parsed = module.parseWorkbookFile(args.file);
  try {
    const rows = parsed.sheets[0]?.rows.length ?? 0;
    const expectedRows = Math.ceil(CELLS / COLS);
    if (rows !== expectedRows) throw new Error("行数不符：expected=" + String(expectedRows) + " actual=" + String(rows));
    const probe = parsed.sheets[0]?.rows[rows - 1]?.[0];
    if (typeof probe !== "string" || probe === "") throw new Error("末行探针缺失");
  } finally {
    parsed.close();
  }
  const usage = process.resourceUsage();
  const mem = process.memoryUsage();
  process.stdout.write(JSON.stringify({
    mode: "import",
    cells: CELLS,
    cols: COLS,
    elapsedMs: Date.now() - startedAt,
    maxRssMiB: round(usage.maxRSS / 1024),
    heapUsedMiB: round(mem.heapUsed / MI_B),
    heapLimitMiB: HEAP_MIB,
  }) + "\n");
}

async function runPreviewChild() {
  const { AppConfig } = await dynamicImport("dist/config/config.module.js");
  const { PreviewContentService } = await dynamicImport("dist/modules/file/preview-content.service.js");
  const jwt = await dynamicImport("dist/modules/file/onlyoffice.jwt.js");
  const secret = "memory-smoke-secret";
  const apiBase = "http://api.internal:3000";
  const fileId = "22222222-2222-4222-8222-222222222222";
  const versionId = "66666666-6666-4666-8666-666666666666";
  const originalUrl = "/api/v1/files/" + fileId + "/versions/" + versionId + "/preview-content";
  const expectedUrl = jwt.absoluteDocServerApiUrl(apiBase, originalUrl);
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.signHs256Jwt({ payload: { url: expectedUrl }, iat: now, exp: now + 300 }, secret);

  const repository = {
    async findFileById(id) {
      return id === fileId ? { id: fileId, status: "final", recycledAt: null } : null;
    },
    async findVersionById(id, version) {
      return id === fileId && version === versionId
        ? { id: versionId, fileId, objectKey: "memory-smoke/large.pdf", mime: "application/pdf" }
        : null;
    },
  };
  const storage = {
    async getObjectStream() {
      return { stream: new ByteStream(BYTES), sizeBytes: BYTES, contentType: "application/pdf" };
    },
  };
  const config = new AppConfig({
    ONLYOFFICE_DOCSERVER_API_BASE_URL: apiBase,
    ONLYOFFICE_JWT_SECRET: secret,
    ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS: 60,
  });
  const responses = Array.from({ length: CONCURRENCY }, () => new SinkResponse());
  const service = new PreviewContentService(repository, storage, config);
  const startedAt = Date.now();
  await Promise.all(responses.map((response) => service.serve({
    fileId,
    versionId,
    originalUrl,
    authorization: "Bearer " + token,
    response,
  })));
  for (const response of responses) {
    if (response.receivedBytes !== BYTES) {
      throw new Error("响应字节不符：expected=" + String(BYTES) + " actual=" + String(response.receivedBytes));
    }
  }
  const usage = process.resourceUsage();
  const mem = process.memoryUsage();
  process.stdout.write(JSON.stringify({
    mode: "preview",
    bytes: BYTES,
    concurrency: CONCURRENCY,
    totalBytes: BYTES * CONCURRENCY,
    elapsedMs: Date.now() - startedAt,
    maxRssMiB: round(usage.maxRSS / 1024),
    heapUsedMiB: round(mem.heapUsed / MI_B),
    heapLimitMiB: HEAP_MIB,
  }) + "\n");
}

class ByteStream extends Readable {
  constructor(total) {
    super();
    this.remaining = total;
  }

  _read(size) {
    if (this.remaining <= 0) {
      this.push(null);
      return;
    }
    const requested = size !== undefined && size > 0 ? size : 64 * 1024;
    const length = Math.min(requested, this.remaining, MI_B);
    this.remaining -= length;
    this.push(Buffer.alloc(length, 0x61));
  }
}

class SinkResponse extends Writable {
  constructor() {
    super();
    this.receivedBytes = 0;
    this.headers = {};
    this.statusCode = 0;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.receivedBytes += chunk.length;
    callback();
  }
}

async function dynamicImport(relative) {
  const path = join(serverRoot, relative);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    throw new Error("无法加载 " + relative + "，请先执行 npm run build：" + (error instanceof Error ? error.message : String(error)));
  }
}

async function generateWorkbook(file, cells, cols) {
  const root = dirname(file);
  const sheetPath = join(root, "sheet1.xml");
  const rows = Math.ceil(cells / cols);
  const handle = await open(sheetPath, "wx", 0o600);
  let pending = [];
  let pendingLength = 0;
  const flush = async () => {
    if (pendingLength === 0) return;
    const buffer = Buffer.from(pending.join(""));
    pending = [];
    pendingLength = 0;
    await writeAll(handle, buffer);
  };
  const append = async (text) => {
    pending.push(text);
    pendingLength += Buffer.byteLength(text);
    if (pendingLength >= MI_B) await flush();
  };
  try {
    await append("<worksheet><sheetData>");
    let written = 0;
    for (let row = 0; row < rows; row += 1) {
      await append("<row r=\"" + String(row + 1) + "\">");
      for (let col = 0; col < cols && written < cells; col += 1, written += 1) {
        const ref = columnLetters(col) + String(row + 1);
        const value = written % 100000;
        await append("<c r=\"" + ref + "\"><v>" + String(value) + "</v></c>");
      }
      await append("</row>");
    }
    await append("</sheetData></worksheet>");
    await flush();
    await handle.sync();
  } finally {
    await handle.close();
  }

  const sheetSize = (await stat(sheetPath)).size;
  const workbookXml = Buffer.from("<workbook><sheets><sheet name=\"任务\" r:id=\"rId1\"/></sheets></workbook>", "utf8");
  const relsXml = Buffer.from("<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>", "utf8");
  const entries = [];
  const out = await open(file, "wx", 0o600);
  let offset = 0;
  const write = async (buffer) => {
    await writeAll(out, buffer);
    offset += buffer.length;
  };
  const addBuffer = async (name, data) => {
    const start = offset;
    await write(localHeader(name, data.length));
    await write(Buffer.from(name, "utf8"));
    await write(data);
    entries.push({ name, size: data.length, offset: start });
  };
  try {
    await addBuffer("xl/workbook.xml", workbookXml);
    await addBuffer("xl/_rels/workbook.xml.rels", relsXml);
    const sheetStart = offset;
    await write(localHeader("xl/worksheets/sheet1.xml", sheetSize));
    await write(Buffer.from("xl/worksheets/sheet1.xml", "utf8"));
    for await (const chunk of createReadStream(sheetPath)) await write(chunk);
    entries.push({ name: "xl/worksheets/sheet1.xml", size: sheetSize, offset: sheetStart });

    const centralStart = offset;
    for (const entry of entries) await write(centralHeader(entry));
    const centralSize = offset - centralStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    await write(eocd);
  } finally {
    await out.close();
  }
  await rm(sheetPath, { force: true });
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (result.bytesWritten <= 0) throw new Error("临时文件写入失败");
    offset += result.bytesWritten;
  }
}

function localHeader(name, size) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return header;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  name.copy(header, 46);
  return header;
}

function columnLetters(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
