/**
 * 大阶段完成群海报：某一大阶段内全部小任务完成时，由企微机器人随文字通知发送。
 *
 * 1280 x 720 PNG；使用仓库内思源黑体与黄黑品牌资产，不依赖服务器系统字体。
 * 数据由 NotifyGroupRepository 按项目 / 阶段读取，渲染器保持纯函数，便于 worker 失败时只跳过图片。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE_KEYS, STAGE_NAMES } from "@libiaolink/contracts";
import type { Image as CanvasImage, SKRSContext2D } from "@napi-rs/canvas";
import type { StageCompletePosterData } from "./stage-complete.poster.types.js";

const WIDTH = 1280;
const HEIGHT = 720;
const PAPER = "#f3f0e7";
const INK = "#11120f";
const YELLOW = "#feca04";
const MUTED = "#6c675d";
const LINE = "#cfcabf";
const FONT_REGULAR = "LibiaoLink Stage Sans";
const FONT_BOLD = "LibiaoLink Stage Sans Bold";
const LOGO_FILE = "r06-brand-logo.svg";
const FONT_REGULAR_FILE = "fonts/SourceHanSansSC-Regular.otf";
const FONT_BOLD_FILE = "fonts/SourceHanSansSC-Bold.otf";

type NapiCanvas = typeof import("@napi-rs/canvas");
let canvasApiPromise: Promise<NapiCanvas> | null = null;
let logoPromise: Promise<CanvasImage> | null = null;
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
    throw new Error("Stage complete poster asset missing: " + fileName);
  }
  return found;
}

function loadLogo(canvasApi: NapiCanvas): Promise<CanvasImage> {
  logoPromise ??= canvasApi.loadImage(assetPath(LOGO_FILE));
  return logoPromise;
}

function ensureFonts(globalFonts: NapiCanvas["GlobalFonts"]): void {
  if (fontsReady) return;
  const regular = globalFonts.registerFromPath(assetPath(FONT_REGULAR_FILE), FONT_REGULAR);
  const bold = globalFonts.registerFromPath(assetPath(FONT_BOLD_FILE), FONT_BOLD);
  if (regular === null || bold === null) {
    throw new Error("Stage complete poster font registration failed");
  }
  fontsReady = true;
}

function setSans(ctx: SKRSContext2D, bold: boolean, size: number): void {
  ctx.font = (bold ? "700 " : "400 ") + String(size) + "px " + (bold ? FONT_BOLD : FONT_REGULAR);
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

function fitSansSize(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  start: number,
  min: number,
  bold: boolean,
): number {
  let size = start;
  while (size > min) {
    setSans(ctx, bold, size);
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.join("") + "…";
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return "…";
}

function shanghaiDate(value: Date): string {
  return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function formatDot(value: Date): string {
  return shanghaiDate(value).replaceAll("-", ".");
}

function drawCheck(ctx: SKRSContext2D, x: number, y: number, size: number, color: string, lineWidth: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.52);
  ctx.lineTo(x + size * 0.39, y + size * 0.9);
  ctx.lineTo(x + size, y + size * 0.18);
  ctx.stroke();
  ctx.restore();
}

function drawDiamond(ctx: SKRSContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = color;
  ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.restore();
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.save();
  ctx.strokeStyle = "rgba(17,18,15,0.035)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= HEIGHT; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(WIDTH, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  const glow = ctx.createRadialGradient(190, 85, 20, 190, 85, 520);
  glow.addColorStop(0, "rgba(254,202,4,0.13)");
  glow.addColorStop(1, "rgba(254,202,4,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 760, 470);

  ctx.strokeStyle = INK;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, WIDTH - 10, HEIGHT - 10);

  ctx.fillStyle = YELLOW;
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(63, 10);
  ctx.lineTo(10, 63);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(WIDTH - 10, HEIGHT - 10);
  ctx.lineTo(WIDTH - 63, HEIGHT - 10);
  ctx.lineTo(WIDTH - 10, HEIGHT - 63);
  ctx.closePath();
  ctx.fill();
}

function drawHeader(ctx: SKRSContext2D, logo: CanvasImage, completedAt: Date): void {
  const logoWidth = 142;
  const logoHeight = logo.width > 0 ? logoWidth * (logo.height / logo.width) : 50;
  ctx.drawImage(logo, 64, 38, logoWidth, logoHeight);

  ctx.fillStyle = "rgba(17,18,15,0.24)";
  ctx.fillRect(224, 47, 1, 30);
  setSans(ctx, true, 12);
  ctx.fillStyle = "#54514a";
  drawSpaced(ctx, "PROJECT MILESTONE", 243, 60, 3.2);

  setSans(ctx, true, 12);
  ctx.fillStyle = "#5f5b52";
  drawSpaced(ctx, "大阶段完成通知", 1216, 57, 2.2, "right");
  setSans(ctx, true, 12);
  ctx.fillStyle = INK;
  drawSpaced(ctx, formatDot(completedAt), 1216, 77, 2, "right");

  ctx.fillStyle = "rgba(17,18,15,0.22)";
  ctx.fillRect(64, 104, 1152, 1);
}

function drawHero(
  ctx: SKRSContext2D,
  data: StageCompletePosterData,
  stageName: string,
  stageIndex: number,
  stageTotal: number,
): void {
  ctx.fillStyle = YELLOW;
  ctx.fillRect(64, 130, 66, 30);
  setSans(ctx, true, 13);
  ctx.fillStyle = INK;
  drawSpaced(ctx, "里程碑", 81, 151, 2.2);

  setSans(ctx, true, 15);
  ctx.fillStyle = "#5f5b52";
  drawSpaced(ctx, String(stageIndex).padStart(2, "0") + " / " + String(stageTotal).padStart(2, "0"), 146, 151, 2.2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(206, 146);
  ctx.lineTo(268, 146);
  ctx.stroke();
  setSans(ctx, true, 15);
  ctx.fillStyle = "#5f5b52";
  drawSpaced(ctx, "STAGE CLEARED", 282, 151, 2.8);

  setSans(ctx, false, 16);
  ctx.fillStyle = "rgba(108,103,93,0.92)";
  const projectLine = "项目  /  " + data.projectName + "  ·  " + data.projectCode;
  setSans(ctx, true, 16);
  ctx.fillText(ellipsize(ctx, projectLine, 754), 64, 191);

  setSans(ctx, true, 128);
  ctx.fillStyle = INK;
  const stageWidth = drawSpaced(ctx, stageName, 59, 304, -5.5);
  drawDiamond(ctx, 59 + stageWidth + 42, 180, 14, YELLOW);

  const total = data.stages.find((stage) => stage.key === data.stageKey)?.total ?? 0;
  const doneText = "全部完成";
  setSans(ctx, true, 28);
  const doneTextWidth = ctx.measureText(doneText).width;
  const pillWidth = 16 + 30 + 12 + doneTextWidth + 22;
  ctx.fillStyle = INK;
  ctx.fillRect(64, 318, pillWidth, 54);
  ctx.fillStyle = YELLOW;
  ctx.beginPath();
  ctx.arc(95, 345, 15, 0, Math.PI * 2);
  ctx.fill();
  drawCheck(ctx, 87, 336, 16, INK, 3.2);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(doneText, 122, 356);

  setSans(ctx, true, 28);
  ctx.fillStyle = INK;
  const statusX = 64 + pillWidth + 18;
  ctx.fillText("本阶段 ", statusX, 356);
  const prefixWidth = ctx.measureText("本阶段 ").width;
  ctx.fillText(String(total), statusX + prefixWidth, 356);
  const numberWidth = ctx.measureText(String(total)).width;
  ctx.fillStyle = MUTED;
  ctx.fillText(" 项小任务，一个不落", statusX + prefixWidth + numberWidth, 356);

  setSans(ctx, true, 20);
  ctx.fillStyle = INK;
  ctx.fillText("向下一个阶段，继续推进。", 64, 409);
  setSans(ctx, false, 18);
  ctx.fillStyle = MUTED;
  ctx.fillText("每一个小节点都已完成，这一程正式通关。", 64, 440);
}

function drawSummary(ctx: SKRSContext2D, total: number): void {
  const x = 850;
  const y = 146;
  const width = 366;
  const height = 384;
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(254,202,4,0.075)";
  ctx.lineWidth = 32;
  ctx.lineCap = "square";
  ctx.beginPath();
  ctx.moveTo(1060, 406);
  ctx.lineTo(1122, 468);
  ctx.lineTo(1248, 330);
  ctx.stroke();
  ctx.restore();

  setSans(ctx, true, 12);
  ctx.fillStyle = YELLOW;
  drawSpaced(ctx, "STAGE SCORE", 880, 184, 2.7);

  ctx.strokeStyle = "rgba(254,202,4,0.68)";
  ctx.lineWidth = 1;
  ctx.strokeRect(1144, 164, 42, 42);
  drawCheck(ctx, 1153, 173, 23, YELLOW, 2.2);

  const score = String(total);
  const scoreSize = score.length >= 3 ? 82 : score.length === 2 ? 106 : 126;
  setSans(ctx, true, scoreSize);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(score, 880, 335);
  const scoreWidth = ctx.measureText(score).width;
  setSans(ctx, true, 62);
  ctx.fillStyle = "#6f6f68";
  ctx.fillText("/" + score, 880 + scoreWidth + 10, 335);

  setSans(ctx, true, 12);
  ctx.fillStyle = "#8c8c85";
  drawSpaced(ctx, "TASKS DONE", 1186, 280, 2, "right");

  setSans(ctx, true, 23);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("小任务全部清零", 880, 381);
  setSans(ctx, false, 13);
  ctx.fillStyle = "#a09f98";
  drawSpaced(ctx, "ALL TASKS COMPLETED", 880, 405, 1.5);

  setSans(ctx, true, 10);
  ctx.fillStyle = "#7f7f78";
  drawSpaced(ctx, "PHASE PROGRESS", 880, 465, 2);
  drawSpaced(ctx, "100%", 1186, 465, 1.4, "right");
  ctx.fillStyle = "#34342f";
  ctx.fillRect(880, 482, 306, 6);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(880, 482, 306, 6);
}

function drawRail(
  ctx: SKRSContext2D,
  data: StageCompletePosterData,
  stageIndex: number,
  stageTotal: number,
): void {
  setSans(ctx, true, 10);
  ctx.fillStyle = "#777268";
  drawSpaced(ctx, "项目阶段进度", 64, 565, 2.4);
  ctx.fillStyle = INK;
  drawSpaced(ctx, "STAGE " + String(stageIndex).padStart(2, "0") + " OF " + String(stageTotal).padStart(2, "0"), 1216, 565, 2.4, "right");

  ctx.fillStyle = "rgba(17,18,15,0.28)";
  ctx.fillRect(64, 578, 1152, 1);

  const left = 64;
  const usable = 1152;
  const cell = usable / STAGE_KEYS.length;
  const byKey = new Map(data.stages.map((stage) => [stage.key, stage] as const));
  for (let index = 0; index < STAGE_KEYS.length; index += 1) {
    const key = STAGE_KEYS[index];
    if (key === undefined) continue;
    const x = left + index * cell;
    const pad = index === 0 ? 0 : 10;
    const current = key === data.stageKey;
    const stage = byKey.get(key);
    const completed = stage !== undefined && stage.total > 0 && stage.done === stage.total;
    const name = (STAGE_NAMES as Record<string, string>)[key] ?? key;

    if (index > 0) {
      ctx.fillStyle = "rgba(17,18,15,0.12)";
      ctx.fillRect(x, 587, 1, 58);
    }
    if (current) {
      drawDiamond(ctx, x + pad + 3, 588, 6, YELLOW);
    }

    setSans(ctx, true, 10);
    ctx.fillStyle = current || completed ? "#1d1e1a" : "#9a958a";
    drawSpaced(ctx, String(index + 1).padStart(2, "0"), x + pad, 603, 1.2);

    setSans(ctx, true, 14);
    ctx.fillStyle = current || completed ? INK : "#777268";
    ctx.fillText(ellipsize(ctx, name, cell - pad - 8), x + pad, 626);

    ctx.fillStyle = current ? YELLOW : completed ? INK : "rgba(17,18,15,0.13)";
    ctx.fillRect(x + pad, current ? 639 : 640, cell - pad - 10, current ? 7 : 3);
  }

  setSans(ctx, true, 9);
  ctx.fillStyle = "#8e897e";
  drawSpaced(ctx, "LIBIAOLINK · EVERY DETAIL IN PLACE", 1216, 698, 2.0, "right");
}

export async function renderStageCompletePoster(
  data: StageCompletePosterData,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts);
  const logo = await loadLogo(canvasApi);
  const stageName = (STAGE_NAMES as Record<string, string>)[data.stageKey] ?? data.stageKey;
  const rawIndex = (STAGE_KEYS as readonly string[]).indexOf(data.stageKey);
  const stageIndex = rawIndex >= 0 ? rawIndex + 1 : 1;
  const stageTotal = STAGE_KEYS.length;
  const stage = data.stages.find((item) => item.key === data.stageKey);
  const total = stage?.total ?? 0;

  const canvas = canvasApi.createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);
  drawHeader(ctx, logo, data.completedAt);
  drawHero(ctx, data, stageName, stageIndex, stageTotal);
  drawSummary(ctx, total);
  drawRail(ctx, data, stageIndex, stageTotal);
  return canvas.toBuffer("image/png");
}
