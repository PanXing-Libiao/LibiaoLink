-- DXF 输入集合与部分显示（ADR-038）。旧 STEP 产物保留。
-- 唯一约束变化不兼容旧 API 的 ON CONFLICT：必须先停止 API/worker，再迁移并整体升级。
-- 回滚需停服务、清理可重建 DXF 派生索引/对象，再恢复旧三字段唯一约束；不得仅回退镜像。
alter table cad_artifacts
  add column source_format text not null default 'STEP',
  add column main_path text,
  add column companions jsonb not null default '[]'::jsonb,
  add column resource_set_hash text not null default repeat('0',64);
update cad_artifacts set main_path = source_name;
alter table cad_artifacts drop constraint uq_cad_artifacts_version_engine_encoding;
alter table cad_artifacts add constraint uq_cad_artifacts_input_set unique(version_id, engine_version, name_codepage, resource_set_hash);
alter table cad_artifacts drop constraint ck_cad_artifacts_state;
alter table cad_artifacts add constraint ck_cad_artifacts_state check(state in ('queued','running','completed','partial','failed','timed-out'));
alter table cad_artifacts add constraint ck_cad_artifacts_input_set check (
  source_format in ('STEP','DXF') and resource_set_hash ~ '^[a-f0-9]{64}$'
  and length(coalesce(main_path,source_name)) between 1 and 1024
  and jsonb_typeof(companions) = 'array' and jsonb_array_length(companions) <= 127
  and ((source_format = 'DXF' and main_path is not null) or (source_format = 'STEP' and state <> 'partial' and companions = '[]'::jsonb and resource_set_hash = repeat('0',64)))
);
alter table cad_artifacts drop constraint ck_cad_artifacts_ready;
alter table cad_artifacts add constraint ck_cad_artifacts_ready check (
  state not in ('completed','partial') or (object_prefix is not null and manifest_sha256 is not null
    and manifest_sha256 ~ '^[a-f0-9]{64}$' and manifest_bytes is not null and manifest_bytes > 0
    and resource_lease is not null and resource_lease ~ '^[a-f0-9]{48}$' and buffers is not null)
);
