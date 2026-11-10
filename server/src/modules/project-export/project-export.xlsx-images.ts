import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { ProjectZipWriter } from "./project-export.archive.js";
import type { ExportImage, WorkbookImagePlacement } from "./project-export.workbook.js";

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EMU_PER_PIXEL = 9_525;
const DRAWING_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const IMAGE_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const CONTENT_TYPES_NAME = "[Content_Types].xml";
const MAX_SMALL_XML_BYTES = 16 * 1024 * 1024;

async function readAt(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead <= 0) throw new Error("XLSX ZIP 读取提前结束");
    offset += result.bytesRead;
  }
  return buffer;
}

async function readZipEntries(filePath: string): Promise<ZipEntry[]> {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, size - tailSize, tailSize);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error("XLSX ZIP 缺少中央目录");

    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error("暂不支持 ZIP64 格式的 XLSX");
    }
    if (centralOffset + centralSize > size) throw new Error("XLSX ZIP 中央目录越界");

    const central = await readAt(handle, centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("XLSX ZIP 中央目录损坏");
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc32 = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (!name.endsWith("/")) {
        entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function entryDataStart(filePath: string, entry: ZipEntry): Promise<number> {
  if ((entry.flags & 0x0001) !== 0) throw new Error("不支持加密的 XLSX ZIP 条目");
  const handle = await open(filePath, "r");
  try {
    const header = await readAt(handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("XLSX ZIP 本地文件头损坏");
    return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

async function openRawEntryStream(filePath: string, entry: ZipEntry): Promise<Readable> {
  const dataStart = await entryDataStart(filePath, entry);
  if (entry.compressedSize === 0) return Readable.from([]);
  return createReadStream(filePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
}

async function openEntryStream(filePath: string, entry: ZipEntry): Promise<Readable> {
  const dataStart = await entryDataStart(filePath, entry);
  if (entry.compressedSize === 0) return Readable.from([]);
  const raw = createReadStream(filePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(createInflateRaw());
  throw new Error("XLSX ZIP 使用了不支持的压缩算法");
}

async function readEntryBuffer(filePath: string, entry: ZipEntry, maxBytes = MAX_SMALL_XML_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await openEntryStream(filePath, entry)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error("XLSX ZIP 条目超过安全读取上限");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function insertBeforeClosingTag(tag: string, insertion: string): Transform {
  const needle = Buffer.from(tag, "utf8");
  const replacement = Buffer.from(insertion, "utf8");
  let pending = Buffer.alloc(0);
  let inserted = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      if (inserted) {
        this.push(pending);
        pending = Buffer.alloc(0);
        callback();
        return;
      }
      const index = pending.indexOf(needle);
      if (index >= 0) {
        this.push(pending.subarray(0, index));
        this.push(replacement);
        this.push(pending.subarray(index));
        pending = Buffer.alloc(0);
        inserted = true;
        callback();
        return;
      }
      const keep = Math.min(needle.length - 1, pending.length);
      if (pending.length > keep) {
        this.push(pending.subarray(0, pending.length - keep));
        pending = pending.subarray(pending.length - keep);
      }
      callback();
    },
    flush(callback) {
      if (!inserted) {
        callback(new Error("XLSX 工作表缺少结束标签"));
        return;
      }
      if (pending.length > 0) this.push(pending);
      callback();
    },
  });
}

function nextRelationshipId(xml: string): string {
  let next = 1;
  for (const match of xml.matchAll(/Id="rId(\d+)"/g)) next = Math.max(next, Number(match[1]) + 1);
  return "rId" + String(next);
}

function emptyRelationships(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
}

function appendRelationship(xml: string, relationship: string): string {
  const source = xml.trim() === "" ? emptyRelationships() : xml;
  if (!source.includes("</Relationships>")) throw new Error("XLSX 关系文件缺少结束标签");
  return source.replace("</Relationships>", relationship + "</Relationships>");
}

function contentTypesWith(extensions: ReadonlyMap<string, string>, drawingParts: readonly string[]): (xml: string) => string {
  return (source) => {
    const additions: string[] = [];
    for (const [extension, contentType] of extensions) {
      if (!source.includes('Extension="' + extension + '"')) {
        additions.push('<Default Extension="' + extension + '" ContentType="' + contentType + '"/>');
      }
    }
    for (const partName of drawingParts) {
      if (!source.includes('PartName="/' + partName + '"')) {
        additions.push(
          '<Override PartName="/' + partName + '" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>',
        );
      }
    }
    if (additions.length === 0) return source;
    if (!source.includes("</Types>")) throw new Error("XLSX Content Types 缺少结束标签");
    return source.replace("</Types>", additions.join("") + "</Types>");
  };
}

async function addInjectedBuffer(
  writer: ProjectZipWriter,
  name: string,
  bytes: Uint8Array,
  compress = true,
): Promise<void> {
  await writer.addStream(name, Readable.from([bytes]), bytes.byteLength, { compress, hash: false });
}

function drawingXml(placements: readonly WorkbookImagePlacement[], relationshipByFileId: ReadonlyMap<string, string>): string {
  const anchors = placements.map((placement, index) => {
    const relationshipId = relationshipByFileId.get(placement.fileId);
    if (relationshipId === undefined) throw new Error("XLSX 图片关系缺失");
    const pictureId = index + 1;
    return '<xdr:oneCellAnchor editAs="oneCell">' +
      '<xdr:from><xdr:col>' + String(placement.column - 1) + '</xdr:col>' +
      '<xdr:colOff>' + String(Math.round(placement.xOffsetPx * EMU_PER_PIXEL)) + '</xdr:colOff>' +
      '<xdr:row>' + String(placement.row - 1) + '</xdr:row>' +
      '<xdr:rowOff>' + String(Math.round(placement.yOffsetPx * EMU_PER_PIXEL)) + '</xdr:rowOff></xdr:from>' +
      '<xdr:ext cx="' + String(Math.round(placement.widthPx * EMU_PER_PIXEL)) + '" cy="' + String(Math.round(placement.heightPx * EMU_PER_PIXEL)) + '"/>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + String(pictureId) + '" name="Picture ' + String(pictureId) + '"/>' +
      '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip r:embed="' + relationshipId + '" cstate="print"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
      '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
      '<xdr:clientData/></xdr:oneCellAnchor>';
  }).join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    anchors + "</xdr:wsDr>";
}

/**
 * ExcelJS 4.4 的流式 WorksheetWriter 不支持单元格图片。这里在文本工作簿落盘后，
 * 以流式 ZIP 重写方式补入 media / DrawingML / 关系与 Content Types，避免整本工作簿回内存。
 */
export async function injectWorkbookImages(
  filePath: string,
  placements: readonly WorkbookImagePlacement[],
  images: ReadonlyMap<string, ExportImage>,
): Promise<void> {
  const validPlacements = placements.filter((placement) => images.has(placement.fileId));
  if (validPlacements.length === 0) return;

  const entries = await readZipEntries(filePath);
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const usedNames = new Set(entries.map((entry) => entry.name));
  const placementsBySheet = new Map<number, WorkbookImagePlacement[]>();
  for (const placement of validPlacements) {
    const current = placementsBySheet.get(placement.sheetId) ?? [];
    current.push(placement);
    placementsBySheet.set(placement.sheetId, current);
  }

  const mediaByFileId = new Map<string, string>();
  let mediaIndex = 1;
  for (const placement of validPlacements) {
    if (mediaByFileId.has(placement.fileId)) continue;
    const image = images.get(placement.fileId);
    if (image === undefined) continue;
    let mediaName: string;
    do {
      mediaName = "xl/media/image" + String(mediaIndex) + "." + image.extension;
      mediaIndex += 1;
    } while (usedNames.has(mediaName));
    usedNames.add(mediaName);
    mediaByFileId.set(placement.fileId, mediaName);
  }

  const drawingParts: string[] = [];
  const drawingRelParts: Array<{ name: string; xml: string }> = [];
  const sheetTransforms = new Map<string, { relationshipId: string; addedLength: number }>();
  const relationTransforms = new Map<string, Buffer>();
  const addedRelationFiles: Array<{ name: string; xml: string }> = [];

  for (const [sheetId, sheetPlacements] of [...placementsBySheet.entries()].sort((left, right) => left[0] - right[0])) {
    const sheetName = "xl/worksheets/sheet" + String(sheetId) + ".xml";
    if (!entryByName.has(sheetName)) throw new Error("XLSX 工作表不存在：" + sheetName);
    const drawingName = "xl/drawings/drawing" + String(sheetId) + ".xml";
    drawingParts.push(drawingName);

    const usedFileIds = [...new Set(sheetPlacements.map((placement) => placement.fileId))];
    const relationshipByFileId = new Map<string, string>();
    const drawingRelationships = usedFileIds.map((fileId, index) => {
      const relationshipId = "rId" + String(index + 1);
      const mediaName = mediaByFileId.get(fileId);
      if (mediaName === undefined) throw new Error("XLSX 图片媒体文件缺失");
      relationshipByFileId.set(fileId, relationshipId);
      return '<Relationship Id="' + relationshipId + '" Type="' + IMAGE_RELATIONSHIP + '" Target="../' + mediaName.slice(3) + '"/>';
    }).join("");
    drawingRelParts.push({
      name: "xl/drawings/_rels/drawing" + String(sheetId) + ".xml.rels",
      xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        drawingRelationships + "</Relationships>",
    });

    const sheetRelsName = "xl/worksheets/_rels/sheet" + String(sheetId) + ".xml.rels";
    const existingRels = entryByName.get(sheetRelsName);
    const currentRels = existingRels === undefined ? "" : (await readEntryBuffer(filePath, existingRels)).toString("utf8");
    const drawingRelationshipId = nextRelationshipId(currentRels);
    const relationship = '<Relationship Id="' + drawingRelationshipId + '" Type="' + DRAWING_RELATIONSHIP +
      '" Target="../drawings/drawing' + String(sheetId) + '.xml"/>';
    const nextRels = appendRelationship(currentRels, relationship);
    if (existingRels === undefined) addedRelationFiles.push({ name: sheetRelsName, xml: nextRels });
    else relationTransforms.set(sheetRelsName, Buffer.from(nextRels, "utf8"));

    const insertion = '<drawing r:id="' + drawingRelationshipId + '"/>';
    sheetTransforms.set(sheetName, {
      relationshipId: drawingRelationshipId,
      addedLength: Buffer.byteLength(insertion),
    });
  }

  const contentTypesEntry = entryByName.get(CONTENT_TYPES_NAME);
  if (contentTypesEntry === undefined) throw new Error("XLSX 缺少 Content Types");
  const imageTypes = new Map<string, string>();
  for (const placement of validPlacements) {
    const image = images.get(placement.fileId);
    if (image === undefined) continue;
    imageTypes.set(image.extension, image.extension === "jpeg" ? "image/jpeg" : "image/" + image.extension);
  }
  const transformContentTypes = contentTypesWith(imageTypes, drawingParts);
  const contentTypes = transformContentTypes((await readEntryBuffer(filePath, contentTypesEntry)).toString("utf8"));

  const outputPath = filePath + ".thumbnails";
  const writer = new ProjectZipWriter(outputPath);
  await writer.open();
  try {
    for (const entry of entries) {
      if (entry.name === CONTENT_TYPES_NAME) {
        await addInjectedBuffer(writer, entry.name, Buffer.from(contentTypes, "utf8"));
        continue;
      }
      const rels = relationTransforms.get(entry.name);
      if (rels !== undefined) {
        await addInjectedBuffer(writer, entry.name, rels);
        continue;
      }
      const sheetTransform = sheetTransforms.get(entry.name);
      if (sheetTransform !== undefined) {
        const source = await openEntryStream(filePath, entry);
        const transformed = source.pipe(insertBeforeClosingTag(
          "</worksheet>",
          '<drawing r:id="' + sheetTransform.relationshipId + '"/>',
        ));
        await writer.addStream(entry.name, transformed, entry.uncompressedSize + sheetTransform.addedLength, { hash: false });
        continue;
      }
      let raw: Readable | undefined;
      try {
        raw = await openRawEntryStream(filePath, entry);
      } catch {
        raw = undefined;
      }
      if (raw !== undefined) {
        await writer.addCompressedStream(entry.name, raw, {
          method: entry.method,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
        });
        continue;
      }
      await writer.addStream(entry.name, await openEntryStream(filePath, entry), entry.uncompressedSize);
    }

    for (const part of drawingRelParts) await addInjectedBuffer(writer, part.name, Buffer.from(part.xml, "utf8"));
    for (const part of addedRelationFiles) await addInjectedBuffer(writer, part.name, Buffer.from(part.xml, "utf8"));
    for (const [sheetId, sheetPlacements] of placementsBySheet) {
      const usedFileIds = [...new Set(sheetPlacements.map((placement) => placement.fileId))];
      const relationshipByFileId = new Map<string, string>();
      for (let index = 0; index < usedFileIds.length; index += 1) relationshipByFileId.set(usedFileIds[index]!, "rId" + String(index + 1));
      await addInjectedBuffer(
        writer,
        "xl/drawings/drawing" + String(sheetId) + ".xml",
        Buffer.from(drawingXml(sheetPlacements, relationshipByFileId), "utf8"),
      );
    }
    for (const [fileId, mediaName] of mediaByFileId) {
      const image = images.get(fileId);
      if (image === undefined) continue;
      await addInjectedBuffer(writer, mediaName, image.bytes, false);
    }
    await writer.close();
  } catch (error) {
    await writer.abort();
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  await rm(filePath, { force: true });
  await rename(outputPath, filePath);
}
