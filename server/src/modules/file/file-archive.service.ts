import { Injectable, Logger } from "@nestjs/common";
import { FileArchiveRequestSchema, FileArchiveResponseSchema, z } from "@libiaolink/contracts";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipWriter, shouldCompressZipEntry } from "../../common/zip/index.js";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { contentDisposition, ObjectStorage, versionFileName } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import {
  FILE_ARCHIVE_CLEANUP_DELAY_MS,
  FILE_ARCHIVE_GENERATION_TIMEOUT_MS,
  FILE_ARCHIVE_MAX_FILE_BYTES,
  FILE_ARCHIVE_MAX_ITEM_COUNT,
  FILE_ARCHIVE_MAX_TOTAL_BYTES,
  fileArchiveObjectKey,
} from "./file-archive.constants.js";
import { FileArchiveConcurrency } from "./file-archive.concurrency.js";
import { FileArchiveRepository, type FileArchiveProjectRow } from "./file-archive.repository.js";
import type { FileRow, FileVersionRow } from "./file.repository.js";

type FileArchiveRequest = z.infer<typeof FileArchiveRequestSchema>;
type FileArchiveResponse = z.infer<typeof FileArchiveResponseSchema>;
type FileArchiveItem = FileArchiveRequest["items"][number];

interface ResolvedArchiveItem {
  file: FileRow;
  version: FileVersionRow;
  entryName: string;
}

const WINDOWS_INVALID = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;
const LEADING_DOTS = /^\.+/;

/** 清洗 ZIP 路径片段：去控制字符 / 路径分隔符 / 设备字符，保留中文、日文、韩文与 emoji。 */
export function sanitizeArchiveSegment(value: string, fallback: string, maxLength = 140): string {
  let result = value
    .normalize("NFC")
    .replace(WINDOWS_INVALID, "_")
    .replace(LEADING_DOTS, "")
    .replace(TRAILING_DOTS_OR_SPACES, "")
    .trim();
  if (result === "") result = fallback;
  const chars = Array.from(result);
  if (chars.length > maxLength) result = chars.slice(0, maxLength).join("");
  return result.replace(TRAILING_DOTS_OR_SPACES, "") || fallback;
}

export function archiveProjectDirectoryName(project: Pick<FileArchiveProjectRow, "code" | "name">): string {
  const code = sanitizeArchiveSegment(project.code, "项目", 60);
  const name = sanitizeArchiveSegment(project.name, "未命名项目", 100);
  return sanitizeArchiveSegment("[" + code + "] " + name, "项目", 140) + "_项目文件";
}

function splitArchiveFileName(value: string): { stem: string; extension: string } {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { stem: value, extension: "" };
  return { stem: value.slice(0, dot), extension: value.slice(dot) };
}

function allocateArchiveEntryName(requestedName: string, used: Set<string>, version: FileVersionRow): string {
  const forcedName = versionFileName(requestedName, version.objectKey);
  const sanitized = sanitizeArchiveSegment(forcedName, "文件", 160);
  const { stem, extension } = splitArchiveFileName(sanitized);
  let candidate = sanitized;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase("en-US"))) {
    const suffixText = "_" + String(suffix);
    const maxStemLength = Math.max(1, 160 - extension.length - suffixText.length);
    candidate = sanitizeArchiveSegment(
      Array.from(stem).slice(0, maxStemLength).join("") + suffixText,
      "文件",
      160,
    ) + extension;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

/**
 * 项目文件批量 ZIP（POST /projects/{id}/files/download-archive）。
 *
 * 全有或全无：所有选择先完整校验，再流式写临时 ZIP；任一版本不可见、对象缺失、大小 / 哈希不符、超限或写包失败时
 * 整批失败。成功后仅返回一个短时签名地址，浏览器不需要也不允许把整包读成 Blob。
 */
@Injectable()
export class FileArchiveService {
  private readonly logger = new Logger(FileArchiveService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FileArchiveRepository,
    private readonly storage: ObjectStorage,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly concurrency: FileArchiveConcurrency,
  ) {}

  async createArchive(
    projectId: string,
    body: FileArchiveRequest,
    actorId: string,
    signal?: AbortSignal,
  ): Promise<FileArchiveResponse> {
    throwIfArchiveAborted(signal);
    const selected = dedupeArchiveItems(body.items);
    if (selected.length === 0 || selected.length > FILE_ARCHIVE_MAX_ITEM_COUNT) {
      throw new AppError("VALIDATION_FAILED", "单批请选择 1 到 " + String(FILE_ARCHIVE_MAX_ITEM_COUNT) + " 个文件版本");
    }

    const access = await this.permission.assertProjectVisible(actorId, projectId);
    await this.permission.assertCan(
      actorId,
      "file.download",
      { member: access.member, projectManager: access.projectManager, groupAccessLevel: access.groupAccessLevel },
      "无权限打包下载项目文件（file.download）",
    );

    const lock = await this.concurrency.acquire(actorId);
    if (lock === null) {
      throw new AppError("RATE_LIMITED", "当前账号已有文件打包任务，请等待完成后再试");
    }
    try {
      throwIfArchiveAborted(signal);
      return await this.createArchiveLocked(projectId, selected, actorId, signal);
    } finally {
      await lock.release();
    }
  }

  private async createArchiveLocked(
    projectId: string,
    selected: readonly FileArchiveItem[],
    actorId: string,
    signal: AbortSignal | undefined,
  ): Promise<FileArchiveResponse> {
    throwIfArchiveAborted(signal);
    const project = await this.repository.findProject(projectId);
    if (project === null || project.deletedAt !== null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }

    const [files, versions] = await Promise.all([
      this.repository.findFilesByIds(selected.map((item) => item.fileId)),
      this.repository.findVersionsByIds(selected.map((item) => item.versionId)),
    ]);
    throwIfArchiveAborted(signal);
    const fileById = new Map(files.map((file) => [file.id, file] as const));
    const versionById = new Map(versions.map((version) => [version.id, version] as const));
    const resolved: ResolvedArchiveItem[] = [];
    const usedNames = new Set<string>();
    let totalBytes = 0;

    for (const item of selected) {
      const file = fileById.get(item.fileId);
      const version = versionById.get(item.versionId);
      if (
        file === undefined ||
        file.projectId !== projectId ||
        file.status === "recycled" ||
        file.recycledAt !== null ||
        version === undefined ||
        version.fileId !== file.id
      ) {
        throw new AppError("NOT_FOUND", "所选文件或版本不存在、已回收或不属于该项目");
      }
      if (version.sizeBytes > FILE_ARCHIVE_MAX_FILE_BYTES) {
        throw archiveLimitError("单个文件超过 200 MB，无法打包，请缩小选择范围");
      }
      totalBytes += version.sizeBytes;
      if (totalBytes > FILE_ARCHIVE_MAX_TOTAL_BYTES) {
        throw archiveLimitError("所选文件总量超过 2 GB，无法打包，请缩小选择范围");
      }
      resolved.push({
        file,
        version,
        entryName: allocateArchiveEntryName(item.entryName ?? file.name, usedNames, version),
      });
    }

    const batchId = randomUUID();
    const objectKey = fileArchiveObjectKey(batchId);
    const projectDirectory = archiveProjectDirectoryName(project);
    const fileName = projectDirectory + ".zip";
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "libiaolink-file-archive-"));
    const zipPath = join(temporaryDirectory, "archive.zip");
    let uploaded = false;
    try {
      await chmod(temporaryDirectory, 0o700);
      await this.writeArchive(zipPath, projectDirectory, resolved, batchId, signal);
      throwIfArchiveAborted(signal);
      const zipStat = await stat(zipPath);
      uploaded = true;
      await this.storage.putObjectStream({
        objectKey,
        body: createReadStream(zipPath),
        sizeBytes: zipStat.size,
        contentType: "application/zip",
        metadata: { batchId, itemCount: String(resolved.length) },
      });
      throwIfArchiveAborted(signal);

      const signed = await this.storage.signDownloadUrl({
        objectKey,
        responseContentType: "application/zip",
        responseContentDisposition: contentDisposition(fileName),
        expiresInSeconds: this.config.env.S3_DOWNLOAD_URL_TTL_SECONDS,
      });
      throwIfArchiveAborted(signal);
      await this.repository.enqueueCleanup({
        batchId,
        objectKey,
        runAt: new Date(signed.expiresAt.getTime() + FILE_ARCHIVE_CLEANUP_DELAY_MS),
      });

      throwIfArchiveAborted(signal);
      await this.database.db.transaction(async (tx) => {
        for (const item of resolved) {
          await this.audit.record(tx, {
            actorId,
            action: "download",
            objectType: "file",
            objectId: item.file.id,
            projectId,
            projectCode: project.code,
            projectName: project.name,
            summary:
              "批量下载文件：" +
              item.file.name +
              "（版本 v" +
              String(item.version.seq) +
              "；ZIP 批次 " +
              batchId +
              "）",
            metadata: { versionId: item.version.id, batchId, archive: true, itemCount: resolved.length },
          });
        }
      });

      return {
        batchId,
        fileName,
        url: signed.url,
        sizeBytes: zipStat.size,
        expiresAt: signed.expiresAt.toISOString(),
        itemCount: resolved.length,
      };
    } catch (error) {
      if (uploaded) {
        await this.storage.purgeObject(objectKey).catch(() => {
          this.logger.warn("批量下载失败后清理临时 ZIP 失败（批次 " + batchId + "）");
        });
      }
      throw error;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {
        this.logger.warn("清理批量下载临时目录失败（批次 " + batchId + "）");
      });
    }
  }

  private async writeArchive(
    zipPath: string,
    projectDirectory: string,
    items: readonly ResolvedArchiveItem[],
    batchId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const writer = new ZipWriter(zipPath);
    await writer.open();
    const abort = new AbortController();
    let timedOut = false;
    const forwardAbort = (): void => abort.abort(signal === undefined ? undefined : abortReason(signal));
    if (signal?.aborted === true) {
      forwardAbort();
    } else {
      signal?.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort(new Error("文件打包超时"));
    }, FILE_ARCHIVE_GENERATION_TIMEOUT_MS);
    try {
      for (const item of items) {
        abort.signal.throwIfAborted();
        const object = await this.storage.getObjectStream(item.version.objectKey);
        if (object === null) {
          throw new AppError("INTERNAL", "所选文件内容暂不可用，整批打包已取消");
        }
        if (object.sizeBytes !== item.version.sizeBytes) {
          throw new AppError("FILE_HASH_MISMATCH", "源文件大小与版本记录不一致，整批打包已取消");
        }
        const entryName = projectDirectory + "/" + item.entryName;
        const written = await writer.addStream(entryName, object.stream, object.sizeBytes, {
          compress: shouldCompressZipEntry(item.entryName),
          maxBytes: FILE_ARCHIVE_MAX_FILE_BYTES,
          signal: abort.signal,
        });
        if (
          written.sizeBytes !== item.version.sizeBytes ||
          written.sha256.toLocaleLowerCase("en-US") !== item.version.contentHash.toLocaleLowerCase("en-US")
        ) {
          throw new AppError("FILE_HASH_MISMATCH", "源文件内容与版本记录不一致，整批打包已取消");
        }
      }
      await writer.close();
    } catch (error) {
      await writer.abort();
      if (timedOut) {
        throw new AppError("INTERNAL", "文件打包超时，请减少选择文件后重试");
      }
      if (signal?.aborted === true) {
        throw abortReason(signal);
      }
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.warn("批量下载 ZIP 生成失败（批次 " + batchId + "）");
      throw new AppError("INTERNAL", "文件打包失败，请稍后重试");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

function dedupeArchiveItems(items: readonly FileArchiveItem[]): FileArchiveItem[] {
  const unique = new Map<string, FileArchiveItem>();
  for (const item of items) {
    const key = item.fileId + ":" + item.versionId;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function archiveLimitError(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof AppError ? signal.reason : new AppError("INTERNAL", "文件打包已取消");
}

function throwIfArchiveAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}
