import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hatchFillKind, lineDashFor, fillGeometryFor, strokeSegmentsForRepresentation
} from '../../../../frontend/public/cad-viewer/core/drawing-pattern.js';

const translate = (x, y) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,0,1];

test('hatch kind keeps pattern priority over gradient and rejects non-hatches', () => {
  assert.equal(hatchFillKind({geometry:{type:'hatch',patternId:'ANSI31'}}, {gradient:{}}), 'pattern');
  assert.equal(hatchFillKind({geometry:{type:'hatch'}}, {gradient:{name:'LINEAR'}}), 'gradient');
  assert.equal(hatchFillKind({geometry:{type:'hatch'}}, {}), 'solid');
  assert.equal(hatchFillKind({geometry:{type:'line'}}, {}), null);
  assert.equal(hatchFillKind(null, {}), null);
});

test('dash resolution uses compiled patterns and per-item line-type scale', () => {
  const lineTypes = {lt:{segments:[{kind:'dash',length:2},{kind:'gap',length:1}]}};
  assert.deepEqual(lineDashFor({lineTypeId:'lt'}, 'e1', {lineTypes}), [2,1]);
  assert.deepEqual(lineDashFor({lineTypeId:'lt'}, 'e1', {
    lineTypes, styleExt:{lineTypePatterns:{lt:[5,1,.5]}, entityState:{e1:{lineTypeScale:2}}}
  }), [10,2,1]);
  assert.deepEqual(lineDashFor({lineTypeId:'lt'}, 'e1', {
    lineTypes:{lt:{segments:[{kind:'dash',length:2}]}}
  }), []);
  assert.equal(lineDashFor({}, 'e1', {lineTypes}), null);
});

test('fill geometry returns world rings and a bbox from retained rings', () => {
  const fill = fillGeometryFor({
    draw:{localToSpace:translate(10,20), displayRepresentationId:'rep'},
    entity:{geometry:{type:'hatch'}}, fillEntry:{rings:[[[0,0],[2,0],[2,2]]]},
    mode:'display', tolerance:1, representationGeometry:()=>null, analyticFor:()=>null,
    toWorld:point => [point[0] + 10, point[1] + 20],
    boundaryGeometry:()=>null
  });
  assert.equal(fill.kind, 'rings');
  assert.deepEqual(fill.rings, [[[10,20],[12,20],[12,22]]]);
  assert.deepEqual(fill.bbox, {minX:10,minY:20,maxX:12,maxY:22});
});

test('display triangles and analytic boundaries use the same fill contract', () => {
  const representationGeometry = () => ({
    topology:'triangles', positions:new Float32Array([0,0,0, 2,0,0, 0,2,0]), indices:new Uint32Array([0,1,2])
  });
  const triangles = fillGeometryFor({
    draw:{localToSpace:translate(1,1), displayRepresentationId:'rep'},
    entity:{geometry:{type:'hatch'}}, fillEntry:null, mode:'display', tolerance:1,
    representationGeometry, analyticFor:()=>null,
    toWorld:point => [point[0] + 1, point[1] + 1], boundaryGeometry:()=>null
  });
  assert.equal(triangles.kind, 'triangles');
  assert.deepEqual(triangles.triangles, [[[1,1],[3,1],[1,3]]]);
  assert.deepEqual(triangles.bbox, {minX:1,minY:1,maxX:3,maxY:3});

  const rings = fillGeometryFor({
    draw:{localToSpace:translate(0,0), displayRepresentationId:null},
    entity:{geometry:{type:'hatch', boundaryEntityIds:['b']}}, fillEntry:null, mode:'analytic', tolerance:1,
    representationGeometry:()=>null, analyticFor:()=>[[0,0],[4,0],[4,4]],
    toWorld:point => [point[0], point[1]], boundaryGeometry:()=>({type:'polyline'})
  });
  assert.equal(rings.kind, 'rings');
  assert.deepEqual(rings.rings, [[[0,0],[4,0],[4,4]]]);
  assert.deepEqual(rings.bbox, {minX:0,minY:0,maxX:4,maxY:4});
});

test('pattern strokes handle indexed and non-indexed lines without a Path2D dependency', () => {
  const indexed = strokeSegmentsForRepresentation({
    positions:new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,2,0]),
    indices:new Uint32Array([0,1,2,3]), topology:'lines'
  }, point => [point[0] + 1, point[1] + 1]);
  assert.deepEqual(Array.from(indexed.segments), [1,1,3,1,3,3,1,3]);
  assert.deepEqual(indexed.bbox, {minX:1,minY:1,maxX:3,maxY:3});

  const ranged = strokeSegmentsForRepresentation({
    positions:new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,2,0]),
    topology:'lines', range:{first:0,count:4}
  }, point => [point[0], point[1]]);
  assert.deepEqual(Array.from(ranged.segments), [0,0,2,0,2,2,0,2]);
  assert.equal(ranged.invalidRange, undefined);

  const invalid = strokeSegmentsForRepresentation({
    positions:new Float32Array([0,0,0, 2,0,0, 2,2,0]), topology:'lines', range:{first:0,count:3}
  }, point => [point[0], point[1]]);
  assert.equal(invalid.invalidRange, true);
  assert.deepEqual(Array.from(invalid.segments), []);

  const points = strokeSegmentsForRepresentation({
    positions:new Float32Array([0,0,0, 4,5,0]), topology:'points'
  }, point => [point[0], point[1]]);
  assert.deepEqual(points.points, [[0,0],[4,5]]);
  assert.deepEqual(points.bbox, {minX:0,minY:0,maxX:4,maxY:5});

  assert.equal(strokeSegmentsForRepresentation({positions:new Float32Array(), topology:'triangles'},
    point => [point[0], point[1]]).unsupported, 'triangles');
});

