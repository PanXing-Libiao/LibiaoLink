import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hydrateBinary} from '../../../../frontend/public/cad-viewer/core/binary-transport.js';

const raw=Buffer.from("packed-geometry");
const sha=createHash("sha256").update(raw).digest("hex");
const token="a".repeat(48);
const manifest={transportProfile:"ucd-binary-manifest/1",document:{schemaVersion:"2.0.0",buffers:{"buffer-0":{sha256:sha,byteLength:raw.byteLength}}},resourceLease:token,bufferResources:{"buffer-0":{url:"/api/resources/"+token+"/"+sha,sha256:sha,byteLength:raw.byteLength}}};
const arrayBuffer=()=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
const fetcher=(calls)=>async(_url,options={})=>{if(options.method==="DELETE")return new Response("{}");calls.get++;return new Response(raw);};

test("prefetched resource skips duplicate network download and still verifies hash",async()=>{
 const calls={get:0};
 const hydrated=await hydrateBinary(manifest,{fetcher:fetcher(calls),prefetched:new Map([[sha,Promise.resolve(arrayBuffer())]])});
 assert.equal(calls.get,0);
 assert.deepEqual(Buffer.from(hydrated.decodedBuffers.get("buffer-0")),raw);
});

test("corrupt prefetch cannot bypass the manifest hash",async()=>{
 const calls={get:0};const corrupt=Buffer.from(raw);corrupt[0]^=1;
 const prefetched=new Map([[sha,Promise.resolve(corrupt.buffer.slice(corrupt.byteOffset,corrupt.byteOffset+corrupt.byteLength))]]);
 await assert.rejects(hydrateBinary(manifest,{fetcher:fetcher(calls),prefetched}),/hash mismatch/);
 assert.equal(calls.get,0);
});

test("failed or wrong-length prefetch falls back to the checked resource route",async()=>{
 const rejected=Promise.reject(new Error("prefetch failed"));rejected.catch(()=>{});
 for(const pending of [Promise.resolve(new ArrayBuffer(1)),rejected]){
  const calls={get:0};
  const hydrated=await hydrateBinary(manifest,{fetcher:fetcher(calls),prefetched:new Map([[sha,pending]])});
  assert.equal(calls.get,1);
  assert.deepEqual(Buffer.from(hydrated.decodedBuffers.get("buffer-0")),raw);
 }
});
