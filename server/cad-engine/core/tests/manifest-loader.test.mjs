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
 const raw=encode(fixture),expected=(await decodeManifestBytes(raw)).packet;
 const {packet}=await decodeManifest(raw,{workerFactory});
 assert.deepEqual(packet,structuredClone(expected));assert.equal(packet.document.packed,undefined);
 assert.ok(Object.keys(packet.document.representations).length>0);
 assert.ok(Object.keys(packet.document.drawing.entities).length>0);
});


test('v3 compressed source geometry survives a real worker and small-load cancellation',async()=>{
 const {readFile}=await import('node:fs/promises'),{deflateSync}=await import('node:zlib');
 const fixture=JSON.parse(await readFile(new URL('./manifest-dwg-fixture.json',import.meta.url),'utf8'));
 const payload=fixture.document.packed,geometries=payload.entities.map(row=>row[12]);
 const raw=JSON.stringify(geometries);
 payload.version='dwg-table/3';
 payload.geometryChunks=[{first:0,count:geometries.length,byteLength:Buffer.byteLength(raw),data:deflateSync(raw).toString('base64')}];
 for(const row of payload.entities)row[12]=null;
 fixture.padding=' '.repeat(1024*1024);
 const {packet}=await decodeManifest(encode(fixture),{workerFactory});
 assert.equal(packet.document.packed,undefined);
 for(let i=0;i<payload.entities.length;i++){
   const key=payload.strings[payload.entities[i][0]];
   assert.deepEqual(packet.document.drawing.entities[key].geometry,geometries[i]);
 }
 delete fixture.padding;
 const controller=new AbortController();
 const pending=decodeManifest(encode(fixture),{signal:controller.signal,workerFactory:()=>{throw Error('unexpected worker');}});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
});
