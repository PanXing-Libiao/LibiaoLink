# dashboard 模块（平台 · B4 / M7-02）

| 字段 | 内容 |
|---|---|
| 类型 | 平台模块（platform） |
| 职责 | 跨项目统计读面（仪表盘 B4）：项目进度 / 任务状态 / 交付时间 / 问题分布 / 变更原因词频 |
| 主责 | lan（团队分工.md §2） |
| 对外接口 | DashboardService / DashboardModule |

- 状态：已落地（2026-10-21，前端逐项目聚合收口到服务端）。
- HTTP：`GET /api/v1/dashboard/progress`（首屏任务聚合）、`GET /api/v1/dashboard/issues`、`GET /api/v1/dashboard/change-words`；均仅会话守卫，按 `PermissionService.projectScope` 裁剪可见项目。
- 口径：项目 = 未回收、归档仍计入、默认排序 `created_at desc, seq_no asc`；任务 = 未软删；展示态 / 按时交付与 `task.rules` 同形（平台模块不 import 任务领域模块，SQL 为独立副本并由回归测试守口径）；问题按三态 × 多归类计数；词频沿用 B4 已确认的核心词最长匹配。
- 明细：聚合响应只含 `all` 与 `byProject`，不夹带任务 / 问题 / 变更大列表；前端点击图表后按选中项目复用既有项目读面，并按“聚合版本 + 项目 + 资源类型”缓存。
- 结构：controller / service / repository + 纯规则 `dashboard.rules.ts`；跨模块只 import 对端 `index.ts`（`npm run check:boundaries`）。
- 验证：`server/test/dashboard.test.ts` 覆盖规则、可见性、空项目、问题、词频与 task 口径同形；无数据库迁移。
