import {expandDwgCompressed} from './dwg-packed-transport.js';
import {unpackMetadata} from './compact-transport.js';
import {archiveCurves} from './dwg-archive-curves.js';

self.onmessage=async({data:{url,source}})=>{
  try {
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw Error();
    const packet=await response.json();
    if(packet.displayOnly || packet.presentation.sourceSHA256!==source)throw Error();
    const {document}=await expandDwgCompressed(unpackMetadata(packet));
    const tables=archiveCurves(document);
    self.postMessage(tables,Object.values(tables).flatMap(t=>[t.handles.buffer,t.values.buffer]));
  }catch{self.postMessage(null);}
};
