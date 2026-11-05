// Lossless unpacker for the DWG platform-packed document transport.
// Standard drawing entities and display tables are rebuilt into ordinary UCD
// objects; any row that was not packed stays verbatim in the fallback tables.
const PROFILE = 'ucd-dwg-packed/1';
const VERSION = 'dwg-table/1';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EXTENSION = 'org.cad-preview.style-inheritance/1';
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, count) {
  return (value >>> count) | (value << (32 - count));
}

const HEX = '0123456789abcdef';
const SHA_BLOCK = new Uint8Array(256);
const SHA_W = new Uint32Array(64);
const SHA_OUT = new Uint32Array(8);

// Synchronous SHA-256 over a short UTF-8 string, used only to rebuild
// representation IDs from their canonical display key.
function sha256Hex(text) {
  const length = text.length;
  let bytes = SHA_BLOCK;
  let needed = length * 4 + 16;
  if (needed > bytes.length) bytes = new Uint8Array(needed);
  let len = 0;
  for (let i = 0; i < length; i += 1) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes[len++] = code;
    } else if (code < 0x800) {
      bytes[len++] = 0xc0 | (code >> 6);
      bytes[len++] = 0x80 | (code & 0x3f);
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes[len++] = 0xf0 | (point >> 18);
        bytes[len++] = 0x80 | ((point >> 12) & 0x3f);
        bytes[len++] = 0x80 | ((point >> 6) & 0x3f);
        bytes[len++] = 0x80 | (point & 0x3f);
        i += 1;
      } else {
        bytes[len++] = 0xe0 | (code >> 12);
        bytes[len++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[len++] = 0x80 | (code & 0x3f);
      }
    } else {
      bytes[len++] = 0xe0 | (code >> 12);
      bytes[len++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[len++] = 0x80 | (code & 0x3f);
    }
  }
  const total = ((len + 9 + 63) >> 6) << 6;
  if (total > bytes.length) bytes = new Uint8Array(total);
  bytes[len] = 0x80;
  for (let i = len + 1; i < total; i += 1) bytes[i] = 0;
  const bitLength = len * 8;
  bytes[total - 8] = Math.floor(bitLength / 0x100000000) >>> 24;
  bytes[total - 7] = Math.floor(bitLength / 0x100000000) >>> 16;
  bytes[total - 6] = Math.floor(bitLength / 0x100000000) >>> 8;
  bytes[total - 5] = Math.floor(bitLength / 0x100000000);
  bytes[total - 4] = bitLength >>> 24;
  bytes[total - 3] = bitLength >>> 16;
  bytes[total - 2] = bitLength >>> 8;
  bytes[total - 1] = bitLength;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = SHA_W;
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  SHA_OUT[0] = h0; SHA_OUT[1] = h1; SHA_OUT[2] = h2; SHA_OUT[3] = h3;
  SHA_OUT[4] = h4; SHA_OUT[5] = h5; SHA_OUT[6] = h6; SHA_OUT[7] = h7;
  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    const value = SHA_OUT[i];
    hex += HEX[(value >>> 28) & 15] + HEX[(value >>> 24) & 15] +
      HEX[(value >>> 20) & 15] + HEX[(value >>> 16) & 15] +
      HEX[(value >>> 12) & 15] + HEX[(value >>> 8) & 15] +
      HEX[(value >>> 4) & 15] + HEX[value & 15];
  }
  return hex;
}

function fail(message) {
  throw new Error('packed transport: ' + message);
}

function indexOf(strings, value, context) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= strings.length) {
    fail('string index out of range in ' + context);
  }
  return strings[value];
}

export function unpackDwgPacked(envelope) {
  if (!envelope || !envelope.document || !envelope.document.packed) return envelope;
  const packedDoc = envelope.document;
  const payload = packedDoc.packed;
  if (payload.profile !== PROFILE || payload.version !== VERSION) fail('unknown profile');
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
    if (!Array.isArray(row) || row.length !== 12) fail('invalid display row');
    const key = indexOf(strings, row[0], 'display key');
    const accessorId = 'a-' + key;
    const geometryId = 'g-' + key;
    const representationId = 'representation-' + sha256Hex(JSON.stringify([key]));
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
    accessors[accessorId] = {
      bufferId: 'buffer-0', byteOffset, byteLength, component: 'f64', components: 3,
      count, normalized: false,
    };
    geometries[geometryId] = {
      id: geometryId, coordinateSpace: 'geometry-local',
      attributes: { POSITION: accessorId },
      primitives: [{ id: 'p', topology, range: { first: 0, count } }],
      bounds: { min: row.slice(5, 8), max: row.slice(8, 11) }, normalOrigin: 'absent',
      sourceRefs: refs,
    };
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
