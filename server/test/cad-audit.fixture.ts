import { readFile } from "node:fs/promises";
import type { DatabaseService } from "../src/db/database.service.js";

/** Real immutable audit DDL and CAD tables, inside each test's disposable local schema. */
export async function installCadAuditTables(database: DatabaseService, actorId: string) {
  await database.pool.query(`
    create table users(id uuid primary key, display_name text);
    create table files(id uuid primary key, project_id uuid not null);
    create table file_versions(id uuid primary key);
  `);
  const migration = await readFile(new URL("../../database/migrations/0013_admin_dict_audit.sql", import.meta.url), "utf8");
  await database.pool.query(migration.slice(migration.indexOf("create table audit_logs"), migration.indexOf("create index ix_audit_logs_object")));
  await database.pool.query(await readFile(new URL("../../database/migrations/0064_cad_artifacts.sql", import.meta.url), "utf8"));
  await database.pool.query(await readFile(new URL("../../database/migrations/0068_cad_dxf_input_sets.sql", import.meta.url), "utf8"));
  await database.pool.query("insert into users(id, display_name) values($1, $2)", [actorId, "CAD 审计测试用户"]);
}
