-- LibiaoLink · 0054 变更记录「填写者」（Push 347 · 业务口径 2026-10-16「变更申请和填写人没有根据文件的导入啊 是什么问题 现在是导入的是账号人」）
-- 口径来源：导入表「变更管理」表的「填写者」列（源表在「变更申请人」右侧；两列原文可带括注，如「朱成荣(Eli)」）；
--   导入时按显示名匹配库内账号（原文 / 去括注 / 去括注 + -test 三路，与干系人「填写者」同口径 —— Push 324）；
--   变更申请人（applied_by）同口径命中、未命中回落导入人（服务层判定，applied_by 非空不变）。
-- 变更（只加列 · 纯新增 · 不动存量行）：
--   change_requests 增 writer_by uuid（可空、无外键 —— 与 applied_by 同口径：应用层管归属）：
--   命中 = 源表「填写者」的账号；未命中 / 应用内提交 / 存量行 = null（前端「填写者」回落申请人展示）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新列随表级 GRANT 生效。
-- 回滚（如需）：alter table change_requests drop column writer_by;
alter table change_requests add column writer_by uuid;
comment on column change_requests.writer_by is $$变更记录「填写者」账号（0054 / Push 347）：导入表导入按源表「填写者」列匹配命中；应用内提交 / 未命中 / 存量行 = null。$$;
