import { useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ChangeWord, DashboardChangeWords } from "../data/changeWords";
import { useT } from "../i18n";

/**
 * 仪表盘「词频图」视图（Push 353 · 业务口径 2026-10-16「现在做这个词频图 根据变更原因的词频拼成这个图」+
 * 「词频图中修饰词不纳入 只保留核心词纳入词频图」+「我们的词频图也要拼凑出形状」+
 * 「不需要每个都可以点击只有最中间的需要」）：
 *
 * 变更原因核心词词云 —— 落位算法参照开源 d3-cloud / wordcloud2.js 的「画布像素蒙版碰撞 + 阿基米德螺线」
 * 方案（未引入依赖，按同一套算法在本组件内实现）：
 * 1. 每个词先在离屏画布上画出像素蒙版（按 1/4 分辨率收成位图），再沿「画布正中向外的螺线」逐点试探，
 *    第一个与已落位词像素不重叠的位置即词位 —— 词与词严丝合缝，拼出参考图那种「中间实、边缘散」的词团形状；
 * 2. 主实例（每个核心词的第一枚）：字号按词频单调映射（词频最高的词最大、占正中），按字号从大到小先落位 ——
 *    保证每个核心词都在图上（实在挤不下才逐档收小，兜底 14px）；
 * 3. 重复实例（词频第 2 枚起）：字号 = 主字号 x 0.45 起逐枚 x0.78 递减，填进主实例之间的缝里 ——
 *    词的疏密即词频；放不下就跳（只是纹理，不伤口径）；
 * 4. 边缘渐隐：离画布中心越远 fill-opacity 越低（最外圈 0.38），词团边缘像参考图一样虚化；
 * 5. 悬停任意词出浮层卡（词 + 词频）；每一枚核心词的「主枚」（每词最中间的那一枚）都可点、重复小枚不可点
 *    （data-drill 只有各词主枚 true）—— 点开该词的只读「数据详情」；「全部项目」下（混合来源）谁都不可点。
 *
 * Push 355（2026-10-16 业务口径「要这样的效果」参考录屏）追订「悬停聚焦」：悬停某一枚词时它自己保持原样、
 * 其余每一枚（含同词的其他重复实例 —— 按「枚」不按「词」）统一压暗到自身饱和度的 30%（fill-opacity 220ms 过渡，
 * 最淡的枚兜底 0.12 仍可辨形）；移开即还原。旧「悬停压深 brightness(0.84)」一并撤掉 —— 录屏里悬停枚的像素与常态完全一致（无压深）。
 *
 * Push 356（2026-10-16 业务口径「现在为什么只有原因可以点击了 这不符合我的要求啊」）：可点面由「只有正中一枚」
 * 扩到「每词主枚」—— 落位时给每枚主实例标 primary，交互只认 primary（不再只认词频最高的那枚 center）；
 * PlacedWord 新增 primary 字段（center 保留作词团正中的元信息）。
 *
 * 布局是确定性的（螺线相位由实例序号哈希出，同一份词频永远得到同一张图，刷新不跳版）。
 * 画布 1200 x 596（与其他视图同款 viewBox，等比缩放填满面板）。
 * 口径（分词 / 计数 / 词表）见 data/changeWords.ts。
 */

const VIEW_W = 1200;
const VIEW_H = 596;
/** 画布内边距（词不与白卡边缘相贴）。 */
const PADDING = 14;
/** 词与词之间的像素缝（蒙版外扩量，三点即可贴而不糊）。 */
const WORD_GAP = 3;
/** 像素蒙版分辨率倍率（1 / COLLIDE_SCALE；兼顾紧凑度与开销）。 */
const COLLIDE_SCALE = 4;
/** 粗网格倍率（COLLIDE_SCALE 的 4 倍；整块占满即可先判碰撞，省逐像素）。 */
const COARSE_MULT = 4;
/** 主实例基准字号区间（词频最高 = MAX_SIZE 封顶，词频 1 不低于 MIN_SIZE）。 */
const MIN_SIZE = 20;
const MAX_SIZE = 150;
/** 主实例字号曲线指数（小于 1：中低频词也撑得起形状）。 */
const SIZE_EXPONENT = 0.459;
/** 重复实例系数（主字号 x REPEAT_FACTOR 起逐枚 xREPEAT_SHRINK，最低 REPEAT_MIN_SIZE）。 */
const REPEAT_FACTOR = 0.45;
const REPEAT_SHRINK = 0.78;
const REPEAT_MIN_SIZE = 11;
/** 单词语义上限 / 整图上限（防极端数据）。 */
const MAX_COPIES_PER_WORD = 40;
const MAX_INSTANCES_TOTAL = 560;
/** 主实例 / 重复实例挤不下时逐档收小的档距与下限（主实例兜底保每个词都在）。 */
const SHRINK_STEP = 0.86;
const PRIMARY_FLOOR_SIZE = 14;
const REPEAT_FLOOR_SIZE = 10;
/** 螺线参数（归一化坐标系：s = 1 即画布内切椭圆边缘）。 */
const SPIRAL_MAX_S = 1.06;
const SPIRAL_RING_GAP = 0.012;
const SPIRAL_ARC_STEP = 0.006;
const GOLDEN_ANGLE = 2.39996323;
/** 与全局正文字体一致（画布蒙版与 SVG 渲染必须同字体，碰撞才准）。 */
const FONT_STACK = "\"PingFang SC\", \"Microsoft YaHei\", system-ui, -apple-system, sans-serif";

/** 配色（业务参考图同族：蓝 / 天蓝 / 绿 / 琥珀 / 橙 / 紫 / 玫红 / 青 / 黄绿 / 蓝灰，按词固定循环）。 */
const WORD_COLORS: readonly string[] = ["#2f7ef2", "#0ea5e9", "#16a34a", "#f5a623", "#ea580c", "#7c3aed", "#ec4899", "#14b8a6", "#84cc16", "#64748b"];

type PlacedWord = {
  readonly word: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly opacity: number;
  readonly center: boolean;
  readonly primary: boolean;
};

type WordInstance = {
  readonly word: string;
  readonly count: number;
  readonly size: number;
  readonly primary: boolean;
  readonly seed: number;
};

/** 确定性抖动（0~1；同一 seed 永远同值 —— 布局可复现）。 */
function jitterOf(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** 词量少时压低最大字号（防「5 条变更 6 个词」也铺 150px）；fs = 总览字号倍率（见上）。 */
function topSizeOf(maxCount: number, fs: number): number {
  return Math.min(MAX_SIZE * fs, (62 + 5.6 * maxCount) * fs);
}

/** 词频 → 主字号（随词频单调：词频最高 = 封顶字号）。 */
function baseSizeOf(count: number, maxCount: number, topSize: number, fs: number): number {
  const ratio = count / maxCount;
  return Math.max(MIN_SIZE * fs, Math.round(topSize * Math.pow(ratio, SIZE_EXPONENT)));
}

/** 词频 → 落位实例（每词第一枚 = 主实例保形状；其余按字号递减补缝）。 */
function buildInstances(words: readonly ChangeWord[], fs: number): readonly WordInstance[] {
  if (words.length === 0) {
    return [];
  }
  const maxCount = words[0].count;
  const topSize = topSizeOf(maxCount, fs);
  const instances: WordInstance[] = [];
  const repeats: WordInstance[] = [];
  let budget = MAX_INSTANCES_TOTAL;
  let seed = 17;
  for (const entry of words) {
    if (budget <= 0) {
      break;
    }
    instances.push({ word: entry.word, count: entry.count, size: baseSizeOf(entry.count, maxCount, topSize, fs), primary: true, seed: seed });
    seed += 1;
    budget -= 1;
  }
  for (const entry of words) {
    const base = baseSizeOf(entry.count, maxCount, topSize, fs);
    const copies = Math.min(entry.count, MAX_COPIES_PER_WORD) - 1;
    for (let index = 1; index <= copies && budget > 0; index += 1) {
      const size = Math.max(REPEAT_MIN_SIZE * fs, Math.round(base * REPEAT_FACTOR * Math.pow(REPEAT_SHRINK, index - 1)));
      repeats.push({ word: entry.word, count: entry.count, size: size, primary: false, seed: seed + index });
      budget -= 1;
    }
    seed += Math.max(copies, 0) + 1;
  }
  repeats.sort((left, right) => right.size - left.size);
  for (const repeat of repeats) {
    instances.push(repeat);
  }
  return instances;
}

/** 词位蒙版（离屏画布像素收成 1/COLLIDE_SCALE 位图；sw / sh = 蒙版宽高，minX~maxY = 实际占格范围）。 */
type Sprite = {
  readonly mask: Uint8Array;
  readonly sw: number;
  readonly sh: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
  readonly canvasW: number;
  readonly canvasH: number;
  readonly ascent: number;
  readonly descent: number;
};

/** 画一枚词的像素蒙版（真实字体渲染后取 alpha；alpha 大于 80 记占格）。 */
function buildSprite(word: string, size: number): Sprite | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    return null;
  }
  const font = "700 " + String(size) + "px " + FONT_STACK;
  ctx.font = font;
  const metrics = ctx.measureText(word);
  const ascent = metrics.actualBoundingBoxAscent > 0 ? metrics.actualBoundingBoxAscent : size * 0.82;
  const descent = metrics.actualBoundingBoxDescent > 0 ? metrics.actualBoundingBoxDescent : size * 0.18;
  const width = Math.max(1, metrics.width);
  const canvasW = Math.ceil(width + WORD_GAP * 2);
  const canvasH = Math.ceil(ascent + descent + WORD_GAP * 2);
  canvas.width = canvasW;
  canvas.height = canvasH;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000000";
  ctx.fillText(word, WORD_GAP, WORD_GAP + ascent);
  const data = ctx.getImageData(0, 0, canvasW, canvasH).data;
  const sw = Math.ceil(canvasW / COLLIDE_SCALE);
  const sh = Math.ceil(canvasH / COLLIDE_SCALE);
  const mask = new Uint8Array(sw * sh);
  let minX = sw;
  let maxX = -1;
  let minY = sh;
  let maxY = -1;
  for (let py = 0; py < canvasH; py += 1) {
    for (let px = 0; px < canvasW; px += 1) {
      if (data[(py * canvasW + px) * 4 + 3] > 80) {
        const fx = Math.floor(px / COLLIDE_SCALE);
        const fy = Math.floor(py / COLLIDE_SCALE);
        mask[fy * sw + fx] = 1;
        if (fx < minX) { minX = fx; }
        if (fx > maxX) { maxX = fx; }
        if (fy < minY) { minY = fy; }
        if (fy > maxY) { maxY = fy; }
      }
    }
  }
  if (maxX < 0) {
    return null;
  }
  return { mask: mask, sw: sw, sh: sh, minX: minX, maxX: maxX, minY: minY, maxY: maxY, width: width, canvasW: canvasW, canvasH: canvasH, ascent: ascent, descent: descent };
}

/** 落位：像素碰撞 + 螺线试探（d3-cloud 同套思路）→ 已落位词表。 */
function layoutWords(words: readonly ChangeWord[], fs: number): readonly PlacedWord[] {
  const instances = buildInstances(words, fs);
  if (instances.length === 0) {
    return [];
  }
  const centerWord = words[0].word;
  const colorIndexByWord = new Map<string, number>();
  words.forEach((entry, index) => colorIndexByWord.set(entry.word, index));
  const fineW = Math.ceil(VIEW_W / COLLIDE_SCALE);
  const fineH = Math.ceil(VIEW_H / COLLIDE_SCALE);
  const occupancy = new Uint8Array(fineW * fineH);
  const coarseW = Math.ceil(fineW / COARSE_MULT);
  const coarseCount = new Uint8Array(coarseW * Math.ceil(fineH / COARSE_MULT));
  const centerX = VIEW_W / 2;
  const centerY = VIEW_H / 2;
  const spanX = VIEW_W / 2 - PADDING;
  const spanY = VIEW_H / 2 - PADDING;
  const placed: PlacedWord[] = [];
  /** 试放一枚：命中返回词位（左 / 上 / 基线），否则 null。 */
  const trySpot = (sprite: Sprite, px: number, py: number): { left: number; top: number; baseline: number } | null => {
    const left = px - sprite.width / 2 - WORD_GAP;
    const top = py - (sprite.ascent + sprite.descent) / 2 - WORD_GAP;
    if (left < PADDING || top < PADDING || left + sprite.canvasW > VIEW_W - PADDING || top + sprite.canvasH > VIEW_H - PADDING) {
      return null;
    }
    const fx0 = Math.floor(left / COLLIDE_SCALE);
    const fy0 = Math.floor(top / COLLIDE_SCALE);
    const gx0 = fx0 + sprite.minX;
    const gx1 = fx0 + sprite.maxX;
    const gy0 = fy0 + sprite.minY;
    const gy1 = fy0 + sprite.maxY;
    for (let cy = Math.floor(gy0 / COARSE_MULT); cy <= Math.floor(gy1 / COARSE_MULT); cy += 1) {
      const row = cy * coarseW;
      for (let cx = Math.floor(gx0 / COARSE_MULT); cx <= Math.floor(gx1 / COARSE_MULT); cx += 1) {
        if (coarseCount[row + cx] === COARSE_MULT * COARSE_MULT) {
          return null;
        }
      }
    }
    for (let fy = sprite.minY; fy <= sprite.maxY; fy += 1) {
      const row = (fy0 + fy) * fineW;
      for (let fx = sprite.minX; fx <= sprite.maxX; fx += 1) {
        if (sprite.mask[fy * sprite.sw + fx] !== 0 && occupancy[row + fx0 + fx] !== 0) {
          return null;
        }
      }
    }
    return { left: left, top: top, baseline: top + WORD_GAP + sprite.ascent };
  };
  /** 落位成功后把蒙版烙进占位位图（只统计新格，粗网格计数才准）。 */
  const stamp = (sprite: Sprite, left: number, top: number): void => {
    const fx0 = Math.floor(left / COLLIDE_SCALE);
    const fy0 = Math.floor(top / COLLIDE_SCALE);
    for (let fy = sprite.minY; fy <= sprite.maxY; fy += 1) {
      for (let fx = sprite.minX; fx <= sprite.maxX; fx += 1) {
        if (sprite.mask[fy * sprite.sw + fx] === 0) {
          continue;
        }
        const gx = fx0 + fx;
        const gy = fy0 + fy;
        const index = gy * fineW + gx;
        if (occupancy[index] === 0) {
          occupancy[index] = 1;
          coarseCount[Math.floor(gy / COARSE_MULT) * coarseW + Math.floor(gx / COARSE_MULT)] += 1;
        }
      }
    }
  };
  for (const instance of instances) {
    const floor = (instance.primary ? PRIMARY_FLOOR_SIZE : REPEAT_FLOOR_SIZE) * fs;
    let size = instance.size;
    let placedItem: PlacedWord | null = null;
    while (placedItem === null) {
      const sprite = buildSprite(instance.word, size);
      if (sprite !== null) {
        const phase = jitterOf(instance.seed * 3.7 + 11) * Math.PI * 2;
        for (let s = 0; s <= SPIRAL_MAX_S && placedItem === null; s += SPIRAL_RING_GAP) {
          const samples = Math.max(1, Math.ceil((2 * Math.PI * s) / SPIRAL_ARC_STEP));
          const ringPhase = phase + (s / SPIRAL_RING_GAP) * GOLDEN_ANGLE;
          for (let step = 0; step < samples; step += 1) {
            const angle = ringPhase + (step * 2 * Math.PI) / samples;
            const spot = trySpot(sprite, centerX + Math.cos(angle) * s * spanX, centerY + Math.sin(angle) * s * spanY);
            if (spot !== null) {
              stamp(sprite, spot.left, spot.top);
              placedItem = {
                word: instance.word,
                count: instance.count,
                x: spot.left + WORD_GAP,
                y: spot.baseline,
                size: size,
                color: WORD_COLORS[(colorIndexByWord.get(instance.word) ?? 0) % WORD_COLORS.length],
                opacity: Math.round((1 - 0.62 * Math.pow(Math.min(1, s), 1.3)) * 100) / 100,
                center: instance.primary && instance.word === centerWord,
                primary: instance.primary,
              };
              break;
            }
          }
        }
      }
      if (placedItem !== null || size <= floor) {
        break;
      }
      const next = Math.max(floor, Math.round(size * SHRINK_STEP));
      if (next === size) {
        break;
      }
      size = next;
    }
    if (placedItem !== null) {
      placed.push(placedItem);
    }
  }
  return placed;
}

export function HubDashWordCloud({ words, canDrill, onTip, onLeave, onPick, fontScale = 1 }: {
  readonly words: DashboardChangeWords;
  readonly canDrill: boolean;
  readonly onTip: (event: ReactMouseEvent<SVGTextElement>, word: string, count: number) => void;
  readonly onLeave: () => void;
  readonly onPick: (word: string) => void;
  /** 总览字号倍率（Push 360 · 业务口径 2026-10-16「文字不够清晰 那些小字还是要大一点」）：只有「数据总览」传 >1，单视图不传、逐值不变。 */
  readonly fontScale?: number;
}) {
  const t = useT();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const placed = useMemo(() => layoutWords(words.words, fontScale), [words.words, fontScale]);
  return (
    <svg className="hub-dash-wordcloud" viewBox={"0 0 " + String(VIEW_W) + " " + String(VIEW_H)} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("hub.dash.wordcloud.aria")}>
      {placed.map((item, index) => {
        const clickable = canDrill && item.primary;
        const hovered = hoverIndex === index;
        const dimmed = hoverIndex !== null && !hovered;
        return (
          <text
            key={item.word + "#" + String(index)}
            className="hub-dash-wordcloud__word"
            data-word={item.word}
            data-center={item.center ? "true" : "false"}
            data-drill={clickable ? "true" : "false"}
            data-hover={hovered ? "true" : "false"}
            x={item.x}
            y={item.y}
            fontSize={item.size}
            fontWeight={700}
            fill={item.color}
            fillOpacity={hovered ? 1 : dimmed ? Math.max(0.12, Math.round(item.opacity * 30) / 100) : item.opacity}
            onMouseEnter={(event) => {
              setHoverIndex(index);
              onTip(event, item.word, item.count);
            }}
            onMouseMove={(event) => onTip(event, item.word, item.count)}
            onMouseLeave={() => {
              setHoverIndex(null);
              onLeave();
            }}
            onClick={clickable ? () => onPick(item.word) : undefined}
          >
            {item.word}
          </text>
        );
      })}
    </svg>
  );
}
