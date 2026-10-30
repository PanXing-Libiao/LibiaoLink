import assert from 'node:assert/strict';
import test from 'node:test';
import {aciColor, trueColorCss} from '../../../../frontend/public/cad-viewer/core/drawing-colors.js';

test('ACI index resolves through the shared palette', () => {
  assert.equal(aciColor(30), 'rgb(255,127,0)');
  assert.equal(aciColor(40), 'rgb(255,191,0)');
  assert.equal(aciColor(1), 'rgb(255,0,0)');
});

test('context ink and ByBlock/ByLayer have explicit answers', () => {
  assert.equal(aciColor(7), 'rgb(0,0,0)');
  assert.equal(aciColor(0), null);
  assert.equal(aciColor(256), null);
  assert.equal(aciColor('x'), null);
});

test('true color accepts a 24-bit integer', () => {
  assert.equal(trueColorCss(0xff7f00), 'rgb(255,127,0)');
  assert.equal(trueColorCss(0), 'rgb(0,0,0)');
  assert.equal(trueColorCss(-1), null);
  assert.equal(trueColorCss(0x1000000), null);
});
