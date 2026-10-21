// Independent 2D Canvas viewer for UCD Drawing documents.
// Input: a UCD 2.0 envelope whose document carries Drawing tables. The viewer never
// re-reads DXF. Analytic source curves (Entity.geometry) and the discretized display
// representation (Representation kind=drawing) are selectable, separate paths.
import {projectDrawing} from './drawing-projection.js';

const ACCENT = '#d9426f';

export function mountDrawingViewer(envelope) {
  const ucd = envelope.document, drawing = ucd.drawing, presentation = envelope.presentation;
  const styleExt = (ucd.extensions && ucd.extensions['org.cad-preview.style-inheritance/1']) || {};
  const coverageExt = (ucd.extensions && ucd.extensions['org.cad-preview.drawing-coverage/1']) || {};
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
  let spaceTarget = null, projection = null, built = [], texts = [], pointMarks = [];
  let scale = 1, tx = 0, ty = 0, dpr = 1, cssW = 800, cssH = 600;
  let mode = 'display';
  const userLayers = new Map();
  const selected = new Set();
  let selectedInstance = null, selectedLabel = '';
  let buildScale = 1, drag = null, moved = false, destroyed = false;
  const bufferCache = new Map(), repCache = new Map(), analyticCache = new Map();

  // ----- envelope buffers --------------------------------------------------
  function base64Bytes(text) {
    const bin = atob(text), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function accessorView(id) {
    const a = ucd.accessors[id];
    if (!a) throw new Error('missing accessor ' + id);
    let bytes = bufferCache.get(a.bufferId);
    if (!bytes) {
      const binary = envelope.transportProfile === 'ucd-binary-manifest/1'
        && envelope.decodedBuffers && envelope.decodedBuffers.has(a.bufferId);
      if (binary) {
        const raw = envelope.decodedBuffers.get(a.bufferId);
        bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      } else {
        const payload = (envelope.bufferPayloads || {})[a.bufferId];
        if (!payload) throw new Error('buffer ' + a.bufferId + ' is not in this envelope');
        bytes = base64Bytes(payload);
      }
      bufferCache.set(a.bufferId, bytes);
    }
    const count = a.count * (a.components || 1), offset = a.byteOffset || 0;
    if (a.component === 'u32') return new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count);
    if (a.component === 'f32') return new Float32Array(bytes.buffer, bytes.byteOffset + offset, count);
    return new Float64Array(bytes.buffer, bytes.byteOffset + offset, count);
  }
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
  const fillExt = (ucd.extensions && ucd.extensions['org.cad-preview.fill/1']) || {};

  function fillPathFor(draw, entity, tolerance) {
    const toWorld = point => apply(draw.localToSpace, point);
    if (mode === 'display') {
      const rep = representationGeometry(draw.displayRepresentationId);
      if (!rep || rep.topology !== 'triangles' || !rep.indices) return null;
      const positions = rep.positions, indices = rep.indices, path = new Path2D(), triangles = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const tri = [];
        for (let k = 0; k < 3; k++) {
          const at = indices[i + k] * 3;
          const p = toWorld([positions[at], positions[at + 1], positions[at + 2]]);
          tri.push(p);
          minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
          maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
        }
        path.moveTo(tri[0][0], tri[0][1]); path.lineTo(tri[1][0], tri[1][1]); path.lineTo(tri[2][0], tri[2][1]); path.closePath();
        triangles.push(tri);
      }
      if (!triangles.length) return null;
      return { path, triangles, bbox: { minX, minY, maxX, maxY } };
    }
    const rings = [], ids = entity.geometry.boundaryEntityIds || [];
    for (const id of ids) {
      const boundary = drawing.entities[id];
      if (!boundary) return null;
      const pts = analyticFor(id + ':boundary', boundary.geometry, tolerance);
      if (!pts || pts.length < 2) return null;
      rings.push(pts.map(toWorld));
    }
    if (!rings.length) return null;
    const path = new Path2D();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      path.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) path.lineTo(ring[i][0], ring[i][1]);
      path.closePath();
      for (const p of ring) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
    }
    return { path, rings, bbox: { minX, minY, maxX, maxY } };
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
  function dashFor(style) {
    if (!style.lineTypeId) return null;
    const lt = drawing.lineTypes[style.lineTypeId];
    if (!lt || !Array.isArray(lt.pattern) || !lt.pattern.length) return null;
    const lts = styleExt.lineTypeScale || 1;
    return lt.pattern.map(v => Math.abs(v) * lts);
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
    return layerVisible(rec.layerId);
  }
  function rgba(style) {
    const c = style.color || [1, 1, 1, 1];
    return 'rgba(' + [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), (style.opacity ?? 1)].join(',') + ')';
  }
  function rebuild() {
    built = []; texts = []; pointMarks = [];
    buildScale = scale;
    const tolerance = Math.max(1e-7, 0.35 / Math.max(scale, 1e-9));
    const ordered = Object.keys(projection.draws).map(id => [id, projection.draws[id]]).sort((a, b) => a[1].drawOrder - b[1].drawOrder);
    for (const [drawId, draw] of ordered) {
      const layerId = effectiveLayer(draw);
      const rec = { id: drawId, draw, layerId, path: null, segments: null, fillPath: null, fillTriangles: null, fillRings: null, width: lineWidthPx(draw.style.lineWeight && draw.style.lineWeight.value), dash: dashFor(draw.style), color: rgba(draw.style), bbox: null };
      if (draw.kind === 'entity') {
        const entity = drawing.entities[draw.itemId];
        if (!entity || entity.geometry.type === 'unsupported') continue;
        if (entity.geometry.type === 'hatch') {
          const fill = fillPathFor(draw, entity, tolerance);
          if (!fill) continue;
          rec.fillPath = fill.path; rec.fillTriangles = fill.triangles; rec.fillRings = fill.rings;
          rec.bbox = fill.bbox;
          built.push(rec);
          continue;
        }
        const segments = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const extend = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        if (mode === 'display') {
          const rep = representationGeometry(draw.displayRepresentationId);
          if (!rep) continue;
          const pos = rep.positions;
          if (rep.indices) {
            const idx = rep.indices;
            for (let i = 0; i + 1 < idx.length; i += 2) {
              const p1 = apply(draw.localToSpace, [pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2]]);
              const p2 = apply(draw.localToSpace, [pos[idx[i + 1] * 3], pos[idx[i + 1] * 3 + 1], pos[idx[i + 1] * 3 + 2]]);
              segments.push(p1[0], p1[1], p2[0], p2[1]); extend(p1[0], p1[1]); extend(p2[0], p2[1]);
            }
          } else {
            const p = apply(draw.localToSpace, [pos[0], pos[1], pos[2]]);
            pointMarks.push({ x: p[0], y: p[1], draw });
            extend(p[0], p[1]);
          }
        } else {
          const pts = analyticFor(draw.itemId, entity.geometry, tolerance);
          if (!pts || !pts.length) continue;
          if (entity.geometry.type === 'point' || pts.length === 1) {
            const p = apply(draw.localToSpace, pts[0]);
            pointMarks.push({ x: p[0], y: p[1], draw }); extend(p[0], p[1]);
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
        for (let i = 0; i < segments.length; i += 4) { path.moveTo(segments[i], segments[i + 1]); path.lineTo(segments[i + 2], segments[i + 3]); }
        rec.path = path; rec.segments = segments; rec.bbox = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
        built.push(rec);
      } else {
        const annotation = drawing.annotations[draw.itemId];
        if (!annotation) continue;
        const sem = annotation.semantic || {};
        const anchor = apply(draw.localToSpace, annotation.position);
        const dir = [draw.localToSpace[0] * annotation.direction[0] + draw.localToSpace[4] * annotation.direction[1],
                     draw.localToSpace[1] * annotation.direction[0] + draw.localToSpace[5] * annotation.direction[1]];
        const height = Number((sem.height && sem.height.value) || (sem.charHeight && sem.charHeight.value) || 2.5);
        const text = (sem.plainText && sem.plainText.value) ? sem.plainText.value : (annotation.text || '');
        rec.bbox = { minX: anchor[0], minY: anchor[1], maxX: anchor[0], maxY: anchor[1] };
        if (annotation.kind !== 'dimension' && text) {
          const entry = { x: anchor[0], y: anchor[1], text, angle: Math.atan2(dir[1], dir[0]), height: height * matrixScale(draw.localToSpace),
            halign: Number((sem.halign && sem.halign.value) || 0), valign: Number((sem.valign && sem.valign.value) || 0),
            attachment: Number((sem.attachmentPoint && sem.attachmentPoint.value) || 1), color: rec.color, kind: annotation.kind, draw, drawId, itemId: draw.itemId };
          entry.size = entry.height;
          Object.assign(entry, measureText(entry.text, entry.size));
          const box = textWorldBox(entry, textOffsets(entry));
          entry.box = box;
          rec.bbox = box; rec.textBox = box;
          texts.push(entry);
        }
        built.push(rec);
      }
    }
    draw();
    updateStats();
    renderLayers();
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
  function draw() {
    if (destroyed) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cssW, cssH);
    const visible = built.filter(drawVisible);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * tx, dpr * ty);
    for (const rec of visible) {
      if (!rec.fillPath) continue;
      ctx.fillStyle = rec.color;
      ctx.fill(rec.fillPath, 'evenodd');
    }
    for (const rec of visible) {
      if (!rec.path) continue;
      ctx.strokeStyle = rec.color; ctx.lineWidth = rec.width / scale;
      ctx.setLineDash(rec.dash ? rec.dash.map(v => v * 1) : []);
      ctx.stroke(rec.path);
    }
    ctx.setLineDash([]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#1f2933'; ctx.lineWidth = 1;
    for (const p of pointMarks) {
      if (!drawVisible({ draw: p.draw, layerId: effectiveLayer(p.draw) })) continue;
      const sx = p.x * scale + tx, sy = -p.y * scale + ty;
      if (sx < -10 || sy < -10 || sx > cssW + 10 || sy > cssH + 10) continue;
      ctx.beginPath(); ctx.moveTo(sx - 2.5, sy); ctx.lineTo(sx + 2.5, sy); ctx.moveTo(sx, sy - 2.5); ctx.lineTo(sx, sy + 2.5); ctx.stroke();
    }
    for (const t of texts) if (drawVisible({ draw: t.draw, layerId: effectiveLayer(t.draw) })) drawText(t);
    drawSelection();
  }
  const TEXT_FONT = '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif';
  function measureText(text, size) {
    const lines = String(text).split('\n');
    ctx.save();
    ctx.font = '100px ' + TEXT_FONT;
    const widths = lines.map(line => ctx.measureText(line).width * (size / 100));
    ctx.restore();
    return { lines, widths, width: Math.max(0, ...widths), height: size * 1.25 * Math.max(1, lines.length) };
  }
  function textOffsets(t) {
    let dx = 0, dy = 0;
    if (t.kind === 'mtext') {
      const a = t.attachment;
      dx = (a === 2 || a === 5 || a === 8) ? -t.width / 2 : (a === 3 || a === 6 || a === 9) ? -t.width : 0;
      dy = a <= 3 ? t.size : a <= 6 ? t.size * 0.35 : 0;
    } else {
      dx = t.halign === 1 ? -t.width / 2 : t.halign === 2 ? -t.width : 0;
      dy = t.valign === 3 ? t.size : t.valign === 2 ? t.size * 0.35 : 0;
    }
    return { dx, dy };
  }
  // World-space text box: text-space (u right, v down in canvas) mapped by the
  // annotation direction. Used for fit extents, text picking and selection outline.
  function textWorldBox(t, offsets) {
    const cos = Math.cos(t.angle), sin = Math.sin(t.angle);
    const corners = [[offsets.dx, offsets.dy], [offsets.dx + t.width, offsets.dy],
      [offsets.dx, offsets.dy + t.height], [offsets.dx + t.width, offsets.dy + t.height]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [u, v] of corners) {
      const x = t.x + u * cos + v * sin, y = t.y + u * sin - v * cos;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  }
  function drawText(t) {
    const size = Math.max(5, Math.min(220, t.height * scale));
    const sx = t.x * scale + tx, sy = -t.y * scale + ty;
    if (sx < -400 || sy < -400 || sx > cssW + 400 || sy > cssH + 400) return;
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(-t.angle);
    ctx.font = size.toFixed(2) + 'px ' + TEXT_FONT;
    ctx.fillStyle = t.color;
    const lines = t.lines || String(t.text).split('\n');
    const widths = t.widths || [t.width];
    const offsets = textOffsets(t);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    lines.forEach((line, i) => {
      // Alignment is per line: a short centred line must not keep the longest line's offset.
      const w = (widths[i] ?? t.width) * scale;
      const dx = t.kind === 'mtext'
        ? ((t.attachment === 2 || t.attachment === 5 || t.attachment === 8) ? -w / 2
          : (t.attachment === 3 || t.attachment === 6 || t.attachment === 9) ? -w : 0)
        : (t.halign === 1 ? -w / 2 : t.halign === 2 ? -w : 0);
      ctx.fillText(line, dx, offsets.dy * scale + i * size * 1.25);
    });
    ctx.restore();
  }
  function drawSelection() {
    if (!selected.size) return;
    ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * tx, dpr * ty);
    ctx.strokeStyle = ACCENT; ctx.setLineDash([]); ctx.lineWidth = 2.4 / Math.max(scale, 1e-9);
    for (const rec of built) {
      if (!selected.has(rec.id)) continue;
      if (rec.path) ctx.stroke(rec.path);
      else if (rec.fillPath) ctx.stroke(rec.fillPath);
      else if (rec.textBox) { const b = rec.textBox; ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY); }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ----- extents / navigation --------------------------------------------
  function extents() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rec of built) {
      if (!drawVisible(rec)) continue;
      if (rec.bbox) { minX = Math.min(minX, rec.bbox.minX); minY = Math.min(minY, rec.bbox.minY); maxX = Math.max(maxX, rec.bbox.maxX); maxY = Math.max(maxY, rec.bbox.maxY); }
    }
    for (const t of texts) if (drawVisible({ draw: t.draw, layerId: effectiveLayer(t.draw) })) { minX = Math.min(minX, t.x); minY = Math.min(minY, t.y); maxX = Math.max(maxX, t.x); maxY = Math.max(maxY, t.y); }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }
  let fitted = false;
  function fit(bbox) {
    fitted = true;
    const b = bbox || extents();
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
    if (mode === 'analytic' && (scale > buildScale * 2 || scale < buildScale / 2)) rebuild();
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
    const wx = (sx - tx) / scale, wy = (ty - sy) / scale;
    const tolerance = 5 / scale;
    let best = null, bestDistance = tolerance;
    for (const rec of built) {
      if (!drawVisible(rec)) continue;
      if (rec.fillPath && fillHit(rec, wx, wy)) return rec;
      const box = rec.textBox;
      if (box && wx >= box.minX - tolerance && wx <= box.maxX + tolerance
          && wy >= box.minY - tolerance && wy <= box.maxY + tolerance) return rec;
      if (!rec.segments) continue;
      const s = rec.segments;
      for (let i = 0; i < s.length; i += 4) {
        const d = segmentDistance(wx, wy, s[i], s[i + 1], s[i + 2], s[i + 3]);
        if (d <= bestDistance) { bestDistance = d; best = rec; }
      }
    }
    return best;
  }

  // ----- selection --------------------------------------------------------
  function describe(rec) {
    const draw = rec.draw;
    if (draw.kind === 'annotation') {
      const a = drawing.annotations[draw.itemId];
      return (a.kind === 'dimension' ? '尺寸标注 ' : a.kind === 'mtext' ? '多行文字 ' : '文字 ') + (a.text || '').slice(0, 48);
    }
    const e = drawing.entities[draw.itemId], layer = drawing.layers[rec.layerId];
    const g = e.geometry;
    let name = g.type;
    if (g.type === 'arc') name = Math.abs((g.sweepAngle || 0) - Math.PI * 2) < 1e-6 ? '圆' : '圆弧';
    if (g.type === 'polyline') name = g.closed ? '闭合多段线' : '多段线';
    if (g.type === 'hatch') name = '实心填充';
    const path = draw.blockPath.length ? ' · 块内' : '';
    return name + ' · 图层 ' + (layer ? layer.name : '?') + path + ' · 句柄 ' + ((e.sourceRefs[0] || {}).objectKey || '?');
  }
  function select(rec, additive) {
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
    selected.clear(); selectedInstance = instanceId;
    const inst = drawing.blockInstances[instanceId];
    for (const rec of built) if (rec.draw.blockPath.some(s => s.instanceId === instanceId)) selected.add(rec.id);
    const block = inst ? drawing.blocks[inst.definitionId] : null;
    selectedLabel = '块实例 ' + (block ? block.name : instanceId.slice(0, 12)) + ' · ' + selected.size + ' 个绘制项';
    const el = document.getElementById('selected'); if (el) el.textContent = selectedLabel;
    draw(); updateSelectionButtons(); renderBlocks();
  }
  function updateSelectionButtons() {
    const has = selected.size > 0;
    for (const id of ['toggle', 'isolate', 'dim']) { const b = document.getElementById(id); if (b) b.disabled = !has; }
    const focus = document.getElementById('focus'); if (focus) focus.disabled = !has;
  }

  // ----- panel ------------------------------------------------------------
  function spaceName() {
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
  }
  function renderLayers() {
    const host = panel.querySelector('.dlayers'); if (!host) return;
    host.replaceChildren();
    const counts = new Map();
    for (const rec of built) {
      const layer = drawing.layers[rec.layerId];
      const name = layer ? layer.name : rec.layerId;
      const row = counts.get(rec.layerId) || { layer, count: 0 };
      row.count += 1; counts.set(rec.layerId, row);
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
      count.textContent = String(row.count);
      wrapper.append(check, swatch, name, count);
      host.append(wrapper);
    }
    if (!rows.length) host.textContent = '当前空间没有可显示的图层。';
  }
  function renderBlocks() {
    const host = panel.querySelector('.dblocks'); if (!host) return;
    host.replaceChildren();
    const byInstance = new Map();
    for (const rec of built) {
      for (const step of rec.draw.blockPath) {
        const key = step.instanceId + ':' + step.row + ':' + step.column;
        if (!byInstance.has(key)) byInstance.set(key, { instanceId: step.instanceId, row: step.row, column: step.column, count: 0 });
        byInstance.get(key).count += 1;
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
      label.textContent = name + (value.row || value.column ? ' · 阵列 ' + value.row + ',' + value.column : '') + ' · ' + value.count + ' 项';
      label.onclick = () => selectInstance(value.instanceId);
      host.append(label);
    }
  }
  function renderCoverage() {
    const host = panel.querySelector('.dcoverage'); if (!host) return;
    host.replaceChildren();
    const read = coverageExt.sourceRead || {}, geom = coverageExt.displayGeometry || {}, attrs = coverageExt.engineeringAttributes || {};
    const unsupported = (geom.byReason && geom.byReason.unsupported) || {};
    const losses = coverageExt.losses || [];
    const lines = [];
    lines.push('源实体读取 ' + (read.status || '?') + '（' + (read.sourceRecords ?? '?') + '） · 几何显示 ' + (geom.status || '?') + '（' + (geom.withDisplayGeometry ?? '?') + '/' + (geom.sourceRecords ?? '?') + '） · 绘制项 ' + Object.keys(projection.draws).length);
    if (Object.keys(unsupported).length) lines.push('未显示：' + Object.entries(unsupported).map(([k, v]) => k + '×' + v).join('、'));
    if (losses.length) lines.push('损失记录：' + losses.slice(0, 6).map(l => l.code + (l.detail ? '(' + l.detail + ')' : '')).join('、') + (losses.length > 6 ? ' 等 ' + losses.length + ' 条' : ''));
    const fills = Object.keys((ucd.extensions['org.cad-preview.fill/1'] || {}).fills || {}).length;
    if (fills) lines.push('实心填充：' + fills + ' 个（SOLID / solid HATCH，边界以源实体引用 + 分析记录保留）');
    lines.push('工程属性：' + (attrs.status || '?') + ' · 文字/标注 ' + ((attrs.coverage && attrs.coverage.textFontRendering) || '字体替代') + ' · MTEXT 格式 ' + ((attrs.coverage && attrs.coverage.mtextFormatting) || '保留未渲染'));
    for (const line of lines) { const p = document.createElement('p'); p.textContent = line; host.append(p); }
  }
  function updateStats() {
    const total = Object.keys(projection.draws).length;
    let shown = 0, entities = 0, annotations = 0;
    for (const rec of built) { if (drawVisible(rec)) { shown += 1; if (rec.draw.kind === 'entity') entities += 1; else annotations += 1; } }
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
    if (chip) chip.textContent = mode === 'display' ? '显示离散化（sagitta ≤ 1e-3·R）' : '按屏幕重建（≤0.35 px）· ' + Math.round(scale) + ' px/单位';
  }

  // ----- space switching --------------------------------------------------
  function setSpace(target) {
    spaceTarget = target;
    selected.clear(); selectedInstance = null; selectedLabel = '';
    const el = document.getElementById('selected'); if (el) el.textContent = '尚未选择';
    const layerMap = {};
    projection = projectDrawing(ucd, target, layerMap);
    effectiveLayers = new WeakMap(Object.entries(projection.draws).map(([id, draw]) => [draw, layerMap[id]]));
    if (!target.drawingId) target.drawingId = projection.drawingId;
    userLayers.clear();
    rebuild(); renderSpaces(); renderCoverage(); fit(); updateSelectionButtons();
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
      if (moved) { tx += dx; ty += dy; drag.x = event.clientX; drag.y = event.clientY; draw(); }
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
    if (wasDragging) return;
    const p = pointerPosition(event);
    const rec = hitTest(p.x, p.y);
    select(rec, event.shiftKey);
  }
  function onWheel(event) {
    event.preventDefault();
    const p = pointerPosition(event);
    zoomAt(p.x, p.y, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
  function onKeyDown(event) {
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
    '<div class="dsec"><strong>显示方式</strong><div class="dmodes"><label><input type="radio" name="dmode" value="display" checked>显示离散化</label><label><input type="radio" name="dmode" value="analytic">按屏幕重建</label></div><p class="dhint">离散化来自源文件解析的 Representation；重建直接采样解析曲线，两者分开记录。</p></div>' +
    '<div class="dsec"><strong>图层</strong><div class="dlayers"></div></div>' +
    '<div class="dsec"><strong>块定义与实例</strong><div class="dblocks"></div></div>' +
    '<div class="dsec"><strong>覆盖与损失</strong><div class="dcoverage"></div></div>' +
    '<div class="dsec"><button type="button" id="drawingReset">恢复源状态</button></div>';
  panel.querySelectorAll('input[name=dmode]').forEach(input => input.addEventListener('change', () => {
    mode = input.value; analyticCache.clear(); rebuild(); fit(); updatePrecision();
  }));
  panel.querySelector('#drawingReset').addEventListener('click', () => { userLayers.clear(); select(null, false); renderLayers(); draw(); updateStats(); });

  // ----- public API -------------------------------------------------------
  setSpace({ kind: 'model', spaceId: drawing.drawings[Object.keys(drawing.drawings)[0]].modelSpaceId });
  fitted = false; // setSpace fitted against the placeholder width; fit again at the real size
  resize();
  const api = {
    envelope,
    get space() { return spaceTarget; },
    get mode() { return mode; },
    projection: () => projection,
    setSpace,
    setMode(next) { mode = next; panel.querySelectorAll('input[name=dmode]').forEach(i => { i.checked = i.value === next; }); analyticCache.clear(); rebuild(); fit(); },
    setLayerVisible(name, visible) {
      const layer = Object.values(drawing.layers).find(l => l.name === name);
      if (!layer) return false;
      userLayers.set(layer.id, !!visible); renderLayers(); draw(); updateStats(); return true;
    },
    layerStates() {
      const counts = new Map();
      for (const rec of built) counts.set(rec.layerId, (counts.get(rec.layerId) || 0) + 1);
      return Object.values(drawing.layers).map(l => ({ id: l.id, name: l.name, draws: counts.get(l.id) || 0,
        sourceVisible: layerSourceVisible(l.id), userVisible: userLayers.has(l.id) ? userLayers.get(l.id) : true }));
    },
    fit,
    zoomAt,
    scale: () => scale,
    extents,
    fitSelection() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const rec of built) if (selected.has(rec.id) && rec.bbox) {
        minX = Math.min(minX, rec.bbox.minX); minY = Math.min(minY, rec.bbox.minY);
        maxX = Math.max(maxX, rec.bbox.maxX); maxY = Math.max(maxY, rec.bbox.maxY);
      }
      if (!Number.isFinite(minX)) return false;
      fit({ minX, minY, maxX, maxY }); return true;
    },
    selectInstance,
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
      const byKind = { entity: 0, annotation: 0 };
      for (const d of Object.values(projection.draws)) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
      return { draws: Object.keys(projection.draws).length, built: built.length, texts: texts.length, points: pointMarks.length, byKind, visible: built.filter(drawVisible).length };
    },
    texts(limit=200) {
      return texts.slice(0, limit).map(t => {
        const annotation = drawing.annotations[t.itemId] || {};
        return { kind: t.kind, text: String(annotation.text || t.text).slice(0, 32),
                 tag: ((annotation.semantic && annotation.semantic.tag) || {}).value || null,
                 box: t.box, anchor: [t.x, t.y], itemId: t.itemId, drawId:t.drawId,
                 visible:drawVisible({draw:t.draw,layerId:effectiveLayer(t.draw)}) };
      });
    },
    record() {
      return { space: spaceTarget, mode, scale, layers: api.layerStates(), draws: Object.keys(projection.draws).length, selected: [...selected], selectedInstance, extents: extents(), unit: presentation.unit };
    },
    resize, draw,
    destroy() {
      destroyed = true;
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
      itemLayer: itemLayer(rec.draw), blockPath: (rec.draw.blockPath || []).length })),
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
    samplePoint: (index = 0) => {
      const rec = built[index];
      if (!rec) return null;
      let point = null;
      if (rec.segments && rec.segments.length >= 2) point = [rec.segments[0], rec.segments[1]];
      else if (rec.fillTriangles && rec.fillTriangles.length) point = rec.fillTriangles[0][0];
      else if (rec.fillRings && rec.fillRings.length) point = rec.fillRings[0][0];
      if (!point) return null;
      return { id: rec.id, x: point[0] * scale + tx, y: -point[1] * scale + ty };
    },
    selectInstance: (id) => { selectInstance(id); return [...selected]; },
    blockInstances: () => {
      const out = new Map();
      for (const rec of built) for (const step of rec.draw.blockPath) {
        const key = step.instanceId + ':' + step.row + ':' + step.column;
        out.set(key, { instanceId: step.instanceId, row: step.row, column: step.column, draws: (out.get(key)?.draws || 0) + 1, definition: (drawing.blocks[drawing.blockInstances[step.instanceId]?.definitionId] || {}).name || '' });
      }
      return [...out.values()];
    },
    selection: () => [...selected],
    fit: () => fit(),
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
