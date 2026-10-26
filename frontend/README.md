# LibiaoLink 前端（React + Vite + TypeScript）

LibiaoLink 业务前端：项目空间（首页筛选 / 排序 / 记忆）、项目总览（阶段 / 任务表 / 抽屉）等。
登录与会话（公司统一登录 Casdoor，标准 OIDC）自 k6 起由后端 `server/`（identity 模块）承载；本地开发由 Vite 把 `/auth/*` 代理到后端。

> 公司接入标准见 `docs/开发者接入注意事项(SSO接入标准).md`；本地沙箱见 `docs/本地沙箱(LibiaoLink 演练环境).md`；会话实现与排障见 `server/README.md` 的「会话链路」一节。

## 本地启动（沙箱 + 后端 + 前端）

STEP 联调已有无需全量构建的完整系统启动入口，见 [本地完整系统](../server/cad-engine/README.md#本地完整系统)。它运行当前分支的实际前后端，并使用独立本地登录、数据库和文件存储；可直接从任务附件与文件库打开新版 CAD。`3013/tools/cad-platform.html` 仍是单独试用页。

> Windows 开发机不使用 Docker Desktop：先在 WSL2 Ubuntu 内安装原生 Docker Engine，全部命令在 Ubuntu 终端执行，见 [Windows 本地开发环境](../docs/本地开发环境(Windows-WSL2-Docker).md)。

前置：
1. 本地 Casdoor 沙箱：`cd deploy/casdoor && docker compose up -d`（见沙箱文档）
2. PostgreSQL 18 与空库迁移：见 `database/README.md`（`npm run migrate`）
3. `server/.env`：`PORT=3001`（前端占 3000，必须错开）、`DATABASE_URL=...`、`CASDOOR_*` 指向本地沙箱（`CASDOOR_REDIRECT_URI=http://localhost:3000/auth/callback`）

```bash
# 1. 后端（新窗口）
cd ~/LibiaoLink/shared; npm ci; npm run build
cd ../server; npm ci; npm run build; npm run start:api   # http://127.0.0.1:3001/healthz

# 2. 前端（新窗口）
cd ~/LibiaoLink/frontend
npm install
cp .env.example .env.local     # BACKEND_ORIGIN 默认 http://127.0.0.1:3001；TEST_* 供冒烟测试
npm run dev                    # http://localhost:3000
```

打开 `http://localhost:3000`：未登录自动跳公司统一登录页，登录后进入「项目空间」。

Casdoor 应用 `libiaolink` 需要的配置：

| Casdoor 应用配置 | 值 |
|---|---|
| Homepage URL | `http://localhost:3000` |
| Redirect URLs | `http://localhost:3000/auth/callback` |
| Grant Types | 只勾 `authorization_code` |
| Token format | `JWT-Custom` |
| Token fields | `Name` / `Owner` / `Id` / `DisplayName` / `Email` |

## 登录流程（k6 起，会话在后端）

```text
浏览器                        前端 Vite（3000）        后端 api（3001）              Casdoor
  | GET /auth/login           |                        |                            |
  | ------------------------> | 代理 -----------------> | 生成 state + PKCE，302     |
  | ----------------------------------------------------------------------------> /login/oauth/authorize
  | GET /auth/callback?code=…（浏览器到 3000，Vite 代理转发到后端）
  | ------------------------> | 代理 -----------------> | 校验 state，换令牌，建会话 |
  |                           |                        | Set-Cookie: ll_sid（HttpOnly）、ll_csrf
  | GET /auth/me              |                        |                            |
  | ------------------------> | 代理 -----------------> | 校验会话 + 空闲超时        |
```

- 换令牌与验签都在后端：`client_secret` 只存在于 `server/.env`，不进浏览器。
- 会话：HttpOnly `ll_sid`（DB 只存 sha256 哈希）；可读 `ll_csrf`（写接口回传 `X-CSRF-Token`）。
- 空闲超时按接入标准 30 分钟（`SESSION_IDLE_MINUTES`）；超时后 `/auth/me` 401，前端自动重新走 SSO（Casdoor 会话还在则静默续期）。
- `src/api.ts`：统一 fetch 封装（同源 Cookie、写请求自动带 CSRF 头、401 跳登录并带 `returnTo` 回跳当前页）。

## 目录结构

```text
frontend/
  src/api.ts                 fetch 封装（CSRF / 401 → SSO）
  src/App.tsx                入口：未登录跳 SSO，登录后渲染页面
  src/Home.tsx               首页「项目空间」（筛选 / 排序 / 记忆）
  src/ProjectDetail.tsx      项目详情「项目总览」
  src/components/            组件（顶栏 / 卡片 / 侧栏 / 抽屉 / 弹窗等）
  src/data/                  演示数据（接后端后移除）
  scripts/smoke-test.mjs     SSO 链路冒烟（`npm run smoke`，需先起后端与前端）
  vite.config.ts             端口 3000；/auth/*、/healthz、/readyz 代理到 BACKEND_ORIGIN
```

## 生产环境

- `/auth/*` 与业务接口都由 `server/` 承载；生产由站点域名直连（Nginx 反代），不再需要 Vite 代理。
- 上线检查：HTTPS；`SESSION_COOKIE_SECURE=true`（或 `auto` + `NODE_ENV=production`）；Casdoor 正式应用的 Homepage URL / Redirect URLs 换成正式域名；`client_secret` 只放密钥管理 / 后端环境变量。
- 离职回收：企微删除员工 → Casdoor 同步禁用；后端对 `status != active` 的会话直接 401 并踢线。

## 常见问题

| 现象 | 处理 |
|---|---|
| /auth/* 报 502 / ECONNREFUSED | 后端没起或端口不对：`server/.env` 的 `PORT` 与 `frontend/.env.local` 的 `BACKEND_ORIGIN` 保持一致（默认 3001） |
| 换令牌报 `invalid_grant: redirect_uri is invalid` | Casdoor 应用的 Redirect URLs 必须含 `server/.env` 里的 `CASDOOR_REDIRECT_URI`（逐字符一致） |
| 报 state 校验失败 | 登录过程中换了标签页或清了 Cookie；从应用入口重新进入 |
| 启动报端口被占用 | 3000 被别的程序占用（`strictPort` 不会悄悄换端口），腾出端口再启动 |
| 能登录但字段是空的 | 应用 Token fields 没勾 `Name` / `Owner` / `Id` / `DisplayName` / `Email` |
| 登录后立刻又跳登录 | 后端 `SESSION_IDLE_MINUTES=0`（仅测试档）或 `CASDOOR_CLIENT_SECRET` 不对 |
