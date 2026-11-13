import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipWriter, shouldCompressZipEntry } from "../src/common/zip/index.js";

interface ZipEntry {
  method: number;
  content: Buffer;
}

function readZipEntries(bytes: Buffer): Map<string, ZipEntry> {
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
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    entries.set(name, {
      method,
      content: method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("公共 ZipWriter", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "libiaolink-zip-writer-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("写入 UTF-8 条目名、压缩文本并返回实际大小与 SHA-256", async () => {
    const content = Buffer.from("项目说明：批量下载 UTF-8 文件名 ✓", "utf8");
    const path = join(directory, "utf8.zip");
    const writer = new ZipWriter(path);
    await writer.open();
    const result = await writer.addBuffer("资料/中文说明.txt", content, true);
    await writer.close();

    const entries = readZipEntries(await readFile(path));
    expect(entries.get("资料/中文说明.txt")).toMatchObject({ method: 8, content });
    expect(result.sizeBytes).toBe(content.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("按存储模式写入已压缩格式，内容逐字节保持一致", async () => {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
    const path = join(directory, "stored.zip");
    const writer = new ZipWriter(path);
    await writer.open();
    await writer.addStream("现场图.png", Readable.from([content]), content.byteLength, { compress: false });
    await writer.close();

    expect(shouldCompressZipEntry("现场图.png")).toBe(false);
    const entries = readZipEntries(await readFile(path));
    expect(entries.get("现场图.png")).toMatchObject({ method: 0, content });
  });

  it("单条目超过 maxBytes 时中止写入并清理临时文件", async () => {
    const path = join(directory, "oversize.zip");
    const writer = new ZipWriter(path);
    await writer.open();
    await expect(
      writer.addStream("oversize.bin", Readable.from([Buffer.alloc(32)]), 32, {
        maxBytes: 16,
        compress: false,
      }),
    ).rejects.toThrow("超过允许的大小");
    await writer.abort();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
