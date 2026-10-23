-- 全局哈希缓存的旧归属可能由未经验证的客户端哈希登记或转移，不能继承为可信版本产物。
-- 仅清除可再生成的预览缓存登记；源文件、版本、审计与 outbox 历史均保留。
-- 新任务去重键含 versionId，与旧全局任务分开；新对象写 previews/versions/，旧键不再签出。
delete from preview_artifacts;
alter table preview_artifacts drop constraint uq_preview_artifacts_cache_key;
alter table preview_artifacts add constraint uq_preview_artifacts_cache_key
  unique (version_id, pipeline_version, target);
