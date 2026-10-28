# LibiaoLink 仓库约定

> **CAD 专项例外（2026-10-26 更新）**：wmj 负责 CAD 接入及相关文档，以独立 `CAD逆向` 工程的已登记提交与能力矩阵为准，任务见 `docs/CAD平台接入基线与迁移任务.md`，决策见 ADR-035。旧浏览器解析、原对象图片直签及 CAD-0～CAD-5 测量计划撤回；STEP 已在独立本地完整系统跑通实际 API、数据库/对象存储、本地 OIDC、任务附件与文件库预览，并部署到公司测试机；运行方式见 `server/cad-engine/README.md`；公司测试机与正式生产均已显式配置运行环境开放 STEP；正式生产于 2026-10-26 完成 API/worker Unix socket 接线，真实公司账号已打开 64 项零件 STEP。其余 CAD 或未启用环境仍提示并保留下载；拾取、显隐/隔离/恢复与跨重启复用仍待专项验收。lan 协办共享 file/preview/outbox，px 协办部署与通用 UI，不改变其他模块归属。不得把旧网格测量描述为加工/验收依据。

## 文档同步（每次改动必须遵守）

- 前端（`frontend/`）每次改动（页面 / 交互 / 数据模型 / 接口需求）必须同步更新 `前端功能需求.md`，并与改动同一次推送提交；不允许代码先推、文档滞后。
- 每次推送后在 `开发日志.md` 顶部追加一条记录：`日期 时间 | 作者 | 分支 | Push 序号`；作者 = 当次推送人（团队：`px`、`wmj`、`lan`）。
- 字段口径变化时，同步更新 `字段对照清单.md`。
- 推送前在 `frontend/` 下跑通 `npm run typecheck` 与 `npm run build`（纯文档改动除外）。

## 分支与推送

- 先推自己的常驻分支（`px` / `wmj` / `lan`），再经 PR 合入 `main`；禁止直接推送 `main`。
- 合并方式 squash-only；合并后常驻分支保留、不删除（规则集 `resident-branches-no-deletion`）。

## 分工与路由（谁负责哪块）

- 团队：`px`（前端 + 运维，交付负责人）、`wmj`（后端 A：领域负责人，兼技术负责人）、`lan`（后端 B：平台负责人）；完整口径见根目录 `团队分工.md`。

| 范围 | 主责 | 评审 / 协办 |
|---|---|---|
| `frontend/`、`assets/`、`deploy/`、`.github/`、`docs/` | px | wmj、lan |
| `前端功能需求.md`、`字段对照清单.md`、`README.md`、`开发日志.md`、`团队分工.md` | px | wmj |
| 后端领域：identity/org、project、blueprint/node、task、report/issue、stakeholder、automation、admin（字典 / 审计） | wmj | lan |
| 后端平台：file、preview、notify、outbox 队列调度、search、dashboard、迁移工具链 | lan | wmj |
| API 契约（Zod / OpenAPI / 生成客户端）、ADR、`技术设计*.md` | wmj | lan、px |
| `系统功能书.md`（定档口径，与源文档双处同步） | 变更提出人 | wmj（技术可行性）、px（实现一致性） |

- 代理（AI）动手前先按上表判断归属，改动只落在本线目录内；跨线改动（契约、字段口径、部署、权限）先对齐归属人再开工。
- 分支：改动推给归属人的常驻分支（`px` / `wmj` / `lan`）再走 PR；不代他人创建或推送常驻分支（CONTRIBUTING.md 第 5 节）。
- 后端目录（`server/`、`database/`、`shared/`）已落地；后端改动按本表归属落到对应目录，API 契约以 `shared/` 为唯一来源并同步生成物；跨线契约、字段口径、部署与权限改动先对齐归属人再开工。
- 高风险变更（CONTRIBUTING.md 第 15 节）必须取得另一名合格评审者批准；评审路由见 `.github/CODEOWNERS`。

## 服务器与运维（正式机 / 测试机）

- 正式机 = `10.1.103.44`（域名 `pm.libiaorobot.com`；发布清单在 `/opt/libiaolink/RELEASE_MANIFEST.json`）；测试机 = `10.1.104.44`（主机名 `libiao-vm`，域名 `test-pm.libiaorobot.com`）。正式发布只部署 `10.1.103.44`，不得写入测试机；登录 / 目录 / 部署件口径见 `deploy/prod/README.md` §1 与 §1.1。
- SSH 登录：开发机已配置 SSH 密钥；正式机使用 `ssh libiaolink-prod`，测试机使用 `id_ed25519_libiao` 对 `root@10.1.104.44` 登录。**登录凭据不落仓库**（CONTRIBUTING §12）——由 px 持有；开发机上的未跟踪备忘 = `deploy/prod/服务器登录.local.md`（已被 `.gitignore` 忽略，新会话可读该文件续接；过期口令以现场密钥 / IT 登记为准）。
- 铁律：不得修改 root 密码；服务器只跑不改 —— 代码 / 配置变更走本仓常驻分支（`px` / `wmj` / `lan`）→ PR → 部署件同步；禁止在服务器上直接手改业务代码，临时热修必须回灌仓库。

## 本地开发环境（Windows）

- 公司不允许 Docker Desktop。Windows 本地容器统一使用 **WSL2 + Ubuntu + 原生 Docker Engine（docker-ce）**，安装 / 验收 / 排障见 `docs/本地开发环境(Windows-WSL2-Docker).md`。
- Docker、Compose、Node、npm、迁移与回放命令在 WSL Ubuntu 内执行；仓库放在 WSL 文件系统，不以 `/mnt/d` 作为长期构建目录，不在 PowerShell 中调用 Docker。
- 历史实测记录中的 Docker Desktop 仅保留当时环境事实，不作为当前方案或新验收依据。

## 完整规则

- 仓库协作与开发规则见根目录 `CONTRIBUTING.md`（《通用开发规则》第 5、11–17 节落地版）；与本文件冲突时，以更严格者为准。
- 代理（AI）在本仓库工作时，必须同时遵守 `CONTRIBUTING.md` 第 12 节（Secrets 与安全）与第 17 节（Definition of Done）。
