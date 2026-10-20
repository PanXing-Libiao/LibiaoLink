#!/usr/bin/env node
/**
 * Push 398 存量回填（一次性修复工具 · 幂等可重跑）：
 * 修复 Push 398 之前的导入项目里，变更「关联」列为空但符合 R01（变更文件 = 任务输出成果文件）的变更：
 * ① 按最近一次 committed 导入票据的 parse 结果，给任务追加 change_refs；
 * ② 已上传的变更后文件若 task_id 为空，补到首个 R01 命中任务（项目总览「文件」列可见）；
 * ③ 修复本轮导入补充附件误写成 final 的文件：current_version.change_request_id 非空且状态 final/draft
 *    → changed，清空 finalized_at / finalized_by；文件乐观锁 version + 1。
 * 默认范围 = UK 项目 LBGW-20260331-1459；只处理该项目最近一次成功导入的变更，不跨项目。
 * 用法：cd server && node --env-file-if-exists=.env scripts/push398-import-change-r01-backfill.mjs [--dry-run] [--project-code <code>] [--database-url <url>]
 * 退出码：0 = 执行完成（含无需回填）；1 = 出错。
 */
import { Client } from "pg";

const DEFAULT_PROJECT_CODE = "LBGW-20260331-1459";

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

function linkKey(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function composeChangeReason(change) {
  const content = change.content === "" ? "" : change.content + (change.contentPlaceholder ? "（内容待补）" : "");
  const reason = change.reason === "" ? "" : change.reason + (change.reasonPlaceholder ? "（原因待补）" : "");
  if (content === "") return reason === "" ? "（原因待补）" : reason;
  if (reason === "") return content;
  return content + "；原因：" + reason;
}

function parsedTaskIndexesForChange(change, tasks) {
  const indexes = [];
  if (change.related !== null && change.related !== undefined) {
    const wanted = String(change.related)
      .replace(/[，、；;]/g, ",")
      .split(",")
      .map(linkKey)
      .filter((key) => key !== "");
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      const keys = [task.title + (task.titleEn === null ? "" : task.titleEn), task.title, task.titleEn ?? ""].map(linkKey);
      if (wanted.some((key) => keys.includes(key))) indexes.push(taskIndex);
    }
  }
  const explicit = indexes.length === 0 ? [] : [indexes[0]];
  if (
    change.appliedAt !== null &&
    change.docType !== null &&
    change.afterFileName !== null &&
    change.afterFileVersion !== null
  ) {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (Array.isArray(task.deliverableTypes) && task.deliverableTypes.includes(change.docType) && !explicit.includes(taskIndex)) {
        explicit.push(taskIndex);
      }
    }
  }
  return explicit;
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
  const preview = (await client.query(
    "select id, payload from project_import_previews where committed_project_id = $1 and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1",
    [project.id],
  )).rows[0];
  if (preview === undefined) {
    console.log("项目没有已提交的导入票据： " + args.projectCode + " —— 无可回填");
    process.exit(0);
  }
  const parse = preview.payload?.parse;
  if (!parse || !Array.isArray(parse.tasks) || !Array.isArray(parse.changes)) {
    throw new Error("导入票据 payload.parse 结构不完整：" + preview.id);
  }
  console.log("项目 " + project.code + " → " + project.id + "；preview=" + preview.id + "；dry-run=" + String(args.dryRun));

  const dbTasks = (await client.query(
    "select id, title, title_en, stage_key, deliverable_types, change_refs from tasks where project_id = $1",
    [project.id],
  )).rows;
  const dbChanges = (await client.query(
    "select id, applied_at::date::text as day, stage_key, reason from change_requests where project_id = $1",
    [project.id],
  )).rows;

  const taskIdByParsedIndex = new Map();
  for (let taskIndex = 0; taskIndex < parse.tasks.length; taskIndex += 1) {
    const task = parse.tasks[taskIndex];
    const hits = dbTasks.filter(
      (row) =>
        row.title === task.title &&
        (task.titleEn === null || row.title_en === task.titleEn) &&
        row.stage_key === task.stageKey,
    );
    if (hits.length === 1) taskIdByParsedIndex.set(taskIndex, hits[0].id);
    else if (hits.length > 1) console.log("任务命中多条，跳过映射： " + task.title);
  }

  const linksByChange = new Map();
  const changeIds = [];
  for (const change of parse.changes) {
    const parsedTaskIndexes = parsedTaskIndexesForChange(change, parse.tasks);
    if (parsedTaskIndexes.length === 0) continue;
    const reason = composeChangeReason(change);
    const hits = dbChanges.filter(
      (row) =>
        row.day === change.appliedAt &&
        row.stage_key === change.stageKey &&
        row.reason === reason,
    );
    if (hits.length !== 1) {
      console.log("变更匹配 " + String(hits.length) + " 条，跳过：" + change.appliedAt + " / " + change.stageKey + " / " + reason);
      continue;
    }
    const changeId = hits[0].id;
    const taskIds = [];
    for (const taskIndex of parsedTaskIndexes) {
      const taskId = taskIdByParsedIndex.get(taskIndex);
      if (taskId !== undefined && !taskIds.includes(taskId)) taskIds.push(taskId);
    }
    if (taskIds.length === 0) {
      console.log("变更没有可映射的当前任务，跳过：" + reason);
      continue;
    }
    linksByChange.set(changeId, taskIds);
    changeIds.push(changeId);
  }

  const taskUpdates = [];
  for (const [changeId, taskIds] of linksByChange) {
    for (const taskId of taskIds) {
      const task = dbTasks.find((row) => row.id === taskId);
      if (task === undefined || task.change_refs.includes(changeId)) continue;
      taskUpdates.push({ taskId, changeId });
    }
  }
  console.log("R01 任务关联：待补 " + String(taskUpdates.length) + " 条");

  const changeFiles = changeIds.length === 0 ? [] : (await client.query(
    "select f.id, f.name, f.status, f.task_id, f.finalized_at, f.finalized_by, f.version, v.change_request_id " +
      "from files f join file_versions v on v.id = f.current_version_id " +
      "where f.project_id = $1 and v.change_request_id = any($2::uuid[]) order by f.name, f.id",
    [project.id, changeIds],
  )).rows;
  const fileRepairs = [];
  const covered = new Set(changeFiles.map((file) => file.change_request_id));
  for (const file of changeFiles) {
    const taskIds = linksByChange.get(file.change_request_id) ?? [];
    const taskId = file.task_id === null && taskIds.length > 0 ? taskIds[0] : null;
    const status = file.status === "final" || file.status === "draft" ? "changed" : null;
    if (taskId === null && status === null) continue;
    fileRepairs.push({ file, taskId, status });
  }
  console.log("文件落位 / 状态修复：待补 " + String(fileRepairs.length) + " 个");

  for (const update of taskUpdates) {
    console.log("[task] " + update.taskId + " += change " + update.changeId);
  }
  for (const repair of fileRepairs) {
    console.log(
      "[file] " +
        repair.file.name +
        " (" +
        repair.file.id +
        ") task_id=" +
        String(repair.file.task_id) +
        " → " +
        String(repair.taskId ?? repair.file.task_id) +
        "；status=" +
        repair.file.status +
        " → " +
        String(repair.status ?? repair.file.status),
    );
  }
  const linkedWithoutFile = [...linksByChange.keys()].filter((changeId) => !covered.has(changeId));
  if (linkedWithoutFile.length > 0) {
    console.log("仍有 " + String(linkedWithoutFile.length) + " 条关联变更尚未上传变更后文件：" + linkedWithoutFile.join("、"));
  }

  if (args.dryRun) {
    console.log("dry-run：未写库");
  } else if (taskUpdates.length === 0 && fileRepairs.length === 0) {
    console.log("无需回填（幂等）");
  } else {
    await client.query("begin");
    inTransaction = true;
    for (const update of taskUpdates) {
      await client.query(
        "update tasks set change_refs = case when $1::uuid = any(change_refs) then change_refs else array_append(change_refs, $1::uuid) end where id = $2",
        [update.changeId, update.taskId],
      );
    }
    for (const repair of fileRepairs) {
      await client.query(
        "update files set task_id = coalesce(task_id, $2), status = coalesce($3, status), finalized_at = case when $3 = 'changed' then null else finalized_at end, finalized_by = case when $3 = 'changed' then null else finalized_by end, version = version + 1, updated_at = now() where id = $1",
        [repair.file.id, repair.taskId, repair.status],
      );
    }
    await client.query("commit");
    inTransaction = false;
    console.log("已提交：任务关联 " + String(taskUpdates.length) + " 条，文件修复 " + String(fileRepairs.length) + " 个");
  }
} catch (error) {
  if (inTransaction) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
