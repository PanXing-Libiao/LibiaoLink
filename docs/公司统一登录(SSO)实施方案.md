# 公司统一登录（SSO）实施方案 · 基于 Casdoor

> 基线：Casdoor **v4.4.0**（2026-09-15 对照官方仓库 master 核对）
> 适用：LibiaoLink 及公司内需要统一账号的业务系统
> 本仓库配套产物：`deploy/casdoor/`（本地联调部署）、`docs/本地沙箱(LibiaoLink 演练环境).md`（沙箱现状）、`docs/开发者接入注意事项(SSO接入标准).md`（接入标准）、
> `docs/企业微信(WeCom)对接指南.md`（企微对接）、`docs/实测报告(SSO接入验证).md`（实测记录）

---

> **前提（2026-09-15 更新）**：公司**已经在运行** Casdoor —— 正式 `https://auth.libiaorobot.com`（公网）、测试 `https://authtest.libiaorobot.com`（仅内网，管理员 `admintest`）。
> 业务应用与用户统一建在组织 `libiaorobot.com` 下（`built-in` 只做管理、不要改；`casbin` 仅用于复现 Bug）。
> 因此**接入方一般不需要自己部署 Casdoor**：本文第一、二章的部署内容用于「本地联调 / 灾备自建」，各业务系统实际只需要走第四章及之后的应用接入流程。

## 一、先定 3 件事

Casdoor 是**自托管身份中心（IAM）**：自己存用户、签发令牌、提供管理后台，并同时对外提供 OAuth 2.0 / OIDC、SAML 2.0、CAS、LDAP、SCIM 2.0 协议。它既能当"公司唯一账号库"，也能当"对接现有账号体系的中间层"。

| 决策点 | 可选项 | 影响的配置 |
|---|---|---|
| ① 账号以谁为准 | A 以 Casdoor 为主库 / B 沿用公司 AD·LDAP / C 联合登录（企业微信、钉钉、飞书、Entra ID） | 用户从哪来：自建注册 vs LDAP 认证 vs Sync 同步 vs 第三方登录 |
| ② 系统怎么接 | OIDC / SAML / CAS / LDAP | 每个系统在 Casdoor 里是一个 Application |
| ③ 部署在哪 | 公网域名 / 仅内网 | origin、HTTPS、静态资源地址、是否能拉第三方接口 |

**推荐的起步组合**：Casdoor 作为统一账号库 + 用企业微信/钉钉/飞书做联合登录源 + 业务系统统一走 OIDC。
AD/LDAP 先只做认证源（provider），跑通后再开定时同步（sync），避免一上来就动主数据。

---

## 二、总体架构

```
                  ┌──────────────────────────────┐
   员工浏览器  ──▶ │  业务系统（LibiaoLink / OA /  │
                  │  Jenkins / Grafana / GitLab…） │
                  └──────────────┬───────────────┘
                                 │ ① 未登录 → 跳到 Casdoor 授权页
                                 │ ④ 带 code 回调 → 后端换 token → 取 userinfo
                                 ▼
                  ┌──────────────────────────────┐
                  │        Casdoor（SSO 中心）     │
                  │  应用 / 组织 / 角色 / 权限      │
                  │  OIDC·SAML·CAS·LDAP·SCIM      │
                  └──────────────┬───────────────┘
                                 │ ② 账号来源（可多选）
        ┌────────────────┬───────┴────────┬──────────────────┐
        ▼                ▼                ▼                  ▼
   本地账号库        公司 AD / LDAP    企业微信·钉钉·飞书    Entra ID / Okta
   （Casdoor 自带）   认证源或定时同步    扫码登录（OAuth）     联邦（OIDC/SAML）
```

关键点：**员工密码只交给 Casdoor**。业务系统不再存密码，只存"这个用户是谁 + 有什么角色"。

---

## 三、第一步：把 Casdoor 跑起来

### 3.1 前置条件

- 一台 Linux 服务器（生产建议 2C4G 起，磁盘按日志量给）
- Docker + Docker Compose v2
- 一个域名，例如 `auth.libiaorobot.com`，并准备好 HTTPS 证书
- 数据库：MySQL 8 / PostgreSQL（生产不要用 SQLite）
- Redis：**可选，但多副本必须用**（会话、缓存）

### 3.2 启动（本仓库已备好 compose）

```bash
cd deploy/casdoor
cp .env.example .env        # 修改域名与数据库密码
docker compose up -d
docker compose logs -f casdoor
```

默认监听 `8000`（HTTP）、`389/636`（LDAP/LDAPS）、`1812`（RADIUS）。首次启动会自动建表：
入口命令带 `--createDatabase=true`，不需要手工导 SQL。

### 3.3 首次登录

打开 `http://服务器IP:8000`，用内置账号登录：

| 字段 | 值 |
|---|---|
| Organization | `built-in` |
| Username | `admin` |
| Password | 见本地 `deploy/casdoor/.env.local` 的 `CASDOOR_ADMIN_PASSWORD`（本地联调自备；正式环境由 SSO 管理员维护） |

> 登录页的"组织"和"用户名"是两个独立输入框，文档里写作 `built-in/admin` 只是简写。

### 3.4 上线前必改的 6 项（漏一项都算事故）

1. **改 admin 密码**，并开启 MFA / WebAuthn。
2. `origin` 设为对外域名（`https://auth.libiaorobot.com`），否则拼出来的回调地址是错的。
3. `runmode=prod`、`showSql=false`。
4. 只走 HTTPS，HTTP 强制 301；证书用正式的。
5. 数据库密码、ClientSecret、证书私钥**不进 Git**，用环境变量或密钥管理注入。
6. 配置数据库定时备份 + **做一次恢复演练**。

### 3.5 Nginx 反向代理（要点）

```nginx
server {
    listen 443 ssl http2;
    server_name auth.libiaorobot.com;

    ssl_certificate     /etc/nginx/certs/sso.crt;
    ssl_certificate_key /etc/nginx/certs/sso.key;

    client_max_body_size 50m;          # 头像/附件上传

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}

server {                                # HTTP 全量跳 HTTPS
    listen 80;
    server_name auth.libiaorobot.com;
    return 301 https://$host$request_uri;
}
```

### 3.6 备份与升级

- 备份：`mysqldump` 每日全量 + binlog；同时备份 `deploy/casdoor/files`（上传的 Logo/附件）。
- 升级：**固定镜像版本号**（例如 `casbin/casdoor:4.4.0`），不要用 `latest`。
  流程 = 备份 → 改 tag → `docker compose up -d` → 验证登录 → 出问题回滚 tag。
  Casdoor 启动时会自动做表结构迁移，所以**必须先备份**。

---

## 四、第二步：管理后台初始化（按这个顺序做）

打开 `https://auth.libiaorobot.com` 登入 admin，按顺序：

1. **Users → admin**：改密码、开启 MFA。
2. **Organizations**：公司环境里业务组织是 `libiaorobot.com`、管理组织是 `built-in`；本地自建时**沿用 `libiaorobot.com`** 这个业务组织名，配置才能和正式环境一一对应。
3. **Certs**：为组织生成/上传证书。OIDC 的 ID Token 签名、SAML 断言签名都依赖它。
   记住证书名，建应用时要选它。
4. **Applications**：每个业务系统建一个应用，重点是这几个配置——
   - `Organization`：选 `libiaorobot.com`
   - `Certificate`：刚建的证书
   - `Redirect URLs`：登录成功后的回调地址，**必须精确匹配**（含协议、域名、端口、结尾斜杠）
   - `Grant Types`：**公司标准只勾 `authorization_code`**（服务间调用等特殊场景另行审批）
   - `Token Format`：按公司标准选 `JWT-Custom`
   - `Token Fields`：默认只开放 `Name`、`Owner`、`Id`、`DisplayName`、`Email`，其他按需开放
   - **按群组限制页面 / 项目时必须额外勾选 `Groups`**（LibiaoLink「权限管理」依赖该声明；未勾选时登录写入的 `groups` 为空缺，已有群组关系不会被清空，但新群组变更不会生效）。勾选后让用户重新登录，并用 `/auth/me` 检查 `claims.groups`。
   - 以上三项建议在组织级 `Default Token Format` / `Default Token Fields` 里固化，新应用自动继承（详见 `docs/开发者接入注意事项(SSO接入标准).md`）
   - `Token expire` / `Refresh expire`：访问令牌建议 1~2 小时，刷新令牌 7~30 天
   - `Enable Password` / `Enable Sign Up`：公司内部系统建议只开密码登录、关闭自助注册
   - `Signin URL` / `Signup URL`：接入方自己的登录/注册页（非必填）
5. **复制 Client ID / Client Secret** 交给业务系统（Secret 只走密钥渠道，不要贴聊天群）。
6. **Providers**：配置账号来源——
   - 认证源类（登录时校验密码）：LDAP / AD、企业微信、钉钉、飞书、Entra ID、OIDC、SAML、GitHub…
   - 内网 AD：填 Host、Port、BaseDN、Bind DN、Bind 密码，勾 `Auto Sync` 可定时同步用户。
   - 企业微信的完整配置（CorpID / AgentId / Secret / 可信域名 / 通讯录同步）见 `docs/企业微信(WeCom)对接指南.md`。
7. **Applications → Signin Methods / Signin Items**：控制登录页显示什么（账号密码、验证码、扫码、WebAuthn…）。
   对外系统建议只留一种主方式，减少支持成本。
8. **Roles / Permissions**：按"部门/岗位"建角色，把角色写进令牌的 `roles` 声明，业务系统据此判权。
9. **Sync（用户同步）**：AD、LDAP、钉钉、飞书、企业微信、Azure AD、SCIM 都支持定时拉取。先用测试组织验证，再开正式。
   字段映射：**拼音全名 → `name`**、姓名 → `displayName`、企业邮箱 → `email`；登录名口径已定：拼音全名、全小写、无分隔符、离职不回收。`name` 是主键的一部分，
   **同步前务必先把登录名口径定死**，详见 `docs/开发者接入注意事项(SSO接入标准).md`。
10. **Records / Sessions / Tokens**：登录审计、在线会话强制下线、令牌吊销都在这三页。

---

## 五、第三步：各系统怎么接（对照表）

| 系统类型 | 推荐协议 | Casdoor 侧配置 | 对方侧配置 |
|---|---|---|---|
| 自研 Web / 前后端分离 | **OIDC 授权码 + PKCE** | 应用 + Redirect URLs | 授权地址 `/login/oauth/authorize`，换令牌 `/api/login/oauth/access_token` |
| 后端服务间调用 | OIDC `client_credentials` 或校验 JWT | 应用勾 client_credentials | 用 JWKS 校验签名 |
| Java 老系统 / 有 CAS 插件 | **CAS** | 应用开启 CAS | CAS Server 地址 `https://auth.libiaorobot.com/cas/{组织}/{应用}` |
| SaaS / 商用软件（GitLab、Jenkins、Grafana、Confluence…） | **SAML 2.0**（多数支持）或 OIDC | 应用 + SAML 设置 | 元数据地址 `/api/saml/metadata?application={组织}/{应用}` |
| Linux 服务器 / NAS / VPN / 网络设备 | **LDAP** | 控制台 LDAP 页面配置 | 服务器地址 + 端口 389/636 + Bind DN |
| 需要别人反过来下发账号（HR、SCIM 客户端） | **SCIM 2.0** | /scim 接口 | Base URL `https://auth.libiaorobot.com/scim` |

### 5.1 前端 SPA 要点

```text
① 用户点登录 → 前端生成 state、code_verifier
② 跳转 https://auth.libiaorobot.com/login/oauth/authorize
     ?client_id=<Client ID>
     &response_type=code
     &redirect_uri=<回调地址，必须与应用里完全一致>
     &scope=openid profile email
     &state=<随机值>
     &code_challenge=<SHA256(code_verifier) 的 base64url>
     &code_challenge_method=S256
③ 登录成功后回调你的 redirect_uri?code=xxx&state=xxx
④ 拿 code 换令牌（务必带 code_verifier）
⑤ 用 access_token 调 /api/userinfo 拿用户信息
```

**state 和 nonce 必须校验**，否则等于把 CSRF 门开着。

### 5.2 后端校验令牌

- 推荐：用 `/.well-known/jwks` 拉公钥本地验签，不要每次请求都打 userinfo 接口。
- 必须校验 `iss`（=`https://auth.libiaorobot.com`）、`aud`（=Client ID）、`exp`。
- 不想自己实现就用官方 SDK：Go / Java / Python / Node.js / .NET / PHP / Rust 都有（见官方仓库 SDK 列表）。

> 📌 **接入前必读**：`docs/开发者接入注意事项(SSO接入标准).md` —— 标准 OIDC（不用 SDK）、Redirect URLs、只勾 Authorization Code、
> JWT-Custom 与字段收敛、SVG 应用图标、会话超时（SSO Cookie 7 天 / 应用侧 10~60 分钟）、
> 打开主页即跳 SSO 与隐藏本地入口、权限开通与离职回收 API。

### 5.3 本地登录入口（带应用 Logo）

本地沙箱已建好应用 `libiaolink`，Logo（浅色 / 深色）由 Casdoor 自己托管在 `deploy/casdoor/files/brand/`，直接打开即可验证：

```
http://localhost:8000/login/oauth/authorize?client_id=libiaolink-a195b721bb30a7d4&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Faccount&scope=openid+profile+email&state=demo
```

登录页提供 `密码（本地）` 与 `验证码` 两种方式，下方还有「公司统一登录（测试环境）」入口（联邦到 `authtest`，可用公司账号登录）。配置快照、账号与常见问题见 `docs/本地沙箱(LibiaoLink 演练环境).md`。

---

## 六、接口速查（把 `https://auth.libiaorobot.com` 记作 SSO）

| 用途 | 接口 |
|---|---|
| 授权（登录入口） | `GET SSO/login/oauth/authorize` |
| 换令牌 | `POST SSO/api/login/oauth/access_token` |
| 刷新令牌 | `POST SSO/api/login/oauth/refresh_token` |
| 令牌自省 | `POST SSO/api/login/oauth/introspect` |
| 用户信息 | `GET SSO/api/userinfo`（`Authorization: Bearer <access_token>`） |
| 登出 | `GET/POST SSO/api/logout`（支持 `id_token_hint`、`post_logout_redirect_uri`、`client_id`、`state`） |
| OIDC 发现 | `GET SSO/.well-known/openid-configuration` |
| JWKS 公钥 | `GET SSO/.well-known/jwks` |
| SAML 元数据 | `GET SSO/api/saml/metadata?application={组织}/{应用}` |
| SAML ACS | `POST SSO/api/acs` |
| CAS 登录 | `SSO/cas/{组织}/{应用}/login` |
| CAS 校验 | `GET SSO/cas/{组织}/{应用}/serviceValidate` |
| SCIM | `SSO/scim/Users`、`SSO/scim/Groups`、`SSO/scim/ServiceProviderConfig` |
| LDAP | `ldap://auth.libiaorobot.com:389`（端口由 `ldapServerPort` 决定） |
| 健康检查 | `GET SSO/api/health` |
| Swagger | `SSO/swagger`（仅 `runmode=dev` 时挂载） |
| 自查：按 `client_id` 反查应用 | `GET SSO/api/get-app-login?clientId={client_id}&responseType=code&redirectUri={回调}` |
| 自查：按应用名读配置 | `GET SSO/api/get-application?id=admin/{应用名}` |
| 自查：读认证源配置 | `GET SSO/api/get-provider?id=admin/WeCom` |

> 三个“自查”接口**无需登录**，`clientSecret` 一律返回 `***`（2026-09-15 在测试/正式环境实测）。没有管理员账号时，用它们就能核对「我的应用是不是配对了」——`client_id` 就在业务系统跳转 SSO 时的授权 URL 里。

> 反查示例：测试环境 `clientId=75a4ed2163aa67549ae3` → `admin/libiaolink`（`enableAutoSignin=true`、组织 `libiaorobot.com`）。

---

## 七、上线检查清单

- [ ] admin 密码已改，MFA 已开
- [ ] 只走 HTTPS，`origin` = 对外域名，HTTP 已 301
- [ ] 每个应用的 Redirect URL 精确到路径，**没有**用通配
- [ ] ClientSecret 不进 Git、不进前端代码
- [ ] 数据库每日备份 + 已做过一次恢复演练
- [ ] 最少 2 个副本时已接 Redis（否则会话不共享）
- [ ] `runmode=prod`、`showSql=false`、日志已外送
- [ ] 登录审计（Records）有人看，异常登录有告警
- [ ] 灰度顺序：内部系统 → 非核心业务 → 核心业务
- [ ] 有回滚预案（旧登录方式保留一个过渡期）

---

## 八、常见坑（都是实际会踩的）

1. **回调地址不匹配**：多一个斜杠、http/https 混用、端口不一致都会报 `redirect_uri` 错误。
2. **Docker 里的 `localhost`**：`dataSourceName` 里写 `localhost` 不会指向宿主机数据库；用 compose 的服务名（`mysql`）。Casdoor 检测到 `RUNNING_IN_DOCKER` 时会把 localhost 改写掉，反而更难排查。
3. **多副本没有共享会话**：不接 Redis，用户会在两个副本间反复被踢登录。
4. **时间不同步**：服务器时间漂移会让 JWT 校验失败（`token used before issued`），装 NTP。
5. **内网离线部署**：默认 `staticBaseUrl` 指向公网 CDN（`cdn.casbin.org`），纯内网环境要把静态资源换成本地/自建地址，否则部分图标、favicon 加载失败。
6. **升级不备份**：启动即自动迁移表结构，备份是唯一退路。
7. **令牌有效期设太长**：默认值偏宽松，公司内网也要设短一点，配合 refresh_token。
8. **MySQL 的 DSN 不能带查询参数**：Casdoor 是把 `dataSourceName` 与 `dbName` 直接字符串拼接的
   （`object/ormer.go` 的 `open()`），写成 `.../ ?charset=utf8mb4` 会让拼接结果是 `...?charset=utf8mb4casdoor`，
   容器启动直接 `panic: unknown time zone`。字符集请交给 MySQL 服务端参数处理。
9. **调 `/api/login` 自动化登录时参数位置**：OAuth 参数（`clientId`、`responseType`、`redirectUri`、
   `scope`、`state`、`code_challenge`）必须放在 **URL 查询串**里，只有 `type`、`organization`、`username`、
   `password`、`application` 放在 JSON body；放错会报 `Grant_type: xxx is not supported in this application`。
10. **默认令牌有效期 7 天**（内置应用 `expireInHours=168`）且 `roles`/`permissions` 默认为空——
    做鉴权前必须先在控制台建好 Roles/Permissions，否则业务系统只能判断"登录了没有"。
11. **`/api/userinfo` 与令牌的字段命名不一致**：userinfo 里 `preferred_username` 才是登录名、`name` 是显示名；
    令牌（JWT-Custom）里则是 `name` 登录名、`displayName` 显示名。接入时必须归一化，详见接入标准文档。
12. **Grant Types 不能禁用 refresh_token**：实测即使只勾 `authorization_code`，授权码流程仍下发 refresh_token 且刷新接口可用，
    想限制长期会话只能缩短 `Refresh expire`。
13. **直接把组织建成 `built-in`**：管理账号和业务用户混在一个组织里，后面拆分会很痛。
    实测在 `built-in` 下**根本建不了普通用户**，报错为 "all users in the built-in organization are global administrators"，
    业务用户请建在业务组织（公司环境固定为 `libiaorobot.com`）里。

---

## 九、建议的落地节奏（2 周试点）

| 阶段 | 时间 | 产出 |
|---|---|---|
| P0 环境就绪 | D1–D2 | 服务器、域名、HTTPS、Casdoor 跑起来、admin 加固 |
| P1 组织与应用 | D3–D4 | 组织 `libiaorobot.com`、证书、第一个应用（可先用本地沙箱 `deploy/casdoor/` 的登录页验证） |
| P2 账号来源 | D5–D7 | 联合登录（企业微信/钉钉）或 AD 认证源跑通，导入/同步首批用户 |
| P3 真实系统接入 | D8–D12 | 接 1~2 个内部系统（Jenkins/Grafana 之类最省事），补角色与权限 |
| P4 固化 | D13–D14 | 监控告警、备份演练、操作手册、回滚预案，再决定核心系统排期 |

> 顺序原则：**先让一个非核心系统端到端跑通**，再谈全公司推广。SSO 的难点从来不是搭服务，而是账号口径和各系统兼容性。
