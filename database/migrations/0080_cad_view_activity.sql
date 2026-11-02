-- Run before deploying the API/worker. Existing windows start inactive and
-- regain scheduling priority on the next authorized status poll.
alter table cad_views add column last_seen_at timestamptz not null default '1970-01-01T00:00:00Z';
alter table cad_views alter column last_seen_at set default now();
create index ix_cad_views_active_artifact on cad_views(artifact_id, last_seen_at);
