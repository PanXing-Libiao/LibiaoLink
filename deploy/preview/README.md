# deploy/preview/ · 预览转换器沙箱（M4-05 · ADR-007）

> **已退役（S6 · 2026-10-08）**：ONLYOFFICE 替换收官后本转换栈**不再部署 / 启动** —— 预览链路 = `deploy/onlyoffice` 查看器（Office / 文本族 / PDF）+ 图片原对象直签；转换管线零消费者。目录与镜像保留供回滚与 `structured` 二期评估；退役评审见 `docs/s6-退役评审(LibreOffice转换栈).md`。

本目录是**在线预览管道**里 converter（转换沙箱）的落点（px 线运维件）：镜像构建、compose 编排、
沙箱约束、中文字体与自检脚本。lan 线（PR-10）按本目录 README 的接口契约调用它，不关心镜像内部。

- 目录内容：`Dockerfile` / `docker-compose.yml` / `.env.example` / `service/`（转换服务 + 边缘转发 + 自检）
- 相关口径：`docs/adr/ADR-007-在线预览管道.md`、`技术设计v0.3-实施与验收.md` §3.5、`docs/adr/ADR-013-部署与容量起点.md`

## 一、对 lan 清单的 5 项定案（M4-05b）

| # | 项 | 定案 |
|---|---|---|
| 1 | 运行形态 | **① 独立容器**（`deploy/preview/`）。沙箱干净、限额独立、与 `deploy/casdoor/`、`deploy/minio/` 同构；不采用「worker 同机 soffice 子进程」（无沙箱、要污染 worker 机器）与「外部既有服务」（一期无此服务） |
| 2 | 落点与编排 | 新建 `deploy/preview/{Dockerfile, docker-compose.yml, .env.example, README.md, service/}`；`docker compose build` 出镜像，`up -d` 起服务 |
| 3 | 端口与网络 | 容器内监听 `9900`；**只发布到 `127.0.0.1:${PREVIEW_CONVERTER_PORT:-9900}`**，不对外。converter 本体只挂 `internal: true` 网络（**真无外网**），dev 形态的本机可达由 `edge` 哑中继承担（原因见「三」）。本线用 `PREVIEW_CONVERTER_URL=http://127.0.0.1:9900` 指向 |
| 4 | 镜像与版本 pin | 镜像 `libiaolink/preview-converter:<MAJOR>.<MINOR>.<PATCH>`，当前台账 = `1.0.0`；基座 `node:24-trixie-slim` 锁 digest。**换镜像必须同步递增 `PREVIEW_PIPELINE_VERSION`**（规则见「四」） |
| 5 | 中文字体 | 镜像内置 **Noto Sans CJK SC + Noto Serif CJK SC**（`fonts-noto-cjk`），并注册 fontconfig **宋体/黑体映射**；构建期 `fc-match` 断言把关（映射不生效则构建直接失败）。ADR-007 的「中文不乱码」是硬验收项 |

**口径确认（lan 提的两个问题）**：

- **字节流进、字节流出**：确认采用。worker 把源文件字节 POST 给转换器、转换器把产物字节回给 worker。
  转换器**不接触对象存储**、不带任何 S3 凭证、不出网 —— 沙箱最干净；内网局域网传办公文件的字节量无压力。
  不采用「转换器直读直写对象存储」（要凭证 + 要出网 + 要进沙箱，安全面反而变大）。
- **`objectKey` 不进转换器**：`preview_artifacts.object_key` 由 worker 自己算、自己落库；转换器只认字节流与
  `x-preview-target` / `x-file-name` / `x-source-mime` 三个头。
- **`structured` 通道一期返回 501**：按 ADR-007「一期未启用时 xlsx 走 pdf」，worker 把 xlsx 作为 `target=pdf`
  调用即可；等结构化渲染真做时再放开，属兼容变更。

## 二、镜像台账（构建记录）

| 项 | 值 |
|---|---|
| 标签 | `libiaolink/preview-converter:1.0.0` |
| 镜像 ID（本地） | `sha256:5311a78631e8…6cc1a6b` |
| 构建清单摘要 | `sha256:24107770ffb6…c430bd3`（manifest list；含 provenance 附加清单） |
| 构建时间 | 2026-09-23 11:11 +08:00（amd64/linux） |
| 体积 | 1.20 GB（`docker images`） |
| 基座 | `node:24-trixie-slim@sha256:8ec5d7557396…1120cffe`（Debian 13 trixie；镜像内 node `v24.21.0`） |
| 转换引擎 | LibreOffice `4:25.2.3-2+deb13u6`（soffice `25.2.3.2 520(Build:2)`）；writer / calc / impress 三件套，**未装 Java**（`--no-install-recommends`） |
| 光栅化 | poppler-utils `25.03.0-5+deb13u4`（pdftoppm `25.03.0`） |
| 字体 | `fonts-noto-cjk 1:20240730+repack1-1`（Noto Sans / Serif CJK SC 及 TC / JP / KR / HK 与 Mono）；`fonts-liberation 1:2.1.5-3`、Carlito `20230309-2`、Caladea `20200211-2` 作 Arial / Calibri / Cambria 度量兼容替身；`fontconfig 2.15.0-2.3` |
| pipelineVersion | `1.0.0`（与标签同值，规则见「四」） |
| 自检 | **28 / 28 PASS**（`docker compose exec -T converter node /app/smoke.mjs`，逐项见 `docs/m4-05b-回放证据(预览转换器沙箱deploy-preview).md`） |

镜像构建口径：基座锁 digest（ADR-017），LibreOffice / 字体由 Debian 包提供，版本随下表登记；
`/healthz` 也会自报实际版本，便于排障时核对。

国内 / 内网构建：默认走 Debian 官方源，可用 build arg 指定镜像站（apt 仍做 GPG 校验，包内容一致）：

```bash
docker compose build --build-arg APT_MIRROR=mirrors.aliyun.com
```

**生产内网构建必须换内网 apt 源**（镜像里不写死任何外部源）；构建后建议用 `docker save` 出离线包固化。

## 三、沙箱属性（ADR-007 的不可省项）与拓扑

| 属性 | 实现 | 验证 |
|---|---|---|
| 无外网 | converter 只挂 `internal: true` 网络（无默认网关） | `docker compose exec -T converter node /app/smoke.mjs` 的「无外网」两项 |
| 只读根文件系统 | `read_only: true`，唯一可写 = tmpfs `/tmp` | 自检「只读根文件系统」项 |
| 非 root | 镜像 `USER 1000:1000` + compose `user` | 自检「非 root」项 |
| 超时杀进程 | 每次转换独立工作目录；超时对**进程组** SIGKILL（LibreOffice 会派生 `soffice.bin`） | 自检「超时 -> 504」+「无残留进程」 |
| 资源限额 | `cpus` / `mem_limit` / `pids_limit` 全部可配（`.env`） | `docker stats libiaolink-preview-converter` |
| 能力收窄 | `cap_drop: [ALL]` + `no-new-privileges` + `init: true`（收尸） | `docker compose config` |

拓扑（**沙箱 dev 形态**）：

```
worker(宿主进程) --127.0.0.1:9900--> [edge 哑中继] --libiaolink-preview-internal--> [converter]
                                                       ↑ 仅此网络；internal 网络无外网
```

为什么多一个 `edge`：Docker 的 `internal: true` 能真断外网，但**同时断掉端口发布**（本机实证：internal
网络下 `127.0.0.1` 映射与容器 IP 直连都不通）。所以把「无外网」与「本机可达」拆成两个容器：converter
留在 internal 网络（真无外网），edge 用同一镜像跑一个哑 TCP 中继（只搬字节、不解析文件、不落盘、无状态）。

**生产形态（M8，px 线）**：worker 也是容器，和 converter 同处 internal 网络，直接按服务名互连 —— 那时
**删掉 `edge` 服务与 `ports`**，暴露面归零。本目录不写生产编排，避免与 M8 生产模板重复。

## 四、镜像标签 ↔ `PREVIEW_PIPELINE_VERSION` 对应规则

`pipelineVersion` 是预览产物缓存键的一部分（三元组：内容哈希 + pipelineVersion + target，ADR-007）：
**换镜像不递增版本 = 用户看到旧产物；只改版本不换镜像 = 无谓全量重转**。两条都是故障，所以规则是硬约束：

1. **两者永远同值**：容器标签 `libiaolink/preview-converter:<X.Y.Z>` == 容器 env `PIPELINE_VERSION`
   == `.env` 的 `PREVIEW_PIPELINE_VERSION` == `server/.env` 的 `PREVIEW_PIPELINE_VERSION`（四处同一串）。
2. **任何一次镜像内容变化都必须递增**：LibreOffice 版本、字体、fontconfig 映射、兜底策略、转换参数、
   服务代码 —— 一律递增标签并把 `PREVIEW_PIPELINE_VERSION` 一起递增。**不做 patch 豁免**：无法证明
   「不影响产物字节」的改动，一律按影响产物处理（一次全量重转的代价 << 一处幽灵缓存的代价）。
3. **递增即失效**：版本进了对象键，旧产物自然失效、按需重转，**不原地覆盖**、不需要手工清缓存。
4. **自证**：`GET /healthz` 与每次 `POST /convert` 响应都带 `x-pipeline-version`。建议 worker 启动自检时
   比对自身 `PREVIEW_PIPELINE_VERSION`：不一致就把预览任务降级为 `failed`（reason 写明两端版本），
   避免把产物写到错误键上。
5. **生产发布另行记账**：镜像推内网 registry 后，README「镜像台账」追加一行（标签 / digest / 构建时间 /
   变更点），换镜像的 PR 描述里引这一行。

版本号语义（便于人读，不参与程序判断）：`MAJOR` = 转换引擎代际（LibreOffice 大版本或架构变化）；
`MINOR` = 影响产物的参数 / 字体 / 兜底策略变化；`PATCH` = 其它改动（同样要递增 `PREVIEW_PIPELINE_VERSION`）。

## 五、接口契约（v1.0.0，供 PR-10 接线）

### GET /healthz

容器健康检查与 worker 自检共用。200 = 可用；503 = 不可用（`ok=false`，附 `engine.lastError`）。

```json
{
  "ok": true,
  "service": "preview-converter",
  "pipelineVersion": "1.0.0",
  "engine": { "available": true, "bin": "soffice", "version": "LibreOffice 25.2.3.2 ...", "rasterizer": "pdftoppm version 25.03.0" },
  "fonts": { "simsun": "Noto Serif CJK SC", "simhei": "Noto Sans CJK SC", "yahei": "Noto Sans CJK SC", "cjkReady": true },
  "limits": { "timeoutMs": 60000, "maxBytes": 268435456, "maxConcurrency": 2, "maxQueue": 8, "imageDpi": 150, "inflight": 0, "queued": 0 },
  "uptimeSec": 12
}
```

### POST /convert

| 请求 | 说明 |
|---|---|
| body | 源文件字节流（`Content-Length` 建议给出；缺失也接受，但同样受上限约束） |
| `x-preview-target` | `pdf` / `image` / `structured`；缺省 `pdf`；未知值 -> 400 |
| `x-file-name` | URL 编码（`encodeURIComponent`）的原始文件名；用于取扩展名与产物命名，可为空 |
| `x-source-mime` | 可选；扩展名与 MIME 都判不出类型 -> 415 |

| 响应 | 说明 |
|---|---|
| 200 | 产物字节流；`content-type` / `content-length` + `x-preview-target` / `x-pipeline-version` / `x-convert-mode`（`passthrough` / `convert` / `rasterize` / `convert+rasterize`）/ `x-convert-duration-ms` / `x-artifact-name`（URL 编码） |
| 4xx / 5xx | `{ "error": "<CODE>", "message": "<≤500 字，可直接进 D2-05 降级副行>", "pipelineVersion": "..." }` |

| 错误码 | HTTP | 触发 |
|---|---|---|
| `BAD_REQUEST` | 400 | `x-preview-target` 未知 / 请求缺失 |
| `UNSUPPORTED_MEDIA` | 415 | 源类型判不出（如 `.exe`）；image 源被要求走 `pdf` 通道 |
| `PAYLOAD_TOO_LARGE` | 413 | 超过 `CONVERT_MAX_BYTES` |
| `CONVERT_FAILED` | 422 | LibreOffice / pdftoppm 非零退出或没有产物 |
| `CONVERT_TIMEOUT` | 504 | 超过 `CONVERT_TIMEOUT_MS`，已杀进程组 |
| `UNSUPPORTED_TARGET` | 501 | `structured` 通道（一期未启用） |
| `SERVICE_BUSY` | 503 | 并发满且排队超过 `CONVERT_MAX_QUEUE`，worker 稍后重试 |
| `SERVICE_UNAVAILABLE` | 503 | soffice 不可用（healthz 同源判断） |
| `METHOD_NOT_ALLOWED` / `NOT_FOUND` | 405 / 404 | 路径 / 方法不对 |

通道矩阵（一期）：

| 源 \ target | `pdf` | `image` | `structured` |
|---|---|---|---|
| Office（docx/xlsx/pptx 及旧格式、odf、rtf、txt、csv、html） | soffice 转 PDF | soffice 转 PDF 后首屏 150dpi PNG | 501 |
| PDF | 原样直通 | 首屏 PNG（`pdftoppm`） | 501 |
| 图片（png/jpg/gif/bmp/webp/tiff/**svg**） | 415（图片不该走 PDF 通道） | 原样直通 | 501 |
| 其它 | 415 | 415 | 501 |

CAD 已改为 [独立工程接入](../../docs/CAD平台接入基线与迁移任务.md)（ADR-035），不在本 converter 中恢复旧 DWG/DXF 映射，也不将 CAD 原文件或模型资源作为 image/pdf 直通。当前平台 CAD 暂不可预览、保留原文件下载；未来任务与多资源部署另按接入契约落地。

## 六、快速上手（沙箱）

```bash
cd deploy/preview
cp .env.example .env          # 改端口与限额（本目录无需口令）
docker compose build          # 首次约需下载 LibreOffice + Noto CJK（国内可用 --build-arg APT_MIRROR=...）
docker compose up -d
curl -fsS http://127.0.0.1:9900/healthz

# 容器内自检（含中文乱码验收、无外网、只读、非 root、超时杀进程等断言）
docker compose exec -T converter node /app/smoke.mjs

docker compose logs -f converter
docker compose down
```

`server/.env` 侧（lan 线接线用）：

```dotenv
PREVIEW_CONVERTER_URL=http://127.0.0.1:9900
PREVIEW_PIPELINE_VERSION=1.0.0          # 与镜像标签同值，见「四」
PREVIEW_CONVERT_TIMEOUT_MS=90000        # 客户端超时；比容器内 kill 超时（60000）留 30s 余量
PREVIEW_CONVERT_MAX_ATTEMPTS=3
```

## 七、给 PR-10 的对接提示（lan 线，供参考）

- **超时余量**：容器内硬超时 `CONVERT_TIMEOUT_MS=60000`；worker 客户端超时建议 `90000`，
  这样拿到的是转换器的 `504 + CONVERT_TIMEOUT`（可写进 `preview_artifacts.error`），而不是被客户端掐断的裸超时。
- **重试**：`503 SERVICE_BUSY` / `504 CONVERT_TIMEOUT` / 连接错误属可重试；`415` / `501` / `413` / `422` 属
  确定性失败（`422` 已含原因，可直接落 `failed` + reason，走 D2-05 降级「请下载」）。建议按
  `PREVIEW_CONVERT_MAX_ATTEMPTS` 退避重试，最终写 `failed`。
- **大文件**：`CONVERT_MAX_BYTES` 默认 256MiB、容器内存默认 2G（LibreOffice 峰值内存约为源文件的数倍）。
  建议 worker 侧对超大文件（例如 >100MB 的 Office / 页数极多的 PDF）直接降级「仅下载」，别把配额打满。
- **幂等**：转换器无状态、无缓存；三元组幂等由 worker + `preview_artifacts` 负责（同一三元组只转一次）。
- **可观测**：转换器每个请求打一行 JSON 日志（`event=convert_ok` / `request_failed`，含 `requestId`、
  耗时、字节数）；建议 worker 生成 `x-request-id` 便于两端对账。

## 八、风险与后续（px 线留痕）

1. **镜像分发**：沙箱是本地 `docker compose build`；生产/联调要先固化到内网 registry 或 `docker save`
   离线包（与 `deploy/minio/README.md` 同口径）。发布动作在 M8 生产部署形态验证时完成。
2. **apt 源**：镜像内默认 Debian 官方源；生产内网构建走 `APT_MIRROR`，且须确保内网源有 security 通道
   （LibreOffice 是解析不可信文件的组件，安全更新必须跟得上）。
3. **PDF 保真度**：Excel 分页、复杂版式、字体回退的观感需在 PoC-1 用真实样本过一遍（本目录自检只保证
   「中文不乱码 + 通道打通」这类硬项，不承诺版式像素级一致）。
4. **`edge` 只服务沙箱**：生产形态必须删掉它，否则等于把 internal 网络重新接出去。
5. **限额起点**：沙箱默认 2C / 2G / 并发 2 / 队列 8；ADR-013 的生产限额是 2C4G / 并发 2~4，上线前按
   真实样本压一遍再定档。
