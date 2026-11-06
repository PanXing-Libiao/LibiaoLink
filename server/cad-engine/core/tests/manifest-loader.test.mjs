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
 const bytes=encode(compact(30000)),expected=decodeManifestBytes(bytes).packet;
 const pending=decodeManifest(bytes,{workerFactory});assert.equal(bytes.byteLength,0);
 const {packet,timing}=await pending;
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
test('worker startup, script and message failures reject without a main-thread fallback',async()=>{
 const bytes=()=>encode(compact(30000));
 await assert.rejects(decodeManifest(bytes(),{workerFactory:()=>{throw Error('startup');}}),/startup/);
 for(const kind of ['onerror','onmessageerror']){
  let terminated=0;
  await assert.rejects(decodeManifest(bytes(),{workerFactory:()=>{const w={terminate(){terminated++;},postMessage(){queueMicrotask(()=>w[kind]({}));}};return w;}}));
  assert.equal(terminated,1);
 }
});

test('DWG packed geometry and style tables survive batched worker handoff without mutation',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('./manifest-dwg-fixture.json',import.meta.url),'utf8'));
 // Force the worker threshold without duplicating domain entities or identities.
 fixture.padding=' '.repeat(1024*1024);
 const raw=encode(fixture),expected=decodeManifestBytes(raw).packet;
 const {packet}=await decodeManifest(raw,{workerFactory});
 assert.deepEqual(packet,structuredClone(expected));assert.equal(packet.document.packed,undefined);
 assert.ok(Object.keys(packet.document.representations).length>0);
 assert.ok(Object.keys(packet.document.drawing.entities).length>0);
});

test('worker batches preserve special dictionary keys as own data properties',async()=>{
 const source=compact(30000);
 source.document.properties=JSON.parse('{"__proto__":{"label":"source value"},"constructor":{"label":"constructor value"},"toString":{"label":"own method name"}}');
 const expected=decodeManifestBytes(encode(source)).packet;
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

test('worker batches preserve special dictionary keys as own data properties',async()=>{
 const source=compact(30000);
 source.document.properties=JSON.parse('{"__proto__":{"label":"source value"},"constructor":{"label":"constructor value"},"toString":{"label":"own method name"}}');
 const expected=decodeManifestBytes(encode(source)).packet;
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
