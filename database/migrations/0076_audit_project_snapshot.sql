-- LibiaoLink · 0076 审计项目名称快照（2026-10-28 · lan）
-- 口径：操作记录在写入时保存所属项目的编号 / 名称快照；读取时优先当前项目数据（含回收站），
-- 项目彻底删除或项目行缺失时回退到快照，避免历史操作记录失去项目上下文。
-- 存量行不回填：当前项目仍存在时由读面 LEFT JOIN 解析；已彻底删除的项目无法可靠还原当时的名称。
-- 只追加迁移：应用角色 libiaolink_api 无 audit_logs 的 UPDATE 权限，本迁移仅扩列。
-- 回滚（如需）：
--   alter table audit_logs drop column if exists project_name;
--   alter table audit_logs drop column if exists project_code;

alter table audit_logs
  add column project_code text,
  add column project_name text;

comment on column audit_logs.project_code is '所属项目编号快照（写入时记录；读取时优先当前 projects.code）';
comment on column audit_logs.project_name is '所属项目名称快照（写入时记录；读取时优先当前 projects.name）';
