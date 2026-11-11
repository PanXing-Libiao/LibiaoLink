import test from "node:test";
import assert from "node:assert/strict";
import {unpackDwgPacked} from "../../../../frontend/public/cad-viewer/core/dwg-packed-transport.js";

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
  const preview = unpackDwgPacked({...envelope, displayOnly:true});
  const id = preview.document.drawing.entities.e1.displayRepresentationId;
  assert.deepEqual(preview.displayRows[id], [0,2,envelope.document.packed.strings[2]]);
  assert.equal(preview.document.representations[id], undefined);
  const document = unpackDwgPacked(envelope).document;
  const entity = document.drawing.entities.e1;
  assert.equal(entity.displayRepresentationId, "representation-e1");
  assert.equal(document.representations["representation-e1"].bindings[0].geometryId, "g-e1");
  assert.equal(document.geometries["g-e1"].attributes.POSITION, "a-e1");
  assert.equal(document.accessors["a-e1"].byteLength, 48);
});

test("archive handoff matches full-width DWG handles and keeps native and drawing coordinates distinct",async()=>{
  const {archiveCurves,restoreCurve}=await import("../../../../frontend/public/cad-viewer/core/dwg-archive-curves.js");
  const a="entity-FFFFFFFFFFFFFFFE",b="entity-FFFFFFFFFFFFFFFF";
  const g={type:"arc",center:[-6,2,1],normal:[0,1,0],xAxis:[-1,0,0],radius:5,startAngle:-1,sweepAngle:2};
  const n={type:"arc",center:[6,1,2],normal:[0,2,0],radius:5,startAngle:-1,endAngle:1};
  const l={type:"line",start:[8,5,0],end:[9,6,0]};
  const row=[];row[0]=0;row[12]=g;
  const tables=archiveCurves({packed:{strings:[b],entities:[row]},drawing:{entities:{[a]:{geometry:l}}},
    extensions:{"org.libiaolink.dwg/1":{nativeGeometry:{[b]:n}}}});
  const native={};
  for(const [key,geometry] of [[a,l],[b,g]]) {
    const entity={id:key,sourceRefs:[{objectKey:key.slice(7)}],geometry:{type:geometry.type,displayOnly:true}};
    restoreCurve(tables,entity,native);
    assert.deepEqual(entity.geometry,geometry);
  }
  assert.deepEqual(native,{[b]:n});
});
