import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaItemFor, imagePlacement, rasterRecord} from '../../../../frontend/public/cad-viewer/core/drawing-media.js';

const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const translate = (x, y) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,0,1];
const image = (extra = {}) => ({
  geometry:{type:'image', resourceId:'res-1', pixelSize:[2,3],
    imageToEntity:translate(100,200), ...extra}
});
const draw = (matrix = IDENTITY, opacity = 1) => ({localToSpace:matrix, style:{opacity}});

test('image placement maps pixel corners through imageToEntity and localToSpace', () => {
  const placement = imagePlacement(image(), draw(translate(10,20)));
  assert.equal(placement.resourceId, 'res-1');
  assert.deepEqual(placement.pixelSize, [2,3]);
  assert.deepEqual(placement.corners, [[110,220],[112,220],[112,223],[110,223]]);
  assert.deepEqual(placement.bbox, {minX:110,minY:220,maxX:112,maxY:223});
});

test('raster records carry opacity and media diagnostics without decoding', () => {
  const record = rasterRecord(image(), draw(IDENTITY, 0.4),
    {status:'ready', sourceKind:'IMAGE'});
  assert.equal(record.opacity, 0.4);
  assert.equal(record.mediaStatus, 'ready');
  assert.equal(record.sourceKind, 'IMAGE');
  assert.equal(record.w, 2); assert.equal(record.h, 3);
  assert.deepEqual(record.bbox, {minX:100,minY:200,maxX:102,maxY:203});
});

test('invalid images and missing media are explicit nulls', () => {
  assert.equal(imagePlacement(image({pixelSize:[0,3]}), draw()), null);
  assert.equal(imagePlacement(image({imageToEntity:[1,0,0]}), draw()), null);
  assert.equal(imagePlacement({geometry:{type:'line'}}, draw()), null);
  assert.equal(rasterRecord(image({pixelSize:[-1,3]}), draw()), null);
  assert.equal(mediaItemFor({extensions:{}}, 'x'), null);
  const doc = {extensions:{'org.cad-preview.dxf-media/1':{items:{x:{status:'missing'}}}}};
  assert.equal(mediaItemFor(doc, 'x').status, 'missing');
});
