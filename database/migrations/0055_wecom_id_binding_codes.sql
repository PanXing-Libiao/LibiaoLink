-- LibiaoLink · 0055 绑定码表 + 单聊激活表机器人维度（M5-03-5-6 实现段 · Push 247 · lan）
-- 口径来源：docs/M5-03-5-绑定码方案设计口径(企微单聊).md v1.3（§3 目标形态 / §4 数据模型 / §5 ingest 分支 /
--   §6 投递前判定 / §8 换机器人 / §10.2 D2 落地要点）；docs/M5-03-单聊改智能机器人执行计划(企微单聊).md §3 / §4（切片 M5-03-5-6）。
--   编号：口径件原写 0049 —— 该号已被他线迁移占用，按「只追加、末尾顺延」落为 0055。
-- 背景：企微后台无管理员权限 → 回调 from.userid = 企业主体下的密文 open_userid（实测量 E1 ~ E7）→ 明文
--   userid ↔ open_userid 的映射只能由用户交互产生 = 绑定码链路；单聊发送地址随之由 users.username（明文）
--   改为绑定行 wecom_userid（密文）。
-- 变更（只加不改 + 一次定向清理）：
--   1. wecom_id_binding_codes —— 绑定码表（D3 定案：6 位数字 / TTL 10 分钟 / 一次性 / 3 次每小时每用户）：
--      · code 6 位数字 CHECK + 全库唯一；status pending → used | expired（一次性；同一 user_id 仅一个 pending
--        由部分唯一索引保证 —— 重发由写入侧先作废旧码）；
--      · expires_at = created_at + TTL（写入侧定）；used_at / used_wecom_userid = 实际使用留痕（误绑可审计）；
--      · 只存码本身：用户消息正文不入库、不落日志（CONTRIBUTING §12）。
--   2. wecom_aibot_dm_activations —— 加机器人维度与绑定标记（D1 / D2 定案）：
--      · bot_id text 可空（= WECOM_BOT_ID 原文，不建字典表 / 不加外键）：换机器人 = 该 env 变化即视为新机器人；
--      · bound_at timestamptz 可空：非空 = 绑定行 = 可投递地址；NULL = 仅激活登记（D1：非绑定码单聊消息仍登记、
--        但不可作发送地址）；
--      · 唯一索引由 (wecom_userid) 改 (bot_id, wecom_userid)：一个企微号对一个机器人一行（换绑 = 覆盖旧行）；
--        bot_id 为 NULL 的历史行（旧机器人遗留）在本迁移清空 —— 激活态是按机器人成立的，保留会让 846607 被判成
--        「超频」→ deferred 反复重排、既不死信也不降级（口径 §8）；自此「换机器人前手动清空」的运维纪律作废。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需 · 清理行不可回滚 —— 旧机器人已删除，那些行本身无意义）：
--   drop table if exists wecom_id_binding_codes;
--   delete from wecom_aibot_dm_activations where bot_id is not null;
--   drop index uq_wecom_aibot_dm_activations_bot_userid;
--   create unique index uq_wecom_aibot_dm_activations_userid on wecom_aibot_dm_activations (wecom_userid);
--   alter table wecom_aibot_dm_activations drop column bound_at;
--   alter table wecom_aibot_dm_activations drop column bot_id;

create table wecom_id_binding_codes (
  id bigserial primary key,
  code text not null,
  user_id uuid not null references users (id),
  status text not null default 'pending',
  expires_at timestamptz not null,
  used_at timestamptz,
  used_wecom_userid text,
  created_at timestamptz not null default now(),
  constraint ck_wecom_id_binding_codes_code check (code ~ '^[0-9]{6}$'),
  constraint ck_wecom_id_binding_codes_status check (status in ('pending', 'used', 'expired')),
  constraint ck_wecom_id_binding_codes_used check ((status = 'used') = (used_at is not null)),
  constraint ck_wecom_id_binding_codes_used_userid
    check (used_wecom_userid is null or used_wecom_userid ~ '^[A-Za-z0-9_.@-]{1,64}$')
);

create unique index uq_wecom_id_binding_codes_code on wecom_id_binding_codes (code);
create unique index uq_wecom_id_binding_codes_pending on wecom_id_binding_codes (user_id) where status = 'pending';
create index ix_wecom_id_binding_codes_user_created on wecom_id_binding_codes (user_id, created_at desc);

alter table wecom_aibot_dm_activations add column bot_id text;
alter table wecom_aibot_dm_activations add column bound_at timestamptz;
alter table wecom_aibot_dm_activations add constraint ck_wecom_aibot_dm_activations_bot_id
  check (bot_id is null or bot_id ~ '^[A-Za-z0-9_.@-]{1,64}$');

delete from wecom_aibot_dm_activations where bot_id is null;

drop index uq_wecom_aibot_dm_activations_userid;
create unique index uq_wecom_aibot_dm_activations_bot_userid on wecom_aibot_dm_activations (bot_id, wecom_userid);
