-- DWG companion selections already use the fixed-version DXF/DWG input contract.
-- Permit those bounded sets in durable native archives; STEP remains unchanged.
-- Apply with the existing migration runner before enabling companion previews.
alter table cad_artifacts drop constraint ck_cad_artifacts_input_set;
alter table cad_artifacts add constraint ck_cad_artifacts_input_set check (
  source_format in ('STEP','DXF','DWG') and resource_set_hash ~ '^[a-f0-9]{64}$'
  and length(coalesce(main_path,source_name)) between 1 and 1024
  and jsonb_typeof(companions) = 'array' and jsonb_array_length(companions) <= 127
  and (
    (source_format in ('DXF','DWG') and main_path is not null)
    or (source_format = 'STEP' and state <> 'partial' and companions = '[]'::jsonb and resource_set_hash = repeat('0',64))
  )
);
