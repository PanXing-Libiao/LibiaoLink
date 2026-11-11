import {decodeManifestBytes} from './manifest-decode.js?v=direct-1';
import {manifestParts} from './manifest-parts.js?v=direct-1';
let parts,timing;
self.onmessage=async({data})=>{
 try{
  if(!parts){const decoded=await decodeManifestBytes(data, true);timing=decoded.timing;parts=manifestParts(decoded.packet);}
  const next=parts.next();
  self.postMessage(next.done?{kind:'done',timing}:next.value);
 }catch{self.postMessage({kind:'error'});}
};
