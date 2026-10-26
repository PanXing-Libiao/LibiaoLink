-- LibiaoLink · 0072 系统管理员名单（2026-10-24 · px）
-- 口径：权限页手工授予的系统管理员持久化在本表；环境变量 GROUP_ACCESS_ADMIN_USER_IDS /
-- GROUP_ACCESS_ADMIN_GROUP_KEYS 与启用 PERMISSION_ENFORCED 后的 access.manage 角色仍是独立来源。
-- 删除 grantor 不连带删除管理员记录（由用户表外键 NO ACTION 保护）；删除管理员账号时记录随 user_id 级联清理。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists group_access_admins;

create table group_access_admins (
  user_id uuid primary key references users (id) on delete cascade,
  granted_by uuid not null references users (id),
  created_at timestamptz not null default now()
);
