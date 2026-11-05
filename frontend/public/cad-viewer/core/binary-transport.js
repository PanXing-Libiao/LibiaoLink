/** Transport profile, independent of the UCD 2.0 document contract. */
const MAX_REQUESTS=4,MAX_IN_FLIGHT_BYTES=32*1024*1024;

// Validate the complete inventory before fetching; aliases share immutable bytes.
export function binaryDownloadPlan(manifest){
 if(manifest.transportProfile!=='ucd-binary-manifest/1'||manifest.document?.schemaVersion!=='2.0.0')throw new Error('Unknown binary profile');
 const token=manifest.resourceLease;
 if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Invalid resource lease');
 const defs=manifest.document.buffers,refs=manifest.bufferResources;
 if(!refs||Object.keys(refs).length!==Object.keys(defs).length)throw new Error('Resource inventory mismatch');
 const unique=new Map();let total=0;
 for(const [id,b] of Object.entries(defs)){
  total+=b.byteLength;if(!Number.isSafeInteger(b.byteLength)||b.byteLength<0||total>256*1024*1024)throw new Error('Buffer budget exceeded');
  const ref=refs[id];
  if(!/^[a-f0-9]{64}$/.test(b.sha256)||!ref||ref.url!==`/api/resources/${token}/${b.sha256}`||ref.sha256!==b.sha256||ref.byteLength!==b.byteLength)throw new Error('Invalid resource reference');
  const previous=unique.get(b.sha256);
  if(previous){if(previous.byteLength!==b.byteLength)throw new Error('Conflicting buffer sizes');previous.ids.push(id);}
  else unique.set(b.sha256,{...b,url:ref.url,ids:[id]});
 }
 const resources=[...unique.values()];
 return {resources,totalBytes:resources.reduce((sum,b)=>sum+b.byteLength,0)};
}

export async function hydrateBinary(manifest,{signal,fetcher=fetch,prefetched=new Map(),onPlan=()=>{}}={}){
 // Do not send a release request for an untrusted lease identifier.
 const token=manifest.resourceLease;
 if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Invalid resource lease');
 const controller=new AbortController(),buffers=new Map(),pending=new Set();
 const abort=()=>controller.abort(signal.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let inFlight=0,failure;
 try{
  const plan=binaryDownloadPlan(manifest);onPlan({totalBytes:plan.totalBytes,uniqueBuffers:plan.resources.length});
  async function download(b){
   let raw=null;
   const ready=prefetched.get(b.sha256);
   if(ready!==undefined)try{const value=await ready;if(value?.byteLength===b.byteLength)raw=value;}catch{}
   controller.signal.throwIfAborted();
   if(raw===null){
    const response=await fetcher(b.url,{signal:controller.signal});if(!response.ok)throw new Error("Resource unavailable");
    raw=await response.arrayBuffer();controller.signal.throwIfAborted();
   }
   if(raw.byteLength!==b.byteLength)throw new Error("Buffer length mismatch");
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",raw)),x=>x.toString(16).padStart(2,"0")).join("");
   if(hash!==b.sha256)throw new Error("Buffer hash mismatch");
   controller.signal.throwIfAborted();for(const id of b.ids)buffers.set(id,raw);
  }
  for(const b of plan.resources){
   // An oversized but otherwise legal buffer gets the entire window to itself.
   while(pending.size&&(pending.size>=MAX_REQUESTS||inFlight+b.byteLength>MAX_IN_FLIGHT_BYTES))await Promise.race(pending);
   controller.signal.throwIfAborted();inFlight+=b.byteLength;
   const task=download(b).catch(error=>{if(!controller.signal.aborted){failure=error;controller.abort(error);}})
    .finally(()=>{inFlight-=b.byteLength;pending.delete(task);});
   pending.add(task);
  }
  await Promise.all(pending);controller.signal.throwIfAborted();
  return {...manifest,decodedBuffers:buffers};
 }catch(error){controller.abort(error);throw failure??error;}
 finally{
  await Promise.allSettled(pending);signal?.removeEventListener('abort',abort);
  // Release only after all reads settle, including siblings aborted on failure.
  await fetcher(`/api/resources/${token}`,{method:'DELETE'}).catch(()=>{});
 }
}
