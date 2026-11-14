# template 模块（M3-05 余 · 任务节点库 + 任务模板 · A1-16 / A1-17 · Push 181 / 182）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 公共任务节点库（`task_nodes.owner_template_id is null`）列表 / 新增 / 编辑 / 删除；模板私有节点（`owner_template_id` 非空）按模板新增 / 清理；任务模板（`task_templates` / `task_template_nodes`）列表 / 详情 / 新建 / 编辑（`nodeIds` 全量替换）/ 软删 |
| 主责 | wmj（团队分工.md §2；本切为 px 按授权代做，请 wmj 复核） |
| 对外接口 | `TemplateService` / `TaskNodeRepository` / `TaskNodeRequestService`（导入模块同事务调用 `createFromImport`）/ `TaskTemplateRepository`（`index.ts` 出口） |

## 本切片交付（第一段 · Push 181）

- **契约**：`shared/src/modules/templates.ts` —— `TaskNodeSchema` / `TaskNodeListQuerySchema` / `TaskNodeCreateBodySchema` / `TaskNodeUpdateBodySchema` / `TaskNodeDeleteResponseSchema`；`shared/src/openapi.ts` 新增 `POST /api/v1/task-nodes`、`PATCH /api/v1/task-nodes/{id}`、`DELETE /api/v1/task-nodes/{id}`。
- **数据**：迁移 `database/migrations/0032_task_nodes.sql`（`task_nodes`：九阶段 CHECK / `seq` 正数 / 同阶段同名唯一 `uq_task_nodes_stage_title` / 读序索引 `ix_task_nodes_stage_seq`）+ 种子 #8（九阶段 52 条）。
- **读**：`GET /api/v1/task-nodes?stage=`（系统管理员、有项目数据范围，或至少一个有效项目关系（项目经理 / 项目成员 / 任务负责人）；限制关闭时放行；无任何关系且适用规则均为 none 403；缺省全部阶段）—— 排序 = 九阶段顺序 → `seq` → `id`；`total` 与 `items` 同步。
- **公共节点写**（服务层 `assertCanManageTaskNodes` 复核：仅系统管理员；项目经理、部门编辑范围、普通成员、任务负责人均不授予；其余 403 `FORBIDDEN`。模板私有节点另按单模板编辑权，不受本闸影响）：
  - `POST /api/v1/task-nodes`：`title` trim 后落库、`titleEn` 空串 → null；同阶段同名 409 `NODE_ALREADY_EXISTS`（不落库不留痕）；缺省 `seq` = 该阶段末位 + 10；
  - `PATCH /api/v1/task-nodes/{id}`：只改传入字段（`titleEn` 传 null / 空串 = 清空）；`version` 必传 —— 过期 409 `VERSION_CONFLICT`；改名撞同阶段已有名 409 `NODE_ALREADY_EXISTS`（排除自身）；不存在 404 `NOT_FOUND`；
  - `DELETE /api/v1/task-nodes/{id}`：**物理删行**（与字典条目硬删同口径），删除前快照进审计 `changes`；已按该节点生成的项目任务不受影响（任务侧无外键）。
- **留痕**：每条写操作一条审计（`objectType` = `task_node`；`summary` 带阶段中文名与节点名；`metadata` 记 `stageKey` / `seq`），与业务写入**同一事务**；**不写 outbox**（与字典维护同口径）。
- **边界**：不碰 `tasks` / `project_nodes` —— `tasks.node_id` 指向流程节点（`project_nodes`），节点库只回答「任务从哪来」；前端接线见 `frontend/src/templateApi.ts` 与 `PlaceholderPage.tsx`（左列「任务节点」：新增 / 编辑 / 删除 + 按板块缓存重取）。

## 本切片交付（第二段 · Push 182：任务模板落库）

- **契约**：`shared/src/modules/templates.ts` 模板侧别名（`TaskTemplate` / `TaskTemplateNode` / `TaskTemplateListQuery` / `TaskTemplateListResponse` / `TaskTemplateCreateBody` / `TaskTemplateUpdateBody` / `TaskTemplateDeleteBody` / `TaskTemplateDeleteResponse`）；`AUDIT_OBJECT_TYPES` 增 `task_template`。
- **数据**：迁移 `database/migrations/0033_task_templates.sql`（`task_templates` + `task_template_nodes`）+ 0094 增模板私有节点（`task_nodes.owner_template_id`；公共 / 私有分别按部分唯一索引判重）+ 种子 #9（九阶段 10 套，节点按「同阶段 + 同名」解析节点库 id）；0071 增 `task_templates.created_by`（`users.id`）与局部索引，存量 / 种子为空；0092 增 `task_templates.visibility`（`private` / `public`，非空 + CHECK，存量 / 种子默认 `public`）。
- **读**：`GET /api/v1/task-templates?stage=`（系统管理员、有项目数据范围，或至少一个有效项目关系（项目经理 / 项目成员 / 任务负责人）；限制关闭时放行；无关系且无数据范围 403；缺省全部阶段）—— 读序 = 九阶段顺序 → **`created_at` 倒序** → id（最新在最左，与「＋ 新建模板」插到最左一致；种子按清单顺序倒排 `created_at`，业务清单第一套仍在最左）、`total` 与 `items` 同步；`GET /api/v1/task-templates/{id}`（不存在 / 已软删 404）。节点标题 / 英文名**不落模板表**：读面 join `task_nodes` 实时取（节点改名后模板预览随即更新）；模板行另 left join `users` 下发 `createdBy` / `createdByName`，未记录填写人时界面显示系统配置填写人「贾海洋」。**0094 起模板节点只返回公共节点或 `owner_template_id = 当前模板` 的私有节点；0092 起按可见范围过滤：`public` 对所有已过整体读权限的账号可见；`private` 仅填写人本人可见，列表不返回、详情 / 编辑 / 删除及从模板生成任务按 404 处理。**
- **写**（新建先过 `assertCanManageTaskTemplates`：系统管理员，或至少管理一个未软删项目的项目经理；编辑 / 删除在读取模板后再过 `assertCanManageTaskTemplate(actorId, createdBy)`：仅创建人本人（且仍有项目经理资格）或系统管理员；其他项目经理、部门编辑范围、任务负责人均 403 `FORBIDDEN`）：
  - `POST /api/v1/task-templates/{id}/nodes`：在指定模板内新增私有节点（`title` / `titleEn`）；权限跟随模板编辑权（创建人或系统管理员），同模板同名 409 `NODE_ALREADY_EXISTS`；只写 `task_nodes.owner_template_id = 模板 id`，不进入公共节点库；
  - `POST /api/v1/task-templates`：名称 trim 后落库（空 / 全空白 400）、`visibility` 由填写人选择（`private` / `public`；缺省 `public` 兼容旧客户端）、`nodeIds` 允许空数组（新建后逐步拖入）、`nodeIds` 重复 / 节点不存在 / 节点跨阶段 / 引用其它模板私有节点 400 `VALIDATION_FAILED`；同事务写 `created_by = actorId`，回包读回填写人姓名；创建后只有填写人本人可随编辑保存切换 `visibility`；系统预置模板（`created_by` 为空）没有填写人，任何账号（包括管理员）都不能调整其可见范围；
  - `PATCH /api/v1/task-templates/{id}`：改名 / `visibility` 可选切换 / `nodeIds` **全量替换**（`replaceNodes`，`seq = (下标 + 1) × 10`；替换后清理该模板已移除的私有节点）+ `version` 乐观锁必传 —— 过期 409 `VERSION_CONFLICT`、不存在 404 `NOT_FOUND`；内容编辑仍按现有创建人 / 管理员规则放行，但只有实际改变 `visibility` 且 actor 为 `created_by` 时才更新可见范围；客户端回传同值 `visibility` 不算切换，非填写人改可见范围 403 `FORBIDDEN`；
  - `DELETE /api/v1/task-templates/{id}`：**body 带 `version`**，软删（`deleted_at` / `deleted_by` + `version` 前进）；**引用行保留**（软删只打标、不连带清子表 —— 照 0009 / 0022 口径，读面恒 `deleted_at is null` 过滤）；已按它生成的项目任务不受影响。
- **留痕**：每次写一条审计（`objectType = task_template`；`summary` 带阶段中文名与模板名；`changes` 记名称 + 节点名顺序 + 可见范围 + 填写人，删除写删除前快照；`metadata` 同步带 `visibility` / `createdBy`）；节点删除时审计 `metadata.removedFromTemplates` 记连带从几份模板里移除；**不写 outbox**。
- **边界**：不碰 `tasks` / `project_nodes`；**实例化 `POST /api/v1/projects/{id}/tasks/from-template` 仍未实现**（前端「添加任务」卡片逐条 `POST /projects/{id}/tasks`，判重 = 同阶段同名）。

## 本切片交付（第三段 · 2026-11-13：公共任务节点申请）

- **背景 / 口径**：导入表导入不再向公共节点库补节点；导入人（多数没有节点库维护权）需要一个申请渠道，已被权限页勾选为「公共节点审核」的系统管理员审核通过后才落公共节点。
- **契约**：`shared/src/modules/templates.ts` 增 `TaskNodeRequestStatus` / `TaskNodeRequest` / `TaskNodeRequestListQuery` / `TaskNodeRequestListResponse` / `TaskNodeRequestApproveBody` / `TaskNodeRequestRejectBody` / `TaskNodeRequestDecisionResponse`；`shared/src/openapi.ts` 新增 4 条路径；`AUDIT_OBJECT_TYPES` 增 `task_node_request`。导入侧契约见 `shared/src/modules/imports.ts`（commit `nodeRequests` / 结果 `nodeRequests`）。
- **数据**：迁移 `database/migrations/0096_task_node_requests.sql`（阶段 / 中英文名 / 状态 / 申请人 + 时间 / 来源项目 + 预览票据 / 审核人 + 时间 + 意见 / 最终节点 id；同阶段同名只允许一条 pending 的部分唯一索引；状态迁移的 CHECK 兜底）；迁移 `0098_task_node_request_no.sql` 增加申请人维度 `request_no`（历史按提交顺序回填；无 pending 时下一条从 1 开始；pending 内 `(requested_by, request_no)` 唯一），仅供企微审核寻址，不改 HTTP 契约。
- **写**：
  - `POST /api/v1/task-node-requests/{id}/approve`（复核当前管理员身份 + 公共节点审核人白名单）：可先改中英文名 → 同阶段同名判重 → 无同名则追加到该阶段末尾建公共节点（写 `task_node` create 审计）→ 有同名则**直接关联**（`linkedExisting=true`，不建行也不写节点审计）→ 申请行落 approved + `node_id`（写 `task_node_request` update 审计）。已处理 400、不存在 404、无权限 403。
  - `POST /api/v1/task-node-requests/{id}/reject`：原因必填（trim 后非空，≤200），落 rejected + `review_note`，写审计。
  - `POST /api/v1/task-node-requests/{id}/withdraw`：仅申请人本人、仅 pending（他人 403、已处理 400），落 withdrawn，写审计。
  - `createFromImport`（供导入模块在**导入事务内**调用，不对外暴露）：批内同阶段同名去重；该阶段已有同名公共节点 → 跳过并回报；已有同名 pending → 复用不重复插行（`onConflictDoNothing` + 回查兜底并发）；名称 trim、英文空串 → null。
- **读**：`GET /api/v1/task-node-requests?stage=&status=&mine=` —— `mine=true` 只看本人（任何登录账号，含本人待审数）；缺省 = 审核人视角全部（服务层 `assertCanReviewTaskNodeRequests`，无权限 403），响应带全局 `pendingCount`；排序 = pending 优先 → 提交时间倒序。
- **企微通知 / 回复（2026-11-14）**：申请创建（含导入事务）后，按当前仍生效的公共节点审核人逐人写 `notify.message` outbox（`channel=wecom_aibot`、模板码 `TASK_NODE_REQUEST_REVIEW`、去重键 `task-node-request-review:<requestId>:<reviewerId>`）；一条申请一条横向 Markdown 表，第一列为字段名，含具体阶段名对应的现有公共节点、申请节点、申请号、申请人、来源项目、提交时间、平台链接与回复示例。企微单聊仅识别 `同意{申请人}的{n}号申请` / `驳回{申请人}的{n}号申请 [理由]`，先经绑定态解析本地账号，再复核 `taskNodeReview`；省略驳回理由记「无」，结果在会话内回执（例如「已同意：潘兴的1号申请，第四批空箱上架」）。未绑定、无权限、已处理、不存在均回可读中文。
- **留痕**：通过 / 驳回 / 撤销各一条审计（`objectType = task_node_request`，`changes` 记状态 / 名称 / 审核意见 / 最终节点）；通过时新建节点另写一条 `task_node` create 审计（`metadata.source = task_node_request` + `requestId`）。**导入内提交申请不单独留痕**（已由导入的 project create 审计覆盖上下文）；通知 outbox 与申请写入同事务，不额外写审计。
- **边界**：申请**不写** `task_nodes`；只通过审核通过这一条路径落公共节点（与直接 `POST /task-nodes` 并存）。审核资格由 0097 白名单单独配置，公共节点库维护权与审核权互不替代。企微审核通知与回复已接入；申请号只用于沟通与通知，未加入 HTTP 契约。
- **并发口径（真机复验修正）**：审核 / 撤销前的行锁用 `lockById`（只查 `task_node_requests` 本表 + `FOR UPDATE`）；**不能**在读面带 `LEFT JOIN` 的查询上加 `FOR UPDATE` —— PostgreSQL 直接报 `FOR UPDATE cannot be applied to the nullable side of an outer join`（2026-11-13 本地真库 + 浏览器全链路实测暴露，单测替身无法覆盖）。读面字段在行锁之后另取 `findById`。

## 本切片交付（2026-11-13 · 「入库审核」模板独立板块）

- **业务口径**：任务模板页在九阶段标签右侧、「＋ 新建模板」左侧增加「入库审核」。它不是项目阶段，不进入 `STAGE_KEYS` / 项目阶段字典 / 任务 / 看板 / 甘特图 / 日报，也不得混入验收。
- **契约**：`shared/src/modules/templates.ts` 新增 `TEMPLATE_SECTION_KEYS = STAGE_KEYS + inbound_review`、`TemplateSectionKey`、`TemplateSectionKeySchema`；`TaskNode` / `TaskTemplate` 的 `stageKey` 与列表过滤参数改为模板板块 key。`inbound_review` 只允许出现在任务模板 / 节点接口。
- **数据**：迁移 `0095_template_inbound_review_section.sql` 扩展 `task_templates.stage_key` 与 `task_nodes.stage_key` 的 CHECK；仍沿用 `owner_template_id` 隔离模板私有节点，不新增表 / 列。
- **边界**：入库审核模板不能生成项目任务；`TaskService.create(sourceNodeId=…)` 与 `createFromTemplate()` 对 `inbound_review` 返回 400 `VALIDATION_FAILED`。Excel 导入的个人模板候选也排除该分组。
- **前端**：`#/templates?section=inbound-review`；九阶段共用同一套标签、节点库、模板卡片、可见范围与私有节点交互；入库审核只保留审核工作台，不渲染节点库 / 模板卡片与新建模板入口；中 / 英 / 日 / 韩显示名同步。

## 验证

- 第一段：`test/template-nodes.test.ts` —— 18 例全绿（列表 / 新增（归一 + seq + 同名 + 越权）/ 编辑（改名 + 英文名清空 + 同名放行与拦截 + 乐观锁 + 404 + 403）/ 删除（快照 + 404 + 403 + 被模板引用时照删））。
- 第二段：`test/template-templates.test.ts` —— **30 例全绿**（含模板私有节点新增 / 空白标题 / 同模板判重 / 跨模板引用拒绝 / 保存清理）（列表（按阶段 / 全部 + 读序 + 个人 / 公共可见范围）/ 详情（404 + 个人模板隔离）/ 新建（trim + 可见范围 + 空 `nodeIds` + 全空白名 400 + 重复 id / 未知节点 / 跨阶段 400 + 403 + 填写人）/ 编辑（改名 + 可见范围双向切换 + 系统模板管理员不能调整范围 + 他人模板管理员不能调整范围但可编辑内容 + 非管理员拒绝 + `nodeIds` 全量替换 + 清空 + 409 + 404 + 个人模板隔离）/ 删除（软删回包 + 读面消失 + 审计快照 + 409 + 404 + 403））。
- 第三段（2026-11-13）：`test/task-node-requests.test.ts` —— **9 例全绿**（本人视角 / 审核人视角与 403 / 导入内跳过同名节点与复用待审 + 批内去重 / 并发撞唯一索引回查复用 / 通过时改名建节点（seq 追加 + 两条审计）/ 已有同名直接关联 / 已处理 400 + 404 + 403 / 驳回原因必填 / 撤销仅本人且仅 pending）；`test/project-import.test.ts` 增 5 例（申请随导入提交并回传 / 缺省取源表原名与预览英文 / 只能对保留原名提交并拒绝重复分组 / 同名节点提醒 / 复用在途申请提醒）。
- 本次复核（2026-11-14）：`npm run typecheck` / `npm run build` / `npm test`（**1868 passed · 61 skipped / 124 passed · 7 skipped 文件**）/ `npm run check:boundaries`（**361 文件 / 1666 依赖 / 0 违规**）全过；`shared` 的 `typecheck` / `build` 全过。
- 企微审核（2026-11-14）：`test/task-node-review-wecom.test.ts` 覆盖回复解析、驳回省略理由、Markdown 表格与竖线转义；`test/task-node-requests.test.ts` 增企微同意 / 驳回回执、无权限 / 已处理 / 不存在；定向 16 例全过。
- 本次复核：`npm run typecheck` / `npm run build` / `npm test` / `npm run check:boundaries` 全过；`shared` 的 `generate` / `typecheck` / `build` / `check` 全过。
- 真机回放：第一段 `frontend/scripts/m3-05-task-nodes-e2e.mjs` 48 项全过，证据 `docs/m3-05-回放证据(节点库增删改·前端).md`；第二段 `frontend/scripts/m3-05-task-templates-e2e.mjs` **60 项全过**（含硬刷新后仍在 / 未保存改动必须消失 / 面板顺序 = 接口顺序），证据 `docs/m3-05-回放证据(模板落库·前端).md`。

## 待办（后续）

- 模板实例化 `POST /api/v1/projects/{id}/tasks/from-template`（`templateId` + 可选 `nodeIds`，`skipExisting` 默认 true → `created` + `skipped`）：已入契约（Push 62）、未实现；前端「添加任务」卡片目前逐条创建 + 按「同阶段同名」判重，接线后卡片能带上节点库来源。
- 「同阶段同名是否唯一」待业务定稿（当前不设唯一：「未命名模板」允许重复）。
- 模板跨面板移动 / 面板内重排之外的模板列表顺序调整：当前顺序 = `created_at` 倒序，未做手排。
