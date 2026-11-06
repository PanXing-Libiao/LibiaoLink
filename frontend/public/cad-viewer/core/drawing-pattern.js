// Authoritative pattern contract: hatch kind, fill geometry, dash resolution and
// display-line extraction. Renderers build Path2D from these results; they do
// not re-decide what a pattern hatch or complex line type means.
import {lineDashPattern} from './drawing-2d.js';
import {normalizeLineRange} from './drawing-display.js';

function boundsOf(points) {
  let bounds = null;
  const extend = ([x, y]) => {
    if (!bounds) bounds = {minX:x, minY:y, maxX:x, maxY:y};
    else {
      bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
    }
  };
  for (const point of points) extend(point);
  return bounds;
}

export function normalizedFillRule(value) {
  const rule = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  return rule === "nonzero" ? "nonzero" : "evenodd";
}

export function fillEntryFor(document, itemId) {
  return document?.extensions?.['org.cad-preview.fill/1']?.fills?.[itemId] || null;
}

export function hatchFillKind(entity, fillEntry) {
  const geometry = entity && entity.geometry;
  if (!geometry || geometry.type !== 'hatch') return null;
  // The viewer's published order: a patterned hatch keeps its display strokes
  // even when gradient metadata is also present.
  if (geometry.patternId) return 'pattern';
  if (fillEntry && fillEntry.gradient) return 'gradient';
  return 'solid';
}

export function lineDashFor(style, itemId, {lineTypes = {}, styleExt = {}} = {}) {
  if (!style || !style.lineTypeId) return null;
  return lineDashPattern(lineTypes[style.lineTypeId],
    styleExt.lineTypePatterns && styleExt.lineTypePatterns[style.lineTypeId],
    (styleExt.entityState && styleExt.entityState[itemId]
      && styleExt.entityState[itemId].lineTypeScale) ?? 1);
}

export function fillGeometryFor({draw, entity, fillEntry, mode, tolerance,
  representationGeometry, analyticFor, toWorld, boundaryGeometry}) {
  if (typeof toWorld !== 'function') throw new Error('pattern-to-world-required');
  const retainedTriangles = fillEntry && fillEntry.triangles;
  if (Array.isArray(retainedTriangles) && retainedTriangles.length) {
    const triangles = retainedTriangles.map(triangle => triangle.map(toWorld));
    return {kind:"triangles", triangles, fillRule:'nonzero', bbox:boundsOf(triangles.flat())};
  }
  const retainedRings = fillEntry && fillEntry.rings;
  if (retainedRings) {
    const rings = retainedRings.map(ring => ring.map(toWorld));
    return {kind:'rings', rings, fillRule: normalizedFillRule(fillEntry.fillRule), bbox:boundsOf(rings.flat())};
  }
  if (mode === 'display') {
    const representation = representationGeometry(draw.displayRepresentationId);
    if (!representation || representation.topology !== 'triangles' || !representation.indices) return null;
    const positions = representation.positions, indices = representation.indices, triangles = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      triangles.push([0,1,2].map(k => {
        const at = indices[i + k] * 3;
        return toWorld([positions[at], positions[at + 1], positions[at + 2]]);
      }));
    }
    if (!triangles.length) return null;
    return {kind:'triangles', triangles, fillRule:'nonzero', bbox:boundsOf(triangles.flat())};
  }
  const rings = [];
  for (const id of ((entity.geometry && entity.geometry.boundaryEntityIds) || [])) {
    const geometry = boundaryGeometry ? boundaryGeometry(id) : null;
    if (!geometry) return null;
    const points = analyticFor(id + ':boundary', geometry, tolerance);
    if (!points || points.length < 2) return null;
    rings.push(points.map(toWorld));
  }
  if (!rings.length) return null;
  return {kind:'rings', rings, bbox:boundsOf(rings.flat())};
}

export function* strokeSegmentsForRepresentationSteps(representation, toWorld, skipVertices = 0) {
  if (!representation) return null;
  if (typeof toWorld !== 'function') throw new Error('pattern-to-world-required');
  const positions = representation.positions, segments = [], points = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, work = 0;
  let sliceStart = performance.now();
  const extend = point => {
    if (point[0] < minX) minX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] > maxY) maxY = point[1];
  };
  const point = index => toWorld([positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]]);
  const add = (a, b) => {
    const p1 = point(a), p2 = point(b);
    segments.push(p1[0], p1[1], p2[0], p2[1]);
    extend(p1); extend(p2);
  };
  const due = () => ++work >= 1024 && performance.now() - sliceStart >= 6;
  if (representation.indices) {
    const indices = representation.indices;
    for (let index = 0; index + 1 < indices.length; index += 2) {
      add(indices[index], indices[index + 1]);
      if (due()) { yield; work = 0; sliceStart = performance.now(); }
    }
  } else if (representation.topology === 'lines') {
    const range = normalizeLineRange(representation.range, Math.floor(positions.length / 3));
    if (!range) return {segments:[], points:[], bbox:null, invalidRange:true};
    const start = range.first + Math.max(0, skipVertices);
    for (let index = start; index + 1 < range.first + range.count; index += 2) {
      add(index, index + 1);
      if (due()) { yield; work = 0; sliceStart = performance.now(); }
    }
  } else if (representation.topology === 'points') {
    for (let index = 0; index < positions.length / 3; index += 1) {
      const next = point(index);
      points.push(next); extend(next);
      if (due()) { yield; work = 0; sliceStart = performance.now(); }
    }
  } else {
    return {segments:[], points:[], bbox:null, unsupported:representation.topology};
  }
  return {segments, points, bbox:minX === Infinity ? null : {minX, minY, maxX, maxY}};
}
export function strokeSegmentsForRepresentation(representation, toWorld, skipVertices = 0) {
  const steps = strokeSegmentsForRepresentationSteps(representation, toWorld, skipVertices);
  let result;
  do { result = steps.next(); } while (!result.done);
  return result.value;
}
