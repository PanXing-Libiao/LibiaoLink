export const SERVER_CHUNKS_EXTENSION = "org.cad-preview.server-chunks/1";
const CHUNK_VERSION = "ucd-dwg-chunk/1";
const BUNDLE_VERSION = "ucd-dwg-chunks/1";
const HEADER_BYTES = 12;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_POSITION_BYTES = 256 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const MAX_PARALLEL_FETCHES = 3;
const MAX_UNPUBLISHED_CHUNKS = 96;
const FETCH_RETRY_MS = 8000;
const BUNDLE_MAGIC = 0x31574443;

function fail(message) { throw new Error("server chunks: " + message); }
function bytesOf(value) { return value instanceof Uint8Array ? value : new Uint8Array(value); }
function alignedBytes(value, alignment) {
  const bytes = bytesOf(value);
  if (bytes.byteOffset % alignment === 0) return bytes;
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return aligned;
}
function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function* equalValueSteps(left, right, state) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (typeof left !== "object") return Number.isNaN(left) && Number.isNaN(right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!(yield* equalValueSteps(left[key], right[key], state))) return false;
    if (++state.ops >= 128 && nowMs() - state.started >= MERGE_SLICE_MS) {
      yield; state.ops = 0; state.started = nowMs();
    }
  }
  return true;
}

function validateRow(row) {
  if (!isObject(row)) fail("chunk row is invalid");
  if (typeof row.id !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(row.id)) fail("chunk id is invalid");
  if (!["tile", "layout", "block"].includes(row.kind)) fail("chunk kind is invalid");
  if (!Array.isArray(row.bounds) || row.bounds.length !== 4 || !row.bounds.every(Number.isFinite)) fail("chunk bounds are invalid");
  if (typeof row.always !== "boolean") fail("chunk priority is invalid");
  if (row.kind === "block" ? row.spaceId !== null : (typeof row.spaceId !== "string" || !row.spaceId)) fail("chunk space is invalid");
  if (!Array.isArray(row.dependencies) || !row.dependencies.every(value => typeof value === "string")) fail("chunk dependencies are invalid");
  if (new Set(row.dependencies).size !== row.dependencies.length) fail("chunk dependencies contain duplicates");
  if (!Array.isArray(row.removeOverview) || !row.removeOverview.every(value => typeof value === "string" && value.startsWith("overview-e-"))) fail("chunk overview ids are invalid");
  if (new Set(row.removeOverview).size !== row.removeOverview.length) fail("chunk overview ids contain duplicates");
  if (!isObject(row.counts)) fail("chunk counts are invalid");
  if (typeof row.resourceId !== "string" || typeof row.resourceSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(row.resourceSHA256)) fail("chunk resource identity is invalid");
  if (![row.resourceBytes, row.documentBytes, row.positionBytes].every(Number.isSafeInteger)
    || row.resourceBytes <= HEADER_BYTES || row.resourceBytes > MAX_BUNDLE_BYTES
    || row.documentBytes <= 0 || row.documentBytes > MAX_JSON_BYTES
    || row.positionBytes < 0 || row.positionBytes > MAX_POSITION_BYTES
    || row.resourceBytes !== HEADER_BYTES + row.documentBytes + row.positionBytes) fail("chunk resource size is invalid");
  return row;
}

export function isServerChunked(envelope) {
  const extension = envelope?.document?.extensions?.[SERVER_CHUNKS_EXTENSION];
  return !!extension && extension.version === BUNDLE_VERSION && Array.isArray(envelope.chunkResources);
}

export function bindOverviewRepresentations(envelope) {
  const document = envelope?.document;
  const extension = document?.extensions?.[SERVER_CHUNKS_EXTENSION];
  if (!extension || extension.version !== BUNDLE_VERSION) return 0;
  const overviewBindings = extension.overview?.representations;
  const entities = document?.drawing?.entities;
  const representations = document?.representations;
  if (!isObject(overviewBindings) || !isObject(entities) || !isObject(representations)) return 0;
  let bound = 0;
  for (const [entityId, representationId] of Object.entries(overviewBindings)) {
    if (typeof representationId !== "string" || !representationId.startsWith("overview-r-")) continue;
    const entity = entities[entityId];
    const representation = representations[representationId];
    if (!isObject(entity) || entity.id !== entityId || !isObject(representation)
      || representation.id !== representationId || representation.kind !== "drawing") continue;
    if (entity.displayRepresentationId !== undefined) continue;
    entity.displayRepresentationId = representationId;
    bound += 1;
  }
  return bound;
}

export function chunkIndex(envelope) {
  const extension = envelope?.document?.extensions?.[SERVER_CHUNKS_EXTENSION];
  if (!extension || extension.version !== BUNDLE_VERSION) return null;
  if (typeof extension.modelSpaceId !== "string" || !extension.modelSpaceId) fail("chunk model space is invalid");
  const values = [];
  for (const [key, kind] of [["tiles", "tile"], ["layouts", "layout"], ["blocks", "block"]]) {
    if (!Array.isArray(extension[key])) fail("chunk table is invalid");
    for (const row of extension[key]) {
      validateRow(row);
      if (row.kind !== kind) fail("chunk table kind is invalid");
      values.push(row);
    }
  }
  if (!values.length || values.length > 4096) fail("chunk index is empty or too large");
  const byId = new Map(values.map(row => [row.id, row]));
  const ids = new Set(), removed = new Set();
  for (const row of values) {
    if (ids.has(row.id)) fail("duplicate chunk id");
    ids.add(row.id);
    for (const value of row.removeOverview) {
      if (removed.has(value)) fail("chunk overview target is duplicated");
      removed.add(value);
    }
  }
  for (const row of values) {
    for (const dependency of row.dependencies) {
      if (!ids.has(dependency) || dependency === row.id) fail("chunk dependency is invalid");
    }
  }
  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) fail("chunk dependency cycle");
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    state.set(id, 2);
  }
  for (const row of values) visit(row.id);
  if (!Number.isFinite(extension.detailScaleRatio) || extension.detailScaleRatio <= 1) fail("chunk scale threshold is invalid");
  if (!Number.isFinite(extension.detailMinPixels) || extension.detailMinPixels <= 0) fail("chunk pixel threshold is invalid");
  if (extension.resourceCount !== values.length
    || extension.resourceBytes !== values.reduce((sum, row) => sum + row.resourceBytes, 0)) fail("chunk totals are invalid");
  const overview = extension.overview;
  if (!isObject(overview) || overview.bufferId !== "buffer-chunk-overview" || !Array.isArray(overview.entityIds)
    || !overview.entityIds.every(value => typeof value === "string" && value.startsWith("overview-e-"))
    || new Set(overview.entityIds).size !== overview.entityIds.length) fail("chunk overview index is invalid");
  const overviewIds = new Set(overview.entityIds);
  const overviewBindings = overview.representations;
  if (!isObject(overviewBindings) || Object.keys(overviewBindings).length !== overviewIds.size) fail("chunk overview representation index is invalid");
  const documentRepresentations = envelope.document?.representations;
  const documentEntities = envelope.document?.drawing?.entities;
  if (!isObject(documentRepresentations) || !isObject(documentEntities)) fail("chunk overview runtime tables are invalid");
  const runtimeBindings = [];
  for (const [entityId, representationId] of Object.entries(overviewBindings)) {
    if (!overviewIds.has(entityId) || typeof representationId !== "string" || !representationId.startsWith("overview-r-")) fail("chunk overview representation binding is invalid");
    const entity = documentEntities[entityId];
    if (!isObject(entity) || entity.id !== entityId) fail("chunk overview entity is missing");
    if (entity.displayRepresentationId !== undefined && entity.displayRepresentationId !== representationId) fail("chunk overview entity representation conflicts");
    const representation = documentRepresentations[representationId];
    if (!isObject(representation) || representation.id !== representationId || representation.kind !== "drawing") fail("chunk overview representation is missing");
    runtimeBindings.push([entity, representationId]);
  }
  for (const [entity, representationId] of runtimeBindings) entity.displayRepresentationId = representationId;
  if (removed.size !== overviewIds.size || [...removed].some(value => !overviewIds.has(value))) fail("chunk overview inventory is incomplete");
  return { extension, rows: values, byId };
}

function validateResource(entry, row) {
  if (!isObject(entry) || !/^[A-Za-z0-9._:-]{1,128}$/.test(entry.id || "")) fail("chunk resource is invalid");
  if (entry.id !== row.resourceId || entry.sha256 !== row.resourceSHA256 || entry.byteLength !== row.resourceBytes) fail("chunk resource metadata mismatch");
  if (typeof entry.url !== "string" || !entry.url.startsWith("/api/resources/")) fail("chunk resource URL is invalid");
  return entry;
}

const MERGE_SLICE_MS = 4;
const MERGE_SLICE_RECORDS = 128;
function nowMs() { return globalThis.performance?.now?.() ?? Date.now(); }
function mergeSliceDue(started, count) {
  return count >= MERGE_SLICE_RECORDS && nowMs() - started >= MERGE_SLICE_MS;
}
function* checkRecordTableSteps(target, source, label) {
  if (!isObject(source)) fail(label + " table is invalid");
  let started = nowMs(), count = 0;
  const comparison = {ops: 0, started: nowMs()};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (!isObject(value)) fail(label + " record is invalid");
    if (target[key] !== undefined && !(yield* equalValueSteps(target[key], value, comparison))) fail("conflicting " + label + " " + key);
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
}
function* applyRecordTableSteps(target, source) {
  let started = nowMs(), count = 0;
  for (const key of Object.keys(source)) {
    target[key] = source[key];
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
}
function* checkExtensionSteps(target, source, path) {
  if (!isObject(source)) fail(path + " is invalid");
  let started = nowMs(), count = 0;
  const comparison = {ops: 0, started: nowMs()};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (target[key] !== undefined) {
      if (isObject(target[key]) && isObject(value)) yield* checkExtensionSteps(target[key], value, path + "." + key);
      else if (!(yield* equalValueSteps(target[key], value, comparison))) fail("conflicting " + path + " " + key);
    }
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
}
function* checkSpacesSteps(target, source) {
  if (!isObject(target) || !isObject(source)) fail("chunk spaces are invalid");
  let started = nowMs(), count = 0;
  for (const [key, patch] of Object.entries(source)) {
    if (!isObject(patch)) fail("chunk space is invalid");
    for (const list of ["entityIds", "blockInstanceIds", "annotationIds"]) {
      if (patch[list] === undefined) continue;
      if (!Array.isArray(patch[list]) || !patch[list].every(value => typeof value === "string")) fail("chunk space list is invalid");
      if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
    }
    const current = target[key];
    if (!current) continue;
    if (current.drawingId && patch.drawingId && current.drawingId !== patch.drawingId) fail("conflicting chunk space " + key);
  }
}
function* mergeSpaceTableSteps(target, source) {
  let started = nowMs(), count = 0;
  for (const key of Object.keys(source)) {
    const patch = source[key];
    const current = target[key];
    if (!current) { target[key] = patch; continue; }
    for (const list of ["entityIds", "blockInstanceIds", "annotationIds"]) {
      if (!Array.isArray(patch[list])) continue;
      if (!Array.isArray(current[list])) current[list] = [];
      const seen = new Set(current[list]);
      for (const value of patch[list]) {
        if (!seen.has(value)) { seen.add(value); current[list].push(value); }
        if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
      }
    }
    if (!current.drawingId && patch.drawingId) current.drawingId = patch.drawingId;
  }
}
function* mergeExtensionSteps(target, source) {
  let started = nowMs(), count = 0;
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (target[key] === undefined) target[key] = value;
    else if (isObject(target[key]) && isObject(value)) yield* mergeExtensionSteps(target[key], value);
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
}
function* removeOverviewSteps(document, identifiers) {
  const entities = document.drawing.entities;
  const covered = new Set();
  let started = nowMs(), count = 0;
  // Overview remains the LOD-0 fallback. Detail chunks cover it only while the
  // viewport is zoomed in; the viewer hides overview records at detail scale.
  // Deleting them here leaves holes after zooming back out because detail
  // records are LOD-culled at overview scale.
  for (const id of identifiers) {
    if (!entities[id]) fail("chunk overview target is missing");
    covered.add(id);
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
  return covered.size;
}
function* mergeChunkDocumentSteps(envelope, parsed) {
  const document = envelope.document;
  const patch = parsed.document;
  if (!document || document.schemaVersion !== "2.0.0" || !patch || patch.schemaVersion !== "2.0.0") fail("chunk document schema is invalid");
  if (!isObject(document.drawing) || !isObject(patch.drawing)) fail("chunk drawing is invalid");
  if (!isObject(document.buffers)) fail("chunk base buffers are invalid");
  if (!isObject(document.accessors) || !isObject(document.geometries) || !isObject(document.representations)) fail("chunk base tables are invalid");
  if (!isObject(document.drawing.entities) || !isObject(document.drawing.blockInstances)
    || !isObject(document.drawing.annotations) || !isObject(document.drawing.blocks)
    || !isObject(document.drawing.spaces)) fail("chunk base drawing tables are invalid");
  if (patch.buffers !== undefined && !isObject(patch.buffers)) fail("chunk buffers are invalid");
  const bufferPatch = patch.buffers || {};
  const accessors = patch.accessors || {}, geometries = patch.geometries || {}, representations = patch.representations || {};
  const entities = patch.drawing.entities || {}, instances = patch.drawing.blockInstances || {};
  const annotations = patch.drawing.annotations || {}, blocks = patch.drawing.blocks || {};
  for (const [table, label] of [[bufferPatch, "chunk buffer"], [accessors, "chunk accessor"], [geometries, "chunk geometry"],
    [representations, "chunk representation"], [entities, "chunk entity"], [instances, "chunk block instance"],
    [annotations, "chunk annotation"], [blocks, "chunk block"]]) {
    if (!isObject(table)) fail(label + " table is invalid");
  }
  let started = nowMs(), count = 0;
  for (const [id, definition] of Object.entries(bufferPatch)) {
    if (!isObject(definition) || definition.id !== id) fail("chunk buffer definition is invalid");
    if (document.buffers[id] && !sameValue(document.buffers[id], definition)) fail("conflicting chunk buffer " + id);
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
  yield* checkRecordTableSteps(document.accessors, accessors, "accessor");
  yield* checkRecordTableSteps(document.geometries, geometries, "geometry");
  yield* checkRecordTableSteps(document.representations, representations, "representation");
  yield* checkRecordTableSteps(document.drawing.entities, entities, "entity");
  yield* checkRecordTableSteps(document.drawing.blockInstances, instances, "block instance");
  yield* checkRecordTableSteps(document.drawing.annotations, annotations, "annotation");
  yield* checkRecordTableSteps(document.drawing.blocks, blocks, "block");
  yield* checkSpacesSteps(document.drawing.spaces, patch.drawing.spaces || {});
  for (const key of Object.keys(patch.drawing)) {
    if (["spaces", "entities", "blockInstances", "annotations", "blocks"].includes(key)) continue;
    if (!isObject(document.drawing[key]) || !isObject(patch.drawing[key])) fail("chunk drawing table is invalid");
    yield* checkRecordTableSteps(document.drawing[key], patch.drawing[key], "drawing " + key);
  }
  const currentExtensions = document.extensions || (document.extensions = {});
  if (!isObject(currentExtensions)) fail("chunk base extensions are invalid");
  if (patch.extensions !== undefined) yield* checkExtensionSteps(currentExtensions, patch.extensions, "extensions");
  const overview = currentExtensions[SERVER_CHUNKS_EXTENSION]?.overview;
  if (!isObject(overview) || !Array.isArray(overview.entityIds)) fail("chunk overview is unavailable");
  const overviewIds = new Set(overview.entityIds);
  const removals = new Set();
  for (const id of parsed.chunk.removeOverview) {
    if (removals.has(id) || !overviewIds.has(id) || !document.drawing.entities[id]) fail("chunk overview target is invalid");
    removals.add(id);
    if (mergeSliceDue(started, ++count)) { yield; started = nowMs(); count = 0; }
  }
  let positionDefinition = null;
  if (parsed.bufferId && parsed.positions.byteLength) {
    positionDefinition = bufferPatch[parsed.bufferId] || document.buffers[parsed.bufferId];
    if (!positionDefinition || positionDefinition.byteLength !== parsed.positions.byteLength
      || positionDefinition.sha256 !== parsed.bufferSHA256) fail("chunk position buffer is invalid");
  } else if (parsed.bufferId || parsed.positions.byteLength) fail("chunk position buffer identity is incomplete");

  for (const [id, definition] of Object.entries(bufferPatch)) document.buffers[id] = definition;
  if (!(envelope.decodedBuffers instanceof Map)) envelope.decodedBuffers = new Map();
  if (positionDefinition && parsed.positions.byteLength) envelope.decodedBuffers.set(parsed.bufferId, parsed.positions);
  yield* applyRecordTableSteps(document.accessors, accessors);
  yield* applyRecordTableSteps(document.geometries, geometries);
  yield* applyRecordTableSteps(document.representations, representations);
  yield* applyRecordTableSteps(document.drawing.entities, entities);
  yield* applyRecordTableSteps(document.drawing.blockInstances, instances);
  yield* applyRecordTableSteps(document.drawing.annotations, annotations);
  yield* applyRecordTableSteps(document.drawing.blocks, blocks);
  yield* mergeSpaceTableSteps(document.drawing.spaces, patch.drawing.spaces || {});
  for (const key of Object.keys(patch.drawing)) {
    if (["spaces", "entities", "blockInstances", "annotations", "blocks"].includes(key)) continue;
    yield* applyRecordTableSteps(document.drawing[key], patch.drawing[key]);
  }
  if (patch.extensions) yield* mergeExtensionSteps(currentExtensions, patch.extensions);
  const removed = yield* removeOverviewSteps(document, parsed.chunk.removeOverview);
  return { removedOverview: removed, bufferId: parsed.bufferId, bufferBytes: parsed.positions.byteLength };
}
function drainSteps(steps) {
  let next;
  do { next = steps.next(); } while (!next.done);
  return next.value;
}
export function mergeChunkDocument(envelope, parsed) {
  return drainSteps(mergeChunkDocumentSteps(envelope, parsed));
}
export async function mergeChunkDocumentInSlices(envelope, parsed, options = {}) {
  const yieldToMain = options.yieldToMain || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const steps = mergeChunkDocumentSteps(envelope, parsed);
  while (true) {
    const next = steps.next();
    if (next.done) return next.value;
    await yieldToMain();
  }
}

export function parseChunkBundle(value, row) {
  const bytes = bytesOf(value);
  validateRow(row);
  if (bytes.byteLength !== row.resourceBytes) fail("chunk bundle length mismatch");
  if (bytes.byteLength > MAX_BUNDLE_BYTES) fail("chunk bundle exceeds budget");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BUNDLE_MAGIC) fail("chunk bundle magic mismatch");
  const jsonBytes = view.getUint32(4, true);
  const positionBytes = view.getUint32(8, true);
  if (jsonBytes <= 0 || jsonBytes > MAX_JSON_BYTES || positionBytes > MAX_POSITION_BYTES
    || HEADER_BYTES + jsonBytes + positionBytes !== bytes.byteLength) fail("chunk bundle header mismatch");
  let chunk;
  try { chunk = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonBytes))); }
  catch { fail("chunk bundle JSON is invalid"); }
  if (!isObject(chunk) || chunk.version !== CHUNK_VERSION || chunk.id !== row.id || chunk.kind !== row.kind) fail("chunk document identity mismatch");
  if (!isObject(chunk.document) || chunk.document.schemaVersion !== "2.0.0") fail("chunk document is invalid");
  if (!Array.isArray(chunk.removeOverview) || !chunk.removeOverview.every(value => typeof value === "string")
    || !sameValue(chunk.removeOverview, row.removeOverview)) fail("chunk overview inventory is invalid");
  if (!Array.isArray(chunk.dependencies) || !sameValue(chunk.dependencies, row.dependencies)
    || !Array.isArray(chunk.bounds) || !sameValue(chunk.bounds, row.bounds)) fail("chunk index inventory mismatch");
  const buffer = chunk.buffer;
  if (buffer !== null && (!isObject(buffer) || buffer.id !== "buffer-" + row.id || typeof buffer.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(buffer.sha256) || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength !== positionBytes)) fail("chunk buffer metadata is invalid");
  if (positionBytes && !buffer) fail("chunk positions have no buffer");
  if (!positionBytes && buffer) fail("chunk buffer has no positions");
  const definitions = chunk.document.buffers;
  if (definitions !== undefined && !isObject(definitions)) fail("chunk buffers are invalid");
  if (positionBytes) {
    const definition = definitions?.[buffer.id];
    if (!definition || definition.id !== buffer.id || definition.sha256 !== buffer.sha256
      || definition.byteLength !== buffer.byteLength) fail("chunk buffer document mismatch");
  } else if (definitions && Object.keys(definitions).length) fail("chunk buffer table is unexpected");
  return { chunk, document: chunk.document, bufferId: buffer?.id || null, bufferSHA256: buffer?.sha256 || null,
    positions: alignedBytes(bytes.subarray(HEADER_BYTES + jsonBytes), 8) };
}


const CHUNK_BATCH_ITEMS = 256;
function batchEntries(path, value, batches) {
  let entries = [];
  const flush = () => {
    if (!entries.length) return;
    batches.push({kind: "entries", path, entries});
    entries = [];
  };
  for (const [key, item] of Object.entries(value)) {
    entries.push([key, item]);
    if (entries.length >= CHUNK_BATCH_ITEMS) flush();
  }
  flush();
}
function batchArray(path, value, batches) {
  for (let start = 0; start < value.length; start += CHUNK_BATCH_ITEMS) {
    batches.push({kind: "array", path, start, length: value.length,
      items: value.slice(start, start + CHUNK_BATCH_ITEMS)});
  }
}
function skeletonTable(path, value, batches) {
  if (Array.isArray(value)) {
    batchArray(path, value, batches);
    return [];
  }
  if (!isObject(value)) return value;
  batchEntries(path, value, batches);
  return {};
}
function skeletonDrawing(drawing, batches) {
  const skeleton = {};
  for (const [key, value] of Object.entries(drawing)) skeleton[key] = skeletonTable(["drawing", key], value, batches);
  return skeleton;
}
function skeletonExtensions(extensions, batches) {
  const skeleton = {};
  for (const [name, extension] of Object.entries(extensions)) {
    if (!isObject(extension)) { skeleton[name] = extension; continue; }
    const rows = {};
    for (const [key, value] of Object.entries(extension)) {
      rows[key] = Array.isArray(value) || isObject(value)
        ? skeletonTable(["extensions", name, key], value, batches)
        : value;
    }
    skeleton[name] = rows;
  }
  return skeleton;
}
function skeletonChunkDocument(document, batches) {
  const skeleton = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "drawing" && isObject(value)) skeleton[key] = skeletonDrawing(value, batches);
    else if (key === "extensions" && isObject(value)) skeleton[key] = skeletonExtensions(value, batches);
    else if (["buffers", "accessors", "geometries", "representations"].includes(key) && isObject(value)) {
      skeleton[key] = skeletonTable([key], value, batches);
    } else skeleton[key] = value;
  }
  return skeleton;
}
export function chunkBundleMessages(parsed) {
  const batches = [];
  const document = skeletonChunkDocument(parsed.document, batches);
  const chunk = {...parsed.chunk};
  delete chunk.document;
  return {meta: {...parsed, document, chunk}, batches};
}
export function applyChunkBatch(document, batch) {
  if (!isObject(batch) || !Array.isArray(batch.path) || !batch.path.length) fail("chunk batch is invalid");
  let target = document;
  for (let index = 0; index < batch.path.length - 1; index += 1) {
    target = target?.[batch.path[index]];
    if (!isObject(target)) fail("chunk batch path is invalid");
  }
  const key = batch.path[batch.path.length - 1];
  if (batch.kind === "entries") {
    const table = target[key];
    if (!isObject(table) || !Array.isArray(batch.entries)) fail("chunk batch entries are invalid");
    for (const entry of batch.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") fail("chunk batch entry is invalid");
      table[entry[0]] = entry[1];
    }
    return;
  }
  if (batch.kind === "array") {
    const array = target[key];
    if (!Array.isArray(array) || !Number.isSafeInteger(batch.start) || !Number.isSafeInteger(batch.length)
      || batch.start < 0 || batch.start > batch.length || !Array.isArray(batch.items)
      || batch.start + batch.items.length > batch.length) fail("chunk batch array is invalid");
    if (array.length !== batch.length) array.length = batch.length;
    for (let index = 0; index < batch.items.length; index += 1) array[batch.start + index] = batch.items[index];
    return;
  }
  fail("chunk batch kind is invalid");
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const PARSE_WORKER_TIMEOUT_MS = 30000;
function createDefaultChunkWorker() {
  if (typeof window === "undefined" || typeof Worker !== "function") return null;
  return new Worker(new URL("./chunk-worker.js?v=dxf-0.17.24", import.meta.url), {type: "module"});
}

function intersects(left, right) {
  return left.minX <= right.maxX && left.maxX >= right.minX && left.minY <= right.maxY && left.maxY >= right.minY;
}
function rowBounds(row) {
  const b = row.bounds;
  return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}
function intersectionScore(left, right) {
  const width = Math.max(0, Math.min(left.maxX, right.maxX) - Math.max(left.minX, right.minX));
  const height = Math.max(0, Math.min(left.maxY, right.maxY) - Math.max(left.minY, right.minY));
  return width * height;
}

class FetchSlots {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async run(task) {
    if (this.active >= this.limit) await new Promise(resolve => this.waiters.push(resolve));
    this.active++;
    try { return await task(); }
    finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

export function createServerChunkController(options) {
  const envelope = options.envelope;
  const index = chunkIndex(envelope);
  if (!index) throw new Error("server chunks: index is unavailable");
  const resources = new Map();
  for (const row of index.rows) {
    const entry = (envelope.chunkResources || []).find(value => value?.id === row.resourceId);
    resources.set(row.id, validateResource(entry, row));
  }
  if (resources.size !== (envelope.chunkResources || []).length) fail("chunk resource table is incomplete");
  const loaded = new Set();
  const failed = new Map();
  const loading = new Map();
  const slots = new FetchSlots(MAX_PARALLEL_FETCHES);
  const abort = new AbortController();
  const changed = { value: 0, overview: 0 };
  let running = false, destroyed = false, timer = 0, applied = 0, appliedPasses = 0, applyFailures = 0, applyHalted = false;
  let maxParseMs = 0, lastParseMs = 0, maxMergeMs = 0, lastMergeMs = 0, lastApplyMs = 0, maxApplyMs = 0;
  let maxParseWorkerMs = 0, lastParseWorkerMs = 0, parseExecution = "main";
  let parseWorker = null, parseWorkerFailed = false, parseSequence = 0;
  const parsePending = new Map();
  let mergeQueue = Promise.resolve();
  const canWork = () => !options.canWork || options.canWork() !== false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitForWork() {
    while (!destroyed && !canWork()) await wait(80);
    abort.signal.throwIfAborted();
  }
  function enqueueMerge(task) {
    const next = mergeQueue.then(task, task);
    mergeQueue = next.catch(() => {});
    return next;
  }
  async function pauseForViewer() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await waitForWork();
  }
  function rejectPendingParses(error) {
    for (const [id, pending] of parsePending) {
      clearTimeout(pending.timer);
      parsePending.delete(id);
      pending.reject(error);
    }
  }
  function disposeParseWorker(error) {
    const worker = parseWorker;
    parseWorker = null;
    parseWorkerFailed = true;
    try { worker?.terminate(); } catch {}
    rejectPendingParses(error);
  }
  function getParseWorker() {
    if (parseWorker || parseWorkerFailed || options.parseWorker === false) return parseWorker;
    try {
      const factory = options.createParseWorker || createDefaultChunkWorker;
      parseWorker = factory();
      if (!parseWorker) { parseWorkerFailed = true; return null; }
      parseWorker.onmessage = ({data}) => {
        const pending = parsePending.get(data?.id);
        if (!pending) return;
        if (data.kind === "meta") {
          if (pending.meta || !isObject(data.parsed) || !isObject(data.parsed.document)) {
            parsePending.delete(data.id);
            clearTimeout(pending.timer);
            pending.reject(new Error("chunk parse worker returned invalid metadata"));
            return;
          }
          pending.meta = data.parsed;
          pending.document = data.parsed.document;
          return;
        }
        if (data.kind === "batch") {
          if (!pending.document) {
            parsePending.delete(data.id);
            clearTimeout(pending.timer);
            pending.reject(new Error("chunk parse worker returned a batch without metadata"));
            return;
          }
          try { applyChunkBatch(pending.document, data.batch); }
          catch (error) {
            parsePending.delete(data.id);
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          return;
        }
        parsePending.delete(data.id);
        clearTimeout(pending.timer);
        if (data.kind === "parsed") {
          const parsed = pending.meta
            ? {...pending.meta, document: pending.document,
              chunk: {...(pending.meta.chunk || {}), document: pending.document}}
            : data.parsed;
          pending.resolve({parsed, parseMs: Number(data.parseMs) || 0});
        }
        else if (data.kind === "error") pending.reject(new Error("chunk parse worker: " + (data.message || "parse failed")));
        else pending.reject(new Error("chunk parse worker returned an invalid message"));
      };
      parseWorker.onerror = event => {
        event.preventDefault?.();
        disposeParseWorker(new Error("chunk parse worker failed"));
      };
      parseWorker.onmessageerror = () => disposeParseWorker(new Error("chunk parse worker data failed"));
      return parseWorker;
    } catch {
      parseWorkerFailed = true;
      parseWorker = null;
      return null;
    }
  }
  function parseChunkWithWorker(worker, raw, row) {
    return new Promise((resolve, reject) => {
      const id = ++parseSequence;
      const timer = setTimeout(() => {
        parsePending.delete(id);
        reject(new Error("chunk parse worker timed out"));
      }, PARSE_WORKER_TIMEOUT_MS);
      parsePending.set(id, {resolve, reject, timer});
      try { worker.postMessage({id, bytes: raw, row}, [raw]); }
      catch (error) {
        clearTimeout(timer);
        parsePending.delete(id);
        reject(error);
      }
    });
  }

  function schedule(delay = 160) {
    if (destroyed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; void run(); }, delay);
  }

  function activeSpaceId(space) {
    if (!space) return null;
    if (space.kind === "layout") return envelope.document?.drawing?.layouts?.[space.layoutId]?.paperSpaceId || null;
    return space.spaceId || index.extension.modelSpaceId;
  }

  function candidates() {
    const space = options.currentSpace?.();
    if (!space) return [];
    const bounds = options.viewportBounds?.();
    if (!bounds) return [];
    const scale = Number(options.scale?.()) || 0;
    const fitScale = Number(options.fitScale?.()) || scale;
    const detail = scale >= fitScale * index.extension.detailScaleRatio;
    const sizeLimit = index.extension.detailMinPixels;
    const values = [];
    if (space.kind === "model") {
      for (const row of index.extension.tiles || []) {
        if (loaded.has(row.id) || loading.has(row.id) || failed.has(row.id)) continue;
        if (!row.always && !detail) continue;
        const box = rowBounds(row);
        if (!row.always && !intersects(bounds, box)) continue;
        if (!row.always && Math.max((box.maxX - box.minX) * scale, (box.maxY - box.minY) * scale) < sizeLimit) continue;
        values.push({ row, score: intersectionScore(bounds, box), priority: row.always ? 1 : 0 });
      }
    } else if (space.kind === "layout") {
      const spaceId = activeSpaceId(space);
      for (const row of index.extension.layouts || []) {
        if (row.spaceId !== spaceId || loaded.has(row.id) || loading.has(row.id) || failed.has(row.id)) continue;
        values.push({ row, score: 0, priority: 1 });
      }
    }
    values.sort((left, right) => right.priority - left.priority || right.score - left.score || left.row.resourceBytes - right.row.resourceBytes);
    return values.slice(0, MAX_CANDIDATES).map(value => value.row);
  }

  async function load(id) {
    if (loaded.has(id)) return false;
    if (loading.has(id)) return loading.get(id);
    const row = index.byId.get(id);
    if (!row) fail("unknown chunk " + id);
    const task = (async () => {
      for (const dependency of row.dependencies) await load(dependency);
      const resource = resources.get(id);
      const response = await slots.run(() => options.fetch(resource.url, { signal: abort.signal }));
      if (!response?.ok) fail("chunk resource is unavailable");
      const raw = await response.arrayBuffer();
      abort.signal.throwIfAborted();
      if (raw.byteLength !== resource.byteLength || await digestHex(raw) !== resource.sha256) fail("chunk resource integrity mismatch");
      await enqueueMerge(async () => {
        await waitForWork();
        const parseStarted = nowMs();
        const worker = getParseWorker();
        let parsed;
        if (worker) {
          const result = await parseChunkWithWorker(worker, raw, row);
          parsed = result.parsed;
          parseExecution = "worker";
          lastParseWorkerMs = result.parseMs;
          maxParseWorkerMs = Math.max(maxParseWorkerMs, lastParseWorkerMs);
        } else {
          parsed = parseChunkBundle(raw, row);
          parseExecution = "main";
        }
        abort.signal.throwIfAborted();
        lastParseMs = nowMs() - parseStarted;
        maxParseMs = Math.max(maxParseMs, lastParseMs);
        const mergeStarted = nowMs();
        const result = await mergeChunkDocumentInSlices(envelope, parsed, {yieldToMain: pauseForViewer});
        lastMergeMs = nowMs() - mergeStarted;
        maxMergeMs = Math.max(maxMergeMs, lastMergeMs);
        loaded.add(id);
        changed.value++;
        changed.overview += result.removedOverview;
      });
      return true;
    })();
    const guarded = task.catch(error => { failed.set(id, error); throw error; }).finally(() => loading.delete(id));
    loading.set(id, guarded);
    return guarded;
  }

  async function run() {
    if (destroyed || running) return;
    if (!canWork()) { schedule(120); return; }
    running = true;
    try {
      const rows = candidates();
      if (!rows.length && changed.value === applied) return;
      await Promise.all(rows.map(async row => {
        if (destroyed) return;
        try { await load(row.id); }
        catch (error) {
          if (!destroyed && !failed.has(row.id)) failed.set(row.id, error);
        }
      }));
      const pendingCandidates = candidates().length;
      const shouldApply = changed.value > applied && (pendingCandidates === 0 || changed.value - applied >= MAX_UNPUBLISHED_CHUNKS);
      if (shouldApply && !destroyed && !applyHalted) {
        await waitForWork();
        if (destroyed) return;
        try {
          const applyStarted = nowMs();
          await options.apply();
          lastApplyMs = nowMs() - applyStarted;
          maxApplyMs = Math.max(maxApplyMs, lastApplyMs);
          applied = changed.value;
          applyFailures = 0;
          appliedPasses++;
          options.afterApply?.();
        } catch (error) {
          applyFailures++;
          if (applyFailures === 1) options.onError?.(error);
          if (applyFailures >= 3) { applyHalted = true; applied = changed.value; }
        }
      }
    } catch (error) {
      if (!destroyed) options.onError?.(error);
    } finally {
      running = false;
      if (!destroyed && !applyHalted && (changed.value > applied || candidates().length)) schedule(changed.value > applied ? 180 : 120);
    }
  }

  const ready = Promise.resolve(options.ready).catch(() => {}).then(() => schedule(0));
  return {
    start() { void ready; },
    update() { schedule(120); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      abort.abort();
      disposeParseWorker(new Error("server chunk controller destroyed"));
      void options.release?.().catch?.(() => {});
    },
    record() {
      return { version: BUNDLE_VERSION, loaded: [...loaded], failed: [...failed.keys()], pending: loading.size,
        changed: changed.value, applied, overviewRemoved: changed.overview, appliedPasses, applyFailures, applyHalted,
        lastParseMs, maxParseMs, lastParseWorkerMs, maxParseWorkerMs, parseExecution,
        parseWorker: !!parseWorker, parseWorkerFailed,
        lastMergeMs, maxMergeMs, lastApplyMs, maxApplyMs,
        total: index.rows.length, detailScaleRatio: index.extension.detailScaleRatio,
        detailMinPixels: index.extension.detailMinPixels };
    },
    waitForIdle() {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (destroyed) { resolve(); return; }
          if (!running && !loading.size && changed.value === applied) { resolve(); return; }
          setTimeout(check, 30);
        };
        check();
      });
    }
  };
}
