import test from "node:test";
import assert from "node:assert/strict";
import {
  SERVER_CHUNKS_EXTENSION, applyChunkBatch, bindOverviewRepresentations, chunkBundleMessages, chunkIndex,
  createServerChunkController, isServerChunked, mergeChunkDocument, mergeChunkDocumentInSlices, parseChunkBundle,
} from "../public/cad-viewer/core/server-chunks.js";

const encoder = new TextEncoder();
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const lease = "a".repeat(48);

function emptyChunkDocument() {
  return {
    schemaVersion: "2.0.0",
    drawing: { spaces: {}, entities: {}, blockInstances: {}, annotations: {}, blocks: {} },
    accessors: {}, geometries: {}, representations: {}, extensions: {},
  };
}

async function digest(bytes) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function artifact({ id, kind, spaceId, bounds, dependencies = [], removeOverview = [], document, positions = new Uint8Array() }) {
  const bufferId = "buffer-" + id;
  if (positions.byteLength) document.buffers = {
    [bufferId]: { id: bufferId, sha256: await digest(positions), byteLength: positions.byteLength },
  };
  const chunk = {
    version: "ucd-dwg-chunk/1", id, kind, bounds, dependencies, removeOverview,
    buffer: positions.byteLength ? { id: bufferId, sha256: await digest(positions), byteLength: positions.byteLength } : null,
    counts: { entities: 0, instances: 0, annotations: 0, blocks: 0, spaces: 0 }, document,
  };
  const json = encoder.encode(JSON.stringify(chunk));
  const bytes = new Uint8Array(12 + json.byteLength + positions.byteLength);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x31574443, true);
  header.setUint32(4, json.byteLength, true);
  header.setUint32(8, positions.byteLength, true);
  bytes.set(json, 12); bytes.set(positions, 12 + json.byteLength);
  const resourceId = "chunk-" + id;
  const row = { id, kind, spaceId, bounds, always: false, dependencies, removeOverview, counts: chunk.counts,
    resourceId, resourceSHA256: await digest(bytes), resourceBytes: bytes.byteLength,
    documentBytes: json.byteLength, positionBytes: positions.byteLength };
  const resource = { id: resourceId, sha256: row.resourceSHA256, byteLength: bytes.byteLength,
    contentType: "application/vnd.libiaolink.dwg-chunk/1", url: "/api/resources/" + lease + "/" + row.resourceSHA256 };
  return { row, resource, bytes, chunk };
}

function baseEnvelope(rows, overviewIds = ["overview-e-0", "overview-e-1"]) {
  const representations = {}, overviewRepresentations = {};
  for (const [index, id] of overviewIds.entries()) {
    const representationId = "overview-r-" + index;
    representations[representationId] = { id: representationId, kind: "drawing", bindings: [], sourceRefs: [] };
    overviewRepresentations[id] = representationId;
  }
  const extension = {
    version: "ucd-dwg-chunks/1", modelSpaceId: "space-model", bounds: [0, 0, 200, 200],
    detailScaleRatio: 1.6, detailMinPixels: 96,
    tiles: rows.filter(row => row.kind === "tile"), layouts: rows.filter(row => row.kind === "layout"),
    blocks: rows.filter(row => row.kind === "block"),
    overview: { bufferId: "buffer-chunk-overview", entityIds: overviewIds, representations: overviewRepresentations },
    resourceCount: rows.length, resourceBytes: rows.reduce((sum, row) => sum + row.resourceBytes, 0),
  };
  const entities = {};
  for (const id of overviewIds) entities[id] = {
    id, drawingId: "drawing-dwg", ownerSpaceId: "space-model", layerId: "layer-0", localFromOwner: IDENTITY,
    geometry: { type: "line", start: [0, 0, 0], end: [1, 1, 0] },
    style: { color: { mode: "by-layer" }, plot: true }, displayOrder: 0,
  };
  return {
    transportProfile: "ucd-binary-manifest/1", resourceLease: lease,
    presentation: { unit: "mm" }, snapshot: { completeness: "partial" },
    chunkResources: [],
    document: {
      schemaVersion: "2.0.0", revision: "revision",
      drawing: {
        drawings: { "drawing-dwg": { modelSpaceId: "space-model" } },
        spaces: { "space-model": { id: "space-model", drawingId: "drawing-dwg", kind: "model",
          entityIds: overviewIds, blockInstanceIds: [], annotationIds: [] } },
        entities, blockInstances: {}, annotations: {}, blocks: {},
        layers: { "layer-0": { id: "layer-0", drawingId: "drawing-dwg", name: "0", visible: true, plot: true,
          defaultStyle: { color: { mode: "by-layer" } } } },
        layouts: {}, viewports: {},
      },
      accessors: {}, geometries: {}, representations,
      buffers: { "buffer-chunk-overview": { id: "buffer-chunk-overview", sha256: "0".repeat(64), byteLength: 0 } },
      extensions: { [SERVER_CHUNKS_EXTENSION]: extension },
    },
  };
}

function attachResources(envelope, artifacts) {
  envelope.chunkResources = artifacts.map(item => item.resource);
}

function responseFor(artifacts, calls) {
  return async url => {
    calls.push(url);
    const artifact = artifacts.find(item => url.endsWith(item.row.resourceSHA256));
    if (!artifact) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => artifact.bytes.buffer.slice(artifact.bytes.byteOffset, artifact.bytes.byteOffset + artifact.bytes.byteLength) };
  };
}

async function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for server chunks");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("chunk position bytes are realigned for Float64Array accessors", async () => {
  const coords = [0, 0, 0, 1.5, 2.5, 3.5];
  const positions = new Uint8Array(Float64Array.from(coords).buffer);
  let tile = null;
  for (const suffix of ["", "a", "b", "c", "d", "e", "f", "g"]) {
    const id = "tile-align" + suffix;
    const candidate = await artifact({ id, kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
      document: emptyChunkDocument(), positions });
    if ((12 + candidate.row.documentBytes) % 8 !== 0) { tile = candidate; break; }
  }
  assert.ok(tile, "test fixture must produce a misaligned bundle");
  const parsed = parseChunkBundle(tile.bytes, tile.row);
  assert.equal(parsed.positions.byteOffset % Float64Array.BYTES_PER_ELEMENT, 0);
  const values = new Float64Array(parsed.positions.buffer, parsed.positions.byteOffset, coords.length);
  assert.deepEqual([...values], coords);
});

test("overview representations bind before chunk hydration and remain idempotent", async () => {
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row], ["overview-e-0"]);
  assert.equal(bindOverviewRepresentations(envelope), 1);
  assert.equal(envelope.document.drawing.entities["overview-e-0"].displayRepresentationId, "overview-r-0");
  assert.equal(bindOverviewRepresentations(envelope), 0);
  assert.doesNotThrow(() => chunkIndex(envelope));
});

test("chunk index accepts a dependency DAG and rejects a cycle", async () => {
  const block = await artifact({ id: "block-pack-000", kind: "block", spaceId: null, bounds: [0, 0, 1, 1],
    document: emptyChunkDocument() });
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    dependencies: ["block-pack-000"], removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row, block.row], ["overview-e-0"]);
  attachResources(envelope, [tile, block]);
  const index = chunkIndex(envelope);
  assert.equal(envelope.document.drawing.entities["overview-e-0"].displayRepresentationId, "overview-r-0");
  assert.equal(index.rows.length, 2);
  assert.deepEqual(index.byId.get("tile-000").dependencies, ["block-pack-000"]);
  envelope.document.extensions[SERVER_CHUNKS_EXTENSION].tiles[0].dependencies = ["block-pack-000"];
  envelope.document.extensions[SERVER_CHUNKS_EXTENSION].blocks[0].dependencies = ["tile-000"];
  assert.throws(() => chunkIndex(envelope), /dependency cycle/);
});

test("chunk index rejects an incomplete overview representation map", async () => {
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row], ["overview-e-0"]);
  delete envelope.document.extensions[SERVER_CHUNKS_EXTENSION].overview.representations["overview-e-0"];
  assert.throws(() => chunkIndex(envelope), /representation index/);
});

test("bundle parsing and merge retain overview fallback geometry", async () => {
  const detailDocument = emptyChunkDocument();
  detailDocument.drawing.entities["detail-e-0"] = { id: "detail-e-0", drawingId: "drawing-dwg", ownerSpaceId: "space-model",
    layerId: "layer-0", localFromOwner: IDENTITY, geometry: { type: "line", start: [2, 2, 0], end: [3, 3, 0] },
    style: { color: { mode: "by-layer" }, plot: true }, displayOrder: 0 };
  detailDocument.drawing.spaces["space-model"] = { id: "space-model", drawingId: "drawing-dwg", entityIds: ["detail-e-0"] };
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    removeOverview: ["overview-e-0"], document: detailDocument });
  const tile2 = await artifact({ id: "tile-001", kind: "tile", spaceId: "space-model", bounds: [10, 10, 20, 20],
    removeOverview: ["overview-e-1"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row, tile2.row]);
  attachResources(envelope, [tile, tile2]);
  assert.equal(isServerChunked(envelope), true);
  const parsed = parseChunkBundle(tile.bytes, tile.row);
  const result = mergeChunkDocument(envelope, parsed);
  assert.equal(result.removedOverview, 1);
  assert.ok(envelope.document.drawing.entities["overview-e-0"]);
  assert.ok(envelope.document.drawing.entities["overview-e-1"]);
  assert.ok(envelope.document.drawing.entities["detail-e-0"]);
  assert.deepEqual(envelope.document.drawing.spaces["space-model"].entityIds,
    ["overview-e-0", "overview-e-1", "detail-e-0"]);
  assert.throws(() => parseChunkBundle(tile.bytes.subarray(1), tile.row), /length mismatch/);
});

test("sliced merge keeps overview records available for zoom-out", async () => {
  const tile = await artifact({ id: "tile-sliced", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row], ["overview-e-0"]);
  const result = await mergeChunkDocumentInSlices(envelope, parseChunkBundle(tile.bytes, tile.row),
    { yieldToMain: async () => { await Promise.resolve(); } });
  assert.equal(result.removedOverview, 1);
  assert.ok(envelope.document.drawing.entities["overview-e-0"]);
});

test("a conflicting chunk is rejected before any document table is mutated", async () => {
  const document = emptyChunkDocument();
  document.drawing.entities["overview-e-0"] = { id: "overview-e-0", changed: true };
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 10, 10],
    removeOverview: ["overview-e-0"], document });
  const envelope = baseEnvelope([tile.row]);
  attachResources(envelope, [tile]);
  const before = JSON.stringify(envelope.document);
  assert.throws(() => mergeChunkDocument(envelope, parseChunkBundle(tile.bytes, tile.row)), /conflicting entity/);
  assert.equal(JSON.stringify(envelope.document), before);
});

test("controller loads only intersecting detail tiles after the LOD threshold", async () => {
  const near = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const far = await artifact({ id: "tile-001", kind: "tile", spaceId: "space-model", bounds: [1000, 1000, 1100, 1100],
    removeOverview: ["overview-e-1"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([near.row, far.row]);
  attachResources(envelope, [near, far]);
  let scale = 1, applies = 0, releases = 0;
  const calls = [];
  const controller = createServerChunkController({ envelope, ready: Promise.resolve(),
    viewportBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }), scale: () => scale, fitScale: () => 1,
    currentSpace: () => ({ kind: "model", spaceId: "space-model" }), fetch: responseFor([near, far], calls),
    apply: async () => { applies += 1; }, release: async () => { releases += 1; } });
  controller.start();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(calls.length, 0, "detail load waits for the scale threshold");
  scale = 2;
  controller.update();
  await waitFor(() => controller.record().applied > 0);
  assert.deepEqual(controller.record().loaded, ["tile-000"]);
  assert.equal(applies, 1);
  controller.destroy();
  assert.equal(releases, 1);
});

test("controller holds chunk parsing and apply until the viewer is idle", async () => {
  const near = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([near.row], ["overview-e-0"]);
  attachResources(envelope, [near]);
  let canWork = false, applies = 0;
  const calls = [];
  const controller = createServerChunkController({ envelope, ready: Promise.resolve(),
    viewportBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }), scale: () => 2, fitScale: () => 1,
    currentSpace: () => ({ kind: "model", spaceId: "space-model" }), fetch: responseFor([near], calls),
    apply: async () => { applies += 1; }, canWork: () => canWork, release: async () => {} });
  controller.start();
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(calls.length, 0, "gesture pause suppresses detail fetch");
  assert.equal(applies, 0);
  canWork = true;
  controller.update();
  await waitFor(() => controller.record().applied > 0);
  assert.equal(calls.length, 1);
  assert.equal(applies, 1);
  controller.destroy();
});

test("controller wakes a paper-space layout chunk as soon as that layout is active", async () => {
  const layout = await artifact({ id: "layout-000", kind: "layout", spaceId: "space-paper", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([layout.row], ["overview-e-0"]);
  envelope.document.drawing.layouts = { "layout-1": { id: "layout-1", paperSpaceId: "space-paper" } };
  attachResources(envelope, [layout]);
  let applies = 0;
  const calls = [];
  const controller = createServerChunkController({ envelope, ready: Promise.resolve(),
    viewportBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }), scale: () => 1, fitScale: () => 1,
    currentSpace: () => ({ kind: "layout", layoutId: "layout-1" }), fetch: responseFor([layout], calls),
    apply: async () => { applies += 1; }, release: async () => {} });
  controller.start();
  await waitFor(() => controller.record().applied > 0);
  assert.deepEqual(controller.record().loaded, ["layout-000"]);
  assert.equal(applies, 1);
  assert.ok(envelope.document.drawing.entities["overview-e-0"]);
  assert.equal(controller.record().overviewRemoved, 1);
  controller.destroy();
});

test("controller fetches a block dependency before its tile and applies one merged pass", async () => {
  const block = await artifact({ id: "block-pack-000", kind: "block", spaceId: null, bounds: [0, 0, 100, 100],
    document: emptyChunkDocument() });
  const tile = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    dependencies: ["block-pack-000"], removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([tile.row, block.row], ["overview-e-0"]);
  attachResources(envelope, [tile, block]);
  const calls = [];
  let applies = 0;
  const controller = createServerChunkController({ envelope, ready: Promise.resolve(),
    viewportBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }), scale: () => 2, fitScale: () => 1,
    currentSpace: () => ({ kind: "model", spaceId: "space-model" }), fetch: responseFor([tile, block], calls),
    apply: async () => { applies += 1; }, release: async () => {} });
  controller.start();
  await waitFor(() => controller.record().applied >= 2);
  assert.deepEqual(calls.map(url => url.split("/").at(-1)), [block.row.resourceSHA256, tile.row.resourceSHA256]);
  assert.equal(applies, 1);
  assert.equal(controller.record().applyFailures, 0);
  controller.destroy();
});

class FakeChunkWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.count = 0; this.terminated = false; }
  postMessage(message) {
    this.count += 1;
    setTimeout(() => {
      try {
        const parsed = parseChunkBundle(message.bytes, message.row);
        this.onmessage?.({data: {kind: "parsed", id: message.id, parsed, parseMs: 0.5}});
      } catch (error) {
        this.onmessage?.({data: {kind: "error", id: message.id, message: String(error)}});
      }
    }, 0);
  }
  terminate() { this.terminated = true; }
}

test("controller parses chunk bundles in the worker and reports execution", async () => {
  const near = await artifact({ id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document: emptyChunkDocument() });
  const envelope = baseEnvelope([near.row], ["overview-e-0"]);
  attachResources(envelope, [near]);
  const worker = new FakeChunkWorker();
  let applies = 0;
  const controller = createServerChunkController({ envelope, ready: Promise.resolve(),
    viewportBounds: () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }), scale: () => 2, fitScale: () => 1,
    currentSpace: () => ({ kind: "model", spaceId: "space-model" }), fetch: responseFor([near], []),
    createParseWorker: () => worker, apply: async () => { applies += 1; }, release: async () => {} });
  controller.start();
  await waitFor(() => controller.record().applied > 0);
  const record = controller.record();
  assert.equal(worker.count, 1);
  assert.equal(record.parseExecution, "worker");
  assert.equal(record.parseWorker, true);
  assert.equal(record.lastParseWorkerMs, 0.5);
  assert.equal(applies, 1);
  controller.destroy();
  assert.equal(worker.terminated, true);
});

test("large worker parse results are split into independently cloned batches", async () => {
  const document = emptyChunkDocument();
  document.drawing.entities = Object.fromEntries(Array.from({length: 700}, (_, index) => ["entity-" + index, {
    id: "entity-" + index, layerId: "layer-0", localFromOwner: IDENTITY,
    geometry: {type: "line", start: [index, index, 0], end: [index + 1, index + 1, 0]},
    style: {color: {mode: "by-layer"}, plot: true},
  }]));
  document.drawing.spaces["space-model"] = {id: "space-model", drawingId: "drawing-dwg", kind: "model",
    entityIds: Object.keys(document.drawing.entities), blockInstanceIds: [], annotationIds: []};
  document.extensions = {"org.cad-preview.style-inheritance/1": {
    entityState: Object.fromEntries(Array.from({length: 700}, (_, index) => ["entity-" + index, {opacityMode: "explicit", opacity: 1}])),
    values: Array.from({length: 700}, (_, index) => index),
  }};
  const near = await artifact({id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document});
  const parsed = parseChunkBundle(near.bytes, near.row);
  const {meta, batches} = chunkBundleMessages(parsed);
  assert.ok(batches.length > 8);
  assert.equal(meta.chunk.document, undefined);
  assert.ok(batches.every(batch => batch.kind !== "entries" || batch.entries.length <= 256));
  const reconstructed = structuredClone(meta);
  for (const batch of batches) applyChunkBatch(reconstructed.document, structuredClone(batch));
  assert.deepEqual(reconstructed.document, parsed.document);
});

class FakeBatchChunkWorker extends FakeChunkWorker {
  postMessage(message) {
    this.count += 1;
    setTimeout(() => {
      try {
        const parsed = parseChunkBundle(message.bytes, message.row);
        const {meta, batches} = chunkBundleMessages(parsed);
        this.onmessage?.({data: {kind: "meta", id: message.id, parsed: meta}});
        for (const batch of batches) this.onmessage?.({data: {kind: "batch", id: message.id, batch}});
        this.onmessage?.({data: {kind: "parsed", id: message.id, parseMs: 0.5}});
      } catch (error) {
        this.onmessage?.({data: {kind: "error", id: message.id, message: String(error)}});
      }
    }, 0);
  }
}

test("controller reconstructs a batched worker result before merging", async () => {
  const document = emptyChunkDocument();
  document.drawing.entities = Object.fromEntries(Array.from({length: 300}, (_, index) => ["entity-" + index, {
    id: "entity-" + index, layerId: "layer-0", localFromOwner: IDENTITY,
    geometry: {type: "line", start: [index, index, 0], end: [index + 1, index + 1, 0]},
    style: {color: {mode: "by-layer"}, plot: true},
  }]));
  const near = await artifact({id: "tile-000", kind: "tile", spaceId: "space-model", bounds: [0, 0, 100, 100],
    removeOverview: ["overview-e-0"], document});
  const envelope = baseEnvelope([near.row], ["overview-e-0"]);
  attachResources(envelope, [near]);
  const worker = new FakeBatchChunkWorker();
  let applies = 0;
  const controller = createServerChunkController({envelope, ready: Promise.resolve(),
    viewportBounds: () => ({minX: 0, minY: 0, maxX: 100, maxY: 100}), scale: () => 2, fitScale: () => 1,
    currentSpace: () => ({kind: "model", spaceId: "space-model"}), fetch: responseFor([near], []),
    createParseWorker: () => worker, apply: async () => { applies += 1; }, release: async () => {}});
  controller.start();
  await waitFor(() => controller.record().applied > 0);
  assert.equal(controller.record().applyFailures, 0);
  assert.equal(applies, 1);
  assert.equal(envelope.document.drawing.entities["entity-299"].id, "entity-299");
  controller.destroy();
});
