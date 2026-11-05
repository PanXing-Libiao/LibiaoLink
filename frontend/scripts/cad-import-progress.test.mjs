import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportClock, estimateRemaining, trackResponse } from '../public/cad-viewer/import-progress.js';

const MIB = 1024 * 1024;
const large = { bytes: 34_385_320, artifactBytes: 145_269_322, format: 'DWG', mobile: false };

test('queue time does not consume the processing estimate', () => {
  const clock = new ImportClock(0);
  clock.queued(true, 200);
  assert.equal(clock.elapsed(12_200), 200);
  assert.equal(estimateRemaining({ bytes: 1024, queued: true }).kind, 'queued');
  clock.queued(false, 12_200);
  assert.equal(clock.elapsed(13_000), 1000);
});

test('successful local timings take precedence and reject a distant outlier', () => {
  const history = [
    { bytes: large.bytes, kind: 'converted', totalMs: 20_000 },
    { bytes: large.bytes, kind: 'converted', totalMs: 21_000 },
    { bytes: large.bytes, kind: 'converted', totalMs: 900_000 },
    -1, null,
  ];
  const prior = estimateRemaining({ ...large, history, elapsedMS: 5_000, reused: false });
  assert.equal(prior.source, 'history');
  assert.ok(prior.lowSeconds >= 10);
  assert.ok(prior.highSeconds < 40);
  assert.equal(estimateRemaining({ history: [null, -5, Infinity] }).kind, 'pending');
});

test('converted history from a much smaller drawing does not override a new large conversion', () => {
  const prior = estimateRemaining({
    ...large, elapsedMS: 10_000, reused: false,
    history: [{ bytes: 7_623_968, kind: 'converted', totalMs: 27_018, mobile: false }],
  });
  assert.equal(prior.source, 'cold');
  assert.ok(prior.lowSeconds >= 180);
  assert.ok(prior.highSeconds >= 600);
});

test('finished download cannot keep extending a historical estimate', () => {
  const prior = estimateRemaining({
    ...large, reused: false, totalBytes: large.artifactBytes, receivedBytes: large.artifactBytes,
    throughputBytesPerSecond: 20 * MIB, elapsedMS: 76_000, fileId: 'file-1', versionId: 'version-1',
    history: [{ fileId: 'file-1', versionId: 'version-1', totalMs: 22_000, bytes: large.bytes, artifactBytes: large.artifactBytes, kind: 'converted', mobile: false }],
  });
  assert.equal(prior.kind, 'overrun');
});

test('a cached large drawing is estimated from artifact size instead of source size', () => {
  const prior = estimateRemaining({ ...large, reused: true, networkBytesPerSecond: 8 * MIB });
  assert.equal(prior.source, 'cached');
  assert.ok(prior.lowSeconds >= 10 && prior.lowSeconds <= 25);
  assert.ok(prior.highSeconds >= 15 && prior.highSeconds <= 45);
});

test('the same file history narrows a cached estimate', () => {
  const prior = estimateRemaining({
    ...large, reused: true, elapsedMS: 2_000, fileId: 'file-1', versionId: 'version-1',
    history: [{ fileId: 'file-1', versionId: 'version-1', totalMs: 20_200, bytes: large.bytes, artifactBytes: large.artifactBytes, kind: 'cached', mobile: false }],
  });
  assert.equal(prior.source, 'history');
  assert.ok(prior.lowSeconds >= 10 && prior.lowSeconds <= 20);
  assert.ok(prior.highSeconds >= 20 && prior.highSeconds <= 35);
});

test('completed download switches to view-build time instead of a stale download tail', () => {
  const prior = estimateRemaining({
    ...large, reused: true, totalBytes: large.artifactBytes, receivedBytes: large.artifactBytes,
    throughputBytesPerSecond: 20 * MIB, elapsedMS: 10_000, buildElapsedMS: 2_000,
  });
  assert.equal(prior.source, 'build');
  assert.ok(prior.lowSeconds >= 8);
  assert.ok(prior.highSeconds >= 25);
});

test('matching local history stays authoritative while resources are downloading', () => {
  const prior = estimateRemaining({
    ...large, reused: true, elapsedMS: 5_000,
    totalBytes: 120e6, receivedBytes: 40e6, throughputBytesPerSecond: 10e6,
    fileId: 'file-1', versionId: 'version-1',
    history: [{ fileId: 'file-1', versionId: 'version-1', totalMs: 24_700, buildMs: 18_000, bytes: large.bytes, artifactBytes: large.artifactBytes, kind: 'cached', mobile: false }],
  });
  assert.equal(prior.source, 'history');
  assert.ok(prior.lowSeconds >= 8);
  assert.ok(prior.highSeconds >= 20);
});

test('an unmeasured network prior does not widen trusted local history', () => {
  const prior = estimateRemaining({
    ...large, reused: true, elapsedMS: 2_000, networkBytesPerSecond: 2 * MIB,
    totalBytes: 120e6, receivedBytes: 20e6, throughputBytesPerSecond: 0,
    fileId: 'file-1', versionId: 'version-1',
    history: [{ fileId: 'file-1', versionId: 'version-1', totalMs: 20_000, buildMs: 14_000, bytes: large.bytes, artifactBytes: large.artifactBytes, kind: 'cached', mobile: false }],
  });
  assert.equal(prior.source, 'history');
  assert.ok(prior.highSeconds <= 31);
});

test('download time follows observed throughput and remaining bytes', () => {
  const prior = estimateRemaining({ totalBytes: 120e6, receivedBytes: 40e6, throughputBytesPerSecond: 10e6, elapsedMS: 20_000, mobile: false });
  assert.equal(prior.source, 'download');
  assert.ok(prior.lowSeconds >= 6 && prior.lowSeconds <= 10);
  assert.ok(prior.highSeconds >= 8 && prior.highSeconds <= 14);
});

test('first cold conversion is conservative and overruns stay unfinished', () => {
  const cold = estimateRemaining({ bytes: 34_385_320, format: 'DWG', reused: false });
  assert.equal(cold.source, 'cold');
  assert.ok(cold.lowSeconds >= 180);
  assert.ok(cold.highSeconds >= 600);
  assert.equal(estimateRemaining({ bytes: 34_385_320, format: 'DWG', reused: false, elapsedMS: 1_000_000 }).kind, 'overrun');
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
