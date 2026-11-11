import test from 'node:test';
import assert from 'node:assert/strict';
import { trackResponse } from '../public/cad-viewer/import-progress.js';

test('byte progress preserves the payload used for existing length and SHA checks', async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  const raw = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { headers: { 'content-type': 'application/octet-stream' } });
  let counted = 0;
  const tracked = trackResponse(raw, bytes => { counted += bytes; });
  assert.equal(tracked.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await tracked.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(counted, 5);
});

test('download cancellation reaches the original stream and errors are preserved', async () => {
  let reason;
  const raw = new Response(new ReadableStream({ cancel(value) { reason = value; } }));
  await trackResponse(raw, () => {}).body.cancel('user-cancel');
  assert.equal(reason, 'user-cancel');
  const failed = new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } }));
  await assert.rejects(trackResponse(failed, () => {}).arrayBuffer(), /connection lost/);
  const forbidden = new Response('unavailable', { status: 403 });
  assert.equal(trackResponse(forbidden, () => {}), forbidden);
});
