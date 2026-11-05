-- User intent survives short-lived view records; background warmup never renews it.
alter table cad_artifacts add column last_accessed_at timestamptz;
update cad_artifacts a set last_accessed_at=v.seen from
  (select artifact_id,max(last_seen_at) as seen from cad_views group by artifact_id) v
  where a.id=v.artifact_id and v.seen > '1970-01-02'::timestamptz;
create index ix_cad_artifacts_access on cad_artifacts(last_accessed_at);
-- No FK: deletion work must survive file/artifact removal and worker restarts.
create table cad_retired_objects (
  prefix text primary key,
  available_at timestamptz not null default now(),
  constraint ck_cad_retired_prefix check (prefix ~ '^projects/[0-9a-f-]{36}/files/[0-9a-f-]{36}/cad/[0-9a-f-]{36}/[0-9a-f-]{36}/$')
);
create index ix_cad_retired_available on cad_retired_objects(available_at);
