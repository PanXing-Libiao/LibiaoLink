# LibiaoLink

LibiaoLink 是一套项目协作与文件管理系统，连接项目、任务、进展记录和文件版本，让团队在同一工作空间协作。

## 主要功能

- 项目空间与项目总览：查看阶段、任务、进度和关联资料。
- 任务与协作：维护任务、日报、问题和通知。
- 文件管理：上传、版本管理、关联、下载与受控预览。
- 统一登录：通过 OIDC 对接身份服务，登录和会话由后端处理。
- CAD 预览：配置独立解析环境后支持 STEP，其余格式保留下载入口。默认使用 GB 名称编码，可手动选择 UTF8；上传完成后后台解析，成功结果可持久复用。

## 工程目录

| 目录 | 用途 |
| --- | --- |
| [frontend/](frontend/README.md) | React、Vite 与 TypeScript 前端 |
| [server/](server/README.md) | API 与后台 worker |
| [shared/](shared/README.md) | API 契约、OpenAPI 与类型生成 |
| [database/](database/README.md) | 数据库迁移、受限角色与基础数据 |
| `deploy/` | 各服务的部署模板 |
| `assets/` | 应用图标等静态资源 |

## 本地开发

依赖安装、环境变量和启动命令分别见[前端说明](frontend/README.md)、[后端说明](server/README.md)和[数据库说明](database/README.md)。

STEP 的本地完整流程可按 [CAD 运行说明](server/cad-engine/README.md#本地完整系统)启动，覆盖登录、项目与任务附件上传、文件库和 CAD 预览，使用独立的本地数据库与文件存储。

CAD 解析运行在独立容器内，与 API 隔离，并设置内存、CPU、进程数及临时存储硬限额；运行要求见 [CAD 部署说明](deploy/cad/README.md)。

运行配置由各目录的环境模板和受控配置文件提供。真实环境地址、管理员入口、账号、凭据和本机路径不写入公开 README。

## 参与开发

提交、分支和验证约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。功能说明以实现及对应模块文档为准。
