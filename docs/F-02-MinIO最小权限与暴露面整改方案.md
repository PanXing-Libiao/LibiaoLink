# F-02 MinIO 根凭据与端口暴露整改方案与执行切片

> 来源：`LibiaoLink_安全审查报告_2026-10-21.pdf` F-02（第 4～5 页）｜严重度 High / P0｜报告验收要求：应用凭据不能管理用户 / 桶或访问其它桶；9000 / 9001 / 9443 从非授权网络不可达；轮换后旧凭据失效
> 报告审查基线：`px @ e05535b8`｜S0 复核基线：`origin/main@6b846b2`（2026-10-23；F-02 涉及的 Compose、Nginx、存储脚本与凭据挂载配置未发生实质修复）
> 起草：lan（后端平台 / file / storage / preview / outbox）｜拟稿日期：2026-10-22｜S0 评审冻结：2026-10-23｜状态：**S0 已通过并冻结；实施进度 1 / 7，F-02 尚未关闭**
> S0 签收：px（部署 / docs）与 wmj（安全）完成复核；经用户确认三方协商后，由 lan 代录。冻结结论见 §5「S0 · 方案落档与评审冻结」。
> 归属与评审：`docs/` 归 px 主责，落档需 px 复核；生产 Compose、Nginx、主机防火墙与部署窗口归 px 主责；MinIO 身份 / 策略、`server/` 存储脚本与凭据接线归 lan 主责；安全验收请 wmj 交叉复核。涉及安全、部署与 Secrets 的高风险变更必须取得非作者批准。
> 变更控制：后续执行以本文件为基线。若执行中需要改变端口、身份模型、策略动作、切片顺序或验收条件，先修改本文件并写明原因、影响和回滚，再实施；已合入主干的回放证据与部署记录按不可变历史处理，不原地改写。

## 0. 执行状态

| 切片 | 状态 | PR / commit | 部署与验证证据 | 备注 |
|---|---|---|---|---|
| S0 · 方案落档与评审冻结 | 已通过并冻结（2026-10-23） | PR [#554](https://github.com/PanXing-Libiao/LibiaoLink/pull/554)；S0 签收提交 | 本文 §5 / S0 评审记录 | px、wmj 已复核；9443 回环保留至 S6 复评 |
| S1 · 关闭宿主端口暴露 | 待执行 | 待填 | 待填 | 9000 不再发布；9001 / 9443 仅回环 |
| S2 · 主机防火墙与外部网络复核 | 待执行 | 待填 | 待填 | Docker 端口不能只依赖 UFW |
| S3 · MinIO 最小权限身份与策略 | 待执行 | 待填 | 待填 | 先创建身份与负向测试，不切运行时 |
| S4 · Secrets 隔离与运行时凭据切换 | 待执行 | 待填 | 待填 | api / worker 改用 service account |
| S5 · root 凭据轮换与旧凭据失效 | 待执行 | 待填 | 待填 | 维护窗口执行；不得回滚为 root 应用凭据 |
| S6 · 文档、H1 兼容与全量回归 | 待执行 | 待填 | 待填 | 9443 保留时只能经 SSH 隧道 |
| S7 · 验收回放与 F-02 关闭 | 待执行 | 待填 | 待填 | 旧凭据失效、外网不可达、证据齐全后才关闭 |

执行时更新本表：开始时写「进行中」；PR 合入后填 PR / commit；测试机或生产部署后填脱敏证据位置；发生设计变更时先在正文更新决策，再改本表。

## 1. 结论

F-02 是两个可以独立闭合、但必须同时处理的问题：

1. **权限过大**：应用使用的 S3 凭据与 MinIO root 相同。应用或容器一旦泄露凭据，攻击者可管理桶、用户、策略并访问全部对象存储，而不只是 `libiaolink` 桶。
2. **暴露面过大**：MinIO API 的 `9000` 发布到宿主全部接口，9443 备用门面也发布到全部接口。当前从开发机访问超时只证明网络路径暂时被拦住，不证明宿主监听安全。

目标方案：

1. 浏览器、api、worker 的对象存储通道统一保留为 `https://test-pm.libiaorobot.com/libiaolink/` → Nginx → Docker 网络内 `minio:9000`；不新增公网对象存储域名。
2. **9000 不再发布任何宿主端口**；MinIO 只经 Docker `prod` 网络被 web / api / worker 使用。
3. 9001 控制台继续只绑定 `127.0.0.1`，经 SSH 隧道访问。
4. 9443 备用门面降为 `127.0.0.1:9443:9443`，仅供服务器本机排障或 SSH 隧道回放；若后续确认 H1 不再需要，再独立移除，绝不再绑定 `0.0.0.0`。
5. 创建 **桶级最小权限 service account** 供 api / worker / `storage:it` 使用；创建单独的 **bootstrap service account** 供 `storage:init` 使用；root 仅用于 MinIO 自身启动、一次性身份创建与应急运维。
6. api / worker / tools 不再整目录挂载 `secrets/`；改为 Compose 按文件挂载、进程只读取本角色需要的文件。root Secret 只能进入 minio 容器。
7. root 凭据与应用凭据都视为已暴露，必须在应用切换完成后轮换；旧值失效后才可关闭 F-02。
8. 主机防火墙使用 `DOCKER-USER` 或等价持久化规则做纵深防御，并在 Docker 重启 / 主机重启后复验。

一句话口径：**浏览器只走 443 同源门面；应用只有 `libiaolink` 桶的对象读写权限；root 不进入应用容器、不作为应用凭据；9000 不发布，9001 / 9443 仅本机回环。**

## 2. 审查事实与攻击链

### 2.1 仓库证据

| 证据位置（`origin/main@4e5f5ba`） | 关键事实 |
|---|---|
| `deploy/prod/docker-compose.yml:60-67` | minio 使用 `minio_root_user` / `minio_root_password` Secret；9000 发布为 `9000:9000`，9001 已仅回环。 |
| `deploy/prod/docker-compose.yml:148`、`:182`、`:219` | tools / api / worker 均整目录只读挂载 `./secrets`。 |
| `deploy/prod/docker-compose.yml:255` | web 将 `9443:9443` 发布到宿主全部接口。 |
| `deploy/prod/README.md` §2、§9 | 明确记录应用 `s3_access_key` / `s3_secret_key` 当前与 root 同值；首次部署步骤直接复制 root 文件生成应用凭据。 |
| `deploy/prod/scripts/storage.sh:34-42` | `init` 与 `it` 使用同一组 `s3_access_key` / `s3_secret_key`。 |
| `deploy/prod/scripts/service-entrypoint.cjs:19-45` | api / worker 从 `/opt/libiaolink/secrets` 整目录读取凭据并注入环境变量。 |
| `server/scripts/storage-init.mjs:46` | `AccessDenied` 被归入「存储不支持该 API」，只告警不失败；权限配置错误可能漏过部署门禁。 |
| `deploy/prod/nginx/libiaolink.conf:120-143` | 443 的 `/libiaolink/` 是浏览器对象存储主通道；`proxy_pass` 到 `minio_backend`。 |
| `deploy/prod/nginx/libiaolink.conf:197`、`:220` | 9443 仍有独立 MinIO 门面，当前仅依赖宿主绑定与网络策略限制。 |
| `deploy/prod/server.env.example:25-27` | `S3_ENDPOINT` 保持 443 默认端口；注释仍把 9443 描述为内网备用门面，未明确回环边界。 |
| `frontend/scripts/h1-svg-preview-e2e.mjs:41`、`:1159-1161` | H1 B7 可用 `H1_BACKUP_STORAGE_URL` 通过 SSH 隧道验证 9443；不需要重新把 9443 暴露到外部接口。 |

### 2.2 当前攻击链

1. **应用凭据泄露链**：应用容器、环境变量、日志、排障拷贝或备份泄露 `S3_ACCESS_KEY` / `S3_SECRET_KEY` → 因与 root 同值 → 可创建 / 删除桶、用户、策略，访问其它桶，影响全部对象存储。
2. **网络直连链**：从内网主机、误放行的防火墙或 SSRF 触达宿主 `9000` → 绕过 443 同源门面的统一入口约束；9000 当前还是明文 HTTP → 连接内容与签名请求在链路上不具备 TLS 保护。
3. **备用门面链**：`9443` 被发布到全部接口 → 即使主 443 门面加固，仍存在第二个对浏览器可见的 MinIO 入口和证书 / SNI / 响应头维护面。
4. **Secret 横向读取链**：api / worker / tools 整目录挂载 `secrets/` → 应用容器可读取与自身职责无关的 root、PostgreSQL 超级用户、迁移器、只读等凭据；任一容器被利用都会扩大横向影响。

报告所述「开发机访问 9000 / 9443 超时」只说明当前上游网络策略有效；宿主绑定、Compose 编排和容器内可见 Secret 仍是既有风险，不能作为关闭依据。

### 2.3 必须始终成立的安全不变量

- 宿主不得出现 `0.0.0.0:9000`、`[::]:9000`、`0.0.0.0:9443` 或 `[::]:9443`；9001 / 9443 若保留，只能绑定回环。
- 浏览器对象存储访问只能经 443 的 `/libiaolink/` 门面；不得新开公网 9000 或其它 MinIO API 端口。
- api / worker 使用的凭据必须属于专用 service account，策略只能覆盖 `libiaolink` 桶和业务实际需要的对象动作；不得拥有用户、策略、桶管理或其它桶权限。
- root 凭据只能进入 minio 容器和受控应急运维会话；不得出现在 api / worker / web / tools 的长期容器、`server.env`、镜像、源码、日志或回放证据中。
- `storage:init` 只能使用 bootstrap 凭据；`storage:it` 和运行时只能使用应用凭据；两组凭据不可互换。
- `AccessDenied`、空值、缺失文件、权限不合规一律 fail closed；不能把权限错误降级成「存储不支持」告警。
- 任何 Secret 都不得进入仓库、PR 描述、开发日志、命令输出、测试 artifact 或截图；验证只记录文件名、路径存在性、HTTP 状态和脱敏结论。
- 轮换凭据不得删除对象、桶或版本；回滚也不得恢复为「应用使用 root」的状态。

## 3. 目标架构

```text
浏览器 / api / worker
        │  https://test-pm.libiaorobot.com:443
        ▼
      Nginx（唯一对外入口）
        ├── /api/v1        -> api:3000
        └── /libiaolink/   -> minio:9000（Docker prod 网络）

运维
        │  ssh -L 9001:127.0.0.1:9001 ...
        └── 127.0.0.1:9001 -> MinIO Console

可选排障
        │  ssh -L 9443:127.0.0.1:9443 ...
        └── 127.0.0.1:9443 -> Nginx MinIO 备用门面
```

### 3.1 端口契约

| 端口 | 宿主绑定 | 用途 | 关闭验收 |
|---|---|---|---|
| 80 | `0.0.0.0:80` / IPv6 按现网 | HTTP 跳 HTTPS | 仅允许跳转与健康探活 |
| 443 | `0.0.0.0:443` / IPv6 按现网 | SPA、API、`/libiaolink/`、ONLYOFFICE | 唯一浏览器业务入口 |
| 9000 | **不发布** | MinIO S3 API（仅 Docker 网络） | `ss` 无宿主 9000 监听；外部不可达 |
| 9001 | `127.0.0.1:9001` | MinIO Console / SSH 隧道 | 仅回环；非回环外部不可达 |
| 9443 | `127.0.0.1:9443` | MinIO 备用门面 / SSH 隧道 | 仅回环；非回环外部不可达 |

本表约束的是宿主暴露面。MinIO / Nginx 在容器内仍监听自身端口，供 Docker 网络或宿主回环访问；容器内监听不得等同于对外发布。

9443 是临时留存的排障入口，不是浏览器主通道。若 S6 回放确认不再使用，可另开变更删除 Nginx 9443 server 和宿主映射；删除前不得让 H1 回放或排障依赖已移除的入口。

### 3.2 身份与凭据矩阵

| 身份 | Secret 文件 | 消费方 | 允许 | 禁止 |
|---|---|---|---|---|
| MinIO root | `minio_root_user` / `minio_root_password` | minio 容器；受控应急会话 | 启动 MinIO；一次性创建用户 / 策略 / service account；应急修复 | 作为 api / worker 凭据；进入应用容器；写入仓库 / 日志 / 证据 |
| 应用父用户 `libiaolink-app` | 临时随机口令，不长期存业务文件 | 仅 root 管理操作 | 被绑定 `libiaolink-app-rw` 策略；派生 service account | 日常应用登录；管理员操作 |
| 应用 service account `libiaolink-api` | `s3_access_key` / `s3_secret_key` | api、worker、`storage:it` | `libiaolink` 桶对象读写、列举版本、分片、彻底删除业务对象 | 用户 / 策略 / 桶创建删除；其它桶；root 权限 |
| Bootstrap 父用户 `libiaolink-bootstrap` | 临时随机口令，不长期存业务文件 | 仅 root 管理操作 | 被绑定 `libiaolink-bootstrap` 策略；派生初始化 service account | 日常应用登录；对象读取；用户 / 策略管理 |
| Bootstrap service account `libiaolink-storage-init` | `s3_bootstrap_access_key` / `s3_bootstrap_secret_key` | `storage:init` / `storage:init --check` | 桶存在性、创建桶、版本控制、CORS、lifecycle 初始化 | 对象内容读取 / 写入 / 删除；用户 / 策略管理；删除桶 |

应用父用户和 bootstrap 父用户只承担策略挂载与 service account 归属。父用户口令可随机生成后丢弃；后续通过 root 重置或重建，不把父用户口令落成长驻业务 Secret。

### 3.3 应用策略（起点）

工程文件建议落在 `deploy/prod/minio/policies/libiaolink-app-rw.json`：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::libiaolink"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::libiaolink/*"]
    }
  ]
}
```

覆盖范围对应现有 `S3ObjectStorage` 的分片直传、`ListParts`、服务端 `CopyObject`、下载、版本列举、普通删除与按版本彻底删除。若 MinIO 对某个实际调用返回 403，只允许在复现证据后追加该调用的最小动作，不得改成 `s3:*`、`arn:aws:s3:::*` 或管理权限。

### 3.4 Bootstrap 策略（起点）

工程文件建议落在 `deploy/prod/minio/policies/libiaolink-bootstrap.json`：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:ListBucket",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration"
      ],
      "Resource": ["arn:aws:s3:::libiaolink"]
    }
  ]
}
```

`storage-init.mjs` 当前 CORS 在 MinIO 上返回不支持 API，只允许 `NotImplemented` / `NotSupported` / `MethodNotAllowed` 等明确能力缺失进入告警；`AccessDenied` 必须失败。CORS / lifecycle 的读取分支也不得把未知异常静默当作「未配置」：`NoSuchCORSConfiguration` / `NoSuchLifecycleConfiguration` 与明确的能力缺失分开处理，lifecycle 的 `InvalidArgument` 仍按现有能力差异处理，但权限错误不得被吞掉。

## 4. 实施设计

### 4.1 网络收口

- `deploy/prod/docker-compose.yml` 的 minio 服务删除 `9000:9000`；healthcheck 仍访问容器内 `127.0.0.1:9000`。
- 9001 保持 `127.0.0.1:9001:9001`；不得改成 `0.0.0.0`。
- web 的 9443 改成 `127.0.0.1:9443:9443`，或按后续确认完全删除；本方案默认保留回环排障口。
- 不改 `S3_ENDPOINT=https://test-pm.libiaorobot.com`，因为预签名 URL 的 host 必须是浏览器可达的 443 默认端口。
- 不以「上游防火墙已经挡住」为收口依据；宿主绑定必须先关闭，再做网络 ACL 和外部探活。

### 4.2 Docker 防火墙

- 使用 `DOCKER-USER` 链限制宿主机转发到容器端口的流量；普通 UFW `INPUT` 规则不能覆盖 Docker 的 DNAT 行为，不能只看 `ufw status`。
- 默认只放行 22 / 80 / 443 的既定入口；对 9000 / 9001 / 9443 的非回环访问显式拒绝。
- 规则必须幂等、持久化，并在 Docker 服务重启和主机重启后验证；若存在云安全组 / 上游 ACL，必须在同一变更中配置并留存截图或命令输出。
- 检查命令至少包含 `iptables -S DOCKER-USER`（或 nftables 等价命令）和 `ss -lntp`；任何「不在默认链、但仍在 Docker 自动链」的临时规则都应清除。

### 4.3 Secret 分文件挂载

- api / worker 改为声明式 Compose `secrets:`，默认挂载到 `/run/secrets/<name>`；只挂载本角色所需的最少文件。
- `service-entrypoint.cjs` 的读取根目录从 `/opt/libiaolink/secrets` 改为 `/run/secrets`，继续在 root 阶段读取注入，再降权 `1000:1000`。
- `tools` 只挂 `pg_migrator_password`；storage 初始化凭据由一次性 `storage.sh init` 显式注入，不长期挂给 tools。
- 禁止整目录 `./secrets:/opt/libiaolink/secrets:ro` 挂载进入 api / worker / tools。
- 缺失、空值、不可读或权限不合规必须 fail closed；不接受从 `server.env` 回退敏感值。
- 一次性 storage / 迁移脚本不得把 Secret 值展开到命令行参数、shell history 或其它可被 `ps` 读取的位置；使用受控文件输入或权限 `600` 的临时 env-file，并确保退出时清理。

### 4.4 凭据切换与轮换

- 应用先切换到 service account，完成上传、分片、复制、预览、下载、回收站彻底删除和 `storage:it` 全链路，再轮换 root。
- root 轮换只允许在维护窗口更新 `minio_root_user` / `minio_root_password` 并重建 minio；不得删除数据卷、桶或对象。
- 旧 root 与应用旧值（当前同值）在轮换后都必须失效；旧值若存在于 shell 历史、临时文件、备份或镜像构建上下文，必须按 Secret 泄露处置，先停止传播再清理。
- 轮换采用「先创建新身份、验证、切应用、再停用旧身份」的顺序；不得先删除唯一可用凭据导致对象存储不可恢复。

### 4.5 H1 与端口兼容

- H1 的 443 SPA、443 `/libiaolink/` 和对象门面响应头回放保持不变。
- 9443 仅保留回环映射时，H1 B7 继续通过 SSH 隧道和 `H1_BACKUP_STORAGE_URL` 验证；不得为了复用旧脚本重新把 9443 发布到全部接口。
- 历史 H1 回放证据不重写；S6 只追加「9443 已改为回环 / 隧道」的部署证据和必要说明。

## 5. 执行切片

粗估实施工作量：**约 4～6 人日**（不含评审等待和外部网络窗口）。最小可上线顺序是 S1 → S2 → S3 → S4 → S5；S6 / S7 可与实现并行准备，但必须在 S5 后完成。

| 切片 | 内容 | 主责 / 评审 | 依赖 | 交付物 |
|---|---|---|---|---|
| S0 | 方案、基线与评审冻结 | lan / px、wmj | 无 | 本文件、执行状态表、评审记录 |
| S1 | Compose 与宿主端口收口 | px / lan、wmj | S0 | Compose、部署说明、`ss` / curl 证据 |
| S2 | `DOCKER-USER` 与外部网络复核 | px / lan、wmj | S1 | 防火墙脚本、持久化证据、外部探活记录 |
| S3 | MinIO 用户 / 策略 / service account | lan / px、wmj | S1 | 策略 JSON、身份脚本、负向权限回放 |
| S4 | Secrets 分文件挂载与运行时切换 | lan + px / wmj | S3 | Compose、entrypoint、storage 脚本、全链路回放 |
| S5 | root 轮换与旧凭据失效 | lan + px / wmj | S4 | 轮换记录、旧凭据失败证据、Secret 清理记录 |
| S6 | 文档、H1 兼容与全量回归 | px + lan / wmj | S1～S5 | README、Runbook、H1 证据、全量门禁 |
| S7 | 测试机 / 生产验收与 F-02 关闭 | lan + px / wmj | S5、S6 | 回放证据、DoD、开发日志、关闭评审 |

建议 PR 切分（按常驻分支归属，不跨人代推）：

1. **PR-0（lan 常驻分支）**：仅本方案文档。px / wmj 评审；不改配置、脚本或 Secret。
2. **PR-NET（px 常驻分支）**：S1 + S2 的 Compose、端口注释、防火墙脚本和部署说明。lan / wmj 评审；优先合入并部署，尽快缩小暴露面。
3. **PR-PLATFORM（lan 常驻分支）**：`server/scripts/storage-init.mjs` 的 fail-closed 修正、权限错误回归与必要的 server 测试。px / wmj 评审；不直接修改 `deploy/`。
4. **PR-DEPLOY（px 常驻分支）**：S3 / S4 的 MinIO 策略 JSON、身份脚本、Compose Secret 分文件挂载、`storage.sh` / DB 脚本和部署 README。lan 提供策略口径并评审；必须在 PR-NET 合入后基于最新 `main` 重做，避免并行改同一 Compose。
5. **PR-EVIDENCE（按文档归属）**：部署 README / M8 Runbook 由 px 分支提交；F-02 回放证据、方案状态与本文件更新由 lan 分支提交并请 px 复核。不得代他人创建或推送常驻分支。

S5 的 root 轮换是受控运维动作，不是直接手改业务代码：执行前确认对应 Runbook 已合入，执行后把脱敏证据按上述归属回填，不能把 Secret 或完整运维输出写进 PR。

### S0 · 方案落档与评审冻结

**目标**：让后续实现不再临场决定端口、身份边界或回滚口径。

- [x] 本文件完成 px（部署 / docs）与 wmj（安全）复核；评审日期 2026-10-23。经用户确认三方协商后，由 lan 代录签收。
- [x] 复核 `origin/main@6b846b2` 的 F-02 相关文件：9000 / 9443 宿主发布、三处整目录 `secrets` 挂载及 root 同值口径仍存在，新增提交未构成实质修复；基线已更新。
- [x] 工具链策略冻结：不下载来源不明的新二进制；S3 首个变更动作前，必须记录受控 `mc` 的版本、来源、SHA-256 和 `--help` 兼容性；若没有受控 `mc`，只允许使用服务器本地 MinIO Console。实际工具链证据是 S3 入口门禁，缺失不得执行身份变更。
- [x] 本轮执行范围冻结为公司测试机 `10.1.104.44`；生产未部署，S7 证据必须明确「F-02 生产未关闭」。
- [x] 本签收 PR 仅改文档与开发日志，无 API / DDL / 前端行为变更；后续安全配置 / 运维脚本 PR 同步遵守该口径。

**通过条件**：端口契约、身份矩阵、策略动作、回滚边界和评审路由无异议。**未通过不得开始 S1。**

**冻结结论（2026-10-23）**：通过。9000 不发布；9001 与 9443 仅绑定回环；9443 保留为 H1 排障入口并在 S6 复评是否删除。应用 / bootstrap 身份矩阵与两段策略 JSON 冻结；策略动作已按 `S3ObjectStorage`、`storage:it` 与 `storage-init` 的实际调用核对，没有通配或管理权限。root 仅用于启动、一次性身份管理和受控应急；sentinel 跨桶负向测试由 root 创建 / 清理，不扩大 bootstrap 权限。root 轮换必须在 S4 全链路通过后的维护窗口执行，任何回滚都不得恢复应用使用 root 或重新暴露 9000 / 9443。S1 可以开始在 px 常驻分支实施。

### S1 · 关闭宿主端口暴露（最先实施）

**目标**：即使上游网络策略误放行，也不能从宿主全接口直达 MinIO。

**改动文件**

- `deploy/prod/docker-compose.yml`
- `deploy/prod/server.env.example`（只改注释，不改端点）
- `deploy/prod/README.md`（端口与 9443 口径，和配置同 PR）

**执行步骤**

1. minio 删除 `9000:9000`，保留 9001 的 `127.0.0.1` 绑定；确认 healthcheck 仍走容器内 9000。
2. web 的 `9443:9443` 改为 `127.0.0.1:9443:9443`；如果 px 确认 H1 不再依赖备用门面，再另开变更完全删除。
3. 不修改 443 的 `/libiaolink/` 路径、`proxy_pass`、`Host $http_host`、`S3_ENDPOINT` 和预签名 TTL。
4. 更新部署说明中的「9000 对局域网发布」「9443 内网备用」表述，明确「9000 无宿主发布；9001 / 9443 仅回环」。
5. 开发机通过 SSH 隧道验证 9001 控制台和 9443 备用门面；443 只做正常业务验证，不把隧道地址写入应用配置。

**验收**

- `ss -lntp` 无 `0.0.0.0:9000`、`[::]:9000`、`0.0.0.0:9443`、`[::]:9443`；9001 / 9443 仅回环。
- 从服务器本机 curl `/libiaolink/` 仍返回预期的 400 / 403 / 404 安全拒绝，不是连接失败；`/readyz` 全绿。
- 从开发机访问 9000 / 9443 失败；通过 SSH 隧道访问 9001 / 9443 成功。
- 真实浏览器上传、预览、下载、回收站彻底删除均不受影响；H1 443 B7 不回归。

**回滚**：只允许恢复为回环映射；禁止把 9000 或 9443 恢复成 `0.0.0.0`。若 443 业务异常，回滚的是配置注释或服务重建，不是端口暴露。

### S2 · 主机防火墙与外部网络复核

**目标**：在绑定收口之外建立第二层网络边界，并证明 Docker 重启后仍有效。

**改动文件**

- 新增 `deploy/prod/scripts/docker-user-firewall.sh`（建议支持 `--check` / `--apply`，规则幂等、失败非零）。
- `deploy/prod/README.md` / `docs/M8-部署Runbook与上线检查单(单机).md` 增加执行与恢复说明。

**执行步骤**

1. 盘点宿主网卡、Docker bridge 和现有防火墙实现（iptables / nftables / 云安全组）；先 dry-run，应用前备份规则。
2. 在 `DOCKER-USER` 中拦截非授权到 9000 / 9001 / 9443 的 TCP 流量；保留 22 / 80 / 443 的既有访问策略。
3. 配置持久化单位或系统规则文件，保证 Docker 服务重启、主机重启后仍生效。
4. 从开发机、办公网和公网分别做 9000 / 9001 / 9443 探活；从服务器本机做回环正向验证。
5. 若存在云安全组 / 上游 ACL，同步限制 9000 / 9001 / 9443，并在证据中写明作用域；不能只修改其中一层。

**验收**

- `iptables -S DOCKER-USER`（或 nftables 等价）显示规则且位于有效链；`--check` 退出码为 0。
- Docker 服务重启 / 主机重启后，端口绑定和防火墙规则仍满足验收。
- 开发机、办公网、公网的 9000 / 9001 / 9443 均不可达；443 / 80 按预期可达。
- 无规则的临时放行、调试端口或「为了排障先全开」记录残留。

**回滚**：只回滚错误的具体规则，保留 9000 / 9001 / 9443 的默认拒绝；不得用 flush 整条链的方式恢复。

### S3 · MinIO 最小权限身份与策略

**目标**：先建立可重复、可验证的凭据与策略，不改变 api / worker 当前使用的 Secret。

**改动文件**

- `deploy/prod/minio/policies/libiaolink-app-rw.json`
- `deploy/prod/minio/policies/libiaolink-bootstrap.json`
- `deploy/prod/scripts/minio-identity.sh`（建议 `check` / `apply` / `rotate`，默认不输出 Secret）
- `deploy/prod/README.md`（身份清单、凭据文件与首次部署顺序）

**执行步骤**

**S3 入口门禁**：修改任何 MinIO 身份前，先按 S0 冻结口径确认受控 `mc` 的版本、来源、SHA-256 与 `--help` 兼容性；没有受控 `mc` 时改用服务器本地 MinIO Console。该证据缺失时停止 S3，不得下载来源不明二进制。

1. 用受控 root 会话创建父用户 `libiaolink-app`、`libiaolink-bootstrap`，分别挂载上节策略；父用户口令随机生成并在完成后从临时文件清除。
2. 分别创建 service account `libiaolink-api`、`libiaolink-storage-init`；只把 service account 的 access key / secret 写入服务器受控 Secret 文件。
3. 写入 `s3_access_key` / `s3_secret_key`（应用）和 `s3_bootstrap_access_key` / `s3_bootstrap_secret_key`（初始化）；文件权限 `600`，目录权限 `700`。
4. 用 bootstrap 凭据执行 `storage:init --check`；用应用凭据执行只读对象探针；此阶段不重启 api / worker。
5. 运行负向测试：应用凭据不能创建用户 / 策略 / 桶、不能删除生产桶、不能访问临时 sentinel 桶；bootstrap 凭据不能读写对象。sentinel 桶由受控 root 会话创建、验证后清理；不得为测试给 bootstrap 增加 `CreateBucket` / `DeleteBucket` 或跨桶权限。
6. 记录 `mc --version`、策略文件名、策略动作与负向 HTTP / exit code；不记录 access key、secret、完整命令环境或 MinIO root 输出。

**验收**

- `libiaolink-app-rw` 与 `libiaolink-bootstrap` 的策略内容与文件完全一致；没有 `s3:*`、`arn:aws:s3:::*` 或管理动作。
- `storage:init --check` 使用 bootstrap 成功；预期 CORS / lifecycle 能力告警仍可按 MinIO 版本记录，但 `AccessDenied` 必须失败。
- 应用 service account 不能管理用户 / 策略 / 桶，不能访问 sentinel 桶；bootstrap 不能读写对象、不能创建 / 删除 sentinel 桶。
- 现有 api / worker 尚未切换，旧 root 应用凭据仍存在，因此本切片不能宣称 F-02 关闭。

**回滚**：保留 root 管理和已创建的新身份，不做对象删除；只撤销新 service account 的临时验证权限。若策略过窄，按实际 403 复现证据追加最小动作，不直接扩大为通配权限。

### S4 · Secrets 隔离与运行时凭据切换

**目标**：让长期运行的应用只看到自己的 Secret，并实际使用最小权限 service account。

**改动文件**

- `deploy/prod/docker-compose.yml`：api / worker 增加按文件的 Compose `secrets:`；tools 只挂 `pg_migrator_password`；移除三处整目录 `./secrets` 挂载。
- `deploy/prod/scripts/service-entrypoint.cjs`：读取根目录改为 `/run/secrets`；明确必需 / 可选 Secret；不再回退整目录。
- `deploy/prod/scripts/storage.sh`：`init` 使用 `s3_bootstrap_*`，`it` 使用 `s3_*`；缺少对应文件直接退出；凭据不得展开到命令行参数，使用受控文件或权限 `600` 的临时 env-file 并在退出时清理。
- `deploy/prod/scripts/db-migrate.sh`、`deploy/prod/scripts/db-seed.sh`：改为读取 `/run/secrets/pg_migrator_password`。
- `server/scripts/storage-init.mjs`：移除 `AccessDenied` 的不支持降级；修复 CORS / lifecycle 读取分支吞掉未知异常的问题；增加权限错误回归测试（含 `--check`）。
- `deploy/prod/README.md`：更新 Secret 清单、首次部署和运维命令。

**执行步骤**

1. 在 Compose 顶层声明 api / worker 所需的 `pg_api_password`、`casdoor_*`、`s3_*`、`internal_sync_token`、`onlyoffice_jwt_secret`、`translate_api_key`、`wecom_*` 等 Secret；只挂载角色实际需要的文件。
2. 修改 entrypoint 的 Secret 读取目录，保留 root 读取 → 注入环境 → 降权 `1000:1000` 的顺序；缺文件 / 空值按应用启动校验失败。
3. 让 `storage.sh it` 使用新的应用 service account；先用 bootstrap 执行 `storage:init --check`，再跑 `storage:it`。
4. 更新 `server.env` 或部署环境时只改非敏感端点 / TTL；不得把新 access key、secret 或 root 值写入 `server.env`。
5. 重建 api / worker，确认容器 healthy、`/healthz` 200、`/readyz` 200、真实上传 / 分片 / 列表 / 复制 / 预览 / 下载 / 回收站彻底删除全链路通过。
6. 检查容器挂载与 `/run/secrets` 文件清单，确认没有任何 `minio_root_*`、`pg_superuser_password` 或整目录 `secrets` 挂载。

**验收**

- api / worker 运行态只使用应用 service account；`storage:it` 24 / 24，`readyz` 全绿。
- 应用容器不存在 `/run/secrets/minio_root_user`、`/run/secrets/minio_root_password`、`pg_superuser_password`，也不存在 `/opt/libiaolink/secrets` 挂载。
- `server.env` 无 access key、secret、root 值；应用日志无凭据。
- `storage:init --check` 使用 bootstrap 返回 0；权限不足或 `AccessDenied` 返回非 0，不允许仅告警。
- 部署机进程命令行、shell history、临时文件和 CI 日志中均不出现 access key、secret 或 root 值。
- 旧 root 应用凭据尚未轮换，因此仍不能关闭 F-02。

**回滚**：如果应用启动失败，补挂缺失的单文件 Secret 或修正策略并重启；禁止恢复整目录挂载或把应用切回 root。临时应急只允许 root 在服务器本地做对象存储修复，不进入应用容器。

### S5 · root 轮换与旧凭据失效

**目标**：消除当前 root 值已经与业务凭据同值的暴露，并确认旧值全部失效。

**执行步骤**

1. 预约维护窗口，确认 minio 数据卷 / bind 目录有可恢复备份或快照；不把 Secret 内容放进备份说明或工单。
2. 在 `umask 077`、不写 shell history、临时 `MC_CONFIG_DIR` 的受控会话中生成新的 root 用户名 / 口令，更新 `minio_root_user` / `minio_root_password` 并重建 minio。
3. 验证 minio healthy、443 `/libiaolink/`、`readyz`、`storage:init --check` 和 `storage:it`；旧 root / 旧应用凭据的认证探针必须失败。
4. 清理旧 Secret 的受控副本：shell 历史、临时 `mc` 配置、一次性导出、旧部署包和未受控备份；无法销毁的备份标记为敏感并限制访问。
5. 复核应用容器、`server.env`、镜像构建上下文、日志、PR 和 artifact 中不存在旧值；只记录「未发现」或文件名，不打印值。
6. 保留 root 于 minio 容器启动和应急会话中；确认日常 api / worker 没有 root 依赖。

**验收**

- 新 root 可启动 minio；应用 service account 不受 root 轮换影响。
- 旧 root 凭据与旧应用凭据（当前同值）均认证失败，旧签名 / 旧上传会话不会恢复为可用。
- 9000 / 9001 / 9443 的暴露面仍满足 S1 / S2；没有为了轮换重开端口。
- Secret 清理记录不含 Secret 值；未发现的旧副本有明确的处置结论。

**回滚**：若新 root 导致 minio 无法启动，可短暂恢复旧 root 启动并立即进入事件处置；网络收口和 `DOCKER-USER` 规则不得回滚。修复后必须重新执行轮换和旧凭据失效验证。

### S6 · 文档、H1 兼容与全量回归

**目标**：让代码、部署件、H1 回放与运行手册表达同一事实。

- 更新 `deploy/prod/README.md`：Secret 清单、首次部署、身份创建、轮换、9000 / 9001 / 9443 端口、防火墙与回滚。
- 更新 `docs/M8-部署Runbook与上线检查单(单机).md`：部署前检查、上线窗口、轮换、外部网络证据与异常处置。
- 更新 `deploy/prod/server.env.example` 注释：不出现凭据；说明 9000 无宿主发布、9001 / 9443 仅回环、H1 9443 走 SSH 隧道。
- 更新 `docs/H1-SVG预览同源存储型XSS整改方案.md` 与 H1 回放说明的部署口径，仅追加 F-02 引起的 9443 回环事实；历史 B7 结果不重写。
- 如改动 `frontend/scripts/h1-svg-preview-e2e.mjs`，同步 `frontend/package.json` / CI 说明并请 px 评审；默认不要求修改前端功能代码。
- 确认 `前端功能需求.md`、`字段对照清单.md` 不需要变更（无 UI、API 字段或数据模型变化）；若实际发生则按仓库文档同步规则补齐。

**通过条件**

- 文档中不再出现「应用凭据与 root 同值」「9000 对局域网发布」「9443 对全部接口发布」的现行口径（历史变更记录保留但标明过期）。
- `server` 定向测试、H1 443 B7、真实上传 / 预览 / 下载、回收站彻底删除全部有证据；`frontend` 仅在改动前端脚本时跑 `typecheck` / `build`。
- 新增文档与脚本不含 Secret、真实凭据、生产对象键或本机敏感路径。

### S7 · 验收回放与 F-02 关闭

**目标**：把「配置存在」升级为「运行态可证明」。

**交付**

- 新增 `docs/F-02-MinIO整改回放证据.md`（只放脱敏命令结果、状态码、版本、时间、评审人与证据路径）。
- 在 `deploy/prod/README.md` / M8 Runbook 中登记本次部署的 commit、部署时间、容器状态、`storage:it`、`readyz`、端口与外部探活结论。
- 在 `开发日志.md` 顶部按仓库格式追加一条：`日期 时间 | lan | lan | Push 序号`；作者 / 分支按实际推送人填写，不能虚构。
- 由非作者完成安全与部署复核；PR 描述列出未执行 / 失败项、剩余风险和 H1 兼容结论。

**关门前必须全部成立**

- 应用凭据不能创建用户 / 策略 / 桶，不能访问其它桶；bootstrap 不能读写对象；root 不能作为应用凭据。
- 9000 无宿主监听；9001 / 9443 仅回环；开发机、办公网、公网分别验证不可达；Docker / 主机重启后规则仍有效。
- 旧 root 和旧应用凭据失效；旧 Secret 副本处置完成；应用容器无 root Secret。
- `storage:init --check`、`storage:it` 24 / 24、`readyz`、真实上传 / 分片 / 复制 / 预览 / 下载 / 回收站彻底删除全部通过。
- H1 443 SPA / 443 `/libiaolink/` 无回归；9443 仅通过 SSH 隧道验证且不产生新的外部入口。

## 6. 验收与回归

### 6.1 功能性验收

| 场景 | 期望 |
|---|---|
| 浏览器上传 | 443 门面预签名 PUT 成功；不出现 9000 / 9443 浏览器依赖 |
| 分片上传 | CreateMultipartUpload / UploadPart / ListParts / Complete 成功 |
| 服务端复制 | staging → 契约键 CopyObject 成功，版本与哈希不变 |
| 预览 / 下载 | 受控签名 URL 正常，字节一致，附件下载头正确 |
| 回收站 | 普通删除只留 delete marker；按版本彻底删除可清理对象 |
| `storage:init --check` | bootstrap 凭据返回 0；权限错误返回非 0 |
| `storage:it` | 应用 service account 24 / 24 |
| `readyz` | object-storage / database / preview 等探针全绿 |
| H1 B1～B7 | 443 全绿；9443 仅在隧道场景按设计验证 |

### 6.2 安全与网络验收

- 应用凭据的管理面负向测试全部拒绝：建用户、改策略、建桶、删桶、跨桶读取 / 写入 / 删除。
- bootstrap 负向测试全部拒绝：对象读写、用户 / 策略管理、桶删除。
- 服务器 `ss -lntp`：无宿主 9000；9001 / 9443 仅回环；443 为唯一业务入口。
- 开发机 / 办公网 / 公网：9000、9001、9443 均不可达；网络策略变更前后均有记录。
- api / worker / tools：无 root Secret、无 `pg_superuser_password`、无整目录 secrets 挂载。
- 轮换后旧 root / 旧应用凭据认证失败；旧值不出现在日志、环境变量、镜像、`server.env` 或回放证据。

### 6.3 命令门禁

仓库内（按实际改动选择，未运行必须如实登记）：

```powershell
cd server
npm run typecheck
npm test
npm run build
npm run check:boundaries

cd ..\deploy\prod
docker compose config --quiet
bash -n scripts/storage.sh
bash -n scripts/db-migrate.sh
bash -n scripts/db-seed.sh
node --check scripts/service-entrypoint.cjs
node --check ../../server/scripts/storage-init.mjs

cd ..\frontend
npm run typecheck
npm run build
```

部署机（Secret 只从受控文件读取，不打印）：

```bash
cd /opt/libiaolink/deploy/prod
docker compose --profile app ps
docker compose config --quiet
nginx -t
bash scripts/storage.sh init --check
bash scripts/storage.sh it
curl -fsS https://test-pm.libiaorobot.com/readyz
ss -lntp
iptables -S DOCKER-USER
```

如改动 `frontend/scripts/h1-svg-preview-e2e.mjs` 或 H1 门面，追加：

```powershell
cd ..\frontend
npm run preview:svg-e2e
```

验证输出不得粘贴凭据、完整环境变量、签名 query、真实对象键或 Secret 文件内容。

## 7. 发布、回滚与观测

### 7.1 发布顺序

1. S0 方案评审通过；确认测试机与生产适用同一身份模型。
2. S1 关闭 9000 / 9443 的全接口发布，完成服务器本机与开发机边界验证。
3. S2 应用并持久化 `DOCKER-USER` 规则，完成网络 ACL 和外部探活。
4. S3 创建 app / bootstrap 父用户、策略与 service account，完成负向权限测试；此时不切换运行时。
5. S4 切换 api / worker 到应用 service account，切断整目录 Secret 挂载；完成上传全链路和 `storage:it`。
6. S5 在维护窗口轮换 root，确认旧凭据失效，清理旧副本。
7. S6 同步文档、H1 兼容说明与全量回归。
8. S7 完成测试机 / 生产回放证据、非作者评审与开发日志，再关闭 F-02。

### 7.2 回滚边界

- 端口回滚只能是「回环映射」或「不发布」；不得恢复 `0.0.0.0:9000` / `0.0.0.0:9443`。
- 应用回滚不得回到 root 凭据；只能修复 service account 策略或补挂单个 Secret。
- root 启动失败可短暂恢复旧 root 启动，但须按安全事件处理；网络和 Secret 隔离不回滚。
- 任何回滚不得删除对象、桶、版本或数据卷；sentinel / 测试对象只能由专门的清理步骤删除。

### 7.3 观测

- 宿主：9000 / 9001 / 9443 监听状态、DOCKER-USER 规则、Docker 重启后的绑定漂移。
- 存储：`storage:it`、`readyz`、S3 4xx / 5xx、AccessDenied 计数、分片未完成数与生命周期清理状态。
- 应用：上传 / 下载 / 预览失败率、对象不存在与权限拒绝的结构化错误，不输出凭据。
- 安全：应用容器 Secret 清单、旧凭据认证失败探针、外部端口探活；发现异常先按事件升级，不先放宽权限。

## 8. 风险与待实现时确认项

| 风险 / 待确认项 | 处置 |
|---|---|
| MinIO 上游已归档，`mc` / Console 能力和下载渠道受限 | S0 记录现有 `mc` 版本与来源；无受控工具时用服务器本地 Console 完成一次性身份创建并留证据，不下载来源不明二进制 |
| 9443 仍保留回环 listener | 仅允许 SSH 隧道；若 S6 确认无回放需求，另开变更删除 Nginx 9443 server 与宿主映射 |
| 应用 service account 仍可访问 `libiaolink` 桶内全部对象 | 这是文件服务的业务边界；项目 / 记录级隔离继续由应用权限与数据库控制，不在本方案伪装成桶级隔离 |
| MinIO policy 动作与实际调用不完全一致 | 用 403 复现和负向测试定位，只追加最小动作；禁止通配 `s3:*` 或全桶 ARN 通配 |
| CORS / lifecycle 在 MinIO 返回 NotImplemented / InvalidArgument | 按能力缺失告警并记录版本；`AccessDenied` 必须失败，不能混入能力缺失 |
| Compose Secret 切换导致启动失败 | 逐项补齐缺失文件，保持 fail closed；禁止恢复整目录挂载或环境变量回退 |
| root 轮换造成短时不可用 | 维护窗口、确认 bind / 数据卷、先验证新身份；短暂回滚旧 root 也必须保持端口关闭并按事件记录 |
| `DOCKER-USER` 规则不持久，宿主机重启后失效 | 使用持久化 unit / 规则文件，重启演练；`--check` 纳入部署验收 |
| 旧 Secret 可能残留在备份 / 历史 / 日志 | 先停止传播、轮换、再清理；不能只在后续提交删除旧文件 |
| 未来切换 SeaweedFS / 既有对象存储 | 保持 S3 接口和策略边界；按 ADR-006 迁移时重新验证 service account / bucket policy 语义 |

## 9. Definition of Done（F-02 关闭条件）

- [ ] S0 方案已由 px、wmj 完成非作者评审，端口、身份和回滚边界无争议。
- [ ] 9000 不再发布宿主端口；9001 / 9443 仅回环；Docker / 主机重启后仍成立。
- [ ] 开发机、办公网、公网对 9000 / 9001 / 9443 的探活全部失败；443 / 80 按设计可用。
- [ ] 应用使用桶级最小权限 service account；不能管理用户 / 策略 / 桶，不能访问其它桶。
- [ ] bootstrap 只能完成初始化配置；不能读写对象、不能管理身份、不能删除桶。
- [ ] api / worker / tools 不再整目录挂载 `secrets/`；root Secret 不进入应用容器。
- [ ] root 已轮换；旧 root 与应用旧值失效；旧副本处置完成。
- [ ] `storage:init --check`、`storage:it` 24 / 24、`readyz` 和真实上传 / 预览 / 下载 / 回收站全链路通过。
- [ ] H1 443 门面不回归；9443 仅隧道验证；历史 H1 证据不被改写。
- [ ] `deploy/prod/README.md`、M8 Runbook、H1 部署说明、`开发日志.md` 与回放证据同步。
- [ ] 所有适用测试、部署检查和回滚演练有证据；未执行 / 失败项明确登记。
- [ ] F-02 回放证据与评审记录齐全后，才把执行状态表改为「已关闭」。

## 10. 参考

- `deploy/prod/docker-compose.yml`
- `deploy/prod/nginx/libiaolink.conf`
- `deploy/prod/README.md` §2、§9
- `deploy/prod/scripts/storage.sh`
- `deploy/prod/scripts/service-entrypoint.cjs`
- `server/scripts/storage-init.mjs`
- `server/scripts/storage-it.mjs`
- `frontend/scripts/h1-svg-preview-e2e.mjs`
- `docs/H1-SVG预览同源存储型XSS整改方案.md`
- `docs/M8-部署Runbook与上线检查单(单机).md`
- `docs/adr/ADR-006-对象存储.md`、`docs/adr/ADR-013-部署与容量起点.md`
