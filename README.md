# LibiaoLink

> **2026-10-21 STEP 本地接入已跑通，未部署**：沿用独立 `CAD逆向` 工程 STEP v0.3.3（几何基线 `0911573`，宿主适配 `f103d1c`），已接入文件版本、受控任务/二进制资源和 ViewerSession；启用 CAD 运行环境后 STEP 可预览，其余 CAD 保留提示与下载。旧解析器、网格测量及原对象图片直签已撤下。见 [接入基线](docs/CAD平台接入基线与迁移任务.md) 与 [本地逐文件结果](docs/cad-platform-integration/RESULTS.md)。

打通公司全链路，使得信息流通，让世界更高效。

## 统一登录（SSO）

公司各系统的统一账号与登录，基于开源 [Casdoor](https://github.com/casdoor/casdoor)（自托管身份中心）搭建。
支持 OAuth 2.0 / OIDC、SAML 2.0、CAS、LDAP、SCIM 2.0，可对接企业微信、钉钉、飞书、AD/LDAP 等账号来源。

| 目录 | 用途 |
|---|---|
| `docs/公司统一登录(SSO)实施方案.md` | 实施方案：选型决策、部署、控制台配置、各系统接入方式、接口速查、上线清单、常见坑 |
| `deploy/casdoor/` | **本地联调**部署模板（Docker Compose：Casdoor + MySQL + Redis），用于复刻公司环境验证接入 |
| `frontend/` | **LibiaoLink 前端**（React + Vite + TypeScript）：登录后入口页（项目空间 / 任务模板 / 我的任务）、项目空间 / 项目总览页面；登录会话由 `server/` 承载（本地 `/auth/*` 经 Vite 代理到后端），`npm run dev` 起在 3000 端口 |
| `shared/` | **API 契约包**（g2）：Zod schema 唯一真相 → 生成 `openapi.json` 与前端 TypeScript 类型；`npm run generate` 生成、`npm run check` 漂移校验（详见 `shared/README.md`） |
| `database/` | **数据库基线**（g3）：只追加迁移（`migrations/`，0001 一期基线 DDL）、最小权限角色（`roles/`）、带 advisory lock 与漂移校验的迁移器（`scripts/migrate.mjs`）；`npm run migrate` 空库一键迁移（详见 `database/README.md`） |
| `server/` | **后端服务**（g4）：NestJS 12 模块化单体骨架（api / worker 双入口）、统一错误与日志、健康检查、Drizzle schema（对齐 `database/` 基线）与服务边界规则（`npm run check:boundaries`）（详见 `server/README.md`）
| `docs/本地沙箱(LibiaoLink 演练环境).md` | **本地沙箱现状**：起停、登录入口与账号、配置快照、联邦原理、常见问题、与公司环境对照 |
| `docs/开发者接入注意事项(SSO接入标准).md` | **开发者必读**：只用标准 OIDC、Grant Types、JWT-Custom 与 Token fields、字段命名差异 |
| `docs/企业微信(WeCom)对接指南.md` | **企微对接**：登录通道（Provider 字段/可信域名）+ 通讯录同步（离职自动禁用）+ 常见报错 |
| `docs/实测报告(SSO接入验证).md` | **实测记录**：本地沙箱三轮实测（PKCE 全链路、公司接入标准落地、合规改造）+ 公司测试环境端到端演练 + 正式环境只读核对 |
| `系统功能书.md` | **系统功能书（定档版）**：市场项目管理系统功能点清单 V1.1（模块 A1~D5、期次划分、项目总览字段口径） |
| `技术设计v0.1-选型分析.md` | **技术设计 v0.1（选型分析篇）**：需求基线、规模画像、技术选型对比与结论、待确认问题（v0.1.7 讨论稿） |
| `技术设计v0.2-架构与数据模型.md` | **技术设计 v0.2（架构与数据模型篇）**：总体架构、领域模型与 DDL 草案、流程节点与蓝图、权限模型、文件管道、自动化规则、接口契约（v0.2.6 讨论稿；§11 为实施反推增补） |
| `技术设计v0.3-实施与验收.md` | **技术设计 v0.3（实施与验收篇）**：卡片流水线与 DoR/DoD、M0~M8 里程碑与依赖、逐里程碑详细设计、横切机制、协作与联调、M0 待定案口径清单（v0.3 讨论稿） |
| `docs/adr/` | **架构决策记录（ADR）**：ADR-001～035，状态以索引为准；旧 CAD ADR-008/031/032 由 ADR-035 替代 |
| [CAD 平台接入基线与迁移任务](docs/CAD平台接入基线与迁移任务.md) | wmj 主责；STEP 版本/权限/任务/资源与查看器已本地联通；真实公司登录、对象存储与部署验收待完成 |
| `开发日志.md` | **每次推送的开发日志**：做了什么、效果与验证、风险与后续；最新记录在最上面 |
| `团队分工.md` | **团队分工与责任边界**：3 人角色（2 后端 + 1 前端/运维）、模块归属、契约与文档责任、阶段 0 PoC 分工、运维值班与单点风险 |
| `assets/` | 应用图标源文件（SVG，浅色 / 深色两版）；本地沙箱的副本放在 `deploy/casdoor/files/brand/`，由 Casdoor 自己托管 |

### 公司环境

| 环境 | 地址 | 管理员入口 | 公网访问 |
|---|---|---|---|
| 正式 | https://auth.libiaorobot.com | https://auth.libiaorobot.com/login/built-in | ✅ 开放 |
| 测试 | https://authtest.libiaorobot.com | https://authtest.libiaorobot.com/login/built-in（`admintest`） | ❌ 仅内网 |

业务组织固定为 `libiaorobot.com`：**所有应用和用户都必须建在该组织下**。`built-in` 是管理员组织（不要改），`casbin` 是复现 Bug 用的测试组织。
测试环境没有短信 / 邮箱验证码 / 企业微信登录，也没有正式员工数据，需要自行创建同名同邮箱的用户再验证。
正式环境已配好企业微信 Provider（`WeCom`，`Use id as name` 已开 → 令牌 `name` 就是企微 userid），业务应用在 `Applications → Providers` 勾选即可，细节见企微对接指南。

> `deploy/casdoor/` 是**本地联调**环境（组织名 `libiaorobot`），现状与用法见 `docs/本地沙箱(LibiaoLink 演练环境).md`。

### 快速开始

```bash
# 1. 本地联调：起一套 Casdoor 沙箱（公司环境已就绪，接入方一般不需要自己部署）
cd deploy/casdoor && cp .env.example .env && vi .env && docker compose up -d

# 2. 登录控制台并加固：http://<服务器IP>:8000  （管理员账号密码见 deploy/casdoor/.env.local，登录后立刻改密码）
#    然后按方案文档第四章配置组织、证书、应用、认证源

# 3. 验证接入：打开带应用 Logo 的本地登录页（应用 libiaolink，回跳到 Casdoor 账户页）
#    http://localhost:8000/login/oauth/authorize?client_id=libiaolink-a195b721bb30a7d4&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Faccount&scope=openid+profile+email&state=demo
#    登录页：密码（本地）+ 验证码；下方「公司统一登录（测试环境）」可用公司账号登录（详见本地沙箱说明）
#    注意：应用已开 enableAutoSignin —— 已有 SSO 会话时会直接签发、不再显示登录页

# 4. 前端：先起后端 server/（本地 PORT=3001，见 server/README.md），再起前端；未登录自动跳 SSO
cd frontend && npm install && cp .env.example .env.local && npm run dev
```

> 生产最低要求：HTTPS、改掉默认密码、`origin` 设为对外域名、数据库定时备份、多副本时接 Redis。
>
> 本地沙箱的账号与口令（测试账号、管理员、DB / Redis）只存 `deploy/casdoor/.env.local`、`frontend/.env.local`（均被 gitignore），仓库内不写明文；`.env.example` 只有变量名与说明。
