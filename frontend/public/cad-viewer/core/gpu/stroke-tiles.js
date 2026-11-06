// Persistent world-space stroke tiles. Non-stroke paint remains a draw barrier in
// the caller so WIPEOUT, fills and text keep their source order.
import Flatbush from "../vendor/flatbush.js";
export const STROKE_TILE_STRIDE = 9;
export const STROKE_TILE_TARGET_PX = 360;
export const STROKE_TILE_MAX_LEVEL = 8;
const MAX_DRAW_TILES = 64;
const COLOR_FALLBACK = [0, 0, 0];

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function intersects(a, b) {
  return !!a && !!b && a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
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
function parseColor(css) {
  const match = /rgba?\(([^)]+)\)/i.exec(css || "");
  if (!match) return COLOR_FALLBACK;
  const values = match[1].split(",").map(Number);
  if (values.length < 3 || values.slice(0, 3).some(value => !Number.isFinite(value))) return COLOR_FALLBACK;
  return [clamp(values[0] / 255, 0, 1), clamp(values[1] / 255, 0, 1), clamp(values[2] / 255, 0, 1)];
}
function localViewBounds(view,matrix,bounds) {
  const a=matrix[0],b=matrix[1],c=matrix[4],d=matrix[5],det=a*d-b*c;
  if(!det)return bounds;
  const inverse=[d/det,-b/det,0,0,-c/det,a/det,0,0,0,0,1,0,
    (c*matrix[13]-d*matrix[12])/det,(b*matrix[12]-a*matrix[13])/det,0,1];
  return transformBounds(view,inverse);
}
function clipSegment(x1, y1, x2, y2, box) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const checks = [[-dx, x1 - box.minX], [dx, box.maxX - x1], [-dy, y1 - box.minY], [dy, box.maxY - y1]];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t0 > t1) return null;
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}
export function selectTileLevel(bounds, scale, targetPx = STROKE_TILE_TARGET_PX, maxLevel = STROKE_TILE_MAX_LEVEL) {
  if (!bounds || !Number.isFinite(scale) || scale <= 0) return 0;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-9);
  return clamp(Math.ceil(Math.log2(Math.max(1, span * scale / Math.max(1, targetPx)))), 0, maxLevel);
}
export function tileBoundsAt(bounds, level, x, y) {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-9);
  const cells = 2 ** level;
  const size = span / cells;
  return { minX: bounds.minX + x * size, minY: bounds.minY + y * size, maxX: bounds.minX + (x + 1) * size, maxY: bounds.minY + (y + 1) * size };
}
export function visibleTileRange(bounds, level, view) {
  if (!intersects(bounds, view)) return { level, x0: 0, x1: -1, y0: 0, y1: -1, count: 0 };
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-9);
  const cells = 2 ** level;
  const size = span / cells;
  const x0 = clamp(Math.floor((view.minX - bounds.minX) / size), 0, cells - 1);
  const x1 = clamp(Math.floor((view.maxX - bounds.minX - 1e-12) / size), 0, cells - 1);
  const y0 = clamp(Math.floor((view.minY - bounds.minY) / size), 0, cells - 1);
  const y1 = clamp(Math.floor((view.maxY - bounds.minY - 1e-12) / size), 0, cells - 1);
  return { level, x0, x1, y0, y1, count: Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) };
}
function clipSegments(worldSegments, box) {
  const out = [];
  for (let i = 0; i + 3 < worldSegments.length; i += 4) {
    const clipped = clipSegment(worldSegments[i], worldSegments[i + 1], worldSegments[i + 2], worldSegments[i + 3], box);
    if (clipped) out.push(...clipped);
  }
  return out;
}
export function buildTileVertices(descriptors, box, minWorldSize = 0) {
  const groups = new Map();
  for (const descriptor of descriptors) {
    if (!intersects(descriptor.bounds, box)) continue;
    if (descriptor.lodSize > 0 && descriptor.lodSize < minWorldSize) continue;
    const clipped = clipSegments(descriptor.worldSegments, box);
    if (!clipped.length) continue;
    let group = groups.get(descriptor.styleKey);
    if (!group) { group = { key: descriptor.styleKey, color: descriptor.color, width: descriptor.width, layerId: descriptor.layerId, rank: Number.isFinite(descriptor.order) ? descriptor.order : groups.size, rows: [] }; groups.set(group.key, group); }
    else if (Number.isFinite(descriptor.order)) group.rank = Math.min(group.rank, descriptor.order);
    group.rows.push({ descriptor, segments: clipped });
  }
  if (!groups.size) return { data: new Float32Array(0), segments: 0, styleCount: 0 };
  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank);
  let segments = 0;
  for (const group of ordered) for (const row of group.rows) segments += row.segments.length / 4;
  if (!segments) return { data: new Float32Array(0), segments: 0, styleCount: 0 };
  const originX = (box.minX + box.maxX) * 0.5;
  const originY = (box.minY + box.maxY) * 0.5;
  const data = new Float32Array(segments * STROKE_TILE_STRIDE);
  let at = 0;
  for (const group of ordered) {
    for (const row of group.rows) {
      const { color, width, lodSize } = row.descriptor;
      const source = row.segments;
      for (let i = 0; i < source.length; i += 4) {
        data[at++] = source[i] - originX;
        data[at++] = source[i + 1] - originY;
        data[at++] = source[i + 2] - originX;
        data[at++] = source[i + 3] - originY;
        data[at++] = color[0];
        data[at++] = color[1];
        data[at++] = color[2];
        data[at++] = width;
        data[at++] = lodSize;
      }
    }
  }
  return { data, segments, styleCount: ordered.length, originX, originY };
}
function rowKey(planId, runId, level, x, y, lodKey) { return planId + ":" + runId + ":" + level + ":" + x + ":" + y + ":" + lodKey; }
export function createStrokeTilePlanner(renderer, options = {}) {
  const tilePx = options.tilePx || STROKE_TILE_TARGET_PX;
  const maxLevel = options.maxLevel ?? STROKE_TILE_MAX_LEVEL;
  const maxBytes = options.maxBytes || 192 * 1024 * 1024;
  const maxDrawTiles = options.maxDrawTiles || MAX_DRAW_TILES;
  let nodePlans = new WeakMap();
  let planSerial = 0;
  let useSerial = 0;
  let totalBytes = 0;
  let builtTiles = 0;
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
    if (!plan.runEntries) {
      plan.runEntries = new Map();
      for (const entry of entries) {
        if (entry.kind !== "stroke" || entry.gpuRun < 0 || !entry.gpuSegments?.length || entry.dash?.length) continue;
        let rows = plan.runEntries.get(entry.gpuRun);
        if (!rows) { rows = []; plan.runEntries.set(entry.gpuRun, rows); }
        rows.push(entry);
      }
    }
    for (const entry of plan.runEntries.get(runId) || []) {
      const entryBounds = entry.bounds;
      if (!entryBounds) continue;
      const layerId = entry.layerId || "";
      const width = Math.max(0.01, Number(entry.width) || 0.01);
      const color = parseColor(entry.color);
      const styleKey = layerId + "|" + entry.color + "|" + width;
      const lodSize = entry.lodSize ?? Math.max(entryBounds.maxX - entryBounds.minX, entryBounds.maxY - entryBounds.minY, 1e-9);
      const chunks = entry.gpuSegments || [];
      const records = entry.records || [];
      const count = Math.min(chunks.length, records.length);
      for (let i = 0; i < count; i++) {
        const worldSegments = chunks[i];
        if (!worldSegments) continue;
        const worldBounds = records[i].bbox || entry.bounds;
        if (!worldBounds) continue;
        descriptors.push({ bounds: worldBounds, worldSegments, layerId, width, color, styleKey, lodSize,order: order++ });
        bounds = union(bounds, worldBounds);
      }
    }
    let index = null;
    if (descriptors.length) {
      // Tile queries use double-precision drawing coordinates. Float32 bounds
      // can round boundary lines outside the tile and discard entire strokes.
      index = new Flatbush(descriptors.length, 16, Float64Array);
      for (const descriptor of descriptors) index.add(descriptor.bounds.minX, descriptor.bounds.minY, descriptor.bounds.maxX, descriptor.bounds.maxY);
      index.finish();
    }
    const run = { id: runId, descriptors, index, bounds, tiles: new Map() };
    plan.runs.set(runId, run);
    return run;
  }
  function runPlan(node, entries) {
    let plan = nodePlans.get(node);
    if (!plan) {
      plan = { id: ++planSerial, runs: new Map() };
      nodePlans.set(node, plan);
    }
    return plan;
  }
  function ensureTile(plan, run, level, x, y, lodKey, minWorldSize) {
    const key = rowKey(plan.id, run.id, level, x, y, lodKey);
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
    const built = buildTileVertices(candidates, bounds, minWorldSize);
    if (!built.segments) { run.tiles.set(key, null); return null; }
    const buffer = renderer.createTileBuffer(built.data, built.segments, built.originX, built.originY);
    const row = { key, run, buffer, bytes: built.data.byteLength, segments: built.segments, styles: built.styleCount, lastUse: ++useSerial };
    run.tiles.set(key, row);
    rows.set(key, row);
    totalBytes += row.bytes;
    builtTiles++;
    return row;
  }
  function* drawRunSteps(node, runId, entries, matrix, view, scale, minScreenPx) {
    let sliceStarted=performance.now();
    const plan = runPlan(node.group || node, entries);
    const run = describeRun(plan, runId, entries);
    if (!run || !run.descriptors.length || !intersects(transformBounds(run.bounds,matrix), view)) return { tiles: 0, segments: 0, styles: 0, level: 0, bytes: 0, built: 0, reused: 0 };
    // Geometry and tile keys remain in group-local space. The shader applies
    // each parent transform and the exact screen-space LOD threshold per draw.
    const localView=localViewBounds(view,matrix,run.bounds);
    const localScale=scale*Math.max(Math.hypot(matrix[0],matrix[1]),Math.hypot(matrix[4],matrix[5]));
    const lodKey=0,buildMinWorldSize=0;
    let level = selectTileLevel(run.bounds, localScale, tilePx, maxLevel);
    let range = visibleTileRange(run.bounds, level, localView);
    while (range.count > maxDrawTiles && level > 0) { level--; range = visibleTileRange(run.bounds, level, localView); }
    if (!range.count) return { tiles: 0, segments: 0, styles: 0, level, bytes: 0, built: 0, reused: 0 };
    const activeKeys = new Set();
    let tiles = 0, segments = 0, styles = 0, bytes = 0, built = 0, reused = 0;
    for (let y = range.y0; y <= range.y1; y++) {
      for (let x = range.x0; x <= range.x1; x++) {
        if(performance.now()-sliceStarted>=6){yield;sliceStarted=performance.now();}
        const key = rowKey(plan.id, run.id, level, x, y, lodKey);
        const known = run.tiles.get(key);
        const row = ensureTile(plan, run, level, x, y, lodKey, buildMinWorldSize);
        if (!row) continue;
        if (known) reused++; else built++;
        activeKeys.add(key);
        renderer.drawTile(row.buffer, view, minScreenPx, matrix);
        tiles++;
        segments += row.segments;
        styles += row.styles;
        bytes += row.bytes;
      }
    }
    prune(activeKeys);
    return { tiles, segments, styles, level, bytes, built, reused };
  }
  function drawRun(...args){
    const steps=drawRunSteps(...args);let next;do{next=steps.next();}while(!next.done);return next.value;
  }
  function reset() {
    for (const row of rows.values()) renderer.deleteTileBuffer(row.buffer);
    rows.clear();
    totalBytes = 0;
    builtTiles = 0;
    nodePlans = new WeakMap();
  }
  return { drawRun, drawRunSteps, reset, stats: () => ({ cachedTiles: rows.size, bytes: totalBytes, builtTiles }) };
}
