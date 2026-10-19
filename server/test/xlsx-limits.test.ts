import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { parseWorkbook } from "../src/modules/project-import/xlsx.js";

interface ZipEntryInput {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** 中央目录可被伪造成小于真实解压体积；用于验证实际 inflate 上限。 */
  declaredSize?: number;
}

function zipStore(entries: ZipEntryInput[]): Buffer {
  const pieces: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const declaredSize = entry.declaredSize ?? entry.data.length;
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    pieces.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...pieces, centralBuf, eocd]);
}

function xmlEscape(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;");
}

function cellXml(ref: string, text: string): string {
  const quote = String.fromCharCode(34);
  return "<c r=" + quote + ref + quote + " t=" + quote + "inlineStr" + quote + "><is><t>" + xmlEscape(text) + "</t></is></c>";
}

function rowXml(cells: string): string {
  return "<row>" + cells + "</row>";
}

function workbook(sheetData: string, media: ZipEntryInput[] = []): Buffer {
  const quote = String.fromCharCode(34);
  return zipStore([
    {
      name: "xl/workbook.xml",
      data: Buffer.from("<workbook><sheets><sheet name=" + quote + "任务" + quote + " r:id=" + quote + "rId1" + quote + "/></sheets></workbook>", "utf8"),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from("<Relationships><Relationship Id=" + quote + "rId1" + quote + " Target=" + quote + "worksheets/sheet1.xml" + quote + "/></Relationships>", "utf8"),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from("<worksheet><sheetData>" + sheetData + "</sheetData></worksheet>", "utf8"),
      method: 8,
    },
    ...media,
  ]);
}

describe("xlsx parser resource limits", () => {
  it("rejects an Excel-maximum cell coordinate before building the grid", () => {
    const bytes = workbook(rowXml(cellXml("XFD1048576", "x")));
    expect(() => parseWorkbook(bytes)).toThrowError(/行号超出上限|列号超出上限/);
  });

  it("rejects a sparse sheet whose rectangularized cell count exceeds the budget", () => {
    const bytes = workbook(rowXml(cellXml("A1", "a")) + rowXml(cellXml("D5", "e")));
    expect(() => parseWorkbook(bytes, { maxSheetCells: 10 })).toThrowError(/单元格总量超过上限/);
  });

  it("rejects a compressed entry that expands beyond the XML entry budget", () => {
    const bytes = workbook(rowXml(cellXml("A1", "x".repeat(4096))));
    expect(() => parseWorkbook(bytes, { maxEntryBytes: 1024 })).toThrowError(/条目解压后体积超过上限|解压失败/);
  });

  it("bounds actual inflate output even when the zip header understates it", () => {
    const quoted = String.fromCharCode(34);
    const bytes = zipStore([
      {
        name: "xl/workbook.xml",
        data: Buffer.from("<workbook><sheets><sheet name=" + quoted + "任务" + quoted + " r:id=" + quoted + "rId1" + quoted + "/></sheets></workbook>", "utf8"),
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: Buffer.from("<Relationships><Relationship Id=" + quoted + "rId1" + quoted + " Target=" + quoted + "worksheets/sheet1.xml" + quoted + "/></Relationships>", "utf8"),
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: Buffer.from("<worksheet><sheetData>" + rowXml(cellXml("A1", "x".repeat(4096))) + "</sheetData></worksheet>", "utf8"),
        method: 8,
        declaredSize: 1,
      },
    ]);
    expect(() => parseWorkbook(bytes, { maxEntryBytes: 1024 })).toThrowError(/解压失败或解压后体积超过上限/);
  });

  it("counts media byte budget while reading images one by one", () => {
    const bytes = workbook(rowXml(cellXml("A1", "a")), [
      { name: "xl/media/a.jpg", data: Buffer.alloc(6, 1) },
      { name: "xl/media/b.jpg", data: Buffer.alloc(6, 2) },
    ]);
    const parsed = parseWorkbook(bytes, { maxMediaBytes: 100, maxMediaTotalBytes: 10 });
    expect(parsed.readMedia("a.jpg")?.length).toBe(6);
    expect(() => parsed.readMedia("b.jpg")).toThrowError(/图片总量超过上限/);
  });
});
