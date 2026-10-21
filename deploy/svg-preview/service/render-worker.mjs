import { readdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { inspectPng } from "./png-policy.mjs";
import { DEFAULT_LIMITS, SvgPolicyError, inspectSvg } from "./svg-policy.mjs";

const FONTS_DIR = process.env.FONTS_DIR ?? "/app/fonts";
const RESVG_VERSION = "2.6.2";
const HEALTH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#0b6bcb"/><text x="8" y="44" font-size="32" fill="#fff">中</text></svg>';
const HEALTH_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, minLongEdge: 64, maxPixels: 64 * 64 });

function boundedLimit(name, maximum, minimum = 1) {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return maximum;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const limits = {
  ...DEFAULT_LIMITS,
  maxSourceBytes: boundedLimit("SVG_MAX_SOURCE_BYTES", DEFAULT_LIMITS.maxSourceBytes),
  maxOutputBytes: boundedLimit("SVG_MAX_OUTPUT_BYTES", DEFAULT_LIMITS.maxOutputBytes),
  maxLongEdge: boundedLimit("SVG_MAX_LONG_EDGE", DEFAULT_LIMITS.maxLongEdge, DEFAULT_LIMITS.minLongEdge),
  maxPixels: boundedLimit("SVG_MAX_PIXELS", DEFAULT_LIMITS.maxPixels),
  maxAspectRatio: boundedLimit("SVG_MAX_ASPECT_RATIO", DEFAULT_LIMITS.maxAspectRatio),
  maxNaturalEdge: boundedLimit("SVG_MAX_NATURAL_EDGE", DEFAULT_LIMITS.maxNaturalEdge),
  maxElements: boundedLimit("SVG_MAX_ELEMENTS", DEFAULT_LIMITS.maxElements),
};

function render(inspected) {
  const resvg = new Resvg(inspected.text, {
    fitTo: inspected.fitTo,
    font: {
      loadSystemFonts: false,
      fontDirs: [FONTS_DIR],
      defaultFontFamily: "Noto Sans CJK SC",
      serifFamily: "Noto Sans CJK SC",
      sansSerifFamily: "Noto Sans CJK SC",
      cursiveFamily: "Noto Sans CJK SC",
      fantasyFamily: "Noto Sans CJK SC",
      monospaceFamily: "Noto Sans CJK SC",
    },
    dpi: 96,
    languages: ["zh-CN"],
    shapeRendering: 2,
    textRendering: 2,
    logLevel: "error",
  });
  if (resvg.imagesToResolve().length > 0) {
    throw new SvgPolicyError("SVG_EXTERNAL_RESOURCE", "SVG 含待解析的外部图片，已拒绝");
  }
  return Buffer.from(resvg.render().asPng());
}

async function readInput(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new SvgPolicyError("SVG_SOURCE_TOO_LARGE", "SVG 源文件超过安全上限，已拒绝");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function fail(error) {
  const payload = error instanceof SvgPolicyError
    ? { error: error.code, message: error.message }
    : { error: "SVG_RENDER_FAILED", message: "SVG 栅格化失败，已拒绝" };
  process.stderr.write(JSON.stringify(payload), () => process.exit(42));
}

async function main() {
  if (process.argv.includes("--health")) {
    const fonts = readdirSync(FONTS_DIR).filter((name) => name.toLowerCase().endsWith(".ttc"));
    if (fonts.length === 0) throw new SvgPolicyError("FONT_UNAVAILABLE", "固定字体不可用");
    const inspected = inspectSvg(Buffer.from(HEALTH_SVG), {
      ...HEALTH_LIMITS,
      maxLongEdge: Math.min(HEALTH_LIMITS.maxLongEdge, limits.maxLongEdge),
      maxOutputBytes: Math.min(HEALTH_LIMITS.maxOutputBytes, limits.maxOutputBytes),
    });
    const png = render(inspected);
    inspectPng(png, inspected, { ...limits, minLongEdge: 64, maxPixels: 64 * 64 });
    process.stdout.write(JSON.stringify({ ok: true, resvgVersion: RESVG_VERSION, fontFiles: fonts.length }));
    return;
  }
  const bytes = await readInput(limits.maxSourceBytes);
  const inspected = inspectSvg(bytes, limits);
  const png = render(inspected);
  inspectPng(png, inspected, limits);
  process.stdout.write(png);
}

main().catch(fail);
