-- LibiaoLink · 0092 任务模板可见范围（2026-11-13）
-- 口径：task_templates.visibility = private / public。
--   private = 仅填写人可见；public = 有任务模板浏览权的人可见。
--   新建时由填写人选择；存量模板 / 种子默认 public，保持原有公共可见行为。
-- 删除、内容编辑归属与填写人规则不变：内容编辑 / 删除仍由填写人或管理员维护；可见范围只由填写人调整。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新列随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   alter table task_templates drop constraint if exists ck_task_templates_visibility;
--   alter table task_templates drop column if exists visibility;

alter table task_templates
  add column visibility text not null default 'public',
  add constraint ck_task_templates_visibility check (visibility in ('private', 'public'));

comment on column task_templates.visibility is '模板可见范围：private = 仅填写人可见；public = 有任务模板浏览权的人可见（存量默认 public）';
