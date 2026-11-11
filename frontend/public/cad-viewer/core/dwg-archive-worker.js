import {expandDwgCompressed} from './dwg-packed-transport.js';
import {unpackMetadata} from './compact-transport.js';
import {archiveCurves, readCurveColumns} from './dwg-archive-curves.js';

async function fetchColumns(manifestUrl, source, columns, lease) {
  const resource = new URL('resources/' + lease + '/' + columns.sha256, manifestUrl);
  const response = await fetch(resource, {credentials:'same-origin', cache:'no-store'});
  if (!response.ok) throw Error('Curve resource unavailable');
  const raw = await response.arrayBuffer();
  if (raw.byteLength !== columns.byteLength) throw Error('Curve resource length mismatch');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const sha = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha !== columns.sha256) throw Error('Curve resource digest mismatch');
  self.postMessage(readCurveColumns(raw, source), [raw]);
}

self.onmessage=async({data:{url,source,columns,lease}})=>{
  try {
    if (columns && /^[a-f0-9]{64}$/.test(columns.sha256) && /^[a-f0-9]{48}$/.test(lease)) {
      try {
        await fetchColumns(url, source, columns, lease);
        return;
      } catch {
        // A missing or damaged optional resource can be recovered from the same authorized archive.
      }
    }
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)throw Error();
    const packet=await response.json();
    if(packet.displayOnly || packet.presentation.sourceSHA256!==source)throw Error();
    const {document}=await expandDwgCompressed(unpackMetadata(packet));
    const tables=archiveCurves(document);
    self.postMessage(tables,Object.values(tables).flatMap(t=>[t.handles.buffer,t.values.buffer]));
  }catch{self.postMessage(null);}
};
