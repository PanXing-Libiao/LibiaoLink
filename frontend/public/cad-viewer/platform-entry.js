import {loadPlatformModel,inspectionRecord} from './core/app.js';
import {unpackMetadata} from './core/compact-transport.js';
import {hydrateBinary} from './core/binary-transport.js';
import {missingFaceManifest} from './core/nonmeshable-ui.js';
import {repairManifest} from './core/mesh-repair-ui.js';
import {ImportUI} from './import-ui.js';
import {trackResponse} from './import-progress.js';

const query=new URLSearchParams(location.search);
const fileId=query.get('fileId'),versionId=query.get('versionId'),viewId=query.get('viewId');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const valid=uuid.test(fileId||'')&&uuid.test(versionId||'')&&/^[a-f0-9]{32}$/.test(viewId||'');
const base=valid?`/api/v1/files/${fileId}/versions/${versionId}/cad/views/${viewId}/jobs`:null;
const nameCodepage=query.get('nameCodepage')==='UTF8'?'UTF8':'GB';
let currentJob=null,jobBase=null,delivered=false,cancelled=false,loadedEnvelope=null,csrfToken=null,csrfPending=null,authExpiredNotified=false;
const ui=new ImportUI({fileId,versionId,engineVersion:query.get('engineVersion')||'unknown'});
const nameSelect=document.getElementById('nameCodepage'),reloadNames=document.getElementById('reloadNames');
nameSelect.value=nameCodepage;
nameSelect.onchange=()=>{reloadNames.disabled=!delivered||nameSelect.value===nameCodepage;};
reloadNames.onclick=()=>{
 if(delivered&&['UTF8','GB'].includes(nameSelect.value)&&nameSelect.value!==nameCodepage){
  reloadNames.disabled=true;parent.postMessage({type:'cad-name-codepage',value:nameSelect.value},location.origin);
 }
};

window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='cad-context')return;
 ui.context(event.data.name);
});
parent.postMessage({type:'cad-context-request'},location.origin);

const sidebar=document.getElementById('partsSidebar'),sidebarButton=document.getElementById('toggleSidebar');
function setSidebar(open){
 document.body.dataset.sidebar=open?'open':'closed';
 sidebarButton.setAttribute('aria-expanded',String(open));
}
const narrow=matchMedia('(max-width:760px)');
setSidebar(!narrow.matches);
narrow.addEventListener('change',event=>setSidebar(!event.matches));
sidebarButton.onclick=()=>setSidebar(document.body.dataset.sidebar==='closed');
function closeSidebar(){setSidebar(false);sidebarButton.focus();}
document.getElementById('closeSidebar').onclick=closeSidebar;
document.getElementById('sidebarScrim').onclick=closeSidebar;
sidebar.addEventListener('keydown',event=>{
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSidebar();}
});
let partsTreeState=null;
function preparePartsTree(tree){
 const rows=[...tree.querySelectorAll('.row')];
 if(partsTreeState?.tree===tree&&partsTreeState.rows[0]===rows[0])return partsTreeState;
 const state={tree,rows,occurrences:loadedEnvelope?.document?.productOccurrences||{},children:new Map(),controls:new Map(),expanded:new Set(),searchExpanded:new Set(),term:''};
 for(const row of rows){
  const id=row.dataset.productId,parent=state.occurrences[id]?.parentId;
  if(parent==null)state.expanded.add(id);
  else{if(!state.children.has(parent))state.children.set(parent,[]);state.children.get(parent).push(id);}
 }
 for(const row of rows){
  const id=row.dataset.productId,spacer=document.createElement('span');spacer.className='tree-expander-spacer';spacer.setAttribute('aria-hidden','true');
  if(state.children.has(id)){
   const button=document.createElement('button');button.type='button';button.className='tree-expander';
   const arrow=document.createElement('span');arrow.textContent='›';arrow.setAttribute('aria-hidden','true');button.append(arrow);
   button.onclick=()=>{
    const expanded=state.term?state.searchExpanded:state.expanded;
    if(expanded.has(id))expanded.delete(id);else expanded.add(id);
    filterParts();
   };
   row.prepend(button,spacer);state.controls.set(id,{button,spacer});
  }else row.prepend(spacer);
 }
 partsTreeState=state;return state;
}
// Keep source parentId paths; manual folds and temporary search folds never change CAD visibility.
function filterParts(){
 const tree=document.getElementById('productTree');
 if(!tree||tree.hidden)return;
 const state=preparePartsTree(tree),{rows,occurrences}=state,term=document.getElementById('search').value.trim().toLocaleLowerCase();
 const matches=new Set(rows.filter(row=>row.querySelector('.node').textContent.toLocaleLowerCase().includes(term)).map(row=>row.dataset.productId));
 const visible=new Set(matches),autoExpanded=new Set();
 if(term)for(const id of matches){
  const seen=new Set([id]);let parent=occurrences[id]?.parentId;
  while(typeof parent==='string'&&!seen.has(parent)){
   visible.add(parent);autoExpanded.add(parent);seen.add(parent);parent=occurrences[parent]?.parentId;
  }
 }
 if(term!==state.term){state.searchExpanded=autoExpanded;state.term=term;}
 const expanded=term?state.searchExpanded:state.expanded;
 let contextCount=0;
 for(const row of rows){
  const id=row.dataset.productId,match=matches.has(id),context=!!term&&visible.has(id)&&!match;
  let folded=false,parent=occurrences[id]?.parentId;const seen=new Set([id]);
  while(typeof parent==='string'&&!seen.has(parent)){
   if(state.controls.has(parent)&&!expanded.has(parent)){folded=true;break;}
   seen.add(parent);parent=occurrences[parent]?.parentId;
  }
  row.hidden=!visible.has(id)||folded;
  row.toggleAttribute('data-search-match',!!term&&match);row.toggleAttribute('data-search-context',context);
  const button=row.querySelector('.node');button.title=button.textContent;
  const control=state.controls.get(id);
  if(control){
   const hasChildren=state.children.get(id).some(child=>visible.has(child)),open=expanded.has(id);
   control.button.hidden=!hasChildren;control.spacer.hidden=hasChildren;
   control.button.setAttribute('aria-expanded',String(open));
   control.button.setAttribute('aria-label',`${open?'收起':'展开'} ${button.textContent}`);
   control.button.title=`${open?'收起':'展开'}下级，不改变模型显示`;
  }
  if(context)contextCount++;
 }
 const count=document.getElementById('nodecount');count.textContent=term?`${matches.size} 项匹配`:`共 ${rows.length} 项`;
 count.title=`当前展开 ${rows.filter(row=>!row.hidden).length} 项，共 ${rows.length} 项`;
 const status=document.getElementById('searchStatus');status.hidden=!term;
 status.textContent=!matches.size?'没有匹配的零件':contextCount?`含 ${contextCount} 个上级节点 · 加粗为匹配项`:'加粗为匹配项';
}
document.getElementById('search').addEventListener('input',filterParts);

// Host owns downloads and rechecks file access. Reports are the unchanged core manifests.
document.addEventListener('click',event=>{
 const button=event.target instanceof Element?event.target.closest('#exportMissingFaces,#exportMeshRepairs,#export'):null;
 if(!button||!loadedEnvelope)return;
 event.preventDefault();event.stopImmediatePropagation();
 const missing=button.id==='exportMissingFaces',inspection=button.id==='export';
 const report=inspection?inspectionRecord():missing?missingFaceManifest(loadedEnvelope):repairManifest(loadedEnvelope);
 if(!report)return;
 const name=inspection?'CAD检查记录.json':(loadedEnvelope.presentation.name||'STEP').replace(/\.(step|stp)$/i,'')+(missing?'.missing-faces.json':'.display-repairs.json');
 parent.postMessage({type:'cad-export',name,report},location.origin);
},true);

const CSRF_HEADER="X-CSRF-Token";
const SAFE_METHODS=new Set(["GET","HEAD","OPTIONS"]);
function notifyAuthExpired(){
 if(authExpiredNotified)return;
 authExpiredNotified=true;
 parent.postMessage({type:"cad-auth-expired"},location.origin);
}
function csrf(){
 const part=document.cookie.split(";").find(value=>value.trim().startsWith("ll_csrf="));
 return part?decodeURIComponent(part.trim().slice("ll_csrf=".length)):"";
}
async function sessionCsrf(force=false){
 if(force)csrfToken=null;
 if(csrfToken)return csrfToken;
 const cookie=force?"":csrf();
 if(cookie){csrfToken=cookie;return cookie;}
 if(csrfPending)return csrfPending;
 csrfPending=(async()=>{
  try{
   const response=await fetch("/auth/me",{headers:{Accept:"application/json"},credentials:"same-origin",cache:"no-store"});
   if(response.status===401){notifyAuthExpired();return null;}
   if(!response.ok)return null;
   const data=await response.json();
   if(typeof data?.csrfToken==="string"&&data.csrfToken)csrfToken=data.csrfToken;
  }catch{}
  return csrfToken||(force?"":csrf());
 })().finally(()=>{csrfPending=null;});
 return csrfPending;
}
async function request(url,options={}){
 const headers=new Headers(options.headers);
 headers.set("Accept","application/json");
 if(!SAFE_METHODS.has((options.method||"GET").toUpperCase())){
  const token=await sessionCsrf();
  if(token)headers.set(CSRF_HEADER,token);
 }
 return fetch(url,{...options,headers,credentials:"same-origin",cache:"no-store"});
}
function responseError(data,status){
 return data?.error?.message||data?.message||(status===401?"登录状态已失效，请重新登录后打开文件。":status===403?"没有权限或登录状态已失效，请重新登录后打开文件。":"模型读取失败，请重试或下载原文件");
}
async function readJson(response){
 if(response.status===401)notifyAuthExpired();
 const type=(response.headers.get("content-type")||"").toLowerCase();
 if(!type.includes("json")){
  await response.text().catch(()=>"");
  if(response.status===401)throw new Error("登录状态已失效，请重新登录后打开文件。");
  throw new Error("模型服务返回了异常页面，请重新登录或稍后重试；也可以先下载原文件。");
 }
 try{return await response.json();}
 catch{throw new Error("模型服务响应格式异常，请稍后重试或下载原文件。");}
}
async function requestJson(url,options={}){
 let response=await request(url,options),data=await readJson(response);
 if(response.status===403&&data?.code==="CSRF_FAILED"){
  const token=await sessionCsrf(true);
  if(token){
   response=await request(url,options);
   data=await readJson(response);
  }
 }
 if(!response.ok)throw new Error(responseError(data,response.status));
 return data;
}
function delay(signal){
 return new Promise((resolve,reject)=>{
  const stop=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},350);
  signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 });
}
function cancelJob(){
 if(jobBase&&currentJob&&!['completed','failed','cancelled','timed-out'].includes(currentJob.state)){
  request(jobBase+'/cancel',{method:'POST',keepalive:true}).catch(()=>{});
 }
}
function failureMessage(job){
 const message=job.error?.error||'转换已停止，请重试或下载原文件';
 if(job.error?.code==='unsupported-external-reference'||message.startsWith('unsupported-external-reference:'))return '此文件引用了外部零件，暂不支持在线预览。请使用本地 CAD 软件打开，并确保相关零件文件齐全。';
 return message;
}
function unsupportedPreview(job){
 // Explicit capability rejections from the pinned STEP adapter; generic parse failures remain retryable.
 const codes=new Set(['unsupported-external-reference','unsupported-state-or-style','unsupported-non-surface-product','unsupported-step-selection']);
 return codes.has(job?.error?.code)||codes.has(job?.error?.error?.split(':',1)[0]);
}
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'cad-close'},location.origin);}
 // Keyboard events inside an iframe do not reach the host modal's focus trap.
 if(event.key==='Tab'){
  const items=[...document.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')]
   .filter(element=>!element.closest('[inert]')&&element.checkVisibility()&&element.tabIndex>=0);
  const first=items[0],last=items.at(-1),focused=document.activeElement;
  if(first&&(!items.includes(focused)||event.shiftKey&&focused===first||!event.shiftKey&&focused===last)){
   event.preventDefault();(event.shiftKey?last:first).focus();
  }
 }
});
const unloading=new AbortController();
window.addEventListener('pagehide',()=>{ui.destroy();unloading.abort();cancelJob();},{once:true});

loadPlatformModel(async({signal,progress})=>{
 if(!base)throw new Error('文件版本信息无效，请关闭后重新打开');
 const controller=new AbortController();
 const abort=()=>{cancelled=true;controller.abort();cancelJob();};
 signal.addEventListener('abort',abort,{once:true});unloading.signal.addEventListener('abort',abort,{once:true});
 const active=controller.signal;
 try{
  active.throwIfAborted();progress('正在读取模型任务…');
  const created=await requestJson(base+"?"+new URLSearchParams({nameCodepage}),{method:"POST",signal:active});
  currentJob=created.job;
  if(!/^[a-f0-9]{32}$/.test(currentJob?.id||''))throw new Error('模型任务响应无效');
  jobBase=base+'/'+currentJob.id;
  active.throwIfAborted();
  while(currentJob.state!=='completed'){
   if(['failed','cancelled','timed-out'].includes(currentJob.state))throw new Error(failureMessage(currentJob));
   if(!['queued','running'].includes(currentJob.state))throw new Error('模型任务状态无效');
   progress(currentJob.state==='queued'?'正在排队处理模型…':'正在处理模型…');
   ui.job(currentJob);
   await delay(active);currentJob=await requestJson(jobBase,{signal:active});
  }
  ui.bytes=currentJob.sourceByteLength;
  ui.update(2,'正在准备模型视图');
  progress('正在读取已校验模型…');
  let packet=await requestJson(jobBase+"/manifest",{signal:active});
  packet=unpackMetadata(packet);
  if(packet.presentation?.sourceSHA256!==currentJob.sourceSHA256||packet.snapshot?.completeness!=='complete')throw new Error('模型来源或完整性检查未通过');
  const lease=packet.resourceLease;
  const fetcher=async(url,options={})=>{
   const match=/^\/api\/resources\/([a-f0-9]{48})(?:\/([a-f0-9]{64}))?$/.exec(url);
   if(!match||match[1]!==lease)throw new Error('模型资源引用无效');
   const resource=await request(jobBase+'/resources/'+match[1]+(match[2]?'/'+match[2]:''),options);
   return match[2]?trackResponse(resource,count=>ui.receive(count)):resource;
  };
  progress('正在读取模型几何…');
  const total=Object.values(packet.document.buffers).reduce((sum,buffer)=>sum+buffer.byteLength,0);
  ui.downloading(Number.isSafeInteger(total)&&total>0&&total<=256*1024*1024?total:0);
  packet=await hydrateBinary(packet,{signal:active,fetcher});
  active.throwIfAborted();progress('正在显示模型…');
  ui.update(2,'正在生成可交互视图');
  loadedEnvelope=packet;delivered=true;return packet;
 }finally{
  signal.removeEventListener('abort',abort);unloading.signal.removeEventListener('abort',abort);
 }
}).then(()=>{
 const ready=delivered&&document.getElementById('error').hidden;
 if(ready){
  ui.update(3,'模型已就绪');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ui.stop('ready');filterParts();parent.postMessage({type:'cad-ready',viewId},location.origin);}));
 }else{
  const unsupported=!cancelled&&unsupportedPreview(currentJob);
  ui.stop(cancelled?'cancelled':unsupported?'unsupported':'failed',{retryable:!unsupported});
 }
});
