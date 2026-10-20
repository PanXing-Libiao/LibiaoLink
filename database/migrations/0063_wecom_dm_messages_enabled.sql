-- LibiaoLink · 0063 企微单聊消息开关（2026-10-20 · px）
-- 业务口径：部分用户希望完成企微绑定但不接收任务提醒；设置页增加“接收消息”开关，绑定成功后默认开启。
-- 语义：messages_enabled = false 时不再向该绑定行发送企微单聊消息；C5-04 站内信降级保留，
--   避免用户主动关闭外部提醒后仍然静默丢消息。解绑 / 重新绑定 / 跨用户换绑时恢复默认 true。
-- 回滚（如需）：
--   alter table wecom_aibot_dm_activations drop column messages_enabled;

alter table wecom_aibot_dm_activations
  add column messages_enabled boolean not null default true;
