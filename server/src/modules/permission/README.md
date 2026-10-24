# permission 模块（h6 · S6·PoC-6：权限矩阵与脱敏五出口）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain，横切策略层） |
| 职责 | ADR-011 策略服务落地形态：功能权限（can）/ 记录级可见集 / 字段级策略 / 五出口（页面 · 导出 · 搜索 · 通知）投影统一出口 |
| 主责 | wmj（团队分工.md §2 / §6 第 6 行） |
| 对外接口 | PermissionService（getAuthorization / can / assertCan / projectScope / resolveProjectAccess / assertProjectVisible / permissionsOf / invalidate / projectIdOfNode）、ProjectAccessGuard + @ProjectAccess / @RequirePermission / @ProjectScope、纯函数策略（permission.rules.ts：projectScopeSpec / can / visibleFields / hiddenFields / projectFields / planExit / exitsConsistent）；HTTP：GET /api/v1/permissions/me |

## 已实现（h6）

- 策略层纯函数（permission.rules.ts，不碰数据库，CI 用例主对象）：
  - 记录级：`projectScopeSpec`（数据范围 → all / managed / member 三开关；granted 未落地（own_stakeholders 已随 j6 落地，见下「差异」1）；无角色兜底名册）；
  - 功能权限：`can(actor, key, ctx)` = 全局权限位 ∪ 项目内项目经理隐含位 ∪ 项目内成员隐含位（ADR-011 §4.3 平权例外 + ADR-020 / ADR-023 既有口径）；
  - 字段级：表驱动 `FIELD_POLICIES`（干系人联系方式三个字段 → stakeholder.contact.view；公司 / 职务 → stakeholder.view；备注 → stakeholder.manage；员工邮箱一期全员可见）；无权字段**不返回**（服务端裁剪，不做前端打码 · C3-08）；
  - 五出口：`planExit(actor, exit, entity)`（page / export / search / notify）与 `exitsConsistent`（同一实体下四出口投影必须一致）；导出出口额外要求 `project.export`（C3-05 单独授权 + 审计）。
- 数据面（permission.repository.ts）：只读名册（project_members）、项目主数据引用（manager_ids / deleted_at；A22 多位 = 任一位命中）、节点 → 项目（project_nodes）。名册与节点的写路径仍归 project 模块（本模块不写库）。
- 服务（permission.service.ts）：授权画像缓存（TTL 10s + 显式 `invalidate`，ADR-011「内存 + 失效」一期形态）、`projectScope`（列表过滤：all / ids，空集 = 无可见项目）、`resolveProjectAccess` / `assertProjectVisible`（不可见 / 不存在 / 已软删统一 404）、`assertCan`（403）。
- HTTP 入口（project-access.guard.ts）：ProjectAccessGuard 挂 SessionGuard 之后，一次解析项目上下文与可见过滤：
  - `:id` 为项目（默认）或节点（@ProjectAccess("node")，先解析到项目）的读路由 → 记录级 404；
  - 标 @RequirePermission(key) 的写路由 → can 判定，缺权限 403；
  - 无项目路径参数的路由（列表 / facets / 创建）→ 过滤挂到 request，由 @ProjectScope() 取用。
- 矩阵种子：#6b `database/seeds/role-permissions.mjs`（六角色 × 24 键，键唯一来源 = 契约 `PERMISSION_KEYS`；移除键会删除 —— 权限吊销必须生效）。

- **权限判定开关（Push 178 · 一期「不判权限」）**：画像入口 `RoleService.getActorAuthorization()` 在 `PERMISSION_ENFORCED=false`（默认）时返回**等效管理员**（`roleCodes=[admin]` + `dataScopes=[all]` + 契约全量权限位）—— 本模块判定链（`can` / `projectScopeSpec` / `FIELD_POLICIES` / `assertCan` / 五出口）**零改动即整体放开**，记录级不再裁剪、字段级不再隐藏、导出不再单独授权；`true`（二期）回到 ADR-011 判定。画像缓存（TTL 10s + `invalidate`）与 404 / 403 语义不变（开关只决定画像内容）。

## 部门访问规则（0068 / 0069）

- `user_group_memberships` 保存 Casdoor 群组直属成员；权限画像入口按当前账号的群组键读取 `group_access_rules`，群组页面取并集、项目 `all` 优先、否则 `selected` 取并集，无规则默认拒绝（`GROUP_ACCESS_ENFORCED=false` 时不裁决，仅保存）。
- 0069 增 `member_scope` / `member_user_ids`：`all` 让部门规则对全体直属成员生效（后续加入该部门的人员自动覆盖）；`selected` 只对勾选人员生效，空选择不放行任何人。保存 `selected` 时校验每个 user id 都来自该部门当前直属成员，防止伪造。
- 权限页的「部门文件夹全选」只作用于该部门直属人员，子部门按各自规则独立配置；人员勾选状态随规则保存，不做实时同步按钮。

## 与其它模块的边界

- 依赖方向：permission → identity（角色画像）。project / task / blueprint 反向依赖本模块（守卫与策略出口），**本模块不 import project / task**（可见性判定直接读名册与节点表，避免循环；check:boundaries 无违规）。
- 名册维护（增删改）与节点维护仍属 project 模块；本模块只读这两张表做判定。
- C3-09 当前已落地部门访问规则页（页面 / 项目范围 / 适用人员，规则可保存；`GROUP_ACCESS_ENFORCED` 默认关闭），角色模板与权限自检报告仍待做；临时授权（C3-06）不做。越权尝试留痕已随 h7 落地（403 / 项目域 404 → `audit_logs` 的 `result=denied` 行，检索 `GET /api/v1/audit-logs?result=denied`）；告警推送随 M5 通知模块。

## 差异与后续（待复核）

1. `granted` 数据范围**未落地**（临时授权随 C3-06）：当前不贡献可见集；`own_stakeholders` **已随 j6 落地（Push 144）** —— 一期落地形态 = 干系人台账的记录级可见集「我录入的（`stakeholders.created_by` = 本人）」∪「关联项目落在可见项目内」，由 `stakeholder.rules.stakeholderVisibility` 实现（ownId 恒为本人 = 兜底，避免「有角色反而看得更少」）。项目域仍等价于「只看得到自己名册上的项目 ∪（managed_projects 下）自己管理的项目」。
2. 字段级的真实出口**已随 j6 干系人落地（Push 144）**：`StakeholderService` 逐行经 `projectFields(authorization, stakeholder, dto)` 裁剪，无权字段**键不存在**（C3-08：不返回、不打码）—— 策略层零改动，接入即出口。导出 / 搜索 / 消息出口（lan 线 M7 / M5）复用同一策略表与投影入口。
3. 「隐藏脱敏」的位形打码档（masked）与「只读」档仍留待 C3-09 定稿：一期按 C3-08「无权字段一律不返回」执行 —— j6 已按此落地（只读角色读得到干系人、读不到 remark；列表与详情同一键位）。
4. 列表可见集按 id 集合过滤（一次查询取可见项目 id，再 `inArray`）—— 一期规模够用；项目量级上来后随 M2-06 / 压测评估改视图或子查询。
5. 导出 / 搜索 / 通知模块本身（i 系列 / M7 的 search、notify、jobs）尚未落地：本模块已给出统一投影入口，落地时按出口调用即可。
