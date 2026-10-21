import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportClock, estimateRemaining, trackResponse } from '../public/cad-viewer/import-progress.js';

test('queue time does not consume the processing estimate', () => {
  const clock = new ImportClock(0);
  clock.queued(true, 200);
  assert.equal(clock.elapsed(12_200), 200);
  assert.equal(estimateRemaining({ bytes: 1024, queued: true }).kind, 'queued');
  clock.queued(false, 12_200);
  assert.equal(clock.elapsed(13_000), 1000);
});

test('successful local timings take precedence; invalid samples cannot produce an ETA', () => {
  const prior = estimateRemaining({ bytes: 60e6, history: [20_000, 21_000, 900_000, -1, null], elapsedMS: 5000 });
  assert.equal(prior.source, 'history');
  assert.ok(prior.highSeconds < 40);
  assert.equal(estimateRemaining({ history: [null, -5, Infinity] }).kind, 'pending');
});

test('first-open estimates are broad and overruns stay unfinished', () => {
  const first = estimateRemaining({ bytes: 15e6 });
  assert.equal(first.source, 'size');
  assert.ok(first.highSeconds > first.lowSeconds);
  assert.equal(estimateRemaining({ bytes: 15e6, elapsedMS: 180_000 }).kind, 'overrun');
});

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
