# project-import 模块（导入表 Excel 直连导入：preview 解析预览票据 + commit 单事务建项目写全量 · Push 316 / 319 / 321 / 324 / 347 / 349）

| 字段 | 内容 |
|---|---|
| 类型 | 领域模块（domain · 导入表导入） |
| 职责 | 项目空间「导入项目」按钮的服务端落点：xlsx 解析 → 导入表口径转换 → 预览报告（不写库）→ 30 分钟票据 → 确认导入（单事务建项目 + 任务 / 日报 / 问题 / 变更 / 干系人 / 图片 + 审计） |
| 主责 | wmj（后端 A：领域）；本刀由 px 跨线代记落实现（Push 316），**请 wmj 复核** |
| 预留对外接口 | `ProjectImportService`（preview / commit）+ `ProjectImportRepository`（票据 / 批量写入） |
| 依据 | 业务口径 2026-10-14（「导入项目」按钮 + 大屏面板 +「直连 API 导入」）；契约 `shared/src/modules/imports.ts`；《前端功能需求》§一.10 / §3.9；迁移 `0053_project_imports.sql` |

## 文件

```text
project-import.controller.ts  # HTTP 面：POST /api/v1/project-imports/preview（multipart 收流，不引 multer）+ /commit（JSON）；SessionGuard + CsrfGuard + ProjectAccessGuard + RequirePermission("project.create")；Accept-Language → zh / en 文案
project-import.service.ts     # 口径编排：preview = 文件闸 → 解析 + 转换 → 账号对账 + 节点归并 → 源文件留档（imports/<previewId>/source.<ext>）→ 票据；commit = 票据状态机 → 编号占用 → 图片先传对象存储 → 单事务写入（项目 / 蓝图快照 / 成员 / 补节点 / 任务 / 日报 / 问题 / 变更 / 干系人 / 文件）→ 审计 → 完工清理源文件 + 翻译预热；sweepExpiredPreviews = worker 每 10 分钟清理过期 pending 票据（先 purge 源对象，再置 expired；失败下轮重试）
project-import.repository.ts  # 数据访问：project_import_previews 票据（插入 / 取回 / 状态机 / 过期）与批量写入（task_nodes / project_members / tasks / reports / report_issues / change_requests / stakeholders / project_stakeholders / files；写路径由服务层开事务传 tx）
project-import.module.ts      # DI 装配：identity / permission / admin / project / template / translate；对象存储走全局 ObjectStorage 端口
xlsx.ts                       # 解析层（零依赖）：zip 解包（store / deflate，实际解压量受预算约束）+ sheet XML → 二维格 + 内嵌图锚点（cell → media）；XML 缓存与图片按需读取分开限量；支持 .xlsx / .xlsm
legacy.ts                     # 转换层（纯函数）：导入表 → 标准导入模型 + 提醒清单（进度五档 / 完成日期口径 / 日期笔误 / 节点拼装 / 变更阶段映射 / 干系人列解析 / 图片清单；message 中英双语）
people.ts                     # 人员注册表：姓名 → 拼音登录名 / 显示名（-test）建议；PEOPLE_REGISTRY + proposeAccount + stripParen
index.ts                      # 唯一公开出口（跨模块只允许 import 本文件；ADR-010 / g6）
```

## 已落接口

- `POST /api/v1/project-imports/preview`（multipart/form-data，字段 `file`）—— 解析 + 口径校验，**不写库**；返回预览票据（30 分钟）+ 落位建议 + 将写入条数 + 三份清单（需手动导入文件：`id` / `kind` / 任务或变更行 / 文件名 / 原因 / 节点匹配 / 账号）+ 提醒清单。
  错误面：400 `IMPORT_FILE_INVALID`（缺文件名 / 非 .xlsx·.xlsm / 空文件 / 超 256 MB）· 401 未登录 · 403 缺 `project.create` · 422 `IMPORT_PARSE_FAILED`（导入表结构不对 / 不是 xlsx / 超出解析资源预算）· 429 `RATE_LIMITED`（本实例已有导入在解析或提交）。
- `POST /api/v1/project-imports/commit`（JSON：`previewId` / `region` / `projectType` / `addMissingNodes`）—— 单事务建项目并写入全量数据（失败整批回滚，不许半量落库）。
  错误面：400 `VALIDATION_FAILED`（参数非法 / 地区空 / 票据已提交）· 403 票据非本人 · 404 票据不存在 · 409 `PROJECT_CODE_EXISTS`（编号占用）· 410 `IMPORT_PREVIEW_EXPIRED`（过期 / 源文件已清理）· 400 `IMPORT_CANCELLED`（写入中取消：连接在写完前断开 —— 单事务回滚 + 已传图片清理；票据保留 pending、源文件保留，可再次提交）。
- `POST /api/v1/projects/{id}/import-manual-files/attach-change`（JSON：`changeId` / `fileId`）—— 导入补充附件回挂变更：文件首版本写 `file_versions.change_request_id` + 文件定档 + `file_links(change)`；同一变更重复调用幂等（204）；一期「一变更一版本」：变更行 `FOR UPDATE` 串行化后先查该变更已有版本，同一变更已有其它文件 / 文件已挂其它变更 400，项目 / 文件 / 变更不匹配 404。

## 口径铁律（与前端 / 导入表转换工具一致）

- 进度：完成日期未填 = 不算完成（进行中封顶 75%）；五档 0 / 0.25 / 0.5 / 0.75 / 1 就近取档；待开始归零。
- 日期笔误（完成早于开始 / 开始晚于预计完成）照原值导入 + 提醒（`DATE_ORDER` / `DATE_ORDER_END`）。
- `tasks.on_time` = 源表「是否按时交付」原值（按时交付 true / 延期交付 false / 空 null；与日期推导不一致 → `ONTIME_MISMATCH` 提醒，不改值）。
- 任务节点：无对应按文件原名导入；`nameEn` = 节点库 `task_nodes.title_en` ?? 源表英文列；勾选补库且阶段范围内才写 `task_nodes`（阶段外按临时任务、不补库）。
- 变更：阶段映射 实施 → `install`、发货 → `assembly`；内容 / 原因合并落库（占位 = 内容待补 / 原因待补）。
- 变更关联（Push 319）：变更管理「关联」列（多值按逗号 / 顿号拆）按任务描述匹配（键 = 去全部空白 + 小写；对「标题+英文名」/「标题」/「英文名」三串）→ 提交事务回写 `tasks.change_refs`（追加序 = 变更表行序、去重）；未命中 / 多命中 / 日期不一致 / 任务侧落空出提醒（`CHANGE_RELATED_UNMATCHED` / `CHANGE_RELATED_AMBIGUOUS` / `CHANGE_DATE_MISMATCH` / `TASK_CHANGE_REF_UNMATCHED` + 汇总 `CHANGE_LINK_SUMMARY`），照常导入不阻断；预览 / 结果 counts 增 `changesLinked`。
- 问题处理人（Push 319）：源表没有处理人字段 —— 未解决（open / in_progress）默认 `owner_id` = 项目经理首位（`managerIds[0] ?? actorId`；done = null）+ info 提醒 `ISSUE_OWNER_FALLBACK` —— 未解决问题随项目经理进入工作台「待我处理」，「我提出的问题」按 reporter（日报作者）照旧。
- 变更读面（Push 319 · file 模块）：导入遗留变更没有 `file_versions` 行 —— 列表 / 详情 `fileId` / `versionId` / `versionSeq` 可为 null（`file` / `version` 给 null，前端标「变更后文件待补」）；本模块提交只写 `change_requests` 行、不建文件行。
- 图片：表内嵌图 → 文件库（日报现场图 / 问题图挂 `file_links`；变更表「变更前 / 变更后」列内嵌图（Push 349）登记 `files` 后回填 `change_requests.before_summary_file_ids` / `after_summary_file_ids` —— 同 0052 应用内口径：不落 `file_links`、单条 ≤ 30 张）；微盘 / 本地路径 → 「需手动导入」清单（导入时不再抓取）；Push 396 起面板可就地选文件，提交结果按 `manualTargets` 回传任务 / 变更 id，前端用现成分片直传挂任务，`change_after` 再调回挂接口写 `file_versions.change_request_id`。
- 变更附图（Push 349 · 业务口径 2026-10-16「变更记录也是有图片的这个也要导入的」）：锚点按「变更前 / 变更后」列（表头定位、缺列 = 不识别）与行号（1 based = 变更表行）对变更记录；文件命名「变更前附图 <YYYY-MM-DD / 日期待补> NN.<ext>」/「变更后附图 …」；只有图没有文字的变更行同样建记录（内容 / 原因空 = 占位）；列外 / 表头行锚点出 warning `CHANGE_IMAGE_UNPLACED` 不导入；行对不上 / 媒对象缺失 / 单条变更附图超 30 张计入 `IMAGE_ROW_MISSING` 提醒（不阻断）。
- 干系人（Push 324）：导入表「干系人」sheet导入表没有该表 = info `STAKEHOLDER_SHEET_MISSING` 照常导入）；写库 = 台账 `stakeholders` + 项目关联 `project_stakeholders` 同批（单事务）；姓名必填（空行跳过）；公司自由写法 → 四值 + 具体公司名（识别不出按 `customer` 兜底 + `STAKEHOLDER_COMPANY_UNMATCHED`）；联系方式含「微信 / WeChat / weixin」→ `wechat`、否则整段落 `phone`；「填写者」按显示名匹配（原文 / 去括注 / 去括注 + `-test`），未命中 `created_by` 留空 + `STAKEHOLDER_FILLER_MISSING`；「提交时间」→ `created_at`（当天 00:00 UTC；缺 = 导入时间）；超长截断（name 80 / company 120 / title 80 / phone 40 / wechat 64 / role 80、email 3..120）。
- 变更申请人 / 填写者（Push 347 · 迁移 `0054`）：「变更管理」表的「变更申请人」「填写者」两列按显示名三路匹配库内账号（原文 / 去括注 / 去括注 + `-test`，与干系人「填写者」同口径；`resolveByDisplayNames` 由干系人填写者解析泛化）—— 申请人命中 = `change_requests.applied_by`（未命中回落导入人 + warning `CHANGE_APPLICANT_MISSING`）、填写者命中 = `change_requests.writer_by`（未命中留空 + info `CHANGE_WRITER_MISSING`）；预览 / 结果两处提醒；旧表缺「填写者」列 = 空、不提醒。
- 大文件内存口径（2026-10-19）：multipart 有 `Content-Length` 时按声明长度一次预分配并直接切片，不再保留 chunks + concat 双份；预览只解析 XML / 图片锚点，不解压图片；提交从对象存储取回源 ZIP 后逐张解压、哈希、上传，图片字节不进入解析缓存或落库计划。XML 单条 / 缓存 / 图片单张 / 图片总量与行列 / 单元格总量均有预算（默认 96 MB / 256 MB / 64 MB / 1 GB、200000 行 / 256 列 / 单表 500 万格 / 全簿 1000 万格）；同一 API 实例同时只允许一个 preview / commit，后到请求 429。
- 写入取消（Push 321）：`commit` 收 AbortSignal（controller 把「响应连接在写完前断开」—— 取消写入 / 刷新 / 关页 / 断网 —— 转 abort）；检查点（读源文件前 / 图片上传每轮 / 事务首行 / 补节点循环每轮 / 各批量写入（任务 / 日报 / 问题 / 变更 / 文件）/ 审计记录前 / 票据落定前）命中即抛 400 `IMPORT_CANCELLED`：**单事务回滚 + 丢弃本次已上传图片对象**；票据保持 pending、源文件保留（可再次提交）；响应已正常写回时不触发。
- 账号：只对账不建号（登录名 = 拼音、显示名 = 中文名 + `-test`、初始口令 123456 属账号体系口径；**自动建号仅测试环境需要** —— 正式环境用户目录完整、不需要自动创建）；缺号 → `ACCOUNT_MISSING`，项目经理 / 负责人 / 日报作者缺号回落导入人并提醒（`MANAGER_FALLBACK` / `OWNER_MISSING` / `AUTHOR_MISSING`）。
- 地区：`commit.region` 必填（面板选，201 国口径）；项目类型按源表关键字识别（AIRROB → 飞箱）可留空。
- 提醒文案按 `Accept-Language` 出中 / 英（zh 缺省）。

## 上游（直接复用，不重复造）

- `project`：项目插入（预留主键 uuid）/ 蓝图快照 `FlowService.importSnapshot` + `setStageKey` / 成员名册 `ProjectMemberRepository`。
- `template`：任务节点库读（匹配 / `title_en`）与补库写。
- `admin`：审计留痕（项目一条 + 每个新节点各一条）。
- `translate`：项目名后台翻译预热（`translate.warmup`）。
- 对象存储：全局 ObjectStorage 端口（源文件 `imports/<previewId>/source.<ext>`；图片按 `buildObjectKey` 规范键）。

## 测试

- `server/test/xlsx-limits.test.ts`（6 用例）：超大坐标 / 稀疏矩形单元格预算 / XML 解压上限（含 ZIP 头部低报实际大小）/ 图片总量逐张累计 / sharedStrings 十进制与十六进制 XML 字符实体解码（含 `&#10;` 单元格换行）。
- `server/test/import-http-limits.test.ts`（3 用例）：`Content-Length` 预分配、multipart 文件切片零复制、并发 preview / commit 闸门 429。
- `server/test/project-import.test.ts`（21 用例）：自带最小 xlsx 构造器（zip store + inlineStr + 图片锚点）—— 解析口径 / zh·en 文案 / 文件闸 400·422 / `IMAGE_ROW_MISSING` / commit 主链路（`taskNodeId` / `sortIndex` / 图片挂问题 / 回退提醒 / purge / warmup / 审计）/ 账号在库直挂 / 不勾选补节点 / 票据状态机（403 / 409 / 410 / 400）/ **变更关联（Push 319：解析命中与提醒码 / 提交回写 `change_refs`）** / **未解决问题默认处理人（含 done 不挂人）** / **写入取消两例（Push 321：上传途中 abort → 已传图片清理 + 票据 pending + 重提成功 + 源文件保留；事务内 abort → 回滚 + 已传图片全清）** / **过期票据清扫（Push 325：删除源对象成功置 expired；删除失败保留 pending 下轮重试）** / **干系人两例（Push 324：导入表内嵌转换（分类四值 / 联系方式拆分 / 提交时间）；导入表缺表 info 提醒，不导入干系人；提交写台账 + 项目关联（分类 / 提交时间 / 填写者匹配账号））** / **变更申请人·填写者（Push 347：源表「变更申请人」「填写者」两列命中库内账号 → `applied_by` / `writer_by`；未命中 = 回落导入人 / 留空 + `CHANGE_APPLICANT_MISSING` / `CHANGE_WRITER_MISSING`）** / **变更附图（Push 349：解析锚点列 / 行映射 + 列外提醒；提交落 files 并回填 change_requests 两列）**。
- `server/test/resource-change.test.ts`：commit 的资源变更登记（projects / tasks / reports / issues / files / templates）。

## 待落地

- 「账号新建」由账号体系落地（SSO 登录创建）—— 预览面板的「新建」徽标只是提示，本模块不建号；自动建号仅测试环境需要（正式环境用户目录完整、不需要）。
- Push 319 三件（变更关联回写 / 问题默认处理人 / 变更读面宽容）随下次部署件上线后真机复验（工作台「待我处理」/ 变更记录可见性 / 任务行变更关联徽章）；Push 321 写入取消已在本地沙箱真机端到端（中断落在图片上传中途 → 库 / 桶零残留 + 票据 pending + 源文件保留 + 同票据重提 200 + 收尾恢复基线）；更早的真机端到端见 Push 316（37 断言 0 失败 + 迁移 `0053` 实执行）。Push 324（干系人随导入）：服务端用例 18/18 + 转换工具冒烟（单表干系人文件 6/6 行；UK 表主数据回归 0 差异）；写库链路的真机端到端待下次部署复验。
