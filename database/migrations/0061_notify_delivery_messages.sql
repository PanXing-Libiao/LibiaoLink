-- LibiaoLink · 0061 消息级发送归档（M5-06-2A · 2026-10-20 · lan）
-- 口径来源：docs/M5-06-实施方案与执行计划(规则管理与发送记录).md §3.4 / §3.5 / §5.1；
--   shared/src/modules/notifications.ts（NotifyDeliveryMessage / NotifyDeliveryAttempt · S8-4 已合并）。
-- 迁移号在开工时复核：当前目录最高为 0060，因此本文件取 0061；不得回改历史迁移。
-- 变更（只加不改业务语义）：
--   1. notify_delivery_messages —— 一次 outbox 消息一行（notify.message / notify.group），保存标题 / 正文 /
--      渠道 / 收件人 / 原始载荷与最新状态；source_dedupe_key 唯一 = 重复消费 / 回填幂等；
--      outbox_id 在事件清理后置 null，归档不随 outbox 清理；recipient_id 不设 users FK（用户删除后仍保留历史事实）；
--      resend_of_message_id 自引用，供 M5-06-2B 重发链路关联原消息。
--   2. notify_deliveries.message_id —— 尝试级行关联消息归档；历史行允许 null（回填脚本只补缺失链接）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   alter table notify_deliveries drop constraint if exists notify_deliveries_message_id_fkey;
--   drop index if exists ix_notify_deliveries_message;
--   alter table notify_deliveries drop column if exists message_id;
--   drop table if exists notify_delivery_messages;

create table notify_delivery_messages (
  id bigserial primary key,
  outbox_id bigint references outbox_events (id) on delete set null,
  source_dedupe_key text not null,
  topic text not null,
  channel text not null,
  recipient_id uuid,
  recipient_label text,
  title text,
  body text not null,
  template_code text,
  rule_code text,
  ref_type text,
  ref_id text,
  payload jsonb not null,
  resend_of_message_id bigint references notify_delivery_messages (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  last_state text not null default 'pending',
  attempt_count integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_notify_delivery_messages_source_dedupe_key
    check (char_length(btrim(source_dedupe_key)) between 1 and 256),
  constraint ck_notify_delivery_messages_topic
    check (topic in ('notify.message', 'notify.group')),
  constraint ck_notify_delivery_messages_channel
    check (channel in ('inbox', 'wecom_app', 'wecom_aibot', 'wecom_group', 'email')),
  constraint ck_notify_delivery_messages_recipient_label
    check (recipient_label is null or char_length(btrim(recipient_label)) between 1 and 256),
  constraint ck_notify_delivery_messages_title
    check (title is null or char_length(btrim(title)) between 1 and 200),
  constraint ck_notify_delivery_messages_body
    check (char_length(btrim(body)) between 1 and 4000),
  constraint ck_notify_delivery_messages_template_code
    check (template_code is null or char_length(btrim(template_code)) between 1 and 60),
  constraint ck_notify_delivery_messages_rule_code
    check (rule_code is null or char_length(btrim(rule_code)) between 2 and 32),
  constraint ck_notify_delivery_messages_ref
    check ((ref_type is null) = (ref_id is null)
      and (ref_type is null or char_length(btrim(ref_type)) between 1 and 40)
      and (ref_id is null or char_length(btrim(ref_id)) between 1 and 64)),
  constraint ck_notify_delivery_messages_payload
    check (jsonb_typeof(payload) = 'object'),
  constraint ck_notify_delivery_messages_metadata
    check (jsonb_typeof(metadata) = 'object'),
  constraint ck_notify_delivery_messages_resend
    check (resend_of_message_id is null or resend_of_message_id <> id),
  constraint ck_notify_delivery_messages_state
    check (last_state in ('pending', 'sent', 'failed', 'deferred', 'dead')),
  constraint ck_notify_delivery_messages_attempt_count
    check (attempt_count >= 0),
  constraint ck_notify_delivery_messages_outcome
    check (
      (last_state = 'sent' and sent_at is not null and last_error is null)
      or (last_state = 'pending' and sent_at is null and last_error is null)
      or (last_state in ('failed', 'deferred', 'dead')
        and sent_at is null and last_error is not null and char_length(btrim(last_error)) > 0)
    ),
  constraint ck_notify_delivery_messages_timestamps
    check (updated_at >= created_at)
);

create unique index uq_notify_delivery_messages_source
  on notify_delivery_messages (source_dedupe_key);
create index ix_notify_delivery_messages_outbox
  on notify_delivery_messages (outbox_id, id desc);
create index ix_notify_delivery_messages_channel_created
  on notify_delivery_messages (channel, created_at desc);
create index ix_notify_delivery_messages_state_created
  on notify_delivery_messages (last_state, created_at desc);
create index ix_notify_delivery_messages_rule_created
  on notify_delivery_messages (rule_code, created_at desc);
create index ix_notify_delivery_messages_resend
  on notify_delivery_messages (resend_of_message_id)
  where resend_of_message_id is not null;

alter table notify_deliveries
  add column message_id bigint references notify_delivery_messages (id) on delete set null;

create index ix_notify_deliveries_message
  on notify_deliveries (message_id, id);
