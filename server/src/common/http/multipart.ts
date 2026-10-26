import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../errors/app-error.js";
import { createImportTempDirectory, isNoSpaceError, temporaryStorageError } from "./import-temp.js";

/**
 * 最小 multipart/form-data 解析（导入表导入预览用 —— 项目此前没有服务端收文件路径：
 * 文件模块走 S3 预签名直传，API 不代理大文件；导入是一进一出的整包解析，故在本模块内直接收流）。
 * 支持 `file` 字段（浏览器 FormData 默认格式），二进制安全（xlsx 为 zip 二进制）。
 */

export interface MultipartFilePart {
  field: string;
  fileName: string;
  contentType: string | null;
  bytes: Buffer;
}

const CR = 13;
const LF = 10;

/** 从 Content-Type 里取 boundary（带引号 / 不带引号都认）。 */
export function boundaryOf(contentType: string | null | undefined): string | null {
  if (contentType === null || contentType === undefined) return null;
  if (!contentType.toLowerCase().includes("multipart/form-data")) return null;
  const marker = "boundary=";
  const index = contentType.toLowerCase().indexOf(marker);
  if (index < 0) return null;
  let value = contentType.slice(index + marker.length).trim();
  const semicolon = value.indexOf(";");
  if (semicolon >= 0) value = value.slice(0, semicolon).trim();
  if (value.startsWith(String.fromCharCode(34)) && value.endsWith(String.fromCharCode(34))) {
    value = value.slice(1, value.length - 1);
  }
  return value === "" ? null : value;
}

/** 整包读流（上限内；超限立即中止并 400）。有 Content-Length 时预分配，避免 chunks + concat 的峰值副本。 */
export async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const header = req.headers["content-length"];
  const declared = typeof header === "string" ? Number(header) : Number.NaN;
  if (Number.isSafeInteger(declared) && declared >= 0) {
    if (declared > maxBytes) {
      throw new AppError("IMPORT_FILE_INVALID", "文件超过上限（" + Math.floor(maxBytes / 1024 / 1024) + " MB），请拆分后再导入");
    }
    const body = Buffer.allocUnsafe(declared);
    let offset = 0;
    for await (const chunk of req) {
      const part = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      if (offset + part.length > declared) {
        throw new AppError("IMPORT_FILE_INVALID", "请求体长度与 Content-Length 不一致");
      }
      part.copy(body, offset);
      offset += part.length;
    }
    return offset === declared ? body : body.subarray(0, offset);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += part.length;
    if (total > maxBytes) {
      throw new AppError("IMPORT_FILE_INVALID", "文件超过上限（" + Math.floor(maxBytes / 1024 / 1024) + " MB），请拆分后再导入");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function headerValue(headerText: string, name: string): string | null {
  for (const line of headerText.split(String.fromCharCode(13, 10))) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    if (line.slice(0, index).trim().toLowerCase() !== name) continue;
    return line.slice(index + 1).trim();
  }
  return null;
}

/** 从 content-disposition 里取字段名 / 文件名（filename* 优先，RFC 5987）。 */
function dispositionOf(headerText: string): { field: string; fileName: string } {
  const disposition = headerValue(headerText, "content-disposition") ?? "";
  let fileName = "";
  const starIndex = disposition.indexOf("filename*=");
  if (starIndex >= 0) {
    let raw = disposition.slice(starIndex + 10).trim();
    const semicolon = raw.indexOf(";");
    if (semicolon >= 0) raw = raw.slice(0, semicolon).trim();
    const tick = raw.indexOf("'");
    if (tick >= 0) raw = raw.slice(tick + 2);
    try {
      fileName = decodeURIComponent(raw);
    } catch {
      fileName = raw;
    }
  }
  if (fileName === "") {
    const plainIndex = disposition.indexOf("filename=");
    if (plainIndex >= 0) {
      let raw = disposition.slice(plainIndex + 9).trim();
      const semicolon = raw.indexOf(";");
      if (semicolon >= 0) raw = raw.slice(0, semicolon).trim();
      if (raw.startsWith(String.fromCharCode(34)) && raw.endsWith(String.fromCharCode(34))) {
        raw = raw.slice(1, raw.length - 1);
      }
      fileName = raw;
    }
  }
  const nameIndex = disposition.indexOf("name=");
  let field = "";
  if (nameIndex >= 0) {
    let raw = disposition.slice(nameIndex + 5).trim();
    const semicolon = raw.indexOf(";");
    if (semicolon >= 0) raw = raw.slice(0, semicolon).trim();
    if (raw.startsWith(String.fromCharCode(34)) && raw.endsWith(String.fromCharCode(34))) {
      raw = raw.slice(1, raw.length - 1);
    }
    field = raw;
  }
  return { field, fileName };
}

/** 按 boundary 切分并解析每个 part（返回全部带文件名的 part）。 */
export function parseMultipart(body: Buffer, boundary: string): MultipartFilePart[] {
  const delimiter = Buffer.from("--" + boundary);
  const headerEndMarker = Buffer.from(String.fromCharCode(13, 10, 13, 10));
  const parts: MultipartFilePart[] = [];
  let index = body.indexOf(delimiter);
  while (index >= 0) {
    let cursor = index + delimiter.length;
    if (body[cursor] === CR && body[cursor + 1] === LF) cursor += 2;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    const headerEnd = body.indexOf(headerEndMarker, cursor);
    if (headerEnd < 0) break;
    const headerText = body.subarray(cursor, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerEndMarker.length;
    const next = body.indexOf(delimiter, contentStart);
    if (next < 0) break;
    let contentEnd = next;
    if (contentEnd >= 2 && body[contentEnd - 2] === CR && body[contentEnd - 1] === LF) contentEnd -= 2;
    const disposition = dispositionOf(headerText);
    if (disposition.fileName !== "" || headerValue(headerText, "content-type") !== null) {
      parts.push({
        field: disposition.field,
        fileName: disposition.fileName,
        contentType: headerValue(headerText, "content-type"),
        bytes: body.subarray(contentStart, contentEnd),
      });
    }
    index = next;
  }
  return parts;
}

/** 单个 part 校验（空文件 / 超限 400；提示带字段名）。 */
function assertPartSize(part: MultipartFilePart, maxBytes: number): void {
  if (part.bytes.length === 0) {
    throw new AppError("IMPORT_FILE_INVALID", "上传文件为空（multipart 字段 " + part.field + "）");
  }
  if (part.bytes.length > maxBytes) {
    throw new AppError("IMPORT_FILE_INVALID", "文件超过上限（" + Math.floor(maxBytes / 1024 / 1024) + " MB），请拆分后再导入");
  }
}

/**
 * 兼容入口：整包读流后按字段取文件 part（缺失 = null；空文件 / 超限 400 IMPORT_FILE_INVALID）。
 * 生产导入预览必须走 readMultipartFile，避免把 256 MB 请求体放进 API 堆内存。
 */
export async function readMultipartParts(
  req: IncomingMessage,
  contentType: string | null,
  fields: readonly string[],
  maxBytes: number,
): Promise<Map<string, MultipartFilePart | null>> {
  const boundary = boundaryOf(contentType);
  if (boundary === null) {
    throw new AppError("IMPORT_FILE_INVALID", "请求不是 multipart/form-data（字段 file）");
  }
  const body = await readRequestBody(req, (maxBytes + 1024 * 1024) * Math.max(1, fields.length));
  const parts = parseMultipart(body, boundary);
  const result = new Map<string, MultipartFilePart | null>();
  for (const field of fields) {
    const target =
      parts.find((part) => part.field === field && part.fileName !== "") ?? parts.find((part) => part.field === field) ?? null;
    if (target !== null) assertPartSize(target, maxBytes);
    result.set(field, target);
  }
  return result;
}


/** 导入文件的临时盘上视图：path 指向本次请求的 multipart 请求体，offset / sizeBytes 是文件 part 的字节区间。 */
export interface MultipartTempFile {
  field: string;
  fileName: string;
  contentType: string | null;
  path: string;
  offset: number;
  sizeBytes: number;
  /** 删除本次请求的临时目录；幂等，必须由调用方在解析 / 上传结束后执行。 */
  cleanup(): Promise<void>;
}

const MULTIPART_CHUNK_BYTES = 256 * 1024;
const MULTIPART_HEADER_LIMIT_BYTES = 64 * 1024;
const MULTIPART_PREAMBLE_LIMIT_BYTES = 1024 * 1024;
const HEADER_END_MARKER = Buffer.from(String.fromCharCode(13, 10, 13, 10));

/**
 * 导入预览专用：把 multipart 请求体流式落到 0600 临时文件，再在盘上定位目标文件 part。
 *
 * 与 readMultipartParts 的整包 Buffer 口径不同，本函数不把上传文件读进 API 堆内存；返回的区间可直接交给
 * ZipArchive.openFile / createReadStream。请求体仍受单文件上限 + 1 MB multipart 头尾开销约束。
 */
export async function readMultipartFile(
  req: IncomingMessage,
  contentType: string | null,
  field: string,
  maxBytes: number,
): Promise<MultipartTempFile | null> {
  const boundary = boundaryOf(contentType);
  if (boundary === null) {
    throw new AppError("IMPORT_FILE_INVALID", "请求不是 multipart/form-data（字段 " + field + "）");
  }
  const maxBodyBytes = maxBytes + 1024 * 1024;
  const header = req.headers["content-length"];
  const declared = typeof header === "string" ? Number(header) : Number.NaN;
  if (Number.isSafeInteger(declared) && declared > maxBodyBytes) {
    throw fileTooLarge(maxBytes);
  }

  const requiredBytes = Number.isSafeInteger(declared) && declared >= 0 ? Math.min(declared, maxBodyBytes) : maxBodyBytes;
  const root = await createImportTempDirectory(requiredBytes);
  const bodyPath = join(root, "multipart-body.bin");
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
        total += chunk.length;
        if (total > maxBodyBytes) {
          callback(fileTooLarge(maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, createWriteStream(bodyPath, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isNoSpaceError(error)) throw temporaryStorageError();
      throw new AppError("IMPORT_FILE_INVALID", "上传请求中断或临时文件写入失败");
    }
    if (Number.isSafeInteger(declared) && total !== declared) {
      throw new AppError("IMPORT_FILE_INVALID", "请求体长度与 Content-Length 不一致");
    }

    const handle = await fs.open(bodyPath, "r");
    let located: Omit<MultipartTempFile, "path" | "cleanup"> | null;
    try {
      located = await locateMultipartFilePart(handle, total, boundary, field, maxBytes);
    } finally {
      await handle.close();
    }
    if (located === null) {
      await cleanup();
      return null;
    }
    return { ...located, path: bodyPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function locateMultipartFilePart(
  handle: FileHandle,
  fileSize: number,
  boundary: string,
  field: string,
  maxBytes: number,
): Promise<Omit<MultipartTempFile, "path" | "cleanup"> | null> {
  const delimiter = Buffer.from("--" + boundary);
  const contentEndMarker = Buffer.from(String.fromCharCode(13, 10) + "--" + boundary);
  let cursor = await findInFile(handle, fileSize, 0, delimiter, MULTIPART_PREAMBLE_LIMIT_BYTES);
  if (cursor < 0) {
    throw invalidMultipart();
  }

  while (cursor < fileSize) {
    const afterDelimiter = cursor + delimiter.length;
    const suffix = await readExactly(handle, afterDelimiter, 2);
    if (suffix[0] === 45 && suffix[1] === 45) break;
    if (suffix[0] !== 13 || suffix[1] !== 10) {
      throw invalidMultipart();
    }
    cursor = afterDelimiter + 2;

    const headerEnd = await findInFile(
      handle,
      fileSize,
      cursor,
      HEADER_END_MARKER,
      MULTIPART_HEADER_LIMIT_BYTES,
    );
    if (headerEnd < 0) {
      throw invalidMultipart();
    }
    const headerBytes = await readExactly(handle, cursor, headerEnd - cursor);
    const headerText = headerBytes.toString("utf8");
    const disposition = dispositionOf(headerText);
    const contentStart = headerEnd + HEADER_END_MARKER.length;
    const next = await findInFile(handle, fileSize, contentStart, contentEndMarker);
    if (next < 0) {
      throw invalidMultipart();
    }
    const sizeBytes = next - contentStart;
    if (disposition.field === field && disposition.fileName !== "") {
      if (sizeBytes === 0) {
        throw new AppError("IMPORT_FILE_INVALID", "上传文件为空（multipart 字段 " + field + "）");
      }
      if (sizeBytes > maxBytes) {
        throw fileTooLarge(maxBytes);
      }
      return {
        field: disposition.field,
        fileName: disposition.fileName,
        contentType: headerValue(headerText, "content-type"),
        offset: contentStart,
        sizeBytes,
      };
    }
    cursor = next + 2 + delimiter.length;
  }
  return null;
}

async function findInFile(
  handle: FileHandle,
  fileSize: number,
  start: number,
  needle: Buffer,
  maxScanBytes: number = fileSize - start,
): Promise<number> {
  const end = Math.min(fileSize, start + Math.max(0, maxScanBytes));
  let position = start;
  let carry = Buffer.alloc(0);
  while (position < end) {
    const length = Math.min(MULTIPART_CHUNK_BYTES, end - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead <= 0) break;
    const current = chunk.subarray(0, bytesRead);
    const haystack = carry.length === 0 ? current : Buffer.concat([carry, current]);
    const found = haystack.indexOf(needle);
    if (found >= 0) {
      return position - carry.length + found;
    }
    const keep = Math.min(needle.length - 1, haystack.length);
    carry = Buffer.from(haystack.subarray(haystack.length - keep));
    position += bytesRead;
  }
  return -1;
}

async function readExactly(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, offset + read);
    if (result.bytesRead === 0) {
      throw invalidMultipart();
    }
    read += result.bytesRead;
  }
  return buffer;
}

function invalidMultipart(): AppError {
  return new AppError("IMPORT_FILE_INVALID", "multipart 请求格式不完整");
}

function fileTooLarge(maxBytes: number): AppError {
  return new AppError(
    "IMPORT_FILE_INVALID",
    "文件超过上限（" + Math.floor(maxBytes / 1024 / 1024) + " MB），请拆分后再导入",
  );
}
