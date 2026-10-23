# CAD 异常与取消审计验证（F-03）

日期：2026-10-23。实现基线为 `main@6b846b2`，在常驻分支 `wmj` 完成；PR / CI / 合并记录见同批开发日志。未部署公司环境。

## 根因与责任层

原路径只更新 `cad_artifacts` 当前错误与 `cad_views.cancelled`，普通日志不构成不可变历史；重试会清空错误，窗口过期会删掉窗口记录。现在由平台仓储将被接受的失败 / 取消状态和既有 `audit_logs` 追加写放在同一事务中。相比在 worker 的 catch 或控制器响应后独立补写，这能使审计失败回滚状态，并以条件更新和 claim token 防止重复、过期执行者记账。

复用 `file` / `update` 和既有审计查询、权限、保留策略，无迁移、枚举、CAD HTTP 字段或依赖版本变更。事务方式依据 [Drizzle 官方说明](https://orm.drizzle.team/docs/transactions)；并发条件更新采用 PostgreSQL 默认 Read Committed 的重新判断语义，见 [PostgreSQL 18 文档](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)。

| 事件 | 主体 / 结果 | 上下文 |
| --- | --- | --- |
| `cad.failed` | system / failed | 文件与版本、持久任务、引擎 / 码页、尝试次数、错误码、是否计划重试，已知时加 native job / 终态 |
| `cad.limit_exceeded` | 后台为 system / failed；输入拒绝为实际用户 / failed | 明确内存 / 输出 / 产物配额或沙箱 busy；输入拒绝记录源大小 / 上限，不创建任务 |
| `cad.timed_out` | system / failed | native 排队 / 执行超时、平台总截止时间；原生超时即使缺少错误正文仍可识别 |
| `cad.cancelled` | 窗口所属用户 / succeeded | 文件版本、持久任务、窗口、对外窗口任务 id；不终止共享后台转换 |

只采用明确证据：服务断连、非法或超额错误响应仍是不可用，不能推测为 OOM。平台 worker 崩溃或失联后，通过过期 claim 重新领取记录上一尝试中断，耗尽重试的最后一次也保留。该记录不证明 native 崩溃的具体原因。审计不包含原文件、凭据、对象签名、socket、本机路径或未过滤的 native 错误正文。

`AuditService.record(client, ...)` 的操作人姓名读取使用同一连接，避免多个事务占满连接池后再等待独立连接；独立登录、越权事件的既有策略保持。

## 回归方式

本地使用 Node 24、专用 loopback PostgreSQL 18、临时 MinIO 目录和独立测试 CAD 容器。新增数据库测试直接运行仓储、审计服务和原 `0013` 审计表 DDL / `0064` CAD 迁移；用户与文件只用最小夹具，不冒充完整生产库或账号验收。既有应用角色对 `audit_logs` 禁止 UPDATE / DELETE 的授权未修改。

先在旧实现观察到 16 项数据库回归全部失败（审计为空、审计故障未回滚、输入拒绝未在归档服务落实）；另有 8 项传输 / worker 回归复现配额原因与 native 上下文丢失。随后完成实现并运行下列定向验证：

```sh
# 在 server/，CAD 和 PostgreSQL 必须是独立本地测试实例。
CAD_TEST_ENDPOINT=http://127.0.0.1:19910 \
CAD_TEST_CONTAINER=libiaolink-cad-audit-check-cad-1 \
CAD_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/libiaolink_cad_test \
node node_modules/vitest/vitest.mjs run --config test/cad.vitest.config.ts \
  test/cad-audit.integration.test.ts test/cad-archive-worker.test.ts \
  test/cad-engine-client.test.ts test/cad-archive-resource.test.ts \
  test/admin-audit.test.ts test/cad-archive.integration.test.ts
```

覆盖失败 / 超限 / 超时分类、后台与用户身份、平台截止时间、重试不擦历史、并发失败与取消去重、过期 claim fencing / 最终中断、审计异常原子回滚、窗口过期 / 文件清理保留历史，以及原有 STEP 转换、持久缓存、跨重启复用和权限 / 资源读取。

依赖同步后的最终本地结果：Node 24.19.0、PostgreSQL 18.6、CAD `1.0.1`；上述 **6 文件 / 71 项全部通过，38.25 秒**（其中真实数据库审计 16 项、真实 STEP 持久化 10 项）。`server` 的 `tsc -p tsconfig.json --noEmit` 与 `check:boundaries` 通过（294 文件 / 1341 条依赖，0 违规）；`frontend` 的 `npm run build`（包含 typecheck）通过，仅既有大 chunk 警告；`git diff --check` 通过。未做本地全量 server 构建或全量测试，PR 使用仓库既有 CI。

最初本机 `shared/dist` 与安装依赖落后于同步后的主干，导致 server 类型检查与 frontend 构建失败。已按现有锁文件同步本地依赖并重建 shared；没有更改依赖清单 / 锁文件。最终结果以本批开发日志实际命令与退出状态为准。

未执行公司账号浏览器验收、公司环境部署、全样本 CAD 能力矩阵或新的 OOM 压测；解析器、镜像、几何规则和内核资源限制均未修改。没有配置专用数据库的测试会跳过，跳过不算通过。
