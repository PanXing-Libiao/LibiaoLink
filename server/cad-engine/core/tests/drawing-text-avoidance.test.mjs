import test from 'node:test';
import assert from 'node:assert/strict';
import {boxesOverlap, resolveTextAvoidance} from '../../../../frontend/public/cad-viewer/core/drawing-text-avoidance.js';

const box = (minX, minY, maxX, maxY) => ({minX, minY, maxX, maxY});

test('display avoidance keeps the larger text at its source position', () => {
  const result = resolveTextAvoidance([
    {id: 'large', box: box(0, 0, 100, 100)},
    {id: 'small', box: box(50, 50, 100, 100)},
  ]);
  assert.deepEqual(result.get('large'), {dx: 0, dy: 0, box: box(0, 0, 100, 100)});
  const moved = result.get('small');
  assert.ok(moved.dx || moved.dy);
  assert.equal(boxesOverlap(result.get('large').box, moved.box), false);
});

test('display avoidance leaves separated and oversized boxes at their source', () => {
  const separated = resolveTextAvoidance([
    {id: 'a', box: box(0, 0, 10, 10)},
    {id: 'b', box: box(20, 0, 30, 10)},
  ]);
  assert.deepEqual(separated.get('a'), {dx: 0, dy: 0, box: box(0, 0, 10, 10)});
  assert.deepEqual(separated.get('b'), {dx: 0, dy: 0, box: box(20, 0, 30, 10)});

  const limited = resolveTextAvoidance([
    {id: 'large', box: box(0, 0, 100, 100)},
    {id: 'small', box: box(50, 50, 60, 60)},
  ], {maxShift: 1});
  assert.deepEqual(limited.get('small'), {dx: 0, dy: 0, box: box(50, 50, 60, 60)});
});
