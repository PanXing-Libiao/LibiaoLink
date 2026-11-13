-- LibiaoLink · 0089 历史未配置输出成果的已定档任务清洗（2026-11-12 · px）
-- 业务口径：只有任务自身配置了输出成果文件（deliverable_types 非空）才需要任务定档；
-- 历史早期版本允许未配置成果的任务定档，形成 finalized_at 非空但 deliverable_types 为空的不一致数据。
-- 本迁移只清洗仍在用的任务（deleted_at is null），不动文件状态、不动项目、不推进其它字段：
--   ① 先把原 finalized_at / finalized_by / version 写入 audit_logs（entry=system，可追溯）；
--   ② 再清空这些任务的 finalized_at / finalized_by，version + 1，updated_at 刷新；
--   ③ 重复执行命中 0 行；配置了成果类型的已定档任务完全不受影响。
-- 规则：迁移器把每个文件包在独立事务中执行；本文件不含 BEGIN / COMMIT。
-- 回滚（如需）：从 audit_logs.metadata 取 previousFinalizedAt / previousFinalizedBy，按 object_id 回填；
--   version 不回退；若清洗后任务已被编辑，回填前需人工确认业务状态。
-- 验证（执行后自查）：
--   select count(*) from tasks where deleted_at is null and finalized_at is not null
--     and coalesce(cardinality(deliverable_types), 0) = 0;  -- 应为 0
--   select count(*) from audit_logs
--     where metadata ->> $$migration$$ = $$0089_unfinalize_legacy_tasks_without_deliverables.sql$$;

insert into audit_logs (
  actor_id,
  actor_name,
  action,
  object_type,
  object_id,
  project_id,
  result,
  entry,
  summary,
  changes,
  metadata
)
select
  null,
  $$system$$,
  $$update$$,
  $$task$$,
  t.id::text,
  t.project_id,
  $$succeeded$$,
  $$system$$,
  $$历史数据清洗：未配置输出成果，取消任务定档：$$ || coalesce(t.title, $$(无标题)$$),
  jsonb_build_array(
    jsonb_build_object($$field$$, $$finalizedAt$$, $$from$$, t.finalized_at, $$to$$, null),
    jsonb_build_object($$field$$, $$finalizedBy$$, $$from$$, t.finalized_by, $$to$$, null)
  ),
  jsonb_build_object(
    $$reason$$, $$legacy_finalized_without_output_deliverables$$,
    $$migration$$, $$0089_unfinalize_legacy_tasks_without_deliverables.sql$$,
    $$previousFinalizedAt$$, t.finalized_at,
    $$previousFinalizedBy$$, t.finalized_by,
    $$previousVersion$$, t.version
  )
from tasks t
where t.deleted_at is null
  and t.finalized_at is not null
  and coalesce(cardinality(t.deliverable_types), 0) = 0;

update tasks t
set finalized_at = null,
    finalized_by = null,
    version = t.version + 1,
    updated_at = now()
where t.deleted_at is null
  and t.finalized_at is not null
  and coalesce(cardinality(t.deliverable_types), 0) = 0;
