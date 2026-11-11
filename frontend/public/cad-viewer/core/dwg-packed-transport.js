// Lossless unpacker for the DWG platform-packed document transport.
// Standard drawing entities and display tables are rebuilt into ordinary UCD
// objects; any row that was not packed stays verbatim in the fallback tables.
const PROFILE = 'ucd-dwg-packed/1';
const VERSION = 'dwg-table/1';
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

export function unpackDwgPacked(envelope, streamCurves = false) {
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
  let deferredCurves=envelope.displayOnly && Object.values(entities).some(e=>e.geometry?.displayOnly);
  for (const row of payload.entities) {
    if (!Array.isArray(row) || row.length !== 14) fail('invalid entity row');
    if (!deferredCurves && envelope.displayOnly && row[12]?.displayOnly) deferredCurves=true;
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
  const displayRows = envelope.displayOnly ? Object.create(null) : null;
  for (const row of payload.displays) {
    if (!Array.isArray(row) || row.length !== 12) fail('invalid display row');
    const key = indexOf(strings, row[0], 'display key');
    const accessorId = 'a-' + key;
    const geometryId = 'g-' + key;
    const representationId = 'representation-'+key;
    if (Object.hasOwn(accessors, accessorId) || Object.hasOwn(geometries, geometryId)
        || Object.hasOwn(representations, representationId) || (displayRows && Object.hasOwn(displayRows,representationId))) fail('duplicate display ' + key);
    const byteOffset = row[1];
    const byteLength = row[2];
    const count = row[3];
    if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength)
        || !Number.isSafeInteger(count)) fail('invalid accessor range');
    const topology = indexOf(strings, row[4], 'topology');
    const handle = indexOf(strings, row[11], 'display handle');
    if (displayRows) {
      displayRows[representationId] = [byteOffset,count,topology];
      if (entities[key] && !entities[key].displayRepresentationId) entities[key].displayRepresentationId=representationId;
      continue;
    }
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
  const packet = { ...envelope, document, ...(displayRows ? {displayRows,deferredCurves:!!deferredCurves} : {}) };
  if (displayRows && payload.polylineFields) packet.polylineFields = payload.polylineFields;
  if (displayRows && payload.curveRows) {
    packet.deferredCurves = true;
    if (streamCurves) {
      packet.curveRows = payload.curveRows;
      packet.curvePens = payload.curvePens;
    } else applyCurveRows(packet, payload.curveRows, payload.curvePens);
  }
  return packet;
}

// Direct reader rows are only used by a live DWG view. Resolve one shared pen
// per style; visibility, linetype scale and painter order remain per entity.
export function applyCurveRows(packet, rows, pens) {
  const drawing = packet.document.drawing;
  const {entityState, modes, drawOrder} = packet.document.extensions[EXTENSION];
  for (const [handle, kind, space, layer, index, order, visible, scale, offset, count] of rows) {
    const [style, mode, weight, color, rgb] = pens[index];
    const key = 'entity-' + handle, representation = 'representation-' + key;
    drawing.entities[key] = {
      id:key, drawingId:drawing.spaces[space].drawingId, ownerSpaceId:space, layerId:layer,
      localFromOwner:IDENTITY, geometry:{type:kind, displayOnly:true}, style,
      sourceRefs:[{sourceId:'source-0', objectKey:handle}], displayOrder:order,
      displayRepresentationId:representation,
    };
    entityState[key] = {invisible:!visible, lineTypeScale:scale, nativeLineWeight:weight,
      drawOrder:order, nativeColor:{index:color, trueColor:rgb}};
    if (mode.lineType || mode.lineWeight) modes[key] = mode;
    drawOrder[key] = order;
    packet.displayRows[representation] = [offset, count, 'lines'];
  }
}

// Stream the existing lossless tables through the browser's gzip decoder.
// The expanded document still passes the ordinary UCD/binary validation.
export async function expandDwgCompressed(envelope) {
 const doc=envelope?.document,payload=doc?.packed;
 if(payload?.profile!=='ucd-dwg-packed-gzip/1')return envelope;
 const fields=['drawing','extensions','accessors','geometries','representations','packed'];
 const length=payload.byteLength;
 if(!Number.isSafeInteger(length)||length<=0||length>512*1024*1024)fail('expanded budget');
 if(fields.some(key=>key!=='packed'&&Object.keys(doc[key]).length))fail('ambiguous compressed tables');
 const binary=atob(payload.data),input=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)input[i]=binary.charCodeAt(i);
 const reader=new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
 const chunks=[];let total=0;
 try {
  while(true){
   const {done,value}=await reader.read();if(done)break;
   total+=value.byteLength;
   if(total>length){await reader.cancel();fail('expanded length');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 if(total!==length)fail('expanded length');
 const raw=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}
 const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 if(Object.keys(body).length!==fields.length||fields.some(key=>!Object.hasOwn(body,key)))fail('compressed table inventory');
 return {...envelope,document:{...doc,...body}};
}
