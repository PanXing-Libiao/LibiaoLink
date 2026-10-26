-- LibiaoLink · 0073 部门规则权限档位（2026-10-24 · px）
-- 口径：access_level = edit（编辑并浏览）/ view（仅浏览）；edit 隐含 view。
-- 存量规则统一回填 view，升级后不自动放权；project_scope = none 时只能为 view。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；已有表新列随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   alter table group_access_rules drop constraint if exists ck_group_access_rules_none_access;
--   alter table group_access_rules drop constraint if exists ck_group_access_rules_access_level;
--   alter table group_access_rules drop column if exists access_level;

alter table group_access_rules
  add column access_level text not null default 'view',
  add constraint ck_group_access_rules_access_level check (access_level in ('edit', 'view')),
  add constraint ck_group_access_rules_none_access check (project_scope <> 'none' or access_level = 'view');
