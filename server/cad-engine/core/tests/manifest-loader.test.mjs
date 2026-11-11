import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {decodeManifest} from '../../../../frontend/public/cad-viewer/core/manifest-loader.js';
import {decodeManifestBytes} from '../../../../frontend/public/cad-viewer/core/manifest-decode.js';
const encode=value=>new TextEncoder().encode(JSON.stringify(value)).buffer;
function compact(count){
 const strings=['occ','binding','primitive','present','ready','not-represented','shown','material','owner'];
 const rows=Array.from({length:count},(_,i)=>{strings.push('draw-'+i);return [strings.length-1,0,1,2,3,4,5,6,7,8];});
 return {transportProfile:'ucd-binary-compact/1',document:{renderOwnership:{}},snapshot:{draws:{}},drawTable:{version:'draw-index-table/1',strings,rows,ownershipRemainder:[]}};
}
function workerFactory(){
 const native=new Worker(new URL('./manifest-worker-adapter.mjs',import.meta.url));
 const worker={postMessage:(...args)=>native.postMessage(...args),terminate:()=>native.terminate()};
 native.on('message',data=>worker.onmessage?.({data}));native.on('error',error=>worker.onerror?.(error));
 return worker;
}
test('large compact manifest uses a real worker, transfers input, and preserves full draw identities',async()=>{
 const bytes=encode(compact(30000)),expected=(await decodeManifestBytes(bytes)).packet;
 const pending=decodeManifest(bytes,{workerFactory});
 const {packet,timing}=await pending;assert.equal(bytes.byteLength,0);
 assert.deepEqual(packet,structuredClone(expected));assert.equal(timing.execution,'worker');
 assert.ok(timing.jsonMS>=0&&timing.expandMS>=0&&timing.totalMS>=timing.expandMS);
});
test('small manifest avoids worker startup; malformed JSON and compact dictionaries reject',async()=>{
 const packet=compact(1),result=await decodeManifest(encode(packet),{workerFactory:()=>{throw Error('unexpected worker');}});
 assert.equal(result.timing.execution,'main');assert.equal(Object.keys(result.packet.snapshot.draws).length,1);
 await assert.rejects(decodeManifest(new TextEncoder().encode('{').buffer));
 const invalid=compact(30000);invalid.drawTable.rows[0][1]=-1;
 await assert.rejects(decodeManifest(encode(invalid),{workerFactory}),/展开失败/);
});
test('cancellation terminates pending work; a late completion cannot resolve it',async()=>{
 const controller=new AbortController();let terminated=0,worker;
 const bytes=encode(compact(30000));
 const pending=decodeManifest(bytes,{signal:controller.signal,workerFactory:()=>worker={postMessage(){},terminate(){terminated++;}}});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 worker.onmessage({data:{ok:true,packet:{},timing:{}}});assert.ok(terminated>=1);
 await assert.rejects(decodeManifest(encode({}),{signal:controller.signal}));
});
test('startup error retries once with the original buffer and the real module worker', async()=>{
 const bytes=encode(compact(30000)),expected=(await decodeManifestBytes(bytes)).packet;
 const urls=[];let firstTerminated=false;
 function start(url){
  urls.push(url.href);
  if(urls.length===2){assert.ok(firstTerminated);assert.ok(bytes.byteLength>0);return workerFactory();}
  const worker={terminate(){firstTerminated=true;},postMessage(message){
   assert.equal(message,'start');queueMicrotask(()=>worker.onerror({message:'temporary module failure'}));
  }};
  return worker;
 }
 const {packet}=await decodeManifest(bytes,{workerFactory:start});
 assert.deepEqual(packet,structuredClone(expected));assert.equal(bytes.byteLength,0);
 assert.equal(urls.length,2);assert.notEqual(urls[0],urls[1]);
});

test('persistent startup error retains diagnostics; message and post-transfer failures do not retry', async()=>{
 for(const mode of ['startup','decode','message']){
  let attempts=0,terminated=0;
  const bytes=encode(compact(30000));
  const pending=decodeManifest(bytes,{workerFactory:()=>{
   attempts++;
   const w={terminate(){terminated++;},postMessage(message,transfer){
    if(mode==='message'){queueMicrotask(()=>w.onmessageerror());return;}
    if(mode==='decode'&&message==='start'){queueMicrotask(()=>w.onmessage({data:{kind:'ready'}}));return;}
    if(transfer)structuredClone(message,{transfer});
    queueMicrotask(()=>w.onerror({message:'script failed',filename:'module.js',lineno:7,colno:3}));
   }};return w;
  }});
  await assert.rejects(pending,error=>{
   if(mode==='message')return /传输失败/.test(error.message);
   assert.equal(error.cause.phase,mode==='startup'?'worker-start':'worker-decode');
   assert.equal(error.cause.attempt,mode==='startup'?2:1);
   assert.equal(error.cause.filename,'module.js');assert.equal(error.cause.line,7);
   return /处理线程失败/.test(error.message);
  });
  assert.equal(attempts,mode==='startup'?2:1);assert.equal(terminated,attempts);
  assert.equal(bytes.byteLength===0,mode==='decode');
 }
 await assert.rejects(decodeManifest(encode(compact(30000)),{workerFactory(){throw Error('constructor');}}),/constructor/);
});

test('closing the view between startup failure and retry leaves the input untransferred', async()=>{
 const c=new AbortController(),bytes=encode(compact(30000));let attempts=0;
 const pending=decodeManifest(bytes,{signal:c.signal,workerFactory:()=>{
  attempts++;const w={terminate(){},postMessage(){queueMicrotask(()=>{w.onerror({});c.abort();});}};return w;
 }});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(attempts,1);assert.ok(bytes.byteLength>0);
});

test('DWG packed geometry and style tables survive batched worker handoff without mutation',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('./manifest-dwg-fixture.json',import.meta.url),'utf8'));
 // Force the worker threshold without duplicating domain entities or identities.
 fixture.padding=' '.repeat(1024*1024);
 const raw=encode(fixture),expected=(await decodeManifestBytes(raw)).packet;
 const {packet}=await decodeManifest(raw,{workerFactory});
 assert.deepEqual(packet,structuredClone(expected));assert.equal(packet.document.packed,undefined);
 assert.ok(Object.keys(packet.document.representations).length>0);
 assert.ok(Object.keys(packet.document.drawing.entities).length>0);
});

test('worker batches preserve special dictionary keys as own data properties',async()=>{
 const source=compact(30000);
 source.document.properties=JSON.parse('{"__proto__":{"label":"source value"},"constructor":{"label":"constructor value"},"toString":{"label":"own method name"}}');
 const expected=(await decodeManifestBytes(encode(source))).packet;
 const {packet}=await decodeManifest(encode(source),{workerFactory});
 assert.deepEqual(packet,structuredClone(expected));
 assert.equal(Object.getPrototypeOf(packet.document.properties),Object.prototype);
 assert.equal(Object.getOwnPropertyDescriptor(packet.document.properties,'__proto__').value.label,'source value');
 assert.equal({}.label,undefined);
});

test('batched handoff preserves insertion order and keeps one bounded part per acknowledgement',async()=>{
 const {manifestParts,applyManifestEntries}=await import('../../../../frontend/public/cad-viewer/core/manifest-parts.js');
 const input={document:{properties:Object.fromEntries(Array.from({length:8193},(_,i)=>['p-'+i,{id:i}]))}};
 let packet,parts=0;
 for(const part of manifestParts(input)){
  const message=structuredClone(part);
  if(message.kind==='header')packet=message.packet;
  else {assert.ok(message.entries.length/2<=1024);applyManifestEntries(packet,message);parts++;}
 }
 assert.ok(parts<16,'handoff should amortize per-message overhead');
 assert.deepEqual(packet,input);assert.deepEqual(Object.keys(packet.document.properties),Object.keys(input.document.properties));
});

test('live reader pens preserve inherited weights across batches without sharing curve geometry',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('./manifest-dwg-fixture.json',import.meta.url),'utf8'));
 fixture.displayOnly=true;
 const packed=fixture.document.packed;
 const mode={lineType:'by-block',lineWeight:'by-layer'};
 packed.curvePens=[[{color:{mode:'by-block'},plot:true},mode,-1,0,-1]];
 packed.curveRows=Array.from({length:1025},(_,i)=>['live'+i,i%2?'arc':'line','space-1','layer-0',0,i,i!==1,0.5,i*48,2]);
 const {packet:local}=await decodeManifest(encode(fixture));
 fixture.padding=' '.repeat(1024*1024);
 const {packet:worker}=await decodeManifest(encode(fixture),{workerFactory});delete worker.padding;
 assert.deepEqual(worker,structuredClone(local));
 const doc=worker.document,entities=doc.drawing.entities,ext=doc.extensions['org.cad-preview.style-inheritance/1'];
 assert.equal(entities['entity-live0'].style,entities['entity-live1024'].style);
 assert.notEqual(entities['entity-live0'].geometry,entities['entity-live1024'].geometry);
 assert.deepEqual(ext.modes['entity-live1'],mode);
 assert.deepEqual(ext.entityState['entity-live1'],{invisible:true,lineTypeScale:.5,nativeLineWeight:-1,drawOrder:1,nativeColor:{index:0,trueColor:-1}});
 assert.deepEqual(worker.displayRows['representation-entity-live1024'],[49152,2,'lines']);
 assert.equal(worker.deferredCurves,true);
});
