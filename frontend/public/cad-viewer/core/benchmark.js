import * as THREE from 'three';
import {fromUnified} from './unified-viewer.js';
import {batchProjection} from './render-batches.js';
import {hydrateBinary} from './binary-transport.js';
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(800,500);document.querySelector('#view').append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#edf1f5');scene.add(new THREE.HemisphereLight(0xffffff,0x606060,2));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(10,-10,20);scene.add(light);
const camera=new THREE.PerspectiveCamera(45,1.6,.01,10000),out=document.querySelector('#results');let controller;
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const memory=()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,scope:'Chromium estimate; not process RSS'}:null;
function dispose(root){const gs=new Set(),ms=new Set();const collect=m=>{if(m.geometry)gs.add(m.geometry);if(m.material)ms.add(m.material);};root.traverse(collect);(root.userData.detachedDrawObjects||[]).forEach(collect);gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());scene.remove(root);renderer.renderLists.dispose();}
document.querySelector('#cancel').onclick=()=>controller?.abort();
document.querySelector('#run').onclick=async()=>{
 const file=document.querySelector('#file').files[0];if(!file)return;const reports=[];document.querySelector('#run').disabled=true;controller=new AbortController();
 try{
  for(const transport of ['base64','binary'])for(const batch of [false,true]){
   out.textContent=JSON.stringify({running:{transport,batch},reports},null,2);const before=memory(),start=performance.now();
   const response=await fetch('/api/parse?model=ucd&transport='+transport+'&name='+encodeURIComponent(file.name),{method:'POST',body:file,signal:controller.signal});const text=await response.text();const received=performance.now();let e=JSON.parse(text);if(!response.ok)throw new Error(e.error);
   const manifestParsed=performance.now();if(transport==='binary')e=await hydrateBinary(e,{signal:controller.signal});const loaded=performance.now();
   const p=batch?batchProjection(fromUnified(e),e):fromUnified(e);const projected=performance.now();scene.add(p.root);p.root.updateMatrixWorld(true);
   const box=new THREE.Box3().setFromObject(p.root),center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length()/2,dist=radius*3;
   camera.near=Math.max(radius/10000,.0001);camera.far=radius*100;camera.updateProjectionMatrix();camera.position.copy(center).add(new THREE.Vector3(dist,-dist,dist));camera.lookAt(center);
   renderer.render(scene,camera);const firstRendered=performance.now(),calls=renderer.info.render.calls,triangles=renderer.info.render.triangles;
   const stamps=[];for(let i=0;i<60;i++){stamps.push(await frame());camera.position.set(center.x+dist*Math.cos(i*.03),center.y+dist*Math.sin(i*.03),center.z+dist*.7);camera.lookAt(center);renderer.render(scene,camera);}
   const target=Object.values(e.document.productOccurrences).find(x=>e.document.products[x.definitionId].kind==='part');const interaction=[];
   for(let i=0;i<10;i++){const t=performance.now();if(target)p.session.setProductShown(target.id,i%2===1);else p.session.setShown(e.snapshot.sceneRoots[0],i%2===1);p.sync();renderer.render(scene,camera);await frame();interaction.push(performance.now()-t);}
   reports.push({file:file.name,sha256:e.document.sources[0].sha256,transport,batch,parser:e.document.adapter.dependencies,workerStages:e.presentation.stats,jsonBytes:new TextEncoder().encode(text).length,binaryBytes:transport==='binary'?Object.values(e.document.buffers).reduce((n,b)=>n+b.byteLength,0):0,requestToTextMs:received-start,jsonParseMs:manifestParsed-received,resourceLoadAndHashMs:loaded-manifestParsed,projectionMs:projected-loaded,firstRenderMs:firstRendered-projected,totalToFirstRenderMs:firstRendered-start,drawCalls:calls,triangles,activeOrbitFPS:59000/(stamps[59]-stamps[0]),interactionMs:interaction,memoryBefore:before,memoryAfter:memory(),memoryUnavailableReason:performance.memory?null:'performance.memory unavailable in this browser',userAgent:navigator.userAgent});
   dispose(p.root);e=null;await frame();
  }
  out.textContent=JSON.stringify({complete:true,reports},null,2);
 }catch(error){out.textContent=JSON.stringify({complete:false,error:String(error),reports},null,2);}finally{document.querySelector('#run').disabled=false;}
};
