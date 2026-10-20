# database/seeds/ · 种子数据规格（M0-03）

- 定位：**可重跑、幂等、与迁移分离**的种子数据规格与清单。种子 = 系统运行所需的最小业务字典与模板（**不含**项目 / 用户等业务数据，不含演示与压测数据）——**例外**：#11「演示数据」是**可选种子**（`optional = true`）：默认不参与 `node scripts/seed.mjs` 的整跑，只在演示 / 联调环境显式播（见「执行约定」与清单 #11）。
- 现状：规格与清单定于 M0-03（Push 73）；执行器与首个种子（#6a 角色）已随 h1 落地（Push 74：`scripts/seed.mjs` + `seeds/roles.mjs` / `seeds/index.mjs`），此后 #7 蓝图（h3 · Push 83）、#6b 权限矩阵（h6 · Push 95，`seeds/role-permissions.mjs`）、#5 地区 / 项目类型（h7 · Push 97，`seeds/dicts.mjs`）随各自卡片落地；h8（Push 99）无新增种子文件（`#6b` 补 `calendar.manage` 一键），其余种子随对应卡片追加。实现前不得手工往库里灌数据。
- 归属：wmj（后端领域）；评审 lan、px。

## 与迁移的分界

| 维度 | migrations/ | seeds/ |
|---|---|---|
| 内容 | 结构变更（DDL） | 业务字典与模板数据（DML） |
| 追加性 | 只追加、不可修改（CONTRIBUTING §14） | 可重跑、可修订（幂等 upsert） |
| 记录 | `schema_migrations`（checksum 漂移校验） | 不写 `schema_migrations`，不参与漂移校验 |
| 触发 | 部署 / 运维手工 | 部署 / 运维手工（**应用启动不自动执行**） |
| 角色 | `libiaolink_migrator` | `libiaolink_migrator`（不引入第二个写字角色） |

## 执行约定（随实现落地）

- 命令（已落地）：`DATABASE_URL=... node scripts/seed.mjs [--dry-run] [--only=<name>] [--with-optional]`；`--dry-run` 打印变更摘要后全部回滚；执行器逐种子独立事务，advisory lock `20260919`（与迁移器 `20260918` 分开）。
- **可选种子**（`optional = true`，当前只有 #11 演示数据）：整跑时**默认跳过**并在日志里列出来（`seed: 跳过可选种子 demo-projects（演示数据；--only=<name> 或 --with-optional 显式执行）`）—— CI 只跑默认集，#11 需要演示数据时才播；`--only=demo-projects` 单独跑、`--with-optional` 连它一起跑。
- 幂等：按业务键 upsert / 逐字段比对（示例见 `seeds/roles.mjs`）；重复执行结果一致、第二次零变更。
- 不删除：默认不做 DELETE（业务后续调整过的字典项保留）；暂不提供 `--reset`（首个确实需要重置的种子落地时再引入，显式指定、留痕）。**例外**：#6b 权限矩阵**以文件为准** —— 移除键会 DELETE，因为权限是安全面、吊销必须能生效（修订语义见 `seeds/role-permissions.mjs` 顶部）。
- 顺序：dicts → roles / role_permissions → 蓝图（依赖 docType 字典）→ task_nodes / task_templates → automation_rules（依赖 0060）→ 消息模板 → 工作日历（表结构 + 管理入口已随 h8 落地：0014）→ 其余模板（当前注册表实序：dicts → roles → role-permissions → blueprint → task-nodes → task-templates → automation-rules）。
- 待业务确认的取值集中在文件顶部常量区并标注「可修订」；回执后更新常量并重跑。

## 种子清单（首批 · 对应 M0-03 的九阶段 / 十类成果文件 / 问题归类 / 角色权限矩阵 / 蓝图节点）

| # | 种子 | 落表（预计） | 业务键 | 口径来源 | 状态 |
|---|---|---|---|---|---|
| 1 | 九阶段 | `dict_types` / `dict_items`（type = stage） | (type, code)：presale ~ acceptance | v0.2 §2.5；A1-12 | 定稿 |
| 2 | 十类成果文件 | `dict_items`（type = docType） | (type, code)：CAD图纸 / 技术协议 / 合同 / 评审单 / 设备清单 / 物料总清单 / 发货装箱单 / 到货单 / 安装完成证明 / 验收单 | v0.2 §2.5；C9-01；门禁 required_doc 与任务 deliverable_types 引用 | 定稿 |
| 3 | 问题归类（10 项） | `dict_items`（type = issueCategory） | (type, code) | v0.2 §2.5 + 评审补充 | 定稿；SLA 时限字段随 ADR-026（metadata，业务待回执） |
| 4 | 紧急重要度（4 项） | `dict_items`（type = priority） | (type, code) | v0.2 §2.5 | 定稿 |
| 5 | 地区 / 项目类型 | `dict_items`（type = region / projectType）+ `metadata.continent` / `accent` / `accentText` | (type, code) | 地区已回执（2026-10-14 · 与「新建项目选择地区」同一份国家/地区清单）；项目类型仍待回执（v0.3 §7.3 #10） | 已落地（h7 · Push 97；Push 314 起 region = **201 国标准清单** —— 与 `frontend/src/data/worldMap.ts` 同源，旧 8 条占位由迁移 `0051` 清理 / projectType 3 项；改常量区重跑即可，库内已修订的不覆盖） |
| 6a | 角色（一期六个内置角色） | `roles` | (role code) | v0.2 §4.1；C3-01 / C3-02 | 已落地（h1 · Push 74，`seeds/roles.mjs`） |
| 6b | 功能权限矩阵（role_permissions 条目） | `role_permissions` | (role_id, permission) | v0.2 §4.1 关键能力列；ADR-011 | 已落地（h6 · Push 95，`seeds/role-permissions.mjs`：六角色 74 条；键唯一来源 = 契约 `PERMISSION_KEYS`，`check:permission-matrix` 三方对齐、admin 全量 **31 键**（h7 补 `dict.manage` / `audit.view`，h8 补 `calendar.manage`，M6-01 ~ M6-03 · Push 155 补 `report.view` / `report.fill` / `issue.view` / `issue.manage` —— 六角色 78 条）；幂等复跑 0 变更） |
| 7 | 蓝图（默认模板 + 项目类型覆盖） | `blueprints` / `blueprint_versions` | (project_type, version) | ADR-019；v0.2 §3.3 首批节点清单 | 已落地（h3 · Push 83，`seeds/blueprint.mjs`：默认模板 9 阶段 19 节点 + 版本 1）；节点清单仍待业务补全（可修订常量区，库内已修订时不覆盖） |
| 8 | 任务节点库 / 任务模板 | `task_nodes` / `task_templates` / `task_template_nodes` | (stage_key, node key) | A1-16 / A1-17；对照 `frontend/src/data/templatePresets.ts`（Push 60） | 待业务确认 |
| 9 | 消息模板（R01~R07 文案） | 消息模板表（M5 建表） | (template code) | `docs/rules/R01-R07-内置规则文案.md` | 文案定稿；表结构随 M5 |
| 10 | 工作日历（节假日 / 调休） | `calendar_days` / `calendar_settings`（0014 已落） | (日期, day_type) | D5-01；业务提供 | 表结构 + 管理入口已落地（h8 · Push 99）：`GET / PUT / DELETE /api/v1/calendar/*`（仅 `calendar.manage` 可写）+ 真机回放 30 项断言；**年度节假日 / 调休数据待业务回执**（回执后由管理端录入，或按新种子落地） |
| 11 | 演示数据：项目空间 + 地图地区分布（**可选种子**） | `dict_items`（type = region）+ `projects` | 地区 `(type, code)`；项目 `code` | Push 188 地图改版（业务 2026-09-24「你现在多写一点数据到数据库 这些国家的订单都可以写 写一点数据到数据库 到项目空间」） | 已落地（Push 189，`seeds/demo-projects.mjs`：地区 41 项 + 演示项目 100 个；`optional = true` → **默认不执行**；项目经理按用户名解析、缺账号退兜底并在摘要报 `managerFallback`；与 `migrations/` 无关、不动结构） |
| 12 | 自动化内置规则（M5-06-1A） | `automation_rules` + `jobs` | `automation_rules.code`；`jobs.dedupe_key = automation-schedule:<ruleCode>` | `server/src/modules/automation/builtin-rules.ts` 的 `BUILTIN_RULES`（10 条） | 已落地（Push 268，`seeds/automation-rules.mjs`）：需先构建 server（读 `server/dist`）；只插入缺失规则、不覆盖库内 enabled / actions / version；按库内实际状态 reconcile 7 个 schedule job（启用 pending / 停用 done）；旧通用 job（dedupe_key IS NULL）置 done 保留行 |

> 待确认（#6a / #6b）：数据范围枚举按 v0.2 §4.1 六角色实际使用的五值先行（`all` / `managed_projects` / `involved_projects` / `own_stakeholders` / `granted`）；C3-02 措辞差（「本部门」未被任何角色使用、「自定义项目集」≈ `granted`）已登记《技术设计v0.3》§7.3 #16 —— h6 矩阵按五值落地、未新增角色；措辞收敛（补角色或改功能书表述）仍待业务 / px 确认。

## 验收口径（随实现）

- 空库迁移后连续执行种子两次：第二次零变更、无重复行（幂等）—— #6a 角色（Push 74）、#7 蓝图（Push 83）、#6b 权限矩阵（h6 · Push 95）、#5 地区 / 项目类型字典（h7 · Push 97：首次 inserted 2 / 11、复跑 0 变更）、#6b 补 `calendar.manage`（h8 · Push 99：inserted 1、复跑 0 变更，六角色 74 条 / 27 键）、#6b 补 `report.view` / `report.fill` / `issue.view` / `issue.manage`（M6-01 ~ M6-03 · Push 155：admin 27 → 31 键、矩阵 74 → 78 条；幂等与全量口径由静态门禁 `check:permission-matrix` 复核）已按此验证；**#11 演示数据（可选种子 · Push 189）**独立验：先建临时空库 → 34 个迁移 → 整跑默认集（日志明确「跳过可选种子 demo-projects」，库内 `projects` 仍 0 行）→ `--only=demo-projects` 首次 `regionsInserted 41 / projectsInserted 100`（4 行里 5 个经理用户名不在库里 → `managerFallback 5`，按兜底账号落库）→ 复跑 `regionsUnchanged 41 / projectsUnchanged 100`（零变更）→ `--with-optional` 整跑 7 个种子全 0 变更；**空库无账号时按约定报错并整体回滚**（`库里没有任何账号…`；回滚后 projects 0 / region 8 —— 验的是「不静默、不留半截」）；沙箱库 `--dry-run` 对账 `projectsInserted 0 / regionsInserted 0`（种子与库内那批演示数据逐条一致）；
- 2026-10-14 · Push 314 region 改口径复验（旧 8 条占位 → 201 国标准清单）：**空库全链**（临时库 → 迁移全量（含 0051）→ 复跑无漂移 → 整跑默认种子首次 `dicts typesInserted 2 / itemsInserted 204`、复跑 0 变更；region 恰 = **201**、洲分布 47 / 45 / 56 / 25 / 13 / 15、首条阿富汗（sort 10）/ 末条新西兰（2010）、英国 920 / 美国 1640 / 中国 470）＋ **存量沙箱**（迁移 0051 生效后 region 51 → 43（删 8 条占位；复跑 DELETE 0 行）→ `--only=dicts` 首跑 `itemsInserted 159 / itemsUnchanged 45` → region 202（201 标准 + 自建「阿联酋」保留）；复跑 0 变更；整跑 6 种子全 0 变更）；
- 2026-10-20 · M5-06-1A `automation-rules` 复验：空库迁移 `0001~0060` 后首跑 `rulesInserted 10 / jobsInserted 7`；二跑 `rulesUnchanged 10 / jobsUnchanged 7`（零插入 / 零更新）；启用集仍为 R02 / R03 / R05；7 个 per-rule job 状态与 enabled 一致；旧通用 job 由 seed 置 done（`legacyJobsRetired 1`，保留行）。`server/scripts/m5-06-1a-replay.mjs --migrate` 10/10 通过。
- 引用一致性：`node_requirements.doc_type` 与任务 `deliverable_types` 的取值全部命中成果文件字典（检查脚本随 M1 落地）；
- 蓝图校验：种子蓝图通过 v0.2 §3.4 全部校验，能生成 stages / nodes / requirements 全量；
- 业务确认项（#5 / #8 及 #3 的 SLA 时限）在回执前按占位值断言，回执后更新断言（#5 的 region 已回执 · 2026-10-14 · Push 314 = 201 国标准清单；projectType 与 #8 / #3 仍按占位值）。

## 与其它文档的关系

- `database/README.md`：迁移器、角色与权限（种子与迁移同角色执行）；
- `技术设计v0.2-架构与数据模型.md` §2.5（字典第一批）/ §3.3（节点清单）/ §3.4（蓝图校验）；
- `技术设计v0.3-实施与验收.md` §3.1（M0-03 卡片）/ §7.2 / §7.3（M0 决议与业务确认清单）；
- `docs/rules/`：R01~R07 文案（种子 #9 的逐字来源）。
