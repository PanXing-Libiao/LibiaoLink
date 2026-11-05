import test from "node:test";
import assert from "node:assert/strict";
import {unpackDwgPacked,inflateDwgGeometry} from "../../../../frontend/public/cad-viewer/core/dwg-packed-transport.js";

test("packed display rows use collision-checked keys as deterministic representation ids", () => {
  const strings = ["e1", "H-E1", "lines", "L1", "S1", "H-D1"];
  const envelope = {
    document: {
      drawing: {spaces: {S1: {id: "S1", drawingId: "drawing-1"}}},
      extensions: {"org.cad-preview.style-inheritance/1": {entityState: {}, modes: {}, drawOrder: {}}},
      packed: {
        profile: "ucd-dwg-packed/1", version: "dwg-table/1",
        strings, layers: ["L1"], spaces: ["S1"], styles: [{color: {mode: "by-layer"}}],
        entities: [[0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, {type: "line"}, 0]],
        displays: [[0, 0, 48, 2, 2, 0, 0, 0, 1, 0, 0, 5]],
      },
    },
  };
  const document = unpackDwgPacked(envelope).document;
  const entity = document.drawing.entities.e1;
  assert.equal(entity.displayRepresentationId, "representation-e1");
  assert.equal(document.representations["representation-e1"].bindings[0].geometryId, "g-e1");
  assert.equal(document.geometries["g-e1"].attributes.POSITION, "a-e1");
  assert.equal(document.accessors["a-e1"].byteLength, 48);
});

function indexedEnvelope(){
  return {document:{drawing:{spaces:{}},extensions:{'org.cad-preview.style-inheritance/1':{}},
    packed:{profile:'ucd-dwg-packed/1',version:'dwg-table/2',strings:['e1','lines','H1'],
      layers:[],spaces:[],styles:[],entities:[],displays:[[0,0,72,3,1,0,0,0,1,1,0,2,72,4]]}}};
}
test('indexed display rows preserve distinct vertex and primitive counts',()=>{
  const doc=unpackDwgPacked(indexedEnvelope()).document;
  assert.equal(doc.accessors['a-e1'].count,3);
  assert.deepEqual(doc.geometries['g-e1'].primitives,[{id:'p',topology:'lines',range:{first:0,count:4},indices:'i-e1'}]);
  assert.equal(doc.accessors['i-e1'].byteOffset,72);
  assert.equal(doc.accessors['i-e1'].byteLength,16);
});
test('indexed rows reject invalid ranges, duplicate accessors and legacy profile',()=>{
  for(const bad of ['negative','fraction','overflow','duplicate','legacy']){
    const env=indexedEnvelope();
    if(bad==='negative')env.document.packed.displays[0][12]=-4;
    if(bad==='fraction')env.document.packed.displays[0][13]=1.5;
    if(bad==='overflow')env.document.packed.displays[0][13]=Number.MAX_SAFE_INTEGER;
    if(bad==='duplicate')env.document.accessors={'i-e1':{}};
    if(bad==='legacy')env.document.packed.version='dwg-table/1';
    assert.throws(()=>unpackDwgPacked(env),/packed transport/,bad);
  }
});


test('v3 source geometry chunks inflate exactly and reject invalid blocks', async () => {
 const {deflateSync} = await import('node:zlib');
 const geometry = {type:'polyline',points:[[-0,1e-20,0],[1,2,0]],widths:[[0,0],[0,0]],closed:false};
 const raw=JSON.stringify([geometry]);
 const payload={profile:'ucd-dwg-packed/1',version:'dwg-table/3',entities:[[0,0,0,1,0,0,0,0,1,0,0,0,null,0]],
   geometryChunks:[{first:0,count:1,byteLength:Buffer.byteLength(raw),data:deflateSync(raw).toString('base64')}]};
 const envelope={document:{packed:payload}};
 const expanded=await inflateDwgGeometry(envelope);
 assert.deepEqual(expanded.document.packed.entities[0][12],JSON.parse(raw)[0]);
 assert.equal(envelope.document.packed.entities[0][12],null);
 for(const change of ['short','large','count','overlap','corrupt']) {
   const invalid=structuredClone(envelope),p=invalid.document.packed;
   if(change==='short')p.geometryChunks[0].byteLength--;
   if(change==='large')p.geometryChunks[0].byteLength=1048577;
   if(change==='count')p.geometryChunks[0].count=2;
   if(change==='overlap')p.entities[0][12]={};
   if(change==='corrupt')p.geometryChunks[0].data='bad!';
   await assert.rejects(inflateDwgGeometry(invalid));
 }
 await assert.rejects(async()=>unpackDwgPacked(envelope));
});
