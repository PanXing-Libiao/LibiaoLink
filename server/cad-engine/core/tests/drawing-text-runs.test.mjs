import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMtextRuns, layoutTextRun} from '../../../../frontend/public/cad-viewer/core/drawing-text.js';

const resolve = name => (/宋体|simsun/i.test(name) ? 'SIM' : null);

test('parses an inline font run with group scope', () => {
  const runs = parseMtextRuns('{\\f宋体|b0|i0;中文}ABC', 'LAT', resolve);
  assert.deepEqual(runs.map(run => [run.text, run.fontFamily]), [['中文', 'SIM'], ['ABC', 'LAT']]);
});

test('nested groups restore the outer font', () => {
  const runs = parseMtextRuns('A{\\f宋体;中}B{\\f宋体;文}C', 'LAT', resolve);
  assert.deepEqual(runs.map(run => [run.text, run.fontFamily]),
    [['A', 'LAT'], ['中', 'SIM'], ['B', 'LAT'], ['文', 'SIM'], ['C', 'LAT']]);
});

test('layout keeps per-run fonts and total widths', () => {
  const measure = (text, fontFamily) => text.length * (fontFamily === 'SIM' ? 100 : 50);
  const run = layoutTextRun({
    text: '', runs: [{text: '中文', fontFamily: 'SIM'}, {text: 'AB', fontFamily: 'LAT'}],
    kind: 'mtext', x: 0, y: 0, angle: 0, height: 10, measure, nativeLayout: false
  });
  assert.equal(run.runLines.length, 1);
  assert.deepEqual(run.runLines[0].segments.map(segment => segment.fontFamily), ['SIM', 'LAT']);
  assert.equal(run.width, 2 * 10 + 2 * 5);
});

test('inline ACI color persists until the group ends', () => {
  const color = (kind, value) => (kind === 'aci' && Number(value) === 30 ? 'ORANGE' : null);
  const runs = parseMtextRuns('{\\C30;黄}AB', 'LAT', resolve, color);
  assert.deepEqual(runs.map(run => [run.text, run.color]), [['黄', 'ORANGE'], ['AB', null]]);
});

test('inline true color resolves a 24-bit value', () => {
  const color = (kind, value) => (kind === 'true' && Number(value) === 16711680 ? 'RED' : null);
  const runs = parseMtextRuns('\\c16711680;红', 'LAT', resolve, color);
  assert.deepEqual(runs.map(run => [run.text, run.color]), [['红', 'RED']]);
});

test('run colors survive layout into segments', () => {
  const measure = () => 50;
  const run = layoutTextRun({
    text: '', runs: [{text: '甲', fontFamily: 'SIM', color: 'ORANGE'}, {text: 'AB', fontFamily: 'LAT', color: null}],
    kind: 'mtext', x: 0, y: 0, angle: 0, height: 10, measure, nativeLayout: false
  });
  assert.deepEqual(run.runLines[0].segments.map(segment => segment.color), ['ORANGE', null]);
  assert.deepEqual(run.runLines[0].segments.map(segment => segment.text), ['甲', 'AB']);
});

test('inline runs wrap on CAD tokens instead of splitting English words', () => {
  const measure = text => text.length * 10;
  const run = layoutTextRun({
    text: '', runs: [{text: 'All power lines', fontFamily: 'LAT'}],
    kind: 'mtext', x: 0, y: 0, angle: 0, height: 100, measure,
    nativeLayout: true, rectangleWidth: 100, matrixScale: 1
  });
  assert.deepEqual(run.lines.map(line => line.trim()), ['All power', 'lines']);
});

test('wrap tolerance fits lines the source rectangle would break', () => {
  const measure = text => text.length * 10;
  const strict = layoutTextRun({
    text: 'All power lines', kind: 'mtext', x: 0, y: 0, angle: 0, height: 100, measure,
    nativeLayout: true, rectangleWidth: 120, matrixScale: 1
  });
  const relaxed = layoutTextRun({
    text: 'All power lines', kind: 'mtext', x: 0, y: 0, angle: 0, height: 100, measure,
    nativeLayout: true, rectangleWidth: 120, matrixScale: 1, wrapTolerance: 1.4
  });
  assert.equal(strict.lines.length, 2);
  assert.equal(relaxed.lines.length, 1);
});

test('style width factor narrows advances and widens the wrap budget', () => {
  const measure = text => text.length * 10;
  const wide = layoutTextRun({
    text: 'All power lines', kind: 'mtext', x: 0, y: 0, angle: 0, height: 100, measure,
    nativeLayout: true, rectangleWidth: 120, matrixScale: 1
  });
  const narrow = layoutTextRun({
    text: 'All power lines', kind: 'mtext', x: 0, y: 0, angle: 0, height: 100, measure,
    nativeLayout: true, rectangleWidth: 120, matrixScale: 1, widthFactor: 0.8
  });
  assert.equal(narrow.widthFactor, 0.8);
  assert.equal(Math.round(narrow.width), 120);
  assert.equal(wide.lines.length, 2);
  assert.equal(narrow.lines.length, 1);
});
