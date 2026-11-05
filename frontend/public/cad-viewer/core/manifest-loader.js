import {applyManifestEntries} from './manifest-parts.js';
import {decodeManifestBytes} from './manifest-decode.js';
const WORKER_BYTES=1024*1024;
const createWorker=()=>new Worker(new URL('./manifest-worker.js',import.meta.url),{type:'module'});

/** One owner per load: cancellation terminates CPU work and rejects stale results. */
export async function decodeManifest(bytes,{signal,workerFactory=createWorker}={}){
 signal?.throwIfAborted();
 const started=performance.now();
 if(bytes.byteLength<WORKER_BYTES){
  const result=decodeManifestBytes(bytes);
  return {...result,timing:{...result.timing,execution:'main',totalMS:performance.now()-started}};
 }
 return new Promise((resolve,reject)=>{
  const worker=workerFactory();
  let settled=false,packet;
  const finish=(error,result)=>{
   if(settled)return;settled=true;
   signal?.removeEventListener('abort',abort);worker.terminate();
   if(error)reject(error);else resolve(result);
  };
  const abort=()=>finish(signal.reason);
  worker.onmessage=({data})=>{
   if(signal?.aborted){abort();return;}
   if(settled)return;
   try{
    if(data.kind==='error')throw new Error('模型数据展开失败，请重试或下载原文件');
    if(data.kind==='done'){
     finish(null,{packet,timing:{...data.timing,execution:'worker',totalMS:performance.now()-started}});return;
    }
    if(data.kind==='header')packet=data.packet;
    else if(data.kind==='entries')applyManifestEntries(packet,data);
    else throw new Error('模型数据处理消息无效');
    worker.postMessage('next');
   }catch(error){finish(error);}
  };
  worker.onerror=event=>{event.preventDefault?.();finish(new Error('模型数据处理线程失败，请重试或下载原文件'));};
  worker.onmessageerror=()=>finish(new Error('模型数据传输失败，请重试或下载原文件'));
  signal?.addEventListener('abort',abort,{once:true});
  try{worker.postMessage(bytes,[bytes]);}catch(error){finish(error);}
 });
}
