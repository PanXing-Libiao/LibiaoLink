# M8 部署 Runbook 与上线检查单（单机部署）

> 归属：px（部署 / 交付 · M8-03 / M8-04 先行落地件）｜2026-10-13｜状态：v1.10（随落地进展更新）
> 口径来源：`docs/adr/ADR-013-部署与容量起点.md`（单机 Compose + Nginx、容量起点、生产门禁、备份口径）、`docs/PoC-10-部署前置定稿(F1-R3·R6).md`、`deploy/onlyoffice/README.md`（S2 部署清单 + 升级回归五项）、`deploy/minio/README.md`、`docs/公司统一登录(SSO)实施方案.md`、`docs/M5-03-外部依赖清单(企微通道).md`、`技术设计v0.3-实施与验收.md` §3.9（M8）。
> 关系说明：本文件是「单机落地方案 + 检查单」的汇总与追踪；组件级配置以各自 README / 定稿为准，冲突时以上游为准并回改本文件；M8-03 / M8-04 正式主体继续按 `技术设计v0.3` §3.9 推进。

## 0. 服务器现状（2026-10-13 锚定）

| 项 | 实际 | ADR-013 试点起点 | 结论 |
|---|---|---|---|
| CPU | 8 核（2 sockets × 4 cores，x86-64-v2-AES） | 8C | 达标 |
| 内存 | **12G（暂不扩容，仅此一档）** | 16G | 用「限额 + 监控 + 降配」对冲（§1）；扩容列观察项 |
| 系统 | Ubuntu 26.04 LTS（VM `nilt-pm-test`，主机名 `libiao-vm`） | — | systemd 基座；NTP 用 `timedatectl` 核对；桌面版（GNOME 常驻，内存吃紧再评估关图形） |
| 网络 | 内部 IP `10.1.104.44`（VLAN 1104） | — | 仅经 Nginx 暴露端口（唯一对外入口） |
| 系统盘 `sda` | **40G SSD**（`ssd-pool01`） | 500G SSD | 偏小：只放 OS / Docker / 镜像 / PG；日志轮转与磁盘告警必做（§2） |
| 数据盘 `sdb` | **300G HDD**（`hdd-pool01`） | 2TB 数据盘 | 300G 起步；容量监控提前接入（§2）；单盘无冗余 → 异地同步兜底（§5） |

> 一期画像：试点（实施部门 80 用户内）、全部组件同机；可用性口径按 ADR-013（Q19：以「计划外中断次数 + 恢复时长」联合验收，验收前与业务 / IT 书面确认）。

## 1. 内存预算（12G 大盘子 · 建议限额，部署后按压测校准）

| 组件 | 建议限额 | 备注 |
|---|---|---|
| OS + Docker 引擎 | ~1.5G | 不可压 |
| PostgreSQL | 1G（shared_buffers 256M 档） | max_connections 按连接池上限收紧（生产门禁） |
| MinIO（或目标对象存储） | 0.5 ~ 1G | 若换 SeaweedFS / 内网既有存储，按实现调整 |
| api（Node） | 768M | `--max-old-space-size=512` 量级；DB 连接池有界 |
| worker（Node） | 768M | 同上；常驻循环（outbox / 通知 / 调度） |
| web（Nginx） | 64M | |
| ONLYOFFICE | **3G**（`OO_MEM_LIMIT=3g`、`OO_CPUS=2`） | compose 默认 4g；12G 机器降配到 3G，预览并发按首关 20/50 曲线观察 |
| 预留（页缓存 / 尖峰） | ≥ 2.5G | 告警看「可用内存下限 + swap 抬头」 |
| 翻译引擎（HY-MT1.5-1.8B） | **不在本机部署** | 模型 ≥ 2G 内存；`TRANSLATE_ORIGIN` 指向内网既有地址；无引擎时英译静默降级 |

- swap：4G swapfile（落数据盘，`vm.swappiness=10`），只做兜底、不作性能依赖；
- 吃紧时的降级顺序：先压 ONLYOFFICE（限额 / 并发限流），再查 worker 循环批大小；不得挤占 api / worker / PG 的保障余量；
- 部署后复测：首关 20/50 并发曲线口径回放，结果记部署日志（与 ONLYOFFICE 升级回归「R4 并发复测」同源）。

## 2. 磁盘分工与告警

- `sda`（40G SSD）放：OS、Docker 引擎与镜像、PG 数据（含 WAL）、Nginx。做法：
  - 容器日志一律 `json-file` 轮转（`max-size` 10~20m、`max-file` 3~5；ONLYOFFICE compose 已内建）；新写的 api / worker / PG / Nginx compose 一并照做；
  - 定期 `docker image prune`；部署前先 `docker system df` 盘一遍镜像占用；
  - **不要**把 docker data-root 整体挪到 HDD（PG 会跟着掉到机械盘）；40G 真放不下时：镜像改内网 registry 按需拉取 + 只保留在用版本，PG 数据卷显式 bind mount 回 sda。
- `sdb`（HDD）放：对象存储数据目录（MinIO 默认 docker volume 在系统盘，**必须改成 bind mount 落到 sdb**）、ONLYOFFICE 转换缓存挂卷（容器内 `App_Data/cache`）、PG 备份落点、（如启用）翻译模型文件；示例：`/srv/data/minio`、`/srv/data/onlyoffice-cache`、`/srv/data/backups/pg`（挂载点以实际为准）。
- 告警阈值：系统盘 75% / 85% 两档（系统盘满 = 数据库 + 服务同挂）；数据盘同档；告警进管理员告警群。
- 网络可达性两点（易漏）：① 对象存储 API 要能被浏览器直连（预签名直传；CORS 来源 = 生产站点域名）；② `ONLYOFFICE_DOCSERVER_URL` 必须是浏览器可达地址。

## 3. 部署前置检查单（未完成项）

**A. 仓库侧（px）**

- [ ] 应用栈部署件（进行中）：PostgreSQL + 迁移/种子工具已落地 `deploy/prod/`（postgres 18.6 双锁 + 文件密钥 + db-init + tools 容器；2026-10-13 服务器实测：47 个迁移 + 无漂移复跑、6 个种子 + 零变更复跑）；api / worker 已部署件落地并服务器实测启动（profiles: app / 非 root 降权 entrypoint / 依赖命名卷 / `server.env` 模板；2026-10-13 实测：容器均 healthy、`/healthz` 200 ok、`/readyz` 503 degraded 属预期——对象存储占位凭据）；web（Nginx）已落地并服务器实测（2026-10-14 TLS 接入：80 → 301、443 应用 + 对象存储同源门面 `/libiaolink/`、9443 MinIO 备用门面；ALLinSSL 自动下发 *.libiaorobot.com；SPA 产物已上线（2026-10-14））；对象存储（MinIO 本机自建）已落地并服务器实测（本地构建镜像 / 数据盘 bind；storage init + --check + it 24/24、readyz 200 全绿，2026-10-14）—— 生产门禁全项（容器非 root、镜像精确版本 + digest、迁移独立任务、Secrets 文件挂载、CPU / 内存 / pids 限额、连接池有界）
- [ ] 上线检查单、灰度与回滚预案正文（M8-04；本文件 §3 / §4 为骨架）
- [ ] 备份脚本：PG 每 12h 加密备份 → 数据盘 + 异地；对象存储每日增量异地同步
- [ ] 监控告警接线（§6）
- [ ] 镜像离线化：内网 registry 或 `docker save` 离线包（ONLYOFFICE `9.4.0.1` 按 digest、MinIO quay 镜像、PG、Node 基础镜像、Nginx）
- [ ] M5-03-5 单聊改智能机器人（绑定码链路）部署件：`deploy/prod/server.env.example` 已补 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（2026-10-16）；**待执行 = 迁移 `0055` + `server/dist` 重传 + `server.env` 回填 + `restart api worker` + BC-1 ~ BC-4 真机复跑**（项目组 2026-10-16 决定暂缓；先本地等价执行 —— 见 `docs/PoC-2-回放证据(企微通道).md` §七）

**B. 外部依赖（先发起，路径最长优先）**

- [ ] 正式环境 SSO 应用 `libiaolink` 创建（SSO 管理员）：组织 `libiaorobot.com`；Grant Types 仅 `authorization_code`；Token Format `JWT-Custom` 五字段；Redirect URL = 生产站点域名 + `/auth/callback`（精确到路径）；挂企微登录方式；Client Secret 只走密钥渠道（`docs/实测报告(SSO接入验证).md` §五）—— 进展（2026-10-14）：测试环境（authtest）应用 `LibiaoLink` 已按同一标准先行调整并接通（§7 #10 与《实测报告》§四）；正式环境应用仍未创建，本项待发起
- [x] 对象存储生产选型关闭（px + lan）—— 2026-10-14 关闭：选定**本机 MinIO 单节点**（ADR-013 画像；接口层只依赖 S3 协议，ADR-006 可替换绑定不变）；quay 下架应急 = GitHub Release 官方二进制（sha256 校验）+ 服务器本地构建镜像（`deploy/prod/minio/Dockerfile`）；关闭验收全绿：`storage:init` + `--check` 通过、`storage:it` 24/24、`readyz` 200（待 lan 复核）
- [ ] 企微群通道：各在用项目群「机器人进群 + 群内激活」（业务侧逐群；话术见依赖清单 §七）；如报白名单再补固定出口 IP；生产密钥注入渠道
- [x] 域名 / DNS / HTTPS 证书（内网域名也要）—— 2026-10-14：test-pm.libiaorobot.com → 10.1.104.44（测试）、pm.libiaorobot.com → 10.1.103.44（第二台接收端就绪）；证书 *.libiaorobot.com（DigiCert，至 2026-12-01）经 ALLinSSL SSH 自动下发（固定路径 /etc/ssl/libiaorobot.com.pem|.key + allinssl 重载白名单通道；续签自动覆盖并重载）
- [ ] 服务器 NTP 时间同步（SSO 令牌校验依赖时间）

**C. 服务器侧（部署日前）**

- [x] Docker + Compose；数据盘挂载与目录就位（§2）—— 2026-10-13：Docker 29.9.0 + Compose v5.6.0；`/srv/data` ext4（label `libiaolink-data`，noatime）
- [x] swap、日志轮转就位（§1 / §2）—— 2026-10-13：双 4G swap（`/swap.img` pri=100 + `/srv/data/swapfile` pri=20）+ `vm.swappiness=10`；daemon.json 日志轮转
- [x] PostgreSQL 容器 + 角色 + 迁移 + 种子就绪（§4 第 1 条前半）—— 2026-10-13 实测：容器 18.6 healthy（回环端口 / 限额）；三角色 + 密码注入；47 个迁移 + 无漂移复跑；6 个种子 + 零变更复跑
- [ ] 磁盘告警就位（§2）—— 未开始
- [ ] 生产 Secrets（文件挂载、不进 Git）：PG 密码 ✅（2026-10-13 已生成并注入三角色）、`INTERNAL_SYNC_TOKEN` ✅ / `OO_JWT_SECRET` ✅（均 2026-10-13 生成 hex32；OO 与 DocServer 同值待 ONLYOFFICE 切片核对）、Casdoor Client ID / Secret ✅ + `CASDOOR_ISSUER` ✅（均 2026-10-14 回填，测试环境 authtest；正式环境应用创建后替换）/ `CASDOOR_ORG_NAME=libiaorobot.com`、企微智能机器人 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`（群 + 单聊共用同一机器人；换机器人 = 换此二值）、S3 凭据 ✅（minio_root 同值；专用最小权限账号列待办）+ CORS 来源 ✅（`MINIO_API_CORS_ALLOW_ORIGIN` = https://test-pm.libiaorobot.com,http://10.1.104.44；2026-10-14 随 TLS 同步）
- [ ] 内网到公司 SSO / 企微 `qyapi.weixin.qq.com` 的连通复核 —— SSO 测试环境（authtest）连通已实测（2026-10-14：宿主 + api 容器直连正常）；企微待群通道切片复核

## 4. 部署日 Runbook（按序执行）

1. PostgreSQL ✅（2026-10-13 实测完成）：建库 + 最小权限角色（`database/roles/`）→ `node scripts/migrate.mjs`（0001~0047，独立任务，API 不自动迁移）→ `node scripts/seed.mjs`（roles / role-permissions / dicts / blueprint / task-nodes / task-templates）→ `npm run check:db-schema` 复算（随 server 切片补跑）—— 2026-10-13 实测已完成：db-init → 47 个迁移（无漂移复跑）→ 6 个种子（零变更复跑）；
2. 对象存储 ✅（2026-10-14 实测完成，本机 MinIO）：`npm run storage:init` →（建桶 + 版本控制 + 匿名拒绝 ✓；CORS / 分片清理按 MinIO 社区版能力面降级为告警——服务端 CORS 走 `MINIO_API_CORS_ALLOW_ORIGIN`、分片清理走内置 `stale_uploads_expiry`，属预期）→ `--check` 退出码 0 → `storage:it` 24/24 全绿（含预签名直传 host 可达断言）；故障处置：quay 镜像下架 → 官方二进制本地构建（镜像锚点 `sha256:165271c0…`）；`storage.sh` 补 `DATABASE_URL` 注入（server `loadEnv` 校验前置）；
3. api / worker 起进程（`dist` 产物；worker 可用 `--health-check` 一次性探针）→ `/healthz`、`/readyz` 通过 —— 2026-10-13 实测：api / worker 均 (healthy)；`/healthz` → 200 `{"status":"ok"}`；`/readyz` → 503 `status:degraded`（`object-storage:head-bucket` 探针失败：占位凭据，属预期，随对象存储切片转 ok）；worker heartbeat 正常；故障处置两笔：① scp 权限畸形（`drwx---rwx`，容器报 `Cannot find module`）→ `chmod -R a+rX` 修复；② `shared` dist 运行时引用 devDependency（`@asteasolutions/zod-to-openapi` 缺包）→ `npm ci --include=dev` 重装 `shared` 依赖；
4. ONLYOFFICE：起容器 → 入口自检 + 升级回归五项：① `blockPrivateIP=false` ② `outbox=true` ③ 中文字体 ④ 受控端点无 token 401 基线 ⑤ `/example/` 网关侧不可达；
5. Nginx 上线：TLS、SPA 静态（`frontend` build 产物）、反代 `/api/v1`、`/auth`、`/healthz`、`/readyz`；受控预览端点仅 DocServer 网段可达、公网 404；`/example/` 不暴露；Nginx 是唯一对外端口 —— 2026-10-13 实测（HTTP 先行）：web (healthy)；经反代 `/nginx-health` ok、`/healthz` 200、`/readyz` 503 degraded（存储占位，与 api 直连口径一致）、`/` 404（SPA 未传输）；配置修正：`try_files` 末项补 `=404`（缺省内部重定向环 → 500）；→ 2026-10-14 TLS 接入实测：80 → 301（IP 访问一并收口到域名）、443 证书链校验通过（无 `-k` 请求 200；SAN 匹配 test-pm）、`/nginx-health` ok / `/healthz` 200 / `/readyz` 200 全绿、9443 MinIO https 门面预签名回放 24/24（host 断言 test-pm.libiaorobot.com:9443）、5 容器 healthy；2026-10-14 对象存储改同源 443 门面（客户端网络仅放行 22/80/443，9443 / 9000 实测被拦）：443 增 `location /libiaolink/`（= 桶名；`proxy_pass` 不重写 / `Host $http_host` 保 SigV4）、`S3_ENDPOINT` 去端口；`storage:it` 24/24 + 开发机真实网络预签名 PUT 200 / GET 200 字节一致 / DELETE 204 / 删后 404；SPA 产物已上线（2026-10-14：站点根 200 / SPA 路由兜底 200 / wasm `application/wasm`）；2026-10-14 追加：nginx 以 `resolver` + `upstream … resolve` 动态跟踪容器 IP（api / minio 重建后不再需要 `restart web`；重建回归通过）；
6. 冒烟：SSO 登录 → 首页 / 项目空间 → 上传（分片直传 → 完成）→ 预览（Office / PDF / 图片）→ 企微群一条消息 —— SSO 测试环境已接通（2026-10-14：`/auth/login` 302 → authtest 授权页；浏览器全流程人工实测进行中）；
7. 收口：`PERMISSION_ENFORCED=false`（一期口径）、`SESSION_COOKIE_SECURE=auto`（生产自动 Secure）；发布按 CONTRIBUTING §16（标签指向全绿主干）；值班按 `团队分工.md` §7。
8. M5-03-5 智能机器人单聊（绑定码链路）**待执行**（项目组 2026-10-16 决定暂缓）：**先备份 PG** → `bash scripts/db-migrate.sh`（执行 `0055`；含不可回滚清理）→ 复跑「无漂移」→ 重传 `server/dist` → `server.env` 回填 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` → `docker compose --profile app restart api worker` → 真机复跑 BC-1 ~ BC-4（取码 → 单聊发码绑定 → 绑定后送达 → 未绑定 / 换机器人降级）。

## 5. 备份与恢复口径（ADR-013）

| 项 | 口径 |
|---|---|
| PG 备份 | 每 12 小时加密备份 → 数据盘 + 异地；RPO ≤ 24h / RTO ≤ 2h（以实测校准） |
| 文件备份 | 每日增量异地同步（数据盘单盘无冗余，异地是唯一退路） |
| 恢复演练 | 每月一次（ADR-013）；每季度至少一次两人会操（v0.3 §3.9）；记录进部署日志 |
| 上线前 | 先做一次空库迁移演练 + 一次恢复演练（M8 出口标准） |

## 6. 监控与告警清单（M8-03）

- 磁盘：`/` 75% / 85%、`/srv/data` 同档；
- 内存 / swap：可用内存下限、swap 使用抬头；
- 容器：重启、OOM、healthcheck 失败（ONLYOFFICE / PG / 对象存储 / api / worker）；
- 业务：outbox 积压与死信、预览转换失败、企微投递失败、`job_runs` 异常；
- 路由：管理员告警群（已建）；归属按 `团队分工.md` §7（px 服务 / 部署、lan 数据 / 投递、wmj 领域逻辑）。

## 7. 待办与归属

| # | 事项 | 主责 | 状态 |
|---|---|---|---|
| 1 | 应用栈部署件（api / worker / PG / Nginx） | px | 进行中：PG + 迁移/种子工具（tools）✅ 服务器实测（47 迁移无漂移 / 6 种子零变更）；api / worker ✅ 服务器实测（均 healthy、`/healthz` ok、`/readyz` 503-degraded 属预期）；web（Nginx）✅ 服务器实测（TLS 接入：80 → 301 / 443 应用 + 对象存储同源门面 `/libiaolink/` / 9443 备用门面；SPA 产物已上线）；minio ✅ 服务器实测（healthy / api→minio 200 / storage init+check+it 24/24 / readyz 200 全绿） |
| 2 | 上线检查单 / 灰度 / 回滚预案正文（M8-04） | px | 本文件 §3 / §4 为骨架 |
| 3 | 备份 / 恢复脚本 + 首次演练 | px（lan 复核） | 未开始 |
| 4 | 正式环境 SSO 应用创建 | SSO 管理员 | 未发起 |
| 5 | 对象存储生产选型关闭 | px + lan | ✅ 已关闭（2026-10-14）：本机 MinIO 单节点（本地构建镜像）；`storage:init --check` + `storage:it` 24/24 + `readyz` 全绿；待 lan 复核 |
| 6 | 企微各项目群接入 | 业务侧 | 待执行 |
| 7 | 内存扩容（12G → 16G） | px | 观察项（暂不扩容） |
| 8 | `shared` 打包缺陷：`@asteasolutions/zod-to-openapi` 被 dist 运行时引用、却声明为 devDependency | wmj（契约包；px 记录） | 待修：服务器已以 `npm ci --include=dev` 绕行；修复 = 移入 `dependencies` + 重生成 `shared` / `server` 两处 lock，此后部署收回 `--omit=dev` |
| 9 | Nginx 硬化 / TLS 切片（443 + 证书挂载；`/internal/**`、`/example/` 显式 404；SPA 产物上线） | px | 接近关闭（2026-10-14）：TLS 接入 ✅ + SPA 产物上线 ✅；剩余：`/internal/**`、`/example/` 显式 404 加固 |
| 10 | SSO 测试环境对接（authtest 应用 → 104.44 测试环境） | px | ✅ 2026-10-14：应用按接入标准调整（回调 / grant / 字段）+ 服务器回填 + `/auth/login` 302 实测；浏览器全流程人工实测进行中 |
| 11 | M5-03-5 智能机器人单聊（绑定码链路）部署：迁移 `0055` + `server/dist` + `server.env` 新机器人凭据 + 重启 api / worker + BC-1 ~ BC-4 真机复跑 | px（lan 协办：迁移包 / 构建件 / 证据） | 待执行（项目组 2026-10-16 决定暂缓；先本地等价执行） |

## 8. 变更记录

| 版本 | 日期 | 变更 | 人 |
|---|---|---|---|
| v1.0 | 2026-10-13 | 首版：服务器现状锚定（8C12G / sda 40G SSD / sdb HDD）；12G 内存预算；磁盘分工与告警；部署前置检查单（仓库 / 外部 / 服务器）；部署日 Runbook；备份与恢复；监控告警；待办归属 | px |
| v1.1 | 2026-10-13 | 现状补录：Ubuntu 26.04 LTS / 系统盘 40G `ssd-pool01` / 数据盘 300G `hdd-pool01` / 内网 IP 10.1.104.44（VLAN 1104） | px |
| v1.2 | 2026-10-13 | 系统基础落地：Ubuntu 26.04 桌面版（主机名 libiao-vm）；数据盘 300G 格式化挂载 `/srv/data`（ext4 label `libiaolink-data`）；双 swap（pri 100/20）+ swappiness=10；Docker 29.9.0 + Compose v5.6.0 + daemon.json 日志轮转；新增生产部署件 `deploy/prod/`（postgres 18.6 双锁 + 文件密钥 + db-init 脚本） | px |
| v1.3 | 2026-10-13 | 数据库切片收口：部署件增 tools 容器（node 24 双锁 / 一次性 profile / 依赖命名卷）+ `db-migrate.sh` / `db-seed.sh`；服务器实测 47 个迁移（无漂移复跑）、6 个种子（零变更复跑）；修复 compose 挂载相对路径（`../../database`） | px |
| v1.4 | 2026-10-13 | 应用栈部署件就绪：`deploy/prod/` 增 api / worker（profiles: app；node 24 双锁；service-entrypoint.cjs 降权非 root + secrets 注入 + DATABASE_URL 组装 + 信号转发，本地实测通过）+ `server.env.example` + server / shared 依赖命名卷；外部依赖（SSO / 对象存储）以占位密钥先行，回填后替换 | px |
| v1.5 | 2026-10-13 | api / worker 切片收口：服务器实测启动通过（均 healthy；`/healthz` 200 ok；`/readyz` 503 degraded 属预期——对象存储占位；worker heartbeat 正常）；故障处置两笔：scp 传输致目录权限畸形 → `chmod -R a+rX`；`shared` dist 运行时引用 devDependency（zod-to-openapi）→ `npm ci --include=dev` 绕行（§7 待办 #8 挂 wmj 线）；§3-A / §4 第 3 条同步更新 | px |
| v1.6 | 2026-10-13 | web（Nginx）切片收口：compose 增 web（唯一对外端口 80 / SPA 挂载 / 反代 / healthcheck / 镜像双锁 `nginx:1.30.5-alpine@sha256:0985e772…`）；`nginx/libiaolink.conf`（HTTP 先行 + TLS 模板注释；`/internal/**` 不对外）；服务器实测 `/nginx-health` ok / `/healthz` 200 / `/readyz` 503（存储占位）/ `/` 404（SPA 未传）；修正 `try_files` 内部重定向环（补 `=404`）；§7 增待办 #9（Nginx 硬化 / TLS） | px |
| v1.7 | 2026-10-14 | MinIO 切片收口：quay 2026-10-13 实测下架（匿名 401 / $disabled；官方分发 410 / Docker Hub 无）→ GitHub Release 官方二进制（sha256 校验）+ `deploy/prod/minio/Dockerfile`（alpine 3.24 双锁）服务器本地构建 `libiaolink/minio:RELEASE.2025-09-07T16-13-09Z`（镜像锚点 `sha256:165271c0…`）；compose minio（数据盘 bind / 9000 局域网 + 9001 回环 / busybox wget healthcheck）；服务器实测：minio healthy、api→minio 200、`storage.sh init` + `--check` 通过、`it` 24/24、`readyz` 200 全绿；初试 Docker Hub auth 抖动（connection reset）→ 拉取重试成功；§3-B / §4-2 / §7 同步（#5 关闭） | px |
| v1.8 | 2026-10-14 | TLS 切片收口（104.44）：域名 test-pm.libiaorobot.com；ALLinSSL SSH 自动下发 *.libiaorobot.com（固定 /etc/ssl/ 路径 + allinssl 重载白名单通道；第二台 10.1.103.44 接收端同步就绪）；nginx 80 → 301 / 443 应用 / 9443 MinIO https 门面（Host 原样透传保 SigV4）；server.env S3 段切 https://test-pm.libiaorobot.com:9443、MINIO_CORS_ALLOW_ORIGIN 同步；服务器实测：证书链 200（无 -k）· /readyz 200 · storage:it 24/24（host 断言 9443）· 5 容器 healthy；§3-B / §4-5 / §7 同步（#9 部分关闭） | px |
| v1.9 | 2026-10-14 | SPA 产物上线：`frontend/dist`（10 文件 / 9.3MB，构建 2026-10-13 21:21）传到 `/opt/libiaolink/frontend/dist`；scp 目录权限畸形（707）→ `chmod -R u=rwX,go=rX` 修正（二次踩坑，步骤已固化入 `deploy/prod/README.md` §8）；实测：站点根 200（index.html）/ JS·CSS·SVG 200 / wasm 200（`application/wasm`）/ SPA 路由兜底 200；#9 接近关闭 | px |
| v1.10 | 2026-10-14 | SSO 切片（测试环境接通）：authtest 应用 `LibiaoLink` 按接入标准调整（redirect 追加 test-pm 回调 / 仅 `authorization_code` / `JWT-Custom` 五字段）；服务器回填 `casdoor_client_id` / `casdoor_client_secret` + `CASDOOR_ISSUER=https://authtest.libiaorobot.com` / `CASDOOR_REDIRECT_URI=https://test-pm.libiaorobot.com/auth/callback`；实测 `/auth/login` 302 → authtest 授权页（PKCE S256）· `/readyz` 200 · 5 容器 healthy；nginx 修复「api / minio 重建换 IP 后 502」→ `upstream … resolve` 动态解析（重建回归通过）；§3-B / §4-5 / §4-6 / §7 同步 | px |
| v1.11 | 2026-10-14 | SPA 产物更新部署（Push 304：「已有项目地区」按项目落库值聚合修复）：frontend/dist 重建 → tar 上传解包 + 权限 u=rwX,go=rX；实测站点根 200 / 新 JS 200 / /healthz 200 / /readyz 200（与 deploy/prod/README.md v1.11 对齐） | px |
| v1.12 | 2026-10-14 | 部署口径补录：测试机登录与运维口径（10.1.104.44 / test-pm.libiaorobot.com；登录口令不落仓库 + 本机未跟踪备忘；服务器只跑不改）进 AGENTS.md「服务器与运维（测试机）」与 deploy/prod/README.md §1.1（与 deploy/prod/README.md v1.12 对齐） | px |
| v1.13 | 2026-10-14 | 对象存储改「443 同源门面」修上传 / 预览断链：根因 = 客户端网络仅放行 22/80/443（9443 / 9000 实测被拦；API 侧 201/200 正常、浏览器预签名 PUT/GET 超时）→ 443 增 location /libiaolink/（= 桶名；proxy_pass 不重写 / Host $http_host 保 SigV4）、S3_ENDPOINT 去端口；storage:it 24/24 + 开发机真实网络预签名 PUT/GET/DELETE 全绿；9443 保留内网备用门面；§3 / §4 / §7 同步 | px |
| v1.14 | 2026-10-16 | M5-03-5 智能机器人单聊（绑定码链路）部署登记：§3-A 补仓库侧待执行项（`server.env.example` 已补新机器人凭据）；§3-C Secrets 口径改「群 + 单聊共用同一机器人」；§4 增第 8 步（备份 → `0055` → dist 重传 → 凭据 → 重启 → BC-1 ~ BC-4）；§7 增 #11；与 `deploy/prod/README.md` §6 / §7 / §10 同步 | px（lan 代记） |