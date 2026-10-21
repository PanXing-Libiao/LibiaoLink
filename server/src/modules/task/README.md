# task 模块（h4 · S6·task：任务主表 / 五态派生 + 显式覆盖 / 进度聚合 / 完成门禁 / 批量操作 / 软删 / 锁定字段例外调整 / 节点库来源与模板实例化（M3-07 刀 3））

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 任务主数据（列表 / 详情）、进度与状态写入联动（五态可写 · M3-07 刀 1）、展示五态与按时交付派生、汇总卡（最慢 / 最新阶段 + 三计数）、阶段任务统计出口、完成门禁（M3-03 · A4-20 / ADR-024）、批量操作（M3-04 · A1-08）、软删与引用守卫（M3-05 · A25）、锁定字段例外调整（M3-05 续卡 · A1-17 / C9-07） |
| 主责 | wmj（团队分工.md §2） |
| 对外接口 | TaskService（summary / list / detail / create / update / updateProgress / canComplete / complete / batch / remove / adjustLockedFields）、TaskStatsService（countStageTasks / stageTaskCounts）、规则纯函数与查询解析（task.rules / task.query）；节点实例的读写仍在 project 模块 flow.service（依赖方向 project → node → task，本模块不反向依赖） |

## 已实现（h4 · Push 89）

- 契约：`shared/src/modules/tasks.ts`（列表 / 详情 / 创建 / 编辑 / 进度五组 schema + `TaskListItem` 随行摘要）；错误码新增 `TASK_ALREADY_EXISTS`（409：节点已有未删任务）。**Push 146（lan 线代记，请 wmj 复核）**：`Task.changeRef` → `Task.changeLinks: TaskChangeLink[]`（`{ id, reason(截 40 字), appliedAt }`，A1-07「追加＋去重」可多条），`TaskListItem` / `TaskDetail` 的单条 `changeSummary` 下线（改由 `changeLinks` 承载）；落库 `tasks.change_refs uuid[]`（迁移 0020），本模块只读、不写该列。
- 规则口径（纯函数 `task.rules.ts`，来源：系统功能书 A1-06、A12 / A13 / A14（Push 70 定案）、ADR-028 时区）：
  - 展示五态**读时派生 + 显式覆盖（2026-09-24 · M3-07 刀 1）**：存储只有基础三态 `pending / active / done` + `status_override`（仅 `overdue` / `early_done` 两值）；**有覆盖且边界满足时优先取覆盖**（overdue 仅未完成生效、early_done 仅已完成生效），否则回落派生 —— `overdue` = 未完成且已过预计完成日期；`early_done` = 完成且实际完成日期早于预计完成日期；展示态本身仍不写回；
  - `applyStatusWrite`（A12 · 2026-09-24 五态）：done → 满格 + 缺省补当天完成日期（已有日期保留）+ 清覆盖；active → 至少 1 格（0 → 0.25、满格 → 0.75）并清完成日期 + 清覆盖；pending → 清进度与完成日期 + 清覆盖；**overdue（已延期）→ 保持当前格数与完成日期、只落覆盖**；**early_done（提前完成）→ 四格全亮 + 完成日期缺省当天 + 落覆盖**；
  - `applyProgressWrite`（A13）：0 → 待开始；0.25 / 0.5 / 0.75 → 进行中并清完成日期（**清除完成日期的唯一方式**）；1 → 已完成 + 完成日期（缺省当天，可显式传入）；三种结果一律**清空显式覆盖**（回到派生，与原型点进度条同结果）；
  - `deriveOnTime`（A14）：完成且实际 ≤ 预计 → true，完成但晚于预计（或未填完成日期且预计已过）→ false；未完成已过期 → false；派生不出回落存储值；
  - 日界：`shanghaiToday` 按 UTC+8 固定偏移算出后以参数进 SQL（ADR-028），不在 SQL 里拼时区表达式。
- 接口（挂 `api/v1/projects`；读登录即可，写入口径见下）：
  - `GET /{id}/summary` 汇总卡（**M3-07 刀 1 起**：`slowestStage` 最慢 = 九阶段序第一个存在未完成任务的阶段 / `latestStage` 最新 = 已动工任务（基础态 active / done）里阶段序最靠后者的所属阶段，均 `nullable`；`overdue` / `done` / `total` 三计数照旧）—— 原 `currentStage`（= `projects.stage_key`）下线；
  - `GET /{id}/tasks` 分页列表：阶段 / 负责人 / 展示态（可多值，条件下推 SQL）/ 关键字 `q` 筛选 + 排序白名单（plannedStart / plannedEnd / actualEnd / progress / title / createdAt；默认序 = 阶段序 + 组内位次 `sort_index` + id（A15 / A19 / A20 · Push 124：未分组落最后，与看板列内顺序同口径））；非法参数 400；
  - `GET /{id}/tasks/{taskId}` 详情：抽屉全字段 + 文件清单 + 负责人名与变更摘要（`fileSummaries` 聚合，免 N+1）；
  - `POST /{id}/tasks` 创建：① 从任务节点生成（来源二选一：`taskNodeId` = **项目流程节点**；`sourceNodeId` = **节点库节点（Push 183）**，同传 400 `VALIDATION_FAILED`，`sourceNodeId` 时描述 / 英文名 / 阶段取节点库现值；节点须属本项目，`stageKey` 与节点阶段不一致 400；同节点已有未删任务 409 `TASK_ALREADY_EXISTS`）；② 手工创建（**仅管理员**，系统功能书 A1-13，非管理员 403）；`stageKey` 缺省 / 显式 null = 「未分组」、`ownerIds` 缺省与**显式 `[]` 同义 = 「待分配」**（A18 / A23 · Push 136；**Push 184 修订：不再兜底项目经理**）、`sortIndex` = 插入位次（A15 / A18 / A20 · Push 124）；
  - `POST /{id}/tasks/from-template` 模板实例化（M3-07 刀 3 · A1-16 · Push 183）：`templateId` + 可选 `nodeIds`（子集，模板外节点 400）/ `skipExisting`（缺省 true → 已加过的进 `skipped`；false 遇重复 409 且**整批回滚**）/ `ownerIds` / `sortIndex` / `priority` → `{ created: Task[], skipped: { nodeId, taskId }[] }`；整批同事务、顺序 = 模板内顺序、阶段取模板阶段、位次从 `sortIndex` 起顺延；空模板 / 空 `nodeIds` 返回空数组且不 touch 项目；模板不存在或已软删 404；口径见下节「节点库来源与模板实例化」。
  - `PATCH /{id}/tasks/{taskId}` 编辑：乐观锁 `version`（不一致 409 `VERSION_CONFLICT`）+ **五态写入联动（A12 · M3-07 刀 1）**+ `ownerIds` 显式置空（不传 = 不改；传数组 = 整体替换、顺序 = 展示顺序）+ 组内重排（`sortIndex`，越界 = 组尾）+ 字段级留痕（A18 / A19 / A20 · Push 124）；输出成果文件（`deliverableTypes`）自 2026-10-08 起**常规编辑开放**（业务口径「文件输出成果也要可以选择」：传数组 = 整体替换、去重保序，显式 [] = 不要求；原「生成后锁定（A1-17）」下架 —— px 线代记，请 wmj 复核）、任务描述自 **Push 196（px 线代记，请 wmj 复核；Push 197 收窄判定）** 起仅对**未归入阶段**的临时任务（看板「添加 → 临时任务」手工创建：`stage_key` 为空且无来源节点）开放 —— **阶段任务**（`stageKey` 非空，哪怕没有来源节点）与节点 / 模板生成的任务带 `title` / `titleEn` 请求 400 `VALIDATION_FAILED`，仍走「锁定字段例外调整」；
  - `PATCH /{id}/tasks/{taskId}/progress` 进度写入：响应与列表行同形（`TaskListItem`），联动状态与完成日期；`note` 写 note_change 事件留痕；
  - `PATCH /{id}/tasks/batch` 批量操作（M3-04 · Push 150 / A1-08）：`ids`（1~100、重复去重）+ `changes` 白名单（ownerIds / status / plannedStart / plannedEnd / estimatedDays / headcount / priority / note；null = 清空、缺键 = 不改；不含描述 / 成果文件（A1-17）与 sortIndex）；逐条独立事务 + 部分失败清单 `failures[]`（复用单条写入内核 `applyUpdate`）；空 changes 400、归档项目 409；审计 = 批次一条（`project` 域，metadata 记 batchId / 计数 / 失败清单）+ 逐条字段级一条（`metadata.entry = batch` + 同批 `batchId`）；
  - `DELETE /{id}/tasks/{taskId}` 删除（M3-05 · A25 · Push 152）：软删 —— 列表 / 看板 / 甘特图 / 详情 / 完成门禁一律不可见 + 写留痕；重复删除与已删任务上的任何写操作统一 404（不新增错误码）；组内位次同事务压缩、来源节点约束随软删释放（口径见下节）。
  - `PATCH /{id}/tasks/{taskId}/locked-fields` 锁定字段例外调整（M3-05 续卡 · A1-17 / C9-07 · Push 153）：**仅系统管理员**（服务端复核，非管理员 403）；任务描述按模板生成后锁定、常规编辑不可达（输出成果文件 2026-10-08 起常规编辑开放；本端点 body 该字段保留），确需修正时**原因必填并留痕**；至少一个实际变化（空调整 400）；乐观锁 409；不写 `task_events`（四值闭集）；口径见下节「锁定字段例外调整」。
  - 归档项目写入口径 409 `PROJECT_ARCHIVED`（ADR-027）；任务变更 touch 项目 `updated_at`（ADR-022 ④）。
- 留痕与队列：`task_events` 四类型 `status_change / progress_change / date_change / note_change`（before / after 为 JSON 键值对）+ outbox 五个 topic `task.created / task.updated / task.progress_changed / task.deleted / task.locked_fields_adjusted`（dedupeKey 带版本；锁定字段调整 payload 带 `reason` 与实际变化字段）；软删与锁定字段例外调整不写 `task_events`（四值闭集）。
- 与 h3 门禁的衔接（**过渡口径收口**）：`node/gate.repository` 不再直读 `tasks` 表；阶段推进门禁的「任务全 done」与 `GET /projects/{id}/stages` 的任务计数改经 `TaskStatsService` 出口，`StageProgressRow` 不再携带任务字段，门禁语义不变；`files` 表直读仍为过渡口径（随 i1 收口）。
- 单测：`test/task-rules.test.ts`（17 例，纯规则）+ `test/task-service.test.ts`（18 例，桩仓储不连库）+ `test/task-order.test.ts`（4 例，顺序纯函数）+ `test/task-locked-fields.test.ts`（8 例，锁定字段例外调整：桩仓储 + 角色 / 门禁替身）；**Push 183 后全量 622 例 / 40 文件（任务族新增 `test/task-from-template.test.ts` 12 例：节点库来源与模板实例化）**；Push 153 后全量 387 例 / 26 文件（任务族：rules 17 / service 22 / order 4 / gate 8 / batch 9 / remove 10 / locked-fields 8）；**Push 155（M6-01 ~ M6-03 日报 / 问题）后全量 416 例 / 27 文件** —— `test/task-remove.test.ts` 10 → **12 例**（引用守卫补齐：日报 `report_ref` / 问题 `issue_ref`，与变更记录同一 409 `TASK_HAS_REFERENCES`）；**Push 196 后 `test/task-service.test.ts` 31 例**（27 → 31：临时任务改名 / 清英文名 / 节点任务与节点库来源任务 400 拦截 × 2）；**Push 197 后 32 例**（+1：阶段任务（stageKey 非空）即便没有来源节点也锁定 —— 改名 → 400），全量 **644 例 / 42 文件**；**Push 248 后 task-service 34 例（+2：输出成果文件常规编辑与去重保序），全量 793 例 / 56 文件**。

## 完成门禁（M3-03 · Push 143）

> 【暂时下线 · 2026-09-30】业务口径「暂时不要这个约束功能」：缺件不再拦截完成（单条 / 批量 / 进度 / 完成提交四条写入路径同口径），预检 `can-complete` 恒放行（`missing` 恒空）；draft 放行提示（R02）保留；节点完成 / 阶段推进 / 归档的同类门禁不随本开关。开关 = `task.service.ts` 常量 `TASK_COMPLETION_DOC_GATE_ENABLED`（恢复改回 true）；本节以下描述为门禁恢复后的口径。

> 口径来源：系统功能书 A4-20 / A2-10、ADR-024（成果文件多选与门禁）、技术设计v0.3 §3.4。

- 契约：`GET /projects/{id}/tasks/{taskId}/can-complete`（预检：`canComplete` + `missing[]` + `warnings[]`）、`POST …/complete`（提交：`{ task, warnings }`）；错误码新增 422 `TASK_REQUIRED_DOC_MISSING`（缺件）与 409 `TASK_ALREADY_DONE`（重复提交）；`Task.deliverableTypes: DocType[]`（数组、服务端去重、空数组 = 不要求）。
- 判定来源（ADR-024）：① 有节点任务按所属节点 `node_requirements` 的 `required_doc` 逐类统计（与 node 模块 `GateService.evaluateNode` 同口径）；② 无节点任务按自身 `deliverable_types` 兜底（每类 ≥ 1 份）。定档口径 = `files.status ∈ (final, changed)` 且 `current_version_id` 非空；统计范围 = 节点下 / 任务下文件（回收站不计）。
- 三入口一致（A4-20）：完成提交（`POST …/complete`）与 `PATCH …/{taskId}`（`status=done`）、`PATCH …/progress`（`progress=1`）在**事务内走同一门禁判定**；缺件一律 422 + `missing[]`（`details[].code = required_doc`）且不部分生效（乐观锁校验在前、写库在后）。
- 完成事件统一（2026-10-19）：上述入口及批量状态完成在任务**首次进入 done**（含 `early_done` 覆盖）时统一写 `task.completed`（同版本幂等键，与完成提交同载荷）；已完成后编辑其他字段不重复发。R02 因此不再依赖单一完成提交入口。
- 放行提示（A2-10 / R02）：存在未定档（draft）成果文件时放行，响应带 `warnings[{ code: draft_doc_present, docType, count }]`，并写 outbox `task.draft_doc_reminded`（R02 触发点，notify 落地后消费）。
- 留痕：拒绝 → outbox `task.gate_rejected`（事务回滚后补写）+ 审计 `result=failed`（含错误码与缺件明细）；成功 → outbox `task.completed`（payload 带 warnings）+ 审计 `action=complete`。
- 数据面：迁移 `0018_task_deliverable_types.sql`（`deliverable` text → `deliverable_types` text[] 非空默认空数组 + `ck_tasks_deliverable_types` / `ck_tasks_deliverable_types_no_null` + GIN `ix_tasks_deliverable_types`；存量单值转单元素数组、空值转空数组）；创建任务缺省从节点 `required_doc` 类型带出（body 显式给出优先）；`TaskUpdateBody` 自 2026-10-08 起含该字段（常规编辑开放：传数组 = 整体替换 / 去重保序、显式 [] = 不要求；原「生成后锁定（A1-17）」下架）；**例外调整已落 Push 153**（见下节），本字段的例外通道保留。
- 实现归属：门禁判定实现在本模块 `task.gate.repository.ts`（只读 `node_requirements` / `files`）—— node 模块 `GateService` 依赖 task（`TaskStatsService`），task 反向依赖会成环；两处 SQL 口径必须同步修改（node/README.md 已登记）。
- 单测：`test/task-gate.test.ts` 11 例（预检缺件明细 / 无节点 deliverable_types 兜底 / 完成缺件 422 + outbox + 审计 failed / 门禁通过 200 + `task.completed` / draft 放行 + R02 / 重复提交 409 / `PATCH status=done`、`status=early_done`、`progress=1` 与批量完成写完成事件 / 已完成后编辑不重复发）。

## 批量操作（M3-04 · A1-08 · Push 150）

> 口径来源：系统功能书 A1-08（批量指派 / 改状态 / 改日期 / 批量完成）；一次请求 = 同一组变更应用到 1~100 个任务。

- 端点与权限：`PATCH /projects/{id}/tasks/batch`（注册在 `PATCH …/{taskId}` 之前，否则 batch 会被当作任务 id 命中）；权限键 `task.update`（项目内成员平权）；归档项目入口 409 `PROJECT_ARCHIVED`。
- 变更白名单 `TaskBatchChanges`：`ownerIds` / `status`（基础三态，done = 批量完成，走同一完成门禁）/ `plannedStart` / `plannedEnd` / `estimatedDays` / `headcount` / `priority` / `note`；语义与单条编辑一致（null = 清空、缺键 = 不改）；不含任务描述（A1-17 生成后锁定）与 `sortIndex`（成果文件自 2026-10-08 起可走单条编辑、不在本批量白名单）（顺序是「插入位置」的逐条语义）；全空 changes 400 `VALIDATION_FAILED`。
- 执行模型：`ids` 去重后按首次出现顺序**逐条独立事务**（避免长事务与整体回滚），复用单条写入内核 `applyUpdate`（锁行 → 校验 → 状态联动 → 完成门禁 → 落库 + 事件 + outbox + touch + 审计）；响应 `{ total, succeededCount, failedCount, succeeded[], failures[] }`。
- 部分失败（条目级可预期错误降级，整体 200）：`not_found`（不存在 / 不属于该项目）/ `archived` / `gate_not_passed`（带 `missing[]`，与完成门禁同形）/ `already_done`（批量完成遇已完成条目，不重复写）/ `version_conflict` / `invalid_state`（其它 4xx）；非 AppError 照旧抛出（500）。
- 留痕双层：① **批次审计**（A1-08「批量操作整体写审计日志」）—— 每次请求一条 `project` 域记录（summary「批量操作任务：N 条（成功 X，失败 Y）」，metadata = `{ entry, batchId, taskIds, changedFields, succeededCount, failedCount, failures[] }`）；② **逐条字段级审计**（C7-02）—— `action=update`，summary 前缀「批量修改任务：」，`metadata.entry = batch` + 同批 `batchId`；批量完成缺件的拒绝留痕沿用 outbox `task.gate_rejected` + 审计 `result=failed`（summary 前缀「批量任务完成被门禁拒绝：」+ 同批 metadata）。
- 单测：`test/task-batch.test.ts` 9 例（批量改字段 + 审计同 batchId / 部分失败 not_found / ids 去重 / 空 changes 400 / 归档 409 / 批量指派置空 / 批量完成 / 缺件 gate_not_passed + 留痕 / already_done）。

## 软删（M3-05 · A25 · Push 152）

> 口径来源：系统功能书【修订 2026-09-22，Push 148】业务确认「任务删除要做」+ `前端功能需求.md` §3.8 A25；记录级 404 语义随 h6 策略服务。

- 端点与权限：`DELETE /projects/{id}/tasks/{taskId}`（权限键 `task.update` —— 与编辑同一权限位，不新增权限键，`PROJECT_MEMBER_IMPLIED_KEYS` 已含该键）；响应 `TaskDeleteResponse = { id, deleted: true }`（只回标记，前端列表本地移除即可）；项目侧照旧先过 `loadProjectForWrite`（归档 409 `PROJECT_ARCHIVED`）。
- 软删而非物理删：置 `tasks.deleted_at` / `deleted_by`（迁移 `0022_task_soft_delete.sql`，照 0009 projects / 0019 stakeholders 口径），行与留痕保留；**统一 404、不新增错误码** —— 重复删除、已删任务上的编辑 / 进度 / 完成提交 / 预检、跨项目与不存在一律 404 `NOT_FOUND`（记录级 404 语义）。
- 引用守卫（系统功能书 A2-01「已产生日报 / 问题 / 变更的任务不允许删除，只能关闭或标记」）：`change_refs` 非空 → 409 `TASK_HAS_REFERENCES`（`details[].code = change_ref` + `changeRequestId`），不软删 / 不压缩位次 / 不写留痕；日报 / 问题两表随 M5 落地后在守卫处一并加判定（照「节点下已有文件 → 409 `NODE_HAS_FILES`」同一先例）。
- 读面不可见：列表 / 详情 / summary 四格 / 阶段计数 / 看板与甘特图（与列表同源）/ 完成门禁预检与提交 / 节点判重 / 组内顺序读 / 锁行一律过滤 `deleted_at is null`；新增部分索引 `ix_tasks_active_group (project_id, stage_key, sort_index) where deleted_at is null`（列表与看板顺序读走它）。
- 组内位次压缩（A19 / A20 不变式）：删除后同组后续任务位次同事务 -1，保持「0 起、密集」；只写位次列，不 bump `version` / `updated_at`（与插入 / 移动同口径）。
- 节点释放（A10 / A11）：判重走 `findTaskIdByNode`（只看未删行），软删后同一节点可重新创建任务；`tasks` 本无 `(project_id, node_id)` 唯一约束，无需改约束。
- 留痕：审计 `action=delete`（`objectType=task`，summary「删除任务：<标题>」，changes = 删除前快照，metadata `{ softDelete: true, stageKey, nodeId }`）+ outbox `task.deleted`（dedupeKey = `task.deleted:{taskId}:{version}`，payload = projectId / taskId / stageKey / nodeId / actorId / at）+ touch 项目 `updated_at`；**不写 `task_events`**（其类型为四值闭集：status_change / date_change / progress_change / note_change，删除不属于字段级变更）。
- 单测：`test/task-remove.test.ts` 10 例（软删置位 + 审计快照 / 位次压缩 / outbox task.deleted / 重复删除 404 / 不存在与跨项目 404 + 并发兜底 / 归档 409 / 已删任务写路径全 404 / can-complete 404 / 节点释放可重建 / 位次仍 0 起密集 / **已有变更关联 409 `TASK_HAS_REFERENCES`（不软删 / 不变位次 / 不写留痕）** / 无关联照常软删）。

## 锁定字段例外调整（M3-05 续卡 · A1-17 / C9-07 · Push 153）

> 口径来源：系统功能书 A1-17（任务描述 / 阶段性里程 / 输出成果文件按流程节点模板生成后锁定；确需修正时由管理员修正模板 + 对当期任务例外调整，原因必填并留痕）与 C9-07；设计口径见 技术设计v0.3 §3.4（M3-05）。

- 端点与权限：`PATCH /projects/{id}/tasks/{taskId}/locked-fields`（body `TaskLockedFieldsAdjustBody` = `version` + `reason` + 可选 `title` / `titleEn` / `deliverableTypes`）；控制器 `@RequirePermission(task.update)` 只作项目上下文门禁，**服务端 `assertAdmin` 复核（仅系统管理员，非管理员 403）** —— 与手工创建任务同口径（A1-13）。
- 锁定范围：`title`（任务描述）/ `titleEn`；`deliverableTypes` 2026-10-08 起常规编辑开放（常规 `PATCH …/{taskId}` 可带、去重保序；本端点 body 该字段保留 —— 例外修正通道不动）；本端点与批量 `PATCH …/batch` 均不含这三项（**Push 196 例外 / Push 197 收窄**：仅**未归入阶段**的临时任务（`stage_key` 为空且无来源节点）可在常规编辑 `PATCH …/{taskId}` 里直接改 `title` / `titleEn` —— 面向的是「手工输入、非模板生成、也未挂施工阶段」的任务；**阶段任务**（`stageKey` 非空）与节点 / 模板生成的任务保持锁定）；**「阶段性里程」一期 tasks 表无对应列**（A1-17 映射修订），本期不开放（差异登记见本 README 边界段与系统功能书）。
- 校验：至少一个实际变化（同值 / 空调整 → 400 `VALIDATION_FAILED`，防止刷留痕）；`deliverableTypes` 走 `normalizeDocTypes`（字典内、首次出现去重保序）；乐观锁 409 `VERSION_CONFLICT`；归档项目 409 `PROJECT_ARCHIVED`；不存在 / 跨项目 / 已软删统一 404。
- 留痕（A1-17 / C9-07）：审计 `action=update`（changes = 锁定字段 before → after；metadata = { reason, kind: locked_field_exception, adminOnly: true, fields }）+ outbox `task.locked_fields_adjusted`（dedupeKey = `task.locked_fields_adjusted:{taskId}:{version}`，payload = projectId / taskId / fields / reason / actorId / at）+ touch 项目 `updated_at`；**不写 `task_events`**（四值闭集）。
- 门禁联动：`deliverableTypes` 修正后即刻成为**无节点任务**的完成门禁依据（有节点任务仍以节点 `node_requirements` 为准，ADR-024）。
- 单测：`test/task-locked-fields.test.ts` 8 例（管理员改 title + deliverableTypes → 落库 / 版本 +1 / 审计含原因 / outbox / touch / 不写 task_events / 非管理员 403 且无留痕 / 空调整 400 / 乐观锁 409 / 归档 409 / 不存在与跨项目与已软删 404 / 去重与非法值过滤 + 门禁联动 / titleEn 清空）。

## 五态写入与汇总卡（M3-07 刀 1 · Push 179 · 2026-09-24 业务定案）

> 业务口径：「状态下拉都要有 要5态 但是他们的逻辑要和之前的一样」/「（`currentStage` 保持 = 项目当前阶段）有了最快最慢这个就不需要了」；按授权替 wmj 线落地，跨线请 wmj 复核。

- **写面**：契约新增 `TaskStatusWrite`（`pending` / `active` / `done` / `overdue` / `early_done`），替换 `TaskUpdateBody.status` 与 `TaskBatchChanges.status` 的实现类型；服务端 `applyStatusWrite` 五态分支（overdue = 保持格数与完成日期、只落 `status_override`；early_done = 四格全亮 + 完成日期缺省当天 + 覆盖），`applyProgressWrite` 与 `done / active / pending` 一律清覆盖。
- **读面**：`deriveDisplayStatus` 先判覆盖（边界：overdue 仅未完成、early_done 仅已完成）再走原派生；`displayStatusExpression`（SQL CASE）与规则函数**严格同形** —— `filter[status]` 下推与读时派生必须同批修改，改一处即改两处（`task.query.ts` 的解析注释同步）。
- **汇总卡**：`summary()` 由 `taskCountsByStage` 聚合（`stage_key is null` 的「未分组」不参与阶段判定、只进三计数）；`slowestStage` = `STAGE_KEYS.find(存在未完成)`、`latestStage` = 反序 `find(已动工)`；`currentStage` 字段从契约删除（`projects.stage_key` 本身仍供阶段推进，不再出现在汇总卡）。
- **留痕**：`buildEvents` 的 `status_change` 负载补 `statusOverride`（只记本次变化的键）—— 基础态不变、只切覆盖时同样有事件；`taskAuditSnapshot` 同样带该字段。
- **迁移**：`database/migrations/0031_task_status_override_and_priority_three_levels.sql`（`tasks.status_override` + CHECK + 存量 `priority` 折算三档，无其他 DDL）。
- **验证**：`test/task-rules.test.ts` / `test/task-service.test.ts` 新增五态与两阶段用例；真机回放 `server/scripts/m3-07-replay.mjs` 24 项断言全过（证据 `docs/m3-07-回放证据(五态与汇总卡).md`：覆盖写入与清空、覆盖来源筛选命中、两阶段与两个 null 边界、四象限值 400、事件负载、批量五态、零残留）。
## 落库口径（w2 · A15 / A18 / A19 / A20 · Push 124）

> 口径来源：`前端功能需求.md` 附录 A15 / A18 / A19 / A20（Push 119 / 120 定案）与 `字段对照清单.md` §七；落库机制二选一定为 **① `tasks.sort_index` 位次列**（不新增批量排序接口）。

- 顺序（A19 / A20）：一组 = 同一项目 + 同一阶段（`stage_key` 为空 = 「未分组」，自成一组）；组内位次 0 起、密集。创建带 `sortIndex` = 插入位次、编辑带 `sortIndex` = 移到组内第 N 位（两者越界 / 缺省都落组尾），同组其余任务顺延 —— 只写位次列、不逐个 bump `version` / `updated_at`，并发靠组行锁（`select … for update` 锁整组后再锁任务行）。
- 阶段可空（A15）：创建不传 / 显式 null = 「未分组」；带 `taskNodeId` 时缺省取节点所属阶段、显式不一致 400。默认读序 = **阶段序（`STAGE_KEYS` 序，未分组落最后）+ `sort_index` + id**（A8 原「阶段序 + `planned_start` + `created_at` + id」由本条取代）；阶段完成度（`GET /projects/{id}/stages`）与阶段门禁**只统计带阶段任务**。
- 负责人可多位 / 可空（A18 / A23 · Push 136）：创建缺省（不传）与显式 `[]` 同义 = 「待分配」（**Push 184 修订**：不再兜底项目经理）；编辑不传 = 不改、显式 `[]` = 置空、传数组 = 整体替换（顺序 = 展示顺序）；`Task.ownerIds` 为 uuid[]（空数组 = 待分配）、`TaskListItem.ownerNames` 为同下标姓名数组。筛选 `filter[ownerId]` = 任一位负责人命中即命中。
- 数据面与契约：迁移 `0015_task_order_and_nullable_scope.sql`（回填按迁移前默认读序 → 迁移前后读序一致；`ck_tasks_sort_index` + `ix_tasks_project_stage_order`）与 `0017_multi_manager_and_owner.sql`（`owner_id` → `owner_ids` uuid[] + `ck_tasks_owner_ids_no_null` + `ix_tasks_owner_ids` GIN；回填空数组 / `array[owner_id]`）、Drizzle `src/db/schema/tasks.ts`、契约 `shared/src/modules/tasks.ts` 三处同步（`check:db-schema`：27 表 / 265 列 / 78 索引 / 77 CHECK · Push 143 后）；outbox topic 与 `task_events` 类型不变，`sortIndex` / `ownerIds` 进审计快照（C7-02 字段级留痕）。
- 真机回放：`server/scripts/w2-replay.mjs`（真 PG + 真 api :3011，33 项断言，退出码即门禁）；证据入 `docs/w2-回放证据(任务落库口径A15A18A19).md`。

## 节点库来源与模板实例化（M3-07 刀 3 · A1-16 / A1-17 · Push 183）

- 落库：迁移 `0034_task_source_node.sql` —— `tasks.task_node_id uuid references task_nodes (id) on delete set null`（**节点库来源**）+ 部分唯一索引 `uq_tasks_active_source_node on tasks (project_id, task_node_id) where deleted_at is null and task_node_id is not null`。与 `tasks.node_id`（**项目流程节点** `project_nodes`）**并存互不替代**：一个说「这条任务从项目流程的哪个节点来」，一个说「从节点库的哪个节点来」。
- 逐条来源（`create()` 带 `sourceNodeId`）：任务描述 / 英文名 / 阶段取**节点库现值**（A1-17 锁定字段）；缺省负责人 = 「待分配」空数组（Push 184 修订）；`sourceNodeId` 与 `taskNodeId` 二选一（同传 400）、节点不存在 / 与 `stageKey` 不一致 400、**同一项目同一节点重复 409 `TASK_ALREADY_EXISTS`**；审计 `metadata = { sourceNodeId, source: "task_node" }`、outbox `task.created` 与逐条路径同形。
- 模板实例化（`createFromTemplate()` · `POST /projects/{id}/tasks/from-template`）：`templateId` + 可选 `nodeIds` / `skipExisting`（缺省 true）/ `ownerIds` / `sortIndex` / `priority` → `{ created: Task[], skipped: { nodeId, taskId }[] }`。**整批同事务**（撞到任何一条冲突都整批回滚 —— 真机回放 B9 用「n1 在前会插入、n2 已存在」验住）、顺序 = 模板内顺序、位次从 `sortIndex` 起依次落位（同组其余顺延）、阶段取模板阶段、`ownerIds` 缺省 = 项目经理；`nodeIds` 子集校验（模板外节点 400）；空模板 / 空 `nodeIds` 返回空数组且**不 touch 项目**（不写 outbox、不推 `updated_at`）。
- 判重粒度 =（项目 × 节点库节点）且**只约束未删行**：软删该任务后同一节点回到「可添加」（再实例化时进 `created`）；节点在节点库被物理删 → `task_node_id` 置 null、**任务保留**（`on delete set null`）。
- 读面：列表与详情下发 `sourceNodeId`（= `tasks.task_node_id`，可空）。
- 真机回放：`server/scripts/m3-07-replay-from-template.mjs`（真 PG + 真 api :3001，47 项断言，退出码即门禁）；证据入 `docs/m3-07-回放证据(添加任务模板化).md`（前端侧 `frontend/scripts/m3-07-from-template-e2e.mjs` · 21 项 · 证据 `docs/m3-07-回放证据(添加任务模板化·前端).md`）。

## 任务定档（Push 249 · A2-10 / A4-05 修订）

- 字段：`tasks.finalized_at timestamptz` / `tasks.finalized_by uuid → users(id)`（迁移 `0044_task_finalize.sql`；成对 CHECK `ck_tasks_finalized_pair`：同 null 或同非 null）—— **任务侧定档两个入口（Push 252）**：① **显式入口** `POST /api/v1/projects/{id}/tasks/{taskId}/finalize`（`TaskFinalizeBodySchema` = `{ version }`；乐观锁，已定档重复提交幂等短路、不写库不审计；outbox `task.finalized`）—— 抽屉头部「定档」开关走它；② **随文件定档**：`file.service.finalizeFile` 在同一事务内 `repository.markTaskFinalized`，`isNull` 幂等置位 + `version + 1`，并写一条 `object_type=task` 审计「任务定档（随文件定档：…）」）。两个入口定档时均**同事务撤销该任务在途的 version 上传会话**（`abortActiveTaskUploadSessions`：只撤 version、不撤 change，条数进审计 metadata）。
- 写口闸 `assertTaskMutable`：任务已定档（`finalized_at` 非空）时 **409 `TASK_FINALIZED`**（新错误码；details `code: task_finalized` / `path: finalizedAt`）—— 覆盖 `applyUpdate`（编辑 / 批量：批量失败码映射 `TASK_FINALIZED → finalized`）、`remove`、`adjustLockedFields`、`updateProgress`、`complete`。
- 读面：`toTaskView` 下发 `finalizedAt`（ISO）/ `finalizedBy`；`TaskListItem` 经 spread 同口径（前端 `ProjectTask.finalizedAt` 据此出「已定档」提示与入口闸）。
- 唯一保留的修改通道 = 对已定档文件的变更（A4-13 申请即通过，`intent=change`）。
- 防绕过补漏（定档时）：`file.service.completeUpload` 事务内复核任务定档（会话先发起、任务后被定档 → 409 `TASK_FINALIZED`，change 意图放行）；漏网会话（如并发发起）由该复核兜住。
- 单测：`test/task-service.test.ts`（「任务定档写口闸」4 例 + `finalize` 撤销会话 / 审计 metadata 断言）+ `task-remove` / `task-locked-fields` 各 1 例；其余 task 测试夹具补 `finalizedAt: null, finalizedBy: null`。

## 边界与后续（差异登记）

- 已随 h6 落地：读路由记录级 404（不可见项目 / 跨项目任务统一 404）、写路由功能权限位（`task.create` / `task.update` / `task.progress` —— 项目内成员对这三项平权，见 `modules/permission/README.md`）；手工创建仅管理员的口径随 A1-13 复核；
- M3-07 刀 1 后半（前端接线）不在本模块：前端 `taskApi.ts` 接线与服务端零改动；刀 2（门禁三入口 / 批量 failures 消费）已随 M3-03 / M3-04 落地，**刀 3（添加任务模板化）已落 Push 183**；只剩快筛参数待后续切片。
- 不在本卡（Push 152 后更新）：列表快捷筛选参数、门禁增强 M3-04 ~ M3-06（**M3-03 已落 Push 143**：`deliverableTypes` 多值 + 完成门禁；**M3-04 批量操作已落 Push 150**：批量指派 / 改状态 / 改期 / 批量完成 + 部分失败清单；**M3-05 软删已落 Push 152**：`DELETE …/tasks/{taskId}` + 统一 404 + 位次压缩；**锁定字段例外调整已落 Push 153**：仅管理员可执行（非管理员 403）/ 原因必填并留痕（审计 + outbox）/ 空调整 400 / 阶段性里程一期无列；模板实例化与快筛随 M3-05 其余切片、1 万行压测随 M3-06）；
- A1-17 差异登记（Push 153）：系统功能书锁定字段含「阶段性里程」，一期 `tasks` 表无该列（A1-17 映射修订），本期只开放任务描述 / 英文描述 / 输出成果文件三项；里程碑列落地后再开；
- 列表默认序已有 `ix_tasks_project_stage_order (project_id, stage_key, sort_index)` 复合索引（0015 · Push 124）；1 万行压测与索引调优仍随压测卡 M3-06；
- 契约里进度档位为离散五档，迁移数据任意小数在读时四舍五入到最近档。
