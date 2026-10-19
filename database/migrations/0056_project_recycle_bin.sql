-- LibiaoLink · 0056 项目回收站（2026-10-19 · 业务口径「项目删除进入回收站」）
-- 口径：
--   1. DELETE /api/v1/projects/{id} 恢复为软删：只写 projects.deleted_at / deleted_by，version + 1；
--      项目聚合子表与对象存储 projects/{id}/ 下的图片 / 文件保持不动，以便恢复。
--   2. 普通列表 / 详情 / facets 继续过滤 deleted_at is null；项目回收站 = GET /projects?filter[recycled]=true。
--   3. 恢复 = POST /projects/{id}/restore；彻底删除 = POST /projects/{id}/purge（仅管理员），
--      后者清空项目聚合子表并删除对象存储前缀下全部版本与 delete marker。
--   4. projects_code_key 保持全局唯一：项目在回收站期间编号仍占用，彻底删除后才释放；
--      seq_no 仍不回收（跳号）。
-- 只追加迁移；无数据回填，不修改应用角色权限。

create index if not exists ix_projects_recycled_updated
  on projects (updated_at desc)
  where deleted_at is not null;

alter table projects drop constraint if exists ck_projects_deleted_pair;
alter table projects add constraint ck_projects_deleted_pair
  check ((deleted_at is null) = (deleted_by is null));

comment on table projects is $q$项目主档（M2-01）：2026-10-19 起删除 = 移入项目回收站（deleted_at / deleted_by）；恢复清标记，彻底删除才物理清理聚合数据与对象存储$q$;
comment on column projects.deleted_at is $q$项目进入回收站的时间；null = 未删除；普通读面过滤 deleted_at is null$q$;
comment on column projects.deleted_by is $q$将项目移入回收站的操作人（users.id）$q$;
comment on constraint projects_code_key on projects is $q$项目编号全局唯一；项目在回收站期间编号仍占用，彻底删除后释放$q$;
