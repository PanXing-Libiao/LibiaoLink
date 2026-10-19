# project 模块（h2 · S6·project + h3 · S6·blueprint/node：项目 CRUD / 列表 facets / 成员名册 / 流程快照与阶段）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain） |
| 职责 | 项目主数据、首页分类字段（地区 / 项目类型 / 项目经理）、项目回收站（软删 / 恢复 / 满 30 天自动或管理员手动彻底删除）、最小空闲 seq_no 复用；阶段推进 / 成员 / 视图随 M2-03 / M2-05 / M2-06 |
| 主责 | wmj（团队分工.md §2） |
| 对外接口 | ProjectService（listProjects / getFacets / getProject / createProject / updateProject / deleteProject / restoreProject / purgeProject / sweepExpiredRecycled）、ProjectMemberService（listMembers / addMember / removeMember）、ArchiveService（archiveProject / getArchive）；FlowService（importSnapshot / getFlow / listStages / createNode / deleteNode / completeNode / canComplete / advanceStage / rollbackStage）；HTTP：GET /api/v1/projects、GET /api/v1/projects/facets、GET / PATCH / DELETE /api/v1/projects/{id}、POST /api/v1/projects、GET / POST /api/v1/projects/{id}/members、DELETE /api/v1/projects/{id}/members/{userId}、GET /api/v1/projects/{id}/group/candidates、GET / PUT / DELETE /api/v1/projects/{id}/group、POST / GET /api/v1/projects/{id}/archive、GET /api/v1/projects/{id}/flow、GET /api/v1/projects/{id}/stages、POST /api/v1/projects/{id}/stages/{key}/advance、POST /api/v1/projects/{id}/stages/{key}/rollback、POST / DELETE /api/v1/projects/{id}/nodes[/{nodeId}]、POST /api/v1/nodes/{id}/complete、GET /api/v1/nodes/{id}/can-complete |

## 已实现（h2 第一批）

- 路由（契约 `shared/src/modules/projects.ts`，OpenAPI tags=projects）：全部挂 `SessionGuard + CsrfGuard`（读要登录、写要 `X-CSRF-Token`）。注册顺序上 `GET /facets` 在 `GET /:id` 之前（否则被 `:id` 吃掉）；`id` 走 `UuidSchema` 校验（非法 400 VALIDATION_FAILED）。
- M2-01 项目 CRUD：
  - 创建 `POST /api/v1/projects` → 201；`seq_no` 由服务端在事务内分配“当前最小可用正整数”（请求不接受 `seqNo`；彻底删除后的空号由下一次创建复用，并发创建用事务级 advisory lock 串行化）；`code` 唯一由约束兜底，23505 + `projects_code_key` → 409 `PROJECT_CODE_EXISTS`；缺省 `stageKey = presale`。
  - 更新 `PATCH /api/v1/projects/{id}`：乐观锁（正文回传 `version`，命中则 `version + 1` 并刷新 `updated_at`）；不匹配 409 `VERSION_CONFLICT`；期间被删 → 404。
  - 回收站 `DELETE /api/v1/projects/{id}`：`If-Match` 回传当前 `version`，只写 `deleted_at` / `deleted_by` 并 `version + 1`；普通读面立即不可见，`GET /projects?filter[recycled]=true` 可查。
  - 恢复 / 彻底删除：`POST /projects/{id}/restore`（只需 `project.delete`）清回收站标记；`POST /projects/{id}/purge`（仅 admin）先按 `projects/{id}/` 前缀清对象全部版本，再按外键序物理清 9 张聚合子表与项目行。`code` 与 `seq_no` 均在回收站期间保留，彻底删除后同时释放。
  - 30 天到期清理：worker 每 24 小时扫描 `deleted_at <= now() - 30 days` 的项目，单轮内按 ≤ 20 个一批（`PROJECT_RECYCLE_SWEEP_BATCH`）drain，直到不满批或无进展；复用彻底删除链路清理数据、文件 / 图片对象并写 `source=system` 审计；并发恢复 / 手动彻底删除在行锁内复核后跳过。
  - 归档（M7-04 · Push 167）：走专门端点 —— `POST /api/v1/projects/{id}/archive`（门禁 + 置位 + 引用式清单 + 撤销上传会话 + 审计）与 `GET /api/v1/projects/{id}/archive`（清单读面，未归档 404）；`PATCH` 的 `status` 收紧为 active / paused / done（**不再接受 archived**）；列表增 `filter[archivedYear]`（C4-07 检索）。写保护不变：`status = archived` 的项目 PATCH / DELETE 一律 409 `PROJECT_ARCHIVED`。
- M2-04 首页列表 / facets：`GET /api/v1/projects` 与 `GET /api/v1/projects/facets` 共用 `buildProjectFilter`（v0.3 §3.3「禁止两套 SQL」）——多值 `filter[region|projectType|managerId|stageKey|status]`（英文逗号分隔；`managerId` 命中口径 = 项目挂的任意一位经理，A22 · Push 136）；facets 的项目经理维度 = 数组展开后按人头计数（一个项目挂多位经理时每位各计一次）、`q` 命中编号 / 名称 / 客户 / 序号、`filter[timeFrom] / filter[timeTo]` 闭区间（`updated_at`）；facets 五组固定返回（A6），`total` 与列表同口径。
- 时间口径（ADR-028 · **Push 175 维度修订**）：区间按 Asia/Shanghai 日界（固定 `+08:00`，中国无夏令时）——下界含当日 00:00，上界取次日 00:00 不含；**区间维度 = `projects.created_at`（项目创建时间；原「最近活动 `updated_at`」口径作废）**；`timeFrom` 晚于 `timeTo` 或 `status` / `stageKey` / `managerId` 含非法值一律 400（不返回静默空列表）。
- 排序（A9 · **Push 175 缺省修订**）：白名单 `updatedAt` / `createdAt` / `seqNo`，方向 `asc|desc`；**缺省 `createdAt:desc`（最近创建的在前；原 `updatedAt:desc` 作废）** —— 前端 TIME = 「维度 × 方向」（创建时间 / 更新时间 × 降序 / 升序）；仓储补 `asc(seq_no)` 稳定 tie-breaker，分页不跳行。
- 可见性（A5）：普通列表 / 详情 / facets 统一 `deleted_at is null`，项目回收站显式 `filter[recycled]=true`；`code` / `seq_no` 在回收站期间仍唯一且占用，彻底删除后释放（`seq_no` 由下一次创建取最小空号）。索引见 `0056_project_recycle_bin.sql`（回收站 updated_at）与 `0057_project_recycle_retention.sql`（deleted_at 到期扫描）。
- 触点：`ProjectRepository.touch(id, at)` 为 ADR-022「项目 updated_at 触发集」的单点入口（阶段推进 / 任务变更等聚合视图变更调用；文件 / 日报 / 系统调度不调用）；本批 CRUD 自身由 `updateWithVersion` 一并刷新。
- 单测：`test/project-crud.test.ts` —— 筛选解析（多值 / 非法枚举 400 / 上海时区日界 / 区间反向 400）、排序白名单、行 → 契约视图映射、创建缺省阶段与撞号 409、乐观锁冲突、归档写保护、软删可见性与操作人透传、唯一约束违例解包、彻底删除后 seq_no 空号复用、30 天到期清理边界与系统审计（32 例，不连库）；真 PG 回放见 `scripts/project-recycle-retention-replay.mjs`（编号复用 / 并发唯一 / 满 30 天自动清理 / 未满保留，7 项断言）。

## 已实现（h2 第二批 · M2-05 名册 + 分类字段口径）

- 数据面（迁移 `0010_project_members.sql` + Drizzle `projectMembers`）：`project_members`（`project_id` / `user_id` / `role_in_project` / `joined_at`；`uq_project_members_project_user` 联合唯一 + `ix_project_members_user` 反查索引）；`npm run check:db-schema`：19 张表 / 195 列 / 54 索引 / 48 CHECK。
- 名册接口（`ProjectMemberService` + `ProjectMemberRepository`）：
  - `GET /api/v1/projects/{id}/members` —— 名册列表（项目经理在前，同角色按工号升序），姓名 / 工号随行下发（A2 / ADR-021：关联一律 users.id）。
  - `POST /api/v1/projects/{id}/members`（200）—— 添加 / 更新成员（**幂等 upsert**：同项目 + 同用户唯一，重复提交 = 覆盖角色、`joinedAt` 保持首次），缺省角色 `project_member`；目标用户不存在 → 404「用户不存在」（复用用户目录语义）。
  - `DELETE /api/v1/projects/{id}/members/{userId}` —— 移除成员并返回被移除行；不是成员 / 项目不可见统一 404（ADR-011 统一 404 语义）。
- 角色口径：`role_in_project` 一期两值 `project_manager` / `project_member`（与全局角色 `roles` / `user_roles` 相互独立：前者管项目名册与记录级可见性，后者管功能权限）。`projects.manager_ids`（主数据：首页 `filter[managerId]` / 卡片展示，A22 多位）与名册**不自动联动**：建项目时的成员初始化随 M2-02 建项目事务（h3），管理界面（u 系列）落地时收敛。
- ADR-022 触点：成员增删 / 改角色后调用 `ProjectRepository.touch`，项目 `updated_at` 前移（「人来动、视图可见的变更才触发」②）。
- 归档写保护（ADR-027）同样覆盖名册：归档项目的 POST / DELETE 成员 → 409 `PROJECT_ARCHIVED`（名册读仍可用）。
- 分类字段口径（A1-12 定档）：`region` / `projectType` 是首页分类侧边栏（facets 五组里的两组，A6）与统计的来源；创建请求缺省「**未分类**」（契约 `default("未分类")`，前端表单仍必填、空串 400）；更新可改。字典取值由 C9 字典维护（h7 已落地：`dict_types` / `dict_items` 表 + `GET /dicts` 下发；前端改读字典随 u12，服务端不封锁取值）。
- 单测：`test/project-members.test.ts` —— 视图映射、列表顺序与项目不可见 404、添加 upsert + touch、重复添加改角色保留 joinedAt、目标用户 404、归档写保护（不落任何写入）、移除与「不是成员」404（7 例，不连库）。
- 单测：`test/project-archive.test.ts`（M7-04 · Push 167）—— 契约收紧断言（PATCH 拒绝 archived / confirm 缺省 false）、硬前置 409、缺项 422（三类明细 + 失败留痕）、confirm 越过后置位 / 清单 / 撤销会话 / 审计、幂等 409 与版本冲突 409、权限 403、清单读面 404 / 成功、`filter[archivedYear]` 解析与非法 400（8 例，不连库）。

## 已实现（h3 · S6·blueprint/node：M2-02 建项目快照 + M2-03 阶段推进 / 回退 + 节点增删 · Push 83）

- 建项目事务（M2-02）：`createProject` 改为**单事务** —— 插入 projects → `FlowService.importSnapshot`（取该项目类型已发布蓝图，缺失回落 default；生成 stages / nodes / requirements；`projects.stage_key` 指向蓝图首阶段，请求 `stageKey` 命中快照阶段时按请求）→ touch；蓝图不可用 → 422 `BLUEPRINT_NOT_PUBLISHED`。旧口径「只写 projects + 缺省 presale」由本批替代。
- 流程读：`GET /api/v1/projects/{id}/flow`（快照：`blueprintVersion` + 阶段 + 节点 + 约束）、`GET /api/v1/projects/{id}/stages`（九阶段状态 + 节点 / 任务完成度，读时派生，不落库）。
- 阶段推进 / 回退（ADR-023）：`advanceStage` / `rollbackStage` —— 门禁失败 = 事务回滚后补写 outbox 留痕（`stage.gate_rejected`）再转 422；回退只认相邻上一阶段、原因必填、不做门禁；跟踪列（`advanced_at/by`、`rolled_back_at/by`、`rollback_reason`）见迁移 `0012`。
- 节点增删（ADR-020，仅项目经理）：`createNode`（模板节点池校验 → `node_key` 项目内唯一：已有未删节点 409 `NODE_ALREADY_EXISTS`；软删后再增补 = 还原同一行；`seq` 缺省 = 同阶段 max + 10）、`deleteNode`（原因必填、软删、乐观锁、有成果文件 409 `NODE_HAS_FILES`）。
- 完成门禁：`completeNode` / `canComplete`（复用 `NodeModule` 的 GateService；`/api/v1/nodes/*` 路由在本模块 `nodes.controller.ts`，按功能面而非 project 前缀）；拒绝同样先回滚事务、再补写 `node.gate_rejected` 留痕、最后 422。`complete` 响应按契约 `NodeCompleteResponse`（{ node }）（h5 修正：原先返回裸节点视图）。
- 权限（h6 落地）：读路由的记录级可见性与写路由的功能权限位统一走 `ProjectAccessGuard` —— 不可见 / 不存在 / 已软删一律 404（防 IDOR）；写路由缺位 403（`project.create` / `project.update` / `project.delete` / `member.manage`）；列表与 facets 取 `@ProjectScope()` 过滤。节点增删的 `assertProjectManager`（`admin` 角色 / `projects.manager_ids` 任一位 / 名册 `role_in_project=project_manager`）保留为服务内业务口径。归档项目一律 409 `PROJECT_ARCHIVED`。
- 留痕与触点：节点 / 阶段事件同事务写 outbox（`node.added`（还原带 `restored: true`）/ `node.completed` / `node.deleted` / `stage.advanced` / `stage.rolled_back`）；节点增删后调用 `ProjectRepository.touch`（ADR-022 ② 触点）。
- 单测：`test/project-crud.test.ts` 的 `makeService` 已注入 fake DB（`transaction` 直通）+ fake Flow（`importSnapshot`），创建用例覆盖快照调用；流程用例见 `test/blueprint-validation.test.ts` / `test/flow-gate.test.ts` 与本地实机演练记录。
## 已实现（M7-04 归档 · ADR-027 · C4-02 / C4-03 · Push 167）

- 端点（契约 `shared/src/modules/projects.ts`，OpenAPI tags = projects；`project.archive` 功能权限 + 记录级可见性）：`POST /api/v1/projects/{id}/archive`（200 返回清单视图）与 `GET /api/v1/projects/{id}/archive`（未归档 / 无清单 404）。
- 门禁（ADR-027）：① 硬前置 = 验收阶段（`project_stages.stage_key = acceptance`）已完成（未完成 409 `ARCHIVE_NOT_READY`，不可确认越过）；② 缺项清单 = 未完成任务（task_not_done）→ 未定档文件（file_not_final）→ A4-20 必交成果缺件（doc_missing，逐节点跑 `GateService.evaluateNode`）；有缺项且未确认 → 422 `ARCHIVE_GATE_NOT_PASSED`（details 带明细 + 写 `action=archive` / `result=failed` 审计、项目不置位）；`confirm=true` 确认越过，缺项随清单留痕。
- 归档事务（单事务）：锁项目行（`FOR UPDATE`）→ 乐观锁 `version` 判定 → 置 `status = archived` + `archived_at` / `archived_by` → 生成 `project_archives` 引用式清单（阶段 / 任务分布 / 文件含版本 / 变更 / 日报 / 问题统计）→ 撤销进行中的上传会话 → 审计 `action=archive`；不删数据、不改阶段、不做解冻（冻结口径）。
- 检索与投影：列表 `filter[archivedYear]`（四位年份 1900-2100、多值逗号分隔；按 `archived_at` 的 Asia/Shanghai 年）—— 归档检索（C4-07）的服务端读面；`search_docs` 搜索投影随 M7-01（lan）。
- 数据面：迁移 `0036_project_archive.sql`（`projects.archived_at` / `archived_by` 成对 CHECK + `project_archives` 表 + `ck_audit_logs_action` 十值 → 十一值）；`project_archives` 已并入硬删外键依赖序（本模块 README 上节删除序列）。
- 差异登记：① 清单为引用式（只记 id 与摘要，ADR-027；不做全库快照表）；② 清单导出（归档目录 / 压缩包）随 M7-03（lan）、C4-04 二期；③ 归档解冻不做（恢复走 DBA / 迁移器脚本，非产品口径）；④ 归档状态不可再编辑（`PATCH` 拒绝 archived；`filter[status]=archived` 只用于读 / 检索）。

## 已实现（M5-03-2 接线段 · 项目群绑定 · C2-05 · Push 224；0058 自动发现候选 · 2026-10-19）

- 端点（契约 `shared/src/modules/projects.ts`，OpenAPI tags = projects；类级 `SessionGuard + CsrfGuard + ProjectAccessGuard`，**候选列表 / PUT / DELETE 需 `project.update`** —— B3 定案，绑定状态 GET 为登录 + 记录级可见的读面）：`GET /api/v1/projects/{id}/group/candidates`（最近 30 天、最多 50 条，排除已绑定 chatid；只回 id / name / chatidMasked / lastSeenAt）、`GET /api/v1/projects/{id}/group`（恒 200；未绑定 = `bound:false` 全 null）、`PUT /api/v1/projects/{id}/group`（body `candidateId` 或 `chatid` 二选一 + `name?`；候选路径服务端回查完整 chatid，以候选 `lastSeenAt` 作 `activated_at` 并同事务删候选行，name 缺省沿用候选名；手工 chatid 路径保持 name 缺省清空、先绑后激活；chatid 变更 = 换绑、同 chatid 幂等；chatid 撞其它项目唯一约束 → 400 `VALIDATION_FAILED`；候选不存在 / 过期 → 404）、`DELETE /api/v1/projects/{id}/group`（幂等；未绑定不落审计 / 不触 `updatedAt`）。
- 安全口径：读面 / 候选列表 / 审计 / 日志**只回掩码**（`"****" + 末 4 位`；chatid 全文只落库 —— 等同机器人寻址凭据，防外泄）；审计 objectType=`project` 记掩码级 diff（`groupChatid` / `groupName`）；归档 409 `PROJECT_ARCHIVED`（写路径保护同主数据 · ADR-027）；变更刷新项目 `updatedAt`（ADR-022 触点）。
- 数据面：`wecom_groups`（迁移 `0046` · Push 222；`project_id` / `chatid` 双唯一 = 一个项目一群 / 一个群一项目 —— 换绑到别的项目需先解绑）；会话激活态 `activated_at` 由**企微回调 ingest** 置位。`wecom_group_candidates`（迁移 `0058`）承接未绑定群回调：同 `chatid` 幂等 upsert 群名 / 首末活跃时间；候选绑定成功后删除，列表排除已绑定群。消费侧（`notify.group` 寻址）见 `server/src/modules/notify/README.md`。
- 单测 `test/project-group.test.ts` **20 例**（含候选掩码读面 / 列表排除已绑定 / candidateId 绑定与过期 404）；差异登记：chatid 撞唯一约束 = 400（无新错误码，待 wmj 复核）；设置页自动发现候选 UI 已落地（px）；一期 = 一项目一群（多群广播不在本期口径）。

## 边界与后续

- 已随 h6 落地：名册的**记录级过滤**（列表 / 详情 / facets 按成员裁剪、非成员 404）由权限策略层（ADR-011）承担 —— 本模块只保留名册数据面与维护接口（搜索出口的同一策略入口已就绪，实现随 M7）；`projects.manager_ids` 与名册的自动联动随 M2-02 建项目事务（h3）/ 管理界面（u 系列）。
- 不做（收口后剩余）：`blueprintVersion` 入参仍忽略（建项目固定取「已发布蓝图」；指定版本 / 项目升级蓝图随 M6）；项目记录级权限的过滤已随 h6 落地（策略层 `ProjectAccessGuard` + `@ProjectScope()`）、视图 / 关注 / 偏好（M2-06）、写接口幂等键 `Idempotency-Key`（随 i5）；CRUD 与流程的审计留痕已随 h7 接线（项目创建 / 修改 / 归档、名册增删、节点增删与完成、阶段推进 / 回退，同事务写 `audit_logs`）。已随 h3 落地：建项目蓝图快照（M2-02）、阶段推进 / 回退（M2-03）、节点增删与完成门禁。
- 权限现状（h6 后）：读接口登录 + 记录级可见；写接口按功能权限位判定（项目内成员平权项见 `modules/permission/README.md`）；前端按钮可见性由 `GET /api/v1/permissions/me` 驱动，只做体验、不作为安全边界（ADR-011）。
- 待接：⓪ 成员批量维护（导入 / 变更）随 u 系列管理界面；① 项目总览四格 `GET /api/v1/projects/{id}/summary`（契约已入，依赖任务派生口径，随 M3 任务卡片）；② 搜索 / 导出复用本模块 filter 构造器（随 M5 检索卡片）。归档动作已随 M7-04 落地（Push 167：`POST` / `GET /api/v1/projects/{id}/archive`，见上节；前端归档按钮 / 确认流 / 清单页随 px 接线）。
