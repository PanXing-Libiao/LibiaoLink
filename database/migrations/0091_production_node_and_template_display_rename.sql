-- LibiaoLink · 0091 投产节点与任务模板显示名补充改名（2026-11-13 · px）
-- 范围：
--   1) blueprints.draft_payload：仅 production 阶段的 production.record 节点精确旧名
--      “生产运行记录”改为“投产运行记录”；阶段内其它节点、顺序、key 与其它阶段不动。
--   2) task_templates：仅有旧名“生产阶段模板”或“生产阶段参考模板”的未删除系统模板，
--      在不存在“投产阶段模板”时选一条改为“投产阶段模板”；用户模板与模板节点不动。
--   3) blueprint_versions.payload（历史发布版本）保留原文，由服务读面映射阶段名与节点名。
--      通知、发送归档、导入预览、翻译缓存、outbox、审计原文与其它业务正文均不改。
-- 幂等：重复执行命中 0；version 不回退。迁移器负责事务，本文件不含 BEGIN / COMMIT。

update blueprints b
set draft_payload = jsonb_set(
      b.draft_payload,
      array[$q$stages$q$],
      (
        select jsonb_agg(
          case
            when stage->>$q$key$q$ = $q$production$q$ then
              jsonb_set(
                stage,
                array[$q$nodes$q$],
                (
                  select jsonb_agg(
                    case
                      when node->>$q$key$q$ = $q$production.record$q$ and node->>$q$name$q$ = $q$生产运行记录$q$
                        then jsonb_set(node, array[$q$name$q$], to_jsonb($q$投产运行记录$q$::text))
                      else node
                    end
                    order by node_ordinal
                  )
                  from jsonb_array_elements(stage->$q$nodes$q$) with ordinality as nodes(node, node_ordinal)
                ),
                false
              )
            else stage
          end
          order by stage_ordinal
        )
        from jsonb_array_elements(b.draft_payload->$q$stages$q$) with ordinality as stages(stage, stage_ordinal)
      ),
      false
    ),
    version = b.version + 1,
    updated_at = now()
where exists (
  select 1
  from jsonb_array_elements(b.draft_payload->$q$stages$q$) as stages(stage)
  cross join lateral jsonb_array_elements(stage->$q$nodes$q$) as nodes(node)
  where stage->>$q$key$q$ = $q$production$q$
    and node->>$q$key$q$ = $q$production.record$q$
    and node->>$q$name$q$ = $q$生产运行记录$q$
);

with candidates as (
  select t.id,
         row_number() over (
           order by case when t.name = $q$生产阶段模板$q$ then 0 else 1 end, t.created_at, t.id
         ) as candidate_no
  from task_templates t
  where t.stage_key = $q$production$q$
    and t.name in ($q$生产阶段模板$q$, $q$生产阶段参考模板$q$)
    and t.deleted_at is null
    and t.created_by is null
),
chosen as (
  select id from candidates where candidate_no = 1
)
update task_templates t
set name = $q$投产阶段模板$q$,
    version = t.version + 1,
    updated_at = now()
where t.id in (select id from chosen)
  and not exists (
    select 1
    from task_templates other
    where other.stage_key = $q$production$q$
      and other.name = $q$投产阶段模板$q$
      and other.deleted_at is null
      and other.created_by is null
      and other.id <> t.id
  );
