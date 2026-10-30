// Independent 2D Canvas viewer for UCD Drawing documents.
// Input: a UCD 2.0 envelope whose document carries Drawing tables. The viewer never
// re-reads DXF. Analytic source curves (Entity.geometry) and the discretized display
// representation (Representation kind=drawing) are selectable, separate paths.
import {projectDrawing, projectBlock} from './drawing-projection.js?v=dxf-0.15.0';
import {clipInfiniteLine, gradientField, triangleBoundarySegments, traceStrokeSegments} from './drawing-2d.js?v=dxf-2d-0.5.0';
import {drawingClips, compileClips, triangulateRings, insideRing} from './drawing-clipping.js?v=dxf-0.15.0';
import {plotAppearance, plotParts, fillTile} from './drawing-plot-styles.js?v=dxf-0.15.0';
import {estimateDrawingDraws, projectInstances, shouldProjectInstances, recordVisibleBounds, INSTANCE_DRAW_LIMIT, multiply, transformPoint, inverse2D, transformBounds, union, sourceExtentsFromHeader, fitExtentsCandidate, I} from './drawing-instances.js';
import Flatbush from './vendor/flatbush.js';
import {TEXT_FONT, layoutAnnotationText, parseMtextRuns, textOffsets, textWorldCorners, textDisplayBox} from './drawing-text.js?v=dxf-0.15.0';
import {aciColor, trueColorCss} from './drawing-colors.js?v=dxf-0.15.0';
import {resolveTextAvoidance} from './drawing-text-avoidance.js?v=dxf-0.15.0';
import {hatchFillKind, lineDashFor, fillEntryFor, fillGeometryFor, strokeSegmentsForRepresentation} from './drawing-pattern.js?v=dxf-0.15.0';
import {mediaItemFor, rasterRecord} from './drawing-media.js?v=dxf-0.15.0';

const ACCENT = '#d9426f';

export function mountDrawingViewer(envelope) {
  const ucd = envelope.document, drawing = ucd.drawing, presentation = envelope.presentation;
  const styleExt = (ucd.extensions && ucd.extensions['org.cad-preview.style-inheritance/1']) || {};
  const coverageExt = (ucd.extensions && ucd.extensions['org.cad-preview.drawing-coverage/1']) || {};
  const annotationItems = ucd.extensions?.['org.cad-preview.annotation-presentation/1']?.items || {};
  const recovery = ucd.extensions?.['org.cad-preview.dxf/1']?.recovery;
  const recoveredBlocks = recovery?.blockPreviews || [];
  const xrefs = ucd.extensions?.['org.cad-preview.dxf-xref/1'];
  const shx = ucd.extensions?.['org.cad-preview.dxf-shx/1'];
  const media = ucd.extensions?.['org.cad-preview.dxf-media/1'];
  const mtextLayout = ucd.extensions?.['org.cad-preview.dxf-mtext/1'];
  const plotStyles = ucd.extensions?.['org.cad-preview.dxf-plot-styles/1'];
  let plotPreview = false;
  const plotErrors = new Set(), plotFillCache = new Map();
  const viewport = document.getElementById('viewport');
  let canvas = document.getElementById('drawingCanvas');
  if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'drawingCanvas'; viewport.prepend(canvas); }
  canvas.hidden = false;
  const ctx = canvas.getContext('2d');
  let overlay = document.getElementById('drawingOverlay');
  if (!overlay) {
    overlay = document.createElement('div'); overlay.id = 'drawingOverlay';
    overlay.innerHTML = '<div class="dchip" id="drawingSpace">模型空间</div><div class="dchip" id="drawingCoords">X — · Y —</div><div class="dchip" id="drawingPrecision">显示离散化</div>';
    viewport.append(overlay);
  }
  let panel = document.getElementById('drawingPanel');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'drawingPanel'; panel.className = 'drawingPanel';
    document.getElementById('tree').parentNode.insertBefore(panel, document.getElementById('tree'));
  }
  panel.hidden = false;

  let effectiveLayers = new WeakMap();
  let presentationStyles = {};
  // ?instances=1 forces the retained-instance path so small fixtures can
  // regression-test layout/presentation/media semantics without a 400k-draw file.
  const nativeTextLayout = !!ucd.extensions?.['org.libiaolink.dwg/1'];
  // Dimension picture blocks carry their own text; display avoidance must never
  // move it (that would put a dimension at a neighbour's place and leave its own
  // spot empty). The reader records every dimension instance; fall back to the
  // anonymous *D block naming when that table is absent.
  const dimensionInstances = new Set(Object.keys(ucd.extensions?.['org.libiaolink.dwg/1']?.dimensionSemantics || {}));
  function inDimensionBlock(draw) {
    const path = draw.blockPath || [];
    if (dimensionInstances.size) {
      for (const step of path) if (dimensionInstances.has(step.instanceId)) return true;
      return false;
    }
    const step = path[0];
    if (!step) return false;
    const instance = drawing.blockInstances[step.instanceId];
    const block = instance && drawing.blocks[instance.definitionId];
    return !!block && /^\*D/i.test(block.name || '');
  }
  // Local font-substitution experiment: honour the source text style / inline
  // \f name and pick the closest locally available family instead of one stack.
  const FONT_STACK_CJK = '"SimSun","Noto Serif CJK SC",serif';
  // Latin-first stacks keep a CJK fallback so mixed runs get Song glyphs from
  // the browser's per-glyph fallback instead of tofu or a wider system default.
  const FONT_STACK_LATIN = '"Arial","Liberation Sans","SimSun",sans-serif';
  function mapFontFamily(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    if (/simsun|宋体|song|fangsong|stsong/.test(n)) return FONT_STACK_CJK;
    if (/simhei|黑体|heiti/.test(n)) return '"SimHei","Noto Sans CJK SC",sans-serif';
    if (/msyh|yahei|pingfang/.test(n)) return '"Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    if (/swiss|arial|helvetica/.test(n)) return FONT_STACK_LATIN;
    if (/times/.test(n)) return '"Times New Roman","Liberation Serif","SimSun",serif';
    if (/courier/.test(n)) return '"Courier New","Liberation Mono","SimSun",monospace';
    if (/romans|simplex|txt\.shx|gbcbig|hztxt|\.shx/.test(n)) return FONT_STACK_LATIN;
    if (/^hy|longfang/.test(n)) return FONT_STACK_CJK;
    return null;
  }
  // \C carries an ACI index, \c a 24-bit true color; both become CSS colors on
  // the following text runs until the next color control or group end.
  const textRunColor = (kind, value) => kind === 'true' ? trueColorCss(value) : aciColor(value);
  function styleFontFamilyFor(annotation) {
    const sem = annotation.semantic || {};
    let name = (sem.fontFilename && sem.fontFilename.value) || '';
    if (!name && sem.textStyleId) {
      const key = String(sem.textStyleId.value || '').replace(/^textstyle-/, '');
      const styles = (ucd.extensions?.['org.libiaolink.dwg/1']?.fonts) || {};
      const row = styles[key];
      if (row && row.Filename) name = row.Filename;
    }
    const mapped = mapFontFamily(name);
    if (mapped) return mapped;
    const bigFont = (sem.bigFontFilename && sem.bigFontFilename.value) || '';
    if (bigFont) return FONT_STACK_CJK;
    const text = (sem.plainText && sem.plainText.value) || annotation.text || '';
    return /[⺀-鿿豈-﫿＀-￯]/.test(String(text)) ? FONT_STACK_CJK : FONT_STACK_LATIN;
  }
  function annotationRuns(annotation) {
    const defaultFont = styleFontFamilyFor(annotation);
    const sem = annotation.semantic || {};
    const raw = (sem.rawText && sem.rawText.value) || '';
    let runs = null;
    // Inline runs only when the parser reproduces the sanitized plain text; any
    // control we do not model (e.g. stacking) falls back to the single-font path.
    if (nativeTextLayout && /\\[fFcC]/.test(raw) && !/\\[sS][^;]*;/.test(raw)) {
      const parsed = parseMtextRuns(raw, defaultFont, mapFontFamily, textRunColor);
      const plain = (sem.plainText && sem.plainText.value) || annotation.text || '';
      const norm = value => String(value).replace(/\s+/g, '');
      if (parsed.length && norm(parsed.map(item => item.text).join('')) === norm(plain)) runs = parsed;
    }
    return {defaultFont, runs};
  }
  function fontFamilyFor(annotation) {
    const sem = annotation.semantic || {};
    const raw = (sem.rawText && sem.rawText.value) || '';
    const inline = /\\f([^|;\\}]+)/.exec(raw);
    let name = inline ? inline[1] : ((sem.fontFilename && sem.fontFilename.value) || '');
    if (!name && sem.textStyleId) {
      const key = String(sem.textStyleId.value || '').replace(/^textstyle-/, '');
      const styles = (ucd.extensions?.['org.libiaolink.dwg/1']?.fonts) || {};
      const row = styles[key];
      if (row && row.Filename) name = row.Filename;
    }
    const mapped = mapFontFamily(name);
    if (mapped) return mapped;
    const bigFont = (sem.bigFontFilename && sem.bigFontFilename.value) || '';
    if (bigFont) return FONT_STACK_CJK;
    const text = (sem.plainText && sem.plainText.value) || annotation.text || '';
    return /[⺀-鿿豈-﫿＀-￯]/.test(String(text)) ? FONT_STACK_CJK : FONT_STACK_LATIN;
  }
  // ACadSharp evaluates some periodic splines at uStart to XYZ.Zero; the reader's
  // display pairs then start with (0,0) -> real point, painting a giant segment
  // from the origin. The reader source cleans this up; stale engine binaries can
  // still emit it, so the viewer drops that first pair when it is clearly bogus.
  function splineOriginPair(entity, representation) {
    const geometry = entity && entity.geometry;
    if (!geometry || geometry.type !== 'spline' || !representation || representation.indices) return false;
    const pos = representation.positions;
    if (!pos || pos.length < 6) return false;
    const near = value => Math.abs(value) < 1e-9;
    if (!(near(pos[0]) && near(pos[1]) && near(pos[2]))) return false;
    const control = geometry.controlPoints || [];
    if (control.length) {
      const first = control[0];
      if (Math.abs(first[0]) < 1e-6 && Math.abs(first[1]) < 1e-6) return false;
    }
    return Math.hypot(pos[3], pos[4]) > 1;
  }
  const forceInstances = typeof location !== 'undefined' && new URLSearchParams(location.search).get('instances') === '1';
  let spaceTarget = null, projection = null, built = [], texts = [], pointMarks = [];
  let textAvoidance = true;
  let instancePlan = null, instanceLayerKey = '', instanceSelected = null;
  let scale = 1, tx = 0, ty = 0, dpr = 1, cssW = 800, cssH = 600;
  let mode = 'display';
  const userLayers = new Map();
  const selected = new Set();
  let selectedInstance = null, selectedLabel = '', selectedBlockDetails = false;
  let buildScale = 1, drag = null, moved = false, destroyed = false;
  // Interaction preview: transformed bitmap while panning/zooming.
  let interacting = false, interactionTimer = 0;
  let previewCanvas = null, previewView = null, previewValid = false;
  const bufferCache = new Map(), repCache = new Map(), analyticCache = new Map();
  const gradientCache = new Map();
  const rasterCache = new Map();
  const rasterProbes = new Map();
  const warnedDisplayTopologies = new Set();

  // ----- envelope buffers --------------------------------------------------
  function base64Bytes(text) {
    const bin = atob(text), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bufferBytes(id) {
    let bytes = bufferCache.get(id);
    if (!bytes) {
      const binary = envelope.transportProfile === 'ucd-binary-manifest/1'
        && envelope.decodedBuffers && envelope.decodedBuffers.has(id);
      if (binary) {
        const raw = envelope.decodedBuffers.get(id);
        bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      } else {
        const payload = (envelope.bufferPayloads || {})[id];
        if (!payload) throw new Error('buffer ' + id + ' is not in this envelope');
        bytes = base64Bytes(payload);
      }
      bufferCache.set(id, bytes);
    }
    return bytes;
  }
  function accessorView(id) {
    const a = ucd.accessors[id];
    if (!a) throw new Error('missing accessor ' + id);
    const bytes = bufferBytes(a.bufferId);
    const count = a.count * (a.components || 1), offset = a.byteOffset || 0;
    if (a.component === 'u32') return new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count);
    if (a.component === 'f32') return new Float32Array(bytes.buffer, bytes.byteOffset + offset, count);
    return new Float64Array(bytes.buffer, bytes.byteOffset + offset, count);
  }
  const rasterReady = Promise.all([...new Map(Object.values(media?.items || {}).filter(item=>item.status==='ready')
    .map(item=>[item.resourceId,item])).values()].map(async item=>{
      const bitmap = await createImageBitmap(new Blob([bufferBytes(item.bufferId)],{type:'image/png'}));
      try {
        if (destroyed) return;
        if (bitmap.width!==item.pixelSize[0]||bitmap.height!==item.pixelSize[1]) throw new Error('媒体派生产物尺寸不一致');
        const target=document.createElement('canvas');target.width=bitmap.width;target.height=bitmap.height;
        target.getContext('2d',{willReadFrequently:true}).drawImage(bitmap,0,0);
        rasterCache.set(item.resourceId,target);
      } finally { bitmap.close(); }
    })).then(()=>{if(!destroyed)draw();});
  function representationGeometry(repId) {
    if (!repId) return null;
    if (repCache.has(repId)) return repCache.get(repId);
    const rep = ucd.representations[repId];
    if (!rep) return null;
    const geo = ucd.geometries[rep.bindings[0].geometryId];
    if (!geo) return null;
    const primitive = geo.primitives[0];
    const result = {
      positions: accessorView(geo.attributes.POSITION),
      indices: primitive.indices ? accessorView(primitive.indices) : null,
      topology: primitive.topology,
      range: primitive.range,
      localFromRepresentation: rep.bindings[0].localFromRepresentation
    };
    repCache.set(repId, result); return result;
  }

  // ----- analytic evaluation ---------------------------------------------
  const MAX_SEG = 4096;
  function arcSegments(radius, tolerance) {
    if (!(radius > 0)) return 8;
    const ratio = Math.max(-1, Math.min(1, 1 - tolerance / radius));
    const step = 2 * Math.acos(ratio);
    return Math.max(8, Math.min(MAX_SEG, Math.ceil((2 * Math.PI) / Math.max(step, 1e-4))));
  }
  function bulgePoints(p1, p2, bulge, z, tolerance) {
    if (!bulge) return [[p1[0], p1[1], z], [p2[0], p2[1], z]];
    const theta = 4 * Math.atan(bulge);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], chord = Math.hypot(dx, dy);
    if (chord < 1e-12) return [[p1[0], p1[1], z]];
    const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
    const n = Math.max(4, Math.min(MAX_SEG, Math.ceil(Math.abs(theta) / Math.max(2 * Math.acos(Math.max(-1, 1 - tolerance / Math.max(radius, 1e-9))), 1e-4))));
    const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    const h = Math.sqrt(Math.max(radius * radius - chord * chord / 4, 0)) * (bulge < 0 ? -1 : 1);
    const cx = mx - dy / chord * h, cy = my + dx / chord * h;
    const a0 = Math.atan2(p1[1] - cy, p1[0] - cx), out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + theta * i / n; out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), z]); }
    return out;
  }
  function splinePoints(geo, tolerance) {
    const ctrl = geo.controlPoints, degree = geo.degree, knots = geo.knots;
    const weight = (geo.weights && geo.weights.length === ctrl.length) ? geo.weights : ctrl.map(() => 1);
    const n = ctrl.length;
    if (n < degree + 1) return ctrl.slice();
    const t0 = knots[degree], t1 = knots[n];
    if (!(t1 > t0)) return ctrl.slice();
    let length = 0;
    for (let i = 1; i < n; i++) length += Math.hypot(ctrl[i][0] - ctrl[i - 1][0], ctrl[i][1] - ctrl[i - 1][1], ctrl[i][2] - ctrl[i - 1][2]);
    const count = Math.max(16, Math.min(MAX_SEG, Math.ceil(length / Math.max(tolerance, 1e-9))));
    const out = [];
    for (let i = 0; i <= count; i++) {
      const u = Math.min(t1 - 1e-12, t0 + (t1 - t0) * i / count);
      let k = n - 1;
      for (let j = degree; j < n; j++) if (u >= knots[j] && u < knots[j + 1]) { k = j; break; }
      const d = [];
      for (let j = 0; j <= degree; j++) {
        const idx = Math.max(0, Math.min(n - 1, k - degree + j));
        d.push([ctrl[idx][0], ctrl[idx][1], ctrl[idx][2], weight[idx]]);
      }
      for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
        const i0 = k - degree + j, den = knots[i0 + degree - r + 1] - knots[i0];
        const a = den > 1e-12 ? (u - knots[i0]) / den : 0;
        d[j] = [d[j - 1][0] * (1 - a) + d[j][0] * a, d[j - 1][1] * (1 - a) + d[j][1] * a,
                d[j - 1][2] * (1 - a) + d[j][2] * a, d[j - 1][3] * (1 - a) + d[j][3] * a];
      }
      const top = d[degree], w = top[3] || 1;
      out.push([top[0] / w, top[1] / w, top[2] / w]);
    }
    return out;
  }
  function analyticPoints(geo, tolerance) {
    if (geo.type === 'line') return [geo.start, geo.end];
    if (geo.type === 'point') return [geo.position];
    if (geo.type === 'arc') {
      const n = arcSegments(geo.radius, tolerance);
      const xAxis = geo.xAxis || [1, 0, 0], normal = geo.normal || [0, 0, 1];
      const yAxis = [normal[1] * xAxis[2] - normal[2] * xAxis[1], normal[2] * xAxis[0] - normal[0] * xAxis[2], normal[0] * xAxis[1] - normal[1] * xAxis[0]];
      const out = [], sweep = geo.sweepAngle || Math.PI * 2;
      for (let i = 0; i <= n; i++) {
        const a = (geo.startAngle || 0) + sweep * i / n, c = Math.cos(a), s = Math.sin(a);
        out.push([geo.center[0] + (xAxis[0] * c + yAxis[0] * s) * geo.radius,
                  geo.center[1] + (xAxis[1] * c + yAxis[1] * s) * geo.radius,
                  geo.center[2] + (xAxis[2] * c + yAxis[2] * s) * geo.radius]);
      }
      return out;
    }
    if (geo.type === 'ellipse') {
      const major = geo.majorAxis, minor = geo.minorAxis;
      const n = arcSegments(Math.max(Math.hypot(...major), Math.hypot(...minor)), tolerance);
      const out = [], sweep = geo.sweepAngle || Math.PI * 2;
      for (let i = 0; i <= n; i++) {
        const t = (geo.startAngle || 0) + sweep * i / n, c = Math.cos(t), s = Math.sin(t);
        out.push([geo.center[0] + major[0] * c + minor[0] * s, geo.center[1] + major[1] * c + minor[1] * s, geo.center[2] + major[2] * c + minor[2] * s]);
      }
      return out;
    }
    if (geo.type === 'polyline') {
      const pts = geo.points || [];
      if (pts.length < 2) return pts.slice();
      const closed = !!geo.closed, bulges = geo.bulges || [], out = [];
      const pairs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < pairs; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % pts.length], z = (p1[2] + p2[2]) / 2;
        let seg = bulgePoints(p1, p2, bulges[i] || 0, z, tolerance);
        if (out.length && Math.abs(out[out.length - 1][0] - seg[0][0]) < 1e-9 && Math.abs(out[out.length - 1][1] - seg[0][1]) < 1e-9) seg = seg.slice(1);
        out.push(...seg);
      }
      return out.length ? out : pts.slice();
    }
    if (geo.type === 'spline') return splinePoints(geo, tolerance);
    return null;
  }
  function analyticFor(itemId, geo, tolerance) {
    const key = itemId + ':' + tolerance.toPrecision(6);
    if (analyticCache.has(key)) return analyticCache.get(key);
    const points = analyticPoints(geo, tolerance);
    if (analyticCache.size > 4000) analyticCache.clear();
    analyticCache.set(key, points);
    return points;
  }

  // ----- filled entities (SOLID / solid HATCH) ----------------------------
  function fillPathFor(draw, entity, tolerance) {
    const fill = fillGeometryFor({
      draw, entity, fillEntry:fillEntryFor(ucd, draw.itemId), mode, tolerance,
      representationGeometry, analyticFor,
      toWorld:point => apply(draw.localToSpace, point),
      boundaryGeometry:id => drawing.entities[id] && drawing.entities[id].geometry
    });
    if (!fill || !fill.bbox) return null;
    const path = new Path2D();
    if (fill.kind === 'triangles') {
      for (const triangle of fill.triangles) {
        path.moveTo(...triangle[0]); path.lineTo(...triangle[1]); path.lineTo(...triangle[2]); path.closePath();
      }
      return {path, triangles:fill.triangles, bbox:fill.bbox};
    }
    for (const ring of fill.rings) {
      if (!ring.length) continue;
      path.moveTo(...ring[0]);
      for (const point of ring.slice(1)) path.lineTo(...point);
      path.closePath();
    }
    return {path, rings:fill.rings, bbox:fill.bbox};
  }
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function fillHit(rec, x, y) {
    if (rec.clipRegion.active) return rec.visibleGeometry.polygons.some(p=>insideRing(x,y,p));
    if (rec.fillTriangles) {
      for (const [a, b, c] of rec.fillTriangles) {
        const d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
        const d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1]);
        const d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1]);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
      }
      return false;
    }
    let inside = false;
    for (const ring of rec.fillRings || []) if (pointInRing(x, y, ring)) inside = !inside;
    return inside;
  }

  // ----- build ------------------------------------------------------------
  function apply(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]]; }
  function matrixScale(m) { return Math.hypot(m[0], m[1]) || 1; }
  function lineWidthPx(mm) { return Math.max(0.6, Math.min(4.0, 0.75 + (Number(mm || 0.25) - 0.25) * 1.1)); }
  function dashFor(style, itemId) {
    return lineDashFor(style, itemId, {lineTypes:drawing.lineTypes, styleExt});
  }
  function itemLayer(draw) { return draw.kind === 'entity' ? drawing.entities[draw.itemId].layerId : drawing.annotations[draw.itemId].layerId; }
  // Layer-0 inheritance is resolved once in drawing projection: each draw publishes
  // the effective layer. The viewer only applies it to visibility toggles and must not
  // re-derive block inheritance from its own copy of the tables.
  function effectiveLayer(draw) { return effectiveLayers.get(draw) || itemLayer(draw); }
  function layerSourceVisible(layerId) {
    const state = projection.layerStates[layerId];
    return state ? !!(state.visible && !state.frozen) : true;
  }
  function layerVisible(layerId) {
    return layerSourceVisible(layerId) && (userLayers.has(layerId) ? userLayers.get(layerId) : true);
  }
  function drawVisible(rec) {
    const draw = rec.draw;
    if (draw.visibility === 'hidden' || draw.availability !== 'ready') return false;
    const hasGeometry=rec.infinite ? rec.clipRegion.finiteBounds===undefined || !!rec.navigationBounds : !!rec.visibleGeometry.bounds;
    return hasGeometry && layerVisible(rec.layerId) && draw.visibilityLayerIds.every(layerVisible);
  }
  function rgba(style) {
    const c = style.color || [1, 1, 1, 1];
    return 'rgba(' + [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), (style.opacity ?? 1)].join(',') + ')';
  }
  function addRecord(rec) {
    if (rec.infinite) {
      const window=rec.clipRegion.finiteBounds;
      const segment=window && clipInfiniteLine(rec.infinite,window);
      rec.navigationBounds=segment ? rec.clipRegion.geometry({segments:segment}).bounds : null;
    } else if (rec.clipRegion.active) {
      const polygons=rec.fillTriangles || (rec.fillRings ? triangulateRings(rec.fillRings)
        : rec.raster ? [rec.raster.corners] : rec.textEntry ? [textWorldCorners(rec.textEntry,textOffsets(rec.textEntry))] : []);
      rec.visibleGeometry=rec.clipRegion.geometry({segments:rec.segments||[],polygons,
        points:rec.pointMark?[[rec.pointMark.x,rec.pointMark.y]]:[]});
    } else rec.visibleGeometry={bounds:rec.bbox,segments:rec.segments||[]};
    built.push(rec);
    if(instancePlan)instancePlan.drawGroups.get(rec.draw).records.push(rec);
  }
  function applyTextAvoidance() {
    if (!textAvoidance || !nativeTextLayout) return;
    const entries = [], seen = new Set();
    for (const rec of built) {
      const entry = rec.textEntry;
      // Block-internal text (dimension pictures, attributes) keeps its source
      // position: retained instances share one record, so moving it would move
      // every copy and can put a dimension at a neighbour's place.
      if (!entry || seen.has(entry) || !drawVisible(rec)
        || (rec.draw.blockPath || []).length || inDimensionBlock(rec.draw)) continue;
      seen.add(entry);
      const box = textDisplayBox(entry);
      if (!box) continue;
      entries.push({id: entry.itemId + '@' + entries.length, box, entry, rec});
    }
    if (!entries.length) return;
    const resolved = resolveTextAvoidance(entries.map(({id, box}) => ({id, box})), {gap: 0});
    for (const item of entries) {
      const choice = resolved.get(item.id);
      if (!choice) continue;
      const entry = item.entry;
      entry.sourceBox = entry.sourceBox || entry.box;
      entry.sourceX = entry.sourceX ?? entry.x;
      entry.sourceY = entry.sourceY ?? entry.y;
      entry.displayX = entry.x + choice.dx;
      entry.displayY = entry.y + choice.dy;
      entry.displayBox = choice.box;
      entry.box = choice.box;
      entry.avoidance = choice.dx || choice.dy
        ? {dx: choice.dx, dy: choice.dy, sourceX: entry.sourceX, sourceY: entry.sourceY}
        : null;
      item.rec.textBox = choice.box;
      item.rec.bbox = choice.box;
      if (item.rec.visibleGeometry) item.rec.visibleGeometry.bounds = choice.box;
    }
  }

  function rebuild() {
    built = []; texts = []; pointMarks = [];
    if(instancePlan)for(const group of instancePlan.groups)group.records=[];
    plotErrors.clear();
    buildScale = scale;
    const tolerance = Math.max(1e-7, 0.35 / Math.max(scale, 1e-9));
    const ordered = Object.keys(projection.draws).map(id => [id, projection.draws[id]]).sort((a, b) => a[1].drawOrder - b[1].drawOrder);
    for (const [drawId, draw] of ordered) {
      const layerId = effectiveLayer(draw);
      const plotContext=spaceTarget.kind==='layout'?spaceTarget.layoutId:'model';
      // Retained draws carry a group-qualified key; plot styles are resolved by
      // the source draw id, which the retained path reconstructs from its path.
      const plotDrawId=instancePlan?instancePlan.identity(draw,draw.blockPath):drawId;
      const plotEntry=plotPreview?plotStyles?.resolved?.[plotContext]?.[plotDrawId]:null;
      let rootStyle=draw.style;
      try {rootStyle=plotAppearance(rootStyle,plotEntry?.root);} catch(error) {plotErrors.add(error.message);continue;}
      const rec = { id: drawId, draw, layerId, clipRegion:compileClips(drawingClips(draw,projection.viewports)), path: null, segments: null, fillPath: null, fillTriangles: null, fillRings: null, width: lineWidthPx(draw.style.lineWeight && draw.style.lineWeight.value), dash: dashFor(draw.style, draw.itemId), color: rgba(draw.style), bbox: null };
      rec.width=lineWidthPx(rootStyle.lineWeight?.value);rec.color=rgba(rootStyle);rec.plotPen=plotEntry?.root?.style;
      const annotationDisplay = annotationItems[draw.itemId];
      if (annotationDisplay) {
        // One source identity/selection, many library-generated presentation parts.
        // A failed derivative never falls back to unformatted, misleading text.
        if (annotationDisplay.status === 'ready') {
          const styles = new Map((presentationStyles[drawId] || draw.presentationStyles || []).map(row => [row.id, row]));
          const sourceParts=[annotationDisplay,...(annotationDisplay.scaleVariants||[])].flatMap(entry=>entry.parts);
          for (const part of sourceParts) {
            const resolved = styles.get(part.id);
            if (!resolved) continue;
            const pen=plotEntry?.parts?.[part.id];
            let style,parts;
            try {style=plotAppearance(resolved.style,pen);parts=plotParts(part,resolved.presentationParts,pen,plotContext,plotDrawId);}
            catch(error) {plotErrors.add(error.message);continue;}
            for (const renderedPart of parts) {
              const partDraw = { ...draw, style: resolved.style, visibility: resolved.visibility,
                visibilityLayerIds: resolved.visibilityLayerIds || draw.visibilityLayerIds };
              // Retained draws carry group-qualified ids; presentation parts must
              // stay in the same retained group as their source draw.
              if(instancePlan)instancePlan.drawGroups.set(partDraw,instancePlan.drawGroups.get(draw));
              const child = { ...rec, draw: partDraw, layerId: resolved.layerId,
                width: lineWidthPx(resolved.style.lineWeight?.value), dash: resolved.presentationParts ? [] : dashFor(resolved.style, part.id), color: rgba(resolved.style), fillRule: renderedPart.fillRule || 'evenodd' };
              child.width=lineWidthPx(style.lineWeight?.value);child.color=rgba(style);child.plotPen=pen?.style;
              if (part.role==='text' && child.plotPen) child.plotPen={...child.plotPen,fill:64};
              if (part.clipRegions?.length) child.clipRegion=compileClips([
                ...drawingClips(draw,projection.viewports),...part.clipRegions.map(clip=>({...clip,
                  boundary:clip.boundary.map(point=>apply(draw.localToSpace,[...point,0]).slice(0,2))}))]);
              if (pen && pen.style.lineType!==31) child.dash=[];
              if (part.role === 'infinite') {
                const origin = apply(draw.localToSpace, part.line.origin);
                const direction = [draw.localToSpace[0] * part.line.direction[0] + draw.localToSpace[4] * part.line.direction[1] + draw.localToSpace[8] * part.line.direction[2],
                  draw.localToSpace[1] * part.line.direction[0] + draw.localToSpace[5] * part.line.direction[1] + draw.localToSpace[9] * part.line.direction[2]];
                child.infinite = {kind: part.line.kind, origin, direction};
                addRecord(child); continue;
              }
              const geometry = representationGeometry(renderedPart.representationId);
              if (!geometry) continue;
              child.mask = part.role === 'mask';
              const positions = geometry.positions, indices = geometry.indices;
              const point = index => apply(draw.localToSpace, [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]]);
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              const extend = p => { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); };
              const path = new Path2D();
              if (geometry.topology === 'triangles') {
                child.fillTriangles = [];
                for (let i = 0; i + 2 < indices.length; i += 3) {
                  const tri = [point(indices[i]), point(indices[i + 1]), point(indices[i + 2])];
                  path.moveTo(...tri[0]); path.lineTo(...tri[1]); path.lineTo(...tri[2]); path.closePath();
                  tri.forEach(extend); child.fillTriangles.push(tri);
                }
                child.fillPath = path;
              } else if (geometry.topology === 'points') {
                for (let index=0; index<positions.length/3; index++) {
                  const p=point(index), mark={...child,pointMark:{x:p[0],y:p[1],dot:renderedPart.role==='stroke'},bbox:{minX:p[0],minY:p[1],maxX:p[0],maxY:p[1]}};
                  pointMarks.push(mark.pointMark);addRecord(mark);
                }
                continue;
              } else {
                child.segments = [];
                for (let i = 0; i + 1 < indices.length; i += 2) {
                  const a = point(indices[i]), b = point(indices[i + 1]);
                  extend(a); extend(b);
                  child.segments.push(...a, ...b);
                }
                traceStrokeSegments(path, child.segments);
                child.path = path;
              }
              if (Number.isFinite(minX)) {
                child.bbox = { minX, minY, maxX, maxY };
                if (part.role === 'text') child.textBox = child.bbox;
                addRecord(child);
              }
            }
          }
        }
        continue;
      }
      if (draw.kind === 'entity') {
        const entity = drawing.entities[draw.itemId];
        if (!entity || entity.geometry.type === 'unsupported') continue;
        if (entity.geometry.type === 'image') {
          const raster = rasterRecord(entity, draw, mediaItemFor(ucd, draw.itemId));
          if (!raster) continue;
          rec.raster={resourceId:raster.resourceId,corners:raster.corners,w:raster.w,h:raster.h,opacity:raster.opacity};
          rec.bbox=raster.bbox;
          addRecord(rec);continue;
        }
        const fillEntry = fillEntryFor(ucd, draw.itemId);
        const patternHatch = hatchFillKind(entity, fillEntry) === 'pattern';
        if (entity.geometry.type === 'hatch' && !patternHatch) {
          const fill = fillPathFor(draw, entity, tolerance);
          if (!fill) continue;
          rec.fillPath = fill.path; rec.fillTriangles = fill.triangles; rec.fillRings = fill.rings;
          rec.bbox = fill.bbox;
          rec.gradient = fillEntry?.gradient;
          addRecord(rec);
          continue;
        }
        const segments = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const extend = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        // Pattern strokes already encode their own dashes/dots. Keep them in
        // both display modes; drawing boundary polygons would solid-fill holes.
        if (patternHatch || mode === 'display') {
          const representation = representationGeometry(draw.displayRepresentationId);
          const skip = splineOriginPair(entity, representation) ? 2 : 0;
          const stroke = strokeSegmentsForRepresentation(representation,
            point => apply(draw.localToSpace, point), skip);
          if (!stroke) continue;
          if (stroke.invalidRange) {
            if (!warnedDisplayTopologies.has('invalid-lines')) {
              warnedDisplayTopologies.add('invalid-lines');
              console.warn('忽略非索引线段范围：顶点数或 range 不合法', draw.displayRepresentationId);
            }
            continue;
          }
          if (stroke.unsupported) {
            if (!warnedDisplayTopologies.has(stroke.unsupported)) {
              warnedDisplayTopologies.add(stroke.unsupported);
              console.warn('忽略未接入的显示拓扑', stroke.unsupported, draw.displayRepresentationId);
            }
            continue;
          }
          if (patternHatch) rec.dash = [];
          segments.push(...stroke.segments);
          if (stroke.points.length) {
            const p = stroke.points[0];
            rec.pointMark = {x: p[0], y: p[1]}; pointMarks.push(rec.pointMark);
          }
          if (stroke.bbox) { extend(stroke.bbox.minX, stroke.bbox.minY); extend(stroke.bbox.maxX, stroke.bbox.maxY); }
        } else {
          const pts = analyticFor(draw.itemId, entity.geometry, tolerance);
          if (!pts || !pts.length) continue;
          if (entity.geometry.type === 'point' || pts.length === 1) {
            const p = apply(draw.localToSpace, pts[0]);
            rec.pointMark = {x: p[0], y: p[1]}; pointMarks.push(rec.pointMark); extend(p[0], p[1]);
          } else {
            let previous = null;
            for (const p of pts) {
              const q = apply(draw.localToSpace, p);
              if (previous) segments.push(previous[0], previous[1], q[0], q[1]);
              extend(q[0], q[1]); previous = q;
            }
          }
        }
        if (!segments.length && minX === Infinity) continue;
        const path = new Path2D();
        traceStrokeSegments(path, segments);
        rec.path = path; rec.segments = segments; rec.bbox = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
        addRecord(rec);
      } else {
        const annotation = drawing.annotations[draw.itemId];
        if (!annotation) continue;
        const annotationFont = annotationRuns(annotation);
        const layout = layoutAnnotationText(annotation, draw, {
          measure: measureReference,
          nativeLayout: nativeTextLayout,
          color: rec.color,
          fontFamily: annotationFont.runs ? annotationFont.defaultFont : fontFamilyFor(annotation),
          runs: annotationFont.runs
        });
        rec.bbox = { minX: layout.anchor[0], minY: layout.anchor[1],
          maxX: layout.anchor[0], maxY: layout.anchor[1] };
        if (layout.run) {
          const entry = {...layout.run, draw, drawId, itemId: draw.itemId};
          rec.bbox = entry.box; rec.textBox = entry.box;
          rec.textEntry = entry;
          texts.push(entry);
        }
        addRecord(rec);
      }
    }
    applyTextAvoidance();
    if(instancePlan)buildInstanceIndexes();
    draw();
    updateStats();
    renderLayers();
  }

  // Retained block rendering is a capacity strategy inside this viewer. The
  // projection still resolves UCD styles/ownership; Flatbush supplies the spatial
  // index and Canvas Path2D batches consecutive opaque strokes in source order.
  function projectionCount(){return instancePlan?instancePlan.count:Object.keys(projection.draws).length;}
  function buildInstanceIndexes(){
    if(!instancePlan)return;
    const active=new Set(),done=new Set();
    instancePlan.infiniteAnchor=null;
    function compile(group,matrix){
      if(done.has(group))return;if(active.has(group))throw new Error('cyclic-instance-plan');active.add(group);
      const byId=new Map();for(const rec of group.records){const rows=byId.get(rec.id)||[];rows.push(rec);byId.set(rec.id,rows);}
      group.bounds=null;group.unbounded=false;group.paint=[];group.hits=[];group.visibleCount=0;group.byKind={entity:0,annotation:0};
      // Merge strokes with the same style inside each barrier segment (a barrier
      // is any non-stroke entry: group, fill, text, raster, clipped record...).
      // Same-style strokes may then paint in first-appearance order; strokes of
      // different styles keep their segment order and never cross a barrier.
      let pending=new Map();
      const flush=()=>{for(const batch of pending.values())group.paint.push(batch);pending=new Map();};
      for(const entry of group.entries){
        if(entry.kind==='group'){
          flush();
          compile(entry.group,multiply(matrix,entry.matrix));entry.bounds=transformBounds(entry.group.bounds,entry.matrix);
          group.bounds=union(group.bounds,entry.bounds);group.unbounded=group.unbounded||entry.group.unbounded;
          group.paint.push(entry);if(entry.bounds)group.hits.push(entry);
          group.visibleCount+=entry.group.visibleCount;
          for(const kind of ['entity','annotation'])group.byKind[kind]+=entry.group.byKind[kind];
          continue;
        }
        const visible=[];
        for(const rec of byId.get(entry.id)||[]){
          if(!drawVisible(rec))continue;
          // Infinite lines get a finite navigation box only when a clip window
          // bounds them; unbounded ones are painted per frame and stay unindexed.
          const box=recordVisibleBounds(rec);
          if(!box&&!rec.infinite)continue;
          if(!box&&!instancePlan.infiniteAnchor)
            instancePlan.infiniteAnchor=transformPoint(matrix,...rec.infinite.origin);
          visible.push([rec,box]);
        }
        if(visible.length){group.visibleCount++;group.byKind[visible[0][0].draw.kind]++;}
        for(const [rec,box] of visible){
          rec.instanceOrder=entry.order;
          if(box)group.bounds=union(group.bounds,box);else group.unbounded=true;
          if(box)group.hits.push({kind:'record',rec,bounds:box,order:entry.order});
          const opaque=(rec.draw.style.opacity??1)===1;
          if(box&&rec.path&&!rec.fillPath&&!rec.textEntry&&!rec.pointMark&&!rec.infinite&&!rec.raster&&!rec.clipRegion.active&&opaque){
            const key=JSON.stringify([rec.color,rec.width,rec.dash]);
            let batch=pending.get(key);
            if(!batch){batch={kind:'stroke',key,path:new Path2D(),color:rec.color,width:rec.width,dash:rec.dash,bounds:null,count:0};pending.set(key,batch);}
            batch.path.addPath(rec.path);batch.bounds=union(batch.bounds,box);batch.count++;
          }else{flush();group.paint.push({kind:'record',rec,bounds:box});}
        }
      }
      flush();
      group.index=group.hits.length?new Flatbush(group.hits.length):null;
      if(group.index){for(const row of group.hits){const b=row.bounds;group.index.add(b.minX,b.minY,b.maxX,b.maxY);}group.index.finish();}
      active.delete(group);done.add(group);
    }
    for(const node of instancePlan.roots)compile(node.group,node.matrix);
    instanceLayerKey=JSON.stringify([...userLayers]);
  }
  function refreshInstanceLayers(){if(instancePlan&&instanceLayerKey!==JSON.stringify([...userLayers]))buildInstanceIndexes();}
  function drawInstances(){
    const profile = typeof window !== 'undefined' && window.__CAD_VIEWER_PROFILE__ === true;
    const paintStarted = profile ? performance.now() : 0;
    refreshInstanceLayers();
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,cssW,cssH);
    const view={minX:-tx/scale,maxX:(cssW-tx)/scale,minY:(ty-cssH)/scale,maxY:ty/scale};
    let calls=0;
    const intersects=b=>b&&b.minX<=view.maxX&&b.maxX>=view.minX&&b.minY<=view.maxY&&b.maxY>=view.minY;
    function setMatrix(m){ctx.setTransform(dpr*scale*m[0],-dpr*scale*m[1],dpr*scale*m[4],-dpr*scale*m[5],dpr*(tx+scale*m[12]),dpr*(ty-scale*m[13]));}
    function localClipBounds(matrix){const inverse=inverse2D(matrix);return inverse?transformBounds(view,inverse):null;}
    function paint(node,parent){
      const matrix=multiply(parent,node.matrix);
      if(!node.group.unbounded&&!intersects(transformBounds(node.group.bounds,matrix)))return;
      const localScale=scale*Math.max(Math.hypot(matrix[0],matrix[1]),Math.hypot(matrix[4],matrix[5]),1e-15);
      for(const entry of node.group.paint){
        if(entry.kind==='group'){paint(entry,matrix);continue;}
        if(entry.bounds&&!intersects(transformBounds(entry.bounds,matrix)))continue;
        if(entry.kind==='stroke'){
          setMatrix(matrix);calls++;
          ctx.strokeStyle=entry.color;ctx.lineWidth=entry.width/localScale;ctx.lineJoin='round';ctx.lineCap=entry.dash?.length?'round':'butt';ctx.setLineDash(entry.dash||[]);ctx.stroke(entry.path);continue;
        }
        const rec=entry.rec;
        if(rec.infinite){
          // Infinite construction lines stay clipped to the visible window; the
          // retained line is expressed in this group's local coordinates. An
          // unbounded line has no index box, so it is painted every frame.
          const inverse=inverse2D(matrix);
          updateInfinite(rec,inverse?transformBounds(view,inverse):view);
          if(!rec.path)continue;
          calls++;
          setMatrix(matrix);
          ctx.save();
          // The view window only bounds the parametric line; the source clip
          // still cuts the painted stroke, matching the ordinary path.
          if(rec.clipRegion.active){const bounds=localClipBounds(matrix);if(bounds)rec.clipRegion.apply(ctx,bounds);}
          ctx.setLineDash(rec.dash||[]);ctx.strokeStyle=rec.color;ctx.lineWidth=rec.width/localScale;
          ctx.stroke(rec.path);
          ctx.restore();
          continue;
        }
        setMatrix(matrix);calls++;
        ctx.save();
        if(rec.clipRegion.active){const bounds=localClipBounds(matrix);if(bounds)rec.clipRegion.apply(ctx,bounds);}
        ctx.setLineDash([]);
        if(rec.raster)drawRaster(rec);
        if(rec.fillPath){
          if(rec.gradient)drawGradient(rec);
          else {ctx.fillStyle=rec.mask?'#ffffff':rec.color;ctx.fill(rec.fillPath,rec.fillRule||'evenodd');}
        }
        if(rec.path){ctx.strokeStyle=rec.color;ctx.lineWidth=rec.width/localScale;ctx.setLineDash(rec.dash||[]);ctx.stroke(rec.path);}
        if(rec.pointMark){const p=rec.pointMark;ctx.strokeStyle=rec.color;ctx.lineWidth=1/localScale;ctx.beginPath();ctx.moveTo(p.x-2.5/localScale,p.y);ctx.lineTo(p.x+2.5/localScale,p.y);ctx.moveTo(p.x,p.y-2.5/localScale);ctx.lineTo(p.x,p.y+2.5/localScale);ctx.stroke();}
        if(rec.textEntry){
          const t=rec.textEntry;
          drawTextLeader(t,matrix);
          // Match the ordinary path: raw annotations keep a legible minimum
          // screen size, while presentation glyph parts stay at source scale.
          const screen=Math.max(t.nativeLayout?0.7:5,Math.min(220,t.size*localScale));
          ctx.save();ctx.translate(t.displayX??t.x,t.displayY??t.y);ctx.rotate(t.angle);ctx.scale(1,-1);ctx.fillStyle=t.color;ctx.font=(screen/localScale)+'px '+(t.fontFamily||TEXT_FONT);ctx.textBaseline='alphabetic';
          const off=textOffsets(t);
          if(t.runLines){
            for(let i=0;i<t.runLines.length;i++){
              let x=off.dx;const y=off.dy+i*(t.lineHeight||t.height*1.25);
              for(const seg of t.runLines[i].segments){
                if(!seg.text)continue;
                ctx.font=(screen/localScale)+'px '+(seg.fontFamily||t.fontFamily||TEXT_FONT);
                ctx.fillStyle=seg.color||t.color;
                ctx.fillText(seg.text,x,y);x+=seg.width;
              }
            }
          }else{
            for(let i=0;i<t.lines.length;i++)ctx.fillText(t.lines[i],off.dx,off.dy+i*(t.lineHeight||t.height*1.25));
          }
          ctx.restore();
        }
        ctx.restore();
      }
    }
    for(const root of instancePlan.roots)paint(root,I);
    instancePlan.lastPaintCalls=calls;
    if(profile){canvas.dataset.lastPaintMs=(performance.now()-paintStarted).toFixed(1);canvas.dataset.lastPaintCalls=String(calls);}
    if(instanceSelected){
      const {record:rec,matrix}=instanceSelected.instance;setMatrix(matrix);ctx.setLineDash([]);ctx.strokeStyle=ACCENT;ctx.lineWidth=2.4/(scale*Math.max(matrixScale(matrix),1e-15));
      if(rec.path)ctx.stroke(rec.path);else if(rec.fillPath)ctx.stroke(rec.fillPath);else if(rec.bbox){const b=rec.bbox;ctx.strokeRect(b.minX,b.minY,b.maxX-b.minX,b.maxY-b.minY);}
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    cacheFullFrame();
  }
  function hitInstances(sx,sy){
    refreshInstanceLayers();const world=[(sx-tx)/scale,(ty-sy)/scale],worldTolerance=5/scale;
    function query(node,parent,path,baseOrder){
      const matrix=multiply(parent,node.matrix),inverse=inverse2D(matrix);if(!inverse||!node.group.index)return null;
      const point=transformPoint(inverse,...world),box=transformBounds({minX:world[0]-worldTolerance,minY:world[1]-worldTolerance,maxX:world[0]+worldTolerance,maxY:world[1]+worldTolerance},inverse);
      const candidates=node.group.index.search(box.minX,box.minY,box.maxX,box.maxY).map(i=>node.group.hits[i]).sort((a,b)=>b.order-a.order);
      const nextPath=path.concat(node.path);
      for(const entry of candidates){
        if(entry.kind==='group'){const hit=query(entry,matrix,nextPath,baseOrder+entry.order);if(hit)return hit;continue;}
        const rec=entry.rec;if(rec.clipRegion.active&&!rec.clipRegion.contains(...point))continue;
        let hit=!!rec.textBox||!!(rec.fillPath&&fillHit(rec,...point));
        if(rec.raster)hit=rasterHit(rec,...point);
        if(rec.pointMark)hit=Math.hypot(...transformPoint(matrix,rec.pointMark.x,rec.pointMark.y).map((v,k)=>v-world[k]))<=worldTolerance;
        const segments=rec.visibleGeometry?.segments||[];
        for(let i=0;!hit&&i<segments.length;i+=4){const a=transformPoint(matrix,segments[i],segments[i+1]),b=transformPoint(matrix,segments[i+2],segments[i+3]);hit=segmentDistance(...world,...a,...b)<=worldTolerance;}
        if(hit){const draw={...rec.draw,blockPath:nextPath,localToSpace:multiply(matrix,rec.draw.localToSpace),drawOrder:baseOrder+entry.order};
          return {...rec,id:instancePlan.identity(draw,nextPath),draw,bbox:transformBounds(rec.bbox,matrix),instance:{record:rec,matrix}};}
      }
      return null;
    }
    let base=instancePlan.count;
    for(let i=instancePlan.roots.length-1;i>=0;i--){const root=instancePlan.roots[i];base-=root.group.count;const hit=query(root,I,[],base);if(hit)return hit;}
    return null;
  }

  // ----- render -----------------------------------------------------------
  function resize() {
    const r = viewport.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(200, r.width); cssH = Math.max(200, r.height);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    // The first ResizeObserver delivery is the first real size; fitting before it
    // would use the placeholder width and leave the drawing off-centre.
    if (!fitted) fit(); else draw();
  }
  // ----- interaction preview ---------------------------------------------
  // While the user pans or zooms, reuse the last full frame as a transformed
  // bitmap; the vector scene is repainted once the interaction settles. This
  // keeps wheel/drag feedback cheap on drawings with >1M expanded draws.
  function cacheFullFrame() {
    if (!previewCanvas) previewCanvas = document.createElement('canvas');
    if (previewCanvas.width !== canvas.width || previewCanvas.height !== canvas.height) {
      previewCanvas.width = canvas.width; previewCanvas.height = canvas.height;
    }
    const cache = previewCanvas.getContext('2d');
    cache.setTransform(1, 0, 0, 1, 0, 0);
    cache.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    cache.drawImage(canvas, 0, 0);
    previewView = { scale, tx, ty };
    previewValid = true;
  }
  function interactionSettled() {
    if (destroyed) return;
    if (mode === 'analytic' && (scale > buildScale * 2 || scale < buildScale / 2)) rebuild(); else draw();
  }
  function beginInteraction() {
    interacting = true;
    if (interactionTimer) clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => {
      interactionTimer = 0; interacting = false; interactionSettled();
    }, 140);
  }
  function endInteraction() {
    if (interactionTimer) { clearTimeout(interactionTimer); interactionTimer = 0; }
    if (!interacting) return;
    interacting = false;
    interactionSettled();
  }
  function drawPreview() {
    if (!previewValid || !previewCanvas || !previewView) return false;
    if (previewCanvas.width !== canvas.width || previewCanvas.height !== canvas.height) return false;
    const k = scale / previewView.scale;
    if (!Number.isFinite(k) || k < 0.05 || k > 20) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, dpr * (tx - k * previewView.tx), dpr * (ty - k * previewView.ty));
    ctx.drawImage(previewCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  function draw() {
    if (destroyed) return;
    if (interacting && drawPreview()) return;
    if(instancePlan){drawInstances();return;}
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cssW, cssH);
    const visible = built.filter(drawVisible);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const rec of visible) {
      // Paint all primitive kinds in source/SORTENTSTABLE order. A late WIPEOUT
      // covers earlier text/lines/fills, while later artwork stays above it.
      ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * tx, dpr * ty);
      ctx.save();
      rec.clipRegion.apply(ctx, {
        minX:-tx/scale-1/scale, maxX:(cssW-tx+1)/scale,
        minY:(ty-cssH-1)/scale, maxY:(ty+1)/scale});
      if (rec.infinite) updateInfinite(rec);
      if (rec.raster) drawRaster(rec);
      if (rec.fillPath) {
        if (rec.gradient) drawGradient(rec);
        else {
          ctx.fillStyle = rec.mask ? '#ffffff' : rec.color;
          if (rec.plotPen && !rec.mask && rec.plotPen.fill!==64 && rec.plotPen.fill!==73) {
            const key=rec.plotPen.fill+':'+rec.color;
            let pattern=plotFillCache.get(key);
            if (!pattern) {pattern=ctx.createPattern(fillTile(rec.plotPen.fill,rec.color),'repeat');plotFillCache.set(key,pattern);}
            // Match source raster-driver tile origin at the device bottom-left;
            // screen zoom, pan and device pixel ratio cannot change its period.
            pattern.setTransform(new DOMMatrix([1/(dpr*scale),0,0,-1/(dpr*scale),-tx/scale,(ty-cssH)/scale]));ctx.fillStyle=pattern;
          }
          ctx.fill(rec.fillPath, rec.fillRule || 'evenodd');
        }
      }
      if (rec.path) {
        ctx.strokeStyle = rec.color; ctx.lineWidth = rec.width / scale;
        // Match ezdxf's SVG backend round caps: very short DOT dashes must
        // remain visible at the displayed line weight, including zero length.
        ctx.lineCap = rec.dash?.length ? 'round' : 'butt';
        if (rec.plotPen) {
          ctx.lineCap=({0:'butt',1:'square',2:'round'})[rec.plotPen.end]||ctx.lineCap;
          ctx.lineJoin=({0:'miter',1:'bevel',2:'round'})[rec.plotPen.join]||'round';
        }
        ctx.setLineDash(rec.dash || []); ctx.stroke(rec.path);
      }
      ctx.setLineDash([]);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (rec.pointMark) {
        const p = rec.pointMark, sx = p.x * scale + tx, sy = -p.y * scale + ty;
        if(p.dot){ctx.fillStyle=rec.color;ctx.beginPath();ctx.arc(sx,sy,Math.max(.5,rec.width/2),0,Math.PI*2);ctx.fill();}
        else {
          ctx.strokeStyle = rec.color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(sx - 2.5, sy); ctx.lineTo(sx + 2.5, sy); ctx.moveTo(sx, sy - 2.5); ctx.lineTo(sx, sy + 2.5); ctx.stroke();
        }
      }
      if (rec.textEntry) drawText(rec.textEntry);
      drawSelection(rec);
      ctx.restore();
    }
    cacheFullFrame();
  }
  function rasterBasis(rec) {
    const {corners,w,h}=rec.raster,[o,a,,b]=corners;
    return {o,ax:(a[0]-o[0])/w,ay:(a[1]-o[1])/w,bx:(b[0]-o[0])/h,by:(b[1]-o[1])/h};
  }
  function drawRaster(rec) {
    const image=rasterCache.get(rec.raster.resourceId);if(!image)return;
    const {o,ax,ay,bx,by}=rasterBasis(rec);
    ctx.save();
    ctx.globalAlpha=rec.raster.opacity ?? rec.draw.style.opacity ?? 1;
    ctx.transform(ax,ay,bx,by,o[0],o[1]);ctx.drawImage(image,0,0);ctx.restore();
  }
  function rasterHit(rec,x,y) {
    const image=rasterCache.get(rec.raster.resourceId);
    const opacity=rec.raster.opacity ?? rec.draw.style.opacity ?? 1;
    if(!image||opacity<=0)return false;
    const {o,ax,ay,bx,by}=rasterBasis(rec),det=ax*by-ay*bx;if(Math.abs(det)<1e-20)return false;
    const px=((x-o[0])*by-(y-o[1])*bx)/det,py=(ax*(y-o[1])-ay*(x-o[0]))/det;
    if(px<0||py<0||px>=image.width||py>=image.height)return false;
    return image.getContext('2d').getImageData(Math.floor(px),Math.floor(py),1,1).data[3]>0;
  }
  function rasterSample(rec,index) {
    const image=rasterCache.get(rec.raster.resourceId);if(!image)return null;
    let probes=rasterProbes.get(rec.raster.resourceId);
    if(!probes){
      probes=[];const {width:w,height:h}=image,data=image.getContext('2d').getImageData(0,0,w,h).data;
      for(let row=0;row<4;row++)for(let col=0;col<4;col++){
        const x0=Math.floor(col*w/4),y0=Math.floor(row*h/4),x1=Math.floor((col+1)*w/4),y1=Math.floor((row+1)*h/4);
        const cx=Math.floor((x0+x1)/2),cy=Math.floor((y0+y1)/2);
        let found=data[(cy*w+cx)*4+3]?[cx+.5,cy+.5]:null;for(let y=y0;y<y1&&!found;y++)for(let x=x0;x<x1;x++)if(data[(y*w+x)*4+3]){found=[x+.5,y+.5];break;}
        if(found)probes.push(found);
      }
      rasterProbes.set(rec.raster.resourceId,probes);
    }
    if(!probes.length)return null;
    const [x,y]=probes[index%probes.length],{o,ax,ay,bx,by}=rasterBasis(rec);
    return [o[0]+ax*x+bx*y,o[1]+ay*x+by*y];
  }
  function drawGradient(rec) {
    const spec = rec.gradient, basis = spec.localToOwner, m = rec.draw.localToSpace;
    const o = apply(m, basis.slice(12, 15));
    const a = apply(m, [basis[12] + basis[0], basis[13] + basis[1], basis[14] + basis[2]]);
    const b = apply(m, [basis[12] + basis[4], basis[13] + basis[5], basis[14] + basis[6]]);
    const ax = a[0] - o[0], ay = a[1] - o[1], bx = b[0] - o[0], by = b[1] - o[1];
    const [x, y, maxX, maxY] = spec.domain, width = maxX - x, height = maxY - y;
    const resolution = pixels => { let n = 32; while (n < pixels && n < 1024) n *= 2; return n; };
    const w = resolution(width * Math.hypot(ax, ay) * scale * dpr);
    const h = resolution(height * Math.hypot(bx, by) * scale * dpr);
    const key = rec.draw.itemId + ':' + w + ':' + h;
    let texture = gradientCache.get(key);
    if (!texture) {
      // Bounded display texture; the boundary remains a vector path with holes.
      // The texture's OCS basis preserves rotations, mirrored/nonuniform INSERTs
      // and paper-space projection, with no geometry or color substitution.
      texture = document.createElement('canvas'); texture.width = w; texture.height = h;
      const target = texture.getContext('2d'), pixels = target.createImageData(w, h);
      const value = gradientField(spec), [c1, c2] = spec.colors;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const t = value(x + (i + .5) * width / w, y + (j + .5) * height / h);
        const at = (j * w + i) * 4;
        for (let k = 0; k < 3; k++) pixels.data[at + k] = Math.round(c1[k] + (c2[k] - c1[k]) * t);
        pixels.data[at + 3] = 255;
      }
      target.putImageData(pixels, 0, 0);
      if (gradientCache.size >= 16) gradientCache.delete(gradientCache.keys().next().value);
      gradientCache.set(key, texture);
    }
    ctx.save(); ctx.clip(rec.fillPath, 'evenodd');
    ctx.globalAlpha = rec.draw.style.opacity ?? 1;
    ctx.transform(ax, ay, bx, by, o[0], o[1]);
    ctx.drawImage(texture, x, y, width, height); ctx.restore();
  }
  function updateInfinite(rec, bounds = {minX: -tx / scale, maxX: (cssW - tx) / scale,
      minY: (ty - cssH) / scale, maxY: ty / scale}) {
    rec.segments = clipInfiniteLine(rec.infinite, bounds);
    rec.visibleGeometry=rec.clipRegion.geometry({segments:rec.segments||[]});
    rec.path = null;
    if (rec.segments) {
      rec.path = new Path2D(); rec.path.moveTo(rec.segments[0], rec.segments[1]);
      rec.path.lineTo(rec.segments[2], rec.segments[3]);
    }
  }
  function measureReference(text, fontFamily = TEXT_FONT) {
    ctx.save();
    ctx.font = '100px ' + fontFamily;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }
  function drawTextLeader(t, matrix) {
    const a = t.avoidance;
    if (!a) return;
    // Retained draws keep group-local coordinates; apply the current instance
    // matrix before the screen mapping, exactly like the glyph paint does.
    const toScreen = (x, y) => {
      const p = matrix ? transformPoint(matrix, x, y) : [x, y];
      return [p[0] * scale + tx, -p[1] * scale + ty];
    };
    const [ax, ay] = toScreen(a.sourceX, a.sourceY);
    const [bx, by] = toScreen(t.displayX ?? t.x, t.displayY ?? t.y);
    if (Math.hypot(bx - ax, by - ay) < 1) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(95,95,95,0.62)';
    ctx.fillStyle = 'rgba(95,95,95,0.82)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(ax, ay, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawText(t) {
    drawTextLeader(t);
    const size = Math.max(t.nativeLayout ? 0.7 : 5, Math.min(220, t.size * scale));
    const sx = (t.displayX ?? t.x) * scale + tx, sy = -(t.displayY ?? t.y) * scale + ty;
    if (sx < -400 || sy < -400 || sx > cssW + 400 || sy > cssH + 400) return;
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(-t.angle);
    ctx.font = size.toFixed(2) + 'px ' + (t.fontFamily || TEXT_FONT);
    ctx.fillStyle = t.color;
    const lines = t.lines || String(t.text).split('\n');
    const widths = t.widths || [t.width];
    const offsets = textOffsets(t);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const alignDx = w => t.kind === 'mtext'
      ? ((t.attachment === 2 || t.attachment === 5 || t.attachment === 8) ? -w / 2
        : (t.attachment === 3 || t.attachment === 6 || t.attachment === 9) ? -w : 0)
      : (t.halign === 1 ? -w / 2 : t.halign === 2 ? -w : 0);
    if (t.runLines) {
      t.runLines.forEach((line, i) => {
        const dx = alignDx(line.width * scale);
        const y = offsets.dy * scale + i * (t.lineHeight ? t.lineHeight * scale : size * 1.25);
        let x = dx;
        for (const segment of line.segments) {
          if (!segment.text) continue;
          ctx.font = size.toFixed(2) + 'px ' + (segment.fontFamily || t.fontFamily || TEXT_FONT);
          ctx.fillStyle = segment.color || t.color;
          ctx.fillText(segment.text, x, y);
          x += segment.width * scale;
        }
      });
      ctx.restore();
      return;
    }
    lines.forEach((line, i) => {
      // Alignment is per line: a short centred line must not keep the longest line's offset.
      const w = (widths[i] ?? t.width) * scale;
      const dx = alignDx(w);
      ctx.fillText(line, dx, offsets.dy * scale + i * (t.lineHeight?t.lineHeight*scale:size*1.25));
    });
    ctx.restore();
  }
  function drawSelection(rec) {
    if (!selected.has(rec.id)) return;
    ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * tx, dpr * ty);
    ctx.strokeStyle = ACCENT; ctx.setLineDash([]); ctx.lineWidth = 2.4 / Math.max(scale, 1e-9);
    if (rec.textBox) { const b = rec.textBox; ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY); }
    else if (rec.path) ctx.stroke(rec.path);
    else if (rec.fillPath) {
      if (rec.fillTriangles && !rec.selectionPath) {
        rec.selectionPath = new Path2D();
        for (const [a, b] of triangleBoundarySegments(rec.fillTriangles)) {
          rec.selectionPath.moveTo(...a); rec.selectionPath.lineTo(...b);
        }
      }
      ctx.stroke(rec.selectionPath || rec.fillPath);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ----- extents / navigation --------------------------------------------
  function extents() {
    if(instancePlan){
      refreshInstanceLayers();
      const box=instancePlan.roots.reduce((bounds,node)=>union(bounds,transformBounds(node.group.bounds,node.matrix)),null);
      if(box)return box;
      // Mirror the ordinary infinite-only fallback: retained groups carry no
      // finite extent for an unbounded construction line.
      const anchor=instancePlan.infiniteAnchor;
      if(!anchor)return null;
      return {minX:anchor[0]-50,minY:anchor[1]-50,maxX:anchor[0]+50,maxY:anchor[1]+50};
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rec of built) {
      if (!drawVisible(rec)) continue;
      const box = rec.infinite ? rec.navigationBounds : rec.visibleGeometry.bounds;
      if (box) { minX = Math.min(minX, box.minX); minY = Math.min(minY, box.minY); maxX = Math.max(maxX, box.maxX); maxY = Math.max(maxY, box.maxY); }
    }
    if (!Number.isFinite(minX)) {
      // An infinite-only file has no fit extent. Use a documented initial view
      // centred at its source anchor, with a 100-drawing-unit viewing span.
      const line = built.find(rec => rec.infinite && rec.clipRegion.finiteBounds===undefined && drawVisible(rec));
      if (!line) return null;
      const [x, y] = line.infinite.origin;
      return {minX: x - 50, minY: y - 50, maxX: x + 50, maxY: y + 50};
    }
    return { minX, minY, maxX, maxY };
  }
  function overlaps(a,b){return !!a&&!!b&&a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY;}
  // The header box is only a default-view candidate: it must cover most of the
  // visible drawing (not a stale sliver) and must not dwarf the geometry.
  function modelCoverage(box){
    let inside=0,total=0;
    if(instancePlan){
      for(const node of instancePlan.roots){
        const b=transformBounds(node.group.bounds,node.matrix),n=node.group.visibleCount;
        total+=n;
        if(overlaps(b,box))inside+=n;
      }
    }else{
      for(const rec of built){
        if(!drawVisible(rec))continue;
        const b=rec.infinite?rec.navigationBounds:rec.visibleGeometry?.bounds;
        total+=1;
        if(overlaps(b,box))inside+=1;
      }
    }
    return total?inside/total:0;
  }
  function sourceExtentsForFit(computed){
    if(spaceTarget?.kind!=='model')return null;
    const source=sourceExtentsFromHeader(ucd.extensions?.['org.libiaolink.dwg/1']?.header);
    if(!source)return null;
    return fitExtentsCandidate(source,computed,modelCoverage(source));
  }
  let fitted = false;
  function fit(bbox) {
    fitted = true;
    let b = bbox;
    if (!b) {
      const computed = extents();
      b = sourceExtentsForFit(computed) || computed;
    }
    if (!b) return;
    const dx = Math.max(b.maxX - b.minX, 1e-9), dy = Math.max(b.maxY - b.minY, 1e-9);
    scale = Math.min((cssW * 0.9) / dx, (cssH * 0.9) / dy);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    tx = cssW / 2 - cx * scale; ty = cssH / 2 + cy * scale;
    if (mode === 'analytic') rebuild(); else draw();
    updatePrecision();
  }
  function zoomAt(mx, my, factor) {
    const wx = (mx - tx) / scale, wy = (ty - my) / scale;
    scale = Math.max(1e-9, Math.min(1e12, scale * factor));
    tx = mx - wx * scale; ty = my + wy * scale;
    if (mode === 'analytic' && !interacting && (scale > buildScale * 2 || scale < buildScale / 2)) rebuild();
    else draw();
    updatePrecision();
  }
  function screenToWorld(mx, my) { return { x: (mx - tx) / scale, y: (ty - my) / scale }; }

  // ----- hit testing ------------------------------------------------------
  function segmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hitTest(sx, sy) {
    if(instancePlan)return hitInstances(sx,sy);
    const wx = (sx - tx) / scale, wy = (ty - sy) / scale;
    const tolerance = 5 / scale;
    // Reverse painting order: a mask intercepts a hit, and covered artwork
    // cannot be selected through its filled area.
    for (let index = built.length - 1; index >= 0; index--) {
      const rec = built[index];
      if (!drawVisible(rec)) continue;
      if (!rec.clipRegion.contains(wx, wy)) continue;
      if (rec.raster && rasterHit(rec,wx,wy)) return rec;
      if (rec.infinite) updateInfinite(rec);
      if (rec.fillPath && fillHit(rec, wx, wy)) return rec;
      const box = rec.textBox;
      if (box && wx >= box.minX - tolerance && wx <= box.maxX + tolerance
          && wy >= box.minY - tolerance && wy <= box.maxY + tolerance) return rec;
      if (rec.pointMark && Math.hypot(wx - rec.pointMark.x, wy - rec.pointMark.y) <= tolerance) return rec;
      const s = rec.visibleGeometry.segments;
      for (let i = 0; i < s.length; i += 4) {
        const d = segmentDistance(wx, wy, s[i], s[i + 1], s[i + 2], s[i + 3]);
        if (d <= tolerance) return rec;
      }
    }
    return null;
  }

  // ----- selection --------------------------------------------------------
  function describe(rec) {
    const draw = rec.draw;
    if (draw.kind === 'annotation') {
      const a = drawing.annotations[draw.itemId];
      const content = a.semantic?.plainText?.value || a.text || '';
      return (a.kind === 'dimension' ? '尺寸标注 ' : a.kind === 'mtext' ? '多行文字 ' : '文字 ') + content.slice(0, 48)
        + ' · 句柄 ' + (a.sourceRefs?.[0]?.objectKey || '?') + sourceLabel(a);
    }
    const e = drawing.entities[draw.itemId], layer = drawing.layers[rec.layerId];
    const g = e.geometry;
    let name = g.type;
    if (g.sourceType === 'LEADER') name = '引线';
    if (g.sourceType === 'MULTILEADER') name = '多重引线';
    if (g.sourceType === 'MLINE') name = '多线';
    if (g.sourceType === 'ACAD_TABLE') name = '表格';
    if (g.sourceType === 'WIPEOUT') name = '区域遮罩';
    if (g.sourceType === 'XLINE') name = '构造线';
    if (g.sourceType === 'RAY') name = '射线';
    if (g.sourceType === 'TOLERANCE') name = '形位公差';
    if (g.sourceType === 'SHAPE') name = 'SHX 形状';
    if (g.type === 'image') name = ({PDFUNDERLAY:'PDF 底图',DWFUNDERLAY:'DWF 底图',DGNUNDERLAY:'DGN 底图',OLE2FRAME:'OLE 内容缓存'})[mediaItemFor(ucd,draw.itemId)?.sourceKind]||'外链图片';
    if (g.sourceType === 'REGION') name = '平面区域';
    if (g.type === 'arc') name = Math.abs((g.sweepAngle || 0) - Math.PI * 2) < 1e-6 ? '圆' : '圆弧';
    if (g.type === 'polyline') name = g.closed ? '闭合多段线' : '多段线';
    if (g.type === 'hatch') name = fillEntryFor(ucd,draw.itemId)?.gradient ? '渐变填充' : g.patternId ? '图案填充' : '实心填充';
    const path = draw.blockPath.length ? ' · 块内' : '';
    return name + ' · 图层 ' + (layer ? layer.name : '?') + path + ' · 句柄 ' + ((e.sourceRefs[0] || {}).objectKey || '?') + sourceLabel(e);
  }
  function sourceLabel(item) {
    const ref=item.sourceRefs?.[0];
    return ref&&ref.sourceId!==ucd.sources[0].id?' · 来源 '+(ucd.sources.find(source=>source.id===ref.sourceId)?.name||ref.sourceId):'';
  }
  function select(rec, additive) {
    if(instancePlan)instanceSelected=rec;
    selectedBlockDetails=false;
    const id = rec ? rec.id : null;
    if (!additive) selected.clear();
    if (id) { if (additive && selected.has(id)) selected.delete(id); else selected.add(id); }
    if (!rec) { selectedInstance = null; selectedLabel = ''; }
    else {
      selectedInstance = rec.draw.blockPath.length ? rec.draw.blockPath[0].instanceId : null;
      selectedLabel = describe(rec);
    }
    const el = document.getElementById('selected');
    if (el) el.textContent = selected.size ? selectedLabel + (selected.size > 1 ? '（+' + (selected.size - 1) + '）' : '') : '尚未选择';
    draw(); updateSelectionButtons(); renderBlocks();
  }
  function selectInstance(instanceId) {
    if(instancePlan){
      let found=null;
      function find(node,parent,path){const matrix=multiply(parent,node.matrix),next=path.concat(node.path);
        if(node.path.some(step=>step.instanceId===instanceId)){found={node,matrix,path:next};return;}
        for(const child of node.group.entries)if(child.kind==='group'&&!found)find(child,matrix,next);}
      for(const root of instancePlan.roots)if(!found)find(root,I,[]);
      if(!found)return;
      selected.clear();selected.add('instance-selection:'+instanceId);selectedInstance=instanceId;selectedBlockDetails=true;
      const box=found.node.group.bounds;instanceSelected={bbox:transformBounds(box,found.matrix),instance:{record:{bbox:box},matrix:found.matrix}};
      selectedLabel='块实例 '+drawing.blocks[drawing.blockInstances[instanceId].definitionId].name+' · '+found.node.group.count+' 项 · 句柄 '+(drawing.blockInstances[instanceId].sourceRefs[0]?.objectKey||'?');
      document.getElementById('selected').textContent=selectedLabel;draw();updateSelectionButtons();renderBlocks();return;
    }
    selected.clear(); selectedInstance = instanceId;selectedBlockDetails=true;
    const inst = drawing.blockInstances[instanceId];
    for (const rec of built) if (rec.draw.blockPath.some(s => s.instanceId === instanceId)) selected.add(rec.id);
    const block = inst ? drawing.blocks[inst.definitionId] : null;
    selectedLabel = '块实例 ' + (block ? block.name : instanceId.slice(0, 12)) + ' · ' + selected.size + ' 个绘制项';
    const el = document.getElementById('selected'); if (el) el.textContent = selectedLabel;
    draw(); updateSelectionButtons(); renderBlocks();
  }
  function focusSourceHandle(handle){
    const key=String(handle).toUpperCase();
    const sourceOf=rec=>(drawing.entities[rec.draw.itemId]||drawing.annotations[rec.draw.itemId])?.sourceRefs||[];
    const candidates=built.filter(rec=>sourceOf(rec).some(ref=>ref.objectKey.toUpperCase()===key));
    if(!candidates.length){
      const entry=Object.values(drawing.blockInstances).find(item=>item.sourceRefs.some(ref=>ref.objectKey.toUpperCase()===key));
      if(entry){selectInstance(entry.id);return api.fitSelection();}return false;
    }
    if(!instancePlan){select(candidates[0],false);return api.fitSelection();}
    const byGroup=new Map();for(const rec of candidates)byGroup.set(instancePlan.drawGroups.get(rec.draw),rec);
    const reachable=new Map();
    function contains(group){if(reachable.has(group))return reachable.get(group);const result=byGroup.has(group)||group.entries.some(row=>row.kind==='group'&&contains(row.group));reachable.set(group,result);return result;}
    function find(node,parent,path,offset){
      if(!contains(node.group))return null;
      const matrix=multiply(parent,node.matrix),nextPath=path.concat(node.path);
      const rec=byGroup.get(node.group);
      if(rec&&drawVisible(rec)){const draw={...rec.draw,blockPath:nextPath,localToSpace:multiply(matrix,rec.draw.localToSpace),drawOrder:offset+rec.instanceOrder};
        return {...rec,id:instancePlan.identity(draw,nextPath),draw,bbox:transformBounds(rec.bbox,matrix),instance:{record:rec,matrix}};}
      for(const child of node.group.entries)if(child.kind==='group'){const hit=find(child,matrix,nextPath,offset+child.order);if(hit)return hit;}return null;
    }
    let offset=0;for(const root of instancePlan.roots){const rec=find(root,I,[],offset);if(rec){select(rec,false);return api.fitSelection();}offset+=root.group.count;}return false;
  }
  function updateSelectionButtons() {
    const has = selected.size > 0;
    for (const id of ['toggle', 'isolate', 'dim']) { const b = document.getElementById(id); if (b) b.disabled = !has; }
    const focus = document.getElementById('focus'); if (focus) focus.disabled = !has;
    renderSourceProperties();
  }

  function renderSourceProperties() {
    const host=panel.querySelector('.dproperties');if(!host)return;host.replaceChildren();
    const draw=instanceSelected?.draw||built.find(rec=>selected.has(rec.id))?.draw;
    const item=selectedBlockDetails?drawing.blockInstances[selectedInstance]:draw?(drawing.entities[draw.itemId]||drawing.annotations[draw.itemId]):null;
    const ref=item?.sourceRefs?.[0];
    const source=ucd.extensions?.['org.cad-preview.dxf-source-facts/1']?.sources?.[ref?.sourceId];
    let facts=source?.objects?.[ref?.objectKey];
    const nativeDwg=ucd.extensions?.['org.libiaolink.dwg/1'];
    if(!facts&&item&&nativeDwg){facts={type:item.geometry?.type||item.kind||(selectedBlockDetails?'INSERT':'DWG'),attributes:{sourceHandle:ref?.objectKey,sourceFormat:'DWG',
      nativeGeometry:nativeDwg.nativeGeometry?.[item.id],dimension:nativeDwg.dimensionSemantics?.[item.id],sourceSHA256:ucd.sources[0].sha256}};}
    if(!facts){host.textContent=item?'此对象没有可用的源属性记录。':'选择对象可查看源文件声明的属性。';return;}
    const hint=document.createElement('p');hint.className='dhint';
    hint.textContent=facts.type+' · '+(facts.handleOrigin==='reader-assigned-for-anonymous-record'?'匿名记录读取标识 ':'源句柄 ')+ref.objectKey+'；尺寸值按原文件记录，未经约束求解或验收计算。';host.append(hint);
    if(facts.attributeStatus==='reader-repaired'||facts.tagStatus){const warning=document.createElement('p');warning.className='dhint';warning.textContent='此记录存在读取修复或原标签预算损失，请结合下方状态和解析诊断查看。';host.append(warning);}
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看源属性与关联记录';details.append(summary);
    const pre=document.createElement('pre');pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:11px';
    const record={attributes:facts.attributes,...Object.fromEntries(['attributeStatus','attributeDecodeError','tagStatus','dimension','blockState','xdata','extensionDictionary','entries'].filter(key=>key in facts).map(key=>[key,facts[key]]))};
    if(source?.customProperties?.length)record.documentCustomProperties=source.customProperties;
    const text=JSON.stringify(record,null,2);pre.textContent=text.length>65536?text.slice(0,65536)+'\n…界面节选；完整记录保留在解析产物中。':text;
    details.append(pre);host.append(details);
  }

  // ----- panel ------------------------------------------------------------
  function spaceName() {
    if (spaceTarget.kind === 'block-preview') return '块内容 · ' + drawing.blocks[spaceTarget.blockId].name;
    if (spaceTarget.kind === 'model') return '模型空间';
    const layout = drawing.layouts[spaceTarget.layoutId];
    return '图纸空间 · ' + layout.name;
  }
  function renderSpaces() {
    const host = panel.querySelector('.dspaces'); if (!host) return;
    host.replaceChildren();
    const entries = [{ kind: 'model', spaceId: drawing.drawings[Object.keys(drawing.drawings)[0]].modelSpaceId, name: '模型空间' }];
    for (const lid of Object.keys(drawing.layouts)) {
      const layout = drawing.layouts[lid];
      entries.push({ kind: 'layout', layoutId: lid, name: layout.name });
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dspace';
      button.textContent = entry.name;
      const active = (spaceTarget.kind === 'model' && entry.kind === 'model') || (spaceTarget.kind === 'layout' && entry.layoutId === spaceTarget.layoutId);
      button.setAttribute('aria-pressed', String(active));
      button.onclick = () => setSpace(entry.kind === 'model' ? { kind: 'model', spaceId: entry.spaceId } : { kind: 'layout', layoutId: entry.layoutId });
      host.append(button);
    }
    if (recoveredBlocks.length) {
      const label = document.createElement('label');
      label.textContent = '恢复的块内容';
      const select = document.createElement('select');
      select.setAttribute('aria-label', '恢复的块内容');
      select.style.cssText = 'display:block;width:100%;max-width:100%;margin-top:6px;padding:7px';
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = '选择一个块查看';
      select.append(placeholder);
      for (const block of recoveredBlocks) {
        const option = document.createElement('option');
        option.value = block.blockId; option.textContent = block.name + '（' + block.sourceItems + ' 项）';
        select.append(option);
      }
      select.value = spaceTarget.kind === 'block-preview' ? spaceTarget.blockId : '';
      select.addEventListener('change', () => {
        if (select.value) {
          setSpace({kind: 'block-preview', blockId: select.value});
          panel.querySelector('select[aria-label="恢复的块内容"]')?.focus();
        }
      });
      label.append(select); host.append(label);
    }
  }
  function renderLayers() {
    const host = panel.querySelector('.dlayers'); if (!host) return;
    host.replaceChildren();
    const counts = new Map();
    for (const rec of built) {
      for (const id of new Set([rec.layerId,...rec.draw.visibilityLayerIds])) {
        const row=counts.get(id)||{layer:drawing.layers[id],ids:new Set()};
        row.ids.add(rec.id);counts.set(id,row);
      }
    }
    const rows = [...counts.entries()].sort((a, b) => (a[1].layer ? a[1].layer.name : '').localeCompare(b[1].layer ? b[1].layer.name : ''));
    for (const [layerId, row] of rows) {
      const layer = row.layer || { name: layerId, defaultStyle: { color: { rgba: [1, 1, 1, 1] } } };
      const wrapper = document.createElement('label');
      wrapper.className = 'dlayer';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = layerVisible(layerId);
      check.disabled = !layerSourceVisible(layerId);
      check.onchange = () => { userLayers.set(layerId, check.checked); draw(); updateStats(); };
      const swatch = document.createElement('span');
      swatch.className = 'dswatch';
      const rgbaColor = (layer.defaultStyle && layer.defaultStyle.color && layer.defaultStyle.color.rgba) || [1, 1, 1, 1];
      swatch.style.background = 'rgb(' + Math.round(rgbaColor[0] * 255) + ',' + Math.round(rgbaColor[1] * 255) + ',' + Math.round(rgbaColor[2] * 255) + ')';
      const name = document.createElement('span');
      name.className = 'dname';
      name.textContent = layer.name + (layerSourceVisible(layerId) ? '' : '（源关闭）');
      const count = document.createElement('span');
      count.className = 'dcount';
      count.textContent = String(row.ids.size);
      wrapper.append(check, swatch, name, count);
      host.append(wrapper);
    }
    if (!rows.length) host.textContent = '当前空间没有可显示的图层。';
  }
  function renderBlocks() {
    const host = panel.querySelector('.dblocks'); if (!host) return;
    host.replaceChildren();
    if(instancePlan){
      const entries=instancePlan.roots.flatMap(node=>node.group.entries.filter(row=>row.kind==='group'));
      for(const entry of entries){const step=entry.path[0];if(!step)continue;const instance=drawing.blockInstances[step.instanceId],block=drawing.blocks[instance.definitionId],button=document.createElement('button');
        button.type='button';button.className='dblock';button.setAttribute('aria-pressed',String(selectedInstance===step.instanceId));
        button.textContent=block.name+' · '+entry.group.count+' 项';button.onclick=()=>selectInstance(step.instanceId);host.append(button);}
      if(!entries.length)host.textContent='当前空间没有块引用。';return;
    }
    const byInstance = new Map();
    for (const rec of built) {
      for (const step of rec.draw.blockPath) {
        const key = step.instanceId + ':' + step.row + ':' + step.column;
        if (!byInstance.has(key)) byInstance.set(key, { instanceId: step.instanceId, row: step.row, column: step.column, ids: new Set() });
        byInstance.get(key).ids.add(rec.id);
      }
    }
    if (!byInstance.size) { host.textContent = '当前空间没有块引用（INSERT）。'; return; }
    for (const [key, value] of [...byInstance.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const instance = drawing.blockInstances[value.instanceId];
      const block = instance ? drawing.blocks[instance.definitionId] : null;
      const name = block ? block.name : value.instanceId.slice(0, 12);
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'dblock';
      label.setAttribute('aria-pressed', String(selectedInstance === value.instanceId));
      label.textContent = name + (value.row || value.column ? ' · 阵列 ' + value.row + ',' + value.column : '') + ' · ' + value.ids.size + ' 项';
      label.onclick = () => selectInstance(value.instanceId);
      host.append(label);
    }
  }
  function renderCoverage() {
    const host = panel.querySelector('.dcoverage'); if (!host) return;
    host.replaceChildren();
    const read = coverageExt.sourceRead || {}, geom = coverageExt.displayGeometry || {};
    const unsupported = (geom.byReason && geom.byReason.unsupported) || {};
    const losses = coverageExt.losses || [];
    const lines = [];
    if (recovery) {
      const issue = recovery.missingSections.length ? '缺少 ' + recovery.missingSections.join('、') : '已进行结构恢复';
      lines.push('原文件信息不完整（Partial）：' + issue + '。仅预览已恢复的内容，未声明的版本、单位和布局不作推定。');
      lines.push('ezdxf 恢复记录 ' + recovery.fixes.length + ' 项；移除的源记录 ' + recovery.removedSourceRecords.length + ' 项；' + recovery.displayDefaultLayers.length + ' 个图层使用显示默认样式。');
      if (recovery.preservedOrphanBlocks.length) lines.push('保留 ' + recovery.preservedOrphanBlocks.length + ' 个孤立图纸块的源内容，可在上方切换查看；未生成原图布局。');
    }
    lines.push('源实体读取 ' + (read.status || '?') + '（' + (read.sourceRecords ?? '?') + '） · 几何显示 ' + (geom.status || '?') + '（' + (geom.withDisplayGeometry ?? '?') + '/' + (geom.sourceRecords ?? '?') + '） · 绘制项 ' + Object.keys(projection.draws).length);
    if (Object.keys(unsupported).length) lines.push('未显示：' + Object.entries(unsupported).map(([k, v]) => k + '×' + v).join('、'));
    if (geom.byReason?.externalReferenceUnresolved) lines.push('外部参照：' + geom.byReason.externalReferenceUnresolved + ' 项未加载，原因见下方配套文件列表');
    if (losses.length) lines.push('损失记录：' + losses.slice(0, 6).map(l => l.code + (l.detail ? '(' + l.detail + ')' : '')).join('、') + (losses.length > 6 ? ' 等 ' + losses.length + ' 条' : ''));
    const fills = Object.values((ucd.extensions['org.cad-preview.fill/1'] || {}).fills || {});
    const patterns = fills.filter(fill => fill.solid === false).length;
    const gradients = fills.filter(fill => fill.gradient).length;
    if (fills.length) lines.push('填充：' + (fills.length - patterns - gradients) + ' 个实心 · ' + patterns + ' 个图案 · ' + gradients + ' 个渐变（保留源边界与定义）');
    const laidOut = Object.values(annotationItems).some(item => item.sourceKind === 'MTEXT' && item.status === 'ready');
    lines.push('工程属性：保留源声明、字典及关联记录；无 CAD 求解器。多行文字' + (laidOut ? '已排版' : '按源内容显示') + '；缺失字体保持部分预览。');
    if(coverageExt.sourceFacts?.status==='partial')lines.push('源属性记录 partial：'+coverageExt.sourceFacts.partialSourceIds.length+' 份源文件存在读取修复或预算损失，详见解析诊断。');
    if (xrefs?.references.length) {
      lines.push('XREF：已加载 '+xrefs.references.filter(ref=>ref.status==='resolved').length+' 项；逐项保留原文件路径');
      for (const ref of xrefs.references) {
        const status=ref.status==='resolved'?'已加载':!ref.required?'嵌套 overlay 不传播':ref.status==='ambiguous'?'文件重名歧义':ref.status==='missing'?'缺少文件':'未支持 / 未加载';
        lines.push(ref.blockName+' · '+ref.requestedPath+' · '+status+(ref.logicalPath?' → '+ref.logicalPath:'')+' · '+ref.reason+(ref.match?' · 匹配：'+ref.match:'')+(ref.candidates?.length?' · 候选：'+ref.candidates.join('、'):''));
      }
    }
    if (shx?.references.length || shx?.failures.length) {
      const coverage=shx.coverage;
      lines.push('字体/形状资源：'+coverage.status+' · 已加载 '+coverage.resolvedReferences+'/'+coverage.references+' 项引用 · '+coverage.substitutedObjects+' 个源对象使用替代预览 · '+coverage.missingObjects+' 个源对象未显示');
      for(const ref of shx.references){
        const state=ref.status==='resolved'?'原资源已加载':ref.status==='missing'?(ref.role==='shape-library'?'缺少配套文件（形状未显示）':'缺少配套文件（替代预览）'):ref.status==='ambiguous'?'文件重名歧义':'未支持 / 资源损坏';
        const role=ref.role==='shape-library'?'形状库':ref.role==='bigfont'?'BigFont':'字体';
        lines.push(role+' · '+ref.requestedPath+' · '+state+(ref.logicalPath?' → '+ref.logicalPath:'')+' · '+ref.reason+' · 涉及 '+ref.usedSourceRefs.length+' 条源记录'+(ref.match?' · 匹配：'+ref.match:'')+(ref.candidates?.length?' · 候选：'+ref.candidates.join('、'):''));
      }
      for(const failure of shx.failures.slice(0,8))lines.push('字体/形状未显示 · 源句柄 '+failure.sourceRefs.map(ref=>ref.objectKey||'?').join('、')+' · '+failure.reason);
    }
    if (media?.references.length || Object.keys(media?.items||{}).length) {
      const c=media.coverage;lines.push('图片/底图/OLE：'+c.status+' · 已显示 '+c.displayedObjects+'/'+c.sourceObjects+' 个源对象 · 缺少/受限 '+c.missingObjects+' 个');
      for(const ref of media.references)lines.push(ref.kind+' · '+ref.requestedPath+' · '+(ref.status==='resolved'?'已收集原配套':ref.status==='missing'?'缺少配套文件':ref.status==='ambiguous'?'配套文件重名':'未支持/超出限制')+(ref.logicalPath?' → '+ref.logicalPath:'')+' · '+ref.reason+' · 匹配：'+ref.match);
      for(const item of Object.values(media.items))lines.push(item.sourceKind+' · 源句柄 '+item.sourceRefs.map(ref=>ref.objectKey).join('、')+' · '+(item.status==='ready'?'原配套已解析':item.reason)+(item.details?.pageNumber?' · PDF 第 '+item.details.pageNumber+' 页 · 有界栅格显示':''));
    }
    if (mtextLayout?.coverage.sourceObjects) {
      const c=mtextLayout.coverage;
      lines.push('文字排版/字段：'+c.status+' · 字距 '+c.trackingLayouts+' · 制表符 '+c.tabLayouts+' · 字段处理 '+c.cachedFieldLayouts+' · 未显示 '+c.missingObjects+' 个源对象 · 未支持动态求值 '+c.dynamicEvaluationsUnsupported+' 个字段');
      for(const item of Object.values(mtextLayout.items)) {
        const source='文字排版/字段 · 源句柄 '+item.sourceRefs.map(ref=>ref.objectKey||'?').join('、');
        const detail=item.status==='ready'?(item.fieldPolicy?('evaluatedText' in item?'内置字段已只读求值'+(item.cacheDiffersFromEvaluation?'；源缓存与计算值不同，显示保留源缓存':''):'保留源字段缓存；'+(item.evaluationReason||'外部求值器未执行')):item.verticalLayout?'竖排几何已生成':'字距/制表符已排版'):item.reason;
        lines.push(source+' · '+detail);
        // Version 1.0 artifacts have no layout warnings. Version 1.1 keeps
        // rendered-but-unverified placement separate from missing geometry.
        for(const warning of item.layoutWarnings || []) lines.push(source+' · '+warning);
      }
    }
    const contexts=ucd.extensions?.['org.cad-preview.dxf-annotation-contexts/1'];
    if(contexts?.coverage.sourceObjects)lines.push('注释上下文：'+contexts.coverage.status+' · 已处理 '+contexts.coverage.readyObjects+'/'+contexts.coverage.sourceObjects+' 个源对象 · 当前模型比例 '+(contexts.modelDrawingPerPaper??'未声明'));
    for (const line of lines) { const p = document.createElement('p'); p.textContent = line; host.append(p); }
  }
  function updateStats() {
    const total = projectionCount();
    let shown = 0, entities = 0, annotations = 0;
    const seen = new Set();
    for (const rec of built) { if (drawVisible(rec) && !seen.has(rec.id)) { seen.add(rec.id); shown += 1; if (rec.draw.kind === 'entity') entities += 1; else annotations += 1; } }
    if(instancePlan){refreshInstanceLayers();shown=instancePlan.roots.reduce((n,node)=>n+node.group.visibleCount,0);entities=instancePlan.roots.reduce((n,node)=>n+node.group.byKind.entity,0);annotations=instancePlan.roots.reduce((n,node)=>n+node.group.byKind.annotation,0);}
    const stats = document.getElementById('stats');
    if (stats) stats.textContent = '显示 ' + shown + ' / ' + total + ' 个绘制项 · ' + entities + ' 个实体 · ' + annotations + ' 个标注 · ' + Object.keys(drawing.layers).length + ' 个图层';
    const unit = document.getElementById('unit');
    if (unit) unit.textContent = presentation.unit || '单位未声明';
    const spaceChip = document.getElementById('drawingSpace');
    if (spaceChip) spaceChip.textContent = spaceName();
    const label = document.getElementById('viewlabel');
    if (label) label.textContent = spaceName() + ' · 二维 · ' + (mode === 'display' ? '显示离散化' : '按屏幕重建');
    updatePrecision();
  }
  function updatePrecision() {
    const chip = document.getElementById('drawingPrecision');
    if (chip) chip.textContent = ucd.extensions?.['org.libiaolink.dwg/1']
      ? (mode==='display'?'DWG 社区几何离散 · 含明确损失':'曲线按屏幕重建 · 含明确损失')
      : mode === 'display' ? '显示离散化（sagitta ≤ 1e-3·R）' : '曲线按屏幕重建（≤0.35 px）· 图案沿用解析线条';
  }

  // ----- space switching --------------------------------------------------
  function setSpace(target) {
    spaceTarget = target;
    const plotSetup=plotStyles?.layouts?.[target.kind==='layout'?target.layoutId:'model'];
    plotPreview=target.kind!=='block-preview'&&!!plotSetup?.displayPlotStyles&&plotSetup.status==='ready';
    selected.clear(); selectedInstance = null; selectedLabel = '';
    const el = document.getElementById('selected'); if (el) el.textContent = '尚未选择';
    const layerMap = {};
    presentationStyles = {};
    instancePlan=null;instanceSelected=null;
    const drawEstimate=(target.kind==='model'||target.kind==='layout')?estimateDrawingDraws(ucd,target):0;
    if(drawEstimate>INSTANCE_DRAW_LIMIT)
      throw new Error('drawing-instance-count-overflow: '+drawEstimate+' expanded draws exceed the retained-viewer budget');
    if((target.kind==='model'||target.kind==='layout')&&shouldProjectInstances(target,forceInstances?0:drawEstimate,forceInstances)){
      instancePlan=projectInstances(ucd,target,presentationStyles);projection=instancePlan.projection;effectiveLayers=instancePlan.layers;
    }else{
    projection = target.kind === 'block-preview'
      ? projectBlock(ucd, target.blockId, layerMap, presentationStyles)
      : projectDrawing(ucd, target, layerMap, presentationStyles);
    effectiveLayers = new WeakMap(Object.entries(projection.draws).map(([id, draw]) => [draw, layerMap[id]]));
    }
    if (!target.drawingId) target.drawingId = projection.drawingId;
    userLayers.clear();
    rebuild(); renderSpaces(); renderBlocks(); renderCoverage(); renderPlotControls(); fit(); updateSelectionButtons();
  }

  function renderPlotControls() {
    const host=panel.querySelector('.dplot');if (!host) return;host.replaceChildren();
    const setup=plotStyles?.layouts?.[spaceTarget.kind==='layout'?spaceTarget.layoutId:'model'];
    if (!setup?.requestedPath) {host.textContent='源页面未指定打印样式。';return;}
    const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';
    input.checked=plotPreview;input.disabled=setup.status!=='ready'||spaceTarget.kind==='block-preview';
    input.addEventListener('change',()=>{plotPreview=input.checked;rebuild();renderPlotControls();draw();});
    label.append(input,document.createTextNode('打印样式预览 · '+setup.requestedPath));host.append(label);
    const hint=document.createElement('p');hint.className='dhint';
    hint.textContent=setup.status==='ready'?'屏幕预览；填充纹理、菱形端点及设备抖色不代表实际出图。'
      :'打印样式未就绪：'+(setup.reason||setup.status);host.append(hint);
    if (plotErrors.size) {const p=document.createElement('p');p.textContent='打印预览不完整：'+[...plotErrors].join('；');host.append(p);}
  }

  // ----- events -----------------------------------------------------------
  function pointerPosition(event) {
    const r = canvas.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }
  function onPointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    drag = { x: event.clientX, y: event.clientY, start: pointerPosition(event), button: event.button };
    moved = false;
    canvas.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event) {
    const p = pointerPosition(event);
    const world = screenToWorld(p.x, p.y);
    const chip = document.getElementById('drawingCoords');
    if (chip) chip.textContent = 'X ' + formatCoord(world.x) + ' · Y ' + formatCoord(world.y);
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) moved = true;
      if (moved) { beginInteraction(); tx += dx; ty += dy; drag.x = event.clientX; drag.y = event.clientY; draw(); }
    }
  }
  function formatCoord(value) {
    const abs = Math.abs(value);
    if (abs >= 1e6) return value.toExponential(3);
    return value.toFixed(abs >= 1 ? 2 : 4);
  }
  function onPointerUp(event) {
    if (!drag) return;
    const wasDragging = moved;
    drag = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch {}
    if (wasDragging) { endInteraction(); return; }
    const p = pointerPosition(event);
    const rec = hitTest(p.x, p.y);
    select(rec, event.shiftKey);
  }
  function onWheel(event) {
    event.preventDefault();
    const p = pointerPosition(event);
    beginInteraction();
    zoomAt(p.x, p.y, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
  function onKeyDown(event) {
    if (event.target.closest?.('input,select,textarea')) return;
    if (event.key === 'Escape') select(null, false);
    if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey) fit();
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(viewport);

  // ----- panel skeleton ---------------------------------------------------
  panel.innerHTML = '<div class="dsec"><strong>图纸空间</strong><div class="dspaces"></div></div>' +
    '<div class="dsec"><strong>显示方式</strong><div class="dmodes"><label><input type="radio" name="dmode" value="display" checked>显示离散化</label><label><input type="radio" name="dmode" value="analytic">按屏幕重建</label></div><p class="dhint">重建模式采样源曲线；填充与宽带沿用已生成的显示几何。</p></div>' +
    '<div class="dsec"><strong>图层</strong><div class="dlayers"></div></div>' +
    '<div class="dsec"><strong>打印样式</strong><div class="dplot"></div></div>' +
    '<div class="dsec"><strong>源属性</strong><div class="dproperties"></div></div>' +
    '<div class="dsec"><strong>块定义与实例</strong><div class="dblocks"></div></div>' +
    '<div class="dsec"><strong>覆盖与损失</strong><div class="dcoverage"></div></div>' +
    '<div class="dsec"><button type="button" id="drawingReset">恢复源状态</button></div>';
  panel.querySelectorAll('input[name=dmode]').forEach(input => input.addEventListener('change', () => {
    mode = input.value; analyticCache.clear(); rebuild(); fit(); updatePrecision();
  }));
  panel.querySelector('#drawingReset').addEventListener('click', () => { userLayers.clear(); select(null, false); renderLayers(); draw(); updateStats(); });

  // ----- public API -------------------------------------------------------
  const modelSpaceId = drawing.drawings[Object.keys(drawing.drawings)[0]].modelSpaceId;
  const model = drawing.spaces[modelSpaceId];
  const emptyModel = !model.entityIds.length && !model.annotationIds.length && !model.blockInstanceIds.length;
  setSpace(recoveredBlocks.length && emptyModel
    ? {kind: 'block-preview', blockId: recoveredBlocks[0].blockId}
    : {kind: 'model', spaceId: modelSpaceId});
  fitted = false; // setSpace fitted against the placeholder width; fit again at the real size
  resize();
  const api = {
    envelope,
    get space() { return spaceTarget; },
    get mode() { return mode; },
    projection: () => projection,
    setSpace,
    setMode(next) { mode = next; panel.querySelectorAll('input[name=dmode]').forEach(i => { i.checked = i.value === next; }); analyticCache.clear(); rebuild(); fit(); },
    setPlotPreview(enabled) {plotPreview=!!enabled;rebuild();renderPlotControls();draw();},
    setTextAvoidance(enabled) { textAvoidance=!!enabled; rebuild(); return textAvoidance; },
    textAvoidance: () => textAvoidance,
    setLayerVisible(name, visible) {
      const layer = Object.values(drawing.layers).find(l => l.name === name);
      if (!layer) return false;
      userLayers.set(layer.id, !!visible); renderLayers(); draw(); updateStats(); return true;
    },
    layerStates() {
      const counts = new Map();
      for (const rec of built) {
        for (const layerId of new Set([rec.layerId,...rec.draw.visibilityLayerIds])) {
          if (!counts.has(layerId)) counts.set(layerId, new Set());
          counts.get(layerId).add(rec.id);
        }
      }
      return Object.values(drawing.layers).map(l => ({ id: l.id, name: l.name, draws: counts.get(l.id)?.size || 0,
        sourceVisible: layerSourceVisible(l.id), userVisible: userLayers.has(l.id) ? userLayers.get(l.id) : true }));
    },
    fit,
    fitAll: () => fit(extents()),
    sourceExtents: () => sourceExtentsForFit(extents()),
    zoomAt,
    scale: () => scale,
    extents,
    fitSelection() {
      if(instancePlan&&instanceSelected?.bbox){fit(instanceSelected.bbox);return true;}
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const rec of built) if (selected.has(rec.id) && drawVisible(rec)) {
        const box=rec.infinite ? rec.navigationBounds : rec.visibleGeometry.bounds;
        if (!box) continue;
        minX = Math.min(minX, box.minX); minY = Math.min(minY, box.minY);
        maxX = Math.max(maxX, box.maxX); maxY = Math.max(maxY, box.maxY);
      }
      if (!Number.isFinite(minX)) {
        const line = built.find(rec => selected.has(rec.id) && rec.infinite
          && rec.clipRegion.finiteBounds===undefined && drawVisible(rec));
        if (line) {
          // Locate the source anchor without zooming to an arbitrary "length".
          tx = cssW / 2 - line.infinite.origin[0] * scale;
          ty = cssH / 2 + line.infinite.origin[1] * scale; draw(); return true;
        }
      }
      if (!Number.isFinite(minX)) return false;
      fit({ minX, minY, maxX, maxY }); return true;
    },
    selectInstance, focusSourceHandle,
    selectedDraws: () => [...selected],
    selectedInstance: () => selectedInstance,
    spaces: () => [{ kind: 'model' }].concat(Object.values(drawing.layouts).map(l => ({ kind: 'layout', name: l.name, id: l.id }))),
    pixelAtWorld(x, y) {
      const sx = Math.round((x * scale + tx) * dpr), sy = Math.round((-y * scale + ty) * dpr);
      if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) return null;
      const data = ctx.getImageData(sx, sy, 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    },
    fills() {
      const rows = built.filter(rec => rec.fillPath);
      return { count: rows.length,
               triangles: rows.reduce((sum, rec) => sum + (rec.fillTriangles ? rec.fillTriangles.length : 0), 0),
               rings: rows.reduce((sum, rec) => sum + (rec.fillRings ? rec.fillRings.length : 0), 0),
               bboxes: rows.slice(0, 5).map(rec => rec.bbox) };
    },
    counts() {
      if(instancePlan){refreshInstanceLayers();return {draws:instancePlan.count,built:instancePlan.roots.reduce((n,node)=>n+node.group.visibleCount,0),
        presentationParts:built.length,texts:texts.length,points:pointMarks.length,byKind:instancePlan.roots.reduce((n,node)=>({entity:n.entity+node.group.byKind.entity,annotation:n.annotation+node.group.byKind.annotation}),{entity:0,annotation:0}),
        visible:instancePlan.roots.reduce((n,node)=>n+node.group.visibleCount,0),retainedGroups:instancePlan.groups.length,uniqueSourceDraws:Object.keys(projection.draws).length,paintCalls:instancePlan.lastPaintCalls};}
      const byKind = { entity: 0, annotation: 0 };
      for (const d of Object.values(projection.draws)) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
      return { draws: Object.keys(projection.draws).length, built: new Set(built.map(rec => rec.id)).size,
        presentationParts: built.length, texts: texts.length, points: pointMarks.length, byKind,
        visible: new Set(built.filter(drawVisible).map(rec => rec.id)).size };
    },
    texts(limit=200) {
      return texts.slice(0, limit).map(t => {
        const annotation = drawing.annotations[t.itemId] || {};
        return { kind: t.kind, text: String(annotation.text || t.text).slice(0, 32),
                 tag: ((annotation.semantic && annotation.semantic.tag) || {}).value || null,
                 box: t.box, anchor: [t.x, t.y], itemId: t.itemId, drawId:t.drawId,
                 displayX: t.displayX ?? t.x, displayY: t.displayY ?? t.y,
                 avoidance: t.avoidance || null, dimension: inDimensionBlock(t.draw),
                 layout: t.layout, approximations: t.approximations || [],
                 visible:drawVisible({draw:t.draw,layerId:effectiveLayer(t.draw),visibleGeometry:{bounds:t.box}}) };
      });
    },
    record() {
      return { space: spaceTarget, mode, scale, layers: api.layerStates(), draws: Object.keys(projection.draws).length, selected: [...selected], selectedInstance, extents: extents(), unit: presentation.unit };
    },
    resize, draw, ready:rasterReady,
    destroy() {
      destroyed = true;
      if (interactionTimer) { clearTimeout(interactionTimer); interactionTimer = 0; }
      rasterCache.clear();
      rasterProbes.clear();
      if (window.__drawing === api) { delete window.__drawing; delete window.__drawingTest; }
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      canvas.hidden = true; overlay.remove(); panel.remove();
      canvas.remove();
    }
  };
  window.__drawing = api;
  window.__drawingTest = {
    debug: () => ({ space: spaceTarget, mode, scale, counts: api.counts(), fills: api.fills(),
                    completeness: (envelope.snapshot || {}).completeness, extents: extents(), unit: presentation.unit }),
    setSpace: (name) => {
      if (!name || name === 'Model') { setSpace({ kind: 'model', spaceId: drawing.drawings[Object.keys(drawing.drawings)[0]].modelSpaceId }); return true; }
      const layout = Object.values(drawing.layouts).find(l => l.name === name);
      if (!layout) return false;
      setSpace({ kind: 'layout', layoutId: layout.id }); return true;
    },
    setMode: (next) => api.setMode(next),
    setLayer: (name, visible) => api.setLayerVisible(name, visible),
    layers: () => api.layerStates(),
    sample: (n) => built.slice(0, n || 40).map(rec => ({ id: rec.id, layerId: rec.layerId,
      itemId:rec.draw.itemId, sourceRefs:(drawing.entities[rec.draw.itemId]||drawing.annotations[rec.draw.itemId])?.sourceRefs||[],
      segmentCount:rec.segments?rec.segments.length/4:0, raster:!!rec.raster,
      itemLayer: itemLayer(rec.draw), blockPath: (rec.draw.blockPath || []).length })),
    wideRecords: (minWidth=300, maxHeight=30) => built.map(rec => {
      const b = rec.visibleGeometry?.bounds || rec.bbox;
      if (!b) return null;
      const w = (b.maxX - b.minX) * scale, h = (b.maxY - b.minY) * scale;
      if (!(w >= minWidth && h <= maxHeight)) return null;
      return { id: rec.id, itemId: rec.draw.itemId, layerId: rec.layerId, itemLayer: itemLayer(rec.draw),
        width: rec.width, dash: rec.dash, bbox: b, blockPath: (rec.draw.blockPath || []).length,
        sourceRefs: (drawing.entities[rec.draw.itemId] || drawing.annotations[rec.draw.itemId])?.sourceRefs || [] };
    }).filter(Boolean).slice(0, 200),
    splineAudit: () => {
      const violations = []; let total = 0;
      for (const draw of Object.values(projection.draws)) {
        if (draw.kind !== 'entity') continue;
        const entity = drawing.entities[draw.itemId];
        if (!entity || (entity.geometry || {}).type !== 'spline') continue;
        total += 1;
        const rep = representationGeometry(draw.displayRepresentationId);
        const p = rep && rep.positions;
        if (!p || p.length < 6) continue;
        const near = value => Math.abs(value) < 1e-9;
        if (near(p[0]) && near(p[1]) && near(p[2]) && Math.hypot(p[3], p[4]) > 1)
          violations.push({itemId: draw.itemId, handle: (entity.sourceRefs || [{}])[0]?.objectKey || null});
      }
      return {splines: total, originPairs: violations.length, samples: violations.slice(0, 10)};
    },
    counts: () => api.counts(),
    texts: (limit) => api.texts(limit),
    fills: () => api.fills(),
    pixelAtWorld: (x, y) => api.pixelAtWorld(x, y),
    spaces: () => api.spaces(),
    selectAt: (sx, sy) => { const rec = hitTest(sx, sy); select(rec, false); return rec ? rec.id : null; },
    selectAtWorld: (x, y) => {
      const rec = hitTest(x * scale + tx, -y * scale + ty);
      select(rec, false);
      return rec ? { id: rec.id, itemId: rec.draw.itemId, kind: rec.draw.kind, fill: !!rec.fillPath } : null;
    },
    samplePoint: (index = 0, segment = null) => {
      const rec = built[index];
      if (!rec) return null;
      let point = null;
      if(rec.raster)point=rasterSample(rec,segment??0);
      else if(segment!==null&&rec.segments&&rec.segments.length>=(segment+1)*4){const start=segment*4;point=[(rec.segments[start]+rec.segments[start+2])/2,(rec.segments[start+1]+rec.segments[start+3])/2];}
      else if (rec.segments && rec.segments.length >= 2) point = [rec.segments[0], rec.segments[1]];
      else if (rec.fillTriangles && rec.fillTriangles.length) {
        const triangle=rec.fillTriangles[(segment??0)%rec.fillTriangles.length];
        point=[triangle.reduce((sum,p)=>sum+p[0],0)/3,triangle.reduce((sum,p)=>sum+p[1],0)/3];
      }
      else if (rec.fillRings && rec.fillRings.length) point = rec.fillRings[0][0];
      else if (rec.pointMark) point = [rec.pointMark.x, rec.pointMark.y];
      if (!point) return null;
      return { id: rec.id, x: point[0] * scale + tx, y: -point[1] * scale + ty };
    },
    selectInstance: (id) => { selectInstance(id); return [...selected]; },
    blockInstances: () => {
      const out = new Map();
      for (const rec of built) for (const step of rec.draw.blockPath) {
        const key = step.instanceId + ':' + step.row + ':' + step.column;
        if (!out.has(key)) out.set(key, { instanceId: step.instanceId, row: step.row, column: step.column, ids: new Set(), definition: (drawing.blocks[drawing.blockInstances[step.instanceId]?.definitionId] || {}).name || '' });
        out.get(key).ids.add(rec.id);
      }
      return [...out.values()].map(({ids, ...row}) => ({...row, draws: ids.size}));
    },
    selection: () => [...selected],
    fit: () => fit(),
    fitAll: () => fit(extents()),
    sourceExtents: () => sourceExtentsForFit(extents()),
    zoom: (factor) => zoomAt(cssW / 2, cssH / 2, factor),
    worldToScreen: (x, y) => ({ x: x * scale + tx, y: -y * scale + ty }),
    extents: () => extents(),
    projectionParity: () => {
      // Recompute with the same pure module used by layout switching.
      const again = projectDrawing(ucd, spaceTarget);
      return JSON.stringify(again.draws) === JSON.stringify(projection.draws);
    },
    coveredTexts: () => texts.map(t => ({ text: t.text, x: t.x, y: t.y })),
    clearSelection: () => select(null, false)
  };
  return api;
}
