# audit 模块（平台）

> Push 173 自 admin 拆分 —— 审计写入 / 检索出口（C7）。admin 依赖 identity 守卫、identity 又要写审计，独立模块避免循环依赖。

## 职责

- 业务留痕 AuditService.record(client, input)：由业务用例在**同一事务**内调用（谁、何时、对什么、从什么改成什么）；登录成功等无业务事务的场景用 recordStandalone(input) 独立连接追加；
- 当前动作含 `visit`（项目详情进入 / 登录成功）与 `preview`（实际送达就绪预览，图片直签 / 产物 / ONLYOFFICE / CAD；未就绪 / 失败 / 404 不写）；操作记录筛选下拉隐藏 advance / rollback，但值集与历史写入不变；
- 越权 / 未命中留痕 recordDenied()：全局异常过滤器经 common/audit/audit-sink.ts 的 AUDIT_SINK 令牌调用（AppModule 以 useExisting 绑定本服务）；
- 检索 list(query)：按对象 / 操作人 / 动作 / 结果 / 项目 / 时间区间 + 关键字 q（Push 260：summary ∪ actor_name ∪ changes ILIKE，读面参数、无新列）（GET /api/v1/audit-logs，控制器仍在 admin 模块）；
- 防篡改：只 INSERT / SELECT（库级收回 UPDATE / DELETE，0013 迁移）；保留 ≥6 个月由运维按月清理。

## 出口

CAD 异常与取消（2026-10-23，F-03）复用 `file` / `update`，详细语义见 [file 模块](../file/README.md)。状态更新与审计追加由 CAD 仓储在同一事务内完成；`record(client, input)` 的操作人姓名查询也沿用传入的连接，避免冷缓存、并发状态更新时占满连接池后等待另一条连接。独立登录 / 越权留痕继续使用各自既有连接与失败策略。

- AuditModule（providers: AuditRepository / AuditService；exports: AuditService）；
- admin/index.ts re-export 本模块出口 —— 既有调用方零改动；新调用方可直接走 audit/index.ts（identity 采用后者，避免 admin 与 identity 成环）。

## 边界与后续（差异登记）

- 对象类型受契约 AUDIT_OBJECT_TYPES 约束（Push 173 增 user：离职回收 / 组织同步的停用 / 启用 / 软删）；
- 审计页面与导出（u12 · px 线）、告警推送（M5 通知）随各自卡片。
