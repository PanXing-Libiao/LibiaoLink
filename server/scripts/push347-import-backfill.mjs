#!/usr/bin/env node
/**
 * Push 347 存量回填（一次性修复工具 · 幂等可重跑）：
 * 2026-10-14 老表导入的 UK 项目（LBGW-20260331-1459）在 Push 347 修复前入库 ——「变更申请人」写成了导入账号（panxing）、
 * 「填写者」列（writer_by）为空。按源表「变更管理」sheet 逐行回填两列（其余字段不动）：
 *   ① 实施阶段 · 2026/8/11「1xxx」→ 申请人 / 填写者 = 贾海洋（jiahaiyang）；
 *   ② 发货阶段 · 2026/8/11「新增物料」→ 贾海洋（jiahaiyang）；
 *   ③ 发货阶段 · 2026/8/11「2x x x」→ 贾海洋（jiahaiyang）；
 *   ④ 实施阶段 · 2026/9/1「供应商货架立柱…」→ 朱成荣（zhuchengrong）。
 * 匹配键 = 项目 code + stage_key + reason 前缀（与源表逐行对应）。
 * 用法：cd server && node --env-file-if-exists=.env scripts/push347-import-backfill.mjs [--dry-run] [--database-url <url>]
 * 退出码：0 = 执行完成（含无可回填）；1 = 出错。
 */
import { Client } from "pg";

const PROJECT_CODE = "LBGW-20260331-1459";
/** 源表「变更管理」行 → 库内落人（按源表原文逐条列出）。 */
const ROWS = [
  { stage: "install", reasonPrefix: "1xxx", username: "jiahaiyang" },
  { stage: "assembly", reasonPrefix: "新增物料", username: "jiahaiyang" },
  { stage: "assembly", reasonPrefix: "2x x x", username: "jiahaiyang" },
  { stage: "install", reasonPrefix: "供应商货架立柱", username: "zhuchengrong" },
];

const args = parseArgs(process.argv.slice(2));
const DATABASE_URL = args.databaseUrl ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:5433/libiaolink";

const client = new Client({ connectionString: DATABASE_URL });
const live = !args.dryRun;

await client.connect();
try {
  const project = (await client.query("select id, code from projects where code = $1", [PROJECT_CODE])).rows[0];
  if (project === undefined) {
    console.log("未找到项目 code = " + PROJECT_CODE + "（跳过）");
    process.exit(0);
  }
  const usernames = [...new Set(ROWS.map((r) => r.username))];
  const users = (await client.query("select id, username from users where username = any($1)", [usernames])).rows;
  const userIdOf = new Map(users.map((u) => [u.username, u.id]));
  for (const name of usernames) {
    if (!userIdOf.has(name)) throw new Error("用户不存在：" + name);
  }
  if (live) await client.query("begin");
  let changed = 0;
  for (const row of ROWS) {
    const uid = userIdOf.get(row.username);
    const matched = (await client.query(
      "select id, applied_by, writer_by, left(reason, 24) as reason from change_requests where project_id = $1 and stage_key = $2 and reason like $3 order by applied_at, created_at",
      [project.id, row.stage, row.reasonPrefix + "%"],
    )).rows;
    if (matched.length === 0) {
      console.log("[warn] 未命中：" + row.stage + " / " + row.reasonPrefix);
      continue;
    }
    const ids = matched.map((m) => m.id);
    const updated = live
      ? (await client.query(
          "update change_requests set applied_by = $2, writer_by = $2 where id = any($1) and (applied_by is distinct from $2 or writer_by is distinct from $2)",
          [ids, uid],
        )).rowCount
      : 0;
    changed += updated;
    for (const m of matched) {
      console.log((live ? "[set] " : "[dry] ") + row.reasonPrefix + " → " + row.username + " · " + m.reason);
    }
  }
  if (live) await client.query("commit");
  const after = (await client.query(
    "select c.stage_key, u1.username as applied_by, u2.username as writer_by, left(c.reason, 16) as reason from change_requests c left join users u1 on u1.id = c.applied_by left join users u2 on u2.id = c.writer_by where c.project_id = $1 order by c.applied_at, c.created_at",
    [project.id],
  )).rows;
  console.log("== 回填" + (live ? changed + " 行" : "演练（未写库）") + " · 现况 ==");
  for (const r of after) console.log([r.stage_key, r.applied_by, r.writer_by, r.reason].join(" | "));
} finally {
  await client.end();
}

function parseArgs(argv) {
  const out = { dryRun: false, databaseUrl: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--database-url") { out.databaseUrl = argv[i + 1]; i++; }
  }
  return out;
}
