// Model-level checks for line geometry, per-Draw highlight and shared instances.
// Usage: node --experimental-loader ./tests/three-loader.mjs tests/check_phase_g_viewer.mjs <envelope.json>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fromUnified} from '../../../../frontend/public/cad-viewer/core/unified-viewer.js';
import {directProjection} from '../../../../frontend/public/cad-viewer/core/direct-projection.js';
import {identityAtHit} from '../../../../frontend/public/cad-viewer/core/render-batches.js';
import {createHighlighter,drawsForProduct,drawsForScene} from '../../../../frontend/public/cad-viewer/core/highlight.js';

const e=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const report={source:process.argv[2]};
function colorsOf(root){const out=new Map();root.traverse(o=>{if((o.isMesh||o.isLineSegments)&&o.userData.renderItemId)out.set(o.userData.renderItemId,o.material.color.getHexString());});return out;}
function stats(root){let meshes=0,lines=0,triangles=0,segments=0;root.traverse(o=>{if(o.isMesh)meshes++;if(o.isLineSegments)lines++;if(o.userData.primitiveSpans)for(const s of o.userData.primitiveSpans){if(o.isLineSegments)segments+=s.indexCount/2;else triangles+=s.triangleCount;}});return {meshes,lines,triangles,segments};}

for(const [label,project] of [['legacy',(env)=>fromUnified(env)],['direct',(env)=>directProjection(env)]]){
  const p=project(e);const scene=new THREE.Scene();scene.add(p.root);p.root.updateMatrixWorld(true);
  const drawIds=Object.keys(e.snapshot.draws);
  const shape=stats(p.root);
  const colors=colorsOf(p.root);
  const hi=createHighlighter(scene);
  const first=drawIds[0];
  const one=hi.build([first],p.drawObjects);
  const afterOne=colorsOf(p.root);
  let unchanged=true;for(const [id,value] of colors)if(afterOne.get(id)!==value)unchanged=false;
  assert.ok(one.meshes>=1,'single draw highlight produced no overlay');
  hi.clear();
  assert.equal(hi.stats().meshes,0,'clear left overlays');
  const product=e.document.renderOwnership[first];
  const productDraws=drawsForProduct(e.document,product);
  const productStats=hi.build(productDraws,p.drawObjects);
  assert.ok(productDraws.length===0||productStats.meshes>=1,'product highlight produced no overlay');
  hi.clear();
  const sceneOcc=e.snapshot.draws[first].occurrenceId;
  const sceneDraws=drawsForScene(e.document,e.snapshot,sceneOcc);
  const sceneStats=hi.build(sceneDraws,p.drawObjects);
  assert.ok(sceneDraws.length===0||sceneStats.meshes>=1,'scene highlight produced no overlay');
  hi.clear();
  // identity for line hits uses the absolute index offset.
  let lineIdentity=null;
  if(shape.lines>0){
    let lineMesh=null;let span=null;
    p.root.traverse(o=>{if(lineMesh||!o.isLineSegments||!o.geometry.index)return;const spans=o.userData.primitiveSpans;span=spans&&spans.length?spans[0]:{firstIndex:o.geometry.drawRange.start,indexCount:o.geometry.drawRange.count,renderItemId:o.userData.renderItemId,primitiveId:o.userData.primitiveId};lineMesh=o;});
    const hit={object:lineMesh,index:span.firstIndex};
    const identity=identityAtHit(hit);
    lineIdentity={renderItemId:identity?.renderItemId===span.renderItemId,primitiveId:identity?.primitiveId===span.primitiveId};
    assert.ok(lineIdentity.renderItemId,'line hit identity mismatch');
  }
  // Hide the instance that owns the first draw and check overlay visibility follows.
  const draw=e.snapshot.draws[first];
  hi.build([first],p.drawObjects);
  p.session.setShown(draw.occurrenceId,false);p.sync();hi.syncVisibility();
  const hidden=hi.group.children.every(o=>o.visible===false);
  p.session.setShown(draw.occurrenceId,true);p.sync();hi.syncVisibility();
  const shown=hi.group.children.every(o=>o.visible===true);
  hi.clear();
  report[label]={shape,logicalDraws:drawIds.length,singleDraw:{meshes:one.meshes,triangles:one.triangles,segments:one.segments},materialUntouched:unchanged,product:{draws:productDraws.length,...productStats},scene:{draws:sceneDraws.length,...sceneStats},lineIdentity,overlayFollowsVisibility:{hidden,shown}};
  scene.remove(p.root);
}
console.log(JSON.stringify(report,null,1));
