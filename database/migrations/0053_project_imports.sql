-- LibiaoLink · 0053 老表导入预览票据（老表 Excel 直连导入 · 业务口径 2026-10-14 · Push 316 前端接线 / 本次服务端落地）
-- 口径来源：业务口径 2026-10-14「先在新建项目左侧加导入项目按钮 点击导入选择 Excel 然后不切换页面 直接在项目空间里面有一块大屏里面操作」+「直连 API 导入」；
--   契约 shared/src/modules/imports.ts（ProjectImportPreview / ProjectImportCommitBody / ProjectImportResult）；
--   《前端功能需求》§一.10（页面与四步面板）/ §3.9（接口契约草案）。
-- 变更（纯新增表 · 不动存量）：
--   project_import_previews —— 预览票据：preview 解析结果（payload jsonb，含任务 / 日报 / 变更 / 节点 / 账号 / 提醒清单）
--   + 源工作簿对象键（object_key，提交时按需取回解出内嵌图片）；commit 单事务写入全部业务数据后置 committed。
--   状态机：pending → committed（提交成功）；pending → expired（超时未提交，服务端惰性标记 / 清理对象）。
-- 口径：
--   1. 票据默认 30 分钟有效（IMPORT_PREVIEW_TTL_MINUTES）；过期提交 410 IMPORT_PREVIEW_EXPIRED。
--   2. payload 只存解析产物（不存源文件二进制）；文件本身在对象存储（imports/<previewId>/source.xlsx），提交 / 过期后清理。
--   3. committed_project_id 记录落位项目（只读排障用，项目硬删时置空 —— on delete set null）。
-- 只追加迁移：应用角色 libiaolink_api 无 DDL；新表随默认权限自动授权（与既有表同口径）。
-- 回滚（如需）：drop table project_import_previews;
create table project_import_previews (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_size_bytes bigint not null,
  object_key text not null,
  payload jsonb not null,
  status text not null default 'pending',
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  committed_project_id uuid references projects (id) on delete set null
);

alter table project_import_previews add constraint ck_project_import_previews_status check (status in ('pending', 'committed', 'expired'));
alter table project_import_previews add constraint ck_project_import_previews_file_size check (file_size_bytes >= 0);
alter table project_import_previews add constraint ck_project_import_previews_expires check (expires_at > created_at);
alter table project_import_previews add constraint ck_project_import_previews_payload check (jsonb_typeof(payload) = 'object');
alter table project_import_previews add constraint ck_project_import_previews_committed_pair check ((status = 'committed') = (committed_at is not null));

create index ix_project_import_previews_status_expires on project_import_previews (status, expires_at);
create index ix_project_import_previews_creator on project_import_previews (created_by, created_at desc, id);

comment on table project_import_previews is '老表导入预览票据（0053）：preview 解析结果 + 源工作簿对象键；commit 单事务写入业务数据后置 committed；过期 410 IMPORT_PREVIEW_EXPIRED。';
comment on column project_import_previews.payload is '解析产物（ProjectImportPreview 同形 + 规范化数据）—— 不存源文件二进制（对象存储 imports/<previewId>/source.xlsx）。';
