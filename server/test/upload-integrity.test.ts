import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { inspectUploadedObject } from "../src/modules/file/upload-integrity.js";
import { StorageError, type ObjectStorage } from "../src/storage/index.js";

function storage(stream: Readable | null): ObjectStorage {
  return { getObjectStream: async () => stream === null ? null : { stream, sizeBytes: 0, contentType: null } } as unknown as ObjectStorage;
}

describe("上传实际字节完整性", () => {
  it("对所有流块计算 SHA-256，文件头仅保留上限内的字节", async () => {
    const bytes = Buffer.alloc(128 * 1024, 7);
    bytes[bytes.length - 1] = 8;
    const result = await inspectUploadedObject(storage(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)])), "staging", bytes.length, 64 * 1024);
    expect(result.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.prefix).toEqual(bytes.subarray(0, 64 * 1024));
    expect(result.contentHash).not.toBe(createHash("sha256").update(result.prefix).digest("hex"));
  });

  it.each([2, 4])("实际流长度 %s 与声明 3 不符时拒绝并关闭流", async (length) => {
    const stream = Readable.from([Buffer.alloc(length)]);
    await expect(inspectUploadedObject(storage(stream), "staging", 3, 2)).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
    expect(stream.destroyed).toBe(true);
  });

  it("源对象缺失时拒绝", async () => {
    await expect(inspectUploadedObject(storage(null), "staging", 3, 2)).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
  });

  it("流中途失败映射为存储错误，不把已读前缀当作完整文件", async () => {
    const stream = Readable.from((async function* () {
      yield Buffer.from("a");
      throw new StorageError("unavailable", "unit-test stream interruption");
    })());
    await expect(inspectUploadedObject(storage(stream), "staging", 3, 2)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(stream.destroyed).toBe(true);
  });

  it("空对象也按实际零字节计算 SHA-256", async () => {
    await expect(inspectUploadedObject(storage(Readable.from([])), "staging", 0, 64 * 1024)).resolves.toEqual({
      contentHash: createHash("sha256").digest("hex"), prefix: Buffer.alloc(0),
    });
  });
});
