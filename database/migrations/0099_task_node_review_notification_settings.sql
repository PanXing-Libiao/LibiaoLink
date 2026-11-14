-- LibiaoLink · 0099 公共节点审核企微通知设置（2026-11-15）
-- 业务口径：任务模板「入库审核」左侧提供全局开关与每日通知时间；关闭 = 不发送待审核申请通知，
--   开启 = 每天到设定时刻发送尚未通知的 pending 申请。审批结果的即时通知不受本开关影响。
-- 单例：id 恒为 true；last_dispatched_on 记录最近一次每日派发所在的上海业务日，防止当天重复派发。
-- 回滚（如需）：
--   drop table if exists task_node_review_notification_settings;

create table task_node_review_notification_settings (
  id boolean primary key default true,
  enabled boolean not null default true,
  daily_time text not null default '09:00',
  last_dispatched_on date,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id),
  constraint ck_task_node_review_notification_settings_single check (id),
  constraint ck_task_node_review_notification_settings_daily_time
    check (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

insert into task_node_review_notification_settings (id) values (true) on conflict (id) do nothing;

comment on table task_node_review_notification_settings is
  '公共节点审核企微通知全局设置：开关 + 每日通知时间（Asia/Shanghai）；审批结果通知仍即时';
comment on column task_node_review_notification_settings.last_dispatched_on is
  '最近一次每日待审通知派发的上海业务日（YYYY-MM-DD）；同一业务日不重复派发';

grant select, insert, update on table task_node_review_notification_settings to libiaolink_api;
grant select on table task_node_review_notification_settings to libiaolink_readonly;
