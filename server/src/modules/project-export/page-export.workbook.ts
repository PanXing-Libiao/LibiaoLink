import ExcelJS from "exceljs";
import type { PageExportSheetKey } from "@libiaolink/contracts";
import type {
  ExportImage,
  ExportPhotoLoader,
  ExportPhotoRef,
  ProjectExportWorkbookFileResult,
  ProjectExportWorkbookResult,
  WorkbookImagePlacement,
} from "./project-export.workbook.js";
import { sanitizeFileName } from "./project-export.workbook.js";
import type { PageExportCellValue } from "./page-export.mapping.js";

export interface PageExportWorkbookColumn {
  key: string;
  label: string;
  width: number;
  photo: boolean;
}

export interface PageExportWorkbookRow {
  values: Readonly<Record<string, PageExportCellValue>>;
  photos: Readonly<Record<string, readonly ExportPhotoRef[]>>;
}

export interface PageExportWorkbookSheet {
  key: PageExportSheetKey;
  name: string;
  columns: readonly PageExportWorkbookColumn[];
  rows: readonly PageExportWorkbookRow[];
}

export interface PageExportWorkbookPayload {
  projectId: string;
  origin: string | null;
  sheets: readonly PageExportWorkbookSheet[];
  images: ReadonlyMap<string, ExportImage>;
}

const IMAGE_WIDTH_PX = 88;
const IMAGE_HEIGHT_PX = 64;
const IMAGE_GAP_PX = 4;
const PX_PER_POINT = 4 / 3;
const EMU_PER_PIXEL = 9525;
const IMAGE_PADDING_PX = 2;

function uniquePhotos(refs: readonly ExportPhotoRef[]): ExportPhotoRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.fileId)) return false;
    seen.add(ref.fileId);
    return true;
  });
}

function appendMissing(base: string, refs: readonly ExportPhotoRef[], images: ReadonlyMap<string, ExportImage>): string {
  const missing = refs.filter((ref) => !images.has(ref.fileId)).map((ref) => "（附图缺失）" + ref.name);
  if (missing.length === 0) return base;
  const note = missing.join("\n");
  return base === "" ? note : base + "\n" + note;
}

function imageCapacity(widthChars: number): number {
  return Math.max(1, Math.floor((widthChars * 7 + 5 + 0) / (IMAGE_WIDTH_PX + IMAGE_GAP_PX)));
}

function placeImages(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  refs: readonly ExportPhotoRef[],
  images: ReadonlyMap<string, ExportImage>,
  column: number,
  rowNumber: number,
  capacity: number,
  baseHeightPx: number,
): number {
  const available = uniquePhotos(refs).filter((ref) => images.has(ref.fileId));
  for (let index = 0; index < available.length; index += 1) {
    const ref = available[index];
    if (ref === undefined) continue;
    const image = images.get(ref.fileId);
    if (image === undefined) continue;
    const slot = index % capacity;
    const line = Math.floor(index / capacity);
    const xOffsetPx = IMAGE_PADDING_PX + slot * (IMAGE_WIDTH_PX + IMAGE_GAP_PX);
    const yOffsetPx = baseHeightPx + IMAGE_PADDING_PX + line * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX);
    const imageId = workbook.addImage({
      buffer: Uint8Array.from(image.bytes).buffer as ArrayBuffer,
      extension: image.extension,
    });
    const position = {
      tl: {
        col: column - 1,
        row: rowNumber - 1,
        nativeCol: column - 1,
        nativeColOff: Math.round(xOffsetPx * EMU_PER_PIXEL),
        nativeRow: rowNumber - 1,
        nativeRowOff: Math.round(yOffsetPx * EMU_PER_PIXEL),
      },
      ext: { width: IMAGE_WIDTH_PX, height: IMAGE_HEIGHT_PX },
      editAs: "oneCell",
    };
    sheet.addImage(imageId, position as unknown as ExcelJS.ImageRange);
  }
  return available.length;
}

function setWidths(sheet: ExcelJS.Worksheet, columns: readonly PageExportWorkbookColumn[]): void {
  for (let index = 0; index < columns.length; index += 1) {
    sheet.getColumn(index + 1).width = columns[index]?.width ?? 8.43;
  }
}

function styleHeader(sheet: ExcelJS.Worksheet, columns: readonly PageExportWorkbookColumn[]): ExcelJS.Row {
  const row = sheet.addRow(columns.map((column) => column.label));
  row.height = 24;
  for (let index = 1; index <= columns.length; index += 1) {
    const cell = row.getCell(index);
    cell.font = { name: "Arial", size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFE4E4E7" } } };
  }
  return row;
}

function applyLinkFont(cell: ExcelJS.Cell): void {
  const value = cell.value;
  if (value !== null && typeof value === "object" && "hyperlink" in value) {
    cell.font = { name: "Arial", size: 10, color: { argb: "FF0563C1" }, underline: true };
  }
}

function styleBodyRow(sheet: ExcelJS.Worksheet, rowNumber: number, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    const cell = sheet.getCell(rowNumber, index);
    cell.font = { name: "Arial", size: 10 };
    cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
    applyLinkFont(cell);
  }
}

function textWidth(value: string): number {
  let width = 0;
  for (const char of value) width += /[\u0000-\u00ff]/.test(char) ? 1 : 2;
  return width;
}

function estimatedLines(value: string, widthChars: number): number {
  if (value === "") return 1;
  let total = 0;
  for (const line of value.split("\n")) total += Math.max(1, Math.ceil(textWidth(line) / Math.max(4, widthChars)));
  return total;
}

function estimatedTextHeight(sheet: ExcelJS.Worksheet, values: readonly string[], columns: readonly number[]): number {
  let lines = 1;
  for (let index = 0; index < values.length; index += 1) {
    const column = columns[index] ?? 1;
    lines = Math.max(lines, estimatedLines(values[index] ?? "", sheet.getColumn(column).width ?? 8.43));
  }
  return Math.max(24, Math.min(220, lines * 14 + 6));
}

function plainText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "text" in value) return String(value.text ?? "");
  return "";
}

function sheetNameOf(value: string): string {
  let result = value;
  for (const char of ["[", "]", ":", "*", "?", "/", "\\"]) result = result.split(char).join("_");
  result = result.replace(/[\u0000-\u001f]/g, "").replace(/^\u0027+|\u0027+$/g, "").trim();
  return (result === "" ? "导出数据" : result).slice(0, 31);
}

function rowValues(sheet: PageExportWorkbookSheet, row: PageExportWorkbookRow): PageExportCellValue[] {
  return sheet.columns.map((column) => (column.photo ? null : row.values[column.key] ?? null));
}

function addPageSheet(workbook: ExcelJS.Workbook, payload: PageExportWorkbookPayload, sheetDefinition: PageExportWorkbookSheet): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(sheetNameOf(sheetDefinition.name), { views: [{ state: "frozen", ySplit: 1 }] });
  setWidths(sheet, sheetDefinition.columns);
  styleHeader(sheet, sheetDefinition.columns);
  for (const definition of sheetDefinition.rows) {
    const row = sheet.addRow(rowValues(sheetDefinition, definition));
    const photoColumns: Array<{ column: number; refs: readonly ExportPhotoRef[]; capacity: number }> = [];
    for (let index = 0; index < sheetDefinition.columns.length; index += 1) {
      const column = sheetDefinition.columns[index];
      if (column === undefined || !column.photo) continue;
      const refs = uniquePhotos(definition.photos[column.key] ?? []);
      row.getCell(index + 1).value = appendMissing("", refs, payload.images) || null;
      photoColumns.push({ column: index + 1, refs, capacity: imageCapacity(column.width) });
    }
    styleBodyRow(sheet, row.number, sheetDefinition.columns.length);
    const texts = sheetDefinition.columns.map((_column, index) => plainText(row.getCell(index + 1)));
    const basePx = estimatedTextHeight(sheet, texts, sheetDefinition.columns.map((_column, index) => index + 1));
    let imageLines = 0;
    let availableImageCount = 0;
    for (const photo of photoColumns) {
      const available = uniquePhotos(photo.refs).filter((ref) => payload.images.has(ref.fileId)).length;
      availableImageCount += available;
      imageLines = Math.max(imageLines, Math.ceil(available / photo.capacity));
    }
    row.height = (basePx + imageLines * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX) + (availableImageCount > 0 ? 4 : 0)) / PX_PER_POINT;
    for (const photo of photoColumns) {
      placeImages(workbook, sheet, photo.refs, payload.images, photo.column, row.number, photo.capacity, basePx);
    }
  }
  return sheet;
}

export async function buildPageExportWorkbook(payload: PageExportWorkbookPayload): Promise<ProjectExportWorkbookResult> {
  const workbook = new ExcelJS.Workbook();
  const sheetNames: string[] = [];
  for (const definition of payload.sheets) {
    sheetNames.push(addPageSheet(workbook, payload, definition).name);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), sheetNames };
}

export function pageExportFileName(project: { code: string; name: string }, sheets: readonly { name: string }[]): string {
  const suffix = sheets.map((sheet) => sanitizeFileName(sheet.name)).join("、");
  return "[" + sanitizeFileName(project.code) + "] " + sanitizeFileName(project.name) + " - " + suffix + ".xlsx";
}

export class PageExportWorkbookWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sheetNames: string[] = [];
  private readonly images = new Map<string, ExportImage>();
  private readonly imagePlacements: WorkbookImagePlacement[] = [];
  private committed = false;

  constructor(
    private readonly filePath: string,
    private readonly photoLoader: ExportPhotoLoader,
  ) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true, useSharedStrings: true });
  }

  async writeSheet(sheetDefinition: PageExportWorkbookSheet, rows: AsyncIterable<PageExportWorkbookRow>): Promise<void> {
    const name = sheetNameOf(sheetDefinition.name);
    const sheet = this.workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    this.sheetNames.push(name);
    setWidths(sheet, sheetDefinition.columns);
    styleHeader(sheet, sheetDefinition.columns).commit();
    for await (const definition of rows) {
      const row = sheet.addRow(rowValues(sheetDefinition, definition));
      const photoColumns: Array<{
        column: number;
        refs: readonly ExportPhotoRef[];
        images: ReadonlyMap<string, ExportImage>;
        capacity: number;
      }> = [];
      for (let index = 0; index < sheetDefinition.columns.length; index += 1) {
        const column = sheetDefinition.columns[index];
        if (column === undefined || !column.photo) continue;
        const refs = uniquePhotos(definition.photos[column.key] ?? []);
        const images = await this.photoLoader(refs);
        row.getCell(index + 1).value = appendMissing("", refs, images) || null;
        photoColumns.push({ column: index + 1, refs, images, capacity: imageCapacity(column.width) });
      }
      styleBodyRow(sheet, row.number, sheetDefinition.columns.length);
      const texts = sheetDefinition.columns.map((_column, index) => plainText(row.getCell(index + 1)));
      const basePx = estimatedTextHeight(sheet, texts, sheetDefinition.columns.map((_column, index) => index + 1));
      let imageLines = 0;
      let availableImageCount = 0;
      for (const photo of photoColumns) {
        const available = uniquePhotos(photo.refs).filter((ref) => photo.images.has(ref.fileId)).length;
        availableImageCount += available;
        imageLines = Math.max(imageLines, Math.ceil(available / photo.capacity));
      }
      row.height = (basePx + imageLines * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX) + (availableImageCount > 0 ? 4 : 0)) / PX_PER_POINT;
      for (const photo of photoColumns) {
        this.placeThumbnails(sheet, photo.refs, photo.images, photo.column, row.number, photo.capacity, basePx);
      }
      row.commit();
    }
    sheet.commit();
  }

  async commit(): Promise<ProjectExportWorkbookFileResult> {
    if (this.committed) throw new Error("页面导出工作簿已经提交");
    this.committed = true;
    await this.workbook.commit();
    return {
      filePath: this.filePath,
      sheetNames: this.sheetNames,
      images: this.images,
      imagePlacements: this.imagePlacements,
    };
  }

  async abort(): Promise<void> {
    if (this.committed) return;
    this.committed = true;
    await this.workbook.commit().catch(() => undefined);
  }

  private placeThumbnails(
    sheet: ExcelJS.Worksheet,
    refs: readonly ExportPhotoRef[],
    images: ReadonlyMap<string, ExportImage>,
    column: number,
    rowNumber: number,
    capacity: number,
    baseHeightPx: number,
  ): void {
    const available = uniquePhotos(refs).filter((ref) => images.has(ref.fileId));
    for (let index = 0; index < available.length; index += 1) {
      const ref = available[index];
      if (ref === undefined) continue;
      const image = images.get(ref.fileId);
      if (image === undefined) continue;
      this.images.set(ref.fileId, image);
      this.imagePlacements.push({
        sheetId: sheet.id,
        row: rowNumber,
        column,
        fileId: ref.fileId,
        xOffsetPx: IMAGE_PADDING_PX + (index % capacity) * (IMAGE_WIDTH_PX + IMAGE_GAP_PX),
        yOffsetPx: baseHeightPx + IMAGE_PADDING_PX + Math.floor(index / capacity) * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX),
        widthPx: IMAGE_WIDTH_PX,
        heightPx: IMAGE_HEIGHT_PX,
      });
    }
  }
}
