import {loadPlatformModel,inspectionRecord} from './core/app.js';
import {unpackMetadata} from './core/compact-transport.js';
import {hydrateBinary} from './core/binary-transport.js';
import {missingFaceManifest} from './core/nonmeshable-ui.js';
import {repairManifest} from './core/mesh-repair-ui.js';

const query=new URLSearchParams(location.search);
const fileId=query.get('fileId'),versionId=query.get('versionId'),viewId=query.get('viewId');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const valid=uuid.test(fileId||'')&&uuid.test(versionId||'')&&/^[a-f0-9]{32}$/.test(viewId||'');
const base=valid?`/api/v1/files/${fileId}/versions/${versionId}/cad/views/${viewId}/jobs`:null;
let currentJob=null,jobBase=null,delivered=false,cancelled=false,loadedEnvelope=null;

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

function csrf(){
 const part=document.cookie.split(';').find(value=>value.trim().startsWith('ll_csrf='));
 return part?decodeURIComponent(part.trim().slice('ll_csrf='.length)):'';
}
function request(url,options={}){
 const headers=new Headers(options.headers);
 if(!['GET','HEAD'].includes((options.method||'GET').toUpperCase()))headers.set('X-CSRF-Token',csrf());
 return fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store'});
}
async function json(response){
 const data=await response.json();
 if(!response.ok)throw new Error(data.error?.message||data.message||'模型读取失败，请重试或下载原文件');
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
 if(job.error?.code==='unsupported-external-reference'||message.startsWith('unsupported-external-reference:'))return '本文件引用了外部零件，当前尚不支持读取配套文件。请下载原文件及其配套文件查看。';
 return message;
}
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'cad-close'},location.origin);}
});
const unloading=new AbortController();
window.addEventListener('pagehide',()=>{unloading.abort();cancelJob();},{once:true});

loadPlatformModel(async({signal,progress})=>{
 if(!base)throw new Error('文件版本信息无效，请关闭后重新打开');
 const controller=new AbortController();
 const abort=()=>{cancelled=true;controller.abort();cancelJob();};
 signal.addEventListener('abort',abort,{once:true});unloading.signal.addEventListener('abort',abort,{once:true});
 const active=controller.signal;
 try{
  active.throwIfAborted();progress('正在读取文件并创建转换任务…');
  const created=await json(await request(base,{method:'POST',signal:active}));
  currentJob=created.job;
  if(!/^[a-f0-9]{32}$/.test(currentJob?.id||''))throw new Error('模型任务响应无效');
  jobBase=base+'/'+currentJob.id;
  active.throwIfAborted();
  while(currentJob.state!=='completed'){
   if(['failed','cancelled','timed-out'].includes(currentJob.state))throw new Error(failureMessage(currentJob));
   if(!['queued','running'].includes(currentJob.state))throw new Error('模型任务状态无效');
   progress(currentJob.state==='queued'?'正在排队处理模型…':'正在处理模型…');
   await delay(active);currentJob=await json(await request(jobBase,{signal:active}));
  }
  progress('正在读取已校验模型…');
  const response=await request(jobBase+'/manifest',{signal:active});
  let packet=unpackMetadata(await json(response));
  if(packet.presentation?.sourceSHA256!==currentJob.sourceSHA256||packet.snapshot?.completeness!=='complete')throw new Error('模型来源或完整性检查未通过');
  const lease=packet.resourceLease;
  const fetcher=(url,options={})=>{
   const match=/^\/api\/resources\/([a-f0-9]{48})(?:\/([a-f0-9]{64}))?$/.exec(url);
   if(!match||match[1]!==lease)throw new Error('模型资源引用无效');
   return request(jobBase+'/resources/'+match[1]+(match[2]?'/'+match[2]:''),options);
  };
  progress('正在读取模型几何…');
  packet=await hydrateBinary(packet,{signal:active,fetcher});
  active.throwIfAborted();progress('正在显示模型…');
  loadedEnvelope=packet;delivered=true;return packet;
 }finally{
  signal.removeEventListener('abort',abort);unloading.signal.removeEventListener('abort',abort);
 }
}).then(()=>{
 const ready=delivered&&document.getElementById('error').hidden;
 document.body.dataset.cadState=ready?'ready':cancelled?'cancelled':'failed';
 if(ready)requestAnimationFrame(()=>requestAnimationFrame(()=>parent.postMessage({type:'cad-ready'},location.origin)));
 else if(cancelled){const status=document.getElementById('busy');status.hidden=false;status.textContent='已取消加载，可关闭后重新打开';}
});
