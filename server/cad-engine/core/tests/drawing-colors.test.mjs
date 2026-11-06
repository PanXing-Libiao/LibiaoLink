import assert from 'node:assert/strict';
import test from 'node:test';
import {aciColor, trueColorCss, drawingColorCss} from '../../../../frontend/public/cad-viewer/core/drawing-colors.js';

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

test('white sheet keeps white drawing ink visible without changing source colors', () => {
  const source = [1, 1, 1, 1];
  assert.equal(drawingColorCss(source), 'rgba(0,0,0,1)');
  assert.equal(drawingColorCss(source, 0.4), 'rgba(0,0,0,0.4)');
  assert.deepEqual(source, [1, 1, 1, 1]);
  assert.equal(drawingColorCss([0.5, 0.5, 0.5, 1]), 'rgba(128,128,128,1)');
  assert.equal(drawingColorCss([1, 1, 0, 1]), 'rgba(255,255,0,1)');
  assert.equal(aciColor(255), 'rgb(0,0,0)');
  assert.equal(trueColorCss(0xffffff), 'rgb(0,0,0)');
  assert.equal(trueColorCss(0xfefefe), 'rgb(254,254,254)');
});

test('black sheet keeps legacy ACI 7 and explicit monochrome ink visible', () => {
  const black = '#000000', white = '#ffffff';
  for (const source of [[0, 0, 0, 1], [1, 1, 1, 1]]) {
    const original = source.slice();
    assert.equal(drawingColorCss(source, 0.5, black), 'rgba(255,255,255,0.5)');
    assert.equal(drawingColorCss(source, 0.5, white), 'rgba(0,0,0,0.5)');
    assert.deepEqual(source, original);
  }
  assert.equal(aciColor(7, black), 'rgb(255,255,255)');
  assert.equal(aciColor(255, black), 'rgb(255,255,255)');
  assert.equal(trueColorCss(0, black), 'rgb(255,255,255)');
  assert.equal(trueColorCss(0xffffff, black), 'rgb(255,255,255)');
  assert.equal(aciColor(1, black), aciColor(1, white));
  assert.equal(trueColorCss(0x808080, black), trueColorCss(0x808080, white));
  assert.equal(drawingColorCss([1, 1, 0, 1], 1, black), 'rgba(255,255,0,1)');
});
