import {unpackMetadata} from './compact-transport.js';
import {unpackDwgPacked,expandDwgCompressed} from './dwg-packed-transport.js?v=direct-1';

export async function decodeManifestBytes(bytes, streamCurves = false){
 const start=performance.now(),parsed=JSON.parse(new TextDecoder().decode(bytes)),decoded=performance.now();
 const packet=unpackDwgPacked(await expandDwgCompressed(unpackMetadata(parsed)), streamCurves);
 return {packet,timing:{jsonMS:decoded-start,expandMS:performance.now()-decoded}};
}
