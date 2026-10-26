-- LibiaoLink · 0074 部门内个人权限覆盖（2026-10-26 · px）
-- 口径：group_access_rules 保留为部门默认权限；group_access_member_rules 为个人覆盖，按 user_id 命中时优先于同部门默认规则。
-- 同一部门的不同人员可以分别设置项目范围 / 编辑或仅浏览，互不覆盖；多部门仍按各自有效规则取并集。
-- 存量 member_scope=selected 规则按原适用人员拆成个人规则，并删除原部门规则，保持升级前后实际授权不变。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists project_group_member_access;
--   drop table if exists group_access_member_rules;
--   （member_scope=selected 的原规则无法自动恢复，需从部署前备份还原）

create table group_access_member_rules (
  group_key text not null,
  user_id uuid not null references users (id) on delete cascade,
  project_scope text not null default 'none',
  access_level text not null default 'view',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_access_member_rules_pkey primary key (group_key, user_id),
  constraint ck_group_access_member_rules_key check (char_length(btrim(group_key)) between 1 and 200),
  constraint ck_group_access_member_rules_scope check (project_scope in ('all', 'own', 'selected', 'none')),
  constraint ck_group_access_member_rules_access_level check (access_level in ('edit', 'view')),
  constraint ck_group_access_member_rules_none_access check (project_scope <> 'none' or access_level = 'view')
);
create index ix_group_access_member_rules_user on group_access_member_rules (user_id);

create table project_group_member_access (
  project_id uuid not null references projects (id) on delete cascade,
  group_key text not null,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint project_group_member_access_pkey primary key (project_id, group_key, user_id),
  constraint fk_project_group_member_access_member foreign key (group_key, user_id)
    references group_access_member_rules (group_key, user_id) on delete cascade
);
create index ix_project_group_member_access_member on project_group_member_access (group_key, user_id);

insert into group_access_member_rules (
  group_key, user_id, project_scope, access_level, created_at, updated_at
)
select r.group_key, u.member_id, r.project_scope, r.access_level, r.created_at, r.updated_at
from group_access_rules r
cross join lateral unnest(r.member_user_ids) as u(member_id)
where r.member_scope = 'selected'
on conflict (group_key, user_id) do nothing;

insert into project_group_member_access (project_id, group_key, user_id, created_at)
select mapping.project_id, r.group_key, u.member_id, mapping.created_at
from group_access_rules r
join project_group_access mapping on mapping.group_key = r.group_key
cross join lateral unnest(r.member_user_ids) as u(member_id)
where r.member_scope = 'selected' and r.project_scope = 'selected'
on conflict (project_id, group_key, user_id) do nothing;

delete from group_access_rules where member_scope = 'selected';
