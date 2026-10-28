// Phase C pattern slice: solid/gradient fills and patterned strokes share one
// contract across the ordinary and retained projections.
import assert from 'node:assert/strict';
import {projectDrawing, identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
import {projectInstances, estimateDrawingDraws, multiply, I} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {hatchFillKind, fillGeometryFor, patternStrokeSegments} from '../../../../frontend/public/cad-viewer/core/drawing-pattern.js';

const style = {color:{mode:'explicit', rgba:[0,0,0,1]}, plot:true};
const affine = (a,b,c,d,e,f) => [a,b,0,0, c,d,0,0, 0,0,1,0, e,f,0,1];
const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const toWorld = draw => point => [
  draw.localToSpace[0]*point[0] + draw.localToSpace[4]*point[1] + draw.localToSpace[12],
  draw.localToSpace[1]*point[0] + draw.localToSpace[5]*point[1] + draw.localToSpace[13]
];
const fillExt = {
  h1:{rings:[[[0,0],[4,0],[4,4],[0,4]]]},
  h3:{rings:[[[0,0],[3,0],[3,3]]], gradient:{name:'LINEAR', frameBounds:[0,0,3,3]}}
};
const representation = {
  topology:'lines', positions:new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,2,0]),
  indices:new Uint32Array([0,1,2,3])
};

function document(){
  const space = (id, entityIds=[], blockInstanceIds=[]) =>
    ({id, drawingId:'d', entityIds, annotationIds:[], blockInstanceIds});
  const entity = (id, patternId, representationId) => ({id, layerId:'l0', localFromOwner:I,
    displayRepresentationId:representationId,
    geometry:{type:'hatch', patternId, boundaryEntityIds:['b1']}, style, sourceRefs:[{recordOffset:0}]});
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{}},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['h1','h2','h3'])},
      entities:{h1:entity('h1', null, 'rep-solid'), h2:entity('h2', 'ANSI31', 'rep-pattern'),
        h3:entity('h3', null, 'rep-gradient')},
      annotations:{}, layouts:{}, viewports:{},
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
assert.equal(estimateDrawingDraws(doc, target), 6);
assert.equal(retained.count, 6);
assert.equal(Object.keys(retained.projection.draws).length, 3);
assert.equal(Object.keys(normal.draws).length, 6);
const keys = Object.keys(normal.draws).sort();
assert.deepEqual(Object.keys(flattened).sort(), keys);

function compareGeometry(a, b) {
  assert.equal(a.kind, b.kind);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  if (a.bbox) for(const field of ['minX','minY','maxX','maxY']) assert.ok(close(a.bbox[field], b.bbox[field]));
  if (a.rings) {
    assert.equal(a.rings.length, b.rings.length);
    a.rings.forEach((ring, index) => ring.forEach((point, at) => {
      assert.ok(close(point[0], b.rings[index][at][0]));
      assert.ok(close(point[1], b.rings[index][at][1]));
    }));
  }
  if (a.triangles) {
    assert.equal(a.triangles.length, b.triangles.length);
    a.triangles.forEach((triangle, index) => triangle.forEach((point, at) => {
      assert.ok(close(point[0], b.triangles[index][at][0]));
      assert.ok(close(point[1], b.triangles[index][at][1]));
    }));
  }
}

for(const key of keys){
  const expected = normal.draws[key], actual = flattened[key];
  assert.equal(actual.drawOrder, expected.drawOrder);
  const entity = doc.drawing.entities[expected.itemId];
  const entry = fillExt[expected.itemId] || null;
  const kind = hatchFillKind(entity, entry);
  if (expected.itemId === 'h2') {
    assert.equal(kind, 'pattern');
    const a = patternStrokeSegments(representation, toWorld(expected));
    const b = patternStrokeSegments(representation, toWorld(actual));
    assert.equal(a.segments.length, b.segments.length);
    for(let i=0; i<a.segments.length; i++) assert.ok(close(a.segments[i], b.segments[i]));
    for(const field of ['minX','minY','maxX','maxY']) assert.ok(close(a.bbox[field], b.bbox[field]));
  } else {
    const a = fillGeometryFor({draw:expected, entity, fillEntry:entry, mode:'display', tolerance:1,
      representationGeometry:()=>null, analyticFor:()=>null, toWorld:toWorld(expected),
      boundaryGeometry:()=>null});
    const b = fillGeometryFor({draw:actual, entity, fillEntry:entry, mode:'display', tolerance:1,
      representationGeometry:()=>null, analyticFor:()=>null, toWorld:toWorld(actual),
      boundaryGeometry:()=>null});
    compareGeometry(a, b);
    assert.equal(Boolean(entry && entry.gradient), Boolean(expected.itemId === 'h3'));
  }
}
console.log('PASS: retained pattern slice keeps solid/gradient fills and patterned strokes aligned.');
