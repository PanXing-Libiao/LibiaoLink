// Persistent world-space triangle tiles for solid HATCH fills. Triangles stay
// independent and keep source paint order, so overlapping fills never cancel.
import Flatbush from "../vendor/flatbush.js";
import {selectTileLevel, tileBoundsAt, visibleTileRange} from "./stroke-tiles.js?v=dxf-0.17.24";
export const FILL_TILE_STRIDE = 7;
export const FILL_TILE_TARGET_PX = 360;
export const FILL_TILE_MAX_LEVEL = 8;
const MAX_DRAW_TILES = 64;
const COLOR_FALLBACK = [0, 0, 0, 1];

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function completeView(view) {
  return !!view && [view.scale, view.tx, view.ty, view.dpr].every(Number.isFinite);
}
function intersects(a, b) {
  return !!a && !!b && a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
function inverseAffine(matrix) {
  if (!matrix) return null;
  const det = matrix[0] * matrix[5] - matrix[1] * matrix[4];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const a = matrix[5] / det, b = -matrix[1] / det;
  const c = -matrix[4] / det, d = matrix[0] / det;
  return [a, b, 0, 0, c, d, 0, 0, 0, 0, 1, 0,
    -a * matrix[12] - c * matrix[13], -b * matrix[12] - d * matrix[13], 0, 1];
}
function matrixScale(matrix) {
  return matrix ? Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[4], matrix[5]), 1e-15) : 1;
}
function intersectView(view, matrix) {
  if (!matrix) return view;
  const inverse = inverseAffine(matrix);
  return inverse ? transformBounds(view, inverse) : null;
}
function union(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
function transformBounds(box, matrix) {
  if (!box) return null;
  const xs = [], ys = [];
  for (const [x, y] of [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]]) {
    xs.push(matrix[0] * x + matrix[4] * y + matrix[12]);
    ys.push(matrix[1] * x + matrix[5] * y + matrix[13]);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
export function parseFillColor(css) {
  const match = /rgba?\(([^)]+)\)/i.exec(css || "");
  if (!match) return COLOR_FALLBACK.slice();
  const values = match[1].split(",").map(Number);
  if (values.length < 3 || values.slice(0, 3).some(value => !Number.isFinite(value))) return COLOR_FALLBACK.slice();
  return [
    clamp(values[0] / 255, 0, 1), clamp(values[1] / 255, 0, 1),
    clamp(values[2] / 255, 0, 1), values.length > 3 && Number.isFinite(values[3]) ? clamp(values[3], 0, 1) : 1
  ];
}
function boxPadding(box) {
  const magnitude = Math.max(Math.abs(box.minX), Math.abs(box.maxX), Math.abs(box.minY), Math.abs(box.maxY), 1);
  return Math.max(1e-6, magnitude * 2 ** -22);
}
function padBox(box, pad = boxPadding(box)) {
  return { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad };
}
function triangleBounds(triangle) {
  return {
    minX: Math.min(triangle[0][0], triangle[1][0], triangle[2][0]),
    minY: Math.min(triangle[0][1], triangle[1][1], triangle[2][1]),
    maxX: Math.max(triangle[0][0], triangle[1][0], triangle[2][0]),
    maxY: Math.max(triangle[0][1], triangle[1][1], triangle[2][1])
  };
}
function clipPolygon(points, box) {
  let output = points;
  const edges = [
    [point => point[0] >= box.minX, (a, b) => interpolate(a, b, 0, box.minX)],
    [point => point[0] <= box.maxX, (a, b) => interpolate(a, b, 0, box.maxX)],
    [point => point[1] >= box.minY, (a, b) => interpolate(a, b, 1, box.minY)],
    [point => point[1] <= box.maxY, (a, b) => interpolate(a, b, 1, box.maxY)]
  ];
  for (const [inside, crossing] of edges) {
    if (!output.length) return [];
    const next = [];
    let previous = output[output.length - 1], previousInside = inside(previous);
    for (const current of output) {
      const currentInside = inside(current);
      if (currentInside !== previousInside) next.push(crossing(previous, current));
      if (currentInside) next.push(current);
      previous = current; previousInside = currentInside;
    }
    output = next;
  }
  return output;
}
function dedupePolygon(points) {
  const clean = [];
  for (const point of points) {
    const previous = clean[clean.length - 1];
    if (previous && Math.abs(previous[0] - point[0]) <= 1e-12 && Math.abs(previous[1] - point[1]) <= 1e-12) continue;
    clean.push(point);
  }
  while (clean.length > 1) {
    const first = clean[0], last = clean[clean.length - 1];
    if (Math.abs(first[0] - last[0]) > 1e-12 || Math.abs(first[1] - last[1]) > 1e-12) break;
    clean.pop();
  }
  return clean;
}
function interpolate(a, b, axis, value) {
  const denominator = b[axis] - a[axis];
  const t = Math.abs(denominator) < 1e-20 ? 0 : (value - a[axis]) / denominator;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function ensureCapacity(scratch, needed) {
  if (scratch.data && scratch.data.length >= needed) return scratch.data;
  let size = scratch.data ? scratch.data.length : 4096;
  while (size < needed) size *= 2;
  const next = new Float32Array(size);
  if (scratch.data && scratch.length) next.set(scratch.data.subarray(0, scratch.length));
  scratch.data = next;
  return next;
}
function vertex(scratch, x, y, color, lodSize, originX, originY) {
  const data = ensureCapacity(scratch, scratch.length + FILL_TILE_STRIDE);
  let at = scratch.length;
  data[at++] = x - originX; data[at++] = y - originY;
  data[at++] = color[0]; data[at++] = color[1]; data[at++] = color[2]; data[at++] = color[3];
  data[at++] = lodSize;
  scratch.length = at;
}
function triangle(scratch, points, color, lodSize, originX, originY) {
  vertex(scratch, points[0][0], points[0][1], color, lodSize, originX, originY);
  vertex(scratch, points[1][0], points[1][1], color, lodSize, originX, originY);
  vertex(scratch, points[2][0], points[2][1], color, lodSize, originX, originY);
}
export function buildFillTileVertices(descriptors, box, scratch = { data: null, length: 0 }) {
  const clipBox = padBox(box);
  const originX = (box.minX + box.maxX) * 0.5;
  const originY = (box.minY + box.maxY) * 0.5;
  scratch.length = 0;
  let triangles = 0;
  const styles = new Set();
  const ordered = descriptors.length > 1 ? descriptors.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : descriptors;
  for (const descriptor of ordered) {
    if (!intersects(descriptor.bounds, clipBox)) continue;
    const color = descriptor.tint || COLOR_FALLBACK;
    const lodSize = Number(descriptor.lodSize) || 0;
    for (const source of descriptor.triangles || []) {
      if (!source || source.length < 3) continue;
      const bounds = triangleBounds(source);
      if (!intersects(bounds, clipBox)) continue;
      const clipped = bounds.minX < clipBox.minX || bounds.maxX > clipBox.maxX
        || bounds.minY < clipBox.minY || bounds.maxY > clipBox.maxY
        ? dedupePolygon(clipPolygon(source, clipBox)) : source;
      if (clipped.length < 3) continue;
      styles.add(descriptor.styleKey);
      for (let i = 1; i + 1 < clipped.length; i++) {
        triangle(scratch, [clipped[0], clipped[i], clipped[i + 1]], color, lodSize, originX, originY);
        triangles++;
      }
    }
  }
  return {
    data: scratch.length ? scratch.data.subarray(0, scratch.length) : new Float32Array(0),
    triangles, styleCount: styles.size, originX, originY
  };
}
function rowKey(planId, runId, level, x, y) { return planId + ":" + runId + ":" + level + ":" + x + ":" + y; }
export function createFillTilePlanner(renderer, options = {}) {
  const tilePx = options.tilePx || FILL_TILE_TARGET_PX;
  const maxLevel = options.maxLevel ?? FILL_TILE_MAX_LEVEL;
  const maxBytes = options.maxBytes || 128 * 1024 * 1024;
  const maxDrawTiles = options.maxDrawTiles || MAX_DRAW_TILES;
  let nodePlans = new WeakMap();
  let planSerial = 0;
  let useSerial = 0;
  let totalBytes = 0;
  let builtTiles = 0;
  let maxBuildMs = 0, maxBuildTriangles = 0, maxBuildBytes = 0;
  const vertexScratch = { data: null, length: 0 };
  const rows = new Map();
  function prune(activeKeys) {
    if (totalBytes <= maxBytes) return;
    const stale = [...rows.values()].sort((a, b) => a.lastUse - b.lastUse);
    for (const row of stale) {
      if (totalBytes <= maxBytes * 0.8) break;
      if (activeKeys && activeKeys.has(row.key)) continue;
      rows.delete(row.key);
      if (row.run.tiles.get(row.key) === row) row.run.tiles.delete(row.key);
      totalBytes -= row.bytes;
      renderer.deleteTileBuffer(row.buffer);
    }
  }
  function describeRun(plan, runId, entries) {
    const cached = plan.runs.get(runId);
    if (cached) return cached;
    const descriptors = [];
    let bounds = null;
    let order = 0;
    for (const entry of entries) {
      if (entry.kind !== "fill" || entry.gpuFillRun !== runId) continue;
      const tint = parseFillColor(entry.color);
      const styleKey = (entry.layerId || "") + "|" + entry.color + "|" + (entry.lodSize || 0);
      for (const record of entry.records || []) {
        const triangles = record.fillTriangles;
        if (!triangles?.length) continue;
        const recordBounds = record.visibleGeometry?.bounds || record.bbox;
        if (!recordBounds) continue;
        descriptors.push({
          bounds: recordBounds, triangles, tint, styleKey,
          lodSize: Number(entry.lodSize) || 0, order: order++
        });
        bounds = union(bounds, recordBounds);
      }
    }
    let index = null;
    if (descriptors.length) {
      index = new Flatbush(descriptors.length, 16, Float32Array);
      for (const descriptor of descriptors) {
        const box = padBox(descriptor.bounds);
        index.add(box.minX, box.minY, box.maxX, box.maxY);
      }
      index.finish();
    }
    const run = { id: runId, descriptors, index, bounds, tiles: new Map() };
    plan.runs.set(runId, run);
    return run;
  }
  function runPlan(node) {
    const owner = node?.group || node || {};
    let plan = nodePlans.get(owner);
    if (!plan) {
      plan = { id: ++planSerial, runs: new Map() };
      nodePlans.set(owner, plan);
    }
    return plan;
  }
  function ensureTile(plan, run, level, x, y) {
    const key = rowKey(plan.id, run.id, level, x, y);
    if (run.tiles.has(key)) {
      const row = run.tiles.get(key);
      if (!row) return null;
      row.lastUse = ++useSerial;
      return row;
    }
    const bounds = tileBoundsAt(run.bounds, level, x, y);
    const candidates = run.index
      ? run.index.search(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY).map(i => run.descriptors[i])
      : run.descriptors;
    const buildStarted = performance.now();
    const built = buildFillTileVertices(candidates, bounds, vertexScratch);
    if (!built.triangles) { run.tiles.set(key, null); return null; }
    const buffer = renderer.createFillTileBuffer(built.data, built.triangles, built.originX, built.originY);
    const buildMs = performance.now() - buildStarted;
    if (buildMs > maxBuildMs) {
      maxBuildMs = buildMs; maxBuildTriangles = built.triangles; maxBuildBytes = built.data.byteLength;
    }
    const row = { key, run, buffer, bytes: built.data.byteLength, triangles: built.triangles,
      styles: built.styleCount, lastUse: ++useSerial };
    run.tiles.set(key, row);
    rows.set(key, row);
    totalBytes += row.bytes;
    builtTiles++;
    return row;
  }
  function* drawRunSteps(node, runId, entries, matrix, view, scale, minScreenPx) {
    if (!completeView(view)) return { tiles: 0, triangles: 0, styles: 0, level: 0, bytes: 0, built: 0, reused: 0 };
    const plan = runPlan(node);
    const run = describeRun(plan, runId, entries);
    const localView = intersectView(view, matrix);
    if (!run || !run.descriptors.length || !localView || !intersects(run.bounds, localView))
      return { tiles: 0, triangles: 0, styles: 0, level: 0, bytes: 0, built: 0, reused: 0 };
    const localScale = Math.max(scale * matrixScale(matrix), 1e-15);
    let level = selectTileLevel(run.bounds, localScale, tilePx, maxLevel);
    let range = visibleTileRange(run.bounds, level, localView);
    while (range.count > maxDrawTiles && level > 0) {
      level--;
      range = visibleTileRange(run.bounds, level, localView);
    }
    if (!range.count) return { tiles: 0, triangles: 0, styles: 0, level, bytes: 0, built: 0, reused: 0 };
    const activeKeys = new Set();
    let tiles = 0, triangles = 0, styles = 0, bytes = 0, built = 0, reused = 0;
    let sliceStarted = performance.now();
    for (let y = range.y0; y <= range.y1; y++) {
      for (let x = range.x0; x <= range.x1; x++) {
        if (performance.now() - sliceStarted >= 6) {
          yield;
          sliceStarted = performance.now();
        }
        const key = rowKey(plan.id, run.id, level, x, y);
        const known = run.tiles.get(key);
        const row = ensureTile(plan, run, level, x, y);
        if (!row) continue;
        if (known) reused++; else built++;
        activeKeys.add(key);
        renderer.drawFillTile(row.buffer, view, minScreenPx, matrix);
        tiles++;
        triangles += row.triangles;
        styles += row.styles;
        bytes += row.bytes;
      }
    }
    prune(activeKeys);
    return { tiles, triangles, styles, level, bytes, built, reused };
  }
  function drawRun(node, runId, entries, matrix, view, scale, minScreenPx) {
    const steps = drawRunSteps(node, runId, entries, matrix, view, scale, minScreenPx);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  }
  function reset() {
    for (const row of rows.values()) renderer.deleteTileBuffer(row.buffer);
    rows.clear();
    totalBytes = 0;
    builtTiles = 0;
    maxBuildMs = 0; maxBuildTriangles = 0; maxBuildBytes = 0;
    nodePlans = new WeakMap();
  }
  return {
    drawRun, drawRunSteps, reset,
    stats: () => ({ cachedTiles: rows.size, bytes: totalBytes, builtTiles,
      maxBuildMs, maxBuildTriangles, maxBuildBytes })
  };
}
