# S7-2 · PoC-4 回放证据（Outbox 投递语义：不丢 / 不重发 / 重试与可执行告警）

> 卡片：i6 · S7·PoC-4（主责 lan，评审 wmj 或 px）｜验收：杀 worker 不丢消息、重复领取不重发、重试与可执行告警演示（团队分工.md §6 第 4 行）。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-10-19 13:49:52 +08:00 |
| 数据库 | postgresql://libiaolink_api@127.0.0.1:55432/libiaolink |
| 代码版本 | d490a3c（工作区含未提交改动） |
| 脚本 | server/scripts/poc4-outbox-replay.mjs |
| 环境口径 | OUTBOX_STALE_MS=60000（env 下限）· 退避 1000ms 起 / 2000ms 封顶 · maxAttempts=3 · 告警阈值 backlog=1 / oldest=60s / 进度窗口=60s / 停滞=1 轮 |
| 领取者 | poc4-main（主）· poc4-crashed-worker（被 SIGKILL 的子进程）|

## 断言明细

| 结果 | 编号 | 断言 | 期望 | 实际 |
|---|---|---|---|---|
| PASS | P0 | 基线：本脚本话题前缀无存量行（回放自清理） | 期望：0 行 | 实际：0 行 |
| PASS | A1 | 投递落库：appendOutbox 写 pending（提交后可见、可领取） | 期望：status=pending / attempts=0 / locked_at=null | 实际：id=9262 / status=pending / attempts=0 / locked_by=null / locked_at=null / last_error=null |
| PASS | A2 | 杀 worker 不丢：子进程真领取后被 SIGKILL —— 行留 processing 且可查（locked_by / locked_at 留痕） | 期望：子进程 signal=SIGKILL；行 status=processing / locked_by=poc4-crashed-worker / locked_at 非空 / attempts=0 | 实际：child pid=27560 code=null signal=SIGKILL / claimed.id=9262 / status=processing / attempts=0 / locked_by=poc4-crashed-worker / locked_at=非空 / last_error=null |
| PASS | A3 | 崩溃窗口内（locked_at 未超 OUTBOX_STALE_MS）第二 worker 领取 0 条 —— 不重复投递 | 期望：claimed=0 / done=0 / handler 调用 0 | 实际：stats={"claimed":0,"done":0,"retried":0,"deferred":0,"dead":0} / handler=0 |
| PASS | A4 | 超窗重领（回拨 locked_at 到 stale 之外 = 崩溃已超阈值）：真 dispatcher 重领并恰好消费一次 | 期望：claimed=1 / done=1 / handler=1（dedupeKey 一致）/ 行 done / locked_by=poc4-main | 实际：stats={"claimed":1,"done":1,"retried":0,"deferred":0,"dead":0} / handler=1 / status=done / attempts=0 / locked_by=poc4-main / locked_at=null / last_error=null |
| PASS | A5 | done 后不再投递 + 同 dedupeKey 复投不重开：行数仍 1 / 仍 done / 消费恒 1 次 | 期望：两轮 drain claimed=0 / 行数=1 / status=done / handler=1 | 实际：claimed=[0,0] / 行数=1 / status=done / attempts=0 / locked_by=poc4-main / locked_at=null / last_error=null / handler=1 |
| PASS | A6 | 去重键：同 dedupeKey 重复投递只落 1 行（onConflict 幂等）、只消费 1 次 | 期望：行数=1 / claimed=1 / handler=1 / status=done | 实际：行数=1 / stats={"claimed":1,"done":1,"retried":0,"deferred":0,"dead":0} / status=done / attempts=0 / locked_by=poc4-main / locked_at=null / last_error=null / handler=1 |
| PASS | B1 | 可重试失败：attempts 累计 + 按主题策略退避（第 1 次 = base 1000ms）回 pending | 期望：retried=1 / status=pending / attempts=1 / last_error=记录 / 剩余退避 ∈ [850,1600]ms / locked_at=null | 实际：stats={"claimed":1,"done":0,"retried":1,"deferred":0,"dead":0} / status=pending / attempts=1 / locked_by=poc4-main / locked_at=null / last_error=poc4 通道抖动（可重试） / 剩余退避=995ms |
| PASS | B2 | 退避到期重领 → 第 2 次成功 done（attempts 留痕保留，不抹历史） | 期望：done=1 / status=done / attempts=1 / last_error=null / handler=2 | 实际：stats={"claimed":1,"done":1,"retried":0,"deferred":0,"dead":0} / status=done / attempts=1 / locked_by=poc4-main / locked_at=null / last_error=null / handler=2 |
| PASS | B3 | 重试到顶（3/3）转 dead：onDead 留痕 + 单条死信即时告警（detail 口径） | 期望：轮次 retried=1,retried=1,dead=1 / status=dead / attempts=3 / handler=3 / onDead=1 / outbox.dead 1 条（attempts=3 maxAttempts=3） | 实际：stats=[{"retried":1,"dead":0},{"retried":1,"dead":0},{"retried":0,"dead":1}] / status=dead / attempts=3 / locked_by=poc4-main / locked_at=null / last_error=poc4 上游持续不可用（重试到顶） / handler=3 / onDead=1 / 告警=[{"code":"outbox.dead","level":"error","detail":{"topic":"poc4.replay.dead","id":9267,"dedupeKey":"poc4-d06c18e5-dead","attempts":3,"maxAttempts":3}}] |
| PASS | C1 | 告警探针（阈值内且进度窗口 0 完成）：仅 queue_stalled + unconsumed_topic 即时告警；dead_letter 只记日志 | 期望：两码齐发；queue_stalled.detail.duePending>=2；oldestDueMs>=119000 且 doneRecent=0；unconsumed_topic 命中合成 backlog 主题；不含 backlog / oldest_due / dead_letter | 实际：codes=["outbox.queue_stalled","outbox.unconsumed_topic"] / [{"code":"outbox.queue_stalled","detail":{"duePending":2,"oldestDueMs":120003.363,"doneRecent":0,"stalledProbes":1,"byTopic":[{"topic":"poc4.replay.backlog","due":2,"oldestMs":120004.58}]}},{"code":"outbox.unconsumed_topic","detail":{"duePending":2,"byTopic":[{"topic":"poc4.replay.backlog","due":2,"... |
| PASS | C2 | 同一份快照、宽阈值对照：阈值类 0 告警 + 未消费主题 1 条（探针语义不是恒告警噪声） | 期望：threshold=0 / unconsumed=1 | 实际：threshold=0 / codes=["outbox.unconsumed_topic"] |
| PASS | C3 | 演示记录入库：本脚本全部状态迁移在 outbox_events 可查（三态计数） | 期望：pending=2 / processing=0 / done=3 / dead=1 | 实际：{"dead":1,"done":3,"pending":2} |
| CLEANUP | — | 清除本脚本 outbox 行 | 期望：— | 实际：删除 6 条（前缀 poc4.replay.） |

## 汇总

- 全部断言通过：杀 worker 不丢（A1~A4）· 重复领取不重发（A3 / A5 / A6）· 重试与可执行告警（B1~B3 / C1~C3）。

## 复跑

cd server && POC4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node --env-file-if-exists=.env scripts/poc4-outbox-replay.mjs [--out ../docs/PoC-4-回放证据(Outbox投递语义).md] [--keep]
