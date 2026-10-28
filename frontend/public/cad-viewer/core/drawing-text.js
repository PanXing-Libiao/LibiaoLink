// Authoritative text-layout contract for the 2D viewer. The adapter owns glyph
// parts when it can produce them; this module owns the raw-annotation fallback
// used by both the ordinary and retained projections. It is pure apart from the
// caller-supplied Canvas font metric callback.
import {wrapCadText, cadTextEm, cadLineHeight} from './vendor/cad-text-layout.js';

export const TEXT_FONT = '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif';

function apply(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[12], m[1] * p[0] + m[5] * p[1] + m[13]];
}
function matrixScale(m) {
  return Math.hypot(m[0], m[1]) || 1;
}
function measureTextLines(text, size, measure) {
  if (typeof measure !== 'function') throw new Error('text-measure-required');
  const lines = String(text).split('\n');
  const widths = lines.map(line => measure(line) * (size / 100));
  return {lines, widths, width: Math.max(0, ...widths),
    height: size * 1.25 * Math.max(1, lines.length)};
}

export function layoutTextRun(input) {
  const run = {
    x: input.x, y: input.y, angle: input.angle, text: String(input.text),
    kind: input.kind || 'text', height: input.height, size: input.height,
    halign: input.halign || 0, valign: input.valign || 0,
    attachment: input.attachment || 1, color: input.color,
    fontFamily: input.fontFamily || TEXT_FONT
  };
  const approximations = ['substituted-font'];
  if (input.nativeLayout) {
    // Native metrics are a one-line cap-height contract. Using the measured
    // multi-line box height here would multiply em and line advance by the
    // source line count, so wrapped notes grow every time they gain a line.
    const capHeight = Number(input.height);
    run.size = cadTextEm(capHeight);
    run.lineHeight = cadLineHeight(capHeight, input.lineSpacing ?? 1);
    const width = Number(input.rectangleWidth || 0) * Number(input.matrixScale || 1);
    const lines = wrapCadText(run.text, width, run.size, input.measure);
    Object.assign(run, measureTextLines(lines.join('\n'), run.size, input.measure));
    // Preserve the published viewer contract: the fit/pick box uses the em
    // size for native CAD text, while line advance uses cadLineHeight.
    run.height = run.size;
    run.nativeLayout = true;
    approximations.push('cad-em-layout');
  } else {
    Object.assign(run, measureTextLines(run.text, run.size, input.measure));
    approximations.push('canvas-text-layout');
  }
  run.offsets = textOffsets(run);
  run.box = textWorldBox(run, run.offsets);
  run.approximations = approximations;
  run.layout = input.nativeLayout ? 'cad-em' : 'canvas';
  return run;
}

export function layoutAnnotationText(annotation, draw, options = {}) {
  const sem = annotation.semantic || {};
  const matrix = draw.localToSpace;
  const anchor = apply(matrix, annotation.position || [0, 0, 0]);
  const direction = annotation.direction || [1, 0, 0];
  const dir = [matrix[0] * direction[0] + matrix[4] * direction[1],
    matrix[1] * direction[0] + matrix[5] * direction[1]];
  const height = Number((sem.height && sem.height.value) ||
    (sem.charHeight && sem.charHeight.value) || 2.5) * matrixScale(matrix);
  const text = (sem.plainText && sem.plainText.value) ? sem.plainText.value : (annotation.text || '');
  if (annotation.kind === 'dimension' || !text) return {anchor, run: null};
  const run = layoutTextRun({
    text, kind: annotation.kind, x: anchor[0], y: anchor[1],
    angle: Math.atan2(dir[1], dir[0]), height,
    halign: Number((sem.halign && sem.halign.value) || 0),
    valign: Number((sem.valign && sem.valign.value) || 0),
    attachment: Number((sem.attachmentPoint && sem.attachmentPoint.value) || 1),
    color: options.color,
    nativeLayout: !!options.nativeLayout,
    lineSpacing: Number((sem.lineSpacing && sem.lineSpacing.value) ?? 1),
    rectangleWidth: Number((sem.rectangleWidth && sem.rectangleWidth.value) || 0),
    matrixScale: matrixScale(matrix),
    measure: options.measure,
    fontFamily: options.fontFamily
  });
  return {anchor, run};
}

export function textOffsets(t) {
  let dx = 0, dy = 0;
  if (t.kind === 'mtext') {
    const a = t.attachment;
    dx = (a === 2 || a === 5 || a === 8) ? -t.width / 2 : (a === 3 || a === 6 || a === 9) ? -t.width : 0;
    dy = a <= 3 ? t.size : a <= 6 ? t.size * 0.35 : 0;
  } else {
    dx = t.halign === 1 ? -t.width / 2 : t.halign === 2 ? -t.width : 0;
    dy = t.valign === 3 ? t.size : t.valign === 2 ? t.size * 0.35 : 0;
  }
  return {dx, dy};
}

// World-space text box: text-space (u right, v down in canvas) mapped by the
// annotation direction. Used for fit extents, text picking and selection.
export function textWorldCorners(t, offsets) {
  const cos = Math.cos(t.angle), sin = Math.sin(t.angle);
  const corners = [[offsets.dx, offsets.dy], [offsets.dx + t.width, offsets.dy],
    [offsets.dx + t.width, offsets.dy + t.height], [offsets.dx, offsets.dy + t.height]];
  return corners.map(([u, v]) => [t.x + u * cos + v * sin, t.y + u * sin - v * cos]);
}

export function textWorldBox(t, offsets) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of textWorldCorners(t, offsets)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {minX, minY, maxX, maxY};
}
