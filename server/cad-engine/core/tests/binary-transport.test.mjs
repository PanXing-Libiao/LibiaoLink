import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hydrateBinary} from '../../../../frontend/public/cad-viewer/core/binary-transport.js';
const token='a'.repeat(48);
function fixture(values){
 const bodies=new Map(),buffers={},bufferResources={};
 values.forEach((value,i)=>{const raw=Buffer.from(value),sha256=createHash('sha256').update(raw).digest('hex');bodies.set(sha256,raw);buffers['b'+i]={sha256,byteLength:raw.length};bufferResources['b'+i]={...buffers['b'+i],url:`/api/resources/${token}/${sha256}`};});
 return {manifest:{transportProfile:'ucd-binary-manifest/1',resourceLease:token,document:{schemaVersion:'2.0.0',buffers},bufferResources},bodies};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('downloads distinct buffers concurrently with a bound and shares verified duplicate bytes',async()=>{
 const {manifest,bodies}=fixture(['one','two','one','three','four','five','six']);
 let active=0,peak=0,releases=0;const calls=[];
 const result=await hydrateBinary(manifest,{fetcher:async(url,options)=>{
  if(options.method==='DELETE'){assert.equal(active,0);releases++;return new Response();}
  calls.push(url);active++;peak=Math.max(peak,active);await tick();await tick();active--;
  return new Response(bodies.get(url.split('/').at(-1)));
 }});
 assert.ok(peak>1);assert.ok(peak<=4);assert.equal(calls.length,6);assert.equal(releases,1);
 assert.strictEqual(result.decodedBuffers.get('b0'),result.decodedBuffers.get('b2'));
});
test('rejects conflicting sizes for one hash before starting downloads',async()=>{
 const {manifest}=fixture(['same','same']);manifest.document.buffers.b1.byteLength++;manifest.bufferResources.b1.byteLength++;
 let gets=0,releases=0;
 await assert.rejects(hydrateBinary(manifest,{fetcher:async(_,o)=>{if(o.method==='DELETE')releases++;else gets++;return new Response('same');}}));
 assert.equal(gets,0);assert.equal(releases,1);
});
test('a failed download aborts siblings before releasing the lease',async()=>{
 const {manifest}=fixture(['one','two','three','four','five']);let active=0,aborted=0,releases=0;
 await assert.rejects(hydrateBinary(manifest,{fetcher:async(url,o)=>{
  if(o.method==='DELETE'){assert.equal(active,0);releases++;return new Response();}
  if(url===manifest.bufferResources.b0.url){await tick();throw new Error('offline');}
  active++;return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{active--;aborted++;reject(o.signal.reason);},{once:true}));
 }}),/offline/);
 assert.ok(aborted>0);assert.equal(releases,1);
});
test('hash mismatch and caller cancellation never return an accepted artifact',async()=>{
 const {manifest}=fixture(['one']);let releases=0;
 await assert.rejects(hydrateBinary(manifest,{fetcher:async(_,o)=>{if(o.method==='DELETE'){releases++;return new Response();}return new Response('two');}}),/hash mismatch/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(hydrateBinary(manifest,{signal:controller.signal,fetcher:async(_,o)=>{assert.equal(o.method,'DELETE');releases++;return new Response();}}));
 assert.equal(releases,2);
});
test('byte window bounds concurrent bodies and an oversized buffer runs alone',async()=>{
 const {manifest,bodies}=fixture([Buffer.alloc(36*1024*1024,1),Buffer.alloc(20*1024*1024,2),Buffer.alloc(20*1024*1024,3),Buffer.alloc(1024,4)]);
 let bytes=0,count=0,plan;
 await hydrateBinary(manifest,{onPlan:value=>{plan=value;},fetcher:async(url,o)=>{
  if(o.method==='DELETE'){assert.equal(count,0);return new Response();}
  const raw=bodies.get(url.split('/').at(-1));bytes+=raw.length;count++;
  assert.ok(bytes<=32*1024*1024||count===1);
  return {ok:true,async arrayBuffer(){await tick();await tick();bytes-=raw.length;count--;return raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);}};
 }});
 assert.equal(plan.uniqueBuffers,4);assert.equal(plan.totalBytes,76*1024*1024+1024);
});
test('caller abort during concurrent reads waits for cancellation before release',async()=>{
 const {manifest}=fixture(['one','two','three']);const controller=new AbortController();let opened=0,closed=0;
 await assert.rejects(hydrateBinary(manifest,{signal:controller.signal,fetcher:async(_,o)=>{
  if(o.method==='DELETE'){assert.equal(closed,opened);return new Response();}
  opened++;if(opened===2)setImmediate(()=>controller.abort(new Error('closed window')));
  return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{closed++;reject(o.signal.reason);},{once:true}));
 }}),/closed window/);
 assert.ok(opened>=2);
});
