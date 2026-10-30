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
