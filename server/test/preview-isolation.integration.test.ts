import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import { PreviewRepository } from "../src/modules/file/preview.repository.js";

const databaseUrl = process.env.PREVIEW_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("预览版本隔离（真实 PostgreSQL）", () => {
  it("升级失效旧全局缓存；同哈希独立缓存；失败只影响本版本且不能降级 ready", async () => {
    const schema = "preview_isolation_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pool = new pg.Pool({ connectionString: databaseUrl, options: "-c search_path=" + schema });
    try {
      await admin.query(`create schema ${schema}`);
      await pool.query("create table files (id uuid primary key); create table file_versions (id uuid primary key); create table audit_logs (action text constraint ck_audit_logs_action check (action = 'create'));");
      await pool.query(await readFile(new URL("../../database/migrations/0027_preview_artifacts.sql", import.meta.url), "utf8"));
      const fileA = randomUUID(); const fileB = randomUUID();
      const versionA = randomUUID(); const versionB = randomUUID();
      const contentHash = "a".repeat(64);
      await pool.query("insert into files values ($1), ($2)", [fileA, fileB]);
      await pool.query("insert into file_versions values ($1), ($2)", [versionA, versionB]);
      await pool.query("insert into audit_logs values ('create')");
      await pool.query("insert into preview_artifacts(file_id,version_id,content_hash,pipeline_version,target,status,object_key,generated_at) values($1,$2,$3,'2.0.0','image','ready','previews/legacy',now())", [fileA, versionA, contentHash]);
      await pool.query(await readFile(new URL("../../database/migrations/0067_preview_version_isolation.sql", import.meta.url), "utf8"));
      expect((await pool.query("select * from preview_artifacts")).rowCount).toBe(0);
      expect((await pool.query("select * from file_versions")).rowCount).toBe(2);
      expect((await pool.query("select * from audit_logs")).rowCount).toBe(1);

      const repository = new PreviewRepository({ db: drizzle(pool) } as unknown as DatabaseService);
      const a = { versionId: versionA, contentHash, pipelineVersion: "2.0.0", target: "image" as const };
      const b = { ...a, versionId: versionB };
      await repository.ensureRequested({ ...a, fileId: fileA });
      await repository.ensureRequested({ ...b, fileId: fileB });
      await repository.markReady(a, { objectKey: "previews/versions/a", generatedAt: new Date() });
      await repository.markFailed(b, { error: "本版本转换失败", updatedAt: new Date() });
      await repository.markFailed(a, { error: "迟到的旧任务失败", updatedAt: new Date() });
      expect(await repository.findByKey(a)).toMatchObject({ status: "ready", objectKey: "previews/versions/a", error: null });
      expect(await repository.findByKey(b)).toMatchObject({ status: "failed", objectKey: null, error: "本版本转换失败" });
      expect(await repository.findByKey({ ...a, versionId: randomUUID() })).toBeNull();
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });
});
