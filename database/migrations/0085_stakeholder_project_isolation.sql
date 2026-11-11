-- LibiaoLink · 0085 项目干系人独立归属（2026-11-10 · px）
-- 业务口径：每个项目拥有独立的干系人清单；同一个人出现在多个项目时是互不关联的独立记录。
-- 收敛方式：历史多关联不删除数据，按“优先保留未删除项目，其次最早关联”保留原记录，
-- 其余每个项目复制一条完整干系人记录并改挂到该项目；完成后每条记录只归属一个项目。
-- 数据库以 stakeholder_id 唯一约束兜底，禁止再次形成跨项目共享。
-- 不增加姓名 / 手机号唯一约束：不同项目的重复联系人是允许的。
-- 回滚（如需）：
--   alter table project_stakeholders drop constraint uq_project_stakeholders_stakeholder;
--   create index ix_project_stakeholders_stakeholder on project_stakeholders (stakeholder_id);
-- 注意：回滚不会自动合并迁移时复制出的独立记录。

with ranked as (
  select ps.id as link_id,
         ps.stakeholder_id,
         row_number() over (
           partition by ps.stakeholder_id
           order by (p.deleted_at is null) desc, ps.linked_at asc, ps.id asc
         ) as rn
  from project_stakeholders ps
  left join projects p on p.id = ps.project_id
),
clones as (
  select r.link_id, r.stakeholder_id, gen_random_uuid() as clone_id
  from ranked r
  where r.rn > 1
),
inserted as (
  insert into stakeholders (
    id, name, company_type, company, title, phone, wechat, email, remark, role,
    created_by, created_at, updated_at, deleted_at, deleted_by
  )
  select c.clone_id, s.name, s.company_type, s.company, s.title, s.phone, s.wechat,
         s.email, s.remark, s.role, s.created_by, s.created_at, s.updated_at,
         s.deleted_at, s.deleted_by
  from clones c
  join stakeholders s on s.id = c.stakeholder_id
  returning id
),
updated as (
  update project_stakeholders ps
  set stakeholder_id = c.clone_id
  from clones c
  join inserted i on i.id = c.clone_id
  where ps.id = c.link_id
  returning ps.id
)
select count(*) as project_stakeholder_records_split from updated;

drop index if exists ix_project_stakeholders_stakeholder;

alter table project_stakeholders
  add constraint uq_project_stakeholders_stakeholder unique (stakeholder_id);
