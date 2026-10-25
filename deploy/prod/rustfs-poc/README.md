# RustFS 1.0.3 隔离 POC

> 状态（2026-10-26）：仓库件与本地隔离 POC 已完成；**测试机尚未部署**。本目录不对应用提供服务，不改变现有 MinIO，也不代表 RustFS 已成为生产选型。

## 1. 目的与边界

本 POC 只回答以下问题：

- RustFS 1.0.3 能否在当前 Docker Compose 单机形态下稳定启动、持久化并正确处理版本控制 / CORS / 分片清理；
- 现有 `storage:init` / `storage:it` 与预签名直传链路能否在 RustFS 上原样跑通；
- 应用账号与 bootstrap 账号能否按最小权限隔离。

明确不做：

- 不接 `api` / `worker`，不改 `server.env`，不复用 MinIO 的 `s3_*` 凭据；
- 不替换、不重建、不写入现有 `minio` 容器与 `/srv/data/minio`；
- 不改 443 应用门面，不迁移现有桶 / 对象 / 版本；
- 不宣称高可用、容量、性能或长期维护承诺。

## 2. 组件与隔离

| 项目 | POC 口径 |
|---|---|
| 服务端 | `rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b` |
| 管理客户端 | `rustfs/rc@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699`（0.1.36；该版本没有独立 tag） |
| 容器 | `libiaolink-rustfs-poc`、`libiaolink-rustfs-poc-web` |
| 网络 | API 仅加入 `libiaolink-prod`，不发布宿主 9000；控制台关闭 |
| 回环门面 | `127.0.0.1:9445` → 专用 Nginx → `rustfs-poc:9000` |
| 数据 / 日志 | 默认 `/srv/data/rustfs-poc` / `/srv/data/rustfs-poc-logs`，独立 bind mount |
| 桶 | `rustfs-poc` |
| 健康检查 | `/health/ready`（不要依赖 MinIO 的 `/minio/health/live`） |

Compose 覆盖文件：`deploy/prod/docker-compose.rustfs-poc.yml`；POC 专用门面：`deploy/prod/rustfs-poc/nginx.conf`。

## 3. 前置条件

- 在 `deploy/prod` 下执行；需要 root，以便把数据 / 日志目录设置为 `10001:10001`、`700`。
- 宿主需要 `docker compose`、`openssl`、`install`、`stat`。
- `secrets/` 必须为 `700`；所有 `rustfs_poc_*` 文件必须为 `600`、非符号链接、无换行；POC root / service Secret 属主必须为 `10001:10001`，供 RustFS 与 `rc` 的非 root 进程读取。
- 首次运行由脚本生成 POC 独立 Secret，不读取 MinIO / 应用 Secret：

```text
secrets/rustfs_poc_root_access_key
secrets/rustfs_poc_root_secret_key
secrets/rustfs_poc_app_access_key
secrets/rustfs_poc_app_secret_key
secrets/rustfs_poc_bootstrap_access_key
secrets/rustfs_poc_bootstrap_secret_key
```

`rc` 临时容器只逐文件挂载上述 6 个 Secret 与 POC 策略目录，不挂载整个 `secrets/`，不会读取 MinIO / 应用凭据。

## 4. 操作

### 4.1 启动与初始化

```bash
cd /opt/libiaolink/deploy/prod

bash scripts/rustfs-poc.sh prepare
bash scripts/rustfs-poc.sh up
bash scripts/rustfs-poc.sh apply
bash scripts/rustfs-poc.sh check
bash scripts/rustfs-poc.sh it
```

- `prepare`：创建数据 / 日志目录并校正为 `10001:10001` / `700`。
- `up`：生成缺失的 root Secret，只启动 `rustfs-poc` 与 `rustfs-poc-web`。
- `apply`：通过 `rc` 创建 / 更新 `libiaolink-poc-app`、`libiaolink-poc-bootstrap` 两个 service account，然后执行 `storage:init`。
- `check`：执行 `storage:init --check`，并验证应用账号不能建桶、bootstrap 账号不能读对象。
- `it`：用应用 service account 执行真实 `storage:it`。

重复执行 `apply` 是幂等的；已有 POC Secret 不会被覆盖。

### 4.2 同源门面验收

测试机不对外发布 9445。开发机建立 SSH 隧道：

```bash
ssh -N -L 9445:127.0.0.1:9445 root@10.1.104.44
```

另一终端：

```bash
curl -fsS -D- http://127.0.0.1:9445/health/ready
curl -sS -D- -o /dev/null -H 'Origin: http://127.0.0.1:9445' http://127.0.0.1:9445/rustfs-poc/
curl -sS -D- -o /dev/null -H 'Origin: https://invalid.example' http://127.0.0.1:9445/rustfs-poc/
```

预期：健康检查 200；两次匿名对象请求均为 403；允许的 Origin 响应带 `access-control-allow-origin: http://127.0.0.1:9445`，非法 Origin 不带该响应头。`storage:it` 在容器网络内仍走 `http://rustfs-poc-web`；9445 只用于浏览器同源口径与 SSH 隧道验收。

### 4.3 停止与清理

```bash
# 停止 POC，保留数据和 Secret
bash scripts/rustfs-poc.sh down

# 彻底清理 POC（不可恢复）
RUSTFS_POC_CONFIRM=PURGE_RUSTFS_POC bash scripts/rustfs-poc.sh purge
```

`purge` 只接受以 `/rustfs-poc`、`/rustfs-poc-logs` 结尾的数据 / 日志目录，并只删除 `secrets/rustfs_poc_*`。不得用该命令清理 MinIO 或应用 Secret。

## 5. 本地 POC 证据（2026-10-26）

- 固定镜像健康检查 `/health`、`/health/ready` 均 200。
- `storage:init`：建桶、版本控制、CORS、30 天未完成分片清理、匿名访问拒绝全部通过。
- `storage:it`：24 / 24；应用最小权限 service account 24 / 24；经 Nginx 同源代理 24 / 24。
- 容器重启后数据、service account 与第二轮 `storage:it` 均保持 24 / 24。
- CORS：允许的 Origin 收到 `access-control-allow-origin`，非法 Origin 不带该头；匿名对象 GET 均为 403。
- 权限负向：应用账号不能创建 / 删除桶；bootstrap 账号不能读写对象（403）。
- `_FILE` Secret 可直接读取，不需要 MinIO 的入口转换脚本。
- 临时容器、数据卷、策略文件与测试凭据已清理。

这些是本地隔离环境证据，不等于测试机实际 bind mount、重启、隧道与现有生产容器共存验收。

## 6. RustFS 兼容性注意事项

### 6.1 IAM 动作名

RustFS 1.0.3 的策略动作名与 MinIO / AWS 常见写法不同：

| 能力 | RustFS 1.0.3 | 不能直接复用 |
|---|---|---|
| 读取桶 CORS | `s3:GetBucketCors` | `s3:GetBucketCORS` |
| 写入桶 CORS | `s3:PutBucketCors` | `s3:PutBucketCORS` |
| 读取生命周期 | `s3:GetBucketLifecycle` | `s3:GetLifecycleConfiguration` |
| 写入生命周期 | `s3:PutBucketLifecycle` | `s3:PutLifecycleConfiguration` |

本目录两份策略已按 RustFS 实测动作名编写；迁移到正式环境前仍需再次做策略能力回放。

### 6.2 客户端与管理面

- 健康检查使用 `/health/ready`。
- 管理客户端 `rc` 的 service account 命令是 `admin service-account`；本 POC 以镜像 digest 锁定，不依赖浮动 tag。
- 控制台默认关闭；POC 不提供图形管理面。
- 单机 bind mount 是本轮测试机重点：必须确认宿主机目录真实归属 `10001:10001`，容器内可写，重启后数据仍在。
- 单机 POC 未验证多节点、复制、故障切换、Quota、备份恢复 SLA、性能或升级路径。

## 7. 测试机部署门禁

1. PR 通过 `wmj` / `lan` 中至少一名合格评审者批准并合入 `main`。
2. 在测试机确认 `libiaolink-minio`、`api`、`worker`、443 门面健康基线。
3. 只执行 `prepare → up → apply → check → it`；不得顺手 `up` 其他 profile。
4. 记录容器健康、`docker inspect`、数据目录权限、Secret 权限、`storage:init --check`、`storage:it`、权限负向、重启持久化与 SSH 隧道证据。
5. 确认现有 MinIO 桶键数 / 应用上传下载 / `/readyz` 未变化。
6. 任一失败：执行 `down` 停止 POC，保留日志与检查证据；不得删除 MinIO 数据，不得改应用 `server.env` 来“修复” POC。
