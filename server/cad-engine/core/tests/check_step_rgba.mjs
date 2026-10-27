// Check native STEP transparency at the actual default renderer boundary.
// node --experimental-loader ./tests/three-loader.mjs tests/check_step_rgba.mjs <envelope.json>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {directProjection} from '../../../../frontend/public/cad-viewer/core/direct-projection.js';
const envelope=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const projection=directProjection(envelope),seen=new Set();let transparent=0;
for(const [id,draw] of Object.entries(envelope.snapshot.draws)){
  const source=envelope.document.materials[draw.materialId];
  if(source.alphaMode!=='blend')continue;
  transparent++;
  const mesh=projection.drawObjects.get(id);
  assert.equal(mesh.material.opacity,source.baseColor[3]);
  assert.equal(mesh.material.transparent,true);assert.equal(mesh.material.depthWrite,false);
  assert.equal(mesh.userData.logicalDraws.length,1);assert.ok(!seen.has(mesh));seen.add(mesh);
  const box=new THREE.Box3(),point=new THREE.Vector3(),geo=mesh.geometry;
  for(let i=geo.drawRange.start;i<geo.drawRange.start+geo.drawRange.count;i++){
    point.fromBufferAttribute(geo.attributes.position,geo.index.getX(i));box.expandByPoint(point);
  }
  assert.ok(box.equals(geo.boundingBox));
  assert.ok(box.getCenter(new THREE.Vector3()).distanceTo(geo.boundingSphere.center)<1e-9);
  projection.session.setShown(draw.occurrenceId,false);projection.sync();assert.equal(mesh.visible,false);
  projection.session.setShown(draw.occurrenceId,true);projection.sync();assert.equal(mesh.visible,true);
}
assert.ok(transparent>0,'expected source transparency');
console.log(JSON.stringify({transparentDraws:transparent,opacityPreserved:true,independentSortingBounds:true,visibility:true}));
