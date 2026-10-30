# ONLYOFFICE 替换执行计划（Office 预览 · 首关 → 切换）

> **2026-10-28 移动端预览修订（已发布）**：PDF 撤出 ONLYOFFICE 查看器通道，改「服务端直签原件 + 前端 PDF.js 本地分页」；Word / Excel / PPT / 文本族仍由 ONLYOFFICE 承接。DocServer 四个编辑器模板内建 30 秒硬超时随镜像延长至 120 秒，宿主 90 秒先降级；2026-10-28 13:56 已随 `prod-20261028-mobile-preview-cdb6eb5d` 发布正式环境，移动端纳入本链路验收。

> **2026-10-21 CAD 边界更新**：本计划“CAD 不动”为历史 Office 替换边界；CAD 后续由 [ADR-035](adr/ADR-035-CAD接入与旧浏览器解析链移除.md) 和 [接入基线](CAD平台接入基线与迁移任务.md) 承接，旧实现撤下、平台暂不可预览并保留下载。Office 路线不变。

> **唯一执行口径**：本文件是「Office 文档预览改由 ONLYOFFICE 承接」的唯一执行口径（2026-09-30 由 lan 指定）；后续执行过程中的任何变动**直接修改本文件**并登记「变更记录」，不另开会话口径、不另立清单。
> 卡片：主责 lan；协办 wmj（契约 / ADR）、px（部署 / 前端 / 交付）；业务口：样本与验收。
> 计划内审核（2026-09-30 起）：本计划（仅限本计划范围）由 lan 全权负责 —— 计划内审核与变更由 lan 执行并登记；跨线实现仍按分工路由。
> 关联：首关证据 `docs/PoC-10-回放证据(ONLYOFFICE查看器·首关).md`；保真度证据 `docs/PoC-10-回放证据(ONLYOFFICE查看器·保真度).md`；安全定稿 `docs/PoC-10-安全定稿(R1-R2·受控下载端点).md`；部署前置定稿 `docs/PoC-10-部署前置定稿(F1-R3·R6).md`；S1 契约切片 `docs/契约切片草案(S8-2-ONLYOFFICE查看器).md`（px 代 wmj 线起草 · Push 241 / PR #251 先入 `main`；**已定案**（wmj · 2026-09-30 · lan 代行登记））；治理件 `docs/adr/ADR-030-Office预览改由ONLYOFFICE承接.md`（wmj 线 Push 238 / PR #247 先入 `main`）；S3 回放证据 `docs/s8-2-回放证据(S3·受控预览端点).md`（Push 194 / PR #255 / squash `35490f3`）；分工卡 `团队分工.md` §6 第 10~11 项；S6 退役评审 `docs/s6-退役评审(LibreOffice转换栈).md`。

## 0. 已定决策（冻结，勿再翻）

| # | 决策 | 拍板 |
|---|---|---|
| D1 | 形态 = 在线查看器（`editorConfig.mode="view"`）；**不做在线编辑**；不采用 Conversion API 形态 | lan，2026-09-30 |
| D2 | 镜像 `onlyoffice/documentserver:9.4.0.1`（digest `sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212`，pin；回退规则 9.3.1.2 未触发） | lan，2026-09-30 |
| D3 | 合规：自托管满足「不经第三方软件」；AGPL 社区版获法务 / 采购接受 | 业务 / 法务，2026-09-30 |
| D4 | 范围：Office 文档预览链路（Word / Excel / PPT / 文本族）；图片直通、下载链（仍签原始对象 + download 审计）、CAD、审计口径不动。**业务修订（2026-10-08）：PDF 暂并入 ONLYOFFICE 查看器通道；图片直通 / 下载链 / CAD / 审计口径仍不动；图片直通载体迁移（S6 前置）见 D6**【2026-10-23 修订：预览恢复实际送达写审计，见 v1.19】**；【2026-10-28 移动端修订：PDF 撤出 ONLYOFFICE，改直签原件 + 前端 PDF.js；移动端纳入验收，Office 仍走查看器】 | 业务，2026-09-30；PDF 并入 2026-10-08；PDF 撤出 2026-10-28 |
| D5 | 兜底：`deploy/preview`（LibreOffice）不退役，与 ONLYOFFICE 并存至切换完成；失败降级「请下载」保留 | lan，2026-09-30 |
| D6 | 图片直通迁移（S6 前置）：图片预览改**原对象短时签名直签**（不投转换任务、不落产物行、不经 `deploy/preview`）；显示 / 审计（一条 `action = preview`）【2026-10-23 恢复：实际送达一条 `action = preview`，见 v1.19】/ 下载链口径不变；完成后 `deploy/preview` 归零消费者，S6 退役方可执行 | lan，2026-10-08 |

## 1. 路线总览（状态机）

| 阶段 | 内容 | 状态 | 出口判据 |
|---|---|---|---|
| **首关** | 三件可能杀方案的事：20/50 并发与资源曲线；JWT 只读不可绕；中文字体与内网拓扑 | ✅ 已完成（2026-09-30，服务端侧通过） | 三项全过（证据归档） |
| **次关** | N1 保真度抽查；N2 R1/R2 安全定稿；N3 实施前置定稿（F1/R6 + ADR-030） | ✅ 已完成（2026-09-30：N1 ✅ / N2 ✅ / N3 ✅；出口达成 = 随 PR #246 合入 `main`，squash `f8c762c`） | N1 达标 + N2/N3 定稿并入 ADR-030 / 部署清单 |
| **实施** | S1 契约切片 → S2 `deploy/onlyoffice` → S3 server 改造 → S4 前端文件库 → S5 回归与双轨（含 R4 门禁）→ S6-前置 图片直通迁移（D6）→ S6 退役 LibreOffice | ✅ 已完成（S1 ✅ 定案 · S2 ✅ 已交付 · S3 ✅ 已交付（PR #255 已合并）· S4 ✅ 已交付（px 线 · 回放 21/21 · 合并收口已回填：squash `cc63d3e` · 双 CI 四 job 全绿）· 范围修订 2026-10-08：PDF 并入查看器通道（PR #268，见 v1.12）· S5 ✅ 已完成（R4 达标 · 见 v1.13）· S6-前置 ✅ 已交付（图片直通迁移 · Push 201 · 回放 14/14 + 前端 11/11 · 见 v1.15）· S6 ✅ 已完成（退役 LibreOffice · 退役评审通过 · 2026-10-08 · 见 v1.16）—— 实施切片全收官） | 各切片出口见 §4 |

> 口径说明（防漂移）：会话历史里曾出现两种旧口径——① 11:20「次关 = 保真度、契约切片、部署改造」（过宽，含实施项）；② 证据文档初版「次关 = outbox / 受控下载端点 / 生产部署态复测」（过窄，只含遗留收口）。**本文件为准**：次关 = 实施前置收口（N1~N3）；契约切片与部署改造归入实施切片（§4）。原 09:48「完整 PoC-10」中的移动端项随 D4 移除。

## 2. 首关（已完成，2026-09-30）

- **A 组 · 并发**：2C4G 下 20/20 全部就绪（p50 ≈ 7.1s）；50 并发四轮 ready 37~42/50，失败全部归因回放客户机侧（无头 Edge 多实例 `net::ERR_ABORTED` → RequireJS 卡载 / 浏览器进程转储）；服务端全程零错误、零饱和（CPU ≤1.2 核 / 内存 <0.9GB），4C8G 复跑曲线同形 → 排除资源型。
- **B 组 · 只读不可绕**：8/8 拒绝（无 token / 篡改不重签 / 换密钥 / `alg=none` / 过期 / 越权直连）；b6 深测：客户端外观可篡、服务端权限拒绝、同 key 重开零持久。
- **C 组 · 字体与拓扑**：装 Noto Sans CJK SC + `generate-allfonts` 后中文闭环；DocServer 从内网 `libiaolink-minio:9000` 拉取 200、环回反例 000。
- **判定：通过（服务端侧）**；遗留 R1~R6 见 §5。证据（含仓外附件 sha256 与复现要点）：`docs/PoC-10-回放证据(ONLYOFFICE查看器·首关).md`。

## 3. 次关（进行中；实施前置收口）

### N1 保真度抽查（最高优先） —— ✅ 已完成（2026-09-30；构造样本口径）
- **目的**：给出「替换后不差于现行 LibreOffice→PDF 方案」的量化底账（业务验收线）。
- **样本（口径变更）**：业务反馈无法提供真实样本（2026-09-30）→ 经授权由实施方**自建 5 份确定性构造样本**（`server/scripts/poc10/fixtures/`，生成器 `make-n1-samples.py`；覆盖 xlsx 多 Sheet / 公式 / 图表 / 条件格式 + docx 复杂版式 / 长文档分页 / 红头公文，含中文字体面）；字节级确定性（sha256 manifest 随附）。**追加口径**：业务后续如能提供真实文件，按同法追加 1~2 份抽样复核（可选）。
- **方法**：同一文件双侧比对 —— ONLYOFFICE 查看器（fidelity 回放：逐 Sheet 切换 / 逐页翻页截屏 + 帧内 DOM 探针）vs 现行 LibreOffice→PDF（`deploy/preview` 转换 + 栅格化）；逐项记录：版式 / 公式（含数值独立复算）/ 图表 / 条件格式 / 字体（宋·黑）/ 分页。
- **判据**：无「内容性失真」为达标；如有，评估降级路径（structured 二期 / 降级「请下载」）并与业务定夺。
- **结果**：5/5 达标、**无内容性失真**；差异 D1~D5（分页点 / 断行点 / 印章缩放 / 生成器图表 XML 缺省样式（已修）/ UI 提示）与夹具修正 FIX-1~3 全登记（证据 §4 / §5）。
- **产出**：`docs/PoC-10-回放证据(ONLYOFFICE查看器·保真度).md`（已入库）。
- **主责**：lan；协办 px；业务确认达标线（本轮回放以构造样本 + 双侧比对方式执行）。

### N2 R1/R2 安全定稿 —— ✅ 已完成（2026-09-30）
- **R1**：定稿 = **a) 受控下载端点**（与 R2 合并设计）——查看器 `document.url` 指向本仓受控端点；端点凭 DocServer outbox `Bearer JWT` 鉴权（HS256 共享密钥 + `payload.url` 逐字绑定 + ≤300s），服务端 SDK 流式读对象；**预览链全程无预签名**。备选 b 不再采用；若 S3 实施受阻须回本文件重开定稿（登记变更记录），不得静默降级。
- **R2**：冻结约束照旧（禁止 MinIO 预签名与 outbox 同开）+ 设计归位本定稿；**实现随 S3**——受控端点取代预签名后该组合不复存在，生产 `outbox=true` 常开（鉴权依赖，F3「重启改回 true」由事故变为期望态）。
- **产出**：`docs/PoC-10-安全定稿(R1-R2·受控下载端点).md`（含 ADR-030 / 部署清单待并入段落、离线 JWT 验证 3/3、S1/S3/S5 归位）。
- **主责**：lan；**计划内审核完成（2026-09-30）** —— 契约草案（新增受控端点路由 + `FilePreviewResponse` 查看配置 / JWT 改造）与残余风险接受均通过（附条件 C1~C6 / D1~D4，见定稿 §7）；S1/S3 按实施切片落地。

### N3 实施前置定稿 —— ✅ 已完成（2026-09-30）
- **F1/R3 定稿**：固化键 `services.CoAuthoring.externalRequest.action.blockPrivateIP=false`（决定键）+ `request-filtering-agent.allowPrivateIPAddress=true`；落地方式 = 镜像构建期模板 / 挂载 + **启动后自检**（不得依赖手工改容器）；`token.enable.request.outbox=true` 为期望态（沙箱「保持 false」口径不再沿用）；中文字体生成入构建；**升级 / 重建回归清单五项**（① blockPrivateIP 生效 ② outbox=true ③ 中文字体 ④ 受控端点 401 基线 ⑤ 示例 app 关闭）；ADR-030 所列「升级回归三项」为本清单安全子集，以定稿 §1.3 为准。
- **R6 定稿**：示例 app 保持默认关闭 + 网关不暴露 `/example/`；S5 验收断言（网关侧 `GET /example/` 非 200 且无示例页面；直连容器 502 为合规）。
- **产出**：`docs/PoC-10-部署前置定稿(F1-R3·R6).md`（并入路径 S2 / S5）；**ADR-030 已立**（`docs/adr/ADR-030-Office预览改由ONLYOFFICE承接.md`，wmj 线 Push 238 / PR #247 先入 `main` —— 本线原起草重复稿按「先入 main 者为准」撤销、引用改指；ADR-007 → Superseded；ADR-013 / ADR-017 修订随件；`系统功能书.md` D2-01 同步登记为跨线待办）。
- **次关出口**：N1 达标 + N2/N3 定稿随 ADR-030 合入 `main` → 解锁实施（**已达成**：PR #246 合入 `main`，squash `f8c762c`）。

## 4. 实施切片（次关通过后执行；R4/R5 在此归位）

| # | 切片 | 内容 | 主责 | 出口判据 |
|---|---|---|---|---|
| S1 ✅ | 契约切片（**S8-2** —— 定案编号；px 代 wmj 线起草 → 已定案） | `FilePreviewResponse` 增查看配置 / JWT；`PreviewTarget` 语义；`preview_artifacts` / `preview.job` 去留；**已合入 + 已定案**：`docs/契约切片草案(S8-2-ONLYOFFICE查看器).md` + `shared/` 契约与生成物（Push 241 / PR #251 / squash `00dbdc3`；六项口径 + 3 条补充答复定案见草案 §三 —— wmj · 2026-09-30 · lan 代行登记） | wmj（lan 代行登记） | ✅ 契约 + 生成客户端合入（S8-2 定案登记） |
| S2 ✅ | `deploy/onlyoffice/` | 部署形态（pin digest / 字体 / `blockPrivateIP` / 示例 app / 安全基线：callback 校验、缓存盘清理、CVE 升级路径）；**已交付**：Push 240 / PR #250 / squash `3c74300` | px | ✅ 部署清单 + 回滚步骤 + 升级回归项（PR #250 已合并 · 2026-09-30） |
| S3 ✅ | server 预览读改造 | 签发 view-only JWT；受控下载端点（N2 采纳）；文本族（txt / csv / html / htm）纳入查看器通道；契约描述补全（响应头 / 错误码，随刀）；**已交付**：Push 194 / PR [#255](https://github.com/256-code/LibiaoLink/pull/255) / squash `35490f3` —— 受控预览端点 + 查看器配置签发 + 文本族通道 + 契约描述补全（单测 786/786 · 真机回放 12/12 含 DocServer 真机拉取转换；证据 `docs/s8-2-回放证据(S3·受控预览端点).md` / `.json`） | lan | ✅ 单测 + 回放证据（PR #255 已合并） |
| S4 ✅ | 前端文件库预览页 | 内嵌查看器外壳（**R5**：超时 / 重试 / 文案 + 降级「请下载」）；**已交付**：Push 245 / PR [#264](https://github.com/256-code/LibiaoLink/pull/264) / squash `cc63d3e`（回放 21/21；证据 `docs/s4-回放证据(ONLYOFFICE查看器外壳·前端).md`） | px | ✅ 回放证据（PR #264 已合并） |
| S5 ✅ | 回归与双轨 | 全量回归 + 部署环境复测（**R4 门禁**：50 并发（含受控预览端点内存核查）、真实终端、CE 许可行为）+ 文本族抽样（1~2 份）+ **PDF 查看器通道回归（2026-10-08 业务修订）** + 灰度；**已完成（2026-10-08 · lan）**：R4 门禁 50 并发全过（docx 25 + pdf 25 字节全等 · p95 134ms · 内存 Δduring +12MB / 静置回落 · 无泄漏）+ S3 回放 12 项 + PDF 端到端（ready/documentType=pdf/转换 `%PDF-`）+ 双轨并存（LibreOffice 9900 healthz 200）+ 部署侧五项与 R6 核验 + CE 许可行为核验 + 既有门禁（server 791 例 / boundaries / db-schema / 契约零漂移 87 / 240 / 前端 typecheck + build）；证据 `docs/s5-回放证据(回归与双轨·R4门禁).md` + `docs/s5-R4并发报告(受控预览端点50并发).md` + `server/scripts/s5-r4-preview-burst.mjs`；未覆盖项（真实终端人工点检 / 生产网关拓扑复验 / ⑤ 401 计数本次 SKIP）已登记 | lan | ✅ R4 报告达标（0 遗留断言；未覆盖项已登记） |
| S6-前置 ✅ | 图片直通迁移（预览） | 图片预览改**原对象短时签名直签**（不投转换任务、不落产物行、不经 `deploy/preview`；字节 = 原对象；前端 `url` 通道与缩略图零改动；显示 / 审计 / 下载链口径不变；响应形状不变） | lan | ✅ 已交付（2026-10-08 · Push 201）：`previewTargetsFor` 归零（structured 二期恢复的挂账注释保留）+ 读面图片 `isImageFile` → `serveImageDirect` 原对象短时签名（`target=image`、`pipelineVersion` / `generatedAt` 空；产物三态段保留）；回放 14/14（`deploy/preview` 停机态：字节与夹具全等 / 零投递 / 零产物行 / 审计恰一条 / 版本路由 v1·v2 不串 / PDF 对照）+ 前端 11/11（缩略图与大图浮层实测原对象签名地址渲染 + 截图）；证据 `docs/s6-pre-回放证据(图片直通·原对象直签).md`；PR [#272](https://github.com/256-code/LibiaoLink/pull/272) / squash [`c5b568d`](https://github.com/256-code/LibiaoLink/commit/c5b568d6fd138da554167008453d44d213cc3bec)（已合并 · 2026-10-08；PR CI 37739388391 / main CI 37740018891 四 job 全绿） |
| S6 ✅ | 退役 LibreOffice | 业务确认后退役 `deploy/preview`（**前置 = S6-前置 ✅（Push 201）**） | px（lan 代做 · 请 px 复核） | ✅ 已退役（2026-10-08 · Push 203）：退役评审通过（`docs/s6-退役评审(LibreOffice转换栈).md` —— 消费者归零核查 6 项 / 风险评估与回滚 / 遗留移交）+ `deploy/preview` README 退役状态行 + `server/README.md` / `server/.env.example` 注记 + 环境 compose down（容器移除、镜像保留）；PR [#274](https://github.com/256-code/LibiaoLink/pull/274) / squash [`4cd2fd3`](https://github.com/256-code/LibiaoLink/commit/4cd2fd30c4718a260cb5f8235ab7e42dc201525b)（已合并 · 2026-10-08；PR CI 37745838996 / main CI 37746631459 四 job 全绿） |

> **S3 遗留（v1.9 登记；明细见证据文档「未覆盖 / 风险登记」；v1.10 挂账落点）**：① 受控端点暂整读对象进内存（流式读取 + 大文件护栏记后续切片）→ **落点：S5 门禁核查（50 并发内存表现）+ 后续切片（分段流式 + 大小护栏）**；② 405 / 503 走 Nest 异常信封（HTTP 状态码正确、无契约专属错误码，由 unit 覆盖）→ **落点：契约变更（wmj 线）**；③ 401 暂以逐条 warn 日志替代 M5 告警出口 → **落点：M5（`技术设计v0.3-实施与验收.md` §4.10「会话与 401 突增」）**；④ Range / HEAD 未覆盖（DocServer 后续版本若出现，回 `docs/PoC-10-安全定稿(R1-R2·受控下载端点).md` §3.2 补全）→ **落点：DocServer 升级回归核查（联动 `deploy/onlyoffice` 升级回归项）+ 出现即回安全定稿 §3.2 补全**。

## 5. 风险归位表（R1~R6）

| # | 风险 | 现状 | 处置 | 落点 |
|---|---|---|---|---|
| R1 | 预签名 TTL 可绕 `download=false` | 定稿完成（去预签名） | 受控下载端点（a，与 R2 合并设计） | N2 ✅ → S1·S3 |
| R2 | outbox × 预签名冲突 400 | 定稿完成（约束 + 设计） | 禁止同开；受控端点取代预签名（outbox 常开、鉴权依赖） | N2 ✅ → S2·S3 |
| R3 | `blockPrivateIP` 属运行时配置 | 定稿完成 | 部署清单固化 + 升级回归（五项） | N3 ✅ → S2 |
| R4 | 50 并发生产复测 | ✅ 已达成（S5 · 2026-10-08） | 部署环境复测（真实终端） | S5 门禁 |
| R5 | 前端错误 UX（白屏无重试） | ✅ 已达成（S4 外壳 · 回放 21/21） | 外壳超时 / 重试 / 文案 | S4 |
| R6 | 示例 app（`ds:example`） | 定稿完成 | 保持默认关闭、不暴露 `/example/` + S5 验收断言 | N3 ✅ → S2·S5 |
> 收口（S6 退役评审 · 2026-10-08）：R1~R6 落点全闭环 —— R4 ✅（S5 门禁）/ R5 ✅（S4 外壳）/ R6 ✅（N3 → S2·S5）；R1~R3 定稿随 N2 / N3 与 S2 / S3 落地。

## 6. 变更记录

| 版本 | 日期 | 变更 | 人 |
|---|---|---|---|
| v1.0 | 2026-09-30 | 首版：冻结 D1~D5；首关结果归档；次关重定义为 N1~N3（去移动端）；实施切片 S1~S6 与 R1~R6 归位；「唯一执行口径」机制生效 | lan |
| v1.1 | 2026-09-30 | N1 完成（✅）：样本来源变更（业务无法提供真实样本 → 实施方自建 5 份确定性构造样本，2026-09-30 授权）；5/5 达标、无内容性失真；差异 D1~D5 与夹具修正 FIX-1~3 登记；保真度证据文档入库；预留「真实样本追加抽样」口径；次关状态更新为「进行中（N1 ✅ / N2·N3 待执行）」 | lan |
| v1.2 | 2026-09-30 | N2 完成（✅）：R1 定稿受控下载端点（a；备选 b 不再采用）、R2 定稿（冻结约束 + 设计归位 + outbox 常开）；离线 JWT 验证 3/3（HS256 / `payload.url` 逐字绑定 / TTL 300s）；定稿文档 `docs/PoC-10-安全定稿(R1-R2·受控下载端点).md` 入库；次关状态更新为「进行中（N1 ✅ / N2 ✅ / N3 待执行）」 | lan |
| v1.3 | 2026-09-30 | **计划内审核**（lan 全权负责范围内）：N2 契约草案 + 残余风险接受均通过（附条件 C1~C6 / D1~D4）；新增证据 E5（鉴权判别矩阵 6/6）；计划头补「计划内审核」口径；N2 主责行注记同步（定稿 §7） | lan |
| v1.4 | 2026-09-30 | N3 完成（✅）：F1/R3 定稿（固化键 / 落地方式 / outbox 期望态 / 字体 / 升级·重建回归五项）、R6 定稿（默认关闭 + 网关不暴露 + S5 验收断言），产出 `docs/PoC-10-部署前置定稿(F1-R3·R6).md`；ADR-030 立（wmj 线 Push 238 先入 `main`，见 v1.5 收口）；次关状态更新为「进行中（N1 ✅ / N2 ✅ / N3 ✅ 2026-09-30；待合入 `main` 达成出口）」 | lan |
| v1.5 | 2026-09-30 | **并入 `main` 收口（二次并）**：ADR-030 认 wmj 线稿（`docs/adr/ADR-030-Office预览改由ONLYOFFICE承接.md`，px 代起草 · Push 238 / PR #247 先入 `main`；按「先入 main 者为准」），本线重复件撤销、关联行 / N3 段引用改指；一致性核对 = 决策内容（D1~D5 / 边界 / 不变量 / 切换条件）与 wmj 线稿一致、无决策性缺失；升级回归口径 = ADR 三项为定稿五项之安全子集；ADR-030 状态转「已采纳」按 ADR 线惯例（本线不代改） | lan |
| v1.6 | 2026-09-30 | **次关出口达成（✅）**：本计划随 PR #246 合入 `main`（squash `f8c762c`；PR CI run 36685367035 / main CI run 36685556447 四 job 全绿）；N1 / N2 / N3 全闭环 → 实施切片 S1~S6 解锁（S1 契约 = wmj 线、S2 部署 = px 线、S3 = lan 线） | lan |
| v1.7 | 2026-09-30 | **S1 / S2 认稿与对齐（lan 线）**：S2 已交付 —— `deploy/onlyoffice/`（Push 240 / PR #250 / squash `3c74300`；出口 = 部署清单 + 回滚 + 升级回归项）；S1 契约切片由 px 线代 wmj 起草并合入 `main`（Push 241 / PR #251 / squash `00dbdc3`；草案 `docs/契约切片草案(S8-2-ONLYOFFICE查看器).md`；`viewer` 与受控端点路由落 `shared/`，paths 86→87 / schemas 233→239）—— 本线并行起草的 S8-6 草案**撤销（未推送）**，按「先入 `main` 者为准」先例转认稿 + 复核意见（投 PR #251 评论：文本族边界 / 响应头与错误码补全 / 查看器 token TTL）；实施状态转「S1 待 wmj 定案 · S2 已交付」；ADR-030「参考」补 N3 定稿引用（lan 提请，wmj 复核） | lan |
| v1.8 | 2026-09-30 | **S8-2 定案（wmj · 2026-09-30 · lan 代行登记 —— 经用户与 wmj 协商）**：六项口径全按推荐定案（`preview-content` 不落别名 / `viewer` 必填可空 / `PreviewTarget` 不新增值 / 四段显式 schema + token / `preview_artifacts`·`preview.job` 保留 / token TTL 900s）+ 3 条补充答复（文本族纳入查看器通道 / 响应头与错误码以安全定稿 §3.2 为准 + 契约描述补全随 S3 / TTL 维持 900s）；**S1 出口达成**（契约与生成物已随 PR #251 合入 + 定案登记）；实施状态转「S1 ✅ 定案 · S2 ✅ 已交付 · 下一刀 S3」 | lan |
| v1.9 | 2026-09-30 | **S3 交付（lan 线）**：server 预览读改造落地 —— 受控预览端点（outbox Bearer HS256 校验 / 401 六反例统一同形 / 无重定向 / fail-closed）+ 查看器配置签发（view-only JWT 900s、全程无预签名）+ 文本族（txt / csv / html / htm）查看器通道 + 契约描述补全（200 响应头 / 新增 502）；单测 server 786/786（新增 C4 用例集与 JWT 用例）、`check-boundaries` 0 违规、契约零漂移（paths 87 / schemas 239）；真机回放 12/12 + DocServer 真机 `/converter` 拉取转换（证据 `docs/s8-2-回放证据(S3·受控预览端点).md`）。**遗留登记**：① 受控端点整读内存（流式记后续切片）；② 405 / 503 走 Nest 信封、无契约专属错误码；③ 401 暂以 warn 日志替代 M5 告警出口；④ Range / HEAD 未覆盖。实施状态转「S1 ✅ 定案 · S2 ✅ 已交付 · S3 ✅ 已交付（PR #255 已合并）· 下一刀 S4」；**合并收口（2026-10-08）**：PR #255 已合并（squash `35490f3`；PR CI 36698126576 / main CI 36698918314 四 job 全绿） | lan |
| v1.10 | 2026-10-08 | **S3 遗留挂账 + ADR-030 回写批（lan 线 · Push 196）**：① S3 遗留 4 项按落点各自挂账 —— 受控端点整读内存 → S5 门禁核查（50 并发内存表现）+ 后续切片（分段流式 + 大小护栏）；405 / 503 无契约专属错误码 → 契约变更（wmj 线）；401 告警出口 → M5（`技术设计v0.3-实施与验收.md` §4.10）；Range / HEAD → DocServer 升级回归核查（联动 `deploy/onlyoffice` 升级回归项）+ 出现即回安全定稿 §3.2 补全（见 §4 登记行）。② ADR-030 回写批落地 —— `技术设计v0.1` §4.7 / §5#8（v0.1.11）· `技术设计v0.2` §5.4（v0.2.23）· `技术设计v0.3` §3.5 / §4.10 · `系统功能书` D2-01 · `ADR-007` 取代说明横幅 · `ADR-030` 回写条款勾验；lan 代记、PR 请 wmj 复核 | lan |
| v1.11 | 2026-10-08 | **S4 交付（px 线）**：前端文件预览接 ONLYOFFICE 查看器外壳 —— `fileApi.ensurePreviewOutcome` 两通道裁决（viewer / url / 降级带 reason）；新组件 `OnlyOfficeViewer.tsx`（api.js 单例加载 + DocEditor 四段逐字 + 状态机 loading → ready / error / timeout 20s + 降级「暂无在线预览」+「重试」重取配置重建 + 卸载 destroyEditor）；抽屉浮层两通道化（pane: url / viewer，nonce 重建键）、「预览」按钮扩到 Office 行；真机回放 `frontend/scripts/s4-onlyoffice-preview-e2e.mjs` **21 / 21 全过 + 零残留 + 控制台 0 异常**（阻断降级 → 重试恢复闭环；签发四段复核；审计 viewerKind=onlyoffice；无 token 直取 401），证据 `docs/s4-回放证据(ONLYOFFICE查看器外壳·前端).md`。实施状态转「S4 ✅ 已交付 · 下一刀 S5（回归与双轨，含 R4 门禁）」；**合并收口（2026-10-08，lan 代记回填）**：PR #264 已合并 → squash `cc63d3e`；PR CI [37726148837](https://github.com/256-code/LibiaoLink/actions/runs/37726148837) / main CI [37726270412](https://github.com/256-code/LibiaoLink/actions/runs/37726270412) 四 job 全绿；**lan 独立复核补录**：本机前端 `typecheck` 绿 · `build`（tsc ×2 + vite build）绿 · server `vitest run` **790 / 790 全过**（56 文件；复核时工作区仅本刀文档改动，结论适用于已合入 `main` 的代码态；前置：重建本地 `shared/dist` —— server 测试走构建产物，本地旧 dist 曾致 1 例假红）。 | px |
| v1.12 | 2026-10-08 | **业务范围修订 + PDF 入查看器通道（px 线 · PR #268）**：业务口径「为什么pdf是内置浏览器 不是onlyoffice」→「统一用onlyoffice」—— PDF 撤「源直通」、并入 ONLYOFFICE 查看器通道（`preview.targets.ts` 删 PDF 分支；`ViewerChannel.documentType` / 扩展名 / MIME 增 `pdf`；契约 minor：`PreviewViewerSchema.documentType` 枚举 + `pdf`，paths 87 / schemas 240 零漂移；前端悬停改整行浅色底）；server 56 文件 / 791 例全过；m4-07 回放 60/60（④o3 PDF 走 ONLYOFFICE ready + 编辑器 iframe 在位）。**计划口径同步**：D4 修订（PDF 并入，其余不动）、S5 范围补「PDF 查看器通道回归」。**合并收口**（lan 核，2026-10-08）：PR #268 → squash `d994b48`；PR CI [37731856675](https://github.com/256-code/LibiaoLink/actions/runs/37731856675) / main CI [37732054363](https://github.com/256-code/LibiaoLink/actions/runs/37732054363) 四 job 全绿。 | px |
| v1.13 | 2026-10-08 | **业务范围修订登记 + S5 完成（lan 线 · Push 199）**：① 计划口径同步 PR #268（PDF 并入 ONLYOFFICE 查看器通道）—— D4 修订、实施行范围注记、S5 范围补「PDF 查看器通道回归」（v1.12 已登记，本行收口）；② **S5 ✅ 完成**：R4 门禁 50 并发（25 × docx + 25 × pdf，字节全等；p95 134ms；内存 Δduring +12MB、静置 2 分钟回落无泄漏 —— v1.10 挂账①「受控端点整读内存」按本口径核查通过，大文件护栏 / 分段流式仍留后续切片）+ S3 受控端点回放 12 项 + PDF 端到端（ready / documentType=pdf / DocServer 转换 `%PDF-`）+ 双轨并存 + 部署侧五项与 R6（含 CE 许可行为）+ 既有门禁全绿（server 791 / boundaries / db-schema 44 表 / 契约 87 paths · 240 schemas / 前端）；新增回放脚本 `server/scripts/s5-r4-preview-burst.mjs`（可作门禁复跑）；证据 `docs/s5-回放证据(回归与双轨·R4门禁).md`；**未覆盖项登记**（真实终端人工点检 / 生产网关拓扑复验 / ⑤ 401 计数本次 SKIP）。实施状态转「S5 ✅ 已完成 · 下一刀 S6（退役 LibreOffice，待业务确认）」 | lan |
| v1.14 | 2026-10-08 | **图片直通迁移登记（S6 前置 · lan 线 · Push 200）**：新增 **D6** —— 图片预览改原对象短时签名直签（不经产物通道；依据：图片经转换器为 passthrough 字节直通、LibreOffice 引擎不参与；S3 后 `deploy/preview` 仅剩图片一个消费者，直签后归零、S6 退役无功能损失）；D4 补「载体迁移见 D6」指针；§4 增「S6-前置」行（主责 lan）+ S6 行补前置注记；实施行转「下一刀 S6-前置」。**S5 证据措辞修正**（`docs/s5-回放证据(回归与双轨·R4门禁).md` §4）：「图片类仍走产物通道（LibreOffice 转换）」→「passthrough 字节直通、无实际转换」 | lan |
| v1.15 | 2026-10-08 | **S6-前置 交付（lan 线 · Push 201）**：`previewTargetsFor` 改**常量空表**（投递归零 · structured 二期恢复）+ 读面图片直签（`isImageFile` → `serveImageDirect`：原对象短时签名 / `target=image` / `pipelineVersion`·`generatedAt` 空 / 一条 `action=preview` 审计 metadata `{versionId, target}`；产物三态段保留为二期复用段）；定档预生成（P1）循环保留自然空转；单测 791/791（预览读 16 / 队列 25 / 文件服务 73）+ boundaries 0 违规；回放 `server/scripts/s6-pre-image-direct-replay.mjs` **14/14**（停机态：字节全等 / 零投递 / 零产物行 / 版本路由 / PDF 对照）+ 前端 `frontend/scripts/s6-pre-image-direct-e2e.mjs` **11/11**（缩略图 / 大图浮层 + 截图，0 控制台异常；零前端实现改动）；`server/README.md` + 模块 README 修订；实施行转「下一刀 S6（待业务确认）」 | lan |
| v1.16 | 2026-10-08 | **S6 退役 LibreOffice（lan 代做（px 线）· 请 px 复核 · Push 203）**：退役评审通过（证据 `docs/s6-退役评审(LibreOffice转换栈).md`）—— 消费者归零核查（投递面空表 / 图片直签 / 查看器承接 Office·文本族·PDF / 下载链独立 / CI 不构建本栈）+ 环境停用（`docker compose down`：容器与网络移除、镜像保留）+ 回滚方案（栈可一键重建、产物段代码未删）；`deploy/preview/README.md` 退役状态行 + `server/README.md` / `server/.env.example` 注记 + §5 R4 / R5 收口；实施切片 S1~S6 全收官（业务确认 = px 侧五类预览验证）。**Push 202 回填**（PR #273 → squash `26db48a`；双 CI 四 job 全绿） | lan |
| v1.17 | 2026-10-08 | **Push 203 回填 + S2 状态同步（lan 线 · Push 204）**：① Push 203 回填 —— PR #274 / squash `4cd2fd3`（2026-10-08 15:57 +08:00）/ 双 CI 四 job 全绿（PR 37745838996（头 `9cf66c6`）/ main 37746631459）；② §4 实施切片 **S2 行补 ✅** + 出口判据收口（依据：PR #250 已合并 · 2026-09-30 · squash `3c74300` —— v1.7 已登记交付，§4 表行遗漏同步）；无口径变更。 | lan |
| v1.18 | 2026-10-12 | **预览不再计入操作日志（px 线 · Push 283 · 业务口径「操作日志中不需要记录预览的动作」）**：服务端读取侧三路径（产物通道 `ready` 签名 / 图片直签 `serveImageDirect` / ONLYOFFICE 查看器签发 `serveViewer`）不再写 `action = preview` 审计 —— D4「审计口径不动」的预览一项撤销（见 D4 / D6 修订标记）；S6-前置 与 S4 / S8-2 / M4-05d 回放中「审计恰一条 / 签发即写一条」仅存历史记录，现行回放断言 = preview 0 条（`s6-pre-image-direct-replay.mjs` / `s8-2-preview-content-replay.mjs` / `m4-preview-read-replay.mjs` / `m4-05-stress.mjs` / `s4-onlyoffice-preview-e2e.mjs`）；`audit_logs.action` 的 `preview` 值 / 契约 `AUDIT_ACTIONS` / 库侧 `ck_audit_logs_action` 一律保留（历史行回读 / 筛选兼容）；下载（A4-10）与越权留痕不变。同步：`系统功能书.md` C7-01 / D2-07、`技术设计v0.3` §3.5、`技术设计v0.1` / `v0.2`（修订表 v0.1.12 / v0.2.25）、`ADR-011` 不变量 4、`shared/README.md`、`server/README.md`、`server/src/modules/file/README.md`、`前端功能需求.md` §8。 | px |
| v1.19 | 2026-10-23 | **预览审计恢复 + 访问动作**（业务口径「访问某一个项目也要有日志记录 在操作记录里面新加动作 访问 预览」「登录也要」）：D4 / D6 的停写口径撤销 —— 图片直签 / 产物通道 / ONLYOFFICE / CAD 实际送达就绪内容时各写一条 `action = preview`（metadata 记 versionId 与通道，不落签名地址 / token；未就绪 / 失败 / 404 不写）；新增 `visit` 记录项目详情进入与登录成功（迁移 `0066`）；操作记录动作筛选恢复「预览」、新增「访问」，撤「推进」「回退」；`advance` / `rollback` 值保留且历史行 / 直链可读。回放脚本断言同步（待有全套本地依赖重跑）。 | px |
