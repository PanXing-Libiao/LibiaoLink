import { expect, it } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const databaseUrl = process.env.CAD_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("0068 upgrades existing STEP records and supports a coordinated rollback of derived DXF indexes", async () => {
  const target = new URL(databaseUrl!);
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.startsWith("/libiaolink_cad_test")) throw new Error("Dedicated local CAD database required");
  const pool = new Pool({ connectionString: target.toString(), max: 1 }), db = await pool.connect();
  const schema = "cad_upgrade_" + randomBytes(6).toString("hex");
  try {
    await db.query(`create schema ${schema}`); await db.query(`set search_path to ${schema}`);
    await db.query("create table files(id uuid primary key); create table file_versions(id uuid primary key)");
    await db.query(await readFile(new URL("../../database/migrations/0064_cad_artifacts.sql", import.meta.url), "utf8"));
    const fileId = randomUUID(), versionId = randomUUID(), sha = "1".repeat(64);
    await db.query("insert into files values($1)", [fileId]); await db.query("insert into file_versions values($1)", [versionId]);
    const oldInsert = "insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version) values($1,$2,$3,10,'box.step','old-release') on conflict(version_id,engine_version,name_codepage) do nothing returning id";
    const oldId = (await db.query(oldInsert, [fileId, versionId, sha])).rows[0].id;
    await db.query(await readFile(new URL("../../database/migrations/0068_cad_dxf_input_sets.sql", import.meta.url), "utf8"));
    expect((await db.query("select id,source_format,main_path,companions,resource_set_hash from cad_artifacts")).rows).toEqual([
      { id: oldId, source_format: "STEP", main_path: "box.step", companions: [], resource_set_hash: "0".repeat(64) },
    ]);
    await expect(db.query("update cad_artifacts set state='partial' where id=$1", [oldId])).rejects.toMatchObject({ code: "23514" });
    for (const hash of ["2".repeat(64), "3".repeat(64)]) {
      await db.query("insert into cad_artifacts(file_id,version_id,source_sha256,source_bytes,source_name,engine_version,source_format,main_path,resource_set_hash) values($1,$2,$3,10,'main.dxf','new-release','DXF','main.dxf',$4)", [fileId, versionId, sha, hash]);
    }
    expect((await db.query("select id from cad_artifacts")).rowCount).toBe(3);
    await expect(db.query(oldInsert, [fileId, versionId, sha])).rejects.toMatchObject({ code: "42P10" });
    // The new unique key is a contract change: stop API/worker and remove only
    // rebuildable DXF derivatives before restoring the old binary's key.
    await db.query("delete from cad_artifacts where source_format='DXF'");
    await db.query("alter table cad_artifacts drop constraint uq_cad_artifacts_input_set; alter table cad_artifacts add constraint uq_cad_artifacts_version_engine_encoding unique(version_id,engine_version,name_codepage)");
    expect((await db.query(oldInsert, [fileId, versionId, sha])).rowCount).toBe(0);
    expect((await db.query("select id from cad_artifacts")).rows).toEqual([{ id: oldId }]);
    expect((await db.query("select id from file_versions")).rows).toEqual([{ id: versionId }]);
  } finally { await db.query(`drop schema if exists ${schema} cascade`); db.release(); await pool.end(); }
});
