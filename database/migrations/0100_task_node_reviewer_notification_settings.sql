-- LibiaoLink · 0100 公共节点审核企微通知设置改为审核人个人（2026-11-15）
-- 业务口径：每位公共节点审核管理员各自配置开关、通知方式（immediate 及时 / scheduled 固定时间）与固定时间 HH:mm。
--   关闭 = 该审核人不再收到待审核申请通知；及时 = 新申请随导入事务即时写 outbox；
--   固定时间 = worker 到本人设定时刻派发尚未通知的 pending 申请。审批结果通知不走本设置，仍在审核事务内即时发送。
-- 迁移：把 0099 全局设置复制给当前审核人，默认沿用原开关 / 时间 / 当日派发标记，通知方式取 scheduled；旧表保留作历史与回滚依据。
-- 新审核人没有行时按默认（开启 / 固定时间 / 09:00）处理；首次保存或首次到点派发时落行。
-- 回滚（如需）：
--   drop table if exists task_node_reviewer_notification_settings;

create table task_node_reviewer_notification_settings (
  reviewer_id uuid primary key references users (id) on delete cascade,
  enabled boolean not null default true,
  notification_mode text not null default 'scheduled',
  daily_time text not null default '09:00',
  last_dispatched_on date,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  constraint ck_task_node_reviewer_notification_settings_mode
    check (notification_mode in ('immediate', 'scheduled')),
  constraint ck_task_node_reviewer_notification_settings_daily_time
    check (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

insert into task_node_reviewer_notification_settings (
  reviewer_id,
  enabled,
  notification_mode,
  daily_time,
  last_dispatched_on,
  updated_at,
  updated_by
)
select
  reviewers.user_id,
  legacy.enabled,
  'scheduled',
  legacy.daily_time,
  legacy.last_dispatched_on,
  legacy.updated_at,
  legacy.updated_by
from task_node_reviewers as reviewers
cross join task_node_review_notification_settings as legacy
where legacy.id
on conflict (reviewer_id) do nothing;

comment on table task_node_reviewer_notification_settings is
  '公共节点审核企微通知个人设置：开关 + 通知方式（immediate / scheduled）+ 固定时间（Asia/Shanghai）；审批结果通知仍即时';
comment on column task_node_reviewer_notification_settings.notification_mode is
  'immediate = 新申请即时通知；scheduled = 到本人 daily_time 派发当日 pending 申请';
comment on column task_node_reviewer_notification_settings.last_dispatched_on is
  '最近一次固定时间待审通知派发的上海业务日（YYYY-MM-DD）；同一审核人同一业务日不重复派发';

grant select, insert, update on table task_node_reviewer_notification_settings to libiaolink_api;
grant select on table task_node_reviewer_notification_settings to libiaolink_readonly;
