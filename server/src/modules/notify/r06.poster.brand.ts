/**
 * R06 黄黑品牌交付海报（全部任务按时交付专用）。
 *
 * 900 x 1350 PNG。与 A 方案共用仓库内思源宋体字体资产与覆盖口径；
 * 仅由 r06.poster.ts 在项目已完成、taskTotal > 0 且 taskDone / onTimeDone 均等于 taskTotal 时调用。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Image as CanvasImage, SKRSContext2D } from "@napi-rs/canvas";
import type { R06PosterFontPaths, R06PosterMetrics, R06PosterView } from "./r06.poster.types.js";

const WIDTH = 900;
const HEIGHT = 1350;
const YELLOW = "#f4cd11";
const BLACK = "#101010";
const MUTED = "#777777";
const PAPER = "#ffffff";
const FONT_SANS = "LibiaoLink R06 Brand Sans";
const FONT_SERIF = "LibiaoLink R06 Brand Numerals";
const BUNDLED_SERIF = "SourceHanSerifSC-SemiBold.otf";
const BUNDLED_SERIF_BOLD = "SourceHanSerifSC-Bold.otf";
const BRAND_LOGO = "r06-brand-logo.svg";
const BRAND_BANNER = "r06-brand-banner.jpg";

type NapiCanvas = typeof import("@napi-rs/canvas");
let canvasApiPromise: Promise<NapiCanvas> | null = null;
let brandAssetsPromise: Promise<{ logo: CanvasImage; banner: CanvasImage }> | null = null;
let fontsReady = false;

async function loadCanvasApi(): Promise<NapiCanvas> {
  canvasApiPromise ??= import("@napi-rs/canvas");
  return await canvasApiPromise;
}

function assetPath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "assets", fileName),
    join(here, "..", "..", "..", "assets", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("R06 brand poster asset missing: " + fileName);
  }
  return found;
}

function loadBrandAssets(canvasApi: NapiCanvas): Promise<{ logo: CanvasImage; banner: CanvasImage }> {
  brandAssetsPromise ??= Promise.all([canvasApi.loadImage(assetPath(BRAND_LOGO)), canvasApi.loadImage(assetPath(BRAND_BANNER))]).then(
    ([logo, banner]) => ({ logo, banner }),
  );
  return brandAssetsPromise;
}

function ensureFonts(globalFonts: NapiCanvas["GlobalFonts"], paths?: R06PosterFontPaths): void {
  if (fontsReady) {
    return;
  }
  const customSans = paths?.sans?.trim() ?? "";
  const customSansBold = paths?.sansBold?.trim() ?? "";
  const customSerif = paths?.serif?.trim() ?? "";
  const sans = globalFonts.registerFromPath(customSans === "" ? assetPath("fonts/" + BUNDLED_SERIF) : customSans, FONT_SANS);
  const sansBold = globalFonts.registerFromPath(customSansBold === "" ? assetPath("fonts/" + BUNDLED_SERIF_BOLD) : customSansBold, FONT_SANS);
  const serif = globalFonts.registerFromPath(customSerif === "" ? assetPath("fonts/" + BUNDLED_SERIF) : customSerif, FONT_SERIF);
  if (sans === null || sansBold === null || serif === null) {
    throw new Error("R06 brand poster font registration failed");
  }
  fontsReady = true;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return "rgba(" + String(red) + "," + String(green) + "," + String(blue) + "," + String(alpha) + ")";
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

function fitSansSize(ctx: SKRSContext2D, text: string, maxWidth: number, start: number, min: number, weight = 600): number {
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

function shanghaiDate(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function formatDot(value: Date): string {
  return shanghaiDate(value).replaceAll("-", ".");
}

function dateOnly(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  return value.slice(0, 10);
}

function formatDate(value: string | null): string {
  const date = dateOnly(value);
  return date === null ? "待定" : date.replaceAll("-", ".");
}


function pad2(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

function projectNameParts(name: string): [string, string] {
  const chars = Array.from(name);
  if (/[\u4e00-\u9fff]/.test(name)) {
    const suffixLength = name.endsWith("项目") ? Math.min(4, chars.length) : Math.min(2, chars.length);
    return [chars.slice(0, -suffixLength).join(""), chars.slice(-suffixLength).join("")];
  }
  const separator = name.lastIndexOf("-");
  if (separator > 0) {
    return [name.slice(0, separator + 1), name.slice(separator + 1)];
  }
  return ["", name];
}

function drawImageCover(ctx: SKRSContext2D, image: CanvasImage, x: number, y: number, width: number, height: number): void {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y - (drawHeight - height) * 0.58;
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(250, 45, 20, 250, 45, 620);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.38, "rgba(255,255,255,0.92)");
  glow.addColorStop(1, "rgba(244,205,17,0.025)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, 430);
  const shade = ctx.createLinearGradient(0, 0, WIDTH, 430);
  shade.addColorStop(0, "rgba(244,205,17,0.018)");
  shade.addColorStop(0.55, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.02)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, WIDTH, 430);
}

function drawHeader(ctx: SKRSContext2D, logo: CanvasImage, status: string): void {
  const logoWidth = 173;
  const logoHeight = logoWidth * (logo.height / logo.width);
  ctx.drawImage(logo, 53, 31, logoWidth, logoHeight);

  const isDone = status === "done";
  setSans(ctx, 700, 9);
  ctx.fillStyle = rgba(BLACK, 0.92);
  drawSpaced(ctx, isDone ? "PROJECT COMPLETE" : "PROJECT IN PROGRESS", 847, 42, 2.6, "right");
  setSans(ctx, 500, 11);
  ctx.fillStyle = rgba(BLACK, 0.62);
  drawSpaced(ctx, isDone ? "项目交付喜报" : "项目进行中", 847, 57, 2.5, "right");

  ctx.fillStyle = "#d9d9d7";
  ctx.fillRect(53, 110, 794, 1);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, 107, 77, 6);
}

function drawOutcome(ctx: SKRSContext2D, view: R06PosterView, metrics: R06PosterMetrics): void {
  const isDone = view.status === "done";
  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, 138, 7, 7);
  setSans(ctx, 700, 9);
  ctx.fillStyle = rgba(BLACK, 0.78);
  drawSpaced(ctx, isDone ? "Project Outcome" : "Progress Snapshot", 71, 146, 2.4);
  ctx.fillStyle = rgba(BLACK, 0.42);
  drawSpaced(ctx, "/", 201, 146, 2.4);
  setSans(ctx, 500, 9);
  ctx.fillStyle = rgba(BLACK, 0.52);
  drawSpaced(ctx, isDone ? "项目成果" : "进展概览", 217, 146, 2.4);

  setSans(ctx, 500, 26);
  ctx.fillStyle = "#727272";
  drawSpaced(ctx, "这一次，我们", 53, 183, 5.7);

  const headlineSize = 145;
  const tracking = -10;
  const lead = isDone ? "如期" : "稳步";
  const accent = isDone ? "交付" : "推进";
  setSans(ctx, 900, headlineSize);
  ctx.fillStyle = BLACK;
  const leadWidth = drawSpaced(ctx, lead, 53, 323, tracking);
  const accentWidth = spacedWidth(ctx, accent, tracking);
  const accentX = 53 + leadWidth + 9;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(accentX - 6, 189, accentWidth + 20, 149);
  ctx.fillStyle = BLACK;
  drawSpaced(ctx, accent, accentX + 6, 323, tracking);

  const duration = isDone ? metrics.elapsedDays : metrics.plannedDays;
  const done = Math.min(view.taskTotal, view.taskDone);
  const delayDays = 0;
  const stats: Array<{ value: string; unit: string; label: string }> = [
    { value: String(duration), unit: "天", label: isDone ? "PROJECT DURATION" : "SCHEDULED DURATION" },
    { value: String(done) + "/" + String(view.taskTotal), unit: "", label: "TASKS DONE / TOTAL" },
    { value: String(delayDays), unit: "天", label: "DELAY" },
  ];
  const statX = [53, 173, 310];
  for (let index = 0; index < stats.length; index += 1) {
    const stat = stats[index];
    if (stat === undefined) {
      continue;
    }
    const x = statX[index] ?? 53;
    setSans(ctx, 700, 25);
    ctx.fillStyle = BLACK;
    const valueWidth = ctx.measureText(stat.value).width;
    ctx.fillText(stat.value, x, 365);
    if (stat.unit !== "") {
      setSans(ctx, 500, 14);
      ctx.fillStyle = MUTED;
      ctx.fillText(stat.unit, x + valueWidth + 2, 365);
    }
    setSans(ctx, 600, 7);
    ctx.fillStyle = rgba(BLACK, 0.48);
    drawSpaced(ctx, stat.label, x, 383, 1.5);
  }
  ctx.fillStyle = "#d6d6d2";
  ctx.fillRect(158, 343, 1, 42);
  ctx.fillRect(294, 343, 1, 42);

  setSans(ctx, 500, 13);
  ctx.fillStyle = rgba(BLACK, 0.53);
  ctx.textAlign = "right";
  ctx.fillText("复杂的事情，", 847, 357);
  ctx.fillText(isDone ? "被一件一件认真做完。" : "正在被一件一件认真做完。", 847, 376);
  ctx.textAlign = "left";
}

function drawPhoto(ctx: SKRSContext2D, view: R06PosterView, metrics: R06PosterMetrics, banner: CanvasImage): void {
  const top = 426;
  const height = 391;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, WIDTH, height);
  ctx.clip();
  drawImageCover(ctx, banner, 0, top, WIDTH, height);

  const shade = ctx.createLinearGradient(0, top, WIDTH, top);
  shade.addColorStop(0, "rgba(0,0,0,0.89)");
  shade.addColorStop(0.33, "rgba(0,0,0,0.73)");
  shade.addColorStop(0.61, "rgba(0,0,0,0.35)");
  shade.addColorStop(1, "rgba(0,0,0,0.03)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, top, WIDTH, height);

  const topShade = ctx.createLinearGradient(0, top, 0, top + 90);
  topShade.addColorStop(0, "rgba(0,0,0,0.5)");
  topShade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topShade;
  ctx.fillRect(0, top, WIDTH, 90);

  const bottomShade = ctx.createLinearGradient(0, top + height - 120, 0, top + height);
  bottomShade.addColorStop(0, "rgba(0,0,0,0)");
  bottomShade.addColorStop(1, "rgba(0,0,0,0.33)");
  ctx.fillStyle = bottomShade;
  ctx.fillRect(0, top + height - 120, WIDTH, 120);

  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, top, 7, height);

  setSans(ctx, 700, 8.5);
  ctx.fillStyle = "rgba(255,255,255,0.74)";
  drawSpaced(ctx, "SMART SORTING SYSTEM / 智能分拣系统", 82, 480, 2.3);

  const statusText = view.status === "done" ? "ACCEPTANCE PASSED" : "EXECUTION ACTIVE";
  setSans(ctx, 700, 8);
  const statusWidth = spacedWidth(ctx, statusText, 2.2) + 38;
  const statusX = WIDTH - 53 - statusWidth;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(statusX, 463, statusWidth, 27);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(statusX + 12, 472, 7, 7);
  ctx.fillStyle = "#ffffff";
  drawSpaced(ctx, statusText, statusX + 28, 481, 2.2);

  setSans(ctx, 700, 10);
  ctx.fillStyle = YELLOW;
  drawSpaced(ctx, metrics.allTasksDone ? "ON-TIME DELIVERY" : "ON-TIME COMPLETION", 82, 507, 3.2);

  const rateText = metrics.rateText;
  const rateSize = rateText === "—" ? 140 : 180;
  setSerif(ctx, 700, rateSize);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(rateText, 82, 660);
  const rateWidth = ctx.measureText(rateText).width;
  if (rateText !== "—") {
    setSans(ctx, 500, 55);
    ctx.fillStyle = YELLOW;
    ctx.fillText("%", 82 + rateWidth - 10, 616);
  }

  setSans(ctx, 700, 22);
  ctx.fillStyle = "#ffffff";
  const rateLabel = metrics.allTasksDone ? "按时交付" : metrics.rateLabel;
  const labelWidth = drawSpaced(ctx, rateLabel, 82, 696, 6.3);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(96 + labelWidth, 687, 98, 2);

  const gridX = 710;
  const gridY = 510;
  const gridSize = 137;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(gridX, gridY, gridSize, gridSize);
  ctx.beginPath();
  ctx.moveTo(gridX, gridY + 46);
  ctx.lineTo(gridX + gridSize, gridY + 46);
  ctx.moveTo(gridX + 77, gridY);
  ctx.lineTo(gridX + 77, gridY + gridSize);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.stroke();
  setSans(ctx, 500, 7);
  ctx.fillStyle = "rgba(255,255,255,0.84)";
  drawSpaced(ctx, "AUTOMATION / LIVE", gridX + gridSize - 7, gridY + gridSize - 7, 1.4, "right");
  ctx.restore();
}

function drawProject(ctx: SKRSContext2D, view: R06PosterView, metrics: R06PosterMetrics): void {
  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, 844, 20, 20);
  setSans(ctx, 700, 8);
  ctx.fillStyle = BLACK;
  ctx.textAlign = "center";
  ctx.fillText("02", 63, 858);
  ctx.textAlign = "left";
  ctx.fillStyle = "#b9b9b5";
  ctx.fillRect(84, 854, 25, 1);
  setSans(ctx, 700, 8);
  ctx.fillStyle = rgba(BLACK, 0.56);
  drawSpaced(ctx, "PROJECT FILE / 项目档案", 118, 858, 2);

  const fileId = "FILE ID / " + view.projectCode;
  const fileSize = fitSansSize(ctx, fileId, 260, 8, 6, 500);
  setSans(ctx, 500, fileSize);
  ctx.fillStyle = "rgba(160,160,157,0.9)";
  drawSpaced(ctx, fileId, 847, 858, 1.5, "right");

  const [prefix, suffix] = projectNameParts(view.projectName);
  const nameSize = fitSansSize(ctx, view.projectName, 794, 43, 26, 800);
  setSans(ctx, 800, nameSize);
  const prefixWidth = ctx.measureText(prefix).width;
  const suffixWidth = ctx.measureText(suffix).width;
  const nameStart = 53;
  const baseline = 910;
  setSans(ctx, 800, nameSize);
  ctx.fillStyle = BLACK;
  ctx.fillText(prefix, nameStart, baseline);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(nameStart + prefixWidth, baseline - 10, suffixWidth, 14);
  ctx.fillStyle = BLACK;
  ctx.fillText(suffix, nameStart + prefixWidth, baseline);

  const top = 960;
  const bottom = 1048;
  ctx.fillStyle = "#d3d3cf";
  ctx.fillRect(53, top, 794, 1);
  ctx.fillRect(53, bottom, 794, 1);
  ctx.fillRect(325, top + 1, 1, bottom - top - 1);
  ctx.fillRect(530, top + 1, 1, bottom - top - 1);

  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, top, 48, 3);
  ctx.fillRect(351, top, 30, 3);
  ctx.fillRect(556, top, 30, 3);

  const labels = ["PROJECT MANAGER / 项目经理", "TEAM / 参与成员", view.status === "done" ? "DELIVERY DATE / 交付日期" : "PLANNED DELIVERY / 计划交付"];
  const labelX = [53, 351, 556];
  for (let index = 0; index < labels.length; index += 1) {
    setSans(ctx, 600, 7);
    ctx.fillStyle = rgba(BLACK, 0.46);
    drawSpaced(ctx, labels[index] ?? "", labelX[index] ?? 53, 986, 1.45);
  }

  const managerText = view.managers.length === 0 ? "待定" : view.managers.join("、");
  const managerSize = fitSansSize(ctx, managerText, 238, 25, 14, 700);
  setSans(ctx, 700, managerSize);
  ctx.fillStyle = BLACK;
  ctx.fillText(managerText, 53, 1018);

  setSans(ctx, 700, 27);
  ctx.fillStyle = BLACK;
  const teamText = pad2(view.participants.length);
  ctx.fillText(teamText, 351, 1018);
  const teamWidth = ctx.measureText(teamText).width;
  setSans(ctx, 500, 13);
  ctx.fillStyle = MUTED;
  ctx.fillText("人", 351 + teamWidth + 5, 1018);

  const dateText = view.status === "done" ? formatDot(view.completedAt) : formatDate(view.plannedEnd);
  const dateSize = fitSansSize(ctx, dateText, 286, 27, 17, 700);
  setSans(ctx, 700, dateSize);
  ctx.fillStyle = BLACK;
  ctx.fillText(dateText, 556, 1018);

  setSans(ctx, 500, 6.5);
  ctx.fillStyle = "rgba(160,160,156,0.92)";
  drawSpaced(ctx, "DELIVERY OWNER", 53, 1037, 1.35);
  drawSpaced(ctx, "CROSS-FUNCTIONAL TEAM", 351, 1037, 1.35);
  drawSpaced(ctx, view.status === "done" ? "FINAL HANDOVER" : "PLANNED / ON TRACK", 556, 1037, 1.35);

  setSans(ctx, 700, 7.5);
  ctx.fillStyle = "rgba(138,138,135,0.92)";
  drawSpaced(ctx, "EXECUTION TRACE / 项目执行轨迹", 53, 1094, 1.9);
  const completion = view.status === "done" && metrics.allTasksDone ? 100 : view.taskTotal > 0 ? Math.round((view.taskDone / view.taskTotal) * 100) : 0;
  setSans(ctx, 700, 9);
  ctx.fillStyle = BLACK;
  drawSpaced(ctx, String(completion) + "% COMPLETE", 847, 1094, 1.2, "right");

  const lineY = 1115;
  ctx.fillStyle = "#c8c8c4";
  ctx.fillRect(53, lineY, 794, 1);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(53, lineY, (794 * completion) / 100, 2);

  const nodes = [53, 300, 547, 847];
  for (let index = 0; index < nodes.length; index += 1) {
    const x = nodes[index] ?? 53;
    const isFinal = index === nodes.length - 1;
    ctx.fillStyle = isFinal && metrics.allTasksDone ? YELLOW : "#f7f7f5";
    ctx.fillRect(x - 1, lineY - 5, 9, 9);
    ctx.strokeStyle = isFinal && !metrics.allTasksDone ? "rgba(189,189,183,0.8)" : YELLOW;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, lineY - 4, 7, 7);
  }

  const stepNames = [
    ["启动", "KICKOFF"],
    ["推进", "BUILD"],
    ["验收", "ACCEPT"],
    ["交付", "DELIVER"],
  ];
  const stepX = [53, 300, 547, 847];
  for (let index = 0; index < stepNames.length; index += 1) {
    const step = stepNames[index] ?? ["", ""];
    const x = stepX[index] ?? 53;
    const align = index === stepNames.length - 1 ? "right" : "left";
    setSans(ctx, 600, 10);
    ctx.fillStyle = "rgba(74,74,71,0.9)";
    drawSpaced(ctx, step[0] ?? "", x, 1136, 1.7, align);
    setSans(ctx, 500, 6.5);
    ctx.fillStyle = "rgba(154,154,150,0.9)";
    drawSpaced(ctx, step[1] ?? "", x, 1147, 1.4, align);
  }
}

function drawBand(ctx: SKRSContext2D): void {
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, 1210, WIDTH, 94);
  setSans(ctx, 900, 36);
  ctx.fillStyle = BLACK;
  drawSpaced(ctx, "真效率 · 不妥协", 53, 1248, 2.8);
  setSans(ctx, 700, 8);
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  drawSpaced(ctx, "TRUE EFFICIENCY. NO COMPROMISE.", 53, 1264, 3);

  setSans(ctx, 800, 23);
  ctx.fillStyle = BLACK;
  drawSpaced(ctx, "EVERY DETAIL / IN PLACE", 847, 1247, -0.5, "right");
  setSans(ctx, 700, 7);
  ctx.fillStyle = "rgba(0,0,0,0.66)";
  drawSpaced(ctx, "ENGINEERED TO PERFORM", 847, 1263, 2, "right");
}

function drawFooter(ctx: SKRSContext2D): void {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 1304, WIDTH, 46);
  ctx.save();
  ctx.translate(56, 1327);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(-3.5, -3.5, 7, 7);
  ctx.restore();
  setSans(ctx, 700, 10);
  ctx.fillStyle = "#ffffff";
  drawSpaced(ctx, "LIBIAOLINK", 70, 1330, 2.3);
  setSans(ctx, 500, 7.5);
  ctx.fillStyle = "rgba(165,165,161,0.95)";
  drawSpaced(ctx, "每个项目都值得被记录", 184, 1330, 2.1);

  setSans(ctx, 500, 6.5);
  ctx.fillStyle = "rgba(184,184,179,0.95)";
  drawSpaced(ctx, "PROJECT DELIVERY REPORT", 847, 1330, 1.7, "right");
}

export async function renderR06BrandPoster(view: R06PosterView, metrics: R06PosterMetrics, fonts?: R06PosterFontPaths): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts, fonts);
  const assets = await loadBrandAssets(canvasApi);
  const canvas = canvasApi.createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);
  drawHeader(ctx, assets.logo, view.status);
  drawOutcome(ctx, view, metrics);
  drawPhoto(ctx, view, metrics, assets.banner);
  drawProject(ctx, view, metrics);
  drawBand(ctx);
  drawFooter(ctx);
  return canvas.toBuffer("image/png");
}
