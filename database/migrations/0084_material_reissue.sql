-- LibiaoLink · 0084 物料变更补发（业务口径 2026-11-09）
-- 来源：任务抽屉「变更申请」增加第二入口「物料变更补发」，仿现有《补发/补货申请表》线上填写；
-- 提交后写一条变更记录，并自动生成 DOCX 进入项目文件。申请人 / 时间由服务端记录，补发类别为选题。
--
-- 变更：
--   1. change_requests.change_type：file_change（存量普通变更，默认）/ material_reissue（物料补发）；
--   2. change_requests.material_reissue：补发表单快照（项目 / 任务 / 申请人自动带入 + 表单字段 + 物料行）；普通变更为 null。
--
-- 回滚（如需）：
--   alter table change_requests drop constraint ck_change_requests_material_reissue_payload;
--   alter table change_requests drop constraint ck_change_requests_change_type;
--   alter table change_requests drop column material_reissue;
--   alter table change_requests drop column change_type;

alter table change_requests
  add column change_type text not null default 'file_change',
  add column material_reissue jsonb;

alter table change_requests
  add constraint ck_change_requests_change_type
  check (change_type in ('file_change', 'material_reissue')),
  add constraint ck_change_requests_material_reissue_payload
  check ((change_type = 'file_change' and material_reissue is null) or (change_type = 'material_reissue' and material_reissue is not null));
