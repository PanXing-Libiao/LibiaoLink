import {unpackMetadata} from './compact-transport.js';
import {unpackDwgPacked,expandDwgCompressed} from './dwg-packed-transport.js';

export async function decodeManifestBytes(bytes){
 const start=performance.now(),parsed=JSON.parse(new TextDecoder().decode(bytes)),decoded=performance.now();
 const packet=unpackDwgPacked(await expandDwgCompressed(unpackMetadata(parsed)));
 return {packet,timing:{jsonMS:decoded-start,expandMS:performance.now()-decoded}};
}
