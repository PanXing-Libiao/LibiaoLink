import assert from 'node:assert/strict';
import {projectDrawing,identity} from '../../../../frontend/public/cad-viewer/core/drawing-projection.js';
import {projectInstances,estimateDrawingDraws,multiply,I} from '../../../../frontend/public/cad-viewer/core/drawing-instances.js';

const style={color:{mode:'by-block'},plot:true}, explicit={color:{mode:'explicit',rgba:[1,0,0,1]},plot:true};
const move=(x,y)=>{const m=I.slice();m[12]=x;m[13]=y;return m;};
function source(columns=3){
 const space=(id,kind,entityIds=[],blockInstanceIds=[])=>({id,drawingId:'d',kind,entityIds,annotationIds:[],blockInstanceIds});
 return {extensions:{'org.cad-preview.style-inheritance/1':{layerInheritance:{zero:true}}},drawing:{
  drawings:{d:{id:'d',modelSpaceId:'root'}},spaces:{root:space('root','model',['a'],['one','two']),block:space('block','block',['b'],['nested']),leaf:space('leaf','block',['c'])},
  entities:Object.fromEntries(['a','b','c'].map((id,n)=>[id,{id,layerId:'zero',localFromOwner:move(n,0),geometry:{type:'line'},style,sourceRefs:[]}])),annotations:{},
  blockInstances:{one:{id:'one',definitionId:'B',layerId:'red',localFromBlock:move(10,20),style:explicit,array:{rows:2,columns,rowOffset:[0,7,0],columnOffset:[5,0,0]}},
   two:{id:'two',definitionId:'B',layerId:'red',localFromBlock:move(50,20),style:explicit},nested:{id:'nested',definitionId:'C',layerId:'zero',localFromBlock:move(2,3),style}},
  blocks:{B:{spaceId:'block'},C:{spaceId:'leaf'}},layers:{zero:{drawingId:'d',visible:true,frozen:false,defaultStyle:explicit},red:{drawingId:'d',visible:true,frozen:false,defaultStyle:explicit}},layouts:{},viewports:{}}};
}
const target={kind:'model',spaceId:'root'},doc=source(),normal=projectDrawing(doc,target),plan=projectInstances(doc,target),flattened={};
let order=0;
function visit(node,parentMatrix,parentPath){
 const matrix=multiply(parentMatrix,node.matrix),path=parentPath.concat(node.path);
 for(const entry of node.group.entries){
  if(entry.kind==='group')visit(entry,matrix,path);
  else {const draw={...entry.draw,blockPath:path,localToSpace:multiply(matrix,entry.draw.localToSpace),drawOrder:order++};
   flattened[identity('drawing-draw',['d',draw.kind,draw.itemId,path,''])]=draw;}
 }
}
for(const root of plan.roots)visit(root,I,[]);
assert.deepEqual(flattened,normal.draws,'Retained instances preserve source path, transforms, inherited appearance and paint order');
assert.equal(plan.count,Object.keys(normal.draws).length);
const large=source(199999);
assert.equal(estimateDrawingDraws(large,target),799999);
const retained=projectInstances(large,target);
assert.equal(retained.count,799999);
assert.equal(retained.groups.length,3);
assert.equal(Object.keys(retained.projection.draws).length,3);
console.log('PASS: projection parity and 799,999 instance draws retain three unique source leaves.');
