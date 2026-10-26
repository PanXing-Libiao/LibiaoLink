-- LibiaoLink · 0070 部门项目范围增加 own（2026-10-24 · px）
-- 口径：own = 仅本人负责（projects.manager_ids 含本人）或已进入项目名册的项目；与 selected 并集，任一 all 取消收窄。
-- 页面不再按部门限制：allowed_pages 保留列与旧客户端兼容，裁决层恒返回全部页面。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；已有表 constraint 变更由部署账号执行。
-- 回滚（如需）：
--   update group_access_rules set project_scope = 'none' where project_scope = 'own';
--   alter table group_access_rules drop constraint if exists ck_group_access_rules_scope;
--   alter table group_access_rules add constraint ck_group_access_rules_scope check (project_scope in ('all', 'selected', 'none'));

alter table group_access_rules drop constraint if exists ck_group_access_rules_scope;
alter table group_access_rules
  add constraint ck_group_access_rules_scope check (project_scope in ('all', 'own', 'selected', 'none'));
