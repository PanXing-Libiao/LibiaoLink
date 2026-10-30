// Phase B clipping slice: one retained source draw, two array copies, a block
// clip and a non-commutative placement. Both projections must produce the same
// identity, order, transform and visible-region membership without expanding
// the array into two source leaves.
import assert from 'node:assert/strict';
import {projectDrawing, identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
import {projectInstances, estimateDrawingDraws, multiply, transformPoint, inverse2D, I} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {compileClips} from '../../../../frontend/public/cad-viewer/core/drawing-clipping.js';

const style = {color:{mode:'explicit', rgba:[0,0,0,1]}, plot:true};
const affine = (a,b,c,d,e,f) => [a,b,0,0, c,d,0,0, 0,0,1,0, e,f,0,1];
const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const closeMatrix = (a,b) => a.length===b.length && a.every((value,index)=>close(value,b[index]));
const closePoint = (a,b) => close(a[0],b[0]) && close(a[1],b[1]);

function document(){
  const clip = [[0,0],[10,0],[10,10],[0,10]];
  const space = (id, entityIds=[], blockInstanceIds=[]) =>
    ({id, drawingId:'d', entityIds, annotationIds:[], blockInstanceIds});
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{
      blockClips:{bi:{boundary:clip, inverted:false}}
    }},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{
        root:space('root', [], ['bi']),
        block:space('block', ['e1'])
      },
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:I, geometry:{type:'line'},
        style, sourceRefs:[{recordOffset:0}]}},
      annotations:{}, layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', ownerSpaceId:'root', definitionId:'B', layerId:'l0',
        // 90 degrees + non-uniform scale (2, 0.5) + translation; not commutable.
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
  const out = {};
  let order = 0;
  function visit(node, parentMatrix, parentPath){
    const matrix = multiply(parentMatrix, node.matrix);
    const path = parentPath.concat(node.path);
    for(const entry of node.group.entries){
      if(entry.kind==='group'){visit(entry, matrix, path); continue;}
      const draw = {...entry.draw, blockPath:path,
        localToSpace:multiply(matrix, entry.draw.localToSpace), drawOrder:order++};
      if(entry.draw.clipRegions) draw.clipRegions = entry.draw.clipRegions.map(clip=>({
        ...clip, boundary:clip.boundary.map(point=>transformPoint(matrix,...point))}));
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
  'array copies share one retained source draw');
assert.equal(Object.keys(normal.draws).length, 2, 'ordinary projection expands both copies');

const keys = Object.keys(normal.draws).sort();
assert.deepEqual(Object.keys(flattened).sort(), keys);
for(const key of keys){
  const expected = normal.draws[key], actual = flattened[key];
  assert.equal(actual.kind, expected.kind);
  assert.equal(actual.itemId, expected.itemId);
  assert.equal(actual.blockPath.length, expected.blockPath.length);
  assert.equal(actual.drawOrder, expected.drawOrder);
  assert.ok(closeMatrix(actual.localToSpace, expected.localToSpace));
  assert.equal(actual.clipRegions?.length, expected.clipRegions?.length);
  for(let index=0; index<expected.clipRegions.length; index++){
    const a = expected.clipRegions[index], b = actual.clipRegions[index];
    assert.equal(b.inverted, a.inverted);
    assert.equal(b.boundary.length, a.boundary.length);
    for(let point=0; point<a.boundary.length; point++)
      assert.ok(closePoint(b.boundary[point], a.boundary[point]));
  }
  const region = compileClips(expected.clipRegions);
  const actualRegion = compileClips(actual.clipRegions);
  const inside = transformPoint(actual.localToSpace, 5, 5);
  assert.equal(region.contains(...inside), true);
  assert.equal(actualRegion.contains(...inside), true);
  assert.equal(region.contains(1000, 1000), false);
  assert.equal(actualRegion.contains(1000, 1000), false);
}

const matrix = doc.drawing.blockInstances.bi.localFromBlock;
const inverse = inverse2D(matrix);
assert.ok(inverse);
const roundTrip = transformPoint(inverse, ...transformPoint(matrix, 3, 4));
assert.ok(closePoint(roundTrip, [3,4]));
console.log('PASS: retained clipping slice keeps identity, order, transform and visible membership for both array copies.');
