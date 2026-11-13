-- 0094 · 任务模板私有节点（2026-11-13）
--
-- 背景：模板列头「＋ 添加节点」原先写公共节点库，导致模板内新增的节点出现在
-- 左侧公共节点池、并可被其它模板使用。业务口径改为：模板内新增节点只属于当前模板。
-- 左侧公共节点库的「＋ 添加节点」仍写公共节点，行为不变。
--
-- 口径：
--   1. task_nodes.owner_template_id is null  = 公共节点库节点；
--   2. task_nodes.owner_template_id 非空     = 某份模板的私有节点（不出现在 GET /api/v1/task-nodes）；
--   3. 公共节点在同阶段内仍按 title 唯一；模板私有节点在同一模板内按 title 唯一；
--   4. 私有节点随模板硬删级联；模板软删仍保留行，但模板读面不可见，公共读面恒过滤私有行。
--
-- 回滚（如需）：drop index if exists uq_task_nodes_owner_title;
--              drop index if exists ix_task_nodes_owner_seq;
--              drop index if exists uq_task_nodes_shared_stage_title;
--              alter table task_nodes drop column if exists owner_template_id;
--              alter table task_nodes add constraint uq_task_nodes_stage_title unique (stage_key, title);
--              （仅当库内不存在同阶段同名的公共节点时才能恢复旧约束）

alter table task_nodes
  add column owner_template_id uuid references task_templates (id) on delete cascade;

alter table task_nodes
  drop constraint uq_task_nodes_stage_title;

create unique index uq_task_nodes_shared_stage_title
  on task_nodes (stage_key, title)
  where owner_template_id is null;

create unique index uq_task_nodes_owner_title
  on task_nodes (owner_template_id, title)
  where owner_template_id is not null;

create index ix_task_nodes_owner_seq
  on task_nodes (owner_template_id, seq, id);

comment on column task_nodes.owner_template_id is
  '模板私有节点归属；null = 公共任务节点库，非空 = 只在指定模板内可见 / 可用';
comment on table task_nodes is
  '任务节点：owner_template_id 为空时是公共节点库；非空时是模板私有节点，不进入公共节点库';
