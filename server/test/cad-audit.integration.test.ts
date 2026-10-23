import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AppConfig } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { DatabaseService } from "../src/db/database.service.js";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";
import { AuditService } from "../src/modules/audit/audit.service.js";
import { CadArchiveRepository, type CadArchiveSource } from "../src/modules/file/cad-archive.repository.js";
import { CadArchiveService } from "../src/modules/file/cad-archive.service.js";
import { CadEngineClient } from "../src/modules/file/cad-engine.client.js";
import type { ObjectStorage } from "../src/storage/index.js";
import { installCadAuditTables } from "./cad-audit.fixture.js";

const databaseUrl = process.env.CAD_TEST_DATABASE_URL;
const actorId = randomUUID(), projectId = randomUUID();
const schemaName = "cad_audit_" + randomBytes(8).toString("hex");
let database: DatabaseService, admin: Pool, audit: AuditService, repository: CadArchiveRepository, engine: CadEngineClient;
const events = async (fileId: string) => (await database.pool.query("select * from audit_logs where object_id=$1 order by id", [fileId])).rows;
const state = async (id: string) => (await database.pool.query("select * from cad_artifacts where id=$1", [id])).rows[0];

async function source(): Promise<CadArchiveSource> {
  const row = { fileId: randomUUID(), versionId: randomUUID(), sourceSHA256: "1".repeat(64), sourceBytes: 3, sourceName: "box.step" };
  await database.pool.query("insert into files(id, project_id) values($1,$2)", [row.fileId, projectId]);
  await database.pool.query("insert into file_versions(id) values($1)", [row.versionId]);
  return row;
}
async function running() {
  const input = await source(); await repository.request(input, "GB");
  const row = await repository.claim();
  if (!row) throw new Error("Expected claimed CAD task");
  return { input, row };
}

describe.skipIf(!databaseUrl)("CAD audit transactions with PostgreSQL", () => {
  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.startsWith("/libiaolink_cad_test")) {
      throw new Error("Dedicated local CAD test database required");
    }
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`create schema ${schemaName}`);
    target.searchParams.set("options", "-c search_path=" + schemaName);
    const config = new AppConfig(loadEnv({ NODE_ENV: "test", DATABASE_URL: target.toString(), CAD_ENGINE_URL: "http://127.0.0.1:9910" }));
    database = new DatabaseService(config);
    await installCadAuditTables(database, actorId);
    audit = new AuditService(database, new AuditRepository(database));
    repository = new CadArchiveRepository(database, audit);
    engine = new CadEngineClient(config);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await database.pool.query("update cad_artifacts set state='failed' where state in ('queued','running')");
  });
  afterAll(async () => {
    await engine?.onModuleDestroy(); await database?.onApplicationShutdown();
    if (admin) { await admin.query(`drop schema if exists ${schemaName} cascade`); await admin.end(); }
  });

  it.each([
    ["conversion-failed", undefined, "cad.failed"],
    ["job-memory-quota", "failed", "cad.limit_exceeded"],
    ["job-output-quota", "failed", "cad.limit_exceeded"],
    ["artifact-budget", undefined, "cad.limit_exceeded"],
    ["engine-busy", undefined, "cad.limit_exceeded"],
    ["job-timeout", "timed-out", "cad.timed_out"],
    ["job-queue-timeout", "timed-out", "cad.timed_out"],
    ["conversion-timeout", undefined, "cad.timed_out"],
    ["conversion-failed", "timed-out", "cad.timed_out"],
  ] as const)("%s / %s preserves an immutable %s event", async (code, terminalState, operation) => {
    const { input, row } = await running();
    await repository.fail(row, code, "safe failure", false, { nativeJobId: "2".repeat(32), terminalState });
    expect(await events(input.fileId)).toMatchObject([{ actor_id: null, entry: "system", action: "update", result: "failed",
      object_type: "file", project_id: projectId, metadata: { operation, versionId: input.versionId, artifactId: row.id,
        attempt: 1, errorCode: code, nativeJobId: "2".repeat(32), retryScheduled: false } }]);
    expect((await state(row.id)).state).toBe("failed");
  });

  it("retries retain earlier failure details and concurrent stale completions do not duplicate events", async () => {
    const { input, row } = await running();
    await Promise.all(Array.from({ length: 3 }, () => repository.fail(row, "job-memory-quota", "too large", true)));
    expect(await events(input.fileId)).toHaveLength(1);
    await repository.retry(row.id, "queued");
    expect((await state(row.id)).error_code).toBeNull();
    expect((await events(input.fileId))[0].metadata.errorCode).toBe("job-memory-quota");
    const next = (await repository.claim())!;
    await repository.fail(row, "conversion-failed", "stale worker", false);
    expect(await events(input.fileId)).toHaveLength(1);
    await repository.fail(next, "job-timeout", "deadline", false);
    expect((await events(input.fileId)).map((event) => event.metadata.operation)).toEqual(["cad.limit_exceeded", "cad.timed_out"]);
  });

  it("concurrent cancellation commits exactly one user event and leaves the shared conversion running", async () => {
    const { input, row } = await running();
    const view = await repository.openView(row.id, actorId, "3".repeat(32));
    await Promise.all(Array.from({ length: 5 }, () => repository.cancelView(view.id)));
    expect(await events(input.fileId)).toMatchObject([{ actor_id: actorId, actor_name: "CAD 审计测试用户", entry: "api",
      result: "succeeded", metadata: { operation: "cad.cancelled", artifactId: row.id, versionId: input.versionId,
        viewId: view.viewId, viewJobId: view.id.replaceAll("-", "") } }]);
    expect((await state(row.id)).state).toBe("running");
  }, 10_000);

  it.each(["failure", "cancel"] as const)("audit failure rolls back the %s state transition", async (action) => {
    const { input, row } = await running();
    const view = await repository.openView(row.id, actorId, "4".repeat(32));
    vi.spyOn(audit, "record").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(action === "failure" ? repository.fail(row, "job-timeout", "deadline", false) : repository.cancelView(view.id))
      .rejects.toThrow("audit unavailable");
    expect((await state(row.id)).state).toBe("running");
    expect((await database.pool.query("select cancelled from cad_views where id=$1", [view.id])).rows[0].cancelled).toBe(false);
    expect(await events(input.fileId)).toHaveLength(0);
  });

  it("expired claims retain every interrupted attempt, including the final exhausted claim", async () => {
    const { input, row } = await running();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await database.pool.query("update cad_artifacts set claim_until=now()-interval '1 second' where id=$1", [row.id]);
      const next = await repository.claim();
      expect(next?.attempts ?? null).toBe(attempt < 3 ? attempt + 1 : null);
    }
    expect((await events(input.fileId)).map((event) => [event.metadata.errorCode, event.metadata.attempt])).toEqual([
      ["worker-interrupted", 1], ["worker-interrupted", 2], ["worker-interrupted", 3],
    ]);
    expect((await state(row.id)).state).toBe("failed");
  });

  it("view expiry and file deletion do not remove the cancellation history", async () => {
    const { input, row } = await running();
    const view = await repository.openView(row.id, actorId, "5".repeat(32));
    await repository.cancelView(view.id);
    await database.pool.query("update cad_views set expires_at=now()-interval '1 second' where id=$1", [view.id]);
    await repository.clearExpiredViews();
    await database.pool.query("delete from files where id=$1", [input.fileId]);
    expect(await events(input.fileId)).toHaveLength(1);
  });

  it("oversized input is audited without creating a conversion task", async () => {
    const input = { ...await source(), sourceBytes: engine.inputLimit + 1 };
    const archive = new CadArchiveService(repository, {} as ObjectStorage, engine);
    await expect(archive.create(input, actorId, "6".repeat(32), "GB")).rejects.toMatchObject({ status: 503 });
    expect((await database.pool.query("select id from cad_artifacts where version_id=$1", [input.versionId])).rows).toHaveLength(0);
    expect(await events(input.fileId)).toMatchObject([{ actor_id: actorId, entry: "api", result: "failed",
      metadata: { operation: "cad.limit_exceeded", errorCode: "input-limit", versionId: input.versionId,
        sourceBytes: input.sourceBytes, limitBytes: engine.inputLimit } }]);
  });
});
