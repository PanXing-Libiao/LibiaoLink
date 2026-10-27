import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fromUnified} from '../../../../frontend/public/cad-viewer/core/unified-viewer.js';
const [ep,lp,wp,out]=process.argv.slice(2);
const envelope=JSON.parse(fs.readFileSync(ep)),legacy=JSON.parse(fs.readFileSync(lp)),worlds=JSON.parse(fs.readFileSync(wp));
assert.throws(()=>fromUnified({...envelope,snapshot:{...envelope.snapshot,drawingProjection:{}}}),/二维绘制消费者尚未实现/);
const {root,session,sync}=fromUnified(envelope);root.updateWorldMatrix(true,true);
const oldNodes=new Map();function collect(n){oldNodes.set(n.id,n);for(const c of n.children||[])collect(c);}collect(legacy.root);
const objects=new Map(),definitionGeometries=new Map();let geometryCount=0,maximum=0,worst=null;
root.traverse(o=>{
 const id=o.userData.legacyId,old=oldNodes.get(id);assert.ok(old);assert.equal(o.name,old.name);assert.deepEqual(o.matrix.toArray(),old.matrix16??[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],id+' local');objects.set(id,o);
 assert.equal(o.parent?.userData.legacyId??null,[...oldNodes.values()].find(n=>n.children?.some(c=>c.id===id))?.id??null);
 const matrix=worlds[id];o.matrixWorld.toArray().forEach((v,i)=>{const delta=Math.abs(v-matrix[i]);if(delta>maximum){maximum=delta;worst={id,index:i,actual:v,expected:matrix[i],local:o.matrix.toArray(),parent:o.parent?.userData.legacyId,parentWorld:o.parent?.matrixWorld.toArray()};}});
 if(old.mesh){geometryCount++;const mesh=legacy.meshes[old.mesh];const bytes=a=>Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength);
  assert.ok(bytes(o.geometry.attributes.position).equals(Buffer.from(mesh.positions,'base64')));assert.ok(bytes(o.geometry.index).equals(Buffer.from(mesh.indices,'base64')));
  if(mesh.colors)assert.ok(bytes(o.geometry.attributes.color).equals(Buffer.from(mesh.colors,'base64')));
  if(!definitionGeometries.has(old.mesh))definitionGeometries.set(old.mesh,new Set());definitionGeometries.get(old.mesh).add(o.geometry.uuid);
  assert.equal(session.effective(o.userData.sourceId),old.visible!==false);
 }
});
assert.equal(objects.size,oldNodes.size);assert.ok(maximum<1e-10,JSON.stringify({maximum,worst}));assert.ok([...definitionGeometries.values()].every(s=>s.size===1));
assert.equal(new Set([...objects.values()].map(o=>o.uuid)).size,objects.size);
const visibleMeshes=[...objects.values()].filter(o=>o.isMesh&&session.effective(o.userData.sourceId));assert.ok(visibleMeshes.length>1);
const child=visibleMeshes[0],sibling=visibleMeshes[1],rootId=root.userData.sourceId,childId=child.userData.sourceId;
const source=[...session.sourceVisibility];session.setShown(childId,false);sync();session.setShown(rootId,false);sync();session.setShown(rootId,true);sync();
assert.equal(session.effective(childId),false);assert.equal(session.effective(sibling.userData.sourceId),true);assert.deepEqual([...session.sourceVisibility],source);
assert.equal(child.visible,false);assert.equal(root.visible,true);session.reset();sync();assert.equal(session.effective(childId),true);
fs.writeFileSync(out,JSON.stringify({scene_nodes:objects.size,geometry_instances:geometryCount,shared_definitions_preserved:true,maximum_world_delta:maximum,source_state_unchanged:true,child_hidden_preserved:true,scope:'Actual THREE object construction; no WebGL pixels/GPU measurement'}));
