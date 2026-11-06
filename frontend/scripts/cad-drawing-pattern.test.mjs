import test from "node:test";
import assert from "node:assert/strict";
import {fillGeometryFor} from "../public/cad-viewer/core/drawing-pattern.js";

test("retained HATCH triangles take precedence over rings", () => {
  const fill = fillGeometryFor({
    draw: {}, entity: {geometry: {type: "hatch", boundaryEntityIds: []}},
    fillEntry: {
      fillRule: "nonzero",
      rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
      triangles: [
        [[0, 0], [10, 0], [10, 10]],
        [[0, 0], [10, 10], [0, 10]]
      ]
    },
    mode: "display", tolerance: 1, representationGeometry: () => null,
    analyticFor: () => null, toWorld: point => point.slice(0, 2),
    boundaryGeometry: () => null
  });
  assert.equal(fill.kind, "triangles");
  assert.equal(fill.fillRule, "nonzero");
  assert.deepEqual(fill.triangles, [
    [[0, 0], [10, 0], [10, 10]],
    [[0, 0], [10, 10], [0, 10]]
  ]);
  assert.deepEqual(fill.bbox, {minX: 0, minY: 0, maxX: 10, maxY: 10});
});

test("retained HATCH rings remain a fallback", () => {
  const fill = fillGeometryFor({
    draw: {}, entity: {geometry: {type: "hatch", boundaryEntityIds: []}},
    fillEntry: {fillRule: "even-odd", rings: [[[0, 0], [5, 0], [5, 5], [0, 5]]]},
    mode: "display", tolerance: 1, representationGeometry: () => null,
    analyticFor: () => null, toWorld: point => point.slice(0, 2),
    boundaryGeometry: () => null
  });
  assert.equal(fill.kind, "rings");
  assert.equal(fill.fillRule, "evenodd");
  assert.equal(fill.rings.length, 1);
});
