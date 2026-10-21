-- LibiaoLink · 0052 变更前后摘要附图（Push 315 · 业务口径「这个变更要可以填图片」—— 变更前 / 变更后两栏支持填图）
-- 编号顺延：原取 0050（平行刀先在 main 合入，但 0051 已先于本刀上服）—— 追加式迁移器只允许在已执行序列末尾追加，
--   而服务端已执行到 0051（0051 之前插入 0050 会被「迁移顺序非法」拒绝）→ 本文件随 PR #356 后订正顺延为 0052。
-- 口径来源：业务口径 2026-10-14「这个变更要可以填图片」（抽屉「变更申请」页 —— 变更前 / 变更后 文本摘要之外要能贴图 / 选图）；
--   契约 ChangeIntentBody.beforeSummaryFileIds / afterSummaryFileIds（随上传会话 change_payload 提交，完成变更时同事务入本表）。
-- 变更（只加列 · 纯新增 · 不动存量行）：
--   1. change_requests 增 before_summary_file_ids uuid[]（非空、默认空数组）—— 变更前摘要附图（有序，≤ 30 张）；
--   2. change_requests 增 after_summary_file_ids uuid[]（非空、默认空数组）—— 变更后摘要附图（有序，≤ 30 张）。
-- 引用口径：存 files.id 有序数组、不建外键（与 file_links.object_id 同口径 —— 多值引用由应用层校验：
--   intent=change 建会话时校验「文件存在 / 属本项目 / 未进回收站」，非法 400 VALIDATION_FAILED）；
--   读面（变更记录 / 变更管理弹窗）按 id 取预览签名展示；不落 file_links、不动 file_links.kind 取值面。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；不改权限，新列随表级 GRANT 生效。
-- 回滚（如需；约束随列一并删除）：
--   alter table change_requests drop column before_summary_file_ids, drop column after_summary_file_ids;
alter table change_requests
  add column before_summary_file_ids uuid[] not null default array[]::uuid[],
  add column after_summary_file_ids uuid[] not null default array[]::uuid[];

alter table change_requests add constraint ck_change_requests_before_summary_file_ids check (cardinality(before_summary_file_ids) <= 30);
alter table change_requests add constraint ck_change_requests_after_summary_file_ids check (cardinality(after_summary_file_ids) <= 30);
