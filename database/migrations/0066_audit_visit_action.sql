-- LibiaoLink · 0066 审计动作「访问」（2026-10-23）
-- 业务口径：进入项目详情也要留痕，操作记录新增动作「访问」；登录成功同样记一条 visit（object_type=user）。
-- 变更：ck_audit_logs_action 由十一值扩为十二值（新增 visit，顺序与契约 AUDIT_ACTIONS 一致：archive → visit → preview → download → deny）。
-- 说明：preview 值保留；2026-10-23 起预览实际送达时恢复写入（本次不新增值）。
-- 只追加迁移：应用角色 libiaolink_api 仍无 DDL 权限。
-- 回滚（如需）：
--   alter table audit_logs drop constraint ck_audit_logs_action,
--     add constraint ck_audit_logs_action check (action in ('create','update','delete','progress','complete','advance','rollback','archive','preview','download','deny'));

alter table audit_logs drop constraint ck_audit_logs_action;
alter table audit_logs add constraint ck_audit_logs_action
  check (action in ('create','update','delete','progress','complete','advance','rollback','archive','visit','preview','download','deny'));
