// Phase C media/layout slice: an image on paper space and an image inside a
// clipped viewport. Placement, identity, opacity and viewport clipping must be
// identical between the ordinary and retained layout projections.
import assert from 'node:assert/strict';
import {projectDrawing, identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
import {projectInstances, estimateDrawingDraws, multiply, transformPoint, I} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {layoutViewports} from '../../../../frontend/public/cad-viewer/core/drawing-layout.js';
import {imagePlacement, rasterRecord, mediaItemFor} from '../../../../frontend/public/cad-viewer/core/drawing-media.js';
import {drawingClips} from '../../../../frontend/public/cad-viewer/core/drawing-clipping.js';

const style = {color:{mode:'explicit', rgba:[0,0,0,1]}, plot:true};
const translate = (x, y) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,0,1];
const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const closePoint = (a,b) => close(a[0],b[0]) && close(a[1],b[1]);
const clip = [[100,50],[140,50],[140,90],[100,90]];

function document(){
  const space = id => ({id, drawingId:'d', entityIds:[], annotationIds:[], blockInstanceIds:[]});
  const image = (id, resourceId, offset, opacity) => {
    const entity = {id, layerId:'l0', localFromOwner:I, style:{...style, opacity},
      geometry:{type:'image', resourceId, pixelSize:[4,2], imageToEntity:translate(...offset)},
      sourceRefs:[{recordOffset:0}]};
    return entity;
  };
  const doc = {
    extensions:{'org.cad-preview.style-inheritance/1':{},
      'org.cad-preview.dxf-media/1':{items:{
        'img-paper':{status:'ready', sourceKind:'IMAGE'},
        'img-model':{status:'ready', sourceKind:'IMAGE'}
      }}},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'m1'}},
      spaces:{m1:space('m1'), p1:space('p1')},
      entities:{'img-paper':image('img-paper','res-paper',[10,20],0.7),
        'img-model':image('img-model','res-model',[5,6],1)},
      annotations:{}, blocks:{}, blockInstances:{},
      layers:{l0:{id:'l0', drawingId:'d', name:'L0', visible:true, frozen:false, plot:true,
        defaultStyle:style}},
      layouts:{lay1:{id:'lay1', drawingId:'d', paperSpaceId:'p1', viewportIds:['vp1']}},
      viewports:{vp1:{id:'vp1', enabled:true, sourceSpaceId:'m1', modelToPaper:translate(100,50),
        annotationScale:2, clipBoundary:clip, frozenLayerIds:[]}},
      lineTypes:{}
    }
  };
  doc.drawing.spaces.p1.entityIds.push('img-paper');
  doc.drawing.spaces.m1.entityIds.push('img-model');
  return doc;
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
      if(entry.draw.clipRegions) draw.clipRegions = entry.draw.clipRegions.map(clip => ({
        ...clip, boundary:clip.boundary.map(point => transformPoint(matrix, ...point))}));
      out[identity('drawing-draw',['d',draw.kind,draw.itemId,path,draw.viewportId||''])] = draw;
    }
  }
  for(const root of plan.roots) visit(root, I, []);
  return out;
}

const doc = document();
const target = {kind:'layout', layoutId:'lay1'};
const normal = projectDrawing(doc, target);
const retained = projectInstances(doc, target);
const flattened = flatten(retained);
assert.equal(layoutViewports(doc, 'lay1').length, 1);
assert.equal(estimateDrawingDraws(doc, target), 2);
assert.equal(retained.count, 2);
assert.equal(Object.keys(retained.projection.draws).length, 2);
const keys = Object.keys(normal.draws).sort();
assert.deepEqual(Object.keys(flattened).sort(), keys);

for(const key of keys){
  const expected = normal.draws[key], actual = flattened[key];
  assert.equal(actual.drawOrder, expected.drawOrder);
  const expectedPlacement = imagePlacement(doc.drawing.entities[expected.itemId], expected);
  const actualPlacement = imagePlacement(doc.drawing.entities[actual.itemId], actual);
  assert.equal(actualPlacement.resourceId, expectedPlacement.resourceId);
  assert.deepEqual(actualPlacement.pixelSize, expectedPlacement.pixelSize);
  for(let index=0; index<4; index++) assert.ok(closePoint(actualPlacement.corners[index], expectedPlacement.corners[index]));
  for(const field of ['minX','minY','maxX','maxY']) assert.ok(close(actualPlacement.bbox[field], expectedPlacement.bbox[field]));
  const expectedRecord = rasterRecord(doc.drawing.entities[expected.itemId], expected,
    mediaItemFor(doc, expected.itemId));
  const actualRecord = rasterRecord(doc.drawing.entities[actual.itemId], actual,
    mediaItemFor(doc, actual.itemId));
  assert.equal(actualRecord.opacity, expectedRecord.opacity);
  assert.equal(actualRecord.mediaStatus, expectedRecord.mediaStatus);
  const expectedClips = drawingClips(expected, normal.viewports);
  const actualClips = drawingClips(actual, retained.projection.viewports);
  assert.equal(actualClips.length, expectedClips.length);
  for(let index=0; index<expectedClips.length; index++){
    assert.equal(actualClips[index].inverted, expectedClips[index].inverted);
    assert.equal(actualClips[index].boundary.length, expectedClips[index].boundary.length);
    for(let point=0; point<expectedClips[index].boundary.length; point++)
      assert.ok(closePoint(actualClips[index].boundary[point], expectedClips[index].boundary[point]));
  }
}
console.log('PASS: retained media/layout slice keeps image placement and viewport clipping aligned.');
