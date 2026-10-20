# LibiaoLink 仓库约定

> **CAD 专项例外（2026-10-21 更新）**：wmj 负责 CAD 接入及相关文档，以独立 `CAD逆向` 工程的已登记提交与能力矩阵为准，任务见 `docs/CAD平台接入基线与迁移任务.md`，决策见 ADR-035。旧浏览器解析、原对象图片直签及 CAD-0～CAD-5 测量计划撤回；平台接入完成前仅提示暂不可预览并保留下载。lan 协办共享 file/preview/outbox，px 协办部署与通用 UI，不改变其他模块归属。不得把旧网格测量描述为加工/验收依据。

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
- 后端目录（`server/`、`database/`、`shared/`）尚未落地；落地前涉及后端的改动先落文档与契约（`技术设计v0.2-架构与数据模型.md`、`前端功能需求.md`）。
- 高风险变更（CONTRIBUTING.md 第 15 节）必须取得另一名合格评审者批准；评审路由见 `.github/CODEOWNERS`。

## 服务器与运维（测试机）

- 部署目标机 = `10.1.104.44`（libiao-vm；域名 `test-pm.libiaorobot.com`）；`10.1.103.44` 只是 ALLinSSL 证书下发接收端，勿作部署目标。登录 / 目录 / 部署件口径见 `deploy/prod/README.md` §1 与 §1.1。
- SSH 登录：开发机 `ssh root@10.1.104.44`；**登录口令不落仓库**（CONTRIBUTING §12）—— 由 px 持有；开发机上的未跟踪备忘 = `deploy/prod/服务器登录.local.md`（已被 `.gitignore` 忽略，新会话可直接读该文件续接）。
- 铁律：不得修改 root 密码；服务器只跑不改 —— 代码 / 配置变更走本仓常驻分支（`px` / `wmj` / `lan`）→ PR → 部署件同步；禁止在服务器上直接手改业务代码，临时热修必须回灌仓库。

## 完整规则

- 仓库协作与开发规则见根目录 `CONTRIBUTING.md`（《通用开发规则》第 5、11–17 节落地版）；与本文件冲突时，以更严格者为准。
- 代理（AI）在本仓库工作时，必须同时遵守 `CONTRIBUTING.md` 第 12 节（Secrets 与安全）与第 17 节（Definition of Done）。
