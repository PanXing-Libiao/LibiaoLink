// Shared UCD instance planning: reuse the ordinary projection's ownership,
// ordering and style resolver, retaining repeated block geometry once.
// Presentation parts, layout viewports and image/media draws keep the same
// projection contract; only the space-local clip boundary is re-expressed so
// retained geometry can be repainted under each instance matrix.
import {projectDrawing, canonical, identity} from './drawing-projection.js';
export const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function multiply(a,b){const out=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];out[c*4+r]=v;}return out;}
export function transformPoint(m,x,y){return [m[0]*x+m[4]*y+m[12],m[1]*x+m[5]*y+m[13]];}
export function inverse2D(m){const det=m[0]*m[5]-m[1]*m[4];if(Math.abs(det)<1e-20)return null;const a=m[5]/det,b=-m[1]/det,c=-m[4]/det,d=m[0]/det;return [a,b,0,0,c,d,0,0,0,0,1,0,-a*m[12]-c*m[13],-b*m[12]-d*m[13],0,1];}
export function transformBounds(b,m){if(!b)return null;const pts=[[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]].map(p=>transformPoint(m,...p));return {minX:Math.min(...pts.map(p=>p[0])),minY:Math.min(...pts.map(p=>p[1])),maxX:Math.max(...pts.map(p=>p[0])),maxY:Math.max(...pts.map(p=>p[1]))};}
export function union(a,b){if(!b)return a;if(!a)return {...b};return {minX:Math.min(a.minX,b.minX),minY:Math.min(a.minY,b.minY),maxX:Math.max(a.maxX,b.maxX),maxY:Math.max(a.maxY,b.maxY)};}

export const INSTANCE_DRAW_THRESHOLD=400000;
export function shouldProjectInstances(target,count,force=false){
 return (target.kind==='model'||target.kind==='layout')&&(force||count>INSTANCE_DRAW_THRESHOLD);
}

export function estimateDrawingDraws(document,target){
 const m=document.drawing,memo=new Map(),active=new Set(),attached=new Map();
 for(const a of Object.values(m.annotations))if(a.ownerBlockInstanceId)attached.set(a.ownerBlockInstanceId,(attached.get(a.ownerBlockInstanceId)||0)+1);
 function count(id){
  if(memo.has(id))return memo.get(id);if(active.has(id))throw new Error('cyclic-drawing-blocks');active.add(id);
  const s=m.spaces[id];let n=s.entityIds.length+s.annotationIds.filter(id=>!m.annotations[id].ownerBlockInstanceId).length;
  for(const iid of s.blockInstanceIds){const inst=m.blockInstances[iid],a=inst.array;
   const copies=(a&&a.rowOffset.some(v=>v!==0)?a.rows:1)*(a&&a.columnOffset.some(v=>v!==0)?a.columns:1);
   n+=copies*(count(m.blocks[inst.definitionId].spaceId)+(attached.get(iid)||0));
   if(!Number.isSafeInteger(n))throw new Error('drawing-instance-count-overflow');
  }
  active.delete(id);memo.set(id,n);return n;
 }
 if(target.kind==='model')return count(target.spaceId);
 const layout=m.layouts[target.layoutId];return count(layout.paperSpaceId)+layout.viewportIds.reduce((n,id)=>n+(m.viewports[id].enabled?count(m.viewports[id].sourceSpaceId):0),0);
}

export function projectInstances(document,target,presentationStyles=null){
 const ext=document.extensions?.['org.cad-preview.style-inheritance/1']||{};
 const groups=[],cache=new Map(),roots=[],drawGroups=new WeakMap(),layers=new WeakMap(),draws={};let current=null,currentSpace=null;
 const projection=projectDrawing(document,target,null,presentationStyles,{
  space(context,visit){
   const {spaceId,transform,path,viewport,chain,inheritedHidden,clips}=context;
   // Block clips and viewport boundaries arrive in the parent/paper coordinate
   // system; retained draws are space-local, so store the inverse-mapped form.
   const inverse=inverse2D(transform);
   if((clips.length||viewport?.clipBoundary?.length)&&!inverse)
    throw new Error('instanced-projection-clip-transform-not-invertible');
   const localClips=clips.map(clip=>({...clip,
    boundary:inverse?clip.boundary.map(point=>transformPoint(inverse,...point)):clip.boundary}));
   const viewportClip=viewport?.clipBoundary?.length?{boundary:(inverse?viewport.clipBoundary.map(point=>transformPoint(inverse,...point)):viewport.clipBoundary),inverted:false}:null;
   const key=canonical([spaceId,viewport?.id||null,chain.map(([style,layer,id])=>[style,layer,ext.modes?.[id]||{},
    {opacityMode:ext.entityState?.[id]?.opacityMode,opacity:ext.entityState?.[id]?.opacity}]),!!inheritedHidden,
    localClips.length?localClips:null]);
   const parent=current;let group=cache.get(key);
   if(!group){group={id:'group-'+groups.length,spaceId,entries:[],records:[],count:0,bounds:null};cache.set(key,group);groups.push(group);
    current=group;const previousSpace=currentSpace;currentSpace={clips:localClips,viewportClip};visit();currentSpace=previousSpace;current=parent;
    for(const entry of group.entries){entry.order=group.count;group.count+=entry.kind==='group'?entry.group.count:1;}
   }
   const node={kind:'group',group,matrix:transform,path};
   if(parent)parent.entries.push(node);else roots.push(node);
  },
  draw(sourceDrawId,draw,layer){
   const clips=currentSpace?[...currentSpace.clips,...(currentSpace.viewportClip?[currentSpace.viewportClip]:[])]:[];
   if(clips.length)draw.clipRegions=clips;else delete draw.clipRegions;
   if(currentSpace?.viewportClip)draw.viewportClipLocal=true;
   const id=current.id+':'+sourceDrawId;draws[id]=draw;current.entries.push({kind:'draw',id,draw});drawGroups.set(draw,current);layers.set(draw,layer);
  }
 });
 projection.draws=draws;
 const count=roots.reduce((n,node)=>n+node.group.count,0);
 if(count!==estimateDrawingDraws(document,target))throw new Error('instanced-projection-count-mismatch');
 return {projection,groups,roots,drawGroups,layers,count,
  identity(draw,path){return identity('drawing-draw',[projection.drawingId,draw.kind,draw.itemId,path,draw.viewportId||'']);}};
}
