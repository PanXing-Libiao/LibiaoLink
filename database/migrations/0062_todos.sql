-- LibiaoLink · 0062 自定义待办（M5-06-3 · A14 · 2026-10-20 · lan）
-- 口径来源：docs/M5-06-实施方案与执行计划(规则管理与发送记录).md §9 M5-06-3；
--   系统功能书 C2-06（标题 / 内容 / 关联项目或任务 / 提醒时间 / 提醒对象 / 重复规则）；
--   docs/rules/A01-A03-A14-扩展规则文案.md A14（提醒日当天 09:00、todo.status != done、rule.members 收件人）。
-- 迁移号在开工时复核：当前目录最高为 0061，因此本文件取 0062；不得回改历史迁移。
-- 设计：
--   1. todos —— 一条待办一行；remind_at = 首次提醒时刻（timestamptz，业务日按 Asia/Shanghai 折算）；
--      repeat_rule = none / daily / weekly / monthly；repeat_until 含当日、null = 不限；
--      reminder_user_ids = 提醒对象（至少 1 人；数组元素不设 FK，用户删除后由读面过滤）；
--      project_id / task_id = 关联项目 / 任务（可空，删除时置空）；status = pending / done；
--      completed_at 与 status 成对（done 必有完成时刻）。
--   2. 不在本表预展开逐次提醒日：AutomationSubjectReader 按调度窗口 + 重复规则求值，避免无限重复写行。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists todos;

create table todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  title text not null,
  content text,
  project_id uuid references projects (id) on delete set null,
  task_id uuid references tasks (id) on delete set null,
  remind_at timestamptz not null,
  repeat_rule text not null default 'none',
  repeat_until date,
  reminder_user_ids uuid[] not null default array[]::uuid[],
  status text not null default 'pending',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ck_todos_title check (char_length(btrim(title)) between 1 and 200),
  constraint ck_todos_content check (content is null or char_length(content) <= 4000),
  constraint ck_todos_repeat_rule check (repeat_rule in ('none', 'daily', 'weekly', 'monthly')),
  constraint ck_todos_repeat_until check (
    repeat_until is null or repeat_until >= (remind_at at time zone 'Asia/Shanghai')::date
  ),
  constraint ck_todos_reminder_users check (
    cardinality(reminder_user_ids) >= 1 and array_position(reminder_user_ids, null) is null
  ),
  constraint ck_todos_status check (status in ('pending', 'done')),
  constraint ck_todos_completed check ((status = 'done') = (completed_at is not null)),
  constraint ck_todos_timestamps check (updated_at >= created_at)
);

create index ix_todos_remind on todos (remind_at, id);
create index ix_todos_owner on todos (user_id, id);
create index ix_todos_reminder_users on todos using gin (reminder_user_ids);
