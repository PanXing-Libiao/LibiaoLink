# template 模块（M3-05 余 · 任务节点库 + 任务模板 · A1-16 / A1-17 · Push 181 / 182）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 任务节点库（`task_nodes`）读写：列表 / 新增 / 编辑 / 删除；任务模板（`task_templates` / `task_template_nodes`）读写：列表 / 详情 / 新建 / 编辑（`nodeIds` 全量替换）/ 软删 |
| 主责 | wmj（团队分工.md §2；本切为 px 按授权代做，请 wmj 复核） |
| 对外接口 | `TemplateService` / `TaskNodeRepository` / `TaskTemplateRepository`（`index.ts` 出口） |

## 本切片交付（第一段 · Push 181）

- **契约**：`shared/src/modules/templates.ts` —— `TaskNodeSchema` / `TaskNodeListQuerySchema` / `TaskNodeCreateBodySchema` / `TaskNodeUpdateBodySchema` / `TaskNodeDeleteResponseSchema`；`shared/src/openapi.ts` 新增 `POST /api/v1/task-nodes`、`PATCH /api/v1/task-nodes/{id}`、`DELETE /api/v1/task-nodes/{id}`。
- **数据**：迁移 `database/migrations/0032_task_nodes.sql`（`task_nodes`：九阶段 CHECK / `seq` 正数 / 同阶段同名唯一 `uq_task_nodes_stage_title` / 读序索引 `ix_task_nodes_stage_seq`）+ 种子 #8（九阶段 52 条）。
- **读**：`GET /api/v1/task-nodes?stage=`（登录即可；缺省全部阶段）—— 排序 = 九阶段顺序 → `seq` → `id`；`total` 与 `items` 同步。
- **写**（服务层 `assertCanManageBlueprint` 复核：系统管理员，或部门限制开启且命中编辑规则；其余 403 `FORBIDDEN`）：
  - `POST /api/v1/task-nodes`：`title` trim 后落库、`titleEn` 空串 → null；同阶段同名 409 `NODE_ALREADY_EXISTS`（不落库不留痕）；缺省 `seq` = 该阶段末位 + 10；
  - `PATCH /api/v1/task-nodes/{id}`：只改传入字段（`titleEn` 传 null / 空串 = 清空）；`version` 必传 —— 过期 409 `VERSION_CONFLICT`；改名撞同阶段已有名 409 `NODE_ALREADY_EXISTS`（排除自身）；不存在 404 `NOT_FOUND`；
  - `DELETE /api/v1/task-nodes/{id}`：**物理删行**（与字典条目硬删同口径），删除前快照进审计 `changes`；已按该节点生成的项目任务不受影响（任务侧无外键）。
- **留痕**：每条写操作一条审计（`objectType` = `task_node`；`summary` 带阶段中文名与节点名；`metadata` 记 `stageKey` / `seq`），与业务写入**同一事务**；**不写 outbox**（与字典维护同口径）。
- **边界**：不碰 `tasks` / `project_nodes` —— `tasks.node_id` 指向流程节点（`project_nodes`），节点库只回答「任务从哪来」；前端接线见 `frontend/src/templateApi.ts` 与 `PlaceholderPage.tsx`（左列「任务节点」：新增 / 编辑 / 删除 + 按板块缓存重取）。

## 本切片交付（第二段 · Push 182：任务模板落库）

- **契约**：`shared/src/modules/templates.ts` 模板侧别名（`TaskTemplate` / `TaskTemplateNode` / `TaskTemplateListQuery` / `TaskTemplateListResponse` / `TaskTemplateCreateBody` / `TaskTemplateUpdateBody` / `TaskTemplateDeleteBody` / `TaskTemplateDeleteResponse`）；`AUDIT_OBJECT_TYPES` 增 `task_template`。
- **数据**：迁移 `database/migrations/0033_task_templates.sql`（`task_templates` + `task_template_nodes`）+ 种子 #9（九阶段 10 套，节点按「同阶段 + 同名」解析节点库 id）；0071 增 `task_templates.created_by`（`users.id`）与局部索引，存量 / 种子为空。
- **读**：`GET /api/v1/task-templates?stage=`（登录即可；缺省全部阶段）—— 读序 = 九阶段顺序 → **`created_at` 倒序** → id（最新在最左，与「＋ 新建模板」插到最左一致；种子按清单顺序倒排 `created_at`，业务清单第一套仍在最左）、`total` 与 `items` 同步；`GET /api/v1/task-templates/{id}`（不存在 / 已软删 404）。节点标题 / 英文名**不落模板表**：读面 join `task_nodes` 实时取（节点改名后模板预览随即更新）；模板行另 left join `users` 下发 `createdBy` / `createdByName`，未记录填写人时界面显示「系统」。
- **写**（服务层 `assertCanManageBlueprint` 复核：系统管理员，或部门限制开启且命中编辑规则；其余 403 `FORBIDDEN`）：
  - `POST /api/v1/task-templates`：名称 trim 后落库（空 / 全空白 400）、`nodeIds` 允许空数组（新建后逐步拖入）、`nodeIds` 重复 / 节点不存在 / 节点跨阶段 400 `VALIDATION_FAILED`；同事务写 `created_by = actorId`，回包读回填写人姓名；
  - `PATCH /api/v1/task-templates/{id}`：改名 / `nodeIds` **全量替换**（`replaceNodes`，`seq = (下标 + 1) × 10`）+ `version` 乐观锁必传 —— 过期 409 `VERSION_CONFLICT`、不存在 404 `NOT_FOUND`；
  - `DELETE /api/v1/task-templates/{id}`：**body 带 `version`**，软删（`deleted_at` / `deleted_by` + `version` 前进）；**引用行保留**（软删只打标、不连带清子表 —— 照 0009 / 0022 口径，读面恒 `deleted_at is null` 过滤）；已按它生成的项目任务不受影响。
- **留痕**：每次写一条审计（`objectType = task_template`；`summary` 带阶段中文名与模板名；`changes` 记名称 + 节点名顺序，删除写删除前快照）；节点删除时审计 `metadata.removedFromTemplates` 记连带从几份模板里移除；**不写 outbox**。
- **边界**：不碰 `tasks` / `project_nodes`；**实例化 `POST /api/v1/projects/{id}/tasks/from-template` 仍未实现**（前端「添加任务」卡片逐条 `POST /projects/{id}/tasks`，判重 = 同阶段同名）。

## 验证

- 第一段：`test/template-nodes.test.ts` —— 18 例全绿（列表 / 新增（归一 + seq + 同名 + 越权）/ 编辑（改名 + 英文名清空 + 同名放行与拦截 + 乐观锁 + 404 + 403）/ 删除（快照 + 404 + 403 + 被模板引用时照删））。
- 第二段：`test/template-templates.test.ts` —— 16 例全绿（列表（按阶段 / 全部 + 读序）/ 详情（404）/ 新建（trim + 空 `nodeIds` + 全空白名 400 + 重复 id / 未知节点 / 跨阶段 400 + 403 + 填写人）/ 编辑（改名 + `nodeIds` 全量替换 + 清空 + 409 + 404）/ 删除（软删回包 + 读面消失 + 审计快照 + 409 + 404 + 403））。
- `npm run typecheck` / `npm run build` / `npm test`（587 → 593 → **610 项 · 39 文件**）/ `npm run check:db-schema`（35 → **37 表 · 364 列 · 115 索引 / 唯一 · 118 CHECK**）/ `npm run check:boundaries`（**169 文件 / 699 依赖 / 0 违规**）全过。
- 真机回放：第一段 `frontend/scripts/m3-05-task-nodes-e2e.mjs` 48 项全过，证据 `docs/m3-05-回放证据(节点库增删改·前端).md`；第二段 `frontend/scripts/m3-05-task-templates-e2e.mjs` **60 项全过**（含硬刷新后仍在 / 未保存改动必须消失 / 面板顺序 = 接口顺序），证据 `docs/m3-05-回放证据(模板落库·前端).md`。

## 待办（后续）

- 模板实例化 `POST /api/v1/projects/{id}/tasks/from-template`（`templateId` + 可选 `nodeIds`，`skipExisting` 默认 true → `created` + `skipped`）：已入契约（Push 62）、未实现；前端「添加任务」卡片目前逐条创建 + 按「同阶段同名」判重，接线后卡片能带上节点库来源。
- 「同阶段同名是否唯一」待业务定稿（当前不设唯一：「未命名模板」允许重复）。
- 模板跨面板移动 / 面板内重排之外的模板列表顺序调整：当前顺序 = `created_at` 倒序，未做手排。
