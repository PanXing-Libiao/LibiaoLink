// Phase C text slice: a block-array annotation is laid out once through the
// shared text contract and compared between the ordinary and retained paths.
import assert from 'node:assert/strict';
import {projectDrawing, identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
import {projectInstances, estimateDrawingDraws, multiply, I} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {layoutAnnotationText} from '../../../../frontend/public/cad-viewer/core/drawing-text.js';

const style = {color:{mode:'explicit', rgba:[0,0,0,1]}, plot:true};
const affine = (a,b,c,d,e,f) => [a,b,0,0, c,d,0,0, 0,0,1,0, e,f,0,1];
const measure = text => String(text).length * 50;
const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const closePoint = (a,b) => close(a[0],b[0]) && close(a[1],b[1]);

function document(){
  const space = (id, annotationIds=[], blockInstanceIds=[]) =>
    ({id, drawingId:'d', entityIds:[], annotationIds, blockInstanceIds});
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{}},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['a1'])},
      entities:{},
      annotations:{a1:{id:'a1', layerId:'l0', position:[5,5,0], direction:[1,0,0],
        kind:'text', text:'AB', sourceRefs:[{recordOffset:0}],
        semantic:{height:{value:2.5}, halign:{value:1}, valign:{value:2},
          attachmentPoint:{value:1}, lineSpacing:{value:1}}}},
      layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', ownerSpaceId:'root', definitionId:'B', layerId:'l0',
        localFromBlock:affine(0,0.5,-2,0,10,20), style, sourceRefs:[{recordOffset:0}],
        array:{rows:2, columns:1, rowOffset:[0,7,0], columnOffset:[0,0,0]}}},
      blocks:{B:{id:'B', spaceId:'block', name:'B'}},
      layers:{l0:{id:'l0', drawingId:'d', name:'L0', visible:true, frozen:false, plot:true,
        defaultStyle:style}},
      lineTypes:{}
    }
  };
}

function flatten(plan){
  const out = {}; let order = 0;
  function visit(node, parentMatrix, parentPath){
    const matrix = multiply(parentMatrix, node.matrix);
    const path = parentPath.concat(node.path);
    for(const entry of node.group.entries){
      if(entry.kind==='group'){visit(entry,matrix,path);continue;}
      const draw = {...entry.draw, blockPath:path,
        localToSpace:multiply(matrix,entry.draw.localToSpace), drawOrder:order++};
      out[identity('drawing-draw',['d',draw.kind,draw.itemId,path,''])] = draw;
    }
  }
  for(const root of plan.roots) visit(root, I, []);
  return out;
}

const doc = document();
const target = {kind:'model', spaceId:'root'};
const normal = projectDrawing(doc, target);
const retained = projectInstances(doc, target);
const flattened = flatten(retained);

assert.equal(estimateDrawingDraws(doc, target), 2);
assert.equal(retained.count, 2);
assert.equal(Object.keys(retained.projection.draws).length, 1,
  'both array copies share one retained annotation draw');
assert.equal(Object.keys(normal.draws).length, 2, 'ordinary projection expands both copies');
const keys = Object.keys(normal.draws).sort();
assert.deepEqual(Object.keys(flattened).sort(), keys);

const annotation = doc.drawing.annotations.a1;
for(const key of keys){
  const expected = normal.draws[key], actual = flattened[key];
  assert.equal(actual.drawOrder, expected.drawOrder);
  const a = layoutAnnotationText(annotation, expected, {measure});
  const b = layoutAnnotationText(annotation, actual, {measure});
  assert.ok(closePoint(a.anchor, b.anchor));
  assert.ok(close(a.run.angle, b.run.angle));
  assert.ok(close(a.run.size, b.run.size));
  assert.ok(close(a.run.width, b.run.width));
  assert.ok(close(a.run.height, b.run.height));
  assert.deepEqual(a.run.offsets, b.run.offsets);
  for(const field of ['minX','minY','maxX','maxY']) assert.ok(close(a.run.box[field], b.run.box[field]));
  assert.deepEqual(a.run.approximations, b.run.approximations);
}
console.log('PASS: retained text slice consumes the same layout contract for both array copies.');
