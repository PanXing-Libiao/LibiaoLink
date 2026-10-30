/* CADCraft-derived gradient field: MIT License

Copyright (c) 2026 ArtCraft Team and the CADCraft contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// View-dependent display helpers. Parametric DXF RAY/XLINE coordinates stay
// infinite in the artifact; only their current visible interval is finite.
export function clipInfiniteLine(line, bounds) {
  const {origin: p, direction: d, kind} = line;
  let lo = kind === 'ray' ? 0 : -Infinity, hi = Infinity;
  if (!Number.isFinite(Math.hypot(...d)) || Math.hypot(...d) === 0) return null;
  for (const [axis, min, max] of [[0, bounds.minX, bounds.maxX], [1, bounds.minY, bounds.maxY]]) {
    if (d[axis] === 0) {
      if (p[axis] < min || p[axis] > max) return null;
    } else {
      const a = (min - p[axis]) / d[axis], b = (max - p[axis]) / d[axis];
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      if (lo > hi) return null;
    }
  }
  return [p[0] + d[0] * lo, p[1] + d[1] * lo, p[0] + d[0] * hi, p[1] + d[1] * hi];
}

// Selectively adapted from truedxf render/draw/gradient.ts, 019c2e504738965c.
// MIT, attribution in vendor/truedxf-display/NOTICE. AutoCAD-calibrated display
// fit: continuous sRGB field, without CAD's mesh interpolation and dither.
export function gradientField(spec) {
  const [minX, minY, maxX, maxY] = spec.frameBounds;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const width = maxX - minX, height = maxY - minY;
  const inverted = spec.name.startsWith('INV'), shape = inverted ? spec.name.slice(3) : spec.name;
  const shifted = spec.shift === 1, clamp = t => Math.max(0, Math.min(1, t));
  if (!['LINEAR', 'CYLINDER', 'CURVED', 'SPHERICAL', 'HEMISPHERICAL'].includes(shape)
      || ![0, 1].includes(spec.shift) || !(width > 0 && height > 0)) throw new Error('Unsupported gradient field');
  const c = Math.cos(spec.angleRadians), s = Math.sin(spec.angleRadians);
  return (x, y) => {
    const u = x * c + y * s, v = -x * s + y * c;
    let t;
    if (shape === 'SPHERICAL' || shape === 'HEMISPHERICAL') {
      const radius = shape === 'SPHERICAL' ? Math.max(width, height) / 2
        : Math.max(width, spec.domain[3] - spec.domain[1]);
      const ox = cx - (shifted ? radius / 2 : 0);
      const oy = shape === 'HEMISPHERICAL' ? cy - radius / 2 : cy + (shifted ? radius / 2 : 0);
      t = Math.cos(Math.PI / 2 * Math.min(1, Math.hypot(u - ox, v - oy) / radius));
    } else if (shape === 'CURVED') {
      t = Math.sin(Math.PI / 2 * clamp((maxY - v) / height - .1125 * ((u - cx) / (width / 2)) ** 2));
    } else {
      t = (u - minX) / width;
      if (shifted) t = t < .3125 ? .5 * t / .3125 : .5 + .5 * (t - .3125) / .703125;
      t = clamp(t);
      if (shape === 'CYLINDER') t = Math.sin(Math.PI * t);
    }
    return inverted ? 1 - t : t;
  };
}

// Shared triangle edges are display tessellation, not a visible CAD boundary.
// Keep only exterior/hole edges for the selection outline (text uses glyph boxes).
export function triangleBoundarySegments(triangles) {
  const edges = new Map();
  for (const triangle of triangles) for (let i = 0; i < 3; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3];
    const ak = a.join(','), bk = b.join(',');
    if (ak === bk) continue;
    const key = ak < bk ? ak + ';' + bk : bk + ';' + ak;
    if (edges.has(key)) edges.delete(key); else edges.set(key, [a, b]);
  }
  return [...edges.values()];
}

// The adapter publishes ezdxf's compiled dash/gap sequence in drawing units.
// Its document scale is already applied; only the source item's scale remains.
export function lineDashPattern(lineType, compiled, itemScale = 1) {
  let pattern = compiled;
  if (!Array.isArray(pattern)) {
    const segments = lineType?.segments || [];
    if (!segments.every((segment, i) => i % 2 ? segment.kind === 'gap'
      : segment.kind === 'dash' || segment.kind === 'dot')) return [];
    pattern = segments.map(segment => segment.length);
  }
  if (pattern.length < 2 || !pattern.every(value => Number.isFinite(value) && value >= 0)
    || !pattern.some(value => value > 0) || !Number.isFinite(itemScale) || itemScale <= 0) return [];
  return pattern.map(value => value * itemScale);
}

// Adjacent tessellation edges form one stroke. Restarting the Canvas subpath at
// every edge restarts its dash phase and can turn an entire dashed circle solid.
export function traceStrokeSegments(path, segments) {
  let previous = null;
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const [ax, ay, bx, by] = segments.slice(i, i + 4);
    if (!previous || Math.abs(previous[0] - ax) > 1e-9 || Math.abs(previous[1] - ay) > 1e-9) path.moveTo(ax, ay);
    path.lineTo(bx, by);
    previous = [bx, by];
  }
}
