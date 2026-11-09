import {decodeManifestBytes} from './manifest-decode.js';
import {manifestParts} from './manifest-parts.js?v=cad-handoff-1';
let parts,timing;
self.onmessage=async({data})=>{
 try{
  if(!parts){const decoded=await decodeManifestBytes(data);timing=decoded.timing;parts=manifestParts(decoded.packet);}
  const next=parts.next();
  self.postMessage(next.done?{kind:'done',timing}:next.value);
 }catch{self.postMessage({kind:'error'});}
};
