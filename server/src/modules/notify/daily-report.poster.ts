/**
 * 日报群同步海报（1440px 宽，高度随内容增长）。
 *
 * 设计口径（2026-10-27 业务终稿）：
 * - 两类独立图片：日报海报（项目 / 日期 / 今日完成 / 明日计划 / 全部现场图）与现场问题专报（全部问题 / 处理记录 / 全部问题附图）。
 * - 正文与图片不省略、不截取；长文本自动换行，图片按数量自适应单列、双列或三列画册。
 * - 页眉使用深色底，项目名称直接进入页眉，项目信息使用三张色块卡，不使用报送人和装饰图标。
 * - 随包字体固定为思源黑体 SC Regular / Bold（SIL OFL 1.1），不依赖系统字体或 Noto。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Image as CanvasImage, SKRSContext2D } from "@napi-rs/canvas";
import type {
  DailyReportDigestIssue,
  DailyReportDigestPosterData,
  DailyReportDigestReport,
  DailyReportPosterData,
  DailyReportPosterFontPaths,
  DailyReportPosterIssue,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";
import {
  DAILY_REPORT_DIGEST_ATTACHMENT_NOTICE,
  DAILY_REPORT_DIGEST_TRUNCATION_NOTICE,
  DAILY_REPORT_POSTER_MAX_HEIGHT,
  DAILY_REPORT_POSTER_MAX_THUMBNAILS,
} from "./daily-report.poster.constants.js";

export type {
  DailyReportDigestIssue,
  DailyReportDigestPosterData,
  DailyReportDigestReport,
  DailyReportPosterData,
  DailyReportPosterFontPaths,
  DailyReportPosterIssue,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";

const WIDTH = 1440;
const MARGIN = 80;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const PROJECT_TITLE_WIDTH = 940;
const PAPER = "#F3F0E7";
const INK = "#080D0E";
const NAVY = "#0A171C";
const YELLOW = "#FFC928";
const ORANGE = "#FF673B";
const MUTED = "#4D5754";
const MUTED_LIGHT = "#A7B1AF";
const BADGE_GRAY = "#E4E0D5";
const WHITE = "#FFFFFF";
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

function setFont(ctx: SKRSContext2D, bold: boolean, size: number): void {
  ctx.font = String(size) + "px " + (bold ? FONT_BOLD : FONT_REGULAR);
}

function textWidth(ctx: SKRSContext2D, text: string): number {
  return ctx.measureText(text).width;
}

function spacedWidth(ctx: SKRSContext2D, text: string, spacing: number): number {
  let total = 0;
  for (const char of Array.from(text)) {
    total += ctx.measureText(char).width + spacing;
  }
  return Math.max(0, total - spacing);
}

function drawSpaced(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  color: string,
  align: "left" | "center" | "right" = "left",
): number {
  const width = spacedWidth(ctx, text, spacing);
  let cursor = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
  ctx.fillStyle = color;
  for (const char of Array.from(text)) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + spacing;
  }
  return width;
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = String(text ?? "").replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  const forbidden = "，。！？；：、）】》」』％%";
  for (const paragraph of paragraphs) {
    const clean = paragraph.trim();
    if (clean.length === 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
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
          lines.push(line);
          line = char;
        }
      } else {
        line = candidate;
      }
    }
    if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines : ["未填写"];
}

function wrapTextBalanced(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const original = wrapText(ctx, text, maxWidth);
  if (original.length <= 1) {
    return original;
  }
  let best = original;
  for (let shrink = 8; shrink < maxWidth * 0.32; shrink += 8) {
    const candidate = wrapText(ctx, text, maxWidth - shrink);
    if (candidate.length !== original.length) {
      break;
    }
    best = candidate;
  }
  return best;
}

/**
 * 海报行首编号清洗：日报输入框会自动写「1: 」，用户粘贴或再次输入带号文本时会出现
 * 「1: 1 …」/「2: 2 …」。海报已自己画 01 / 02 徽标，正文只保留业务文字。
 * 只清行首的枚举标记，不动句中数量、日期和纯数字内容。
 */
const DELIMITED_LIST_MARKER =
  /^(?:[（(]\s*(\d{1,2})\s*[)）]|(\d{1,2})\s*[:：.、．)）]|[①-⑳]|[•·]|[-—–])\s*/u;
const BARE_LIST_MARKER = /^([1-9])(?=\s)/u;

export function stripPosterListMarkers(line: string): string {
  let text = line.trim();
  let ordinal: string | null = null;
  let stripped = false;
  for (let guard = 0; guard < 12 && text !== ""; guard += 1) {
    const marked = DELIMITED_LIST_MARKER.exec(text);
    if (marked !== null) {
      ordinal ??= marked[1] ?? marked[2] ?? null;
      text = text.slice(marked[0].length).trimStart();
      stripped = true;
      continue;
    }
    if (ordinal !== null) {
      const repeated = new RegExp("^" + ordinal + "(?=\\s)", "u");
      if (repeated.test(text)) {
        text = text.slice(ordinal.length).trimStart();
        stripped = true;
        continue;
      }
      break;
    }
    const bare = BARE_LIST_MARKER.exec(text);
    if (bare === null) {
      break;
    }
    ordinal = bare[1] ?? null;
    text = text.slice(bare[0].length).trimStart();
    stripped = true;
  }
  return stripped ? text : line.trim();
}

function parseItems(text: string | null): string[] {
  const lines = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cleaned = lines.map(stripPosterListMarkers).filter((line) => line.length > 0);
  return cleaned.length > 0 ? cleaned : ["未填写"];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function reportWeekday(reportDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(reportDate);
  if (match === null) {
    return "";
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(date);
}

function issueStateLabel(state: string): string {
  if (state === "open") {
    return "待处理";
  }
  if (state === "in_progress") {
    return "处理中";
  }
  if (state === "done") {
    return "已完成";
  }
  return state || "未标记";
}

function photoCount(issues: readonly DailyReportPosterIssue[]): number {
  return issues.reduce((sum, issue) => sum + issue.photos.length, 0);
}

async function preparePhotoImages(
  canvasApi: NapiCanvas,
  photos: readonly DailyReportPosterPhoto[],
  buffers: ReadonlyMap<string, Buffer>,
): Promise<Map<string, CanvasImage>> {
  const decoded = new Map<string, CanvasImage>();
  await Promise.all(
    photos.map(async (photo) => {
      if (decoded.has(photo.fileId)) {
        return;
      }
      const buffer = buffers.get(photo.fileId);
      if (buffer === undefined) {
        return;
      }
      try {
        decoded.set(photo.fileId, await canvasApi.loadImage(buffer));
      } catch {
        // 缺图 / 坏图只留占位片，不阻断整张海报。
      }
    }),
  );
  return decoded;
}

function drawImageCover(
  ctx: SKRSContext2D,
  image: CanvasImage,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = Math.max(0, (image.width - sourceWidth) / 2);
  const sourceY = Math.max(0, (image.height - sourceHeight) / 2);
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawImagePlaceholder(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
): void {
  ctx.fillStyle = "#D9DDD8";
  ctx.fillRect(x, y, width, height);
  setFont(ctx, false, 16);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText(label, x + width / 2, y + height / 2 + 6);
  ctx.textAlign = "left";
}

function drawPhoto(
  ctx: SKRSContext2D,
  image: CanvasImage | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  index: number,
  accent: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  if (image === undefined) {
    drawImagePlaceholder(ctx, x, y, width, height, "图片未能载入");
  } else {
    drawImageCover(ctx, image, x, y, width, height);
  }
  ctx.fillStyle = "rgba(8,13,14,0.72)";
  ctx.fillRect(x, y + height - 42, width, 42);
  setFont(ctx, true, 12);
  drawSpaced(ctx, "PHOTO " + pad2(index), x + 16, y + height - 16, 1.4, accent, "left");
  setFont(ctx, false, 13);
  ctx.fillStyle = WHITE;
  ctx.textAlign = "right";
  ctx.fillText(label, x + width - 16, y + height - 15);
  ctx.textAlign = "left";
  ctx.restore();
}

function drawDateBlock(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  fullDate: string,
  weekday: string,
  accent: string,
): void {
  ctx.textAlign = "right";
  setFont(ctx, true, 11);
  drawSpaced(ctx, "日报日期 / REPORT DATE", x + width, y + 17, 1.4, MUTED_LIGHT, "right");
  setFont(ctx, true, 42);
  ctx.fillStyle = WHITE;
  ctx.fillText(fullDate, x + width, y + 76);
  setFont(ctx, true, 14);
  drawSpaced(ctx, weekday, x + width, y + 105, 2.2, accent, "right");
  ctx.textAlign = "left";
}

interface PosterHeaderLayout {
  projectLines: string[];
  headerHeight: number;
}

function layoutPosterHeader(ctx: SKRSContext2D, data: { projectName: string }): PosterHeaderLayout {
  setFont(ctx, true, 34);
  const projectLines = wrapText(ctx, data.projectName, PROJECT_TITLE_WIDTH);
  return {
    projectLines,
    headerHeight: 214 + (projectLines.length - 1) * 40,
  };
}

interface MetaCard {
  label: string;
  value: string;
  fill: string;
  labelColor: string;
  valueColor: string;
  stat: boolean;
}

interface MetaBandOptions {
  accent: string;
  darkCard?: string;
  headcountLabel?: string;
  headcountValue?: string;
}

interface MetaBandLayout {
  cards: MetaCard[];
  widths: number[];
  valueLineSets: string[][];
  cardHeight: number;
  chips: { text: string; x: number; y: number; width: number }[];
  height: number;
}

const META_GAP = 14;
const CHIP_HEIGHT = 34;
const CHIP_GAP = 8;

function layoutMetaBand(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  options: MetaBandOptions,
): MetaBandLayout {
  const accent = options.accent;
  const darkCard = options.darkCard ?? "#0E191C";
  const softCard = "#E2E5DF";
  const availableWidth = CONTENT_WIDTH - META_GAP * 2;
  const widths = [0.32, 0.4, 0.28].map((ratio) => availableWidth * ratio);
  const cards: MetaCard[] = [
    {
      label: "PROJECT CODE / 项目编号",
      value: data.projectCode,
      fill: darkCard,
      labelColor: "#E4ECEC",
      valueColor: WHITE,
      stat: false,
    },
    {
      label: "PROJECT MANAGER / 项目经理",
      value: data.managers.join(" / "),
      fill: softCard,
      labelColor: "#26302D",
      valueColor: INK,
      stat: false,
    },
    {
      label: options.headcountLabel ?? "SITE HEADCOUNT / 现场人数",
      value: options.headcountValue ?? (data.headcount === null ? "— 人" : String(data.headcount) + " 人"),
      fill: accent,
      labelColor: "rgba(16,22,23,0.86)",
      valueColor: "#101617",
      stat: true,
    },
  ];

  setFont(ctx, true, 22);
  const valueLineSets = cards.map((card, index) =>
    card.stat ? [card.value] : wrapText(ctx, card.value, (widths[index] ?? 0) - 36),
  );
  const maxLines = Math.max(...valueLineSets.map((lines) => lines.length));
  const cardHeight = Math.max(104, 62 + maxLines * 28);
  const chipTop = cardHeight + 24;
  const stages = data.stages.length > 0 ? data.stages : ["未关联"];
  const chips: MetaBandLayout["chips"] = [];
  let chipX = MARGIN + 220;
  let chipY = chipTop;
  const maxX = MARGIN + CONTENT_WIDTH;
  for (const stage of stages) {
    setFont(ctx, true, 14);
    const chipWidth = textWidth(ctx, stage) + 30;
    if (chipX > MARGIN + 220 && chipX + chipWidth > maxX) {
      chipX = MARGIN + 220;
      chipY += CHIP_HEIGHT + CHIP_GAP;
    }
    chips.push({ text: stage, x: chipX, y: chipY, width: chipWidth });
    chipX += chipWidth + CHIP_GAP;
  }
  return {
    cards,
    widths,
    valueLineSets,
    cardHeight,
    chips,
    height: cardHeight + 24 + CHIP_HEIGHT + (chipY - chipTop) + 2,
  };
}

function drawMetaBand(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  y: number,
  options: MetaBandOptions,
): number {
  const layout = layoutMetaBand(ctx, data, options);
  let x = MARGIN;
  for (let index = 0; index < layout.cards.length; index += 1) {
    const card = layout.cards[index];
    const width = layout.widths[index] ?? 0;
    if (card === undefined) {
      continue;
    }
    ctx.fillStyle = card.fill;
    ctx.fillRect(x, y, width, layout.cardHeight);
    setFont(ctx, true, 11);
    drawSpaced(ctx, card.label, x + 18, y + 27, 0.6, card.labelColor, "left");
    if (card.stat) {
      const match = /^([0-9.,]+)\s*(.*)$/u.exec(card.value);
      if (match !== null) {
        const number = match[1] ?? "";
        const unit = match[2] ?? "";
        setFont(ctx, true, 42);
        ctx.fillStyle = card.valueColor;
        ctx.fillText(number, x + 18, y + 81);
        const numberWidth = textWidth(ctx, number);
        setFont(ctx, true, 15);
        ctx.fillText(unit, x + 26 + numberWidth, y + 80);
      } else {
        setFont(ctx, true, 22);
        ctx.fillStyle = card.valueColor;
        ctx.fillText(card.value, x + 18, y + 76);
      }
    } else {
      setFont(ctx, true, 22);
      ctx.fillStyle = card.valueColor;
      (layout.valueLineSets[index] ?? []).forEach((line, lineIndex) => {
        ctx.fillText(line, x + 18, y + 61 + lineIndex * 28);
      });
    }
    x += width + META_GAP;
  }

  setFont(ctx, true, 10.5);
  const stageLabelY = y + (layout.chips[0]?.y ?? layout.cardHeight + 24) + 23;
  drawSpaced(ctx, "RELATED STAGE / 关联阶段", MARGIN, stageLabelY, 0.8, INK, "left");
  for (const chip of layout.chips) {
    ctx.fillStyle = "#1B2021";
    ctx.fillRect(chip.x, y + chip.y, chip.width, CHIP_HEIGHT);
    setFont(ctx, true, 14);
    ctx.fillStyle = WHITE;
    ctx.fillText(chip.text, chip.x + 15, y + chip.y + 22);
  }
  return layout.height;
}

function drawSectionHeader(
  ctx: SKRSContext2D,
  y: number,
  index: string,
  title: string,
  english: string,
  accent: string,
  darkText: string,
  layout: { x: number; width: number },
): number {
  const box = 40;
  ctx.fillStyle = accent;
  ctx.fillRect(layout.x, y, box, box);
  setFont(ctx, true, 19);
  ctx.fillStyle = darkText;
  ctx.textAlign = "center";
  ctx.fillText(index, layout.x + box / 2, y + 27);
  ctx.textAlign = "left";
  setFont(ctx, true, 30);
  ctx.fillStyle = INK;
  ctx.fillText(title, layout.x + 56, y + 30);
  setFont(ctx, false, 10);
  drawSpaced(ctx, english, layout.x + layout.width, y + 26, 1.8, MUTED, "right");
  return y + 64;
}

function measureItemsHeight(ctx: SKRSContext2D, items: readonly string[], width: number): number {
  let height = 0;
  for (const item of items) {
    setFont(ctx, false, 26);
    const lines = wrapText(ctx, item, width - 48);
    height += lines.length * 40 + 18;
  }
  return height;
}

function drawItems(
  ctx: SKRSContext2D,
  items: readonly string[],
  y: number,
  layout: { x: number; width: number },
): number {
  let cursor = y;
  for (let index = 0; index < items.length; index += 1) {
    setFont(ctx, false, 26);
    const lines = wrapText(ctx, items[index] ?? "", layout.width - 48);
    const rowHeight = lines.length * 40 + 18;
    ctx.fillStyle = BADGE_GRAY;
    ctx.fillRect(layout.x, cursor + 2, 28, 28);
    setFont(ctx, true, 14);
    ctx.fillStyle = "#101617";
    ctx.textAlign = "center";
    ctx.fillText(pad2(index + 1), layout.x + 14, cursor + 22);
    ctx.textAlign = "left";
    setFont(ctx, false, 26);
    ctx.fillStyle = INK;
    lines.forEach((line, lineIndex) => {
      ctx.fillText(line, layout.x + 46, cursor + 24 + lineIndex * 40);
    });
    cursor += rowHeight;
  }
  return cursor;
}

function dailyGalleryHeight(count: number): number {
  if (count === 0) {
    return 220;
  }
  if (count === 1) {
    return 500;
  }
  if (count === 2) {
    return 360;
  }
  const rows = Math.ceil(count / 3);
  return rows * 260 + Math.max(0, rows - 1) * 16;
}

function drawDailyGallery(
  ctx: SKRSContext2D,
  images: readonly (CanvasImage | undefined)[],
  y: number,
): number {
  const count = images.length;
  if (count === 0) {
    ctx.fillStyle = "#DDE1DC";
    ctx.fillRect(MARGIN, y, CONTENT_WIDTH, 220);
    setFont(ctx, true, 22);
    ctx.fillStyle = INK;
    ctx.fillText("今日未上传现场照片", MARGIN + 26, y + 92);
    setFont(ctx, false, 15);
    ctx.fillStyle = MUTED;
    ctx.fillText("日报文字内容已完整保留，现场影像可在 LibiaoLink 中查看。", MARGIN + 26, y + 128);
    return y + 220;
  }
  if (count === 1) {
    drawPhoto(ctx, images[0], MARGIN, y, CONTENT_WIDTH, 500, "现场照片 01", 1, YELLOW);
    return y + 500;
  }
  if (count === 2) {
    const gap = 16;
    const width = (CONTENT_WIDTH - gap) / 2;
    drawPhoto(ctx, images[0], MARGIN, y, width, 360, "现场照片 01", 1, YELLOW);
    drawPhoto(ctx, images[1], MARGIN + width + gap, y, width, 360, "现场照片 02", 2, YELLOW);
    return y + 360;
  }
  const columns = 3;
  const gap = 16;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const height = 260;
  let cursor = y;
  for (let index = 0; index < images.length; index += columns) {
    for (let column = 0; column < columns; column += 1) {
      const imageIndex = index + column;
      if (imageIndex >= images.length) {
        break;
      }
      drawPhoto(
        ctx,
        images[imageIndex],
        MARGIN + column * (width + gap),
        cursor,
        width,
        height,
        "现场照片 " + pad2(imageIndex + 1),
        imageIndex + 1,
        YELLOW,
      );
    }
    cursor += height + (index + columns < images.length ? 16 : 0);
  }
  return cursor;
}

function drawBottomStripe(ctx: SKRSContext2D, height: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, height - 14, WIDTH, 14);
}

function drawDailyHeader(ctx: SKRSContext2D, data: DailyReportPosterData, layout: PosterHeaderLayout): void {
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, WIDTH, layout.headerHeight);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, 0, WIDTH, 8);

  setFont(ctx, true, 13);
  const brandWidth = drawSpaced(ctx, "LIBIAOLINK", MARGIN, 32, 3.2, YELLOW, "left");
  setFont(ctx, false, 12);
  drawSpaced(
    ctx,
    "/ PROJECT FIELD REPORT",
    MARGIN + brandWidth + 16,
    32,
    1.8,
    MUTED_LIGHT,
    "left",
  );

  setFont(ctx, true, 46);
  ctx.fillStyle = WHITE;
  ctx.fillText("现场日报", MARGIN, 88);
  setFont(ctx, false, 12.5);
  drawSpaced(ctx, "DAILY FIELD REPORT", MARGIN, 111, 3.2, "#93A5AA", "left");

  setFont(ctx, false, 10.5);
  drawSpaced(ctx, "PROJECT / 项目", MARGIN, 151, 1.8, YELLOW, "left");
  setFont(ctx, true, 34);
  ctx.fillStyle = WHITE;
  layout.projectLines.forEach((line, index) => {
    setFont(ctx, true, 34);
    ctx.fillStyle = WHITE;
    ctx.fillText(line, MARGIN, 184 + index * 40);
  });

  drawDateBlock(
    ctx,
    WIDTH - MARGIN - 280,
    30,
    280,
    data.reportDate.replaceAll("-", "."),
    reportWeekday(data.reportDate),
    YELLOW,
  );
  ctx.fillStyle = YELLOW;
  ctx.fillRect(0, layout.headerHeight - 7, WIDTH, 7);
}

/** 日报海报：只含项目信息、今日完成、明日计划与全部现场图；问题另发专报。 */
export async function renderDailyReportPoster(
  data: DailyReportPosterData,
  images: ReadonlyMap<string, Buffer> = new Map(),
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts, fonts);

  const measureCanvas = canvasApi.createCanvas(WIDTH, 1);
  const measureContext = measureCanvas.getContext("2d");
  const header = layoutPosterHeader(measureContext, data);
  const meta = layoutMetaBand(measureContext, data, { accent: YELLOW });
  const doneItems = parseItems(data.doneWork);
  const planItems = parseItems(data.plan);
  const columnGap = 56;
  const columnWidth = (CONTENT_WIDTH - columnGap) / 2;
  const doneHeight = measureItemsHeight(measureContext, doneItems, columnWidth);
  const planHeight = measureItemsHeight(measureContext, planItems, columnWidth);
  const galleryHeight = dailyGalleryHeight(data.photos.length);
  const finalHeight = Math.ceil(
    header.headerHeight +
      34 +
      meta.height +
      48 +
      64 +
      Math.max(doneHeight, planHeight) +
      58 +
      64 +
      galleryHeight +
      58,
  );

  const canvas = canvasApi.createCanvas(WIDTH, finalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, finalHeight);
  drawDailyHeader(ctx, data, header);

  let y = header.headerHeight + 34;
  y += drawMetaBand(ctx, data, y, { accent: YELLOW }) + 48;

  const rightColumnX = MARGIN + columnWidth + columnGap;
  drawSectionHeader(
    ctx,
    y,
    "01",
    "今日完成",
    "WORK COMPLETED TODAY",
    YELLOW,
    INK,
    { x: MARGIN, width: columnWidth },
  );
  const doneBottom = drawItems(ctx, doneItems, y + 64, {
    x: MARGIN,
    width: columnWidth,
  });
  drawSectionHeader(
    ctx,
    y,
    "02",
    "明日计划",
    "NEXT DAY PLAN",
    YELLOW,
    INK,
    { x: rightColumnX, width: columnWidth },
  );
  const planBottom = drawItems(ctx, planItems, y + 64, {
    x: rightColumnX,
    width: columnWidth,
  });
  y = Math.max(doneBottom, planBottom) + 58;

  const decoded = await preparePhotoImages(canvasApi, data.photos, images);
  const galleryImages = data.photos.map((photo) => decoded.get(photo.fileId));
  y = drawSectionHeader(
    ctx,
    y,
    "03",
    "现场纪实",
    "SITE PHOTO EVIDENCE / " + pad2(data.photos.length),
    YELLOW,
    INK,
    { x: MARGIN, width: CONTENT_WIDTH },
  );
  drawDailyGallery(ctx, galleryImages, y);
  drawBottomStripe(ctx, finalHeight, YELLOW);
  return canvas.toBuffer("image/png");
}

function issuePhotosHeight(count: number): number {
  if (count === 0) {
    return 150;
  }
  if (count === 1) {
    return 320;
  }
  if (count === 2) {
    return 180;
  }
  const rows = Math.ceil((count - 1) / 2);
  return 280 + 14 + rows * 180 + Math.max(0, rows - 1) * 14;
}

function drawIssuePhotos(
  ctx: SKRSContext2D,
  images: readonly (CanvasImage | undefined)[],
  x: number,
  y: number,
  width: number,
): number {
  if (images.length === 0) {
    ctx.fillStyle = "#E8E1D9";
    ctx.fillRect(x, y, width, 150);
    setFont(ctx, false, 15);
    ctx.fillStyle = MUTED;
    ctx.fillText("该问题未上传附图", x + 20, y + 84);
    return y + 150;
  }
  if (images.length === 1) {
    drawPhoto(ctx, images[0], x, y, width, 320, "问题附图 01", 1, ORANGE);
    return y + 320;
  }
  if (images.length === 2) {
    const gap = 14;
    const cellWidth = (width - gap) / 2;
    drawPhoto(ctx, images[0], x, y, cellWidth, 180, "问题附图 01", 1, ORANGE);
    drawPhoto(ctx, images[1], x + cellWidth + gap, y, cellWidth, 180, "问题附图 02", 2, ORANGE);
    return y + 180;
  }
  drawPhoto(ctx, images[0], x, y, width, 280, "问题附图 01", 1, ORANGE);
  let cursor = y + 280 + 14;
  const rest = images.slice(1);
  const gap = 14;
  const cellWidth = (width - gap) / 2;
  for (let index = 0; index < rest.length; index += 2) {
    drawPhoto(
      ctx,
      rest[index],
      x,
      cursor,
      cellWidth,
      180,
      "问题附图 " + pad2(index + 2),
      index + 2,
      ORANGE,
    );
    if (rest[index + 1] !== undefined) {
      drawPhoto(
        ctx,
        rest[index + 1],
        x + cellWidth + gap,
        cursor,
        cellWidth,
        180,
        "问题附图 " + pad2(index + 3),
        index + 3,
        ORANGE,
      );
    }
    cursor += 180 + (index + 2 < rest.length ? 14 : 0);
  }
  return cursor;
}

function issueEvidenceHeight(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  width: number,
  allowSideBySide: boolean,
): number {
  const hasSolution = typeof issue.solution === "string" && issue.solution.trim().length > 0;
  if (!hasSolution) {
    return issuePhotosHeight(issue.photos.length);
  }
  setFont(ctx, false, 20);
  if (!allowSideBySide) {
    const solutionLines = wrapText(ctx, issue.solution ?? "", width);
    return 44 + solutionLines.length * 29 + 14 + issuePhotosHeight(issue.photos.length);
  }
  const gap = 28;
  const solutionWidth = Math.floor((width - gap) * 0.42);
  const solutionLines = wrapText(ctx, issue.solution ?? "", solutionWidth);
  const solutionBottom = 45 + Math.max(0, solutionLines.length - 1) * 30 + 14;
  const photoRows = Math.ceil(issue.photos.length / 2);
  const photoBottom = photoRows === 0 ? 22 : 36 + photoRows * 190 + Math.max(0, photoRows - 1) * 14;
  return Math.max(solutionBottom, photoBottom);
}

async function drawIssueEvidence(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  images: readonly (CanvasImage | undefined)[],
  x: number,
  y: number,
  width: number,
  allowSideBySide: boolean,
): Promise<number> {
  const hasSolution = typeof issue.solution === "string" && issue.solution.trim().length > 0;
  if (!hasSolution) {
    return drawIssuePhotos(ctx, images, x, y, width);
  }
  if (!allowSideBySide) {
    setFont(ctx, true, 10.5);
    drawSpaced(ctx, "PROGRESS / 处理记录", x, y + 15, 1.5, ORANGE, "left");
    setFont(ctx, false, 20);
    const solutionLines = wrapText(ctx, issue.solution ?? "", width);
    solutionLines.forEach((line, index) => {
      setFont(ctx, false, 20);
      ctx.fillStyle = INK;
      ctx.fillText(line, x, y + 44 + index * 29);
    });
    const photoTop = y + 44 + solutionLines.length * 29 + 14;
    return drawIssuePhotos(ctx, images, x, photoTop, width);
  }

  const gap = 28;
  const solutionWidth = Math.floor((width - gap) * 0.42);
  const photoWidth = width - gap - solutionWidth;
  setFont(ctx, true, 10.5);
  drawSpaced(ctx, "PROGRESS / 处理记录", x, y + 15, 1.5, ORANGE, "left");
  setFont(ctx, false, 20);
  const solutionLines = wrapText(ctx, issue.solution ?? "", solutionWidth);
  solutionLines.forEach((line, index) => {
    setFont(ctx, false, 20);
    ctx.fillStyle = INK;
    ctx.fillText(line, x, y + 45 + index * 30);
  });
  const solutionBottom = y + 45 + Math.max(0, solutionLines.length - 1) * 30 + 14;

  const photoX = x + solutionWidth + gap;
  setFont(ctx, true, 10.5);
  drawSpaced(ctx, "ATTACHMENTS / 问题附图", photoX, y + 15, 1.5, ORANGE, "left");
  const photoGap = 14;
  const cellWidth = (photoWidth - photoGap) / 2;
  const cellHeight = 190;
  let cursor = y + 36;
  for (let index = 0; index < images.length; index += 2) {
    drawPhoto(
      ctx,
      images[index],
      photoX,
      cursor,
      cellWidth,
      cellHeight,
      "问题附图 " + pad2(index + 1),
      index + 1,
      ORANGE,
    );
    if (images[index + 1] !== undefined) {
      drawPhoto(
        ctx,
        images[index + 1],
        photoX + cellWidth + photoGap,
        cursor,
        cellWidth,
        cellHeight,
        "问题附图 " + pad2(index + 2),
        index + 2,
        ORANGE,
      );
    }
    cursor += cellHeight + 14;
  }
  const photoBottom = cursor - 14;
  return Math.max(solutionBottom, photoBottom);
}

/** 问题标题的首个非空行已有橙色 ISSUE 编号徽标，清掉数据自带的「1: / 2、」前缀；后续行原样保留。 */
export function normalizePosterIssueTitle(title: string): string {
  const lines = String(title ?? "").replace(/\r/g, "").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first >= 0) {
    lines[first] = stripPosterListMarkers(lines[first] ?? "");
  }
  return lines.join("\n");
}

function issueTitleLines(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  contentWidth: number,
): string[] {
  setFont(ctx, true, 27);
  return wrapTextBalanced(ctx, normalizePosterIssueTitle(issue.title), contentWidth);
}

function measureIssueBlockHeight(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  contentWidth: number,
  allowSideBySide: boolean,
): number {
  const titleLines = issueTitleLines(ctx, issue, contentWidth);
  const titleBottom = 58 + Math.max(0, titleLines.length - 1) * 40 + 26;
  return titleBottom + issueEvidenceHeight(ctx, issue, contentWidth, allowSideBySide);
}

async function drawIssueBlock(
  ctx: SKRSContext2D,
  issue: DailyReportPosterIssue,
  index: number,
  decoded: ReadonlyMap<string, CanvasImage>,
  x: number,
  rowY: number,
  issueWidth: number,
  allowSideBySide: boolean,
): Promise<number> {
  const contentX = x + 100;
  const contentWidth = issueWidth - 100;
  setFont(ctx, true, 64);
  ctx.fillStyle = ORANGE;
  ctx.fillText(pad2(index + 1), x, rowY + 52);
  setFont(ctx, false, 9.5);
  drawSpaced(ctx, "ISSUE", x + 2, rowY + 73, 2.4, MUTED, "left");

  setFont(ctx, true, 13);
  const category = issue.categories.length > 0 ? issue.categories.join("  /  ") : "未分类";
  drawSpaced(ctx, category, contentX, rowY + 16, 1.2, ORANGE, "left");
  setFont(ctx, false, 12);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText(
    "责任人  " + (issue.ownerName ?? "待分派") + "    状态  " + issueStateLabel(issue.state),
    x + issueWidth,
    rowY + 16,
  );
  ctx.textAlign = "left";

  const titleLines = issueTitleLines(ctx, issue, contentWidth);
  titleLines.forEach((line, lineIndex) => {
    setFont(ctx, true, 27);
    ctx.fillStyle = INK;
    ctx.fillText(line, contentX, rowY + 58 + lineIndex * 40);
  });
  const issueBottom = rowY + 58 + Math.max(0, titleLines.length - 1) * 40 + 26;
  const issueImages = issue.photos.map((photo) => decoded.get(photo.fileId));
  return await drawIssueEvidence(
    ctx,
    issue,
    issueImages,
    contentX,
    issueBottom,
    contentWidth,
    allowSideBySide,
  );
}

function drawIssueHeader(
  ctx: SKRSContext2D,
  data: DailyReportPosterData,
  layout: PosterHeaderLayout,
): void {
  const totalPhotoCount = photoCount(data.issues);
  ctx.fillStyle = "#0B0E0E";
  ctx.fillRect(0, 0, WIDTH, layout.headerHeight);
  ctx.fillStyle = ORANGE;
  ctx.fillRect(0, 0, WIDTH, 8);

  setFont(ctx, true, 13);
  const brandWidth = drawSpaced(ctx, "LIBIAOLINK", MARGIN, 32, 3.2, ORANGE, "left");
  setFont(ctx, false, 12);
  drawSpaced(ctx, "/ SITE ISSUE BRIEF", MARGIN + brandWidth + 16, 32, 1.8, MUTED_LIGHT, "left");
  setFont(ctx, false, 11);
  drawSpaced(
    ctx,
    "ISSUE LOG / " + data.reportDate.replaceAll("-", "."),
    WIDTH - MARGIN,
    32,
    1.6,
    MUTED_LIGHT,
    "right",
  );

  setFont(ctx, true, 48);
  ctx.fillStyle = WHITE;
  ctx.fillText("现场问题专报", MARGIN, 88);
  setFont(ctx, false, 12.5);
  drawSpaced(ctx, "FIELD ISSUE REPORT", MARGIN, 111, 3.2, "#BEAAA1", "left");

  ctx.textAlign = "right";
  setFont(ctx, false, 10.5);
  drawSpaced(ctx, "OPEN ISSUES", WIDTH - MARGIN, 65, 2.2, MUTED_LIGHT, "right");
  setFont(ctx, true, 68);
  ctx.fillStyle = ORANGE;
  ctx.fillText(pad2(data.issues.length), WIDTH - MARGIN, 127);
  setFont(ctx, false, 11);
  drawSpaced(ctx, pad2(totalPhotoCount) + " PHOTOS", WIDTH - MARGIN, 147, 2.1, MUTED_LIGHT, "right");
  ctx.textAlign = "left";

  setFont(ctx, false, 10.5);
  drawSpaced(ctx, "PROJECT / 项目", MARGIN, 151, 1.8, ORANGE, "left");
  layout.projectLines.forEach((line, index) => {
    setFont(ctx, true, 34);
    ctx.fillStyle = WHITE;
    ctx.fillText(line, MARGIN, 184 + index * 40);
  });

  ctx.fillStyle = ORANGE;
  ctx.fillRect(0, layout.headerHeight - 7, WIDTH, 7);
}

/** 现场问题专报：全部问题、处理记录和问题附图；无问题时 service 不发送此图。 */
export async function renderDailyReportIssuePoster(
  data: DailyReportPosterData,
  images: ReadonlyMap<string, Buffer> = new Map(),
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  ensureFonts(canvasApi.GlobalFonts, fonts);

  const measureCanvas = canvasApi.createCanvas(WIDTH, 1);
  const measureContext = measureCanvas.getContext("2d");
  const header = layoutPosterHeader(measureContext, data);
  const meta = layoutMetaBand(measureContext, data, {
    accent: ORANGE,
    darkCard: "#0B0E0E",
    headcountLabel: "ISSUE PHOTOS / 问题附图",
    headcountValue: String(photoCount(data.issues)) + " 张",
  });
  const issueGap = 52;
  const issueColumns = data.issues.length === 1 ? 1 : 2;
  const issueWidth = issueColumns === 1 ? CONTENT_WIDTH : (CONTENT_WIDTH - issueGap) / 2;
  const contentWidth = issueWidth - 100;
  let y = header.headerHeight + 34 + meta.height + 48;
  if (data.issues.length === 0) {
    y += 190 + 46;
  } else {
    for (let rowStart = 0; rowStart < data.issues.length; rowStart += issueColumns) {
      let rowHeight = 0;
      for (let column = 0; column < issueColumns; column += 1) {
        const issue = data.issues[rowStart + column];
        if (issue === undefined) {
          break;
        }
        rowHeight = Math.max(
          rowHeight,
          measureIssueBlockHeight(measureContext, issue, contentWidth, issueColumns === 1),
        );
      }
      y += rowHeight + (rowStart + issueColumns < data.issues.length ? 58 : 0);
    }
    y += 46;
  }
  const finalHeight = Math.ceil(y);

  const canvas = canvasApi.createCanvas(WIDTH, finalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, finalHeight);
  drawIssueHeader(ctx, data, header);

  y = header.headerHeight + 34;
  y += drawMetaBand(ctx, data, y, {
    accent: ORANGE,
    darkCard: "#0B0E0E",
    headcountLabel: "ISSUE PHOTOS / 问题附图",
    headcountValue: String(photoCount(data.issues)) + " 张",
  }) + 48;

  if (data.issues.length === 0) {
    ctx.fillStyle = "#E8E1D9";
    ctx.fillRect(MARGIN, y, CONTENT_WIDTH, 190);
    setFont(ctx, true, 24);
    ctx.fillStyle = INK;
    ctx.fillText("本日报未关联现场问题", MARGIN + 28, y + 86);
    setFont(ctx, false, 15);
    ctx.fillStyle = MUTED;
    ctx.fillText("问题处理进展以 LibiaoLink 系统记录为准。", MARGIN + 28, y + 121);
  } else {
    const allIssuePhotos = data.issues.flatMap((issue) => issue.photos);
    const decoded = await preparePhotoImages(canvasApi, allIssuePhotos, images);
    for (let rowStart = 0; rowStart < data.issues.length; rowStart += issueColumns) {
      const rowY = y;
      let rowBottom = rowY;
      for (let column = 0; column < issueColumns; column += 1) {
        const index = rowStart + column;
        const issue = data.issues[index];
        if (issue === undefined) {
          break;
        }
        const x = MARGIN + column * (issueWidth + issueGap);
        const bottom = await drawIssueBlock(
          ctx,
          issue,
          index,
          decoded,
          x,
          rowY,
          issueWidth,
          issueColumns === 1,
        );
        rowBottom = Math.max(rowBottom, bottom);
      }
      y = rowBottom + (rowStart + issueColumns < data.issues.length ? 58 : 0);
    }
  }

  drawBottomStripe(ctx, finalHeight, ORANGE);
  return canvas.toBuffer("image/png");
}

const DIGEST_CARD_HEADER = 96;
const DIGEST_CARD_BOTTOM = 28;
const DIGEST_CARD_GAP = 26;
const DIGEST_TEXT_LINE = 32;
const DIGEST_KICKER_FONT_SIZE = 12.5;
const DIGEST_META_FONT_SIZE = 16;
const DIGEST_SECTION_LABEL_FONT_SIZE = 14;
const DIGEST_SECTION_LABEL = 36;
const DIGEST_SECTION_GAP = 18;
const DIGEST_PHOTO_WIDTH = 360;
const DIGEST_PHOTO_HEIGHT = 250;
const DIGEST_PHOTO_GAP = 28;
const DIGEST_ISSUE_HEADER = 104;
const DIGEST_ISSUE_TITLE_LINE = 36;
const DIGEST_ISSUE_SOLUTION_LINE = 30;
const DIGEST_ISSUE_SOURCE_HEIGHT = 30;
const DIGEST_NOTICE_HEIGHT = 92;
const DIGEST_MAX_CONTENT_BOTTOM = DAILY_REPORT_POSTER_MAX_HEIGHT - DIGEST_NOTICE_HEIGHT - 40;
const YELLOW_INK = "#815C00";

interface DigestMetaLayout {
  cards: MetaCard[];
  widths: number[];
  valueLineSets: string[][];
  cardHeight: number;
  height: number;
}

interface DigestLine {
  text: string;
  itemStart: boolean;
}

interface DigestTextFit {
  done: DigestLine[];
  plan: DigestLine[];
  truncated: boolean;
}

interface DigestReportCardLayout {
  report: DailyReportDigestReport;
  index: number;
  photo: DailyReportPosterPhoto | undefined;
  done: DigestLine[];
  plan: DigestLine[];
  textWidth: number;
  textHeight: number;
  bodyHeight: number;
  cardHeight: number;
  truncated: boolean;
}

interface DigestIssueTextFit {
  title: string[];
  solution: DigestLine[];
  truncated: boolean;
}

interface DigestIssueCardLayout {
  issue: DailyReportDigestIssue;
  index: number;
  photo: DailyReportPosterPhoto | undefined;
  title: string[];
  solution: DigestLine[];
  textWidth: number;
  cardHeight: number;
  truncated: boolean;
}

function digestDateTime(value: string | null): string {
  if (value === null || value.trim() === "") return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function layoutDigestMeta(
  ctx: SKRSContext2D,
  data: DailyReportDigestPosterData,
  metricLabel: string,
  metricValue: string,
  accent: string,
): DigestMetaLayout {
  const availableWidth = CONTENT_WIDTH - META_GAP * 2;
  const widths = [0.3, 0.42, 0.28].map((ratio) => availableWidth * ratio);
  const cards: MetaCard[] = [
    {
      label: "PROJECT CODE / 项目编号",
      value: data.projectCode,
      fill: NAVY,
      labelColor: "#E4ECEC",
      valueColor: WHITE,
      stat: false,
    },
    {
      label: "PROJECT MANAGER / 项目经理",
      value: data.managers.length > 0 ? data.managers.join(" / ") : "未设置",
      fill: "#E2E5DF",
      labelColor: "#26302D",
      valueColor: INK,
      stat: false,
    },
    {
      label: metricLabel,
      value: metricValue,
      fill: accent,
      labelColor: "rgba(16,22,23,0.86)",
      valueColor: "#101617",
      stat: true,
    },
  ];
  setFont(ctx, true, 21);
  const valueLineSets = cards.map((card, index) =>
    card.stat ? [card.value] : wrapText(ctx, card.value, (widths[index] ?? 0) - 36),
  );
  const maxLines = Math.max(...valueLineSets.map((lines) => lines.length));
  const cardHeight = Math.max(104, 62 + maxLines * 27);
  return { cards, widths, valueLineSets, cardHeight, height: cardHeight };
}

function drawDigestMetaBand(ctx: SKRSContext2D, layout: DigestMetaLayout, y: number): void {
  let x = MARGIN;
  for (let index = 0; index < layout.cards.length; index += 1) {
    const card = layout.cards[index];
    const width = layout.widths[index] ?? 0;
    if (card === undefined) continue;
    ctx.fillStyle = card.fill;
    ctx.fillRect(x, y, width, layout.cardHeight);
    setFont(ctx, true, 11);
    drawSpaced(ctx, card.label, x + 18, y + 27, 0.6, card.labelColor, "left");
    if (card.stat) {
      const match = /^([0-9.,]+)\s*(.*)$/u.exec(card.value);
      if (match !== null) {
        const number = match[1] ?? "";
        const unit = match[2] ?? "";
        setFont(ctx, true, 42);
        ctx.fillStyle = card.valueColor;
        ctx.fillText(number, x + 18, y + 81);
        const numberWidth = textWidth(ctx, number);
        setFont(ctx, true, 15);
        ctx.fillText(unit, x + 26 + numberWidth, y + 80);
      }
    } else {
      setFont(ctx, true, 21);
      ctx.fillStyle = card.valueColor;
      (layout.valueLineSets[index] ?? []).forEach((line, lineIndex) => {
        ctx.fillText(line, x + 18, y + 61 + lineIndex * 27);
      });
    }
    x += width + META_GAP;
  }
}

function drawDigestHeader(
  ctx: SKRSContext2D,
  data: DailyReportDigestPosterData,
  layout: PosterHeaderLayout,
  kind: "reports" | "issues",
): void {
  const accent = kind === "reports" ? YELLOW : ORANGE;
  const dark = kind === "reports" ? NAVY : "#0B0E0E";
  const title = kind === "reports" ? "现场日报合集" : "现场问题合集";
  const english = kind === "reports" ? "DAILY REPORT DIGEST" : "FIELD ISSUE DIGEST";
  const brandTail = kind === "reports" ? " / REPORT DIGEST" : " / ISSUE DIGEST";
  const countLabel = kind === "reports" ? "SUBMITTED / 已提交" : "ISSUES / 问题总数";
  const count = kind === "reports" ? data.reports.length : data.issues.length;
  const countUnit = kind === "reports" ? " 篇" : " 条";
  const extra =
    kind === "reports"
      ? "DRAFT / 草稿 " + String(data.draftCount) + " 篇"
      : "ATTACHMENTS / 附图 " + String(data.issues.reduce((sum, issue) => sum + issue.photos.length, 0)) + " 张";

  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, WIDTH, layout.headerHeight);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, WIDTH, 8);

  setFont(ctx, true, 13);
  const brandWidth = drawSpaced(ctx, "LIBIAOLINK", MARGIN, 32, 3.2, accent, "left");
  setFont(ctx, false, 12);
  drawSpaced(
    ctx,
    brandTail + " · " + data.projectCode,
    MARGIN + brandWidth + 16,
    32,
    1.6,
    MUTED_LIGHT,
    "left",
  );

  setFont(ctx, true, 46);
  ctx.fillStyle = WHITE;
  ctx.fillText(title, MARGIN, 88);
  setFont(ctx, false, 12.5);
  drawSpaced(ctx, english, MARGIN, 111, 3.2, "#93A5AA", "left");

  drawDateBlock(
    ctx,
    WIDTH - MARGIN - 280,
    30,
    280,
    data.reportDate.replaceAll("-", "."),
    reportWeekday(data.reportDate),
    accent,
  );
  setFont(ctx, false, 10.5);
  drawSpaced(ctx, countLabel, WIDTH - MARGIN, 166, 1.8, MUTED_LIGHT, "right");
  setFont(ctx, true, 30);
  ctx.fillStyle = accent;
  ctx.textAlign = "right";
  ctx.fillText(String(count) + countUnit, WIDTH - MARGIN, 199);
  ctx.textAlign = "left";
  setFont(ctx, false, 11);
  drawSpaced(ctx, extra, WIDTH - MARGIN, 224, 1.2, MUTED_LIGHT, "right");

  setFont(ctx, false, 10.5);
  drawSpaced(ctx, "PROJECT / 项目", MARGIN, 151, 1.8, accent, "left");
  layout.projectLines.forEach((line, index) => {
    setFont(ctx, true, 34);
    ctx.fillStyle = WHITE;
    ctx.fillText(line, MARGIN, 184 + index * 40);
  });

  ctx.fillStyle = accent;
  ctx.fillRect(0, layout.headerHeight - 7, WIDTH, 7);
}

function buildDigestLines(ctx: SKRSContext2D, text: string | null, width: number): DigestLine[] {
  const lines: DigestLine[] = [];
  setFont(ctx, false, 19);
  for (const item of parseItems(text)) {
    const wrapped = wrapText(ctx, item, width - 22);
    wrapped.forEach((line, index) => lines.push({ text: line, itemStart: index === 0 }));
  }
  return lines;
}

function ellipsizeToWidth(ctx: SKRSContext2D, text: string, width: number): string {
  const characters = Array.from(text);
  let candidate = text + "…";
  while (characters.length > 0 && textWidth(ctx, candidate) > width) {
    characters.pop();
    candidate = characters.join("") + "…";
  }
  return candidate;
}

function ellipsizeDigestLine(
  ctx: SKRSContext2D,
  line: DigestLine,
  width: number,
  bold = false,
  size = 19,
): DigestLine {
  setFont(ctx, bold, size);
  return { ...line, text: ellipsizeToWidth(ctx, line.text, width - 22) };
}

function fitDigestText(
  ctx: SKRSContext2D,
  done: readonly DigestLine[],
  plan: readonly DigestLine[],
  width: number,
  maxRows: number,
): DigestTextFit {
  const rows = Math.max(2, maxRows);
  if (done.length + plan.length <= rows) {
    return { done: [...done], plan: [...plan], truncated: false };
  }
  let doneCount = Math.min(done.length, Math.max(1, Math.ceil(rows * 0.6)));
  let planCount = Math.min(plan.length, Math.max(1, rows - doneCount));
  while (doneCount + planCount > rows) {
    if (doneCount >= planCount && doneCount > 1) {
      doneCount -= 1;
    } else if (planCount > 1) {
      planCount -= 1;
    } else {
      break;
    }
  }
  let unused = rows - doneCount - planCount;
  while (unused > 0 && doneCount < done.length) {
    doneCount += 1;
    unused -= 1;
  }
  while (unused > 0 && planCount < plan.length) {
    planCount += 1;
    unused -= 1;
  }
  const doneVisible = done.slice(0, doneCount);
  const planVisible = plan.slice(0, planCount);
  if (doneCount < done.length && doneVisible.length > 0) {
    doneVisible[doneVisible.length - 1] = ellipsizeDigestLine(ctx, doneVisible[doneVisible.length - 1]!, width, false, 19);
  }
  if (planCount < plan.length && planVisible.length > 0) {
    planVisible[planVisible.length - 1] = ellipsizeDigestLine(ctx, planVisible[planVisible.length - 1]!, width, false, 19);
  }
  return { done: doneVisible, plan: planVisible, truncated: true };
}

function layoutDigestReportCard(
  ctx: SKRSContext2D,
  report: DailyReportDigestReport,
  index: number,
  maxBodyHeight: number,
  photo: DailyReportPosterPhoto | undefined,
): DigestReportCardLayout {
  const textWidth =
    CONTENT_WIDTH - 128 - (photo === undefined ? 0 : DIGEST_PHOTO_WIDTH + DIGEST_PHOTO_GAP);
  const done = buildDigestLines(ctx, report.doneWork, textWidth);
  const plan = buildDigestLines(ctx, report.plan, textWidth);
  const fixedHeight = DIGEST_SECTION_LABEL * 2 + DIGEST_SECTION_GAP;
  const rows = Math.max(2, Math.floor((maxBodyHeight - fixedHeight) / DIGEST_TEXT_LINE));
  const fitted = fitDigestText(ctx, done, plan, textWidth, rows);
  const textHeight = fixedHeight + (fitted.done.length + fitted.plan.length) * DIGEST_TEXT_LINE;
  const bodyHeight = Math.max(textHeight, photo === undefined ? 0 : DIGEST_PHOTO_HEIGHT);
  return {
    report,
    index,
    photo,
    done: fitted.done,
    plan: fitted.plan,
    textWidth,
    textHeight,
    bodyHeight,
    cardHeight: DIGEST_CARD_HEADER + bodyHeight + DIGEST_CARD_BOTTOM,
    truncated: fitted.truncated,
  };
}

function drawDigestSectionLabel(
  ctx: SKRSContext2D,
  label: string,
  x: number,
  y: number,
  accent: string,
): void {
  ctx.fillStyle = accent;
  ctx.fillRect(x, y + 7, 22, 7);
  setFont(ctx, true, DIGEST_SECTION_LABEL_FONT_SIZE);
  drawSpaced(ctx, label, x + 30, y + 18, 1.2, MUTED, "left");
}

function drawDigestLines(
  ctx: SKRSContext2D,
  lines: readonly DigestLine[],
  x: number,
  y: number,
  accent: string,
): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.itemStart) {
      ctx.fillStyle = accent;
      ctx.fillRect(x, y + index * DIGEST_TEXT_LINE + 11, 6, 6);
    }
    setFont(ctx, false, 19);
    ctx.fillStyle = INK;
    ctx.fillText(line.text, x + 22, y + index * DIGEST_TEXT_LINE + 20);
  }
  return y + lines.length * DIGEST_TEXT_LINE;
}

function drawDigestReportCard(
  ctx: SKRSContext2D,
  layout: DigestReportCardLayout,
  y: number,
  decoded: ReadonlyMap<string, CanvasImage>,
): void {
  ctx.fillStyle = "#E9E5DA";
  ctx.fillRect(MARGIN, y, CONTENT_WIDTH, layout.cardHeight);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(MARGIN, y, 8, layout.cardHeight);

  setFont(ctx, true, 44);
  ctx.fillStyle = YELLOW_INK;
  ctx.fillText(pad2(layout.index + 1), MARGIN + 28, y + 57);
  setFont(ctx, true, DIGEST_KICKER_FONT_SIZE);
  drawSpaced(ctx, "REPORT", MARGIN + 30, y + 78, 1.8, MUTED, "left");

  const contentX = MARGIN + 100;
  const author = layout.report.authorName ?? "未记录填写者";
  setFont(ctx, true, 25);
  ctx.fillStyle = INK;
  ctx.fillText(author, contentX, y + 38);
  if (layout.report.state === "supplement") {
    const authorWidth = textWidth(ctx, author);
    const badgeX = contentX + authorWidth + 14;
    ctx.fillStyle = YELLOW;
    ctx.fillRect(badgeX, y + 17, 58, 28);
    setFont(ctx, true, 13);
    ctx.fillStyle = INK;
    ctx.fillText("补填", badgeX + 15, y + 37);
  }
  setFont(ctx, false, 12.5);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("提交  " + digestDateTime(layout.report.submittedAt), MARGIN + CONTENT_WIDTH - 28, y + 37);
  ctx.textAlign = "left";
  setFont(ctx, false, DIGEST_META_FONT_SIZE);
  ctx.fillStyle = MUTED;
  const headcount = layout.report.headcount === null ? "人数未填" : String(layout.report.headcount) + " 人";
  const stages = layout.report.stages.length > 0 ? layout.report.stages.join(" / ") : "未关联阶段";
  ctx.fillText(headcount + "  ·  " + stages, contentX, y + 70);

  const bodyY = y + DIGEST_CARD_HEADER;
  drawDigestSectionLabel(ctx, "DONE / 当日完成", contentX, bodyY, YELLOW_INK);
  const doneBottom = drawDigestLines(ctx, layout.done, contentX, bodyY + DIGEST_SECTION_LABEL, YELLOW_INK);
  const planY = doneBottom + DIGEST_SECTION_GAP;
  drawDigestSectionLabel(ctx, "PLAN / 明日计划", contentX, planY, YELLOW_INK);
  drawDigestLines(
    ctx,
    layout.plan,
    contentX,
    planY + DIGEST_SECTION_LABEL,
    YELLOW_INK,
  );
  if (layout.photo !== undefined) {
    const photoX = MARGIN + CONTENT_WIDTH - 28 - DIGEST_PHOTO_WIDTH;
    const image = decoded.get(layout.photo.fileId);
    drawPhoto(
      ctx,
      image,
      photoX,
      bodyY,
      DIGEST_PHOTO_WIDTH,
      DIGEST_PHOTO_HEIGHT,
      "现场缩略图",
      layout.index + 1,
      YELLOW,
    );
  }
}

function drawDigestTruncationNotice(ctx: SKRSContext2D, y: number, message: string): void {
  ctx.fillStyle = "#11191B";
  ctx.fillRect(MARGIN, y, CONTENT_WIDTH, DIGEST_NOTICE_HEIGHT - 20);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(MARGIN, y, 8, DIGEST_NOTICE_HEIGHT - 20);
  setFont(ctx, true, 17);
  ctx.fillStyle = WHITE;
  ctx.fillText("CONTENT NOTICE / 内容提示", MARGIN + 28, y + 30);
  setFont(ctx, false, 16);
  ctx.fillStyle = "#D8E0DF";
  ctx.fillText(message, MARGIN + 28, y + 57);
}

async function drawDigestReportPoster(
  canvasApi: NapiCanvas,
  data: DailyReportDigestPosterData,
  images: ReadonlyMap<string, Buffer>,
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  ensureFonts(canvasApi.GlobalFonts, fonts);
  const measureCanvas = canvasApi.createCanvas(WIDTH, 1);
  const measureContext = measureCanvas.getContext("2d");
  const header = layoutDigestHeader(measureContext, data);
  const meta = layoutDigestMeta(
    measureContext,
    data,
    "SUBMITTED / 已提交日报",
    String(data.reports.length) + " 篇",
    YELLOW,
  );
  const cards: DigestReportCardLayout[] = [];
  let photoBudget = DAILY_REPORT_POSTER_MAX_THUMBNAILS;
  let cursor = header.headerHeight + 34 + meta.height + 48;
  let contentTruncated = false;
  let attachmentsLimited = false;
  for (let index = 0; index < data.reports.length; index += 1) {
    const report = data.reports[index];
    if (report === undefined) continue;
    const photo = photoBudget > 0 ? report.photos[0] : undefined;
    const maxBodyHeight = DIGEST_MAX_CONTENT_BOTTOM - cursor - DIGEST_CARD_HEADER - DIGEST_CARD_BOTTOM;
    const minimumBodyHeight = photo === undefined ? 158 : DIGEST_PHOTO_HEIGHT;
    if (maxBodyHeight < minimumBodyHeight) {
      contentTruncated = true;
      break;
    }
    const card = layoutDigestReportCard(measureContext, report, index, maxBodyHeight, photo);
    cards.push(card);
    if (card.truncated) contentTruncated = true;
    if (report.photos.length > (photo === undefined ? 0 : 1)) attachmentsLimited = true;
    if (photo !== undefined) photoBudget -= 1;
    cursor += card.cardHeight + DIGEST_CARD_GAP;
  }
  if (cards.length < data.reports.length) contentTruncated = true;
  const limited = contentTruncated || attachmentsLimited;
  const finalHeight = Math.ceil(
    Math.min(
      DAILY_REPORT_POSTER_MAX_HEIGHT,
      limited ? cursor + DIGEST_NOTICE_HEIGHT + 10 : cursor + 30,
    ),
  );

  const canvas = canvasApi.createCanvas(WIDTH, finalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, finalHeight);
  drawDigestHeader(ctx, data, header, "reports");
  let y = header.headerHeight + 34;
  drawDigestMetaBand(ctx, meta, y);
  y += meta.height + 48;

  const usedPhotos = cards.flatMap((card) => (card.photo === undefined ? [] : [card.photo]));
  const decoded = await preparePhotoImages(canvasApi, usedPhotos, images);
  for (const card of cards) {
    drawDigestReportCard(ctx, card, y, decoded);
    y += card.cardHeight + DIGEST_CARD_GAP;
  }
  if (limited) {
    drawDigestTruncationNotice(
      ctx,
      y,
      contentTruncated ? DAILY_REPORT_DIGEST_TRUNCATION_NOTICE : DAILY_REPORT_DIGEST_ATTACHMENT_NOTICE,
    );
  }
  drawBottomStripe(ctx, finalHeight, YELLOW);
  return canvas.toBuffer("image/png");
}

function layoutDigestHeader(
  ctx: SKRSContext2D,
  data: DailyReportDigestPosterData,
): PosterHeaderLayout {
  setFont(ctx, true, 34);
  const projectLines = wrapText(ctx, data.projectName, PROJECT_TITLE_WIDTH);
  return { projectLines, headerHeight: 244 + (projectLines.length - 1) * 40 };
}

function digestIssueTitleLines(
  ctx: SKRSContext2D,
  issue: DailyReportDigestIssue,
  width: number,
): string[] {
  setFont(ctx, true, 27);
  return wrapTextBalanced(ctx, normalizePosterIssueTitle(issue.title), width);
}

function fitDigestIssueText(
  ctx: SKRSContext2D,
  issue: DailyReportDigestIssue,
  width: number,
  maxBodyHeight: number,
): DigestIssueTextFit {
  const fullTitle = digestIssueTitleLines(ctx, issue, width);
  const solutionText = issue.solution !== null && issue.solution.trim() !== "" ? issue.solution : "暂无处理记录";
  const fullSolution = buildDigestLines(ctx, solutionText, width);
  const fixedHeight = DIGEST_SECTION_LABEL + DIGEST_ISSUE_SOURCE_HEIGHT + 28;
  const available = Math.max(66, maxBodyHeight - fixedHeight);
  const fullHeight = fullTitle.length * DIGEST_ISSUE_TITLE_LINE + fullSolution.length * DIGEST_ISSUE_SOLUTION_LINE;
  if (fullHeight <= available) {
    return { title: fullTitle, solution: fullSolution, truncated: false };
  }

  let titleCount = Math.max(
    1,
    Math.min(fullTitle.length, Math.floor((available * 0.42) / DIGEST_ISSUE_TITLE_LINE)),
  );
  let solutionCount = Math.max(
    1,
    Math.min(
      fullSolution.length,
      Math.floor((available - titleCount * DIGEST_ISSUE_TITLE_LINE) / DIGEST_ISSUE_SOLUTION_LINE),
    ),
  );
  let unused = available - titleCount * DIGEST_ISSUE_TITLE_LINE - solutionCount * DIGEST_ISSUE_SOLUTION_LINE;
  while (unused >= DIGEST_ISSUE_TITLE_LINE && titleCount < fullTitle.length) {
    titleCount += 1;
    unused -= DIGEST_ISSUE_TITLE_LINE;
  }
  while (unused >= DIGEST_ISSUE_SOLUTION_LINE && solutionCount < fullSolution.length) {
    solutionCount += 1;
    unused -= DIGEST_ISSUE_SOLUTION_LINE;
  }
  while (titleCount > 1 && titleCount * DIGEST_ISSUE_TITLE_LINE + solutionCount * DIGEST_ISSUE_SOLUTION_LINE > available) {
    titleCount -= 1;
  }
  while (solutionCount > 1 && titleCount * DIGEST_ISSUE_TITLE_LINE + solutionCount * DIGEST_ISSUE_SOLUTION_LINE > available) {
    solutionCount -= 1;
  }

  const title = fullTitle.slice(0, titleCount);
  if (titleCount < fullTitle.length && title.length > 0) {
    setFont(ctx, true, 27);
    title[title.length - 1] = ellipsizeToWidth(ctx, title[title.length - 1] ?? "", width);
  }
  const solution = fullSolution.slice(0, solutionCount);
  if (solutionCount < fullSolution.length && solution.length > 0) {
    solution[solution.length - 1] = ellipsizeDigestLine(ctx, solution[solution.length - 1]!, width, false, 19);
  }
  return {
    title,
    solution,
    truncated: titleCount < fullTitle.length || solutionCount < fullSolution.length,
  };
}

function layoutDigestIssueCard(
  ctx: SKRSContext2D,
  issue: DailyReportDigestIssue,
  index: number,
  maxBodyHeight: number,
  photo: DailyReportPosterPhoto | undefined,
): DigestIssueCardLayout {
  const textWidth =
    CONTENT_WIDTH - 128 - (photo === undefined ? 0 : DIGEST_PHOTO_WIDTH + DIGEST_PHOTO_GAP);
  const fitted = fitDigestIssueText(ctx, issue, textWidth, maxBodyHeight);
  const textHeight =
    fitted.title.length * DIGEST_ISSUE_TITLE_LINE +
    14 +
    DIGEST_SECTION_LABEL +
    fitted.solution.length * DIGEST_ISSUE_SOLUTION_LINE +
    14 +
    DIGEST_ISSUE_SOURCE_HEIGHT;
  const bodyHeight = Math.max(textHeight, photo === undefined ? 0 : DIGEST_PHOTO_HEIGHT);
  return {
    issue,
    index,
    photo,
    title: fitted.title,
    solution: fitted.solution,
    textWidth,
    cardHeight: DIGEST_ISSUE_HEADER + bodyHeight + DIGEST_CARD_BOTTOM,
    truncated: fitted.truncated,
  };
}

function drawDigestIssueCard(
  ctx: SKRSContext2D,
  layout: DigestIssueCardLayout,
  y: number,
  decoded: ReadonlyMap<string, CanvasImage>,
): void {
  ctx.fillStyle = "#ECE5DF";
  ctx.fillRect(MARGIN, y, CONTENT_WIDTH, layout.cardHeight);
  ctx.fillStyle = ORANGE;
  ctx.fillRect(MARGIN, y, 8, layout.cardHeight);

  setFont(ctx, true, 58);
  ctx.fillStyle = ORANGE;
  ctx.fillText(pad2(layout.index + 1), MARGIN + 28, y + 58);
  setFont(ctx, true, DIGEST_KICKER_FONT_SIZE);
  drawSpaced(ctx, "ISSUE", MARGIN + 30, y + 79, 1.8, MUTED, "left");

  const contentX = MARGIN + 100;
  setFont(ctx, true, 13);
  ctx.fillStyle = ORANGE;
  const category = layout.issue.categories.length > 0 ? layout.issue.categories.join("  /  ") : "未分类";
  drawSpaced(ctx, category, contentX, y + 28, 1.1, ORANGE, "left");
  setFont(ctx, false, 12);
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText(
    "责任人  " + (layout.issue.ownerName ?? "待分派") + "    状态  " + issueStateLabel(layout.issue.state),
    MARGIN + CONTENT_WIDTH - 28,
    y + 28,
  );
  ctx.textAlign = "left";

  const bodyY = y + DIGEST_ISSUE_HEADER;
  layout.title.forEach((line, index) => {
    setFont(ctx, true, 27);
    ctx.fillStyle = INK;
    ctx.fillText(line, contentX, bodyY + 27 + index * DIGEST_ISSUE_TITLE_LINE);
  });
  const solutionLabelY = bodyY + layout.title.length * DIGEST_ISSUE_TITLE_LINE + 14;
  drawDigestSectionLabel(ctx, "PROGRESS / 解决方案", contentX, solutionLabelY, ORANGE);
  const solutionBottom = drawDigestLines(
    ctx,
    layout.solution,
    contentX,
    solutionLabelY + DIGEST_SECTION_LABEL,
    ORANGE,
  );
  const sourceY = solutionBottom + 18;
  const source = layout.issue.sourceReport;
  const sourceText =
    source === null
      ? "手工登记 · 问题日期 " + layout.issue.raisedAt
      : "来源日报 · " + (source.authorName ?? "未记录填写者") + " · " + digestDateTime(source.submittedAt);
  setFont(ctx, false, 13);
  ctx.fillStyle = MUTED;
  ctx.fillText(sourceText, contentX, sourceY + 17);

  if (layout.photo !== undefined) {
    const photoX = MARGIN + CONTENT_WIDTH - 28 - DIGEST_PHOTO_WIDTH;
    const image = decoded.get(layout.photo.fileId);
    drawPhoto(
      ctx,
      image,
      photoX,
      bodyY,
      DIGEST_PHOTO_WIDTH,
      DIGEST_PHOTO_HEIGHT,
      "问题缩略图",
      layout.index + 1,
      ORANGE,
    );
  }
}

async function drawDigestIssuePoster(
  canvasApi: NapiCanvas,
  data: DailyReportDigestPosterData,
  images: ReadonlyMap<string, Buffer>,
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  ensureFonts(canvasApi.GlobalFonts, fonts);
  const measureCanvas = canvasApi.createCanvas(WIDTH, 1);
  const measureContext = measureCanvas.getContext("2d");
  const header = layoutDigestHeader(measureContext, data);
  const meta = layoutDigestMeta(
    measureContext,
    data,
    "ISSUES / 当日问题",
    String(data.issues.length) + " 条",
    ORANGE,
  );
  const cards: DigestIssueCardLayout[] = [];
  let photoBudget = DAILY_REPORT_POSTER_MAX_THUMBNAILS;
  let cursor = header.headerHeight + 34 + meta.height + 48;
  let contentTruncated = false;
  let attachmentsLimited = false;
  if (data.issues.length === 0) {
    cursor += 190 + 30;
  } else {
    for (let index = 0; index < data.issues.length; index += 1) {
      const issue = data.issues[index];
      if (issue === undefined) continue;
      const photo = photoBudget > 0 ? issue.photos[0] : undefined;
      const maxBodyHeight = DIGEST_MAX_CONTENT_BOTTOM - cursor - DIGEST_ISSUE_HEADER - DIGEST_CARD_BOTTOM;
      const minimumBodyHeight = photo === undefined ? 158 : DIGEST_PHOTO_HEIGHT;
      if (maxBodyHeight < minimumBodyHeight) {
        contentTruncated = true;
        break;
      }
      const card = layoutDigestIssueCard(measureContext, issue, index, maxBodyHeight, photo);
      cards.push(card);
      if (card.truncated) contentTruncated = true;
      if (issue.photos.length > (photo === undefined ? 0 : 1)) attachmentsLimited = true;
      if (photo !== undefined) photoBudget -= 1;
      cursor += card.cardHeight + DIGEST_CARD_GAP;
    }
    if (cards.length < data.issues.length) contentTruncated = true;
  }
  const limited = contentTruncated || attachmentsLimited;
  const finalHeight = Math.ceil(
    Math.min(
      DAILY_REPORT_POSTER_MAX_HEIGHT,
      limited ? cursor + DIGEST_NOTICE_HEIGHT + 10 : cursor + 30,
    ),
  );

  const canvas = canvasApi.createCanvas(WIDTH, finalHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, finalHeight);
  drawDigestHeader(ctx, data, header, "issues");
  let y = header.headerHeight + 34;
  drawDigestMetaBand(ctx, meta, y);
  y += meta.height + 48;

  if (data.issues.length === 0) {
    ctx.fillStyle = "#E8E1D9";
    ctx.fillRect(MARGIN, y, CONTENT_WIDTH, 190);
    setFont(ctx, true, 24);
    ctx.fillStyle = INK;
    ctx.fillText("本日报未关联现场问题", MARGIN + 28, y + 86);
    setFont(ctx, false, 15);
    ctx.fillStyle = MUTED;
    ctx.fillText("问题处理进展以 LibiaoLink 系统记录为准。", MARGIN + 28, y + 121);
  } else {
    const usedPhotos = cards.flatMap((card) => (card.photo === undefined ? [] : [card.photo]));
    const decoded = await preparePhotoImages(canvasApi, usedPhotos, images);
    for (const card of cards) {
      drawDigestIssueCard(ctx, card, y, decoded);
      y += card.cardHeight + DIGEST_CARD_GAP;
    }
    if (limited) {
      drawDigestTruncationNotice(
        ctx,
        y,
        contentTruncated ? DAILY_REPORT_DIGEST_TRUNCATION_NOTICE : DAILY_REPORT_DIGEST_ATTACHMENT_NOTICE,
      );
    }
  }
  drawBottomStripe(ctx, finalHeight, ORANGE);
  return canvas.toBuffer("image/png");
}

/** 多篇日报合集：每篇只带首张现场缩略图，整图附件最多 8 张，超预算显示深链提示。 */
export async function renderDailyReportDigestPoster(
  data: DailyReportDigestPosterData,
  images: ReadonlyMap<string, Buffer> = new Map(),
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  return await drawDigestReportPoster(canvasApi, data, images, fonts);
}

/** 当天问题合集：每个问题只带首张附图，整图附件最多 8 张；0 篇日报也复用该渲染器。 */
export async function renderDailyReportIssueDigestPoster(
  data: DailyReportDigestPosterData,
  images: ReadonlyMap<string, Buffer> = new Map(),
  fonts?: DailyReportPosterFontPaths,
): Promise<Buffer> {
  const canvasApi = await loadCanvasApi();
  return await drawDigestIssuePoster(canvasApi, data, images, fonts);
}
