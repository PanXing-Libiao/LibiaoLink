import fs from 'node:fs';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import {fromUnified} from '../../../../frontend/public/cad-viewer/core/unified-viewer.js';
import {batchProjection,identityAtHit} from '../../../../frontend/public/cad-viewer/core/render-batches.js';
import {hydrateBinary} from '../../../../frontend/public/cad-viewer/core/binary-transport.js';
const e=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),a=fromUnified(e),b=batchProjection(fromUnified(e),e);
a.root.updateMatrixWorld(true);b.root.updateMatrixWorld(true);
const original=[...a.drawObjects],physical=[];b.root.traverse(m=>{if(m.isMesh)physical.push(m);});
let triangles=0;
for(const mesh of physical){
 const spans=mesh.userData.primitiveSpans||[{firstTriangle:mesh.geometry.drawRange.start/3,triangleCount:mesh.geometry.drawRange.count/3,renderItemId:mesh.userData.renderItemId}];
 for(const span of spans){
  const old=a.drawObjects.get(span.renderItemId),start=old.geometry.drawRange.start;
  assert.equal(mesh.visible,old.visible);assert.deepEqual(mesh.matrixWorld.elements,old.matrixWorld.elements);assert.deepEqual(mesh.material.color.toArray(),old.material.color.toArray());
  for(let j=0;j<span.triangleCount*3;j++)assert.equal(mesh.geometry.index.array[span.firstTriangle*3+j],old.geometry.index.array[start+j]);
  assert.equal(identityAtHit({object:mesh,faceIndex:span.firstTriangle}).renderItemId,span.renderItemId);assert.equal(identityAtHit({object:mesh,faceIndex:span.firstTriangle}).primitiveId,e.snapshot.draws[span.renderItemId].primitiveId);
  assert.equal(identityAtHit({object:mesh,faceIndex:span.firstTriangle+span.triangleCount-1}).renderItemId,span.renderItemId);triangles+=span.triangleCount;
 }
}
let sharedBatchReuseChecks=0;const shared=new Map();
for(const mesh of physical){
 if(!mesh.userData.primitiveSpans)continue;
 const key=JSON.stringify([mesh.userData.meshDefinition,mesh.userData.primitiveSpans.map(s=>s.primitiveId)]);
 if(shared.has(key)){assert.equal(mesh.geometry,shared.get(key));sharedBatchReuseChecks++;}else shared.set(key,mesh.geometry);
}
let rayChecks=0;
for(const mesh of physical.slice(0,16)){
 const geo=mesh.geometry,first=geo.drawRange.start,position=geo.attributes.position;
 const v=[0,1,2].map(i=>new THREE.Vector3().fromBufferAttribute(position,geo.index.array[first+i]).applyMatrix4(mesh.matrixWorld));
 const normal=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();if(normal.lengthSq()<.5)continue;
 const center=v[0].clone().add(v[1]).add(v[2]).multiplyScalar(1/3),ray=new THREE.Raycaster(center.clone().addScaledVector(normal,.001),normal.negate());
 const hit=ray.intersectObject(mesh,false)[0];assert.ok(hit);const identity=identityAtHit(hit);assert.ok(identity?.renderItemId);assert.ok(a.drawObjects.has(identity.renderItemId));
 const oldHits=ray.intersectObjects([...a.drawObjects.values()],false);assert.ok(oldHits.some(h=>h.object.userData.renderItemId===identity.renderItemId&&h.point.distanceTo(hit.point)<1e-5));rayChecks++;
}
const occurrence=Object.values(e.document.productOccurrences).find(p=>e.document.products[p.definitionId].kind==='part');
if(occurrence){
 b.session.setProductShown(occurrence.id,false);b.sync();
 for(const mesh of physical)if(mesh.userData.productId===occurrence.id)assert.equal(mesh.visible,false);
 if(occurrence.parentId){b.session.setProductShown(occurrence.parentId,false);b.sync();b.session.setProductShown(occurrence.parentId,true);b.sync();assert.equal(b.session.productEffective(occurrence.id),false);}
 const peer=Object.values(e.document.productOccurrences).find(p=>p.id!==occurrence.id&&p.definitionId===occurrence.definitionId);
 if(peer){assert.equal(b.session.productEffective(peer.id),true);for(const mesh of physical)if(mesh.userData.productId===peer.id){const did=mesh.userData.primitiveSpans?.[0].renderItemId||mesh.userData.renderItemId;assert.equal(mesh.visible,a.drawObjects.get(did).visible);}}
 b.session.reset();b.sync();
}
const token='a'.repeat(48),manifest={...e,transportProfile:'ucd-binary-manifest/1',resourceLease:token,bufferResources:{}};delete manifest.bufferPayloads;
for(const [id,def] of Object.entries(e.document.buffers))manifest.bufferResources[id]={url:`/api/resources/${token}/${def.sha256}`,sha256:def.sha256,byteLength:def.byteLength};
let released=0,corrupt=false;
const fetcher=async(url,options)=>{
 if(options?.method==='DELETE'){released++;return new Response('{}');}
 const id=Object.keys(manifest.bufferResources).find(id=>manifest.bufferResources[id].url===url);assert.ok(id);
 const raw=Buffer.from(e.bufferPayloads[id],'base64');if(corrupt)raw[0]^=1;return new Response(raw);
};
const hydrated=await hydrateBinary(manifest,{fetcher});assert.equal(released,1);
for(const [id,raw] of hydrated.decodedBuffers)assert.deepEqual(Buffer.from(raw),Buffer.from(e.bufferPayloads[id],'base64'));
const c=fromUnified(hydrated);assert.equal(c.drawObjects.size,a.drawObjects.size);
corrupt=true;await assert.rejects(hydrateBinary(manifest,{fetcher}),/hash mismatch/);corrupt=false;
const invalid=structuredClone(manifest);invalid.bufferResources[Object.keys(invalid.bufferResources)[0]].url='https://example.com/private';await assert.rejects(hydrateBinary(invalid,{fetcher}),/Invalid resource reference/);
const controller=new AbortController();controller.abort();await assert.rejects(hydrateBinary(manifest,{fetcher,signal:controller.signal}));assert.equal(released,4);
const during=new AbortController();
await assert.rejects(hydrateBinary(manifest,{signal:during.signal,fetcher:async(url,opts)=>{
 if(opts?.method==='DELETE'){released++;return new Response('{}');}
 return new Promise((resolve,reject)=>{opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});during.abort();});
}}));assert.equal(released,5);
console.log(JSON.stringify({sharedBatchReuseChecks,rayChecks,logicalDraws:original.length,physicalMeshes:physical.length,triangles,matrixMaterialIndexAndPickIdentity:true,productVisibilityPreserved:!!occurrence,binaryHashRoundtrip:true,invalidHashReferenceAndCancellationRejected:true}));
