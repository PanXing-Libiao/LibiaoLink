# 本地沙箱说明（LibiaoLink 演练环境）

> 这份文档只讲**本机 Linux 容器里那一套 Casdoor**（`deploy/casdoor/`）的现状与用法；Windows 通过 WSL2 Ubuntu，macOS 使用本地 Docker Engine。
> 它与公司环境（正式 `auth.libiaorobot.com` / 测试 `authtest.libiaorobot.com`）是**两套完全独立的用户库** —— 同名同邮箱也不是同一个人。
> Windows 开发机使用 WSL2 Ubuntu 内的原生 Docker Engine，禁止 Docker Desktop；安装与验收见 [Windows 本地开发环境](本地开发环境(Windows-WSL2-Docker).md)。
> 最后更新：2026-10-26

## 一、用途与边界

> 未入库说明：本机沙箱的账号与口令（测试账号、管理员、DB / Redis）只写在 `deploy/casdoor/.env.local`（gitignore），仓库与文档里只留引用；`frontend/.env.local` 另存 smoke 用的 `TEST_USERNAME` / `TEST_PASSWORD`。

- **用途**：在完全不碰公司环境的前提下，验证接入代码、登录页与流程。组织、应用、证书、令牌字段口径都按公司标准配置。
- **边界**：本地用户是手工建的演示数据；公司账号靠联邦入口登录（见第五节）。正式上线时业务系统直接对接公司 Casdoor，本地这套不参与。

## 二、起停

Windows 在 WSL Ubuntu 终端执行（仓库按标准放在 WSL 文件系统），macOS 在普通终端执行；路径按本机实际情况调整：

```bash
cd ~/LibiaoLink/deploy/casdoor
docker compose up -d      # 启动（casdoor / mysql / redis 三个容器）
docker compose ps         # 状态，三个都应是 healthy
docker compose logs -f casdoor
docker compose down       # 停止（数据保留在数据卷）
docker compose down -v    # 连数据一起清掉，下次启动是全新环境
```

健康检查：`curl http://localhost:8000/api/health`

## 三、登录入口与账号

带应用 Logo 的登录页（收藏这一条就够，不需要任何其它本地服务）：

```
http://localhost:8000/login/oauth/authorize?client_id=libiaolink-a195b721bb30a7d4&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Faccount&scope=openid+profile+email&state=demo
```

业务系统前端（LibiaoLink）：`http://localhost:3000` —— 从应用页 `http://localhost:8000/apps` 点 `LibiaoLink` 卡片进入；未登录会自动跳单点登录。用法见第九节。

页面上有三条登录路径：

| 路径 | 位置 | 用什么登录 | 效果 |
|---|---|---|---|
| 本地账号 | 登录页 `密码（本地）` 页签 | 用户名 `zhangsan`，口令见 `deploy/casdoor/.env.local` 的 `TEST_PASSWORD` | 登录到本地用户库，不碰公司 |
| 公司账号 | 登录页下方「公司统一登录（测试环境）」 | 测试环境组织 `libiaorobot.com` 下的账号（如 `yicaonan`） | 联邦登录，首次登录自动建本地账号 |
| Casdoor 管理员 | `http://localhost:8000/login/built-in` | 见 `deploy/casdoor/.env.local` 的 `CASDOOR_ADMIN_USERNAME` / `CASDOOR_ADMIN_PASSWORD` | 进控制台（**上线前必须改**） |

> `验证码` 页签现在点了发不出码 —— 本地没有短信/邮箱通道（公司测试环境也一样）。

> **回放专用账号（2026-10-12 已删除）**：`px-replay`（潘兴·回放）/ `wmj-replay`（吴孟杰·回放）—— 曾建在本地用户库、**无口令**（回放脚本直接写会话，不走登录页），角色与真人号一致（`admin` + `project_manager`）；`frontend/scripts/*-e2e.mjs` 默认用它俩跑（`REPLAY_USER` 可覆盖）。**真人账号（panxing / wmj）不做回放夹具**（2026-10-10 事故：脚本与用户并发共用同一账号，快照还原把用户的删除覆盖 →「删了便签重登又出现」）。**2026-10-12 按业务要求删除**：两账号已按内建删除语义软删（`status=disabled` + `removed_at`、在线会话全部撤销、审计留痕）—— 用户目录 / 项目经理与负责人候选 / 登录面均不再出现；回放脚本启动时即报「回放用户不存在：px-replay」退出（Push 281 起加 `status=active` 守卫）。**要再跑回放，先按本节 SQL 复活账号。**

> 换库 / 新沙箱重建（全新库用下面 INSERT 段；**已软删的现有沙箱用紧随其后的 UPDATE 段复活**）：

```sql
insert into users (casdoor_id, username, display_name, email, status) values
  ('replay-user-px-0001', 'px-replay', '潘兴·回放', 'px-replay@libiaorobot.com', 'active'),
  ('replay-user-wmj-0001', 'wmj-replay', '吴孟杰·回放', 'wmj-replay@libiaorobot.com', 'active');
insert into user_roles (user_id, role_id)
  select u.id, r.id from users u join roles r on r.code in ('admin', 'project_manager')
  where u.username in ('px-replay', 'wmj-replay');
```

> 现有沙箱「复活」两条（软删后恢复；角色未动、直接可用；如需再回到删除态，把 status 改回 'disabled' 并置 removed_at）：

```sql
update users set status = 'active', removed_at = null, updated_at = now()
  where username in ('px-replay', 'wmj-replay');
```

> 应用已开 `enableAutoSignin`：**已有 SSO 会话时，打开登录入口（或点应用卡片）会直接签发、不再显示登录页**（对应接入标准第 4 条「打开主页即弹认证页、无需二次点击」）。想查看登录页本身或切换账号：用无痕窗口，或先退出登录。

## 四、当前配置快照

| 项 | 值 |
|---|---|
| 组织 | `libiaorobot`（**本地专用名**；公司是 `libiaorobot.com`） |
| 证书 | `cert-libiaorobot`（RS256） |
| 应用 | `libiaolink`，Client ID `libiaolink-a195b721bb30a7d4`（Secret 在控制台应用详情页） |
| Grant Types | 只勾 `authorization_code` |
| Token | `JWT-Custom`，字段 `name` / `owner` / `id` / `displayName` / `email` |
| Redirect URLs | `http://localhost:8000/account`（回跳 Casdoor 账户页，验证登录用）、`http://localhost:3000/auth/callback`（前端回调） |
| Homepage URL | `http://localhost:3000` —— Casdoor 应用页点卡片跳这里 |
| 自动签发 | `enableAutoSignin=true`：已有 SSO 会话时授权页自动签发，免二次点击 |
| 登录方式 | `密码（本地）` + `验证码` |
| 外部认证源 | `provider_authtest` → `https://authtest.libiaorobot.com`（类型 Casdoor，即联邦；clientId 指向测试环境的 `LibiaoLink` 应用）；应用里 `canSignIn` 与 `canSignUp` 都为真 |
| 注册 | 应用 `enableSignUp` 已开：公司账号第一次登录会自动建本地用户 |
| Logo | `http://localhost:8000/files/brand/libiaolink-logo.svg`、`...-dark.svg`（Casdoor 自托管；源文件在 `assets/`，副本在 `deploy/casdoor/files/brand/`） |
| 登录页 Logo 尺寸 | `formCss = .login-logo-box img{height:140px!important}`（Casdoor 默认只给 40px） |
| 会话 | SSO Cookie 30 天（compose 的 `sessionCookieLifeTime`） |
| 本地用户 | `zhangsan`（张三，已绑定公司测试环境 UUID `8a11328a-…`）、`yicaonan`（预留，绑定 `a7cf26f5-…`） |

## 五、公司账号是怎么登进来的（联邦原理）

1. 本地登录页 → 点「公司统一登录（测试环境）」→ 跳到 `https://authtest.libiaorobot.com`（用的是测试环境 `LibiaoLink` 应用的 Client ID `41e162d34e5fa4022ae5`）；
2. 在**公司页面**上输入公司账号（密码 / 扫码都在那边输入）；
3. 回到本地 Casdoor：按认证源的 `userMapping` 把公司用户映射成本地用户 —— 已绑定的直接命中，没绑定的自动建号；
4. 本地 Casdoor 再签发自己的令牌给业务系统 —— 所以业务系统自始至终只认本地这一套。

本地用户身上的 `casdoor` 字段存的就是**公司那边的用户 UUID**，这是两边能对上的关键。

> ⚠️ 联邦回调是本地 Casdoor 的 `/callback`（`http://localhost:8000/callback`）—— **公司测试环境 `LibiaoLink` 应用的 Redirect URLs 里必须保留这一条**，删掉联邦就登不进去。

## 六、没有浏览器也能查

```
# 登录页会渲染出哪些登录方式与入口
GET http://localhost:8000/api/get-app-login?clientId=libiaolink-a195b721bb30a7d4&responseType=code&redirectUri=http%3A%2F%2Flocalhost%3A8000%2Faccount&type=code&scope=openid%20profile%20email&state=x

# 应用 / 认证源 / 用户
GET http://localhost:8000/api/get-application?id=admin/libiaolink
GET http://localhost:8000/api/get-providers?owner=admin
GET http://localhost:8000/api/get-user?id=libiaorobot/zhangsan

# 管理员登录（返回会话 Cookie，后续请求带上）
POST http://localhost:8000/api/login   # 口令见 deploy/casdoor/.env.local
{"application":"app-built-in","organization":"built-in","username":"admin","password":"<见 deploy/casdoor/.env.local>","autoLogin":true,"type":"login"}
```

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 在「密码（本地）」里填公司账号（邮箱或用户名）→ 报「用户不存在」 | 本地页只查本地用户库；公司账号必须走下方「公司统一登录（测试环境）」 |
| 直接打开或刷新 `/callback` → `Unknown authentication type` | `/callback` 是联邦回跳的落地页，只有带 `code`/`state` 时才有效；验证登录请从登录页入口走 |
| 公司账号登录报 `libiaorobot.com/xxx 不存在` | 账号建在了别的组织（如 `built-in`）。用户必须建在应用所属的 `libiaorobot.com` |
| 「验证码」点了没反应 | 本地没有短信 / 邮箱通道（公司测试环境同样没有） |
| 公司登录入口图标是 Casdoor 的立方体 | 认证源类型为 `Casdoor` 时图标被 Casdoor 写死；改成 `OIDC` 类型才能自定义 `customLogo`（需重新验证链路） |
| 换了 Logo 但页面没变 | 改 `assets/` 后要同步一份到 `deploy/casdoor/files/brand/` |
| 想切回「只有本地账号」 | 控制台应用 `libiaolink` → Providers 取消勾选 `provider_authtest` |
| 登录页一闪而过 / 直接进业务系统 | 应用 `enableAutoSignin` 已开（标准要求）：已有 SSO 会话时直接签发；想看登录页用无痕窗口或先登出 |
| 点应用卡片打不开 | 前端没在跑：`cd frontend && npm run dev`（占用 3000 端口） |
| 前端报「换取令牌失败」 | Casdoor 应用 Redirect URLs 里要有 `http://localhost:3000/auth/callback`（逐字符一致） |

## 八、与公司环境对照

| 项 | 本地沙箱 | 公司测试 | 公司正式 |
|---|---|---|---|
| 地址 | `http://localhost:8000` | `https://authtest.libiaorobot.com`（仅内网） | `https://auth.libiaorobot.com` |
| 组织 | `libiaorobot` | `libiaorobot.com` | `libiaorobot.com` |
| 管理员 | `admin`（口令见 `.env.local`） | `admintest` | 由 SSO 管理员维护 |
| 用户来源 | 手工建 + 联邦自动建 | 手工建（无正式员工数据） | 企微通讯录同步 |
| 企微登录 | 无 | 无 | ✅ `WeCom` Provider |
| 应用注册 | 控制台自助 | 管理员账号可自助 | 需找 SSO 管理员 |
| 业务前端 | `http://localhost:3000`（`frontend/`，SSO 链路已跑通） | 未接入 | 未接入（上线后由 SSO 管理员建 `LibiaoLink` 应用） |

## 九、前端联调（frontend/）

`frontend/` 是 LibiaoLink 业务前端（React + Vite + TypeScript，严格模式）；登录与会话自 k6 起由后端 `server/`（identity 模块）承载，本地由 Vite 把 `/auth/*` 代理到后端：

Windows 在 WSL Ubuntu 终端执行，macOS 在普通终端执行：

```bash
# 1. 后端（新窗口）：server/.env 指向本沙箱，PORT=3001（前端占 3000）
cd ~/LibiaoLink/shared; npm ci; npm run build
cd ../server; npm ci; npm run build; npm run start:api

# 2. 前端（新窗口）
cd ~/LibiaoLink/frontend
npm install
cp .env.example .env.local        # BACKEND_ORIGIN 默认已指向 http://127.0.0.1:3001
npm run dev                       # http://localhost:3000
```

- 入口一：`http://localhost:8000/apps` 点 `LibiaoLink` 卡片（= 应用配置里的 Homepage URL）
- 入口二：直接打开 `http://localhost:3000`，未登录自动跳 SSO
- 无浏览器回归：`npm run smoke`（先起后端与前端；登录 → 回调 → me → 登出 → returnTo 白名单，共 8 组）
- 令牌交换与验签在后端（`server/src/modules/identity/`），`client_secret` 只存在于 `server/.env`；生产环境由站点域名直接承载 4 个 `/auth/*` 路由，细节见 `frontend/README.md`

> 本地前端只对接本地 Casdoor；验证公司账号走登录页下方「公司统一登录（测试环境）」（第五节），上线时把 `server/.env` 换成公司环境地址与正式应用凭据。

## 十、用户角色（写操作 403 的常见原因）

从公司 SSO 联邦进来的账号，本地 Casdoor 会自动建号；但业务库里的角色（`user_roles`）**不会自动分配** —— **打开权限判定时**（`PERMISSION_ENFORCED=true`）权限位为空即写接口 403、列表按「我管的 / 我参与的」裁剪（服务端是最终裁决）。

**当前阶段口径（业务已定：「我们当前这个系统就不要考虑权限」）= 服务端开关 `PERMISSION_ENFORCED` 默认 `false`（Push 178 起）**：授权画像一律**等效管理员**（数据范围 `all` + 契约全量权限位 + `admin` 角色码）—— 与 `user_roles` 有没有绑定无关：新账号从公司 SSO 登进来**直接用，不必再执行任何 SQL**（服务端不再读角色，本机 / 沙箱 / 生产同口径）。

下面的绑定 SQL 仍然有用 —— 它现在是**打开开关（`PERMISSION_ENFORCED=true`，即回到 ADR-011 判定）时**给账号配权限（或本地复现「受限账号」场景）的手段：

```sql
-- 全员管理员（打开判定 PERMISSION_ENFORCED=true 时给账号配全权）：全量可见 + 全权限
insert into user_roles (user_id, role_id)
select u.id, r.id from users u cross join roles r
where r.code = 'admin' and u.status = 'active' and u.removed_at is null
on conflict do nothing;

-- 只给单人 / 换别的角色（例：项目经理 = 只看得见自己管的项目 + 建改删项目）
insert into user_roles (user_id, role_id)
select u.id, r.id from users u, roles r
where u.username = 'zhangsan' and r.code = 'project_manager'
on conflict do nothing;

-- 撤销某人的全部角色
delete from user_roles where user_id = (select id from users where username = 'zhangsan');
```

- 直连串：`postgres://libiaolink_migrator@127.0.0.1:5433/libiaolink`（见 `database/README.md`）；查现有绑定：`select u.username, r.code from user_roles ur join users u on u.id = ur.user_id join roles r on r.id = ur.role_id order by 1;`
- 权限画像有 10 秒缓存：改完角色**刷新页面**即可生效（最迟 10 秒）。
- 角色集与权限位（`project.create` / `project.update` / `project.delete` / `dict.manage` 等）由种子维护（`database/seeds/roles.mjs` / `role-permissions.mjs`）；**分配角色的管理界面还没做**（成员管理 u3 / u12 待建）。
- **「全员全权」的落点（Push 178 定案）**= 服务端开关（一期默认 `false`，无需改数据）；二期打开 `PERMISSION_ENFORCED=true` 恢复按角色判定时，再走 ① identity 建号流程落默认角色 / ② 角色管理界面（u12）两条路。
- 想在本机验「按 ADR-011 判定」：以 `PERMISSION_ENFORCED=true` 重启 api（`server/.env` 或进程环境变量，重启生效），再按上面的 SQL 给账号配角色；两态对照证据见 `docs/权限开关回放证据(PERMISSION_ENFORCED).md`（A 站默认 / B 站 true，同一账号同一份数据）。
