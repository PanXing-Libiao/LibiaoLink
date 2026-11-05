// Shared UCD instance planning: reuse the ordinary projection's ownership,
// ordering and style resolver, retaining repeated block geometry once.
// Presentation parts, layout viewports and image/media draws keep the same
// projection contract; only the space-local clip boundary is re-expressed so
// retained geometry can be repainted under each instance matrix.
import {projectDrawing, canonical, identity, drawingDrawIdentity} from './drawing-projection.js';
import {layoutSpacePlan} from './drawing-layout.js';
export const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export const LOD_MIN_SCREEN_PX=0.75;
export const LOD_BINS_PER_OCTAVE=8;
export const LOD_BIN_RATIO=2**(1/LOD_BINS_PER_OCTAVE);
// Paint batches retain a lower bound of their local size. A bin is culled only
// when its entire [lower, upper) interval is below the screen threshold, so a
// record just above the threshold is never hidden by quantization.
export function quantizeLodSize(value){
 if(!(value>0)||!Number.isFinite(value))return 0;
 const step=Math.floor(Math.log2(value)*LOD_BINS_PER_OCTAVE);
 return 2**(step/LOD_BINS_PER_OCTAVE);
}
export function isLodCulled(lodSize,localScale,minScreenPx=LOD_MIN_SCREEN_PX){
 const cutoff=minScreenPx/Math.max(localScale,1e-15);
 return lodSize>0&&lodSize*LOD_BIN_RATIO<=cutoff;
}
export function multiply(a,b){const out=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];out[c*4+r]=v;}return out;}
export function transformPoint(m,x,y){return [m[0]*x+m[4]*y+m[12],m[1]*x+m[5]*y+m[13]];}
export function inverse2D(m){const det=m[0]*m[5]-m[1]*m[4];if(Math.abs(det)<1e-20)return null;const a=m[5]/det,b=-m[1]/det,c=-m[4]/det,d=m[0]/det;return [a,b,0,0,c,d,0,0,0,0,1,0,-a*m[12]-c*m[13],-b*m[12]-d*m[13],0,1];}
export function transformBounds(b,m){if(!b)return null;const x0=b.minX,y0=b.minY,x1=b.maxX,y1=b.maxY;const ax=m[0]*x0+m[4]*y0+m[12],ay=m[1]*x0+m[5]*y0+m[13];const bx=m[0]*x1+m[4]*y0+m[12],by=m[1]*x1+m[5]*y0+m[13];const cx=m[0]*x1+m[4]*y1+m[12],cy=m[1]*x1+m[5]*y1+m[13];const dx=m[0]*x0+m[4]*y1+m[12],dy=m[1]*x0+m[5]*y1+m[13];return {minX:Math.min(ax,bx,cx,dx),minY:Math.min(ay,by,cy,dy),maxX:Math.max(ax,bx,cx,dx),maxY:Math.max(ay,by,cy,dy)};}
export function union(a,b){if(!b)return a;if(!a)return {...b};return {minX:Math.min(a.minX,b.minX),minY:Math.min(a.minY,b.minY),maxX:Math.max(a.maxX,b.maxX),maxY:Math.max(a.maxY,b.maxY)};}

// DWG headers keep the model-space EXTENTS the source application last saved.
// A valid header box is only a candidate for the default view: the viewer
// additionally checks that it covers most of the visible drawing before using
// it, so stale or never-set header extents fall back to computed geometry.
export function sourceExtentsFromHeader(header){
 const min=header?.modelSpaceExtMin,max=header?.modelSpaceExtMax;
 if(!Array.isArray(min)||!Array.isArray(max)||min.length<2||max.length<2)return null;
 const box={minX:Number(min[0]),minY:Number(min[1]),maxX:Number(max[0]),maxY:Number(max[1])};
 if(!Number.isFinite(box.minX)||!Number.isFinite(box.minY)||!Number.isFinite(box.maxX)||!Number.isFinite(box.maxY))return null;
 if(!(box.maxX>box.minX&&box.maxY>box.minY))return null;
 return box;
}
export function fitExtentsCandidate(source,computed,coverage){
 if(!source||!computed)return null;
 const sw=source.maxX-source.minX,sh=source.maxY-source.minY;
 const cw=computed.maxX-computed.minX,ch=computed.maxY-computed.minY;
 if(!(sw>0&&sh>0)||sw>cw*4||sh>ch*4)return null;
 return coverage>=0.5?source:null;
}

export const INSTANCE_DRAW_THRESHOLD=400000;
// Retained projection keeps one source draw per instance path and no longer
// applies the ordinary 400k expanded-draw budget. A finite ceiling still keeps
// pathological block arrays from freezing the viewer while it builds the plan.
// Measured: a real 2.0M-expanded-draw layout DWG opened in ~24 s with a ~1.1 GB
// JS heap and a 2.8 s fit repaint, so the ceiling leaves that class admitted
// with headroom while still rejecting pathological expansion.
export const INSTANCE_DRAW_LIMIT=3000000;
export function shouldProjectInstances(target,count,force=false){
 return (target.kind==='model'||target.kind==='layout')&&(force||count>INSTANCE_DRAW_THRESHOLD);
}
// Infinite source lines have no finite visible geometry until the current view
// is known. Retained indexing uses a clipped navigation window when one exists
// and paints unbounded lines per frame instead of reading visibleGeometry.
export function recordVisibleBounds(rec){
 if(rec.infinite)return rec.navigationBounds||null;
 return rec.visibleGeometry?.bounds||null;
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
 const plan=layoutSpacePlan(document,target.layoutId);
 if(!plan)throw new Error('layout-missing');
 return count(plan.paperSpaceId)+plan.viewports.reduce((n,viewport)=>n+count(viewport.sourceSpaceId),0);
}

export function projectInstances(document,target,presentationStyles=null){
 const ext=document.extensions?.['org.cad-preview.style-inheritance/1']||{};
 const groups=[],cache=new Map(),groupsByChain=new WeakMap(),roots=[],drawGroups=new WeakMap(),layers=new WeakMap(),draws={};let current=null,currentSpace=null;
 const seenViewports=new WeakSet();
 // drawVariants and plotVariants are keyed by the complete draw id and may differ
 // per array copy, e.g. when a derivative budget ran out. Such spaces keep one
 // group per instance path instead of sharing the first copy's resolved variant
 // with every copy. Plot variants count even while preview is off because the
 // viewer can enable preview without re-projecting.
 const presentationItems=document.extensions?.['org.cad-preview.annotation-presentation/1']?.items||{};
 const pathVariants=new Map(),sensing=new Set();
 function pathVariantItem(itemId){
  const entry=presentationItems[itemId];if(!entry)return false;
  const parts=[...(entry.parts||[]),...(entry.scaleVariants||[]).flatMap(variant=>variant.parts||[])];
  return parts.some(part=>Object.keys(part.drawVariants||{}).length||
   Object.values(part.plotVariants||{}).some(context=>Object.keys(context||{}).length));
 }
 function pathVariantSpace(spaceId){
  if(pathVariants.has(spaceId))return pathVariants.get(spaceId);
  if(sensing.has(spaceId))return true;
  sensing.add(spaceId);
  const m=document.drawing,space=m.spaces[spaceId];
  let value=!!space&&(space.entityIds.some(pathVariantItem)||space.annotationIds.some(pathVariantItem));
  if(!value&&space)for(const id of space.blockInstanceIds){
   const instance=m.blockInstances[id],definition=instance&&m.blocks[instance.definitionId];
   if(definition&&pathVariantSpace(definition.spaceId)){value=true;break;}
  }
  sensing.delete(spaceId);pathVariants.set(spaceId,value);return value;
 }
 const projection=projectDrawing(document,target,null,presentationStyles,{
  space(context,visit){
   const {spaceId,transform,path,viewport,chain,inheritedHidden,clips}=context;
   // Group nodes carry the path relative to their parent group; the visitor's
   // draw ids keep the absolute path so per-instance variants still resolve.
   const parentPath=currentSpace?.path||[];
   // Block clips and viewport boundaries arrive in the parent/paper coordinate
   // system; retained draws are space-local, so store the inverse-mapped form.
   const inverse=inverse2D(transform);
   if((clips.length||viewport?.clipBoundary?.length)&&!inverse)
    throw new Error('instanced-projection-clip-transform-not-invertible');
   const localClips=clips.length?clips.map(clip=>({...clip,
    boundary:inverse?clip.boundary.map(point=>transformPoint(inverse,...point)):clip.boundary})):clips;
   // The paper viewport boundary is introduced once, in its source space, then
   // inherited like a block clip. Re-mapping it at every nested group would clip
   // in the wrong frame; nested spaces only convert the already-local boundary.
   let viewportClip=null;
   if(viewport?.clipBoundary?.length&&!seenViewports.has(viewport)){
    seenViewports.add(viewport);
    viewportClip={boundary:(inverse?viewport.clipBoundary.map(point=>transformPoint(inverse,...point)):viewport.clipBoundary),inverted:false};
   }
   const effective=viewportClip?localClips.concat([viewportClip]):localClips;
   const pathVariant=pathVariantSpace(spaceId);
   const parent=current;
   const canShare=!effective.length&&!pathVariant;
   let byContext=null,contextKey=null,group=null;
   if(canShare){
    byContext=groupsByChain.get(chain);
    if(!byContext){byContext=new Map();groupsByChain.set(chain,byContext);}
    contextKey=spaceId+'|'+(viewport?.id||'')+'|'+(inheritedHidden?1:0);
    group=byContext.get(contextKey)||null;
   }
   if(!group){
    const key=canonical([spaceId,viewport?.id||null,chain.map(([style,layer,id])=>[style,layer,ext.modes?.[id]||{},
     {opacityMode:ext.entityState?.[id]?.opacityMode,opacity:ext.entityState?.[id]?.opacity}]),!!inheritedHidden,
     effective.length?effective:null,pathVariant?path:null]);
    group=cache.get(key)||null;
    if(!group){group={id:'group-'+groups.length,spaceId,entries:[],records:[],count:0,bounds:null};cache.set(key,group);groups.push(group);
     current=group;const previousSpace=currentSpace;currentSpace={clips:effective,viewport:!!viewport,path};visit(effective);currentSpace=previousSpace;current=parent;
     for(const entry of group.entries){entry.order=group.count;group.count+=entry.kind==='group'?entry.group.count:1;}
    }
    if(byContext)byContext.set(contextKey,group);
   }
   const node={kind:'group',group,matrix:transform,path:parentPath.length?path.slice(parentPath.length):path};
   if(parent)parent.entries.push(node);else roots.push(node);
  },
  draw(sourceDrawId,draw,layer){
   // Attached block attributes arrive with their own child clip set (inherited
   // clips plus the block clip). Keep it instead of replacing it with the
   // enclosing group's list.
   if(!draw.clipRegions?.length&&currentSpace?.clips?.length)draw.clipRegions=currentSpace.clips;
   if(currentSpace?.viewport)draw.viewportClipLocal=true;
   const id=current.id+':'+sourceDrawId;draws[id]=draw;current.entries.push({kind:'draw',id,draw});drawGroups.set(draw,current);layers.set(draw,layer);
  }
 });
 projection.draws=draws;
 const count=roots.reduce((n,node)=>n+node.group.count,0);
 if(count!==estimateDrawingDraws(document,target))throw new Error('instanced-projection-count-mismatch');
 return {projection,groups,roots,drawGroups,layers,count,
  identity(draw,path){return identity('drawing-draw',[projection.drawingId,draw.kind,draw.itemId,path,draw.viewportId||'']);},
  localIdentity(draw,path){return drawingDrawIdentity(projection.drawingId,draw.kind,draw.itemId,path,draw.viewportId||'');}};
}
