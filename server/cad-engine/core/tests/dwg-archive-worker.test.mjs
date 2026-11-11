import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('archive handoff uses the leased resource and recovers from a damaged or absent projection', async t => {
  const source = 'ab'.repeat(32);
  const raw = Buffer.alloc(96);
  Buffer.from(source, 'hex').copy(raw);
  raw.writeUInt32LE(1, 32);
  raw.writeBigUInt64LE(0xffffffffffffffffn, 40);
  [1, 2, 3, 4, 5, 6].forEach((value, i) => raw.writeDoubleLE(value, 48 + i * 8));
  const columns = {sha256:createHash('sha256').update(raw).digest('hex'), byteLength:raw.length};
  const url = 'https://example.invalid/job/manifest', lease = 'a'.repeat(48);
  const archive = {presentation:{sourceSHA256:source}, document:{
    packed:{entities:[], strings:[]}, extensions:{'org.libiaolink.dwg/1':{nativeGeometry:{}}},
    drawing:{entities:{'entity-2':{geometry:{type:'line', start:[7,8,9], end:[10,11,12]}}}},
  }};
  const requests = [];
  let corrupt = false, tables;
  t.mock.method(globalThis, 'fetch', async address => {
    requests.push(String(address));
    if (String(address) === url) return Response.json(archive);
    assert.equal(String(address), 'https://example.invalid/job/resources/' + lease + '/' + columns.sha256);
    return new Response(corrupt ? Buffer.alloc(raw.length) : raw);
  });
  const previous = globalThis.self;
  globalThis.self = {postMessage:(value, transfer)=>{tables = structuredClone(value, {transfer});}};
  try {
    await import('../../../../frontend/public/cad-viewer/core/dwg-archive-worker.js');
    await self.onmessage({data:{url, source, columns, lease}});
    assert.equal(requests.length, 1);
    assert.equal(tables.line.handles[0], 0xffffffffffffffffn);
    assert.deepEqual([...tables.line.values], [1,2,3,4,5,6]);
    corrupt = true;
    await self.onmessage({data:{url, source, columns, lease}});
    assert.equal(requests.at(-1), url);
    assert.equal(tables.line.handles[0], 2n);
    requests.length = 0;
    await self.onmessage({data:{url, source}});
    assert.deepEqual(requests, [url]);
    assert.deepEqual([...tables.line.values], [7,8,9,10,11,12]);
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
});
