# stakeholder 模块（j6 · S8·stakeholder）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 项目干系人台账（每条记录独立归属一个项目；A5-01 ~ A5-04 / A5-07） |
| 主责 | wmj（团队分工.md §2） |
| 对外接口 | StakeholderService（`src/modules/stakeholder/index.ts` 唯一公开出口） |

## 落地内容

- 契约 `shared/src/modules/stakeholders.ts`（tags=stakeholders）：`StakeholderSchema` / `StakeholderCreateBodySchema` / `StakeholderUpdateBodySchema` / `StakeholderListQuerySchema` / `StakeholderListResponseSchema` / `StakeholderDeleteResponseSchema`；`AUDIT_OBJECT_TYPES` 增 `stakeholder`。OpenAPI 5 条路由：GET / POST `/api/v1/stakeholders`、GET / PATCH / DELETE `/api/v1/stakeholders/{stakeholderId}`；不提供跨项目追加 / 解除关联接口。
- 数据面（迁移 0019 + 0042 + 0085）：`stakeholders`（全库台账）+ `project_stakeholders`（单项目归属；`stakeholder_id` 唯一）。迁移 0085 将存量多关联拆成独立记录：保留原记录对应一个项目，其余每个项目复制一条完整干系人记录并改挂过去，不删除任何项目的数据；同一自然人在不同项目的记录互不共享。台账字段 = name / company_type（四值 libiao / supplier / general_contractor / customer）/ company / title / phone / wechat / email / remark / role（干系人角色 · Push 225 代做 wmj 线增列）+ created_by（录入人）+ created_at / updated_at + 软删 deleted_at / deleted_by。
- 四层：`stakeholder.controller.ts`（5 条路由；SessionGuard + CsrfGuard + ProjectAccessGuard；读 `stakeholder.view`；写由服务层叠加 `stakeholder.manage` 与所属项目最终 `accessLevel=edit`；POST 201）、`stakeholder.service.ts`（用例 + 记录级 404 + 字段级裁剪 + 项目级写权限 + 审计）、`stakeholder.repository.ts`（列表 / 详情 / 增删改 / 单项目归属写入 / 批量反查项目；restricted 空集短路）、`stakeholder.rules.ts`（stakeholderVisibility / isStakeholderProjectFilterVisible / buildStakeholderFilter / parseStakeholderSort / matchesKeyword，纯函数）。

## 口径（五条硬约束）

1. **记录级**：每条干系人记录必须归属一个项目，可见性只由所属项目决定，不按录入人跨项目兜底；不同项目即使姓名 / 联系方式相同也是独立记录。不可见 / 不存在 / 已软删**统一 404**（防 IDOR）。响应中的 `projects[]` 最多一项，且只投影当前账号可见项目；无权项目的 id / code / name 不返回。`filter[projectId]` 指向无权项目时，列表 / 总数 / 导出均为空集，不得借“我录入的”记录反推关联。
2. **字段级**（A5-07 / C3-08）：直接复用 permission 的 `FIELD_POLICIES` + `projectFields`，无权字段**键不存在**（不落 null、不做前端打码）—— phone / wechat / email → `stakeholder.contact.view`；company / title → `stakeholder.view`；remark → `stakeholder.manage`；name / companyType / role / createdBy / projects 未登记字段级策略 = 恒可见（有权但值为空才是 null）。
3. **项目独立**：创建时 `projectIds` 必须且只能有 1 项，空值或多项目直接 400；不提供追加 / 解除关联接口；数据库以 `uq_project_stakeholders_stakeholder` 唯一约束兜底。不建立姓名 / 手机号唯一约束，同一个人可在不同项目各建一条独立记录。
4. **留痕**：建 / 改 / 删都在**同一事务**写审计（`objectType = stakeholder`、`objectId` = 干系人 id）；归属不存在的项目 404 且不写审计。
5. **写权限（0075）**：更新 / 删除要求所属项目可编辑；创建要求 `stakeholder.manage + 所属项目 edit`。裁决同时传入最终 `accessLevel`：部门规则为 view / none 时，所管项目经理仍凭本项目 edit 写台账；只读项目仍可查看台账，但写入口由服务端拒绝。

## 验收与门禁（本卡）

- `npm run typecheck` / `npm run build` / `npm run test` 全绿：新增 `test/stakeholder-rules.test.ts` 12 例（记录级 4 / 过滤 3 / 排序 3 / 关键词 2）+ `test/stakeholder-service.test.ts` 22 例（字段级脱敏 4 / 导出上下文 1 / 记录级与项目隔离 7 / 写权限 5 / 用例与留痕 5）。
- `npm run check:boundaries` 0 违规；`npm run check:permission-matrix` 通过（种子 #6b 无需改动：project_manager / sales 三键、task_owner / project_member / viewer 读键、admin 全量）；`check:db-schema` 由 CI `database` job 复验（迁移 0019 / 0085 + Drizzle schema 对齐，本机无 PostgreSQL）。

## 差异与后续

1. **A5-05 批量导入**（Excel / CSV 模板 + 干跑报告 + 幂等重导）随 M8-01（lan 线）：本切片只做单条新增 / 编辑；判重（姓名 + 手机号）当前为口径约定（不建唯一约束），导入落地时按提示 / 报告呈现。
2. **A5-06 去重合并**二期：涉及关联迁移与留痕口径，需先定合并规则。
3. **A5-08 提醒**随 M5 通知模块（lan 线）。
4. **A5-09 导出**随 M7-03（lan 线）—— 导出与页面同一字段策略（五出口同源，C3-08），落地时直接复用 `planExit`。
5. ~~**「干系人角色」列**（A5-01 措辞）口径未定（源表无此列）~~ —— **已落地（Push 225 · 代做 wmj 线，请 wmj 复核）**：业务口径 2026-09-29 明确列表要此列；迁移 `0042_stakeholder_role.sql` 增 `stakeholders.role text`（可空、1..80）+ 契约 `Stakeholder.role` / 创建 / 更新体 + 前端表格列与表单字段；不登记字段级策略（有 `stakeholder.view` 即可见）。
6. 公司分类（A5-02）为**新增枚举**，与源表自由写法（如「项目经理 / 客户」）的映射待业务确认；新增分类值需契约 + 迁移 + 种子三处同步。
7. 前端台账页与项目详情「干系人」面板（u 系列 · px 线）尚未接入：接口已备（`filter[projectId]` 反查 + 台账 CRUD）。
