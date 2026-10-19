-- LibiaoLink · 0058 企微未绑定群候选（设置页自动发现群 · C2-05 补充）
--
-- 背景：群回调原先只处理已绑定群；未绑定群仅掩码告警后丢弃，导致前端无法获得 chatid。
-- 本迁移只新增 staging 表：
--   · 机器人收到未绑定群的消息 -> upsert chatid + 最后活跃时间（同群一行）；
--   · 设置页候选列表只读 chatid 末 4 位掩码；
--   · 选择候选绑定项目成功后，由 project 模块删除该行；
--   · 表不关联项目 —— 一个群在绑定前没有项目归属。
-- 只追加迁移；应用角色 libiaolink_api 无 DDL，新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists wecom_group_candidates;

create table wecom_group_candidates (
  id bigserial primary key,
  chatid text not null,
  name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint ck_wecom_group_candidates_chatid check (chatid ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint ck_wecom_group_candidates_name check (name is null or char_length(btrim(name)) between 1 and 64)
);

create unique index uq_wecom_group_candidates_chatid on wecom_group_candidates (chatid);
create index ix_wecom_group_candidates_last_seen on wecom_group_candidates (last_seen_at desc);
