import * as THREE from 'three';
/** Optional projection optimization. Logical draws remain immutable and addressable.
 * Never merges across a scene occurrence, binding, material, or visibility gate.
 * No material groups: each group would still issue a draw call.
 */
export function batchProjection(projection,envelope){
 projection.root.updateMatrixWorld(true);
 const groups=new Map(),cache=new Map(),batches=[];
 for(const [id,mesh] of projection.drawObjects){
  if(mesh.userData.sceneAnchor||!mesh.geometry.index||mesh.material.transparent||mesh.isLineSegments)continue;
  const draw=envelope.snapshot.draws[id];
  const key=JSON.stringify([draw.occurrenceId,draw.bindingId,draw.materialId,draw.visibility,envelope.document.renderOwnership[id]??null]);
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push([id,mesh,draw]);
 }
 for(const members of groups.values()){
  if(members.length<2)continue;
  const first=members[0][1],parent=first.parent;
  if(members.some(([,m])=>m.parent!==parent||!m.matrix.equals(first.matrix)||m.geometry.attributes.position!==first.geometry.attributes.position||m.geometry.index!==first.geometry.index||m.userData.meshDefinition!==first.userData.meshDefinition))continue;
  const key=JSON.stringify(members.map(([,m,draw])=>[m.userData.meshDefinition,draw.primitiveId,m.geometry.drawRange.start,m.geometry.drawRange.count]));
  let geo=cache.get(key);const spans=[];let offset=0;
  const lines=first.isLineSegments;
  for(const [id,m,draw] of members){const count=m.geometry.drawRange.count;spans.push({firstTriangle:offset/3,triangleCount:count/3,firstIndex:offset,indexCount:count,renderItemId:id,primitiveId:draw.primitiveId,bindingId:draw.bindingId,productOccurrenceId:envelope.document.renderOwnership[id],sceneOccurrenceId:draw.occurrenceId});offset+=count;}
  if(!geo){
   geo=new THREE.BufferGeometry();for(const [name,attribute] of Object.entries(first.geometry.attributes))geo.setAttribute(name,attribute);
   const indices=new Uint32Array(offset);let cursor=0;
   for(const [,m] of members){const {start,count}=m.geometry.drawRange;indices.set(m.geometry.index.array.subarray(start,start+count),cursor);cursor+=count;}
   geo.setIndex(new THREE.BufferAttribute(indices,1));geo.setDrawRange(0,offset);geo.computeBoundingSphere();cache.set(key,geo);
  }
  const mesh=new THREE.Mesh(geo,first.material);mesh.matrix.copy(first.matrix);mesh.matrixAutoUpdate=false;mesh.matrixWorldNeedsUpdate=true;mesh.name=first.name+' [batch]';
  mesh.userData={...first.userData,renderItemId:undefined,primitiveSpans:spans};
  for(const [,m] of members){m.userData.renderObject=mesh;parent.remove(m);}parent.add(mesh);batches.push({mesh,members});
 }
 const originalSync=projection.sync;
 projection.sync=()=>{originalSync();for(const {mesh,members} of batches){const visible=members[0][1].visible;if(members.some(([,m])=>m.visible!==visible))throw new Error('Batch visibility gates diverged');mesh.visible=visible;}};
 // Detached logical objects still need world matrices and explicit disposal.
 projection.root.userData.detachedDrawObjects=batches.flatMap(b=>b.members.map(([,m])=>m));
 projection.root.userData.batchCount=batches.length;projection.sync();return projection;
}
export function identityAtHit(hit){
 const spans=hit.object.userData.primitiveSpans;
 if(spans&&hit.object.isLineSegments){
  const offset=hit.index;
  const span=spans.find(s=>offset>=s.firstIndex&&offset<s.firstIndex+s.indexCount);
  if(!span)return null;
  return {renderItemId:span.renderItemId,primitiveId:span.primitiveId,bindingId:span.bindingId,productOccurrenceId:span.productOccurrenceId,sceneOccurrenceId:span.sceneOccurrenceId,lineIndex:offset-span.firstIndex};
 }
 if(!spans)return {renderItemId:hit.object.userData.renderItemId,primitiveId:hit.object.userData.primitiveId,bindingId:hit.object.userData.bindingId,productOccurrenceId:hit.object.userData.productId,sceneOccurrenceId:hit.object.userData.sourceId};
 if(!Number.isInteger(hit.faceIndex))return null;
 return spans.find(s=>hit.faceIndex>=s.firstTriangle&&hit.faceIndex<s.firstTriangle+s.triangleCount)||null;
}
