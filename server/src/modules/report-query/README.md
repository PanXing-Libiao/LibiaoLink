# report-query 模块（企微机器人日报查询编排）

| 字段 | 内容 |
|---|---|
| 类型 | 组合模块（仅 worker） |
| 职责 | S3 查询路由、命令 / 日期解析、发送人身份、`report.view` / `issue.view`、文字回复、限流与回调幂等 |
| 主责 | lan（按 `docs/企微智能机器人日报查询实施方案.md` 执行） |
| 对外出口 | `ReportQueryService` / `ReportQueryModule` |
| 依赖 | permission、project、report-issue、notify（全部走目标模块 `index.ts`） |
| 不拥有 | 业务表、HTTP API、迁移、审计、outbox、站内信、群播报、海报 |

## 路由顺序

- worker 的 `aibot.onMessage` 在绑定码 / 群名命令之前调用 `accepts`；命中查询后不再回退。
- 单聊先调用 `NotifyDmService.activateFromReportQuery` 登记激活（不提取绑定码、不计失败），
  再按 `(bot_id, from.userid)` 的绑定行解析系统用户。
- 群聊先调用 `NotifyGroupService.activateFromReportQuery` 只激活会话，再读群绑定项目；
  显式项目只能是群绑定项目。
- 发送人必须完成单聊绑定，并在目标项目具备 `report.view`；问题内容另需 `issue.view`。

## 输出

- 日期按 `Asia/Shanghai`；支持今天 / 昨天 / 前天与三种日期格式，未来日期拒绝。
- 单篇日报主深链带 `report`，多篇使用 `date`；问题链接使用 `sub=issues&date`。
- 无 `issue.view` 时问题数量、链接与内容全部隐藏。
- 文字超过企微 markdown 字节上限时只截断逐篇列表，项目、日期、数量与主深链保留。

S4/S5 的海报与图片失败兜底不在本模块当前切片内。
