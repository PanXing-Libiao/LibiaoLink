/** Display estimates only; never interpreted as native conversion percentages. */
export class ImportClock {
  constructor(start) { this.start = start; this.waited = 0; this.waitStart = null; }
  queued(on, now) {
    if (on && this.waitStart === null) this.waitStart = now;
    if (!on && this.waitStart !== null) { this.waited += now - this.waitStart; this.waitStart = null; }
  }
  elapsed(now) { return Math.max(0, now - this.start - this.waited - (this.waitStart === null ? 0 : now - this.waitStart)); }
}

export function estimateRemaining({ bytes, history = [], elapsedMS = 0, queued = false }) {
  if (queued) return { kind: 'queued' };
  const samples = history.filter(n => Number.isFinite(n) && n > 0 && n <= 1_200_000).sort((a, b) => a - b);
  let low, high, source;
  if (samples.length) {
    const middle = samples[Math.floor(samples.length / 2)];
    low = middle * .8; high = middle * 1.4; source = 'history';
  } else if (Number.isFinite(bytes) && bytes > 0) {
    // Broad engineering fallback, not a complexity predictor or completion promise.
    const baseline = (8 + bytes / (1024 * 1024) * 1.1) * 1000;
    low = Math.max(5_000, baseline * .7); high = Math.max(15_000, baseline * 2); source = 'size';
  } else return { kind: 'pending' };
  if (elapsedMS >= high) return { kind: 'overrun', source };
  return { kind: 'estimate', source, lowSeconds: Math.max(0, Math.ceil((low - elapsedMS) / 5000) * 5), highSeconds: Math.max(5, Math.ceil((high - elapsedMS) / 5000) * 5) };
}

/** Observe real received bytes while preserving the core's length/SHA validation. */
export function trackResponse(response, onBytes) {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); }
        else { onBytes(value.byteLength); controller.enqueue(value); }
      } catch (error) { controller.error(error); reader.releaseLock(); }
    },
    cancel(reason) { return reader.cancel(reason).finally(() => reader.releaseLock()); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
