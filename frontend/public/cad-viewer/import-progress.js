/** Display estimates only; never interpreted as native conversion percentages. */
export class ImportClock {
  constructor(start) { this.start = start; this.waited = 0; this.waitStart = null; }
  queued(on, now) {
    if (on && this.waitStart === null) this.waitStart = now;
    if (!on && this.waitStart !== null) { this.waited += now - this.waitStart; this.waitStart = null; }
  }
  elapsed(now) { return Math.max(0, now - this.start - this.waited - (this.waitStart === null ? 0 : now - this.waitStart)); }
}

const MIB = 1024 * 1024;
const MAX_SAMPLE_MS = 1_200_000;
const HISTORY_LIMIT = 32;
const DEFAULT_DESKTOP_BPS = 8 * MIB;
const DEFAULT_MOBILE_BPS = 3 * MIB;

function positive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }

function normalizeSample(value) {
  if (positive(value)) return { totalMs: value, kind: "converted", bytes: null, artifactBytes: null, fileId: null, versionId: null, mobile: null };
  if (!value || typeof value !== "object" || !positive(value.totalMs) || value.totalMs > MAX_SAMPLE_MS) return null;
  return {
    totalMs: value.totalMs,
    kind: value.kind === "cached" ? "cached" : "converted",
    bytes: positive(value.bytes) ? value.bytes : null,
    artifactBytes: positive(value.artifactBytes) ? value.artifactBytes : null,
    fileId: typeof value.fileId === "string" ? value.fileId : null,
    versionId: typeof value.versionId === "string" ? value.versionId : null,
    buildMs: positive(value.buildMs) ? value.buildMs : null,
    mobile: typeof value.mobile === "boolean" ? value.mobile : null,
  };
}

function weightedQuantile(rows, quantile) {
  const ordered = rows.slice().sort((a, b) => a.totalMs - b.totalMs);
  const totalWeight = ordered.reduce((sum, row) => sum + row.weight, 0);
  let accumulated = 0;
  for (const row of ordered) {
    accumulated += row.weight;
    if (accumulated >= totalWeight * quantile) return row.totalMs;
  }
  return ordered.at(-1)?.totalMs ?? 0;
}

function historyEstimate(history, context) {
  const samples = history.map(normalizeSample).filter(Boolean).filter(sample => sample.kind === context.kind).filter(sample => {
    if (typeof sample.mobile === "boolean" && sample.mobile !== context.mobile) return false;
    if (sample.fileId && context.fileId && sample.fileId === context.fileId) return true;
    if (!positive(sample.bytes) || !positive(context.bytes)) return false;
    return Math.max(sample.bytes, context.bytes) / Math.min(sample.bytes, context.bytes) <= 3;
  });
  if (!samples.length) return null;
  const scored = samples.map(sample => {
    let distance = 0.2;
    if (sample.fileId && sample.fileId === context.fileId) distance -= 2.4;
    if (sample.versionId && context.versionId && sample.versionId !== context.versionId) distance += 0.2;
    if (positive(context.bytes)) {
      distance += sample.bytes
        ? Math.abs(Math.log((sample.bytes + 256 * 1024) / (context.bytes + 256 * 1024))) * (context.kind === "cached" ? 1.1 : 0.9)
        : 0.55;
    }
    if (positive(context.artifactBytes)) {
      distance += sample.artifactBytes ? Math.abs(Math.log((sample.artifactBytes + MIB) / (context.artifactBytes + MIB))) : 0.4;
    }
    if (typeof sample.mobile === "boolean" && typeof context.mobile === "boolean") distance += sample.mobile === context.mobile ? 0 : 0.65;
    return { ...sample, distance: Math.max(0, distance) };
  }).sort((a, b) => a.distance - b.distance).slice(0, 6);

  const roughCenter = weightedQuantile(scored.map(sample => ({ ...sample, weight: 1 })), 0.5);
  const inliers = scored.filter(sample => sample.totalMs >= roughCenter * 0.25 && sample.totalMs <= roughCenter * 4);
  const rows = inliers.map(sample => ({ ...sample, weight: Math.max(0.2, 1 / ((0.55 + sample.distance) ** 2)) }));
  const middle = weightedQuantile(rows, 0.5);
  let low = weightedQuantile(rows, 0.2);
  let high = weightedQuantile(rows, 0.8);
  if (rows.length === 1) {
    low = middle * 0.72;
    high = middle * 1.45;
  } else {
    const spread = Math.max(middle * 0.12, 2_000);
    low = Math.min(low, middle - spread * 0.5);
    high = Math.max(high, middle + spread * 0.7);
  }
  return { lowMs: low, highMs: high, p50Ms: middle, sampleCount: rows.length };
}

function cachedFallback({ bytes, artifactBytes, totalBytes, networkBytesPerSecond, mobile }) {
  const transferBytes = positive(artifactBytes) ? artifactBytes : positive(totalBytes) ? totalBytes : positive(bytes) ? bytes * 3 : 0;
  if (!transferBytes) return null;
  const mobileBps = mobile ? DEFAULT_MOBILE_BPS : DEFAULT_DESKTOP_BPS;
  const priorBps = positive(networkBytesPerSecond)
    ? Math.min(mobile ? 8 * MIB : 16 * MIB, Math.max(mobile ? 2 * MIB : 4 * MIB, networkBytesPerSecond))
    : mobileBps;
  const paintMs = mobile ? 3_500 : 1_800;
  const p50 = 1_200 + transferBytes / priorBps * 1_000 + paintMs;
  return { lowMs: p50 * 0.65, highMs: p50 * 1.55, p50Ms: p50, sampleCount: 0 };
}

function buildFallback({ artifactBytes, totalBytes, mobile }) {
  const bytes = positive(artifactBytes) ? artifactBytes : positive(totalBytes) ? totalBytes : 0;
  if (!bytes) return { lowMs: 3_000, highMs: 18_000, p50Ms: 8_000, sampleCount: 0 };
  const megabytes = bytes / MIB;
  const p50 = mobile ? 3_500 + megabytes * 180 : 2_500 + megabytes * 130;
  return { lowMs: p50 * 0.6, highMs: p50 * 1.7, p50Ms: p50, sampleCount: 0 };
}

function coldFallback({ bytes, format }) {
  if (!positive(bytes)) return null;
  const megabytes = bytes / MIB;
  const kind = String(format || "").toUpperCase();
  let lowSeconds;
  let highSeconds;
  if (kind === "DWG") {
    if (megabytes < 1) { lowSeconds = 8; highSeconds = 60; }
    else if (megabytes < 16) { lowSeconds = 180; highSeconds = 900; }
    else { lowSeconds = 240; highSeconds = 900; }
  } else if (kind === "DXF") {
    if (megabytes < 1) { lowSeconds = 8; highSeconds = 60; }
    else { lowSeconds = 60; highSeconds = 300; }
  } else if (kind === "STEP") {
    lowSeconds = 30; highSeconds = 180;
  } else {
    lowSeconds = 15; highSeconds = 600;
  }
  return { lowMs: lowSeconds * 1_000, highMs: highSeconds * 1_000, p50Ms: (lowSeconds + highSeconds) * 500, sampleCount: 0 };
}

function downloadEstimate({ totalBytes, receivedBytes, throughputBytesPerSecond, networkBytesPerSecond, mobile }) {
  if (!positive(totalBytes)) return null;
  const total = totalBytes;
  const received = Math.min(total, positive(receivedBytes) ? receivedBytes : 0);
  const remaining = Math.max(0, total - received);
  const priorBps = positive(networkBytesPerSecond)
    ? Math.min(mobile ? 8 * MIB : 16 * MIB, Math.max(mobile ? 2 * MIB : 4 * MIB, networkBytesPerSecond))
    : mobile ? DEFAULT_MOBILE_BPS : DEFAULT_DESKTOP_BPS;
  const bps = positive(throughputBytesPerSecond) ? throughputBytesPerSecond : Math.max(1, priorBps);
  const tailMs = mobile ? 2_800 : 1_200;
  const p50 = remaining / bps * 1_000 + tailMs;
  const uncertainty = received > total * 0.15 ? 0.22 : 0.55;
  return { lowMs: p50 * (1 - uncertainty * 0.35), highMs: p50 * (1 + uncertainty), p50Ms: p50, sampleCount: 0 };
}

function roundedSeconds(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1_000);
  if (seconds >= 120) return Math.ceil(seconds / 10) * 10;
  if (seconds >= 60) return Math.ceil(seconds / 5) * 5;
  return Math.ceil(seconds);
}

export function estimateRemaining({ bytes, artifactBytes, totalBytes, receivedBytes, throughputBytesPerSecond, networkBytesPerSecond, history = [], elapsedMS = 0, buildElapsedMS = null, queued = false, reused = false, mobile = false, format, fileId, versionId }) {
  if (queued) return { kind: "queued" };
  const kind = reused ? "cached" : "converted";
  const historical = historyEstimate(history, { kind, bytes, artifactBytes, fileId, versionId, mobile });
  const download = downloadEstimate({ totalBytes, receivedBytes, throughputBytesPerSecond, networkBytesPerSecond, mobile });

  if (historical) {
    const pendingDownload = buildElapsedMS === null && download && positive(throughputBytesPerSecond) && positive(totalBytes)
      && (!positive(receivedBytes) || receivedBytes < totalBytes);
    const highMs = Math.max(historical.highMs, pendingDownload ? elapsedMS + download.highMs + 1_000 : 0);
    if (elapsedMS >= highMs * 1.03 || elapsedMS >= highMs + 3_000) return { kind: "overrun", source: "history" };
    return {
      kind: "estimate", source: "history",
      lowSeconds: roundedSeconds(Math.max(0, historical.lowMs - elapsedMS)),
      highSeconds: Math.max(2, roundedSeconds(Math.max(historical.lowMs + 2_000, highMs - elapsedMS))),
    };
  }

  if (buildElapsedMS !== null) {
    const build = buildFallback({ artifactBytes, totalBytes, mobile });
    if (buildElapsedMS >= build.highMs * 1.03 || buildElapsedMS >= build.highMs + 3_000) return { kind: "overrun", source: "build" };
    return {
      kind: "estimate", source: "build",
      lowSeconds: roundedSeconds(Math.max(0, build.lowMs - buildElapsedMS)),
      highSeconds: Math.max(2, roundedSeconds(Math.max(build.lowMs + 2_000, build.highMs - buildElapsedMS))),
    };
  }

  if (download) {
    return { kind: "estimate", source: "download", lowSeconds: roundedSeconds(download.lowMs), highSeconds: Math.max(2, roundedSeconds(download.highMs)) };
  }

  const prior = reused
    ? cachedFallback({ bytes, artifactBytes, totalBytes, networkBytesPerSecond, mobile })
    : coldFallback({ bytes, format });
  if (!prior) return { kind: "pending" };
  if (elapsedMS >= prior.highMs * 1.03 || elapsedMS >= prior.highMs + 3_000) return { kind: "overrun", source: reused ? "cached" : "cold" };
  return {
    kind: "estimate",
    source: reused ? "cached" : "cold",
    lowSeconds: roundedSeconds(Math.max(0, prior.lowMs - elapsedMS)),
    highSeconds: Math.max(2, roundedSeconds(Math.max(prior.lowMs + 2_000, prior.highMs - elapsedMS))),
  };
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

export { HISTORY_LIMIT, MAX_SAMPLE_MS };
