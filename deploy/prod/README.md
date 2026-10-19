# deploy/prod/ · LibiaoLink 生产部署件（单机 · Docker Compose）

> 归属：px（部署 / 交付）· 2026-10-13 起步（postgres → tools → api / worker，逐切片加组件）。
> 口径：`docs/adr/ADR-013-部署与容量起点.md`（Compose 单机 + Nginx 唯一对外端口；生产门禁）、`docs/adr/ADR-004-数据库与数据访问.md`（PostgreSQL 18.x，部署锁精确补丁）、`docs/M8-部署Runbook与上线检查单(单机).md`（总流程与清单）。
> 密钥纪律（CONTRIBUTING §12）：本目录只放非敏感内容；密钥全部以文件存在服务器 `secrets/`，不进仓库、不进 `.env`。

## 0. 现状与规划

| 组件 | 状态 | 说明 |
|---|---|---|
| postgres | ✅ 已交付 | `postgres:18` tag + digest 双锁（18.6）；数据卷 `libiaolink-prod-pgdata`（系统盘 SSD） |
| db-init（角色 + 密码） | ✅ 已交付 | `scripts/db-init.sh`（幂等；密码自 `secrets/` 注入） |
| tools（迁移 / 种子 / 依赖安装） | ✅ 已交付 | node 工具容器（`profiles: tools`，一次性）：`scripts/db-migrate.sh` / `scripts/db-seed.sh` |
| api / worker | ✅ 部署件已交付（本切片） | `profiles: app`；node 24 双锁；entrypoint 降权（容器进程非 root）；依赖装进命名卷；外部依赖（SSO / 对象存储）以占位值先行，见 §2 / §7 |
| web（Nginx） | ✅ TLS 已接入（v1.8）· 对象存储同源门面（v1.13） | 80 → 301 / 443 应用（含 `/libiaolink/` 对象存储同源门面）/ 9443 MinIO 备用门面（ALLinSSL 自动下发证书）；SPA 静态 + `/api/v1` 反代（SPA 已上线 2026-10-14） |
| minio（对象存储） | ✅ 服务器实测收口（本切片） | 本机自建；镜像 = 本地构建（锚点 sha256:165271c0…）；数据盘 bind `/srv/data/minio`；init + --check + it 24/24、readyz 全绿；S3 走 https 同源门面（443 `/libiaolink/`；9443 为内网备用）；见 §9 |
| onlyoffice（文档服务器） | ✅ 生产上线（本切片 · v1.14） | 独立 compose 项目 `libiaolink-onlyoffice`（不发布公网端口；8001 回环排障）；443 子路径 `/onlyoffice/` 门面（DS 9.4 原生子路径支持）；镜像离线下发并归档 `/srv/data/images/oo_docs_9.4.0.1.tar`；JWT 与 api 同值；真实 64MB xlsx 端到端渲染 ready；见 `deploy/onlyoffice/README.md` §6 |
| 备份（PG 每 12h 加密） | 待办 | 落 `/srv/data/backups/pg` + 异地 |

## 1. 服务器目录约定

```text
/opt/libiaolink/
├── database/            # 从仓库同步（roles / migrations / scripts / seeds / package*.json；不含 node_modules）
├── server/              # api / worker 产物（dist / scripts / package*.json；不含 node_modules 与 src）
├── shared/              # @libiaolink/contracts（dist / generated / package*.json）
└── deploy/prod/         # 本目录（docker-compose.yml / scripts / server.env / secrets/）
    └── secrets/         # 只存在于服务器（本机生成、chmod 600、不进仓库）
```

### 1.1 服务器登录（开发机 → 测试机）

- 测试机：`10.1.104.44`（主机名 `libiao-vm`，Ubuntu 26.04 LTS；对外域名 `test-pm.libiaorobot.com`）；`10.1.103.44` = ALLinSSL 证书下发接收端（同口令），仅证书用途、不作为部署目标。
- 登录方式：开发机 PowerShell 直接 `ssh root@10.1.104.44`（首次连接接受指纹即可）。
- **登录口令不落仓库**（CONTRIBUTING §12）：由 px 持有；开发机上的未跟踪备忘 = `deploy/prod/服务器登录.local.md`（`.gitignore` 已忽略，AI / 新会话可直接读该文件续接）。
- 登录后入口：`cd /opt/libiaolink/deploy/prod`（`docker compose --profile app ps` 应见 postgres / api / worker / web / minio 五容器）。
- 铁律：**不得修改 root 密码**；普通用户 `libiao` 未经许可不动；服务器只跑不改 —— 代码 / 配置变更一律走本仓 → 常驻分支 → PR → 部署件同步（§3 ~ §9），禁止在服务器上手改业务代码，临时热修必须回灌仓库。
- MinIO 控制台（运维排查）：`ssh -L 9001:127.0.0.1:9001 root@10.1.104.44` 后浏览器开 `http://127.0.0.1:9001`（同 §9）。
- 证书：ALLinSSL 自动下发 `*.libiaorobot.com` → 宿主 `/etc/ssl/libiaorobot.com.pem|.key`（SSH 通道自动覆盖 + reload）；未使用 1Panel。

## 2. 密钥清单（`secrets/`）

| 文件 | 用途 | 消费方 | 现状 |
|---|---|---|---|
| `pg_superuser_password` | `postgres` 超级用户 | compose secret（`POSTGRES_PASSWORD_FILE`） | ✅ 已生成 |
| `pg_migrator_password` | 迁移 / 种子 | db-init + tools | ✅ 已生成 |
| `pg_api_password` | 应用角色（api / worker） | entrypoint → `DATABASE_URL` | ✅ 已生成 |
| `pg_readonly_password` | 只读（排查 / 报表） | psql 排查 | ✅ 已生成 |
| `internal_sync_token` | 内部作业凭证（`X-Internal-Token`） | entrypoint → `INTERNAL_SYNC_TOKEN` | 随本切片生成 |
| `onlyoffice_jwt_secret` | 查看器 JWT（与 DocServer 同值） | entrypoint → `ONLYOFFICE_JWT_SECRET` | ✅ 已生成（2026-10-14 DocServer 上线同批复核） |
| `translate_api_key` | 翻译 API Key（New API 网关） | entrypoint → `TRANSLATE_API_KEY` | 待回填（Key 由业务侧提供后落文件，600） |
| `casdoor_client_id` / `casdoor_client_secret` | SSO 应用（Casdoor） | entrypoint → `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` | ✅ 已回填（2026-10-14，测试环境 authtest 应用 clientId `41e162…`；正式环境应用创建后替换） |
| `s3_access_key` / `s3_secret_key` | 对象存储（MinIO 应用侧） | entrypoint → `S3_ACCESS_KEY` / `S3_SECRET_KEY` | ✅ 已生成（当前与根口令同值；专用最小权限账号列待办） |
| `wecom_app_secret` / `wecom_bot_secret` | 企微通道 | entrypoint → `WECOM_APP_SECRET` / `WECOM_BOT_SECRET` | 待业务侧开通后补 |

生成（服务器上，root）：`openssl rand -hex 24 > <文件名>`（JWT 用 -hex 32），随后 `chmod 600 *password` 覆盖全部密钥文件。

## 3. 同步与首次部署（postgres）

开发机（Windows PowerShell）→ 服务器：

```powershell
ssh root@10.1.104.44 "mkdir -p /opt/libiaolink/deploy /opt/libiaolink/database"
scp -r D:\LibiaoLink\deploy\prod root@10.1.104.44:/opt/libiaolink/deploy/
scp -r D:\LibiaoLink\database\roles D:\LibiaoLink\database\migrations D:\LibiaoLink\database\scripts D:\LibiaoLink\database\seeds D:\LibiaoLink\database\package.json D:\LibiaoLink\database\package-lock.json D:\LibiaoLink\database\README.md root@10.1.104.44:/opt/libiaolink/database/
```

> 注意：`database/node_modules` 不同步（服务器上由 tools 容器自行 `npm ci`）；`deploy/prod/secrets/`、`deploy/prod/server.env` 不在仓库、不参与同步。

服务器上（root）：

```bash
cd /opt/libiaolink/deploy/prod
mkdir -p secrets
cd secrets
for n in superuser migrator api readonly; do openssl rand -hex 24 > "pg_${n}_password"; done
openssl rand -hex 32 > internal_sync_token
openssl rand -hex 32 > onlyoffice_jwt_secret
chmod 600 *
cd ..
cp .env.example .env
docker compose up -d
docker compose ps
```

## 4. 角色基线与密码注入（幂等）

```bash
bash scripts/db-init.sh
```

## 5. 验证（postgres）

```bash
docker compose exec -T postgres psql -U postgres -d libiaolink -c "select version();"
docker compose exec -T postgres psql -U postgres -d libiaolink -c "\du"
```

期望：版本 = 18.6；`\du` 出现 `libiaolink_migrator` / `libiaolink_api` / `libiaolink_readonly`。

## 6. 迁移与种子（tools 容器）

首次拉取 node 工具镜像（约 55MB，建议单独拉、可看进度）：

```bash
docker compose --profile tools pull tools
```

迁移（以 `libiaolink_migrator` 身份；服务器水位 2026-10-16 = `0054`（v1.52 · Push 347），仓库迁移件已到 `0055`）：

```bash
bash scripts/db-migrate.sh
```

- 复跑幂等：再跑一次应输出「已执行 N 个迁移，无漂移」（N = 已执行件数）；
- **待执行件 `0055`（2026-10-16 · M5-03-5 绑定码链路）**：绑定码表 + 单聊激活表机器人维度；其中含一次定向清理（`delete from wecom_aibot_dm_activations where bot_id is null` = 旧机器人遗留激活行），**不可回滚 → 执行前先备份 PG**（M8 §5）；执行后复跑应输出「已执行 54 个迁移，无漂移」。
- `bash scripts/db-migrate.sh --dry-run` 只列出待执行，不改库；
- 首次运行会在命名卷 `libiaolink-prod-tools-node-modules` 里 `npm ci`（不污染宿主机 `database/`）；慢网可换源：`NPM_REGISTRY=https://registry.npmmirror.com bash scripts/db-migrate.sh`。

种子（幂等；默认集 = roles / role-permissions / dicts / blueprint / task-nodes / task-templates）：

```bash
bash scripts/db-seed.sh
```

- 复跑应零变更；`--dry-run` 打印摘要后全部回滚；`--only=<name>` 单跑。

## 7. api / worker（应用栈 · profiles: app）

**首次准备（开发机 → 服务器）：**

```powershell
ssh root@10.1.104.44 "mkdir -p /opt/libiaolink/server /opt/libiaolink/shared"
scp -r D:\LibiaoLink\server\dist D:\LibiaoLink\server\scripts D:\LibiaoLink\server\package.json D:\LibiaoLink\server\package-lock.json root@10.1.104.44:/opt/libiaolink/server/
scp -r D:\LibiaoLink\shared\dist D:\LibiaoLink\shared\generated D:\LibiaoLink\shared\package.json D:\LibiaoLink\shared\package-lock.json root@10.1.104.44:/opt/libiaolink/shared/

> scp 传输可能留下畸形目录权限（曾出现 `drwx---rwx`；症状：容器报 `Cannot find module '/opt/libiaolink/server/dist/entry/api.js'`）；修复：`chmod -R a+rX /opt/libiaolink/server /opt/libiaolink/shared`。
```

**安装依赖**（tools 容器；装进命名卷，不落宿主机目录）：

```bash
cd /opt/libiaolink/deploy/prod
docker compose --profile tools run --rm tools -c 'cd /opt/libiaolink/shared && npm ci --include=dev --no-audit --no-fund && cd /opt/libiaolink/server && npm ci --omit=dev --no-audit --no-fund'

> `shared` 需含 dev（`--include=dev`）：其 dist 运行时引用 `@asteasolutions/zod-to-openapi`，而它现声明为 devDependency（打包缺陷，待 wmj 线移入 `dependencies` 并重生成双 lock 后可收回 `--omit=dev`；见 M8 §7 待办 #8）。
```

**环境与占位密钥**（替换外部依赖到位后的真值）：

```bash
cp server.env.example server.env          # 按注释回填 SSO / 对象存储 / ONLYOFFICE / 企微 真实值
cd secrets
for n in casdoor_client_id casdoor_client_secret s3_access_key s3_secret_key; do echo "placeholder-until-configured" > "$n"; done
chmod 600 *
```

> 占位值仅供「先起服务、后回填」的过度期使用；真值到位后覆盖文件并 `docker compose --profile app restart api worker`。

> **智能机器人（群 + 单聊 · M5-03-5）**：`server.env` 需回填 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（成对；Secret 不进仓库）。换机器人 = 改此二值即视为新机器人 —— 新 `bot_id` 下无绑定行，单聊不发帧 + `dead` + 站内信降级（D4 话术），已绑定用户需重新绑定一次；回填后 `docker compose --profile app restart api worker`（长连接由 worker 建立）。

**启动与验证：**

```bash
docker compose --profile app up -d api worker
docker compose ps                                   # api / worker 均 (healthy)
docker compose --profile app exec -T api wget -qO- http://127.0.0.1:3000/healthz
docker compose --profile app exec -T api node -e "fetch('http://127.0.0.1:3000/readyz').then(async r => { console.log(r.status); console.log(await r.text()) })"
```

期望：`/healthz` 返回 200 `{"status":"ok"}`；`/readyz` 在对象存储就绪前为 **HTTP 503** + `status:degraded`（`object-storage:head-bucket` 探针失败，属预期，待对象存储选型关闭后转 ok）。busybox `wget` 遇 5xx 不打印 body，故上面用 `node -e fetch` 看正文。

**升级（改代码后）：**

```bash
# 重传 server/dist（或 scripts）后：
docker compose --profile app restart api worker
```

## 8. web（Nginx 反代 · profiles: app）

**首次准备（开发机 → 服务器）：**

```powershell
ssh root@10.1.104.44 "mkdir -p /opt/libiaolink/deploy/prod/nginx /opt/libiaolink/frontend/dist"
scp D:\LibiaoLink\deploy\prod\nginx\libiaolink.conf root@10.1.104.44:/opt/libiaolink/deploy/prod/nginx/
scp D:\LibiaoLink\deploy\prod\docker-compose.yml root@10.1.104.44:/opt/libiaolink/deploy/prod/
```

> SPA 产物（2026-10-14 已上线）：`frontend` build 后把 `frontend\dist` 内容传到 `/opt/libiaolink/frontend/dist/`；注意 **scp 传目录会产生 `drwx---rwx`(707) 权限畸形 → 传完必须 `chmod -R u=rwX,go=rX /opt/libiaolink/frontend/dist`**（两次踩坑）；目录挂载即传即生效、无需重启容器。

**拉取镜像并回填 digest（生产门禁：tag + digest 双锁）：**

```bash
docker pull nginx:stable-alpine
docker run --rm nginx:stable-alpine nginx -v                                    # 记下版本号（如 nginx/1.xx.y）
docker image inspect nginx:stable-alpine --format "{{index .RepoDigests 0}}"    # 记下 digest
```

> 把版本与 digest 回填到 `deploy/prod/docker-compose.yml` 的 `NGINX_IMAGE`（形如 `nginx:1.xx.y-alpine@sha256:…`）；回填前 compose 默认值 `nginx:stable-alpine` 可先跑通；**2026-10-13 已回填：`nginx:1.30.5-alpine@sha256:0985e772…`**。

**启动与验证：**

```bash
docker compose --profile app run --rm --no-deps web nginx -t        # 配置语法自检（compose 网络内可解析 api）
docker compose --profile app up -d web
docker compose --profile app ps                                     # web (healthy)
curl -s http://127.0.0.1/nginx-health; echo                          # ok（80 探活）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/           # 301 → https://test-pm.libiaorobot.com/
curl -sk https://test-pm.libiaorobot.com/nginx-health; echo          # ok（443 探活）
curl -sk https://test-pm.libiaorobot.com/healthz; echo               # {"status":"ok"}（经反代到 api）
curl -sk -o /dev/null -w "%{http_code}\n" https://test-pm.libiaorobot.com/readyz   # 200（对象存储就绪）
curl -sk -o /dev/null -w "%{http_code}\n" https://test-pm.libiaorobot.com/         # 200（index.html，SPA 已上线）
```

- 服务器实测（2026-10-13 HTTP 先行）：`/nginx-health` ok、`/healthz` 200、`/readyz` 503（存储占位）、`/` 404（SPA 未传输）、web (healthy)；
- 服务器实测（2026-10-14 TLS 接入）：证书链校验通过（无 `-k` 请求 200；SAN 匹配）、80 → 301（IP 访问一并收口）、443 `/nginx-health` ok / `/healthz` 200 / `/readyz` 200、9443 门面 `storage:it` 24/24；
- 服务器实测（2026-10-14 对象存储改同源 443 门面 · v1.13）：开发机（真实客户端网络）实测 9443 / 9000 被安全策略拦截（仅 22/80/443 放行）→ 443 增 `location /libiaolink/`（= 桶名；`proxy_pass` 无 URI 不重写、`Host $http_host` 保 SigV4）同源门面、`S3_ENDPOINT` 去端口；`storage:it` 24/24（host 断言 test-pm.libiaorobot.com）；开发机预签名 PUT 200 / GET 200 字节一致 / DELETE 204 / 删后 GET 404；`/libiaolink/` 匿名 403（AccessDenied，符合 ADR-006 短时签名口径）；
- 服务器实测（2026-10-14 SPA 上线）：站点根 200（index.html）、JS / CSS / SVG 200、wasm 200（`application/wasm`）、SPA 路由兜底 200；
- 服务器实测（2026-10-14 SPA 更新 · Push 304「已有项目地区」修复）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` —— 站点根 200（新构建 `assets/index-Qkd_qv0F.js`）、新 JS 200（1,106,488 B）、`/healthz` 200、`/readyz` 200；旧哈希资源已清理；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 SPA 更新 · Push 312「Blocked aria-hidden」告警修复）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 4 个 —— 站点根 200（index.html 引用 `assets/index-9-LTzT0u.js`）、新 JS 200（1,107,122 B · sha256 与本地构建一致 `83e4f5b6…`）、CSS 200、`/healthz` 200、`/readyz` 200；旧资源路径回落 SPA 兜底（text/html）；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 SPA 更新 · Push 313「默认外观改档 + 甘特『全部』不出任务列表」）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-9-LTzT0u.js` / `CadViewer-roDP69Tk.js`）—— 站点根 200（index.html 引用 `assets/index-DckvL4un.js`）、新 JS 200（1,107,126 B · sha256 与本地构建一致 `3add9c49…`）、CSS 200、`/healthz` 200、`/readyz` 200；旧资源路径回落 SPA 兜底（text/html）；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 SPA 更新 · Push 315「变更前 / 变更后可填图」）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-DckvL4un.js` / `CadViewer-l0DG45xP.js`）—— 站点根 200（index.html 引用 `assets/index-BmpRAV9e.js`）、新 JS 200（1,109,516 B · sha256 与本地构建一致 `636c110b…`）、CSS 200、`/healthz` 200、`/readyz` 200；旧资源路径回落 SPA 兜底（text/html）；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 老表导入部署 · Push 316「导入项目 + preview / commit」）：tar 上传解包 → `chmod -R a+rX server shared` + `chmod -R u=rwX,go=rX frontend/dist` → `db-migrate.sh` 实执行 `0053`（23 ms · `project_import_previews` 11 列 / 2 索引 / 5 CHECK / 2 FK）→ 复跑「已执行 52 个迁移，无漂移」→ api / worker restart（均 healthy · 容器内 `/healthz` 200 · `/readyz` 200）→ 旧哈希资源清理 3 个（`index-BmpRAV9e.js` / `CadViewer-q__WjFO3.js` / `index-CBhDTCMn.css`）—— 站点根 200（index.html 引用 `assets/index-BgYAfdBn.js`）、新 JS 200（1,139,908 B · sha256 `838892a1…` 与本地构建一致）、CSS 200、`/healthz` 200、`/readyz` 200、旧资源路径回落 SPA 兜底（text/html）、`POST /api/v1/project-imports/preview` 未登录 401（新路由已挂载）、api / worker 日志 0 error；开发机（真实客户端网络）公网复核同组断言；
- 服务器实测（2026-10-14 老表导入 413 热修 · v1.23）：根因 = 443 server 级 `client_max_body_size 32m` 被 `/api/v1` 继承，61.4 MiB 老表在 nginx 层被 413（前端显示「请求失败（HTTP 413）· 错误码 INTERNAL」）；修复 = `location /api/v1` 单独 `client_max_body_size 65m;`（应用整包上限 64 MiB + 1m 余量）→ conf 原地覆盖（保 inode · 单文件 ro bind mount）+ `nginx -t` OK + `nginx -s reload`（web 不重建）—— 双路实测（服务器本机 + 开发机真实客户端网络）：40 MB POST **413 → 401**、70 MB POST 仍 413（守上限）、61,410,006 B 老表原文件 POST → 401；`/nginx-health` / `/healthz` / `/readyz` / 站点根均 200；
- 服务器实测（2026-10-14 SPA 更新 · Push 318「导入面板撤两处说明文案」）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-BgYAfdBn.js` / `CadViewer-BekWaEqt.js`）—— 站点根 200（index.html 引用 `assets/index-BS9fUUs1.js`）、新 JS 200（1,139,052 B · sha256 `e624326f…` 与本地构建一致）、CSS 200（131,944 B · sha256 `2736d269…`）、`/healthz` 200、`/readyz` 200；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 老表导入收口部署 · Push 319 + v1.25 存量回填）：server / shared / frontend 三包 tar 上传解包 → `chmod -R a+rX`（server / shared）/ `chmod -R u=rwX,go=rX`（frontend）→ api / worker restart（均 healthy · 容器内 `/healthz` 200 · `/readyz` 200）→ 旧哈希资源清理 2 个（`index-BS9fUUs1.js` / `CadViewer-DZptSeOy.js`）；站点根 200（index.html 引用 `assets/index-Bti0_HPU.js`）、新 JS 200（1,140,699 B · sha256 `c50ead8c…` 与本地构建逐字节一致）、CSS 200（131,944 B · sha256 `2736d269…`）、旧资源回落 SPA 兜底、服务器 dist 标记核对（`leftJoin` ×3 / `changesLinked`）；存量回填 `server/scripts/push319-import-backfill.mjs`（dry-run → 实跑 → 幂等复跑 0 变更）：3 条未解决问题处理人回填贾海洋、3 条任务回写 `change_refs`（包装 / 物料清单完整版 / 布局定档；第 4 条「1xxx」源表关联为空按原样跳过）；贾海洋会话公网复验（临时会话 · 用毕即撤 · 残留 0）：`GET /api/v1/workspace`「待我处理」3 条 in_progress、`GET /projects/{id}/tasks` 3 条 changeLinks 有值、`GET /projects/{id}/change-requests` total = 4（fileId / versionId 全 null 不再被过滤）、`GET /change-requests/{id}` 200（file / version = null 不再 500）；
- 服务器实测（2026-10-14 SPA 更新 · Push 320「导入面板两处提示文案撤除 + 项目类型可新建」）：tar 增量上传（解包）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-Bti0_HPU.js` / `CadViewer-BAbx1aIu.js`）—— 站点根 200（index.html 引用 `assets/index-CzQcCLqe.js`）、新 JS 200（1,140,534 B · sha256 `a149af6d…` 与本地构建逐字节一致）、CSS 200（131,944 B · sha256 `2736d269…`）、`/healthz` 200、`/readyz` 200；线上 JS 文案核对：「添加项目类型」命中、撤销文案（「按源表关键字识别」/「导入老项目：选 Excel」）0 命中；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-14 nginx↔Node 上游长连接竞态修复 · Push 323 / v1.29）：根因 = `upstream api_backend` 未显式声明长连接池（实测连接被保持复用：10 连发仅 2 条 · 空闲数秒仍 ESTABLISHED）而 api（Node）默认 `server.keepAliveTimeout = 5s` 空闲即关 → 复用「已关未感知」旧连接偶发 502（`sendfile() failed (104: Connection reset by peer) while sending request to upstream`；Push 321 真机取消验证中复现、更早 `/api/v1/static-version` 高频请求为同型）；修复 = `keepalive 32;` + `keepalive_timeout 4s;`（idle ≤ 4s 复用 · 先于 Node 5s 关门）+ server 级 `proxy_set_header Connection "";` → conf 原地覆盖 + `nginx -t` OK + `nginx -s reload`（web 不重启）；行为探针（内核 uptime 时间戳 + netstat / `/proc/net/tcp`）：改后空闲 ~4s 由 nginx 侧主动关闭（TIME_WAIT · 本端先关）、4s 内复用同连接、超时后新建；修复后真机复跑两轮（共 8 次 61.4 MB preview · 零 502），第二轮 Push 321 公网取消验证 == 全部通过 ==（commit 10.0s 中断落在图片上传中途 → 零残留 / 票据可重提）；
- 服务器实测（2026-10-15 SPA 更新 · Push 334 + 335「仪表盘标题条 + 项目选择器」+「柱段悬停卡 + 点击只读数据详情」）：tar 上传解包 → `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-0fj4yGMQ.js` / `index-D9yiMmGa.css` / `CadViewer-BMoIGbpa.js`）—— 站点根 200（index.html 引用 `assets/index-DhplwV5k.js` + `assets/index-BJT-HW-r.css`）、新 JS 200（1,159,947 B · sha256 `e86dce8b…` 与本地构建逐字节一致）、CSS 200（138,799 B · sha256 `2dd0e8a5…`）、线上文案断言（`hub.dash.detail.title` ×4 · `hub.dash.pickProject` ×3 · CSS `hub-dash-detail` ×28 / `hub-dash-tip` ×10）、`/healthz` 200、 `/readyz` 200；旧资源路径回落 SPA 兜底（text/html）；目录挂载即传即生效（无容器重启）；
- 服务器实测（2026-10-15 仪表盘数据详情弹窗 + 常驻项目偏好键部署 · Push 336 · v1.41）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ 旧哈希资源清理 3 个（`index-DhplwV5k.js` / `index-BJT-HW-r.css` / `CadViewer-g9pZ26_V.js`）→ `docker compose --profile app restart api worker`（5 容器 healthy · `/healthz` 200 · `/readyz` 200）—— 站点根 200（index.html 引用 `assets/index-DS442VMJ.js`）、新 JS 200（1,160,823 B · sha256 `6e46244e…` 与本地构建逐字节一致）、CSS 200（138,506 B · sha256 `0a7a9545…`）、线上 JS 断言（`hubDashProject` ×4 · `hub.dash.pickSearch` ×3 · `hub.dash.pickEmpty` ×3 · `saveHubDashProject` ×3 · `data-hub-detail-dialog` ×2 · `hub-dash-detail-scroll` ×2 · 旧 `hub-dash-pick__ghost` ×0）、线上 CSS 断言（`hub-dash-pick` ×1 · `hub-dash-detail` ×28）、旧资源路径回落 SPA 兜底（text/html）、未登录 `PATCH /api/v1/users/me/preferences` 401 `AUTH_REQUIRED`（偏好新键随既有接口上线）；目录挂载即传即生效（无容器重启，api / worker 需 restart 载入新 server / shared 产物）。
- 服务器实测（2026-10-15 SPA 更新 · Push 337「选择器收起态回标题同款字体 + 明细列对齐项目空间 17 列 + 单滚动条」· v1.42）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-DS442VMJ.js` / `index-BkXTZigY.css` / `CadViewer-8lKG9DTw.js`）；公网复核：站点根 200（index.html 引用 `assets/index-BQUc49bQ.js` / `assets/index-C9JOTvC_.css`）· 新 JS 200（1,163,103 B · sha256 `d76bbe88…` 与本地构建逐字节一致）· 新 CSS 200（139,053 B · sha256 `5021ac3a…`）· 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-15 SPA 更新 · Push 338「数据详情截断格 hover 兜底」· v1.43）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-BQUc49bQ.js` / `CadViewer-CGb3cWC2.js`）；公网复核：站点根 200（index.html 引用 `assets/index-nHUlIt0O.js` / `assets/index-C9JOTvC_.css`）· 新 JS 200（1,163,121 B · sha256 `8070f5d4…` 与本地构建逐字节一致）· 新 CAD 200（612,553 B · sha256 `9dd773c3…`）· 新 CSS 200（139,053 B · sha256 `5021ac3a…`，与 v1.42 同包）· 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-15 SPA 更新 · Push 340「行阴影悬停出该阶段五档浮层 + 数据详情打开不再选中 ✕」· v1.44）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-nHUlIt0O.js` / `CadViewer-CBYafcVr.js`）；公网复核：站点根 200（index.html 引用 `assets/index-C95ICXOc.js` / `assets/index-C9JOTvC_.css`）· 新 JS 200（1,163,922 B · sha256 `4007f77b…` 与本地构建逐字节一致）· 新 CAD 200（612,553 B · sha256 `cd4b0635…`）· 新 CSS 200（139,053 B · sha256 `5021ac3a…`，与 v1.42 / v1.43 同包）· `/healthz` 200 · `/readyz` 200；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-15 SPA 更新 · Push 341「行阴影改仅悬停着色（默认态真透明）」· v1.46）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-BTuz3Oco.js` / `CadViewer-Um-EbZwu.js`）；公网复核：站点根 200（index.html 引用 `assets/index-BM8YlH36.js` / `assets/index-BDHVXrkr.css`）· 新 JS 200（1,171,001 B · sha256 `bd3dfbbb…` 与本地构建逐字节一致）· CSS 200（141,851 B · sha256 `a09b5701…`，与 v1.43–v1.45 同包）· `/healthz` 200 · `/readyz` 200；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-15 SPA 更新 · Push 342「底栏视图按钮收小 + 转场首帧叠影修复」· v1.47）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-BM8YlH36.js` / `index-BDHVXrkr.css` / `CadViewer-DLfNh-Mu.js`）；公网复核：站点根 200（index.html 引用 `assets/index-DSu9cjI1.js` / `assets/index-CbaFiF8C.css`）· 新 JS 200（1,171,001 B · sha256 `8ace2e89…` 与本地构建逐字节一致）· CSS 200（142,076 B · sha256 `aa175ecb…` 与本地一致）· `/healthz` 200 · `/readyz` 200；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-15 SPA 更新 · Push 343「仪表盘转场刚体滑轨 + 两屏卡面去毛玻璃」· v1.48）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-DSu9cjI1.js` / `index-CbaFiF8C.css` / `CadViewer-DS2ReZaS.js`）；公网复核：站点根 200（index.html 引用 `assets/index-Csg6_Q8S.js` / `assets/index-BOUr3dSi.css`）· 新 JS 200（1,171,063 B · sha256 `4ae216c9…` 与本地构建逐字节一致）· CSS 200（141,877 B · sha256 `29518b4d…` 与本地一致）· `/healthz` 200 · `/readyz` 200 · 线上包抽查（`hub-deck__strip` / `hub-deck__cell--in` / `ll-hub-cell-out` 命中 · 旧 `hub-deck__view--in-top` / `ll-hub-out-top` 0 命中 · 卡面类无 `backdrop-blur`）；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-16 SPA 更新 · Push 344「仪表盘「问题」视图（问题状态 × 归类分组柱状图）」· v1.49）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-Csg6_Q8S.js` / `index-BOUr3dSi.css` / `CadViewer-DIMuWrCJ.js`）；公网复核：站点根 200（index.html 引用 `assets/index-CSIeZJxB.js` / `assets/index-Cj8bWFIr.css`）· 新 JS 200（1,185,991 B · sha256 `ab974348…` 与本地构建逐字节一致）· CSS 200（142,584 B · sha256 `0d4f4961…` 与本地一致）· `/healthz` 200 · `/readyz` 200 · 线上包抽查（`hub-dash-issues__bar` / `hub-dash-issues__band` / `hub-dash-issue-detail` / 「问题状态 × 问题归类」命中）；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-16 SPA 更新 · Push 345「仪表盘「交付时间」视图（四结果柱状图 + 按时率小结）+ 页内视图按账号记住」· v1.50）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `docker compose --profile app restart api worker`（5 容器 healthy）；旧哈希资源清理 3 个（`index-CSIeZJxB.js` / `index-Cj8bWFIr.css` / `CadViewer-a-NxMWhw.js`）；公网复核：站点根 200（index.html 引用 `assets/index-CuUsX6-l.js` / `assets/index-CGfrqoiX.css`）· 新 JS 200（1,193,098 B · sha256 `f6a04732…` 与本地构建逐字节一致）· CSS 200（143,960 B · sha256 `86f77298…` 与本地一致）· `/healthz` 200 · `/readyz` 200（四探针全 true）· 未登录 `PATCH /api/v1/users/me/preferences` 401 · 服务器产物核对（server dist `hubDashView` ×3 行 · shared openapi `HubDashView` ×3 · shared dist ×4）· 线上包抽查（`hubDashView` / `hub-dash-delivery` / `[data-bucket` 等 JS / CSS 断言命中）。
- 服务器实测（2026-10-16 SPA 更新 · Push 346「交付时间」追订（提前完成并入按时交付 + 点按时率 / 点注记进详情）· v1.51）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-CuUsX6-l.js` / `index-CGfrqoiX.css` / `CadViewer-BbLKkuQC.js`）；公网复核（17 / 17 全过）：站点根 200（index.html 引用 `assets/index-C2JuRq3U.js` / `assets/index-DfV4ceBm.css`）· 新 JS 200（1,193,479 B · sha256 `6547eb49…` 与本地构建逐字节一致）· CSS 200（143,961 B · sha256 `94af09eb…` 与本地一致）· `/healthz` 200 · `/readyz` 200 · 线上 JS 抽查（`hub-dash-delivery` ×13 · `hubDashView` ×4 · 「按时率」×1 · `writerBy` ×0 · 「逾期未交付」/「逾期已交付」×12）· 旧哈希资源回落 SPA 兜底（text/html）；未重启容器（前端目录挂载）。
- 服务器实测（2026-10-16 老表导入变更落人部署 · Push 347「变更『申请人 / 填写者』按源表落人（applied_by / writer_by · 迁移 0054）」· v1.52）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `db-migrate.sh` 实执行 `0054`（4 ms · `change_requests` 增 `writer_by` uuid 可空无外键）→ 复跑「已执行 53 个迁移，无漂移」→ `docker compose --profile app restart api worker`（5 容器 healthy · 容器内 `/healthz` 200 · `/readyz` 200）；旧哈希资源清理 2 个（`index-C2JuRq3U.js` / `CadViewer-BcVdoq1Q.js`）；公网复核：站点根 200（index.html 引用 `assets/index-D1zT0x-p.js` / `assets/index-DfV4ceBm.css`）· 新 JS 200（1,193,616 B · sha256 `d407c477…` 与本地构建逐字节一致）· CSS 200（143,961 B · sha256 `94af09eb…` 与 v1.51 同产物）· `/healthz` 200 · `/readyz` 200 · 服务器产物核对（`change_requests.writer_by` uuid / YES · server dist `writerBy` 命中 · 线上 JS `writerBy` ×1）；真机端到端（贾海洋临时会话 · 用毕即撤）：preview 200（region = 英国 · type = 飞箱 · manager = 贾海洋 · counts = 任务 44 / 日报 48 / 变更 4 / 关联 3 / 图片 151 / 干系人 6 · 无 `CHANGE_APPLICANT_MISSING` / `CHANGE_WRITER_MISSING`）→ commit 200 建项目 `LBGW-20261016-0001` → 4 条变更落人全对（3 × 贾海洋 + 1 × 朱成荣 · 读面 `appliedBy` / `writerBy` 一致）→ 复查后物理删项目（11 张业务表孤儿 0 · 审计留痕 6 条属设计内）+ 会话即撤（`UPDATE 1`）· 今日新建账号 0；未重启 web（前端目录挂载即传即生效）。
- 服务器实测（2026-10-16 nginx /api/v1 超时热修 · Push 348「老表导入 commit 504」· v1.53）：根因 = server 级 `proxy_read_timeout 60s` 被 commit 逐张传图（151 张 ≈ 60s+）超时掐断 → 504；修复 = `location /api/v1` 加 `proxy_read_timeout 300s; proxy_send_timeout 300s;`（`client_max_body_size 257m` 维持）→ conf 原地覆盖（保 inode · 单文件 ro bind mount）+ `nginx -t` OK + `nginx -s reload`（web 不重建）；复核：`nginx -T` 实配 300s 生效 · `/healthz` 200 · `/readyz` 200 · 站点根 200 · 未登录 `POST /api/v1/project-imports/preview` 401 · conf md5 `cdab8829…` 与仓库逐字节一致；现场失败件核查（api `request aborted` → 图片对象已清理 · 项目未建成 · 票据 pending 自清）零残留。
- 服务器实测（2026-10-16 老表导入变更附图部署 · Push 349「变更『变更前 / 变更后』内嵌图随导入落库」· v1.54）：server 包 tar 上传解包（解到 /opt/libiaolink/server 根）→ `chmod -R a+rX` → `docker compose --profile app restart api worker`（5 容器 healthy · `/healthz` 200 · `/readyz` 200 四探针全 true）；服务器 dist 核对含 `change_before`（legacy ×1 / service ×5 / repo ×1）；真机端到端（公网 · 2026-10-16 12:11）：If-Match 软删旧 UK 项目 → API 重新导入 UK 表（preview `images=153` 含 2 张变更附图 · 缺号提醒无 → commit 200 · `images=153` · `changes=4` 账号全复用既有）→ 库内核验 4 条变更第 4 行「变更前 / 变更后」各 1 图 → files API 元数据「变更前附图 2026-09-01 01.png」/「变更后附图 2026-09-01 01.png」+ MinIO 预览取字节 `image/png` 6,838 B → 前端「变更管理」弹窗两列缩略图 + 点开全屏预览（滚轮缩放工具条）通过；file_links 计数 0（设计不落关联）；今日新建账号 0；前端无改动未动 web 产物。
- 服务器实测（2026-10-16 SPA 更新 · Push 350「变更管理弹窗缩略图大图预览浮于弹窗之上（z-[80]）+ Esc 让位」· v1.55）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-D1zT0x-p.js` / `CadViewer-DyKbVWRG.js`）；公网复核：站点根 200（index.html 引用 `assets/index-CxM_lx8h.js` / `assets/index-DfV4ceBm.css`）· 新 JS 200（1,193,869 B · sha256 `D4046F9E…` 与本地构建逐字节一致）· CadViewer 200（612,553 B · 逐字节一致）· CSS 200（143,961 B · 与上一版同哈希 —— 只动 JS）· 旧资源 SPA 兜底 200（text/html）· `/healthz` 200 · `/readyz` 200 · 6 容器 healthy · 未重启容器；真机验证（Playwright headless · 9/9 全过）：UK 项目「布局定档」行变更弹窗 →「变更前」缩略图 → 大图预览 z 80 > 弹窗 z 70（`elementFromPoint` 命中预览层）→ Esc 先关预览、弹窗仍在 → 再 Esc 关弹窗（截图 `tmp/push350-ui-preview-over-modal.png` / `tmp/push350-ui-after-esc.png`）。
- 服务器实测（2026-10-16 SPA 更新 · Push 351「仪表盘「问题」视图数据详情弹窗 Esc 让位（同源修正清理）」· v1.56）：单包 frontend · tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 2 个（`index-CxM_lx8h.js` / `CadViewer-BtbsA1vC.js`）；公网复核：站点根 200（index.html 引用 `assets/index-BbDeVDAL.js` / `assets/index-DfV4ceBm.css`）· 新 JS 200（1,194,021 B · sha256 `77F3CD37…` 与本地构建逐字节一致）· CadViewer 200（`CadViewer-0VNsTOcw.js` · 612,553 B · 逐字节一致 · 文件名级联因跨 chunk import 新索引名）· CSS 200（143,961 B · 与上一版同哈希 —— 只动 JS）· 旧资源 SPA 兜底 200（text/html）· `/healthz` 200 · `/readyz` 200 · 未重启容器；真机验证（Playwright headless · 12/12 全过）：仪表盘「问题」视图 → UK 项目点柱开「数据详情」→ 点附图瓦片 → 大图预览 z 70 > 弹窗 z 60（`elementFromPoint` 命中预览层）→ Esc 先关预览、弹窗仍在 → 再 Esc 关弹窗（截图 `tmp/push351-ui-preview-in-modal.png` / `tmp/push351-ui-after-esc.png`）。
- 服务器实测（2026-10-16 SPA 更新 · Push 352「顶栏站内信按钮 + 未读红点 + 局部消息弹窗（Transitions.dev Notification badge 样式还原）」· v1.57）：单包 frontend · SFTP 逐文件上传（11 文件 · sha256 逐一比对一致）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-BbDeVDAL.js` / `index-DfV4ceBm.css` / `CadViewer-0VNsTOcw.js`）；公网复核：站点根 200（index.html 引用 `assets/index-CqhgeomN.js` / `assets/index-D1q2DCCm.css`）· 新 JS 200（1,203,348 B · sha256 `7C6BEF9E…` 与本地构建逐字节一致）· CSS 200（145,212 B · sha256 `8D3FCB61…` —— 本刀 i18n 新增键，CSS 自 v1.56 起变化）· CadViewer 200（`CadViewer-BxaErHBW.js` · 612,553 B · 逐字节一致）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 未重启容器；真机验证（Playwright headless · 15/15 全过）：真实登录态顶栏铃铛位于「语言」胶囊左侧同排（`inboxRight 1276 ≤ langLeft 1284`）→ 红点 = 真实 unreadCount（2）→ 弹窗 3 条真实数据（最新在前；提醒行「含 2 条合并消息」）→ 点项目关联条 = 真实 `PATCH /api/v1/notifications/1` + 直达 `#/project/{id}` → 重开 id1 已读（服务端持久化）→「全部已读」= 真实 `POST mark-all-read` + 红点清零 + 按钮禁用 → Esc 收起 → 零脚本错误（截图 `tmp/push352-live-badge.png` / `tmp/push352-live-panel.png`）。
- Nginx 是唯一对外入口（80 / 443 / 9443；80 仅探活 + 301；443 含对象存储同源门面 `/libiaolink/`；9443 = MinIO 备用门面）；
- 证书：ALLinSSL 自动下发 `*.libiaorobot.com` → 宿主 `/etc/ssl/libiaorobot.com.pem|.key`（只读挂载进 web 容器 `/etc/nginx/ssl/`）；续签经 SSH 自动覆盖 + `sudo /usr/local/bin/allinssl-reload`（容器内 nginx 重载）；若续签后证书未生效 → `docker compose --profile app restart web`（单文件 bind mount 兜底）；
- 反代口径（与前端开发代理一致）：`/api/v1`、`/auth`、`/healthz`、`/readyz`；`/internal/**` 不对外；
- api / minio 容器**重建**（换镜像等）后 nginx 自动跟随新 IP（2026-10-14 起：`resolver 127.0.0.11 valid=10s` + `upstream … resolve` 动态解析；重建回归通过，不再需要 `restart web`）；若遇极端仍 502 → `docker compose --profile app restart web` 兜底；
- 生产 cookie 为 `Secure`（`SESSION_COOKIE_SECURE=auto` + `NODE_ENV=production`）→ TLS 已就绪（2026-10-14）；
- SSO（2026-10-14 测试环境接通）：`/auth/login` 302 → `https://authtest.libiaorobot.com/login/oauth/authorize`（client_id / redirect_uri 精确匹配、PKCE S256）；应用侧标准配置见《实测报告(SSO接入验证)》§四；正式环境应用（auth.libiaorobot.com）待 SSO 管理员创建（M8 §3-B）。

## 9. 对象存储（MinIO · 本机自建）

**决策口径（2026-10-13，px；待 lan 复核）**：生产选型 = 本机 MinIO 单节点（pinned `RELEASE.2025-09-07T16-13-09Z`）。背景：MinIO 上游已归档、官方分发下线（见 `deploy/minio/README.md`），故把「镜像离线固化」与「SeaweedFS 迁移评估」列为运维待办；接口层只依赖 S3 协议，换实现不动调用代码。**2026-10-13 追加实测：quay 该镜像已不可拉（匿名 401 / token $disabled）；镜像改由「GitHub Release 官方二进制（sha256 校验）+ 服务器本地 docker build」固化，见下文步骤与 `minio/Dockerfile`。**

**设计要点：**

- 数据落数据盘：bind `/srv/data/minio`（HDD；默认 docker volume 会落系统盘，禁用）；
- 端口：`9000` = S3 API，对局域网发布（预签名直传要求浏览器直连）；`9001` 控制台仅绑 `127.0.0.1`（SSH 隧道访问）；
- 凭据：`secrets/minio_root_user`、`secrets/minio_root_password`（`scripts/minio-entrypoint.sh` 注入）；应用侧 `secrets/s3_access_key` / `s3_secret_key`（当前与根口令同值；专用账号最小权限列为待办）；
- CORS：MinIO 社区版走服务端变量 `MINIO_API_CORS_ALLOW_ORIGIN`（compose 默认 `http://10.1.104.44`；换域名 / TLS 后同步更新并重建容器）。

**首次部署与验证（服务器）：**

```bash
cd /opt/libiaolink/deploy/prod
mkdir -p /srv/data/minio
cd secrets
echo "libiaolink" > minio_root_user
openssl rand -hex 24 > minio_root_password
cp minio_root_user s3_access_key
cp minio_root_password s3_secret_key
chmod 600 *
cd ..
# server.env 已存在（v1.2 切片创建）→ 只回填 S3 段；新机首部署才 cp server.env.example server.env
set_s3() { if grep -q "^$1=" server.env; then sed -i "s|^$1=.*|$1=$2|" server.env; else echo "$1=$2" >> server.env; fi; }
set_s3 S3_ENDPOINT http://10.1.104.44:9000
set_s3 S3_REGION us-east-1
set_s3 S3_BUCKET libiaolink
set_s3 S3_FORCE_PATH_STYLE auto
set_s3 S3_CORS_ORIGINS http://10.1.104.44
set_s3 S3_ABORT_INCOMPLETE_DAYS 30

# 镜像：quay 已下架（2026-10-13 实测 401 / token $disabled）→ 用 GitHub Release 官方二进制在服务器本地构建
# 二进制先（开发机 PowerShell）scp 到 /srv/data/images/minio/（保持文件名）：
#   minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z、minio.sha256sum
cd /srv/data/images/minio
echo "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f  minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z" | sha256sum -c -
docker build -f /opt/libiaolink/deploy/prod/minio/Dockerfile -t libiaolink/minio:RELEASE.2025-09-07T16-13-09Z /srv/data/images/minio
cd /opt/libiaolink/deploy/prod
docker compose --profile app up -d --force-recreate api worker minio
docker compose --profile app ps       # minio (healthy)
bash scripts/storage.sh init          # 建桶 + 版本控制（CORS / 分片清理按 MinIO 能力面告警）
bash scripts/storage.sh init --check  # 只读门禁（部署验收）
bash scripts/storage.sh it            # 真机回放 24 项断言
```

- 完成后 `readyz` 全绿（`object-storage:head-bucket` ✓）—— 2026-10-14 服务器实测：minio healthy / api→minio 200 / init 两项能力面告警属预期 / `--check` 退出码 0 / `it` 24/24 / readyz 200 全绿；镜像锚点 `sha256:165271c0…`；
- 换域名 / TLS 时：同步改 `server.env` 的 `S3_*` 与 compose 的 `MINIO_CORS_ALLOW_ORIGIN`，再 `up -d --force-recreate api worker`——**已执行（2026-10-14）**：`S3_ENDPOINT=https://test-pm.libiaorobot.com`（443 同源门面 `/libiaolink/` → minio:9000；客户端网络仅放行 22/80/443，9443 / 9000 实测被拦 —— **浏览器预签名地址一律走 443 默认端口，不带非标端口**；`/libiaolink/` 与 `S3_BUCKET` 强耦合，换桶名须同步 nginx）、`MINIO_CORS_ALLOW_ORIGIN=https://test-pm.libiaorobot.com,http://10.1.104.44`（改同源后 CORS 非必需，保留兼容 9443 直连与旧源）；同源门面上 `storage:it` 24/24 复跑通过；
- 部署件同步提醒：`nginx/libiaolink.conf` 为**文件级 bind mount（绑定 inode）**——scp 覆盖后容器内仍读旧文件，务必 `docker compose --profile app up -d --force-recreate web` 生效（2026-10-14 实测踩坑，同证书更新口径）；
- 镜像部署锚点：`docker image inspect libiaolink/minio:RELEASE.2025-09-07T16-13-09Z --format '{{.Id}}'` 记录 Image ID（换机 / 归档核对）；
- 控制台（运维）：`ssh -L 9001:127.0.0.1:9001 root@10.1.104.44` 后浏览器开 `http://127.0.0.1:9001`。

## 10. 后续切片（登记）

- web（Nginx）：TLS 接入 ✅（2026-10-14，443 应用 + 对象存储同源门面 + ALLinSSL 自动下发）；剩余：9443 备用门面择机收敛（浏览器流量已全部走 443 同源门面，9443 仅内网直连用，待无使用后从 compose 删端口）；`/internal/**` / `/example/` 显式 404 加固（SPA 产物 2026-10-14 已上线）；备份脚本（PG 12h → `/srv/data/backups/pg`）；监控告警接线；MinIO 运维面：镜像离线固化（quay 2026-10-13 实测下架，已改服务器本地构建；`docker save` 归档待办）、SeaweedFS 迁移评估、S3 专用账号最小权限、9000 明文端口收敛（127.0.0.1，TLS 门面稳定后）；
- onlyoffice（文档服务器）：生产上线 ✅（2026-10-14，离线镜像 + 443 子路径门面 + 真实 64MB xlsx 端到端；见 `deploy/onlyoffice/README.md` §6）；剩余：升级 / 重建后按回归五项 + §6.3 表复验、缓存盘 7 天清理 cron、正式环境容量评估与 CVE 跟踪；
- SSO：测试环境（authtest 应用 `LibiaoLink`）已按接入标准接通（2026-10-14）；正式环境应用 `libiaolink` 创建 + 企微登录方式挂接待 SSO 管理员（M8 §3-B）。
- M5-03-5 单聊改智能机器人（绑定码链路）部署**待执行**（项目组 2026-10-16 决定暂缓）：迁移 `0055` → `server/dist` 重传 → `server.env` 回填 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` → `restart api worker` → 真机复跑 **BC-1 ~ BC-4**（口径 §12）；执行前先备份 PG（`0055` 含不可回滚清理）。
- 完成项在 `docs/M8-部署Runbook与上线检查单(单机).md` 勾选；推送时随 `开发日志.md` 记录。

## 11. 变更记录

| 版本 | 日期 | 变更 | 人 |
|---|---|---|---|
| v1.0 | 2026-10-13 | 首版：postgres 服务（18.6 双锁 / 文件密钥 / 回环端口 / 资源限额 / healthcheck / 日志轮转）；db-init 脚本（角色基线 + 密码注入）；目录与密钥约定 | px |
| v1.1 | 2026-10-13 | tools 服务（node 24 双锁 / 一次性 profile / 依赖命名卷 / 只读 secrets）；db-migrate.sh + db-seed.sh；database 同步方式（scp 多源，不含 node_modules） | px |
| v1.2 | 2026-10-13 | api / worker 服务（profiles: app / 非 root 降权 entrypoint / 依赖命名卷 / healthcheck：api=wget healthz、worker=--health-check）；server.env 非敏感配置模板；server_node_modules / shared_node_modules 卷；README 补应用栈章节 | px |
| v1.3 | 2026-10-13 | api / worker 服务器实测收口（均 healthy / `/healthz` ok / `/readyz` 503-degraded 属预期 / worker heartbeat 正常）；依赖安装口径修正：`shared` 改 `npm ci --include=dev`（`@asteasolutions/zod-to-openapi` 运行时缺陷，待 wmj 线修复）；补 scp 权限畸形坑（`chmod -R a+rX`）；验证命令补 `--profile app` 与 degraded 正文查看方式 | px |
| v1.4 | 2026-10-13 | web（Nginx）部署件落地：compose 增 web 服务（唯一对外端口 80 / SPA 挂载 / 反代 api / nginx-health 探活 / 依赖 api healthy / 64M·0.5c 限额）；`nginx/libiaolink.conf`（80 先行 + TLS 模板注释；`/internal/**` 不对外）；README 补 §8；镜像双锁回填：`nginx:1.30.5-alpine@sha256:0985e772…`（2026-10-13）| px |
| v1.5 | 2026-10-13 | 对象存储切片：`deploy/prod` 增 minio 服务（数据盘 bind / 9000 局域网 + 9001 回环 / secrets 文件注入 / 镜像双锁 quay pinned / healthcheck；profiles: app）；新增 `scripts/minio-entrypoint.sh` + `scripts/storage.sh`（init / --check / it）；server.env S3 段回填内网端点与 CORS；README 补 §9 | px |
| v1.6 | 2026-10-13 | MinIO 镜像改**服务器本地构建**（quay 2026-10-13 实测下架：匿名 401 / `$disabled`；官方分发 410 / Docker Hub 无）—— 新增 `minio/Dockerfile`（alpine 3.24 双锁 + GitHub Release 官方二进制 sha256 校验）；compose minio 镜像指向本地 tag、healthcheck 改 busybox wget；`.env.example` / README §9 步骤与 §0 / §2 现状同步回填；storage.sh 注入 DATABASE_URL（server loadEnv 校验前置，服务器实测补丁） | px |
| v1.7 | 2026-10-14 | MinIO 服务器实测收口：A 路线（alpine 官方构建）成功，镜像锚点 `sha256:165271c0…`；minio healthy、api→minio 200；init（CORS / 分片清理按能力面降级 ⚠ 属预期）+ `--check` 通过 + `it` 24/24 + readyz 200 全绿；初试 Docker Hub auth 抖动（connection reset）→ 重试后拉取成功；§0 / §9 现状回填 | px |
| v1.8 | 2026-10-14 | TLS 切片收口：nginx 80 → 301 / 443 应用 / 9443 MinIO https 门面（Host 原样透传保 SigV4；证书单文件只读挂载）；compose 加 443/9443 端口与证书挂载；server.env S3 段切 https://test-pm.libiaorobot.com:9443、.env 回填 MINIO_CORS_ALLOW_ORIGIN；ALLinSSL SSH 自动下发（固定 /etc/ssl/ 路径 + allinssl 重载通道；第二台 103.44 接收端就绪）；服务器实测：证书链 200（无 -k）· 80/443/9443 全验 · storage:it 24/24（host 断言 9443）· 5 容器 healthy；§0 / §8 / §9 / §10 同步 | px |
| v1.9 | 2026-10-14 | SPA 产物上线：`frontend/dist`（10 文件 / 9.3MB）传服务器 + 权限修正（scp 707 畸形 → `chmod -R u=rwX,go=rX`）；实测站点根 200 / SPA 兜底 200 / wasm `application/wasm`；§8 SPA 说明与验证命令同步 | px |
| v1.10 | 2026-10-14 | SSO 切片（测试环境接通）+ Nginx 容器 DNS 动态解析：authtest 应用 `LibiaoLink` 按接入标准调整（redirect 追加 test-pm 回调 / 仅 `authorization_code` / `JWT-Custom` 五字段）→ 服务器回填 `casdoor_client_id` / `casdoor_client_secret`（chmod 600）+ `CASDOOR_ISSUER=https://authtest.libiaorobot.com` / `CASDOOR_REDIRECT_URI=https://test-pm.libiaorobot.com/auth/callback`；实测 `/auth/login` 302 → authtest 授权页（PKCE S256）· `/readyz` 200 · 5 容器 healthy；nginx 增 `resolver` + `upstream … resolve`（api / minio 重建换 IP 自动跟随，根治 502；重建回归通过）；§2 / §8 / §10 同步 | px |
| v1.11 | 2026-10-14 | SPA 更新部署（Push 304：「已有项目地区」按项目落库值聚合修复）：`frontend/dist` 重新构建 → tar 上传解包 + 权限 `u=rwX,go=rX`；旧哈希资源清理；实测站点根 200 / 新 JS 200 / `/healthz` 200 / `/readyz` 200；§8 补实测行（流程沿用 v1.9，无口径变化） | px |
| v1.12 | 2026-10-14 | 新增 §1.1 服务器登录（测试机 IP / 域名 / 登录方式 / 口令不落仓库 + 本机未跟踪备忘路径 / 登录后入口 / 铁律 / MinIO 控制台隧道 / 证书通道）；AGENTS.md 增「服务器与运维（测试机）」节（新会话自动注入可发现） | px |
| v1.13 | 2026-10-14 | 对象存储改「443 同源门面」修上传 / 预览断链：根因 = 客户端网络仅放行 22/80/443，预签名 URL 的 `:9443` 被拦（API 侧 201/200 正常、浏览器 PUT/GET 超时）→ 443 增 `location /libiaolink/`（= 桶名；`proxy_pass` 不重写、`Host $http_host` 保 SigV4）、`S3_ENDPOINT` 去端口为 `https://test-pm.libiaorobot.com`；`storage:it` 24/24 + 开发机真实网络预签名 PUT 200 / GET 200 字节一致 / DELETE 204 / 删后 404；9443 保留为内网备用门面；§0 / §8 / §9 / §10 同步 | px |
| v1.14 | 2026-10-14 | ONLYOFFICE 文档服务器生产上线（修「No online preview / DocServer unreachable」）：新增 `deploy/onlyoffice/docker-compose.prod.yml`（独立 compose 项目 `libiaolink-onlyoffice` / 不发布公网端口 / 8001 回环 / external 网络 `libiaolink-prod`）；nginx 增 `location /onlyoffice/`（去前缀 + `X-Forwarded-Prefix` / `X-Forwarded-Host` + Upgrade 透传 + `upstream … resolve`；DS 9.4 子路径原生支持）与 `location = /onlyoffice/example/` 恒 404（R6）；server.env `ONLYOFFICE_DOCSERVER_URL=https://test-pm.libiaorobot.com/onlyoffice`；镜像离线 save/scp/load 下发（1.7GB，归档 `/srv/data/images/oo_docs_9.4.0.1.tar`）；实测：门面 `api.js` 200 / `/onlyoffice/` 302 带前缀 / example 404 / healthz·readyz 200 · 密钥三处同值（宿主 secret / DS JWT_SECRET / api 进程）· DS→api:3000 200 · 匿名 preview-content 401 · WSS Upgrade 101 · 真实 64MB xlsx 经 443 全链渲染 ready（0 失败请求）；回滚备份 `nginx/libiaolink.conf.bak-oo-20261014` / `server.env.bak-oo-20261014`；`deploy/onlyoffice/README.md` 增 §6 + v1.1 | px |
| v1.15 | 2026-10-14 | 翻译通道切 API 方案（Push 309）：`translate` 模块 provider 可插拔 —— `TRANSLATE_PROVIDER=openai`（OpenAI 兼容 API 主通道：`TRANSLATE_API_BASE_URL` / `TRANSLATE_API_MODEL`，公司 New API 网关 `newapi.libiaorobot.com/v1`）/ `local`（本地引擎方案保留、暂不部署）；`TRANSLATE_FALLBACK_ORIGIN` 可选本地兜底；api / worker 入口增 `secrets/translate_api_key → TRANSLATE_API_KEY` 注入（不进仓库 / 不进 .env）；`server.env.example` TRANSLATE 段重写（provider / base / model / fallback）；`server/test/translate.test.ts` 13 例全绿；**服务器接线完成（14:36）**：`secrets/translate_api_key` 回填 + `server.env` 切 openai（备份 `server.env.bak-tr-20261014`）+ dist 重传 + api / worker 重建（均 healthy）；真机实测 4/4（1.5–2.6s/条） | px |
| v1.16 | 2026-10-14 | 翻译 API 备用模型接力（Push 310 · 业务口径「gemini-3.8-flash还有这个模型也可以调用 首选deepseek若deepseek断了就用这个」）：新增 `TRANSLATE_API_MODEL_FALLBACK`（备用 API 模型；留空 = 不接力）；`openai` 通道改「主模型 → 备用模型」两跳 —— 主模型（deepseek-v4-flash-vision-exp）失败（网络 / HTTP / 解析）且备用非空且不同名 → warn 日志 + 自动改调 `gemini-3.8-flash`（同一 New API 网关）；两跳皆败才回落 `TRANSLATE_FALLBACK_ORIGIN` 本地引擎（若配置）；落库 engine 按**实际产出模型**标记（`api:<模型>`）；`server.env.example` TRANSLATE 段补备用模型行；单测 18 例全绿 + 全量 1054 例全绿；**服务器接线（同一日）**：server.env 追加 `TRANSLATE_API_MODEL_FALLBACK=gemini-3.8-flash`（备份 `server.env.bak-tr2-20261014`）+ dist 重传 + api / worker 重建；真机实测主通道正常 + 主模型断流自动接力 2/2 | px |
| v1.17 | 2026-10-14 | 翻译规整补「句首大写」（Push 311 · 业务口径「句首大写规整 做」）：`translate.text.ts` 新增 `capitalizeSentenceStart`（小写开头 → 首字母大写；iPhone / eBay / pH 类品牌词形态不误伤；数字 / 标点 / 已大写幂等；占位符 Xq…Y 不受影响）；dist 重传解包 + `chmod -R a+rX` + api / worker `--force-recreate` 均 healthy；容器内探针：部署产物直测 6/6（「in dire straits」→「In dire straits」/ iPhone / eBay / 数字开头 / 已大写 / 全大写各 1 例）+ 真实网关实翻 3/3 正常（均句首大写）；无 env / 契约变化 | px |
| v1.18 | 2026-10-14 | SPA 更新部署（Push 312：日报贴图区「粘贴」的 Chrome「Blocked aria-hidden」控制台告警修复）：`frontend/dist` 重新构建 → tar 增量上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 4 个；实测站点根 200 / 新 JS 200（sha256 `83e4f5b6…` 与本地构建一致）/ CSS 200 / `/healthz` 200 / `/readyz` 200；§8 补实测行（流程沿用 v1.11，无口径变化） | px |
| v1.19 | 2026-10-14 | 默认外观改档部署（Push 313：「所有人 背景=适中 + 无水印」默认值 + 迁移 `0049` 存量回填 + 甘特「全部」不出任务列表）：同步迁移 `0048`（lan 线 · 已在 main；服务器此前至 `0047`）+ `0049` → `db-migrate.sh` 实执行（23 ms / 6 ms）+ 复跑无漂移；服务器 DB 核对 `prefs` 分布 5/5 行 medium/false；server / shared dist 干净替换重传 + `chmod -R a+rX` + api / worker `--force-recreate`（5 容器 healthy）；`frontend/dist` tar 增量上传解包 + 旧哈希清理 2 个；实测站点根 200 / 新 JS 200（sha256 `3add9c49…` 与本地一致）/ `/healthz` 200 / `/readyz` 200；§6 迁移口径同步（49 个） | px |
| v1.20 | 2026-10-14 | 地区字典对齐部署（Push 314：region 种子改 201 国标准清单 + 迁移 `0051` 清理旧 8 条区域占位）：`database/` 同步（`0051` + `dicts.mjs`）→ `db-migrate.sh` 实执行 `0051`（4 ms）→ 复跑「已执行 50 个迁移，无漂移」（本包未含平行刀 0050）→ `db-seed.sh` 六种子全 0 变更（测试环境已先行重写、region 已 201 —— `0051` 为 0 行 no-op、种子全 in sync）；DB 核对 region = 201 / 占位 0 / 英国 920 · 美国 1640 · 中国 470 · 新西兰 2010；站点根 / `/healthz` / `/readyz` 200（公网 `test-pm.libiaorobot.com/healthz` 200）；§6 迁移口径同步（50 个） | px |
| v1.21 | 2026-10-14 | 变更前后可填图部署（Push 315：变更申请「变更前 / 变更后」可填摘要附图 —— 与日报同款贴图区 + 迁移订正 0050→0052）：`database/migrations/` 删残留 `0050` → 同步 `0052`（md5 一致）→ `db-migrate.sh` 实执行 `0052`（7 ms：两列 + 两 CHECK）→ 复跑「已执行 51 个迁移，无漂移」；server / shared dist 重传 + `chmod -R a+rX` + api / worker restart（均 healthy · `/healthz` 200 · `/readyz` 200 四探针全绿）；`frontend/dist` tar 增量上传解包 + 旧哈希清理 2 个；实测站点根 200（index.html 引用 `assets/index-BmpRAV9e.js`）、新 JS 200（1,109,516 B · sha256 `636c110b…` 与本地一致）、CSS 200、`/healthz` 200、`/readyz` 200、旧资源回落 SPA 兜底；§6 迁移口径同步（51 个） | px |
| v1.22 | 2026-10-14 | 老表 Excel 直连导入部署（Push 316：项目空间「导入项目」按钮 + 大屏四步 + 服务端 preview / commit + 迁移 `0053`）：`database/migrations/0053` 同步 → `db-migrate.sh` 实执行 `0053`（23 ms：`project_import_previews` 11 列 / 2 索引 / 5 CHECK / 2 FK，`committed_project_id → projects on delete set null`）→ 复跑「已执行 52 个迁移，无漂移」；server / shared dist 重传 + `chmod -R a+rX` + api / worker restart（均 healthy · `/healthz` 200 · `/readyz` 200）；`frontend/dist` tar 增量上传解包 + 旧哈希清理 3 个；实测站点根 200（index.html 引用 `assets/index-BgYAfdBn.js`）、新 JS 200（1,139,908 B · sha256 `838892a1…` 与本地一致）、CSS 200、`/healthz` 200、`/readyz` 200、旧资源回落 SPA 兜底、`POST /api/v1/project-imports/preview` 未登录 401（新路由挂载）；§6 迁移口径同步（52 个） | px |
| v1.23 | 2026-10-14 | 老表导入 413 热修（Push 317：443 server 级 `client_max_body_size 32m` 被 `/api/v1` 继承 → 61.4 MiB 老表在 nginx 层 413）：`location /api/v1` 单独放 `client_max_body_size 65m`（应用整包上限 64 MiB + 1m 余量 → 超限由应用回 JSON 400）→ conf 原地覆盖（保 inode）+ `nginx -t` + `nginx -s reload`（web 未重建）；双路实测：40 MB POST 413→401、70 MB POST 仍 413、61,410,006 B 老表原文件 POST → 401；`/nginx-health` / `/healthz` / `/readyz` / 站点根均 200 | px |
| v1.24 | 2026-10-14 | SPA 更新部署（Push 318：导入面板撤两处说明文案 —— 标题副标题 + 账号提示 · i18n -4 键）：`frontend/dist` tar 增量上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-BgYAfdBn.js` / `CadViewer-BekWaEqt.js`）；实测站点根 200（index.html 引用 `assets/index-BS9fUUs1.js`）、新 JS 200（1,139,052 B · sha256 `e624326f…` 与本地一致）、CSS 200、`/healthz` 200、`/readyz` 200；§8 补实测行（流程沿用 v1.21，无口径变化） | px |
| v1.25 | 2026-10-14 | 老表导入收口部署（Push 319：变更关联回写 + 问题默认处理人 + 变更读面容忍无文件）+ 存量回填：server / shared / frontend 三包 tar 上传解包 → 权限修复 → api / worker restart（healthy · `/healthz` 200 · `/readyz` 200）→ 旧哈希清理 2 个；站点根 200（引用 `assets/index-Bti0_HPU.js` · 1,140,699 B · sha256 `c50ead8c…` 与本地一致）、CSS 200；存量回填 `push319-import-backfill.mjs`（dry-run → 实跑 · 幂等复跑 0 变更）—— 3 条问题处理人 + 3 条任务变更关联；贾海洋会话公网复验：工作台「待我处理」3 条 / 任务 changeLinks 3 条 / 变更记录 4 条可见（fileId / versionId null）；会话即撤零残留 | px |
| v1.26 | 2026-10-14 | SPA 更新部署（Push 320：导入面板两处提示文案撤除 + 项目类型「＋ 添加项目类型」）：`frontend/dist` tar 增量上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-Bti0_HPU.js` / `CadViewer-BAbx1aIu.js`）；实测站点根 200（index.html 引用 `assets/index-CzQcCLqe.js`）、新 JS 200（1,140,534 B · sha256 `a149af6d…` 与本地一致）、CSS 200、`/healthz` 200、`/readyz` 200；线上 JS 文案核对（新增文案命中 · 撤销文案 0 命中）；§8 补实测行（流程沿用 v1.24，无口径变化） | px |
| v1.27 | 2026-10-14 | 老表导入「可取消」部署（Push 321）：2026-10-14 22:26 完成 api / worker 重启生效（本会话 22:36 核对：dist 含取消检查点标记 `IMPORT_CANCELLED` · 前端 `index-Dr85aZkg.js`）；本条随 v1.28 轮次核对补记 | px |
| v1.28 | 2026-10-14 | 退出登录回跳修正部署（Push 322：`post_logout_redirect_uri` 复用已登记回调地址 + 无参 `/auth/callback` 落回首页）：server / shared / frontend 三包重传解包 + `chmod -R a+rX`（server · shared）/ `u=rwX,go=rX`（frontend）→ api / worker restart（均 healthy · 容器 `/healthz` 200 · `/readyz` 四探针全绿）→ 站点根 200（index.html 引用 `assets/index-Dr85aZkg.js` · 1,141,642 B · sha256 `e52d86e5…` 与本地构建逐字节一致）· CSS 200（131,944 B · sha256 `2736d269…`）· `/healthz` 200 · `/readyz` 200；真机探针（临时会话即用即删 · 残留 0）：`/auth/logout` 302 → Casdoor `/api/logout` 携 `post_logout_redirect_uri=https://test-pm.libiaorobot.com/auth/callback` + `id_token_hint` + `client_id`（此前传站点根地址、被 Casdoor「许可跳转列表」拒绝返回错误 JSON）；无参 `/auth/callback` 302 → `/`；浏览器人工点验「退出登录 → 回登录页」待业务侧确认 | px |
| v1.29 | 2026-10-14 | nginx↔Node 上游长连接竞态 502 修复（Push 323）+ Push 321 真机取消验证收口：`upstream api_backend` 增 `keepalive 32;` / `keepalive_timeout 4s;`（idle ≤ 4s 复用 · 先于 api 默认 `keepAliveTimeout` 5s 关门）+ server 级 `proxy_set_header Connection "";`；conf 原地覆盖（保 inode · 单文件 bind mount）+ `nginx -t` OK + `nginx -s reload`（web 不重建）→ 探针：2s 间隔复用同连接 / 空闲 ~4s 本端先关（TIME_WAIT）/ 超时后新建；改前真机复现：取消提交后 ~5s preview 撞 `sendfile() failed (104)` 502；修复后真机复跑两轮共 8 次 61.4 MB preview 零 502 · 第二轮 Push 321 公网取消验证 == 全部通过 ==（commit 10.0s 中断落在图片上传中途 → 库 / 桶零残留 · 票据 pending 可重提 → 同票据重提 200 · 删项目 200 · 收尾桶恢复基线 422 键） | px |
| v1.43 | 2026-10-15 | SPA 更新部署（Push 338：数据详情截断格 hover 兜底 —— 任务描述含英文 + 经理 / 负责人胶囊标题）（PR [#395](https://github.com/PanXing-Libiao/LibiaoLink/pull/395) · squash `5ad27e7` · main CI `38708485761`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-BQUc49bQ.js` / `CadViewer-CGb3cWC2.js`）；验证：站点根 200（`assets/index-nHUlIt0O.js` · 1,163,121 B · sha256 `8070f5d4…` 与本地构建逐字节一致；`index-C9JOTvC_.css` · 139,053 B · `5021ac3a…`）· 新 JS / CAD / CSS 200 · 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 | px |
| v1.44 | 2026-10-15 | SPA 更新部署（Push 340：行阴影悬停出「该阶段五档」浮层 + 数据详情打开不再选中 ✕）（PR [#396](https://github.com/PanXing-Libiao/LibiaoLink/pull/396) · squash `7f0e29b` · main CI `38710664746`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-nHUlIt0O.js` / `CadViewer-CBYafcVr.js`）；验证：站点根 200（`assets/index-C95ICXOc.js` · 1,163,922 B · sha256 `4007f77b…` 与本地构建逐字节一致；`index-C9JOTvC_.css` · 139,053 B · `5021ac3a…`）· 新 JS / CAD / CSS 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 | px |
| v1.45 | 2026-10-15 | 仪表盘「任务状态」视图（饼图 · 含已延期）+ 底部两枚视图切换按钮 + 悬停卡 + 点扇区只读「数据详情」部署（Push 339 · PR [#397](https://github.com/PanXing-Libiao/LibiaoLink/pull/397) · squash `ef48ae4` · main CI `38711245688`）：单包 frontend · `frontend/dist` tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-C95ICXOc.js` / `index-C9JOTvC_.css` / `CadViewer-DgBpN59a.js`）；验证：站点根 200（`assets/index-BTuz3Oco.js` · 1,170,993 B · sha256 `7b4b674b…` 与本地构建逐字节一致；`index-BDHVXrkr.css` · 141,851 B）· 新 JS / CSS 200 · 旧资源 SPA 兜底 200（text/html）· `/healthz` 200 · `/readyz` 200 · 线上 JS 文案断言（`任务状态` ×10 · `已延期` ×37 · `hub-dash-status` ×7 · `hub-dash-switch` ×1 · `hub-dash__rowband` ×1 · `group-has-[:checked]` ×4）· 线上 CSS 断言（`hub-dash-status__arc` ×3 · `stroke-width:1.5` ×1）· 未重启容器 | px |
| v1.46 | 2026-10-15 | SPA 更新部署（Push 341：仪表盘行阴影改「仅悬停着色」——默认态真透明）（PR [#400](https://github.com/PanXing-Libiao/LibiaoLink/pull/400) · squash `8608fe2` · main CI `38714435993`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-BTuz3Oco.js` / `CadViewer-Um-EbZwu.js`）；验证：站点根 200（`assets/index-BM8YlH36.js` · 1,171,001 B · sha256 `bd3dfbbb…` 与本地构建逐字节一致；`index-BDHVXrkr.css` · 141,851 B · `a09b5701…`）· 新 JS / CSS 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 | px |
| v1.47 | 2026-10-15 | SPA 更新部署（Push 342：底栏视图按钮收小 + 转场首帧叠影修复）（PR [#402](https://github.com/PanXing-Libiao/LibiaoLink/pull/402) · squash `6d330fb` · PR CI run `38717288174` · main CI `38717498782`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 3 个（`index-BM8YlH36.js` / `index-BDHVXrkr.css` / `CadViewer-DLfNh-Mu.js`）；验证：站点根 200（`assets/index-DSu9cjI1.js` · 1,171,001 B · sha256 `8ace2e89…` 与本地构建逐字节一致；`index-CbaFiF8C.css` · 142,076 B · `aa175ecb…`）· 新 JS / CSS 200 · `/healthz` 200 · `/readyz` 200 · 线上包抽查（`h-6 w-6` / `ml-2` 类 · `in-top` 基础位命中）· 未重启容器 | px |
| v1.48 | 2026-10-15 | SPA 更新部署（Push 343：仪表盘转场改「刚体滑轨」 + 两屏卡面去毛玻璃）（PR [#404](https://github.com/PanXing-Libiao/LibiaoLink/pull/404) · squash `3eb3e6c` · PR CI run `38722018728` · main CI `38722218048`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 3 个（`index-DSu9cjI1.js` / `index-CbaFiF8C.css` / `CadViewer-DS2ReZaS.js`）；验证：站点根 200（`assets/index-Csg6_Q8S.js` · 1,171,063 B · sha256 `4ae216c9…` 与本地构建逐字节一致；`index-BOUr3dSi.css` · 141,877 B · `29518b4d…`）· 新 JS / CSS 200 · `/healthz` 200 · `/readyz` 200 · 线上包抽查（`hub-deck__strip` / `ll-hub-cell-out` 命中 · 旧 `ll-hub-out-top` 0 命中 · 卡面类无 `backdrop-blur`）· 未重启容器 | px |
| v1.49 | 2026-10-16 | SPA 更新部署（Push 344：仪表盘「问题」视图（问题状态 × 问题归类分组柱状图 + 悬停卡 + 点柱只读「数据详情」）+ 底部视图切换第三枚按钮）（PR [#406](https://github.com/PanXing-Libiao/LibiaoLink/pull/406) · squash `d852f34` · PR CI run `38834782732` · main CI `38834968023`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 3 个（`index-Csg6_Q8S.js` / `index-BOUr3dSi.css` / `CadViewer-DIMuWrCJ.js`）；验证：站点根 200（`assets/index-CSIeZJxB.js` · 1,185,991 B · sha256 `ab974348…` 与本地构建逐字节一致；`index-Cj8bWFIr.css` · 142,584 B · `0d4f4961…`）· 新 JS / CSS 200 · `/healthz` 200 · `/readyz` 200 · 线上包抽查（`hub-dash-issues__bar` / `hub-dash-issues__band` / `hub-dash-issue-detail` / 「问题状态 × 问题归类」命中）· 未重启容器 | px |
| v1.50 | 2026-10-16 | 仪表盘「交付时间」视图（四结果柱状图 + 按时率小结）+ 页内视图按账号记住部署（Push 345 · PR [#408](https://github.com/PanXing-Libiao/LibiaoLink/pull/408) · squash `9a4f076` · PR CI run `38838595351` · main CI `38838742585`）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `docker compose --profile app restart api worker`（5 容器 healthy · `/healthz` 200 · `/readyz` 200 四探针全 true）；旧哈希资源清理 3 个（`index-CSIeZJxB.js` / `index-Cj8bWFIr.css` / `CadViewer-a-NxMWhw.js`）；验证：站点根 200（`assets/index-CuUsX6-l.js` · 1,193,098 B · sha256 `f6a04732…` 与本地构建逐字节一致；`index-CGfrqoiX.css` · 143,960 B · `86f77298…`）· 新 JS / CSS 200 · 未登录 `PATCH /api/v1/users/me/preferences` 401 · 服务器产物核对（server dist `hubDashView` ×3 行 · shared openapi `HubDashView` ×3 · shared dist ×4）· 线上包抽查（`hubDashView` / `hub-dash-delivery` / `[data-bucket` 等断言命中）；无迁移 / 无 DDL（`hubDashView` 为 jsonb 自由键） | px |
| v1.51 | 2026-10-16 | SPA 更新部署（Push 346：「交付时间」四档收三档（提前完成并入按时交付）+ 点击进入详情（点「按时率」/ 点「未到交付节点」注记））（PR [#409](https://github.com/PanXing-Libiao/LibiaoLink/pull/409) · squash `bf11611` · PR CI run `38840254403` · main CI `38840423900`）：`frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 3 个（`index-CuUsX6-l.js` / `index-CGfrqoiX.css` / `CadViewer-BbLKkuQC.js`）；验证（17 / 17 全过）：站点根 200（`assets/index-C2JuRq3U.js` · 1,193,479 B · sha256 `6547eb49…` 与本地构建逐字节一致；`index-DfV4ceBm.css` · 143,961 B · `94af09eb…`）· 新 JS / CSS 200 · `/healthz` 200 · `/readyz` 200 · 线上 JS 抽查（`hub-dash-delivery` ×13 · `hubDashView` ×4 · `writerBy` ×0 · 「逾期未交付」/「逾期已交付」×12）· 旧哈希资源回落 SPA 兜底（text/html）· 未重启容器 | px |
| v1.52 | 2026-10-16 | 老表导入变更「申请人 / 填写者」按源表落人部署（Push 347 · PR [#411](https://github.com/PanXing-Libiao/LibiaoLink/pull/411) · squash `5d36c38` · PR CI run `38842196681` · main CI `38842336270`）：server / shared / frontend 三包 tar 上传解包 → 权限修复 → `db-migrate.sh` 实执行 `0054`（4 ms · `change_requests` 增 `writer_by`）+ 复跑「已执行 53 个迁移，无漂移」→ api / worker restart（5 容器 healthy · `/healthz` 200 · `/readyz` 200）；旧哈希清理 2 个（`index-C2JuRq3U.js` / `CadViewer-BcVdoq1Q.js`）；验证：站点根 200（`assets/index-D1zT0x-p.js` · 1,193,616 B · sha256 `d407c477…` 与本地构建逐字节一致；`index-DfV4ceBm.css` · 143,961 B · `94af09eb…`）· 线上 JS `writerBy` ×1 · 真机端到端导入验证（preview / commit 落人全对 = 3 × 贾海洋 + 1 × 朱成荣 · 账号对账 11 全既有）· 验证后删测试项目 + 撤临时会话零残留；存量回填工具 `server/scripts/push347-import-backfill.mjs` 随仓库就绪（目标项目不在 test-pm 库 · 未执行） | px |
| v1.53 | 2026-10-16 | nginx `/api/v1` 读写超时 60s → 300s 热修（Push 348 · 老表导入 commit 504 · PR [#415](https://github.com/PanXing-Libiao/LibiaoLink/pull/415) · squash `7c9f3a5` · PR CI run `38845647012` · main CI `38845902306`）：根因 = commit 逐张传图（151 张）60s+ 被 server 级 `proxy_read_timeout 60s` 掐断 → 504；修复 = `location /api/v1` 显式块 + `proxy_read_timeout 300s; proxy_send_timeout 300s;`；conf 原地覆盖（保 inode）+ `nginx -t` + `nginx -s reload`（web 不重建）；复核 `/healthz` 200 · `/readyz` 200 · 站点根 200 · preview 未登录 401 · `nginx -T` 实配 300s · conf md5 `cdab8829…` 与仓库一致；失败件零残留（图片对象已清 · 项目未建成 · 票据 pending 自清） | px |
| v1.54 | 2026-10-16 | 老表导入变更「变更前 / 变更后」内嵌图随导入落库部署（Push 349 · PR [#418](https://github.com/PanXing-Libiao/LibiaoLink/pull/418) · squash `6d4f982` · PR CI [38848433357](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38848433357) · main CI [38848566281](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38848566281)）：server 包 tar 上传解包 + `chmod -R a+rX` → `docker compose --profile app restart api worker`（5 容器 healthy · `/healthz` 200 · `/readyz` 200）；服务器 dist 核对 `change_before`（legacy 1 / service 5 / repo 1）；真机端到端 12:11：删旧 UK 项目重导（preview / commit `images=153` · `changes=4`）→ 4 条变更第 4 行 before / after 各 1 图 → files API「变更前附图 / 变更后附图 2026-09-01 01.png」+ MinIO 取字节 `image/png` 6,838 B → 前端变更管理弹窗缩略图 + 全屏预览通过 · file_links 0 · 今日新建账号 0 | px |
| v1.55 | 2026-10-16 | SPA 更新部署（Push 350：变更管理弹窗「变更前 / 变更后」缩略图大图预览浮于弹窗之上（z-[80]）+ Esc 让位）（PR [#421](https://github.com/PanXing-Libiao/LibiaoLink/pull/421) · squash `776a4bd` · PR CI [38850905504](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38850905504) · main CI [38851050366](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38851050366)）：单包 frontend · `frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-D1zT0x-p.js` / `CadViewer-DyKbVWRG.js`）；验证：站点根 200（`assets/index-CxM_lx8h.js` · 1,193,869 B · sha256 `D4046F9E…` 与本地逐字节一致；`index-DfV4ceBm.css` · 143,961 B · 与上一版同哈希）· CadViewer / CSS 200 · 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 · 真机预览层级 9/9 全过（截图 `tmp/push350-ui-preview-over-modal.png` / `tmp/push350-ui-after-esc.png`） | px |
| v1.56 | 2026-10-16 | SPA 更新部署（Push 351：仪表盘「问题」视图数据详情弹窗 Esc 让位 —— 附图大图预览开着时 Esc 先关预览、弹窗仍在）（PR [#423](https://github.com/PanXing-Libiao/LibiaoLink/pull/423) · squash `323f4f7` · PR CI [38852315881](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38852315881) · main CI [38852448374](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38852448374)）：单包 frontend · `frontend/dist` tar 上传解包 + `chmod -R u=rwX,go=rX`；旧哈希资源清理 2 个（`index-CxM_lx8h.js` / `CadViewer-BtbsA1vC.js`）；验证：站点根 200（`assets/index-BbDeVDAL.js` · 1,194,021 B · sha256 `77F3CD37…` 与本地逐字节一致；`index-DfV4ceBm.css` · 143,961 B · 与上一版同哈希）· CadViewer / CSS 200 · 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 · 真机 Esc 让位 12/12 全过（截图 `tmp/push351-ui-preview-in-modal.png` / `tmp/push351-ui-after-esc.png`） | px |
| v1.57 | 2026-10-16 | SPA 更新部署（Push 352：顶栏「站内信」按钮 + 未读红点 + 局部消息弹窗 —— Transitions.dev Notification badge 样式还原）（PR [#426](https://github.com/PanXing-Libiao/LibiaoLink/pull/426) · squash `23d1858` · PR CI [38856970403](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38856970403) · main CI [38857146764](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38857146764)）：单包 frontend · SFTP 逐文件上传（11 文件 sha256 逐一比对）→ `chmod -R u=rwX,go=rX`；旧哈希资源清理 3 个（`index-BbDeVDAL.js` / `index-DfV4ceBm.css` / `CadViewer-0VNsTOcw.js`）；验证：站点根 200（`assets/index-CqhgeomN.js` · 1,203,348 B · sha256 `7C6BEF9E…` 与本地逐字节一致；`index-D1q2DCCm.css` · 145,212 B · sha256 `8D3FCB61…`）· CadViewer 200（`CadViewer-BxaErHBW.js` · 612,553 B · 逐字节一致）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 未重启容器 · 真机 15/15 全过（置读 / 全部已读 / 直达项目 / Esc 收起 · 截图 `tmp/push352-live-badge.png` / `tmp/push352-live-panel.png`） | px |
| v1.58 | 2026-10-16 | 仪表盘「词频图」视图（变更原因核心词词云 + 只有正中词可点 + 点词数据详情）部署（Push 353 · PR [#429](https://github.com/PanXing-Libiao/LibiaoLink/pull/429) · squash `1d2c58a`）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `docker compose --profile app restart api worker`（5 容器均 healthy）；旧哈希资源清理 3 个（`index-CqhgeomN.js` / `index-D1q2DCCm.css` / `CadViewer-BxaErHBW.js`）；公网复核：站点根 200（index.html 引用 `assets/index-Bool_QF4.js` / `assets/index-BMCIqJF2.css`）· 新 JS 200（1,220,093 B · sha256 `19889bfa…` 与本地构建逐字节一致）· CSS 200（146,027 B · sha256 `95e15b6c…` 与本地一致）· CadViewer 200（612,553 B · 逐字节一致）· `/healthz` 200 · `/readyz` 200（四探针全 true）· 未登录 `PATCH /api/v1/users/me/preferences` 401 · 服务器产物核对（shared openapi `wordcloud` ×2 · shared dist ×3 · 线上 JS 断言 `hub-dash-wordcloud` ×2 / `data-drill` ×9 / `词频图` ×2 / `Word frequency` ×1 · CSS `.hub-dash-wordcloud` / `.hub-dash-word-detail` 命中）· 未重启 web（目录挂载即传即生效） | px |
| v1.59 | 2026-10-16 | 仪表盘「假转场」修复线上生效复核（Push 354：重登录 / 刷新不再播转场动画 —— 滑轨过渡只在用户翻页期间开 + 记忆落屏写回地址 + 首落闸门）（PR [#430](https://github.com/PanXing-Libiao/LibiaoLink/pull/430) · squash `86e6fec` · PR CI [38860551020](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38860551020) · main CI [38860714315](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38860714315)）：修复构建（`assets/index-Bool_QF4.js` / `assets/index-BMCIqJF2.css` / `CadViewer-DNvqh0u-.js`）已随 v1.58 上传批同批上线（14:12 · 同一工作树构建产物 · 本刀无新增传输、未重启容器）；本轮复核：远端 dist 11 文件 sha256 与本地构建逐一一致（JS `19889bfa…` / CSS `95e15b6c…` / CadViewer `90c375a7…`）· 站点根 200（index.html 引用 `assets/index-Bool_QF4.js` / `assets/index-BMCIqJF2.css`）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy；真机验证（Playwright headless · 真实账号临时会话 15 / 15 全过）：裸 `#/` + 记忆=dashboard 冷启动 0 过渡事件（滑轨 101 帧采样零中间帧 · 地址写回 `#/?view=dashboard`）→ 滚轮上滑 / 下滑转场照常（`data-anim` 途中开启 · 过渡事件 3 → 6）→ 记忆=map 冷启动 0 事件、地址保持 `#/` → 零脚本错误（截图 `tmp/push354-live-dashboard.png` / `tmp/push354-live-wheel-mid.png` / `tmp/push354-live-map.png`） | px |
| v1.60 | 2026-10-16 | 仪表盘「词频图」悬停聚焦部署（Push 355：悬停任意枚词 → 该枚保持原样、其余每一枚统一压暗 30%，按「枚」不按「词」）（PR [#434](https://github.com/PanXing-Libiao/LibiaoLink/pull/434) · squash `cc0ee17` · PR CI [38862345159](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38862345159)）：frontend 单包 tar 上传解包（`frontend-v1.60.tgz` 3,893,151 B · 解包到 `frontend/dist` + `chmod -R a+rX` · server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；远端 dist 11 文件 sha256 与本地构建逐一一致（JS `8a16c4ef…` / CSS `33dd9ee2…` / CadViewer `856b7229…`）· 站点根 200（index.html 引用 `assets/index-VATdblOf.js` / `assets/index-XrLItk5s.css`）· `/healthz` 200 · `/readyz` 200 · 旧哈希清理 3 个（`index-Bool_QF4.js` / `index-BMCIqJF2.css` / `CadViewer-DNvqh0u-.js`，访问旧路径落 SPA 兜底属预期） | px |
| v1.61 | 2026-10-16 | 仪表盘「词频图」可点面纠偏部署（Push 356：由「只有正中一枚可点」扩到「每一枚核心词的主枚都可点」，重复小枚仍不可点）（PR [#436](https://github.com/PanXing-Libiao/LibiaoLink/pull/436) · squash `63d0c4d` · PR CI [38863505312](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38863505312) · main CI [38863639768](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38863639768)）：frontend 单包 tar 上传解包（`frontend-v1.61.tgz` 3,893,220 B · 解包到 `frontend/dist` + `chmod -R a+rX` · server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；远端 dist 11 文件 sha256 与本地构建逐一一致（JS `33e26076…` / CSS `33dd9ee2…`（与 v1.60 逐字节相同 —— 本刀 app.css 仅注释改动）/ CadViewer `f2406e7d…`） · 站点根 200（index.html 引用 `assets/index-BSN7FORS.js` / `assets/index-XrLItk5s.css`） · `/healthz` 200 · `/readyz` 200 · 旧哈希清理 2 个（`index-VATdblOf.js` / `CadViewer-DCS8-M1P.js`，访问旧路径落 SPA 兜底属预期） | px |
| v1.62 | 2026-10-16 | 仪表盘图表入场动画部署（Push 357：柱从基线生长 / 饼从圆心展开 / 数字淡入 / 错峰 —— ECharts 风格 · 颜色色调组件零改动）（PR [#438](https://github.com/PanXing-Libiao/LibiaoLink/pull/438) · squash `d7059af` · PR CI [38865948832](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38865948832) · main CI [38866112187](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38866112187)）：frontend `dist` 11 文件逐文件 SFTP 上传 + 每文件远端 sha256 对账 `UPLOAD-ALL-PASS`（11 / 11）+ `chmod -R u=rwX,go=rX`（server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；公网 served sha256 与本地构建逐一一致（JS `207df643…` / CSS `8a99d4dd…` / CadViewer `3b8160ba…`）· 站点根 200（index.html 引用 `assets/index-L8HKCKOS.js` / `assets/rolldown-runtime-CbXtAM7H.js` / `assets/index-BV9H05q7.css`）· `/healthz` 200 · `/readyz` 200 · 5 容器全 healthy · 旧哈希清理 3 个（`index-BSN7FORS.js` / `index-XrLItk5s.css` / `CadViewer-BwbMACzn.js`，访问旧路径落 SPA 兜底属预期）· 线上真机无头 Chrome 逐帧回放 26 / 26 全过（临时会话用毕即撤 · 偏好已还原）；本批部署件为合并后 main 全量构建，随带 Push 250 前端（设置页 / 绑定引导 —— 服务端部署刀待做，绑定读态 500 由前端容错兜住） | px |
| v1.63 | 2026-10-16 | 仪表盘「数据总览」视图部署（Push 358：五图等比例缩小并排 · 底栏最左第一枚 +「项目进度一览」改名「项目进度」）（PR [#442](https://github.com/PanXing-Libiao/LibiaoLink/pull/442) · squash `46f1a22` · PR CI [38869864365](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38869864365) · main CI [38870068984](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38870068984)）：frontend `dist` 11 文件上传 + `chmod -R u=rwX,go=rX`（上传后与合并提交 `46f1a22` 重建构建逐字节对账 —— 11 / 11 一致）；`shared` `dist` / `generated` 同步（逐文件 sha256 对账）+ `chmod -R a+rX` → api / worker restart（均 healthy · `/healthz` 200 · `/readyz` 200；web 未重启 —— nginx 静态 bind-mount 即时生效）；公网 served sha256 与本地构建逐字节一致（JS `d8ba4a18…` / CSS `4a4cdb1b…` / CadViewer `799cf174…`）· 站点根 200（index.html 引用 `assets/index-CH2pUbAF.js` / `assets/index-kqU9Zppk.css` / `assets/rolldown-runtime-CbXtAM7H.js`）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 容器内 `HUB_DASH_VIEW_IDS` 枚举核验 = `overview` + 五视图（api / worker 各一次）· 旧哈希清理 3 个（`index-L8HKCKOS.js` / `index-BV9H05q7.css` / `CadViewer-DlW4MrBH.js`，访问旧路径落 SPA 兜底属预期）· 线上真机无头 Chrome 复核 **37 / 37** 全过（截图 `tmp/push358-live-overview-1560.png`；临时会话用毕即撤 · 偏好已还原）· 本批为合并后 main 全量构建 | px |
| v1.64 | 2026-10-16 | 仪表盘「数据总览」版式追修部署（Push 359：两行版式 · 一屏铺满不滚动 · 尺寸画面放大）（PR [#444](https://github.com/PanXing-Libiao/LibiaoLink/pull/444) · squash `d8b5f4b` · PR CI [38880995912](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38880995912) · main CI [38881249866](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38881249866)）：frontend `dist` 11 文件逐文件 SFTP 上传 + 每文件远端 sha256 对账 `UPLOAD-ALL-PASS`（11 / 11）+ `chmod -R u=rwX,go=rX`（server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；公网 served sha256 与本地构建逐字节一致（JS `dbfd95a0…` / CSS `68661516…` / CadViewer `06822d66…`）· 站点根 200（index.html 引用 `assets/index-hdB6cpNk.js` / `assets/index-Dtf3YuTW.css` / `assets/rolldown-runtime-CbXtAM7H.js`）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 旧哈希清理 3 个（`index-CH2pUbAF.js` / `index-kqU9Zppk.css` / `CadViewer-7NLZKM_T.js`，访问旧路径落 SPA 兜底属预期）· 线上真机无头 Chrome 复核 **37 / 37** 全过（复核脚本 POINT 修正：极扁柱段渲染高约 11px 配合入场动画 CSS 变换时 `getPointAtLength` + `getScreenCTM` 采样点漂出可视格 —— 改「包围盒候选优先」后复跑全过，仅测试脚本、部署件无关；截图 `tmp/push358-live-overview-1560.png`） | px |
| v1.65 | 2026-10-16 | 仪表盘「数据总览」文字放大追修部署（Push 360：小字倍率 1.25~1.5 档 · 只动字号与其排版量）（PR [#446](https://github.com/PanXing-Libiao/LibiaoLink/pull/446) · squash `bed2d40` · PR CI [38883316044](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38883316044) · main CI [38883549522](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38883549522)）：frontend `dist` 11 文件逐文件 SFTP 上传 + 每文件远端 sha256 对账 `UPLOAD-ALL-PASS`（11 / 11）+ `chmod -R u=rwX,go=rX`（server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；公网 served sha256 与本地构建逐字节一致（JS `75d92085…` / CSS `68661516…`（与 v1.64 逐字节相同 —— 本刀未动 CSS）/ CadViewer `7b294d62…`）· 站点根 200（index.html 引用 `assets/index-DXN6DHPg.js` / `assets/index-Dtf3YuTW.css` / `assets/rolldown-runtime-CbXtAM7H.js`）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 旧哈希清理 2 个（`index-hdB6cpNk.js` / `CadViewer-BsEITqs1.js`；`index-Dtf3YuTW.css` 同名复用保留，访问旧路径落 SPA 兜底属预期）· 线上真机无头 Chrome 复核 **37 / 37** 全过 + 字号断言 **15 / 15** 全过（截图 `tmp/push360-live-overview-1560.png`）· 临时会话用毕即撤 · 偏好已还原 | px |
| v1.66 | 2026-10-16 | 仪表盘「数据总览」三面板对调追修部署（Push 361：问题 / 交付时间 / 项目进度 换位 · 字号档随格子对调）（PR [#448](https://github.com/PanXing-Libiao/LibiaoLink/pull/448) · squash `7510935` · PR CI [38918281334](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38918281334) · main CI [38918513421](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/38918513421)）：frontend `dist` 11 文件逐文件 SFTP 上传 + 每文件远端 sha256 对账 `UPLOAD-ALL-PASS`（11 / 11）+ `chmod -R u=rwX,go=rX`（server / shared 无改动 · 未重启容器 —— web = nginx 静态 bind-mount 即时生效）；公网 served sha256 与本地构建逐字节一致（JS `9e50c24a…` / CSS `20ac8453…` / CadViewer `6d98348e…` —— 入口与 CSS 换新、CadViewer 仅内嵌入口文件名 7 字节差异）· 站点根 200（index.html 引用 `assets/index-BX4FAWdr.js` / `assets/index-EJaUuvXj.css` / `assets/rolldown-runtime-CbXtAM7H.js`）· `/healthz` 200 · `/readyz` 200 · 5 容器 healthy · 旧哈希清理 3 个（`index-DXN6DHPg.js` / `index-Dtf3YuTW.css` / `CadViewer-CdEPj-II.js`，访问旧路径落 SPA 兜底属预期）· 线上真机无头 Chrome 复核 **40 / 40** 全过 + 字号断言 **15 / 15** 全过（截图 `tmp/push361-live-overview-1560.png`）· 临时会话用毕即撤 · 偏好已还原 | px |
| v1.42 | 2026-10-15 | 仪表盘「选择器收起态回标题同款字体 + 数据详情列对齐项目空间 17 列 + 藏原生横条只留自绘滑块」部署（Push 337 · PR [#393](https://github.com/PanXing-Libiao/LibiaoLink/pull/393) · squash `0b8e08f` · main CI `38706570597`）：单包 frontend · `frontend/dist` tar 上传解包（解到 `dist` 根）→ `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-DS442VMJ.js` / `index-BkXTZigY.css` / `CadViewer-8lKG9DTw.js`）；验证：站点根 200（`assets/index-BQUc49bQ.js` · 1,163,103 B · sha256 `d76bbe88…` 与本地构建逐字节一致；`index-C9JOTvC_.css` · 139,053 B）· 新 JS / CSS 200 · 旧资源 SPA 兜底 200 · `/healthz` 200 · `/readyz` 200 · 未重启容器 | px |
| v1.38 | 2026-10-15 | 仪表盘页「视图进地址 + 按账号记住常驻视图」部署（Push 332 · PR [#384](https://github.com/PanXing-Libiao/LibiaoLink/pull/384) · squash `3d7fa27` · main CI `38696596707`）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `docker compose --profile app restart api worker`（5 容器 healthy）；旧哈希资源清理 2 个（`index-CLnynHnS.js` / `CadViewer-BP9NI72U.js`）；验证：站点根 200（`assets/index-CeasZpsh.js` · 1,151,832 B · sha256 `85878867…` 与本地构建逐字节一致）· CSS 200（134,105 B · sha256 `b4f96dea…`）· `/healthz` 200 · `/readyz` 200（四探针 ok）· 线上 JS 文案（`?view=dashboard` ×1 / `hubView` ×4 / `saveHubView` ×3）· 未登录 `GET /api/v1/users/me/preferences` 401 · 服务器产物核对（server dist `user-preference.service.js` 命中 `hubView` · shared `generated` `HubView` ×3）；**契约产物重生成**（首轮 PR CI `shared` 报契约漂移 → `npm run generate` 提交 `generated/openapi.json` / `api-types.d.ts` 后四面全绿）。无迁移 / 无 DDL（`hubView` 为 jsonb 自由键） | px |
| v1.39 | 2026-10-15 | 仪表盘页右侧边缘页面指示器部署（Push 333 · PR [#385](https://github.com/PanXing-Libiao/LibiaoLink/pull/385) · squash `45aef89` · main CI `38698476380`）：`frontend/dist` tar 上传解包 → `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-CeasZpsh.js` / `index-CIyEVyLD.css` / `CadViewer-DCCyEf66.js`）；验证：站点根 200（`assets/index-0fj4yGMQ.js` · 1,151,320 B · sha256 `b8f03086…` 与本地构建逐字节一致）· CSS 200（133,897 B · sha256 `81d63401…`）· 线上 CSS 断言（`hub-deck-dots` ×6 · `hub-deck-hint` ×0 · 液体玻璃 blob ×0）· JS 文案（`hub.dots.label` / `hub.dots.map` / `hub.dots.dashboard` 各 ×3）· `/healthz` 200 · `/readyz` 200；旧资源路径回落 SPA 兜底（text/html）；目录挂载即传即生效（无容器重启） | px |
| v1.41 | 2026-10-15 | 仪表盘「数据详情改弹窗 + 横向滑块 + 常驻项目记住 + 可搜索选择器」部署（Push 336 · PR [#391](https://github.com/PanXing-Libiao/LibiaoLink/pull/391) · squash `821d574` · main CI `38704216306`）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ 旧哈希资源清理 3 个（`index-DhplwV5k.js` / `index-BJT-HW-r.css` / `CadViewer-g9pZ26_V.js`）→ `docker compose --profile app restart api worker`；验证：5 容器 healthy · `/healthz` 200 · `/readyz` 200 · 站点根 200（`assets/index-DS442VMJ.js` · 1,160,823 B · sha256 `6e46244e…` 与本地构建逐字节一致）· CSS 200（138,506 B · sha256 `0a7a9545…`）· 线上 JS 断言（`hubDashProject` ×4 · `hub.dash.pickSearch` ×3 · `hub.dash.pickEmpty` ×3 · `saveHubDashProject` ×3 · `data-hub-detail-dialog` ×2 · `hub-dash-detail-scroll` ×2 · `hub-dash-pick__ghost` ×0）· 线上 CSS 断言（`hub-dash-pick` ×1 · `hub-dash-detail` ×28）· 旧资源路径回落 SPA 兜底（text/html）· 未登录 `PATCH /api/v1/users/me/preferences` 401；无 DDL / 迁移 / 依赖改动 | px |
| v1.40 | 2026-10-15 | 仪表盘页两刀部署（Push 334 标题条 + 项目选择器 · PR [#387](https://github.com/PanXing-Libiao/LibiaoLink/pull/387) · squash `594f889` · main CI `38700108261`；Push 335 柱段悬停卡 + 点击只读「数据详情」 · PR [#388](https://github.com/PanXing-Libiao/LibiaoLink/pull/388) · squash `c7321d0` · main CI `38701693914`）：
`frontend/dist` tar 上传解包 → `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-0fj4yGMQ.js` / `index-D9yiMmGa.css` / `CadViewer-BMoIGbpa.js`）；验证：站点根 200（`assets/index-DhplwV5k.js` · 1,159,947 B · sha256 `e86dce8b…` 与本地构建逐字节一致）· CSS 200（138,799 B · sha256 `2dd0e8a5…`）· 线上文案断言（JS `hub.dash.detail.title` ×4 · `hub.dash.pickProject` ×3 · 「数据详情」×1 · CSS `hub-dash-detail` ×28 / `hub-dash-tip` ×10）· `/healthz` 200 · `/readyz` 200；旧资源路径回落 SPA 兜底（text/html 586 B）；目录挂载即传即生效（无容器重启） | px |
| v1.37 | 2026-10-15 | 仪表盘页（原「蓝图」）地图 ⇄「项目进度一览」转场部署（Push 331 · PR [#381](https://github.com/PanXing-Libiao/LibiaoLink/pull/381) · squash `024158ae`）：导航首项改名「仪表盘」+ 鼠标滑动转场大屏 + 去滚动条（`h-[100dvh] overflow-hidden`）。部署 = frontend/dist tar 上传解包 + `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（`index-ChyVtaww.js` / `index-DAPzSaCk.css` / `CadViewer-3koXLSw2.js`）；实测站点根 200（index.html 引用 `assets/index-CLnynHnS.js` · 1,150,680 B · sha256 `432709ad…` 与本地逐字节一致）、新 JS 200、CSS 200（134,105 B · sha256 `b4f96dea…` 与本地一致）、`/docs/import-guide.pdf` 200（189,881 B · sha256 `b54d9171…` 不变）、`/healthz` 200、`/readyz` 200、5 容器 healthy；开发机公网拉取线上 JS 复核：「仪表盘」×1 ·「项目进度一览」×2 ·「滚动查看项目进度」×1 ·「滚动返回地图」×1 · `hub-deck` ×10 · 剩余「蓝图」×1（审计 `objectType` 词条）；目录挂载即传即生效（无容器重启） | px |
| v1.36 | 2026-10-15 | 「令牌声明」调试折叠区移除部署（Push 330 · PR [#378](https://github.com/PanXing-Libiao/LibiaoLink/pull/378) · squash c17a4c0）：项目空间列表底部 me.claims 折叠区（「令牌声明（id_token，已通过 JWKS 验签）」/「令牌到期时间」）整体下架。部署 = frontend/dist tar 上传解包 + chmod -R u=rwX,go=rX → 旧哈希资源清理 3 个（index-BGI_A02h.js / CadViewer-qc0yeGp0.js / index-D2d5S2kg.css）；实测站点根 200（index.html 引用 assets/index-ChyVtaww.js · 1,142,899 B · sha256 d7361715… 与本地逐字节一致）、CSS 200（132,597 B · sha256 de224e63… 与本地一致）、/docs/import-guide.pdf 200（189,881 B · sha256 b54d9171… 不变）、/healthz 200、/readyz 200；开发机公网拉取线上 JS 复核：「令牌声明 / 令牌到期时间 / 已通过 JWKS 验签」0 命中；目录挂载即传即生效（无容器重启） | px |
| v1.35 | 2026-10-15 | 「导入说明」改系统内浮层预览部署（Push 329 · PR [#376](https://github.com/PanXing-Libiao/LibiaoLink/pull/376) · squash 96452f8）：说明书由新标签页链接改系统内浮层（复用文件预览浮层 · kind=pdf · iframe 浏览器内置渲染 · Esc / 点遮罩关闭 · 浮层内「下载原文件」）；悬停「导入项目」浮出入口逻辑不变。部署 = frontend/dist tar 上传解包 + chmod -R u=rwX,go=rX → 旧哈希资源清理 2 个（index-B4HVRqni.js / CadViewer-yXdLRzzA.js）；实测站点根 200（index.html 引用 assets/index-BGI_A02h.js · 1,143,652 B · sha256 c91e6be7… 与本地逐字节一致）、CSS 200（132,641 B · sha256 87ae6c8f… 不变）、/docs/import-guide.pdf 200（189,881 B · sha256 b54d9171… 不变）、/healthz 200、/readyz 200（旧哈希路径经 SPA 回退为 586 B index.html · 非残留）；开发机公网复核同组断言；目录挂载即传即生效（无容器重启） | px |
| v1.34 | 2026-10-15 | 导入说明入口部署（Push 328 · PR [#373](https://github.com/PanXing-Libiao/LibiaoLink/pull/373) · squash `cd34048`）：常显链接改悬停浮出（悬停「导入项目」按钮 → 按钮下方浮出「导入说明」小卡片 → 新标签页打开说明书 PDF）。部署 = frontend/dist tar 上传解包 + `chmod -R u=rwX,go=rX` → 旧哈希资源清理 3 个（index-Bn9KJoT2.js / CadViewer-D7_kYvlj.js / index-CgJYAJR_.css）；实测站点根 200（index.html 引用 `assets/index-B4HVRqni.js` · 1,143,303 B · sha256 `0dd89087…` 与本地逐字节一致）、CSS 200（132,641 B · sha256 `87ae6c8f…`）、新静态件 `/docs/import-guide.pdf` 200（189,881 B · sha256 `b54d9171…` 与本地一致）、`/healthz` 200、`/readyz` 200；开发机（真实客户端网络）公网复核同组断言；目录挂载即传即生效（无容器重启） | px |
| v1.33 | 2026-10-15 | 导入等待「还需要  N 秒」动态倒计时部署（Push 326 · PR [#370](https://github.com/PanXing-Libiao/LibiaoLink/pull/370) · squash `7ad57fb`）：秒数 = 预估总耗时 − 墙钟已用秒数，每 1 秒刷新；未完成前保底 1 秒；中英文案 =「还需要  N 秒 / Remaining  N s」。部署 = frontend 产物重传 + web 重建（bind 目录替换后需重建恢复挂载）；验证：5 容器 healthy · `/healthz` 200 · `/readyz` 四探针全绿 · 站点根 200（`assets/index-Bn9KJoT2.js` · 1,142,281 B · sha256 `17e07fa2…` 与本地构建逐字节一致）· 线上 JS「还需要 / Remaining」各 ×1 · 1 秒 setInterval ×1 · 旧「还需要多长时间 / Time remaining」×0 | px |
| v1.32 | 2026-10-15 | 导入表「上限 256MB + 剩余时间文案」部署（Push 326 · PR [#368](https://github.com/PanXing-Libiao/LibiaoLink/pull/368) · squash `d6e9507`）：契约 / 前端先挡 / 服务端复检上限改 256 MiB，等待文案中英改「还需要多长时间：N 秒 / Time remaining: Ns」；Nginx `/api/v1` 上限改 `257m`（超额仍由网关 413 挡住）；部署 = server / frontend / nginx 三包重传 + `nginx -t` / reload + web 重建（bind 目录替换后需重建恢复挂载）+ api / worker restart；验证：5 容器 healthy · `/healthz` 200 · `/readyz` 四探针全绿 · 站点根 200（`assets/index-Bc4tTBOa.js` · 1,141,980 B · sha256 `fefd78d6…` 与本地构建逐字节一致）· 线上 JS 中文「还需要多长时间」×1 · 英文「Time remaining」×1 · 公网 200MB 未登录 preview 401（应用层 JSON，说明 200MB 可达 API）· 300MB 413（Nginx 守住边界）· api / worker 10 分钟日志 0 error | px |
| v1.31 | 2026-10-15 | 导入表「过期票据清扫 + 单工作簿干系人」部署（Push 325 · PR [#365](https://github.com/PanXing-Libiao/LibiaoLink/pull/365) / [#366](https://github.com/PanXing-Libiao/LibiaoLink/pull/366) · squash `2f023f0` / `c81ec79`）：worker 启动即扫、每 10 分钟清理 pending 过期票据源对象后置 `expired`；移除「另附干系人表」，干系人仅解析导入表内嵌「干系人」sheet；部署 = server 包重传 + api / worker restart + frontend 产物重新按构建根展开（修正 v1.31 首次部署误成 `dist/dist` 导致根路径 404）+ web restart；验证：5 容器 healthy · `/healthz` 200 · `/readyz` 四探针全绿 · 站点根 200（`assets/index-DxFq3uBZ.js` · 1,141,958 B · sha256 `027a3273…` 与本地构建逐字节一致）· CSS 200 · 未登录 preview 401 · 存储门面匿名 403 · 线上 JS「老表 / 另附干系人 / stakeholderFile / STAKEHOLDER_FILE」均 0 命中 · worker 日志「扫描 11 个 / 过期 11 个」且 20 分钟窗口 0 error · 票据状态 `committed 4 / expired 11 / pending 1`（该 pending = 03:30 新预览，未到 30 分钟 TTL 不应清理）· `expired` 行 `committed_at` 非空数 = 0 | px |
| v1.30 | 2026-10-14 | 老表导入「干系人随项目导入」部署（Push 324 · squash `aaf6016`）：server / shared / frontend 三包 tar 上传解包 → 权限修复（server / shared `chmod -R a+rX` · frontend `chmod -R u=rwX,go=rX`）→ `docker compose --profile app restart api worker`（5 容器均 healthy · `/healthz` 200 · `/readyz` 四探针全绿）→ 旧哈希资源清理 3 个（`index-Dr85aZkg.js` / `index-CgJYAJR_.css` / `CadViewer-DVp2EUpp.js`）；站点根 200（index.html 引用 `assets/index-SgbTQaBb.js` · 1,143,947 B · sha256 `9f8e7f12…` 与本地构建逐字节一致）· CSS 200（131,977 B · sha256 `60e455a8…`）· 未登录 `POST /api/v1/project-imports/preview` 401 · 线上 JS 文案核对（「另附干系人表」×1 · 「预计需要」×2 · 「已用」×0）；dist 标记核对（`STAKEHOLDER_FILE_IGNORED` ×1 / `readMultipartParts` ×1）；迁移 `0053` 服务器实执行核对（`schema_migrations` · 2026-10-14 11:56:41 UTC · 23 ms）；**真机复验（三条分支 + 浏览器真单 · 贾海洋临时会话 · 用毕即删）**：① 主表剥「干系人」表 + 另附单表（44.0 MB 主表 + 9,875 B 单表 · 双 part 过 nginx 65m 门）→ 200 · `counts.stakeholders=6` · 无 `STAKEHOLDER_FILE_IGNORED` / `SHEET_MISSING`；② 主表含「干系人」表 + 另附 → info `STAKEHOLDER_FILE_IGNORED`（以主表为准 · 主表内嵌 6 行）；③ 两处都缺 → info `STAKEHOLDER_SHEET_MISSING` · `stakeholders=0`；浏览器真单（23:51 · UK 表内嵌干系人）→ 项目 `LBGW-20260331-1459` + 6 干系人台账 + 6 项目关联行（姓名 / 类别 / 职务 / 「提交时间」→ `created_at` 逐行与源表一致；「填写者 倪里特」三档未命中 → `created_by` 留空 + info `STAKEHOLDER_FILLER_MISSING`，符合口径）；api / worker 12 分钟窗口日志 0 error / exception；收尾：测试预览 3 条 + 源对象 3 个 + 临时会话 1 条即用即删，桶键数回 `573` 基线 | px |
