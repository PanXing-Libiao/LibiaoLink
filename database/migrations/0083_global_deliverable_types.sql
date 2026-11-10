-- 全站自定义成果文件类型（2026-11-06 · **高风险 DDL，请 wmj 复核** · CONTRIBUTING §15）
--
-- 背景：输出成果文件选择器底部「自定义（仅限项目经理）」由项目项目经理新增；新增项不再只随单条任务保存，
-- 而是写入全站字典 dict_items（type_code = deliverableType），所有项目 / 任务 / 文件库均可选用。
-- 内置十类仍由 shared/src/common/dicts.ts 的 DOC_TYPES 契约枚举给出，不写入 dict_items。
--
-- 变更：只登记字典类型 deliverableType（sort = 30，排在地区 / 项目类型之后）；不新增表 / 列，不回填业务数据。
-- 回滚：delete from dict_items where type_code = 'deliverableType'; delete from dict_types where code = 'deliverableType';
-- 注意：回滚会移除全站自定义成果类型入口；存量任务里的自定义字符串仍保留，但不再出现在候选列表。
insert into dict_types (code, name, sort, enabled, created_at, updated_at)
values ('deliverableType', '成果文件类型', 30, true, now(), now())
on conflict (code) do nothing;
