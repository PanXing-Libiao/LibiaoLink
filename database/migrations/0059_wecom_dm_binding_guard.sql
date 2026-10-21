-- LibiaoLink · 0059 企微单聊绑定码防猜码守卫（2026-10-20 · lan）
-- 口径：docs/M5-03-5-绑定码方案设计口径(企微单聊).md v2.0 §3 / §5 / §9 / §10；
--   安全结论：验证侧失败限制 = 5 次 / 10 分钟 / (bot_id, wecom_userid)，达到后按
--   1 / 2 / 4 / 8 / 16 / 30 分钟指数退避；绑定码 TTL = 3 分钟。
-- 变更（只追加）：① 绑定码增加机器人维度，查询与唯一性均按 (bot_id, …) 隔离；
--   ② 激活表增加猜码守卫状态（失败计数 / 窗口起点 / 锁定级别 / 锁定至 / 最近 msgid）；
--   ③ 迁移时把存量 pending 码统一置 expired（TTL 仅 3 分钟，避免旧码无归属窗口）。
-- 回滚（如需）：
--   alter table wecom_aibot_dm_activations drop column last_binding_msgid;
--   alter table wecom_aibot_dm_activations drop column last_binding_attempt_at;
--   alter table wecom_aibot_dm_activations drop column binding_locked_until;
--   alter table wecom_aibot_dm_activations drop column binding_lock_level;
--   alter table wecom_aibot_dm_activations drop column binding_fail_window_started_at;
--   alter table wecom_aibot_dm_activations drop column binding_fail_count;
--   drop index if exists ix_wecom_id_binding_codes_bot_user_created;
--   create index ix_wecom_id_binding_codes_user_created on wecom_id_binding_codes (user_id, created_at desc);
--   drop index if exists uq_wecom_id_binding_codes_pending;
--   create unique index uq_wecom_id_binding_codes_pending on wecom_id_binding_codes (user_id) where status = 'pending';
--   drop index if exists uq_wecom_id_binding_codes_bot_code;
--   create unique index uq_wecom_id_binding_codes_code on wecom_id_binding_codes (code);
--   alter table wecom_id_binding_codes drop constraint ck_wecom_id_binding_codes_bot_id;
--   alter table wecom_id_binding_codes drop column bot_id;

alter table wecom_id_binding_codes add column bot_id text;
update wecom_id_binding_codes set bot_id = 'legacy';
update wecom_id_binding_codes set status = 'expired' where status = 'pending';
alter table wecom_id_binding_codes alter column bot_id set not null;
alter table wecom_id_binding_codes add constraint ck_wecom_id_binding_codes_bot_id
  check (bot_id ~ '^[A-Za-z0-9_.@-]{1,64}$');

drop index uq_wecom_id_binding_codes_code;
create unique index uq_wecom_id_binding_codes_bot_code on wecom_id_binding_codes (bot_id, code);

drop index uq_wecom_id_binding_codes_pending;
create unique index uq_wecom_id_binding_codes_pending on wecom_id_binding_codes (bot_id, user_id) where status = 'pending';

drop index ix_wecom_id_binding_codes_user_created;
create index ix_wecom_id_binding_codes_bot_user_created on wecom_id_binding_codes (bot_id, user_id, created_at desc);

alter table wecom_aibot_dm_activations add column binding_fail_count integer not null default 0;
alter table wecom_aibot_dm_activations add column binding_fail_window_started_at timestamptz;
alter table wecom_aibot_dm_activations add column binding_lock_level integer not null default 0;
alter table wecom_aibot_dm_activations add column binding_locked_until timestamptz;
alter table wecom_aibot_dm_activations add column last_binding_attempt_at timestamptz;
alter table wecom_aibot_dm_activations add column last_binding_msgid text;

alter table wecom_aibot_dm_activations add constraint ck_wecom_aibot_dm_activations_binding_fail_count
  check (binding_fail_count >= 0);
alter table wecom_aibot_dm_activations add constraint ck_wecom_aibot_dm_activations_binding_lock_level
  check (binding_lock_level between 0 and 6);
alter table wecom_aibot_dm_activations add constraint ck_wecom_aibot_dm_activations_last_binding_msgid
  check (last_binding_msgid is null or char_length(last_binding_msgid) between 1 and 128);
