# permission 模块（h6 · S6·PoC-6：权限矩阵与脱敏五出口）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain，横切策略层） |
| 职责 | ADR-011 策略服务落地形态：功能权限（can）/ 记录级可见集 / 字段级策略 / 五出口（页面 · 导出 · 搜索 · 通知）投影统一出口 |
| 主责 | wmj（团队分工.md §2 / §6 第 6 行） |
| 对外接口 | PermissionService（getAuthorization / can / assertCan / assertWritable / canManageBlueprint / assertCanManageBlueprint / projectScope / auditAccessOf / resolveProjectAccess / assertProjectVisible / permissionsOf / invalidate / projectIdOfNode）、ProjectAccessGuard + @ProjectAccess / @RequirePermission / @ProjectScope、纯函数策略（permission.rules.ts：projectScopeSpec / can / visibleFields / hiddenFields / projectFields / planExit / exitsConsistent）；HTTP：GET /api/v1/permissions/me |

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
- 历史矩阵种子：#6b `database/seeds/role-permissions.mjs`（六角色 × 24 键）；2026-10-26 起仅保留为历史数据，不参与业务授权。

- **部门权限唯一裁定（2026-10-26）**：`RoleService.getActorAuthorization()` 固定返回全量能力基线（遗留 `roleCodes=[]` + `dataScopes=[all]` + 契约全量权限位）；项目范围、编辑 / 仅浏览与写入口由 `GROUP_ACCESS_ENFORCED` 下的部门规则统一裁决。管理员硬闸统一调用 `PermissionService.canManageGroupAccess()`，不得再以 `roleCodes.includes("admin")` 判断。画像缓存（TTL 10s + `invalidate`）与 404 / 403 语义不变。

## 部门访问规则与系统管理员（0068 / 0069 / 0070 / 0072 / 0073 / 0074）

- `user_group_memberships` 保存 Casdoor 群组直属成员；权限画像入口按当前账号的群组键读取 `group_access_rules`。2026-10-24 起页面不再按部门裁剪：所有登录账号的页面集合恒为 `GROUP_ACCESS_PAGE_KEYS`，`allowed_pages` 仅为旧客户端兼容字段，保存时恒写全量、裁决时忽略。
- **权限管理入口**：仅 `GROUP_ACCESS_ADMIN_GROUP_KEYS` 命中的部门管理员、`GROUP_ACCESS_ADMIN_USER_IDS` 显式用户白名单，以及权限页手工授权账号可进入；角色 `access.manage` 不再产生管理员。
- **系统管理员名单（0072）**：权限页左栏展示当前生效的管理员，来源合并 `GROUP_ACCESS_ADMIN_USER_IDS`、`GROUP_ACCESS_ADMIN_GROUP_KEYS` 与 `group_access_admins` 手工授权；按 user id 去重，环境配置来源不可在页面撤销。`POST /api/v1/access/admins` / `DELETE /api/v1/access/admins` 仅权限管理员可调用，手工变更写审计 `group_access_admin` 并立即清空权限画像缓存；至少保留一名管理员。
- **编辑 / 仅浏览（0073）**：`group_access_rules.access_level = edit | view`，edit 隐含浏览；多部门规则取并集，任一适用 edit 才解除只读。`projectScope=none` 保存时强制 view，数据库同时以 CHECK 拒绝 none + edit。开关 `GROUP_ACCESS_ENFORCED=true`、非部门管理员且无任何适用 edit 时，画像下发 `groupReadOnly=true`；所有业务写权限键（项目 / 成员 / 任务 / 日报 / 问题 / 节点 / 蓝图 / 文件 / 干系人 / 字典 / 日历 / 自动化 / 重发）经 `can` 一律返回 false，未挂功能权限键的写入口可用 `assertWritable` 兜底拒绝。读接口保持可用。**edit 是账号级写能力**：任一适用规则命中后，该账号可在其全部可见项目内写，不按项目逐一拆分。
- 项目范围支持 `all` / `own` / `selected` / `none`：多群组规则取并集，任一 `all` 取消收窄；`own` 展开为 `projects.manager_ids` 含本人或 `project_members` 名册包含本人的项目；没有有效规则 = 项目空集（默认拒绝数据）。系统管理员不受部门规则限制，恒为全部项目。
- **画像三态与业务页空状态**：`ActorPermissions.groupProjectAccess` = `allowed`（有可浏览范围）/ `empty`（至少一个 `all` / `own` / `selected` 范围但当前无可见项目）/ `denied`（无规则或适用规则的项目范围全部为 `none`，仅登录）；前端对仪表盘、项目空间、项目详情、我的任务、文件库统一显示「权限不足」或「当前没有可浏览的项目」，接口仍以服务端空范围兜底。2026-10-26 起画像另下发 `groupProjectScopes`（命中规则的项目范围并集）与 `groupAccessLevel`（edit / view），用于项目空间空态解释当前权限；两者均由既有规则派生，不新增表或迁移。
- **任务模板维护**：`canManageBlueprint` 仅系统管理员，或 `GROUP_ACCESS_ENFORCED=true` 且命中任一编辑规则的账号为 true；旧角色权限不再放大模板写权限。
- **任务节点 / 模板读取**：`canReadBlueprint` / `assertCanReadBlueprint` 在 `GROUP_ACCESS_ENFORCED=true` 时仅放行系统管理员或至少命中一个 `all` / `own` / `selected` 项目范围的账号；仅登录账号（无规则或适用规则均为 `none`）读取节点 / 模板列表与详情均 403。有数据范围但当前无可见项目的 `empty` 仍可读模板，管理员与限制关闭时恒可读。
- **操作记录范围**：`auditAccessOf` 返回 `all` / `project_manager` / `self`；项目经理的管理项目集合 = 主数据项目经理 ∪ 名册项目经理，再与当前部门有效项目范围取交集并排除软删项目，防止关闭部门范围后从操作记录旁路。
- **部门默认（0069 兼容保留）**：`group_access_rules.member_scope` / `member_user_ids` 保留用于旧客户端与升级迁移。权限页保存部门默认时固定写 `member_scope=all`、`member_user_ids=[]`；`all` 对部门全体直属成员生效，后续加入者自动继承。存量 `selected` 部门行由 0074 拆成个人规则后删除，不再作为新配置入口。
- **部门内个人覆盖（0074）**：`group_access_member_rules` 以 `group_key + user_id` 为主键保存个人项目范围 / 编辑或仅浏览，`project_group_member_access` 保存 `selected` 项目白名单并以组合外键级联到个人规则。同一部门内个人规则优先，未设置者继承部门默认；不同人员互不影响，多部门仍按各自有效规则取并集。新增 `PUT /api/v1/access/member-rules`（批量写入相同权限或各自调用）与 `DELETE /api/v1/access/member-rules`（JSON body，删除所选人员覆盖并恢复部门默认）；仅权限管理员可调用，保存 / 删除写审计 `group_access_rule`（`metadata.target=member`）并清空画像缓存。
- **虚拟未分组（Push 497）**：没有 `user_group_memberships` 记录的未删除账号（含停用）在权限通讯录 / 看板聚合为根级虚拟部门「未分组」（固定键 `__ungrouped__`，不写 `departments`）；无账号时不返回空节点。该节点可保存 / 删除规则，`selected` 人员范围只校验当前未分组账号；权限画像把无部门账号的 `groupKeys` 映射为 `__ungrouped__`，进入任一真实部门后自动退出。
- 权限页的「部门文件夹全选」只作用于该部门直属人员，子部门按各自规则独立配置；部门默认与个人覆盖分块保存，选中人员只表示本次个人权限目标，不再表示部门规则适用范围。个人行显示「个人权限」标识，点击姓名会打开所属部门并载入该人员有效权限；恢复默认会删除其个人覆盖。手工部门键入口已删除，部门目录完全来自 Casdoor 自动同步。

## 与其它模块的边界

- 依赖方向：permission → identity（组织与全量能力基线；部门规则在本模块内裁决）。project / task / blueprint 反向依赖本模块（守卫与策略出口），**本模块不 import project / task**（可见性判定直接读名册与节点表，避免循环；check:boundaries 无违规）。
- 名册维护（增删改）与节点维护仍属 project 模块；本模块只读这两张表做判定。
- C3-09 当前已落地部门访问规则页（项目范围 / 适用人员 / 编辑或仅浏览，规则可保存；页面恒全开，开关开启时无适用 edit 的非管理员只读；`GROUP_ACCESS_ENFORCED` 本地默认关闭；生产环境启动时强制要求 `true`），角色模板与权限自检报告仍待做；临时授权（C3-06）不做。越权尝试留痕已随 h7 落地（403 / 项目域 404 → `audit_logs` 的 `result=denied` 行，检索 `GET /api/v1/audit-logs?result=denied`）；告警推送随 M5 通知模块。

## 差异与后续（待复核）

1. `granted` 数据范围**未落地**（临时授权随 C3-06）：当前不贡献可见集；`own_stakeholders` **已随 j6 落地（Push 144）** —— 一期落地形态 = 干系人台账的记录级可见集「我录入的（`stakeholders.created_by` = 本人）」∪「关联项目落在可见项目内」，由 `stakeholder.rules.stakeholderVisibility` 实现（ownId 恒为本人 = 兜底，避免「有角色反而看得更少」）。项目域仍等价于「只看得到自己名册上的项目 ∪（managed_projects 下）自己管理的项目」。
2. 字段级的真实出口**已随 j6 干系人落地（Push 144）**：`StakeholderService` 逐行经 `projectFields(authorization, stakeholder, dto)` 裁剪，无权字段**键不存在**（C3-08：不返回、不打码）—— 策略层零改动，接入即出口。导出 / 搜索 / 消息出口（lan 线 M7 / M5）复用同一策略表与投影入口。
3. 「隐藏脱敏」的位形打码档（masked）与「只读」档仍留待 C3-09 定稿：一期按 C3-08「无权字段一律不返回」执行 —— j6 已按此落地（只读角色读得到干系人、读不到 remark；列表与详情同一键位）。
4. 列表可见集按 id 集合过滤（一次查询取可见项目 id，再 `inArray`）—— 一期规模够用；项目量级上来后随 M2-06 / 压测评估改视图或子查询。
5. 导出 / 搜索 / 通知模块本身（i 系列 / M7 的 search、notify、jobs）尚未落地：本模块已给出统一投影入口，落地时按出口调用即可。
