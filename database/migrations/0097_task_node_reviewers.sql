-- LibiaoLink · 0097 公共任务节点审核人白名单（2026-11-14）
-- 业务口径：任务模板「入库审核」中的公共节点申请，不再默认所有系统管理员都可审核；
--   仅系统管理员可在权限管理页「公共节点审核」中勾选审核人，且只能从当前生效的系统管理员中选择。
-- 门禁：表为空 = 尚未配置，任何管理员都不可审核；管理员保存至少一名审核人后，以本表白名单为准。
-- 安全：审核接口仍先校验当前账号是系统管理员，再校验是否在本名单内；撤销管理员后自动失去审核权。
-- 回滚（如需）：
--   drop table if exists task_node_reviewers;

create table task_node_reviewers (
  user_id uuid primary key references users (id) on delete cascade,
  assigned_by uuid not null references users (id),
  created_at timestamptz not null default now()
);

comment on table task_node_reviewers is
  '公共任务节点申请审核人白名单；仅系统管理员可配置，管理员被撤销后即使残留本表也不再获权';
comment on column task_node_reviewers.assigned_by is
  '最近一次保存该名单的操作人（系统管理员）';
