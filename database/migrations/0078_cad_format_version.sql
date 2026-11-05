-- CAD 版本拆分：engine_version 保留服务器 bundle 身份，format_version 作为产物缓存键。
-- 旧产物回填为旧 engine_version，新格式版本首次访问时重建；不把旧产物伪装成新格式产物。
-- 部署：先停止 API/worker，再迁移并整体升级；回滚需恢复旧唯一约束后再回退镜像。
alter table cad_artifacts
  add column format_version text not null default '';
update cad_artifacts set format_version = engine_version;
alter table cad_artifacts drop constraint uq_cad_artifacts_input_set;
alter table cad_artifacts add constraint uq_cad_artifacts_input_set
  unique(version_id, format_version, name_codepage, resource_set_hash);
alter table cad_artifacts add constraint ck_cad_artifacts_format_version
  check (length(format_version) between 1 and 512);
-- Old queued/running rows belong to the retired bundle key. They are not
-- claimed by the new format filter; fail them so users reopen a fresh job.
update cad_artifacts
  set state = 'failed', phase = 'failed', claim_token = null, claim_until = null,
      error_code = 'engine-version-retired',
      error = 'CAD 版本已拆分，旧任务不再执行，请重新打开预览', updated_at = now()
  where state in ('queued', 'running');
