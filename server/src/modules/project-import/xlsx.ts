import { closeSync, openSync, readSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { AppError } from "../../common/errors/app-error.js";

/**
 * xlsx 读取（导入表导入）：xlsx = ZIP 容器（workbook.xml / sheetN.xml / sharedStrings.xml / media/*）。
 * 本文件只做「读」：中央目录定位 + 有界 inflate（支持 200 MB 级图片型导入表；XML 与图片分开限流），
 * 生产入口 openFile 按盘上字节区间随机读取，不把上传包或整个工作簿读进 API 堆内存；
 * 不引第三方库（服务端此前没有任何 Excel 依赖；解析口径与 D:/LibiaoLink_help/_conv/legacy-convert.mjs 一致）。
 */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** ZIP 解析预算：工作表 XML 按条解压不保留缓存；read() 的小对象缓存与图片读取各自限额。 */
export interface XlsxLimits {
  /** 单个 XML / 文本条目的解压上限。 */
  maxEntryBytes: number;
  /** read() 的有界缓存总量上限；解析工作表时不使用该缓存。 */
  maxCachedBytes: number;
  /** 整个工作簿保留在 ParsedWorkbook 中的单元格文本总字符数上限。 */
  maxTextChars: number;
  /** 单张图片的解压上限。 */
  maxMediaBytes: number;
  /** 一次导入实际读取的图片总字节上限（逐张读取，不会同时占用）。 */
  maxMediaTotalBytes: number;
  maxRows: number;
  maxColumns: number;
  maxSheetCells: number;
  maxWorkbookCells: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxCachedBytes: 64 * 1024 * 1024,
  maxTextChars: 32 * 1024 * 1024,
  maxMediaBytes: 64 * 1024 * 1024,
  maxMediaTotalBytes: 1024 * 1024 * 1024,
  maxRows: 200_000,
  maxColumns: 256,
  maxSheetCells: 2_000_000,
  maxWorkbookCells: 3_000_000,
};

interface ZipSource {
  readonly size: number;
  read(offset: number, length: number): Buffer;
  close(): void;
}

class BufferZipSource implements ZipSource {
  constructor(private readonly bytes: Buffer) {}

  get size(): number {
    return this.bytes.length;
  }

  read(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.bytes.length) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表 ZIP 读取范围越界");
    }
    return this.bytes.subarray(offset, offset + length);
  }

  close(): void {}
}

class FileZipSource implements ZipSource {
  private fd: number | null;

  constructor(
    path: string,
    private readonly offset: number,
    readonly size: number,
    private readonly onClose?: () => void,
  ) {
    this.fd = openSync(path, "r");
  }

  read(offset: number, length: number): Buffer {
    if (this.fd === null) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表临时文件已关闭");
    }
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表 ZIP 读取范围越界");
    }
    const data = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const bytesRead = readSync(this.fd, data, read, length - read, this.offset + offset + read);
      if (bytesRead <= 0) {
        throw new AppError("IMPORT_PARSE_FAILED", "导入表 ZIP 文件不完整");
      }
      read += bytesRead;
    }
    return data;
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      closeSync(fd);
    } finally {
      this.onClose?.();
    }
  }
}

export interface OpenZipFileOptions {
  offset?: number;
  length?: number;
  limits?: Partial<XlsxLimits>;
  /** 关闭时回调：调用方可在这里清理本归档专用的临时目录。 */
  onClose?: () => void;
}

const LOCAL_SIGNATURE = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const INFLATE_FRAME_OVERHEAD_BYTES = 1024 * 1024;

/**
 * ZIP 归档（只读）：Buffer 与“文件区间”共用同一套中央目录 / 解压逻辑。
 * 导入表生产路径使用 openFile，按偏移读盘再解压，不把 256 MB 上传包整份留在 API 堆内。
 */
export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly cache = new Map<string, Buffer>();
  private readonly seenMedia = new Set<string>();
  private cachedBytes = 0;
  private mediaBytes = 0;

  private constructor(
    private readonly source: ZipSource,
    private readonly limits: XlsxLimits,
  ) {}

  static open(bytes: Buffer, limits: XlsxLimits = DEFAULT_XLSX_LIMITS): ZipArchive {
    const archive = new ZipArchive(new BufferZipSource(bytes), limits);
    archive.readCentralDirectory();
    return archive;
  }

  static openFile(path: string, options: OpenZipFileOptions = {}): ZipArchive {
    const offset = options.offset ?? 0;
    const fileSize = statSync(path).size;
    const length = options.length ?? fileSize - offset;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > fileSize) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表临时文件区间非法");
    }
    const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.limits };
    const source = new FileZipSource(path, offset, length, options.onClose);
    try {
      const archive = new ZipArchive(source, limits);
      archive.readCentralDirectory();
      return archive;
    } catch (error) {
      source.close();
      throw error;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 条目声明的解压后大小；仅用于预算预检，最终以实际解压计数为准。 */
  uncompressedSize(name: string): number | null {
    const entry = this.entries.get(name);
    return entry === undefined ? null : entry.uncompressedSize;
  }

  /** XML / 文本读取：结果进入有界缓存，受 maxEntryBytes 与 maxCachedBytes 双重限制。 */
  read(name: string): Buffer | null {
    return this.readEntry(name, true, this.limits.maxEntryBytes);
  }

  /** 图片等大对象读取：不进入缓存，调用方必须逐张处理并及时释放。 */
  readUncached(name: string, maxBytes: number = this.limits.maxMediaBytes): Buffer | null {
    return this.readEntry(name, false, maxBytes);
  }

  /** 读取 UTF-8 文本（xml，有界缓存）。 */
  readText(name: string): string | null {
    const data = this.read(name);
    return data === null ? null : data.toString("utf8");
  }

  /** 读取 XML 文本但不保留缓存：工作表 / drawing 解析完成后即可释放。 */
  readTextUncached(name: string): string | null {
    const data = this.readEntry(name, false, this.limits.maxEntryBytes);
    return data === null ? null : data.toString("utf8");
  }

  /** 释放文件描述符、缓存与调用方登记的临时目录。Buffer 归档为 no-op。 */
  close(): void {
    this.cache.clear();
    this.cachedBytes = 0;
    this.source.close();
  }

  private readEntry(name: string, useCache: boolean, maxBytes: number): Buffer | null {
    if (useCache) {
      const cached = this.cache.get(name);
      if (cached !== undefined) return cached;
    }
    const entry = this.entries.get(name);
    if (entry === undefined) return null;

    let limit = maxBytes;
    if (useCache) {
      const remaining = this.limits.maxCachedBytes - this.cachedBytes;
      if (remaining <= 0) {
        throw new AppError("IMPORT_PARSE_FAILED", "导入表 XML 解压总量超过上限");
      }
      limit = Math.min(limit, remaining);
    }
    if (limit <= 0 || entry.uncompressedSize > limit) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表条目解压后体积超过上限");
    }

    if (entry.method === 0 && entry.compressedSize > limit) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表条目体积超过上限");
    }
    if (entry.method === 8 && entry.compressedSize > limit + INFLATE_FRAME_OVERHEAD_BYTES) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表压缩条目体积超过上限");
    }
    const raw = this.source.read(entry.dataOffset, entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limit });
      } catch {
        throw new AppError("IMPORT_PARSE_FAILED", "导入表解压失败或解压后体积超过上限");
      }
    } else {
      throw new AppError("IMPORT_PARSE_FAILED", "不支持的压缩方式（zip method " + entry.method + "）：" + entry.name);
    }

    if (useCache) {
      this.cachedBytes += data.length;
      this.cache.set(name, data);
    } else if (name.startsWith("xl/media/") && !this.seenMedia.has(name)) {
      this.seenMedia.add(name);
      this.mediaBytes += data.length;
      if (this.mediaBytes > this.limits.maxMediaTotalBytes) {
        throw new AppError("IMPORT_PARSE_FAILED", "导入表图片总量超过上限");
      }
    }
    return data;
  }

  private readCentralDirectory(): void {
    const tailLength = Math.min(this.source.size, 22 + 65535);
    const tailStart = this.source.size - tailLength;
    const tail = this.source.read(tailStart, tailLength);
    let eocdIndex = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocdIndex = i;
        break;
      }
    }
    if (eocdIndex < 0) {
      throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（缺少 zip 结束记录）");
    }
    const count = tail.readUInt16LE(eocdIndex + 10);
    const centralSize = tail.readUInt32LE(eocdIndex + 12);
    const centralOffset = tail.readUInt32LE(eocdIndex + 16);
    const eocd = tailStart + eocdIndex;
    if (centralOffset === 0xffffffff || centralSize === 0xffffffff || count === 0xffff) {
      throw new AppError("IMPORT_PARSE_FAILED", "不支持 ZIP64 导入表");
    }
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new AppError("IMPORT_PARSE_FAILED", "导入表 ZIP 中央目录超过上限");
    }
    if (centralOffset + centralSize > this.source.size || eocd < centralOffset + centralSize) {
      throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 中央目录越界）");
    }
    const central = this.source.read(centralOffset, centralSize);
    let cursor = 0;
    for (let i = 0; i < count; i += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 中央目录损坏）");
      }
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > central.length || localOffset + 30 > this.source.size) {
        throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 条目越界）");
      }
      const name = central.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      const local = this.source.read(localOffset, 30);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 本地头损坏）");
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > this.source.size) {
        throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 条目数据越界）");
      }
      this.entries.set(name, { name, method, compressedSize, uncompressedSize, dataOffset });
      cursor = entryEnd;
    }
    if (this.entries.size === 0) {
      throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（zip 中央目录为空）");
    }
  }
}

export interface SheetGrid {
  name: string;
  path: string;
  /** 行数组按 Excel 行号稀疏存放；缺行 / 缺列由读取方按空值处理。 */
  rows: (string | null)[][];
}

/** 表内图片锚点（1 based 行 / 列；sheet = 工作表名，media = xl/media 下文件名）。 */
export interface SheetImageAnchor {
  sheet: string;
  row: number;
  col: number;
  media: string;
}

export interface ParsedWorkbook {
  sheets: SheetGrid[];
  anchors: SheetImageAnchor[];
  /** 预览阶段只检查媒体是否存在，不读取 / 解压图片字节。 */
  hasMedia(name: string): boolean;
  /** 提交阶段逐张读取媒体；读取结果不缓存，调用方需及时释放。 */
  readMedia(name: string): Buffer | null;
  /** 关闭文件型归档并清理调用方登记的临时目录；Buffer 归档为 no-op。 */
  close(): void;
}

function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return null;
  return text.slice(start + open.length, end);
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function unescapeXml(text: string): string {
  return text.replace(
    /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));|&(lt|gt|quot|apos|amp);/g,
    (entity: string, hex: string | undefined, decimal: string | undefined, named: string | undefined): string => {
      if (named === "lt") return "<";
      if (named === "gt") return ">";
      if (named === "quot") return String.fromCharCode(34);
      if (named === "apos") return String.fromCharCode(39);
      if (named === "amp") return "&";
      const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return isXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const quote = String.fromCharCode(34);
  for (const piece of xml.split("<Relationship ").slice(1)) {
    const id = between(piece, "Id=" + quote, quote);
    const target = between(piece, "Target=" + quote, quote);
    if (id !== null && target !== null) map.set(id, target);
  }
  return map;
}

function resolvePath(basePath: string, target: string): string {
  const parts = basePath.split("/");
  parts.pop();
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function colIndex(letters: string): number {
  let value = 0;
  for (const ch of letters) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

function splitCellRef(ref: string): { letters: string; row: number } {
  let end = 0;
  while (end < ref.length) {
    const code = ref.charCodeAt(end);
    if (code < 65 || code > 90) break;
    end += 1;
  }
  const letters = end === 0 ? "A" : ref.slice(0, end);
  const row = Number(ref.slice(end)) - 1;
  return { letters, row };
}

/** 内联字符串 / 富文本：拼接所有 <t> 文本。 */
function inlineText(chunk: string): string {
  let text = "";
  let from = 0;
  while (true) {
    const open = chunk.indexOf("<t", from);
    if (open < 0) break;
    const gt = chunk.indexOf(">", open);
    if (gt < 0) break;
    const close = chunk.indexOf("</t>", gt);
    if (close < 0) break;
    text += unescapeXml(chunk.slice(gt + 1, close));
    from = close + 4;
  }
  return text;
}

interface TextBudget {
  remaining: number;
}

function consumeTextBudget(budget: TextBudget, chars: number): void {
  budget.remaining -= chars;
  if (budget.remaining < 0) {
    throw new AppError("IMPORT_PARSE_FAILED", "导入表文本总量超过上限");
  }
}

function readSharedStrings(zip: ZipArchive, budget: TextBudget): string[] {
  const xml = zip.readTextUncached("xl/sharedStrings.xml");
  if (xml === null) return [];
  const list: string[] = [];
  let cursor = xml.indexOf("<si>");
  while (cursor >= 0) {
    const next = xml.indexOf("<si>", cursor + 4);
    const value = inlineText(xml.slice(cursor + 4, next < 0 ? xml.length : next));
    consumeTextBudget(budget, value.length);
    list.push(value);
    cursor = next;
  }
  return list;
}

interface CellBudget {
  remaining: number;
}

function readSheetGrid(
  zip: ZipArchive,
  name: string,
  path: string,
  shared: string[],
  limits: XlsxLimits,
  budget: CellBudget,
  textBudget: TextBudget,
): SheetGrid {
  const xml = zip.readTextUncached(path);
  if (xml === null) return { name, path, rows: [] };
  const quote = String.fromCharCode(34);
  const grid: (string | null)[][] = [];
  let cursor = xml.indexOf("<c ");
  while (cursor >= 0) {
    const next = xml.indexOf("<c ", cursor + 3);
    const chunk = xml.slice(cursor + 3, next < 0 ? xml.length : next);
    const endOfOpen = chunk.indexOf(">");
    if (endOfOpen >= 0) {
      const attrs = chunk.slice(0, endOfOpen);
      const close = chunk.indexOf("</c>");
      const inner = close >= 0 && endOfOpen < close ? chunk.slice(endOfOpen + 1, close) : "";
      const ref = between(attrs, "r=" + quote, quote);
      if (ref !== null) {
        const typeAttr = between(attrs, " t=" + quote, quote);
        let value: string | null = null;
        const valueIndex = inner.indexOf("<v>");
        if (valueIndex >= 0) {
          const valueEnd = inner.indexOf("</v>", valueIndex);
          value = inner.slice(valueIndex + 3, valueEnd >= 0 ? valueEnd : inner.length);
        } else if (inner.indexOf("<t") >= 0) {
          value = inlineText(inner);
        }
        if (value !== null) {
          let text = value;
          if (typeAttr === "s") {
            const index = Number(value);
            text = shared[index] === undefined ? "" : shared[index];
          } else {
            consumeTextBudget(textBudget, text.length);
          }
          const parsed = splitCellRef(ref);
          const rowCol = colIndex(parsed.letters);
          if (!Number.isInteger(parsed.row) || parsed.row < 0 || parsed.row >= limits.maxRows) {
            throw new AppError("IMPORT_PARSE_FAILED", "导入表行号超出上限：" + ref);
          }
          if (rowCol < 0 || rowCol >= limits.maxColumns) {
            throw new AppError("IMPORT_PARSE_FAILED", "导入表列号超出上限：" + ref);
          }
          let target = grid[parsed.row];
          if (target === undefined) {
            target = [];
            grid[parsed.row] = target;
          }
          target[rowCol] = text;
        }
      }
    }
    cursor = next;
  }
  let maxCol = 0;
  for (const row of grid) if (row !== undefined) maxCol = Math.max(maxCol, row.length);
  const cellCount = grid.length * maxCol;
  if (cellCount > limits.maxSheetCells || cellCount > budget.remaining) {
    throw new AppError("IMPORT_PARSE_FAILED", "导入表单元格总量超过上限：" + name);
  }
  budget.remaining -= cellCount;
  // 保留稀疏行：不把只为定位最大行列的空槽展开成矩形，降低大表峰值内存。
  return { name, path, rows: grid };
}

function readAnchors(zip: ZipArchive, sheets: SheetGrid[]): SheetImageAnchor[] {
  const anchors: SheetImageAnchor[] = [];
  const quote = String.fromCharCode(34);
  for (const sheet of sheets) {
    const base = sheet.path.split("/").pop() ?? "";
    const relsPath = sheet.path.slice(0, sheet.path.length - base.length) + "_rels/" + base + ".rels";
    const relsXml = zip.readTextUncached(relsPath);
    if (relsXml === null) continue;
    const rels = parseRelationships(relsXml);
    let drawingPath: string | null = null;
    for (const target of rels.values()) {
      if (target.includes("drawing")) {
        drawingPath = target.startsWith("/") ? target.slice(1) : resolvePath(sheet.path, target);
      }
    }
    if (drawingPath === null) continue;
    const drawingXml = zip.readTextUncached(drawingPath);
    if (drawingXml === null) continue;
    const drawingBase = drawingPath.split("/").pop() ?? "";
    const drawingRelsPath = drawingPath.slice(0, drawingPath.length - drawingBase.length) + "_rels/" + drawingBase + ".rels";
    const drawingRelsXml = zip.readTextUncached(drawingRelsPath);
    const drawingRels = drawingRelsXml === null ? new Map<string, string>() : parseRelationships(drawingRelsXml);
    const normalized = drawingXml
      .split("<xdr:twoCellAnchor>").join("<xdr:oneCellAnchor>")
      .split("<xdr:absoluteAnchor>").join("<xdr:oneCellAnchor>");
    for (const piece of normalized.split("<xdr:oneCellAnchor").slice(1)) {
      const colText = between(piece, "<xdr:col>", "</xdr:col>");
      const rowText = between(piece, "<xdr:row>", "</xdr:row>");
      const embedIndex = piece.indexOf("r:embed=");
      if (colText === null || rowText === null || embedIndex < 0) continue;
      const embed = between(piece.slice(embedIndex), "r:embed=" + quote, quote);
      if (embed === null) continue;
      const mediaPath = drawingRels.get(embed);
      if (mediaPath === undefined) continue;
      const media = mediaPath.split("/").pop();
      if (media === undefined || media === "") continue;
      anchors.push({ sheet: sheet.name, row: Number(rowText) + 1, col: Number(colText) + 1, media });
    }
  }
  return anchors;
}

/** 解析已打开的归档：全部工作表（文本网格）+ 图片锚点 + 按需媒体读取器。 */
function parseWorkbookArchive(zip: ZipArchive, limits: XlsxLimits): ParsedWorkbook {
  const workbookXml = zip.readTextUncached("xl/workbook.xml");
  const workbookRelsXml = zip.readTextUncached("xl/_rels/workbook.xml.rels");
  if (workbookXml === null || workbookRelsXml === null) {
    throw new AppError("IMPORT_PARSE_FAILED", "文件不是有效的 xlsx（缺少 workbook.xml）");
  }
  const quote = String.fromCharCode(34);
  const rels = parseRelationships(workbookRelsXml);
  const textBudget: TextBudget = { remaining: limits.maxTextChars };
  const shared = readSharedStrings(zip, textBudget);
  const sheets: SheetGrid[] = [];
  const budget: CellBudget = { remaining: limits.maxWorkbookCells };
  for (const piece of workbookXml.split("<sheet ").slice(1)) {
    const name = between(piece, "name=" + quote, quote);
    const rid = between(piece, "r:id=" + quote, quote);
    if (name === null || rid === null) continue;
    const target = rels.get(rid);
    if (target === undefined) continue;
    const path = target.startsWith("/") ? target.slice(1) : resolvePath("xl/workbook.xml", target);
    if (zip.has(path)) sheets.push(readSheetGrid(zip, name, path, shared, limits, budget, textBudget));
  }
  if (sheets.length === 0) {
    throw new AppError("IMPORT_PARSE_FAILED", "工作簿里没有可读的工作表");
  }
  return {
    sheets,
    anchors: readAnchors(zip, sheets),
    hasMedia: (name: string) => zip.has("xl/media/" + name),
    readMedia: (name: string) => {
      const path = "xl/media/" + name;
      const size = zip.uncompressedSize(path);
      if (size === null) return null;
      if (size > limits.maxMediaBytes) {
        throw new AppError("IMPORT_PARSE_FAILED", "导入表单张图片超过上限：" + name);
      }
      return zip.readUncached(path, limits.maxMediaBytes);
    },
    close: () => zip.close(),
  };
}

/** 从内存解析导入表工作簿（测试 / 小文件兼容入口）。 */
export function parseWorkbook(bytes: Buffer, overrides: Partial<XlsxLimits> = {}): ParsedWorkbook {
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...overrides };
  const zip = ZipArchive.open(bytes, limits);
  try {
    return parseWorkbookArchive(zip, limits);
  } catch (error) {
    zip.close();
    throw error;
  }
}

export interface ParseWorkbookFileOptions {
  offset?: number;
  length?: number;
  limits?: Partial<XlsxLimits>;
  onClose?: () => void;
}

/** 从盘上文件区间解析导入表工作簿：生产路径不整读上传文件。 */
export function parseWorkbookFile(path: string, options: ParseWorkbookFileOptions = {}): ParsedWorkbook {
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.limits };
  const zip = ZipArchive.openFile(path, {
    offset: options.offset,
    length: options.length,
    limits,
    onClose: options.onClose,
  });
  try {
    return parseWorkbookArchive(zip, limits);
  } catch (error) {
    zip.close();
    throw error;
  }
}
