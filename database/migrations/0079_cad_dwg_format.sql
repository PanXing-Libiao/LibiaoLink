-- Native DWG main drawing support. DWG is always a partial preview (explicit
-- decoder/mapping losses); it has no companion inputs and no main-path choice.
-- Coordinate deployment with API/worker/CAD image; this migration is local only.
alter table cad_artifacts drop constraint ck_cad_artifacts_input_set;
alter table cad_artifacts add constraint ck_cad_artifacts_input_set check (
  source_format in ('STEP','DXF','DWG') and resource_set_hash ~ '^[a-f0-9]{64}$'
  and length(coalesce(main_path,source_name)) between 1 and 1024
  and jsonb_typeof(companions) = 'array' and jsonb_array_length(companions) <= 127
  and (
    (source_format in ('DXF','DWG') and main_path is not null
      and (source_format <> 'DWG' or (companions = '[]'::jsonb and resource_set_hash = repeat('0',64))))
    or (source_format = 'STEP' and state <> 'partial' and companions = '[]'::jsonb and resource_set_hash = repeat('0',64))
  )
);
