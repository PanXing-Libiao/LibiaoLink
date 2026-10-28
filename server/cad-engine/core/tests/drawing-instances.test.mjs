import test from 'node:test';
import assert from 'node:assert/strict';
import {projectInstances, estimateDrawingDraws, shouldProjectInstances, INSTANCE_DRAW_THRESHOLD} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {drawingClips} from '../../../../frontend/public/cad-viewer/core/drawing-clipping.js';
import {identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';

const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const translate = (x, y) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,0,1];
const paint = (rgba = [0,0,0,1]) => ({color:{mode:'explicit',rgba}, plot:true});
const layer = (id, drawingId) => ({id, drawingId, name:id, visible:true, frozen:false, plot:true,
  defaultStyle:{color:{mode:'explicit',rgba:[0,0,0,1]}}});

function document(){
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{modes:{},entityState:{},annotationStyles:{}}},
    drawing:{
      drawings:{d1:{id:'d1',modelSpaceId:'s1',layerIds:['l0','l1','l2']}},
      spaces:{s1:{id:'s1',drawingId:'d1',entityIds:[],annotationIds:[],blockInstanceIds:[]}},
      entities:{},annotations:{},blockInstances:{},blocks:{},layouts:{},viewports:{},
      layers:{l0:layer('l0','d1'),l1:layer('l1','d1'),l2:layer('l2','d1')},lineTypes:{}
    }
  };
}

function annotation(doc, id = 'a1', text = 'A'){
  doc.drawing.annotations[id] = {id, layerId:'l0', position:[0,0,0], direction:[1,0,0],
    text, kind:'text', semantic:{height:{value:2.5}}, sourceRefs:[{recordOffset:0}]};
  doc.drawing.spaces.s1.annotationIds.push(id);
}

function presentation(doc, id, entry){
  doc.extensions['org.cad-preview.annotation-presentation/1'] = {items:{[id]:entry}};
}

function part(id, role, layerId = 'l1', extra = {}){
  return {id, role, representationId:'rep-'+id, layerId, style:paint(), ancestors:[], ...extra};
}

function entity(id, layerId = 'l0'){
  return {id, layerId, localFromOwner:IDENTITY, geometry:{type:'line'}, style:paint(),
    sourceRefs:[{recordOffset:0}]};
}

function find(plan, itemId){
  return Object.values(plan.projection.draws).find(draw => draw.itemId === itemId);
}

test('instance path is selected only above the registered draw threshold', () => {
  assert.equal(INSTANCE_DRAW_THRESHOLD, 400000);
  const model = {kind:'model', spaceId:'s1'};
  for (const [count, expected] of [[399999,false],[400000,false],[400001,true]])
    assert.equal(shouldProjectInstances(model, count), expected, String(count));
  assert.equal(shouldProjectInstances({kind:'layout', layoutId:'l1'}, 400001), true);
  assert.equal(shouldProjectInstances({kind:'block-preview', blockId:'b1'}, 999999), false);
  assert.equal(shouldProjectInstances(model, 0, true), true);
});

test('a non-invertible clip placement is reported instead of silently unclipped', () => {
  const doc = document();
  doc.drawing.spaces.s1.blockInstanceIds.push('bi1');
  doc.drawing.blocks.b1 = {id:'b1', spaceId:'bs1', drawingId:'d1', name:'B'};
  doc.drawing.spaces.bs1 = {id:'bs1', drawingId:'d1', entityIds:['be1'], annotationIds:[], blockInstanceIds:[]};
  doc.drawing.blockInstances.bi1 = {id:'bi1', ownerSpaceId:'s1', definitionId:'b1', layerId:'l0',
    localFromBlock:[0,0,0,0, 0,0,0,0, 0,0,1,0, 10,20,0,1], style:paint(), sourceRefs:[{recordOffset:0}]};
  doc.drawing.entities.be1 = entity('be1');
  doc.extensions['org.cad-preview.style-inheritance/1'].blockClips = {
    bi1:{boundary:[[0,0],[10,0],[10,10],[0,10]], inverted:false}};
  assert.throws(() => projectInstances(doc, {kind:'model',spaceId:'s1'}),
    /instanced-projection-clip-transform-not-invertible/);
});

test('presentation text and mask parts resolve inside retained groups', () => {
  const doc = document();
  annotation(doc);
  presentation(doc, 'a1', {status:'ready', sourceKind:'TEXT',
    parts:[part('p-text','text','l1'), part('p-mask','mask','l2')]});
  const styles = {};
  const plan = projectInstances(doc, {kind:'model',spaceId:'s1'}, styles);

  assert.equal(plan.count, 1);
  assert.equal(plan.groups.length, 1);
  const draw = find(plan, 'a1');
  assert.ok(draw, 'annotation draw is retained');
  const rows = draw.presentationStyles;
  assert.deepEqual(rows.map(row => [row.id, row.layerId]), [['p-text','l1'],['p-mask','l2']]);
  assert.deepEqual(rows[0].visibilityLayerIds, ['l1','l0']);
  assert.deepEqual(Object.values(styles)[0], rows);
  assert.equal(draw.visibility, 'shown');
  assert.equal(draw.availability, 'ready');
});

test('a block clip follows each array copy while geometry stays retained once', () => {
  const doc = document();
  doc.drawing.spaces.s1.blockInstanceIds.push('bi1');
  doc.drawing.blocks.b1 = {id:'b1', spaceId:'bs1', drawingId:'d1', name:'B'};
  doc.drawing.spaces.bs1 = {id:'bs1', drawingId:'d1', entityIds:['be1'], annotationIds:[], blockInstanceIds:[]};
  doc.drawing.blockInstances.bi1 = {id:'bi1', ownerSpaceId:'s1', definitionId:'b1', layerId:'l0',
    localFromBlock:IDENTITY, style:paint(), sourceRefs:[{recordOffset:0}],
    array:{rows:2, columns:1, rowOffset:[0,5,0], columnOffset:[0,0,0]}};
  doc.drawing.entities.be1 = entity('be1');
  const boundary = [[0,0],[10,0],[10,10],[0,10]];
  doc.extensions['org.cad-preview.style-inheritance/1'].blockClips = {bi1:{boundary, inverted:false}};

  const target = {kind:'model',spaceId:'s1'};
  const plan = projectInstances(doc, target);
  assert.equal(estimateDrawingDraws(doc, target), 2);
  assert.equal(plan.count, 2);

  const root = plan.roots[0];
  assert.equal(root.group.entries.length, 2);
  const [first, second] = root.group.entries;
  assert.equal(first.group, second.group, 'both array copies reuse one retained group');
  assert.deepEqual(first.matrix, translate(0,0));
  assert.deepEqual(second.matrix, translate(0,5));
  assert.equal(first.group.entries.length, 1);

  const draw = find(plan, 'be1');
  assert.deepEqual(draw.clipRegions, [{boundary, inverted:false}]);
  assert.equal(draw.viewportClipLocal, undefined);
});

test('layout viewports convert the paper boundary into retained source space', () => {
  const doc = document();
  doc.drawing.spaces.s1.entityIds.push('m1');
  doc.drawing.entities.m1 = entity('m1');
  doc.drawing.spaces.p1 = {id:'p1', drawingId:'d1', entityIds:['pe1'], annotationIds:[], blockInstanceIds:[]};
  doc.drawing.entities.pe1 = entity('pe1');
  doc.drawing.layouts.lay1 = {id:'lay1', name:'Layout1', drawingId:'d1',
    paperSpaceId:'p1', viewportIds:['vp1']};
  doc.drawing.viewports.vp1 = {id:'vp1', enabled:true, sourceSpaceId:'s1',
    modelToPaper:translate(100,50), annotationScale:2, frozenLayerIds:[],
    clipBoundary:[[100,50],[120,50],[120,70],[100,70]]};

  const target = {kind:'layout',layoutId:'lay1'};
  const plan = projectInstances(doc, target);
  assert.equal(estimateDrawingDraws(doc, target), 2);
  assert.equal(plan.count, 2);
  assert.equal(plan.roots.length, 2, 'viewport and paper space remain separate roots');

  const modelDraw = find(plan, 'm1');
  assert.equal(modelDraw.viewportClipLocal, true);
  assert.deepEqual(modelDraw.clipRegions,
    [{boundary:[[0,0],[20,0],[20,20],[0,20]], inverted:false}]);
  assert.equal(drawingClips(modelDraw, plan.projection.viewports), modelDraw.clipRegions);
  assert.notEqual(modelDraw.clipRegions[0].boundary, doc.drawing.viewports.vp1.clipBoundary);

  const paperDraw = find(plan, 'pe1');
  assert.equal(paperDraw.viewportClipLocal, undefined);
  assert.equal(paperDraw.clipRegions, undefined);
  assert.deepEqual(drawingClips(paperDraw, plan.projection.viewports), []);
});

test('scale variants select the annotation context and honour hidden variants', () => {
  const doc = document();
  annotation(doc);
  const v1 = part('p-v1','text','l1'), v2 = part('p-v2','text','l1');
  presentation(doc, 'a1', {status:'ready', sourceKind:'TEXT', parts:[], defaultScale:1,
    scaleVariants:[{status:'ready', drawingPerPaper:1, parts:[v1]},
                   {status:'ready', drawingPerPaper:2, parts:[v2]}]});
  doc.extensions['org.cad-preview.dxf-annotation-contexts/1'] = {modelDrawingPerPaper:2, allVisible:false};

  const plan = projectInstances(doc, {kind:'model',spaceId:'s1'}, {});
  let draw = find(plan, 'a1');
  assert.deepEqual(draw.presentationStyles.map(row => row.id), ['p-v2']);
  assert.equal(draw.displayRepresentationId,
    identity('representation', ['a1','linetype',['rep-p-v2']]));

  doc.extensions['org.cad-preview.dxf-annotation-contexts/1'].modelDrawingPerPaper = 3;
  const hiddenPlan = projectInstances(doc, {kind:'model',spaceId:'s1'}, {});
  draw = find(hiddenPlan, 'a1');
  assert.equal(draw.visibility, 'hidden');
  assert.deepEqual(draw.presentationStyles.map(row => row.id), ['p-v1'],
    'fallback keeps the source default scale');
});

test('layer, viewport and part opacity combine through the retained projection', () => {
  const doc = document();
  annotation(doc);
  presentation(doc, 'a1', {status:'ready', sourceKind:'TEXT', parts:[
    part('p-layer','text','l1'),
    part('p-own','text','l1', {style:paint(), ancestors:[{id:'anc-1', layerId:'l2', style:paint()}]})
  ]});
  const ext = doc.extensions['org.cad-preview.style-inheritance/1'];
  ext.layerOpacity = {l0:0.5, l1:0.4};
  ext.entityState = {a1:{opacityMode:'explicit',opacity:0.25}, 'p-layer':{opacityMode:'by-layer'}, 'p-own':{opacityMode:'by-layer'}};
  ext.viewportLayerOpacity = {vp1:{l1:0.6}};

  const model = projectInstances(doc, {kind:'model',spaceId:'s1'}, {});
  const draw = find(model, 'a1');
  assert.equal(draw.style.opacity, 0.25);
  assert.deepEqual(draw.presentationStyles.map(row => row.style.opacity), [0.4,0.4]);
  assert.deepEqual(draw.presentationStyles[1].visibilityLayerIds, ['l1','l0','l2']);
});
