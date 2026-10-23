import { Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { Env } from "../config/env.js";
import { SINGLE_COPY_MAX_BYTES } from "./part-plan.js";
import {
  ObjectStorage,
  StorageError,
  type CompleteMultipartUploadInput,
  type CopyObjectInput,
  type CopyObjectResult,
  type CreateMultipartUploadInput,
  type DownloadUrlInput,
  type GetObjectResult,
  type ObjectStreamResult,
  type ObjectPrefixResult,
  type MultipartUploadKeyInput,
  type MultipartUploadRef,
  type ObjectHead,
  type PartUploadUrlInput,
  type PurgeObjectResult,
  type PurgePrefixResult,
  type PutObjectInput,
  type SignedUrl,
  type UploadedPart,
} from "./object-storage.js";

/** 日志端口：单测传空实现，避免污染输出。 */
export interface StorageLogger {
  warn(message: string): void;
}

export interface S3ObjectStorageOptions {
  client: S3Client;
  bucket: string;
  partUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  /** 需要从日志里抹掉的敏感串（访问密钥等，CONTRIBUTING §12）。 */
  secretValues?: readonly string[];
  logger?: StorageLogger;
}

/** 分片相关 S3 错误：重传可解（契约 409 UPLOAD_INCOMPLETE）。 */
const PART_CONFLICT_S3_ERRORS = new Set([
  "InvalidPart",
  "InvalidPartOrder",
  "EntityTooSmall",
  "EntityTooLarge",
]);

/** 单页 ListParts 上限（S3 协议最大值）；最多翻 20 页，防异常响应下的死循环。 */
const LIST_PARTS_PAGE_SIZE = 1000;
const LIST_PARTS_MAX_PAGES = 20;

/** 按版本删除的批量上限（S3 DeleteObjects 单请求上限）与 ListObjectVersions 翻页上限。 */
const DELETE_VERSIONS_BATCH = 1000;
const LIST_VERSIONS_MAX_PAGES = 20;
/** 项目前缀清理：最多翻 100 页（约 10 万个版本）；超出直接报错，绝不静默漏删。 */
const LIST_PREFIX_MAX_PAGES = 100;

export class S3ObjectStorage extends ObjectStorage {
  readonly bucket: string;

  private readonly client: S3Client;
  private readonly partUrlTtlSeconds: number;
  private readonly downloadUrlTtlSeconds: number;
  private readonly secretValues: readonly string[];
  private readonly logger: StorageLogger;

  constructor(options: S3ObjectStorageOptions) {
    super();
    this.client = options.client;
    this.bucket = options.bucket;
    this.partUrlTtlSeconds = options.partUrlTtlSeconds;
    this.downloadUrlTtlSeconds = options.downloadUrlTtlSeconds;
    this.secretValues = (options.secretValues ?? []).filter((value) => value !== "");
    this.logger = options.logger ?? new Logger(S3ObjectStorage.name);
  }

  async createMultipartUpload(input: CreateMultipartUploadInput): Promise<MultipartUploadRef> {
    const output = await this.call("CreateMultipartUpload", () =>
      this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          ContentType: input.contentType ?? undefined,
          Metadata: input.metadata,
        }),
      ),
    );
    if (!output.UploadId) {
      throw new StorageError("unavailable", "对象存储未返回 UploadId");
    }
    return { objectKey: input.objectKey, uploadId: output.UploadId };
  }

  async signPartUploadUrl(input: PartUploadUrlInput): Promise<SignedUrl> {
    const ttl = input.expiresInSeconds ?? this.partUrlTtlSeconds;
    const url = await this.call("UploadPartPresign", () =>
      getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
        }),
        { expiresIn: ttl },
      ),
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async listParts(input: MultipartUploadKeyInput): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    for (let page = 0; page < LIST_PARTS_MAX_PAGES; page += 1) {
      const output = await this.call("ListParts", () =>
        this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: input.objectKey,
            UploadId: input.uploadId,
            PartNumberMarker: marker,
            MaxParts: LIST_PARTS_PAGE_SIZE,
          }),
        ),
      );
      for (const part of output.Parts ?? []) {
        if (part.PartNumber === undefined || part.ETag === undefined) {
          continue;
        }
        parts.push({
          partNumber: part.PartNumber,
          sizeBytes: part.Size ?? 0,
          etag: part.ETag.trim(),
          lastModified: part.LastModified ?? null,
        });
      }
      const next = output.IsTruncated ? output.NextPartNumberMarker : undefined;
      if (!next) {
        break;
      }
      marker = next;
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<{ etag: string | null }> {
    if (input.parts.length === 0) {
      throw new StorageError("part_conflict", "分片清单为空，无法合并");
    }
    const parts = [...input.parts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag.trim() }));
    const output = await this.call("CompleteMultipartUpload", () =>
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    );
    return { etag: output.ETag ? output.ETag.trim() : null };
  }

  async abortMultipartUpload(input: MultipartUploadKeyInput): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
        }),
      );
    } catch (error) {
      if (s3ErrorName(error) === "NoSuchUpload") {
        this.logger.warn(`S3 AbortMultipartUpload 忽略：会话已不存在（${input.objectKey}）`);
        return;
      }
      throw this.fail("AbortMultipartUpload", error);
    }
  }

  async headObject(objectKey: string): Promise<ObjectHead | null> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return {
        objectKey,
        sizeBytes: output.ContentLength ?? 0,
        etag: output.ETag ? output.ETag.trim() : null,
        contentType: output.ContentType ?? null,
        lastModified: output.LastModified ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.fail("HeadObject", error);
    }
  }

  async signDownloadUrl(input: DownloadUrlInput): Promise<SignedUrl> {
    const ttl = input.expiresInSeconds ?? this.downloadUrlTtlSeconds;
    const url = await this.call("GetObjectPresign", () =>
      getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          ResponseContentType: input.responseContentType,
          ResponseContentDisposition:
            input.responseContentDisposition ?? (input.fileName ? contentDisposition(input.fileName) : undefined),
          ResponseCacheControl: input.responseCacheControl,
        }),
        { expiresIn: ttl },
      ),
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async getObject(objectKey: string): Promise<GetObjectResult | null> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      const bytes = output.Body ? await output.Body.transformToByteArray() : new Uint8Array();
      return {
        objectKey,
        bytes,
        contentType: output.ContentType ?? null,
        sizeBytes: bytes.byteLength,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.fail("GetObject", error);
    }
  }

  override async getObjectStream(objectKey: string): Promise<ObjectStreamResult | null> {
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      if (!output.Body) return null;
      if (!(output.Body instanceof Readable)) throw new StorageError("unavailable", "当前运行环境不支持对象读取流");
      return { stream: output.Body, sizeBytes: output.ContentLength ?? 0, contentType: output.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.fail("GetObjectStream", error);
    }
  }

  override async putObjectStream(input: {
    objectKey: string;
    body: Readable;
    sizeBytes: number;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    await this.call("PutObjectStream", () => this.client.send(new PutObjectCommand({ Bucket: this.bucket,
      Key: input.objectKey, Body: input.body, ContentLength: input.sizeBytes, ContentType: input.contentType,
      Metadata: input.metadata })));
  }

  async readObjectPrefix(objectKey: string, maxBytes: number): Promise<ObjectPrefixResult | null> {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new StorageError("unavailable", "对象前缀读取长度非法");
    }
    if (maxBytes === 0) {
      return { objectKey, bytes: new Uint8Array(), contentType: null };
    }
    try {
      const output = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: `bytes=0-${maxBytes - 1}`,
        }),
      );
      const bytes = output.Body ? await output.Body.transformToByteArray() : new Uint8Array();
      return { objectKey, bytes, contentType: output.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.fail("GetObjectPrefix", error);
    }
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string | null }> {
    const output = await this.call("PutObject", () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          Body: input.body,
          ContentType: input.contentType ?? undefined,
          Metadata: input.metadata,
        }),
      ),
    );
    return { etag: output.ETag ? output.ETag.trim() : null };
  }

  async copyObject(input: CopyObjectInput): Promise<CopyObjectResult> {
    const source = await this.headObject(input.sourceKey);
    if (source === null) {
      throw new StorageError("object_not_found", `源对象不存在（CopyObject / ${input.sourceKey}）`);
    }
    if (source.sizeBytes > SINGLE_COPY_MAX_BYTES) {
      throw new StorageError(
        "object_too_large",
        `源对象 ${source.sizeBytes} 字节超过单次复制上限 ${SINGLE_COPY_MAX_BYTES} 字节（需 UploadPartCopy）`,
      );
    }
    const replaceMetadata = input.contentType !== undefined || input.metadata !== undefined;
    const output = await this.call("CopyObject", () =>
      this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: input.destinationKey,
          CopySource: `${this.bucket}/${input.sourceKey}`,
          ContentType: replaceMetadata ? input.contentType ?? undefined : undefined,
          Metadata: replaceMetadata ? input.metadata : undefined,
          MetadataDirective: replaceMetadata ? "REPLACE" : "COPY",
        }),
      ),
    );
    return {
      etag: output.CopyObjectResult?.ETag?.trim() ?? null,
      versionId: output.VersionId ?? null,
    };
  }

  async purgeObject(objectKey: string): Promise<PurgeObjectResult> {
    const listed = await this.listVersionEntries(objectKey);
    const versioned = listed.filter((entry) => entry.versionId !== "null");
    if (versioned.length === 0) {
      // 未开启版本控制（或该键只剩 delete marker）：确认对象在不在，在则普通删除 —— 不无脑调
      // DeleteObject，避免在版本化桶里给不存在的键写一个 delete marker。
      const head = await this.headObject(objectKey);
      if (head === null) {
        return { deletedVersions: 0, deleteMarkers: 0 };
      }
      await this.call("DeleteObject", () =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey })),
      );
      return { deletedVersions: 1, deleteMarkers: 0 };
    }
    let deletedVersions = 0;
    let deleteMarkers = 0;
    for (let start = 0; start < versioned.length; start += DELETE_VERSIONS_BATCH) {
      const batch = versioned.slice(start, start + DELETE_VERSIONS_BATCH);
      const output = await this.call("DeleteObjectVersions", () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: batch.map((entry) => ({ Key: objectKey, VersionId: entry.versionId })),
              Quiet: true,
            },
          }),
        ),
      );
      if (output.Errors && output.Errors.length > 0) {
        throw new StorageError(
          "unavailable",
          `按版本删除失败：${output.Errors[0]?.Code ?? "unknown"}`,
        );
      }
      deletedVersions += batch.filter((entry) => !entry.isDeleteMarker).length;
      deleteMarkers += batch.filter((entry) => entry.isDeleteMarker).length;
    }
    return { deletedVersions, deleteMarkers };
  }

  /**
   * 项目彻底删除用的前缀清空：列举 prefix 下所有键的版本 + delete marker，分批按版本删。
   * 前缀必须以 / 结尾，避免 projects/{id}/ 误伤同前缀的其它项目；未开启版本控制时按普通键删。
   */
  async purgePrefix(prefix: string): Promise<PurgePrefixResult> {
    if (prefix.trim() === "" || !prefix.endsWith("/")) {
      throw new StorageError("unavailable", "对象前缀不能为空且必须以 / 结尾");
    }
    const entries = await this.listPrefixEntries(prefix);
    if (entries.length === 0) {
      // 兼容未开版本控制且 ListObjectVersions 返回空集的 S3 实现（本地 MinIO 实测）：
      // 退回 ListObjectsV2 按当前对象键普通删除；确实无对象时自然返回全 0。
      const keys = await this.listCurrentObjectKeys(prefix);
      for (let start = 0; start < keys.length; start += DELETE_VERSIONS_BATCH) {
        const batch = keys.slice(start, start + DELETE_VERSIONS_BATCH);
        const output = await this.call("DeleteObjectsByPrefix", () =>
          this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
            }),
          ),
        );
        if (output.Errors && output.Errors.length > 0) {
          throw new StorageError("unavailable", "按前缀删除失败：" + (output.Errors[0]?.Code ?? "unknown"));
        }
      }
      return { deletedVersions: keys.length, deleteMarkers: 0, deletedObjects: keys.length };
    }
    const versioned = entries.filter((entry) => entry.versionId !== "null");
    const unversionedKeys = [...new Set(entries.filter((entry) => entry.versionId === "null").map((entry) => entry.key))];
    let deletedVersions = 0;
    let deleteMarkers = 0;
    for (let start = 0; start < versioned.length; start += DELETE_VERSIONS_BATCH) {
      const batch = versioned.slice(start, start + DELETE_VERSIONS_BATCH);
      const output = await this.call("DeleteObjectVersionsByPrefix", () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: batch.map((entry) => ({ Key: entry.key, VersionId: entry.versionId })),
              Quiet: true,
            },
          }),
        ),
      );
      if (output.Errors && output.Errors.length > 0) {
        throw new StorageError("unavailable", "按前缀删除失败：" + (output.Errors[0]?.Code ?? "unknown"));
      }
      deletedVersions += batch.filter((entry) => !entry.isDeleteMarker).length;
      deleteMarkers += batch.filter((entry) => entry.isDeleteMarker).length;
    }
    for (let start = 0; start < unversionedKeys.length; start += DELETE_VERSIONS_BATCH) {
      const batch = unversionedKeys.slice(start, start + DELETE_VERSIONS_BATCH);
      const output = await this.call("DeleteObjectsByPrefix", () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
          }),
        ),
      );
      if (output.Errors && output.Errors.length > 0) {
        throw new StorageError("unavailable", "按前缀删除失败：" + (output.Errors[0]?.Code ?? "unknown"));
      }
      deletedVersions += batch.length;
    }
    return {
      deletedVersions,
      deleteMarkers,
      deletedObjects: new Set(entries.map((entry) => entry.key)).size,
    };
  }

  /** 列举前缀下所有版本；超过安全页数上限直接失败，避免只清一部分。 */
  private async listPrefixEntries(prefix: string): Promise<{ key: string; versionId: string; isDeleteMarker: boolean }[]> {
    const entries: { key: string; versionId: string; isDeleteMarker: boolean }[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < LIST_PREFIX_MAX_PAGES; page += 1) {
      const output = await this.call("ListObjectVersionsPrefix", () =>
        this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        ),
      );
      for (const version of output.Versions ?? []) {
        if (version.Key !== undefined && version.VersionId !== undefined) {
          entries.push({ key: version.Key, versionId: version.VersionId, isDeleteMarker: false });
        }
      }
      for (const marker of output.DeleteMarkers ?? []) {
        if (marker.Key !== undefined && marker.VersionId !== undefined) {
          entries.push({ key: marker.Key, versionId: marker.VersionId, isDeleteMarker: true });
        }
      }
      if (!output.IsTruncated) return entries;
      keyMarker = output.NextKeyMarker;
      versionIdMarker = output.NextVersionIdMarker;
    }
    throw new StorageError("unavailable", "对象前缀版本数超过单次清理上限，请分批重试");
  }

  /** 列举前缀下当前对象键（未开版本控制时的兜底；按 ContinuationToken 翻页）。 */
  private async listCurrentObjectKeys(prefix: string): Promise<string[]> {
    const keys = new Set<string>();
    let continuationToken: string | undefined;
    for (let page = 0; page < LIST_PREFIX_MAX_PAGES; page += 1) {
      const output = await this.call("ListObjectsByPrefix", () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        ),
      );
      for (const object of output.Contents ?? []) {
        if (object.Key !== undefined) keys.add(object.Key);
      }
      if (!output.IsTruncated) return [...keys];
      continuationToken = output.NextContinuationToken;
      if (continuationToken === undefined) {
        throw new StorageError("unavailable", "对象前缀列举响应缺少翻页标记");
      }
    }
    throw new StorageError("unavailable", "对象前缀对象数超过单次清理上限，请分批重试");
  }

  /** 该键的所有版本与 delete marker（版本化桶）；未开启版本控制时 VersionId 为字符串 `null`。 */
  private async listVersionEntries(objectKey: string): Promise<{ versionId: string; isDeleteMarker: boolean }[]> {
    const entries: { versionId: string; isDeleteMarker: boolean }[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < LIST_VERSIONS_MAX_PAGES; page += 1) {
      const output = await this.call("ListObjectVersions", () =>
        this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            // Prefix 只是粗筛：同前缀的其它键（`staging/{id}` 与 `staging/{id}.bak`）必须按 Key 精确比对。
            Prefix: objectKey,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        ),
      );
      for (const version of output.Versions ?? []) {
        if (version.Key === objectKey && version.VersionId !== undefined) {
          entries.push({ versionId: version.VersionId, isDeleteMarker: false });
        }
      }
      for (const marker of output.DeleteMarkers ?? []) {
        if (marker.Key === objectKey && marker.VersionId !== undefined) {
          entries.push({ versionId: marker.VersionId, isDeleteMarker: true });
        }
      }
      if (!output.IsTruncated) {
        break;
      }
      keyMarker = output.NextKeyMarker;
      versionIdMarker = output.NextVersionIdMarker;
    }
    return entries;
  }

  async probe(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const failure = this.fail("HeadBucket", error);
      // 桶不存在 / 无权限是「存储不可用」，不是「对象不存在」。
      throw failure.code === "object_not_found"
        ? new StorageError("unavailable", "存储桶不存在或不可访问", { cause: error })
        : failure;
    }
  }

  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  private fail(operation: string, error: unknown): StorageError {
    const name = s3ErrorName(error);
    const status = s3HttpStatus(error);
    const raw = error instanceof Error ? error.message : "";
    this.logger.warn(
      this.scrub(`S3 ${operation} 失败：${[name || "unknown", status ? status : "", raw].filter(Boolean).join(" / ")}`),
    );
    if (name === "NoSuchUpload") {
      return new StorageError("upload_not_found", `对象存储中不存在该上传会话（${operation}）`, { cause: error });
    }
    if (PART_CONFLICT_S3_ERRORS.has(name)) {
      return new StorageError("part_conflict", `上传分片不可用（${operation} / ${name}）`, { cause: error });
    }
    if (isNotFound(error)) {
      return new StorageError("object_not_found", `对象不存在（${operation}）`, { cause: error });
    }
    return new StorageError(
      "unavailable",
      `对象存储调用失败（${operation}${name ? " / " + name : ""}）`,
      { cause: error },
    );
  }

  /** 日志脱敏：预签名 URL 与访问密钥不得进日志（CONTRIBUTING §12）。 */
  private scrub(text: string): string {
    let scrubbed = text
      .replace(/X-Amz-(Credential|Signature|Security-Token)=[^&\s"'<>]+/gi, "X-Amz-$1=***")
      .replace(/AKIA[0-9A-Z]{16}/g, "***");
    for (const secret of this.secretValues) {
      scrubbed = scrubbed.split(secret).join("***");
    }
    return scrubbed;
  }
}

/** 寻址方式：auto = 非 AWS 端点用 path-style（MinIO / SeaweedFS 必需），AWS 用 virtual-host。 */
export function resolveForcePathStyle(env: Env): boolean {
  if (env.S3_FORCE_PATH_STYLE === "true") {
    return true;
  }
  if (env.S3_FORCE_PATH_STYLE === "false") {
    return false;
  }
  try {
    return !/\.amazonaws\.com$/i.test(new URL(env.S3_ENDPOINT).hostname);
  } catch {
    return true;
  }
}

/**
 * 构造 S3 客户端（唯一处配置协议细节）。
 * 校验和按需计算 / 校验：SDK 新版默认给请求带 CRC32，自建 S3 实现（MinIO）与浏览器直传
 * 预签名 PUT 容易因此不匹配 —— 显式降为 WHEN_REQUIRED，由服务端做最终哈希比对。
 */
export function createS3Client(env: Env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: resolveForcePathStyle(env),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function createS3ObjectStorage(env: Env): S3ObjectStorage {
  return new S3ObjectStorage({
    client: createS3Client(env),
    bucket: env.S3_BUCKET,
    partUrlTtlSeconds: env.S3_PART_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: env.S3_DOWNLOAD_URL_TTL_SECONDS,
    secretValues: [env.S3_ACCESS_KEY, env.S3_SECRET_KEY],
  });
}

/** 下载响应头：中文文件名走 RFC 5987（`filename*`），ASCII 兜底（契约「原文件名含中文」）。 */
export function contentDisposition(fileName: string, disposition: "attachment" | "inline" = "attachment"): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function s3ErrorName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "";
}

function s3HttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    if (metadata && typeof metadata.httpStatusCode === "number") {
      return metadata.httpStatusCode;
    }
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  const name = s3ErrorName(error);
  return name === "NoSuchKey" || name === "NotFound" || s3HttpStatus(error) === 404;
}
