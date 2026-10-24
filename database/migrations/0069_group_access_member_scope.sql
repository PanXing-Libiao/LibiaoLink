-- LibiaoLink · 0069 部门规则人员范围（2026-10-24 · px）
-- 口径：规则可按部门全部直属人员生效（all），或仅对勾选人员生效（selected）。
-- 存量规则统一回填 all，保持原行为；selected 的人员 id 必须来自该部门直属成员（服务层校验）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；已有表新列随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   alter table group_access_rules drop constraint if exists ck_group_access_rules_members;
--   alter table group_access_rules drop constraint if exists ck_group_access_rules_member_scope;
--   alter table group_access_rules drop column if exists member_user_ids;
--   alter table group_access_rules drop column if exists member_scope;

alter table group_access_rules
  add column member_scope text not null default 'all',
  add column member_user_ids uuid[] not null default array[]::uuid[],
  add constraint ck_group_access_rules_member_scope check (member_scope in ('all', 'selected')),
  add constraint ck_group_access_rules_members check (
    cardinality(member_user_ids) <= 2000
    and array_position(member_user_ids, null::uuid) is null
    and (member_scope <> 'all' or cardinality(member_user_ids) = 0)
  );
