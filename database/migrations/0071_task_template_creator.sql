-- LibiaoLink · 0071 任务模板填写人（2026-10-24 · px）
-- 口径：task_templates.created_by = 新建模板的登录账号；存量模板 / 种子为空，界面显示「系统」。
-- 删除模板沿用 deleted_by，不改语义。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新列随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop index if exists ix_task_templates_created_by;
--   alter table task_templates drop column if exists created_by;

alter table task_templates
  add column created_by uuid references users (id);
create index ix_task_templates_created_by on task_templates (created_by) where deleted_at is null;
