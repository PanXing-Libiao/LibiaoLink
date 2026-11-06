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
  const document = unpackDwgPacked(envelope).document;
  const entity = document.drawing.entities.e1;
  assert.equal(entity.displayRepresentationId, "representation-e1");
  assert.equal(document.representations["representation-e1"].bindings[0].geometryId, "g-e1");
  assert.equal(document.geometries["g-e1"].attributes.POSITION, "a-e1");
  assert.equal(document.accessors["a-e1"].byteLength, 48);
});
