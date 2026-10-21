# ADR-030 Office 在线预览改由 ONLYOFFICE 承接（查看器形态 · 只读）

> **2026-10-21 CAD 边界更新**：D4 的“CAD 不动”为当时 Office 替换范围。CAD 当前另按 [ADR-035](ADR-035-CAD接入独立能力工程.md) 清理旧链路并接入独立工程，暂不可预览、保留下载；本文 Office 决策不因此改变。

> **局部修订（2026-10-20 · H1 · ADR-034 Accepted）**：D4 中「PDF / 图片直通」继续适用于 PDF 与安全位图；SVG 原对象的直通 / 内联预览子口径由 ADR-034 取代，改为服务端栅格化 PNG。Office 查看器决策及其余边界不变。

- 状态：已采纳（Accepted · 2026-09-30，随 PR #247 合并 main）｜评审：wmj（复核追认）、lan、px｜本件由 px 代 wmj 线起草（2026-09-30），请 wmj 复核决策归属与措辞
- 日期：2026-09-30｜决策人：wmj（技术负责人）
- 依据：docs/ONLYOFFICE替换执行计划(Office预览).md（唯一执行口径 · D1~D5 / N1~N3 / S1~S6 / R1~R6）；docs/PoC-10-回放证据(ONLYOFFICE查看器·首关).md；docs/PoC-10-回放证据(ONLYOFFICE查看器·保真度).md；docs/PoC-10-安全定稿(R1-R2·受控下载端点).md；系统功能书.md A4-19 / D2-09

## 背景

一期 Office 文档在线预览原由自建转换管道（LibreOffice headless，见 ADR-007）承接。2026-09-30 完成 PoC-10 首关与次关，具备切换到 ONLYOFFICE 的完整证据链与业务 / 法务定档：

- **首关（可杀方案的三件事，服务端侧全过）**：2C4G 档 20/20 就绪（p50 约 7.1s）；50 并发四轮就绪 37~42/50，失败全部归因回放客户机侧（无头 Edge 多实例 net::ERR_ABORTED 等），服务端零错误、零饱和（CPU 不超 1.2 核 / 内存低于 0.9GB），4C8G 复跑曲线同形；JWT 只读不可绕 8/8 拒绝（含 b6 深测：客户端外观可篡、服务端权限拒绝、同 key 重开零持久）；中文字体与内网拓扑正反例通过。
- **N1 保真度**：构造样本 5/5 达标、无内容性失真（方法 = 与现行 LibreOffice 转 PDF 栅格化双侧比对；逐项记录版式 / 公式 / 图表 / 条件格式 / 字体 / 分页；差异与夹具修正全登记于证据文档）。
- **N2 安全**：R1 定稿「受控下载端点」（预览链全程无对象存储预签名）；R2 定稿（禁止预签名与 `outbox` 同开；`outbox` 常开为期望态）；离线 JWT 校验 3/3、鉴权判别矩阵 6/6；契约草案与残余风险接受经计划内审核通过（附条件 C1~C6 / D1~D4）。
- **业务 / 法务定档（D3）**：自托管满足「不经第三方软件」；AGPL 社区版获法务 / 采购接受。

## 决策

**总**：Office 文档（Word / Excel / PPT 等）一期在线预览改由 ONLYOFFICE 文档服务器承接（查看器形态），替换自建转换管道中的 Office 链路；其余预览与下载链路不变。

具体条款（转写自计划 D1~D5 与 N2 / N3 定稿）：

1. **形态（D1）**：在线查看器（`mode=view`）；不做在线编辑（服务端锁死）；不采用 Conversion API 形态。
2. **版本（D2）**：pin `onlyoffice/documentserver:9.4.0.1`（digest sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212）；回退镜像 9.3.1.2（回退规则未触发）。
3. **合规（D3）**：自托管满足「不经第三方软件」；AGPL 社区版经法务 / 采购接受。
4. **边界（D4）**：仅 Office 文档预览链路；PDF / 图片直通、下载链（仍签原始对象 + download 审计）、CAD、审计口径均不动；移动端不做。
5. **兜底（D5）**：`deploy/preview`（LibreOffice）不退役，与 ONLYOFFICE 双轨并存至切换完成；失败降级「请下载」保留。
6. **安全不变量（N2）**：在线查看器拉取链无对象存储预签名；`document.url` 一律指向本仓受控端点；端点鉴权 = DocServer `outbox` Bearer JWT（共享密钥 / `payload.url` 逐字绑定 / 至多 300s）；用户下载链独立不动（预签名 + file.download 权限 + download 审计）。
7. **实施前置（N3）**：`blockPrivateIP=false`（受控端点前置）与 `outbox=true` 为部署常备项（升级 / 重建会覆盖 `local.json`，列为升级回归项）；示例 app 保持关闭且不在网关暴露 `/example/`（部署清单 + 验收断言）。

## 备选与不采用原因

- **保持纯 LibreOffice 转换管道（ADR-007 原方案）**：保真度与兜底成本（Excel 分页 / 版式 / 字体需结构化兜底与逐项验收）；PoC-10 保真度与安全证据达标后，Office 链改由 ONLYOFFICE 承接。
- **ONLYOFFICE Conversion API 形态（转 PDF 再展示）**：不采用（D1）——放弃原生渲染，链路更绕。
- **编辑形态（mode=edit）**：不做——一期业务口径不支持在线编辑；编辑属二期（系统功能书 A4-19 / D2-09）。
- **第三方云 / WPS 等外部方案**：维持既有排除（数据不出内网）。
- **R1 备选 b（更短 TTL + 书面接受）**：不再采用（N2 定稿附则）。

## 影响与后果

- **ADR-007 → 被本 ADR 取代（Superseded · 2026-09-30）**：仅 Office 预览链；PDF / 图片 / CAD / 下载链等边界见上文 D4。
- **ADR-013（部署与容量）已随本刀修订**：组件新增 ONLYOFFICE 文档服务器（2C4G 起，首关实测档；与 converter 双轨并存至 S6 退役）。
- **ADR-017（版本基线）已随本刀修订**：基线新增 pin 镜像 `onlyoffice/documentserver:9.4.0.1`（digest 同 D2）。
- **实施切片（计划 §4）**：S1 契约（wmj；新增受控端点路由 + `FilePreviewResponse` 查看配置 / JWT；附条件 C1~C6）→ S2 `deploy/onlyoffice`（px；部署清单 / 回滚 / 升级回归，含 `blockPrivateIP` 与示例 app 条目）→ S3 服务端端点实现与配置签发（lan；附条件 D1~D4）→ S4 前端文件库预览页（px；超时 / 重试 / 降级）→ S5 回归与双轨（lan + px；50 并发生产复测门禁 + 抓包断言）→ S6 退役 LibreOffice（px；业务确认后）。`preview_artifacts` / `preview.job` 去留在 S1 定。
- **安全与运维**：受控端点不进外网入口（仅 DocServer 网段可达 / 公网 404）；`outbox` 常开（fail-closed）；401 计数与告警；升级回归三项 = `outbox=true` / `blockPrivateIP=false` / 401 基线；预览拉取链不再经过对象存储预签名。
- **风险登记（R1~R6）**：见计划 §5；R1 备选 b 不再采用；若 S3 实施中发现受控端点不可行，须回计划重开 N2 定稿（登记变更记录），不得静默降级。
- **文档回写（随实施切片）**：技术设计v0.1 §4.7 / v0.2 §5.4 / v0.3 §3.5、系统功能书 D2-01 的管道与部署描述、server 与 deploy 相关 README，按实现落地进度回写。**✅ 回写落地（2026-10-08 · Push 196 · lan 代记，请 wmj 复核）**：`技术设计v0.1` §4.7 / §5（#8，v0.1.11）· `技术设计v0.2` §5.4（v0.2.23）· `技术设计v0.3` §3.5 / §4.10 · `系统功能书` D2-01（含顶部修订块）· 本仓 `ADR-007` 取代说明横幅；server / deploy 相关 README 已于 S3 / S2 完成、不欠账。

## 切换触发条件

- **编辑需求重启**（系统功能书 A4-19 / D2-09 二期立项）：本 ADR 不变量「不做编辑且服务端锁死」须经新 ADR 修订后放开。
- **S3 实施受阻**：不得静默降级——回计划重开 N2 定稿（登记变更记录）。
- **镜像升级（主版本 / 安全 CVE）**：按 ADR-017 独立 PR + `deploy/onlyoffice` 升级回归，并复核本 ADR。
- **LibreOffice 退役**：S6、业务确认后执行；退役前双轨并存。

## 参考

- docs/ONLYOFFICE替换执行计划(Office预览).md（D1~D5 / N1~N3 / S1~S6 / R1~R6）
- docs/PoC-10-回放证据(ONLYOFFICE查看器·首关).md
- docs/PoC-10-回放证据(ONLYOFFICE查看器·保真度).md
- docs/PoC-10-安全定稿(R1-R2·受控下载端点).md（含附条件 C1~C6 / D1~D4）
- docs/PoC-10-部署前置定稿(F1-R3·R6).md（N3 产出：`blockPrivateIP` / `outbox` 固化键、升级回归五项、R6 断言）
- 系统功能书.md A4-19 / D2-09；技术设计v0.1-选型分析.md §4.7；团队分工.md §6 第 10~11 项
