import * as THREE from 'three';
import {fromUnified} from './unified-viewer.js';
import {batchProjection,identityAtHit} from './render-batches.js';
import {directProjection} from './direct-projection.js';

/** Independent Viewer engineering benchmark. Synthetic UCD only: this page is
 * not evidence for CAD parsing. Results separate object creation, normals,
 * batching, draw calls, heap and interaction timings. */
const renderer=new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:false});
renderer.setPixelRatio(1);renderer.setSize(1280,800);renderer.setClearColor('#e9eef2');
document.getElementById('view').append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#e9eef2');
scene.add(new THREE.HemisphereLight(0xffffff,0x607080,2.0));
const light=new THREE.DirectionalLight(0xffffff,2.6);light.position.set(3,-4,6);scene.add(light);
const camera=new THREE.PerspectiveCamera(40,1280/800,.01,100000);camera.up.set(0,0,1);
const raycaster=new THREE.Raycaster();
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const heap=()=>performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize,limit:performance.memory.jsHeapSizeLimit}:null;
const gc=()=>{if(window.gc){window.gc();return true;}return false;};
const counter={BufferGeometry:0,Mesh:0,Material:0,computeVertexNormals:0,normalMs:0};
const originalGeometry=THREE.BufferGeometry.prototype.computeVertexNormals;
THREE.BufferGeometry.prototype.computeVertexNormals=function(...args){
  counter.computeVertexNormals++;const t=performance.now();const out=originalGeometry.apply(this,args);counter.normalMs+=performance.now()-t;return out;
};
const meshes=root=>{const out=[];root.traverse(o=>{if(o.isMesh)out.push(o);});return out;};
const effective=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
function dispose(root){
  const gs=new Set(),ms=new Set();const collect=o=>{if(o.geometry)gs.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){ms.add(m);}};
  root.traverse(collect);(root.userData.detachedDrawObjects||[]).forEach(collect);
  gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());
  scene.remove(root);renderer.renderLists.dispose();
}
function load(url){
  return fetch(url,{cache:'no-store'}).then(async response=>{
    if(!response.ok)throw new Error('HTTP '+response.status);
    const text=await response.text();const fetchDone=performance.now();
    const envelope=JSON.parse(text);const parsed=performance.now();
    return {envelope,text,fetchDone,parsed,bytes:text.length};
  });
}
function project(envelope,mode){
  const t=performance.now();
  let projection;
  if(mode==='legacy')projection=fromUnified(envelope);
  else if(mode==='batch')projection=batchProjection(fromUnified(envelope),envelope);
  else if(mode==='direct')projection=directProjection(envelope);
  else if(mode==='direct-nomerge')projection=directProjection(envelope,{mergePrimitives:false});
  else throw new Error('unknown mode '+mode);
  const ms=performance.now()-t;
  return {projection,ms};
}
function frameTiming(frames){
  return new Promise(async resolve=>{
    const times=[];let last=performance.now();
    for(let i=0;i<frames;i++){
      camera.position.set(state.center.x+state.dist*Math.cos(i*.05),state.center.y+state.dist*Math.sin(i*.05),state.center.z+state.dist*.6);
      camera.lookAt(state.center);
      renderer.render(scene,camera);
      const now=performance.now();times.push(now-last);last=now;await frame();
    }
    times.sort((a,b)=>a-b);
    resolve({frames:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],note:'software WebGL (SwiftShader); refresh-rate capped by requestAnimationFrame, not a GPU benchmark'});
  });
}
const state={center:new THREE.Vector3(),dist:10};

function pick(mesh,span,which='first'){
  const geo=mesh.geometry,index=geo.index.array,start=(span.firstTriangle+(which==='last'?span.triangleCount-1:0))*3;
  const position=geo.attributes.position;
  const v=[0,1,2].map(i=>new THREE.Vector3().fromBufferAttribute(position,index[start+i]).applyMatrix4(mesh.matrixWorld));
  const normal=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize();
  if(normal.lengthSq()<.5)return null;
  const center=v[0].clone().add(v[1]).add(v[2]).multiplyScalar(1/3);
  const ray=new THREE.Raycaster(center.clone().addScaledVector(normal,.002),normal.negate());
  const hit=ray.intersectObject(mesh,false)[0];
  return hit?{hit,identity:identityAtHit(hit),center}:null;
}

function spansForProduct(root,pid){
  const out=[];
  for(const mesh of meshes(root)){
    const spans=mesh.userData.primitiveSpans||(mesh.userData.renderItemId?[{firstTriangle:mesh.geometry.drawRange.start/3,triangleCount:mesh.geometry.drawRange.count/3,renderItemId:mesh.userData.renderItemId,primitiveId:mesh.userData.primitiveId,bindingId:mesh.userData.bindingId,productOccurrenceId:mesh.userData.productId,sceneOccurrenceId:mesh.userData.sourceId}]:[]);
    for(const span of spans)if(span.productOccurrenceId===pid)out.push({mesh,span});
  }
  return out;
}

function semantics(projection,envelope,limited){
  const d=envelope.document,s=envelope.snapshot,root=projection.root,session=projection.session,sync=projection.sync;
  const checks={};
  const parts=Object.values(d.productOccurrences).filter(p=>d.products[p.definitionId].kind==='part');
  const byDef=new Map();for(const p of parts){(byDef.get(p.definitionId)||byDef.set(p.definitionId,[]).get(p.definitionId)).push(p);}
  const pair=[...byDef.values()].find(list=>list.length>1);
  const warnings=[];
  if(pair){
    const [a,b]=pair;
    const aMeshes=spansForProduct(root,a.id),bMeshes=spansForProduct(root,b.id);
    const aBefore=aMeshes.map(x=>x.mesh.visible),bVisibleBefore=new Set(bMeshes.filter(x=>x.mesh.visible).map(x=>x.mesh));
    session.setProductShown(a.id,false);sync();renderer.render(scene,camera);
    checks.sharedInstanceIndependence=aMeshes.length>0&&bMeshes.length>0&&aMeshes.every(x=>!x.mesh.visible)&&[...bVisibleBefore].every(m=>m.visible);
    session.setProductShown(a.id,true);sync();renderer.render(scene,camera);
    checks.restoreProduct=aMeshes.every((x,i)=>x.mesh.visible===aBefore[i])&&[...bVisibleBefore].every(m=>m.visible);
    checks.sharedDebug={a:a.id,b:b.id,aCount:aMeshes.length,bCount:bMeshes.length,aVisibleAfter:aMeshes.filter(x=>x.mesh.visible).length,bVisibleAfter:[...bVisibleBefore].filter(m=>m.visible).length,aDef:a.definitionId};
  }else{checks.sharedInstanceIndependence=null;warnings.push('no repeated definition');}
  // Parent/child gate: hide child, hide+show parent, child must stay hidden.
  const child=parts.find(p=>p.parentId)||null;
  if(child){
    session.setProductShown(child.id,false);sync();
    session.setProductShown(child.parentId,false);sync();session.setProductShown(child.parentId,true);sync();
    checks.childHiddenAfterParentRoundTrip=session.productEffective(child.id)===false;
    session.reset();sync();
    checks.resetRestores=session.productEffective(child.id)===true;
  }
  // Scene occurrence gate: hide one scene anchor, peers with the same definition stay visible.
  const sceneLeaf=Object.values(d.sceneOccurrences).find(n=>n.parentId!==null&&n.representationId);
  if(sceneLeaf){
    session.setShown(sceneLeaf.id,false);sync();renderer.render(scene,camera);
    const target=spansForProduct(root,Object.keys(d.productOccurrences).find(p=>d.productOccurrences[p].sceneAnchorIds.includes(sceneLeaf.id)));
    checks.sceneGateInstanceOnly=target.length?target.every(x=>!x.mesh.visible):null;
    session.setShown(sceneLeaf.id,true);sync();
  }
  // Logical span identity inside one physical mesh, and selection mapping.
  let spansChecked=0,identityMismatch=0,sampledSpanHits=0,distinctInBatch=null;const mismatchExamples=[];
  for(const mesh of meshes(root)){
    const spans=mesh.userData.primitiveSpans||(mesh.userData.renderItemId?[{firstTriangle:mesh.geometry.drawRange.start/3,triangleCount:mesh.geometry.drawRange.count/3,renderItemId:mesh.userData.renderItemId,primitiveId:mesh.userData.primitiveId,bindingId:mesh.userData.bindingId,productOccurrenceId:mesh.userData.productId,sceneOccurrenceId:mesh.userData.sourceId}]:null);
    if(!spans||!spans.length)continue;
    for(const span of spans){
      const hit=pick(mesh,span);if(!hit)continue;
      spansChecked++;const id=hit.identity;
      // The ray may hit a neighbouring triangle of the same physical mesh; that is not
      // a mapping failure. Identity must exist, belong to this mesh, and agree with the
      // document's draw/ownership records.
      const draw=id&&s.draws[id.renderItemId];
      const coherent=!!id&&spans.some(x=>x.renderItemId===id.renderItemId)&&draw&&draw.occurrenceId===id.sceneOccurrenceId&&draw.primitiveId===id.primitiveId&&d.renderOwnership[id.renderItemId]===id.productOccurrenceId;
      if(!coherent){identityMismatch++;if(mismatchExamples.length<3)mismatchExamples.push({span,id,hasDraw:!!draw});}
      if(id&&id.renderItemId===span.renderItemId)sampledSpanHits++;
    }
    if(mesh.userData.primitiveSpans&&mesh.userData.primitiveSpans.length>1&&distinctInBatch===null){
      const ids=new Set();
      for(const span of mesh.userData.primitiveSpans.slice(0,3)){const hit=pick(mesh,span);if(hit)ids.add(hit.identity?.renderItemId);}
      distinctInBatch=ids.size===Math.min(3,mesh.userData.primitiveSpans.length);
    }
  }
  checks.raycastSamples=spansChecked;checks.raycastIdentityMismatches=identityMismatch;checks.raycastSampledSpanHits=sampledSpanHits;
  checks.raycastIdentityPreserved=spansChecked>0&&identityMismatch===0;if(mismatchExamples.length)checks.mismatchExamples=mismatchExamples;
  checks.samePhysicalBatchLogicalIdentityDistinct=distinctInBatch;
  // Selection semantics: hide one occurrence while the shared definition peers stay visible, then restore.
  const leaf=parts.find(p=>spansForProduct(root,p.id).length);
  if(leaf){
    const before=spansForProduct(root,leaf.id).filter(x=>x.mesh.visible).length;
    session.setProductShown(leaf.id,false);sync();renderer.render(scene,camera);
    const after=spansForProduct(root,leaf.id).filter(x=>x.mesh.visible).length;
    session.setProductShown(leaf.id,true);sync();renderer.render(scene,camera);
    const restored=spansForProduct(root,leaf.id).filter(x=>x.mesh.visible).length;
    checks.hideShowRoundTrip=before>0&&after<before&&restored===before;
    checks.hiddenCount={before,after,restored};
  }
  checks.warnings=warnings;
  return checks;
}

async function interactionTimings(projection,envelope){
  const d=envelope.document,root=projection.root,session=projection.session,sync=projection.sync;
  const parts=Object.values(d.productOccurrences).filter(p=>d.products[p.definitionId].kind==='part').slice(0,10);
  const timings={hideMs:[],showMs:[],isolateMs:[],selectMs:[],renderMs:[]};
  for(const p of parts){
    let t=performance.now();session.setProductShown(p.id,false);sync();renderer.render(scene,camera);timings.hideMs.push(performance.now()-t);
    t=performance.now();session.setProductShown(p.id,true);sync();renderer.render(scene,camera);timings.showMs.push(performance.now()-t);
  }
  const target=parts[0];
  if(target){
    let t=performance.now();session.isolate(parts[0].sceneAnchorIds[0]);sync();renderer.render(scene,camera);timings.isolateMs.push(performance.now()-t);
    t=performance.now();session.showAll();sync();renderer.render(scene,camera);timings.isolateMs.push(performance.now()-t);
  }
  // Raycast selection against visible meshes, aimed at sampled mesh centres.
  const visible=meshes(root).filter(effective);
  for(const mesh of visible.slice(0,20)){
    mesh.geometry.computeBoundingSphere();const world=mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
    const t=performance.now();
    const direction=world.clone().sub(camera.position).normalize();
    raycaster.set(camera.position.clone(),direction);
    const hit=raycaster.intersectObjects(visible,false).find(x=>x.object===mesh);
    if(hit){const id=identityAtHit(hit);timings.selectMs.push(performance.now()-t);if(!id)throw new Error('pick without identity');}
  }
  const stat=a=>a.length?{n:a.length,meanMs:a.reduce((x,y)=>x+y,0)/a.length,maxMs:Math.max(...a)}:null;
  return {hide:stat(timings.hideMs),show:stat(timings.showMs),isolate:stat(timings.isolateMs),select:stat(timings.selectMs)};
}

function buildTree(root,envelope){
  const t0=performance.now();
  // Same shape as app.js: one pre-order pass to collect entries, then DOM rows.
  const entries=[];const visit=(o,depth)=>{let hasMesh=false;const stack=[o];while(stack.length){const x=stack.pop();if(x.isMesh){hasMesh=true;break;}for(const c of x.children)stack.push(c);}if(!hasMesh)return;entries.push({object:o,depth,name:o.name||'node'});for(const child of o.children)visit(child,depth+1);};
  visit(root,0);
  const collectMs=performance.now()-t0;
  const t=performance.now();
  const container=document.createElement('div');const fragment=document.createDocumentFragment();
  for(const entry of entries){const row=document.createElement('div');row.className='row';row.style.paddingLeft=Math.min(entry.depth,6)*12+'px';
    const check=document.createElement('input');check.type='checkbox';const button=document.createElement('button');button.textContent=entry.name;row.append(check,button);fragment.append(row);}
  container.append(fragment);document.body.append(container);
  const nodes=entries.length;
  const ms=performance.now()-t;
  const expand=performance.now();for(const row of container.children)row.getBoundingClientRect();const expandMs=performance.now()-expand;
  container.remove();
  return {treeNodes:nodes,treeCollectMs:collectMs,treeBuildMs:ms,treeLayoutMs:expandMs};
}

window.stress={
  async run(options={}){
    const {url,mode='direct',repeats=1,frames=30,interactions=true,semanticsChecks=true}=options;
    const reports=[];
    for(let repetition=0;repetition<repeats;repetition++){
      gc();const before=heap();const started=performance.now();const counterStart={...counter};
      const report={url,mode,repetition,startedAt:new Date().toISOString(),userAgent:navigator.userAgent};
      let projection=null;
      try{
        const loaded=await load(url);
        const projected=project(loaded.envelope,mode);projection=projected.projection;
        const projectedAt=performance.now();
        scene.add(projection.root);projection.root.updateMatrixWorld(true);
        const box=new THREE.Box3().setFromObject(projection.root);const center=box.getCenter(new THREE.Vector3());const radius=Math.max(box.getSize(new THREE.Vector3()).length()/2,.001);
        const dist=radius*2.6;state.center=center;state.dist=dist;
        camera.near=Math.max(radius/10000,.0001);camera.far=radius*100;camera.updateProjectionMatrix();
        camera.position.copy(center).add(new THREE.Vector3(dist,-dist,dist*.8));camera.lookAt(center);
        const renderStart=performance.now();renderer.render(scene,camera);const firstRenderAt=performance.now();
        const physical=meshes(projection.root);
        const geometries=new Set(),materials=new Set();
        for(const mesh of physical){if(mesh.geometry)geometries.add(mesh.geometry);for(const m of Array.isArray(mesh.material)?mesh.material:[mesh.material])materials.add(m);}
        const logical=Object.keys(loaded.envelope.snapshot.draws).length;
        report.transport={bytes:loaded.bytes,fetchMs:loaded.fetchDone-started,jsonParseMs:loaded.parsed-loaded.fetchDone,parseToFirstObjectMs:projectedAt-loaded.parsed};
        report.fetchMs=loaded.fetchDone-started;report.parseMs=loaded.parsed-loaded.fetchDone;report.projectionMs=projected.ms;
        report.firstRenderMs=firstRenderAt-renderStart;report.totalToFirstRenderMs=firstRenderAt-started;
        report.drawCalls=renderer.info.render.calls;report.triangles=renderer.info.render.triangles;
        report.sceneTriangles=physical.reduce((n,m)=>n+(Number.isFinite(m.geometry.drawRange.count)?m.geometry.drawRange.count/3:0),0);
        const visible=physical.filter(effective);
        report.visibleMeshes=visible.length;
        report.visibleTriangles=visible.reduce((n,m)=>n+m.geometry.drawRange.count/3,0);
        report.hiddenTriangles=report.sceneTriangles-report.visibleTriangles;
        report.camera={position:camera.position.toArray().map(v=>+v.toFixed(3)),distance:+camera.position.length().toFixed(3)};
        const reasons={occurrence:0,product:0,source:0,group:0};
        const doc=loaded.envelope.document,snap=loaded.envelope.snapshot,sess=projection.session;
        for(const m of physical){
          if(effective(m))continue;
          const span=m.userData.primitiveSpans?.[0];
          if(!span){reasons.group++;continue;}
          const draw=snap.draws[span.renderItemId];
          if(!sess.localShown(draw.occurrenceId))reasons.occurrence++;
          else if(!sess.productEffective(doc.renderOwnership[span.renderItemId]))reasons.product++;
          else if((m.userData.logicalDraws||[]).some(id=>{const x=snap.draws[id];return x.visibility!=='shown'&&!sess.revealSourceHidden&&!sess.revealed.has(x.occurrenceId);}))reasons.source++;
          else reasons.group++;
        }
        report.hiddenReasons=reasons;
        report.logicalDraws=logical;report.physicalMeshes=physical.length;report.bufferGeometries=geometries.size;report.materials=materials.size;
        report.normalsComputed=counter.computeVertexNormals-counterStart.computeVertexNormals;report.normalsMs=counter.normalMs-counterStart.normalMs;
        report.projectionStats=projection.stats||null;
        report.rendererInfo={renderer:renderer.getContext().getParameter(renderer.getContext().getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL||renderer.getContext().RENDERER),memory:{...renderer.info.memory},programs:renderer.info.programs?.length??null};
        report.sceneNodes=(()=>{let n=0;projection.root.traverse(()=>n++);return n;})();
        report.heap={before,afterProjection:heap(),gcBefore:before?before.used:null};
        report.tree=buildTree(projection.root,loaded.envelope);
        if(semanticsChecks)report.semantics=semantics(projection,loaded.envelope);
        if(interactions)report.interactions=await interactionTimings(projection,loaded.envelope);
        report.frames=await frameTiming(frames);
        report.heap.afterFrames=heap();
        const disposeStart=performance.now();dispose(projection.root);projection=null;
        report.disposeMs=performance.now()-disposeStart;report.heap.afterDispose=heap();report.rendererAfterDispose={...renderer.info.memory};
        report.complete=true;
      }catch(error){
        report.complete=false;report.error=String(error&&error.stack||error);
        if(projection)try{dispose(projection.root);}catch{}
      }
      report.wallMs=performance.now()-started;
      reports.push(report);
    }
    return reports;
  },
  async project(url,mode){
    const loaded=await load(url);const p=project(loaded.envelope,mode);return {mode,stats:p.projection.stats||null,ms:p.ms};
  },
  ready:true
};
document.getElementById('log').textContent='stress harness ready';
