import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CadArchiveWorker } from "../src/modules/file/cad-archive.worker.js";
import type { CadArchiveRepository, CadArtifactRow, CadFailureContext } from "../src/modules/file/cad-archive.repository.js";
import { CadEngineBusyError, type CadEngineClient, type CadJob } from "../src/modules/file/cad-engine.client.js";
import type { FileRepository } from "../src/modules/file/file.repository.js";
import type { ObjectStorage } from "../src/storage/index.js";

function fixture(state: CadJob["state"], code?: string, options: {
  sourceFormat?: "STEP" | "DXF" | "DWG"; sourceName?: string; manifest?: Record<string, unknown>; resources?: Map<string, Buffer>;
} = {}) {
  const body = Buffer.from("abc"), sha = createHash("sha256").update(body).digest("hex");
  const sourceFormat = options.sourceFormat ?? "STEP";
  const sourceName = options.sourceName ?? (sourceFormat === "DWG" ? "box.dwg" : "box.step");
  const row: CadArtifactRow = { id: "11111111-1111-4111-8111-111111111111", fileId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333", sourceSHA256: sha, sourceBytes: 3, sourceName,
    sourceFormat, mainPath: sourceName, companions: [], resourceSetHash: "0".repeat(64),
    engineVersion: "fixture", formatVersion: "fixture", nameCodepage: "GB", state: "running", phase: "reading", attempts: 1,
    availableAt: new Date(), claimToken: "44444444-4444-4444-8444-444444444444", claimUntil: new Date(),
    objectPrefix: null, manifestSHA256: null, manifestBytes: null, resourceLease: null, buffers: null, artifactBytes: 0,
    errorCode: null, error: null, lastAccessedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const job: CadJob = { id: "5".repeat(32), state, phase: state, sourceSHA256: sha, sourceByteLength: 3,
    createdAt: 1, updatedAt: 1, ...(code ? { error: { code, error: "controlled conversion failure" } } : {}) };
  const failures: { code: string; retryable: boolean; context: CadFailureContext | undefined }[] = [];
  const repository = { clearExpiredViews: async () => {}, claim: async () => row, renew: async () => true,
    publish: vi.fn(async (..._args: unknown[]) => true),
    async fail(_row: CadArtifactRow, code: string, _message: string, retryable: boolean, context?: CadFailureContext) {
      failures.push({ code, retryable, context });
    } };
  const raw = Buffer.from(JSON.stringify(options.manifest ?? { resourceLease: "6".repeat(48), presentation: { sourceSHA256: sha },
    snapshot: { completeness: "complete" }, document: { buffers: {} }, bufferResources: {} }));
  const engine = { enabled: true, inputLimit: 64 * 1024 ** 2, lookup: vi.fn(async () => null),
    submit: async () => ({ job, reused: false }), status: async () => job,
    cancel: vi.fn(async () => ({ ...job, state: "cancelled" as const })), release: async () => {},
    file: async (action: string, request: { sha256?: string }) => {
      if (action === "manifest") return { stream: Readable.from([raw]), bytes: raw.byteLength };
      const resource = options.resources?.get(request.sha256 ?? "");
      if (!resource) throw new Error("missing fixture resource");
      return { stream: Readable.from([resource]), bytes: resource.byteLength };
    } };
  const files = { findFileById: async () => ({ id: row.fileId, projectId: "7".repeat(32), status: "draft" }),
    findVersionById: async () => ({ id: row.versionId, contentHash: sha, sizeBytes: 3, objectKey: "source.step" }) };
  const storage = { getObject: async () => ({ bytes: body }), purgePrefix: async () => {}, putObject: async () => {},
    putObjectStream: vi.fn(async () => {}) };
  const worker = new CadArchiveWorker(repository as unknown as CadArchiveRepository, files as unknown as FileRepository,
    engine as unknown as CadEngineClient, storage as unknown as ObjectStorage,
    { assertAvailable: async () => {}, enginePayload: async () => ({ body, byteLength: body.byteLength, sha256: sha }) } as never,
    { runIfDue: async () => {} } as never);
  return { worker, engine, repository, failures, job, storage };
}

afterEach(() => vi.restoreAllMocks());

describe("CAD failure audit context", () => {
  it.each([
    ["failed", "conversion-failed"], ["failed", "job-memory-quota"], ["failed", "job-output-quota"],
    ["timed-out", "job-queue-timeout"], ["cancelled", "conversion-cancelled"],
  ] as const)("%s / %s retains the native task and terminal state", async (state, code) => {
    const env = fixture(state, code); await env.worker.drainOnce();
    expect(env.failures).toEqual([{ code, retryable: false, context: { nativeJobId: env.job.id, terminalState: state } }]);
    expect(env.repository.publish).not.toHaveBeenCalled();
  });

  it("a native timeout without an error payload is still recorded as a timeout", async () => {
    const env = fixture("timed-out"); await env.worker.drainOnce();
    expect(env.failures).toEqual([{ code: "job-timeout", retryable: false,
      context: { nativeJobId: env.job.id, terminalState: "timed-out" } }]);
  });

  it("the platform deadline cancels the native task and preserves its identity for audit", async () => {
    const env = fixture("queued"), now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 27 * 60_000);
    await env.worker.drainOnce();
    expect(env.engine.cancel).toHaveBeenCalledOnce();
    expect(env.failures).toEqual([{ code: "conversion-timeout", retryable: false, context: { nativeJobId: env.job.id } }]);
  });

  it("a completed conversion publishes normally without emitting a failure", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    const env = fixture("completed"); await env.worker.drainOnce();
    const entry = log.mock.calls.map(call => call[0]).find(value => value?.event === "cad.archive.timing");
    expect(entry).toMatchObject({ outcome: "published", attempt: 1 });
    expect(Object.keys(entry.timings).sort()).toEqual(["eligibleQueueWaitMS", "engineWaitMS", "inputLookupSubmitMS", "persistMS", "totalMS"]);
    for (const value of Object.values(entry.timings)) expect(value).toBeGreaterThanOrEqual(0);
    expect(env.repository.publish).toHaveBeenCalledOnce(); expect(env.failures).toEqual([]);
  });

  it("an explicit sandbox quota rejection remains retryable and is identified for audit", async () => {
    const env = fixture("queued"); env.engine.lookup.mockRejectedValueOnce(new CadEngineBusyError());
    await env.worker.drainOnce();
    expect(env.failures).toEqual([{ code: "engine-busy", retryable: true, context: {} }]);
    expect(env.repository.publish).not.toHaveBeenCalled();
  });
});

describe("DWG spatial chunk archive persistence", () => {
  const lease = "6".repeat(48);
  const chunk = Buffer.from("CDW1-fixture-chunk");
  const chunkSHA = createHash("sha256").update(chunk).digest("hex");
  const sourceSHA = createHash("sha256").update(Buffer.from("abc")).digest("hex");

  function manifest(resources: Record<string, unknown>[]) {
    return { resourceLease: lease, presentation: { sourceSHA256: sourceSHA },
      snapshot: { completeness: "partial" }, document: { buffers: {} }, bufferResources: {}, chunkResources: resources };
  }
  function resource(overrides: Record<string, unknown> = {}) {
    return { id: "chunk-tile-000", sha256: chunkSHA, byteLength: chunk.byteLength,
      contentType: "application/vnd.libiaolink.dwg-chunk/1",
      url: `/api/resources/${lease}/${chunkSHA}`, ...overrides };
  }

  it("persists chunk bundles before publishing the manifest", async () => {
    const env = fixture("partial", undefined, { sourceFormat: "DWG", manifest: manifest([resource()]),
      resources: new Map([[chunkSHA, chunk]]) });
    await env.worker.drainOnce();
    expect(env.failures).toEqual([]);
    expect(env.repository.publish).toHaveBeenCalledOnce();
    const artifact = (env.repository.publish as unknown as { mock: { calls: [unknown, {
      buffers: { sha256: string; byteLength: number; objectKey: string }[]; artifactBytes: number;
    }][] } }).mock.calls[0]![1];
    expect(artifact.buffers).toEqual([{ sha256: chunkSHA, byteLength: chunk.byteLength,
      objectKey: expect.stringMatching(new RegExp(chunkSHA + "$")) }]);
    expect(artifact.artifactBytes).toBe(Buffer.byteLength(JSON.stringify(manifest([resource()]))) + chunk.byteLength);
    expect(env.storage.putObjectStream).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: expect.stringMatching(new RegExp(chunkSHA + "$")), sizeBytes: chunk.byteLength,
    }));
  });

  it("rejects a duplicate chunk id before publishing", async () => {
    const env = fixture("partial", undefined, { sourceFormat: "DWG",
      manifest: manifest([resource(), resource({ sha256: "a".repeat(64) })]),
      resources: new Map([[chunkSHA, chunk]]) });
    await env.worker.drainOnce();
    expect(env.repository.publish).not.toHaveBeenCalled();
    expect(env.failures).toEqual([{ code: "archive-unavailable", retryable: true,
      context: { nativeJobId: env.job.id } }]);
  });

  it("rejects a chunk URL that does not carry the active lease", async () => {
    const env = fixture("partial", undefined, { sourceFormat: "DWG",
      manifest: manifest([resource({ url: "/api/resources/" + "b".repeat(48) + "/" + chunkSHA })]),
      resources: new Map([[chunkSHA, chunk]]) });
    await env.worker.drainOnce();
    expect(env.repository.publish).not.toHaveBeenCalled();
    expect(env.failures[0]?.code).toBe("archive-unavailable");
  });

  it.each([
    ["declared length", resource({ byteLength: chunk.byteLength + 1 })],
    ["content digest", resource({ sha256: "c".repeat(64) })],
  ])("rejects a chunk with a mismatched %s", async (_label, entry) => {
    const key = (entry as { sha256: string }).sha256;
    const env = fixture("partial", undefined, { sourceFormat: "DWG", manifest: manifest([entry]),
      resources: new Map([[key, chunk]]) });
    await env.worker.drainOnce();
    expect(env.repository.publish).not.toHaveBeenCalled();
    expect(env.failures[0]?.code).toBe("archive-unavailable");
  });
});
