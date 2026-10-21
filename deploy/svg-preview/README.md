# deploy/svg-preview/ · H1 SVG 安全栅格化沙箱（S3）

> 状态（2026-10-21）：S3 已随 PR [#529](https://github.com/PanXing-Libiao/LibiaoLink/pull/529) 合并 main `acd6113`；S4 主栈接线已随 PR [#531](https://github.com/PanXing-Libiao/LibiaoLink/pull/531) 合并 main `db7d5e0`；S5 已随 PR [#534](https://github.com/PanXing-Libiao/LibiaoLink/pull/534) 合并 main `660cc80`；S2 已随 PR #523 合并 `e2b6aab`；S6 已随 PR [#539](https://github.com/PanXing-Libiao/LibiaoLink/pull/539) 合并 main `336b66fd`。测试机 10.1.104.44 已于 2026-10-21 按该基线完成 S2 ～ S6 同批部署：6 容器 healthy，converter 自检 40 PASS / 0 FAIL / 0 SKIP，B1 ～ B6 21/21 与 B7 浏览器 2/4 通过；**生产尚未部署**。回放发现 443 `/libiaolink/` 与 9443 重复 HSTS，收口 PR 修复后待部署复测；生产验收前不得宣布 H1 闭环。
>
> 口径：`docs/adr/ADR-034-SVG预览安全栅格化.md` 与 `docs/H1-SVG预览同源存储型XSS整改方案.md`。外部 V1.0 源文档同条同步已按 2026-10-21 指令移出本整改跟踪；S6 完成前仍不能由本目录或本切片宣称 H1 已闭环。

## 1. 边界与职责

本服务只做一件事：把通过严格预检的 SVG 源字节交给固定版本 `@resvg/resvg-js` 栅格化，只返回 PNG。它不接触对象存储、数据库、鉴权令牌和业务数据，也不接受 PDF、Office、CAD 或其他图片类型。

```text
SVG bytes ──> SVG policy preflight ──> isolated render worker ──> PNG policy ──> image/png
                                      (resvg-js 2.6.2)
```

- **原始 SVG 永不从本服务返回**；成功响应体只能是 PNG。
- 预检、一次性子进程、容器隔离、PNG 头校验共同构成纵深，不能把 XML / CSS 正则当作唯一安全边界。
- 本切片不修改前端、`server/`、`shared/`、数据库或生产 Compose；S4 才把 `preview.job` 的 SVG `target=image` 接到这里。

## 2. HTTP 契约（内部）

### `POST /convert`

请求体是原始 SVG 字节（`application/octet-stream`），上限 20 MiB。兼容现有 worker 客户端的下列头：

| 请求头 | 必填 | 规则 |
|---|---:|---|
| `x-preview-target` | 是 | 只接受 `image`（大小写不敏感） |
| `x-file-name` | 是 | URL 编码或原样文件名；基线名必须以 `.svg` 结尾 |
| `x-source-mime` | 否 | 若提供，去掉参数并小写后必须精确等于 `image/svg+xml`；S4 应始终发送该值 |
| `x-request-id` | 否 | `A-Z a-z 0-9 . _ : -`，最长 128；非法值替换为 UUID |

成功：`200 image/png`，并返回 `content-disposition: inline`、`x-content-type-options: nosniff`、`cache-control: no-store`、`x-pipeline-version: 2.0.0`、`x-convert-mode: rasterize`、`x-png-width`、`x-png-height` 与请求 ID。S4 起服务端消费版本同为 `2.0.0`，版本不一致会按确定性失败降级。

### `GET /healthz`

`200` 表示固定字体可加载、resvg 能栅格化 64×64 健康图并通过 PNG 校验；否则 `503 SERVICE_UNAVAILABLE`。响应同时回显当前限额与 `resvgVersion`，仅供内部探针和排障。

### 错误语义

错误统一为 JSON：`{ error, message, pipelineVersion }`，带稳定错误码与请求 ID；不返回堆栈或内部路径。

| HTTP | 错误码（代表值） | 含义 |
|---:|---|---|
| 400 | `BAD_REQUEST` | 目标 / 文件名 / Content-Length 非法 |
| 413 | `PAYLOAD_TOO_LARGE` | 源 SVG 超过 20 MiB |
| 415 | `UNSUPPORTED_MEDIA` | 非 `.svg` 文件名或非 `image/svg+xml` MIME |
| 422 | `SVG_*` / `PNG_*` / `SVG_RENDER_FAILED` | 预检、渲染或产物校验确定性失败 |
| 501 | `UNSUPPORTED_TARGET` | 非 `x-preview-target: image` |
| 503 | `SERVICE_BUSY` / `SERVICE_UNAVAILABLE` | 队列满 / 排队超时 / 渲染进程不可用 |
| 504 | `CONVERT_TIMEOUT` | 渲染超过 10 秒，子进程被 `SIGKILL` |

安全 / 资源相关错误包括：`SVG_ACTIVE_CONTENT`、`SVG_EVENT_ATTRIBUTE`、`SVG_EXTERNAL_RESOURCE`、`SVG_ACTIVE_CSS`、`SVG_CSS_ESCAPE`、`SVG_CSS_COMMENT`、`SVG_DTD_FORBIDDEN`、`SVG_DIMENSION_UNKNOWN`、`SVG_DIMENSION_TOO_LARGE`、`SVG_ASPECT_RATIO`、`SVG_OUTPUT_TOO_LARGE`、`SVG_PIXEL_LIMIT`、`SVG_ELEMENT_LIMIT`、`PNG_INVALID`、`PNG_TOO_LARGE`。

## 3. 安全策略与限额

ADR-034 定档值只能在实现中收紧；本目录当前值如下：

| 项 | 上限 / 规则 |
|---|---:|
| 源 SVG | 20 MiB；严格 UTF-8 |
| 输出长边 | 1600 ~ 4096 px |
| 输出总像素 | 16,777,216 |
| 输出 PNG | 20 MiB |
| 源长边 / 长宽比 | 1,000,000 px / 16 |
| 元素数 | 100,000 |
| 单次硬超时 | 10 s |
| 并发 / 队列 | 1 / 4 |
| 容器资源 | 1 CPU / 256 MiB / PIDs 64 / tmpfs 128 MiB |

预检拒绝：DOCTYPE / ENTITY、任何处理指令、脚本 / `iframe` / `object` / `embed` / `foreignObject`、事件属性、`xml:base`、非文档内 `href`、外部 CSS `url()` / `@import` / `@font-face` / `image-set()`、CSS 转义 / 注释 / `expression()` / `-moz-binding` / `behavior:`。`<style>` 文本按完整内容聚合校验，样式内的 XML 注释直接拒绝，避免用注释或 CDATA 分片拼接敏感 CSS token。

输出校验：PNG 魔数、IHDR、8-bit RGBA、非隔行、尺寸 / 像素 / 字节上限、IEND；尺寸必须与受控 `fitTo` 结果一致（允许 ±1 px 舍入）。resvg 若报告待解析外部图片，立即失败。

## 4. 沙箱不变量

生产 / 测试使用的 `converter` 服务：

- 非 root（`1000:1000`）、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`；
- 仅连接 `internal: true` 的 `libiaolink-svg-preview-internal` 网络，不发布宿主端口，无外网；
- 每次请求启动一次性 `render-worker.mjs`，父进程 10 秒硬超时后杀进程组；不保留可复用执行上下文；
- 固定 `/app/fonts` 中的 Noto Sans CJK，禁用系统字体探测；不写数据库 / 对象存储。

`edge` 仅是**本地开发 profile**：它是一个 TCP 中继，把 `127.0.0.1:9900` 转发到 internal 网络里的 `converter:9900`。生产不部署 edge；S4 由主栈 worker 在受控内网访问 converter。

```text
default: [host/主栈内网] ──(internal network)──> converter（无 host port）
dev:     host 127.0.0.1:9900 ──> edge relay ──> converter（仍只在 internal network）
```

## 5. 构建、运行与复跑

本地依赖测试（Windows / Linux 均可，容器内运行才是发布证据）：

```bash
cd deploy/svg-preview
npm ci
npm test
npm audit --omit=dev --audit-level=low
docker compose config --quiet
```

构建并启动 internal-only converter：

```bash
docker compose build --build-arg PIPELINE_VERSION=2.0.0 --build-arg BUILD_REVISION=<commit-or-slice>
docker compose up -d
docker compose ps
docker compose exec -T -e SVG_PREVIEW_SELFCHECK_SANDBOX=1 converter node /app/service/selfcheck.mjs
```

本地需要从宿主访问时使用 dev profile（不要用于生产）：

```bash
docker compose --profile dev up -d
curl -fsS http://127.0.0.1:9900/healthz
```

自检覆盖正常图形 / 渐变 / 中文字形 / 透明背景 / 4096 级矢量、全部恶意夹具、像素 / 元素炸弹、非法 MIME / target、超时残留，以及非 root / 只读根 / 无 Docker socket / capabilities 清空 / no-new-privileges / 无外网 / cgroup 限额断言。容器内结果必须为 `FAIL=0`、`SKIP=0`；本地未开沙箱时只允许 sandbox 组 skip。

## 6. 镜像与供应链台账（S3 构建）

构建主机：Docker Desktop，`linux/amd64`；构建时间：2026-10-21 09:12:44 +08:00。

| 项 | 值 |
|---|---|
| 镜像标签 | `libiaolink/svg-preview:2.0.0` |
| 测试机部署 digest（2026-10-21） | `sha256:eaee947e1e6a9e4b3ea7e7057e76e4ac45ac6209fb470593c46686ec7a474282` |
| 历史 S3 台账 digest（不可重现） | `sha256:d0a2a405dc6eb557630369c641541a61690f34a1f12a551d8d22a5f39d2500cf` |
| S3 历史镜像大小 | 490,998,073 B（约 468.25 MiB） |
| 构建修订 | `3ed2f59-s3`（S3 工作树；主线基线 `3ed2f59b5e69563d4fe69d354ddd3c6a287acb7d`） |
| Node / OS | Node v24.21.0 / Debian GNU/Linux 13 (trixie) |
| 基础镜像 | `node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe` |
| Dockerfile frontend | `docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e` |
| Compose config hash | `2f7dfd7d61e0634a29a52bae154bb0d552507e98ee23b4b322273a968c15c15d` |
| `Dockerfile` SHA-256 | `00d1ef15f9055f5c90ffcc281dabfeee9acfd0de1cd5bfe1b4aa6297cbf592ab` |
| `docker-compose.yml` SHA-256 | `1558366cc14b212a5baed51e0aa967b6e37b356b8c518b087e480c866f35dfe0` |
| `package-lock.json` SHA-256 | `4fa23ca86dc56b7b7e5a700bf4e1f5bcfb5194ff6c8448c80bc127eae9e15776` |

### 6.1 测试机部署镜像（2026-10-21）

| 项 | 值 |
|---|---|
| 基线 | `main@336b66fd4ee5c202828bd0480031702b5b692799` |
| 镜像 | `libiaolink/svg-preview:2.0.0@sha256:eaee947e1e6a9e4b3ea7e7057e76e4ac45ac6209fb470593c46686ec7a474282` |
| 离线归档 | `/srv/data/backups/h1-svg-336b66fd/svg-preview-2.0.0-linux-amd64.tar`；SHA-256 `23bfb7e3b93077ef4248790de299707a1155752b2cde73d80b20cd73af504a7d` |
| 测试机结果 | 6 容器 healthy；converter 自检 40 PASS / 0 FAIL / 0 SKIP；B1 ～ B6 21/21、B7 浏览器 2/4；9443 由服务器本机 curl 复核 |
| 说明 | S3 历史构建的 `d0a2…` digest 已无法重现；测试机与生产部署锁统一使用本表 `eaee947e…`。 |

依赖（锁文件精确版本）：

| 包 | 版本 | 许可证 | 作用 |
|---|---:|---|---|
| `@resvg/resvg-js` / linux-x64-gnu | 2.6.2 | MPL-2.0 | 固定 SVG → PNG 渲染器 |
| `saxes` | 6.0.0 | ISC | 预检用严格 XML 解析器 |
| `xmlchars` | 2.2.0 | MIT | `saxes` 的 XML 字符规则依赖 |

固定字体与许可证（final image 内实测 SHA-256）：

| 文件 | SHA-256 |
|---|---|
| `/app/fonts/NotoSansCJK-Regular.ttc` | `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a` |
| `/app/fonts/NotoSansCJK-Bold.ttc` | `faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb` |
| `/app/fonts/NOTO-CJK-LICENSE.txt` | `849f4ea9c214fa4ac3593b770c699f387534b11ce671264c1b10d85bdcb5997b` |

字体构建参数 = `fonts-noto-cjk=1:20240730+repack1-1`（Noto CJK / SIL OFL 系许可，许可证随镜像保留）。构建阶段以 `fc-match 'Noto Sans CJK SC'` 断言字体族，再只复制两个 TTC 与许可证到最终镜像。

最终容器实测：`ReadonlyRootfs=true`、`User=1000:1000`、`CapDrop=["ALL"]`、`SecurityOpt=["no-new-privileges:true"]`、`Memory=268435456`、`NanoCpus=1000000000`、`PidsLimit=64`，网络仅 `libiaolink-svg-preview-internal`，`9900/tcp` 无宿主映射。容器自检 **40 PASS / 0 FAIL / 0 SKIP**；经 dev edge 实测 4096×4096 PNG 返回 `200 image/png`。

## 7. 生产接线与回滚（S4）

S4 代码已实现（2026-10-21）：

1. `deploy/prod/docker-compose.yml` 新增 `svg-preview`，只挂 `libiaolink-svg-preview-internal`（`internal: true`），无宿主端口；worker 同时挂 `prod` 与该 internal 网络，`PREVIEW_CONVERTER_URL=http://svg-preview:9900`。
2. worker 只对 SVG `target=image` 发送 `x-source-mime: image/svg+xml`；读取源对象后重算 SHA-256，与 `file_versions.content_hash` 不一致即确定性失败。
3. worker 独立校验返回的 `Content-Type: image/png`、`x-convert-mode: rasterize`、PNG 魔数 / IHDR / 8-bit RGBA / 尺寸 / 像素 / IEND / 20 MiB；通过后才写 `previews/{contentHash}/2.0.0/image` 与 `preview_artifacts`。
4. `PREVIEW_PIPELINE_VERSION` 默认与生产模板均为 `2.0.0`，旧 `1.0.0` 产物保留但不被读取；失败仍为 `failed + reason`，绝不回退到原 SVG 签名。
5. S4 代码与部署件已交付；测试机 2026-10-21 已按 `main@336b66fd` 部署，生产仍未执行。实际发布前需 px 把同 digest 镜像放入内网 registry / 离线归档，并更新服务器未跟踪的 `server.env`；随后与 S5 / S6 同窗口执行。

S6 已增加独立 CI job，用真实 converter / worker / MinIO / Nginx 与浏览器覆盖转换成功、确定失败、PNG 校验、MIME / 改名绕过、原文件下载与 PDF / Office / CAD 分流；ONLYOFFICE 渲染器在 CI 用本地 `api.js` 桩替代。测试机已用真实 PDF / DOCX 进入 ONLYOFFICE、STL 进入 `cad3d` WebGL 完成回放；生产部署、完整 B7、真实 CAD 生产样本与旧签名过期复测仍需完成。

回滚只回退主栈镜像 / 环境接线，**不把 `PREVIEW_PIPELINE_VERSION` 回退到 `1.0.0`、不恢复 SVG 原对象直签**；converter 不可用时预览确定性降级为下载。生产发布前还需由 px 完成镜像归档 / 内网 registry 和部署件校验，另行记录发布证据。

## 8. 已知限制

- 当前镜像约 468 MiB，主要来自 Node 基础镜像与 Noto CJK；生产分发需要 registry 或离线归档策略。
- 动画、交互 SVG、远程字体 / 图片一律不保留；这是 ADR-034 的有意能力边界，前端只展示静态 PNG。
- 本服务不做鉴权与租户判断，绝不能直接暴露公网；鉴权、对象读取、哈希与产物登记都在 S4 的主栈 worker 完成。
- 外部 V1.0 源文档同步已按 2026-10-21 指令移出本整改跟踪；S3 / S4 / S5 / S6 合入与测试机部署均不代表 H1 关闭，生产部署、生产验收与人工回归完成前不得宣布闭环。
