-- CAD 持久产物 / 独立预解析队列（ADR-037，wmj，2026-10-22）。
-- 仅新增表；回滚应用前先停止 CAD worker，旧应用不使用新表。保留表和对象可重新启用。
create table cad_artifacts (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  version_id uuid not null references file_versions(id) on delete cascade,
  source_sha256 text not null,
  source_bytes bigint not null,
  source_name text not null,
  engine_version text not null,
  name_codepage text not null default 'GB',
  state text not null default 'queued',
  phase text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claim_token uuid,
  claim_until timestamptz,
  object_prefix text,
  manifest_sha256 text,
  manifest_bytes bigint,
  resource_lease text,
  buffers jsonb,
  artifact_bytes bigint not null default 0,
  error_code text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_cad_artifacts_version_engine_encoding unique (version_id, engine_version, name_codepage),
  constraint ck_cad_artifacts_state check (state in ('queued','running','completed','failed','timed-out')),
  constraint ck_cad_artifacts_encoding check (name_codepage in ('GB','UTF8')),
  constraint ck_cad_artifacts_source check (source_sha256 ~ '^[a-f0-9]{64}$' and source_bytes > 0),
  constraint ck_cad_artifacts_ready check (state <> 'completed' or (object_prefix is not null and manifest_sha256 is not null and manifest_sha256 ~ '^[a-f0-9]{64}$' and manifest_bytes is not null and manifest_bytes > 0 and resource_lease is not null and resource_lease ~ '^[a-f0-9]{48}$' and buffers is not null))
);
create index ix_cad_artifacts_queue on cad_artifacts(state, available_at);
create index ix_cad_artifacts_file on cad_artifacts(file_id);

create table cad_views (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references cad_artifacts(id) on delete cascade,
  actor_id uuid not null,
  view_id text not null,
  cancelled boolean not null default false,
  expires_at timestamptz not null,
  lease_expires_at timestamptz,
  constraint uq_cad_views_window unique (actor_id, view_id, artifact_id),
  constraint ck_cad_views_id check (view_id ~ '^[a-f0-9]{32}$')
);
create index ix_cad_views_expiry on cad_views(expires_at);
