import { describe, expect, it } from "vitest";
import {
  S3ObjectStorage,
  StorageError,
  buildObjectKey,
  buildUploadStagingKey,
  contentDisposition,
  createS3Client,
  extensionOf,
  missingPartNumbers,
  planUpload,
  resolveForcePathStyle,
  toApiError,
  versionFileName,
} from "../src/storage/index.js";
import { loadEnv } from "../src/config/env.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const OBJECT_KEY = `projects/${PROJECT_ID}/files/${FILE_ID}/v1/${HASH}.docx`;

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

const s3Error = (name: string, httpStatusCode?: number): Error => {
  const error = new Error(`stub ${name}`);
  error.name = name;
  Object.assign(error, httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } });
  return error;
};

const TEST_ENV = loadEnv({
  DATABASE_URL: "postgres://test@127.0.0.1:1/test",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_ACCESS_KEY: "test-access-key",
  S3_SECRET_KEY: "test-secret-key",
});

/** 替身只换 send：客户端与预签名走生产工厂（本地签名，不触网），协议约束因此仍是真实行为。 */
function createStorage(handler: (command: CommandLike) => unknown) {
  const client = createS3Client(TEST_ENV);
  const commands: CommandLike[] = [];
  const warnings: string[] = [];
  client.send = ((command: CommandLike) => {
    commands.push(command);
    return Promise.resolve(handler(command));
  }) as typeof client.send;
  const storage = new S3ObjectStorage({
    client,
    bucket: "libiaolink",
    partUrlTtlSeconds: 900,
    downloadUrlTtlSeconds: 300,
    secretValues: ["test-access-key", "test-secret-key"],
    logger: { warn: (message) => warnings.push(message) },
  });
  return { storage, commands, warnings };
}

describe("对象键（ADR-006：定档不覆盖物理对象，版本与哈希进键）", () => {
  it("按契约形态构造键，扩展名小写", () => {
    expect(buildObjectKey({ projectId: PROJECT_ID, fileId: FILE_ID, seq: 3, contentHash: HASH.toUpperCase(), fileName: "机械设计图纸-V2.DOCX" }))
      .toBe(`projects/${PROJECT_ID}/files/${FILE_ID}/v3/${HASH}.docx`);
  });

  it("无扩展名 / 非法扩展名 / 超长扩展名一律回落 bin", () => {
    expect(extensionOf("图纸")).toBe("bin");
    expect(extensionOf("图纸.v2-final")).toBe("bin");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(extensionOf("x." + "a".repeat(20))).toBe("bin");
    expect(extensionOf(".gitignore")).toBe("bin");
    expect(buildObjectKey({ projectId: PROJECT_ID, fileId: FILE_ID, seq: 1, contentHash: HASH, fileName: "图纸" }))
      .toBe(`projects/${PROJECT_ID}/files/${FILE_ID}/v1/${HASH}.bin`);
  });

  it("（Push 256）versionFileName：主名取当前文件名、扩展名取版本对象键；无合法扩展名（bin）回落当前文件名", () => {
    expect(versionFileName("回放-变更后.pptx", `projects/${PROJECT_ID}/files/${FILE_ID}/v1/${HASH}.xls`)).toBe("回放-变更后.xls");
    expect(versionFileName("回放-变更后.pptx", `projects/${PROJECT_ID}/files/${FILE_ID}/v2/${HASH}.pptx`)).toBe("回放-变更后.pptx");
    expect(versionFileName("说明.txt", `projects/${PROJECT_ID}/files/${FILE_ID}/v1/${HASH}.bin`)).toBe("说明.txt");
  });

  it("拒绝非法输入（路径穿越 / 非法哈希 / 非法版本号）", () => {
    expect(() => buildObjectKey({ projectId: "../../etc", fileId: FILE_ID, seq: 1, contentHash: HASH, fileName: "a.docx" })).toThrow(/projectId/);
    expect(() => buildObjectKey({ projectId: PROJECT_ID, fileId: FILE_ID, seq: 1, contentHash: "../../x", fileName: "a.docx" })).toThrow(/contentHash/);
    expect(() => buildObjectKey({ projectId: PROJECT_ID, fileId: FILE_ID, seq: 0, contentHash: HASH, fileName: "a.docx" })).toThrow(/seq/);
  });

  it("暂存键按上传会话隔离（同一文件可并发多个会话）", () => {
    expect(buildUploadStagingKey({ projectId: PROJECT_ID, fileId: FILE_ID, sessionId: "33333333-3333-4333-8333-333333333333" }))
      .toBe(`projects/${PROJECT_ID}/files/${FILE_ID}/staging/33333333-3333-4333-8333-333333333333`);
  });
});

describe("分片计划（S3 协议约束：非末片 >= 5 MiB、总片数 <= 10000）", () => {
  it("默认 8 MiB；空文件按 1 片", () => {
    expect(planUpload(0)).toEqual({ partSizeBytes: 8 * 1024 * 1024, totalParts: 1 });
    expect(planUpload(1024)).toEqual({ partSizeBytes: 8 * 1024 * 1024, totalParts: 1 });
    expect(planUpload(8 * 1024 * 1024)).toEqual({ partSizeBytes: 8 * 1024 * 1024, totalParts: 1 });
    expect(planUpload(8 * 1024 * 1024 + 1)).toEqual({ partSizeBytes: 8 * 1024 * 1024, totalParts: 2 });
  });

  it("大文件翻倍分片，片数始终 <= 10000", () => {
    const plan = planUpload(200 * 1024 * 1024 * 1024);
    expect(plan.totalParts).toBeLessThanOrEqual(10_000);
    expect(plan.partSizeBytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(plan.partSizeBytes * plan.totalParts).toBeGreaterThanOrEqual(200 * 1024 * 1024 * 1024);
  });

  it("缺片计算以 ListParts 为唯一真相", () => {
    expect(missingPartNumbers([1, 3], 4)).toEqual([2, 4]);
    expect(missingPartNumbers([1, 2, 3], 3)).toEqual([]);
  });
});

describe("S3 适配器：分片直传", () => {
  it("创建会话返回存储侧 uploadId", async () => {
    const { storage } = createStorage(() => ({ UploadId: "upload-1" }));
    await expect(storage.createMultipartUpload({ objectKey: OBJECT_KEY, contentType: "application/pdf" }))
      .resolves.toEqual({ objectKey: OBJECT_KEY, uploadId: "upload-1" });
  });

  it("分片预签名 URL 可直传（含 uploadId / partNumber，且不夹带校验和签名头）", async () => {
    const { storage } = createStorage(() => ({}));
    const signed = await storage.signPartUploadUrl({ objectKey: OBJECT_KEY, uploadId: "upload-1", partNumber: 2 });
    expect(signed.url).toContain("http://127.0.0.1:9000/libiaolink/");
    expect(signed.url).toContain("partNumber=2");
    expect(signed.url).toContain("uploadId=upload-1");
    expect(signed.url).toContain("X-Amz-Signature=");
    // SDK 新版默认计算 CRC32 校验和，会要求浏览器额外带 x-amz-checksum-* 头；已显式降为按需。
    expect(signed.url).not.toMatch(/checksum/i);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("ListParts 分页合并并按编号升序（断点续传的唯一真相）", async () => {
    const { storage, commands } = createStorage((command) => {
      const marker = command.input.PartNumberMarker as string | undefined;
      return marker === undefined
        ? { Parts: [{ PartNumber: 2, Size: 20, ETag: " etag-2 " }], IsTruncated: true, NextPartNumberMarker: "1" }
        : { Parts: [{ PartNumber: 1, Size: 10, ETag: "\"etag-1\"" }], IsTruncated: false };
    });
    const parts = await storage.listParts({ objectKey: OBJECT_KEY, uploadId: "upload-1" });
    expect(commands.map((command) => command.constructor.name)).toEqual(["ListPartsCommand", "ListPartsCommand"]);
    expect(parts).toEqual([
      { partNumber: 1, sizeBytes: 10, etag: "\"etag-1\"", lastModified: null },
      { partNumber: 2, sizeBytes: 20, etag: "etag-2", lastModified: null },
    ]);
  });

  it("合并时按编号升序提交，空清单直接拒绝", async () => {
    const { storage, commands } = createStorage(() => ({ ETag: "\"merged\"" }));
    const result = await storage.completeMultipartUpload({
      objectKey: OBJECT_KEY,
      uploadId: "upload-1",
      parts: [{ partNumber: 2, etag: "etag-2" }, { partNumber: 1, etag: "etag-1" }],
    });
    expect(result).toEqual({ etag: "\"merged\"" });
    expect(commands[0]?.input.MultipartUpload).toEqual({
      Parts: [{ PartNumber: 1, ETag: "etag-1" }, { PartNumber: 2, ETag: "etag-2" }],
    });
    await expect(storage.completeMultipartUpload({ objectKey: OBJECT_KEY, uploadId: "upload-1", parts: [] }))
      .rejects.toMatchObject({ code: "part_conflict" });
  });

  it("中止上传幂等：会话已不存在不报错", async () => {
    const { storage } = createStorage(() => { throw s3Error("NoSuchUpload", 404); });
    await expect(storage.abortMultipartUpload({ objectKey: OBJECT_KEY, uploadId: "upload-1" })).resolves.toBeUndefined();
  });
});

describe("S3 适配器：读取与错误映射", () => {
  it("HeadObject 命中返回元数据，404 返回 null", async () => {
    const hit = createStorage(() => ({ ContentLength: 123, ETag: "\"e\"", ContentType: "application/pdf", LastModified: new Date(0) }));
    await expect(hit.storage.headObject(OBJECT_KEY)).resolves.toMatchObject({ sizeBytes: 123, contentType: "application/pdf" });

    const miss = createStorage(() => { throw s3Error("NotFound", 404); });
    await expect(miss.storage.headObject(OBJECT_KEY)).resolves.toBeNull();
  });

  it("错误映射：会话缺失 410 / 分片不可用 409 / 对象缺失 404 / 其他 500", async () => {
    const uploadGone = createStorage(() => { throw s3Error("NoSuchUpload", 404); });
    await expect(uploadGone.storage.listParts({ objectKey: OBJECT_KEY, uploadId: "upload-1" }))
      .rejects.toMatchObject({ code: "upload_not_found" });

    const badPart = createStorage(() => { throw s3Error("InvalidPart", 400); });
    await expect(badPart.storage.completeMultipartUpload({ objectKey: OBJECT_KEY, uploadId: "upload-1", parts: [{ partNumber: 1, etag: "x" }] }))
      .rejects.toMatchObject({ code: "part_conflict" });

    const tooSmall = createStorage(() => { throw s3Error("EntityTooSmall", 400); });
    await expect(tooSmall.storage.completeMultipartUpload({ objectKey: OBJECT_KEY, uploadId: "upload-1", parts: [{ partNumber: 1, etag: "x" }] }))
      .rejects.toMatchObject({ code: "part_conflict" });

    const down = createStorage(() => { throw s3Error("TimeoutError"); });
    await expect(down.storage.listParts({ objectKey: OBJECT_KEY, uploadId: "upload-1" }))
      .rejects.toMatchObject({ code: "unavailable" });

    const noBucket = createStorage(() => { throw s3Error("NotFound", 404); });
    await expect(noBucket.storage.probe()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("日志脱敏：告警里不出现访问密钥与签名", async () => {
    const { storage, warnings } = createStorage(() => {
      throw new Error("failed http://127.0.0.1:9000/libiaolink/k?X-Amz-Credential=test-access-key%2F20260920&X-Amz-Signature=deadbeef");
    });
    await expect(storage.probe()).rejects.toBeInstanceOf(StorageError);
    expect(warnings.join("\n")).not.toContain("test-access-key");
    expect(warnings.join("\n")).not.toContain("deadbeef");
    expect(warnings.join("\n")).toContain("***");
  });

  it("存储失败 → 契约错误码与 HTTP 状态", () => {
    expect(toApiError(new StorageError("upload_not_found", "x"))).toMatchObject({ code: "UPLOAD_SESSION_EXPIRED", httpStatus: 410 });
    expect(toApiError(new StorageError("part_conflict", "x"))).toMatchObject({ code: "UPLOAD_INCOMPLETE", httpStatus: 409 });
    expect(toApiError(new StorageError("object_not_found", "x"))).toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(toApiError(new StorageError("object_too_large", "x"))).toMatchObject({ code: "INTERNAL", httpStatus: 500 });
    expect(toApiError(new StorageError("unavailable", "x"))).toMatchObject({ code: "INTERNAL", httpStatus: 500 });
    expect(toApiError(new Error("boom"))).toMatchObject({ code: "INTERNAL" });
  });
});

const STAGING_KEY = `projects/${PROJECT_ID}/files/${FILE_ID}/staging/33333333-3333-4333-8333-333333333333`;

describe("S3 适配器：复制与版本回收（ADR-006 定案：暂存键 → 契约键；彻底删除含版本）", () => {
  it("copyObject：先 HEAD 校验源对象，再按元数据复制到契约键", async () => {
    const { storage, commands } = createStorage((command) =>
      command.constructor.name === "HeadObjectCommand"
        ? { ContentLength: 20 * 1024 * 1024 }
        : { CopyObjectResult: { ETag: " \"copied\" " }, VersionId: "v-2" },
    );
    const result = await storage.copyObject({
      sourceKey: STAGING_KEY,
      destinationKey: OBJECT_KEY,
      contentType: "application/pdf",
      metadata: { "file-name": "a.pdf" },
    });
    expect(commands.map((command) => command.constructor.name)).toEqual(["HeadObjectCommand", "CopyObjectCommand"]);
    expect(commands[1]?.input).toMatchObject({
      Bucket: "libiaolink",
      Key: OBJECT_KEY,
      CopySource: `libiaolink/${STAGING_KEY}`,
      MetadataDirective: "REPLACE",
      ContentType: "application/pdf",
    });
    expect(result).toEqual({ etag: "\"copied\"", versionId: "v-2" });
  });

  it("copyObject：源对象缺失 404；超过单次复制上限按 object_too_large 拒绝", async () => {
    const missing = createStorage(() => {
      throw s3Error("NotFound", 404);
    });
    await expect(missing.storage.copyObject({ sourceKey: STAGING_KEY, destinationKey: OBJECT_KEY })).rejects.toMatchObject({
      code: "object_not_found",
    });

    const oversized = createStorage(() => ({ ContentLength: 5 * 1024 * 1024 * 1024 + 1 }));
    await expect(oversized.storage.copyObject({ sourceKey: STAGING_KEY, destinationKey: OBJECT_KEY })).rejects.toMatchObject({
      code: "object_too_large",
    });
    expect(oversized.commands.map((command) => command.constructor.name)).toEqual(["HeadObjectCommand"]);
  });

  it("purgeObject：按版本删（含 delete marker），同前缀的其它键不动", async () => {
    const { storage, commands } = createStorage((command) =>
      command.constructor.name === "ListObjectVersionsCommand"
        ? {
            Versions: [
              { Key: STAGING_KEY, VersionId: "v-1" },
              { Key: `${STAGING_KEY}.bak`, VersionId: "v-9" },
            ],
            DeleteMarkers: [{ Key: STAGING_KEY, VersionId: "m-1" }],
          }
        : {},
    );
    await expect(storage.purgeObject(STAGING_KEY)).resolves.toEqual({ deletedVersions: 1, deleteMarkers: 1 });
    expect(commands.map((command) => command.constructor.name)).toEqual(["ListObjectVersionsCommand", "DeleteObjectsCommand"]);
    expect(commands[1]?.input).toMatchObject({
      Delete: {
        Objects: [
          { Key: STAGING_KEY, VersionId: "v-1" },
          { Key: STAGING_KEY, VersionId: "m-1" },
        ],
      },
    });
  });

  it("purgeObject：未开启版本控制退回普通删除；键不存在时不写 delete marker", async () => {
    const unversioned = createStorage((command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return { Versions: [{ Key: OBJECT_KEY, VersionId: "null" }] };
      }
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentLength: 10 };
      }
      return {};
    });
    await expect(unversioned.storage.purgeObject(OBJECT_KEY)).resolves.toEqual({ deletedVersions: 1, deleteMarkers: 0 });
    expect(unversioned.commands.map((command) => command.constructor.name)).toEqual([
      "ListObjectVersionsCommand",
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);

    const absent = createStorage((command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return { Versions: [], DeleteMarkers: [] };
      }
      throw s3Error("NotFound", 404);
    });
    await expect(absent.storage.purgeObject(OBJECT_KEY)).resolves.toEqual({ deletedVersions: 0, deleteMarkers: 0 });
    expect(absent.commands.map((command) => command.constructor.name)).toEqual(["ListObjectVersionsCommand", "HeadObjectCommand"]);
  });
});

describe("S3 适配器：项目前缀彻底删除（项目回收站 purge）", () => {
  it("purgePrefix：按前缀列出全部版本与 delete marker，再批量删除", async () => {
    const prefix = "projects/" + PROJECT_ID + "/";
    const secondKey = prefix + "files/" + FILE_ID + "/v1/" + HASH + ".pdf";
    const { storage, commands } = createStorage((command) =>
      command.constructor.name === "ListObjectVersionsCommand"
        ? {
            Versions: [
              { Key: OBJECT_KEY, VersionId: "v-1" },
              { Key: OBJECT_KEY, VersionId: "v-2" },
              { Key: secondKey, VersionId: "v-3" },
            ],
            DeleteMarkers: [{ Key: secondKey, VersionId: "m-1" }],
            IsTruncated: false,
          }
        : {},
    );

    await expect(storage.purgePrefix(prefix)).resolves.toEqual({
      deletedVersions: 3,
      deleteMarkers: 1,
      deletedObjects: 2,
    });
    expect(commands.map((command) => command.constructor.name)).toEqual([
      "ListObjectVersionsCommand",
      "DeleteObjectsCommand",
    ]);
    expect(commands[0]?.input).toMatchObject({ Prefix: prefix });
    expect(commands[1]?.input).toMatchObject({
      Delete: {
        Objects: [
          { Key: OBJECT_KEY, VersionId: "v-1" },
          { Key: OBJECT_KEY, VersionId: "v-2" },
          { Key: secondKey, VersionId: "v-3" },
          { Key: secondKey, VersionId: "m-1" },
        ],
      },
    });
  });

  it("purgePrefix：未开启版本控制时按普通键删除，同键只删一次", async () => {
    const prefix = "projects/" + PROJECT_ID + "/";
    const { storage, commands } = createStorage((command) =>
      command.constructor.name === "ListObjectVersionsCommand"
        ? {
            Versions: [
              { Key: OBJECT_KEY, VersionId: "null" },
              { Key: OBJECT_KEY, VersionId: "null" },
              { Key: STAGING_KEY, VersionId: "null" },
            ],
            DeleteMarkers: [],
            IsTruncated: false,
          }
        : {},
    );
    await expect(storage.purgePrefix(prefix)).resolves.toEqual({
      deletedVersions: 2,
      deleteMarkers: 0,
      deletedObjects: 2,
    });
    expect(commands[1]?.input).toMatchObject({
      Delete: { Objects: [{ Key: OBJECT_KEY }, { Key: STAGING_KEY }] },
    });
  });

  it("purgePrefix：翻页取满后一次清理；空结果不写删除请求", async () => {
    const prefix = "projects/" + PROJECT_ID + "/";
    let page = 0;
    const paged = createStorage((command) => {
      if (command.constructor.name !== "ListObjectVersionsCommand") return {};
      page += 1;
      if (page === 1) {
        return {
          Versions: [{ Key: OBJECT_KEY, VersionId: "v-1" }],
          DeleteMarkers: [],
          IsTruncated: true,
          NextKeyMarker: OBJECT_KEY,
          NextVersionIdMarker: "v-1",
        };
      }
      return {
        Versions: [{ Key: STAGING_KEY, VersionId: "v-2" }],
        DeleteMarkers: [],
        IsTruncated: false,
      };
    });
    await expect(paged.storage.purgePrefix(prefix)).resolves.toEqual({
      deletedVersions: 2,
      deleteMarkers: 0,
      deletedObjects: 2,
    });
    expect(paged.commands.map((command) => command.constructor.name)).toEqual([
      "ListObjectVersionsCommand",
      "ListObjectVersionsCommand",
      "DeleteObjectsCommand",
    ]);

    const empty = createStorage(() => ({ Versions: [], DeleteMarkers: [], IsTruncated: false }));
    await expect(empty.storage.purgePrefix(prefix)).resolves.toEqual({
      deletedVersions: 0,
      deleteMarkers: 0,
      deletedObjects: 0,
    });
    expect(empty.commands.map((command) => command.constructor.name)).toEqual(["ListObjectVersionsCommand", "ListObjectsV2Command"]);
  });

  it("purgePrefix：未开版本控制且 ListObjectVersions 为空时，ListObjectsV2 兜底普通删除", async () => {
    const prefix = "projects/" + PROJECT_ID + "/";
    const { storage, commands } = createStorage((command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return { Versions: [], DeleteMarkers: [], IsTruncated: false };
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: OBJECT_KEY }, { Key: STAGING_KEY }], IsTruncated: false };
      }
      return {};
    });
    await expect(storage.purgePrefix(prefix)).resolves.toEqual({
      deletedVersions: 2,
      deleteMarkers: 0,
      deletedObjects: 2,
    });
    expect(commands.map((command) => command.constructor.name)).toEqual([
      "ListObjectVersionsCommand",
      "ListObjectsV2Command",
      "DeleteObjectsCommand",
    ]);
    expect(commands[1]?.input).toMatchObject({ Prefix: prefix });
    expect(commands[2]?.input).toMatchObject({
      Delete: { Objects: [{ Key: OBJECT_KEY }, { Key: STAGING_KEY }] },
    });
  });

  it("purgePrefix：空前缀 / 不以斜杠结尾直接拒绝，避免误删同前缀项目", async () => {
    const invalid = createStorage(() => ({}));
    await expect(invalid.storage.purgePrefix("")).rejects.toMatchObject({ code: "unavailable" });
    await expect(invalid.storage.purgePrefix("projects/" + PROJECT_ID)).rejects.toMatchObject({ code: "unavailable" });
    expect(invalid.commands).toEqual([]);
  });
});

describe("下载签名与寻址", () => {
  it("中文文件名走 RFC 5987，签名 URL 带响应头参数", async () => {
    const { storage } = createStorage(() => ({}));
    const signed = await storage.signDownloadUrl({ objectKey: OBJECT_KEY, fileName: "机械设计图纸-v2.docx" });
    expect(signed.url).toContain("response-content-disposition=");
    expect(decodeURIComponent(signed.url)).toContain("filename*=UTF-8''");
    expect(contentDisposition("a\"b.docx")).toBe("attachment; filename=\"a_b.docx\"; filename*=UTF-8''a%22b.docx");
  });

  it("寻址方式：非 AWS 端点走 path-style，AWS 走 virtual-host", () => {
    const base = { DATABASE_URL: "postgres://x/y" };
    expect(resolveForcePathStyle(loadEnv({ ...base, S3_ENDPOINT: "http://127.0.0.1:9000" }))).toBe(true);
    expect(resolveForcePathStyle(loadEnv({ ...base, S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com" }))).toBe(false);
    expect(resolveForcePathStyle(loadEnv({ ...base, S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com", S3_FORCE_PATH_STYLE: "true" }))).toBe(true);
  });
});

describe("环境变量契约（对象存储）", () => {
  it("生产环境必须配置访问密钥", () => {
    const base = { NODE_ENV: "production", DATABASE_URL: "postgres://x/y", CASDOOR_CLIENT_ID: "a", CASDOOR_CLIENT_SECRET: "b", CASDOOR_ORG_NAME: "c", INTERNAL_SYNC_TOKEN: "d" };
    expect(() => loadEnv(base)).toThrow(/S3_ACCESS_KEY/);
    expect(
      loadEnv({ ...base, S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s", ONLYOFFICE_JWT_SECRET: "shared-secret" }).S3_BUCKET,
    ).toBe("libiaolink");
  });

  it("上传上限必须挡在单次复制上限（5 GiB）以内", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x/y", UPLOAD_MAX_SIZE_MB: "5121" })).toThrow(/UPLOAD_MAX_SIZE_MB/);
    expect(loadEnv({ DATABASE_URL: "postgres://x/y", UPLOAD_MAX_SIZE_MB: "5120" }).UPLOAD_MAX_SIZE_MB).toBe(5120);
    expect(loadEnv({ DATABASE_URL: "postgres://x/y" }).UPLOAD_MAX_SIZE_MB).toBe(2048);
  });
});
