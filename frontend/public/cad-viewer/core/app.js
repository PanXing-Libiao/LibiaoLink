import * as THREE from 'three';
import { OrbitControls } from './vendor/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { STLLoader } from './vendor/loaders/STLLoader.js';
import { OBJLoader } from './vendor/loaders/OBJLoader.js';
import { fromUnified } from './unified-viewer.js';
import {hydrateBinary} from './binary-transport.js';
import {unpackMetadata} from './compact-transport.js?v=step-0.3-packed';
import {convertJob} from './conversion-jobs.js';
import {batchProjection,identityAtHit} from './render-batches.js';
import {createHighlighter,drawsForProduct,drawsForScene} from './highlight.js';
import {directProjection} from './direct-projection.js?v=step-0.2';
import {appendNonMeshableUI,clearNonMeshableUI} from './nonmeshable-ui.js?v=step-combined';
import {appendMeshRepairUI,repairManifest} from './mesh-repair-ui.js?v=step-combined';
import {mountDrawingViewer} from './drawing-viewer.js';
import {fitCameraToBox,updateCameraRange} from './camera-framing.js';
const query=new URLSearchParams(location.search),binaryMode=query.get('transport')==='binary',batchMode=query.get('batch')==='1';
// The unified pipeline is the default entry; ?pipeline=legacy keeps the old EASM bridge for regression.
const unifiedMode=query.get('pipeline')!=='legacy';
// UCD previews default to Direct projection; ?direct=0 is the explicit regression/emergency fallback.
const directMode=unifiedMode?query.get('direct')!=='0':false;
const modelQuery=unifiedMode?'&model=ucd':'';
let viewerSession=null,syncViewer=null,productRows=[],selectedProductId=null;
let currentEnvelope=null,currentDrawObjects=null,selectedDrawId=null,drawingViewer=null;
const $=id=>document.getElementById(id);
let uploadLimits=null;
async function getUploadLimits(){
 if(uploadLimits)return uploadLimits;
 const response=await fetch('/api/limits');if(!response.ok)throw new Error('无法读取服务端文件限制，请重试');
 const limits=await response.json();
 if(!['cad-input-policy/1','cad-input-policy/2'].includes(limits.version)||!Number.isSafeInteger(limits.stepJobInputBytes)||limits.stepJobInputBytes<=0||!Number.isSafeInteger(limits.synchronousInputBytes)||limits.synchronousInputBytes<=0)throw new Error('服务端文件限制无效');
 return uploadLimits=limits;
}
// Existing browser documents may retain the previous HTML during a JS update.
if(!$('cancelLoad')){const button=document.createElement('button');button.id='cancelLoad';button.textContent='取消加载';button.hidden=true;$('open').before(button);}
const scene=new THREE.Scene();scene.background=new THREE.Color('#e9eef2');
const camera=new THREE.PerspectiveCamera(38,1,.01,100000);camera.up.set(0,0,1);
let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true});}catch(e){$('error').hidden=false;$('error').textContent='此环境无法启动 WebGL。请在支持 WebGL 的浏览器打开本机地址。';$('busy').hidden=true;throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#e9eef2');
$('viewport').append(renderer.domElement);renderer.domElement.setAttribute('aria-label','三维模型视图');renderer.domElement.tabIndex=0;
let controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.screenSpacePanning=true;
scene.add(new THREE.HemisphereLight(0xffffff,0x758797,2.2));
const light=new THREE.DirectionalLight(0xffffff,2.4);light.position.set(3,-4,6);scene.add(light);
let groundPicking=false,groundPlane=null;
let sourceUpload=null;
let model=null,entries=[],selected=null,helper=null,meta={},wire=false,loading=false,grid=null,pendingPartialFile=null;
let loadSeq=0,activeLoad=null,loadTiming=null;
function mark(name){if(loadTiming)loadTiming[name]=Math.round((performance.now()-loadTiming.t0)*10)/10;}
const raycaster=new THREE.Raycaster();raycaster.params.Line.threshold=0.5;
const highlighter=createHighlighter(scene);
const drawMap=()=>currentDrawObjects||new Map();
function applyHighlight(){
  if(!highlighter||!currentEnvelope){highlighter&&highlighter.clear();return;}
  try{
    if(selectedDrawId){highlighter.build([selectedDrawId],drawMap(),{dim:dimMode});}
    else if(selectedProductId&&currentEnvelope.document){highlighter.build(drawsForProduct(currentEnvelope.document,selectedProductId),drawMap(),{dim:dimMode});}
    else if(selected&&selected.object?.userData.sourceId&&currentEnvelope.snapshot){highlighter.build(drawsForScene(currentEnvelope.document,currentEnvelope.snapshot,selected.object.userData.sourceId),drawMap(),{dim:dimMode});}
    else highlighter.clear();
    highlighter.syncVisibility();
  }catch(error){highlighter.clear();console.warn('highlight failed',error);}
}
let cameraBounds=null;
let renderCount=0;const render=()=>{updateCameraRange(camera,controls,cameraBounds);renderer.render(scene,camera);renderCount++;};controls.addEventListener('change',render);
function setCameraUp(up){
 if(camera.up.equals(up))return;
 // This pinned OrbitControls captures camera.up in its constructor. Recreate
 // through the public API so source views and user support planes share its axis.
 const target=controls.target.clone(),position=camera.position.clone();
 const {minDistance,maxDistance,enableDamping,screenSpacePanning}=controls;
 controls.removeEventListener('change',render);controls.dispose();camera.up.copy(up);
 controls=new OrbitControls(camera,renderer.domElement);
 Object.assign(controls,{minDistance,maxDistance,enableDamping,screenSpacePanning});
 camera.position.copy(position);controls.target.copy(target);controls.update();
 controls.addEventListener('change',render);
}

new ResizeObserver(()=>{const r=$('viewport').getBoundingClientRect();renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();render();}).observe($('viewport'));
function dispose(root){const gs=new Set(),ms=new Set(),ts=new Set();const collect=o=>{if(o.geometry)gs.add(o.geometry);for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[]){ms.add(m);Object.values(m).forEach(v=>{if(v?.isTexture)ts.add(v);});}};root.traverse(collect);(root.userData.detachedDrawObjects||[]).forEach(collect);gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());ts.forEach(t=>t.dispose());}
function effective(o){for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;}
function meshes(root,visible=false){const out=[];root[visible?'traverseVisible':'traverse'](o=>{if(o.isMesh||o.isLineSegments)out.push(o);});return out;}
// Logical statistics come from the UCD document/snapshot (Draws, scene occurrences,
// product ownership), never from the number of physical meshes that batching produced.
let logicalCache=null,dimMode=false;
function logicalIndex(){
 if(logicalCache)return logicalCache;
 const env=currentEnvelope,out={drawTri:new Map(),byScene:new Map(),children:new Map(),subtree:new Map(),byProduct:new Map(),prodChildren:new Map(),prodSubtree:new Map(),draws:0,triangles:0,instances:0};
 if(!env?.snapshot)return out;
 const bindingsByRepresentation=new Map(Object.entries(env.document.representations||{}).map(([id,r])=>[id,new Map(r.bindings.map(b=>[b.id,b.geometryId]))]));
 const arity={triangles:3,lines:2,points:1};
 for(const [id,draw] of Object.entries(env.snapshot.draws)){
  const occurrence=env.document.sceneOccurrences[draw.occurrenceId],over=env.snapshot.occurrenceOverrides?.[draw.occurrenceId];
  const geo=env.document.geometries[bindingsByRepresentation.get(over?.representationId||occurrence.representationId)?.get(draw.bindingId)];
  const prim=geo&&geo.primitives.find(p=>p.id===draw.primitiveId);
  const count=prim?prim.range.count/(arity[prim.topology]||1):0;
  out.drawTri.set(id,count);out.draws+=1;out.triangles+=count;
  const occ=draw.occurrenceId,row=out.byScene.get(occ)||{draws:0,triangles:0};row.draws+=1;row.triangles+=count;out.byScene.set(occ,row);
  const owner=env.document.renderOwnership?.[id];if(owner){const pr=out.byProduct.get(owner)||{draws:0,triangles:0};pr.draws+=1;pr.triangles+=count;out.byProduct.set(owner,pr);}
 }
 for(const [id,n] of Object.entries(env.document.sceneOccurrences||{})){
  const parent=n.parentId??null;if(!out.children.has(parent))out.children.set(parent,[]);out.children.get(parent).push(id);
 }
 for(const [id,n] of Object.entries(env.document.productOccurrences||{})){
  const parent=n.parentId??null;if(!out.prodChildren.has(parent))out.prodChildren.set(parent,[]);out.prodChildren.get(parent).push(id);
 }
 const sumScene=id=>{const self=out.byScene.get(id)||{draws:0,triangles:0};let draws=self.draws,triangles=self.triangles;for(const c of out.children.get(id)||[]){const r=sumScene(c);draws+=r.draws;triangles+=r.triangles;}const result={draws,triangles};out.subtree.set(id,result);return result;};
 for(const [id,n] of Object.entries(env.document.sceneOccurrences||{}))if((n.parentId??null)===null)sumScene(id);
 const sumProduct=id=>{const self=out.byProduct.get(id)||{draws:0,triangles:0};let draws=self.draws,triangles=self.triangles;for(const c of out.prodChildren.get(id)||[]){const r=sumProduct(c);draws+=r.draws;triangles+=r.triangles;}const result={draws,triangles};out.prodSubtree.set(id,result);return result;};
 for(const [id,n] of Object.entries(env.document.productOccurrences||{}))if((n.parentId??null)===null)sumProduct(id);
 out.instances=out.byScene.size;logicalCache=out;return out;
}
function visibleLogical(){
 const idx=logicalIndex(),env=currentEnvelope,out={draws:0,triangles:0,instances:0,byScene:new Map(),byProduct:new Map(),subtree:new Map(),productSubtree:new Map()};
 if(!env?.snapshot||!viewerSession)return out;
 const seen=new Set();
 for(const [id,draw] of Object.entries(env.snapshot.draws)){
  const owner=env.document.renderOwnership?.[id]??null;
  if(!viewerSession.effective(draw.occurrenceId))continue;
  if(owner&&!viewerSession.productEffective(owner))continue;
  out.draws+=1;out.triangles+=idx.drawTri.get(id)||0;seen.add(draw.occurrenceId);
  out.byScene.set(draw.occurrenceId,(out.byScene.get(draw.occurrenceId)||0)+1);
  if(owner)out.byProduct.set(owner,(out.byProduct.get(owner)||0)+1);
 }
 out.instances=seen.size;
 const walk=(id,memo,childrenMap,counts)=>{let n=counts.get(id)||0;for(const c of childrenMap.get(id)||[])n+=walk(c,memo,childrenMap,counts);memo.set(id,n);return n;};
 for(const [id,n] of Object.entries(env.document.sceneOccurrences||{}))if((n.parentId??null)===null)walk(id,out.subtree,idx.children,out.byScene);
 for(const [id,n] of Object.entries(env.document.productOccurrences||{}))if((n.parentId??null)===null)walk(id,out.productSubtree,idx.prodChildren,out.byProduct);
 return out;
}
function bounds(root,visible=false){root.updateWorldMatrix(true,true);const b=new THREE.Box3();for(const m of meshes(root,visible)){if(!m.geometry.boundingBox)m.geometry.computeBoundingBox();b.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));}return b;}
function fit(root=model,visible=true){if(!root)return;const b=bounds(root,visible);if(b.isEmpty())return;cameraBounds=bounds(model||root).getBoundingSphere(new THREE.Sphere());fitCameraToBox(camera,controls,b,cameraBounds);render();}
function select(entry,productId=null,drawId=null){selected=entry;selectedProductId=productId;selectedDrawId=drawId||null;if(helper){scene.remove(helper);helper.geometry.dispose();helper.material.dispose();helper=null;}if(entry&&!drawId&&!productId&&effective(entry.object)){helper=new THREE.BoxHelper(entry.object,0x1489a4);scene.add(helper);}refresh();applyHighlight();}
function refresh(){if(drawingViewer)return;const all=model?meshes(model):[];const shown=all.filter(effective);const idx=currentEnvelope?.snapshot?logicalIndex():null;const vis=idx?visibleLogical():null;
if(idx){$('stats').textContent=`显示 ${vis.draws.toLocaleString()} / ${idx.draws.toLocaleString()} 个逻辑对象 · ${vis.instances.toLocaleString()} / ${idx.instances.toLocaleString()} 个实例 · ${shown.length.toLocaleString()} / ${all.length.toLocaleString()} 个物理网格`;}
else{const tris=shown.reduce((s,m)=>s+Math.min(m.geometry.drawRange.count,m.geometry.index?m.geometry.index.count:m.geometry.attributes.position.count)/3,0);$('stats').textContent=`显示 ${shown.length.toLocaleString()} / ${all.length.toLocaleString()} 个网格 · ${Math.round(tris).toLocaleString()} 个三角形`;}
$('selected').textContent=selected?selected.name:'尚未选择';['toggle','isolate','focus','dim'].forEach(id=>$(id).disabled=!selected||loading);$('toggle').textContent=selected&&(selectedProductId&&viewerSession?viewerSession.productEffective(selectedProductId):effective(selected.object))?'隐藏选中':viewerSession&&selected?.object.userData.sourceVisible===false?'检查显示选中':'显示选中';if(helper)helper.visible=!!selected&&effective(selected.object);
for(const e of entries){if(!e.row)continue;let total,visible;const sid=idx?e.object.userData.sourceId:null;const sub=sid?idx.subtree.get(sid):null;if(sub&&sub.draws){total=sub.draws;visible=vis.subtree.get(sid)||0;}else{const subset=meshes(e.object);total=subset.length;visible=subset.filter(effective).length;}e.check.checked=total>0&&visible===total;e.check.indeterminate=visible>0&&visible<total;e.row.classList.toggle('off',visible===0);e.row.classList.toggle('active',e===selected);e.button.setAttribute('aria-pressed',String(e===selected));}for(const row of productRows){let total,visible;const sub=idx?idx.prodSubtree.get(row.id):null;if(sub&&sub.draws){total=sub.draws;visible=vis.productSubtree.get(row.id)||0;}else{const subset=meshes(row.object);total=subset.length;visible=subset.filter(effective).length;}row.check.checked=total>0&&visible===total;row.check.indeterminate=visible>0&&visible<total;const active=selected?.object.userData.productId===row.id;row.button.setAttribute('aria-pressed',String(active));row.row.classList.toggle('active',active);}highlighter&&highlighter.syncVisibility();render();}
function makeTree(){const target=$('tree');target.replaceChildren();const q=$('search').value.toLowerCase();for(const e of entries){e.row=null;if(q&&!e.name.toLowerCase().includes(q))continue;const row=document.createElement('div');row.className='row';row.dataset.sceneId=e.object.userData.sourceId||e.id;row.dataset.productId=e.object.userData.productId||'';row.style.paddingLeft=Math.min(e.depth,6)*12+'px';const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','显示 '+e.name);check.addEventListener('change',()=>{if(viewerSession){viewerSession.setShown(e.object.userData.sourceId,check.checked);syncViewer();refresh();return;}e.object.visible=check.checked;if(check.checked){e.object.traverse(o=>o.visible=true);for(let p=e.object.parent;p&&p!==scene;p=p.parent)p.visible=true;}refresh();});const button=document.createElement('button');button.className='node';button.textContent=e.name;button.title=e.name;button.addEventListener('click',()=>select(e));row.append(check,button);target.append(row);Object.assign(e,{row,check,button});}$('nodecount').textContent=`${entries.length} 节点`;refresh();}
function setDrawingChrome(on){
 renderer.domElement.style.display=on?'none':'';
 $('ground').hidden=on;$('clearGround').hidden=on;$('wire').hidden=on;$('dim').hidden=on;$('toggle').hidden=on;$('isolate').hidden=on;
 $('search').hidden=on;const head=document.querySelector('.treehead'),foot=document.querySelector('.treefoot');
 if(head)head.style.display=on?'none':'';if(foot)foot.style.display=on?'none':'';
 if($('tree'))$('tree').style.display=on?'none':'';
 if($('productTree')&&on)$('productTree').style.display='none';
 const panel=$('drawingPanel');if(panel)panel.style.display=on?'':'none';
 const hint=document.querySelector('.hint');if(hint)hint.textContent=on?'拖动平移 · 滚轮缩放 · 单击选中 · Shift 多选 · Esc 取消':'拖动旋转 · 滚轮缩放 · 右键平移 · 单击选中';
}
function installDrawing(envelope,info){
 if(drawingViewer){drawingViewer.destroy();drawingViewer=null;}
 if(model){scene.remove(model);dispose(model);model=null;}
 currentEnvelope=envelope;currentDrawObjects=null;logicalCache=null;entries=[];productRows=[];viewerSession=null;syncViewer=null;meta=info;drawingViewer=null;cameraBounds=null;
 setDrawingChrome(true);
 drawingViewer=mountDrawingViewer(envelope);
 $('filename').textContent=info.name||'DXF 图纸';
 $('quality').textContent=info.quality||'DXF 二维绘制';
 $('quality').classList.toggle('candidate',!!info.candidate);
 $('note').textContent=info.note||'';
 $('source').textContent=info.sourceSHA256?'源文件 SHA-256：'+info.sourceSHA256:'';
 $('unit').textContent=info.unit||'单位依源文件';
 $('reference').hidden=true;
 $('error').hidden=true;$('busy').hidden=true;
 const box=$('completeness');const snap=envelope.snapshot||{};
 clearNonMeshableUI();box.classList.remove('has-omissions','has-repairs');box.setAttribute('role','status');box.removeAttribute('aria-label');
 const ext=(envelope.document.extensions||{});
 const axes=ext['org.cad-preview.drawing-coverage/1']||{};
 const read=axes.sourceRead||{},geom=axes.displayGeometry||{},attrs=axes.engineeringAttributes||{};
 const unsupported=geom.byReason&&geom.byReason.unsupported||{};
 const unsupportedText=Object.entries(unsupported).map(([k,v])=>k+'×'+v).join('、');
 const readLine='源实体读取：'+(read.status||'unknown')+'（'+(read.sourceRecords??'?')+' 条记录）';
 const geomLine='几何显示：'+(geom.status||'unknown')+'（'+(geom.withDisplayGeometry??'?')+' / '+(geom.sourceRecords??'?')+' 条产生绘制项'
   +(geom.withoutDisplayGeometry?('，未显示 '+(geom.withoutDisplayGeometry)+(unsupportedText?'：'+unsupportedText:'')):'')+'）';
 const attrLine='工程属性覆盖：'+(attrs.status||'unknown')+'（尺寸语义未重建、MTEXT 格式保留未渲染、字体替代、图案填充未支持；与几何完整性独立）';
 box.hidden=false;box.classList.toggle('incomplete',(geom.status||snap.completeness)!=='complete');
 box.textContent=readLine+' · '+geomLine+' · '+attrLine+'。';
 mark('sceneTreeReady');mark('installed');mark('viewerInstallEnd');
 window.__drawingInstalled=true;finishModelFrame();
}
function install(root,info,session=null,sync=null,projection=null){
 if(projection?.drawing){installDrawing(projection.drawing,info);return;}
 if(drawingViewer){drawingViewer.destroy();drawingViewer=null;}
 window.__drawingInstalled=false;
 setDrawingChrome(false);
 selectedDrawId=null;dimMode=false;$('dim').setAttribute('aria-pressed','false');if(!meshes(root).length)throw new Error('文件没有可显示的几何对象');for(const m of meshes(root)){const p=m.geometry.attributes.position;if(!p?.count)throw new Error('网格没有顶点');for(let i=0;i<p.array.length;i++)if(!Number.isFinite(p.array[i]))throw new Error('网格含无效坐标');}
select(null);if(model){scene.remove(model);dispose(model);}if(grid){scene.remove(grid);dispose(grid);}currentEnvelope=projection?.envelope||null;currentDrawObjects=projection?.drawObjects||null;logicalCache=null;model=root;meta=info;viewerSession=session;syncViewer=sync;entries=[];wire=false;$('wire').setAttribute('aria-pressed','false');scene.add(model);
const visit=(o,depth,path)=>{if(!meshes(o).length)return;if(info.unified&&!o.userData.sourceId){o.children.forEach((c,i)=>visit(c,depth,path+'.'+i));return;}const e={id:path,name:o.name||'未命名节点 '+path,object:o,depth,initial:o.visible};entries.push(e);o.userData.entry=e;for(let i=0;i<o.children.length;i++){const child=o.children[i];if(info.unified&&child.userData.drawObject&&!child.userData.sceneAnchor){child.userData.entry=e;continue;}visit(child,depth+1,path+'.'+i);}};visit(root,0,'0');
$('tree').setAttribute('data-title',info.unified?'显示场景树':'');if(info.unified){document.querySelector('.treehead strong').textContent='产品与显示场景';document.querySelector('.samples p').textContent='统一模型：EASM 场景与 STEP 产品装配。二维、外部依赖及未映射特性见能力诊断。';$('showAll').textContent='检查全部几何';}else{document.querySelector('.treehead strong').textContent='零件 / 文件节点';document.querySelector('.samples p').textContent='可打开 EASM、GLB、STL、OBJ。每种格式的能力边界见下方说明。';$('showAll').textContent='全部显示';}
groundPicking=false;groundPlane=null;grid=null;$('ground').setAttribute('aria-pressed','false');$('ground').textContent='选底面摆正';$('clearGround').disabled=true;setCameraUp(info.view?.up?new THREE.Vector3(...info.view.up).normalize():new THREE.Vector3(0,0,1));
renderCompleteness(projection?.envelope,info);
$('filename').textContent=info.name;$('quality').textContent=info.quality;$('quality').classList.toggle('candidate',!!info.candidate);$('note').textContent=info.note;$('source').textContent=info.sourceSHA256?'源文件 SHA-256：'+info.sourceSHA256:'';$('unit').textContent=info.unit||'单位依源文件';$('reference').hidden=!info.reference;$('search').value='';if(info.view){camera.position.fromArray(info.view.position);controls.target.fromArray(info.view.target);}else{camera.position.set(1,-1,.8);controls.target.set(0,0,0);}$('viewlabel').textContent='查看方向 · 地面未设置';makeTree();mark('tree');makeProductTree();mark('sceneTreeReady');fit();stateControls();mark('installed');mark('viewerInstallEnd');finishModelFrame();}
function makeProductTree(){
 let panel=$('productTree');if(!panel){panel=document.createElement('section');panel.id='productTree';$('tree').parentNode.insertBefore(panel,$('tree'));}
 panel.replaceChildren();productRows=[];const pm=model?.userData.productModel;if(!pm||!Object.keys(pm.occurrences).length){panel.hidden=true;return;}panel.hidden=false;
 const title=document.createElement('strong');title.textContent='产品实例树';panel.append(title);panel.setAttribute('aria-label','产品实例树');
 const children=new Map(),roots=[];
 for(const p of Object.values(pm.occurrences)){if(p.parentId===null)roots.push(p);else{if(!children.has(p.parentId))children.set(p.parentId,[]);children.get(p.parentId).push(p);}}
 for(const list of children.values())list.sort((a,b)=>a.orderInParent-b.orderInParent);
 const visit=(id,depth)=>{const p=pm.occurrences[id],object=pm.sceneObjects.get(p.sceneAnchorIds[0]);if(!object)return;const row=document.createElement('div');row.className='row';row.dataset.productId=id;row.style.paddingLeft=depth*12+'px';const check=document.createElement('input');check.type='checkbox';const name=pm.products[p.definitionId].name.value||id;check.setAttribute('aria-label','显示产品实例 '+name);check.onchange=()=>{viewerSession.setProductShown(id,check.checked);syncViewer();refresh();};const button=document.createElement('button');button.className='node';button.textContent=name;button.onclick=()=>select(object.userData.entry,id);row.append(check,button);panel.append(row);productRows.push({id,row,button,check,object});for(const c of children.get(id)||[])visit(c.id,depth+1);};
 for(const p of roots)visit(p.id,0);refresh();
}
function unpack(s,Type){const bytes=Uint8Array.from(atob(s),c=>c.charCodeAt(0));return new Type(bytes.buffer);}
function fromPacket(packet,demo=false){const geos=new Map();for(const [id,g] of Object.entries(packet.meshes)){const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(unpack(g.positions,Float32Array),3));geo.setIndex(new THREE.BufferAttribute(unpack(g.indices,Uint32Array),1));if(g.colors)geo.setAttribute('color',new THREE.BufferAttribute(unpack(g.colors,Uint8Array),3,true));geo.computeVertexNormals();geo.computeBoundingSphere();geos.set(id,geo);}
const matColor=new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,metalness:.15,roughness:.65,side:THREE.DoubleSide});const mat=new THREE.MeshStandardMaterial({color:0x83a7b8,metalness:.25,roughness:.48,side:THREE.DoubleSide,flatShading:true});
function build(n){let o;if(n.mesh){const geo=geos.get(n.mesh);if(!geo)throw new Error('缺少网格引用');o=new THREE.Mesh(geo,geo.attributes.color?matColor:mat);}else o=new THREE.Group();o.name=n.name;o.userData.sourceId=n.id;o.userData.sourcePath=n.sourcePath;o.userData.meshDefinition=n.mesh;o.visible=n.visible!==false;if(n.mesh&&n.color){o.material=o.material.clone();o.material.color.fromArray(n.color);}if(n.matrix16){o.matrix.fromArray(n.matrix16);o.matrixAutoUpdate=false;}else if(n.matrix12){const m=n.matrix12;o.matrix.set(m[0],m[1],m[2],m[9],m[3],m[4],m[5],m[10],m[6],m[7],m[8],m[11],0,0,0,1);o.matrixAutoUpdate=false;}for(const c of n.children||[])o.add(build(c));return o;}
let root=build(packet.root);let info={...packet,meshes:undefined,root:undefined,candidate:packet.candidate??(packet.format==='eDrawings'),reference:false};
if(demo){const span=bounds(root).getSize(new THREE.Vector3()).x*1.6;const shared=root;const group=new THREE.Group();group.name='交互演示（人为排布，非原装配）';for(let i=0;i<3;i++){const instance=shared.clone(true);instance.name='同一板件 · 实例 '+(i+1);instance.position.x=i*span;group.add(instance);}root=group;info={name:'重复实例显隐演示',quality:'人为排布 · 仅验证交互',candidate:true,unit:packet.unit,note:'同一份真实 Platte 几何被放置三次，用于检查共享网格的实例能否分别显隐。这不是从原文件解析出的装配。',sourceSHA256:packet.sourceSHA256};}return {root,info};}
async function cancelActive(){
 const current=activeLoad;if(!current)return;
 activeLoad=null;current.controller.abort();
 // The platform loader owns its authenticated cancellation route.
 if(query.get('platform')!=='1'){try{await fetch(current.jobId?'/api/jobs/'+current.jobId+'/cancel':'/api/cancel?requestId='+current.requestId,{method:'POST'});}catch(e){}}
}
$('cancelLoad').onclick=()=>cancelActive();
async function busy(task){
 // A new load cancels the previous worker instead of waiting for it; only the
 // newest token may install a result, so a stale parse cannot replace the model.
 if(loading)await cancelActive();
 const token=++loadSeq;const controller=new AbortController();const requestId=crypto.randomUUID().replace(/-/g,'');const startedAt=performance.now();loadTiming={t0:startedAt,uploadStart:0,traceId:requestId,browserDocumentHadModel:!!(model||drawingViewer)};
 activeLoad={token,controller,requestId};
 loading=true;$('cancelLoad').hidden=false;$('busy').textContent='正在解析文件…';$('busy').hidden=false;$('error').hidden=true;['sample','open','configuration','displayState'].forEach(id=>$(id).disabled=true);refresh();
 try{await task({token,controller,requestId});}
 catch(e){if(token===loadSeq&&!controller.signal.aborted){window.__lastError={message:e.message,stack:e.stack};$('error').textContent=e.message||String(e);$('error').hidden=false;const offer=$('partialOffer');if(e.payload?.partialPreviewAvailable&&pendingPartialFile){offer.hidden=false;offer.querySelector('span').textContent=`严格模式已中止：源几何存在缺失面（${e.payload.details?.entries?.length||'若干'} 处）。可手动改用部分预览；结果会明确标记为不完整。`;}else{offer.hidden=true;}}}
 finally{if(token===loadSeq){loading=false;activeLoad=null;$('cancelLoad').hidden=true;$('busy').hidden=true;['sample','open','configuration','displayState'].forEach(id=>$(id).disabled=false);refresh();window.__lastLoad={ms:performance.now()-startedAt,rows:entries.length,name:meta.name||null,error:$('error').hidden?'':$('error').textContent,heap:performance.memory?performance.memory.usedJSHeapSize:null};}}
}
function drawIdsForRepair(face){
 const d=currentEnvelope?.document,s=currentEnvelope?.snapshot;if(!d||!s)return [];
 const product=d.products[face.productId],bindings=new Set((product?.representationIds||[]).flatMap(id=>d.representations[id].bindings.map(b=>b.id)));
 return Object.entries(s.draws).filter(([,draw])=>draw.primitiveId==='face-'+face.face&&bindings.has(draw.bindingId)).map(([id])=>id);
}
function focusDraw(drawId){
 const draw=currentEnvelope?.snapshot.draws[drawId],logical=currentDrawObjects?.get(drawId),mesh=logical?.userData?.renderObject||logical;
 if(!draw||!mesh?.isMesh||!effective(mesh))return false;
 const span=mesh.userData.primitiveSpans?.find(s=>s.renderItemId===drawId),geo=mesh.geometry;
 const first=span?.firstIndex??geo.drawRange.start,count=Math.min(span?.indexCount??geo.drawRange.count,geo.index?.count-first);
 if(!geo.index||count<3)return false;
 mesh.updateWorldMatrix(true,false);const box=new THREE.Box3();let largest=-1,point=null,normal=null;
 for(let i=first;i<first+count;i+=3){
  const p=[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(geo.attributes.position,geo.index.getX(i+j)).applyMatrix4(mesh.matrixWorld));
  for(const v of p)box.expandByPoint(v);
  const n=p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]));
  if(n.lengthSq()>largest){largest=n.lengthSq();normal=n.normalize();point=p[0].clone().add(p[1]).add(p[2]).multiplyScalar(1/3);}
 }
 if(!point||largest<=0)return false;
 const entry=entries.find(e=>e.object.userData.sourceId===draw.occurrenceId)||null;select(entry,null,drawId);
 const radius=Math.max(box.getSize(new THREE.Vector3()).length()/2,1e-6),fov=THREE.MathUtils.degToRad(camera.fov);
 const angle=Math.min(fov,2*Math.atan(Math.tan(fov/2)*camera.aspect)),distance=radius/Math.sin(angle/2)*1.3;
 camera.position.copy(point).addScaledVector(normal,distance);if(Math.abs(camera.up.dot(normal))>.98)camera.up.set(1,0,0);
 controls.target.copy(point);updateCameraRange(camera,controls,cameraBounds,radius);controls.update();render();
 return {drawId,primitiveId:draw.primitiveId,sceneId:draw.occurrenceId,point:point.toArray(),normal:normal.toArray()};
}
function renderCompleteness(envelope,info){
 const box=$('completeness');const c=envelope?.document?.extensions?.['org.cad-preview.completeness/1'];
 clearNonMeshableUI();box.classList.remove('has-omissions','has-repairs');box.setAttribute('role','status');box.removeAttribute('aria-label');
 if(!c){box.hidden=true;box.textContent='';return;}
 const faces=c.categories?.faceTriangulation||[],wire=c.categories?.geometryWithoutFaces||[],counts=c.counts||{},repairs=c.categories?.meshRepairs||[];
 box.hidden=false;box.classList.toggle('incomplete',c.status==='partial');
 if(c.status==='partial'){box.textContent=`完整性诊断：部分预览（未完成）· 缺失面 ${counts.missingFaces??faces.length} 个，涉及 ${(c.affectedProducts||[]).join('、')||'—'}；已省略 ${counts.omittedFaces??faces.length} 个面。缺失源于三角化失败，不是源文件主动隐藏；严格模式下的完整性检查仍然生效。`;}
 else{box.textContent=`完整性诊断：${c.categories?.nonMeshableFaces?.length?'已按缺失接收契约加载':'全部映射几何已包含'}${wire.length?` · ${wire.length} 个无面产品按边线显示`:''}${repairs.length?` · ${repairs.length} 个面由源曲面重采样（面积比 ${repairs.map(r=>r.areaRatio.toFixed(4)).join(' / ')}，见诊断）`:''}${(c.categories?.unsupportedSourceAttributes||[]).length?` · 未支持源属性 ${c.categories.unsupportedSourceAttributes.length} 项`:''}。`;}
 if(c.categories?.nonMeshableFaces?.length){box.classList.add('has-omissions');appendNonMeshableUI(box,envelope,info);}
 appendMeshRepairUI(box,envelope,info,face=>{const id=drawIdsForRepair(face).find(id=>{const o=currentDrawObjects?.get(id);return o&&effective(o.userData?.renderObject||o);});return !!id&&focusDraw(id);});
}
$('partialRetry').onclick=()=>{const file=pendingPartialFile;if(!file||loading)return;$('partialOffer').hidden=true;busy(async load=>{const p=await parseUpload(file,null,null,load,{partial:true});if(load.token!==loadSeq)return;const projection=decodePayload(p);const {root,info,session,sync}=projection;info.reference=false;sourceUpload=null;install(root,info,session,sync,projection);});};
function stateControls(){
 $('stateControls').hidden=!meta.selection||!sourceUpload;
 for(const id of ['configuration','displayState'])$(id).replaceChildren();
 if(!meta.selection)return;
 const config=meta.selection.configurations.find(c=>c.path===meta.selectedConfiguration);
 for(const c of meta.selection.configurations){const o=new Option(c.name,c.path);o.selected=c.path===meta.selectedConfiguration;$('configuration').add(o);}
 for(const s of config?.states||[]){const o=new Option(s.name+(s.supported?'':' · 未支持'),s.path);o.disabled=!s.supported;o.title=s.reason||'';o.selected=s.path===meta.selectedDisplayState;$('displayState').add(o);}
}
async function parseJobUpload(file,q,load){
  mark('jobCreateStart');
  const job=await convertJob(file,q,{signal:load.controller.signal,
   onJob:(id,reused)=>{load.jobId=id;if(activeLoad?.token===load.token)activeLoad.jobId=id;if(loadTiming){loadTiming.jobId=id;loadTiming.jobReused=reused;}mark('jobCreated');},
   onProgress:job=>{if(load.token!==loadSeq)return;const labels={queued:'文件已接收，等待转换…',running:'正在转换几何，请稍候…',completed:'产物已校验，正在安装模型…',failed:'转换失败',cancelled:'转换已取消','timed-out':'转换任务超时'};$('busy').textContent=labels[job.state]||'正在转换…';if(loadTiming){loadTiming.jobState=job.state;loadTiming.jobPhase=job.phase;}}});
  mark('jobVerified');load.controller.signal.throwIfAborted();
  const resultQuery=new URLSearchParams({transport:query.get('transport')==='base64'?'base64':'binary',requestId:load.requestId});
  for(const key of ['compression','metadata'])if(query.has(key))resultQuery.set(key,query.get(key));
  return packetFrom(await fetch('/api/jobs/'+job.id+'/result?'+resultQuery,{signal:load.controller.signal}),load);
}
async function parseUpload(file,configuration,displayState,load,{partial=false}={}){
 const q=new URLSearchParams({name:file.name,requestId:load.requestId});if(partial)q.set('partial','1');if(unifiedMode)q.set('model','ucd');if(unifiedMode&&binaryMode)q.set('transport','binary');if(configuration)q.set('configuration',configuration);if(displayState)q.set('displayState',displayState);
 if(query.has('compression'))q.set('compression',query.get('compression'));
 const step=unifiedMode&&/\.(step|stp)$/i.test(file.name);
 if(step&&(file.size>8*1024*1024||query.get('jobs')==='1'))return parseJobUpload(file,q,load);
 // A cancel response can arrive just before the worker's lock is released.
 for(let attempt=0;;attempt++){
  const response=await fetch('/api/parse?'+q,{method:'POST',body:file,signal:load.controller.signal});
  if(response.status===429&&step){
   if(loadTiming){loadTiming.syncBusyFallback=true;loadTiming.syncBusyTrace=JSON.parse(response.headers.get('X-CAD-Trace')||'null');}
   mark('queueFallback');return parseJobUpload(file,q,load);
  }
  if(response.status!==429||attempt>=5)return packetFrom(response,load);
  await new Promise(r=>setTimeout(r,250));
 }
}
async function changeState(configuration,displayState){
 if(!sourceUpload||loading)return;
 await busy(async load=>{const p=await parseUpload(sourceUpload,configuration,displayState,load);if(load.token!==loadSeq)return;const {root,info,session,sync}=decodePayload(p);install(root,info,session,sync);});stateControls();
}
$('configuration').onchange=e=>changeState(e.target.value,null);
$('displayState').onchange=e=>changeState(meta.selectedConfiguration,e.target.value);
async function packetFrom(response,load){mark('headers');if(loadTiming){loadTiming.artifactBytes=Number(response.headers.get('X-CAD-Artifact-Bytes')||response.headers.get('X-CAD-Unencoded-Bytes'))||null;loadTiming.cache=response.headers.get('X-Cache');loadTiming.serverTrace=JSON.parse(response.headers.get('X-CAD-Trace')||'null');}const text=await response.text();mark('body');let p=JSON.parse(text);mark('json');if(loadTiming){loadTiming.encodedBytes=Number(response.headers.get('X-CAD-Encoded-Bytes'));loadTiming.unencodedBytes=Number(response.headers.get('X-CAD-Unencoded-Bytes'));loadTiming.contentEncoding=response.headers.get('Content-Encoding');loadTiming.wireProfile=p.transportProfile;}mark('metadataExpandStart');p=unpackMetadata(p);mark('metadataExpandEnd');if(!response.ok||p.error){const error=new Error(p.error||'解析失败');error.payload=p;throw error;}if(loadTiming)loadTiming.manifestBytes=text.length;mark('resourceHydrationStart');if(p.transportProfile!=='ucd-binary-manifest/1'){mark('resourceHydrationEnd');return p;}const hydrated=await hydrateBinary(p,{signal:load?.controller.signal});mark('resources');mark('resourceHydrationEnd');return hydrated;}
function decodePayload(payload){mark('viewerInstallStart');if(!unifiedMode)return fromPacket(payload);
 const drawingTables=payload.document&&payload.document.drawing;
 if(drawingTables&&Object.values(drawingTables).some(t=>t&&Object.keys(t).length)){mark('viewerProjection');mark('project');const info={name:payload.presentation.name,quality:payload.presentation.quality,unit:payload.presentation.unit,note:payload.presentation.note,candidate:payload.presentation.candidate,sourceSHA256:payload.presentation.sourceSHA256,drawing:true};return {root:null,info,session:null,sync:null,drawing:payload};}
 const p=directMode?null:fromUnified(payload);mark('viewerProjection');const projection=directMode?directProjection(payload):batchMode?batchProjection(p,payload):p;mark('project');projection.envelope=payload;return projection;}
/** Host supplies an already validated transport envelope. CAD interpretation,
 * face identities, completeness and ViewerSession remain the existing path. */
export function loadPlatformModel(loader){
 if(query.get('platform')!=='1')throw new Error('Platform entry is disabled');
 return busy(async load=>{
  const payload=await loader({signal:load.controller.signal,progress:text=>{if(load.token===loadSeq)$('busy').textContent=text;}});
  if(load.token!==loadSeq)return;
  const projection=decodePayload(payload);sourceUpload=null;
  install(projection.root,projection.info,projection.session,projection.sync,projection);
 });
}
function loadSample(id){return busy(async load=>{const p=await packetFrom(await fetch('/api/sample?id='+(id==='demo'?'platte':id)+modelQuery+(unifiedMode&&binaryMode?'&transport=binary':'')+'&requestId='+load.requestId+(query.get('compression')==='gzip'?'&compression=gzip':''),{signal:load.controller.signal}),load);if(load.token!==loadSeq)return;const projection=decodePayload(p);const {root,info,session,sync}=projection;sourceUpload=null;install(root,info,session,sync,projection);});}
$('sample').addEventListener('change',e=>loadSample(e.target.value));$('open').onclick=()=>$('file').click();
$('file').addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;await busy(async load=>{const ext=file.name.split('.').at(-1).toLowerCase(),limits=await getUploadLimits(),limit=/^(step|stp)$/.test(ext)?limits.stepJobInputBytes:limits.synchronousInputBytes;if(file.size>limit)throw new Error(`文件超过当前 ${limit/(1024*1024)} MiB 上限`);let root,session,sync,info={name:file.name,quality:'文件节点解析',unit:'单位依源文件',note:''};
if(unifiedMode&&!['easm','step','stp','dxf'].includes(ext))throw new Error('统一模型入口接入 EASM、STEP 与 DXF');pendingPartialFile=ext==='step'||ext==='stp'?file:null;
if(['catpart','easm','step','stp','dxf'].includes(ext)){const p=await parseUpload(file,null,null,load);if(load.token!==loadSeq)return;const projection=decodePayload(p);({root,info,session,sync}=projection);info.reference=false;var unifiedProjection=projection;}
else if(ext==='glb'){const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(url.startsWith('data:')||url.startsWith('blob:'))return url;throw new Error('本地验证版仅支持内嵌资源的GLB，外部引用未加载');});const gltf=await new GLTFLoader(manager).parseAsync(await file.arrayBuffer(),'');root=gltf.scene;let unsupported=false;root.traverse(o=>{if(o.isSkinnedMesh||o.isInstancedMesh||o.morphTargetInfluences?.length)unsupported=true;});if(unsupported){dispose(root);throw new Error('此GLB包含蒙皮、变形或GPU合批实例，尚未支持逐实例验收');}root.name=file.name;info.note='保留GLB场景节点、变换与网格引用；节点是否对应设计零件取决于导出文件。仅显示静态场景，不播放动画。';}
else if(ext==='stl'){const geo=new STLLoader().parse(await file.arrayBuffer());root=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0x83a7b8,metalness:.2,roughness:.5,side:THREE.DoubleSide}));root.name=file.name;info.note='STL按整个文件作为一个对象显示。未按连通块猜测设计零件；文件不提供可靠的装配树和单位。';info.unit='STL单位未知';}
else if(ext==='obj'){root=new OBJLoader().parse(await file.text());root.name=file.name;info.note='保留OBJ的对象与分组；未加载外部MTL及纹理。分组不一定对应原始CAD零件。';info.unit='OBJ单位未知';}
else throw new Error('当前验证版不支持此格式');if(load.token!==loadSeq)return;sourceUpload=ext==='easm'?file:null;install(root,info,session,sync,typeof unifiedProjection!=='undefined'?unifiedProjection:null);});});
$('search').oninput=makeTree;$('fit').onclick=()=>{if(drawingViewer)return drawingViewer.fit();fit();};$('dim').onclick=()=>{dimMode=!dimMode;$('dim').setAttribute('aria-pressed',String(dimMode));applyHighlight();render();};
$('focus').onclick=()=>{if(drawingViewer)return drawingViewer.fitSelection();if(selected)fit(selected.object,false);};
$('toggle').onclick=()=>{if(!selected)return;if(viewerSession){if(selectedProductId)viewerSession.setProductShown(selectedProductId,!viewerSession.productEffective(selectedProductId));else viewerSession.setShown(selected.object.userData.sourceId,!effective(selected.object));syncViewer();refresh();return;}const show=!effective(selected.object);selected.object.visible=show;if(show){selected.object.traverse(o=>o.visible=true);for(let p=selected.object.parent;p&&p!==scene;p=p.parent)p.visible=true;}refresh();};
$('isolate').onclick=()=>{if(!selected)return;if(viewerSession){viewerSession.isolate(selected.object.userData.sourceId);syncViewer();refresh();fit(selected.object);return;}entries.forEach(e=>e.object.visible=false);selected.object.traverse(o=>o.visible=true);for(let p=selected.object;p&&p!==scene;p=p.parent)p.visible=true;refresh();fit(selected.object);};
$('showAll').onclick=()=>{if(viewerSession){viewerSession.showAll();syncViewer();refresh();return;}entries.forEach(e=>e.object.visible=true);refresh();};$('reset').onclick=()=>{if(viewerSession){viewerSession.reset();syncViewer();select(null);fit();return;}entries.forEach(e=>e.object.visible=e.initial);select(null);fit();};
$('wire').onclick=()=>{wire=!wire;$('wire').setAttribute('aria-pressed',String(wire));if(model)model.traverse(o=>{for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])m.wireframe=wire;});render();};
export function inspectionRecord(){
 if(!model||loading)return null;
 model.updateWorldMatrix(true,true);
 const data={viewerSession:viewerSession?.record()??null,schemaVersion:2,time:new Date().toISOString(),file:meta,scope:'当前浏览器场景运行记录，不代表原软件几何对照验收通过；运行 UUID 仅在本次加载内标识对象',matrixLayout:'column-major',groundPlane,selection:selected?.id||null,nodes:entries.map(e=>{
  const o=e.object;
  return {id:e.id,parentId:o.parent?.userData.entry?.id??null,name:e.name,sourceId:o.userData.sourceId??null,sourcePath:o.userData.sourcePath??null,legacyId:o.userData.legacyId??null,sourceVisible:o.userData.sourceVisible??null,meshDefinition:o.userData.meshDefinition??null,objectUUID:o.uuid,geometryUUID:o.geometry?.uuid??null,isMesh:!!o.isMesh,visible:effective(o),localVisible:o.visible,initialLocalVisible:e.initial,localMatrix:o.matrix.toArray(),worldMatrix:o.matrixWorld.toArray(),meshes:meshes(o).length};
 })};
 return data;
}
$('export').onclick=()=>{
 if(drawingViewer){const data={schemaVersion:'ucd-drawing-record/1',time:new Date().toISOString(),file:meta,drawing:drawingViewer.record()};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='DXF二维检查记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
 const data=inspectionRecord();if(!data)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='CAD检查记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
let down=null;renderer.domElement.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,button:e.button};});renderer.domElement.addEventListener('pointerup',e=>{if(!model||!down||down.button!==0||Math.hypot(e.clientX-down.x,e.clientY-down.y)>4)return;const r=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);const hit=raycaster.intersectObjects(meshes(model).filter(effective),false)[0];if(groundPicking){if(hit)setGroundFromHit(hit);return;}const identity=hit&&unifiedMode?identityAtHit(hit):null;select(hit?hit.object.userData.entry:null,identity?.productOccurrenceId??null,identity?.renderItemId??null);});

function setGroundFromHit(hit){
 if(!hit.face)return;
 model.updateWorldMatrix(true,true);
 const up=hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
 const plane=up.dot(hit.point);let low=Infinity,high=-Infinity;
 // Project actual vertices in world space; works with arbitrary rotation and shared instances.
 for(const mesh of meshes(model)){
  const p=mesh.geometry.attributes.position,e=mesh.matrixWorld.elements;
  const a=up.x*e[0]+up.y*e[1]+up.z*e[2],b=up.x*e[4]+up.y*e[5]+up.z*e[6],c=up.x*e[8]+up.y*e[9]+up.z*e[10],d=up.x*e[12]+up.y*e[13]+up.z*e[14];
  for(let i=0;i<p.count;i++){const v=a*p.getX(i)+b*p.getY(i)+c*p.getZ(i)+d;low=Math.min(low,v);high=Math.max(high,v);}
 }
 const box=bounds(model),size=Math.max(box.getSize(new THREE.Vector3()).length(),.001),tolerance=size*1e-5;
 if(low<plane-tolerance&&high>plane+tolerance){$('error').textContent='这个面穿过模型内部，不能作为整个总装的地面。请旋转到下面，选择脚底或模型最外侧的支撑面。';$('error').hidden=false;return;}
 if(high-plane<plane-low){up.negate();const old=low;low=-high;high=-old;}
 if(grid){scene.remove(grid);dispose(grid);}
 grid=new THREE.GridHelper(size*1.5,30,0xb7c7d2,0xd2dde5);grid.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),up);
 const center=box.getCenter(new THREE.Vector3());grid.position.copy(center).addScaledVector(up,low-center.dot(up));scene.add(grid);
 groundPlane={normal:up.toArray(),offset:low,source:'user-selected-support-face'};
 const side=camera.position.clone().sub(controls.target);side.addScaledVector(up,-side.dot(up));
 if(side.lengthSq()<1e-12)side.crossVectors(up,Math.abs(up.x)<.8?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0));
 side.normalize().addScaledVector(up,.45).normalize();setCameraUp(up);controls.target.copy(center);camera.position.copy(center).add(side);
 groundPicking=false;$('ground').setAttribute('aria-pressed','false');$('ground').textContent='重选底面';$('clearGround').disabled=false;$('error').hidden=true;$('viewlabel').textContent='所选支撑面贴地';fit();
}
$('ground').onclick=()=>{if(!model)return;groundPicking=!groundPicking;$('ground').setAttribute('aria-pressed',String(groundPicking));$('ground').textContent=groundPicking?'取消选底面':groundPlane?'重选底面':'选底面摆正';$('viewlabel').textContent=groundPicking?'旋转到模型下方，单击脚底或支撑面':groundPlane?'所选支撑面贴地':'查看方向 · 地面未设置';};
$('clearGround').onclick=()=>{if(grid){scene.remove(grid);dispose(grid);grid=null;}groundPlane=null;groundPicking=false;$('ground').setAttribute('aria-pressed','false');$('ground').textContent='选底面摆正';$('clearGround').disabled=true;$('viewlabel').textContent='查看方向 · 地面未设置';render();};

window.addEventListener('beforeunload',()=>{controls.dispose();if(model)dispose(model);renderer.dispose();});
if(query.get('autoload')!=='0')loadSample('viola');
// Read-only test hook: exposes what the page installed, not viewer internals.
window.__viewerDebug=()=>({mode:{direct:directMode,batch:batchMode,unified:unifiedMode,drawing:!!drawingViewer},drawing:drawingViewer?drawingViewer.record():null,name:meta.name||null,unified:!!(meta.unified||meta.drawing),rows:entries.length,loading,error:$('error').hidden?'':$('error').textContent,selected:selected?.id??null,selectedDrawId,selectedSceneId:selected?.object.userData.sourceId??null,loadSeq,requestId:activeLoad?.requestId??null,render:{...renderer.info.render,renderCount},highlight:highlighter?highlighter.stats():null,timing:loadTiming?{...loadTiming}:null,draws:currentEnvelope?Object.keys(currentEnvelope.snapshot.draws).length:null,session:viewerSession?viewerSession.record():null,completeness:(currentEnvelope?.document?.extensions?.['org.cad-preview.completeness/1'])??null,products:currentEnvelope?Object.keys(currentEnvelope.document.productOccurrences).length:null,quality:meta.quality||null});
window.__viewerTest={pickDraw:(drawId)=>{const sid=currentEnvelope?.snapshot.draws[drawId]?.occurrenceId;const entry=entries.find(e=>e.object.userData.sourceId===sid)||null;select(entry,null,drawId);return {highlight:highlighter.stats(),selected:entry?.id??null};},pickProduct:(productId)=>{const entry=entries[0]||null;select(entry,productId,null);return {highlight:highlighter.stats()};},pickNone:()=>{select(null);return {highlight:highlighter.stats()};},
pickScene:(sceneId)=>{const obj=model?.userData.productModel?.sceneObjects?.get(sceneId)||null;select(obj?.userData.entry||null,null,null);return {highlight:highlighter.stats()};},drawIds:()=>currentDrawObjects?[...currentDrawObjects.keys()]:[],
catalog:()=>{const out=[];for(const [id,entry] of (currentDrawObjects||[])){const mesh=entry.userData?.renderObject||entry;out.push({id,topology:mesh.isLineSegments?'lines':'triangles',productId:currentEnvelope?currentEnvelope.document.renderOwnership[id]??null:null,sceneId:currentEnvelope?currentEnvelope.snapshot.draws[id]?.occurrenceId??null:null,meshDefinition:mesh.userData.meshDefinition??null,physicalMeshCount:mesh.userData.primitiveSpans?.length??1});}return out;},
stats:()=>({text:$('stats').textContent,logical:currentEnvelope?.snapshot?{draws:logicalIndex().draws,instances:logicalIndex().instances,visibleDraws:visibleLogical().draws,visibleInstances:visibleLogical().instances}:null,physical:model?meshes(model).length:0,physicalVisible:model?meshes(model,true).length:0,treeChecked:[...document.querySelectorAll('#tree .row input:checked')].map(x=>x.getAttribute('aria-label')),treeIndeterminate:[...document.querySelectorAll('#tree .row input:indeterminate')].map(x=>x.getAttribute('aria-label'))}),
nonMeshableAudit:()=>{
 const d=currentEnvelope?.document;if(!d)return [];
 return (d.extensions['org.cad-preview.completeness/1']?.categories.nonMeshableFaces||[]).map(face=>{
  const product=d.products[face.productId],m=d.extensions['org.cad-preview.step-audit/1'].definitionMeasurements[face.productId];
  const hasPrimitive=product.representationIds.some(rid=>d.representations[rid].bindings.some(b=>d.geometries[b.geometryId].primitives.some(p=>p.id==='face-'+face.face)));
  return {entry:face.entry,face:face.face,hasPrimitive,volumeUnavailable:m.volumeMM3===null&&m.centroidMM===null,areaScope:m.areaScope};
 });
},
dim:()=>{dimMode=!dimMode;$('dim').setAttribute('aria-pressed',String(dimMode));applyHighlight();return highlighter.stats();},
setShown:(sceneId,shown)=>{if(viewerSession)viewerSession.setShown(sceneId,shown);syncViewer();refresh();return viewerSession?viewerSession.effective(sceneId):null;},
probeDraw:(drawId)=>{const entry=currentDrawObjects?.get(drawId);const mesh=entry?.userData?.renderObject||entry;if(!mesh)return null;const box=new THREE.Box3().setFromObject(mesh);const center=box.getCenter(new THREE.Vector3()).project(camera);return window.__viewerTest.probe(center.x,center.y);},
probe:(x=0,y=0)=>{raycaster.setFromCamera(new THREE.Vector2(x,y),camera);const hit=raycaster.intersectObjects(meshes(model).filter(effective),false)[0];if(!hit)return null;const identity=unifiedMode?identityAtHit(hit):null;return {drawId:identity?.renderItemId??null,productId:identity?.productOccurrenceId??null,mesh:!!hit.object.isMesh,isOverlay:!!hit.object.userData.highlight||!!hit.object.userData.dim};},materials:()=>{const out={};if(!model)return out;model.traverse(o=>{if((o.isMesh||o.isLineSegments)&&o.userData.renderItemId)out[o.userData.renderItemId]=o.material.color?.getHexString?.()||null;});return out;}};

function finishModelFrame(){
 const timing=loadTiming,token=loadSeq;
 requestAnimationFrame(()=>{
  if(token!==loadSeq||timing!==loadTiming)return;
  if(drawingViewer){if(!drawingViewer.counts().visible)return;}
  else{render();if(!renderer.info.render.calls)return;if(query.get('acceptance')==='1')renderer.getContext().finish();}
  mark('firstModelFrame');mark('firstFrame');
  requestAnimationFrame(()=>{if(token===loadSeq&&!loading)mark('interactionReady');});
 });
}

// Acceptance hooks report physical visibility and fence GPU work only on request.
window.__viewerTest.repairCatalog=()=>repairManifest(currentEnvelope).faces.map(face=>({entry:face.entry,face:face.face,reason:face.reason,productId:face.productId,drawIds:drawIdsForRepair(face)}));
window.__viewerTest.focusDraw=focusDraw;
window.__viewerTest.pickSamples=drawId=>{
 const logical=currentDrawObjects?.get(drawId),mesh=logical?.userData?.renderObject||logical,geo=mesh?.geometry;
 if(!geo?.index||!effective(mesh))return [];
 const span=mesh.userData.primitiveSpans?.find(s=>s.renderItemId===drawId),first=span?.firstIndex??geo.drawRange.start;
 const count=Math.min(span?.indexCount??geo.drawRange.count,geo.index.count-first),stride=mesh.isLineSegments?2:3;
 mesh.updateWorldMatrix(true,false);const out=[];
 for(let i=first;i<first+count&&out.length<8;i+=stride){
  const point=new THREE.Vector3();for(let j=0;j<stride;j++)point.add(new THREE.Vector3().fromBufferAttribute(geo.attributes.position,geo.index.getX(i+j)));
  point.multiplyScalar(1/stride).applyMatrix4(mesh.matrixWorld).project(camera);out.push({x:point.x,y:point.y});
 }
 return out;
};
window.__viewerTest.sceneContract=()=>({parents:[...viewerSession.parents],source:[...viewerSession.sourceVisibility]});
window.__viewerTest.visibleDrawIds=()=>[...(currentDrawObjects||[])].filter(([,o])=>effective(o.userData?.renderObject||o)).map(([id])=>id).sort();
window.__viewerTest.capture=()=>{
 if(drawingViewer){const canvas=document.querySelector('#viewport canvas.drawing-canvas');return {drawing:drawingViewer.counts()};}
 render();const gl=renderer.getContext();gl.finish();const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,bytes=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
 let hash=2166136261,nonBackground=0;const r=bytes[0],g=bytes[1],b=bytes[2];
 for(let i=0;i<bytes.length;i+=4){hash=Math.imul(hash^bytes[i],16777619);hash=Math.imul(hash^bytes[i+1],16777619);hash=Math.imul(hash^bytes[i+2],16777619);if(Math.abs(bytes[i]-r)+Math.abs(bytes[i+1]-g)+Math.abs(bytes[i+2]-b)>15)nonBackground++;}
 return {hash:hash>>>0,nonBackground,width:w,height:h,render:{...renderer.info.render},geometries:renderer.info.memory.geometries,heap:performance.memory?.usedJSHeapSize??null};
};
window.__viewerTest.isolateMeasured=(id,reference=null)=>{
 const t=performance.now();if(reference)reference.call(viewerSession,id);else viewerSession.isolate(id);const stateMs=performance.now()-t;syncViewer();refresh();
 const object=model.userData.productModel.sceneObjects.get(id);fit(object);renderer.getContext().finish();return {ms:performance.now()-t,stateMs};
};

// Offline prepared-envelope acceptance: explicitly excludes parsing and transport.
if(query.get('acceptance')==='1')window.__viewerTest.prepared=async(payload,legacyPrelude=false)=>{
 let legacyPreludeMs=0,unused=null;window.__viewerTest.preparedCleanup=()=>{if(unused){dispose(unused.root);unused=null;}};await busy(async()=>{if(legacyPrelude){const t=performance.now();unused=fromUnified(payload);legacyPreludeMs=performance.now()-t;}const projection=decodePayload(payload);install(projection.root,projection.info,projection.session,projection.sync,projection);});return {legacyPreludeMs};
};

if(query.get('acceptance')==='1')window.__viewerTest.camera=()=>({position:camera.position.toArray(),target:controls.target.toArray(),quaternion:camera.quaternion.toArray(),up:camera.up.toArray(),enabled:controls.enabled,state:controls.state,pointers:controls._pointers?.length});
if(query.get('acceptance')==='1')window.__viewerTest.cameraUp=up=>{setCameraUp(new THREE.Vector3(...up));controls.update();render();return window.__viewerTest.camera();};
