import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutViewports, layoutSpacePlan} from '../../../../frontend/public/cad-viewer/core/drawing-layout.js';

function document() {
  return {drawing:{
    layouts:{l1:{id:'l1', paperSpaceId:'paper', viewportIds:['v1','v2','missing']}},
    viewports:{
      v1:{id:'v1', enabled:true, sourceSpaceId:'model', modelToPaper:[1,0,0,0,0,1,0,0,0,0,1,0,10,20,0,1]},
      v2:{id:'v2', enabled:false, sourceSpaceId:'model2', modelToPaper:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
    }
  }};
}

test('layout viewports filter disabled and missing ids in source order', () => {
  const doc = document();
  assert.deepEqual(layoutViewports(doc, 'l1').map(viewport => viewport.id), ['v1']);
  assert.deepEqual(layoutViewports(doc, 'none'), []);
  assert.equal(layoutSpacePlan(doc, 'none'), null);
});

test('layout space plan publishes paper space and the same enabled viewports', () => {
  const doc = document();
  const plan = layoutSpacePlan(doc, 'l1');
  assert.equal(plan.layoutId, 'l1');
  assert.equal(plan.paperSpaceId, 'paper');
  assert.deepEqual(plan.viewports.map(viewport => viewport.id), ['v1']);
  assert.equal(plan.viewports[0], doc.drawing.viewports.v1);
});
