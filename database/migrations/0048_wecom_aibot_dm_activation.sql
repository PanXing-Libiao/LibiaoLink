-- LibiaoLink · 0048 单聊激活表 + 通知投递渠道扩值（M5-03-5-2 迁移段 · Push 236 · lan）
-- 口径来源：docs/M5-03-单聊改智能机器人执行计划(企微单聊).md §3.2（激活表与回调 ingest）/ §3.5（846607
--   分流）/ §4（M5-03-5-2）；docs/adr/ADR-033-企微消息通道改由智能机器人承接.md（渠道承接 · 单聊 =
--   智能机器人）；server/src/db/schema/notify.ts（Drizzle 镜像）。
-- 变更（只加不改）：
--   1. wecom_aibot_dm_activations —— 单聊激活表（主动推送前置；用户向机器人发过消息 = 激活）：
--      · wecom_userid 唯一（回调 from.userid 原文）；user_id 可空 FK → users（按 users.username 反查
--        回填；未匹配 / 尚未回填为 null）；first_activated_at = 首次激活时刻（upsert 不覆盖）；
--        last_message_at = 最近一条消息时刻（upsert 刷新）；审计两列 created_at / updated_at
--        （无触发器，由应用写入 updated_at）；
--      · 形状护栏沿用群表（0046 wecom_groups）风格：userid 字符集 / 长度 CHECK。
--   2. notify_deliveries —— channel CHECK 扩值：保留旧值（wecom_app / wecom_group / email），
--      增 'wecom_aibot'（单聊 aibot 投递留痕；改约束 = drop + add，存量行不受影响）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   alter table notify_deliveries drop constraint ck_notify_deliveries_channel;
--   alter table notify_deliveries add constraint ck_notify_deliveries_channel check (channel in ('wecom_app', 'wecom_group', 'email'));
--   drop table if exists wecom_aibot_dm_activations;

create table wecom_aibot_dm_activations (
  id bigserial primary key,
  wecom_userid text not null,
  user_id uuid references users (id),
  first_activated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_wecom_aibot_dm_activations_userid check (wecom_userid ~ '^[A-Za-z0-9_.@-]{1,64}$')
);

create unique index uq_wecom_aibot_dm_activations_userid on wecom_aibot_dm_activations (wecom_userid);

alter table notify_deliveries drop constraint ck_notify_deliveries_channel;
alter table notify_deliveries add constraint ck_notify_deliveries_channel
  check (channel in ('wecom_app', 'wecom_aibot', 'wecom_group', 'email'));
