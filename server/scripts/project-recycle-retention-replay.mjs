#!/usr/bin/env node
/**
 * 项目回收站真机回放（真 PG + 生产 Repository / ProjectService）：
 *   ① seq_no 空号复用：彻底删除后，下一次创建取回同一最小空号；
 *   ② 满 30 天自动清理：deleted_at 满 30 天的项目被 worker 服务方法彻底删除，聚合数据与对象前缀走同一链路；
 *   ③ 未满 30 天不清理；
 *   ④ 系统审计 actorId=null + metadata.source=system。
 *
 * 用法：cd server && node scripts/project-recycle-retention-replay.mjs
 * 前置：先 npm run build；DATABASE_URL 默认本机 5433 migrator。
 * 退出码：全过 0，否则 1。
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../dist/db/schema/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:5433/libiaolink";
const RUN = randomUUID().slice(0, 8);
const PREFIX = "PXRET-" + RUN + "-";
const DAY_MS = 86_400_000;
const checks = [];
let failures = 0;

function check(id, title, ok, actual) {
  if (!ok) failures += 1;
  checks.push({ id, title, ok, actual });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + " | " + actual + "\n");
}

const mod = await import(new URL("../dist/modules/project/project.repository.js", import.meta.url).href);
const svcMod = await import(new URL("../dist/modules/project/project.service.js", import.meta.url).href);
const ProjectRepository = mod.ProjectRepository;
const ProjectService = svcMod.ProjectService;

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
const db = drizzle(pool, { schema });
const audit = {
  entries: [],
  async record(_tx, input) {
    this.entries.push(input);
  },
};
const storage = {
  prefixes: [],
  async purgePrefix(prefix) {
    this.prefixes.push(prefix);
    return { deletedVersions: 1, deleteMarkers: 0, deletedObjects: 1 };
  },
};
const permission = {
  async permissionsOf() {
    return { roleCodes: ["admin"], dataScopes: [], permissionKeys: [] };
  },
};
const projectRepo = new ProjectRepository({ db });
const service = new ProjectService({ db }, projectRepo, {}, audit, permission, storage);
const actorId = randomUUID();
const managerId = randomUUID();
let projectIds = [];

function baseInput(suffix) {
  return {
    code: PREFIX + suffix,
    name: "PXRET 回放 " + suffix,
    customer: "回放",
    region: "华东",
    projectType: "分拣",
    managerIds: [managerId],
    stageKey: "presale",
    description: "project-recycle-retention-replay",
  };
}

try {
  const at = new Date();
  const first = await projectRepo.insert(baseInput("A"), at);
  projectIds.push(first.id);
  check("S1", "首次创建分配正序号", Number.isInteger(first.seqNo) && first.seqNo > 0, "seqNo=" + first.seqNo);

  await service.deleteProject(first.id, first.version, actorId);
  await service.purgeProject(first.id, { version: first.version + 1 }, actorId);
  const second = await projectRepo.insert(baseInput("B"), at);
  projectIds.push(second.id);
  check(
    "S2",
    "彻底删除后最小空号复用于下一次创建",
    second.seqNo === first.seqNo,
    "before=" + first.seqNo + " after=" + second.seqNo,
  );

  const [parallelA, parallelB] = await Promise.all([
    db.transaction((tx) => projectRepo.insert(baseInput("P1"), at, tx)),
    db.transaction((tx) => projectRepo.insert(baseInput("P2"), at, tx)),
  ]);
  projectIds.push(parallelA.id, parallelB.id);
  check(
    "S3",
    "并发创建序号唯一（事务级 advisory lock）",
    parallelA.seqNo !== parallelB.seqNo,
    "seqA=" + parallelA.seqNo + " seqB=" + parallelB.seqNo,
  );

  const due = await projectRepo.insert(baseInput("C"), at);
  projectIds.push(due.id);
  const recycled = await service.deleteProject(due.id, due.version, actorId);
  projectIds = projectIds.filter((id) => id !== due.id);
  await pool.query("update projects set deleted_at = now() - interval '31 days' where id = $1", [due.id]);
  const beforePurge = audit.entries.length;
  const swept = await service.sweepExpiredRecycled(20, new Date());
  const stillThere = (await pool.query("select count(*)::int n from projects where id = $1", [due.id])).rows[0].n;
  const systemAudit = audit.entries.slice(beforePurge).find((entry) => entry.objectId === due.id && entry.actorId === null);
  check(
    "R1",
    "满 30 天自动彻底删除项目行",
    stillThere === 0 && swept.purged >= 1,
    "row=" + stillThere + " scanned=" + swept.scanned + " purged=" + swept.purged,
  );
  check(
    "R2",
    "到期清理复用对象前缀链路 + system 审计",
    storage.prefixes.includes("projects/" + due.id + "/") && systemAudit?.metadata?.source === "system",
    "prefix=" + storage.prefixes.includes("projects/" + due.id + "/") + " source=" + String(systemAudit?.metadata?.source),
  );
  check("R3", "回收站恢复态版本已参与清理", recycled.deletedAt !== null, "deletedAt=" + recycled.deletedAt);

  const fresh = await projectRepo.insert(baseInput("D"), at);
  projectIds.push(fresh.id);
  await service.deleteProject(fresh.id, fresh.version, actorId);
  await pool.query("update projects set deleted_at = now() - interval '29 days' where id = $1", [fresh.id]);
  const sweptFresh = await service.sweepExpiredRecycled(20, new Date());
  const freshStill = (await pool.query("select count(*)::int n from projects where id = $1", [fresh.id])).rows[0].n;
  check(
    "R4",
    "未满 30 天不清理",
    freshStill === 1,
    "row=" + freshStill + " scanned=" + sweptFresh.scanned + " purged=" + sweptFresh.purged,
  );
} catch (error) {
  failures += 1;
  process.stdout.write("EXCEPTION " + String(error?.stack ?? error) + "\n");
} finally {
  try {
    if (projectIds.length > 0) {
      await pool.query("delete from follows where object_type = 'project' and object_id = any($1::uuid[])", [projectIds]);
      await pool.query("delete from audit_logs where project_id = any($1::uuid[])", [projectIds]);
      await pool.query("delete from projects where id = any($1::uuid[])", [projectIds]);
    }
    await pool.query("delete from projects where code like $1", [PREFIX + "%"]);
  } catch (error) {
    process.stdout.write("cleanup failed: " + String(error?.message ?? error) + "\n");
    failures += 1;
  }
  await pool.end().catch(() => undefined);
}

process.stdout.write("结果：" + (failures === 0 ? "全部通过" : failures + " 项失败") + "（" + checks.length + " 项）\n");
process.exit(failures === 0 ? 0 : 1);
