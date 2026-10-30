# report-issue 模块（日报与问题）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 日报填报与闭环（M6-01 / M6-02）、问题三态（Push 215）与处理留痕（M6-02 / M6-03） |
| 主责 | wmj（团队分工.md §2） |
| 对外出口 | `ReportService`、`IssueService`、`ReportSummaryService`（跨模块只允许 import 本目录 `index.ts`） |
| 依赖 | identity（会话/用户）、permission（项目上下文与权限位）、admin（审计）+ calendar（工作日判定，横切出口）+ project（项目名册出口 `ProjectMemberService` —— A7-05 的应填范围）+ notify（发送归档只读 `NotifyDeliveryReadRepository` —— M5-06-3 已提醒）；不反向依赖 task / node 等其它领域模块（`shanghaiToday` 走 task 纯规则出口，无 DI） |
| 契约 | `shared/src/modules/reports.ts` / `issues.ts`（Push 215 修订：同日多条 / 关联阶段 / 归类多值 / 三态 / 附图 / 删 dueAt；**Push 243 修订：内联问题清单 `issues` / `ReportIssueDraft` / 处理人 `ownerId`**）；表口径 `0023` + 修订迁移 `0041_reports_issues_revision.sql` + **`0043_report_multi_issues.sql`（Push 243）** |

## 结构

```text
report-issue/
├── report-issue.controller.ts  ReportController（:id/reports 四路径七操作）+ IssueController（:id/issues 两路径四操作）
├── report.service.ts           日报用例：填报 / 编辑 / 提交 / 补填 + A3-09 问题生成与问题图转挂 + 成对删除
├── report-summary.service.ts   当日读用例：A7-01 当日汇总 + A7-05 应填未填（名册 × 日历 × 当日状态）
├── report.repository.ts        日报数据访问（列表 / 乐观锁 / 删除级联）
├── report-issue.links.ts       附图链（file_links）：项目内校验 / 读写 / 整体替换 / 问题图转挂 / 级联清理
├── issue.service.ts            问题用例：三态流转 / 解决方案 / 分派 / 描述与归类编辑 + 留痕
├── issue.repository.ts         问题数据访问（列表 / 详情 / 乐观锁 + issue_events）
├── report-issue.rules.ts       纯规则（状态推导 / 归类→部门 / 筛选解析 / 幂等标记）
├── report-issue.module.ts      NestJS 模块装配
└── index.ts                    唯一公开出口
```

## 接口（路径为项目嵌套 —— 契约提案 A21 的扁平路径在守卫下拿不到项目上下文，差异已登记）

| 方法 | 路径 | 权限位 | 说明 |
|---|---|---|---|
| GET | `/api/v1/projects/{id}/reports` | `report.view` | 列表（日期区间 / 状态 / 提交人 + 分页，日期倒序） |
| POST | `/api/v1/projects/{id}/reports` | `report.fill` | 新报一天（草稿写库 / 提交）；**同日多条** —— 原 409 `REPORT_ALREADY_EXISTS` 判重随 Push 215 删除 |
| GET | `/api/v1/projects/{id}/reports/summary` | `report.view` | **当日汇总（A7-01）**：只算已提交条目（草稿只计数）+ 人数合计 / 问题计数 + 工作日信息 |
| GET | `/api/v1/projects/{id}/reports/missing` | `report.view` | **应填未填（A7-05）**：名册 × 工作日历 × 当日未提交（非工作日整列为空）；M5-06-3 起附 `reminderSentAt`（仅 `sent`） |
| GET | `/api/v1/projects/{id}/reports/{reportId}` | `report.view` | 详情（A3-01 全字段 + 关联阶段 `stageKeys` / `stageNames` 同下标 + 现场 / 问题两栏附图） |
| PATCH | `/api/v1/projects/{id}/reports/{reportId}` | `report.fill` | 编辑 / 提交（乐观锁；`date` 不可改；已提交不允许退回草稿；附图整体替换 —— 已生成问题时问题图改挂问题侧） |
| DELETE | `/api/v1/projects/{id}/reports/{reportId}` | `report.fill` | **成对删除（Push 215）**：删日报 = 连它派生的全部问题 + 两侧附图链（响应回 `cascadedIssueIds`） |
| POST | `/api/v1/projects/{id}/reports/{reportId}/group-sync` | `project.update` + 项目经理 | **同步项目群（2026-10-27 / 2026-10-28 文案、统一可投递与深链修订）**：日报非草稿且项目群可投递（绑定存在且机器人已激活）；未绑定 / 未激活均 409 `REPORT_GROUP_NOT_BOUND` 并分别提示处置；202 仅表示 outbox 已受理；写 `daily_report` 审计与 `notify.group`（正文首行「日报已送达」、次行 `{项目名称}{日期}的日报记录` 纯文字 Markdown 链接，指向生产站点具体日报记录页；模板 `DAILY_REPORT_GROUP`），去重键按日报版本 |
| GET | `/api/v1/projects/{id}/issues` | `issue.view` | 列表（三态 / 多值归类（命中任一即入选）/ 任务 / 来源日报 + 关键字 + 分页） |
| GET | `/api/v1/projects/{id}/issues/{issueId}` | `issue.view` | 详情（问题 + 处理过程留痕，时间正序） |
| PATCH | `/api/v1/projects/{id}/issues/{issueId}` | `issue.manage` | 状态流转 / 解决方案 / 分派 / 描述 / 归类（Push 208 / 212 扩项）；每次**实际变化**写一条事件 |
| DELETE | `/api/v1/projects/{id}/issues/{issueId}` | `issue.manage` | **成对删除（Push 215）**：无来源日报 = 只删自己；有来源日报 = 连来源日报及其全部问题（响应回 `cascadedReportId`） |

## 口径（差异登记一并列出）

- **同步项目群（2026-10-27 / 2026-10-28 修订）**：`syncToProjectGroup` 先校验项目可写、项目经理、项目群可投递与日报非草稿，再在同一事务写审计和 outbox；**可投递统一判定 = 绑定存在且机器人已激活**，未绑定 / 已绑定未激活均返回 409 `REPORT_GROUP_NOT_BOUND`，正文分别提示绑定或激活处置。正文在入队时生成，首行「日报已送达」，次行是 `[{项目名称}{YYYY-MM-DD}的日报记录](https://pm.libiaorobot.com/#/project/{id}?view=daily&report={reportId})` 形式的 Markdown 超链接（企业微信只显示链接文字，不显示裸 URL）；基址取 `PUBLIC_APP_BASE_URL`，缺省生产站点，本地不另配域名。同版本重复点击由 `report.group-sync:{reportId}:v{version}` 去重，dead 行可由下一次点击唤醒。接口只承诺受理，不承诺企微送达。

- **同人同项目同日可多条（Push 215）**：原「一人一天一条」唯一约束 `uq_daily_reports_author_date` 与重复 409 `REPORT_ALREADY_EXISTS` 随批删除 —— 同日多条按创建时间区分；**草稿写库**（`state=draft` 落行、`submitted_at` 为空，可 PATCH 到提交 / 补填）。一期不做日报版本历史 —— 「补填保留原始提交记录」以状态 `supplement` + `submittedAt` 表达（差异登记）。
- **补填由服务端推导**：`state` 只接受 `draft` / `submitted`；提交过去日期 → `supplement`，提交当天 → `submitted`；未来日期 400（A3-04）。已提交 / 补填行不允许退回草稿。
- **A3-09 问题生成（Push 243 多条口径 · 代做 wmj 线，请 wmj 复核）**：提交时按日报携带的**内联问题清单**（`issues` 1~50 条，原文存 `daily_reports.issue_drafts`）**逐条生成**独立问题 —— 各自带入标题 / 归类多值 / 解决方案 / **处理人**（`ownerId` 显式给出时直接落 `owner_id`；缺省仍按归类取首个命中部门落 `owner_department`，全不命中 = 待分派）/ 提出人 / 来源日报 / 提出日期，**附图由 `issues[].photoFileIds` 直接挂问题侧**（`file_links(object_type=issue, kind='')`，不再依赖转挂）；每条写 `created` 事件 + 审计（`action=create`，metadata 带 `sourceReportId` / `categories` / `state` / `ownerId`）+ outbox `issue.created:<id>`；标题超 500 字截短（原文仍在日报行）。**幂等（Push 243 修订）**：`uq_issues_source_report` 唯一约束已随 0043 删除、改部分索引 `ix_issues_source_report` —— 生成前按 `source_report_id` **计数兜底**（`countBySourceReport > 0` = 已生成过，直接返回、不重复写事件与审计）。**旧路径兼容**：`foundIssue` + 归类非空且无 `issues` 时照旧生成一条，并把日报「当前问题附图」（`file_links(report, kind=issue)`）整体转挂到问题侧（Push 215 方案一口径不变）。
- **A3-12 自动分派（一期口径）**：归类为「机械部 / 采购部 / 规划部 / 项目部」时自动落 `owner_department`；其余归类（原因类）不自动分派 → `owner_department = null`（展示层「待分派」；原「未分组」随三态修订并入「未解决」）。多值归类命中任一部门名即落该部门（映射在 C9 可维护属二期，差异登记）。
- **A3-08 回写随 Push 215 停用**（「关联任务 → 关联阶段」连带）：提交日报不再回写 `tasks.note`、不写 `task_events(note_change)`；`appendTaskProgress` 与「`【日报 <日期>】`」幂等标记一并删除（真机回放 T1 反证：note 空 / note_change=0）。
- **问题三态允许回退（A3-10 · Push 215）**：`open` 未解决 / `in_progress` 处理中 / `done` 已完成（原 `unassigned` 并入 `open`；存量行与 `issue_events` 随迁移 0041 同步）；不设流转白名单，只要求每次**实际变化**写一条 `issue_events`（`state_change` / `solution` / `assignment`）；`done → 其它态` 一并清 `closed_at` / `closed_by`（`ck_issues_closed_pairs`）；关闭 = `state=done` 且写 `closed_at` / `closed_by`，审计 `action=complete`；描述 / 归类编辑走审计、不写事件（Push 208 / 212 扩项）。
- **处理时限删除（Push 215）**：`issues.due_at` 列随批删除（A3-14 / 规则 A03 两条内置规则 / ADR-026 一并作废）—— PATCH 不再接受 `dueAt`，契约与库侧 CHECK 同步移除。
- **成对删除（Push 215）**：删日报 = 删其派生问题 + 两侧 `file_links`（`issue_events` 无级联外键，按序先删）；删问题：无来源日报只删自己，有来源日报 = 连来源日报及其全部问题；重复删除 404。
- **空更新 400**：问题更新必须至少一个实际变化（防刷留痕）；日报编辑同理走契约校验（`doneWork` 等最小长度）。
- **A7-01 当日汇总（Push 162）**：`GET :id/reports/summary?date=` —— 只聚合**已提交**（`submitted` / `supplement`）条目（草稿只进 `draftCount`，不进正文、不计人数）；`headcountTotal` 未填按 0 计；`issueCount` = 「现场发现问题」非空（空白串不算）；`entries` 按 `submittedAt` 升序、同刻按作者 id 兜底；工作日信息随行（`isWorkday` / `dayKind` / `dayName`）。
- **A7-05 应填未填（Push 162；M5-06-3 增已提醒）**：`GET :id/reports/missing?date=` —— **名册即应填范围**（`project_members`，项目经理在前；顺序由名册出口保证），逐人下发 `reportId` / `state` / `submittedAt` / `reminderSentAt`；**草稿未提交仍计未填**、已提交（submitted / supplement）不进 `missingUserIds`；`missingCount = 名册 − 已提交`（工作日），**非工作日整列为空（不催报）**；名册外的人当日提交不扩大应填范围（也不因此进名单）。`reminderSentAt` 只按 `A01:<memberId>:<date>` 与 `:aibot` / `:app` 回读发送归档，仅 `last_state=sent` 取最早成功时刻，不写日报主体。
- **当日读接口共用口径（Push 162）**：`date` 缺省 = 今天（Asia/Shanghai），**未来日期 400 `VALIDATION_FAILED`**（与 A3-04 填报同口径，`details[].path = date`）；静态段 `summary` / `missing` 路由注册在 `:reportId` **之前**（Nest 按声明顺序匹配）；数据面一次 `listByDate` 取当日全量行，不落分页。
- **归档项目 409 `PROJECT_ARCHIVED`**（ADR-027）；不可见 / 跨项目 / 不存在统一 404（记录级，h6）。
- **留痕**：审计对象 `daily_report` / `issue`（字段级 changes + metadata）+ outbox `report.submitted` / `issue.created` / `issue.updated`（dedupeKey 带版本或 id）；Push 215 扩 `report.deleted` / `issue.deleted`。

## 测试与门禁

- `server/test/report-issue.test.ts`：**40 例**（2026-10-27 增 3 例：非 PM 403 / 未绑定 409 / 草稿 400 / 成功审计与 outbox 载荷和去重键；2026-10-28 增 1 例：已绑定未激活 409 且分别提示原因 / 激活处置；Push 243 增：多条生成 / 草稿携带清单 PATCH 提交 / 重新提交幂等 / 契约互斥按内容判定）（日报 20 + 问题 12 · Push 215 整文件重写）—— 日报：创建与提交 / **草稿写库** / **同日多条（无 409 判重）** / 补填推导 / 未来日期 400 / 问题生成与自动分派 / 原因类不分派 / A3-09 幂等 / **附图校验与整体替换 + 转挂** / 草稿 → 提交 / 已提交不可退回 / 编辑后缺归类 400 / 乐观锁 409 / 归档 409 / 跨项目与不存在 404 / 列表筛选 / **成对删除**；问题：状态流转事件 / 三态回退清关闭字段 / 分派 / **描述与多值归类 PATCH** / **附图整体替换** / 空更新 400 / 乐观锁 409 / 归档 409 / 404 / 详情留痕正序 / 列表同源 / **成对删除**。另 `server/test/task-remove.test.ts` 11 例覆盖删除引用守卫（Push 215 起仅 `issue_ref`；`report_ref` 随关联阶段删除）。
- `server/test/report-summary.test.ts`（**Push 162 · 14 例 → M5-06-3 · 15 例**；Push 215 注入 DatabaseService + 附图替身）：当日汇总 7（只算已提交 / 人数合计与问题计数（空白串不算）/ 提交时刻升序 + 同刻作者兜底 / 契约形态 stageKeys / stageNames 同下标 + 附图随行（Push 215）/ 缺省日期 = 今天 / 只取当日 / 未来日期 400 且不读库）+ 应填未填 8（草稿未提交仍计未填 / 逐行状态与 reportId / **A01 已提醒回读** / missingUserIds 顺序同名册 / 非工作日整列为空 / 名册为空 / 名册外提交不扩大应填范围 / 未来日期 400）—— 日历 / 名册 / 仓储 / 发送归档替身，不连库。全量：**M5-06-3 合并 main 后 83 文件 / 1288 例全绿**。
- 随 `npm test` 常跑；`check:boundaries` 覆盖跨模块 import（本模块只进口对端 `index.ts`；新增 calendar / project 两条出口依赖）。
- 真机回放（真 PG + 真 api）随 M3-06 压测 / 联调卡；M6 回放脚本已补 A7-01 / A7-05 断言（`server/scripts/m6-replay.mjs` 证据五 S0 ~ S6），由 CI `database` job 真机执行 —— **本片已执行（CI run `35946672352`）S0 ~ S6 全 PASS**。**Push 215 整文件重写脚本并本机真机重跑：57 项断言全 PASS（P / R / I / T / E / G / S / W / A 全链）—— 证据 `docs/m6-回放证据(日报与问题+工作台).md`（+ 同名 .json）**。
