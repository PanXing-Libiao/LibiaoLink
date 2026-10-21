# workspace 模块（M6-05 · 工作台聚合读面 · A6-01 / A6-03 · Push 166 落地 · 2026-09-30 口径复评）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain · 已登记 check-boundaries 的 DOMAIN_MODULES） |
| 职责 | 工作台聚合读面：我的任务四组（今日待办 / 即将到期 / 已逾期 / 未排期）+ 我的问题两栏（我处理 / 我提出的） |
| 主责 | wmj（团队分工 §2） |
| 对外接口 | `WorkspaceService`（`index.ts` 出口） |

## 本切片交付（第一刀 · Push 166 · 历史记录，口径以复评段为准）

- **契约**：`shared/src/modules/workspace.ts`（Push 166 版：`myTasks` 三组 + `myIssues` 两栏）；`shared/src/openapi.ts` 新增 `GET /api/v1/workspace`（tags = workspace）；生成物重出 —— paths 75 → 76、operations 98 → 99、schemas 189 → 194。
- **读（无新表、无迁移）**：跨项目个人读面，无项目路径参数；仅会话（`SessionGuard`），不做功能权限位 —— 数据按记录级可见性过滤（`PermissionService.projectScope`，ADR-011）。
- **分组口径（Push 166 版）**：任务 = 负责人含我（A23 多值任一位命中）且未完成、未删除；基准日 = Asia/Shanghai 今天（ADR-028）：已逾期 / 今日待办 / 即将到期（今天 + 7 天内，建议值）；未排期（plannedEnd 空）与 7 天外不进工作台；归档项目（ADR-027 冻结）与软删项目不进。
- **排序**：任务组内 plannedEnd 升序 → id 升序；问题未关闭在前 —— `raisedAt`（提出日期）升序 → id 升序（Push 215：原「处理时限升序（无时限最后）」档随 `due_at` 删除下线）。
- **只读边界**：本模块不改任何表（跨模块写路径仍归各领域模块）；负责人姓名聚合 SQL 与 task 模块同源（只读副本）。
- **测试**：`server/test/workspace.test.ts`（纯函数 + 服务替身）；真机回放见 `server/scripts/m6-replay.mjs` 证据六（CI database job 执行）；**Push 215 本机真机重跑 57 项全 PASS（含 W0 ~ W7）—— 证据 `docs/m6-回放证据(日报与问题+工作台).md`**。

## 2026-09-30 口径复评（业务：不限窗口 + 项目经理含我 + 未排期单列）

- **背景**：业务反馈「明明有四个 为什么只显示了两个」——旧口径把「预计完成日期超出今天 + 7 天」与「未排期」两类任务默默丢弃。
- **新口径**：我的任务 = 任务未完成、未删除、项目未归档未软删，且满足其一：① 任务负责人含我（原口径保留）；② 任务所属项目 `projects.manager_ids` 含我（项目经理）。**不再设 plannedEnd 天数窗口**；分组：plannedEnd < 今天 → overdue、= 今天 → today、> 今天 → upcoming（远期照收）、空 → unscheduled（新组，组内排末 —— 排序 plannedEnd asc nulls last → id asc）。
- **契约**：`WORKSPACE_TASK_GROUPS` 三组 → 四组（`today / upcoming / overdue / unscheduled`，删 `WORKSPACE_UPCOMING_DAYS`）；`WorkspaceTasksSchema` 增 `unscheduled`；`WorkspaceTaskItem.ownerIds` 注明「项目经理口径命中的行可能不含会话用户」。生成物重出、零漂移。
- **前端**：`frontend/src/WorkspacePage.tsx` 四组展示（组序 overdue → today → upcoming → unscheduled；未排期灰签；面板摘要与总数含未排期）；`frontend/src/workspaceApi.ts` 类型同步（px 线）。
- **测试**：`server/test/workspace.test.ts` 改为四组落位 + 「+365 仍 upcoming」+ 未排期落组；`server/scripts/m6-replay.mjs` W0 ~ W7 按新口径重写（原 W4「待分配不进」反例失效：靶子项目项目经理即 admin，清空负责人后按新口径仍命中）。
- **归属与路由**：契约（`shared/`）+ 服务端（`server/src/modules/workspace/`）属 wmj 线；前端属 px 线 —— 合并与评审按 `团队分工.md` / `.github/CODEOWNERS` 路由（改动不直接落他人常驻分支）。
- **差异登记（更新）**：①「我参与的任务」口径未定（A6-01 原文「我负责 / 我参与」，仍只做我负责 + 项目经理）；② **关闭** —— 「即将到期 7 天窗口」随本次复评下线；③「我的问题」含已完成（后置排序）维持；④ A6-04 / A6-07 随 M5-07（lan）、A6-02 一期不启用（C8）、A6-06 纯前端；⑤ 新增 —— 项目经理口径命中的任务可能不含「我」在负责人名单（任务表「任务负责人」列会显示别人，属预期）。

## 2026-10-13 全字段修订（Push 302 · px 线代改 wmj 线契约，请 wmj / lan 复核）

- **背景**：工作台「我的任务」页刷新卡顿、字段与 UI 分批出现 —— 根因是聚合读面只带 9 列，前端须逐项目回打 `GET /projects/{id}/tasks`（limit 200）+ `GET /projects/{id}` + 问题源接口三路补齐。
- **契约**：`WorkspaceTaskItem` = `TaskListItem` 全字段 + `projectCode` / `projectName` + `files`（`TaskFileBrief[]`，排除回收站、创建时间倒序）；`WorkspaceIssueItem` 补 `solution` / `photos`（`FilePhotoRef[]`，插入序）；`WorkspaceResponse` 新增 `projects`（聚合涉及项目卡，按任务组 → 问题栏首次出现去重，含 `managerIds` / `managerNames` / `version`）。生成物重出、零漂移（paths 95 / schemas 261）。
- **服务端读面**：任务行取全 15 列数据源（`ownerNames` / `fileSummary` / `changeLinks` / 随行 `files` / `estimatedDays` / `headcount` / `deliverableTypes` / `note` / `finalizedAt` / `finalizedBy` / `version` 等）；问题行取 `solution` / `photos`；项目卡随盘下发。SQL 块（负责人 / 项目经理 / 变更关联）与 task / project 线同源切片复用；仍只读、无新表、无迁移。
- **测试**：`server/test/workspace.test.ts` 13 例（全字段随行 / onTime 派生 / projects 去重 / solution + photos）；`server/scripts/m6-replay.mjs` 新增 W6b 全字段随行断言（本机无 DB，未重跑 —— 登记）。
- **前端**：`WorkspacePage.tsx` 删除 `useTaskFull` / `useIssueFull` / `fallbackTaskOf` 与逐项目回填，点行开抽屉零请求（px 线）。
- **差异登记（更新）**：新增 ⑥ —— 工作台读面载荷变大（任务行全字段 + 随行 files），一期不分页（载荷评估随项目任务量级再定）。
