-- 0095 · 任务模板「入库审核」独立分组（2026-11-13）
--
-- 背景：任务模板页在「＋ 新建模板」左侧新增「入库审核」入口。
-- 业务口径：它是模板库的独立板块，不属于项目阶段；不能混入验收，也不参与项目任务生成。
--
-- 口径：
--   1. task_templates.stage_key 与 task_nodes.stage_key 增加 inbound_review；
--   2. inbound_review 只服务任务模板页 / 模板库，不进入 shared STAGE_KEYS，
--      项目 / 项目的阶段、任务、甘特图等仍只接受九阶段；
--   3. 入库审核模板的私有节点仍按 owner_template_id 隔离，不进入公共节点库；
--   4. 服务端从模板生成项目任务时显式拒绝 stage_key = inbound_review。
--
-- 回滚（如需；先清理该分组的模板及其节点，避免旧 CHECK 约束拒绝存量行）：
--   delete from task_templates where stage_key = 'inbound_review';
--   delete from task_nodes where stage_key = 'inbound_review';
--   alter table task_templates drop constraint if exists ck_task_templates_stage_key;
--   alter table task_templates add constraint ck_task_templates_stage_key
--     check (stage_key in ('presale','design','purchase','assembly','install','deploy','trial','production','acceptance'));
--   alter table task_nodes drop constraint if exists ck_task_nodes_stage_key;
--   alter table task_nodes add constraint ck_task_nodes_stage_key
--     check (stage_key in ('presale','design','purchase','assembly','install','deploy','trial','production','acceptance'));

alter table task_templates
  drop constraint if exists ck_task_templates_stage_key;

alter table task_templates
  add constraint ck_task_templates_stage_key
  check (stage_key in (
    'presale', 'design', 'purchase', 'assembly', 'install',
    'deploy', 'trial', 'production', 'acceptance', 'inbound_review'
  ));

alter table task_nodes
  drop constraint if exists ck_task_nodes_stage_key;

alter table task_nodes
  add constraint ck_task_nodes_stage_key
  check (stage_key in (
    'presale', 'design', 'purchase', 'assembly', 'install',
    'deploy', 'trial', 'production', 'acceptance', 'inbound_review'
  ));

comment on column task_templates.stage_key is
  '任务模板板块 key：九阶段或 inbound_review（入库审核，模板库特殊分组，不属于项目阶段）';

comment on column task_nodes.stage_key is
  '任务节点所属模板板块 key：九阶段或 inbound_review（仅模板专区分组，不属于项目阶段）';
