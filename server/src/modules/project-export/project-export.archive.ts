import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import type { ProjectExportFileRef } from "../file/index.js";

export type ProjectExportFormat = "xlsx" | "zip";
export type ProjectArchiveAttachmentStatus = "included" | "missing" | "skipped";

export const PROJECT_ARCHIVE_MAX_FILE_COUNT = 3_000;
export const PROJECT_ARCHIVE_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PROJECT_ARCHIVE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface ProjectArchiveAttachmentSource {
  /** 稳定键只用于本次导出内回填 Excel 链接，不写入 ZIP 或 manifest。 */
  key: string;
  sourcePage: string;
  sourceRow: number;
  sourceRecord: string;
  attachmentType: string;
  /** 相对「附件」目录的子路径，如「日报及问题汇总/现场工作附图」。 */
  directory: string;
  fileId: string;
  fileName: string;
}

export interface ProjectArchiveFile {
  relativePath: string;
  zipDirectory: string;
  fileName: string;
  fileId: string;
  ref: ProjectExportFileRef | null;
  sizeBytes: number | null;
  sha256: string | null;
  status: ProjectArchiveAttachmentStatus;
}

export interface ProjectArchiveAttachmentReference extends ProjectArchiveAttachmentSource {
  file: ProjectArchiveFile;
}

export interface ProjectArchivePlan {
  references: ProjectArchiveAttachmentReference[];
  files: ProjectArchiveFile[];
}

export interface ProjectArchiveManifestAttachment {
  sourcePage: string;
  sourceRow: number;
  sourceRecord: string;
  attachmentType: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  status: ProjectArchiveAttachmentStatus;
}

export interface ProjectArchiveManifest {
  schemaVersion: 1;
  exportedAt: string;
  project: { code: string; name: string };
  workbook: string;
  attachments: ProjectArchiveManifestAttachment[];
  summary: {
    attachmentCount: number;
    fileCount: number;
    includedCount: number;
    includedFileCount: number;
    missingCount: number;
    skippedCount: number;
    attachmentBytes: number;
  };
}

const WINDOWS_INVALID = /[\\/:*?"<>|\u0000-\u001f]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;
const LEADING_DOTS = /^\.+/;

/** 保留中文与项目编号外面的方括号；只清掉跨平台文件名 / ZIP 路径不能安全使用的字符。 */
export function sanitizeProjectArchiveSegment(value: string, fallback: string, maxLength = 140): string {
  let result = value.replace(WINDOWS_INVALID, "_").replace(LEADING_DOTS, "").replace(TRAILING_DOTS_OR_SPACES, "").trim();
  if (result === "") result = fallback;
  return result.slice(0, maxLength).replace(TRAILING_DOTS_OR_SPACES, "") || fallback;
}

export function projectArchiveHref(relativePath: string): string {
  return "./" + relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function splitFileName(value: string): { stem: string; extension: string } {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { stem: value, extension: "" };
  return { stem: value.slice(0, dot), extension: value.slice(dot) };
}

function allocFileName(directory: string, requestedName: string, fileId: string, used: Map<string, string>): string {
  const clean = sanitizeProjectArchiveSegment(requestedName, "文件");
  const { stem, extension } = splitFileName(clean);
  let candidate = clean;
  let suffix = 2;
  while (true) {
    const key = directory.toLowerCase() + "\u0000" + candidate.toLowerCase();
    const owner = used.get(key);
    if (owner === undefined || owner === fileId) {
      used.set(key, fileId);
      return candidate;
    }
    candidate = sanitizeProjectArchiveSegment(stem.slice(0, Math.max(1, 120 - extension.length)) + "_" + String(suffix), "文件") + extension;
    suffix += 1;
  }
}

/**
 * 只规划被 Excel 业务行引用的附件，不打包项目文件库里的散文件。
 * 同一目录中的同一文件只入包一次；同目录重名文件追加 _2、_3，绝不覆盖。
 */
export function planProjectArchiveAttachments(
  sources: readonly ProjectArchiveAttachmentSource[],
  refs: ReadonlyMap<string, ProjectExportFileRef>,
): ProjectArchivePlan {
  const references: ProjectArchiveAttachmentReference[] = [];
  const files: ProjectArchiveFile[] = [];
  const fileByKey = new Map<string, ProjectArchiveFile>();
  const usedNames = new Map<string, string>();
  let includedCandidates = 0;
  let reservedBytes = 0;

  for (const source of sources) {
    const ref = refs.get(source.fileId) ?? null;
    const directory = ["附件", ...source.directory.split("/").map((part) => sanitizeProjectArchiveSegment(part, "附件"))].join("/");
    const planKey = directory.toLowerCase() + "\u0000" + source.fileId;
    let file = fileByKey.get(planKey);
    if (file === undefined) {
      const fileName = allocFileName(directory, ref?.name ?? source.fileName, source.fileId, usedNames);
      let status: ProjectArchiveAttachmentStatus = "included";
      if (ref === null || ref.objectKey === null) {
        status = "missing";
      } else if (ref.sizeBytes !== null && ref.sizeBytes > PROJECT_ARCHIVE_MAX_FILE_BYTES) {
        status = "skipped";
      } else if (includedCandidates >= PROJECT_ARCHIVE_MAX_FILE_COUNT) {
        status = "skipped";
      } else if (ref.sizeBytes !== null && reservedBytes + ref.sizeBytes > PROJECT_ARCHIVE_MAX_TOTAL_BYTES) {
        status = "skipped";
      }
      if (status === "included") {
        includedCandidates += 1;
        reservedBytes += ref?.sizeBytes ?? 0;
      }
      file = {
        relativePath: directory + "/" + fileName,
        zipDirectory: directory,
        fileName,
        fileId: source.fileId,
        ref,
        sizeBytes: ref?.sizeBytes ?? null,
        sha256: null,
        status,
      };
      files.push(file);
      fileByKey.set(planKey, file);
    }
    references.push({ ...source, file });
  }
  return { references, files };
}

export function projectArchiveLinks(plan: ProjectArchivePlan): Map<string, string> {
  const links = new Map<string, string>();
  for (const reference of plan.references) {
    if (reference.file.status !== "included") continue;
    links.set(reference.key, projectArchiveHref(reference.file.relativePath));
  }
  return links;
}

export function buildProjectArchiveManifest(input: {
  project: { code: string; name: string };
  workbook: string;
  plan: ProjectArchivePlan;
  exportedAt: Date;
}): ProjectArchiveManifest {
  const attachments = input.plan.references.map((reference) => ({
    sourcePage: reference.sourcePage,
    sourceRow: reference.sourceRow,
    sourceRecord: reference.sourceRecord,
    attachmentType: reference.attachmentType,
    fileName: reference.file.fileName,
    relativePath: reference.file.relativePath,
    sizeBytes: reference.file.sizeBytes,
    sha256: reference.file.sha256,
    status: reference.file.status,
  }));
  const includedFiles = input.plan.files.filter((file) => file.status === "included");
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt.toISOString(),
    project: input.project,
    workbook: input.workbook,
    attachments,
    summary: {
      attachmentCount: attachments.length,
      fileCount: input.plan.files.length,
      includedCount: attachments.filter((attachment) => attachment.status === "included").length,
      includedFileCount: includedFiles.length,
      missingCount: attachments.filter((attachment) => attachment.status === "missing").length,
      skippedCount: attachments.filter((attachment) => attachment.status === "skipped").length,
      attachmentBytes: includedFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    },
  };
}

export function projectArchiveManifestJson(manifest: ProjectArchiveManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export interface ProjectZipWriteResult {
  sizeBytes: number;
  sha256: string;
}

interface ZipCentralEntry {
  name: Buffer;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32Update(previous: number, bytes: Uint8Array): number {
  let crc = previous;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return crc >>> 0;
}

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: ((hours << 11) | (minutes << 5) | seconds) & 0xffff,
    date: (((year - 1980) << 9) | (month << 5) | day) & 0xffff,
  };
}

/** 不依赖第三方库的 ZIP 写入器：顺序写临时文件、原生 deflate、支持 UTF-8 路径与 Data Descriptor。 */
export class ProjectZipWriter {
  private handle: FileHandle | null = null;
  private offset = 0;
  private readonly entries: ZipCentralEntry[] = [];
  private readonly dosTime: number;
  private readonly dosDate: number;
  private aborted = false;

  constructor(readonly filePath: string, now = new Date()) {
    const stamp = dosDateTime(now);
    this.dosTime = stamp.time;
    this.dosDate = stamp.date;
  }

  async open(): Promise<void> {
    if (this.handle !== null) return;
    this.handle = await open(this.filePath, "wx", 0o600);
  }

  async addBuffer(name: string, bytes: Uint8Array, compress = true): Promise<ProjectZipWriteResult> {
    return await this.addStream(name, Readable.from([bytes]), bytes.byteLength, { compress });
  }

  async addStream(
    name: string,
    source: Readable,
    declaredSize: number,
    options: { compress?: boolean; maxBytes?: number; onChunk?: (chunk: Buffer) => void; hash?: boolean } = {},
  ): Promise<ProjectZipWriteResult> {
    const handle = this.requireHandle();
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.byteLength === 0 || nameBytes.byteLength > 0xffff) throw new Error("ZIP 条目名称长度非法");
    const compress = options.compress !== false;
    const method = compress ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const localHeaderOffset = this.offset;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_FLAGS, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(this.dosTime, 10);
    localHeader.writeUInt16LE(this.dosDate, 12);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    await this.write(localHeader);
    await this.write(nameBytes);

    let crc = 0xffffffff;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const hash = options.hash === false ? undefined : createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, bytes);
        uncompressedSize += bytes.byteLength;
        if (options.maxBytes !== undefined && uncompressedSize > options.maxBytes) {
          callback(new Error("ZIP 条目超过允许的大小"));
          return;
        }
        options.onChunk?.(bytes);
        hash?.update(bytes);
        callback(null, bytes);
      },
    });
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
          (bytesWritten) => {
            compressedSize += bytesWritten;
            callback();
          },
          callback,
        );
      },
    });
    try {
      if (compress) {
        await pipeline(source, meter, createDeflateRaw({ level: 6 }), sink);
      } else {
        await pipeline(source, meter, sink);
      }
    } catch (error) {
      source.destroy();
      throw error;
    }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(finalCrc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(uncompressedSize, 12);
    await this.write(descriptor);
    this.entries.push({
      name: nameBytes,
      flags: ZIP_FLAGS,
      method,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      crc32: finalCrc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    if (declaredSize >= 0 && uncompressedSize !== declaredSize) {
      // 对象存储长度可能被并发重写；manifest 以实际写入字节为准，不因预检值不同截断文件。
    }
    return { sizeBytes: uncompressedSize, sha256: hash?.digest("hex") ?? "" };
  }

  /**
   * 直接复制 ZIP 条目已有的压缩字节，保留来源 CRC、压缩算法与尺寸。
   * 用于工作簿注入等只改写少量 XML 条目的场景，避免未修改内容再次解压 / 压缩。
   */
  async addCompressedStream(
    name: string,
    source: Readable,
    metadata: { method: number; crc32: number; compressedSize: number; uncompressedSize: number },
  ): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.byteLength === 0 || nameBytes.byteLength > 0xffff) throw new Error("ZIP 条目名称长度非法");
    if (!Number.isInteger(metadata.method) || metadata.method < 0 || metadata.method > 0xffff) {
      throw new Error("ZIP 压缩条目元数据非法");
    }
    for (const value of [metadata.crc32, metadata.compressedSize, metadata.uncompressedSize]) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("ZIP 压缩条目元数据非法");
    }

    const localHeaderOffset = this.offset;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_FLAGS, 6);
    localHeader.writeUInt16LE(metadata.method, 8);
    localHeader.writeUInt16LE(this.dosTime, 10);
    localHeader.writeUInt16LE(this.dosDate, 12);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    await this.write(localHeader);
    await this.write(nameBytes);

    let compressedSize = 0;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
          (bytesWritten) => {
            compressedSize += bytesWritten;
            callback();
          },
          callback,
        );
      },
    });
    try {
      await pipeline(source, sink);
    } catch (error) {
      source.destroy();
      throw error;
    }
    if (compressedSize !== metadata.compressedSize) throw new Error("ZIP 压缩条目长度不一致");

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(metadata.crc32, 4);
    descriptor.writeUInt32LE(metadata.compressedSize, 8);
    descriptor.writeUInt32LE(metadata.uncompressedSize, 12);
    await this.write(descriptor);
    this.entries.push({
      name: nameBytes,
      flags: ZIP_FLAGS,
      method: metadata.method,
      dosTime: this.dosTime,
      dosDate: this.dosDate,
      crc32: metadata.crc32,
      compressedSize: metadata.compressedSize,
      uncompressedSize: metadata.uncompressedSize,
      localHeaderOffset,
    });
  }

  async close(): Promise<void> {
    const handle = this.requireHandle();
    if (this.entries.length > 0xffff) throw new Error("ZIP 条目数超过 65535");
    const centralOffset = this.offset;
    let centralSize = 0;
    for (const entry of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x0314, 4);
      central.writeUInt16LE(ZIP_VERSION, 6);
      central.writeUInt16LE(entry.flags, 8);
      central.writeUInt16LE(entry.method, 10);
      central.writeUInt16LE(entry.dosTime, 12);
      central.writeUInt16LE(entry.dosDate, 14);
      central.writeUInt32LE(entry.crc32, 16);
      central.writeUInt32LE(entry.compressedSize, 20);
      central.writeUInt32LE(entry.uncompressedSize, 24);
      central.writeUInt16LE(entry.name.byteLength, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      central.writeUInt32LE(entry.localHeaderOffset, 42);
      await this.write(central);
      await this.write(entry.name);
      centralSize += central.byteLength + entry.name.byteLength;
    }
    if (centralOffset > 0xffffffff || centralSize > 0xffffffff || this.offset > 0xffffffff) {
      throw new Error("ZIP 超过 4GB 流式导出上限");
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.handle = null;
    await handle.sync();
    await handle.close();
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }

  private requireHandle(): FileHandle {
    if (this.handle === null) throw new Error("ZIP 写入器尚未打开或已经关闭");
    return this.handle;
  }

  private async write(bytes: Uint8Array): Promise<number> {
    const handle = this.requireHandle();
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await handle.write(bytes, written, bytes.byteLength - written, null);
      if (result.bytesWritten <= 0) throw new Error("ZIP 临时文件写入失败");
      written += result.bytesWritten;
      this.offset += result.bytesWritten;
    }
    return written;
  }
}

export function shouldCompressProjectArchiveEntry(name: string): boolean {
  return !/\.(?:jpe?g|png|gif|webp|zip|7z|rar|xlsx|docx|pptx|pdf)$/i.test(name);
}
