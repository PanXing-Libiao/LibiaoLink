/**
 * 物料变更补发群图片：提交成功后随群通知发送整张补发/补货申请表。
 *
 * 1440px 宽、高度随物料行数动态增长；使用仓库内思源黑体与 Libiao 品牌标识，
 * 不依赖服务器系统字体。数据只来自 change_requests.material_reissue 快照。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Image as CanvasImage, SKRSContext2D } from "@napi-rs/canvas";
import {
  MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS,
  MATERIAL_REISSUE_FREIGHT_OPTIONS,
  MATERIAL_REISSUE_REASON_OPTIONS,
  MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS,
} from "@libiaolink/contracts";
import type { MaterialReissuePosterData } from "./material-reissue.poster.types.js";

const WIDTH = 1440;
const MARGIN = 72;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const LABEL_WIDTH = 252;
const CELL_PAD_X = 14;
const TABLE_HEADER_HEIGHT = 48;
const PAPER = "#FFFFFF";
const INK = "#111416";
const MUTED = "#596064";
const LINE = "#8C9498";
const LABEL_BG = "#F1F3F4";
const HEADER_BG = "#E8ECEE";
const ACCENT = "#F6C400";
const FONT_REGULAR = "LibiaoLink Material Reissue Sans";
const FONT_BOLD = "LibiaoLink Material Reissue Sans Bold";
const FONT_REGULAR_FILE = "SourceHanSansSC-Regular.otf";
const FONT_BOLD_FILE = "SourceHanSansSC-Bold.otf";
const LOGO_FILE = "r06-brand-logo.svg";

type NapiCanvas = typeof import("@napi-rs/canvas");
type Choice = { label: string; checked: boolean };
type MainRow = { label: string; value?: string; choices?: Choice[] };
type MainRowLayout = { row: MainRow; lines: string[]; choiceRows: Choice[][]; height: number };
type MaterialColumn = { key: string; label: string; width: number; align: "left" | "center" };

const MATERIAL_COLUMNS: MaterialColumn[] = [
  { key: "index", label: "序号", width: 72, align: "center" },
  { key: "materialCode", label: "物料编码", width: 190, align: "left" },
  { key: "materialName", label: "物料名称", width: 280, align: "left" },
  { key: "specification", label: "规格型号", width: 280, align: "left" },
  { key: "quantity", label: "数量", width: 100, align: "center" },
  { key: "unit", label: "单位", width: 86, align: "center" },
  { key: "remark", label: "备注", width: 288, align: "left" },
];

const NOTE_LINES = [
  "项目部或售后部负责填写补发信息，并判断是否免费、是否质保期内。",
  "商务助理和仓库根据本申请表执行发货，不负责判断是否免费、是否保内。",
  "不属于常规免费补发范围但需免费补发的，须先经夏总审批，并在“是否已审批”处勾选“是”。",
  "收货信息、出库时间、运费承担方式需填写完整后再提交。",
];

let canvasApiPromise: Promise<NapiCanvas> | null = null;
let fontsReady = false;
let logoPromise: Promise<CanvasImage> | null = null;

async function loadCanvasApi(): Promise<NapiCanvas> {
  canvasApiPromise ??= import("@napi-rs/canvas");
  return await canvasApiPromise;
}

function assetPath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cwd = typeof process === "undefined" ? "" : process.cwd();
  const candidates = [
    join(cwd, "assets", fileName),
    join(here, "..", "..", "..", "assets", fileName),
    join(cwd, "server", "assets", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("补发图片资产缺失：" + fileName);
  }
  return found;
}

function fontPath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cwd = typeof process === "undefined" ? "" : process.cwd();
  const candidates = [
    join(cwd, "assets", "fonts", fileName),
    join(here, "..", "..", "..", "assets", "fonts", fileName),
    join(cwd, "server", "assets", "fonts", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("补发图片字体缺失：" + fileName);
  }
  return found;
}

function ensureFonts(globalFonts: NapiCanvas["GlobalFonts"]): void {
  if (fontsReady) return;
  const regular = globalFonts.registerFromPath(fontPath(FONT_REGULAR_FILE), FONT_REGULAR);
  const bold = globalFonts.registerFromPath(fontPath(FONT_BOLD_FILE), FONT_BOLD);
  if (regular === null || bold === null) {
    throw new Error("补发图片字体注册失败");
  }
  fontsReady = true;
}

async function loadLogo(canvasApi: NapiCanvas): Promise<CanvasImage | null> {
  try {
    logoPromise ??= canvasApi.loadImage(assetPath(LOGO_FILE));
    return await logoPromise;
  } catch {
    return null;
  }
}

function setFont(ctx: SKRSContext2D, bold: boolean, size: number): void {
  ctx.font = String(size) + "px " + (bold ? FONT_BOLD : FONT_REGULAR);
}

function textWidth(ctx: SKRSContext2D, text: string): number {
  return ctx.measureText(text).width;
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = String(text ?? "").replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  const forbidden = "，。！？；：、）】》」』％%";
  for (const paragraph of paragraphs) {
    const clean = paragraph.replace(/\s+$/u, "");
    if (clean.length === 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    let line = "";
    for (const char of Array.from(clean)) {
      const candidate = line + char;
      if (line.length > 0 && textWidth(ctx, candidate) > maxWidth) {
        if (forbidden.includes(char)) {
          lines.push(candidate);
          line = "";
        } else {
          lines.push(line.replace(/\s+$/u, ""));
          line = char === " " ? "" : char;
        }
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) lines.push(line.replace(/\s+$/u, ""));
  }
  return lines.length > 0 ? lines : [""];
}

function formatDateTime(value: Date): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(value)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return (parts.year ?? "") + "/" + (parts.month ?? "") + "/" + (parts.day ?? "") + " " + (parts.hour ?? "") + ":" + (parts.minute ?? "");
}

function slashDate(value: string): string {
  return value.replace(/-/g, "/");
}

function optionChoices(
  options: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
  otherText?: string,
): Choice[] {
  return options.map((option) => {
    const checked = option.value === selected;
    const suffix = option.value === "other"
      ? "：" + (checked && otherText !== undefined && otherText !== "" ? otherText : "______")
      : "";
    return { label: option.label + suffix, checked };
  });
}

function boolChoices(value: boolean): Choice[] {
  return [
    { label: "是", checked: value },
    { label: "否", checked: !value },
  ];
}

function approvalChoices(value: "yes" | "no" | "not_applicable"): Choice[] {
  return [
    { label: "是", checked: value === "yes" },
    { label: "否", checked: value === "no" },
    { label: "不涉及", checked: value === "not_applicable" },
  ];
}

function mainRows(data: MaterialReissuePosterData): MainRow[] {
  const snapshot = data.snapshot;
  return [
    { label: "项目编号", value: snapshot.projectCode },
    { label: "项目名称", value: snapshot.projectName },
    { label: "客户名称", value: snapshot.customerName ?? "" },
    {
      label: "申请部门",
      choices: optionChoices(
        MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS,
        snapshot.applicationDepartment,
        snapshot.applicationDepartmentOther,
      ),
    },
    { label: "申请人", value: snapshot.applicantName },
    {
      label: "补发类别",
      choices: optionChoices(MATERIAL_REISSUE_REASON_OPTIONS, snapshot.reason, snapshot.reasonOther),
    },
    { label: "是否已验收", choices: boolChoices(snapshot.accepted) },
    { label: "是否质保期内", choices: boolChoices(snapshot.inWarranty) },
    { label: "是否免费补发", choices: boolChoices(snapshot.freeReissue) },
    { label: "是否已审批", choices: approvalChoices(snapshot.approved) },
    {
      label: "责任归属部门",
      choices: optionChoices(
        MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS,
        snapshot.responsibleDepartment,
        snapshot.responsibleDepartmentOther,
      ),
    },
    { label: "要求出库时间", value: slashDate(snapshot.requiredOutDate) },
    { label: "是否涉及旧件返还", choices: boolChoices(snapshot.oldPartReturn) },
    {
      label: "运费承担",
      choices: optionChoices(MATERIAL_REISSUE_FREIGHT_OPTIONS, snapshot.freightBearer),
    },
    { label: "收货人", value: snapshot.recipient },
    { label: "联系电话", value: snapshot.phone },
    { label: "收货地址", value: snapshot.address },
    { label: "补发原因简述", value: snapshot.description },
  ];
}

function choiceWidth(ctx: SKRSContext2D, choice: Choice): number {
  setFont(ctx, false, 20);
  return 18 + 8 + textWidth(ctx, choice.label) + 24;
}

function layoutChoices(ctx: SKRSContext2D, choices: Choice[], maxWidth: number): Choice[][] {
  const rows: Choice[][] = [];
  let row: Choice[] = [];
  let used = 0;
  for (const choice of choices) {
    const width = choiceWidth(ctx, choice);
    if (row.length > 0 && used + width > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(choice);
    used += width;
  }
  if (row.length > 0) rows.push(row);
  return rows.length > 0 ? rows : [[]];
}

function layoutMainRows(ctx: SKRSContext2D, rows: MainRow[]): MainRowLayout[] {
  const valueWidth = CONTENT_WIDTH - LABEL_WIDTH - CELL_PAD_X * 2;
  return rows.map((row) => {
    setFont(ctx, false, 20);
    const lines = row.value === undefined ? [""] : wrapText(ctx, row.value, valueWidth);
    const choiceRows = row.choices === undefined ? [] : layoutChoices(ctx, row.choices, valueWidth);
    const contentHeight = row.choices === undefined
      ? Math.max(30, lines.length * 30)
      : Math.max(34, choiceRows.length * 34);
    return { row, lines, choiceRows, height: Math.max(54, contentHeight + 20) };
  });
}

function drawLines(
  ctx: SKRSContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  align: "left" | "center" = "left",
): void {
  setFont(ctx, false, 20);
  ctx.fillStyle = INK;
  ctx.textAlign = align;
  const drawX = align === "center" ? x + (CONTENT_WIDTH - CELL_PAD_X * 2) / 2 : x;
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index] ?? "", drawX, y + index * lineHeight);
  }
  ctx.textAlign = "left";
}

function drawChoiceRow(
  ctx: SKRSContext2D,
  choices: Choice[],
  x: number,
  y: number,
): void {
  setFont(ctx, false, 20);
  let cursor = x;
  for (const choice of choices) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cursor + 1, y - 17, 17, 17);
    if (choice.checked) {
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.2;
      ctx.lineCap = "square";
      ctx.beginPath();
      ctx.moveTo(cursor + 5, y - 9);
      ctx.lineTo(cursor + 9, y - 5);
      ctx.lineTo(cursor + 16, y - 14);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = INK;
    ctx.fillText(choice.label, cursor + 27, y);
    cursor += choiceWidth(ctx, choice);
  }
}

function drawMainTable(ctx: SKRSContext2D, layouts: MainRowLayout[], y: number): number {
  const left = MARGIN;
  const top = y;
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(left, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.4;
  ctx.strokeRect(left, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT);
  ctx.beginPath();
  ctx.moveTo(left + LABEL_WIDTH, y);
  ctx.lineTo(left + LABEL_WIDTH, y + TABLE_HEADER_HEIGHT);
  ctx.stroke();
  setFont(ctx, true, 21);
  ctx.fillStyle = INK;
  ctx.fillText("项目", left + CELL_PAD_X, y + 31);
  ctx.fillText("填写内容", left + LABEL_WIDTH + CELL_PAD_X, y + 31);
  y += TABLE_HEADER_HEIGHT;

  for (const layout of layouts) {
    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(left, y, LABEL_WIDTH, layout.height);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(left, y, CONTENT_WIDTH, layout.height);
    ctx.beginPath();
    ctx.moveTo(left + LABEL_WIDTH, y);
    ctx.lineTo(left + LABEL_WIDTH, y + layout.height);
    ctx.stroke();
    setFont(ctx, false, 20);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(layout.row.label, left + CELL_PAD_X, y + 32);
    if (layout.row.choices !== undefined) {
      let choiceY = y + 30;
      for (const choiceRow of layout.choiceRows) {
        drawChoiceRow(ctx, choiceRow, left + LABEL_WIDTH + CELL_PAD_X, choiceY);
        choiceY += 34;
      }
    } else {
      drawLines(ctx, layout.lines, left + LABEL_WIDTH + CELL_PAD_X, y + 32, 30);
    }
    y += layout.height;
  }
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.8;
  ctx.strokeRect(left, top, CONTENT_WIDTH, y - top);
  return y;
}

function materialValues(snapshot: MaterialReissuePosterData["snapshot"]): string[][] {
  return snapshot.materials.map((item, index) => [
    String(index + 1),
    item.materialCode,
    item.materialName,
    item.specification,
    String(item.quantity),
    item.unit,
    item.remark,
  ]);
}

function materialRowLayout(
  ctx: SKRSContext2D,
  values: string[],
): { cells: string[][]; height: number } {
  setFont(ctx, false, 20);
  const cells = MATERIAL_COLUMNS.map((column, index) =>
    wrapText(ctx, values[index] ?? "", column.width - CELL_PAD_X * 2));
  const maxLines = Math.max(1, ...cells.map((lines) => lines.length));
  return { cells, height: Math.max(54, maxLines * 28 + 22) };
}

function drawMaterialSection(
  ctx: SKRSContext2D,
  data: MaterialReissuePosterData,
  y: number,
): number {
  setFont(ctx, true, 24);
  ctx.fillStyle = INK;
  ctx.fillText("补发物料清单", MARGIN, y + 24);
  y += 42;

  const left = MARGIN;
  const top = y;
  const headerHeight = 46;
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(left, y, CONTENT_WIDTH, headerHeight);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.4;
  ctx.strokeRect(left, y, CONTENT_WIDTH, headerHeight);
  let x = left;
  for (const column of MATERIAL_COLUMNS) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + headerHeight);
    ctx.stroke();
    setFont(ctx, true, 19);
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.fillText(column.label, x + column.width / 2, y + 30);
    x += column.width;
  }
  ctx.textAlign = "left";
  y += headerHeight;

  const rows = materialValues(data.snapshot);
  for (const values of rows) {
    const layout = materialRowLayout(ctx, values);
    let cellX = left;
    for (let index = 0; index < MATERIAL_COLUMNS.length; index += 1) {
      const column = MATERIAL_COLUMNS[index]!;
      const cell = layout.cells[index] ?? [""];
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(cellX, y, column.width, layout.height);
      setFont(ctx, false, 20);
      ctx.fillStyle = INK;
      ctx.textAlign = column.align;
      const textX = column.align === "center" ? cellX + column.width / 2 : cellX + CELL_PAD_X;
      for (let line = 0; line < cell.length; line += 1) {
        ctx.fillText(cell[line] ?? "", textX, y + 30 + line * 28);
      }
      cellX += column.width;
    }
    ctx.textAlign = "left";
    y += layout.height;
  }
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.8;
  ctx.strokeRect(left, top, CONTENT_WIDTH, y - top);
  return y;
}

function drawNotes(ctx: SKRSContext2D, y: number): number {
  const top = y;
  setFont(ctx, true, 22);
  ctx.fillStyle = INK;
  ctx.fillText("备注说明：", MARGIN, y + 24);
  y += 50;
  let noteNumber = 1;
  for (const note of NOTE_LINES) {
    setFont(ctx, false, 19);
    const lines = wrapText(ctx, note, CONTENT_WIDTH - 48);
    const number = String(noteNumber) + ". ";
    setFont(ctx, false, 19);
    ctx.fillStyle = MUTED;
    ctx.fillText(number, MARGIN, y);
    setFont(ctx, false, 19);
    ctx.fillStyle = MUTED;
    ctx.fillText(lines[0] ?? "", MARGIN + textWidth(ctx, number), y);
    for (let index = 1; index < lines.length; index += 1) {
      y += 28;
      ctx.fillText(lines[index] ?? "", MARGIN + 32, y);
    }
    y += 30;
    noteNumber += 1;
  }
  return Math.max(top + 50, y);
}

function drawHeader(
  ctx: SKRSContext2D,
  logo: CanvasImage | null,
  data: MaterialReissuePosterData,
  emailTitleLines: string[],
): number {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, 230);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, WIDTH, 8);
  if (logo !== null) {
    ctx.drawImage(logo, MARGIN, 26, 190, 67);
  } else {
    setFont(ctx, true, 28);
    ctx.fillStyle = INK;
    ctx.fillText("Libiao 立镖机器人", MARGIN, 72);
  }
  setFont(ctx, false, 19);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("浙江立镖机器人有限公司", WIDTH - MARGIN, 72);
  ctx.textAlign = "center";
  setFont(ctx, true, 34);
  ctx.fillStyle = INK;
  ctx.fillText("补发/补货申请表", WIDTH / 2, 142);
  ctx.textAlign = "left";
  const prefix = "邮件标题：";
  setFont(ctx, true, 20);
  ctx.fillStyle = INK;
  ctx.fillText(prefix, MARGIN, 186);
  const prefixWidth = textWidth(ctx, prefix);
  setFont(ctx, false, 20);
  for (let index = 0; index < emailTitleLines.length; index += 1) {
    ctx.fillText(emailTitleLines[index] ?? "", MARGIN + prefixWidth + 4, 186 + index * 30);
  }
  return 222 + Math.max(0, emailTitleLines.length - 1) * 30;
}

function drawFooter(ctx: SKRSContext2D, data: MaterialReissuePosterData, y: number, finalHeight: number): void {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(WIDTH - MARGIN, y);
  ctx.stroke();
  setFont(ctx, false, 16);
  ctx.fillStyle = MUTED;
  ctx.fillText("提交时间：" + formatDateTime(data.submittedAt), MARGIN, y + 30);
  ctx.textAlign = "right";
  ctx.fillText("LibiaoLink · 物料变更补发", WIDTH - MARGIN, y + 30);
  ctx.textAlign = "left";
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, finalHeight - 8, WIDTH, 8);
}

export async function renderMaterialReissuePoster(data: MaterialReissuePosterData): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts);
  const logo = await loadLogo(canvasApi);
  const measure = canvasApi.createCanvas(WIDTH, 1).getContext("2d");

  const emailTitle = data.snapshot.emailTitle?.trim() || "项目【补发申请】" + data.snapshot.projectCode + " " + data.snapshot.projectName + "项目/ 紧急";
  setFont(measure, true, 20);
  const emailPrefixWidth = textWidth(measure, "邮件标题：");
  setFont(measure, false, 20);
  const emailTitleLines = wrapText(measure, emailTitle, CONTENT_WIDTH - emailPrefixWidth - 4);
  const tableTop = 222 + Math.max(0, emailTitleLines.length - 1) * 30;

  const layouts = layoutMainRows(measure, mainRows(data));
  const mainTableHeight = TABLE_HEADER_HEIGHT + layouts.reduce((sum, item) => sum + item.height, 0);
  let cursor = tableTop + mainTableHeight + 34;
  const materialSectionTop = cursor;
  setFont(measure, true, 24);
  const materialHeadingHeight = 42;
  setFont(measure, false, 20);
  const materialRows = materialValues(data.snapshot);
  const materialTableHeight = 46 + materialRows.reduce((sum, row) => sum + materialRowLayout(measure, row).height, 0);
  cursor = materialSectionTop + materialHeadingHeight + materialTableHeight + 30;

  setFont(measure, false, 19);
  const noteHeight = 50 + NOTE_LINES.reduce((sum, note) => {
    const lines = wrapText(measure, note, CONTENT_WIDTH - 48);
    return sum + 30 + Math.max(0, lines.length - 1) * 28;
  }, 0);
  const footerTop = cursor + noteHeight + 20;
  const finalHeight = Math.ceil(footerTop + 64);

  const canvas = canvasApi.createCanvas(WIDTH, finalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, finalHeight);
  const bodyTop = drawHeader(ctx, logo, data, emailTitleLines);
  let y = drawMainTable(ctx, layouts, bodyTop);
  y += 34;
  y = drawMaterialSection(ctx, data, y);
  y += 30;
  y = drawNotes(ctx, y);
  drawFooter(ctx, data, footerTop, finalHeight);
  return canvas.toBuffer("image/png");
}
