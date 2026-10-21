#!/usr/bin/env node
/**
 * Push 319 存量回填（一次性修复工具 · 幂等可重跑）：
 * 2026-10-14 老表导入的 UK 项目（LBGW-20260331-1459）在 Push 319 修复前入库，两处历史口径按新口径补齐：
 * ① 未解决（open / in_progress）问题 owner_id 为空 → 置为项目第一位项目经理（与 commit 新口径一致：ISSUE_OWNER_FALLBACK）；
 * ② 源表「变更管理」sheet「关联」列（写任务描述）未回写任务 change_refs → 按源表逐条补（匹配键 = 项目 + 阶段 + 日期 + reason 前缀；
 *    reason = 内容 +「；原因：」合并落库）：
 *    - 「新增物料」（发货阶段 · 2026/8/11）→ 关联「包装Packing」→ 任务「包装」；
 *    - 「2x x x」（发货阶段 · 2026/8/11）→ 关联「物料清单完整版」→ 任务「物料清单完整版」；
 *    - 「供应商货架立柱…」（实施阶段 · 2026/9/1）→ 关联「布局定档Layout scheduling」→ 任务「布局定档」；
 *    - 「1xxx」（实施阶段 · 2026/8/11）关联为空 → 不回写。
 * 用法：cd server && node --env-file-if-exists=.env scripts/push319-import-backfill.mjs [--dry-run] [--database-url <url>]
 *   --dry-run 只打印将回填的行，不写库。
 * 退出码：0 = 执行完成（含无可回填）；1 = 出错。
 */
import { Client } from "pg";

/** 单引号字面量（SQL 文本里避免转义引号）。 */
const q = String.fromCharCode(39);

const PROJECT_CODE = "LBGW-20260331-1459";
/** 源表「关联」列 → 任务标题（按源表原文逐条列出）。 */
const CHANGE_LINKS = [
  { date: "2026-08-11", stage: "assembly", reasonPrefix: "新增物料", taskTitle: "包装" },
  { date: "2026-08-11", stage: "assembly", reasonPrefix: "2x x x", taskTitle: "物料清单完整版" },
  { date: "2026-09-01", stage: "install", reasonPrefix: "供应商货架立柱", taskTitle: "布局定档" },
];

const args = parseArgs(process.argv.slice(2));
const DATABASE_URL = args.databaseUrl ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:5433/libiaolink";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--dry-run") out.dryRun = true;
    else if (item === "--database-url") out.databaseUrl = argv[++i];
  }
  return out;
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const project = (await client.query("select id, manager_ids from projects where code = $1", [PROJECT_CODE])).rows[0];
  if (project === undefined) {
    console.log("项目不存在（已删除？）：" + PROJECT_CODE + " —— 无可回填");
    process.exit(0);
  }
  console.log("项目 " + PROJECT_CODE + " → " + project.id);

  // ① 未解决问题默认处理人 = 项目经理首位（manager_ids[0]；无经理 = 跳过并提示）
  const managerId = project.manager_ids?.[0] ?? null;
  const pending = (await client.query(
    "select id from issues where project_id = $1 and state <> " + q + "done" + q + " and owner_id is null order by raised_at",
    [project.id],
  )).rows;
  if (managerId === null) {
    console.log("⚠ 项目没有项目经理（manager_ids 空）—— 跳过问题处理人回填（" + String(pending.length) + " 条）");
  } else if (pending.length === 0) {
    console.log("① 问题处理人：无待回填（均为 done 或已有处理人）");
  } else if (args.dryRun) {
    for (const row of pending) console.log("[dry-run] issue=" + row.id + " → owner=" + managerId);
  } else {
    const result = await client.query(
      "update issues set owner_id = $1 where project_id = $2 and state <> " + q + "done" + q + " and owner_id is null",
      [managerId, project.id],
    );
    console.log("① 问题处理人：回填 " + String(result.rowCount) + " 条（owner=" + managerId + "）");
  }

  // ② 变更关联（源表「关联」列）→ change_refs 追加（幂等：已在 refs 内跳过）
  const changes = (await client.query(
    "select id, applied_at::date::text as day, stage_key, reason from change_requests where project_id = $1 order by applied_at",
    [project.id],
  )).rows;
  for (const link of CHANGE_LINKS) {
    const hit = changes.filter(
      (row) => row.day === link.date && row.stage_key === link.stage && row.reason.startsWith(link.reasonPrefix),
    );
    if (hit.length === 0) {
      console.log("② 变更未命中（跳过）：" + link.date + " / " + link.stage + " / " + link.reasonPrefix);
      continue;
    }
    if (hit.length > 1) {
      console.log("② 变更命中多条（跳过 · 请人工核对）：" + link.date + " / " + link.stage + " / " + link.reasonPrefix);
      continue;
    }
    const changeId = hit[0].id;
    const task = (await client.query(
      "select id, change_refs from tasks where project_id = $1 and title = $2",
      [project.id, link.taskTitle],
    )).rows[0];
    if (task === undefined) {
      console.log("② 任务不存在（跳过）：" + link.taskTitle);
      continue;
    }
    if (task.change_refs.includes(changeId)) {
      console.log("② 已关联（幂等跳过）：" + link.taskTitle + " ← " + changeId);
      continue;
    }
    if (args.dryRun) {
      console.log("[dry-run] task=" + link.taskTitle + "(" + task.id + ") += change=" + changeId);
      continue;
    }
    await client.query(
      "update tasks set change_refs = array_append(change_refs, $1::uuid) where id = $2",
      [changeId, task.id],
    );
    console.log("② 已回写：" + link.taskTitle + " ← " + changeId);
  }
  console.log("完成（dry-run=" + String(args.dryRun) + "）");
} finally {
  await client.end();
}
