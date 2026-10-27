/**
 * 日报群同步海报（1080 x 1120 PNG）。
 *
 * 设计口径（2026-10-27 业务确认）：工程现场简报风、米白纸面、黑黄品牌色；
 * 标题 / 日期 / 项目信息 / 今日完成 / 现场照片 / 明日计划 / 现场问题一屏收口。
 * 不使用 R06 喜报版式，不依赖系统字体 —— 服务端随包发布思源黑体 SC（SIL OFL 1.1）。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Image as CanvasImage, SKRSContext2D } from "@napi-rs/canvas";
import type {
  DailyReportPosterData,
  DailyReportPosterFontPaths,
  DailyReportPosterIssue,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";

export type {
  DailyReportPosterData,
  DailyReportPosterFontPaths,
  DailyReportPosterIssue,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";

const WIDTH = 1080;
const HEIGHT = 1120;
const MARGIN = 54;
const CONTENT_RIGHT = 1026;
const CONTENT_W = CONTENT_RIGHT - MARGIN;
const PAPER = "#f0eee7";
const SURFACE = "#faf9f4";
const INK = "#10110f";
const YELLOW = "#feca04";
const MUTED = "#6e706a";
const LINE = "#c7c5bc";
const ISSUE = "#ff5c35";
const FONT_REGULAR = "LibiaoLink Daily Source Han Sans";
const FONT_BOLD = "LibiaoLink Daily Source Han Sans Bold";
const BUNDLED_FONT = "SourceHanSansSC-Regular.otf";
const BUNDLED_FONT_BOLD = "SourceHanSansSC-Bold.otf";
const CANVAS_MODULE = "@napi-rs/canvas";

type NapiCanvas = typeof import("@napi-rs/canvas");
let canvasApiPromise: Promise<NapiCanvas> | null = null;
let fontRegistration = "";

async function loadCanvasApi(): Promise<NapiCanvas> {
  canvasApiPromise ??= import(CANVAS_MODULE);
  return await canvasApiPromise;
}

function fontAssetPath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "assets", "fonts", fileName),
    join(here, "..", "..", "..", "assets", "fonts", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error("日报海报字体缺失：" + fileName);
  }
  return found;
}

function ensureFonts(globalFonts: NapiCanvas["GlobalFonts"], paths?: DailyReportPosterFontPaths): void {
  const bundledRegular = fontAssetPath(BUNDLED_FONT);
  const bundledBold = fontAssetPath(BUNDLED_FONT_BOLD);
  const regular = paths?.regular?.trim() || bundledRegular;
  const bold = paths?.bold?.trim() || bundledBold;
  const key = regular + "\n" + bold;
  if (fontRegistration === key) {
    return;
  }
  const regularFace = globalFonts.registerFromPath(regular, FONT_REGULAR);
  const boldFace = globalFonts.registerFromPath(bold, FONT_BOLD);
  if (regularFace === null || boldFace === null) {
    throw new Error("日报海报字体注册失败");
  }
  fontRegistration = key;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return "rgba(" + String(r) + "," + String(g) + "," + String(b) + "," + String(alpha) + ")";
}

function setFont(ctx: SKRSContext2D, bold: boolean, size: number): void {
  ctx.font = String(size) + "px " + (bold ? FONT_BOLD : FONT_REGULAR);
}

function textWidth(ctx: SKRSContext2D, text: string): number {
  return ctx.measureText(text).width;
}

function fitFontSize(
  ctx: SKRSContext2D,
  bold: boolean,
  text: string,
  maxWidth: number,
  start: number,
  min: number,
): number {
  let size = start;
  while (size > min) {
    setFont(ctx, bold, size);
    if (textWidth(ctx, text) <= maxWidth) {
      break;
    }
    size -= 1;
  }
  return size;
}

function spacedWidth(ctx: SKRSContext2D, text: string, spacing: number): number {
  let width = 0;
  for (const char of Array.from(text)) {
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
  for (const char of Array.from(text)) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + spacing;
  }
  return width;
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (textWidth(ctx, text) <= maxWidth) {
    return text;
  }
  const chars = Array.from(text);
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.join("").trimEnd() + "…";
    if (textWidth(ctx, candidate) <= maxWidth) {
      return candidate;
    }
  }
  return "…";
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized === "" || maxLines <= 0) {
    return [];
  }
  const chars = Array.from(normalized);
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length && lines.length < maxLines) {
    let count = 0;
    let measured = "";
    while (start + count < chars.length) {
      const candidate = measured + (chars[start + count] ?? "");
      if (count > 0 && textWidth(ctx, candidate) > maxWidth) {
        break;
      }
      measured = candidate;
      count += 1;
    }
    if (count === 0) {
      count = 1;
    }
    const remaining = chars.length - start;
    if (lines.length === maxLines - 1 && count < remaining) {
      const partial = chars.slice(start, start + count).join("").trimEnd();
      lines.push(ellipsize(ctx, partial + chars.slice(start + count).join(""), maxWidth));
      break;
    }
    lines.push(chars.slice(start, start + count).join("").trim());
    start += count;
    while (start < chars.length && chars[start] === " ") {
      start += 1;
    }
  }
  return lines.filter((line) => line !== "");
}

function clipOneLine(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  return ellipsize(ctx, text.replace(/\s+/gu, " ").trim(), maxWidth);
}

function listItems(text: string, maxItems: number): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:\d+)[:：.、)]\s*/u, "").trim())
    .filter((line) => line !== "")
    .slice(0, maxItems);
}

function countListItems(text: string): number {
  return text.split(/\r?\n/u).filter((line) => line.trim() !== "").length;
}

function shanghaiTime(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return String(Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0");
}

function dateInfo(reportDate: string): {
  year: string;
  monthDay: string;
  nextMonthDay: string;
  weekdayEn: string;
  weekdayZh: string;
  week: string;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(reportDate);
  if (match === null) {
    return {
      year: reportDate.slice(0, 4),
      monthDay: "--.--",
      nextMonthDay: "--.--",
      weekdayEn: "",
      weekdayZh: "",
      week: "",
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const next = new Date(date.getTime() + 86_400_000);
  const weekdayEn = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date).toUpperCase();
  const weekdayZh = new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
  return {
    year: String(year),
    monthDay: match[2] + "." + match[3],
    nextMonthDay: String(next.getUTCMonth() + 1).padStart(2, "0") + "." + String(next.getUTCDate()).padStart(2, "0"),
    weekdayEn,
    weekdayZh,
    week: isoWeek(year, month, day),
  };
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.lineWidth = 1;
  for (let x = 80; x < WIDTH; x += 80) {
    ctx.strokeStyle = "rgba(16,17,15,0.032)";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, HEIGHT);
    ctx.stroke();
  }
  for (let y = 80; y < HEIGHT; y += 80) {
    ctx.strokeStyle = "rgba(16,17,15,0.028)";
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(WIDTH, y + 0.5);
    ctx.stroke();
  }
}

function drawDateCard(ctx: SKRSContext2D, data: DailyReportPosterData): void {
  const info = dateInfo(data.reportDate);
  const x = 782;
  const y = 43;
  const width = 258;
  const height = 236;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(16,17,15,0.24)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 9.5, y + 9.5, width - 19, height - 19);

  setFont(ctx, true, 12);
  ctx.fillStyle = INK;
  drawSpaced(ctx, info.weekdayEn, x + 21, y + 31, 2.4);
  drawSpaced(ctx, "WEEK " + info.week, x + width - 21, y + 32, 1.4, "right");

  const dateSize = fitFontSize(ctx, true, info.monthDay, 215, 101, 72);
  setFont(ctx, true, dateSize);
  ctx.fillText(info.monthDay, x + 19, y + 154);

  setFont(ctx, true, 23);
  ctx.fillText(info.year, x + 21, y + 209);
  const time = shanghaiTime(data.submittedAt);
  setFont(ctx, true, 12);
  ctx.textAlign = "right";
  drawSpaced(ctx, info.weekdayZh + (time === "" ? "" : " / " + time), x + width - 21, y + 208, 1.5, "right");
  ctx.textAlign = "left";
}

function drawEyebrow(ctx: SKRSContext2D): void {
  setFont(ctx, true, 15);
  ctx.fillStyle = "#4c4e49";
  drawSpaced(ctx, "PROJECT DAILY", MARGIN, 65, 3.2);
  const width = spacedWidth(ctx, "PROJECT DAILY", 3.2);
  setFont(ctx, true, 15);
  ctx.fillStyle = ISSUE;
  ctx.fillText("/", MARGIN + width + 11, 65);
  ctx.fillStyle = "#4c4e49";
  drawSpaced(ctx, "项目日报", MARGIN + width + 29, 65, 2.4);
}

function splitTitle(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const chars = Array.from(text.trim());
  if (chars.length <= 1) {
    return [chars.join("")];
  }
  const target = Math.max(1, Math.min(chars.length - 1, Math.round(chars.length * 0.58)));
  for (let offset = 0; offset < chars.length; offset += 1) {
    const lower = target - offset;
    const upper = target + offset;
    for (const split of offset === 0 ? [target] : [lower, upper]) {
      if (split < 1 || split >= chars.length) continue;
      const first = chars.slice(0, split).join("").trim();
      const second = chars.slice(split).join("").trim();
      if (first === "" || second === "") continue;
      if (textWidth(ctx, first) <= maxWidth && textWidth(ctx, second) <= maxWidth) {
        return [first, second];
      }
    }
  }
  const first = wrapText(ctx, text, maxWidth, 1)[0] ?? chars.slice(0, 1).join("");
  return [first, ellipsize(ctx, chars.slice(Array.from(first).length).join(""), maxWidth)];
}

function drawProjectTitle(ctx: SKRSContext2D, data: DailyReportPosterData): void {
  const maxWidth = 664;
  const chars = Array.from(data.projectName.trim());
  let size = 40;
  let lines: string[] = [data.projectName.trim()];
  for (let candidate = 55; candidate >= 40; candidate -= 1) {
    setFont(ctx, true, candidate);
    if (chars.length <= 8 && textWidth(ctx, data.projectName.trim()) <= maxWidth) {
      size = candidate;
      lines = [data.projectName.trim()];
      break;
    }
    const pair = splitTitle(ctx, data.projectName, maxWidth);
    if (pair.length === 2 && pair.every((line) => line !== "" && textWidth(ctx, line) <= maxWidth)) {
      size = candidate;
      lines = pair;
      break;
    }
  }
  const lineHeight = Math.round(size * 1.13);
  const firstBaseline = lines.length === 1 ? 166 : 146;
  lines.forEach((line, index) => {
    const baseline = firstBaseline + index * lineHeight;
    setFont(ctx, true, size);
    if (index === lines.length - 1) {
      const width = textWidth(ctx, line);
      ctx.fillStyle = YELLOW;
      ctx.beginPath();
      ctx.moveTo(MARGIN - 3, baseline + 8);
      ctx.lineTo(MARGIN + width + 5, baseline + 8);
      ctx.lineTo(MARGIN + width + 10, baseline - 8);
      ctx.lineTo(MARGIN + 1, baseline - 8);
      ctx.closePath();
      ctx.fill();
    }
    setFont(ctx, true, size);
    ctx.fillStyle = INK;
    ctx.fillText(line, MARGIN, baseline);
  });
}

function drawMeta(ctx: SKRSContext2D, data: DailyReportPosterData): void {
  const labelY = 262;
  const valueY = 289;
  const columns = [
    { x: MARGIN, width: 176, label: "PROJECT CODE", value: data.projectCode, size: 18 },
    {
      x: 274,
      width: 222,
      label: "PROJECT MANAGER",
      value: data.managers.length === 0 ? "待定" : data.managers.join("、"),
      size: 19,
    },
    {
      x: 555,
      width: 450,
      label: "SUBMITTED BY",
      value: (data.authorName ?? "—") + (shanghaiTime(data.submittedAt) === "" ? "" : " · " + shanghaiTime(data.submittedAt)),
      size: 19,
    },
  ];
  for (const column of columns) {
    setFont(ctx, true, 10);
    ctx.fillStyle = MUTED;
    drawSpaced(ctx, column.label, column.x, labelY, 1.7);
    const valueSize = fitFontSize(ctx, true, column.value, column.width, column.size, 13);
    setFont(ctx, true, valueSize);
    ctx.fillStyle = INK;
    ctx.fillText(clipOneLine(ctx, column.value, column.width), column.x, valueY);
  }
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  for (const x of [248, 526]) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 246);
    ctx.lineTo(x + 0.5, 304);
    ctx.stroke();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, 318.5);
  ctx.lineTo(CONTENT_RIGHT, 318.5);
  ctx.stroke();
}

function drawStats(ctx: SKRSContext2D, data: DailyReportPosterData): void {
  const issuePhotoCount = data.issues.reduce((sum, issue) => sum + issue.photos.length, 0);
  const stageText = data.stages.length === 0 ? "未关联阶段" : data.stages.slice(0, 2).join(" / ");
  const stats = [
    { x: MARGIN, width: 210, label: "SITE HEADCOUNT", value: String(data.headcount ?? 0), unit: "人" },
    { x: 282, width: 302, label: "CURRENT STAGE", value: stageText, unit: "" },
    { x: 601, width: 191, label: "OPEN ISSUES", value: String(data.issues.length).padStart(2, "0"), unit: "项" },
    {
      x: 815,
      width: 211,
      label: "PHOTO EVIDENCE",
      value: String(data.photos.length + issuePhotoCount).padStart(2, "0"),
      unit: "张",
    },
  ];
  setFont(ctx, true, 10);
  for (const stat of stats) {
    ctx.fillStyle = MUTED;
    drawSpaced(ctx, stat.label, stat.x, 344, 1.8);
  }
  for (const [index, stat] of stats.entries()) {
    setFont(ctx, true, 40);
    ctx.fillStyle = INK;
    if (index === 1) {
      setFont(ctx, true, 19);
      const lines = wrapText(ctx, stat.value, stat.width, 1);
      ctx.fillText(lines[0] ?? "—", stat.x, 389);
      setFont(ctx, false, 10);
      ctx.fillStyle = MUTED;
      ctx.fillText(data.stages.length === 0 ? "未关联阶段" : String(data.stages.length) + " 个关联阶段", stat.x, 416);
    } else {
      ctx.fillText(stat.value, stat.x, 394);
      const numberWidth = textWidth(ctx, stat.value);
      setFont(ctx, true, 12);
      ctx.fillStyle = "#4f514c";
      ctx.fillText(stat.unit, stat.x + numberWidth + 7, 391);
      if (index === 3) {
        setFont(ctx, false, 10);
        ctx.fillStyle = MUTED;
        ctx.fillText(
          "现场 " + String(data.photos.length) + " / 问题 " + String(issuePhotoCount),
          stat.x,
          416,
        );
      }
    }
  }
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  for (const x of [270, 590, 803]) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 331);
    ctx.lineTo(x + 0.5, 423);
    ctx.stroke();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, 435.5);
  ctx.lineTo(CONTENT_RIGHT, 435.5);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(MARGIN, 472.5);
  ctx.lineTo(CONTENT_RIGHT, 472.5);
  ctx.stroke();
}

function drawSectionHeading(ctx: SKRSContext2D, index: string, title: string, right: string): void {
  setFont(ctx, true, 14);
  ctx.fillStyle = ISSUE;
  drawSpaced(ctx, index + " /", MARGIN, 505, 1.6);
  setFont(ctx, true, 30);
  ctx.fillStyle = INK;
  ctx.fillText(title, 124, 509);
  setFont(ctx, true, 9.5);
  ctx.fillStyle = MUTED;
  drawSpaced(ctx, right, CONTENT_RIGHT, 496, 2.2, "right");
}

function drawWork(ctx: SKRSContext2D, data: DailyReportPosterData): void {
  const allItems = listItems(data.doneWork, 99);
  const items = allItems.slice(0, 4);
  const extra = Math.max(allItems.length, countListItems(data.doneWork)) - items.length;
  drawSectionHeading(
    ctx,
    "01",
    "今日完成",
    extra > 0 ? "WORK COMPLETED TODAY · +" + String(extra) + " MORE" : "WORK COMPLETED TODAY",
  );
  if (items.length === 0) {
    setFont(ctx, false, 17);
    ctx.fillStyle = MUTED;
    ctx.fillText("今日完成工作待补充", MARGIN, 563);
    return;
  }
  const columnWidth = 472;
  const gap = 28;
  const rowGap = 58;
  items.forEach((item, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + column * (columnWidth + gap);
    const top = 526 + row * rowGap;
    ctx.fillStyle = INK;
    ctx.fillRect(x, top, 30, 30);
    setFont(ctx, true, 15);
    ctx.fillStyle = YELLOW;
    ctx.fillText(String(index + 1).padStart(2, "0"), x + 6, top + 22);
    const textX = x + 41;
    const textMax = columnWidth - 41;
    setFont(ctx, true, 18);
    ctx.fillStyle = INK;
    const lines = wrapText(ctx, item, textMax, 2);
    lines.forEach((line, lineIndex) => {
      setFont(ctx, true, 18);
      ctx.fillText(line, textX, top + 22 + lineIndex * 23);
    });
  });
}

function drawCoverImage(
  ctx: SKRSContext2D,
  image: CanvasImage,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
}

function drawPhotoPlaceholder(ctx: SKRSContext2D, x: number, y: number, width: number, height: number): void {
  const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, "#7d817c");
  gradient.addColorStop(0.5, "#4d534e");
  gradient.addColorStop(1, "#252a26");
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(254,202,4,0.34)";
  ctx.lineWidth = 3;
  for (let offset = -height; offset < width; offset += 34) {
    ctx.beginPath();
    ctx.moveTo(x + offset, y + height);
    ctx.lineTo(x + offset + height, y);
    ctx.stroke();
  }
}

function drawPhotos(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  images: ReadonlyMap<string, CanvasImage>,
): boolean {
  const photos = data.photos.slice(0, 3);
  if (photos.length === 0) {
    return false;
  }
  const top = 642;
  const height = 174;
  const gap = 8;
  const ratios = photos.length === 1 ? [1] : photos.length === 2 ? [1, 1] : [1.25, 1, 1];
  const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const usable = CONTENT_W - gap * (photos.length - 1);
  let x = MARGIN;
  photos.forEach((photo, index) => {
    const width = usable * (ratios[index] ?? 1) / ratioTotal;
    ctx.fillStyle = "#d3d4cd";
    ctx.fillRect(x, top, width, height);
    const image = images.get(photo.fileId);
    if (image === undefined) {
      drawPhotoPlaceholder(ctx, x, top, width, height);
    } else {
      drawCoverImage(ctx, image, x, top, width, height);
    }
    const shade = ctx.createLinearGradient(0, top + height - 74, 0, top + height);
    shade.addColorStop(0, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.76)");
    ctx.fillStyle = shade;
    ctx.fillRect(x, top + height - 74, width, 74);
    ctx.strokeStyle = "#b9bab4";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 0.5, width - 1, height - 1);
    ctx.fillStyle = YELLOW;
    ctx.fillRect(x + width - 46, top + 11, 35, 22);
    setFont(ctx, true, 10);
    ctx.fillStyle = INK;
    drawSpaced(ctx, String(index + 1).padStart(2, "0"), x + width - 38, top + 26, 1.2);
    setFont(ctx, true, 10.5);
    ctx.fillStyle = "#ffffff";
    drawSpaced(ctx, "现场工作 / " + String(index + 1).padStart(2, "0"), x + 13, top + height - 13, 1.2);
    x += width + gap;
  });
  return true;
}

function drawNoPhotosNotice(ctx: SKRSContext2D): void {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, 642.5);
  ctx.lineTo(CONTENT_RIGHT, 642.5);
  ctx.stroke();
  setFont(ctx, true, 9.5);
  ctx.fillStyle = MUTED;
  drawSpaced(ctx, "SITE PHOTO EVIDENCE", MARGIN, 665, 1.8);
  setFont(ctx, false, 14);
  ctx.fillStyle = MUTED;
  ctx.fillText("今日未上传现场工作照片，工作记录以 LibiaoLink 为准。", MARGIN, 688);
}

function drawPlanCard(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = SURFACE;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  const info = dateInfo(data.reportDate);
  setFont(ctx, true, 22);
  ctx.fillStyle = INK;
  ctx.fillText("明日计划", x + 20, y + 39);
  setFont(ctx, true, 9.5);
  ctx.fillStyle = MUTED;
  drawSpaced(ctx, "NEXT / " + info.nextMonthDay, x + width - 20, y + 36, 1.5, "right");
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 20, y + 53.5);
  ctx.lineTo(x + width - 20, y + 53.5);
  ctx.stroke();

  const allItems = listItems(data.plan ?? "", 99);
  const rowHeight = height < 300 ? 46 : 48;
  const maxVisible = Math.max(1, Math.min(5, Math.floor((height - 86) / rowHeight)));
  const items = allItems.slice(0, maxVisible);
  if (items.length === 0) {
    setFont(ctx, false, 14);
    ctx.fillStyle = MUTED;
    ctx.fillText("明日计划待补充", x + 21, y + 91);
    return;
  }
  items.forEach((item, index) => {
    const top = y + 68 + index * rowHeight;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x + 21.5, top + 3.5, 14, 14);
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 25, top + 7.5);
    ctx.lineTo(x + 32, top + 7.5);
    ctx.stroke();
    setFont(ctx, true, 15.5);
    ctx.fillStyle = INK;
    ctx.fillText(clipOneLine(ctx, item, width - 72), x + 47, top + 16);
  });
  const extra = allItems.length - items.length;
  if (extra > 0) {
    setFont(ctx, false, 10);
    ctx.fillStyle = MUTED;
    ctx.fillText("另有 " + String(extra) + " 项，详见 LibiaoLink", x + 21, y + height - 14);
  }
}

function drawIssueThumb(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  image: CanvasImage | undefined,
  x: number,
  y: number,
): void {
  const width = 68;
  const height = 62;
  ctx.fillStyle = "#3b423c";
  ctx.fillRect(x, y, width, height);
  if (image === undefined) {
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, "#737970");
    gradient.addColorStop(1, "#252b26");
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
  } else {
    drawCoverImage(ctx, image, x, y, width, height);
  }
  ctx.strokeStyle = "rgba(254,202,4,0.72)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(x + width - 21, y, 21, 17);
  setFont(ctx, true, 10);
  ctx.fillStyle = INK;
  drawSpaced(ctx, String(issue.photos.length), x + width - 15, y + 12, 0.4);
  setFont(ctx, false, 7);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("问题附图", x + 5, y + height - 5);
}

function drawIssueCard(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  images: ReadonlyMap<string, CanvasImage>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = INK;
  ctx.fillRect(x, y, width, height);
  setFont(ctx, true, 22);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("现场问题", x + 20, y + 39);
  const issuePhotoCount = data.issues.reduce((sum, issue) => sum + issue.photos.length, 0);
  setFont(ctx, true, 9.5);
  ctx.fillStyle = "#9b9d95";
  drawSpaced(
    ctx,
    "OPEN " + String(data.issues.length).padStart(2, "0") + " / IMG " + String(issuePhotoCount).padStart(2, "0"),
    x + width - 20,
    y + 36,
    1.2,
    "right",
  );
  ctx.strokeStyle = "#3a3b36";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 20, y + 53.5);
  ctx.lineTo(x + width - 20, y + 53.5);
  ctx.stroke();

  if (data.issues.length === 0) {
    setFont(ctx, true, 18);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("今日无新增现场问题", x + 20, y + 98);
    setFont(ctx, false, 10);
    ctx.fillStyle = "#9b9d95";
    ctx.fillText("现场问题与整改跟踪以 LibiaoLink 为准。", x + 20, y + height - 20);
    return;
  }

  const available = height < 300 ? 2 : 3;
  const visible = data.issues.slice(0, available);
  const footer = 33;
  const contentTop = y + 61;
  const rowHeight = Math.min(104, Math.max(58, (height - 61 - footer - 4) / visible.length));
  visible.forEach((issue, index) => {
    const top = contentTop + index * rowHeight;
    ctx.fillStyle = index === 0 ? ISSUE : YELLOW;
    ctx.fillRect(x + 20, top, 3, Math.min(62, rowHeight - 8));
    const image = issue.photos[0] === undefined ? undefined : images.get(issue.photos[0].fileId);
    const hasThumb = issue.photos.length > 0;
    const copyWidth = width - 49 - (hasThumb ? 82 : 0);
    setFont(ctx, true, 9);
    ctx.fillStyle = YELLOW;
    const category = issue.categories.length === 0 ? "未分类" : issue.categories.join(" / ");
    const meta = clipOneLine(ctx, category, copyWidth * 0.49);
    ctx.fillText(meta, x + 32, top + 10);
    setFont(ctx, false, 9);
    ctx.fillStyle = "#b9bbb3";
    ctx.textAlign = "right";
    ctx.fillText(
      clipOneLine(ctx, "责任人 · " + (issue.ownerName ?? "待分派"), copyWidth * 0.48),
      x + 32 + copyWidth,
      top + 10,
    );
    ctx.textAlign = "left";
    setFont(ctx, true, 14);
    ctx.fillStyle = "#f2f2ed";
    const lines = wrapText(ctx, issue.title, copyWidth, 2);
    lines.forEach((line, lineIndex) => {
      setFont(ctx, true, 14);
      ctx.fillText(line, x + 32, top + 29 + lineIndex * 18);
    });
    if (hasThumb) {
      drawIssueThumb(ctx, issue, image, x + width - 88, top + 3);
    }
  });
  ctx.strokeStyle = "#3a3b36";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 20, y + height - footer + 0.5);
  ctx.lineTo(x + width - 20, y + height - footer + 0.5);
  ctx.stroke();
  setFont(ctx, false, 9);
  ctx.fillStyle = "#b6b8af";
  const hidden = data.issues.length - visible.length;
  const footerText = hidden > 0
    ? "另有 " + String(hidden) + " 项问题可在 LibiaoLink 查看，处理进展以系统记录为准。"
    : "问题与附图已进入 LibiaoLink 追踪，处理进展以系统记录为准。";
  ctx.fillText(clipOneLine(ctx, footerText, width - 40), x + 20, y + height - 12);
}

async function prepareImages(
  canvasApi: NapiCanvas,
  data: DailyReportPosterData,
  buffers: ReadonlyMap<string, Buffer>,
): Promise<Map<string, CanvasImage>> {
  const photos = [...data.photos.slice(0, 3), ...data.issues.slice(0, 3).flatMap((issue) => issue.photos.slice(0, 1))];
  const decoded = new Map<string, CanvasImage>();
  await Promise.all(
    photos.map(async (photo) => {
      const buffer = buffers.get(photo.fileId);
      if (buffer === undefined) return;
      try {
        decoded.set(photo.fileId, await canvasApi.loadImage(buffer));
      } catch {
        // 坏图只留占位片，不阻断整张海报。
      }
    }),
  );
  return decoded;
}

/** 渲染入口：images = fileId -> 原图字节；缺图 / 坏图只留占位片，不抛整张海报。 */
export async function renderDailyReportPoster(
  data: DailyReportPosterData,
  images: ReadonlyMap<string, Buffer> = new Map(),
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts, fonts);
  const canvas = canvasApi.createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);
  drawEyebrow(ctx);
  drawDateCard(ctx, data);
  drawProjectTitle(ctx, data);
  drawMeta(ctx, data);
  drawStats(ctx, data);
  drawWork(ctx, data);
  const decoded = await prepareImages(canvasApi, data, images);
  const hasPhotos = drawPhotos(ctx, data, decoded);
  if (!hasPhotos) {
    drawNoPhotosNotice(ctx);
  }
  const lowerTop = hasPhotos ? 840 : 720;
  const lowerHeight = 1082 - lowerTop;
  drawPlanCard(ctx, data, MARGIN, lowerTop, 495, lowerHeight);
  drawIssueCard(ctx, data, decoded, 567, lowerTop, 459, lowerHeight);
  return canvas.toBuffer("image/png");
}
