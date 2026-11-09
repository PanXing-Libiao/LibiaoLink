// Authoritative text-layout contract for the 2D viewer. The adapter owns glyph
// parts when it can produce them; this module owns the raw-annotation fallback
// used by both the ordinary and retained projections. It is pure apart from the
// caller-supplied Canvas font metric callback.
import {cadTextTokens, cadLineHeight} from './vendor/cad-text-layout.js';

export const TEXT_FONT = '"Libiao Sans SC"';

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
export function parseMtextRuns(raw, defaultFont, resolveFont, resolveColor, baseHeight = 0, baseWidthFactor = 1) {
  const source = String(raw || '');
  const runs = [];
  const stack = [];
  const initial = {font: defaultFont, color: null, heightFactor: 1, widthFactor: 1, tracking: 1, paragraph: {}, bold: false, italic: false};
  let state = {...initial};
  let buffer = '';
  const sameState = (a, b) => (a.fontFamily ?? a.font) === (b.fontFamily ?? b.font)
    && a.color === b.color
    && a.heightFactor === b.heightFactor && a.widthFactor === b.widthFactor
    && a.tracking === b.tracking && a.paragraph === b.paragraph
    && a.bold === b.bold && a.italic === b.italic;
  const flush = () => {
    if (!buffer) return;
    const last = runs[runs.length - 1];
    if (last && sameState(last, state)) last.text += buffer;
    else runs.push({text: buffer, fontFamily: state.font, color: state.color,
      heightFactor: state.heightFactor, widthFactor: state.widthFactor, tracking: state.tracking, paragraph: state.paragraph,
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
        const factor = parseHeightControl(value.trim(), baseHeight, state.heightFactor);
        if (factor) state = {...state, heightFactor: factor};
        i = end; continue;
      }
      if (next === 'W') {
        const {value, end} = readValue(i + 2);
        flush();
        const control = value.trim();
        const factor = /x$/i.test(control) ? state.widthFactor * Number(control.slice(0, -1)) : Number(control) / baseWidthFactor;
        if (Number.isFinite(factor) && factor > 0) state = {...state, widthFactor: factor};
        i = end; continue;
      }
      if (next === 'T' || next === 'p') {
        const {value, end} = readValue(i + 2); flush();
        if (next === 'p') state = {...state, paragraph: paragraphControl(value, state.paragraph)};
        else {
          const control = value.trim(), factor = /x$/i.test(control)
            ? state.tracking * Number(control.slice(0, -1)) : Number(control);
          if (Number.isFinite(factor) && factor > 0) state = {...state, tracking: factor};
        }
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
function parseHeightControl(value, baseHeight, currentFactor) {
  if (!value) return null;
  const factor = /x$/i.test(value) ? currentFactor * Number(value.slice(0, -1)) : (baseHeight > 0 ? Number(value) / baseHeight : NaN);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

// CJK 禁则: closing punctuation must not start a line, opening punctuation must
// not end one. Both sets are the common fullwidth and ASCII forms CAD text uses.
const CLOSING_PUNCT = /^[，。、；：！？"”’）】》」』·…—％‰,.;:!?)\]}%]$/;
const OPENING_PUNCT = /^[（【《「『“‘(\[{]$/;

function trackedMeasure(text, measure, factor = 1) {
  if (factor === 1) return {width: measure(text)};
  let width = 0, previous = '';
  const offsets = [];
  for (const char of text) {
    const advance = measure(char);
    if (previous && !(previous.trim() === '' && char.trim() === ''))
      width += (measure(previous + char) - measure(previous) - advance) * factor;
    offsets.push(width); width += advance * factor; previous = char;
  }
  return {width, offsets};
}

function paragraphControl(value, previous = {}) {
  const result = {...previous}, unsupported = [];
  let tabs = null;
  for (const part of value.replace(/^x/, '').split(',')) {
    const numeric = /^([ilr])([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\*)$/i.exec(part);
    if (numeric) { result[{i:'indent',l:'left',r:'right'}[numeric[1].toLowerCase()]] = numeric[2] === '*' ? 0 : Number(numeric[2]); continue; }
    if (/^q[lcr*]$/.test(part)) { result.align = {l:0,c:.5,r:1,'*':null}[part[1]]; continue; }
    if (part.startsWith('t')) tabs = [];
    const tab = tabs && (part.startsWith('t') ? part.slice(1) : part);
    if (tab === '*') continue;
    if (tab !== null && tab !== false && tab !== undefined && tab !== '' && Number.isFinite(Number(tab))) { tabs.push(Number(tab)); continue; }
    if (part) unsupported.push(part);
  }
  if (tabs) result.tabs = tabs;
  if (unsupported.length) result.unsupported = unsupported;
  return result;
}

function layoutRunLines(runs, size, measure, wrapWidth, native = false, lineSpacing = 1, capHeight = size, measureCapHeight, flow = {}) {
  if (typeof measure !== 'function') throw new Error('text-measure-required');
  const paragraphs = [];
  let current = {runs: [], format: runs[0]?.paragraph || {}};
  for (const run of runs) {
    String(run.text).split('\n').forEach((part, index) => {
      if (index > 0) { paragraphs.push(current); current = {runs: [], format: run.paragraph || {}}; }
      if (!current.runs.length) current.format = run.paragraph || {};
      if (part) current.runs.push({...run, text: part});
    });
  }
  paragraphs.push(current);
  const lines = [], hasFrame = wrapWidth > 0;
  const attachmentAlign = ((flow.attachment || 1) - 1) % 3 / 2;
  const mtext = native && flow.kind === 'mtext';
  for (const paragraph of paragraphs) {
    const format = mtext ? paragraph.format : {};
    let tokens = [], width = 0, first = true;
    const left = () => ((format.left || 0) + (first ? format.indent || 0 : 0)) * capHeight;
    const available = () => wrapWidth - left() - (format.right || 0) * capHeight;
    const fontSize = entry => (native && measureCapHeight
      ? capHeight * 100 / measureCapHeight(entry.fontFamily, entry.bold, entry.italic) : size) * (entry.heightFactor || 1);
    const metric = (text, entry) => trackedMeasure(text,
      text => measure(text, entry.fontFamily, entry.bold, entry.italic), entry.tracking || 1);
    const tokenWidth = (text, entry) => metric(text, entry).width * fontSize(entry) / 100 * (entry.widthFactor || 1);
    const token = (text, entry) => ({...entry, text, width:tokenWidth(text, entry),
      size:fontSize(entry), capHeight:capHeight * (entry.heightFactor || 1)});
    const pushLine = () => {
      // Match plain CAD wrapping: line-end spaces are separators, not ink or
      // extra rows. Keep leading spaces, explicit tabs and empty paragraphs.
      if (mtext) for (let i = tokens.length - 1; i >= 0 && !tokens[i].tab; i--) {
        const item = tokens[i], text = item.text.replace(/ +$/, '');
        if (text === item.text) break;
        tokens[i] = {...item, text, width: tokenWidth(text, item)};
        if (text) break;
      }
      const segments = []; let lineSize = 0, lineCapHeight = 0;
      for (const item of tokens) {
        const last = segments[segments.length - 1];
        if (!item.tab && last && !last.tab && last.fontFamily === item.fontFamily && last.color === item.color
          && last.bold === item.bold && last.italic === item.italic && last.size === item.size
          && last.widthFactor === (item.widthFactor || 1) && last.tracking === (item.tracking || 1)) {
          last.text += item.text; last.width += item.width;
        } else segments.push({...item, widthFactor:item.widthFactor || 1, tracking:item.tracking || 1});
        lineSize = Math.max(lineSize, item.size); lineCapHeight = Math.max(lineCapHeight, item.capHeight);
      }
      for (const segment of segments) if (!segment.tab && segment.tracking !== 1) {
        const measured = metric(segment.text, segment), factor = segment.size / 100 * segment.widthFactor;
        segment.glyphOffsets = measured.offsets.map(offset => offset * factor);
        segment.width = measured.width * factor;
      }
      const lineWidth = segments.reduce((sum, segment) => sum + segment.width, 0);
      const line = {segments, width:lineWidth, size:lineSize || size, capHeight:lineCapHeight || capHeight,
        advance:native ? cadLineHeight(flow.lineSpacingStyle === 'Exactly' ? capHeight : lineCapHeight || capHeight, lineSpacing) : (lineSize || size) * 1.25};
      if (mtext) {
        const align = format.align ?? attachmentAlign;
        line.x = hasFrame ? -attachmentAlign * wrapWidth + left() + align * (available() - lineWidth)
          : left() - align * lineWidth;
        if (format.unsupported?.length) line.unmappedParagraph = format.unsupported;
      }
      lines.push(line); tokens = []; width = 0; first = false;
    };
    const appendText = (text, entry) => {
      if (!text) return;
      const whole = token(text, entry);
      const fitWidth = tokenWidth(mtext ? text.replace(/ +$/, '') : text, entry);
      if (!hasFrame || /^ +$/.test(text) || width + fitWidth <= available()) { tokens.push(whole); width += whole.width; return; }
      for (const value of cadTextTokens(text)) {
        const item = token(value, entry);
        const fit = tokenWidth(mtext ? value.replace(/ +$/, '') : value, entry);
        if (!/^ +$/.test(value) && width + fit > available() && tokens.length && !CLOSING_PUNCT.test(value)) {
          let carry = null;
          if (OPENING_PUNCT.test(tokens[tokens.length - 1].text)) { carry = tokens.pop(); width -= carry.width; }
          pushLine();
          if (carry) { tokens.push(carry); width += carry.width; }
        }
        tokens.push(item); width += item.width;
      }
    };
    for (const entry of paragraph.runs) {
      const parts = entry.text.split('\t');
      parts.forEach((part, index) => {
        if (index > 0) {
          const cursor = left() + width;
          const stops = format.tabs?.length ? format.tabs.map(stop => stop * capHeight) : [];
          const stop = stops.length ? stops.find(stop => stop > cursor) : (Math.floor(cursor / (4 * capHeight)) + 1) * 4 * capHeight;
          const advance = stop !== undefined ? stop - cursor : tokenWidth(' ', entry);
          tokens.push({...token('', entry), tab:true, width:advance}); width += advance;
        }
        appendText(part, entry);
      });
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
      if (!tokens.length || !wrapWidth || width + fit <= wrapWidth) { tokens.push({text: token, width: full}); width += full; continue; }
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
    // CAD stores capital-letter height, whereas Canvas font size is an em.
    // Measure the selected font instead of assuming one multiplier for all fonts.
    run.size = input.measureCapHeight ? capHeight * 100 / input.measureCapHeight(run.fontFamily) : capHeight;
    run.lineHeight = cadLineHeight(capHeight, input.lineSpacing ?? 1);
    const width = Number(input.rectangleWidth || 0) * Number(input.matrixScale || 1);
    if (useRuns) {
      const runLines = layoutRunLines(input.runs, run.size, measure, width, true, input.lineSpacing ?? 1, capHeight, input.measureCapHeight, input);
      run.runLines = runLines;
      run.lines = runLines.map(line => line.segments.map(segment => segment.text).join(''));
      run.widths = runLines.map(line => line.width);
      run.lineAdvances = runLines.map(line => line.advance);
      run.lineSizes = runLines.map(line => line.size);
      run.width = Math.max(0, ...run.widths);
      if (runLines.every(line => line.x !== undefined)) {
        run.paragraphLeft = Math.min(...runLines.map(line => line.x));
        run.width = Math.max(...runLines.map(line => line.x + line.width)) - run.paragraphLeft;
      }
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
  if (input.fitWidth > 0 && run.width > 0) {
    const factor = input.fitWidth / run.width;
    run.width = input.fitWidth;
    run.widths = run.widths.map(width => width * factor);
    if (input.aligned) {
      run.size *= factor; run.height *= factor;
      if (run.lineHeight) run.lineHeight *= factor;
    } else run.widthFactor *= factor;
    for (const line of run.runLines || []) {
      line.width *= factor;
      if (line.x !== undefined) line.x *= factor;
      if (input.aligned) { line.size *= factor; line.advance *= factor; }
      for (const segment of line.segments) {
        segment.width *= factor;
        if (segment.glyphOffsets) segment.glyphOffsets = segment.glyphOffsets.map(offset => offset * factor);
        if (input.aligned) segment.size *= factor;
      }
    }
    approximations.push(input.aligned ? 'aligned-endpoints' : 'fit-endpoints');
  }
  // Measure painted ink after wrapping and Fit/Aligned scaling. MTEXT uses it
  // for attachment; TEXT also needs its above-baseline bounds for fit/picking.
  if (run.nativeLayout && input.measureInk) {
    let top = Infinity, bottom = -Infinity, baseline = 0;
    const lines = run.runLines || run.lines.map(text => ({segments: [{text,
      fontFamily: run.fontFamily, size: run.size}], advance: run.lineHeight}));
    for (const line of lines) {
      line.inkTop = Infinity; line.inkBottom = -Infinity;
      const visible = line.segments.filter(segment => !segment.tab);
      const segments = visible.length ? visible : [{text: 'H', fontFamily: run.fontFamily, size:line.size || run.size}];
      for (const segment of segments) {
        const ink = input.measureInk(segment.text.trim() ? segment.text : 'H', segment.fontFamily, segment.bold, segment.italic);
        line.inkTop = Math.min(line.inkTop, -ink.ascent * segment.size / 100);
        line.inkBottom = Math.max(line.inkBottom, ink.descent * segment.size / 100);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i + 1 < lines.length && input.lineSpacingStyle !== 'Exactly')
        line.advance += Math.max(0, -lines[i + 1].inkTop - (lines[i + 1].capHeight || Number(input.height)));
      top = Math.min(top, baseline + line.inkTop); bottom = Math.max(bottom, baseline + line.inkBottom);
      baseline += line.advance || run.lineHeight || run.height * 1.25;
    }
    run.verticalInk = {top, bottom};
  }
  if (run.runLines?.some(line => line.unmappedParagraph?.length)) approximations.push('paragraph-controls-unmapped');
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
  let anchor = apply(matrix, annotation.position || [0, 0, 0]);
  const direction = annotation.direction || [1, 0, 0];
  let dir = [matrix[0] * direction[0] + matrix[4] * direction[1],
    matrix[1] * direction[0] + matrix[5] * direction[1]];
  const height = Number((sem.height && sem.height.value) ||
    (sem.charHeight && sem.charHeight.value) || 2.5) * matrixScale(matrix);
  const semText = (sem.plainText && sem.plainText.value) ? sem.plainText.value : (annotation.text || '');
  const text = Array.isArray(options.runs) && options.runs.length
    ? options.runs.map(item => item.text).join('') : semText;
  if (annotation.kind === 'dimension' || !text) return {anchor, run: null};
  const fitPoints = sem.fitPoints?.value;
  let fitWidth;
  if (annotation.kind === 'text' && fitPoints?.length === 2) {
    anchor = apply(matrix, fitPoints[0]);
    const end = apply(matrix, fitPoints[1]);
    dir = [end[0]-anchor[0], end[1]-anchor[1]];
    fitWidth = Math.hypot(...dir);
  }
  const run = layoutTextRun({
    fitWidth, aligned: sem.horizontalAlignment?.value === 'Aligned',
    text, kind: annotation.kind, x: anchor[0], y: anchor[1],
    angle: Math.atan2(dir[1], dir[0]), height,
    halign: Number((sem.halign && sem.halign.value) || 0),
    valign: Number((sem.valign && sem.valign.value) || 0),
    attachment: Number((sem.attachmentPoint && sem.attachmentPoint.value) || 1),
    color: options.color,
    nativeLayout: !!options.nativeLayout,
    lineSpacing: Number((sem.lineSpacing && sem.lineSpacing.value) ?? 1),
    lineSpacingStyle: sem.lineSpacingStyle?.value === 'Exact' ? 'Exactly' : sem.lineSpacingStyle?.value || 'AtLeast',
    rectangleWidth: Number((sem.rectangleWidth && sem.rectangleWidth.value) || 0),
    matrixScale: matrixScale(matrix),
    measure: options.measure,
    measureCapHeight: options.measureCapHeight,
    measureInk: options.measureInk,
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
    dx = t.paragraphLeft ?? ((a === 2 || a === 5 || a === 8) ? -t.width / 2 : (a === 3 || a === 6 || a === 9) ? -t.width : 0);
    const ink = t.verticalInk;
    dy = ink ? (a <= 3 ? -ink.top : a <= 6 ? -(ink.top + ink.bottom) / 2 : -ink.bottom)
      : a <= 3 ? t.size : a <= 6 ? t.size * 0.35 : 0;
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
  if (t.verticalInk) return t.verticalInk.bottom - t.verticalInk.top;
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

export function textDisplayCorners(t) {
  const offsets = textOffsets(t);
  offsets.dy += t.verticalInk?.top || 0;
  return textWorldCorners({...t, height: textDisplayHeight(t)}, offsets);
}

export function textDisplayBox(t, x = t.x, y = t.y) {
  const offsets = textOffsets(t);
  offsets.dy += t.verticalInk?.top || 0;
  const box = textWorldBox({...t, x, y, height: textDisplayHeight(t)}, offsets);
  return Number.isFinite(box.minX) && Number.isFinite(box.minY) ? box : null;
}


// Both viewer projections paint the same layout. Native CAD glyphs must keep
// the source scale: clamping font pixels while scaling advances/anchors moves
// visible text away from its layout and can push it entirely out of the view.
export function paintTextRun(ctx, t, scale = 1, screenScale = scale) {
  const size = t.nativeLayout ? t.size * scale
    : Math.max(5, Math.min(220, t.size * screenScale)) / screenScale * scale;
  const wf = t.widthFactor || 1;
  const offsets = textOffsets(t);
  ctx.save();
  ctx.scale(wf, 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (t.runLines) {
    let y = offsets.dy * scale;
    for (const line of t.runLines) {
      let x = (line.x ?? textOffsets({...t, width: line.width}).dx) * scale / wf;
      for (const segment of line.segments) {
        if (!segment.text) { x += segment.width * scale / wf; continue; }
        const inlineWidth = segment.widthFactor || 1;
        const segmentSize = segment.size && t.size ? segment.size / t.size : 1;
        ctx.font = (segment.italic ? 'italic ' : '') + (segment.bold ? 'bold ' : '')
          + (size * segmentSize) + 'px ' + (segment.fontFamily || t.fontFamily || TEXT_FONT);
        ctx.fillStyle = segment.color || t.color;
        ctx.save(); ctx.scale(inlineWidth, 1);
        if (segment.glyphOffsets) {
          [...segment.text].forEach((char, index) => ctx.fillText(char,
            (x + segment.glyphOffsets[index] * scale / wf) / inlineWidth, y));
        } else ctx.fillText(segment.text, x / inlineWidth, y);
        ctx.restore();
        x += segment.width * scale / wf;
      }
      y += (line.advance || t.lineHeight || t.height * 1.25) * scale;
    }
  } else {
    ctx.font = size + 'px ' + (t.fontFamily || TEXT_FONT);
    ctx.fillStyle = t.color;
    const lines = t.lines || String(t.text).split('\n');
    lines.forEach((line, i) => {
      const width = t.widths?.[i] ?? t.width;
      const dx = textOffsets({...t, width}).dx * scale / wf;
      ctx.fillText(line, dx, offsets.dy * scale + i * (t.lineHeight ? t.lineHeight * scale : size * 1.25));
    });
  }
  ctx.restore();
}
