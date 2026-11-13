/**
 * 项目阶段列表（「项目总览」+ 九个施工阶段）：任务表 / 两块看板 / 甘特图 / 模板页共用同一份顺序。
 * 阶段是契约枚举（shared/src/common/dicts.ts 的 STAGE_KEYS），不走字典接口。
 * 首页演示数据（原 INITIAL_PROJECTS）已随 M2-07 下线 —— 项目数据来自 GET /api/v1/projects。
 */
export const PROJECT_STAGES = [
  "项目总览",
  "售前规划",
  "设计开发",
  "加工采购",
  "组装发货",
  "硬件实施",
  "软件部署",
  "试运行",
  "投产阶段",
  "验收",
] as const;
