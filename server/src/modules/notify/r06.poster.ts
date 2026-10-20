/**
 * R06 A 方案动态海报（姓名墙）。
 *
 * 900 x 1350 PNG，直接按项目真实数据绘制：项目经理 + 项目成员 + 任务负责人去重后的姓名墙、
 * 已完成任务按期率、项目编号 / 名称 / 计划交付日期。字体随服务端资产发布，不依赖容器系统字体。
 * 绘制失败由调用方回退静态喜报图，不影响已送达的群文字。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";

export interface R06PosterView {
  projectCode: string;
  projectName: string;
  status: string;
  managers: string[];
  participants: string[];
  taskTotal: number;
  taskDone: number;
  onTimeDone: number;
  startDate: string | null;
  plannedEnd: string | null;
  completedAt: Date;
}

export interface R06PosterFontPaths {
  sans?: string;
  sansBold?: string;
  serif?: string;
}

export interface R06PosterMetrics {
  elapsedDays: number;
  plannedDays: number;
  rate: number;
  rateText: string;
  rateLabel: string;
  allTasksDone: boolean;
}

const WIDTH = 900;
const HEIGHT = 1350;
const INK = "#191b17";
const ACCENT = "#9b4a39";
const PAPER = "#f6f0e3";
const BG = "#dbe6dc";
const FONT_SANS = "LibiaoLink Source Han Serif";
const FONT_SERIF = "LibiaoLink Source Han Serif Numerals";
const BUNDLED_SERIF = "SourceHanSerifSC-SemiBold.otf";
const BUNDLED_SERIF_BOLD = "SourceHanSerifSC-Bold.otf";
let fontsReady = false;
let customSansMode = false;
let customSerifMode = false;

function fontPath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "assets", "fonts", fileName),
    join(here, "..", "..", "..", "assets", "fonts", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("R06 poster font missing: " + fileName);
  }
  return found;
}

function ensureFonts(paths?: R06PosterFontPaths): void {
  if (fontsReady) {
    return;
  }
  const customSans = paths?.sans?.trim() ?? "";
  const customSansBold = paths?.sansBold?.trim() ?? "";
  const customSerif = paths?.serif?.trim() ?? "";
  // 默认字体 = 仓库内思源宋体（SIL OFL）；外部路径只做已授权字体覆盖，不改字号 / 缩放口径。
  customSansMode = true;
  customSerifMode = true;
  const sans = customSans === "" ? GlobalFonts.registerFromPath(fontPath(BUNDLED_SERIF), FONT_SANS) : GlobalFonts.registerFromPath(customSans, FONT_SANS);
  const sansBold = customSansBold === "" ? GlobalFonts.registerFromPath(fontPath(BUNDLED_SERIF_BOLD), FONT_SANS) : GlobalFonts.registerFromPath(customSansBold, FONT_SANS);
  const serif = customSerif === "" ? GlobalFonts.registerFromPath(fontPath(BUNDLED_SERIF), FONT_SERIF) : GlobalFonts.registerFromPath(customSerif, FONT_SERIF);
  if (sans === null || sansBold === null || serif === null) {
    throw new Error("R06 poster font registration failed");
  }
  fontsReady = true;
}

function shanghaiDate(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function dateOnly(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  return value.slice(0, 10);
}

function daysBetween(start: string | null, end: string | Date | null): number {
  const startDate = dateOnly(start);
  const endDate = end instanceof Date ? shanghaiDate(end) : dateOnly(end);
  if (startDate === null || endDate === null) {
    return 1;
  }
  const startMs = Date.parse(startDate + "T00:00:00Z");
  const endMs = Date.parse(endDate + "T00:00:00Z");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / 86_400_000));
}

function formatDot(value: Date): string {
  return shanghaiDate(value).replaceAll("-", ".");
}

function formatMonthDay(value: string | null): string {
  const date = dateOnly(value);
  return date === null ? "待定" : date.replaceAll("-", ".");
}

export function buildR06PosterMetrics(view: Pick<R06PosterView, "taskTotal" | "taskDone" | "onTimeDone" | "startDate" | "plannedEnd" | "completedAt">): R06PosterMetrics {
  const completedBase = view.taskTotal > 0 ? view.taskDone : 0;
  const allTasksDone = view.taskTotal > 0 && view.taskDone === view.taskTotal;
  const rate = completedBase > 0 ? Math.round((view.onTimeDone / completedBase) * 100) : 0;
  const rateLabel = completedBase === 0 ? "暂无任务" : allTasksDone ? "按时交付" : "已完成任务按期";
  const elapsedDays = daysBetween(view.startDate, view.completedAt);
  return {
    elapsedDays,
    plannedDays: view.plannedEnd === null ? elapsedDays : daysBetween(view.startDate, view.plannedEnd),
    rate,
    rateText: completedBase === 0 ? "—" : String(rate),
    rateLabel,
    allTasksDone,
  };
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return "rgba(" + String(r) + "," + String(g) + "," + String(b) + "," + String(alpha) + ")";
}

function setSans(ctx: SKRSContext2D, weight: number, size: number): void {
  ctx.font = String(weight) + " " + String(size) + "px " + FONT_SANS;
}

function setSerif(ctx: SKRSContext2D, weight: number, size: number): void {
  ctx.font = String(weight) + " " + String(size) + "px " + FONT_SERIF;
}

function spacedWidth(ctx: SKRSContext2D, text: string, spacing: number): number {
  let width = 0;
  for (const char of text) {
    width += ctx.measureText(char).width + spacing;
  }
  return Math.max(0, width - spacing);
}

function drawSpaced(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  align: "left" | "center" | "right" = "left",
): number {
  const width = spacedWidth(ctx, text, spacing);
  let cursor = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + spacing;
  }
  return width;
}

function drawSpacedBold(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  lineWidth: number,
  align: "left" | "center" | "right" = "left",
): number {
  const width = spacedWidth(ctx, text, spacing);
  let cursor = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = lineWidth;
    ctx.strokeText(char, cursor, y);
    cursor += ctx.measureText(char).width + spacing;
  }
  return width;
}

function fitFontSize(ctx: SKRSContext2D, weight: number, text: string, maxWidth: number, start: number, min: number): number {
  let size = start;
  while (size > min) {
    setSans(ctx, weight, size);
    if (ctx.measureText(text).width <= maxWidth) {
      break;
    }
    size -= 1;
  }
  return size;
}

function drawGrain(ctx: SKRSContext2D): void {
  const tile = createCanvas(5, 5);
  const tileCtx = tile.getContext("2d");
  tileCtx.fillStyle = "rgba(63,59,51,0.38)";
  tileCtx.fillRect(2, 2, 1, 1);
  const pattern = ctx.createPattern(tile, "repeat");
  if (pattern !== null) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(450, 610, 80, 450, 610, 540);
  glow.addColorStop(0, "rgba(255,255,255,0.30)");
  glow.addColorStop(0.45, "rgba(255,255,255,0.12)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const shade = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  shade.addColorStop(0, "rgba(255,255,255,0.11)");
  shade.addColorStop(0.55, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(80,70,45,0.055)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawNameWall(ctx: SKRSContext2D, names: string[]): void {
  const wallNames = names.length === 0 ? ["项目团队"] : names.slice(0, 24);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-76, 198, WIDTH + 152, 848);
  ctx.clip();
  ctx.translate(WIDTH / 2, 622);
  ctx.rotate((-7 * Math.PI) / 180);
  setSans(ctx, 800, 64);
  const lineHeight = 106;
  for (let row = 0; row < 8; row += 1) {
    const y = -390 + row * lineHeight;
    let x = -360 - (row % 3) * 110;
    let index = row * 2;
    for (let column = 0; column < 6; column += 1) {
      const name = wallNames[index % wallNames.length] ?? "项目团队";
      index += 1;
      const style = (row * 7 + column) % 4;
      if (style === 3) {
        ctx.strokeStyle = rgba(INK, 0.135);
        ctx.lineWidth = 1;
        ctx.strokeText(name, x, y);
      } else {
        ctx.fillStyle = style === 1 ? rgba(ACCENT, 0.15) : rgba(INK, 0.135);
        ctx.fillText(name, x, y);
      }
      x += ctx.measureText(name).width + 28;
    }
  }
  ctx.restore();
  const fade = ctx.createRadialGradient(WIDTH / 2, 634, 80, WIDTH / 2, 634, 525);
  fade.addColorStop(0, "rgba(219,230,220,1)");
  fade.addColorStop(0.17, "rgba(219,230,220,1)");
  fade.addColorStop(0.58, "rgba(219,230,220,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawHeader(ctx: SKRSContext2D, status: string): void {
  setSans(ctx, 400, 10);
  ctx.fillStyle = rgba(INK, 0.52);
  ctx.fillRect(56, 50, 26, 1);
  const label = status === "done" ? "PROJECT COMPLETE · 项目喜报" : "PROJECT IN PROGRESS · 项目进行中";
  drawSpaced(ctx, label, 93, 54, 2.4);
  const brand = "LIBIAOLINK";
  const suffix = "R06";
  const brandWidth = spacedWidth(ctx, brand, 2.4);
  const suffixWidth = spacedWidth(ctx, suffix, 2.4);
  const start = WIDTH - 56 - brandWidth - 18 - suffixWidth;
  ctx.save();
  ctx.translate(start + 4, 49);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(-4, -4, 8, 8);
  ctx.restore();
  setSans(ctx, 700, 10);
  ctx.fillStyle = INK;
  drawSpaced(ctx, brand, start + 18, 54, 2.4);
  setSans(ctx, 500, 10);
  ctx.fillStyle = rgba(INK, 0.46);
  drawSpaced(ctx, suffix, start + 18 + brandWidth + 18, 54, 2.4);
}

function drawCopy(ctx: SKRSContext2D, metrics: R06PosterMetrics): void {
  setSans(ctx, 400, 9);
  ctx.fillStyle = rgba(INK, 0.5);
  drawSpaced(ctx, metrics.allTasksDone ? "THE WORK IS DONE · THE DETAILS REMAIN" : "IN PROGRESS · EVERY NAME MATTERS", 57, 168, 3);
  setSans(ctx, customSansMode ? 600 : 900, 72);
  ctx.fillStyle = INK;
  const headlineTracking = customSansMode ? -3.8 : -3.2;
  const headlineStroke = customSansMode ? 0 : 1.35;
  drawSpacedBold(ctx, "把复杂的事，", 57, 251, headlineTracking, headlineStroke);
  const leadWidth = drawSpacedBold(ctx, "做得", 57, 339, headlineTracking, headlineStroke);
  ctx.fillStyle = ACCENT;
  const accentWidth = drawSpacedBold(ctx, "刚刚好", 57 + leadWidth, 339, headlineTracking, headlineStroke);
  ctx.fillStyle = INK;
  ctx.fillText("。", 57 + leadWidth + accentWidth - 1, 339);
  ctx.strokeStyle = INK;
  ctx.lineWidth = headlineStroke;
  ctx.strokeText("。", 57 + leadWidth + accentWidth - 1, 339);
  setSans(ctx, 400, customSansMode ? 16 : 17);
  ctx.fillStyle = rgba(INK, 0.62);
  ctx.fillText(metrics.allTasksDone ? "复杂的事情，被一件一件认真做完。" : "复杂的事情，正在被一件一件认真做完。", 57, 391);
}

function drawMeter(ctx: SKRSContext2D, view: R06PosterView, metrics: R06PosterMetrics): void {
  const cx = 450;
  const cy = 634;
  ctx.save();
  ctx.shadowColor = "rgba(72,57,32,0.38)";
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 36;
  ctx.beginPath();
  ctx.arc(cx, cy, 213, 0, Math.PI * 2);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 211, 0, Math.PI * 2);
  ctx.setLineDash([1, 8]);
  ctx.strokeStyle = rgba(INK, 0.34);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  const sweep = (Math.PI * 2 * Math.max(0, Math.min(100, metrics.rate))) / 100;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 189, -Math.PI / 2, -Math.PI / 2 + sweep);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();

  if (customSerifMode) {
    setSerif(ctx, 400, 151);
    ctx.fillStyle = INK;
    const rateTracking = -7;
    const digitsWidth = spacedWidth(ctx, metrics.rateText, rateTracking);
    setSans(ctx, 500, 30);
    const percentWidth = ctx.measureText("%").width;
    const gap = 0;
    const startX = cx - (digitsWidth + gap + percentWidth) / 2 + 10;
    setSerif(ctx, 400, 151);
    ctx.fillStyle = INK;
    drawSpaced(ctx, metrics.rateText, startX, 657, rateTracking);
    if (metrics.rateText !== "—") {
      setSans(ctx, 500, 30);
      ctx.fillText("%", startX + digitsWidth + gap, 585);
    }
  } else {
    setSerif(ctx, 400, 140);
    ctx.fillStyle = INK;
    const digitsWidth = ctx.measureText(metrics.rateText).width;
    setSans(ctx, 500, 32);
    const percentWidth = ctx.measureText("%").width;
    const gap = 0;
    const rateScale = 0.86;
    const scaledDigits = digitsWidth * rateScale;
    const startX = cx - (scaledDigits + gap + percentWidth) / 2 + 10;
    setSerif(ctx, 400, 140);
    ctx.fillStyle = INK;
    ctx.save();
    ctx.translate(startX, 660);
    ctx.scale(rateScale, 1);
    ctx.fillText(metrics.rateText, 0, 0);
    ctx.restore();
    if (metrics.rateText !== "—") {
      setSans(ctx, 500, 32);
      ctx.fillText("%", startX + scaledDigits + gap, 592);
    }
  }

  setSans(ctx, 400, 9);
  ctx.fillStyle = rgba(INK, 0.43);
  drawSpaced(ctx, metrics.allTasksDone ? "ON-TIME DELIVERY" : "ON-TIME · COMPLETED TASKS", cx, 690, 3.6, "center");
  setSans(ctx, 700, 14);
  ctx.fillStyle = ACCENT;
  drawSpaced(ctx, metrics.rateLabel, cx, 720, 3, "center");

  const badgeX = 647;
  const badgeY = 498;
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, 57, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(ACCENT, 0.46);
  ctx.lineWidth = 1;
  ctx.stroke();
  setSans(ctx, 700, 15);
  ctx.fillStyle = ACCENT;
  ctx.textAlign = "center";
  ctx.fillText(String(Math.max(0, view.participants.length)), badgeX, badgeY + 2);
  ctx.textAlign = "left";
  setSans(ctx, 600, 8);
  drawSpaced(ctx, "TEAM", badgeX, badgeY + 16, 1.4, "center");
  drawSpaced(ctx, "MEMBERS", badgeX, badgeY + 27, 1.4, "center");
}

function drawSide(ctx: SKRSContext2D): void {
  ctx.save();
  ctx.translate(858, 382);
  ctx.rotate(Math.PI / 2);
  setSans(ctx, 400, 8);
  ctx.fillStyle = rgba(INK, 0.36);
  drawSpaced(ctx, "EVERY NAME · EVERY STEP · LIBIAOLINK R06", 0, 0, 1.6);
  ctx.restore();
}

interface SummarySegment {
  text: string;
  accent?: boolean;
  bold?: boolean;
}

function summarySegments(view: R06PosterView, metrics: R06PosterMetrics): SummarySegment[] {
  if (view.taskTotal === 0) {
    return [{ text: "项目已完成，暂无任务记录。" }];
  }
  if (view.status === "done" && view.taskDone === view.taskTotal) {
    return [
      { text: "历时 " },
      { text: String(metrics.elapsedDays), accent: true, bold: true },
      { text: " 天，" },
      { text: String(view.taskTotal), accent: true, bold: true },
      { text: " 项任务全部完成，项目已通过验收并正式交付。" },
    ];
  }
  if (view.status === "done") {
    return [
      { text: "历时 " },
      { text: String(metrics.elapsedDays), accent: true, bold: true },
      { text: " 天，" },
      { text: String(view.taskTotal), accent: true, bold: true },
      { text: " 项任务已完成 " },
      { text: String(view.taskDone), accent: true, bold: true },
      { text: " 项，项目已标记完成。" },
    ];
  }
  return [
    { text: "计划周期 " },
    { text: String(metrics.plannedDays), accent: true, bold: true },
    { text: " 天，" },
    { text: String(view.taskTotal), accent: true, bold: true },
    { text: " 项任务已完成 " },
    { text: String(view.taskDone), accent: true, bold: true },
    { text: " 项，项目正在推进。" },
  ];
}

function drawSegments(ctx: SKRSContext2D, segments: SummarySegment[], x: number, y: number): void {
  let cursor = x;
  for (const segment of segments) {
    setSans(ctx, segment.bold === true ? (customSansMode ? 600 : 800) : 400, customSansMode ? 15 : 16);
    ctx.fillStyle = segment.accent === true ? ACCENT : rgba(INK, customSansMode ? 0.58 : 0.66);
    ctx.fillText(segment.text, cursor, y);
    cursor += ctx.measureText(segment.text).width;
  }
}

function drawDetail(ctx: SKRSContext2D, view: R06PosterView, metrics: R06PosterMetrics): void {
  setSans(ctx, customSansMode ? 400 : 500, customSansMode ? 9 : 10);
  ctx.fillStyle = rgba(INK, customSansMode ? 0.48 : 0.55);
  drawSpaced(ctx, "PROJECT / " + view.projectCode, 57, 970, 2.4);

  const nameSize = fitFontSize(ctx, customSansMode ? 600 : 900, view.projectName, 770, 38, 26);
  setSans(ctx, customSansMode ? 600 : 900, nameSize);
  ctx.fillStyle = INK;
  if (customSansMode) {
    drawSpaced(ctx, view.projectName, 57, 1017, -1);
  } else {
    ctx.save();
    ctx.translate(57, 1017);
    ctx.scale(1.22, 1);
    drawSpacedBold(ctx, view.projectName, 0, 0, -0.8, 1.3);
    ctx.restore();
  }

  drawSegments(ctx, summarySegments(view, metrics), customSansMode ? 57 : 49, 1056);

  ctx.fillStyle = rgba(INK, 0.24);
  ctx.fillRect(57, 1089, 786, 1);
  ctx.fillStyle = rgba(INK, 0.16);
  ctx.fillRect(57, 1169, 786, 1);
  ctx.fillStyle = rgba(INK, 0.17);
  ctx.fillRect(343, 1100, 1, 60);
  ctx.fillRect(593, 1100, 1, 60);

  const factX = [57, 365, 615];
  const labels = ["项目经理", "参与成员", "交付日期"];
  const completed = view.status === "done";
  if (!completed) {
    labels[2] = "计划交付";
  }
  for (let index = 0; index < labels.length; index += 1) {
    setSans(ctx, 600, customSansMode ? 11 : 10);
    ctx.fillStyle = rgba(INK, customSansMode ? 0.72 : 0.66);
    drawSpaced(ctx, labels[index] ?? "", factX[index] ?? 57, 1112, 2);
  }

  const managerText = view.managers.length === 0 ? "待定" : view.managers.join("、");
  const managerSize = fitFontSize(ctx, 700, managerText, 270, 21, 13);
  setSans(ctx, customSansMode ? 600 : 900, customSansMode ? 20 : managerSize);
  ctx.fillStyle = INK;
  ctx.fillText(managerText, 57, 1146);
  ctx.strokeStyle = INK;
  ctx.lineWidth = customSansMode ? 0 : 0.7;
  ctx.strokeText(managerText, 57, 1146);

  setSans(ctx, customSansMode ? 600 : 900, customSansMode ? 20 : 21);
  ctx.fillStyle = INK;
  if (customSansMode) {
    ctx.save();
    ctx.translate(365, 1146);
    ctx.scale(0.85, 1);
    ctx.fillText(String(view.participants.length), 0, 0);
    ctx.restore();
  } else {
    ctx.fillText(String(view.participants.length), 365, 1146);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.6;
    ctx.strokeText(String(view.participants.length), 365, 1146);
  }
  const countWidth = ctx.measureText(String(view.participants.length)).width;
  setSans(ctx, 400, 11);
  ctx.fillStyle = ACCENT;
  ctx.fillText("人", 365 + countWidth + 5, 1146);

  setSans(ctx, customSansMode ? 700 : 900, customSansMode ? 20 : 21);
  ctx.fillStyle = INK;
  const dateText = completed ? formatDot(view.completedAt) : formatMonthDay(view.plannedEnd);
  if (customSansMode && /^[\d.]+$/.test(dateText)) {
    ctx.save();
    ctx.translate(615, 1146);
    ctx.scale(0.85, 1);
    ctx.fillText(dateText, 0, 0);
    ctx.restore();
  } else {
    ctx.fillText(dateText, 615, 1146);
    ctx.strokeStyle = INK;
    ctx.lineWidth = customSansMode ? 0 : 0.6;
    ctx.strokeText(dateText, 615, 1146);
  }

  setSans(ctx, 700, 8);
  ctx.fillStyle = rgba(INK, 0.74);
  ctx.fillText("LibiaoLink", 57, 1315);
  const logoWidth = ctx.measureText("LibiaoLink").width;
  setSans(ctx, 400, 8);
  ctx.fillStyle = rgba(INK, 0.6);
  ctx.fillText(" · 数据截至 " + formatDot(view.completedAt), 57 + logoWidth, 1315);

  setSerif(ctx, 400, 21);
  ctx.fillStyle = rgba(INK, 0.42);
  ctx.textAlign = "right";
  ctx.fillText("No. 06", WIDTH - 57, 1315);
  ctx.textAlign = "left";
}

export function renderR06Poster(view: R06PosterView, fonts?: R06PosterFontPaths): Buffer {
  ensureFonts(fonts);
  const metrics = buildR06PosterMetrics(view);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);
  drawNameWall(ctx, view.participants.length > 0 ? view.participants : view.managers);
  drawGrain(ctx);
  drawHeader(ctx, view.status);
  drawCopy(ctx, metrics);
  drawMeter(ctx, view, metrics);
  drawSide(ctx);
  drawDetail(ctx, view, metrics);
  return canvas.toBuffer("image/png");
}
