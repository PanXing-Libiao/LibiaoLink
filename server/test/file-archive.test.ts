import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { FileArchiveRequestSchema } from "@libiaolink/contracts";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { ObjectStorage, ObjectStreamResult } from "../src/storage/object-storage.js";
import { FileArchiveCleanupHandler } from "../src/modules/file/file-archive.cleanup.js";
import {
  FILE_ARCHIVE_CLEANUP_JOB_KIND,
  FILE_ARCHIVE_MAX_TOTAL_BYTES,
} from "../src/modules/file/file-archive.constants.js";
import { FileArchiveService } from "../src/modules/file/file-archive.service.js";
import type { FileRow, FileVersionRow } from "../src/modules/file/file.repository.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const FILE_A = "33333333-3333-4333-8333-333333333333";
const FILE_B = "44444444-4444-4444-8444-444444444444";
const VERSION_A = "55555555-5555-4555-8555-555555555555";
const VERSION_B = "66666666-6666-4666-8666-666666666666";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileRow(id: string, name: string, currentVersionId: string, projectId = PROJECT): FileRow {
  return {
    id,
    projectId,
    nodeId: null,
    taskId: null,
    docType: null,
    name,
    status: "final",
    currentVersionId,
    version: 1,
    createdBy: ACTOR,
    createdAt: new Date("2026-11-12T00:00:00Z"),
    updatedAt: new Date("2026-11-12T00:00:00Z"),
    finalizedAt: new Date("2026-11-12T00:00:00Z"),
    finalizedBy: ACTOR,
    recycledAt: null,
    recycledBy: null,
    recycledFromStatus: null,
    purgeAfter: null,
  };
}

function versionRow(
  id: string,
  fileId: string,
  seq: number,
  objectKey: string,
  bytes: Buffer,
  contentHash = sha256(bytes),
  sizeBytes = bytes.byteLength,
): FileVersionRow {
  return {
    id,
    fileId,
    seq,
    objectKey,
    sizeBytes,
    contentHash,
    mime: null,
    uploadedBy: ACTOR,
    uploadedAt: new Date("2026-11-12T00:00:00Z"),
    changeRequestId: null,
  };
}

interface RawZipEntry {
  method: number;
  compressed: Buffer;
}

function readZipEntries(bytes: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("EOCD 缺失");
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("中央目录损坏");
    const entry: RawZipEntry = {
      method: bytes.readUInt16LE(cursor + 10),
      compressed: Buffer.alloc(0),
    };
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entry.compressed = Buffer.from(bytes.subarray(dataOffset, dataOffset + compressedSize));
    result.set(name, entry.method === 8 ? inflateRawSync(entry.compressed) : entry.compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function harness(options: {
  files?: FileRow[];
  versions?: FileVersionRow[];
  objects?: Map<string, Buffer>;
  lockAvailable?: boolean;
} = {}) {
  const objects = options.objects ?? new Map<string, Buffer>();
  const uploaded = new Map<string, Buffer>();
  const purged: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const cleanup: Array<Record<string, unknown>> = [];
  const permission = {
    assertProjectVisible: vi.fn(async () => ({ member: true, projectManager: false, groupAccessLevel: "read" })),
    assertCan: vi.fn(async () => undefined),
  };
  const repository = {
    findProject: vi.fn(async () => ({
      id: PROJECT,
      code: "LB-001",
      name: "测试项目",
      status: "active",
      deletedAt: null,
    })),
    findFilesByIds: vi.fn(async () => options.files ?? []),
    findVersionsByIds: vi.fn(async () => options.versions ?? []),
    enqueueCleanup: vi.fn(async (input: Record<string, unknown>) => {
      cleanup.push(input);
    }),
  };
  const storage = {
    getObjectStream: vi.fn(async (objectKey: string): Promise<ObjectStreamResult | null> => {
      const bytes = objects.get(objectKey);
      return bytes === undefined
        ? null
        : { stream: Readable.from([bytes]), sizeBytes: bytes.byteLength, contentType: null };
    }),
    putObjectStream: vi.fn(async (input: { objectKey: string; body: Readable; sizeBytes: number }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.byteLength).toBe(input.sizeBytes);
      uploaded.set(input.objectKey, bytes);
    }),
    signDownloadUrl: vi.fn(async () => ({
      url: "https://objects.example.test/signed.zip",
      expiresAt: new Date("2026-11-12T12:00:00Z"),
    })),
    purgeObject: vi.fn(async (objectKey: string) => {
      purged.push(objectKey);
      uploaded.delete(objectKey);
      return { deletedVersions: 1, deleteMarkers: 0 };
    }),
  };
  const audit = {
    record: vi.fn(async (_client: unknown, input: Record<string, unknown>) => {
      audits.push(input);
    }),
  };
  const database = {
    db: {
      transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => await work({}),
    },
  };
  const lock = { release: vi.fn(async () => undefined) };
  const concurrency = {
    acquire: vi.fn(async () => (options.lockAvailable === false ? null : lock)),
  };
  const service = new FileArchiveService(
    database as never,
    repository as never,
    storage as unknown as ObjectStorage,
    permission as never,
    audit as never,
    { env: { S3_DOWNLOAD_URL_TTL_SECONDS: 300 } } as never,
    concurrency as never,
  );
  return { service, objects, uploaded, purged, audits, cleanup, permission, repository, storage, audit, lock, concurrency };
}

describe("FileArchiveService（项目文件批量 ZIP）", () => {
  it("按选择顺序打包、清洗路径并强制版本扩展名，审计 + 清理任务齐全", async () => {
    const text = Buffer.from("hello", "utf8");
    const image = Buffer.from("not-really-jpeg", "utf8");
    const keyA = "projects/p/files/a/v1/hash.txt";
    const keyB = "projects/p/files/b/v1/hash.jpg";
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A), fileRow(FILE_B, "现场图.jpg", VERSION_B)],
      versions: [
        versionRow(VERSION_A, FILE_A, 1, keyA, text),
        versionRow(VERSION_B, FILE_B, 2, keyB, image),
      ],
      objects: new Map([
        [keyA, text],
        [keyB, image],
      ]),
    });

    const result = await h.service.createArchive(
      PROJECT,
      {
        items: [
          { fileId: FILE_A, versionId: VERSION_A, entryName: "../说明.txt" },
          { fileId: FILE_B, versionId: VERSION_B },
        ],
      },
      ACTOR,
    );

    expect(result.fileName).toBe("[LB-001] 测试项目_项目文件.zip");
    expect(result.url).toBe("https://objects.example.test/signed.zip");
    expect(result.itemCount).toBe(2);
    const stored = h.uploaded.get("temp/file-archives/" + result.batchId + ".zip");
    expect(stored).toBeDefined();
    const entries = readZipEntries(stored!);
    const root = "[LB-001] 测试项目_项目文件/";
    expect([...entries.keys()]).toEqual([root + "_说明.txt", root + "现场图.jpg"]);
    expect(entries.get(root + "_说明.txt")?.toString("utf8")).toBe("hello");
    expect(entries.get(root + "现场图.jpg")?.toString("utf8")).toBe("not-really-jpeg");
    expect(h.audits).toHaveLength(2);
    expect(h.audits[0]).toMatchObject({
      action: "download",
      objectId: FILE_A,
      metadata: { versionId: VERSION_A, archive: true, itemCount: 2 },
    });
    expect(h.cleanup).toHaveLength(1);
    expect(h.cleanup[0]?.["objectKey"]).toBe("temp/file-archives/" + result.batchId + ".zip");
    expect(h.lock.release).toHaveBeenCalledOnce();
    expect(h.purged).toEqual([]);
  });

  it("同一 (fileId, versionId) 只入包一次，重名追加 _2", async () => {
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second", "utf8");
    const keyA = "projects/p/files/a/v1/hash.txt";
    const keyB = "projects/p/files/a/v2/hash.txt";
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_B)],
      versions: [
        versionRow(VERSION_A, FILE_A, 1, keyA, first),
        versionRow(VERSION_B, FILE_A, 2, keyB, second),
      ],
      objects: new Map([
        [keyA, first],
        [keyB, second],
      ]),
    });

    const result = await h.service.createArchive(
      PROJECT,
      {
        items: [
          { fileId: FILE_A, versionId: VERSION_A, entryName: "说明.txt" },
          { fileId: FILE_A, versionId: VERSION_A, entryName: "重复会被忽略.txt" },
          { fileId: FILE_A, versionId: VERSION_B, entryName: "说明.txt" },
        ],
      },
      ACTOR,
    );

    expect(result.itemCount).toBe(2);
    const entries = readZipEntries(h.uploaded.get("temp/file-archives/" + result.batchId + ".zip")!);
    const root = "[LB-001] 测试项目_项目文件/";
    expect([...entries.keys()]).toEqual([root + "说明.txt", root + "说明_2.txt"]);
    expect(entries.get(root + "说明_2.txt")?.toString("utf8")).toBe("second");
  });

  it("跨项目文件返回 404，且不读取对象、不写审计", async () => {
    const bytes = Buffer.from("x");
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A, OTHER_PROJECT)],
      versions: [versionRow(VERSION_A, FILE_A, 1, "projects/x.txt", bytes)],
    });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });

  it("总量超过 2 GB 整批拒绝，不创建临时 ZIP", async () => {
    const files: FileRow[] = [];
    const versions: FileVersionRow[] = [];
    const items: Array<{ fileId: string; versionId: string }> = [];
    for (let index = 0; index < 11; index += 1) {
      const fileId = "70000000-0000-4000-8000-" + String(index).padStart(12, "0");
      const versionId = "80000000-0000-4000-8000-" + String(index).padStart(12, "0");
      files.push(fileRow(fileId, "文件" + String(index) + ".bin", versionId));
      versions.push(
        versionRow(
          versionId,
          fileId,
          index + 1,
          "projects/p/files/" + fileId + "/v1/hash.bin",
          Buffer.alloc(0),
          sha256("x"),
          200 * 1024 * 1024,
        ),
      );
      items.push({ fileId, versionId });
    }
    expect(FILE_ARCHIVE_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024 * 1024);
    const h = harness({ files, versions });
    await expect(h.service.createArchive(PROJECT, { items }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("2 GB"),
    });
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
    expect(h.uploaded.size).toBe(0);
  });

  it("对象内容哈希不匹配时整批失败且不上传缺件包", async () => {
    const expected = Buffer.from("right");
    const tampered = Buffer.from("wrong");
    const key = "projects/p/files/a/v1/hash.txt";
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_A, FILE_A, 1, key, expected)],
      objects: new Map([[key, tampered]]),
    });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "FILE_HASH_MISMATCH" });
    expect(h.uploaded.size).toBe(0);
    expect(h.audits).toEqual([]);
    expect(h.cleanup).toEqual([]);
  });

  it("后一个对象缺失时全批失败，前一个已写入的临时内容不会上传", async () => {
    const bytes = Buffer.from("ok");
    const keyA = "projects/p/files/a/v1/hash.txt";
    const h = harness({
      files: [fileRow(FILE_A, "a.txt", VERSION_A), fileRow(FILE_B, "b.txt", VERSION_B)],
      versions: [
        versionRow(VERSION_A, FILE_A, 1, keyA, bytes),
        versionRow(VERSION_B, FILE_B, 1, "projects/p/files/b/v1/hash.txt", bytes),
      ],
      objects: new Map([[keyA, bytes]]),
    });
    await expect(
      h.service.createArchive(
        PROJECT,
        {
          items: [
            { fileId: FILE_A, versionId: VERSION_A },
            { fileId: FILE_B, versionId: VERSION_B },
          ],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.uploaded.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it("同账号已有打包任务时返回 429", async () => {
    const h = harness({ lockAvailable: false });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(h.repository.findProject).not.toHaveBeenCalled();
  });

  it("无 file.download 权限返回 403，且不读取文件或对象", async () => {
    const h = harness();
    h.permission.assertCan.mockRejectedValueOnce(new AppError("FORBIDDEN", "无下载权限"));
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.repository.findProject).not.toHaveBeenCalled();
    expect(h.repository.findFilesByIds).not.toHaveBeenCalled();
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
  });

  it("契约和服务端均拒绝 51 项，50 项通过契约校验", async () => {
    const items = Array.from({ length: 51 }, (_, index) => {
      const suffix = String(index).padStart(12, "0");
      return {
        fileId: "90000000-0000-4000-8000-" + suffix,
        versionId: "a0000000-0000-4000-8000-" + suffix,
      };
    });
    expect(FileArchiveRequestSchema.safeParse({ items: items.slice(0, 50) }).success).toBe(true);
    expect(FileArchiveRequestSchema.safeParse({ items }).success).toBe(false);
    const h = harness();
    await expect(h.service.createArchive(PROJECT, { items }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(h.permission.assertProjectVisible).not.toHaveBeenCalled();
  });

  it("单文件超过 200 MB 整批拒绝，不读取对象", async () => {
    const h = harness({
      files: [fileRow(FILE_A, "大文件.bin", VERSION_A)],
      versions: [
        versionRow(
          VERSION_A,
          FILE_A,
          1,
          "projects/p/files/a/v1/hash.bin",
          Buffer.alloc(0),
          sha256("x"),
          200 * 1024 * 1024 + 1,
        ),
      ],
    });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("200 MB") });
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
    expect(h.uploaded.size).toBe(0);
  });

  it("版本不属于该文件时整批返回 404", async () => {
    const bytes = Buffer.from("x");
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_B, FILE_B, 1, "projects/p/files/b/v1/hash.txt", bytes)],
    });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_B }] }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
  });

  it("回收站文件整批返回 404", async () => {
    const bytes = Buffer.from("x");
    const recycled = {
      ...fileRow(FILE_A, "说明.txt", VERSION_A),
      status: "recycled" as const,
      recycledAt: new Date("2026-11-12T01:00:00Z"),
    };
    const h = harness({
      files: [recycled],
      versions: [versionRow(VERSION_A, FILE_A, 1, "projects/p/files/a/v1/hash.txt", bytes)],
    });
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.storage.getObjectStream).not.toHaveBeenCalled();
  });

  it("签名失败时不写审计，并清理已上传的临时 ZIP", async () => {
    const bytes = Buffer.from("x");
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_A, FILE_A, 1, "projects/p/files/a/v1/hash.txt", bytes)],
      objects: new Map([["projects/p/files/a/v1/hash.txt", bytes]]),
    });
    h.storage.signDownloadUrl.mockRejectedValueOnce(new Error("签名服务不可用"));
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toThrow("签名服务不可用");
    expect(h.audits).toEqual([]);
    expect(h.cleanup).toEqual([]);
    expect(h.purged).toHaveLength(1);
    expect(h.uploaded.size).toBe(0);
  });

  it("上传临时 ZIP 失败时 best-effort 清理可能残留的对象", async () => {
    const bytes = Buffer.from("x");
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_A, FILE_A, 1, "projects/p/files/a/v1/hash.txt", bytes)],
      objects: new Map([["projects/p/files/a/v1/hash.txt", bytes]]),
    });
    h.storage.putObjectStream.mockRejectedValueOnce(new Error("对象上传失败"));
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toThrow("对象上传失败");
    expect(h.audits).toEqual([]);
    expect(h.cleanup).toEqual([]);
    expect(h.purged).toHaveLength(1);
  });

  it("审计写入失败时不返回地址，并清理临时 ZIP", async () => {
    const bytes = Buffer.from("x");
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_A, FILE_A, 1, "projects/p/files/a/v1/hash.txt", bytes)],
      objects: new Map([["projects/p/files/a/v1/hash.txt", bytes]]),
    });
    h.audit.record.mockRejectedValueOnce(new Error("审计写入失败"));
    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR),
    ).rejects.toThrow("审计写入失败");
    expect(h.cleanup).toHaveLength(1);
    expect(h.purged).toHaveLength(1);
    expect(h.uploaded.size).toBe(0);
  });

  it("请求断开时中止生成，不上传、不写审计并释放并发锁", async () => {
    const bytes = Buffer.from("cancel-me");
    const key = "projects/p/files/a/v1/hash.txt";
    const abort = new AbortController();
    const h = harness({
      files: [fileRow(FILE_A, "说明.txt", VERSION_A)],
      versions: [versionRow(VERSION_A, FILE_A, 1, key, bytes)],
      objects: new Map([[key, bytes]]),
    });
    h.storage.getObjectStream.mockImplementationOnce(async () => {
      abort.abort(new AppError("INTERNAL", "文件打包已取消"));
      return { stream: Readable.from([bytes]), sizeBytes: bytes.byteLength, contentType: null };
    });

    await expect(
      h.service.createArchive(PROJECT, { items: [{ fileId: FILE_A, versionId: VERSION_A }] }, ACTOR, abort.signal),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "文件打包已取消" });
    expect(h.uploaded.size).toBe(0);
    expect(h.audits).toEqual([]);
    expect(h.cleanup).toEqual([]);
    expect(h.lock.release).toHaveBeenCalledOnce();
  });
});

describe("FileArchiveCleanupHandler", () => {
  it("只清理合法临时前缀，返回可读留痕", async () => {
    const purgeObject = vi.fn(async () => ({ deletedVersions: 2, deleteMarkers: 1 }));
    const handler = new FileArchiveCleanupHandler({ purgeObject } as never);
    const note = await handler.run({
      job: { payload: { objectKey: "temp/file-archives/11111111-1111-4111-8111-111111111111.zip" } },
    });
    expect(FILE_ARCHIVE_CLEANUP_JOB_KIND).toBe("file.download-archive.cleanup");
    expect(handler.transactional).toBe(false);
    expect(purgeObject).toHaveBeenCalledWith("temp/file-archives/11111111-1111-4111-8111-111111111111.zip");
    expect(note.note).toContain("数据版本 2");
    expect(note.note).toContain("11111111-1111-4111-8111-111111111111");
    expect(note.note).not.toContain("temp/file-archives");
  });

  it("拒绝清理任意对象键", async () => {
    const purgeObject = vi.fn();
    const handler = new FileArchiveCleanupHandler({ purgeObject } as never);
    await expect(handler.run({ job: { payload: { objectKey: "projects/important/file" } } })).rejects.toThrow(
      "对象键非法",
    );
    expect(purgeObject).not.toHaveBeenCalled();
  });
});
