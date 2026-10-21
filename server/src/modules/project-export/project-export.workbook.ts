import ExcelJS from "exceljs";

/** 项目导出工作簿：纯数据 + 已加载图片 → xlsx 字节。模板列序对齐企微智能表格样例。 */

export type ExportImageExtension = "png" | "jpeg" | "gif";

export interface ExportImage {
  bytes: Uint8Array;
  extension: ExportImageExtension;
}

export interface ExportFileLink {
  id: string;
  name: string;
}

export interface ExportPhotoRef {
  fileId: string;
  name: string;
}

export interface ProjectExportTaskRow {
  description: string;
  managers: string;
  owners: string;
  status: string;
  progress: number | null;
  onTime: string;
  deliverables: string;
  note: string;
  plannedStart: string;
  plannedEnd: string;
  headcount: number | null;
  estimatedDays: number | null;
  actualEnd: string;
  stage: string;
  priority: string;
  endedAt: string;
  files: ExportFileLink[];
  changeDates: string[];
}

export interface ProjectExportReportRow {
  date: string;
  author: string;
  doneWork: string;
  plan: string;
  onsitePhotos: ExportPhotoRef[];
  issueDescription: string;
  issueCategory: string;
  issueSolution: string;
  issueState: string;
  issuePhotos: ExportPhotoRef[];
  headcount: number | null;
}

export interface ProjectExportChangeRow {
  changedAt: string;
  stage: string;
  files: ExportFileLink[];
  description: string;
  beforeText: string;
  afterText: string;
  reason: string;
  applicant: string;
  writer: string;
  afterVersion: string;
  afterFiles: ExportFileLink[];
  progress: string;
  related: string;
  beforePhotos: ExportPhotoRef[];
  afterPhotos: ExportPhotoRef[];
}

export interface ProjectExportStakeholderRow {
  name: string;
  contact: string;
  email: string;
  position: string;
  company: string;
  writer: string;
  submittedAt: string;
}

export interface ProjectExportPayload {
  project: { id: string; code: string; name: string };
  origin: string | null;
  tasks: ProjectExportTaskRow[];
  reports: ProjectExportReportRow[];
  changes: ProjectExportChangeRow[];
  stakeholders: ProjectExportStakeholderRow[];
  images: Map<string, ExportImage>;
}

export interface ProjectExportWorkbookResult {
  buffer: Buffer;
  sheetNames: string[];
}

const TASK_HEADERS = [
  "任务描述",
  "项目经理",
  "任务负责人",
  "任务状态",
  "项目进度",
  "是否按时交付",
  "输出成果文件",
  "项目进展描述",
  "开始日期",
  "预计完成日期",
  "预计所需施工人数",
  "预计所需天数",
  "实际完成日期",
  "阶段性里程",
  "紧急重要度",
  "结束时间",
  "文件",
  "变更关联",
];

const REPORT_HEADERS = [
  "日期",
  "填写者",
  "当日完成工作",
  "明日计划",
  "现场工作附图",
  "问题描述",
  "问题归类",
  "解决方案或建议",
  "问题附图",
  "问题是否处理",
  "施工人数",
];

const CHANGE_HEADERS = [
  "变更时间",
  "变更阶段",
  "变更文件",
  "变更内容描述",
  "变更前",
  "变更后",
  "变更原因",
  "变更申请人",
  "填写者",
  "变更后文件版本",
  "变更后文件",
  "进度",
  "关联",
];

const STAKEHOLDER_HEADERS = [
  "干系人姓名/name",
  "电话或whats app或微信号",
  "邮箱Email",
  "职务Position/责任板块",
  "所属公司company",
  "填写者",
  "提交时间",
];

const TASK_WIDTHS: Record<number, number> = { 1: 43, 2: 16.4, 3: 18.9, 4: 13.8, 5: 10, 6: 12, 7: 14, 8: 23.2, 9: 19.8, 10: 15.5, 11: 11.2, 12: 13.8, 13: 14, 14: 17.2, 15: 13.8, 16: 12, 17: 21.5, 18: 16 };
const REPORT_WIDTHS: Record<number, number> = { 1: 13.8, 2: 16.4, 3: 21.5, 4: 23.2, 5: 60.2, 6: 26.7, 7: 18.9, 8: 23.2, 9: 37, 10: 13.8, 11: 11.2 };
const CHANGE_WIDTHS: Record<number, number> = { 1: 21.5, 2: 13.8, 3: 18.9, 4: 23.2, 5: 30, 6: 30, 7: 23.2, 8: 16.4, 9: 16.4, 10: 23.2, 11: 21.5, 12: 13.8, 13: 21.5 };
const STAKEHOLDER_WIDTHS: Record<number, number> = { 1: 22, 2: 25, 3: 30, 4: 30, 5: 24, 6: 18, 7: 22 };

const IMAGE_WIDTH_PX = 88;
const IMAGE_HEIGHT_PX = 64;
const IMAGE_GAP_PX = 4;
const PX_PER_POINT = 4 / 3;

const SHANGHAI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function partsOf(value: string): { year: string; month: string; day: string; hour: string; minute: string } | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly !== null) {
    return { year: dateOnly[1] ?? "", month: dateOnly[2] ?? "", day: dateOnly[3] ?? "", hour: "00", minute: "00" };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const values: Record<string, string> = {};
  for (const part of SHANGHAI_PARTS.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: values.year ?? "",
    month: values.month ?? "",
    day: values.day ?? "",
    hour: values.hour === "24" ? "00" : (values.hour ?? ""),
    minute: values.minute ?? "",
  };
}

function monthDay(month: string, day: string): string {
  return String(Number(month)) + "月" + String(Number(day)) + "日";
}

export function formatTaskDate(value: string | null): string {
  if (value === null || value === "") return "";
  const parts = partsOf(value);
  return parts === null ? value : monthDay(parts.month, parts.day);
}

export function formatCalendarDate(value: string | null): string {
  if (value === null || value === "") return "";
  const parts = partsOf(value);
  if (parts === null) return value;
  return parts.year + "/" + String(Number(parts.month)) + "/" + String(Number(parts.day));
}

export function formatReportDate(value: string, state: string): string {
  const parts = partsOf(value);
  const text = parts === null ? value : parts.year + "年" + String(Number(parts.month)) + "月" + String(Number(parts.day)) + "日";
  return state === "draft" ? text + "（草稿）" : text;
}

export function formatReportTime(value: string): string {
  const parts = partsOf(value);
  if (parts === null) return value;
  return parts.year + "年" + String(Number(parts.month)) + "月" + String(Number(parts.day)) + "日 " + parts.hour + ":" + parts.minute;
}

export function numbered(values: readonly string[]): string {
  const clean = values.map((value) => value.trim()).filter((value) => value !== "");
  return clean.map((value, index) => String(index + 1) + " " + value).join("\n");
}

export function sanitizeFileName(value: string): string {
  const result = value
    .replace(/[\\/:*?\u0022<>|\[\]\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return result === "" ? "项目" : result.slice(0, 120).replace(/[. ]+$/g, "");
}

export function projectExportFileName(project: { code: string; name: string }): string {
  return "[" + sanitizeFileName(project.code) + "] " + sanitizeFileName(project.name) + ".xlsx";
}

/** 企微样例的「变更后文件版本」= 文件名去掉最后一级扩展名（版本名沿用文件名），不是 vN。 */
export function versionNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}

export function normalizeHttpOrigin(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function sheetNameOf(value: string): string {
  let result = value;
  for (const char of ["[", "]", ":", "*", "?", "/", "\\"]) result = result.split(char).join("_");
  result = result.replace(/[\u0000-\u001f]/g, "").replace(/^\u0027+|\u0027+$/g, "").trim();
  if (result === "") result = "项目任务";
  return result.slice(0, 31);
}

function fileLink(origin: string | null, projectId: string, fileName: string): string | null {
  if (origin === null) return null;
  return origin + "/#/files?project=" + encodeURIComponent(projectId) + "&q=" + encodeURIComponent(fileName);
}

function filesValue(files: readonly ExportFileLink[], origin: string | null, projectId: string): ExcelJS.CellValue {
  if (files.length === 0) return null;
  const text = files.map((file) => file.name).join("\n");
  const link = fileLink(origin, projectId, files[0]?.name ?? "");
  if (link === null) return text;
  return { text, hyperlink: link, tooltip: files[0]?.name ?? text };
}

function applyLinkFont(cell: ExcelJS.Cell): void {
  if (cell.value !== null && typeof cell.value === "object" && "hyperlink" in cell.value) {
    cell.font = { name: "Arial", size: 10, color: { argb: "FF0563C1" }, underline: true };
  }
}

function styleHeader(sheet: ExcelJS.Worksheet, headers: readonly string[]): void {
  const row = sheet.addRow([...headers]);
  row.height = 24;
  for (let index = 1; index <= headers.length; index += 1) {
    const cell = row.getCell(index);
    cell.font = { name: "Arial", size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFE4E4E7" } } };
  }
}

function setWidths(sheet: ExcelJS.Worksheet, widths: Record<number, number>, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    sheet.getColumn(index).width = widths[index] ?? 8.43;
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
    const col = columns[index] ?? 1;
    const width = sheet.getColumn(col).width ?? 8.43;
    lines = Math.max(lines, estimatedLines(values[index] ?? "", width));
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

function appendMissing(base: string, missing: readonly string[]): string {
  if (missing.length === 0) return base;
  const note = missing.map((name) => "（附图缺失）" + name).join("\n");
  return base === "" ? note : base + "\n" + note;
}

function uniquePhotos(refs: readonly ExportPhotoRef[]): ExportPhotoRef[] {
  const seen = new Set<string>();
  const result: ExportPhotoRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.fileId)) continue;
    seen.add(ref.fileId);
    result.push(ref);
  }
  return result;
}

function imageCapacity(widthChars: number, gapPx = 0): number {
  return Math.max(1, Math.floor((widthChars * 7 + 5 + gapPx) / (IMAGE_WIDTH_PX + IMAGE_GAP_PX)));
}

function missingNames(refs: readonly ExportPhotoRef[], images: Map<string, ExportImage>): string[] {
  return refs.filter((ref) => !images.has(ref.fileId)).map((ref) => ref.name);
}

function availableRefs(refs: readonly ExportPhotoRef[], images: Map<string, ExportImage>): ExportPhotoRef[] {
  return refs.filter((ref) => images.has(ref.fileId));
}

function placeImages(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  refs: readonly ExportPhotoRef[],
  images: Map<string, ExportImage>,
  column: number,
  rowNumber: number,
  capacity: number,
  baseHeightPx: number,
  rowHeightPx: number,
): number {
  const available = availableRefs(refs, images);
  for (let index = 0; index < available.length; index += 1) {
    const ref = available[index];
    if (ref === undefined) continue;
    const image = images.get(ref.fileId);
    if (image === undefined) continue;
    const slot = index % capacity;
    const line = Math.floor(index / capacity);
    const xOffset = (slot / capacity) * 0.96 + 0.01;
    const yOffset = (baseHeightPx + 2 + line * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX)) / rowHeightPx;
    const imageBuffer = Uint8Array.from(image.bytes).buffer as ArrayBuffer;
    const imageId = workbook.addImage({ buffer: imageBuffer, extension: image.extension });
    sheet.addImage(imageId, {
      tl: { col: column - 1 + xOffset, row: rowNumber - 1 + yOffset },
      ext: { width: IMAGE_WIDTH_PX, height: IMAGE_HEIGHT_PX },
      editAs: "oneCell",
    });
  }
  return available.length;
}

function addTaskSheet(workbook: ExcelJS.Workbook, payload: ProjectExportPayload, name: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  setWidths(sheet, TASK_WIDTHS, TASK_HEADERS.length);
  styleHeader(sheet, TASK_HEADERS);
  for (const task of payload.tasks) {
    const row = sheet.addRow([
      task.description,
      task.managers,
      task.owners,
      task.status,
      task.progress,
      task.onTime,
      task.deliverables,
      task.note,
      task.plannedStart,
      task.plannedEnd,
      task.headcount,
      task.estimatedDays,
      task.actualEnd,
      task.stage,
      task.priority,
      task.endedAt,
      null,
      task.changeDates.join("\n"),
    ]);
    row.getCell(17).value = filesValue(task.files, payload.origin, payload.project.id);
    styleBodyRow(sheet, row.number, TASK_HEADERS.length);
    const texts: string[] = [];
    for (let col = 1; col <= TASK_HEADERS.length; col += 1) texts.push(plainText(row.getCell(col)));
    row.height = estimatedTextHeight(sheet, texts, Array.from({ length: TASK_HEADERS.length }, (_value, index) => index + 1)) / PX_PER_POINT;
  }
  return sheet;
}

function addReportSheet(workbook: ExcelJS.Workbook, payload: ProjectExportPayload, name: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  setWidths(sheet, REPORT_WIDTHS, REPORT_HEADERS.length);
  styleHeader(sheet, REPORT_HEADERS);
  for (const report of payload.reports) {
    const onsite = uniquePhotos(report.onsitePhotos);
    const issuePhotos = uniquePhotos(report.issuePhotos);
    const onsiteMissing = missingNames(onsite, payload.images);
    const issueMissing = missingNames(issuePhotos, payload.images);
    const row = sheet.addRow([
      report.date,
      report.author,
      report.doneWork,
      report.plan,
      appendMissing("", onsiteMissing),
      report.issueDescription,
      report.issueCategory,
      report.issueSolution,
      appendMissing("", issueMissing),
      report.issueState,
      report.headcount,
    ]);
    styleBodyRow(sheet, row.number, REPORT_HEADERS.length);
    const basePx = estimatedTextHeight(sheet, [
      plainText(row.getCell(3)),
      plainText(row.getCell(4)),
      plainText(row.getCell(5)),
      plainText(row.getCell(6)),
      plainText(row.getCell(7)),
      plainText(row.getCell(8)),
      plainText(row.getCell(9)),
    ], [3, 4, 5, 6, 7, 8, 9]);
    const onsiteAvailable = availableRefs(onsite, payload.images).length;
    const issueAvailable = availableRefs(issuePhotos, payload.images).length;
    const onsiteLines = Math.ceil(onsiteAvailable / imageCapacity(REPORT_WIDTHS[5] ?? 60.2));
    const issueLines = Math.ceil(issueAvailable / imageCapacity(REPORT_WIDTHS[9] ?? 37));
    const imageLines = Math.max(onsiteLines, issueLines);
    const rowHeightPx = basePx + imageLines * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX) + 4;
    row.height = rowHeightPx / PX_PER_POINT;
    placeImages(workbook, sheet, onsite, payload.images, 5, row.number, imageCapacity(REPORT_WIDTHS[5] ?? 60.2), basePx, rowHeightPx);
    placeImages(workbook, sheet, issuePhotos, payload.images, 9, row.number, imageCapacity(REPORT_WIDTHS[9] ?? 37), basePx, rowHeightPx);
  }
  return sheet;
}

function addChangeSheet(workbook: ExcelJS.Workbook, payload: ProjectExportPayload, name: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  setWidths(sheet, CHANGE_WIDTHS, CHANGE_HEADERS.length);
  styleHeader(sheet, CHANGE_HEADERS);
  for (const change of payload.changes) {
    const before = uniquePhotos(change.beforePhotos);
    const after = uniquePhotos(change.afterPhotos);
    const row = sheet.addRow([
      change.changedAt,
      change.stage,
      null,
      change.description,
      appendMissing(change.beforeText, missingNames(before, payload.images)),
      appendMissing(change.afterText, missingNames(after, payload.images)),
      change.reason,
      change.applicant,
      change.writer,
      change.afterVersion,
      null,
      change.progress,
      change.related,
    ]);
    row.getCell(3).value = filesValue(change.files, payload.origin, payload.project.id);
    row.getCell(11).value = filesValue(change.afterFiles, payload.origin, payload.project.id);
    styleBodyRow(sheet, row.number, CHANGE_HEADERS.length);
    const basePx = estimatedTextHeight(sheet, [
      plainText(row.getCell(3)),
      plainText(row.getCell(4)),
      plainText(row.getCell(5)),
      plainText(row.getCell(6)),
      plainText(row.getCell(7)),
      plainText(row.getCell(11)),
      plainText(row.getCell(13)),
    ], [3, 4, 5, 6, 7, 11, 13]);
    const beforeAvailable = availableRefs(before, payload.images).length;
    const afterAvailable = availableRefs(after, payload.images).length;
    const beforeLines = Math.ceil(beforeAvailable / imageCapacity(CHANGE_WIDTHS[5] ?? 30));
    const afterLines = Math.ceil(afterAvailable / imageCapacity(CHANGE_WIDTHS[6] ?? 30));
    const imageLines = Math.max(beforeLines, afterLines);
    const rowHeightPx = basePx + imageLines * (IMAGE_HEIGHT_PX + IMAGE_GAP_PX) + 4;
    row.height = rowHeightPx / PX_PER_POINT;
    placeImages(workbook, sheet, before, payload.images, 5, row.number, imageCapacity(CHANGE_WIDTHS[5] ?? 30), basePx, rowHeightPx);
    placeImages(workbook, sheet, after, payload.images, 6, row.number, imageCapacity(CHANGE_WIDTHS[6] ?? 30), basePx, rowHeightPx);
  }
  return sheet;
}

function addStakeholderSheet(workbook: ExcelJS.Workbook, payload: ProjectExportPayload, name: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  setWidths(sheet, STAKEHOLDER_WIDTHS, STAKEHOLDER_HEADERS.length);
  styleHeader(sheet, STAKEHOLDER_HEADERS);
  for (const item of payload.stakeholders) {
    const row = sheet.addRow([item.name, item.contact, item.email, item.position, item.company, item.writer, item.submittedAt]);
    styleBodyRow(sheet, row.number, STAKEHOLDER_HEADERS.length);
    const texts: string[] = [];
    for (let col = 1; col <= STAKEHOLDER_HEADERS.length; col += 1) texts.push(plainText(row.getCell(col)));
    row.height = estimatedTextHeight(sheet, texts, Array.from({ length: STAKEHOLDER_HEADERS.length }, (_value, index) => index + 1)) / PX_PER_POINT;
  }
  return sheet;
}

export async function buildProjectExportWorkbook(payload: ProjectExportPayload): Promise<ProjectExportWorkbookResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LibiaoLink";
  workbook.lastModifiedBy = "LibiaoLink";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.title = payload.project.code + " " + payload.project.name;
  const reportSheetName = "日报及问题汇总";
  const changeSheetName = "变更管理";
  const stakeholderSheetName = "干系人";
  const fixed = [reportSheetName, changeSheetName, stakeholderSheetName];
  let taskSheetName = sheetNameOf(payload.project.name);
  if (fixed.includes(taskSheetName)) taskSheetName = sheetNameOf(taskSheetName + " 项目");
  addTaskSheet(workbook, payload, taskSheetName);
  addReportSheet(workbook, payload, reportSheetName);
  addChangeSheet(workbook, payload, changeSheetName);
  addStakeholderSheet(workbook, payload, stakeholderSheetName);
  const bytes = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(bytes as unknown as Uint8Array);
  return { buffer, sheetNames: [taskSheetName, ...fixed] };
}
