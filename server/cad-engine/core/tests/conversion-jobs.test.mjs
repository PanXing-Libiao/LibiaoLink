import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const code=await readFile(new URL('../../../../frontend/public/cad-viewer/core/conversion-jobs.js',import.meta.url),'utf8');
const {convertJob}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const id='a'.repeat(32);
test('only completed artifacts become installable and partial is retained',async()=>{
 const calls=[],states=[];
 const responses=[{job:{id,state:'queued'}},{id,state:'running'},{id,state:'completed',completeness:'partial'}];
 const job=await convertJob({},'model=ucd',{fetcher:async url=>{calls.push(url);return {ok:true,json:async()=>responses.shift()};},onProgress:j=>states.push(j.state)});
 assert.equal(job.completeness,'partial');assert.deepEqual(states,['queued','running','completed']);assert.equal(calls.length,3);
});
test('strict rejection details are preserved for the explicit partial offer',async()=>{
 const payload={error:'missing faces',code:'step-strict-incomplete',partialPreviewAvailable:true};
 await assert.rejects(convertJob({},'',{fetcher:async()=>({ok:true,json:async()=>({job:{id,state:'failed',error:payload}})})}),e=>e.payload===payload);
});
test('abort stops polling and never returns an installable result',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(convertJob({},'',{signal:controller.signal,onJob:()=>controller.abort(),fetcher:async()=>{calls++;return {ok:true,json:async()=>({job:{id,state:'queued'}})};}}),e=>e.name==='AbortError');assert.equal(calls,1);
});
