import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMeshes} from '../../../../frontend/public/cad-viewer/core/drawing-mesh-viewer.js';
import {projectDrawing} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const paint={color:{mode:'explicit',rgba:[.2,.4,.8,1]},plot:true};
const inherit={color:{mode:'by-block'},plot:true};
test('mesh-only projection retains nested mirrored placement, colour and visibility without changing 2D sources',()=>{
 const doc={extensions:{'org.cad-preview.annotation-presentation/1':{items:{face:{status:'ready',sourceKind:'3DFACE',parts:[{id:'fill',role:'fill',representationId:'rep',layerId:'zero',style:inherit,ancestors:[]}]}}},
 'org.cad-preview.style-inheritance/1':{layerInheritance:{zero:true},entityState:{},modes:{}}},drawing:{
 drawings:{d:{modelSpaceId:'model'}},spaces:{model:{drawingId:'d',entityIds:['line'],annotationIds:[],blockInstanceIds:['outer']},nested:{drawingId:'d',entityIds:[],annotationIds:[],blockInstanceIds:['inner']},leaf:{drawingId:'d',entityIds:['face'],annotationIds:[],blockInstanceIds:[]}},
 blocks:{b1:{spaceId:'nested'},b2:{spaceId:'leaf'}},blockInstances:{outer:{definitionId:'b1',layerId:'colour',style:paint,localFromBlock:[-2,0,0,0,0,3,0,0,0,0,1,0,10,20,30,1]},inner:{definitionId:'b2',layerId:'zero',style:inherit,localFromBlock:[1,0,0,0,0,1,0,0,0,0,1,0,1,2,3,1]}},
 entities:{face:{layerId:'zero',geometry:{type:'unsupported'},localFromOwner:I,style:inherit},line:{layerId:'zero',geometry:{type:'line'},localFromOwner:I,style:paint}},annotations:{},layouts:{},viewports:{},lineTypes:{},
 layers:Object.fromEntries(['zero','colour'].map(id=>[id,{drawingId:'d',name:id,visible:true,frozen:false,plot:true,defaultStyle:paint}]))}};
 const before=JSON.stringify(doc),allStyles={},all=projectDrawing(doc,{kind:'model',spaceId:'model'},null,allStyles);
 const mesh=projectMeshes(doc,new Set(['face']));
 assert.equal(Object.keys(mesh.projection.draws).length,1);
 const [id,draw]=Object.entries(mesh.projection.draws)[0];
 assert.deepEqual(draw,all.draws[id]);assert.deepEqual(mesh.styles[id],allStyles[id]);
 assert.deepEqual(draw.localToSpace.slice(12,15),[8,26,33]);
 assert.deepEqual(mesh.styles[id][0].style.color,[.2,.4,.8,1]);
 assert.ok(draw.visibilityLayerIds.includes('colour'));assert.equal(JSON.stringify(doc),before);
 doc.drawing.layers.colour.frozen=true;
 assert.equal(Object.values(projectMeshes(doc,new Set(['face'])).projection.draws)[0].visibility,'hidden');
});
