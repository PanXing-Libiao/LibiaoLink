-- LibiaoLink · 0065 站内信删除（2026-10-23）
-- 业务口径：「站内信要可以删除消息一键删除和删除指定项」。
-- 语义：删除 = 从本人收件箱隐藏（软删），用于单条删除与一键删除全部；
--   不物理删 notifications 行，C5-03 全量留档 / 合并子行 / 管理员发送记录（notify_delivery_messages）保留。
--   已删除行不再进入收件箱列表 / 未读角标，不参与后续合并、稍后提醒触发与标记写口；
--   用户删除不回收每日投递上限的历史计数（已投递事实不变）。
-- 回滚（如需）：
--   alter table notifications drop column deleted_at;

alter table notifications add column deleted_at timestamptz;
