# 本地沙箱说明（LibiaoLink 演练环境）

> 这份文档只讲**本机 Docker 里那一套 Casdoor**（`deploy/casdoor/`）的现状与用法。
> 它与公司环境（正式 `auth.libiaorobot.com` / 测试 `authtest.libiaorobot.com`）是**两套完全独立的用户库** —— 同名同邮箱也不是同一个人。
> 最后更新：2026-09-23

## 一、用途与边界

> 未入库说明：本机沙箱的账号与口令（测试账号、管理员、DB / Redis）只写在 `deploy/casdoor/.env.local`（gitignore），仓库与文档里只留引用；`frontend/.env.local` 另存 smoke 用的 `TEST_USERNAME` / `TEST_PASSWORD`。

- **用途**：在完全不碰公司环境的前提下，验证接入代码、登录页与流程。组织、应用、证书、令牌字段口径都按公司标准配置。
- **边界**：本地用户是手工建的演示数据；公司账号靠联邦入口登录（见第五节）。正式上线时业务系统直接对接公司 Casdoor，本地这套不参与。

## 二、起停

```powershell
cd D:\LibiaoLink\deploy\casdoor
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

```powershell
# 1. 后端（新窗口）：server/.env 指向本沙箱，PORT=3001（前端占 3000）
cd shared; npm ci; npm run build
cd ../server; npm ci; npm run build; npm run start:api

# 2. 前端（新窗口）
cd frontend
npm install
copy .env.example .env.local      # BACKEND_ORIGIN 默认已指向 http://127.0.0.1:3001
npm run dev                       # http://localhost:3000
```

- 入口一：`http://localhost:8000/apps` 点 `LibiaoLink` 卡片（= 应用配置里的 Homepage URL）
- 入口二：直接打开 `http://localhost:3000`，未登录自动跳 SSO
- 无浏览器回归：`npm run smoke`（先起后端与前端；登录 → 回调 → me → 登出 → returnTo 白名单，共 8 组）
- 令牌交换与验签在后端（`server/src/modules/identity/`），`client_secret` 只存在于 `server/.env`；生产环境由站点域名直接承载 4 个 `/auth/*` 路由，细节见 `frontend/README.md`

> 本地前端只对接本地 Casdoor；验证公司账号走登录页下方「公司统一登录（测试环境）」（第五节），上线时把 `server/.env` 换成公司环境地址与正式应用凭据。

## 十、部门权限（写操作 403 / 数据不可见的常见原因）

从公司 SSO 联邦进来的账号由 Casdoor 建立并同步到 `users`；部门归属来自 Casdoor Group，同步到 `user_group_memberships`。业务权限不再来自 `roles` / `user_roles` / `role_permissions`，这三张表只保留历史数据。

**当前口径（2026-10-26 收口）**：部门规则是唯一业务权限来源。管理员在权限管理页按部门配置：

- 项目范围：`all` / `own`（本人负责或参与）/ `selected`（指定项目）/ `none`；多部门规则取并集。
- 权限档位：`edit`（可编辑并浏览）或 `view`（仅浏览）；`none` 只允许登录，不显示项目数据。
- 适用人员：部门全体直属成员，或勾选的部分成员。

所有登录账号都能进入业务页面；有规则但当前无可见项目时显示「账户暂无可浏览/编辑的项目」，完全无规则或规则为 `none` 时显示权限不足。服务端仍逐请求裁决，前端空态不能替代接口权限。

- 本地开关：`GROUP_ACCESS_ENFORCED=false`（默认）= 规则只可配置、不参与裁定；`true` = 执行部门规则。开启后必须同时配置 `GROUP_ACCESS_ADMIN_GROUP_KEYS` 或 `GROUP_ACCESS_ADMIN_USER_IDS`，否则服务拒绝启动。
- 管理员只来自上述环境变量命中的部门 / 用户，以及权限管理页手工添加；角色 `access.manage` 不再产生管理员。
- 权限画像有 10 秒缓存；保存部门规则或修改管理员后会清理缓存，刷新页面即可看到最新结果。
- 查询当前部门成员：`select u.username, m.group_key from user_group_memberships m join users u on u.id = m.user_id order by 1, 2;`（直连串见 `database/README.md`）。
- 不要再用 `user_roles` 绑定来调试权限；它不会改变页面、项目范围或写入口。

旧角色开关的回放证据仅用于历史追溯；从本版本起不再提供对应运行开关或回放脚本。
