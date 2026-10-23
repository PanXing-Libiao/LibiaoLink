# F-02 MinIO 根凭据与端口暴露整改方案与执行切片

> 来源：`LibiaoLink_安全审查报告_2026-10-21.pdf` F-02（第 4～5 页）｜严重度 High / P0｜报告验收要求：应用凭据不能管理用户 / 桶或访问其它桶；9000 / 9001 / 9443 从非授权网络不可达；轮换后旧凭据失效
> 报告审查基线：`px @ e05535b8`｜S0 复核基线：`origin/main@6b846b2`（2026-10-23；F-02 涉及的 Compose、Nginx、存储脚本与凭据挂载配置未发生实质修复）
> 起草：lan（后端平台 / file / storage / preview / outbox）｜拟稿日期：2026-10-22｜S0 评审冻结：2026-10-23｜状态：**S0 已冻结；S1～S5 已部署公司测试机（2026-10-23，`main@1881deac` · 回填 PR [#596](https://github.com/PanXing-Libiao/LibiaoLink/pull/596)），生产未部署；F-02 未关闭，S5 验收登记（S5-T3 旧预签名 / 历史应用值、T7 压缩 / 二进制备份敏感登记待补）、认证后真实上传 / 预览浏览器验收与 S6 / S7 待收口**
> S0 签收：px（部署 / docs）与 wmj（安全）完成复核；经用户确认三方协商后，由 lan 代录。冻结结论见 §5「S0 · 方案落档与评审冻结」。
> 归属与评审：`docs/` 归 px 主责，落档需 px 复核；生产 Compose、Nginx、主机防火墙与部署窗口归 px 主责；MinIO 身份 / 策略、`server/` 存储脚本与凭据接线归 lan 主责；安全验收请 wmj 交叉复核。涉及安全、部署与 Secrets 的高风险变更必须取得非作者批准。
> 变更控制：后续执行以本文件为基线。若执行中需要改变端口、身份模型、策略动作、切片顺序或验收条件，先修改本文件并写明原因、影响和回滚，再实施；已合入主干的回放证据与部署记录按不可变历史处理，不原地改写。

## 0. 执行状态

| 切片 | 状态 | PR / commit | 部署与验证证据 | 备注 |
|---|---|---|---|---|
| S0 · 方案落档与评审冻结 | 已通过并冻结（2026-10-23） | PR [#554](https://github.com/PanXing-Libiao/LibiaoLink/pull/554)；S0 签收提交 | 本文 §5 / S0 评审记录 | px、wmj 已复核；9443 回环保留至 S6 复评 |
| S1 · 关闭宿主端口暴露 | 已部署测试机（2026-10-23） | PR [#589](https://github.com/PanXing-Libiao/LibiaoLink/pull/589)；squash `1b24536` | `minio` / `web` 已重建；`9000` 不发布，`9001` / `9443` 仅回环，开发机三端口不可达；见 `deploy/prod/README.md` v2.23 | 端口复核通过；生产未部署 |
| S2 · 主机防火墙与外部网络复核 | 已部署并持久化（2026-10-23）；重启复核待 S6 | PR [#589](https://github.com/PanXing-Libiao/LibiaoLink/pull/589)；squash `1b24536` | DOCKER-USER unit `enabled/active`，`check` 通过；见 v2.23 | Docker / 主机重启后的规则恢复待 S6 |
| S3 · MinIO 最小权限身份与策略 | 已部署测试机（2026-10-23）；验收登记待收口 | PR [#591](https://github.com/PanXing-Libiao/LibiaoLink/pull/591)；squash `311c738c` | `apply` / `check` 通过；应用 `admin info` 与建桶均 `AccessDenied`；见 v2.23 | 运行时主路径通过；S3-T1～T9 逐项证据待 S7 登记 |
| S4 · Secrets 隔离与运行时凭据切换 | 已部署测试机（2026-10-23）；验收登记待收口 | PR [#594](https://github.com/PanXing-Libiao/LibiaoLink/pull/594)；squash `88670d85` | `api` / `worker` 仅挂白名单单文件 Secret、UID/GID 1000；`storage:init --check` 与 `storage:it` 24/24 通过；见 v2.23 | 运行时主路径通过；S4-T9 认证后浏览器全链路与逐项证据待 S7 登记 |
| S5 · root 凭据轮换与旧凭据失效 | 已部署测试机（2026-10-23）；验收登记待收口 | PR [#595](https://github.com/PanXing-Libiao/LibiaoLink/pull/595)；squash `1881deac` | 新 root 认证通过、旧 root 拒绝、旧口令扫描 `zero-hits`、状态目录已清理；证据 `/srv/data/backups/f02-s5-evidence/root-rotation-20261023T085110Z-success-7042.txt` | S5-T3 / T7 等逐项证据、认证后浏览器全链路与故障注入项待 S7 收口；不得回滚为 root 应用凭据 |
| S6 · 文档、H1 兼容与全量回归 | 待执行 | 待填 | 待填 | 9443 保留时只能经 SSH 隧道 |
| S7 · 验收回放与 F-02 关闭 | 待执行 | 待填 | 待填 | 旧凭据失效、外网不可达、证据齐全后才关闭 |

执行时更新本表：开始时写「进行中」；PR 合入后填 PR / commit；测试机或生产部署后填脱敏证据位置；发生设计变更时先在正文更新决策，再改本表。

> **运行时验证批次（2026-10-23 已部署测试机）**：S1～S5 已在公司测试机部署，执行记录见 `deploy/prod/README.md` v2.23、`开发日志.md` Push 460 / 461 与 PR [#596](https://github.com/PanXing-Libiao/LibiaoLink/pull/596)。运行时主路径结果已回填；认证后真实上传 / 预览浏览器验收未执行，S5-T3 历史值 / 旧预签名、T7 压缩 / 二进制备份敏感登记与故障注入项等逐项证据仍待 S7 收口。F-02 尚未关闭，生产未部署。

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
| `server/scripts/storage-init.mjs:46`（S3 已改并部署测试机） | 原先把 `AccessDenied` 统一归入「存储不支持该 API」；现已移除通用降级，仅保留 MinIO 无法授予的 CORS 动作这一明确例外。 |
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
- `AccessDenied`、空值、缺失文件、权限不合规一律 fail closed；唯一例外是 MinIO IAM 不支持桶级 CORS 动作，CORS 调用可记录为能力告警，lifecycle / 版本控制等其它路径的 `AccessDenied` 仍必须失败。
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
| Bootstrap service account `libiaolink-storage-init` | `s3_bootstrap_access_key` / `s3_bootstrap_secret_key` | `storage:init` / `storage:init --check` | 桶存在性、创建桶、版本控制、lifecycle 初始化；CORS 由服务端 `MINIO_API_CORS_ALLOW_ORIGIN` 配置 | 对象内容读取 / 写入 / 删除；用户 / 策略管理；删除桶；桶级 CORS IAM 动作（MinIO 不支持） |

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
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration"
      ],
      "Resource": ["arn:aws:s3:::libiaolink"]
    }
  ]
}
```

MinIO 的 IAM 动作列表不包含 `s3:GetBucketCORS` / `s3:PutBucketCORS`，因此 bootstrap 策略不声明这两个动作；CORS 由服务端 `MINIO_API_CORS_ALLOW_ORIGIN` 配置。`storage-init.mjs` 只在 CORS 路径把 `AccessDenied` 视为该能力不可授予的告警；`NotImplemented` / `NotSupported` / `MethodNotAllowed` 仍按能力缺失处理。lifecycle、版本控制和其它路径的 `AccessDenied` 必须失败。CORS / lifecycle 的读取分支也不得把未知异常静默当作「未配置」：`NoSuchCORSConfiguration` / `NoSuchLifecycleConfiguration` 与明确的能力缺失分开处理，lifecycle 的 `InvalidArgument` 仍按现有能力差异处理。

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

**仓库实现与运行时验收分界**：本切片先在仓库内交付策略、脚本、`storage-init` 权限分类修正和部署文档；2026-10-23 已统一部署测试机并执行身份创建、凭据探针、负向权限与 `storage:init --check`。逐项证据仍待 S7 收口，本地临时 MinIO 只用于实现自检。

**改动文件**

- `deploy/prod/minio/policies/libiaolink-app-rw.json`
- `deploy/prod/minio/policies/libiaolink-bootstrap.json`
- `deploy/prod/scripts/minio-identity.sh`（`lint` / `apply` / `check`，默认不输出 Secret）
- `server/scripts/storage-init.mjs`（只把 MinIO 无法授予的 CORS 动作列为能力告警，其它 `AccessDenied` 继续失败）
- `deploy/prod/README.md`（身份清单、凭据文件与首次部署顺序）

**执行步骤（测试机部署后）**

**S3 入口门禁**：修改任何 MinIO 身份前，先按 S0 冻结口径确认受控 `mc` 的版本、来源、SHA-256 与 `--help` 兼容性；没有受控 `mc` 时改用服务器本地 MinIO Console。该证据缺失时停止 S3，不得下载来源不明二进制。

1. 用受控 root 会话创建父用户 `libiaolink-app`、`libiaolink-bootstrap`，分别挂载上节策略；父用户口令随机生成并在完成后从临时文件清除。脚本遇到父用户带有额外策略或异常状态时必须 fail closed，不自动解除策略。
2. 分别创建 service account `libiaolink-api`、`libiaolink-storage-init`；只把 service account 的 access key / secret 写入服务器受控 Secret 文件。凭据通过一次性 `MC_CONFIG_DIR` 和标准输入写入 `mc`，不进入命令行参数。
3. 写入 `s3_access_key` / `s3_secret_key`（应用）和 `s3_bootstrap_access_key` / `s3_bootstrap_secret_key`（初始化）；文件权限 `600`，目录权限 `700`。此阶段不重启 api / worker。
4. 用应用凭据执行只读对象探针；等待 S4 完成 `storage.sh` 的 bootstrap 接线后，再用 bootstrap 执行 `storage:init --check`。
5. 运行负向测试：应用凭据不能创建用户 / 策略 / 桶、不能删除生产桶、不能访问临时 sentinel 桶；bootstrap 凭据不能读写对象、不能创建 / 删除 sentinel 桶。sentinel 桶由受控 root 会话创建、验证后清理；不得为测试给 bootstrap 增加 `CreateBucket` / `DeleteBucket` 或跨桶权限。
6. 记录 `mc --version`、来源、SHA-256、`--help`、策略文件名、策略动作与负向 HTTP / exit code；不记录 access key、secret、完整命令环境或 MinIO root 输出。

**执行期变更（2026-10-23）**：本地使用锁定镜像 `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` 和同镜像 `mc` 验证时，`mc admin policy create` 明确拒绝 `s3:GetBucketCORS` / `s3:PutBucketCORS`（`unsupported action`）。因此 bootstrap 策略删除这两个无法表达的 IAM 动作；CORS 继续由服务端 `MINIO_API_CORS_ALLOW_ORIGIN` 配置，bootstrap 不获得桶级 CORS 权限。`storage-init` 仅在 CORS 路径把 `AccessDenied` 记为能力告警，lifecycle、版本控制等其它路径仍 fail closed。该变更不改变身份模型、桶范围或管理边界；若未来 MinIO 支持这两个动作，须先补测试机证据再按变更控制追加，不能直接恢复旧策略。

**验收**

- `libiaolink-app-rw` 与 `libiaolink-bootstrap` 的策略内容与文件完全一致；没有 `s3:*`、`arn:aws:s3:::*` 或管理动作。
- `storage:init --check` 使用 bootstrap 成功；CORS 的 `AccessDenied` 可按已登记能力例外告警，lifecycle / 版本控制等其它路径的权限错误必须失败。2026-10-23 已在测试机执行；逐项证据待 S7 登记，不在本切片单独关闭 F-02。
- 应用 service account 不能管理用户 / 策略 / 桶，不能访问 sentinel 桶；bootstrap 不能读写对象、不能创建 / 删除 sentinel 桶。
- 部署后 api / worker 已切换到应用 service account；本切片仍不能单独宣称 F-02 关闭。

**回滚**：保留 root 管理和已创建的新身份，不做对象删除；只撤销新 service account 的临时验证权限。若策略过窄，按实际 403 复现证据追加最小动作，不直接扩大为通配权限。

**测试机部署验证登记（已执行，逐项证据待收口）**

| ID | 验证项 | 方法 / 预期 | 状态 | 证据位置 |
|---|---|---|---|---|
| S3-T1 | 受控 `mc` 工具链 | 记录 `mc --version`、来源、SHA-256、`--help` 兼容性；`mc-toolchain.txt` 存在且权限受限 | 已部署；逐项证据待收口 | `/srv/data/backups/f02-s3-evidence/mc-toolchain.txt` |
| S3-T2 | 策略与仓库完全一致 | `bash scripts/minio-identity.sh check`；两份远端策略内容逐字 / 语义等于仓库文件，无 `s3:*`、无全桶 ARN | 已部署；逐项证据待收口 | S3 `check` 输出与脱敏证据 |
| S3-T3 | 父用户与唯一策略 | `libiaolink-app` / `libiaolink-bootstrap` 存在、启用，且策略集合精确等于各自唯一策略 | 已部署；逐项证据待收口 | S3 `check` 输出 |
| S3-T4 | service account 与 Secret | `libiaolink-api` / `libiaolink-storage-init` 的 parent、状态、`impliedPolicy`、有效期正确；四个 Secret 文件 `600`、目录 `700` | 已部署；逐项证据待收口 | S3 `check` 输出与 `stat` 脱敏结果 |
| S3-T5 | 应用只读探针 | 应用 service account `mc ls libiaolink` 成功；不产生对象读写副作用 | 已部署；逐项证据待收口 | S3 `check` 输出 |
| S3-T6 | 应用负向权限 | 不能管理用户 / 策略 / 桶、不能删除生产桶、不能访问 sentinel 桶；命令非零或 HTTP 403 | 已部署；逐项证据待收口 | 负向命令 exit code / HTTP 状态 |
| S3-T7 | bootstrap 负向权限 | 不能读写对象、不能创建 / 删除 sentinel 桶；命令非零或 HTTP 403；sentinel 由 root 创建并在验证后清理 | 已部署；逐项证据待收口 | 负向命令 exit code / HTTP 状态 |
| S3-T8 | `storage:init --check` | S4 完成 `storage.sh` bootstrap 接线后，使用 bootstrap 返回 0；仅登记能力告警，其余 `AccessDenied` 失败 | 已部署；逐项证据待收口 | `storage:init --check` 输出与 exit code |
| S3-T9 | 运行时未切换事实 | S3 完成后 api / worker 未重启，仍使用旧 root 环境值；不得据此关闭 F-02 | 已部署；逐项证据待收口 | `docker compose ps` / 容器启动时间 / 脱敏环境核对 |

以上运行时项以测试机部署后的实际执行结果为准；逐项证据与未复验项待 S7 验收收口，不得以本地 MinIO 冒烟代替。验证命令和结果不得包含 access key、secret、完整环境变量、签名 URL 或真实对象键。

### S4 · Secrets 隔离与运行时凭据切换

**目标**：让长期运行的应用只看到自己的 Secret，并实际使用最小权限 service account。

**仓库实现与运行时验收分界**：本切片先在仓库内交付 Compose 单文件 Secret、entrypoint 读取边界、storage / 迁移脚本接线与部署文档；2026-10-23 已统一部署公司测试机并执行挂载清单、强制失败、可选值 unset、容器健康与 bootstrap / 应用凭据验证。认证后真实上传链路与逐项证据仍待 S7 收口。

**执行期实现说明（2026-10-23）**

- api 只挂 `pg_api_password`、`casdoor_client_id`、`casdoor_client_secret`、`s3_access_key`、`s3_secret_key`、`internal_sync_token`、`onlyoffice_jwt_secret`、`translate_api_key`；worker 只挂 `pg_api_password`、`casdoor_client_id`、`casdoor_client_secret`、`s3_access_key`、`s3_secret_key`、`internal_sync_token`、`onlyoffice_jwt_secret`、`wecom_app_secret`、`wecom_bot_secret`；tools 只挂 `pg_migrator_password`。Casdoor / internal token / OO JWT 之所以同时挂给 worker，是现有共享生产 env 校验要求，不代表 worker 新增业务用途。
- `translate_api_key` / `wecom_app_secret` / `wecom_bot_secret` 属业务可选项：Compose 需要宿主文件存在，未配置时使用 `600` 空占位；entrypoint 将空值明确 unset，并先清空同名环境变量，禁止从 `server.env` 回退。必需 Secret 缺失、为空、非普通文件或不可读时退出 70；发现旧 `/opt/libiaolink/secrets` 挂载或 `/run/secrets` 未授权文件时同样 fail closed。
- `storage.sh init` / `init --check` 只读 `s3_bootstrap_*`，`it` 只读 `s3_*`；凭据经 `umask 077` 的临时目录、权限 `600` 的单次 env-file 交给 `docker compose run --env-from-file`，退出时删除，不进入命令行参数。`DATABASE_URL` 只使用无密码占位值，storage 脚本不访问数据库。
- `db-migrate.sh` / `db-seed.sh` 改读 `/run/secrets/pg_migrator_password`；`db-init.sh` 同步改为从宿主 `secrets/` 读取、校验 `600` 并经 stdin 送入 psql，避免密码进入 psql argv。该补充属于同一 Secret 卫生目标，不改变角色、DDL 或部署拓扑。

**改动文件**

- `deploy/prod/docker-compose.yml`：api / worker 增加按文件的 Compose `secrets:`；tools 只挂 `pg_migrator_password`；移除三处整目录 `./secrets` 挂载。
- `deploy/prod/scripts/service-entrypoint.cjs`：读取根目录改为 `/run/secrets`；明确必需 / 可选 Secret；不再回退整目录。
- `deploy/prod/scripts/storage.sh`：`init` 使用 `s3_bootstrap_*`，`it` 使用 `s3_*`；缺少对应文件直接退出；凭据不得展开到命令行参数，使用受控文件或权限 `600` 的临时 env-file 并在退出时清理。
- `deploy/prod/scripts/db-migrate.sh`、`deploy/prod/scripts/db-seed.sh`：改为读取 `/run/secrets/pg_migrator_password`。
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
- `storage:init --check` 使用 bootstrap 返回 0；CORS 的已登记能力例外可按告警记录，lifecycle / 版本控制等其它路径的权限不足或 `AccessDenied` 返回非 0。
- 部署机进程命令行、shell history、临时文件和 CI 日志中均不出现 access key、secret 或 root 值。
- S4 完成时旧 root 应用凭据仍可能存在，因此 S4 不能单独关闭 F-02；S5 已完成真实轮换，最终关闭仍待 S7 验收。

**回滚**：如果应用启动失败，补挂缺失的单文件 Secret 或修正策略并重启；禁止恢复整目录挂载或把应用切回 root。临时应急只允许 root 在服务器本地做对象存储修复，不进入应用容器。

**测试机部署验证登记（已执行，逐项证据待收口）**

证据目录建议 `/srv/data/backups/f02-s4-evidence/`（目录 `700`、文件 `600`）；任何命令、日志与证据均不得记录 Secret 值、完整环境变量或签名 URL。

| ID | 验证项 | 方法 / 预期 | 状态 | 证据位置 |
|---|---|---|---|---|
| S4-T1 | Compose 挂载精确 | `docker compose --profile app config` 与 `docker inspect` 核对：api / worker / tools 的 Secret 清单与“执行期实现说明”完全一致；三处均无 `./secrets` 整目录挂载 | 已部署；逐项证据待收口 | S4 证据目录 `compose-mounts.txt` |
| S4-T2 | 应用容器无 root / 管理面 Secret 且非 root 运行 | api / worker 的 `/run/secrets` 不含 `minio_root_*`、`pg_superuser_password`、`pg_migrator_password`、`s3_bootstrap_*`；`/opt/libiaolink/secrets` 不存在；`/proc/1/status` 的有效 Uid / Gid 均为 1000 | 已部署；逐项证据待收口 | `runtime-boundary.txt` |
| S4-T3 | 必需 Secret fail closed | 使用隔离 node 镜像 / 空 `/run/secrets` 运行 `service-entrypoint.cjs`；缺失首个必需 Secret 时退出 70 且不 spawn 应用 | 已部署；逐项证据待收口 | `fail-closed.txt`（exit code 与消息类型） |
| S4-T4 | 可选 Secret 空值 unset | 未配置企微 / 翻译时，api 的 `WECOM_APP_SECRET` / `WECOM_BOT_SECRET` 与 worker 的 `TRANSLATE_API_KEY` 不存在；配置对应文件后仅目标容器出现变量；全程不打印值 | 已部署；逐项证据待收口 | `optional-secrets.txt` |
| S4-T5 | 容器健康与 HTTP 门禁 | `docker compose --profile app ps` 中 api / worker（及其依赖）healthy；`/healthz` 200、`/readyz` 200 且对象存储探针全绿 | 已部署；逐项证据待收口 | `health.txt` / 脱敏响应摘要 |
| S4-T6 | tools 迁移 / 种子读取路径 | `docker compose --profile tools config` 仅见 `pg_migrator_password`；`db-migrate.sh --dry-run`、`db-seed.sh --dry-run` 成功；重放无漂移 / 零变更口径不变 | 已部署；逐项证据待收口 | `tools-db.txt` |
| S4-T7 | bootstrap `storage:init --check` | `storage.sh init --check` 返回 0；只有已登记 CORS 能力告警，lifecycle / 版本控制 / 桶路径的 `AccessDenied` 均失败 | 已部署；逐项证据待收口 | `storage-init-check.txt` |
| S4-T8 | 应用 service account 存储回放 | `storage.sh it` 使用 `s3_*` 返回 24 / 24；不读取 bootstrap 凭据 | 已部署；逐项证据待收口 | `storage-it.txt` |
| S4-T9 | 真实上传全链路 | 登录态完成上传 → 分片 / 合并 → 列表 → 预览 → 下载 → 回收站彻底删除；API / worker 的 S3 请求持续使用应用 service account，无 root 值 | 已部署；逐项证据待收口 | 脱敏请求记录 / 对象清理证明 |
| S4-T10 | Secret 不泄漏且 F-02 未关闭 | `docker top` 进程参数、容器日志、`server.env`、shell history、临时目录与证据扫描 access key / secret 均为 0 命中；旧 root 尚未轮换，F-02 仍为开放 | 已部署；逐项证据待收口 | `leak-scan.txt` / `status.txt` |

以上运行时项以测试机部署后的实际执行结果为准；逐项证据与未复验项待 S7 验收收口，本地 Compose 渲染、`node --check` 与脚本静态检查只用于实现自检，不替代 S4-T1～T10。

### S5 · root 轮换与旧凭据失效

**目标**：消除当前 root 值已经与业务凭据同值的暴露，并确认旧 root、旧应用值与旧签名失效。

**仓库实现与运行时验收分界**：本切片先在仓库内交付轮换脚本、状态恢复路径、残留扫描和部署 Runbook；2026-10-23 已在公司测试机维护窗口完成真实轮换。认证后浏览器全链路、S5-T3 历史值 / 旧预签名、T7 敏感备份登记与故障注入项等逐项证据待 S7 收口；本地 fake 回放和临时 MinIO 结果只用于实现自检，不替代验收。

**执行期实现说明（2026-10-23）**

- 新增 `deploy/prod/scripts/minio-root-rotate.sh`：提供 `plan` / `check` / `rotate` / `recover` / `finalize`。所有模式都以 root 在部署机执行，`mc` 必须显式提供 `MC_BIN` 与受控 `MC_SOURCE`；凭据经标准输入和一次性 `MC_CONFIG_DIR` 使用，不进入命令行、日志或证据。
- `plan` 只读检查 Secret 权限、数据目录非空、minio healthy、应用 / bootstrap 凭据不与当前 root 相同、受控 `mc` 命令兼容性；不生成凭据、不写 Secret、不重启容器、不连接 MinIO 修改状态。
- `check` 只读复核当前 root 认证、S3 身份、`storage:init --check`、`storage:it` 与 443 `/healthz` / `/readyz` / `/libiaolink/`，写脱敏证据但不修改运行态。
- `rotate` 必须同时设置 `F02_S5_CONFIRM=ROTATE_MINIO_ROOT` 与 `F02_S5_BACKUP_CONFIRMED=YES`。执行顺序为：基线全链路检查 → 把旧 root 暂存到 `/run/libiaolink-f02-s5`（目录 `700`、文件 `600`，tmpfs）→ 生成新 root → 受控替换两份 Secret → 只重建 minio → 验证新 root 可用、旧 root 拒绝 → 复核 S3 身份、bootstrap、`storage:it` 与 HTTP → 扫描旧口令明文残留 → 无命中后删除状态目录并写脱敏证据。
- 两份 root Secret 先写入同目录 `600` 临时文件，并保留旧值的受控副本；第二次替换失败时恢复第一份，避免留下用户与口令错配。进程中断由状态目录和 `recover` / `finalize` 兜底；状态目录存在时拒绝再次 `rotate`。
- 自动回滚只覆盖“新 root 启动失败、新 root 认证失败、旧 root 仍被接受”三种可在切换阶段判定的故障：恢复旧 Secret、重建 minio、确认旧 root 可用，证据记为 `rolled-back`。若新 root 已可用但身份 / 存储 / HTTP 复核失败，或旧口令扫描命中 / 不确定，则**不回滚到旧 root**，保留 `/run` 状态并写 `failed` 证据，待人工核查后用 `recover` 或 `finalize` 收口。
- `recover` 必须设置 `F02_S5_CONFIRM=RESTORE_PREVIOUS_ROOT`，从状态目录恢复旧 root 并重建 minio；恢复后 F-02 仍开放，必须按事件处置并重新轮换。`finalize` 必须设置 `F02_S5_CONFIRM=FINALIZE_ROOT_ROTATION`，会重新验证当前 root、运行时全链路、旧 root 拒绝和旧口令扫描，确认当前 root 与待退休值不同后才删除状态目录；任何一项失败都保留状态。
- 证据默认写入 `/srv/data/backups/f02-s5-evidence`（目录 `700`、文件 `600`），记录阶段、`root_username_changed=yes/no/unknown`、新 / 旧 root 认证结果、回滚结果、身份 / storage / HTTP 结果、扫描结果与 `f02_status=open`，不记录 Secret 值。残留扫描覆盖部署目录、`/srv/data/backups`、历史、临时目录以及 minio / api / worker 日志；文本扫描为 0 命中才自动清状态，压缩包 / 二进制备份必须另行按敏感备份登记和处置，不能把“未扫描到”写成“未包含”。
- api / worker 不在本脚本中重启；轮换后它们应继续使用既有应用 service account。锁定 MinIO 镜像自检已确认：root 切换后同一数据卷、同一 service account 仍可列桶，旧 root 被拒。

**测试机部署验证登记（已执行，逐项证据待收口）**

| ID | 验证项 | 方法 / 预期 | 状态 | 证据位置 |
|---|---|---|---|---|
| S5-T1 | 维护窗口与可恢复备份 | 记录 MinIO 数据目录可恢复备份 / 快照路径和校验值；确认窗口、影响面和回滚联系人；备份说明不含 Secret | 已部署；逐项证据待收口 | 备份清单 / 变更单（脱敏） |
| S5-T2 | 轮换前基线 | `plan` / `check` 通过；minio healthy；应用与 bootstrap 凭据均不等同于当前 root；S3 / S4 对应运行项已通过 | 已部署；逐项证据待收口 | `plan.txt` / `check.txt` |
| S5-T3 | 新 root 生效、旧凭据失效 | `rotate` 后新 root 可认证；旧 root 被拒；若存在与旧 root 不同的历史应用值，同样做一次拒绝探针；轮换前生成的旧预签名 URL 到期前即不可用 | 已部署；逐项证据待收口 | 脱敏认证结果 / URL 状态码 |
| S5-T4 | 应用身份不受影响 | 应用 / bootstrap service account 的 parent、策略和状态不变；`storage:it` 24 / 24；api / worker 未因本脚本重启，业务请求继续使用应用 service account | 已部署；逐项证据待收口 | `identity.txt` / `storage-it.txt` / 容器重启计数 |
| S5-T5 | 轮换后全链路 | `/healthz` / `/readyz` 200，`/libiaolink/` 返回预期安全拒绝；登录态完成上传 → 分片 / 合并 → 列表 → 复制 → 预览 → 下载 → 回收站彻底删除 | 已部署；逐项证据待收口 | `runtime.txt` / 脱敏请求记录 |
| S5-T6 | Secret 与状态边界 | `/run/libiaolink-f02-s5` 仅轮换期间存在且为 `700/600`；成功 / 回滚后删除；两份 root Secret 始终成对且 `600`；没有临时 `mc` 配置、旧值备份或 `.f02-s5.*` 文件残留 | 已部署；逐项证据待收口 | `state-boundary.txt` |
| S5-T7 | 旧口令残留 | 对部署目录、`/srv/data/backups`、history、`/home`、`/tmp`、`/var/tmp`、minio / api / worker 日志做明文扫描为 0 命中；tar / 镜像 / 压缩备份标记敏感并限制访问；证据不含旧值 | 已部署；逐项证据待收口 | `retired-secret-scan.txt` / 敏感备份登记 |
| S5-T8 | 失败回滚边界 | 仅在启动 / 新 root 认证 / 旧 root 仍可用阶段受控验证自动恢复旧 root、状态删除和 `rolled-back` 证据；新 root 已生效后的检查失败不得自动恢复旧 root | 已部署；逐项证据待收口 | `rollback.txt` / 证据文件 |
| S5-T9 | 中断恢复与 finalize | 在一个可控失败场景保留状态，确认 `recover` 能恢复旧 root；在扫描命中场景清理后确认 `finalize` 只在当前 root、全链路、旧 root 拒绝和扫描均通过后删除状态 | 已部署；逐项证据待收口 | `recover.txt` / `finalize.txt` |
| S5-T10 | 端口不回开、F-02 未误关 | 轮换前后 `ss -lntp` 与 `DOCKER-USER` 复核一致：9000 无宿主监听，9001 / 9443 仅回环；开发机 / 办公网 / 公网探活仍不可达；证据写 `f02_status=open` | 已部署；逐项证据待收口 | `ports.txt` / `status.txt` |

以上运行时项以测试机部署后的实际执行结果为准；逐项证据与未复验项待 S7 验收收口，本地 `bash -n`、fake 回放、锁定 MinIO service account 存活实验和脚本自检只用于实现自检，不替代 S5-T1～T10。

**通过条件**

- 新 root 可启动 minio，应用 service account 不受 root 轮换影响，旧 root 与旧应用值均不能认证，旧预签名 / 旧上传会话不能恢复为可用。
- `storage:init --check`、`storage:it` 24 / 24、`readyz` 与真实上传全链路通过；api / worker 仍不含 root Secret，未回退为 root 应用凭据。
- 旧 Secret 的明文副本完成处置；压缩 / 二进制备份有明确的敏感标记和访问限制；证据、PR、日志和工单不含 Secret。
- 9000 / 9001 / 9443 暴露面保持 S1 / S2 收口结果，未为了轮换重开端口；F-02 只在 S6 / S7 证据齐全后关闭。

**回滚**：新 root 启动失败可短暂恢复旧 root 启动并立即进入事件处置；恢复后必须重新轮换。新 root 已生效且后续检查失败时，保留新 root 和状态目录，修复身份 / 存储 / 网络后执行 `finalize`，不得把 api / worker 改回 root，也不得回滚网络收口或 `DOCKER-USER` 规则。

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
# 本地无真实 secrets 时，在临时目录放置同名空文件后渲染；不得读取服务器 Secret
docker compose --profile app config --quiet
docker compose --profile tools config --quiet
bash -n scripts/storage.sh
bash -n scripts/minio-root-rotate.sh
bash -n scripts/db-migrate.sh
bash -n scripts/db-seed.sh
bash -n scripts/db-init.sh
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
2. S1 / S2 在仓库内完成端口收口、持久化防火墙件与文档，不先单独部署。
3. S3 在仓库内完成策略、身份脚本、CORS 权限分类与验证登记，不连接测试机、不创建真实身份。
4. S4 / S5 在仓库内完成 Secret 接线、运行时切换与 root 轮换步骤。
5. S1～S5 仓库实现完成并通过 PR 门禁后，统一部署公司测试机；先复核 S1 / S2 端口与外部网络，再执行 S3 身份创建、正向 / 负向探针。
6. S4 切换 api / worker 到应用 service account，切断整目录 Secret 挂载；随后执行 S3-T8 `storage:init --check`、上传全链路和 `storage:it`。
7. S5 在维护窗口按 `deploy/prod/README.md` §9.4 执行 `minio-root-rotate.sh plan` / `check` / `rotate`；确认新 root 可用、旧 root 失效、service account 不受影响并完成旧副本处置。
8. S6 同步文档、H1 兼容说明与全量回归。
9. S7 完成测试机 / 生产回放证据、非作者评审与开发日志，再关闭 F-02。

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
| CORS / lifecycle 在 MinIO 返回 AccessDenied / InvalidArgument | MinIO IAM 不提供桶级 CORS 动作，CORS 的 `AccessDenied` 作为唯一已登记例外告警；lifecycle / 版本控制等其它路径的 `AccessDenied` 必须失败。记录镜像与 `mc` 版本，不对 bootstrap 扩大权限 |
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
