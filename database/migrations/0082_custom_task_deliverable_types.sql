-- 自定义输出成果类型（2026-11-06 · **高风险 DDL，请 wmj 复核** · CONTRIBUTING §15）
--
-- 背景：输出成果文件选择器新增「自定义」入口；tasks.deliverable_types 需允许内置十类之外的
-- 1–50 字自定义名称。名称的 trim / 长度 / 去重 / 禁用英文逗号与换行由 shared
-- DeliverableTypeSchema 与 task.service 收敛。
--
-- 变更：
--   1. 删除只允许十类内置值的 ck_tasks_deliverable_types；
--   2. 保留非空数组元素校验，并新增禁止空字符串元素；
--   3. 不新增列、不回填、不改现有行；内置十类数据保持不变。
--
-- 回滚（先清理自定义值，否则恢复内置值 CHECK 会失败）：
--   alter table tasks drop constraint if exists ck_tasks_deliverable_types_no_empty;
--   alter table tasks add constraint ck_tasks_deliverable_types check (
--     deliverable_types <@ array['CAD图纸','技术协议','合同','评审单','设备清单','物料总清单','发货装箱单','到货单','安装完成证明','验收单']::text[]
--   );
alter table tasks drop constraint if exists ck_tasks_deliverable_types;
alter table tasks add constraint ck_tasks_deliverable_types_no_empty
  check (array_position(deliverable_types, ''::text) is null);
