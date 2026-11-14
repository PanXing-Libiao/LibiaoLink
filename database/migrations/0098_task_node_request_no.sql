-- LibiaoLink · 0098 公共任务节点申请号（2026-11-14）
-- 业务口径：企微审核通知按「申请人 + 申请号」回复，例如「同意潘兴的1号申请」。
--   同一申请人在同一批待审申请内编号稳定；该申请人已无 pending 申请时，下一条从 1 号重新开始。
--   request_no 只用于审核沟通与通知，不改现有 API 契约。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新列随表权限自动可用。
-- 回滚（如需）：
--   drop index if exists uq_task_node_requests_pending_no;
--   alter table task_node_requests drop constraint if exists ck_task_node_requests_request_no;
--   alter table task_node_requests drop column if exists request_no;

alter table task_node_requests add column request_no integer;

with numbered as (
  select id, row_number() over (partition by requested_by order by requested_at, id) as rn
  from task_node_requests
)
update task_node_requests as request
   set request_no = numbered.rn
  from numbered
 where numbered.id = request.id;

update task_node_requests
   set request_no = 1
 where request_no is null;

alter table task_node_requests alter column request_no set not null;

alter table task_node_requests
  add constraint ck_task_node_requests_request_no check (request_no > 0);

-- 同一申请人同时只允许一个相同编号；历史已处理行和新一批的 1 号可以并存。
create unique index uq_task_node_requests_pending_no
  on task_node_requests (requested_by, request_no)
  where status = 'pending';

comment on column task_node_requests.request_no is
  '申请人维度申请号（企微回复寻址）：pending 内稳定，处理完一批后下一条从 1 开始';
