# PoC-8 回放证据（工作日历 D5）

> **2026-10-26 历史证据**：本文记录旧角色权限判定；对应脚本已删除，不能按当前代码复跑。当前权限口径以部门规则为准。

> 卡片：h8 · S6·工作日历（主责 wmj，协办 lan / px）｜验收口径：顺延与 T-1/T+1 有金标用例（配合 PoC-3 规则时间语义 i9）。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-09-20 17:01:27 +08:00 |
| 目标 | http://127.0.0.1:3011 |
| 数据库 | postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink |
| 代码版本 | 65d6ace |
| 管理员账号 | caa8d763-4b6a-4967-9b26-7d1086272c9c |
| 受限账号 | ea6eff88-4b3e-4df1-9ce0-02ffb14fed69 |
| 合成日历 | 2099-10-01 ~ 10-07 放假 + 2099-10-10 调休上班（回放后硬删） |
| 脚本（已删除） | server/scripts/poc8-replay.mjs |

## 断言明细

| PASS | S1 | 管理员会话（calendar.manage 基准账号） |
  - 期望：200 + 键位含 calendar.manage
  - 实际：200 {"roles":["admin"],"hasCalendar":true}
  - 说明：账号 Zhangsan（caa8d763-4b6a-4967-9b26-7d1086272c9c）
| PASS | S2 | 受限账号会话（越权拒绝基准账号） |
  - 期望：200 + 不含 calendar.manage
  - 实际：200 {"roles":[],"keys":0}
  - 说明：账号 lisi（ea6eff88-4b3e-4df1-9ce0-02ffb14fed69）；--actor 可指定
| PASS | S3 | 顺延配置单行存在（迁移 0014 默认行） |
  - 期望：1 行（reminder_shift_enabled / shift_direction）
  - 实际：{"reminder_shift_enabled":true,"shift_direction":"forward"}
  - 说明：回放结束恢复为回放前的值
| PASS | K1 | 某年日历（登录即可读）：合成日期尚未登记 |
  - 期望：200 + 不含 2099-10-01 等合成日期
  - 实际：200 days=0
  - 说明：年度查询：GET /api/v1/calendar/days?year=2099
| PASS | K1b | 单日判定（登录即可读）：周四 = 默认工作日 |
  - 期望：200 + kind=workday + isWorkday=true + source=default
  - 实际：200 {"date":"2099-10-08","kind":"workday","isWorkday":true,"name":null,"note":null,"source":"default"}
  - 说明：受限账号也可读（任务日期提示与规则引擎同口径）
| PASS | K1c | 顺延配置（登录即可读） |
  - 期望：200 + reminderShiftEnabled / shiftDirection 字段齐全
  - 实际：200 {"reminderShiftEnabled":true,"shiftDirection":"forward","updatedAt":"2026-09-20T09:01:23.098Z","updatedBy":null}
| PASS | K2 | 写 = 仅管理员：受限账号设置例外 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：calendar.manage","details":[],"traceId":"0c2e4ab4-bbec-4525-a198-edea00f3b907"}
| PASS | K2b | 越权留痕（按对象检索）：calendar_day + 业务日期 |
  - 期望：≥1 行（actorId 受限账号 + objectId=2099-10-08）
  - 实际：实际 1
  - 说明：路径 → 对象解析：/calendar/days/{date} → calendar_day / {date}（audit-path.ts，异步补写最多等 3s）
| PASS | K3 | 管理员设置例外（PUT 幂等 upsert）：响应为更新后的整年日历 |
  - 期望：全部 200 + 整年日历含 7 个假期日与调休日
  - 实际：{"statuses":[200,200,200,200,200,200,200],"makeupStatus":200,"days":["2099-10-01","2099-10-02","2099-10-03","2099-10-04","2099-10-05","2099-10-06","2099-10-07","2099-10-10"]}
| PASS | K4 | 单日判定：放假不是工作日（例外优先，带名称） |
  - 期望：kind=holiday + isWorkday=false + name=PoC-8 合成假期
  - 实际：{"date":"2099-10-01","kind":"holiday","isWorkday":false,"name":"PoC-8 合成假期","note":"回放数据","source":"calendar"}
| PASS | K5 | 单日判定：调休上班（周六补班）= 工作日 |
  - 期望：kind=makeup_workday + isWorkday=true
  - 实际：{"date":"2099-10-10","kind":"makeup_workday","isWorkday":true,"name":"PoC-8 调休上班","note":null,"source":"calendar"}
| PASS | K6 | 顺延到之后最近工作日：假期中跳过后回到 10-08 |
  - 期望：date=2099-10-08 + shifted=true + skipped 6 天
  - 实际：{"baseDate":"2099-10-02","direction":"forward","date":"2099-10-08","shifted":true,"skipped":["2099-10-02","2099-10-03","2099-10-04","2099-10-05","2099-10-06","2099-10-07"],"baseKind":"holiday","baseIsWorkday":false,"kind":"workday","name":null}
| PASS | K7 | 提前到之前最近工作日：假期前移回 09-30 |
  - 期望：date=2099-09-30 + shifted=true + skipped=[10-02,10-01]
  - 实际：{"baseDate":"2099-10-02","direction":"backward","date":"2099-09-30","shifted":true,"skipped":["2099-10-02","2099-10-01"],"baseKind":"holiday","baseIsWorkday":false,"kind":"workday","name":null}
| PASS | K8 | 已是工作日原样返回（shifted=false，无需顺延） |
  - 期望：date=2099-10-09 + shifted=false + skipped=[]
  - 实际：{"baseDate":"2099-10-09","direction":"forward","date":"2099-10-09","shifted":false,"skipped":[],"baseKind":"workday","baseIsWorkday":true,"kind":"workday","name":null}
| PASS | K9 | T-1 命中：10-09 的前一天（10-08）是工作日，不顺延 |
  - 期望：rawDate=date=2099-10-08 + kind=workday + at=null
  - 实际：{"baseDate":"2099-10-09","days":-1,"time":null,"shift":"inherit","rawDate":"2099-10-08","date":"2099-10-08","shifted":false,"shiftDirection":null,"kind":"workday","name":null,"at":null}
| PASS | K10 | 节假日顺延开：T-7 落到假期 → 顺延到 10-08 08:00（UTC 00:00） |
  - 期望：date=2099-10-08 + shifted=true + at=2099-10-08T00:00:00.000Z
  - 实际：{"baseDate":"2099-10-09","days":-7,"time":"08:00","shift":"inherit","rawDate":"2099-10-02","date":"2099-10-08","shifted":true,"shiftDirection":"forward","kind":"workday","name":null,"at":"2099-10-08T00:00:00.000Z"}
| PASS | K11 | 节假日顺延关（配置驱动）：同一入参保留假期内日期（两态各一例） |
  - 期望：settings 200（enabled=false）+ date=2099-10-02 + at=2099-10-02T00:00:00.000Z
  - 实际：{"settings":{"reminderShiftEnabled":false,"shiftDirection":"forward","updatedAt":"2026-09-20T09:01:27.527Z","updatedBy":"caa8d763-4b6a-4967-9b26-7d1086272c9c"},"offset":{"baseDate":"2099-10-09","days":-7,"time":"08:00","shift":"inherit","rawDate":"2099-10-02",…
| PASS | K12 | shift=on 强制覆盖配置（规则引擎回放与金标用） |
  - 期望：date=2099-10-08（配置仍为关）
  - 实际：{"baseDate":"2099-10-09","days":-7,"time":null,"shift":"on","rawDate":"2099-10-02","date":"2099-10-08","shifted":true,"shiftDirection":"forward","kind":"workday","name":null,"at":null}
| PASS | K12b | 恢复顺延配置（回放不留副作用） |
  - 期望：200 + 与回放前一致
  - 实际：{"reminderShiftEnabled":true,"shiftDirection":"forward","updatedAt":"2026-09-20T09:01:27.586Z","updatedBy":"caa8d763-4b6a-4967-9b26-7d1086272c9c"}
| PASS | K13 | T+1 逐级（A03 / A06 时间基准）：10-10（调休上班）后一天是周日 → 顺延到 10-12 |
  - 期望：rawDate=2099-10-11 + date=2099-10-12 + shifted=true
  - 实际：{"baseDate":"2099-10-10","days":1,"time":null,"shift":"inherit","rawDate":"2099-10-11","date":"2099-10-12","shifted":true,"shiftDirection":"forward","kind":"workday","name":null,"at":null}
| PASS | K13b | 实时求值：同一入参重复请求结果稳定（不缓存、不落库） |
  - 期望：两次 date 一致（2099-10-08）
  - 实际：{"first":"2099-10-08","second":"2099-10-08"}
| PASS | K14 | PUT 幂等：重复设置同一天 200 且整年日历无重复行 |
  - 期望：200 + 该日期在 days 中恰好 1 条
  - 实际：200 rows=1
| PASS | A1 | 按对象检索命中例外设置留痕（谁 / 何时 / 对什么 / 从什么改成什么） |
  - 期望：action=create + actorId=caa8d763-4b6a-4967-9b26-7d1086272c9c + result=succeeded + changes 含 dayType
  - 实际：行数=1 {"action":"create","actor_id":"caa8d763-4b6a-4967-9b26-7d1086272c9c","result":"succeeded","entry":"api","changes":[{"to":"holiday","from":null,"field":"dayType"},{"to":"PoC-8 合成假期","from":null,"field":"name"},{"to":"回放数据","from":null,"field…
  - 说明：等价 API：GET /api/v1/audit-logs?objectType=calendar_day&objectId=2099-10-01
| PASS | A2 | 顺延配置留痕：calendar_settings / default 的字段级 before / after |
  - 期望：action=update + changes 含 {reminderShiftEnabled, …}
  - 实际：{"action":"update","actor":"caa8d763-4b6a-4967-9b26-7d1086272c9c","change":{"to":true,"from":false,"field":"reminderShiftEnabled"}}
  - 说明：配置变更与例外维护同为可检索对象
| PASS | A3 | 审计接口·按对象检索（calendar_day + 业务日期） |
  - 期望：200 + total ≥ 1 且全为 calendar_day
  - 实际：200 total=1 ["create"]
| PASS | A3b | 审计接口仅 audit.view：受限账号 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：audit.view","details":[],"traceId":"0dce646b-cf90-435d-bbd1-421e42c72b50"}
| PASS | K15 | 删除不存在的例外 → 404 NOT_FOUND（不静默成功） |
  - 期望：404 NOT_FOUND
  - 实际：404 {"code":"NOT_FOUND","message":"该日期没有日历例外：2099-11-01","details":[],"traceId":"b3b730d0-1248-4913-8e33-2af0490b4e7e"}
| PASS | K16 | 删除例外（仅管理员）：回落默认规则（周六 = 周末） |
  - 期望：200 + 该日不再在整年日历 + kind=weekend
  - 实际：200 {"date":"2099-10-10","kind":"weekend","isWorkday":false,"name":null,"note":null,"source":"default"}
| PASS | A4 | 删除留痕：action=delete（字段级 from → null） |
  - 期望：action=delete + actorId=caa8d763-4b6a-4967-9b26-7d1086272c9c
  - 实际：{"action":"delete","actor_id":"caa8d763-4b6a-4967-9b26-7d1086272c9c","changes":[{"to":null,"from":"makeup_workday","field":"dayType"},{"to":null,"from":"PoC-8 调休上班","field":"name"}]}
| PASS | C1 | 收尾核对：回放数据与临时会话零残留（配置已恢复） |
  - 期望：calendar_days / audit_logs / sessions 全 0 + 配置 1 行等值
  - 实际：{"calendarDays":0,"auditRows":0,"sessions":0,"settings":1}
  - 说明：例外与审计行用 migrator 连接硬删（api 角色对 audit_logs 无 DELETE）

## 汇总

- ✅ 全部断言通过（30 项）：读 = 登录即可、写 = 仅管理员（越权 403 落 denied）、PUT 幂等、DELETE 回落默认规则与 404 边界、顺延两向、顺延开关两态（配置驱动 + shift=on 覆盖）、T-1/T+1 与 08:00 时刻、审计按对象检索（calendar_day / calendar_settings）、回放零残留。

## 验收对照（h8 · S6·工作日历）

- 「日历维护（D5-01）」= K1 ~ K5 / K14 ~ K16：管理员维护节假日与调休安排（PUT 幂等 upsert、DELETE 回落默认规则、删不存在 404）；读路径（某年日历 / 单日判定 / 顺延配置）登录即可，管理面 UI 随 u12（px 线）。
- 「顺延规则可配置（D5-02）」= K6 ~ K12b：非工作日按方向移动到最近工作日（forward / backward，skipped 逐条返回）；提醒日期落在节假日是否顺延由 calendar_settings 驱动（关态保留假期内日期、开态顺延到节后工作日，shift=on / off 供规则引擎回放强制覆盖）。
- 「T-1 / T+1（D5-03）」= K9 ~ K13b：自然日偏移 + 顺延 + 提醒时刻（08:00 → UTC 时间戳）；以任务当前日期实时求值（重复请求结果稳定，改期后按新日期重算；已发送提醒不撤回由 i8 侧保证）。
- 「审计留痕（h7 复用）」= A1 ~ A4：calendar_day（对象 id = 业务日期）与 calendar_settings（对象 id = default）的 create / update / delete 字段级留痕可按对象检索；越权 403 落 denied 且对象与成功写同形（K2b）。
- 「规则时间语义金标（PoC-3 · i9）」= 本脚本的 K6 ~ K13b 即日期语义金标；跨天补跑（worker 重启）按应执行清单补发且不重复属调度面，随 i8 / i9 落地（依赖 lan 线 i5 outbox）。
- 「自动化用例全绿」= server 目录 node node_modules/vitest/vitest.mjs run（新增 test/calendar-rules.test.ts + test/calendar-service.test.ts 29 例）与 node scripts/check-db-schema.mjs / check-permission-matrix.mjs / check-boundaries.mjs。
- 复跑：已停用（脚本于 2026-10-26 删除）。

