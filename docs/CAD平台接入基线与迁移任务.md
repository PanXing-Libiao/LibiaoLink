# CAD 平台接入基线与迁移任务

更新：2026-10-22。CAD 主责 wmj，共享 file/preview/outbox 由 lan 协办，通用 UI 与部署由 px 协办。

本文统一替代 LibiaoLink 原 CAD 选型、浏览器解析和工程测量实施计划。用户已批准接入及旧实现清理。STEP 的版本、任务、资源和查看器已部署公司测试机并通过容器与旁路验证；生产环境尚未部署，真实公司账号浏览器验收待完成。决策见 [ADR-035](adr/ADR-035-CAD接入独立能力工程.md)。

## 1. 已有能力与唯一基线

CAD 能力以独立工程 `CAD逆向` 的 STEP v0.3.3（几何基线 `0911573`，宿主适配源码固定 `f103d1c`）及其 `CAPABILITY_MATRIX.json`、`STEP_0_3_RESULTS.md` 为准。后续升级须登记实际提交与能力矩阵，不沿用 LibiaoLink 历史后缀白名单、PoC 数字或网格测量结论。

| 项目 | 独立工程已有能力 | LibiaoLink 当前状态 |
| --- | --- | --- |
| STEP | 转换、产物校验、首帧、产品树、面拾取、显隐/隔离/恢复；组合补面与缺失明细 | 已接入公司测试机；运行环境已启用 STEP，原文件下载保留 |
| 模型与传输 | UCD 2.0 文档/快照、manifest、二进制几何、ID 字典、gzip | 已接入版本/权限/窗口隔离任务、gzip manifest、二进制几何与资源释放 |
| EASM | 仅能力矩阵中已验证范围；语义须有 eDrawings 原生逆向依据 | 待接入；不依赖 eDrawings 运行时交付 |
| DXF | 仅能力矩阵中已验证的实体、样式、布局与诊断范围 | 待接入；不等同任意二维 CAD 支持 |
| DWG / IGES / 3MF 等 | 不由历史白名单推定支持 | 识别为 CAD 待接入提示不等于支持解析 |
| 工程尺寸依据、PMI、公差 | 不作为当前交付能力 | 旧测量计划撤回，另按业务需要立项 |

独立工程的文件打开成功不等于平台联调成功。测试机已覆盖版本、任务、资源权限和交互，并完成受控箱体夹具的容器内 native 冒烟；真实公司账号、业务文件与浏览器完整交互仍需另行验收。

## 2. 已接入的链路

以下描述 ADR-037 的持久化与上传预解析代码链路，本次变更尚未推送或部署；前文的测试机部署状态属于既有 STEP 接入。

`上传完成 → 事务登记后台任务 → 沙箱解析/校验 → 持久 manifest/buffers → 文件预览复用 → 鉴权资源 → 独立 ViewerSession`。

- 平台通过既有 ObjectStorage 读取版本对象，核对大小与 SHA 后，经 Unix HTTP socket 将原始字节送入独立 CAD 沙箱；产物以有界流返回，不传本机路径、S3/数据库凭据或客户端 URL。旧 API 内 stdio/native 路线撤回；原始输入仍由平台完整读入内存，尚非输入流式改造。禁网、内核资源硬限额与迁移见 [ADR-036](adr/ADR-036-CAD解析沙箱与资源硬限额.md)。
- `server/cad-engine/source.json` 固定独立源码提交、schema 和浏览器依赖逐文件 SHA；更新只运行同步脚本，宿主副本不另改 CAD 规则。OCP 和 Gmsh 使用两套固定版本 Python 环境，不复制本机虚拟环境。
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

名称编码由“模型信息”按文件选择，当前标签页按 fileId/versionId 记忆。使用固定 OCCT 的 `read.step.codepage`，默认 UTF8，中文旧编码为 GB；非法值拒绝，所选码页进入缓存键、规则摘要和检查记录。源字节、SHA、身份算法及网格参数保持原值，不自动推测旧编码。源码依据与原生定向检查见独立工程 `docs/step-0.3/name-encoding/README.md`。

## 4. 沿用的 STEP 接收政策

优先尝试现有原生及 pcurve 修复，再按独立工程组合路线对失败面处理；不改变全局网格参数，不引入未登记近似。保留 `step-display-area/2` 误差检查。

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

该本地轮次保留了测试身份/存储夹具的明确标识，没有把本地夹具等同公司 SSO、数据库或对象存储；后续推送、合并与测试机部署见 §8，生产仍未部署。

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
- 待完成：使用真实公司账号在浏览器打开真实业务 STEP 文件，完成打开、首帧、产品树、拾取、显隐/隔离/恢复走查；生产环境未部署。
