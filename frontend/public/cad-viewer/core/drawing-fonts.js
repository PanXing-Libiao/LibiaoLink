import {BUNDLED_FONT_FACES} from './drawing-font-coverage.js';

const ignored = char => /[\r\n\t]/u.test(char) || /\p{Default_Ignorable_Code_Point}/u.test(char);
const faceKey = face => face.family + '/' + face.weight + '/' + face.style;
export function fontCovers(face, char) {
  if (ignored(char)) return true;
  const point = char.codePointAt(0), ranges = face.ranges;
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1, [start, end] = ranges[mid];
    if (point < start) high = mid - 1;
    else if (point > end) low = mid + 1;
    else return true;
  }
  return false;
}
function candidates(family, bold) {
  const name = String(family).replaceAll('"', '').replaceAll("'", '');
  const serif = /Serif/.test(name), mono = /Mono/.test(name);
  const preferred = BUNDLED_FONT_FACES.some(face => face.family === name) ? name : 'Libiao Sans SC';
  const families = [...new Set([preferred, serif ? 'Libiao Serif SC' : 'Libiao Sans SC',
    mono ? 'Libiao Mono' : serif ? 'Libiao Serif' : 'Libiao Sans', 'Libiao Serif SC', 'Libiao Sans SC'])];
  return families.flatMap(family => BUNDLED_FONT_FACES.filter(face => face.family === family)
    .sort((a, b) => Math.abs(a.weight - (bold ? 700 : 400)) - Math.abs(b.weight - (bold ? 700 : 400))));
}

// Original-font presentation parts stay upstream of this resolver. Only raw
// text previews enter here, and only checked-in faces can supply their glyphs.
export function createBundledFontResolver(fontSet = document.fonts) {
  const unavailable = new Set();
  function resolveRuns(sourceRuns) {
    const runs = [], missing = new Set(), styleApproximations = new Set();
    let unavailableGlyphs = false;
    for (const source of sourceRuns) {
      const choices = candidates(source.fontFamily, source.bold).filter(face => !unavailable.has(faceKey(face)));
      for (const char of String(source.text)) {
        let face = choices.find(face => fontCovers(face, char)), text = char;
        if (!face) {
          missing.add(char);
          text = '\u25a1';
          face = choices.find(face => fontCovers(face, text));
        }
        if (!face) { unavailableGlyphs = true; continue; }
        const bold = face.weight >= 700, italic = face.style === 'italic';
        if (!!source.bold !== bold || !!source.italic !== italic)
          styleApproximations.add((source.bold ? 'bold' : 'regular') + '/' + (source.italic ? 'italic' : 'normal'));
        const previous = runs[runs.length - 1];
        if (previous && previous._source === source && previous._face === face) previous.text += text;
        else runs.push({...source, text, fontFamily: '"' + face.family + '"', bold, italic, _face: face, _source: source});
      }
    }
    return {runs, missing: [...missing], styleApproximations: [...styleApproximations], unavailableGlyphs};
  }
  async function prepare(runGroups) {
    // A failed face may be replaced by another bundled face. Stop once all
    // selected faces loaded, or the finite bundled set has been exhausted.
    for (let attempt = 0; attempt <= BUNDLED_FONT_FACES.length; attempt++) {
      const requests = new Map();
      for (const group of runGroups) for (const run of resolveRuns(group).runs) {
        const key = faceKey(run._face);
        if (!requests.has(key)) requests.set(key, {face: run._face, chars: new Set(['H'])});
        for (const char of run.text) if (!ignored(char)) requests.get(key).chars.add(char);
      }
      const failed = await Promise.all([...requests].map(async ([key, {face, chars}]) => {
        try {
          const loaded = await fontSet.load(face.style + ' ' + face.weight + ' 100px "' + face.family + '"', [...chars].join('') || 'H');
          return loaded.length && loaded.every(item => item.status === 'loaded') ? null : key;
        } catch { return key; }
      }));
      const failures = failed.filter(Boolean);
      if (!failures.length) return;
      for (const key of failures) unavailable.add(key);
    }
  }
  return {prepare, resolveRuns, unavailable: () => [...unavailable]};
}
