-- LibiaoLink · 0090 生产阶段显示名改为投产阶段（2026-11-13 · px）
-- 范围（只动与阶段名称直接相关的现行数据）：
--   1) blueprints.draft_payload：仅 production 阶段且 name 精确为“生产阶段”时改为“投产阶段”；
--      节点、顺序、key 与其它阶段不动。blueprint_versions.payload（历史发布版本）保留原文，由服务读面映射展示。
--   2) task_templates：仅系统默认模板（created_by is null）、未删除、stage_key=production 且旧名精确匹配时改名；
--      模板节点、模板顺序与其它模板不动。
--   3) STAGE_COMPLETE_GROUP 的系统生成历史通知 / 发送归档：只替换 title / body / payload.title / payload.body 中的旧阶段名；
--      不改用户任务名、日报、问题、审计原文、导入源预览或其它业务正文。
-- 幂等：重复执行命中 0 行；version 不回退。迁移器负责事务，本文件不含 BEGIN / COMMIT。
-- 回滚（如需）：把下列条件里的“投产阶段 / 投产阶段模板”换回“生产阶段 / 生产阶段模板”定点回填；
--   version 与 updated_at 不回退；历史发布版本从未被改写。

update blueprints b
set draft_payload = jsonb_set(
      b.draft_payload,
      '{stages}',
      (
        select jsonb_agg(
          case
            when stage->>'key' = 'production' and stage->>'name' = '生产阶段'
              then jsonb_set(stage, '{name}', to_jsonb('投产阶段'::text))
            else stage
          end
          order by ordinal
        )
        from jsonb_array_elements(b.draft_payload->'stages') with ordinality as stages(stage, ordinal)
      ),
      false
    ),
    version = b.version + 1,
    updated_at = now()
where exists (
  select 1
  from jsonb_array_elements(b.draft_payload->'stages') as stage
  where stage->>'key' = 'production' and stage->>'name' = '生产阶段'
);

update task_templates t
set name = '投产阶段模板',
    version = t.version + 1,
    updated_at = now()
where t.stage_key = 'production'
  and t.name = '生产阶段模板'
  and t.deleted_at is null
  and t.created_by is null
  and not exists (
    select 1
    from task_templates other
    where other.stage_key = 'production'
      and other.name = '投产阶段模板'
      and other.deleted_at is null
      and other.created_by is null
      and other.id <> t.id
  );

update notifications
set title = replace(title, '生产阶段', '投产阶段'),
    body = replace(body, '生产阶段', '投产阶段')
where template_code = 'STAGE_COMPLETE_GROUP'
  and (title like '%生产阶段%' or body like '%生产阶段%');

update notify_delivery_messages
set title = replace(title, '生产阶段', '投产阶段'),
    body = replace(body, '生产阶段', '投产阶段'),
    payload = jsonb_set(
      jsonb_set(
        payload,
        '{title}',
        coalesce(to_jsonb(replace(payload->>'title', '生产阶段', '投产阶段')), payload->'title', 'null'::jsonb),
        false
      ),
      '{body}',
      coalesce(to_jsonb(replace(payload->>'body', '生产阶段', '投产阶段')), payload->'body', 'null'::jsonb),
      false
    ),
    updated_at = now()
where template_code = 'STAGE_COMPLETE_GROUP'
  and (title like '%生产阶段%' or body like '%生产阶段%' or payload::text like '%生产阶段%');
