# deploy/minio/ · 对象存储沙箱（S7·file 存储接入）

ADR-006（2026-09-21 阶段 0 修订）定案：接口层只依赖 S3 协议、实现可替换。本目录是**本地 / 联调沙箱**（pinned MinIO，**仅沙箱，不代表生产选型**），不是生产部署模板。

## 阶段 0 结论（2026-09-20 实测；ADR-006 修订已定案，Push 126）

ADR-006 要求「阶段 0 必须核实 MinIO 许可与版本并锁定」。核实结果：

| 项 | 结论 |
|---|---|
| 许可 | **AGPL-3.0** —— 容器内 `minio --version` 自述与 `/licenses/LICENSE` 一致，GitHub 仓库 license 字段同为 `AGPL-3.0` |
| 版本 | 锁定 `RELEASE.2025-09-07T16-13-09Z`（commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`，go1.24.6 linux/amd64） |
| 镜像 | 来自 `quay.io/minio/minio`；**Docker Hub 的 `minio/minio` 已不存在**（`docker pull` 返回 pull access denied） |
| 官方下载 | `https://dl.min.io/server/minio/release/**`（含 windows / linux 二进制与目录页）**全部 410 Gone** |
| 上游仓库 | `github.com/minio/minio` 已 **archived**（最后推送 2026-04-24） |

**含义**：ADR-006 写的切换触发条件「MinIO 许可或功能不满足」**已触发且更强** —— **上游归档、官方分发渠道下线**，社区版不再有安全更新。wmj 已据此定案（[PR #96](https://github.com/256-code/LibiaoLink/pull/96) / Push 126，评审 lan / px）：接口层不变，一期实现改为**可替换绑定** —— 沙箱继续用本目录 pinned 的版本，生产按候选顺序在 **M8 生产部署形态验证前**关闭（责任 px 运维 + lan 平台；关闭验收 = `storage:init -- --check` + `storage:it` 在目标实现上全绿）。**关闭验收已达成（2026-10-14）**：生产形态（本机 MinIO 单节点、本地构建镜像）上 `storage:init --check` 通过、`storage:it` 24/24 全绿、`readyz` 全绿（px 记录；待 lan 复核）。生产接入形态（2026-10-14）：S3 走 TLS https **同源**门面 `https://test-pm.libiaorobot.com`（443 `location /libiaolink/` = 桶名 → `minio:9000`；`proxy_pass` 不重写 / Host 原样透传保 SigV4；客户端网络仅放行 22/80/443，9443 / 9000 实测被拦）；`storage:it` 24/24 于同源门面复跑通过，开发机真实网络预签名 PUT / GET / DELETE 全绿；9443 保留为内网备用门面。

候选顺序（接口层只依赖 S3 协议，**换实现不动调用代码**，见 `server/src/storage/README.md`）：

1. 复用公司内网既有对象存储 / 既有 MinIO 集群（运维能力现成，风险最低）；
2. SeaweedFS（Apache-2.0，活跃维护）等自建 S3 兼容实现；
3. 公司云 OSS（受「不允许上传第三方云」约束，需先有云策略结论）。

**运维待办（px 线，不依赖选型定案）**：把锁定的镜像**固化**到内网 registry 或做成 `docker save` 离线包 —— `docker-compose.yml` 的 digest 锁定只在 quay.io 还留着该 manifest 时有效，quay 也可能随时下架 —— **2026-10-13 实测已下架（匿名拉取 401 / token 内 $disabled）**：生产应急 = GitHub Release 官方资产（`minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z`，SHA-256 `7c5bd851…b855f` 已校验）在服务器本地 `docker build` 出 `libiaolink/minio:RELEASE.2025-09-07T16-13-09Z`（构建件 `deploy/prod/minio/Dockerfile`；步骤见 `deploy/prod/README.md` §9），不再依赖 quay；`docker save` 离线归档仍随附。**两条能力缺口登记为「任何替代实现都必须满足的行为面」**：CORS 不能只依赖存储 API（沙箱走 `MINIO_API_CORS_ALLOW_ORIGIN` 服务端配置）；清理不依赖 lifecycle 规则（未完成分片靠存储侧内置 `stale_uploads_expiry` 兜底，草稿 30 天走应用侧 `files.purge_after` → worker）。

## 启动（本地沙箱）

```bash
cp .env.example .env      # 改成本地口令（不要用示例值）
docker compose up -d
docker compose ps         # 等 healthcheck 变 healthy
```

控制台：<http://127.0.0.1:9001>（用 `.env` 里的口令登录）；S3 API：`http://127.0.0.1:9000`。

## 与应用对接

`server/.env` 填同一组值（示例见 `server/.env.example`）：

```dotenv
S3_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=<MINIO_ROOT_USER>
S3_SECRET_KEY=<MINIO_ROOT_PASSWORD>
S3_BUCKET=libiaolink
S3_FORCE_PATH_STYLE=auto   # 非 AWS 端点自动走 path-style
```

然后（`server/` 目录下）：

```bash
npm run build
npm run storage:init    # 建桶 + 版本控制 + CORS + 未完成分片清理；-- --check 只读校验
npm run storage:it      # 真机回放（24 项断言）：暂存键建会话 → 分片直传 → ListParts → 合并 → 复制到契约键 → 签名下载 → 哈希比对 → 版本回收
```

`storage:init` 需要 `S3_CORS_ORIGINS`（默认 `http://localhost:5173`）与 `S3_ABORT_INCOMPLETE_DAYS`（默认 30）两个可选变量，前者要覆盖前端实际来源。

## 与生产部署的差距（不在本沙箱内）

- 独立数据盘、每日增量异地同步、定期抽检恢复 —— ADR-006 要求，属运维线（px）与生产环境落地；
- **预签名 URL 的 host 必须对客户端可达**：沙箱用 `127.0.0.1`，生产要按内网 / 外网两种形态用真实网络验证后回写——**生产已回写（2026-10-14）**：`test-pm.libiaorobot.com`（443 同源门面 `/libiaolink/`；真实网络 + 浏览器形态，`storage:it` host 断言 24/24 通过；9443 备用形式 `test-pm.libiaorobot.com:9443` 仅内网直连可用）；
- 桶策略只允许签名访问（`storage:init` 会做一次匿名 GET 断言）；
- 本次**未**配置整桶对象过期：草稿 30 天清理按 `files.purge_after` 由 worker 驱动（M4-02），存储侧只兜底未完成分片，避免误删定档文件。
