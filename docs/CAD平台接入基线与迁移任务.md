# CAD 平台接入基线与迁移任务

> **2026-10-29 DWG packed manifest 传输（本地未部署）**：DWG 平台路径新增 `ucd-dwg-packed/1`（`dwg-table/1`）无损传输：标准实体/显示表压成索引行，非标准形状保留回退；正式图 manifest 265,840,262 → **69,039,306 B（25.97%）**，artifact 341,892,958 → **145,092,002 B（42.4%）**，解包后 canonical revision 与原件一致。worker 75.7 秒（未打包 81.6 秒）、峰值 RSS 2.54 GiB（-148 MB）；本机平台任务 2 分 20 秒（未打包 2 分 41 秒），查看器 ready 12.1 秒（未打包 13.4 秒），画面一致。引擎父进程校验前解包、平台保存 packed 形式，查看器 `core/dwg-packed-transport.js` 解包；`conversion_jobs.py` 为共享文件，STEP/DXF 格式键随共享摘要更新。未验证目标 Linux cgroup 下的父进程解包/校验峰值、测试机/生产与真实账号；`CAD_DWG_ENABLED` 默认仍关闭。版本 `engineVersion=1667305a…`、`formatVersions.DWG=dwg-0.1.0/da44f3c9…`、`viewerVersion=cf6aafa0…`、`releaseDigest=8db94edf…`。

> **2026-10-29 DWG 本机完整系统全链路（本地未部署）**：WSL Docker + PostgreSQL 18 + Casdoor + SeaweedFS S3 + 真实 API/Vite + 本机 CAD 引擎，`CAD_DWG_ENABLED=true`；真实浏览器登录后建项目/任务、分片上传公开样本 `sample_AC1027.dwg`（1,091,959 B），文件绑定任务；`GET /files/{id}/preview` 返回 `viewer.kind=cad`、`format=DWG`；平台任务 `partial`，产物 976,948 B（manifest 806,068 B + buffer 170,880 B），`cad_artifacts.state=partial` 且对象存储 manifest/buffer 存在；文件库「预览」打开 DWG 查看器（canvas 1382×825、`state=ready`、部分显示提示正常）。修复查看器只允许 DXF partial 的门禁（`platform-entry.js`；DWG partial 现可打开，按图纸走 UTF8、不显示配套资源按钮）。正式 34 MB 大图（`bc45921b…`，34,385,320 B）也经同一链路完成：5 片上传、后台任务 2 分 46 秒 `partial`、产物 341,892,958 B（manifest 265,840,390 B + buffer 76,052,568 B），文件库预览 `data-cad-ready-ms=13382`、canvas 1382×825、`state=ready`。未验证目标 Linux 沙箱资源档位、测试机/生产部署与真实公司账号浏览器验收；`CAD_DWG_ENABLED` 默认仍关闭。worker 传输优化后正式图 worker 89.6→81.6 秒、平台任务 2 分 46→2 分 41 秒，峰值 RSS 约 2.68 GiB 基本不变。版本 `engineVersion=b7420fe3…`、`formatVersions.DWG=dwg-0.1.0/7669374c…`、`releaseDigest=0013b43f…`。

> **2026-10-28 DWG 平台第一片（本地未部署）**：DWG 已加入 shared CAD 格式、API 输入/预览/任务、产物仓库和 `core/dwg_platform_convert.py` worker；迁移 `0079_cad_dwg_format.sql`，DWG 只接受主图、结果固定为 `partial`。`CAD_DWG_ENABLED` 默认关闭，原生运行时由 `CAD_DWG_PYTHON`、`CAD_DWG_READER`、`CAD_DWG_DOTNET` 提供，缺少时明确失败、不回退 DXF。公开样本 worker 已跑通；正式大图约 2.7 GiB 托管内存/266 MB manifest 未在 Linux 沙箱验证，当前不开放测试机或生产。STEP/DXF 原链路与格式键不变。

> **2026-10-28 二维显示治理本地收敛**：宿主侧阶段 A–D 已完成（基线/能力矩阵、裁剪、文本、图案、媒体/布局切片与分支收敛），验证与未完成项见 [阶段 D 交付检查](CAD二维显示结构治理-阶段D交付检查.md)。版本按 [ADR-041](adr/ADR-041-CAD版本拆分与缓存键.md) 拆为 engineVersion / formatVersion / viewerVersion，迁移 `0078` 改变产物唯一键；当前仅本地 `wmj`，未推送、未部署；真实账号验收和生产部署仍待办。线上开放范围不因本记录扩大。

> **2026-10-27 本地实现更新**：二维 DXF v0.15.0 继续选择性适配已登记社区规则，加入源属性对象图、只读内置 FIELD、注释比例/文字上下文、代理裁剪/外参、平面 REGION、SHIFT、OLE 缓存、二维 DWF/V7 DGN 及 CTB/STB 屏幕预览。文件版本、原字节摘要、UCD 派生、裁剪与拾取沿用平台链路。DGN/DWF 轻量读取器仍为早期版本，复杂字形/未知源记录和原 CAD 精度校验按实际边界报告；不宣称完整 CAD 求解器。当前版本与依赖由 `source.json` 内容指纹确定。此轮未提交、推送或部署，现有线上开放范围不扩大。


> **2026-10-26 本地实现更新**：二维 DXF v0.14.0 已接到平台持久任务及共用查看器，包含固定同项目配套版本、逻辑路径、显式部分显示与资源撤销。代码与依赖的当前基线由 `server/cad-engine/source.json` 内容指纹确定；下述既有线上状态不据此扩大。部署需迁移 `0077` 并协调更新 API/worker/引擎，尚未推送或部署。详见 [ADR-040](adr/ADR-040-DXF二维与配套输入集合.md) 与 [运行说明](../server/cad-engine/README.md)。

更新：2026-10-23。CAD 主责 wmj，共享 file/preview/outbox 由 lan 协办，通用 UI 与部署由 px 协办。

本文统一替代 LibiaoLink 原 CAD 选型、浏览器解析和工程测量实施计划。用户已批准接入及旧实现清理。独立 CAD 沙箱、持久产物与上传预解析已部署公司测试机，并通过容器、真实对象存储与复用验证；2026-10-26 又完成正式生产 API/worker 接线和真实公司账号浏览器首轮验收（64 项零件），详见 §10。决策见 [ADR-035](adr/ADR-035-CAD接入与旧浏览器解析链移除.md)。

## 1. 已有能力与唯一基线

CAD 能力以本仓库登记的 STEP v0.3.3 和已验证能力记录为准。后续升级须登记实际提交与验证结果，不沿用 LibiaoLink 历史后缀白名单、PoC 数字或网格测量结论。

| 项目 | 已登记 CAD 能力 | LibiaoLink 当前状态 |
| --- | --- | --- |
| STEP | 转换、产物校验、首帧、产品树、面拾取、显隐/隔离/恢复；组合补面与缺失明细 | 已接入公司测试机；运行环境已启用 STEP，原文件下载保留 |
| 模型与传输 | UCD 2.0 文档/快照、manifest、二进制几何、ID 字典、gzip | 已接入版本/权限/窗口隔离任务、gzip manifest、二进制几何与资源释放 |
| EASM | 仅能力矩阵中已验证范围；语义须有 eDrawings 原生逆向依据 | 待接入；不依赖 eDrawings 运行时交付 |
| DXF | 仅能力矩阵中已验证的实体、样式、布局与诊断范围 | 待接入；不等同任意二维 CAD 支持 |
| DWG / IGES / 3MF 等 | 原生 DWG 已登记（固定 ACadSharp 提交；只读主图、结果固定 partial）；IGES / 3MF 等不由历史白名单推定支持 | DWG 本机完整系统全链路通过，`CAD_DWG_ENABLED` 默认关闭；测试机/生产未部署。IGES / 3MF 仍为待接入提示 |
| 工程尺寸依据、PMI、公差 | 不作为当前交付能力 | 旧测量计划撤回，另按业务需要立项 |

CAD 文件打开成功不等于平台联调成功。测试机已覆盖版本、任务、资源权限和交互，并完成受控箱体夹具的容器内 native 冒烟；真实公司账号、业务文件与浏览器完整交互仍需另行验收。

## 2. 已接入的链路

以下描述 ADR-037 的持久化与上传预解析代码链路；相关变更已由 PR [#555](https://github.com/PanXing-Libiao/LibiaoLink/pull/555) / [#557](https://github.com/PanXing-Libiao/LibiaoLink/pull/557) 合并，并以代码基线 `c18b417e` 部署公司测试机；正式生产于 2026-10-26 完成运行接线与首轮验收，见 §10。

`上传完成 → 事务登记后台任务 → 沙箱解析/校验 → 持久 manifest/buffers → 文件预览复用 → 鉴权资源 → 独立 ViewerSession`。

- 平台通过既有 ObjectStorage 读取版本对象，核对大小与 SHA 后，经 Unix HTTP socket 将原始字节送入独立 CAD 沙箱；产物以有界流返回，不传本机路径、S3/数据库凭据或客户端 URL。旧 API 内 stdio/native 路线撤回；原始输入仍由平台完整读入内存，尚非输入流式改造。禁网、内核资源硬限额与迁移见 [ADR-036](adr/ADR-036-CAD解析沙箱与资源硬限额.md)。
- `server/cad-engine/source.json` 固定引擎源码提交、schema 和浏览器依赖逐文件 SHA；更新只运行同步脚本，宿主副本不另改 CAD 规则。OCP 和 Gmsh 使用两套固定版本 Python 环境，不复制本机虚拟环境。
- 复用 ConversionJobs 的预算与完整产物校验。上传完成时事务内登记 GB 后台任务，由独立 worker 经现有沙箱解析，数据库 `cad_artifacts` 保存状态与索引，私有对象存储保存 verified manifest/buffers；所有对象成功写入后才发布 completed。`cad_views` 绑定 actor/file/version/view、窗口取消和资源租期，取消不终止共享后台工作。文件版本/源摘要、固定引擎与编码隔离缓存；完成结果跨 API/worker/CAD 重启复用，损坏时撤销并重建，彻底删除文件清理全部对象前缀。见 [ADR-037](adr/ADR-037-CAD产物持久化与上传预解析.md)。
- 显示修复与未显示面信息统一收进默认折叠的“模型信息”，主视图不再展示两类提示条；数量、分类、统计排除说明和导出仍可展开查看。此项是用户批准的展示调整，不改变转换、接收政策或记录。
- 同源 `/cad-viewer/` iframe 使用原 ViewerSession。保留产品树、source/product/occurrence/draw/face/material、XCAF entry、实例变换、visibility/membership、显示修复与缺失清单。宿主只适配传输、进度、关闭与导出。
- manifest 与 buffers 分开，几何不回填 base64 JSON。源 ID 字典按原协议展开，资源 SHA 由浏览器复核；读取和释放逐请求重新鉴权。
- 清单/检查记录由原函数生成，宿主确认当前版本权限后下载，外层增加平台来源关联 `libiaolink-cad-report/1`。原文件下载仍调用原业务入口。
- 未启用运行环境、非 STEP CAD 和旧 ready 响应继续显示提示与下载；EASM/DXF 不由本次接入自动开放。旧解析器、OCCT WASM、网格测量与图片直签已经删除。

## 3. 平台接口与身份

shared 已定义 CadPreviewViewer、CadJob 及创建响应，OpenAPI/客户端由生成器同步。

`GET /api/v1/files/{fileId}/preview?versionId=...` 对已启用 STEP 返回 `status=ready`、`viewer.kind=cad`、fileId/versionId/sourceSHA256/engineVersion，url/target 为空。**ready 仅表示查看入口可用**；模型加载须等待 CadJob.completed，再取完整校验产物。Partial 不发布。

下面的公共前缀记为 `B=/api/v1/files/{fileId}/versions/{versionId}/cad/views/{viewId}/jobs`：

| 请求 | 作用 |
| --- | --- |
| `POST B?nameCodepage=UTF8` | 从平台版本对象创建任务，返回 job/reused；可选 UTF8（默认）或 GB |
| `GET B/{jobId}` | 状态、阶段、来源、输入/产物 bytes、worker 耗时与峰值 RSS |
| `POST B/{jobId}/cancel` | 取消当前命名空间任务 |
| `GET B/{jobId}/manifest` | 重新校验完整产物，返回 gzip JSON 和短期资源 lease |
| `GET B/{jobId}/resources/{lease}/{sha256}` | 按 lease 白名单读取二进制几何 |
| `DELETE B/{jobId}/resources/{lease}` | 释放当前 manifest/资源引用 |

会话、文件/版本可见性逐请求检查，写操作校验 CSRF；无权限与不存在均不泄露资源。viewId/jobId 为 32 位十六进制，lease 为 48 位，SHA 为 64 位；它们不替代平台授权。manifest 中原 `/api/resources/...` 是核心虚拟引用，宿主 fetcher 映射到上述鉴权路径，不暴露独立服务。

平台不新增业务迁移或 preview.job 伪目标。工程隔离不是 CAD 身份：namespace 不进入 UCD，固定输入的文档/快照在不同 namespace 下保持相同。

名称编码由“模型信息”按文件选择，当前标签页按 fileId/versionId 记忆。使用固定 OCCT 的 `read.step.codepage`，默认 UTF8，中文旧编码为 GB；非法值拒绝，所选码页进入缓存键、规则摘要和检查记录。源字节、SHA、身份算法及网格参数保持原值，不自动推测旧编码。源码依据与原生定向检查随引擎版本记录。

## 4. 沿用的 STEP 接收政策

优先尝试现有原生及 pcurve 修复，再按 CAD 平台组合路线对失败面处理；不改变全局网格参数，不引入未登记近似。保留 `step-display-area/2` 误差检查。

`step-nonmeshable/1` 对未显示面逐项分类：

- `degenerate-zero-area`：面积 ≤ 1e-9 mm²，或面积 / 面 bbox 对角线平方 < 1e-9。
- `unmeshable-tiny-area`：不属于上一类、面积 ≤ 0.001 mm²，且 0.08 / 0.02 / 0.01 / 0.005 / 0.001 mm 五档独立重网格均无三角形。
- `missing-other`：其余真实缺面严格拒收，不并入可接受缺失。

接受的未显示面仍列出面号、XCAF entry、曲面类型、面积、bbox、有效性、wire/闭合、容差与命中判据；不参与拾取或面积统计，受影响零件体积不可用。显示修复与未显示缺失不可混称“几何完整”。

既有测试分组保留：原有外部文件 18/19、新增外部设计 20/20、工程夹具 2/2；另一批未测设计 19/20。不是平台接入成绩，也不是任意 STEP 成功率。S03 外部引用资源解析暂缓；U11 第 7 面已恢复 5,118 个三角形，但整文件仍未通过既有时间/补面预算，不能宣称丝杠已可用。

默认 STEP 输入 64 MiB，128 MiB 需显式配置。该上限不是完成保证；worker 2 GiB 采样停止阈值不是整机内存要求。大文件耗时与峰值 RSS 按逐文件实测呈现，不承诺秒开。

## 5. 接入顺序与验收

| 步骤 | 交付物 | 完成条件 |
| --- | --- | --- |
| 接入准备（已完成） | 统一文档、旧实现删除、明确的暂不可预览提示与下载 | 定向验证 CAD 拒绝旧路径，图片/Office/下载不回归；本地提交 |
| 平台适配（本地已完成） | 版本来源、任务与受控模型资源接口 | 文件权限与版本绑定正确，任务/错误/取消可追溯，完整产物才发布 |
| 查看器接入（本地已完成） | 沿用独立 ViewerSession 和模型身份 | 产品树、拾取、显隐/隔离/恢复及缺失明细在平台内可用，关闭/切换释放资源 |
| 公司环境验收（测试机已部署，浏览器待验） | 逐文件表、可打开页面与能力矩阵更新 | 测试机运行容器、公网入口与旁路 STEP 已通过；真实公司账号的打开→首帧→可交互→树→拾取→显隐/隔离/恢复仍待完成，并记录 input/artifact bytes、峰值 RSS 与实际耗时 |

失败、Partial、外部依赖、已列举缺失分别报告；不预报成功率，不更换样本达标。接入与几何修复分开验收，平台适配不借机更改 CAD 语义。

## 6. 接入准备验证记录（历史）

本轮已完成文档统一与旧实现删除：

- 实际服务定向测试：`server` 中运行 `npm exec -- vitest run test/preview-read.test.ts test/file-download.test.ts`，**2 个文件、44 项通过**。覆盖图片/Office/PDF、CAD 暂不可预览、误报 MIME、旧 ready 产物、历史版本、权限和原文件下载；不依赖生产数据库或对象存储。
- 内置浏览器实际组件检查：旧 CAD URL 与旧 viewer 配置均显示提示，未出现图片、模型 canvas 或 Office iframe；下载回调、Tab 焦点循环、Esc 关闭/焦点恢复通过。图片预览可打开并从 100% 放大到 125%。检查页只验证 UI 回调，不冒充真实业务下载。
- [可复现检查页](../frontend/tools/cad-preview-prep.html)：在 `frontend` 运行 `npm run dev -- --host 127.0.0.1 --port 3012`，打开 `http://127.0.0.1:3012/tools/cad-preview-prep.html`。使用实际 `FilePreviewOverlay`，不连接业务后端、不读取业务文件；仅开发环境入口，不加入生产构建入口。[页面记录](cad-integration-prep/preview.png)。
- 删除 tracked 旧组件/声明/WASM 及本地 9 个已无引用的旧包、过期 `frontend/dist`，合计约 **57.15 MiB**（文件字节口径，非磁盘块测量）。依赖由 npm 更新，无其他现有包版本升级；shared 契约描述已同步并重新生成，生成结果无内容变化。

未运行全量构建或无必要静态检查；尚未推送或部署。后续 STEP 本地联调见下一节；44 项准备回归本身不代表 CAD 接入完成。

## 7. STEP 本地接入交付

W01/N02/N03 的平台打开、可交互、产品树、拾取、显隐/隔离/恢复与明细已验证；外部引用文件 S03 明确拒收。实际 HTTP/native 测试与旧预览/下载回归共 52 项通过，原工程 2 项任务生命周期测试通过；未做全量构建。逐文件耗时、bytes、RSS、缺失清单及截图见 [本地结果](cad-platform-integration/RESULTS.md)。运行与迁移方式见 [runtime README](../server/cad-engine/README.md)。

该本地轮次保留了测试身份/存储夹具的明确标识，没有把本地夹具等同公司 SSO、数据库或对象存储；后续推送、合并与测试机部署见 §8，正式生产部署与验收见 §10。

## 8. 公司测试机部署记录（2026-10-21）

本节只登记公司测试机事实，不表示生产上线，也不替代真实业务账号的浏览器验收。

- 来源与目标：PR [#546](https://github.com/PanXing-Libiao/LibiaoLink/pull/546) 的 squash 提交 `71f42fa30bad112b6fb453044c72be6049dd0e36`，部署到 `10.1.104.44`（`libiao-vm`）的 [test-pm.libiaorobot.com](https://test-pm.libiaorobot.com)。
- 发布包：服务器 `/srv/data/deploy-cad-546-20261021-1538/cad546-bundle-71f42fa-20261021-1538.tar.gz`，51,390,495 B，SHA-256 `a39e4e603668ab31eaf97ed0b912a601320d9b313d2314cc9fd9bc5625a24225`。
- 运行镜像：`libiaolink/runtime:24.20.0-cad-20261021-1538`，Image ID `sha256:ee6147e3aef68552965e3280d85414ceead6154968737f16201fbe703842b62a`，2,051,449,037 B；Debian 13、Node 24.20.0、Python 3.13、OCP 7.8.1.1、Gmsh 4.15.2。API 限额 4 GiB，worker 1 GiB。
- 部署前备份：`/srv/data/backups/frontend-before-cad546-20261021-1538.tar.gz`（8.7 MB，SHA-256 `bdb78f2eb7159ba67e015020d6c5a75dbbd5e052327b80db1cef26fb43f729d2`）、`server-before-cad546-20261021-1538.tar.gz`（90 MB，SHA-256 `07d5e2b0d78ead1dbe651fe40c6dbc97211a698a9abc3d698b86ea7d1dc41a2d`）、`shared-before-cad546-20261021-1538.tar.gz`（744 KB，SHA-256 `5c86dcdea8bbb4ced2142cafcf65c5893af18bfa19735f5f54a4b0f5398924aa`）；同时备份 `libiaolink.conf`、`server.env`、`prod.env` 三个配置文件。
- 容器与入口：`api`、`worker`、`web`、`postgres`、`minio`、`svg-preview` 六个容器全部 healthy；公网站点、`/cad-viewer/` 入口、`/healthz`、`/readyz` 均返回 200；`/cad-viewer/` 缺失资源返回 404，不再误回 SPA 首页。
- 静态一致性：公网 `index.html`（499 B，SHA-256 `df3850d7258ae2b68f0476eba948bb5250b11bb1768ddc6de214de4571925286`）、`index-DDGlw1NP.js`（1,411,015 B，SHA-256 `e588e6680889c48383a830377c9e16054ef68062f21853113d351b52fad73f3c`）、`index-mUvOZioE.css`（154,503 B，SHA-256 `40ac2ec42b0b3ae525a85257cad7735b5ea425b87fdb27aeb74bbc2d78f812b0`）与本地构建一致；`/cad-viewer/platform-entry.js` 为 `c70bf2923ee3da76c90c8b5b300ee8a4948f3ad30f2214c5cd9967a2a51ac87b`，`/server/cad-engine/bridge.py` 为 `d48d96b0e22a7483fb112e8c332b818fca74f70a0cedaf094b2ca5855ff0017e`。
- 验证结果：旁路真实 STEP 集成测试 12/12 通过；生产 API 容器内 native bridge 使用受控箱体夹具返回 `completed`，输入 15,416 B、artifact 15,187 B、manifest 15,447 B，worker 峰值 RSS 326,103,040 B、耗时 3.263387 秒。该夹具不代表真实业务文件或浏览器验收。API / worker 近 10 分钟无 `ERROR`、`FATAL`、`SIGILL`、`Unhandled` 或模块加载错误。
- Gmsh 运行库说明：Gmsh wheel 的 `libgmsh.so` 即使无头运行仍声明 `libXcursor`、`libXft`、`libXss` 等动态依赖；安装这些库只为满足动态装载器，不启动桌面服务、不开放 X 服务。macOS 开发机通常由系统与桌面环境直接提供同类库，因此同事在 Mac 上使用时不需单独补装。
- 待完成：使用真实公司账号在浏览器打开真实业务 STEP 文件，完成打开、首帧、产品树、拾取、显隐/隔离/恢复走查；该轮完成时生产环境尚未部署，后续正式接线见 §10。

## 9. 独立沙箱与持久产物部署（2026-10-23）

本节补充 §8 的既有 STEP 接入；容器与旁路冒烟不等于真实公司账号、业务文件与浏览器的完整验收。

- 来源与目标：main 代码基线 `c18b417e`，包含 PR [#553](https://github.com/PanXing-Libiao/LibiaoLink/pull/553) 的独立禁网沙箱、[#555](https://github.com/PanXing-Libiao/LibiaoLink/pull/555) 的持久产物 / 上传静默预解析与 [#557](https://github.com/PanXing-Libiao/LibiaoLink/pull/557) 的续租后读取；部署到 `10.1.104.44`（`libiao-vm`）的 [test-pm.libiaorobot.com](https://test-pm.libiaorobot.com)。main 后续 `5e721dbe`（文档）与 `3243dd44`（前端 UI）均未改 CAD 链路；该轮完成时生产未部署。
- 发布件：`/srv/data/deploy-cad-c18b-20261023-0943/`，CAD 镜像归档 `cad-sandbox-1.0.1-c18b417e.tar`（330,915,328 B · SHA-256 `3d3c64a61ddb4379e5c0dc592087f18e23ca158ad3d0756fac23909e4b6eb333`）、`server-cad-c18b417e-20261023-0943.tar.gz`（45,840,767 B · `fc2f1faa1aa5882fc3d8c52bf57a1358ed095db4003f5f10dae664ecc4baf858`）、`shared-cad-c18b417e-20261023-0943.tar.gz`（349,990 B · `bb4e4a9c7b650b0f5256e9069be038fc5e2945a140327270a54ddf98ff720b65`）、`deploy-cad-c18b417e-20261023-0943.tar.gz`（8,423 B · `bb54ced10e77257e5f052a9141fa249760f91acd5fc2c63568822af2742d265a`）与迁移 `0064_cad_artifacts.sql`（2,447 B · `a763cf0dbdc705a45e6733fad39277d2a76749e5fea7ae00dc99afc9a1a58e41`），远端逐项哈希一致。
- 备份：`/srv/data/backups/` 下 server 107,220,111 B · `9ae581e37b6b3217aad3b63065cb33c4812c84ab4a2d84600a9264ebfce66f3f`、shared 767,779 B · `c2f11499214ed9ec33c87e66447f14d899a6147b908484a900486abb8c9a7ecf`、数据库目录 114,298 B · `7965bfb802daa7a29077fd6d644bb44992bf65aea91af4daf00b4df64864381b`、CAD 配置 5,963 B · `5f232e6ce95d42cfa9e9db689b580c671a613cecf5a44ec1ec74461a193e6233`、DB dump 1,010,081 B · `260a39ab2556d8e01206027a2bae1b3dbb88f4dc453784a61efde545cc17ca39`。
- 数据库：`0064_cad_artifacts.sql` 先 dry-run，实际执行 71 ms；`schema_migrations` 已登记，`cad_artifacts` / `cad_views` 表存在，外键与约束按迁移落地。认证后的上传预解析 / 持久产物业务走查尚未执行，表内没有本轮应用层夹具。
- 运行边界：CAD 镜像 `libiaolink/cad-sandbox:1.0.1-c18b417e@sha256:aeee8b4b072eca1aaf0b2db0d65b972f341e3da07a413aaec07d259d03a9879c`（linux/amd64，服务器解压后 1,437,769,016 B）；容器 `network=none`、根目录只读、capabilities 全丢、`no-new-privileges`、用户 `1000:1000`，内存 3 GiB、swap 0、1 核、64 PIDs；`/tmp` 384 MiB、`/var/lib/cad` 1536 MiB、`/run/cad` 1 MiB 均为限容 tmpfs。API / worker 通过只读 Unix socket 挂载访问，不使用旧 Python 路径或 CAD TCP 地址。
- 容器与接口：`api`、`worker`、`cad`、`web`、`postgres`、`minio`、`svg-preview` 七容器 healthy；公网站点、`/healthz`、`/readyz`、`/cad-viewer/platform-entry.js` 200，缺失查看器资源 404。引擎版本 `step-0.3.3/f103d1c40812b24c3864ae90a91ea707f734dfb5/gateway-1` 与 API 一致。
- 冒烟：受控箱体 UTF8 / GB 各一次 `completed`；另从私有对象存储读取真实 `限流环.STEP`（315,166 B · SHA-256 `36866774a174db2d3dc0de800f3b1b74f0c083bfb18fbe08674521d02550c228`）完成转换，manifest 37,303 B、完整性 `complete`、worker 峰值 RSS 333,180,928 B；同源第二次提交 `reused=true` 且任务 ID 相同。API / worker / CAD 近 20 分钟无 `ERROR` / `FATAL` / `Unhandled` / 模块加载错误。
- 待完成：真实公司账号在浏览器打开真实业务 STEP，完成首帧、产品树、拾取、显隐/隔离/恢复；从上传静默预解析到 `cad_artifacts` 完成、鉴权 manifest / buffers 与跨重启复用的认证后业务走查。该轮完成时生产环境尚未部署，后续正式接线见 §10。

### 9.1 公司测试机 DWG 大文件内存预算修复（2026-11-02）

本节记录公司测试机的 DWG 资源档位修复，不表示正式生产已部署 DWG，也不替代真实账号的浏览器视觉 / 交互验收。

- 来源与初始部署：代码基线 `origin/wmj@7e023ff1`，公司测试机首发清单 `test-20261102-dwg-preview-7e023ff1-0912`（18 条历史增量记录）；初始 CAD 镜像 `libiaolink/cad-sandbox:1.0.1-dwg-7e023ff1@sha256:906589171f8b1f49155f4475b0e12d781986b9ea64609ce881ca936bdc193f25`。测试机 `CAD_DWG_ENABLED=true`，正式机未触碰。
- 原失败：真实文件 `01-LBGW-20260331-1459  英国-VANILLA-飞箱项目-Layout-启动会后版本06-更新货架立柱尺寸.dwg`（`fileId=7f18b3a7-9652-4a1d-a8f7-4db61ec16de1`、`versionId=a7be31b9-c4dc-4515-8905-dd749488dbbe`，34,385,320 B，SHA-256 `bc45921ba82bff24204ae525d4e6b581c316cae489011bd25a6b9a397164a52b`）在 3 GiB 容器 / 2.5 GiB DWG worker 预算下约 35 秒被 `job-memory-quota` 终止，平台提示「转换超过后台任务内存预算」；失败记录 `5685e0b1-c860-4e44-9285-f35c2c25e68e` 保留。
- 容量实测：同镜像、6 GiB 隔离容器跑通同一文件，worker 进程树峰值 `2,978,451,456 B`、cgroup `memory.current` 峰值 `3,291,672,576 B`、耗时 `227.728 s`，输出 manifest `69,197,248 B`；证明原图可转换，失败原因是测试机档位不足，不是文件损坏或浏览器问题。
- 修复：CAD 容器改为 5 GiB / swap 0 / 1 CPU / 64 PIDs / 禁网；`sandbox.py` 启动自检同步接受 5 GiB；DWG worker RSS 采样预算由 2560 MiB 提升为 3584 MiB，结果与产物上限仍为 512 MiB。首次仅改 Compose 被自检拒绝，修正自检后以 `mem2` 镜像重新部署，没有绕过安全门禁。
- 最终发布：`test-20261102-dwg-memory-7e023ff1-1013`；镜像 `libiaolink/cad-sandbox:1.0.1-dwg-7e023ff1-mem2@sha256:d379319c7309d44090f4a351dec60bbd9656424e6caf15685923e8d4619b2340`，release digest `5f117dec3c5ea6910b97ac517401c1720ec852037cb8cef58c1ab4436dbc7521`，engine `step-0.3.3/e3a20b2799ab0c06c843efa60cb6ea03a15caa81fc0c59c81d6b515d511c3931/gateway-1`。server dist 为 628 文件 / 4,377,518 B（tar 999,668 B，SHA-256 `d32f66ba7c74f42887a41b63139cf9ff9fb307464ec4d4c157974233668165d7`）；发布件在 `/srv/data/deploy-dwg-memory-7e023ff1-20261102-1013/`。
- 平台内复验：同一业务文件重新创建临时视图 / 任务，`GET /files/7f18b3a7-9652-4a1d-a8f7-4db61ec16de1/preview` 返回 `viewer.kind=cad`、`format=DWG`；任务最终 `partial`，artifact `b316ed8c-2529-4db8-8118-da64b23a26a8`，产物 145,268,685 B、manifest 69,197,685 B、`transportProfile=ucd-binary-manifest/1`，端到端 386.312 秒，`error=null`。同一文件原失败记录未删除；临时 session / view 已清理。
- 运行与安全验收：CAD `memory.max=5,368,709,120`、`memory.swap.max=0`、`pids.max=64`、`network=none`、根目录只读；容器 cgroup `memory.peak=3,477,983,232 B`，`memory.events` 的 `oom=0`、`oom_kill=0`。`api` / `worker` / `cad` 均 healthy、restart count 0；公网 `/healthz` / `/readyz` 200；近 20 分钟三类日志 `ERROR/FATAL/Unhandled/exception/panic/oom` 计数均为 0。
- 边界：正式生产未部署本次资源档位，仍须按 ADR-036 评审容量与整机预算；34 MB 真实账号浏览器回归已在 §9.2 补齐，76 MB 源样本与完整视觉 / 交互验收仍待补。回滚备份在 `/srv/data/backups/before-dwg-memory-7e023ff1-mem1-20261102-0956/`，原 manifest SHA-256 `61927d43cd2991a4ef5199b3c29ff1bb80d857f62d2e44c6fa83518e19926270`。

### 9.2 浏览器查看器三维返回与空间切换修复（2026-11-02 14:13）

- 发布：公司测试机 `test-20261102-1413-cad-viewer-space-fix-bc185336`，`viewerVersion = viewer-bcf9bd8f…`、`releaseDigest = bc185336…`；沿用 13:35 的 CAD worker-canvas 镜像，正式生产未部署。
- 修复：三维网格画布不再覆盖右侧图纸面板，“二维图纸”按钮恢复真实鼠标可点击；三维视图明确只包含已解析面 / 网格，不包含普通二维线条、文字和标注。同一空间重复点击不再重建；模型空间 / 布局空间按空间、显示模式、打印样式和文字避让缓存最近两份状态，模式与空间往返复用缓存和解析结果。
- 浏览器回归：34,385,320 B 真实业务 DWG（`fileId=7f18b3a7…`、`versionId=a7be31b9…`）任务 `partial`，显示 1,476,332 / 1,478,198 项。真实 Chromium 鼠标实测 3D 打开 147–177 ms、返回二维 81–98 ms；模型 / 布局往返 110–378 ms；首次显示离散化 → 按屏幕重建 4.3–4.6 s，重复切换 214–249 ms，analytic 下模型 / 布局往返 126–224 ms。页面 error 0、console error 0；JS heap 约 1.40 GB。
- 发布一致性：`drawing-viewer.js` 公网 / 容器 SHA-256 均为 `4a390448…`，`drawing-mesh-viewer.js` 为 `f3bf2a41…`；`libiaolink-web` 曾因重命名 dist 后 bind mount 指向旧 inode 而继续返回旧字节，重启容器后恢复，未 force-recreate。10 / 10 容器 healthy，站点根、`/healthz`、`/readyz` 均 200。
- 备份与清单：`/srv/data/backups/before-test-20261102-1413-cad-viewer-space-fix-bc185336/`；`RELEASE_MANIFEST.json` 更新为 136,419 B · `7a9d1cce…`，补记 13:35 和 14:13 两次增量。
- 边界：首次“按屏幕重建”仍有约 4.5 秒主线程长任务；测试库没有 76 MB 源 DWG，34 MB 文件本身为 partial；后续需要 Worker / 分片采样治理，不能把本轮结果宣称为零缺损或任意大图承诺。

### 9.3 CAD 预览交互修复（2026-11-03 15:12）

- 发布：公司测试机 `test-20261103-1512-cad-preview-controls-38e9b001`，来源 `origin/wmj@3c62241168b275f65fe18603291996cae4a04bc4` 加 `codex/cad-preview-async-paint` 工作树补丁；`viewerVersion = viewer-5cff5524…`、`releaseDigest = 38e9b001…`，引擎与 CAD 镜像未变，正式生产未部署。
- 修复：预览打开时锁定背景页面滚动并在关闭后恢复；DWG「部分显示」提示在就绪后约 2 秒自动关闭且可手动关闭；移除 CAD iframe 原生 `title`，消除鼠标悬停文件名提示卡；标题栏增加全屏按钮并同步进入 / 退出状态，退出全屏后 500 ms 内按 Esc 不关闭整个预览。
- 发布一致性：`/srv/data/deploy-cad-preview-controls-38e9b001-20261103-1512/` 下前端 / 服务端 / shared 包分别为 22,088,856 B · `672a04f8…`、999,630 B · `ccd07843…`、375,273 B · `ff21f344…`；10 / 10 容器 healthy，站点根、`/healthz`、`/readyz` 均 200，就绪四项探针通过。测试清单 145,637 B · `ed4481a1…` 已原子替换，含 23 条增量记录。
- 浏览器回归：34,385,320 B 业务 DWG（`fileId=7f18b3a7…`、`versionId=a7be31b9…`，`partial`）确认背景滚动锁定与恢复、提示自动关闭约 1,925 ms、按钮关闭约 42 ms、iframe 悬停提示移除；静态资源本地 / 容器 / 公网哈希一致。
- 边界：原生全屏进入 / 退出和 Esc 防误关仍需真实 Chrome 人工点按确认，自动化点击会立即释放全屏焦点；测试库无 76 MB 源 DWG，34 MB 文件本身为 `partial`，不能宣称零缺损或覆盖首次按屏幕重建的既有秒级长任务。

### 9.4 CAD 大图首开 Worker 优先与投影降重（2026-11-03 16:38）

- 发布：公司测试机 `test-20261103-1638-cad-first-paint-f790edd4`，前端 `viewerVersion = viewer-936fa59d…`、`releaseDigest = f790edd4…`；来源为 `origin/wmj@3c622411` 加 `codex/cad-preview-async-paint` 工作树补丁。正式生产未部署，API / worker 与 CAD 镜像未重建。
- 首开路径：保留实例大图只要加速可用且当前绘制量 ≤ 200,000，就优先让后台 Worker 合成完整首帧，不再因为尚无可预览画面强制走主线程；Worker 启动、字体初始化、提交或首帧发布失败时回退主线程分帧。`ready` 等待实际首帧发布，失败路径完成 first-paint 收口，避免加载悬挂。
- 投影与首帧开销：打包传输层按显示行复用 `representationId`，去除投影阶段约 14.9 万次重复 SHA-256；同一真实 Manifest 的 Node 投影由 1,443 ms 降至 727 ms（163,000 draws / 453 groups / 1,478,198 展开项）。查看器把 `Path2D` 改为实际绘制时按需创建，去掉 163,000 个 draw 的重复 `sort`，回归确认绘制插入顺序仍等于源 `drawOrder`。
- 验证：`drawing-instances.test.mjs` 21/21、相关模块 `node --check`、前端 `npm run typecheck` / `npm run build`、`build-release.py --check` 均通过。真实 34,385,320 B 业务 DWG 确认 `workerPaint=complete`、`instancePaint=complete`、无 Worker 错误，14 个分块内部合计 1,038 ms、6,732 次 stroke / 37,565 段，截图可见完整图纸。
- 发布一致性：前端包 22,090,201 B · `27f0f87c…`；公网 / 容器 `drawing-viewer.js` 均为 153,188 B · `54230941…`，`dwg-packed-transport.js` 为 11,233 B · `e7a91bfb…`。测试清单 158,872 B · `21c367fe…`，24 条增量，补记 15:58 / 16:07 / 16:17 / 16:33 四个中间构建。
- 边界：复测标签页位于最小化 Chrome 窗口，rAF 被节流；后台 `refreshTotalMs=14,134.6 ms`、`readyPaint=25,518.6 ms` 不是前台墙钟结果，前台复测仍待完成。测试库无 76 MB 源 DWG，34 MB 文件仍为 `partial`；Worker 仍有 200,000 绘制项上限，首次按屏幕重建与超大文件不能宣称固定耗时或零缺损。

### 9.5 CAD 首开并行资源预取与主线程微优化（2026-11-03 18:50）

- 发布：公司测试机 `test-20261103-1850-cad-entry-prefetch-fc4a4d60`，前端 `viewerVersion = viewer-d66e51db…`、`releaseDigest = fc4a4d60…`；前端、server、shared 一起部署，API / worker 重启加载新契约与资源摘要，CAD 镜像未变，正式生产未部署。
- 接口边界：完成态任务返回 lease、buffer SHA-256 与 byteLength 的资源摘要，最多 256 项，不发布对象存储 key；buffer 仍要求匹配 lease、已完成产物与未取消 / 未过期窗口。
- 首开路径：任务就绪后立即并行预取最大 4 个几何 buffer，manifest 下载与几何下载不再串行；预取命中仍校验 manifest 引用、长度和 SHA-256，失败、长度不符或取消时回退受控资源路由并释放 lease。二维重建移除 16 万 draw 的临时数组、重复样式计算和重复文字测量，无裁剪路径复用冻结空区域。
- 实测：34,385,320 B 业务 DWG 的 7,604,739 B br manifest 与 9,199,128 B br geometry buffer 在 300 ms 内并行发起（API 1,511 ms / 1,815 ms）；浏览器两次 `packedUnpacked → buffersHydrated` 为 291 / 338 ms，旧链路同一视图约 1,069 ms。前台 `readyPaint` 两次为 11.3 s / 15.3 s，仍由 1,478,198 绘制项主导，不作为固定 SLA。
- 发布一致性：前端包 22,088,810 B · `91452017…`、server 包 1,002,233 B · `86d7e7fd…`、shared 包 375,685 B · `a5096000…`；公网 `drawing-viewer.js` 154,022 B · `363cbaeb…`、`platform-entry.js` 21,599 B · `a40df98d…`。清单 173,094 B · `e923d586…`，25 条增量；10 / 10 容器 healthy，站点根 / healthz / readyz 200 且四项探针通过。
- 验证 / 边界：prefetch 3/3、clipping、instances、packed transport、server 资源契约 12/12，shared / server / frontend typecheck 与 build 通过；正式生产未部署，测试库仍无 76 MB 源 DWG，34 MB 文件为 `partial`，首次按屏幕重建与 200,000 项以上主线程分帧仍需专项压测。

## 10. 正式生产部署与浏览器验收（2026-10-26）

本节记录 `pm.libiaorobot.com` 的正式生产接线与首轮真实账号浏览器验收；不把首帧 / 产品树验收等同拾取、显隐 / 隔离 / 恢复或跨重启复用的完整验收。

- 代码与静态资源：正式前端升级为 `main@7be763d6`（PR [#658](https://github.com/PanXing-Libiao/LibiaoLink/pull/658)），包含 ONLYOFFICE 60 秒冷启动等待与 CAD iframe 宿主加载卡；后端源码与 CAD 镜像未替换。公网 `index.html`、JS、CSS、`/cad-viewer/index.html` 及三个查看器静态模块均 200，哈希与本地构建一致。
- 运行接线：正式机原已存在 `libiaolink/cad-sandbox:1.0.1-c18b417e@sha256:aeee8b4b072eca1aaf0b2db0d65b972f341e3da07a413aaec07d259d03a9879c` 容器与 `0064_cad_artifacts.sql` 迁移，但 API/worker 未加载 `docker-compose.cad.yml`，`server.env` 的 `CAD_ENGINE_SOCKET` 为空，预览接口返回 `cadPending`。备份 `/srv/data/backups/before-cad-enable-20261026-210321/` 后，以已评审 overlay 强制重建 API/worker；二者只读挂载 `cad_socket`，使用 `/run/cad/engine.sock`。未重跑迁移、未改源码、未改镜像，七个容器均 healthy。
- 浏览器验收：真实公司账号在 Chrome 打开 `pdf3d_sample_2.pdf`，ONLYOFFICE 正常显示 82 页；打开 `pythonocc_as1_pe_203.stp` 后显示导入进度，`data-cad-ready-ms=2977`，零件结构 64 项，三维模型正常，浏览器 console error 0。数据库 `cad_artifacts` 为 `completed`（139,752 B，SHA-256 `e14f7a52b3f0…`），引擎版本 `step-0.3.3/f103d1c40812b24c3864ae90a91ea707f734dfb5/gateway-1`。
- 边界 / 回滚：拾取、显隐 / 隔离 / 恢复、跨重启复用及非 STEP 通道仍待专项验收。CAD 回滚恢复上述备份配置并以基础 compose 重建 API/worker（同时停 CAD）；完整发布包、前端备份和验收证据见 [deploy/prod/README.md](../../deploy/prod/README.md) 顶部记录。
