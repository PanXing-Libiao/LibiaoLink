# ONLYOFFICE 文档服务器部署（S2 · deploy/onlyoffice）

> 归属：px（部署 / 交付）· 2026-09-30。唯一执行口径：docs/ONLYOFFICE替换执行计划(Office预览).md；本目录按其 S2（部署清单 + 回滚步骤 + 升级回归项）交付，配置口径来源 docs/PoC-10-部署前置定稿(F1-R3·R6).md（N3）。
> 决策依据：ADR-030（Office 预览改由 ONLYOFFICE 承接）· 决策 D2 = 镜像 pin `onlyoffice/documentserver:9.4.0.1`（digest 固化见 Dockerfile）。

## 0. 文件一览

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 基座 pin（digest）+ 中文字体（构建期注册 + 断言）+ 入口包装/自检挂载 |
| `docker-compose.yml` | dev 沙箱形态（dev 端口回环 / 资源限额 / 健康检查 / 独立网络） |
| `docker-compose.prod.yml` | 生产形态编排（测试机：不发布公网端口 / 挂 `libiaolink-prod`(external) / 8001 回环排障 / 镜像离线下发） |
| `service/entrypoint.sh` | 入口包装：原入口 → 等就绪 → 固化 local.json（F1/R3）→ 只重启 `ds:docservice` → 自检 → 守候 |
| `service/selfcheck.sh` | 启动后自检（配置三键 / 中文字体 / 示例 app 关闭）；同时用作 healthcheck |
| `.env.example` | 环境变量示例（唯一秘密 = `OO_JWT_SECRET`，生成方式见文件内注释） |

## 1. 部署清单（生产形态）

### 1.1 拓扑与链路

- 浏览器 → 网关（内网入口）→ DocServer（本镜像）；DocServer → 本仓 API `/api/v1/files/{id}/versions/{versionId}/preview-content`（服务间 `Bearer JWT`，`outbox=true`）；API → 对象存储（S3 SDK 流式读取，**不预签名**）。用户下载链独立（`download-url` 预签名 + `file.download` + download 审计），不在本目录范围。
- 预览链**全程无预签名**（安全定稿 R1/R2 不变量）；受控端点不进外网入口（S2 网关规则 + S3 实现）。

### 1.2 固化配置键（定稿 §1.2）

| 键（`services.CoAuthoring.*`） | 值 | 落地方式 |
|---|---|---|
| `externalRequest.action.blockPrivateIP` | `false` | 入口包装在**容器启动后**写 `local.json` + 只重启 `ds:docservice`（F3：entrypoint 每次启动会重写 `token.enable.request.*`，故不得在启动前改、不得手工改容器） |
| `request-filtering-agent.allowPrivateIPAddress` | `true` | 同上（与上键同批固化） |
| `token.enable.request.outbox` | `true`（期望态） | 同上（`JWT_ENABLED=true` 时原 entrypoint 亦会写 true；本包装幂等重放兜底） |

环境变量（compose 注入）：`JWT_ENABLED=true`、`JWT_SECRET=…`（受控注入，按 CONTRIBUTING §12；与 API 侧 `ONLYOFFICE_JWT_SECRET` 同值）、`JWT_HEADER=Authorization`、`GENERATE_FONTS=false`（字体已在构建期注册）、`EXAMPLE_ENABLED=false`。

### 1.3 字体（C 组）

- 构建期装 `fonts-noto-cjk`（Noto Sans CJK SC）+ 跑 `documentserver-generate-allfonts.sh`；
- 构建期断言：`fc-list :lang=zh` ≥ 1 且 `AllFonts.js` 含 `Noto Sans CJK SC` —— 不通过直接构建失败；
- 运行期自检复验同两项（防镜像/数据卷漂移）。

### 1.4 网络与网关（含 R6 / D1）

- DocServer 需可达 API 端点（内网）；dev 沙箱用 `docker network connect libiaolink-onlyoffice-internal <s3 容器>` 接线；
- 网关（生产）：**不暴露** `/example/`；受控预览端点仅 DocServer 网段可达、公网 404（S3 上线后生效）；
- 示例 app（`ds:example`）保持默认关闭：不得为排障等目的在生产打开。

### 1.5 资源与容量

- 默认 2C4G（首关沙箱口径；`OO_MEM_LIMIT` / `OO_CPUS` 可调）；生产容量按 ADR-013 容量档评估后调整。

### 1.6 安全基线

- **callback 校验**：查看模式（`mode=view`）不产生编辑回调，本期不配置 callback；若将来启用任何编辑形态，必须：回调 JWT 校验（inbox）+ 来源白名单 + 独立评审（不得静默打开）。
- **缓存盘清理**：转换/预览缓存位于 `/var/lib/onlyoffice/documentserver/App_Data/cache`（生产建议挂卷）。巡检项：目录体积与文件年龄；建议 cron 清理 7 天以上缓存（`find … -type f -mtime +7 -delete`），大促/升级前手动核对；清理不影响已签发会话（缓存按需重建）。
- **CVE 升级路径**：镜像 pin（tag + digest）→ 关注 ONLYOFFICE 安全公告与 Dependabot 提示 → 评估版本 → 更新 Dockerfile `FROM` + `OO_TAG` → 重建 → 跑 §2 回归五项 → 台账登记（§5）；异常回滚 §3。

## 2. 升级 / 重建回归清单（五项 · 每次升级或重建后必查）

| # | 检查 | 方法（dev 沙箱口径） | 通过判据 |
|---|---|---|---|
| ① | blockPrivateIP=false 生效 | DocServer 实际拉取内网地址（见 §4 行为探针）；或盒子内 `curl` 内网地址 | 拉取 200 / 转换出结果（不得 400 onError -4） |
| ② | outbox=true | 容器 `local.json` 读值；拉取探针服务观察 `Authorization: Bearer` | true 且 Bearer 附加（本目录 §4 实测：auth=yes） |
| ③ | 中文字体 | `docker compose exec docs fc-list :lang=zh` + `AllFonts.js` 断言（selfcheck 已含） | 字体在位、无乱码（N1 样本冷开） |
| ④ | 受控端点 401 基线 | 无 token / 篡改 token 打 `/preview-content`（S3 上线后） | 401（N2 §7 C4）；S3 前以 JWT 拒绝基线代替（无 token 拒 / 形状错拒） |
| ⑤ | 示例 app 关闭 | 网关侧 `GET /example/` 非 200；直连容器 502（关闭态） | 不出现示例页面 / 文档会话 |

> 回归留痕：结果记部署日志（升级记录）；异常即回滚上次可用镜像（§3）。

## 3. 回滚步骤

1. **记录现场**：版本 / digest、症状、§2 五项结果、日志（`docker compose logs docs` 与文档服务器日志目录）。
2. **停服**：`docker compose down`（数据卷按需保留）。
3. **回退镜像**：按 §5 台账选上次可用 tag/digest → 改 `Dockerfile` `FROM` + `OO_TAG` → `docker compose build` → `docker compose up -d`。
4. **验证**：跑 §2 回归五项（含入口包装自检输出）；仍异常 → 继续向上一版回退。
5. **配置回滚**：如本次升级伴随 API / 网关 / 密钥变更，联动回退（`OO_JWT_SECRET` 轮换须与 API 同批，否则预览 fail-closed 401）。
6. **留痕**：部署日志 + 开发日志（本仓约定）。

## 4. dev 沙箱用法与实测记录（2026-09-30）

### 4.1 起沙箱

```bash
cp .env.example .env    # 填 OO_JWT_SECRET（生成见文件注释）
docker compose build    # 构建期：装字体 + 生成 AllFonts + 断言（digest pin 校验）
docker compose up -d
docker compose logs docs | grep "[libiaolink"           # 入口包装 + 自检
docker compose exec docs /usr/local/bin/libiaolink-selfcheck.sh
```

dev 沙箱接线（供 S3 联调）：`docker network connect libiaolink-onlyoffice-internal libiaolink-s3`。

### 4.2 实测结果（2026-09-30 · 本机 Docker 29.7.2）

| 项 | 命令 / 方法 | 结果 |
|---|---|---|
| 镜像 | `docker compose build` | 成功；digest pin `sha256:3ab6ebc7…c88212`（与 D2 一致）；构建期字体断言过 |
| 启动与自检 | `docker compose logs docs` | 包装序列全绿：首次就绪 → 固化 → 重启 ds:docservice → 二次就绪 → 自检 PASS → 守候 |
| 配置三键 | selfcheck | `blockPrivateIP=False allowPrivateIPAddress=True request.outbox=True` |
| 中文字体 | selfcheck | `fc-list :lang=zh` = 30 条；`AllFonts.js` 含 Noto Sans CJK SC |
| 示例 app | 主机侧 `GET :8001/example/` | **502** `Test example is not running`（关闭态合规）；`/healthcheck` = 200 |
| 私有 IP 拉取（①） | /converter 行为探针（见下） | DocServer 从 `http://oo-probe:8080`（172.22.0.3）拉取并转换出 **314,223 字节 PDF**（magic `%PDF-`） |
| outbox Bearer（②） | 探针服务日志 | DocServer 拉取请求带 `Authorization: Bearer`（223 字节）→ outbox=true 生效 |
| JWT 拒绝基线（④ 前置） | 无 token / 形状错 token | 无 token → `{"error":-8}`；形状错 → `{"error":-7}`（均拒绝） |
| 重启持久性 | `docker compose restart docs` | 包装自动重放配置 → selfcheck 再次 PASS、容器 healthy（**无人工干预**，F3 对策成立） |

行为探针说明（S5 复测可复用）：起一个内网探针 HTTP 服务（`python3 -m http.server` 变体，日志记录 `Authorization` 有无）挂到沙箱网络，用 Node 以 `OO_JWT_SECRET` 签发 HS256 token 调 DocServer `POST /converter`（载荷 = 请求体含 url；实测仅 `{url}` 形状被拒 —— 9.4 要求 token 载荷与请求参数一致），随后取回 `fileUrl` 验证 PDF 字节。

## 5. 镜像台账

| tag | base | digest（base） | 构建日期 | 说明 / 决策 |
|---|---|---|---|---|
| `libiaolink/onlyoffice-docs:9.4.0.1` | `onlyoffice/documentserver:9.4.0.1` | `sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212` | 2026-09-30 | S2 首版；D2（回退规则 9.3.1.2 未触发） |

## 6. 生产部署（测试机 10.1.104.44 · 2026-10-14 上线）

> 归位：本切片 = §2「升级 / 重建回归清单五项」的生产落地 + 网关形态定稿（443 子路径 `/onlyoffice/`）；决策来源 ADR-030 / N3 定稿（F1/R3/R6）。

### 6.1 形态

- **编排**：`docker-compose.prod.yml`（独立 compose 项目 `libiaolink-onlyoffice`；容器 `libiaolink-onlyoffice-docs` 挂 `libiaolink-prod`（external））：① web（nginx）以 443 子路径 `/onlyoffice/` 反代；② DS 解析 `api:3000` 拉受控预览端点；不发布公网端口（8001 仅回环排障）。
- **镜像离线下发**：服务器无外网（`registry-1.docker.io` 实测 000）→ 开发机 `docker save libiaolink/onlyoffice-docs:9.4.0.1`（1.7GB）→ `scp` → 服务器 `docker load`；离线归档留存 `/srv/data/images/oo_docs_9.4.0.1.tar`。
- **密钥**：服务器 `.env`（600）`OO_JWT_SECRET` = 宿主 `deploy/prod/secrets/onlyoffice_jwt_secret`（**与 api 进程 `ONLYOFFICE_JWT_SECRET` 同值不变量**）。
- **API 接线（deploy/prod/server.env）**：`ONLYOFFICE_DOCSERVER_URL=https://test-pm.libiaorobot.com/onlyoffice`（浏览器可见地址）；`ONLYOFFICE_DOCSERVER_API_BASE_URL=http://api:3000`（DocServer 拉取地址 = 受控端点 URL 绑定基准）。
- **nginx 门面（deploy/prod/nginx/libiaolink.conf）**：`location /onlyoffice/`（`proxy_pass http://onlyoffice_backend/` 去前缀 + `X-Forwarded-Prefix /onlyoffice` + `X-Forwarded-Host` + Upgrade 透传 —— DS 9.4 子路径原生支持，浏览器侧重定向与资源全带前缀）；`location = /onlyoffice/example/` 恒 404（R6）；`upstream onlyoffice_backend … resolve` 跟随容器重建。

### 6.2 上线动作（2026-10-14）

```bash
# 开发机：导镜像
docker save -o oo_docs_9.4.0.1.tar libiaolink/onlyoffice-docs:9.4.0.1
scp oo_docs_9.4.0.1.tar root@10.1.104.44:/srv/data/images/
# 服务器：装镜像 + 起容器 + 自检
cd /opt/libiaolink/deploy/onlyoffice
docker load -i /srv/data/images/oo_docs_9.4.0.1.tar
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec docs /usr/local/bin/libiaolink-selfcheck.sh   # PASS
# 服务器：网关接线（conf 已备份 libiaolink.conf.bak-oo-20261014）
cd /opt/libiaolink/deploy/prod && cp server.env server.env.bak-oo-20261014   # 已留
docker compose --profile app up -d --force-recreate api web
```

### 6.3 实测记录（上线同批 · 开发机经 443 复验）

| 项 | 结果 |
|---|---|
| 容器 | `libiaolink-onlyoffice-docs` healthy；入口包装全序（首次就绪 → 固化三键 → 重启 ds:docservice → 二次就绪 → 自检 PASS → 守候） |
| ① ② ③（回归五项） | 自检三键 `blockPrivateIP=False allowPrivateIPAddress=True request.outbox=True`；中文字体 30 条 + AllFonts 含 Noto Sans CJK SC；示例 app 关闭（内部 `/example/` 502 合规） |
| 门面行为 | `api.js` 200 · `/onlyoffice/` 302 → `/onlyoffice/welcome/`（前缀保留）· `/onlyoffice/example/` 404（门面口径）· `/healthz` 200 · `/readyz` 200 · 站点根 200 |
| 服务间 | DS → `http://api:3000/healthz` 200；web → DS `/healthcheck` = true |
| 密钥同值 | 宿主 secret / DS `JWT_SECRET` / api 进程 `ONLYOFFICE_JWT_SECRET` 前缀一致（121bcf20…） |
| ④ 受控端点基线 | 匿名直打 `…/preview-content`（经 443）→ 401 |
| 端到端（真实文件） | 64MB xlsx（内容哈希为 key · 受控端点 + HS256 查看器 token）经 443 全链渲染 **ready**：0 失败请求 / 0 console 错误；WSS Upgrade 探针 → **101** |
| ⑤ 示例 app | 门面 404 + DS 内 502 双口径 |

### 6.4 回滚

1. 停 DS：`cd /opt/libiaolink/deploy/onlyoffice && docker compose -f docker-compose.prod.yml down`；
2. 撤门面：`cd /opt/libiaolink/deploy/prod && cp nginx/libiaolink.conf.bak-oo-20261014 nginx/libiaolink.conf && docker compose --profile app up -d --force-recreate web`；
3. 撤 API 接线：`cp server.env.bak-oo-20261014 server.env && docker compose --profile app up -d --force-recreate api`（回占位 URL，预览 fail-closed 降级「请下载」）。

（升级 / 重建回归五项与缓存巡检口径仍以 §2 为准；每次升级 / 重建后按 §6.3 表格复核。）

## 7. 变更记录

| 版本 | 日期 | 变更 | 人 |
|---|---|---|---|
| v1.0 | 2026-09-30 | 首版：部署清单（配置键 / 字体 / 网络网关 / 安全基线）+ 升级回归五项 + 回滚步骤 + dev 沙箱实测记录 + 镜像台账 | px |
| v1.1 | 2026-10-14 | 生产部署上线（测试机 10.1.104.44）：离线镜像下发（save/load）+ 生产编排 + 443 子路径 /onlyoffice/ 网关 + 密钥同值接线 + 回归五项与端到端实测（64MB xlsx 渲染 / WS 101 / 匿名 401）；新增 §6 | px |
