/** Transport profile, independent of the UCD 2.0 document contract. */
export async function hydrateBinary(manifest,{signal,fetcher=fetch}={}){
 if(manifest.transportProfile!=='ucd-binary-manifest/1'||manifest.document?.schemaVersion!=='2.0.0')throw new Error('Unknown binary profile');
 const token=manifest.resourceLease;
 if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Invalid resource lease');
 const buffers=new Map();
 try{
  const defs=manifest.document.buffers,refs=manifest.bufferResources;
  if(!refs||Object.keys(refs).length!==Object.keys(defs).length)throw new Error('Resource inventory mismatch');
  let total=0;for(const b of Object.values(defs)){total+=b.byteLength;if(!Number.isSafeInteger(b.byteLength)||b.byteLength<0||total>256*1024*1024)throw new Error('Buffer budget exceeded');}
  for(const [id,b] of Object.entries(defs)){
   signal?.throwIfAborted();const ref=refs[id];
   if(!/^[a-f0-9]{64}$/.test(b.sha256)||!ref||ref.url!==`/api/resources/${token}/${b.sha256}`||ref.sha256!==b.sha256||ref.byteLength!==b.byteLength)throw new Error('Invalid resource reference');
   const response=await fetcher(ref.url,{signal});if(!response.ok)throw new Error('Resource unavailable');
   const raw=await response.arrayBuffer();if(raw.byteLength!==b.byteLength)throw new Error('Buffer length mismatch');
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),x=>x.toString(16).padStart(2,'0')).join('');
   if(hash!==b.sha256)throw new Error('Buffer hash mismatch');buffers.set(id,raw);
  }
  signal?.throwIfAborted();return {...manifest,decodedBuffers:buffers};
 }finally{
  // A cancelled download must still release its lease (do not reuse aborted signal).
  await fetcher(`/api/resources/${token}`,{method:'DELETE'}).catch(()=>{});
 }
}
