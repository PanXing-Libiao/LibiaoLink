#!/usr/bin/env node
/**
 * Push 390 存量回填（一次性修复工具 · 幂等可重跑）：
 * 修复 Push 390 之前导入的 xlsx 单元格换行数字实体（如 `&#10;`）：
 * - daily_reports：done_work / plan / found_issue / suggestion
 * - issues：title / solution
 * 范围默认 = UK 项目代码 LBGW-20260331-1459；按项目限定，只解码数字字符实体，不处理命名实体或普通文本。
 * 用法：cd server && node --env-file-if-exists=.env scripts/push390-import-entity-backfill.mjs [--dry-run] [--project-code <code>] [--database-url <url>]
 * 退出码：0 = 执行完成（含无需回填）；1 = 出错。
 */
import { Client } from "pg";

const DEFAULT_PROJECT_CODE = "LBGW-20260331-1459";
const REPORT_FIELDS = ["done_work", "plan", "found_issue", "suggestion"];
const ISSUE_FIELDS = ["title", "solution"];

function parseArgs(argv) {
  const out = { dryRun: false, projectCode: DEFAULT_PROJECT_CODE };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") out.dryRun = true;
    else if (item === "--project-code") out.projectCode = argv[++index];
    else if (item === "--database-url") out.databaseUrl = argv[++index];
  }
  return out;
}

function isXmlCodePoint(codePoint) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function decodeNumericXmlEntities(value) {
  return value.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/g, (entity, hex, decimal) => {
    const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
    return isXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
  });
}

function decodeField(value) {
  return value === null ? null : decodeNumericXmlEntities(value);
}

function changedFields(row, fields) {
  const next = {};
  const changed = [];
  for (const field of fields) {
    const decoded = decodeField(row[field]);
    next[field] = decoded;
    if (decoded !== row[field]) changed.push(field);
  }
  return { next, changed };
}

function addCounts(target, fields) {
  for (const field of fields) target[field] = (target[field] ?? 0) + 1;
}

const args = parseArgs(process.argv.slice(2));
const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL（或 --database-url）");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
let inTransaction = false;
try {
  const project = (await client.query("select id, code from projects where code = $1", [args.projectCode])).rows[0];
  if (project === undefined) {
    console.log("项目不存在（已删除？）：" + args.projectCode + " —— 无可回填");
    process.exit(0);
  }
  console.log("项目 " + project.code + " → " + project.id + "；dry-run=" + String(args.dryRun));

  const reports = (await client.query(
    "select id, done_work, plan, found_issue, suggestion from daily_reports where project_id = $1 order by report_date, id",
    [project.id],
  )).rows;
  const reportChanges = reports.map((row) => ({ row, ...changedFields(row, REPORT_FIELDS) })).filter((entry) => entry.changed.length > 0);
  const reportCounts = {};
  for (const entry of reportChanges) addCounts(reportCounts, entry.changed);
  console.log("daily_reports：扫描 " + String(reports.length) + " 条，待回填 " + String(reportChanges.length) + " 条；字段=" + JSON.stringify(reportCounts));

  const issues = (await client.query(
    "select id, title, solution from issues where project_id = $1 order by raised_at, id",
    [project.id],
  )).rows;
  const issueChanges = issues.map((row) => ({ row, ...changedFields(row, ISSUE_FIELDS) })).filter((entry) => entry.changed.length > 0);
  const issueCounts = {};
  for (const entry of issueChanges) addCounts(issueCounts, entry.changed);
  console.log("issues：扫描 " + String(issues.length) + " 条，待回填 " + String(issueChanges.length) + " 条；字段=" + JSON.stringify(issueCounts));

  if (!args.dryRun && (reportChanges.length > 0 || issueChanges.length > 0)) {
    await client.query("begin");
    inTransaction = true;
    for (const entry of reportChanges) {
      await client.query(
        "update daily_reports set done_work = $2, plan = $3, found_issue = $4, suggestion = $5, updated_at = now(), version = version + 1 where id = $1",
        [entry.row.id, entry.next.done_work, entry.next.plan, entry.next.found_issue, entry.next.suggestion],
      );
    }
    for (const entry of issueChanges) {
      await client.query(
        "update issues set title = $2, solution = $3, updated_at = now(), version = version + 1 where id = $1",
        [entry.row.id, entry.next.title, entry.next.solution],
      );
    }
    await client.query("commit");
    inTransaction = false;
    console.log("已提交：daily_reports " + String(reportChanges.length) + " 条，issues " + String(issueChanges.length) + " 条");
  } else if (args.dryRun) {
    console.log("dry-run：未写库");
  } else {
    console.log("无需回填");
  }
} catch (error) {
  if (inTransaction) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
