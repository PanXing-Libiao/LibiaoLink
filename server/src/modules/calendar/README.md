# calendar 模块（h8 · S6·工作日历：D5-01 日历维护 / D5-02 顺延规则 / D5-03 T-1·T+1）

| 字段 | 内容 |
|---|---|
| 类型 | 横切模块（crosscut；领域与平台都可依赖 —— 登记于 `server/scripts/check-boundaries.mjs` 的 CROSSCUT_MODULES） |
| 职责 | 工作日历例外维护（D5-01）、顺延规则配置（D5-02）、顺延与 T-1 / T+1 实时求值（D5-03）；管理界面随 u 系列（px 线） |
| 主责 | wmj（团队分工.md §3：日历口径与组织同步；评审 lan 或 px） |
| 对外接口 | CalendarService（getYear / getDay / setDay / deleteDay / getSettings / updateSettings / shift / offset）、纯函数（calendar.rules.ts：resolveDay / shiftToWorkday / evaluateOffset / atShanghaiTime / addDays / dayOfWeek / calendarWindow）、ClockService（common/clock：now / today / setSource）；HTTP：GET /api/v1/calendar/days、GET /api/v1/calendar/day、PUT | DELETE /api/v1/calendar/days/{date}、GET | PUT /api/v1/calendar/settings、GET /api/v1/calendar/shift、GET /api/v1/calendar/offset |

## 已实现（h8）

- 迁移 `database/migrations/0014_work_calendar.sql`：`calendar_days`（**只存例外**：`holiday` 放假 / `makeup_workday` 调休上班；date 主键 + name / note + `updated_by` + 4 CHECK（类型 / 日期区间 2000-01-01~2100-12-31 / 名称 1~80 / 说明 1~200）+ `(day_type, date)` 索引）与 `calendar_settings`（单行：`reminder_shift_enabled` / `shift_direction`（forward 顺延到之后最近工作日 / backward 提前到之前最近工作日）；迁移即建默认行，幂等）。未登记日期按默认规则（周一至周五工作日、周六周日非工作日）—— 不落 365 行 / 年，改年历只增删例外。
- 单日判定（D5-01 读）：GET /api/v1/calendar/day（`date` 缺省今天，Asia/Shanghai）—— 例外优先（`source=calendar`）、否则默认规则（`source=default`）；`kind` 四态 workday / weekend / holiday / makeup_workday。
- 年历与维护（D5-01）：GET /api/v1/calendar/days?year=（例外清单按日期升序 + 顺延配置）；PUT /api/v1/calendar/days/{date}（幂等 upsert，name / note 缺省保持原值；响应 = 更新后的整年日历，前端直接替换）；DELETE …/{date}（回落默认规则；无该例外 404 NOT_FOUND）。写仅 `calendar.manage`，每次变更在**同一事务**写审计（objectType = calendar_day，字段级 before / after；无变化 changes=null）。
- 顺延规则配置（D5-02）：GET / PUT /api/v1/calendar/settings —— 是否顺延 + 方向；PUT 为部分更新（缺省字段不动）、仅 `calendar.manage`、写审计（objectType = calendar_settings，objectId = default）。
- 顺延求值：GET /api/v1/calendar/shift?date=&direction= —— 非工作日移动到最近工作日（已是工作日则 `shifted=false` 原样返回）；`skipped[]` 逐条返回中途跳过的日期（金标用例逐条断言）；`direction` 缺省取配置。
- T-N / T+N 求值（D5-03）：GET /api/v1/calendar/offset?date=&days=&time=&shift= —— 自然日偏移 → 顺延开关（`inherit` 按日历配置 / `on` / `off` 供规则引擎回放与金标用例强制覆盖）→ 顺延到最近工作日 → 可选叠加时刻（`at` = 业务日 + HH:mm 按 Asia/Shanghai 转 UTC，如 R03「前 1 天 08:00」）。**实时求值、不缓存、不落库**：任务改期后按新日期重算（v0.1 §4 时间语义）。
- 时钟（v0.3 §4.7）：新增 `server/src/common/clock/clock.service.ts`（now / today / setSource）—— 求值基准日期一律经 ClockService（缺省今天，Asia/Shanghai），规则 / 调度禁止直接取系统时间（保证回放与金标测试）；本模块提供并导出，后续调度 / 规则模块复用。
- 权限：`calendar.manage` 入契约 `PERMISSION_KEYS`（Push 99 时 27 键；Push 155 后 31 键 —— M6-01 ~ M6-03 补 report.view / report.fill / issue.view / issue.manage）；种子 `database/seeds/role-permissions.mjs` 给 admin 补该键（admin 27 键 = 契约全量；其余角色不含 —— 维护动作属管理面）。
- 窗口防御：求值窗口一次加载基准日 ± 370 天（跨年自动包含）；窗口外一律「未加载」而非「非工作日」（`resolveDay` 返回 null、顺延返回 `exhausted`，最多 366 步）—— 连续非工作日超一年直接 500 提示检查日历数据，避免把不完整数据当默认规则。

## 与其它模块的边界

- 依赖方向：calendar → identity（会话 / CSRF 守卫）、permission（`calendar.manage` 统一判定出口）、admin（`AuditService` 留痕，同事务）；横切模块不反向依赖业务模块 —— 领域与平台模块经本模块 `index.ts` 复用日期求值（i8 规则引擎 / 任务提醒 / 应填未填清单）。
- 审计对象类型 calendar_day / calendar_settings 由 h7 的 `audit_logs`（自由文本 objectType）承载，无需改表。
- 前端与管理界面（u12）只消费契约读接口；写接口缺位一律 403（ProjectAccessGuard + RequirePermission）。

## 差异与后续（待复核）

1. **节假日 / 调休数据待业务回执**（种子 #10）：本轮交付表结构 + 管理入口 + 顺延 / T±N 计算；实际年历由管理员经管理端（u12 · px 线界面，接口已就绪）录入。
2. 跨天补跑 / 应执行清单（worker 重启按清单补发且不重复）属调度面，随 i8 / i9（依赖 i5 outbox）；提醒实际发送随 M5 通知模块。
3. 日历视图（D5-04 展示面）与前端接入随 u 系列（px 线）。
4. `calendar.manage` 使权限计数 26 → 27 键（矩阵 73 → 74 条），已同批同步种子与文档。
5. 原回放脚本（`scripts/poc8-replay.mjs`）已于 2026-10-26 随旧权限模型清理删除；历史证据保留，当前 CI 走不连库的 29 例（calendar-rules 17 + calendar-service 12）与 `check:permission-matrix`。

## 测试

- `server/test/calendar-rules.test.ts`（17 例）：默认规则与例外优先（放假 / 调休上班 / 窗口外 null）、日期算术（跨月 / 跨年）、顺延金标（forward 假期中一路跳到 10-08 / backward 回 09-30 / 已是工作日原样 / 跨年 / 窗口用尽 exhausted）、T-1·T+N 求值（命中不顺延 / 顺延开与关两态 / T+1 跨假期 / backward / 改期后重算、数据变化不缓存）、上海时刻换算（08:00 → UTC 00:00）。
- `server/test/calendar-service.test.ts`（12 例）：年历读取与排序、单日判定缺省取时钟业务日（10-10 调休上班 = 工作日）、setDay 新增 / 幂等 upsert 与审计（create / update、name 缺省保持）、deleteDay 404 与回落默认规则、updateSettings 与空变更 changes=null、shift 缺省方向与显式覆盖、offset T-1 / 顺延开关 + 08:00 / T+1 升级链路。
- 全量：`vitest run` 16 文件 213 例全过；`check:db-schema` 26 表 · 258 列 · 72 索引/唯一 · 70 CHECK；`check:permission-matrix` 6 角色 / 74 条目 / 27 键；`check:boundaries` 110 文件 / 405 依赖 / 0 违规；`tsc --noEmit` 与 `nest build` 通过。
