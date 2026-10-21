/** Local STEP job lifecycle. A verified partial artifact remains partial. */
export async function convertJob(file,query,{signal,onJob,onProgress,fetcher=fetch}={}){
 const states=new Set(['queued','running','completed','failed','cancelled','timed-out']);
 const read=async response=>{const data=await response.json();if(!response.ok){const error=new Error(data.error||'转换请求失败');error.payload=data;throw error;}return data;};
 const created=await read(await fetcher('/api/jobs?'+query,{method:'POST',body:file,signal}));
 let job=created.job;
 if(!job||!/^[a-f0-9]{32}$/.test(job.id))throw new Error('转换任务响应无效');
 // The POST may have reached the server just before AbortController fired. If
 // its response was received, retain the job handle and propagate cancellation.
 onJob?.(job.id,created.reused);signal?.throwIfAborted();
 for(;;){
  if(!states.has(job.state))throw new Error('未知转换任务状态');
  onProgress?.(job);
  if(job.state==='completed')return job;
  if(['failed','cancelled','timed-out'].includes(job.state)){
   const payload=job.error||{error:'转换任务已停止',code:job.state};
   const error=new Error(payload.error||'转换失败');error.payload=payload;throw error;
  }
  await new Promise((resolve,reject)=>{
   const abort=()=>{clearTimeout(timer);reject(signal.reason||new DOMException('Aborted','AbortError'));};
   const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},350);
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  job=await read(await fetcher('/api/jobs/'+job.id,{signal}));
 }
}
