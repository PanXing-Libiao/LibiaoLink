-- LibiaoLink · 0086 任务级项目经理（2026-11-10 · px）
-- 业务口径：任务表每一行可独立设置项目经理；修改一条不得连带修改同项目其他任务。
-- 首页项目卡只展示项目级 projects.manager_ids 的姓名；任务行展示各自 tasks.manager_ids，互不汇总。
-- 兼容升级：用项目现有项目经理名单回填全部任务，部署后现有行列展示保持不变。
-- 项目级 projects.manager_ids 独立维护，供项目卡片、筛选和项目级权限口径使用；任务经理不回写项目级经理。
-- 规则：迁移器把每个文件包在独立事务中执行；本文件不含 BEGIN / COMMIT。
-- 回滚（如需）：
--   drop index if exists ix_tasks_manager_ids;
--   alter table tasks drop constraint if exists ck_tasks_manager_ids_no_null;
--   alter table tasks drop constraint if exists ck_tasks_manager_ids;
--   alter table tasks drop column if exists manager_ids;

alter table tasks add column manager_ids uuid[];

update tasks t
set manager_ids = p.manager_ids
from projects p
where p.id = t.project_id;

alter table tasks
  alter column manager_ids set not null,
  add constraint ck_tasks_manager_ids check (cardinality(manager_ids) >= 1),
  add constraint ck_tasks_manager_ids_no_null check (array_position(manager_ids, null::uuid) is null);

create index ix_tasks_manager_ids on tasks using gin (manager_ids);
