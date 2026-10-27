-- LibiaoLink · 0076 项目总结（2026-10-27 · px）
-- 口径：卡片入口生成某项目的阶段性总结；facts / narrative 均由服务端生成后快照落库。
-- facts 是脚本读取任务 / 日报 / 问题 / 文件 / 变更 / 阶段后的固定事实包；
-- narrative 是 AI 润色或规则模板叙述，项目经理可编辑，确认后成为项目正式总结。
-- 一个项目同时只保留一条 confirmed；确认新版本时旧 confirmed 与其余草稿转 superseded（历史不删，确认人/时间保留）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists project_summaries;

create table project_summaries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  data_cutoff timestamptz not null,
  status text not null default 'draft',
  facts jsonb not null,
  narrative jsonb not null,
  generator_engine text not null,
  generator_model text,
  prompt_version text not null,
  fallback_reason text,
  generated_by uuid not null,
  generated_at timestamptz not null,
  confirmed_by uuid,
  confirmed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_project_summaries_status check (status in ('draft', 'confirmed', 'superseded')),
  constraint ck_project_summaries_version check (version >= 1),
  constraint ck_project_summaries_facts_object check (jsonb_typeof(facts) = 'object'),
  constraint ck_project_summaries_narrative_object check (jsonb_typeof(narrative) = 'object'),
  constraint ck_project_summaries_confirmed_pair check ((confirmed_by is null) = (confirmed_at is null)),
  constraint ck_project_summaries_confirmed_status check (
    (status <> 'draft' or confirmed_at is null)
    and (status <> 'confirmed' or confirmed_at is not null)
  )
);

create index ix_project_summaries_project_created
  on project_summaries (project_id, created_at desc);

create unique index uq_project_summaries_confirmed
  on project_summaries (project_id)
  where status = 'confirmed';
