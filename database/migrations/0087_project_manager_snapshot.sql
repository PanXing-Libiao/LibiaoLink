-- LibiaoLink · 0087 项目经理统一为项目级（2026-11-11 · px）
-- 业务口径：取消任务级经理。projects.manager_ids 是唯一可编辑项目经理名单；
-- tasks.manager_ids 仅保存项目名单在任务行的展示快照，不产生任务级经理身份。
-- 迁移 0086 已建列 / GIN / CHECK，本迁移只统一回填历史任务快照，不改表结构。
-- 已定档任务同样回填：快照变化不推进 version，也不解除定档写保护。
-- 规则：迁移器把每个文件包在独立事务中执行；本文件不含 BEGIN / COMMIT。

update tasks t
set manager_ids = p.manager_ids
from projects p
where p.id = t.project_id
  and t.manager_ids is distinct from p.manager_ids;

comment on column tasks.manager_ids is '项目级项目经理展示快照（与 projects.manager_ids 同步；不是独立任务字段）';

-- 回滚（如需）：任务快照属于派生展示数据，不保留迁移前的任务级改派历史；仅可恢复列注释。
-- comment on column tasks.manager_ids is null;
