import { expect, it } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const databaseUrl = process.env.CAD_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("0069 backfills format_version and keys artifacts by format instead of engine bundle", async () => {
  const target = new URL(databaseUrl!);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.startsWith("/libiaolink_cad_test")) throw new Error("Dedicated local CAD database required");
  const pool = new Pool({ connectionString: target.toString(), max: 1 }), db = await pool.connect();
  const schema = "cad_format_" + randomBytes(6).toString("hex");
  try {
    await db.query(`create schema ${schema}`); await db.query(`set search_path to ${schema}`);
    await db.query("create table files(id uuid primary key); create table file_versions(id uuid primary key)");
    await db.query(await readFile(new URL("../../database/migrations/0064_cad_artifacts.sql", import.meta.url), "utf8"));
    await db.query(await readFile(new URL("../../database/migrations/0068_cad_dxf_input_sets.sql", import.meta.url), "utf8"));
    const fileId = randomUUID(), versionId = randomUUID(), sha = "1".repeat(64);
    await db.query("insert into files values($1)", [fileId]); await db.query("insert into file_versions values($1)", [versionId]);
    const oldId = (await db.query("insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version,main_path) values($1,$2,$3,10,'box.step','old-bundle','box.step') returning id", [fileId, versionId, sha])).rows[0].id;

    await db.query(await readFile(new URL("../../database/migrations/0069_cad_format_version.sql", import.meta.url), "utf8"));
    expect((await db.query("select id,engine_version,format_version from cad_artifacts")).rows).toEqual([
      { id: oldId, engine_version: "old-bundle", format_version: "old-bundle" },
    ]);
    expect((await db.query("select state,error_code from cad_artifacts where id=$1", [oldId])).rows[0]).toEqual({ state: "failed", error_code: "engine-version-retired" });
    const stepVersion = "step-0.3.3/" + "2".repeat(64) + "/gateway-1";
    await db.query("insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version,format_version,main_path) values($1,$2,$3,10,'box.step','new-bundle',$4,'box.step')", [fileId, versionId, sha, stepVersion]);
    await expect(db.query("insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version,format_version,main_path) values($1,$2,$3,10,'box.step','other-bundle',$4,'box.step')", [fileId, versionId, sha, stepVersion])).rejects.toMatchObject({ code: "23505" });
    await expect(db.query("insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version,format_version,main_path) values($1,$2,$3,10,'box.step','new-bundle','','box.step')", [fileId, versionId, sha])).rejects.toMatchObject({ code: "23514" });
    expect((await db.query("select engine_version,format_version from cad_artifacts order by format_version")).rows).toEqual([
      { engine_version: "new-bundle", format_version: stepVersion },
      { engine_version: "old-bundle", format_version: "old-bundle" },
    ]);
  } finally { await db.query(`drop schema if exists ${schema} cascade`); db.release(); await pool.end(); }
});
