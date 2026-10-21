# H1 SVG 预览同源存储型 XSS 整改方案与执行切片

> 来源：`LibiaoLink_安全审查报告_2026-10-19.pdf` H1（第 5 页）｜严重度 High｜报告要求：上线前处理
> 报告审查基线：`e13664f`｜方案落档时 `lan` 分支 HEAD：`d6ae272`（审查基线祖先；H1 涉及路径未发现实质修复）
> 起草：lan（后端平台 / file / preview / outbox）｜拟稿日期：2026-10-20｜状态：**S1 架构 / 契约已批准（ADR-034 Accepted，PR #518 已合入 main）；S2 已随 PR #523 合入 main `e2b6aab`；S3 已随 PR #529 合入 main `acd6113`；S4 已随 PR #531 合入 main `db7d5e0`；S5 已随 PR [#534](https://github.com/PanXing-Libiao/LibiaoLink/pull/534) 合并 main `660cc80`；S6 自动化矩阵已实现且 PR CI 全绿（[run 39540053943](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/39540053943) 5 / 5、矩阵 25 / 25），PR [#539](https://github.com/PanXing-Libiao/LibiaoLink/pull/539) 待评审合并；尚未部署测试机或生产，H1 未闭环；外部 V1.0 源文档同步已按 2026-10-21 指令移出本整改跟踪**
> 归属与评审：本文件位于 `docs/`（px 主责），合入前请 px 复核；ADR 与契约口径由 wmj 主责；生产部署、Nginx 与浏览器测试设施由 px 主责；服务端预览与队列由 lan 主责
> 变更控制：后续执行以本文件为准。若执行中需要改变架构、验收条件或切片顺序，先修改本文件并说明原因；已合入主干的 ADR 与回放证据按不可变历史处理，不原地重写。

## 1. 结论

H1 不能靠前端隐藏预览入口、SVG 内容净化或单独增加 `Content-Disposition` 解决。最终方案是：

1. **原始 SVG 永不内联直出**，也不再返回指向原 SVG 的预览签名 URL。
2. **保留 SVG 在线预览**：服务端将 SVG 栅格化为静态 PNG，前端继续用现有 `<img>` / `ImageZoomViewer` 展示 PNG，缩略图、大图与缩放能力不回退。
3. 原始 SVG 只允许通过下载接口以 `Content-Disposition: attachment` 下发，响应类型按 `application/octet-stream` 处理，原文件字节保持不变。
4. 不采用“净化后同源内联 SVG”。SVG 的脚本、事件属性、`foreignObject`、外部引用、CSS URL、XML 实体等面太多，净化器与浏览器解析差异容易形成绕过。
5. 不复用已退役的 `deploy/preview`（LibreOffice 全量转换栈）。新增 `deploy/svg-preview/` 轻量栅格化服务，复用现有 `preview.job`、outbox 重试、`preview_artifacts` 与前端 `not_ready → ready` 轮询。
6. 不新增数据库迁移。继续使用既有 `target=image` 表达“浏览器图片查看器通道”；SVG 的 `image` 产物强制为 PNG。
7. 预览管线版本切换为 `2.0.0`，避免命中旧 `1.0.0` 的直通 SVG 产物；旧产物不删除，但新预览读面不再引用。
8. 同源响应头、独立对象存储域、上传完成后服务端全量哈希校验作为纵深项分切片落地；其中 P0 上线闭环为 S1 ~ S6。

一句话口径：**SVG 可以看，但浏览器只能看到服务端生成的 PNG；原始 SVG 只能下载，不能作为同源文档打开。**

## 2. 审查事实与当前攻击链

### 2.1 报告证据

| 证据位置（2026-10-20 当前代码） | 关键事实 |
|---|---|
| `server/src/modules/file/file.service.ts:261`、`:448` | 上传会话直接保存客户端 `mime`；完成上传复制到正式对象时继续沿用。 |
| `server/src/modules/file/preview.targets.ts:21`、`:24-27` | SVG 被列入图片扩展名；任何 `image/*` MIME 也会被识别为图片。 |
| `server/src/modules/file/preview-read.service.ts:91-92` | 图片直接进入 `serveImageDirect`，不进入转换、净化或类型复核。 |
| `server/src/modules/file/preview-read.service.ts:224-227` | `serveImageDirect` 直接签原对象，不传文件名，因此不强制 attachment。 |
| `server/src/storage/s3-object-storage.ts:219-232` | 只有 `fileName` 存在时才设置 `Content-Disposition: attachment`。 |
| `deploy/prod/nginx/libiaolink.conf:115-127` | 对象存储通过主站同源 `/libiaolink/` 门面暴露，签名对象与主站共享 origin。 |
| `server/src/modules/identity/auth.controller.ts:97` | CSRF Cookie `ll_csrf` 非 HttpOnly，应用源脚本可读取。 |

### 2.2 利用链

1. 攻击者以 `poc.svg`、`image/svg+xml` 上传包含 `<script>` 的 SVG。
2. 完成上传后调用预览接口，取得短时同源签名 URL。
3. 普通 `<img>` 不执行 SVG 脚本，但攻击者可诱导受害者在浏览器顶层打开该签名 URL；浏览器把 SVG 当文档解析，脚本在应用源执行。
4. 脚本可读取 `ll_csrf`，借助仍然有效的 HttpOnly 会话 Cookie 调用写接口，或读取页面可见数据后外传。
5. 缺少 CSP 等响应头使利用更稳定。

### 2.3 必须始终成立的安全不变量

- 任何 SVG、HTML、XML 或其他主动内容都不得在应用源内联展示。
- 前端拿到的 SVG 预览地址必须指向 `previews/{contentHash}/2.0.0/image` 下的 PNG 产物，不得指向 `projects/.../*.svg` 原对象。
- 原始 SVG 的唯一下载形态是 attachment；下载响应不得被浏览器当作活动文档渲染。
- 图片 MIME 不允许 `startsWith("image/")` 宽松匹配；必须使用规范化后的精确 MIME 白名单，并与扩展名、文件头一致。
- 服务端是唯一可信裁决点；隐藏按钮、前端扩展名判断或 CSS 遮罩都不算安全边界。
- 栅格化服务不可用时只能降级为“请下载查看”，不得回退到原始 SVG 内联签名。
- 未知、冲突或无法验证的 MIME / 内容一律 fail closed。

## 3. 目标架构

```text
上传完成
  → 服务端读取对象头 / 计算并核对哈希
  → 规范化 MIME（扩展名 + 文件头 + 精确白名单）
  → 版本行保存服务端判定的 MIME

SVG 预览
  → GET /files/{id}/preview
  → isSvgFile
  → target=image，登记 / 复用 preview_artifacts
  → outbox preview.job（pipelineVersion=2.0.0）
  → worker 读取原对象
  → deploy/svg-preview /convert
  → 固定版本 resvg 栅格化为 PNG
  → 校验 PNG 魔数 / 尺寸 / 字节上限
  → 写 previews/{contentHash}/2.0.0/image
  → 前端轮询得到 ready + PNG 签名 URL
  → 现有 <img> / ImageZoomViewer 展示

原始 SVG 下载
  → download-url
  → attachment + application/octet-stream
  → 原字节不变
```

### 3.1 渲染器与部署边界

- 渲染器：`@resvg/resvg-js`，实施时锁定 `2.6.2` 精确版本（当前 npm latest；MPL-2.0），同步提交锁文件、镜像 digest 与许可证记录。升级按 `CONTRIBUTING.md` 第 13 节走独立依赖 PR。
- 服务目录：`deploy/svg-preview/`，不复活 `deploy/preview/`。
- 接口：保持现有转换器 wire contract 的 `POST /convert`、`GET /healthz`，继续由 `PreviewConverter` 调用；只接受 SVG + `x-preview-target: image`，其他输入返回 415 / 501。
- 响应：`Content-Type: image/png`、`X-Pipeline-Version: 2.0.0`、`X-Convert-Mode: rasterize`、`X-Request-Id`、耗时与产物尺寸。
- 字体：镜像内固定携带一套 Noto Sans CJK SC（OFL），`loadSystemFonts: false`，构建期与运行期校验中文文字可渲染。
- 服务不接触对象存储、不持有 S3 凭证；文件字节由 worker 送入、PNG 字节由 worker 取回。

### 3.2 栅格化安全上限（起点值）

| 限制 | 起点值 | 处理 |
|---|---:|---|
| 源 SVG 大小 | 20 MiB | 超限 413 / 确定性失败，降级下载 |
| 输出长边 | 1600 ~ 4096 px | 按源尺寸缩放；极长宽比同时受总像素限制 |
| 输出总像素 | 16,777,216 | 超出拒绝，防内存放大 |
| 输出 PNG 大小 | 20 MiB | 超出失败，降级下载 |
| 单次硬超时 | 10 s | 超时杀转换子进程，返回 504 |
| 并发 / 队列 | 1 / 4 | 满队列返回 503，由 outbox 退避重试 |
| 容器资源 | 1 CPU / 256 MiB / PIDs 64 / tmpfs 128 MiB | 只读根文件系统、非 root、cap drop ALL、`no-new-privileges` |
| 网络 | 无外网 | 仅 worker 所在 prod internal 网络可达 |

以上值为实现起点，S1 定档；真实样本压测后只能收紧或经评审调整，不得为了兼容未知大图取消硬上限。

### 3.3 SVG 输入预检

栅格化服务在调用 renderer 前做保守预检，命中任一条件即拒绝并返回可读原因：

- `DOCTYPE` / 自定义实体 / 外部 DTD；
- `<script>`、事件属性（`on*`）、`<foreignObject>`；
- 外部 `href` / `xlink:href`、`<image>` 外部资源、`@import`、非片段 `url(...)`；
- 非法、零、无穷或超出上限的宽高 / viewBox；
- 解码后不是以 `<svg>` 为根的元素。

renderer 不执行脚本；服务容器无外网、不配置外部资源目录，并由预检拒绝外部引用。预检、容器隔离与“产物只可能是 PNG”三者共同构成纵深，不把预检当成唯一安全边界。

## 4. 服务端改造

### 4.1 MIME 规范化与上传完成校验

客户端 `mime` 只作为声明提示，服务端在完成上传时重新判定：

1. 扩展名转小写；MIME 去参数、去空白、转小写（`image/svg+xml; charset=utf-8` → `image/svg+xml`）。
2. 使用精确白名单，不允许 `image/*` 前缀匹配。
3. 通过存储端口的新增 Range / prefix 读取能力检查文件头（不把 GB 级原文件整块读入内存）；声明 MIME、扩展名、实际内容三者不一致时拒绝完成上传。
4. 数据库 `file_versions.mime` 只保存服务端规范化的精确 MIME；**原始对象在对象存储中一律写 `application/octet-stream`**，不保存客户端 MIME，也不把原对象元数据当作浏览器投递类型。预览产物单独写 `image/png`。
5. 无 MIME 时可由扩展名 + 文件头推导；无法唯一推导则保存 `application/octet-stream` 并禁止内联。

白名单起点：

| 扩展名 | 规范 MIME | 预览方式 |
|---|---|---|
| `.png` | `image/png` | 原对象直签，响应强制 `image/png` |
| `.jpg` / `.jpeg` | `image/jpeg` | 原对象直签，响应强制 `image/jpeg` |
| `.gif` | `image/gif` | 原对象直签，响应强制 `image/gif` |
| `.webp` | `image/webp` | 原对象直签，响应强制 `image/webp` |
| `.bmp` | `image/bmp` | 原对象直签，响应强制 `image/bmp` |
| `.tif` / `.tiff` | `image/tiff` | 原对象直签，响应强制 `image/tiff` |
| `.avif` | `image/avif` | 原对象直签，响应强制 `image/avif`；需补 AVIF 魔数测试 |
| `.svg` | `image/svg+xml` | **禁止直签；只走 PNG 栅格化** |

若实施时不能可靠验证 AVIF 文件头，则从服务端图片白名单移除并同步前端入口；不得继续用宽松 MIME 让它直出。

### 4.2 预览类型拆分

- 将现有 `isImageFile` 拆成：
  - `isRasterImageFile`：只接受上表的安全位图精确组合，允许原对象直签。
  - `isSvgFile`：扩展名为 `svg` 或规范 MIME 为 `image/svg+xml`，只允许进入 PNG 产物通道。
- `previewTargetsFor` 对 SVG 返回 `["image"]`，其他类型保持现有查看器 / CAD / 降级路由。
- `getPreview` 的判定顺序改为：SVG 产物通道 → 安全位图直签 → CAD 三维 → 查看器 → 降级；SVG 永远不能落到位图直签分支。
- 对存量记录：扩展名、MIME、历史内容无法证明安全时按不透明文件处理，只能下载。不得把旧数据库中客户端提交的 `mime` 当作可信值。

### 4.3 原对象直签与下载响应

扩展 `DownloadUrlInput`，允许签入响应覆盖：

- `responseContentType`
- `responseContentDisposition`
- `responseCacheControl`（必要时）

安全规则：

- 安全位图预览：显式 `ResponseContentType` 为规范 MIME，`Content-Disposition: inline`，文件名使用服务端生成的 `.png/.jpg/...`。
- CAD 三维原对象直签：`ResponseContentType: application/octet-stream`；CadViewer 只读取字节，不依赖浏览器按模型类型渲染。
- 任意原文件下载：`attachment` + `application/octet-stream`，文件名仍按版本真实扩展名。
- SVG 预览：只签 PNG 产物，不签原 SVG。
- 任何无法映射到安全响应类型的原对象：不得签发 inline 预览地址。

同时收紧受控 `preview-content` 端点的 `Content-Type`：主动内容或未知类型不得以可执行文档类型在本应用源返回。

### 4.4 SVG 缓存键完整性

`preview_artifacts` 的缓存键以数据库 `file_versions.content_hash` 为准。为避免伪造哈希串用已有产物：

1. SVG 进入预览缓存前，worker 对源对象重新计算 SHA-256。
2. 实际哈希必须与版本行一致；不一致则确定性失败，不登记 ready、不写产物，错误原因只面向用户显示通用降级文案。
3. S8 将同样的服务端重算推广到所有上传完成路径；在 S8 完成前，至少保证 SVG 路径不信任客户端哈希。

### 4.5 产物写入与读取校验

- worker 检查转换器响应必须是 `image/png`，实际字节前 8 字节必须匹配 PNG 魔数。
- 读取 IHDR，尺寸不得超过 3.2 的像素上限。
- 产物对象写 `Content-Type: image/png`，元数据继续记录三元组、源版本、pipelineVersion、requestId、conversionMode。
- `preview_artifacts` 只在上述校验全部通过后置 `ready`；否则按既有语义置 `failed + reason`。
- `serveReady` 对 `target=image` 的响应显式签 `image/png`，禁止沿用对象存储中不可信的历史 Content-Type。

## 5. 安全响应头与同源门面

### 5.1 对象存储门面（P0 必需）

对 443 的 `/libiaolink/` 和 9443 门面同时增加：

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `X-Frame-Options: DENY`

使用 `always`，并确认 Nginx 子级 `location` 没有覆盖掉 `add_header`。这是纵深项，不替代“SVG 不内联”。

### 5.2 应用入口（P0 必需）

对 SPA 文档响应增加：

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy` 实际口径：`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`。其中 `'wasm-unsafe-eval'` 仅用于 CAD 的本地 WASM 编译，不引入 `'unsafe-eval'`。
- `X-Frame-Options: DENY`

上线前用浏览器回归确认 SPA、ONLYOFFICE 外壳、CAD WASM / Worker、导出打印 iframe 均未被 CSP 误伤；若需调整，必须记录具体指令与原因。

### 5.3 独立对象存储域（S7 · 纵深）

将浏览器侧对象存储切到独立域名（例如 `storage-test-pm.libiaorobot.com`）：

- 与应用站不同 origin，SVG 即使发生解析缺陷也读不到应用 Cookie（Cookie 必须继续 host-only，不设 `Domain`）。
- CORS 只允许应用 origin；不返回 `Access-Control-Allow-Credentials`。
- 保留 `nosniff`、CSP sandbox 与 attachment 规则。
- 9000 / 9443 不成为新的公网替代入口；DNS、证书、SigV4 host 与 CORS 在部署 Runbook 中同步。

## 6. 执行切片

粗估总工作量：**P0 闭环 S1 ~ S6 约 8 ~ 13 人日**；S7、S8 各约 2 ~ 3 人日。估算不含评审等待；三人可并行时目标为约 1 ~ 1.5 周完成 P0。

| 切片 | 内容 | 主责 / 评审 | 依赖 | 交付物 |
|---|---|---|---|---|
| S1 | ADR-034「SVG 预览安全栅格化」与设计 / 需求口径同步 | wmj / lan、px | 无 | ADR、索引、技术设计 / 系统功能书 / 前端功能需求同步；外部 V1.0 源文档同步按 2026-10-21 指令移出本整改跟踪；本方案保持最新 |
| S2 | 服务端类型边界、MIME 校验、SVG 永不直签、下载响应安全化 | lan / wmj | S1 | server 代码与单测；存量 fail-closed；无迁移 |
| S3 | `deploy/svg-preview/` 轻量栅格化服务与沙箱加固 | px + lan / wmj | S1 | 镜像、锁版本、healthcheck、安全 / 功能自检、README |
| S4 | SVG 接回 `preview.job`，PNG 产物校验与缓存 | lan / wmj | S2、S3 | 队列 / 产物 / env 接线；pipelineVersion 2.0.0；PNG 证据 |
| S5 | Nginx 与应用响应头硬化 | px / lan | 无（可与 S1 ~ S4 并行） | `/libiaolink/`、9443、SPA 头；`nginx -t` 与 curl 证据 |
| S6 | 浏览器回归、CI job、最终回放证据 | px + lan / wmj | S2 ~ S5 | `h1-svg-preview-e2e.mjs`、npm 脚本、独立 CI job、证据文档 |
| S7 | 独立对象存储域与无凭证 CORS | px + lan / wmj | S5 | 独立 origin 部署与回归；可单独 PR 上线 |
| S8 | 所有上传完成后服务端流式 SHA-256 重算 | lan / wmj | S2 | 上传完成 422 校验、全类型回放；可单独 PR 上线 |

### S1 · 决策与文档冻结

- 执行状态（2026-10-20）：wmj 已批准架构与契约，ADR-034 转 Accepted，PR #518 squash 合入 main `c53e895`。仓库内文档已完成同条同步；px 的前端 / 运维复核仍待确认。外部 V1.0 源文档人工同步已于 2026-10-21 按项目负责人指令移出本整改跟踪。
- 新建 `docs/adr/ADR-034-SVG预览安全栅格化.md`，状态先为 Proposed，评审后 Accepted；同步 `docs/adr/README.md`。
- 更新 `系统功能书.md` D2 预览口径、`前端功能需求.md` 的 SVG 预览 / 轮询 / 下载行为、`技术设计v0.2-架构与数据模型.md` 的预览管线说明。
- 若 `mime` 字段语义由“客户端声明”改为“服务端规范化值”，同步 `字段对照清单.md`。
- 明确 `target=image`、`pipelineVersion=2.0.0`、无数据库迁移、原 SVG download-only。
- 验收：ADR 与三处文档无冲突；wmj 批准契约与架构口径；px 确认前端展示与运维可行。外部 V1.0 源文档同条同步按 2026-10-21 指令移出本整改跟踪，不作为 S1 闭合阻塞项。
- 评审收口：ADR-034 与 `docs/adr/README.md` 已记录 wmj 批准及 PR #518 合并基线。外部 V1.0 源文档不在本仓库内维护，已按 2026-10-21 指令移出本整改跟踪。

### S2 · 服务端硬边界（安全止血）

- 执行状态（2026-10-21）：已随 PR #523 合并 main `e2b6aab`；`PREVIEW_PIPELINE_VERSION` 仍为 `1.0.0`，切 `2.0.0` 属 S4。SVG 已保留在线预览入口，但读取面只投递 / 返回 `target=image` 的 PNG 产物，原 SVG 永不进入直签分支。合并 `main` `e674b58` 后最终门禁 = server `typecheck` / `build` / `check:boundaries` 通过，Vitest **85 文件 / 1323 例**全过；含 64 KiB 前缀截断 UTF-8 多字节字符的合法 SVG / HTML 回归。

- 重构 `preview.targets.ts`；移除 `image/*` 前缀匹配与 SVG 位图直签。
- `file.service.ts` 完成上传时规范化 MIME、检查扩展名 / 文件头一致性；数据库保存规范 MIME，原始对象固定 `application/octet-stream`。
- 安全位图、CAD、下载分别签入安全响应类型；未知主动内容 fail closed。
- 增加类型矩阵单测：大小写、参数 MIME、双扩展名、MIME 冲突、`text/html`、`image/svg+xml`、无扩展名；文件改名 / 变更 / 历史版本仍按对象键扩展名裁决，不能靠改名绕过。
- 增加存量兼容测试：客户端 MIME 与扩展名冲突时只能下载，绝不能直签。
- 本切片可先合入代码但不得单独部署生产；上线窗口与 S3 / S4 同批，避免半成品状态。
- 验收：不存在 SVG → 原对象 inline 签名的代码路径；全部 server 测试通过。

### S3 · 栅格化服务

- 执行状态（2026-10-21）：`deploy/svg-preview/` 已随 PR #529 合入 main `acd6113`；S3 只交付沙箱服务与证据，不接主栈队列、不切生产版本。构建台账 = OCI digest `sha256:d0a2a405dc6eb557630369c641541a61690f34a1f12a551d8d22a5f39d2500cf`、linux/amd64、Node v24.21.0、490,998,073 B；容器自检 **40 PASS / 0 FAIL / 0 SKIP**，经 dev edge 实测 4096×4096 PNG 返回 200。实现过程中发现并修复 CSS 注释 / CDATA 分片绕过与 `image-set()` 外部资源面；`edge` 的 Compose `command` 不能覆盖镜像 ENTRYPOINT，已改 `entrypoint` 并收纳到 `dev` profile，默认只启 internal-only converter。详细契约与台账见 `deploy/svg-preview/README.md`。
- 新增 `deploy/svg-preview/`：Node 24 服务、resvg-js 2.6.2、固定字体、无外网、非 root、只读、资源与超时上限。
- 实现 `/convert`、`/healthz` 与现有 worker 客户端兼容；只接受 SVG + image。
- 加入恶意夹具：脚本、事件属性、`foreignObject`、外部图片 / URL、DTD、超大尺寸、极长宽比、超时、超内存。
- 加入正常夹具：普通图形、渐变、中文文字、透明背景、接近 4096 的矢量图；输出只能是有效 PNG。
- 构建阶段固定基础镜像 digest、依赖版本、字体文件与许可证；生成镜像 SHA-256 台账。
- 验收：服务内自检与容器逃逸 / 外网 / 写盘测试通过；坏输入全部确定性失败，无进程残留。

### S4 · 恢复 SVG 预览

- 执行状态（2026-10-21）：已随 PR [#531](https://github.com/PanXing-Libiao/LibiaoLink/pull/531) 合并 main `db7d5e0`，**未部署生产**。worker 以版本对象键推导真实文件名，SVG 固定发送 `image/svg+xml`；读取源对象后重算 SHA-256 并与 `file_versions.content_hash` 比对；独立校验 `image/png` + `rasterize` + PNG 魔数 / IHDR / 8-bit RGBA / 尺寸 / 像素 / IEND / 20 MiB；通过后才写 `previews/{contentHash}/2.0.0/image`。`PREVIEW_PIPELINE_VERSION` 与服务端默认值、生产模板均切 `2.0.0`；`deploy/prod/` 增加 internal-only `svg-preview` 服务与 worker 双网络接线。定向回归覆盖旧 1.0.0 不命中、哈希不一致、坏 PNG、Content-Type / mode 不合规与失败不原地重试；server 全量 **85 文件 / 1330 例**、typecheck / build / boundaries 全绿。S5 已随 PR #534 合并 main `660cc80`；S6 自动化矩阵已实现并通过 PR CI（run `39540053943` 5 / 5、矩阵 25 / 25），PR #539 待评审合并；生产发布仍未执行。
- `previewTargetsFor(SVG) => ["image"]`；`PREVIEW_PIPELINE_VERSION=2.0.0`。
- worker 对 SVG 源对象重算 SHA-256，校验 PNG 魔数 / IHDR / 字节上限，再写 `preview_artifacts`。
- 失败保留现有 `failed + reason` 三态；前端仍按 `not_ready` 轮询，不改生产前端组件。
- 增加队列单测：缓存键 2.0.0、错误 PNG 拒绝、哈希不一致拒绝、失败不原地重试。
- 验收：同内容只栅格化一次；成功返回 PNG URL；失败无 SVG 回退；旧 1.0.0 产物不被读取。

### S5 · 响应头

- 按第 5 节修改 Nginx 443 / 9443 与 SPA 头。
- 先用测试机验证 CSP 不破坏 SPA、ONLYOFFICE、WASM / Worker、导出打印与图片加载。
- 验收：`nginx -t` 通过；curl 断言 `nosniff`、CSP、HSTS、XFO；浏览器控制台无 CSP 阻断错误。
- 执行状态（2026-10-21）：已随 PR [#534](https://github.com/PanXing-Libiao/LibiaoLink/pull/534) 合并 main `660cc80`，**尚未部署测试机或生产**。`deploy/prod/nginx/libiaolink.conf` 的 SPA 入口使用同源 CSP（含 CAD WASM 所需 `'wasm-unsafe-eval'`）、HSTS、`nosniff` 与 XFO；443 `/libiaolink/` 与 9443 使用 CSP sandbox、`script-src 'none'`、HSTS、`nosniff` 与 XFO，并先隐藏上游同名头，避免重复。生产固定镜像 `nginx:1.30.5-alpine@sha256:0985e772…` 本地 `nginx -t` 通过；curl 已验证三条路径的响应头。Headless Edge 验证 SPA 根无 CSP violation、WASM / Blob Worker / `srcdoc` 可用；恶意 SVG 顶层打开时脚本被 sandbox 阻断、无 `/api/v1` 请求、Cookie 读取为 `SecurityError`。测试机关联 ONLYOFFICE 外壳、导出打印与真实 CAD 文件的完整 B7 回归仍由 S6 / 发布窗口执行。

### S6 · 浏览器回归与上线证据

- 新增 `frontend/scripts/h1-svg-preview-e2e.mjs`，沿用现有 CDP 无头 Chrome 基座。
- `frontend/package.json` 增加 `preview:svg-e2e`。
- `.github/workflows/ci.yml` 增加独立 `svg-preview-e2e` job；先完成至少 3 次 main 连续全绿，再由 px 将其加入分支保护必需检查。
- 新增 `docs/H1-SVG预览整改回放证据.md` 与脱敏 JSON 摘要；不得记录会话 token、Cookie、签名 URL 的敏感查询参数或生产数据。
- 验收：第 7 节全部浏览器用例通过，证据与命令可复跑。
- 执行状态（2026-10-21）：`h1-svg-preview-e2e.mjs`、`h1-nginx-ci-config.mjs`、`h1-onlyoffice-stub.mjs` 与 `preview:svg-e2e` 已实现；独立 `svg-preview-e2e` job 覆盖 B1 ～ B7，使用真实 PostgreSQL / MinIO / 上传 API / `preview.job` / worker / `svg-preview` / 生产 Nginx 派生配置 / Headless Chrome，ONLYOFFICE 仅用 `api.js` 桩验证外壳生命周期。`summary.json`、失败截图与服务日志按白名单脱敏后作为 artifact 上传。脚本语法、frontend 两份 TypeScript 检查、`vite build`、Nginx 派生与 YAML 解析通过；PR [#539](https://github.com/PanXing-Libiao/LibiaoLink/pull/539) 的 PR CI [run 39540053943](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/39540053943) 已 5 / 5 全绿，`svg-preview-e2e` 的 B1 ～ B7 矩阵 **25 / 25 PASS**（Chrome 155）。B6 回放发现并修复任务抽屉 CAD 无预览入口，PDF / DOCX / STL 均通过。**S6 PR 尚未合并；main 连续 3 次全绿、`svg-preview-e2e` 加入分支保护、测试机 / 生产部署、真实 ONLYOFFICE / CAD 生产样本与旧签名过期复测均未完成。**

### S7 · 独立对象存储域

- 新域名、证书、Nginx、MinIO CORS、S3 endpoint 与 SigV4 host 同批切换。
- 只允许应用 origin 的 PUT / GET；禁止凭证模式；Cookie 不跨到存储域。
- 验收：上传、位图预览、CAD fetch、下载、SVG PNG 预览全链路；匿名访问仍拒绝；跨域脚本不能读取应用 Cookie。
- 回滚：短时签名 TTL 内保留旧门面只读窗口，再收回旧域名；不删除对象。

### S8 · 全量哈希完整性

- 上传完成、复制到正式对象键之前，对 staging 对象流式计算 SHA-256。
- 与客户端 `contentHash` 不一致返回 422 `FILE_HASH_MISMATCH`，清理 staging，不写版本行、不投缓存。
- 增加大文件流式哈希、并发完成、重试、哈希碰撞伪造与删除清理测试。
- 验收：对象键中的哈希、版本行哈希、实际对象三者一致；伪造哈希不能串用他人产物。

## 7. 验收与回归

### 7.1 功能性验收

- 正常 SVG 上传后 20 秒内进入 `ready`；缩略图真实渲染，`naturalWidth > 0`。
- 点击缩略图打开现有 `ImageZoomViewer`，缩放 / 拖动正常；图片源为 PNG 产物。
- PNG / JPEG / GIF / WebP / BMP / TIFF（以及确认支持的 AVIF）原有预览不回归。
- PDF / Office / 文本族仍走 ONLYOFFICE；CAD 三维仍走前端 WASM / three.js，不误入 SVG 管线。
- SVG 下载字节与上传原文件 SHA-256 相同，文件名 / 扩展名正确。

### 7.2 安全性验收

- `poc.svg` 的预览 API 永远不返回 `projects/.../*.svg`；只返回 `previews/.../2.0.0/image`。
- 预览 URL 响应为 `image/png`，PNG 魔数正确；顶层打开不执行任何 SVG 脚本。
- `<img>` 打开恶意 SVG、顶层打开预览 URL、顶层打开下载 URL 三种场景均无脚本执行、无业务 API 请求、无 Cookie 读取。
- MIME 大小写、`image/svg+xml; charset=utf-8`、双扩展名、扩展名 / MIME / 文件头冲突均不能绕过。
- 原始 SVG 下载响应为 attachment + `application/octet-stream`。
- `/libiaolink/` 与 9443 返回 `nosniff`、CSP sandbox、`script-src 'none'`；应用入口返回 HSTS、CSP、XFO。
- 转换器不可用时结果为 `failed` / “请下载查看”，不存在 SVG 直签回退。
- 旧签名窗口（至少 `PREVIEW_URL_TTL_SECONDS`）过期后复测，旧 SVG 预览 URL 已失效。

### 7.3 浏览器回归矩阵（S6 必测）

| 组 | 用例 | 关键断言 |
|---|---|---|
| B1 | 正常 SVG 缩略图 / 浮层 | `ready`、PNG URL、`<img>` 加载、缩放可用 |
| B2 | 恶意 SVG 的 `<img>` 与顶层打开 | 无脚本、无请求、无 `ll_csrf` 读取、无 DOM 注入 |
| B3 | MIME / 改名绕过矩阵 | 参数 MIME、大小写、双扩展名、冲突类型、改名后历史版本全部 fail closed |
| B4 | 原 SVG 下载 | attachment、octet-stream、SHA-256 与上传一致 |
| B5 | 位图回归 | PNG / JPEG / GIF / WebP 缩略图与浮层正常 |
| B6 | PDF / Office / CAD 回归 | ONLYOFFICE 与 CadViewer 不回归、不误路由 |
| B7 | 响应头 | `nosniff`、CSP、HSTS、XFO 生效；SPA 控制台无 CSP 错误 |

浏览器脚本必须监听网络与控制台：

- 恶意场景出现任何非预期 `/api/v1` 写请求即失败；
- 出现 `Runtime.exceptionThrown`、CSP violation 或脚本标记即失败；
- 顶层导航必须校验最终文档类型，不能只凭页面文本判断。

### 7.4 命令门禁

实现切片各自运行定向测试；P0 收口至少执行：

```powershell
cd shared
npm run typecheck
npm run check

cd ..\server
npm run typecheck
npm test
npm run build
npm run check:boundaries

cd ..\frontend
npm run typecheck
npm run build
npm run preview:svg-e2e

cd ..\deploy\svg-preview
docker compose build
docker compose run --rm svg-preview npm test
```

另需在部署机执行 `nginx -t`、healthz、真实上传与 curl 响应头检查。任何未运行或失败项必须在 PR、开发日志与回放证据中如实写明。

## 8. 发布、回滚与观测

### 8.1 发布顺序

1. S1 文档 / ADR 合并。
2. S3 栅格化服务构建并登记镜像 digest；先把同一 digest 镜像加载到目标机（离线归档或内网 registry），启动 internal-only `svg-preview`，完成容器与网络自检。此时无主栈消费者。
3. S2 + S3 + S4 同一发布窗口：确认 S3 镜像 digest 与 `SVG_PREVIEW_IMAGE` 一致后，更新服务器未跟踪的 `server.env`（`PREVIEW_CONVERTER_URL=http://svg-preview:9900`、`PREVIEW_PIPELINE_VERSION=2.0.0`、`PREVIEW_CONVERT_TIMEOUT_MS=15000`、`PREVIEW_CONVERT_MAX_SOURCE_MB=20`）。
4. 更新 api / worker 与生产 Compose，重启 api / worker；先验证 `svg-preview` 与 worker 互访 `/healthz`，再抽样验证 SVG 仅返回 `2.0.0` PNG 产物。旧 `1.0.0` 产物不删除但不参与读取。
5. S5 响应头已在窗口前或同批生效。
6. 执行 S6 浏览器回归与真实文件抽样；S6 全部通过前不得关闭 H1。
7. 等待旧预览签名过期，再复测顶层打开为下载 / 无脚本。
8. 记录部署日志、镜像 digest、配置变更、测试证据与剩余风险。

### 8.2 回滚

- **禁止**回滚到“原 SVG 同源内联直签”。
- 栅格化服务故障时：保留 `failed` 降级“请下载查看”，或临时停止 SVG 产物投递；下载链保持可用。
- 新服务版本可回滚到上一固定镜像 digest；`pipelineVersion` 不回退到 `1.0.0`，避免重新命中旧直通产物。
- 对象存储独立域回滚使用旧门面短时只读窗口；不删除对象。

### 8.3 观测

- 转换请求：requestId、输入 / 输出字节、尺寸、耗时、失败码、是否命中上限。
- 队列：`preview.job` ready / failed / dead 数量与耗时；`preview_artifacts` 2.0.0 失败率。
- 安全：SVG 原对象 inline 签名次数必须为 0；异常 MIME 拒绝计数；下载 attachment 响应抽样。
- 前端：预览不可用率、`not_ready` 超时、CSP violation。

## 9. 风险与待实现时确认项

| 风险 / 待确认项 | 处置 |
|---|---|
| resvg 2.6.2 对个别 SVG 特性支持不完整 | 不支持则确定性失败并下载；不以放宽内联为补救 |
| 固定 4096 长边对超大图缩放不足 | 先取真实样本评估；只调输出上限，不改变“只出 PNG” |
| 中文 / 特殊字体缺失 | 镜像固定 Noto Sans CJK SC + 构建期门禁 + 中文 SVG 回归 |
| CSP 误伤 ONLYOFFICE / WASM / Worker / 打印 iframe | S5 前做浏览器矩阵，按实际最小放行并记录 |
| 同源存储域仍是纵深弱点 | S7 独立 origin；P0 不停等 |
| 旧对象 MIME 不可信 | 读面 fail closed；必要时后续独立数据审计 / 回填，不信任历史客户端值 |
| 全量哈希成本 | S8 使用流式 SHA-256 与大小上限，避免整文件驻留内存 |
| CI 浏览器 E2E 依赖较多 | 独立 job、固定浏览器版本、healthcheck + 失败截图 / 日志；连续稳定后升为必需检查 |

## 10. Definition of Done（H1 关闭条件）

- [ ] ADR-034 已评审并 Accepted；设计、需求、字段口径同步。
- [ ] SVG 预览只返回 2.0.0 PNG 产物；不存在原 SVG inline 签名路径。
- [ ] 原始 SVG 下载为 attachment + octet-stream，字节不变。
- [ ] MIME 精确白名单、扩展名 / 文件头双重校验、存量 fail closed 全覆盖。
- [ ] 栅格化服务无外网、非 root、只读、资源与超时上限、恶意夹具全过。
- [ ] `nosniff` / CSP sandbox / HSTS / XFO 按第 5 节生效。
- [ ] S6 浏览器回归矩阵全绿，包含恶意 SVG 顶层打开、MIME 绕过与位图 / PDF / Office / CAD 回归。
- [ ] server `typecheck/test/build/check:boundaries`、frontend `typecheck/build` 与本切片定向命令全部通过。
- [ ] 高风险变更已取得非作者评审；部署与回滚步骤已演练。
- [ ] 开发日志、回放证据、镜像 digest、剩余风险与 S7 / S8 后续项登记完成。
