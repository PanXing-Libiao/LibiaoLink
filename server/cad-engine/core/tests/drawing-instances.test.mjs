import test from 'node:test';
import assert from 'node:assert/strict';
import {projectInstances, estimateDrawingDraws, shouldProjectInstances, recordVisibleBounds, multiply, transformPoint, INSTANCE_DRAW_THRESHOLD} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';
import {drawingClips} from '../../../../frontend/public/cad-viewer/core/drawing-clipping.js';
import {projectDrawing, identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';

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

// --- review fixes: nested clip frames, per-instance variants, limits ---

const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const closePoint = (a,b) => close(a[0],b[0]) && close(a[1],b[1]);
const closeMatrix = (a,b) => a.every((value,index)=>close(value,b[index]));
const style = paint();
const space = (id, entityIds=[], blockInstanceIds=[]) =>
  ({id, drawingId:'d', entityIds, annotationIds:[], blockInstanceIds});

function flatten(plan){
  const out = {};
  let order = 0;
  function visit(node, parentMatrix, parentPath){
    const matrix = multiply(parentMatrix, node.matrix);
    const path = parentPath.concat(node.path);
    for(const entry of node.group.entries){
      if(entry.kind === 'group'){ visit(entry, matrix, path); continue; }
      const draw = {...entry.draw, blockPath:path,
        localToSpace:multiply(matrix, entry.draw.localToSpace), drawOrder:order++};
      if(entry.draw.clipRegions) draw.clipRegions = entry.draw.clipRegions.map(clip=>({
        ...clip, boundary:clip.boundary.map(point=>transformPoint(matrix, ...point))}));
      out[identity('drawing-draw',['d',draw.kind,draw.itemId,path,draw.viewportId||''])] = draw;
    }
  }
  for(const root of plan.roots) visit(root, IDENTITY, []);
  return out;
}

function nestedClipDocument(){
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{
      // The clip boundary lives in the instanced block, so this maps to
      // [100,110] in model space once the outer INSERT is applied.
      blockClips:{outer:{boundary:[[0,0],[10,0],[10,10],[0,10]], inverted:false}}
    }},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['outer']), outerSpace:space('outerSpace', [], ['inner']),
        leaf:space('leaf', ['e1'])},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style, sourceRefs:[{recordOffset:0}]}},
      annotations:{}, layouts:{}, viewports:{},
      blockInstances:{
        outer:{id:'outer', definitionId:'A', layerId:'l0', localFromBlock:translate(100,0), style},
        inner:{id:'inner', definitionId:'B', layerId:'l0', localFromBlock:translate(3,0), style}
      },
      blocks:{A:{spaceId:'outerSpace'}, B:{spaceId:'leaf'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      lineTypes:{}
    }
  };
}

test('nested retained groups inherit a block clip in its own local frame', () => {
  const doc = nestedClipDocument();
  const target = {kind:'model', spaceId:'root'};
  const normal = projectDrawing(doc, target);
  const plan = projectInstances(doc, target);
  const flattened = flatten(plan);
  const keys = Object.keys(normal.draws);
  assert.deepEqual(Object.keys(flattened).sort(), keys.sort());
  for(const key of keys){
    const expected = normal.draws[key], actual = flattened[key];
    assert.ok(closeMatrix(actual.localToSpace, expected.localToSpace));
    assert.equal(actual.clipRegions.length, expected.clipRegions.length);
    for(let index=0; index<expected.clipRegions.length; index++){
      const a = expected.clipRegions[index], b = actual.clipRegions[index];
      for(let point=0; point<a.boundary.length; point++)
        assert.ok(closePoint(b.boundary[point], a.boundary[point]));
    }
    // Ordinary clip is [100,110]; the double-mapped retained clip was [200,210].
    assert.ok(close(expected.clipRegions[0].boundary[0][0], 100));
    assert.ok(close(actual.clipRegions[0].boundary[0][0], 100));
  }
});

function nestedViewportDocument(){
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{}},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['outer']), outerSpace:space('outerSpace', ['e1']),
        paper:space('paper')},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style, sourceRefs:[{recordOffset:0}]}},
      annotations:{},
      blockInstances:{outer:{id:'outer', definitionId:'A', layerId:'l0',
        localFromBlock:translate(10,0), style}},
      blocks:{A:{spaceId:'outerSpace'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      layouts:{lay1:{id:'lay1', drawingId:'d', paperSpaceId:'paper', viewportIds:['vp1']}},
      viewports:{vp1:{id:'vp1', enabled:true, sourceSpaceId:'root',
        modelToPaper:translate(50,0), annotationScale:1,
        clipBoundary:[[50,0],[60,0],[60,10],[50,10]], frozenLayerIds:[]}},
      lineTypes:{}
    }
  };
}

test('nested retained groups inherit the paper viewport clip without re-mapping it', () => {
  const doc = nestedViewportDocument();
  const target = {kind:'layout', layoutId:'lay1'};
  const normal = projectDrawing(doc, target);
  const plan = projectInstances(doc, target);
  const flattened = flatten(plan);
  const keys = Object.keys(normal.draws);
  assert.deepEqual(Object.keys(flattened).sort(), keys.sort());
  for(const key of keys){
    const expected = normal.draws[key], actual = flattened[key];
    const expectedClips = drawingClips(expected, normal.viewports);
    const actualClips = drawingClips(actual, plan.projection.viewports);
    assert.equal(actualClips.length, expectedClips.length);
    for(let index=0; index<expectedClips.length; index++)
      for(let point=0; point<expectedClips[index].boundary.length; point++)
        assert.ok(closePoint(actualClips[index].boundary[point], expectedClips[index].boundary[point]));
    assert.equal(actual.viewportClipLocal, true);
  }
});

function variantDocument(){
  const drawId = identity('drawing-draw', ['d','entity','e1',[{instanceId:'bi', row:0, column:0}],'']);
  return {
    extensions:{
      'org.cad-preview.style-inheritance/1':{lineTypePatterns:{special:[0,1,0,-1]}},
      'org.cad-preview.annotation-presentation/1':{items:{
        e1:{status:'ready', sourceKind:'LINE', parts:[{
          id:'p1', layerId:'l0', ancestors:[],
          style:{...style, lineTypeId:'special'},
          patternedStroke:true,
          drawVariants:{[drawId]:{status:'ready', lineTypeId:'special',
            parts:[{representationId:'rep-special', role:'display', fillRule:'nonzero'}]}}
        }]}
      }}
    },
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['e1'])},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style:{...style, lineTypeId:'special'}, sourceRefs:[{recordOffset:0}]}},
      annotations:{}, layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', definitionId:'B', layerId:'l0',
        localFromBlock:translate(10,20), style}},
      blocks:{B:{spaceId:'block'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      lineTypes:{}
    }
  };
}

test('retained groups resolve per-instance draw variants from the instance path', () => {
  const doc = variantDocument();
  const target = {kind:'model', spaceId:'root'};
  const normal = projectDrawing(doc, target);
  const plan = projectInstances(doc, target);
  const expected = Object.values(normal.draws);
  const actual = Object.values(plan.projection.draws);
  assert.equal(expected.length, 1);
  assert.equal(actual.length, 1);
  const selected = identity('representation', ['e1','linetype',['rep-special']]);
  assert.equal(expected[0].displayRepresentationId, selected);
  assert.equal(actual[0].displayRepresentationId, selected,
    'a retained draw must not lose the variant keyed by its full instance path');
  assert.deepEqual(actual[0].presentationStyles[0].presentationParts,
    [{representationId:'rep-special', role:'display', fillRule:'nonzero'}]);
});

function arrayDocument(maxDraws){
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{projectionLimits:{maxDraws}}},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['e1'])},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style, sourceRefs:[{recordOffset:0}]}},
      annotations:{}, layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', definitionId:'B', layerId:'l0',
        localFromBlock:translate(10,20), style,
        array:{rows:3, columns:1, rowOffset:[0,1,0], columnOffset:[0,0,0]}}},
      blocks:{B:{spaceId:'block'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      lineTypes:{}
    }
  };
}

test('a single array above the ordinary draw budget stays on the retained path', () => {
  const doc = arrayDocument(2);
  const target = {kind:'model', spaceId:'root'};
  assert.throws(()=>projectDrawing(doc, target), /drawing-projection-over-limit/);
  assert.equal(estimateDrawingDraws(doc, target), 3);
  const plan = projectInstances(doc, target);
  assert.equal(plan.count, 3);
  assert.equal(Object.keys(plan.projection.draws).length, 1,
    'all array copies share one source draw');
  assert.equal(plan.groups.length, 2, 'root group plus one retained block group');
});

test('retained bounds read infinite lines from their navigation window', () => {
  const navigationBounds = {minX:0, minY:0, maxX:10, maxY:10};
  assert.equal(recordVisibleBounds({infinite:{kind:'xline'}, navigationBounds:null}), null);
  assert.deepEqual(recordVisibleBounds({infinite:{kind:'xline'}, navigationBounds}), navigationBounds);
  assert.deepEqual(recordVisibleBounds({visibleGeometry:{bounds:navigationBounds}}), navigationBounds);
  assert.equal(recordVisibleBounds({}), null);
});

// --- review fixes: attached-attribute clips and per-copy variant state ---

function attributeClipDocument(){
  return {
    extensions:{'org.cad-preview.style-inheritance/1':{
      blockClips:{bi:{boundary:[[0,0],[10,0],[10,10],[0,10]], inverted:false}}
    }},
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['e1'])},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style, sourceRefs:[{recordOffset:0}]}},
      annotations:{att:{id:'att', layerId:'l0', ownerBlockInstanceId:'bi',
        position:[0,0,0], direction:[1,0,0], text:'A', kind:'text',
        semantic:{height:{value:2.5}}, sourceRefs:[{recordOffset:1}]}},
      layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', definitionId:'B', layerId:'l0',
        localFromBlock:translate(100,0), style}},
      blocks:{B:{spaceId:'block'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      lineTypes:{}
    }
  };
}

test('retained block attributes keep their own block clip', () => {
  const doc = attributeClipDocument();
  doc.drawing.spaces.root.annotationIds.push('att');
  const target = {kind:'model', spaceId:'root'};
  const normal = projectDrawing(doc, target);
  const plan = projectInstances(doc, target);
  const expected = Object.values(normal.draws).find(draw => draw.kind === 'annotation');
  const actual = Object.values(plan.projection.draws).find(draw => draw.kind === 'annotation');
  assert.ok(expected && actual, 'attribute draw is projected in both paths');
  assert.equal(actual.clipRegions.length, 1,
    'the enclosing root group must not erase the attribute block clip');
  for(let point=0; point<expected.clipRegions[0].boundary.length; point++)
    assert.ok(closePoint(actual.clipRegions[0].boundary[point], expected.clipRegions[0].boundary[point]));
  assert.ok(close(actual.clipRegions[0].boundary[0][0], 100));
  assert.ok(closeMatrix(actual.localToSpace, expected.localToSpace));
  assert.equal(plan.identity(actual, actual.blockPath),
    identity('drawing-draw', ['d','annotation','att',[{instanceId:'bi',row:0,column:0}],'']));
});

function arrayVariantDocument(){
  const row = index => [{instanceId:'bi', row:index, column:0}];
  const drawId = index => identity('drawing-draw', ['d','entity','e1',row(index),'']);
  return {
    extensions:{
      'org.cad-preview.style-inheritance/1':{lineTypePatterns:{special:[0,1,0,-1]}},
      'org.cad-preview.annotation-presentation/1':{items:{
        e1:{status:'ready', sourceKind:'LINE', parts:[{
          id:'p1', layerId:'l0', ancestors:[],
          style:{...style, lineTypeId:'special'},
          patternedStroke:true,
          drawVariants:{
            [drawId(0)]:{status:'ready', lineTypeId:'special',
              parts:[{representationId:'rep-special', role:'display', fillRule:'nonzero'}]},
            [drawId(1)]:{status:'missing', lineTypeId:'special', parts:[], reason:'test-budget'}
          }
        }]}
      }}
    },
    drawing:{
      drawings:{d:{id:'d', modelSpaceId:'root'}},
      spaces:{root:space('root', [], ['bi']), block:space('block', ['e1'])},
      entities:{e1:{id:'e1', layerId:'l0', localFromOwner:IDENTITY, geometry:{type:'line'},
        style:{...style, lineTypeId:'special'}, sourceRefs:[{recordOffset:0}]}},
      annotations:{}, layouts:{}, viewports:{},
      blockInstances:{bi:{id:'bi', definitionId:'B', layerId:'l0',
        localFromBlock:translate(10,20), style,
        array:{rows:2, columns:1, rowOffset:[0,10,0], columnOffset:[0,0,0]}}},
      blocks:{B:{spaceId:'block'}},
      layers:{l0:{id:'l0', drawingId:'d', visible:true, frozen:false, plot:true, defaultStyle:style}},
      lineTypes:{}
    }
  };
}

test('array copies resolve their own draw variant state', () => {
  const doc = arrayVariantDocument();
  const target = {kind:'model', spaceId:'root'};
  const normal = projectDrawing(doc, target);
  const plan = projectInstances(doc, target);
  const expected = Object.values(normal.draws), actual = Object.values(plan.projection.draws);
  assert.equal(expected.length, 2);
  assert.equal(actual.length, 2,
    'the second copy must not reuse the first copy\'s ready variant');
  assert.deepEqual(actual.map(draw => draw.availability).sort(), ['ready','unsupported']);
  assert.deepEqual(actual.map(draw => draw.availability).sort(),
    expected.map(draw => draw.availability).sort());
  assert.equal(plan.groups.length, 3, 'root group plus one group per array copy');
  const ordinaryKeys = new Set(Object.keys(normal.draws));
  for(const draw of actual)
    assert.ok(ordinaryKeys.has(plan.identity(draw, draw.blockPath)),
      'retained path must reconstruct the source draw id used by plot styles');
});

test('plot variants also split array copies per instance path', () => {
  const row = index => [{instanceId:'bi', row:index, column:0}];
  const drawId = index => identity('drawing-draw', ['d','entity','e1',row(index),'']);
  const doc = arrayVariantDocument();
  delete doc.extensions['org.cad-preview.annotation-presentation/1'].items.e1.parts[0].drawVariants;
  doc.extensions['org.cad-preview.annotation-presentation/1'].items.e1.parts[0].plotVariants = {model:{
    [drawId(0)]:{status:'ready', parts:[{representationId:'plot-0', role:'display', fillRule:'nonzero'}]},
    [drawId(1)]:{status:'ready', parts:[{representationId:'plot-1', role:'display', fillRule:'nonzero'}]}
  }};
  const target = {kind:'model', spaceId:'root'};
  assert.equal(projectInstances(doc, target).groups.length, 3,
    'plot variants can differ per copy, so the projection keeps one group per path');
});
