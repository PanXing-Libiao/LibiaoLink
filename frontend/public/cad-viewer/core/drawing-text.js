// Authoritative text-layout contract for the 2D viewer. The adapter owns glyph
// parts when it can produce them; this module owns the raw-annotation fallback
// used by both the ordinary and retained projections. It is pure apart from the
// caller-supplied Canvas font metric callback.
import {cadTextTokens, cadLineHeight} from './vendor/cad-text-layout.js';

export const TEXT_FONT = '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", "Libiao Sans SC", "Libiao Sans", sans-serif';

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
// font, color, height and width. Font switches (\f / \F, including b/i flags),
// inline colors (\C ACI index, \c true color), heights (\H) and width factors
// (\W) are modelled here; other controls are skipped exactly like the sanitized
// plain text. Grouping braces push/pop the whole run state.
export function parseMtextRuns(raw, defaultFont, resolveFont, resolveColor, baseHeight = 0) {
  const source = String(raw || '');
  const runs = [];
  const stack = [];
  const initial = {font: defaultFont, color: null, heightFactor: 1, widthFactor: 1, bold: false, italic: false};
  let state = {...initial};
  let buffer = '';
  const sameState = (a, b) => (a.fontFamily ?? a.font) === (b.fontFamily ?? b.font)
    && a.color === b.color
    && a.heightFactor === b.heightFactor && a.widthFactor === b.widthFactor
    && a.bold === b.bold && a.italic === b.italic;
  const flush = () => {
    if (!buffer) return;
    const last = runs[runs.length - 1];
    if (last && sameState(last, state)) last.text += buffer;
    else runs.push({text: buffer, fontFamily: state.font, color: state.color,
      heightFactor: state.heightFactor, widthFactor: state.widthFactor,
      bold: state.bold, italic: state.italic});
    buffer = '';
  };
  const readValue = start => {
    let j = start, value = '';
    while (j < source.length && source[j] !== ';') { value += source[j]; j += 1; }
    return {value, end: j < source.length ? j + 1 : source.length};
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
        let j = i + 2, name = '', flags = '';
        while (j < source.length && source[j] !== ';' && source[j] !== '|') { name += source[j]; j += 1; }
        while (j < source.length && source[j] !== ';') { flags += source[j]; j += 1; }
        if (j < source.length) j += 1;
        flush();
        state = {...state,
          font: name ? ((resolveFont && resolveFont(name)) || defaultFont) : defaultFont,
          bold: /\|b1(?!\d)/.test(flags) ? true : (/\|b0(?!\d)/.test(flags) ? false : state.bold),
          italic: /\|i1(?!\d)/.test(flags) ? true : (/\|i0(?!\d)/.test(flags) ? false : state.italic)};
        i = j; continue;
      }
      if (next === 'C' || next === 'c') {
        const {value, end} = readValue(i + 2);
        flush();
        state = {...state, color: resolveColor ? resolveColor(next === 'c' ? 'true' : 'aci', value.trim()) : null};
        i = end; continue;
      }
      if (next === 'H') {
        const {value, end} = readValue(i + 2);
        flush();
        const factor = parseHeightControl(value.trim(), baseHeight);
        if (factor) state = {...state, heightFactor: factor};
        i = end; continue;
      }
      if (next === 'W') {
        const {value, end} = readValue(i + 2);
        flush();
        const factor = Number(value.trim());
        if (Number.isFinite(factor) && factor > 0) state = {...state, widthFactor: factor};
        i = end; continue;
      }
      // Other controls carry their parameter before ';'. Skipping the parameter
      // keeps the visible text that follows it.
      let j = i + 2;
      while (j < source.length && source[j] !== ';') j += 1;
      i = j < source.length ? j + 1 : source.length;
      continue;
    }
    if (ch === '{') { flush(); stack.push({...state}); i += 1; continue; }
    if (ch === '}') {
      flush();
      if (stack.length) state = stack.pop();
      i += 1; continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && sameState(last, run)) last.text += run.text;
    else merged.push({...run});
  }
  return merged;
}

// \H<value>x is a factor of the current height; a bare number is an absolute
// height in drawing units, converted with the annotation's stored base height.
function parseHeightControl(value, baseHeight) {
  if (!value) return null;
  const factor = /x$/i.test(value) ? Number(value.slice(0, -1)) : (baseHeight > 0 ? Number(value) / baseHeight : NaN);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

// CJK 禁则: closing punctuation must not start a line, opening punctuation must
// not end one. Both sets are the common fullwidth and ASCII forms CAD text uses.
const CLOSING_PUNCT = /^[，。、；：！？"”’）】》」』·…—％‰,.;:!?)\]}%]$/;
const OPENING_PUNCT = /^[（【《「『“‘(\[{]$/;

function layoutRunLines(runs, size, measure, wrapWidth, native = false, lineSpacing = 1) {
  if (typeof measure !== 'function') throw new Error('text-measure-required');
  const paragraphs = [];
  let current = [];
  for (const run of runs) {
    const parts = String(run.text).split('\n');
    parts.forEach((part, index) => {
      if (index > 0) { paragraphs.push(current); current = []; }
      if (part) current.push({...run, text: part});
    });
  }
  paragraphs.push(current);
  const lines = [];
  for (const paragraph of paragraphs) {
    let tokens = [];
    let width = 0;
    const tokenWidth = (text, entry) => measure(text, entry.fontFamily, entry.bold, entry.italic)
      * (size * (entry.heightFactor || 1) / 100) * (entry.widthFactor || 1);
    const pushLine = () => {
      const segments = [];
      let lineWidth = 0, lineSize = 0;
      for (const token of tokens) {
        const last = segments[segments.length - 1];
        if (last && last.fontFamily === token.fontFamily && last.color === token.color
          && last.bold === token.bold && last.italic === token.italic
          && last.size === token.size) {
          last.text += token.text; last.width += token.width;
        } else {
          segments.push({text: token.text, fontFamily: token.fontFamily, color: token.color,
            bold: token.bold, italic: token.italic, size: token.size, width: token.width});
        }
        lineWidth += token.width;
        lineSize = Math.max(lineSize, token.size);
      }
      const effSize = lineSize || size;
      lines.push({segments, width: lineWidth, size: effSize,
        advance: native ? cadLineHeight(effSize, lineSpacing) : effSize * 1.25});
      tokens = []; width = 0;
    };
    for (const entry of paragraph) {
      const entrySize = size * (entry.heightFactor || 1);
      const whole = tokenWidth(entry.text, entry);
      if (!wrapWidth || width + whole <= wrapWidth) {
        tokens.push({text: entry.text, fontFamily: entry.fontFamily, color: entry.color,
          bold: entry.bold, italic: entry.italic, widthFactor: entry.widthFactor,
          size: entrySize, width: whole});
        width += whole;
        continue;
      }
      // Same greedy token rule as wrapCadText: words stay whole, CJK glyphs are
      // individual break opportunities.
      for (const token of cadTextTokens(entry.text)) {
        const w = tokenWidth(token, entry);
        if (wrapWidth && width + w > wrapWidth && tokens.length) {
          if (!CLOSING_PUNCT.test(token)) {
            let carry = null;
            const last = tokens[tokens.length - 1];
            if (last && OPENING_PUNCT.test(last.text)) { carry = tokens.pop(); width -= carry.width; }
            pushLine();
            if (carry) { tokens.push(carry); width += carry.width; }
          }
        }
        tokens.push({text: token, fontFamily: entry.fontFamily, color: entry.color,
          bold: entry.bold, italic: entry.italic, widthFactor: entry.widthFactor,
          size: entrySize, width: w});
        width += w;
      }
    }
    pushLine();
  }
  return lines;
}

// Plain (unformatted) MTEXT wrapping with the same CAD token rule and kinsoku
// handling as the inline-run path; keeps lines as text strings.
function wrapCadLines(text, wrapWidth, size, measure, fontFamily) {
  const paragraphs = String(text).replace(/\r\n/g, '\n').split('\n');
  const clean = tokens => {
    const parts = tokens.map(token => token.text);
    if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/[ \t]+$/, '');
    return parts.join('');
  };
  const lines = [];
  for (const paragraph of paragraphs) {
    let tokens = [], width = 0;
    for (const token of cadTextTokens(paragraph)) {
      const fit = measure(token.replace(/[ \t]+$/, ''), fontFamily) * (size / 100);
      const full = measure(token, fontFamily) * (size / 100);
      if (!wrapWidth || width + fit <= wrapWidth) { tokens.push({text: token, width: full}); width += full; continue; }
      if (!CLOSING_PUNCT.test(token)) {
        let carry = null;
        const last = tokens[tokens.length - 1];
        if (last && OPENING_PUNCT.test(last.text)) { carry = tokens.pop(); width -= carry.width; }
        lines.push(clean(tokens)); tokens = []; width = 0;
        if (carry) { tokens.push(carry); width += carry.width; }
      }
      tokens.push({text: token, width: full}); width += full;
    }
    lines.push(clean(tokens));
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
    ? (text, family, bold, italic) => input.measure(text, family, bold, italic) * run.widthFactor
    : input.measure;
  if (useRuns) run.text = input.runs.map(item => item.text).join('');
  if (input.nativeLayout) {
    // Native metrics are a one-line cap-height contract. Using the measured
    // multi-line box height here would multiply em and line advance by the
    // source line count, so wrapped notes grow every time they gain a line.
    const capHeight = Number(input.height);
    // The reference DWG viewer sizes TrueType text so the glyph em equals the
    // stored text height. The ACadSharp SvgTextLayout port's 4/3 cap-height
    // conversion made every note a third taller and wider than the reference,
    // which wrapped notes early and grew their blocks past the source rectangle.
    run.size = capHeight;
    run.lineHeight = cadLineHeight(capHeight, input.lineSpacing ?? 1);
    const width = Number(input.rectangleWidth || 0) * Number(input.matrixScale || 1);
    if (useRuns) {
      const runLines = layoutRunLines(input.runs, run.size, measure, width, true, input.lineSpacing ?? 1);
      run.runLines = runLines;
      run.lines = runLines.map(line => line.segments.map(segment => segment.text).join(''));
      run.widths = runLines.map(line => line.width);
      run.lineAdvances = runLines.map(line => line.advance);
      run.lineSizes = runLines.map(line => line.size);
      run.width = Math.max(0, ...run.widths);
      run.height = run.size * 1.25 * Math.max(1, runLines.length);
    } else {
      const lines = wrapCadLines(run.text, width, run.size, measure, run.fontFamily);
      Object.assign(run, measureTextLines(lines.join('\n'), run.size, measure, run.fontFamily));
    }
    // Preserve the published viewer contract: the fit/pick box uses the em
    // size for native CAD text, while line advance uses cadLineHeight.
    run.height = run.size;
    run.nativeLayout = true;
    approximations.push('cad-em-layout');
  } else {
    if (useRuns) {
      const runLines = layoutRunLines(input.runs, run.size, measure, 0, false, 0);
      run.runLines = runLines;
      run.lines = runLines.map(line => line.segments.map(segment => segment.text).join(''));
      run.widths = runLines.map(line => line.width);
      run.lineAdvances = runLines.map(line => line.advance);
      run.lineSizes = runLines.map(line => line.size);
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
    widthFactor: options.widthFactor,
    wrapTolerance: options.wrapTolerance
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
  const runLines = Array.isArray(t.runLines) ? t.runLines : null;
  if (runLines && runLines.length) {
    let height = 0;
    for (let i = 0; i < runLines.length; i++) {
      if (i === runLines.length - 1) height += Number(runLines[i].size) || size;
      else height += Number(runLines[i].advance) || Number(t.lineHeight) || size * 1.25;
    }
    return Math.max(size, height);
  }
  const lineCount = Math.max(1, Array.isArray(t.lines) ? t.lines.length : String(t.text || '').split('\n').length);
  const lineHeight = Number(t.lineHeight) || size * 1.25;
  return Math.max(size, (lineCount - 1) * lineHeight + size);
}

export function textDisplayBox(t, x = t.x, y = t.y) {
  const box = textWorldBox({...t, x, y, height: textDisplayHeight(t)}, textOffsets(t));
  return Number.isFinite(box.minX) && Number.isFinite(box.minY) ? box : null;
}
