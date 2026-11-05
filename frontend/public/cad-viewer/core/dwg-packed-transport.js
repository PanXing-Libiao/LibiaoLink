// Lossless unpacker for the DWG platform-packed document transport.
// Standard drawing entities and display tables are rebuilt into ordinary UCD
// objects; any row that was not packed stays verbatim in the fallback tables.
const PROFILE = 'ucd-dwg-packed/1';
const VERSION = 'dwg-table/4';
const GEOMETRY_CHUNK_BYTES = 1024 * 1024;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EXTENSION = 'org.cad-preview.style-inheritance/1';
function fail(message) {
  throw new Error('packed transport: ' + message);
}

function indexOf(strings, value, context) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= strings.length) {
    fail('string index out of range in ' + context);
  }
  return strings[value];
}

// Keep each inflated source-parameter block bounded; the ordinary unpacker stays synchronous.
export async function inflateDwgGeometry(envelope) {
  const payload = envelope?.document?.packed;
  if (!['dwg-table/3',VERSION].includes(payload?.version)) return envelope;
  if (payload.profile !== PROFILE) fail('unknown profile');
  if (!Array.isArray(payload.entities) || !Array.isArray(payload.geometryChunks)) fail('invalid geometry chunks');
  const rows = payload.entities.map(row => Array.isArray(row) ? row.slice() : row);
  let end = 0;
  for (const chunk of payload.geometryChunks) {
    const {first, count, byteLength, data} = chunk || {};
    if (![first,count,byteLength].every(Number.isSafeInteger) || first < end || count <= 0
        || first + count > rows.length || byteLength <= 0 || byteLength > GEOMETRY_CHUNK_BYTES
        || typeof data !== 'string' || data.length > GEOMETRY_CHUNK_BYTES * 2) fail('invalid geometry range');
    const binary = atob(data), encoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) encoded[i] = binary.charCodeAt(i);
    const reader = new Blob([encoded]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const raw = new Uint8Array(byteLength);
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.length > byteLength) fail('geometry length exceeded');
        raw.set(next.value, offset); offset += next.value.length;
      }
    } finally { await reader.cancel(); }
    if (offset !== byteLength) fail('geometry length mismatch');
    const values = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    if (!Array.isArray(values) || values.length !== count) fail('invalid geometry count');
    for (let i = 0; i < count; i++) {
      const row = rows[first+i];
      if (!Array.isArray(row) || row.length !== 14 || row[12] !== null) fail('ambiguous geometry chunk');
      row[12] = values[i];
    }
    end = first + count;
  }
  const expanded = {...payload,entities:rows};
  delete expanded.geometryChunks;
  return {...envelope,document:{...envelope.document,packed:expanded}};
}

export function unpackDwgPacked(envelope) {
  if (!envelope || !envelope.document || !envelope.document.packed) return envelope;
  const packedDoc = envelope.document;
  const payload = packedDoc.packed;
  if (payload.profile !== PROFILE || (![VERSION,'dwg-table/1','dwg-table/2','dwg-table/3'].includes(payload.version))) fail('unknown profile');
  if (['dwg-table/3',VERSION].includes(payload.version) && Object.hasOwn(payload,'geometryChunks')) fail('geometry chunks require inflation');
  const strings = payload.strings;
  const layers = payload.layers;
  const spaces = payload.spaces;
  const styles = payload.styles;
  if (!Array.isArray(strings) || !Array.isArray(layers) || !Array.isArray(spaces) || !Array.isArray(styles)) {
    fail('invalid table');
  }
  if (strings.some((value) => typeof value !== 'string') || new Set(strings).size !== strings.length) {
    fail('invalid string dictionary');
  }
  if (!layers.every((value) => typeof value === 'string') || !spaces.every((value) => typeof value === 'string')) {
    fail('invalid layer/space table');
  }
  if (!Array.isArray(payload.entities) || !Array.isArray(payload.displays)) fail('invalid rows');

  const drawing = { ...packedDoc.drawing };
  const extension = packedDoc.extensions?.[EXTENSION];
  if (!extension) fail('missing style inheritance');
  const states = { ...(extension.entityState || {}) };
  const modes = { ...(extension.modes || {}) };
  const orders = { ...(extension.drawOrder || {}) };
  const spacesById = drawing.spaces;
  if (!spacesById) fail('missing spaces');
  const entities = { ...(drawing.entities || {}) };
  for (const row of payload.entities) {
    if (!Array.isArray(row) || row.length !== 14) fail('invalid entity row');
    const key = indexOf(strings, row[0], 'entity id');
    if (Object.hasOwn(entities, key)) fail('duplicate entity ' + key);
    const layer = Number.isSafeInteger(row[1]) ? layers[row[1]] : undefined;
    const space = Number.isSafeInteger(row[2]) ? spaces[row[2]] : undefined;
    if (typeof layer !== 'string' || typeof space !== 'string') fail('invalid entity reference');
    const spaceRow = spacesById[space];
    if (!spaceRow) fail('unknown space ' + space);
    const handle = indexOf(strings, row[3], 'entity handle');
    const style = Number.isSafeInteger(row[4]) ? styles[row[4]] : undefined;
    if (!style || typeof style !== 'object') fail('invalid style');
    const stateKind = row[6];
    if (stateKind === 1) {
      states[key] = { invisible: !!row[7] };
    } else if (stateKind === 2) {
      states[key] = { drawOrder: row[9], invisible: !!row[7], lineTypeScale: row[8],
        nativeColor: { index: row[10], trueColor: row[11] } };
      orders[key] = row[9];
    } else if (stateKind !== 0 && stateKind !== 3) {
      fail('unknown state kind ' + stateKind);
    }
    const modeCode = row[13];
    if (modeCode === 1) modes[key] = { lineType: 'by-layer' };
    else if (modeCode === 2) modes[key] = { lineType: 'by-block' };
    else if (modeCode !== 0 && modeCode !== 3) fail('unknown mode ' + modeCode);
    entities[key] = {
      id: key,
      drawingId: spaceRow.drawingId,
      ownerSpaceId: space,
      layerId: layer,
      localFromOwner: IDENTITY,
      geometry: row[12],
      style,
      sourceRefs: [{ sourceId: 'source-0', objectKey: handle }],
      displayOrder: row[5],
    };
  }

  const accessors = { ...(packedDoc.accessors || {}) };
  const geometries = { ...(packedDoc.geometries || {}) };
  const representations = { ...(packedDoc.representations || {}) };
  for (const row of payload.displays) {
    if (!Array.isArray(row) || ![12,14,15].includes(row.length)
        || (row.length === 14 && payload.version === 'dwg-table/1')
        || (row.length === 15 && payload.version !== VERSION)) fail('invalid display row');
    const key = indexOf(strings, row[0], 'display key');
    const accessorId = 'a-' + key;
    const geometryId = 'g-' + key;
    const representationId = 'representation-'+key;
    if (Object.hasOwn(accessors, accessorId) || Object.hasOwn(geometries, geometryId)
        || Object.hasOwn(representations, representationId)) fail('duplicate display ' + key);
    const byteOffset = row[1];
    const byteLength = row[2];
    const count = row[3];
    if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength)
        || !Number.isSafeInteger(count)) fail('invalid accessor range');
    const topology = indexOf(strings, row[4], 'topology');
    const handle = indexOf(strings, row[11], 'display handle');
    const refs = [{ sourceId: 'source-0', objectKey: handle }];
    const primitive = { id: 'p', topology, range: { first: 0, count } };
    if (row.length >= 14) {
      const indexId = 'i-' + key, offset = row[12], indexCount = row[13];
      const component = row.length === 15 ? row[14] : 'u32';
      const width = {u8:1,u16:2,u32:4}[component];
      if (!['u8','u16','u32'].includes(component)) fail('invalid index component');
      if (Object.hasOwn(accessors,indexId) || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(indexCount) || indexCount < 0 || !Number.isSafeInteger(indexCount*width))
        fail('invalid or duplicate index accessor');
      accessors[indexId] = {bufferId:'buffer-0', byteOffset:offset, byteLength:indexCount*width,
        component, components:1, count:indexCount, normalized:false};
      primitive.indices = indexId;
      primitive.range.count = indexCount;
    }
    accessors[accessorId] = {
      bufferId: 'buffer-0', byteOffset, byteLength, component: 'f64', components: 3,
      count, normalized: false,
    };
    geometries[geometryId] = {
      id: geometryId, coordinateSpace: 'geometry-local',
      attributes: { POSITION: accessorId },
      primitives: [primitive],
      bounds: { min: row.slice(5, 8), max: row.slice(8, 11) }, normalOrigin: 'absent',
      sourceRefs: refs,
    };
    // The packed display key is already unique and validated. Use it as the internal
    // representation id so loading does not hash every geometry row.
    if (entities[key] && !entities[key].displayRepresentationId) entities[key].displayRepresentationId = representationId;
    representations[representationId] = {
      id: representationId, kind: 'drawing',
      bindings: [{ id: 'b', geometryId, localFromRepresentation: IDENTITY, materialSlots: {} }],
      sourceRefs: refs,
    };
  }

  drawing.entities = entities;
  const extensions = { ...packedDoc.extensions };
  extensions[EXTENSION] = { ...extension, modes, entityState: states, drawOrder: orders };
  const document = { ...packedDoc };
  delete document.packed;
  document.drawing = drawing;
  document.extensions = extensions;
  document.accessors = accessors;
  document.geometries = geometries;
  document.representations = representations;
  return { ...envelope, document };
}
