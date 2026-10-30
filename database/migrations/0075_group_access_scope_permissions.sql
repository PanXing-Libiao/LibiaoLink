-- LibiaoLink · 0075 部门 / 个人多范围权限（2026-10-27 · px）
-- 口径：scopePermissions 取代单一 project_scope + access_level 作为新裁决口径；all / own / selected 可同时存在，
-- 每个范围各自是 edit / view；可见范围取并集，同一项目被多个范围命中时取最高权限（edit > view）。
-- 不显示项目数据 = 子表没有行（互斥清空）；旧列保留，仅作旧客户端兼容摘要，不再参与新裁决。
-- 本迁移从存量单选规则无损回填，升级前后授权范围与档位保持一致。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists group_access_member_scope_permissions;
--   drop table if exists group_access_scope_permissions;
--   旧 group_access_rules.project_scope / access_level 与个人规则同名列仍在，不受影响。

create table group_access_scope_permissions (
  group_key text not null references group_access_rules (group_key) on delete cascade,
  project_scope text not null,
  access_level text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_access_scope_permissions_pkey primary key (group_key, project_scope),
  constraint ck_group_access_scope_permissions_scope check (project_scope in ('all', 'own', 'selected')),
  constraint ck_group_access_scope_permissions_access_level check (access_level in ('edit', 'view'))
);

create table group_access_member_scope_permissions (
  group_key text not null,
  user_id uuid not null references users (id) on delete cascade,
  project_scope text not null,
  access_level text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_access_member_scope_permissions_pkey primary key (group_key, user_id, project_scope),
  constraint fk_group_access_member_scope_permissions_member foreign key (group_key, user_id)
    references group_access_member_rules (group_key, user_id) on delete cascade,
  constraint ck_group_access_member_scope_permissions_scope check (project_scope in ('all', 'own', 'selected')),
  constraint ck_group_access_member_scope_permissions_access_level check (access_level in ('edit', 'view'))
);
create index ix_group_access_member_scope_permissions_user
  on group_access_member_scope_permissions (user_id);

insert into group_access_scope_permissions (group_key, project_scope, access_level, created_at, updated_at)
select group_key, project_scope, access_level, created_at, updated_at
from group_access_rules
where project_scope <> 'none'
on conflict (group_key, project_scope) do update
  set access_level = excluded.access_level,
      updated_at = greatest(group_access_scope_permissions.updated_at, excluded.updated_at);

insert into group_access_member_scope_permissions (
  group_key, user_id, project_scope, access_level, created_at, updated_at
)
select group_key, user_id, project_scope, access_level, created_at, updated_at
from group_access_member_rules
where project_scope <> 'none'
on conflict (group_key, user_id, project_scope) do update
  set access_level = excluded.access_level,
      updated_at = greatest(group_access_member_scope_permissions.updated_at, excluded.updated_at);
