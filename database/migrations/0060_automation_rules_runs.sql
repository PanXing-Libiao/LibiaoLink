-- LibiaoLink · 0060 自动化规则与运行记录（M5-06-1A · wmj 领域 / lan 代做）
-- 口径来源：docs/M5-06-实施方案与执行计划(规则管理与发送记录).md §3.1 ~ §3.3。
-- 本迁移只做结构：
--   1. automation_rules：规则权威表；内置规则由 seeds/automation-rules.mjs 幂等写入，代码常量仅作种子 / 金标；
--   2. automation_runs：每次规则 × 实体 × 窗口的求值留痕（条件 / 动作 / 消息快照），不做投递状态机；
--   3. jobs.dedupe_key：一规则一 job 的幂等键（automation-schedule:<ruleCode>）；历史 NULL 行不受影响。
-- 迁移号在开工时复核：当前目录最高为 0059，因此本文件取 0060；不得回改历史迁移。
-- 只追加迁移；应用角色 libiaolink_api 无 DDL，新表权限由 roles/0001 的 default privileges 自动授予。
-- 回滚（如需）：
--   alter table jobs drop constraint if exists ck_jobs_dedupe_key;
--   alter table jobs drop constraint if exists jobs_dedupe_key_key;
--   alter table jobs drop column if exists dedupe_key;
--   drop table if exists automation_runs;
--   drop table if exists automation_rules;

create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  built_in boolean not null default false,
  enabled boolean not null default false,
  trigger jsonb not null,
  conditions jsonb not null,
  actions jsonb not null,
  version integer not null default 1,
  created_by uuid references users (id) on delete set null,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint automation_rules_code_key unique (code),
  constraint ck_automation_rules_code check (char_length(btrim(code)) between 2 and 32),
  constraint ck_automation_rules_name check (char_length(btrim(name)) between 1 and 80),
  constraint ck_automation_rules_trigger check (jsonb_typeof(trigger) = 'object'),
  constraint ck_automation_rules_conditions check (jsonb_typeof(conditions) = 'array'),
  constraint ck_automation_rules_actions check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) between 1 and 10),
  constraint ck_automation_rules_version check (version >= 1),
  constraint ck_automation_rules_timestamps check (updated_at >= created_at)
);

create index ix_automation_rules_enabled on automation_rules (enabled, deleted_at);

create table automation_runs (
  id bigserial primary key,
  rule_id uuid references automation_rules (id) on delete set null,
  rule_code text not null,
  rule_version integer not null,
  source text not null,
  topic text,
  window_key text,
  entity_type text,
  entity_id text,
  dedupe_key text not null,
  status text not null,
  skip_reason text,
  conditions jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  constraint automation_runs_dedupe_key_key unique (dedupe_key),
  constraint ck_automation_runs_rule_code check (char_length(btrim(rule_code)) between 2 and 32),
  constraint ck_automation_runs_rule_version check (rule_version >= 1),
  constraint ck_automation_runs_source check (source in ('event', 'schedule')),
  constraint ck_automation_runs_topic check ((source = 'event') = (topic is not null)),
  constraint ck_automation_runs_window check (window_key is null or char_length(btrim(window_key)) between 1 and 128),
  constraint ck_automation_runs_entity check ((entity_type is null) = (entity_id is null)),
  constraint ck_automation_runs_dedupe check (char_length(btrim(dedupe_key)) between 1 and 256),
  constraint ck_automation_runs_status check (status in ('hit', 'skipped', 'failed')),
  constraint ck_automation_runs_skip_reason check (
    skip_reason is null or skip_reason in (
      'disabled', 'subject_mismatch', 'window_mismatch', 'not_matched',
      'recipient_missing', 'template_missing', 'duplicate', 'event_too_old'
    )
  ),
  constraint ck_automation_runs_outcome check (
    (status = 'hit' and skip_reason is null and error is null)
    or (status = 'skipped' and skip_reason is not null and error is null)
    or (status = 'failed' and skip_reason is null and error is not null and char_length(btrim(error)) > 0)
  ),
  constraint ck_automation_runs_conditions check (jsonb_typeof(conditions) = 'array'),
  constraint ck_automation_runs_actions check (jsonb_typeof(actions) = 'array'),
  constraint ck_automation_runs_messages check (jsonb_typeof(messages) = 'array')
);

create index ix_automation_runs_rule_created on automation_runs (rule_code, created_at desc);
create index ix_automation_runs_entity_created on automation_runs (entity_type, entity_id, created_at desc);
create index ix_automation_runs_window on automation_runs (rule_code, window_key) where window_key is not null;

alter table jobs add column dedupe_key text;
alter table jobs add constraint jobs_dedupe_key_key unique (dedupe_key);
alter table jobs add constraint ck_jobs_dedupe_key check (dedupe_key is null or char_length(btrim(dedupe_key)) between 1 and 128);
