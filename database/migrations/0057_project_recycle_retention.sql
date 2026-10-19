-- LibiaoLink · 0057 项目回收站 30 天到期清理 + seq_no 空号复用（2026-10-19）
-- 口径：
--   1. 项目移入回收站后保留 30 天；worker 每 24 小时扫描 deleted_at <= now() - interval '30 days' 的项目，
--      复用彻底删除链路清理聚合数据、文件 / 图片对象及全部对象版本，并写 system 审计。
--   2. seq_no 从本次起改为“最小可用正整数”：项目彻底删除后释放的序号，由下一次创建项目复用；
--      回收站期间仍占用，恢复不会撞号。
--   3. 保留 projects_seq_no_seq 作为兼容默认值；应用创建路径在事务内显式分配 seq_no。
-- 只追加迁移；无数据回填，不修改应用角色权限。

create index if not exists ix_projects_recycled_deleted_at
  on projects (deleted_at)
  where deleted_at is not null;

comment on column projects.seq_no is $q$项目全库唯一正整数；创建时分配当前最小可用序号，彻底删除项目后该序号可被下一次创建复用$q$;
comment on sequence projects_seq_no_seq is $q$历史项目序号序列（兼容默认值）；当前应用创建路径按最小空闲号显式分配，不再依赖 nextval$q$;
