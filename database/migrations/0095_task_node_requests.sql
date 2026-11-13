-- LibiaoLink · 0095 公共任务节点申请（2026-11-13）
-- 业务口径：导入表导入不再向公共节点库补节点；未匹配 / 保留 Excel 原名的任务改为「申请加入公共节点库」，
--   由审核人（与 taskNodeManage 同口径：系统管理员，或至少管理一个未删除项目的项目经理）逐条通过或驳回。
--   - 申请本身不写 task_nodes；审核通过时才按同阶段同名判重建公共节点（已有同名则直接关联，不重复建）；
--   - 申请与项目导入在同一事务内提交：导入成功则申请落地，整批失败则一起回滚；
--   - 一张表内保留「谁申请、什么时候、来自哪个项目 / 哪次导入票据、谁审、审的结果与原因、最终关联到哪个节点」。
-- 判重：同一阶段同一名称只允许一条 pending（部分唯一索引）；通过后改名撞已有节点由应用层转成「关联已有」。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随 roles/0001 default privileges 自动授权。
-- 回滚（如需）：
--   drop table if exists task_node_requests;

create table task_node_requests (
  id uuid primary key default gen_random_uuid(),
  stage_key text not null,
  title text not null,
  title_en text,
  status text not null default 'pending',
  requested_by uuid not null references users (id),
  requested_at timestamptz not null default now(),
  project_id uuid references projects (id) on delete set null,
  source_preview_id uuid references project_import_previews (id) on delete set null,
  reviewed_by uuid references users (id),
  reviewed_at timestamptz,
  review_note text,
  node_id uuid references task_nodes (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_task_node_requests_stage_key check (
    stage_key in ('presale', 'design', 'purchase', 'assembly', 'install', 'deploy', 'trial', 'production', 'acceptance')
  ),
  constraint ck_task_node_requests_status check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  constraint ck_task_node_requests_title check (char_length(btrim(title)) between 1 and 200),
  constraint ck_task_node_requests_title_en check (title_en is null or char_length(btrim(title_en)) between 1 and 200),
  constraint ck_task_node_requests_node_source check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null and review_note is null and node_id is null)
    or (status = 'approved' and reviewed_by is not null and reviewed_at is not null and node_id is not null)
    or (status = 'rejected' and reviewed_by is not null and reviewed_at is not null and review_note is not null and node_id is null)
    or (status = 'withdrawn' and reviewed_by is null and reviewed_at is null and node_id is null)
  )
);

-- 同阶段同名只留一条待审申请：重复提交复用既有行，避免审核队列刷屏。
create unique index uq_task_node_requests_pending_title
  on task_node_requests (stage_key, title)
  where status = 'pending';

create index ix_task_node_requests_status
  on task_node_requests (status, requested_at, id);

create index ix_task_node_requests_requester
  on task_node_requests (requested_by, requested_at desc, id);

create index ix_task_node_requests_node
  on task_node_requests (node_id)
  where node_id is not null;

comment on table task_node_requests is
  '公共任务节点申请：导入侧发起（未匹配 / 保留 Excel 原名），节点库维护侧审核；通过后才写 task_nodes';
comment on column task_node_requests.status is
  'pending = 待审核；approved = 已通过（已建或已关联公共节点）；rejected = 已驳回；withdrawn = 申请人已撤销';
comment on column task_node_requests.title is
  '申请加入公共节点库的中文名；审核通过时可按审核人口径定稿（改名字段只在申请行内保留，节点名以 task_nodes 为准）';
comment on column task_node_requests.project_id is
  '来源项目（导入提交时同事务创建的项目）；项目删除后置空，保留申请历史';
comment on column task_node_requests.source_preview_id is
  '来源预览票据（project_import_previews）；票据清理后置空';
comment on column task_node_requests.node_id is
  '审核通过后创建或关联到的公共节点（task_nodes.id 且 owner_template_id is null）；节点被删后置空';
