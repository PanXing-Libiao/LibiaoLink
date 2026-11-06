import {parseChunkBundle, chunkBundleMessages} from "./server-chunks.js?v=dxf-0.17.24";
self.onmessage=({data})=>{
  const id=data?.id;
  try{
    const started=performance.now();
    const parsed=parseChunkBundle(data.bytes,data.row);
    const parseMs=performance.now()-started;
    const {meta,batches}=chunkBundleMessages(parsed);
    const transfer=meta.positions?.byteLength?[meta.positions.buffer]:[];
    self.postMessage({kind:"meta",id,parsed:meta},transfer);
    for(const batch of batches)self.postMessage({kind:"batch",id,batch});
    self.postMessage({kind:"parsed",id,parseMs});
  }catch(error){
    self.postMessage({kind:"error",id,message:String(error?.message||error)});
  }
};
