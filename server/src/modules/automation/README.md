# automation 模块（M5-01 规则引擎内核 + M5-05 余项 · A 系列 + M5-02 前置 · 运行时求值入口 + M5-06-1A 规则表 / 运行留痕 + M5-06-1B 规则管理 / 试运行）

| 字段 | 内容 |
|---|---|
| 类型 | 平台模块（platform） |
| 职责 | 规则模型 / 求值 / 回放与留痕（M5-01 内核 + M5-05 余项）+ 运行时求值入口（M5-02 接线段前置：事件 / 调度窗口 → 应发送清单）+ 规则表读取与运行记录（M5-06-1A）+ 规则管理 / 只读试运行 / 运行记录 HTTP 读面（M5-06-1B） |
| 主责 | wmj（团队分工.md §2） |
| 对外接口 | `BUILTIN_RULES` / `BUILTIN_MESSAGE_TEMPLATES` / `findTemplate` / `RECIPIENT_TEMPLATE_OVERRIDES` / `findTemplateForRecipient` / `BUILTIN_RULE_SUBJECT_KINDS` / `subjectKindOf` / `SUBJECT_TEMPLATE_VARIABLES` / `MERGED_TEMPLATE_SPECS` / `findMergedSpec`、`evaluateCondition` / `evaluateOperator` / `evaluateRule`、`renderTemplate`、`resolveScheduleFire` / `mondayOf` / `isoWeekKey` / `dedupeKey`、`REPLAY_SUBJECT_KINDS`、`replayRules` / `cronTime` / `toTaskSubject`、`evaluateEventMessages` / `planWindowMessages` / `AUTOMATION_SCHEDULE_JOB_KIND`、`toReportMemberSubject` / `toProjectDaySubject` / `toProjectSubject` / `toTodoSubject` / `toStageSubject`、`AutomationRuleRepository` / `AutomationRunRepository`（运行时入口 · M5-02 前置；HTTP 面 = `automation.module.ts` 的 `AutomationModule.forRoot`，由 `app.module.ts` 直接装配，不新增 index 出口；A03 / `toIssueSubject` 随处理时限删除下线 · Push 215；规则读取 M5-06-1A 起改读表） |

## 本切片交付

- **当前启用集（2026-10-20）**：代码默认集仍为 R02 / R03 / R05；R06 已配置为可显式启用，部署示例 `server/.env.example` 置 `AUTOMATION_R06_ENABLED=true`。R04 / R07 / A01 / A02 / A08 / A14 的定义、模板与实现保留但 `enabled: false`，不会产出对应消息。
- **R06 触发订正（2026-10-20）**：R06 改为 `project.completed` 事件 + 项目主体；只有项目编辑保存 `status=done` 且原状态非 done 时写入事件，不再由 `task.completed` / `project.progress` 触发。

### M5-01 内核（Push 161）

- 纯函数内核（不连库、不取系统时间）：条件求值（白名单操作符）、模板逐字渲染（缺变量显性抛错）、触发窗口求值（含节假日顺延）、幂等执行键。
- 内置规则 R02 ~ R07 定义 + 逐字文案模板（R01 无通知动作，落点 = 变更生效事务内回写，见 M4-04）。
- 文案修订（2026-10-19，Push 371）：R02 ~ R07 正文统一为「项目行 + 相关人员 + 任务名加粗」。项目行 = `项目编号·项目名称`；R02 取 `task.completed` 载荷 `actorId` 显示实际点击完成账号人；R07 合并清单改为逐条项目 / 任务两行并以换行连接。
- 文案修订（2026-10-26）：所有内置自动化消息标题前增加 emoji；R05 保持单动作 + 多收件人先按用户 ID 去重，再通过 `RECIPIENT_TEMPLATE_OVERRIDES` 将项目经理渲染为 `R05_WECOM_MANAGER`，负责人版本正文不变。
- 回放器：给定规则集 + 任务数据集 + 业务日 + 日历 → 应发送清单（确定性排序、幂等去重、R07 同负责人合并）。
- 单测 31 例（`test/automation-rules.test.ts` 16 / `test/automation-replay.test.ts` 15）。

### M5-05 余项 · A 系列（Push 163）

- **主体模型**：回放不再限于任务 —— `ReplaySubject`（`kind` + `fields` + `recipients`）承载四类 → **三类主体（Push 215）**（A01 日报名册槽位 / A02 项目日报 / A14 自定义待办；A03 问题主体随处理时限删除下线）；任务经 `toTaskSubject` 映射（字段与条件口径不变，既有 31 例零改动全绿）。
- **规则 +4 → 三条（Push 215）**：A01 日报应填未填（19:30 · 按人合并 · 站内信 + 企微）、A02 日报汇总群播报（19:00 · 群机器人）、A14 自定义待办（提醒日 09:00）；**A03 问题 SLA（09:00 · T+1 提醒责任人 / T+3 升级项目经理）随处理时限删除下线**（规则两条 + 模板 4 种同批删除）。逐字模板 +9 种（`BUILTIN_MESSAGE_TEMPLATES` 8 → 17；A03 随批删 4 种 → **Push 215 后 13**；后增 R07 合并、A08 与 R05 角色模板，**2026-10-26 当前 15**）。
- **引擎扩项**：`RULE_SCHEDULE_WINDOWS` 增 `T_PLUS_3`、`RULE_RECIPIENTS` 增 `report.member`（契约随本片扩项；paths 74 / operations 95 / schemas 186 计数不变）；标题参与变量渲染；分组合并模板改按 `rule|channel` 查表；新增跳过原因 `subject_mismatch`；消息与明细带 `ruleName`。**Push 215：A03 同 code 两窗口删除（`ruleName` 字段保留）；`RULE_RECIPIENTS` 摘除 `issue.owner`；`T_PLUS_3` 窗口能力保留（调度器能力不动）**。
- **文案与金标**：`docs/rules/A01-A03-A14-扩展规则文案.md`（建议稿 + 待确认清单 + 主体字段口径表；A03 节随 Push 215 标注退役）；`test/automation-a-series.test.ts` **22 → 17 例**（三条规则逐字 + 窗口互斥 + 合并 + 幂等 + 模板一致性；A03 用例随批删除）。
- **给接线层（M5-02 ~ M5-06 · lan）的口径**：唤醒层按实体快照组主体（字段表见上述 docs/rules 文档）→ 引擎算「应发给谁 / 发什么 / 幂等键」→ 投递层负责渠道、限速、失败降级与重试；模板变量映射见 `SUBJECT_TEMPLATE_VARIABLES`（`@recipient` = 本次解析出的收件人名称）。

### M5-02 前置 · 运行时求值入口（Push 170）

应 lan PR #195 提请的「automation 运行时求值 API」（三件 + 五条口径回执，答复见 PR 评审帖）落地；接线段（事件消费 / `automation-schedule.job`）开工前置就此就绪。

- **文件**：`automation.runtime.ts`（新增）；共用内核 = `automation.replay.ts` 抽出的 `evaluateBusinessDate`（单业务日求值）+ `finalizeMessages`（sent 幂等 / 投放面去重 / 确定性排序）——回放器与运行时入口同一实现，**同一规则集 + 同一主体 + 同一业务日下输出逐字段一致**（自检用例 `test/automation-runtime.test.ts` **12 → 11 例** —— `listEnabledRules` 11 → 9 条 = R02 ~ R07 + A01 / A02 / A14，Push 215；当前启用集见本文件「本切片交付」首条 · Push 373）。
- **事件形态** `evaluateEventMessages({ topic, rules, subject, at, calendar?, eventAt?, maxEventAgeMs? })`：topic → 命中规则（event 型 + 主题相等，主体类型与 `subjectKindOf` 同源）→ 单主体求值；**冷启动保护在入口内**（`at - eventAt > maxEventAgeMs` → 逐规则 `skipped.reason = event_too_old`，不评估主体；阈值由接线层读 env 传参）。
- **调度形态** `planWindowMessages({ jobKind, window, rules, subjects, at, calendar, shiftEnabled?, shiftDirection? })`：`jobKind = automation-schedule.job`（一期白名单）；窗口半开 `(from, to]`（与 `planCatchup` 同口径）——业务日逐日求值 + `resolveScheduleFire` 触发时刻过滤（含顺延）；messages 已去重排序，落库幂等仍由 outbox `dedupe_key` 唯一约束兜底。
- **skipped 口径**：事件形态 = 与回放 `details` 跳过项一一对应（`disabled` 规则级不带实体 id）；窗口形态 = `disabled`（规则级一次）+ 窗口内**已触发但未产出**的原因（`not_matched` / `recipient_missing` / `template_missing` / `duplicate`）——`subject_mismatch`（主体类型不符）与 `window_mismatch`（本窗口不触发）为结构性 / 正常态，不入 skipped。
- **规则来源**（M5-06-1A 起）：`AutomationRuleRepository.listEnabledRules()` 读 `automation_rules`（`enabled = true and deleted_at is null`），逐行用共享 `AutomationRuleSchema` 严格解析；空表返回 `[]` 并显著告警、**不回落** `BUILTIN_RULES`；任一行非法整体抛错（fail closed）。代码常量仅作 seed / 金标。默认启用集仍为 R02 / R03 / R05；部署侧 `AUTOMATION_R06_ENABLED=true` 可在运行时强制纳入 R06（不绕过软删）。
- **主体映射器**（纯函数，输入 = 领域快照，读库在接线层；字段口径唯一来源 = `docs/rules/A01-A03-A14-扩展规则文案.md` 字段表）：`toProjectSubject`（R06，收件人 `project.group`）/ `toReportMemberSubject`（A01，收件人 `report.member`）/ `toProjectDaySubject`（A02，`project.group`）/ `toTodoSubject`（A14，`rule.members`；`entityId` 可覆盖 —— 多提醒对象按成员展开时编入成员 id，保证幂等键不串人）；`toIssueSubject`（A03）随处理时限删除下线（Push 215）。
- **契约配套**（wmj 承接 · 本切片复核）：`shared/src/modules/notifications.ts` 的 `NotifyMessagePayload` 增 `channel`（复用 `NOTIFY_CHANNELS`，**可选、缺省 inbox**）——非 inbox 值在 M5-03 落地前由投递层按确定性失败收口（dead + 告警），不得静默当站内信投递。
- **契约追加（M5-03-5-1 契约段 · Push 235 · lan 代记请 wmj 复核）**：`NOTIFY_CHANNELS` 增 **`wecom_aibot`**（企微智能机器人 · 单聊单发；`wecom_app` 保留备用通道）；R02 / R07 / A01 / A14 单聊动作渠道值 `wecom_app` → `wecom_aibot`（模板码保名 —— `R02_WECOM` / `R07_APP` / `A14_APP` / `A01_WECOM_MERGED`）；`MERGED_TEMPLATE_SPECS` 增 `A01|wecom_aibot` 键；产出层接线前按未落地渠道跳过（warn + `channelSkipped`），随 M5-03-5-4；生成物零漂移（`wecom_aibot` 不入 OpenAPI 产出面 —— 载荷 schema 先例）。

### M5-06-1A · 规则表与运行留痕（Push 268 · lan 代做 wmj 线，待 wmj 复核）

- **迁移** `0060_automation_rules_runs.sql`：`automation_rules`（code 唯一、enabled / version / trigger / conditions / actions、软删）+ `automation_runs`（rule × entity × window 求值留痕、`dedupe_key` 唯一、conditions / actions / messages 快照）+ `jobs.dedupe_key` 唯一键。
- **repository**：`automationRuleFromRow` 严格映射；`AutomationRuleRepository.listEnabledRules` 读表 / 空表不回退 / 非法行 fail closed；`AutomationRunRepository.insertIfAbsent` 先写 run、返回本次真正新建的 dedupeKey；`list` 支持 rule / status / source / topic / entity / window / 时间范围分页。
- **接线**：事件 handler 在数据库事务内读规则、读主体、写 run、写 outbox；调度 handler 在 `JobRunContext.tx` 内写 run、outbox 与窗口推进；只有新建成功的 run 才允许产出 outbox（同窗口 / 同事件重放零新增）。调度 job 按 `payload.ruleCode` 过滤；无 `ruleCode` 的旧通用 job 保留一版兼容，seed 主动将其置 done。
- **job reconcile**：`JobsStore.reconcileAutomationScheduleJob` 新建（启用 pending / 停用 done，`run_at = last_run_at = now`）、更新（只刷新 payload / cron，不重置窗口）、停用（done 保留行）、重新启用（done → pending，窗口与失败计数重置）。
- **验证**：`test/automation-repository.test.ts` / `automation-schedule-job.test.ts` / `automation-wiring.test.ts` 门禁；`scripts/m5-06-1a-replay.mjs` Docker PG18 10/10（空库迁移 + seed 二跑 + 事件 / 调度 run 重放 + legacy job + 应用角色授权）。

### M5-06-1B · 规则管理 / 只读试运行 / 运行记录（Push 271 · lan 代做 wmj 线，待 wmj 复核）

- **HTTP 面**：`AutomationController` 挂 6 个端点 —— `GET /api/v1/automation/rules`、`GET /rules/{code}`、`PATCH /rules/{code}`、`POST /rules/{code}/test`、`GET /runs`、`GET /runs/{id}`；读面 `automation.view`，写 / 试运行 `automation.manage`。`POST /rules/{code}/test` 固定 200（契约声明 200，不用 Nest 默认 201）。
- **规则读面**：只返回内置规则（R01 排除、停用保留、code 升序）；`AutomationRuleView` 附带 `editableFields`、`lastRunAt`、`nextRunAt`、`scheduleJobStatus`（job 行按 `jobs.dedupe_key = automation-schedule:<ruleCode>` 取）。
- **保存**：`version` 乐观锁；只允许 `enabled` 与 `actions.channel` / `actions.recipient` 变化，动作数量 / 顺序 / kind / template / groupBy 只读；模板 / 条件 / 动作数量冲突按 S8-4 返回 **409**（错误码沿用 `VERSION_CONFLICT`，消息体写明不可修改），非法渠道 / 收件人取值 400 `VALIDATION_FAILED`。保存事务内完成规则更新、`version + 1`、审计（`automation_rule.update`）与一规则一 job reconcile。
- **停用**：不删规则行 / job 行；job 置 `done`，规则重新启用时 job `done → pending`，`run_at = last_run_at = now`，避免补发停用前窗口。
- **试运行**：只读，不写 `automation_runs` / outbox / 审计；事件型必须给 `entityId`（task.* 读任务、stage.advanced 读项目阶段、project.completed 读项目），调度型最多评估 100 个主体并置 `truncated`；`matchedCount` = 命中求值明细数（rule × entity × window，与 `replayRules.matched` 同口径），`recipient` 只回展示值。
- **运行记录**：`AutomationRunRepository.list / count / findById`，筛选 rule / status / source / topic / entity / 时间区间，`createdAt desc, id desc` 分页；详情返回条件 / 动作 / 消息快照与错误。
- **验证**：`test/automation-service.test.ts` 18 例门禁；`scripts/m5-06-1b-replay.mjs` Docker PG18 **17/17**（规则读面 / 乐观锁 / 只读字段 409 / 非法收件人 400 / job 联动 / 审计同事务 / A08 阶段与 R06 项目完成试运行 / 试运行零副作用 / 100 主体截断 / 运行记录 / 真实管理员 HTTP 会话）；详见 `docs/M5-06-回放证据.md`。

### M5-06-3 · A14 待办主体与重复展开（Push 276 · lan；迁移请 wmj 复核）

- **迁移** `0062_todos.sql`：`todos` 落标题 / 内容 / 关联项目或任务 / 首次提醒时刻 / `repeat_rule`（none / daily / weekly / monthly）/ `repeat_until` / `reminder_user_ids` / 状态 / 完成时刻 / 乐观锁版本；逐次提醒日不预展开，由主体读取层按窗口求值。
- **主体**：`AutomationSubjectReader.loadWindow()` 追加 todo 主体；`todoOccursOn` 按 Asia/Shanghai 业务日展开，`monthly` 只在每月同日命中，短月无该日跳过；已删除提醒对象过滤，全部不可用时保留无收件人主体供引擎记 `recipient_missing`。
- **幂等键**：单对象沿用 `A14:<todoId>:<date>`；多对象逐人展开 `entityId = <todoId>:<memberId>`、幂等键 = `A14:<todoId>:<memberId>:<date>`，双渠道同键，避免串人。A14 仍 `enabled:false`。
- **验证**：`scripts/m5-06-3-replay.mjs` Docker PG18 **8/8**（daily / weekly / monthly、短月、多对象、已完成、删除对象、重复规划、outbox 唯一约束）；证据见 `docs/M5-06-回放证据.md`。

## 边界与后续

- 依赖方向：automation → calendar（`index.ts`：T±N 求值 / 顺延 / 业务日时刻）。不反向依赖业务模块。
- 已落（lan 线）：M5-06-2A / 2B 发送记录归档与重发（Push 272 / 273）；S7-4 规则接线（`RULE_EVENT_TOPICS` 事件消费 + `automation-schedule.job` handler，Push 180，落点 = outbox 接线层 `automation-subjects.ts` / `automation-wiring.ts`，引擎侧零改动）；M5-06-3 A14 待办主体与重复展开（Push 276）。`automation_rules` 落库形态已在 1A 落定（A03 同 code 两窗口场景随 Push 215 消解）；1B 管理面已在 Push 271 落定。
- A14 当前只完成待办表与提醒主体展开，规则仍 `enabled:false`；待办 CRUD / 前端入口与业务验收未在本切片内。A01「已提醒」读面归 report-issue / notify 发送归档（Push 276）。
- 合并文案：R07 / A01 的分组形态（同一收件人一条清单式消息）为先行口径（模板 `R07_APP_MERGED` / `A01_INBOX_MERGED` / `A01_WECOM_MERGED`）；R07 自 2026-10-19（Push 371）起逐条输出「项目 + 任务」两行并以换行连接，A01 仍按项目名「、」连接。
