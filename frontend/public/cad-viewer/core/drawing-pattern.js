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
  const retainedRings = fillEntry && fillEntry.rings;
  if (retainedRings) {
    const rings = retainedRings.map(ring => ring.map(toWorld));
    return {kind:'rings', rings, bbox:boundsOf(rings.flat())};
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
    return {kind:'triangles', triangles, bbox:boundsOf(triangles.flat())};
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

export function strokeSegmentsForRepresentation(representation, toWorld, skipVertices = 0) {
  if (!representation) return null;
  if (typeof toWorld !== 'function') throw new Error('pattern-to-world-required');
  const positions = representation.positions, segments = [], points = [];
  const add = (a, b) => {
    const p1 = toWorld([positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]]);
    const p2 = toWorld([positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]]);
    segments.push(p1[0], p1[1], p2[0], p2[1]);
  };
  if (representation.indices) {
    const indices = representation.indices;
    for (let i = 0; i + 1 < indices.length; i += 2) add(indices[i], indices[i + 1]);
  } else if (representation.topology === 'lines') {
    const range = normalizeLineRange(representation.range, Math.floor(positions.length / 3));
    if (!range) return {segments:[], points:[], bbox:null, invalidRange:true};
    const start = range.first + Math.max(0, skipVertices);
    for (let i = start; i + 1 < range.first + range.count; i += 2) add(i, i + 1);
  } else if (representation.topology === 'points') {
    for (let i = 0; i < positions.length / 3; i++)
      points.push(toWorld([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]));
  } else {
    return {segments:[], points:[], bbox:null, unsupported:representation.topology};
  }
  const all = [];
  for (let i = 0; i < segments.length; i += 2) all.push([segments[i], segments[i + 1]]);
  all.push(...points);
  return {segments, points, bbox:boundsOf(all)};
}
