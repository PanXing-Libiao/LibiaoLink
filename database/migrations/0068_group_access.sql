-- LibiaoLink · 0068 Casdoor 群组访问控制（2026-10-23 · px）
-- 口径：页面访问按 Casdoor 群组规则并集；项目范围 all / selected / none，先按群组收敛再与角色可见范围取交集。
-- group_key = owner/name（例 libiaorobot.com/项目部），不以中文显示名作权限键。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists project_group_access;
--   drop table if exists group_access_rules;
--   drop table if exists user_group_memberships;

create table user_group_memberships (
  user_id uuid not null references users (id) on delete cascade,
  group_key text not null,
  group_name text not null,
  synced_at timestamptz not null default now(),
  constraint user_group_memberships_pkey primary key (user_id, group_key),
  constraint ck_user_group_memberships_key check (char_length(btrim(group_key)) between 1 and 200),
  constraint ck_user_group_memberships_name check (char_length(btrim(group_name)) between 1 and 200)
);
create index ix_user_group_memberships_group on user_group_memberships (group_key);

create table group_access_rules (
  group_key text primary key,
  group_name text not null,
  allowed_pages text[] not null default array[]::text[],
  project_scope text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_group_access_rules_key check (char_length(btrim(group_key)) between 1 and 200),
  constraint ck_group_access_rules_name check (char_length(btrim(group_name)) between 1 and 200),
  constraint ck_group_access_rules_pages check (
    allowed_pages <@ array['dashboard', 'projects', 'templates', 'workspace', 'files', 'audit']::text[]
    and array_position(allowed_pages, null::text) is null
  ),
  constraint ck_group_access_rules_scope check (project_scope in ('all', 'selected', 'none'))
);

create table project_group_access (
  project_id uuid not null references projects (id) on delete cascade,
  group_key text not null references group_access_rules (group_key) on delete cascade,
  created_at timestamptz not null default now(),
  constraint project_group_access_pkey primary key (project_id, group_key)
);
create index ix_project_group_access_group on project_group_access (group_key);
