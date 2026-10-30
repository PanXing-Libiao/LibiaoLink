// Authoritative text-layout contract for the 2D viewer. The adapter owns glyph
// parts when it can produce them; this module owns the raw-annotation fallback
// used by both the ordinary and retained projections. It is pure apart from the
// caller-supplied Canvas font metric callback.
import {wrapCadText, cadTextTokens, cadTextEm, cadLineHeight} from './vendor/cad-text-layout.js';

export const TEXT_FONT = '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif';

function apply(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[12], m[1] * p[0] + m[5] * p[1] + m[13]];
}
function matrixScale(m) {
  return Math.hypot(m[0], m[1]) || 1;
}
function measureTextLines(text, size, measure, fontFamily) {
  if (typeof measure !== 'function') throw new Error('text-measure-required');
  const lines = String(text).split('\n');
  const widths = lines.map(line => measure(line, fontFamily) * (size / 100));
  return {lines, widths, width: Math.max(0, ...widths),
    height: size * 1.25 * Math.max(1, lines.length)};
}

// MTEXT inline formatting: split the raw source into runs that carry their own
// font and color. Only font switches (\f / \F) and inline colors (\C ACI index,
// \c true color) are modelled here; other controls are skipped exactly like the
// sanitized plain text. Grouping braces push/pop the current font and color so
// a switch inside {...} ends with the group.
export function parseMtextRuns(raw, defaultFont, resolveFont, resolveColor) {
  const source = String(raw || '');
  const runs = [];
  const stack = [];
  let font = defaultFont, color = null;
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    const last = runs[runs.length - 1];
    if (last && last.fontFamily === font && last.color === color) last.text += buffer;
    else runs.push({text: buffer, fontFamily: font, color});
    buffer = '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === '\\' || next === '{' || next === '}') { buffer += next; i += 2; continue; }
      if (next === '~') { buffer += ' '; i += 2; continue; }
      if (next === 'P') { buffer += '\n'; i += 2; continue; }
      if (next === 'f' || next === 'F') {
        let j = i + 2, name = '';
        while (j < source.length && source[j] !== ';' && source[j] !== '|') { name += source[j]; j += 1; }
        while (j < source.length && source[j] !== ';') j += 1;
        if (j < source.length) j += 1;
        flush();
        font = name ? ((resolveFont && resolveFont(name)) || defaultFont) : defaultFont;
        i = j; continue;
      }
      if (next === 'C' || next === 'c') {
        let j = i + 2, value = '';
        while (j < source.length && source[j] !== ';') { value += source[j]; j += 1; }
        if (j < source.length) j += 1;
        flush();
        color = resolveColor ? resolveColor(next === 'c' ? 'true' : 'aci', value.trim()) : null;
        i = j; continue;
      }
      // Other controls carry their parameter before ';'. Skipping the parameter
      // keeps the visible text that follows it.
      let j = i + 2;
      while (j < source.length && source[j] !== ';') j += 1;
      i = j < source.length ? j + 1 : source.length;
      continue;
    }
    if (ch === '{') { flush(); stack.push({font, color}); i += 1; continue; }
    if (ch === '}') {
      flush();
      const scope = stack.pop();
      if (scope) { font = scope.font; color = scope.color; }
      i += 1; continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.fontFamily === run.fontFamily && last.color === run.color) last.text += run.text;
    else merged.push({...run});
  }
  return merged;
}

function layoutRunLines(runs, size, measure, wrapWidth) {
  if (typeof measure !== 'function') throw new Error('text-measure-required');
  const paragraphs = [];
  let current = [];
  for (const run of runs) {
    const parts = String(run.text).split('\n');
    parts.forEach((part, index) => {
      if (index > 0) { paragraphs.push(current); current = []; }
      if (part) current.push({text: part, fontFamily: run.fontFamily, color: run.color});
    });
  }
  paragraphs.push(current);
  const lines = [];
  for (const paragraph of paragraphs) {
    let segments = [], width = 0;
    const pushSegment = (text, fontFamily, color, segmentWidth) => {
      if (!text) return;
      const last = segments[segments.length - 1];
      if (last && last.fontFamily === fontFamily && last.color === color) { last.text += text; last.width += segmentWidth; }
      else segments.push({text, fontFamily, color, width: segmentWidth});
      width += segmentWidth;
    };
    for (const run of paragraph) {
      const whole = measure(run.text, run.fontFamily) * (size / 100);
      if (!wrapWidth || width + whole <= wrapWidth) { pushSegment(run.text, run.fontFamily, run.color, whole); continue; }
      // Same greedy token rule as wrapCadText: words stay whole, CJK glyphs are
      // individual break opportunities. Per-character wrapping here used to
      // split English words and grow the block past the source rectangle.
      for (const token of cadTextTokens(run.text)) {
        const w = measure(token, run.fontFamily) * (size / 100);
        if (wrapWidth && width + w > wrapWidth && segments.length) {
          lines.push({segments, width}); segments = []; width = 0;
        }
        pushSegment(token, run.fontFamily, run.color, w);
      }
    }
    lines.push({segments, width});
  }
  return lines;
}

export function layoutTextRun(input) {
  const run = {
    x: input.x, y: input.y, angle: input.angle, text: String(input.text),
    kind: input.kind || 'text', height: input.height, size: input.height,
    halign: input.halign || 0, valign: input.valign || 0,
    attachment: input.attachment || 1, color: input.color,
    widthFactor: Number(input.widthFactor) > 0 ? Number(input.widthFactor) : 1,
    fontFamily: input.fontFamily || TEXT_FONT
  };
  const approximations = ['substituted-font'];
  const useRuns = Array.isArray(input.runs) && input.runs.length > 0;
  // AutoCAD text styles scale advances horizontally (Width factor); applying it
  // here keeps wrapping, line widths and painted advances on the same metric.
  const measure = typeof input.measure === 'function' && run.widthFactor !== 1
    ? (text, family) => input.measure(text, family) * run.widthFactor
    : input.measure;
  if (useRuns) run.text = input.runs.map(item => item.text).join('');
  if (input.nativeLayout) {
    // Native metrics are a one-line cap-height contract. Using the measured
    // multi-line box height here would multiply em and line advance by the
    // source line count, so wrapped notes grow every time they gain a line.
    const capHeight = Number(input.height);
    run.size = cadTextEm(capHeight);
    run.lineHeight = cadLineHeight(capHeight, input.lineSpacing ?? 1);
    const width = Number(input.rectangleWidth || 0) * Number(input.matrixScale || 1);
    if (useRuns) {
      const runLines = layoutRunLines(input.runs, run.size, measure, width);
      run.runLines = runLines;
      run.lines = runLines.map(line => line.segments.map(segment => segment.text).join(''));
      run.widths = runLines.map(line => line.width);
      run.width = Math.max(0, ...run.widths);
      run.height = run.size * 1.25 * Math.max(1, runLines.length);
    } else {
      const lines = wrapCadText(run.text, width, run.size, line => measure(line, run.fontFamily));
      Object.assign(run, measureTextLines(lines.join('\n'), run.size, measure, run.fontFamily));
    }
    // Preserve the published viewer contract: the fit/pick box uses the em
    // size for native CAD text, while line advance uses cadLineHeight.
    run.height = run.size;
    run.nativeLayout = true;
    approximations.push('cad-em-layout');
  } else {
    if (useRuns) {
      const runLines = layoutRunLines(input.runs, run.size, measure, 0);
      run.runLines = runLines;
      run.lines = runLines.map(line => line.segments.map(segment => segment.text).join(''));
      run.widths = runLines.map(line => line.width);
      run.width = Math.max(0, ...run.widths);
      run.height = run.size * 1.25 * Math.max(1, runLines.length);
    } else {
      Object.assign(run, measureTextLines(run.text, run.size, measure, run.fontFamily));
    }
    approximations.push('canvas-text-layout');
  }
  if (useRuns) approximations.push('inline-font-runs');
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
  const semText = (sem.plainText && sem.plainText.value) ? sem.plainText.value : (annotation.text || '');
  const text = Array.isArray(options.runs) && options.runs.length
    ? options.runs.map(item => item.text).join('') : semText;
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
    fontFamily: options.fontFamily,
    runs: options.runs,
    widthFactor: options.widthFactor
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

// The run box is deliberately one em high for the published fit/pick contract.
// Collision resolution needs the full painted block, including every line's
// advance, without changing that public contract.
export function textDisplayHeight(t) {
  const size = Number(t.size || t.height || 0);
  const lineCount = Math.max(1, Array.isArray(t.lines) ? t.lines.length : String(t.text || '').split('\n').length);
  const lineHeight = Number(t.lineHeight) || size * 1.25;
  return Math.max(size, (lineCount - 1) * lineHeight + size);
}

export function textDisplayBox(t, x = t.x, y = t.y) {
  const box = textWorldBox({...t, x, y, height: textDisplayHeight(t)}, textOffsets(t));
  return Number.isFinite(box.minX) && Number.isFinite(box.minY) ? box : null;
}
