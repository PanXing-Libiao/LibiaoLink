# Casdoor 对接实测报告（LibiaoLink SSO）

> 2026-09-15 ｜ Windows + Docker Desktop 29.7.2 ｜ 镜像 `casbin/casdoor:4.4.0` + `mysql:8.0.36` + `redis:7-alpine`
> 本文件汇总多轮实测：**本地沙箱**（`deploy/casdoor/`，入口 `http://localhost:8000`）→ **公司测试环境** → **公司正式环境**。
> 本地登录入口是 Casdoor 自托管的带 Logo 登录页，不依赖额外进程；早期用来验证链路的示例业务系统（`examples/oidc-node`）已从仓库移除，下文凡称「示例应用 / 业务系统」均指它，仅作历史记录。
> 公司环境只做只读核对，或在测试环境用管理员账号做演练，**未改动正式环境任何配置**。

## 一、本地沙箱（第 1 轮）：授权码 + PKCE 端到端跑通

**结论**：授权码 + PKCE 登录链路端到端跑通，可直接照此接入。

### 验证项与结果

| 验证项 | 结果 |
|---|---|
| 容器启动 / 健康检查 `/api/health` | ✅ 三个容器健康，`{"status":"ok"}` |
| 自动建库建表（`--createDatabase=true`） | ✅ 首次启动自动完成，无需手工导 SQL |
| admin 登录（`POST /api/login`） | ✅ 返回会话 Cookie `casdoor_session_id` |
| 授权码签发（带 PKCE） | ✅ 返回 code |
| 业务系统回调换令牌 | ✅ 302 回业务系统并建立本地会话 |
| 取用户信息 | ✅ `Admin / admin@example.com` |
| **PKCE 强制校验**（故意传错误 `code_verifier`） | ✅ 被拒：`400 invalid_grant: verifier is invalid` |
| `state` 防伪（示例应用侧） | ✅ 伪造 state 返回 400 |
| 单点登出 | ✅ 302 到 `/api/logout`，带 `client_id`、`post_logout_redirect_uri`、`id_token_hint` |
| 登出后会话失效 | ✅ `/me` 返回 401 |
| OIDC 发现端点 | ✅ `/.well-known/openid-configuration`，声明 `S256` |
| **JWKS 本地验签 id_token** | ✅ RS256 验签通过，`kid=cert-built-in` |
| refresh_token 换新令牌（`expires_in=604800`） | ✅ 成功 |
| Bearer 调 `/api/userinfo` | ✅ 返回用户信息 |

### 踩到的坑（已修正到模板 / 文档）

1. **MySQL 的 DSN 不能带查询参数**
   源码 `object/ormer.go` 的 `open()` 是 `dataSourceName + dbName` 直接拼接。
   写成 `...tcp(mysql:3306)/?charset=utf8mb4` 会拼出 `...?charset=utf8mb4casdoor`，容器启动即
   `panic: unknown time zone`。字符集交给 MySQL 服务端参数。
2. **`/api/login` 的 OAuth 参数要放在 query string**
   `clientId / responseType / redirectUri / scope / state / code_challenge` 走 URL 查询参数，
   只有 `type / organization / username / password / application` 在 JSON body 里。
   放错位置会报 `Grant_type: is not supported in this application`。
3. **默认令牌有效期偏长**：内置应用 `expireInHours=168`（7 天），生产应改短并配合 refresh_token。
4. **角色 / 权限默认为空**：实测 id_token 里 `roles: []`、`permissions: []`。
   只做「登录」可以，但要做**授权**必须先在控制台建 Roles / Permissions。

### 复现命令

```bash
cd deploy/casdoor && cp .env.example .env && vi .env && docker compose up -d
# 打开带 Logo 的登录页（这是唯一的本地验证入口，回跳 Casdoor 账户页）：
# http://localhost:8000/login/oauth/authorize?client_id=libiaolink-a195b721bb30a7d4&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Faccount&scope=openid+profile+email&state=demo
```

## 二、本地沙箱（第 2 轮）：公司接入标准落地

按《开发者接入注意事项》在本地实例上建了一套参考实现：

| 对象 | 值 |
|---|---|
| 组织 | `libiaorobot`（**本地演示名**；公司测试 / 正式环境是 `libiaorobot.com`。DisplayName 立标机器人，组织级 Default Token Format = JWT-Custom、Default Token Fields = 5 个字段） |
| 证书 | `cert-libiaorobot`（RS256，新增时由 Casdoor 自动生成密钥对） |
| 应用 | `libiaolink`（Grant Types 只勾 authorization_code，Token Format = JWT-Custom，Redirect URLs = http://localhost:8000/account） |
| 用户 | `zhangsan` / 张三 / zhangsan@libiaorobot.com |

### 验证结果

| 验证项 | 结果 |
|---|---|
| 令牌字段收敛为 5 个业务字段 | ✅ 令牌里只剩 `name`、`owner`、`id`、`displayName`、`email` + 标准声明，密码 / 手机号 / 角色等一律不出现 |
| 张三的令牌内容 | ✅ `name=zhangsan`、`displayName=张三`、`email=zhangsan@libiaorobot.com`、`owner=libiaorobot`、`id=<UUID>` |
| 业务系统拿到用户身份 | ✅ 示例应用首页显示「已登录：张三（登录名 zhangsan，zhangsan@libiaorobot.com）」 |
| 组织级默认值生效 | ✅ 新建应用自动继承 JWT-Custom 与 5 个字段，无需逐个手工勾选 |

### 本轮新发现的坑

1. **内置组织 built-in 不允许创建普通用户**
   报错原文：`adding a new user to the built-in organization is currently disabled ... all users in the built-in organization are global administrators`。
   业务用户必须建在业务组织里（公司环境固定为 `libiaorobot.com`；本次本地演示建在 `libiaorobot`）。
2. **/api/userinfo 与令牌字段命名不一致**：userinfo 用 `preferred_username`（登录名）/ `name`（显示名），
   令牌用 `name`（登录名）/ `displayName`（显示名）。示例代码已做归一化。
3. **Grant Types 无法禁用 refresh_token**：只勾 `authorization_code` 时，授权码流程仍返回 refresh_token，刷新接口实测可用（HTTP 200）。
   要限制长期会话只能缩短 `Refresh expire`。
4. **`id` 是内部 UUID**，不是登录名；登录名对应 `name`（口径为拼音全名，如 `zhangsan`）。业务侧唯一标识建议用 `owner + name`。

## 三、本地沙箱（第 3 轮）：公司规范落地与合规改造

按《开发者接入注意事项》第二~六部分改造接入方（当时的示例应用，已移除），并逐项实测：

| 规范条目 | 实测结果 |
|---|---|
| 四 登录页要求 | ✅ 访问 `/` → 302 → `/login` → 302 → SSO 授权页，全程不出现本地登录界面 |
| 四 隐藏本地入口 | ✅ `/local-login` 可直接访问（无痕也测得到），全站没有任何链接指向它；输入管理员密码后进入「本地管理员会话」 |
| 三 会话超时 | ✅ 临时把 `SESSION_IDLE_MINUTES` 设为 0.05（3 秒）：登录后 /me 200；空闲 5.5 秒后 /me **401**；再打开主页自动 302 回 SSO 重新认证 |
| 六 权限回收 API | ✅ 无凭证 401；带凭证禁用 → 200 且 `affectedSessions:1`；原会话立即 401；重新登录被拒 403「账号已停用」；enable 后恢复正常；删除不存在用户返回 200（幂等） |
| 二.5 SVG 图标 | ✅ `/icon.svg`、`/icon-dark.svg` 正常返回 `image/svg+xml`；已写入 Casdoor 应用的 Logo / LogoDark 字段 |
| 二.4 配置未被破坏 | ✅ 改造后应用仍是 `tokenFormat=JWT-Custom`、`grantTypes=["authorization_code"]`、`tokenFields=[Name,Owner,Id,DisplayName,Email]` |
| 登录页 Logo 尺寸 | ✅ 定位到根因：Casdoor v4.4.0 登录页把应用 Logo 写死为 40px 高（`h-10`），图标再大也会被压扁；已用应用的 `formCss` / `formCssMobile` 覆盖为 140px / 96px，实测 `/api/get-app-login` 立即返回新值、无需重启 |

### 品牌资源

- `assets/libiaolink-logo.svg`（正式 logo，品牌色 #FECA04 黄 + #021D37 深蓝）
- `assets/libiaolink-logo-dark.svg`（由正式 logo 派生：仅把 #021D37 换成 #FFFFFF，几何未改，用于深色主题）
- 两个文件均为纯 SVG，可直接填到 Casdoor 应用的 Logo / LogoDark 字段或上传
- 两个 SVG 的 `viewBox` 已由 `0 0 1535 1024` 收紧为 `221.9 142.6 1149 713.8`（去掉四周约 26% / 32% 的空白，路径数据未改，需要时可改回原画布）

## 四、公司测试环境（authtest.libiaorobot.com）：端到端演练

演练日期 2026-09-15 ｜ 环境 `https://authtest.libiaorobot.com`（内网 10.1.100.17）｜ 业务组织 `libiaorobot.com`

| 项 | 结果 |
|---|---|
| 连通性 | ✅ DNS 解析到 `10.1.100.17`，`/api/health` 返回 200（仅内网可达） |
| OIDC discovery | ✅ `issuer=https://authtest.libiaorobot.com`，authorize / token / userinfo / jwks / logout 端点齐全 |
| 演练应用 | ✅ 新建 `libiaolink`（owner=admin、organization=`libiaorobot.com`、cert=`cert-built-in`、grantTypes 只 `authorization_code`、`JWT-Custom` + 5 字段） |
| 演练用户 | ✅ 新建 `zhangsan` / 张三 / zhangsan@libiaorobot.com（组织 `libiaorobot.com`） |
| 登录名口径 | ✅ 演练用 `zhangsan`，符合已定口径（拼音全名、全小写、无分隔符），数据无需调整 |
| 完整流程 | ✅ `/` → 302 `/login` → 302 测试环境授权页 → 授权码 → `/callback` 换令牌 → 302 `/` |
| userinfo | ✅ `preferred_username=zhangsan`、`name=张三`、`email=zhangsan@libiaorobot.com` |
| 令牌字段 | ✅ access_token 与 id_token 均为 JWT-Custom，只带 `name`/`owner`/`id`/`displayName`/`email` + 标准声明；`owner=libiaorobot.com` |
| 本地沙箱怎么连它 | 本地登录页下方「公司统一登录（测试环境）」入口走联邦（认证源 `provider_authtest`）：沙箱里业务系统只对接本地 Casdoor，上线时再改成直接对接公司环境 —— 见《本地沙箱(LibiaoLink 演练环境)》 |

### 2026-09-16 管理员只读核对（测试环境现状）

> ⚠️ 09-15 演练时建的 `libiaolink`（clientId `75a4ed…`）已不在；LibiaoLink 当前的应用是 **`LibiaoLink`**（displayName「立镖全链路信息平台」，2026-09-15 创建），本地沙箱联邦已切到新 clientId。

| 项 | 实况 |
|---|---|
| `LibiaoLink` 应用 | clientId `41e162d34e5fa4022ae5`；`redirectUris = ["http://localhost:9000/callback", "http://localhost:8000/callback"]`（后者是本地沙箱联邦回调，**必须保留**）；`enableAutoSignin=true`、`expireInHours=168`；**待按接入标准调整**：`tokenFormat=JWT`（标准 JWT-Custom）、`tokenFields=[]`（标准 5 字段）、Grant Types 开了 6 种（标准只留 `authorization_code`）、Logo 仍为 Casdoor 默认图 |
| 应用清单 | `libiaorobot.com` 组织下 13 个：`LibiaoLink`、`INPulse`、`bom`、`3dprint`、`api-docs`、`chatbot_workbench`、`patent`、`qa`、`tested`、`omplat`、`exp`、`hubspot`、`app-built-in`；另有 `casbin/sslvpn` |
| Redirect 写法参考（推荐） | `3dprint` = `["http://127.0.0.1:8000/api/v1/auth/casdoor/callback", "https://3dprint.libiaorobot.com/api/v1/auth/casdoor/callback"]` —— 本地调试 + 线上域名各一条 |
| Provider | `Email`（Default）、`WoCom`（类型 WeCom，**参数全空，占位未配置**）、`provider_captcha_default`（Default / Captcha） |
| 用户 | `libiaorobot.com` 组织下 18 个（含 `panxing`、`zhangsan`、`yicaonan` 等，由测试人员陆续自建；测试环境无正式员工同步数据） |

### 过程中踩到的坑

1. **复制现成用户来建号会把 `ldap` 字段一起带过去**：登录报 `password or code is incorrect`，而密码其实是对的（Casdoor 转去走 LDAP 认证）。
   迷惑点：`signinWrongTimes` 不增长、`/api/set-password` 反而提示「新密码与当前密码相同」。解决办法是新建时只传必要字段。
2. **`update-user` 不带 `columns` 参数不会更新 `ldap` 这类字段**，要 `?columns=ldap` 或删掉重建。
3. **组织级默认值是空的**：`libiaorobot.com` 的 `defaultTokenFormat` / `defaultTokenFields` 为空，新建应用**不会**自动继承公司标准，每个应用都要手工勾。
4. 测试环境没有提供商、没有正式员工数据，必须自建与正式环境同名同邮箱的用户才能联调。

### 2026-10-14 LibiaoLink 应用按接入标准调整（104.44 测试环境联调）

> 面向 `test-pm.libiaorobot.com` → 10.1.104.44 测试环境联调：完成 09-16 核对的「待按接入标准调整」三项（Logo 暂留默认），并为测试环境追加回调（应用仍为 `LibiaoLink`，clientId `41e162…` 不变）。

| 项 | 调整后实况 |
|---|---|
| Redirect URIs | 追加 `https://test-pm.libiaorobot.com/auth/callback`（localhost 两条保留） |
| Grant Types | 只留 `authorization_code`（原 6 种） |
| Token Format / Fields | `JWT-Custom` / 5 字段（`Name` `Owner` `Id` `DisplayName` `Email`） |
| 服务器侧（104.44） | `CASDOOR_ISSUER=https://authtest.libiaorobot.com`、`CASDOOR_REDIRECT_URI=https://test-pm.libiaorobot.com/auth/callback`；clientId / secret 已回填 `secrets/`（文件渠道，不回显） |
| 实测 | `/auth/login` 302 → `https://authtest.libiaorobot.com/login/oauth/authorize`（`client_id` 精确、`code_challenge_method=S256`）；授权页可达；浏览器全流程人工实测进行中 |

### 2026-10-14 单点登出回跳修正（test-pm 登出报错后续）

> 现象：测试环境（test-pm）点「退出登录」后，浏览器落在 Casdoor 的错误 JSON —— `{"status":"error","msg":"重定向 URI: https://test-pm.libiaorobot.com/在许可跳转列表中没有找到"}`。本地沙箱未复现：Casdoor 对 `localhost` / `127.0.0.1` 等 origin 有豁免（`util.IsValidOrigin`），部署环境才按应用「许可跳转列表」（Redirect URIs）精确校验。

| 项 | 说明 |
|---|---|
| 原因 | `/auth/logout` 的 `post_logout_redirect_uri` 原为「站点根地址」（`origin + "/"`）；authtest 应用 Redirect URIs 只登记了 `https://test-pm.libiaorobot.com/auth/callback`（+ 两条 localhost），根地址不在册 → Casdoor `redirectToPostLogout` 拒绝并返回错误 JSON |
| 修正（repo · 2026-10-14） | `post_logout_redirect_uri` 复用已登记的 `CASDOOR_REDIRECT_URI`；`/auth/callback` 收到无 `code` / `state` / `error` 的请求视为登出回跳 → 302 回站点首页（未登录态由前端统一转登录页） |
| 落点 | `server/src/modules/identity/oidc.service.ts`（buildLogoutUrl）、`auth.controller.ts`（callback 回跳分支）、`server/test/auth.e2e.test.ts`（断言更新 + 回跳用例）；不动 Casdoor / SSO 侧配置 |
| 验证 | 单测：登出 302 带 `id_token_hint` + `post_logout_redirect_uri = CASDOOR_REDIRECT_URI`；无参 `/auth/callback` → 302 `/`（本地 vitest + 2026-10-14 部署 v1.28 后 test-pm 真机探针：`/auth/logout` 302 携 `post_logout_redirect_uri=https://test-pm.libiaorobot.com/auth/callback`、无参 `/auth/callback` 302 → `/` 均过；浏览器人工点验「退出登录 → 回登录页」待业务侧确认） |

## 五、公司正式环境（auth.libiaorobot.com）：只读核对

只调用公开接口（`/api/get-provider`、`/api/get-application`、`/api/get-default-application`），未登录、未改动任何配置。

| 项 | 结果 |
|---|---|
| 企微 Provider | 存在：`WeCom`（显示名「企业微信」），`Internal`，`Method=Normal`，`Use id as name` 已开启，Scope 为空 |
| 已有应用 | `app-built-in`、`sslvpn`、`patent`、`qa`、`omplat`、`hubspot`、`api-docs`，均属组织 `libiaorobot.com`，均已挂「企业微信」登录方式 |
| 自动登录 | 除 `app-built-in` 外均为 `enableAutoSignin=true`（打开域名直接进，不用点按钮） |
| 默认应用 | 未设置（`get-default-application` 返回 null）→ 裸 `/login` 没有登录入口，需带 `client_id` 或从业务系统进入 |
| `libiaolink` 应用 | 尚不存在，需 SSO 管理员在正式环境创建 |
| 用户 / 应用列表 | 需要管理员权限，匿名读不到（`Unauthorized operation`） |

补充说明：控制台用户列表里的「应用」列是 `signupApplication`（**注册来源应用**），**不决定**用户能登录哪些应用 —— 能不能登录只看用户 `owner` 与应用的 `organization` 是否一致（都是 `libiaorobot.com` 即可）。测试环境演练用户 `zhangsan` 的该字段已由 `app-built-in` 调整为 `libiaolink`（纯展示语义，不影响登录与令牌；已复测登录 + 换令牌，`name=zhangsan`、`displayName=张三`、`email=zhangsan@libiaorobot.com` 不变）。

## 六、前端接入参考（React + Vite + TypeScript）：端到端验证

2026-09-16 新增 `frontend/`（LibiaoLink 前端起点 + 标准 OIDC 接入参考），在本地沙箱把「点应用卡片 → 进入前端 → 自动 SSO → 展示用户字段」整条链路做了无浏览器端到端验证（`frontend/scripts/smoke-test.mjs`，全部通过）。

| 验证项 | 结果 |
|---|---|
| 应用卡片跳转 | ✅ 卡片链接 = 应用 `Homepage URL`（Casdoor v4.4.0 `AppListPage.tsx` 行为），本地应用已指向 `http://localhost:3000` |
| 登录入口 | ✅ `GET /auth/login` → 302 授权页，带 `state` + PKCE（S256），`redirect_uri` 与应用配置逐字符一致 |
| 口令登录 | ✅ `/api/login`（OAuth 参数走 query、驼峰名）建立 SSO 会话 |
| 免二次点击 | ✅ 应用开 `enableAutoSignin` 后，已有会话时授权页自动签发授权码 |
| 回调换令牌 | ✅ `code + code_verifier + client_secret` 换令牌成功，建立本地会话（HttpOnly Cookie） |
| 用户字段 | ✅ `name=zhangsan`、`displayName`、`email`、`id`、`owner` 五项齐全（JWT-Custom） |
| 验签 | ✅ `id_token` 经 JWKS（RS256）验签后才采信 |
| 登出 | ✅ `/auth/logout` → Casdoor `/api/logout`（带 `id_token_hint`），登出后 `/auth/me` 返回 401 |
| 生产构建 | ✅ `tsc` 严格模式 + Vite 生产构建通过 |

两个值得记的发现（写自动化时容易踩）：

1. **`/api/login` 的 `type=code` 不落地 SSO 会话**（能拿到授权码，但随后 `get-account` 读不到会话）；`type=login` 才建立会话。浏览器登录页的正常路径不受影响。
2. **「免二次点击」是页面 JS 行为**：`enableAutoSignin=true` 时由登录页 JS 自动提交一次「仅带会话、不带口令」的 `/api/login`（等价于再发一次 `type=code`），服务端不会直接 302 —— 无浏览器测试要模拟这一步，而不是等 authorize 端点 302。

## 七、清理

```bash
cd deploy/casdoor && docker compose down -v      # -v 会连数据库卷一起删，仅测试环境使用
```
