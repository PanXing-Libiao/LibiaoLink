// LibiaoLink · 种子 #12：M5-06 自动化规则 + 一规则一调度 job（0060 之后）
// 唯一数据源：server/dist/modules/automation/builtin-rules.js 的 BUILTIN_RULES（执行前先构建 server）。
// 口径：规则行按 code 只插入缺失项，绝不覆盖库内 enabled / actions / version；job 按库内实际规则状态 reconcile。

const BUILTIN_RULES_MODULE = new URL("../../server/dist/modules/automation/builtin-rules.js", import.meta.url);

export const name = "automation-rules";
export const title = "自动化内置规则（BUILTIN_RULES · 10 条）与一规则一调度 job";

async function loadBuiltinRules() {
  let module;
  try {
    module = await import(BUILTIN_RULES_MODULE.href);
  } catch (error) {
    throw new Error("无法加载 server/dist 的 BUILTIN_RULES（先在 server 目录执行 npm run build）：" + String(error));
  }
  if (!Array.isArray(module.BUILTIN_RULES) || module.BUILTIN_RULES.length !== 10) {
    throw new Error("BUILTIN_RULES 应为 10 条可执行规则，实际 = " + String(module.BUILTIN_RULES?.length));
  }
  return module.BUILTIN_RULES;
}

function jobPayload(rule) {
  return JSON.stringify({ ruleCode: rule.code, ruleVersion: rule.version });
}

function payloadEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function reconcileScheduleJob(client, rule) {
  const dedupeKey = "automation-schedule:" + rule.code;
  const payload = JSON.parse(jobPayload(rule));
  const found = await client.query(
    "select id, payload, cron, status from jobs where dedupe_key = $1 limit 1",
    [dedupeKey],
  );
  const row = found.rows[0];
  if (row === undefined) {
    await client.query(
      `insert into jobs (kind, payload, cron, run_at, last_run_at, status, dedupe_key)
       values ('automation-schedule.job', $1::jsonb, $2, now(), now(), $3, $4)`,
      [jobPayload(rule), rule.trigger.cron, rule.enabled ? "pending" : "done", dedupeKey],
    );
    return "inserted";
  }
  const unchanged = payloadEqual(row.payload, payload) && row.cron === rule.trigger.cron;
  if (!rule.enabled) {
    if (row.status === "done" && unchanged) return "unchanged";
    await client.query(
      `update jobs set payload = $2::jsonb, cron = $3, status = 'done', locked_at = null, updated_at = now()
       where id = $1`,
      [row.id, jobPayload(rule), rule.trigger.cron],
    );
    return "disabled";
  }
  if (row.status === "done") {
    await client.query(
      `update jobs
          set payload = $2::jsonb, cron = $3, status = 'pending', run_at = now(), last_run_at = now(),
              attempts = 0, last_error = null, locked_at = null, updated_at = now()
        where id = $1`,
      [row.id, jobPayload(rule), rule.trigger.cron],
    );
    return "reactivated";
  }
  if (unchanged) return "unchanged";
  await client.query(
    "update jobs set payload = $2::jsonb, cron = $3, updated_at = now() where id = $1",
    [row.id, jobPayload(rule), rule.trigger.cron],
  );
  return "updated";
}

export async function run(client) {
  const builtinRules = await loadBuiltinRules();
  const summary = {
    rulesInserted: 0,
    rulesUnchanged: 0,
    jobsInserted: 0,
    jobsReactivated: 0,
    jobsUpdated: 0,
    jobsDisabled: 0,
    jobsUnchanged: 0,
    legacyJobsRetired: 0,
  };

  for (const rule of builtinRules) {
    const result = await client.query(
      `insert into automation_rules (code, name, built_in, enabled, trigger, conditions, actions, version)
       values ($1, $2, true, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       on conflict (code) do nothing
       returning id`,
      [
        rule.code,
        rule.name,
        rule.enabled,
        JSON.stringify(rule.trigger),
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.version,
      ],
    );
    if (result.rowCount === 1) summary.rulesInserted += 1;
    else summary.rulesUnchanged += 1;
  }

  const scheduleRules = await client.query(
    `select code, enabled, version, trigger
       from automation_rules
      where deleted_at is null and trigger->>'kind' = 'schedule'
      order by code`,
  );
  for (const rule of scheduleRules.rows) {
    const outcome = await reconcileScheduleJob(client, rule);
    if (outcome === "inserted") summary.jobsInserted += 1;
    else if (outcome === "reactivated") summary.jobsReactivated += 1;
    else if (outcome === "updated") summary.jobsUpdated += 1;
    else if (outcome === "disabled") summary.jobsDisabled += 1;
    else summary.jobsUnchanged += 1;
  }

  // 一规则一 job 接管后，旧通用 job 不再并行空转；保留行与历史窗口供排障。
  const retired = await client.query(
    `update jobs
        set status = 'done', locked_at = null, updated_at = now()
      where kind = 'automation-schedule.job'
        and dedupe_key is null
        and status <> 'done'`,
  );
  summary.legacyJobsRetired = retired.rowCount ?? 0;
  return summary;
}
