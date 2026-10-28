import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLineRange} from '../../../../frontend/public/cad-viewer/core/drawing-display.js';

test('non-indexed line ranges keep consecutive vertex pairs', () => {
  assert.deepEqual(normalizeLineRange({first: 0, count: 6}, 6), {first: 0, count: 6});
  assert.deepEqual(normalizeLineRange({first: 2, count: 2}, 4), {first: 2, count: 2});
  assert.deepEqual(normalizeLineRange(undefined, 4), {first: 0, count: 4});
});

test('invalid line ranges are rejected instead of becoming a point', () => {
  assert.equal(normalizeLineRange({first: 0, count: 3}, 4), null);
  assert.equal(normalizeLineRange({first: 0, count: 6}, 4), null);
  assert.equal(normalizeLineRange({first: -1, count: 2}, 4), null);
  assert.equal(normalizeLineRange({first: 0, count: 2}, 0), null);
  assert.equal(normalizeLineRange({}, 4), null);
  assert.equal(normalizeLineRange({first: 0, count: 2.5}, 4), null);
});

test('an explicit empty range has no segments but is not malformed', () => {
  assert.deepEqual(normalizeLineRange({first: 0, count: 0}, 4), {first: 0, count: 0});
});
